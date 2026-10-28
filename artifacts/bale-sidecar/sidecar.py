"""Nafis CRM — Bale personal-account sidecar (1a: login + sign-out; 1b: live sessions, send, inbound forwarder).

A "pipe" between the CRM API and Bale. It listens on 127.0.0.1 ONLY, requires the internal token
(`x-bale-internal-token`, read from BALE_SIDECAR_TOKEN_FILE) on every request, has no DB access and makes no decisions:
eligibility, switches, rate limits and audit all live in the API (artifacts/api-server/src/lib/bale.ts).

Security rules:
  * No session is ever written to disk: every aiobale Client is created with session_file=None.
  * The Bale transaction_hash stays in this process's memory only (flow TTL 5 min) and is never returned.
  * Each login uses the per-expert device id sent by the API — never aiobale's shared default device hash.
  * Phone numbers, codes, 2FA passwords and session tokens are never logged; access logging is off and the only
    log lines are "<route> <outcome>".
  * Live sessions (1b) exist in memory only. After a restart the sidecar has none; the API notices the new bootId in
    /v1/health and re-attaches each connected account with its decrypted token.
  * (1b-0.6, BALE-FIXB-66) Dead-connection watchdog: aiobale already sends a protocol-level ping frame every 5 s (no message,
    nobody sees it) and closes the websocket when a pong is late, but with run_in_background=True nothing ever reconnects and
    the dead client stayed in `sessions`, so /v1/health kept listing it as attached for ~31 h (27 Oct). Now every pong / frame
    from Bale is timestamped, and a session whose transport is closed, whose listener or ping loop stopped, or that got no pong
    for PONG_STALE_S is dropped from `sessions` (checked every WATCH_EVERY_S and on every /v1/health). The API then sees it
    missing from `attached` and re-attaches it with the already-sealed token (its existing once-a-minute path). The sidecar
    never logs in, never asks for a code and never sends anything to check liveness.
  * Inbound private messages are forwarded to BALE_INBOUND_URL (loopback HTTP only, straight to the API port, never
    through nginx) with the same internal token. Message text is never logged.
Contract: see CONTRACT.md. Run: BALE_SIDECAR_TOKEN_FILE=/etc/nafisvam/bale-sidecar.token python sidecar.py
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import sys
import time
from urllib.parse import urlparse
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from aiohttp import web  # noqa: E402

VERSION = "1b-0.6"
ATTACH_TIMEOUT_S = 25
MAX_TYPING_MS = 8000
MAX_TEXT = 4000
INBOUND_RETRIES = (1.0, 3.0, 10.0)
FLOW_TTL_S = 300
MAX_BODY = 16 * 1024
# /v1/send-file only: one plan file (≤ 10 MB) as base64 in the JSON body (the API reads the file; the sidecar never touches disk).
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILE_BODY = 15 * 1024 * 1024
FILE_MIMES = {"application/pdf": (b"%PDF-",), "image/jpeg": (b"\xff\xd8\xff",), "image/png": (b"\x89PNG\r\n\x1a\n",), "image/webp": (b"RIFF",)}
MAX_CAPTION = 1024
LIB_DEFAULT_DEVICE_HASH = "ce5ced83-a9ab-47fa-80c8-ed425eeb2ace"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PHONE_RE = re.compile(r"^09\d{9}$")
# /v1/contacts (READ-ONLY «اسکن بله»): one scan per account per cooldown; never sends, never adds/removes contacts, never logs names/phones.
CONTACTS_COOLDOWN_S = 300
CONTACTS_MAX = 3000
CONTACTS_CHUNK = 100
CONTACTS_PAUSE_S = 0.4
DIALOG_PAGES_MAX = 30
# BALE-FIXB-66 watchdog: aiobale pings every 5 s; no pong for this long (or a closed transport / stopped listener / stopped ping
# loop) = dead session → dropped so the API re-attaches it from the sealed token. Read-only observation: adds no traffic.
PONG_STALE_S = 45
WATCH_EVERY_S = 10
WATCHDOG_KEY = web.AppKey("watchdog", asyncio.Task)
log = logging.getLogger("bale-sidecar")


class SessionLoadError(Exception):
    """The sealed token could not be turned into a usable client identity (local problem, not a Bale answer)."""


def prime_identity(client: Any) -> None:
    """aiobale 0.3.10 bug: Client(token=..., session_file=None) builds UserAuth(id=...) without the required `name`;
    the pydantic ValidationError is swallowed in __init__, so client.id stays None and get_me()/load_users fails with
    InfoPeer(id=None). The JWT itself is fine: rebuild the identity from its user_id claim (no network, nothing logged)."""
    if getattr(client, "id", None) is not None or not hasattr(client, "_check_token"):
        return
    from aiobale.types import UserAuth  # vendored
    from aiobale.utils import parse_jwt  # vendored
    parsed = parse_jwt(getattr(client, "token", None) or "")
    payload = (parsed[0] if parsed else {}).get("payload") or {}
    uid = payload.get("user_id", payload.get("userId", payload.get("id")))
    if not isinstance(uid, int) and not (isinstance(uid, str) and uid.isdigit()):
        raise SessionLoadError("token has no user id")
    client._me = client._check_token(UserAuth(id=int(uid), name=""))


def default_client_factory(token: Optional[str] = None):
    from aiobale import Client  # vendored
    c = Client(session_file=None, token=token)
    if token:
        try:  # sign-out does not need the identity: never let a priming problem block it
            prime_identity(c)
        except Exception as e:
            log.warning("client identity not primed %s", describe(e))
    return c


def default_session_factory(token: str, on_message: Callable[[Any], Any]):
    """A long-lived client with a message handler. Still session_file=None: nothing touches the disk."""
    from aiobale import Client, Dispatcher  # vendored
    dp = Dispatcher()
    dp.message()(on_message)
    c = Client(dispatcher=dp, session_file=None, token=token)
    prime_identity(c)
    return c


def private_chat_type():
    try:
        from aiobale.enums import ChatType  # vendored
        return ChatType.PRIVATE
    except Exception:  # pragma: no cover
        return 1


def make_file_input(data: bytes, name: str, mime: str):
    from aiobale.types import FileInput  # vendored
    return FileInput(data, name=name, size=len(data), mime_type=mime)


def file_ok(data: bytes, mime: str) -> bool:
    heads = FILE_MIMES.get(mime)
    if not heads or not data or len(data) > MAX_FILE_BYTES or not any(data.startswith(h) for h in heads):
        return False
    return mime != "image/webp" or data[8:12] == b"WEBP"


def is_loopback_http(u: Optional[str]) -> bool:
    try:
        x = urlparse(u or "")
        return x.scheme == "http" and x.hostname in ("127.0.0.1", "::1", "localhost")
    except Exception:
        return False


async def default_poster(url: str, token: str, payload: dict) -> int:
    import aiohttp
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
        async with s.post(url, json=payload, headers={"x-bale-internal-token": token}, allow_redirects=False) as r:
            return r.status


@dataclass
class Session:
    client: Any
    me_id: Optional[int]
    peer_phone: dict = field(default_factory=dict)  # peerId -> 09.. (memory only; lets the API match a reply)
    attached_mono: float = 0.0
    attached_wall: float = 0.0
    last_pong_mono: Optional[float] = None  # last protocol pong from Bale (monotonic)
    last_pong_wall: Optional[float] = None
    last_rx_wall: Optional[float] = None    # last frame of any kind from Bale
    probed: bool = False                    # True when the real aiobale transport could be observed


def instrument(sess: Session, clock: Callable[[], float], wall: Callable[[], float]) -> bool:
    """Timestamp the library's own keep-alive: wrap the websocket session's send_bytes (returns only once the matching pong
    arrived; a late pong raises) and its frame handler. Never sends anything itself. False when the client is not a real
    aiobale client (tests) — such sessions are only dropped by explicit errors, exactly as before."""
    s = getattr(sess.client, "session", None)
    send, recv = getattr(s, "send_bytes", None), getattr(s, "_handle_received_data", None)
    if s is None or not callable(send) or not callable(recv) or not callable(getattr(s, "is_closed", None)):
        return False

    async def send_bytes(data, future_key, timeout=None):
        r = await send(data, future_key, timeout)
        if str(future_key).startswith("ping_"):
            sess.last_pong_mono, sess.last_pong_wall = clock(), wall()
        return r

    async def handle(data):
        sess.last_rx_wall = wall()
        return await recv(data)

    s.send_bytes = send_bytes
    s._handle_received_data = handle
    return True


def liveness(sess: Session, now: float, stale_s: float) -> Optional[str]:
    """None = alive (or not observable); otherwise the reason this client is dead. Pure inspection, no I/O."""
    if not sess.probed:
        return None
    c = sess.client
    s = getattr(c, "session", None)
    try:
        if s is None or s.is_closed():
            return "transport_closed"
        if getattr(s, "running", True) is False:
            return "listener_stopped"
        ws = getattr(s, "ws", None)
        if ws is not None and getattr(ws, "closed", False):
            return "ws_closed"
        pt = getattr(c, "_ping_task", None)
        if pt is None or pt.done():
            return "ping_loop_stopped"
    except Exception as e:  # never drop on a probe bug
        log.warning("liveness probe error %s", type(e).__name__)
        return None
    last = sess.last_pong_mono if sess.last_pong_mono is not None else sess.attached_mono
    if now - last > stale_s:
        return "no_pong"
    return None


@dataclass
class Flow:
    client: Any
    tx_hash: str
    expires: float
    step: str = "code"
    account_ref: str = ""


@dataclass
class State:
    token: str
    client_factory: Callable[..., Any] = default_client_factory
    flows: dict = field(default_factory=dict)
    clock: Callable[[], float] = time.monotonic
    session_factory: Callable[..., Any] = default_session_factory
    sessions: dict = field(default_factory=dict)
    boot_id: str = field(default_factory=lambda: secrets.token_hex(8))
    inbound_url: Optional[str] = None
    poster: Callable[..., Any] = default_poster
    sleep: Callable[[float], Any] = asyncio.sleep
    pending: set = field(default_factory=set)
    contacts_at: dict = field(default_factory=dict)  # accountRef -> clock() of the last /v1/contacts scan
    wall: Callable[[], float] = time.time
    pong_stale_s: float = PONG_STALE_S
    watch_every_s: float = WATCH_EVERY_S  # 0 = no background watchdog (health still checks)
    drops: dict = field(default_factory=dict)  # accountRef -> {at(ms), reason, count} — last watchdog drop (memory only)


def _ms(t: Optional[float]) -> Optional[int]:
    return None if t is None else int(t * 1000)


def sweep_dead(state: State) -> list:
    """Drop every dead live session (see liveness). Returns [(ref, reason)]. The client is stopped in the background."""
    now, out = state.clock(), []
    for ref, sess in list(state.sessions.items()):
        why = liveness(sess, now, state.pong_stale_s)
        if why is None or state.sessions.get(ref) is not sess:
            continue
        state.sessions.pop(ref, None)
        prev = state.drops.get(ref) or {}
        state.drops[ref] = {"at": _ms(state.wall()), "reason": why, "count": int(prev.get("count", 0)) + 1}
        log.warning("session dropped ref=%s reason=%s", ref, why)
        t = asyncio.ensure_future(_stop_quiet(sess.client))
        state.pending.add(t); t.add_done_callback(state.pending.discard)
        out.append((ref, why))
    return out


def read_token(path: Optional[str]) -> str:
    if not path:
        raise SystemExit("BALE_SIDECAR_TOKEN_FILE is required")
    with open(path, "r", encoding="utf-8") as f:
        t = f.read().strip()
    if len(t) < 32:
        raise SystemExit("sidecar token file too short")
    return t


def err(status: int, code: str, step: Optional[str] = None) -> web.Response:
    return web.json_response({"error": code, **({"step": step} if step else {})}, status=status)


def auth_error_code(e: Any) -> str:
    """Map aiobale AuthErrors (by name, so tests need not import the lib) to the API contract codes."""
    name = getattr(e, "name", str(e))
    return {
        "NUMBER_BANNED": "number_banned", "AUTH_LIMIT": "rate_limited", "RATE_LIMIT": "rate_limited", "INVALID": "phone_invalid",
        "WRONG_CODE": "wrong_code", "SIGN_UP_NEEDED": "sign_up_needed", "WRONG_PASSWORD": "wrong_password",
    }.get(name, "unknown")


PEER_BLOCKED_HINTS = ("USER_BLOCKED", "PEER_BLOCKED", "BLOCKED_BY_USER", "BLOCKED_BY_PEER", "YOU_ARE_BLOCKED", "USER_IS_BLOCKED")


def bale_error_code(e: Any) -> str:
    """Map a runtime BaleError to a contract code by its message text (aiobale has no typed runtime errors).
    The substrings are a best guess and must be confirmed with the test SIM before go-live."""
    if getattr(e, "topic", None) is None and not hasattr(e, "message"):
        return "unknown"
    m = str(getattr(e, "message", "") or "").upper()
    if any(k in m for k in ("FLOOD", "RATE", "LIMIT", "TOO_MANY")):
        return "rate_limited"
    # UNVERIFIED (PM decision b): "this one customer blocked the expert". The exact Bale wording is not known yet; these
    # substrings are a guess to be confirmed with the test SIM. The API treats peer_blocked exactly like account_banned
    # (whole account stops) unless the admin setting peer_block_mode = conversation_pause is switched on after verification.
    if any(k in m for k in PEER_BLOCKED_HINTS):
        return "peer_blocked"
    if any(k in m for k in ("BAN", "BLOCK", "DEACTIVATED")):
        return "account_banned"
    if any(k in m for k in ("AUTH", "TOKEN", "SESSION", "UNAUTHORIZED")):
        return "session_invalid"
    if any(k in m for k in ("PEER", "USER_NOT_FOUND", "NOT_FOUND")):
        return "peer_not_found"
    return "unknown"


_REDACT = ((re.compile(r"eyJ[\w.-]+"), "<jwt>"), (re.compile(r"[A-Za-z0-9+/=_-]{24,}"), "<blob>"), (re.compile(r"\d{5,}"), "<n>"))


def describe(e: BaseException) -> str:
    """Exception class + a redacted, short message for the journal. Never the token, phone numbers or request data:
    pydantic errors are reduced to field location + error type (their text can echo input values)."""
    name = type(e).__name__
    errs = getattr(e, "errors", None)
    if callable(errs) and name == "ValidationError":
        try:
            return name + " " + "; ".join(".".join(map(str, x.get("loc", ()))) + ":" + str(x.get("type")) for x in errs()[:3])
        except Exception:
            return name
    m = str(getattr(e, "message", "") or e or "")
    for rx, rep in _REDACT:
        m = rx.sub(rep, m)
    return (name + " " + " ".join(m.split()))[:200]


def error_code(e: BaseException) -> str:
    """Contract code for a runtime exception: Bale answers via bale_error_code; local client failures (bad identity,
    validation, library bugs) are `client_error` so they are never mistaken for an invalid or banned session."""
    if isinstance(e, asyncio.TimeoutError):
        return "timeout"
    if getattr(e, "topic", None) is None and not hasattr(e, "message"):
        return "client_error"
    return bale_error_code(e)


STATUS = {"client_error": 502, "timeout": 504, "phone_invalid": 422, "wrong_code": 422, "wrong_password": 422, "sign_up_needed": 422, "rate_limited": 429,
          "number_banned": 403, "flow_expired": 410, "code_expired": 410, "unknown": 502,
          "not_attached": 409, "peer_not_found": 404, "session_invalid": 401, "account_banned": 403, "peer_blocked": 403, "bad_request": 400}


async def _stop(client: Any) -> None:
    try:
        await client.stop()
    except Exception:  # best effort
        pass


async def _stop_quiet(client: Any) -> None:
    try:
        await asyncio.wait_for(_stop(client), 10)
    except Exception:
        pass


def phone_ok(phone: str, peer: Any) -> bool:
    """A valid 09.. number, or no number at all when the API already knows the Bale user id (customer_bale_links)."""
    return bool(PHONE_RE.match(phone)) or (phone == "" and isinstance(peer, (str, int)) and str(peer).isdigit())


def contact_phone(full: Any) -> Optional[str]:
    """FullUser.contact_info.value → 09xxxxxxxxx when it looks like an Iranian mobile; anything else is dropped."""
    v = getattr(getattr(full, "contact_info", None), "value", None)
    d = re.sub(r"\D", "", str(v)) if v is not None else ""
    if d.startswith("0098"):
        d = d[4:]
    elif d.startswith("98") and len(d) == 12:
        d = d[2:]
    elif d.startswith("0") and len(d) == 11:
        d = d[1:]
    return "0" + d if re.fullmatch(r"9\d{9}", d) else None


_LOOSE: Any = None


def loose_methods() -> Any:
    """Read-only Bale methods whose responses are kept RAW (field-number dicts) instead of aiobale's strict models:
    on the live server GetContacts' model reads the wrong field and LoadDialogs fails on bot/template messages."""
    global _LOOSE
    if _LOOSE is None:
        from types import SimpleNamespace
        from aiobale.types.base import BaleObject
        from aiobale.methods import GetContacts, LoadDialogs, LoadUsers

        class LooseResponse(BaleObject):
            pass

        class GetContactsRaw(GetContacts):
            __returning__ = LooseResponse

        class LoadDialogsRaw(LoadDialogs):
            __returning__ = LooseResponse

        class LoadUsersRaw(LoadUsers):
            __returning__ = LooseResponse

        _LOOSE = SimpleNamespace(contacts=GetContactsRaw, dialogs=LoadDialogsRaw, users=LoadUsersRaw)
    return _LOOSE


def _raw(res: Any) -> dict:
    d = getattr(res, "model_extra", None)
    return d if isinstance(d, dict) else (res if isinstance(res, dict) else {})


def _f(d: Any, k: str) -> Any:
    """Field k of a decoded message (the decoder may suffix alternative interpretations as 'k-…')."""
    if not isinstance(d, dict):
        return None
    if k in d:
        return d[k]
    for kk, v in d.items():
        if isinstance(kk, str) and kk.split("-")[0] == k:
            return v
    return None


def _list(v: Any) -> list:
    return v if isinstance(v, list) else ([] if v is None else [v])


def _int(v: Any) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.isdigit():
        return int(v)
    return None


def _text(v: Any) -> str:
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            return ""
    if isinstance(v, dict):  # aiobale's StringValue wrapper
        return _text(_f(v, "1")) if set(v) <= {"1"} else ""
    return v if isinstance(v, str) else ""


async def read_contacts(c: Any, sleep: Callable[..., Any]) -> dict:
    """READ-ONLY. GetContacts (user ids) → LoadUsers (name / saved contact name) → LoadFullUsers (phone, best effort).
    Falls back to the dialog list (private chats only) when the contact list is unavailable or empty.
    Responses are read raw (see loose_methods); only counts / field numbers are ever logged."""
    from aiobale.types import InfoPeer
    from aiobale.enums import ChatType
    M = loose_methods()
    source, ids = "contacts", []
    try:
        raw = _raw(await c(M.contacts()))
        log.info("/v1/contacts get_contacts shape %s", {k: len(_list(v)) for k, v in raw.items() if k != "method_data"})
        for k in ("3", "1"):  # user peers (uid=1) — then full users (id=1)
            for it in _list(_f(raw, k)):
                uid = _int(_f(it, "1"))
                if uid and uid > 0:
                    ids.append(uid)
            if ids:
                break
    except Exception as e:
        log.warning("/v1/contacts get_contacts unavailable %s", describe(e))
        ids = []
    if not ids:
        source, seen, offset = "dialogs", set(), -1
        for _ in range(DIALOG_PAGES_MAX):
            page = _list(_f(_raw(await c(M.dialogs(offset_date=offset, limit=100, exclude_pinned=False))), "3"))
            last = None
            for d in page:
                peer = _f(d, "1"); t = _int(_f(peer, "1")); pid = _int(_f(peer, "2"))
                if t == 1 and pid and pid not in seen:
                    seen.add(pid); ids.append(pid)
                last = _int(_f(d, "3")) or _int(_f(d, "6")) or last
            if len(page) < 100 or last is None or last == offset or len(ids) >= CONTACTS_MAX:
                break
            offset = last
            await sleep(CONTACTS_PAUSE_S)
    truncated = len(ids) > CONTACTS_MAX
    ids = list(dict.fromkeys(ids))[:CONTACTS_MAX]
    out: dict = {}
    for i in range(0, len(ids), CONTACTS_CHUNK):
        chunk = [InfoPeer(id=x, type=ChatType.PRIVATE) for x in ids[i:i + CONTACTS_CHUNK]]
        if i:
            await sleep(CONTACTS_PAUSE_S)
        for u in _list(_f(_raw(await c(M.users(peers=chunk))), "1")):
            uid = _int(_f(u, "1"))
            if not uid or _int(_f(u, "16")) or _int(_f(u, "7")):  # deleted / bot
                continue
            out[uid] = {"baleUserId": str(uid), "name": _text(_f(u, "3"))[:120],
                        "localName": _text(_f(u, "4"))[:120] or None, "phone": None}
        if source == "contacts":
            try:
                await sleep(CONTACTS_PAUSE_S)
                for f in await c.load_full_users(chunk) or []:
                    uid = getattr(f, "id", None)
                    if uid is not None and int(uid) in out:
                        out[int(uid)]["phone"] = contact_phone(f)
            except Exception as e:  # the phone is optional: names and ids still match
                log.warning("/v1/contacts full_users unavailable %s", describe(e))
    return {"source": source, "contacts": list(out.values()), "truncated": truncated}


def make_app(state: State) -> web.Application:
    @web.middleware
    async def guard(request: web.Request, handler):
        given = request.headers.get("x-bale-internal-token", "")
        if not hmac.compare_digest(given.encode(), state.token.encode()):
            log.warning("%s unauthorized", request.path)
            return err(401, "unauthorized")
        try:
            resp = await handler(request)
        except web.HTTPException:
            raise
        except Exception as e:  # never echo exception text to the caller: it may contain request data
            log.error("%s exception %s", request.path, describe(e))
            return err(502, "client_error")
        # 1b-0.6: the CRM reads health every 10 s; a 200 there is not worth a journal line
        (log.debug if request.path == "/v1/health" and resp.status == 200 else log.info)("%s %s", request.path, resp.status)
        return resp

    async def body(request: web.Request) -> dict:
        try:
            j = await request.json()
        except Exception:
            raise web.HTTPBadRequest(text='{"error":"unknown"}', content_type="application/json")
        return j if isinstance(j, dict) else {}

    def gc() -> None:
        now = state.clock()
        for fid in [k for k, f in state.flows.items() if f.expires <= now]:
            f = state.flows.pop(fid)
            asyncio.ensure_future(_stop(f.client))

    def take(fid: Any, step: str) -> Optional[Flow]:
        gc()
        f = state.flows.get(fid) if isinstance(fid, str) else None
        return f if f and f.step == step else None

    async def health(_r: web.Request):
        gc()
        sweep_dead(state)  # never report a dead client as attached
        live = {ref: {"attachedAt": _ms(s.attached_wall), "lastPongAt": _ms(s.last_pong_wall), "lastRxAt": _ms(s.last_rx_wall),
                      "probe": "ping" if s.probed else "none"} for ref, s in sorted(state.sessions.items())}
        return web.json_response({"ok": True, "version": VERSION, "sessions": len(state.sessions), "flows": len(state.flows),
                                  "bootId": state.boot_id, "attached": sorted(state.sessions.keys()), "live": live,
                                  "drops": dict(state.drops), "pongStaleS": state.pong_stale_s})

    async def start(request: web.Request):
        j = await body(request)
        phone, dh, title = str(j.get("phone", "")), str(j.get("deviceHash", "")), str(j.get("deviceTitle", ""))[:64] or "Nafis CRM"
        if not PHONE_RE.match(phone):
            return err(422, "phone_invalid")
        if not UUID_RE.match(dh) or dh == LIB_DEFAULT_DEVICE_HASH:
            return err(400, "unknown")
        client = state.client_factory()
        res = await client.start_phone_auth(int("98" + phone[1:]), device_title=title, device_hash=dh)
        tx = getattr(res, "transaction_hash", None)
        if not tx:
            await _stop(client)
            code = auth_error_code(res)
            return err(STATUS[code], code)
        gc()
        fid = secrets.token_urlsafe(24)
        state.flows[fid] = Flow(client=client, tx_hash=tx, expires=state.clock() + FLOW_TTL_S, account_ref=str(j.get("accountRef", ""))[:40])
        sent = getattr(getattr(res, "sent_code_type", None), "name", "")
        return web.json_response({"flowId": fid, "codeType": "app" if sent == "BALEONLY" else "unknown", "expiresInS": FLOW_TTL_S})

    def connected(fid: str, f: Flow, res: Any) -> web.Response:
        state.flows.pop(fid, None)
        token = getattr(getattr(res, "jwt", None), "value", None)
        user = getattr(res, "user", None)
        asyncio.ensure_future(_stop(f.client))  # login session closed; 1b attaches a live client from the sealed token
        if not token:
            return err(502, "unknown")
        uid = getattr(user, "id", None)
        return web.json_response({"status": "connected", "token": token, "baleUserId": str(uid) if uid is not None else None})

    async def code(request: web.Request):
        j = await body(request)
        fid = j.get("flowId"); f = take(fid, "code")
        if not f:
            return err(410, "flow_expired")
        c = str(j.get("code", ""))
        if not re.fullmatch(r"\d{4,6}", c):
            return err(422, "wrong_code")
        res = await f.client.validate_code(c, f.tx_hash)
        if getattr(res, "jwt", None) is not None:
            return connected(fid, f, res)
        if getattr(res, "name", "") == "PASSWORD_NEEDED":
            f.step = "password"
            return web.json_response({"status": "password_needed"})
        code_ = auth_error_code(res)
        if code_ == "sign_up_needed":
            state.flows.pop(fid, None); await _stop(f.client)
        return err(STATUS[code_], code_)

    async def password(request: web.Request):
        j = await body(request)
        fid = j.get("flowId"); f = take(fid, "password")
        if not f:
            return err(410, "flow_expired")
        p = j.get("password")
        if not isinstance(p, str) or not p or len(p) > 256:
            return err(422, "wrong_password")
        res = await f.client.validate_password(p, f.tx_hash)
        if getattr(res, "jwt", None) is not None:
            return connected(fid, f, res)
        code_ = auth_error_code(res)
        return err(STATUS[code_], code_)

    async def cancel(request: web.Request):
        j = await body(request)
        f = state.flows.pop(j.get("flowId"), None) if isinstance(j.get("flowId"), str) else None
        if f:
            await _stop(f.client)
        return web.json_response({"ok": True})

    async def signout(request: web.Request):
        j = await body(request)
        tok = j.get("token")
        if not isinstance(tok, str) or not tok:
            return err(400, "unknown")
        old = state.sessions.pop(str(j.get("accountRef", "")), None)
        if old:
            await _stop(old.client)
        client = state.client_factory(token=tok)
        try:
            await client.sign_out(delete_session=False)
        finally:
            await _stop(client)
        return web.json_response({"ok": True})

    # ---------------- 1b: live sessions, send, inbound ----------------
    def ref_of(j: dict) -> str:
        r = str(j.get("accountRef", ""))
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", r):
            raise web.HTTPBadRequest(text='{"error":"bad_request"}', content_type="application/json")
        return r

    async def forward(ref: str, ev: dict) -> None:
        if not is_loopback_http(state.inbound_url):
            log.warning("inbound dropped (no BALE_INBOUND_URL)")
            return
        for i, delay in enumerate((0.0,) + INBOUND_RETRIES):
            if delay:
                await state.sleep(delay)
            try:
                st = await state.poster(state.inbound_url, state.token, {"accountRef": ref, "events": [ev]})
                if 200 <= st < 300:
                    log.info("inbound forwarded")
                    return
                if st in (400, 403):  # refused by the API: retrying will not help
                    log.warning("inbound refused %s", st)
                    return
            except Exception as e:
                log.warning("inbound post failed %s", type(e).__name__)
        log.error("inbound gave up")

    def make_handler(ref: str):
        async def on_message(message: Any) -> None:
            sess = state.sessions.get(ref)
            chat = getattr(message, "chat", None)
            ctype = getattr(getattr(chat, "type", None), "value", getattr(chat, "type", None))
            if sess is None or chat is None or ctype != 1:  # private chats only
                return
            content = getattr(message, "content", None)
            text_obj = getattr(content, "text", None)
            text = getattr(text_obj, "value", None) if text_obj is not None else None
            if text is not None and not isinstance(text, str):
                text = str(text)
            has_file = text is None and content is not None and any(
                getattr(content, k, None) is not None for k in ("document", "photo", "video", "voice", "audio"))
            peer = str(getattr(chat, "id", ""))
            ev = {"peerId": peer, "peerPhone": sess.peer_phone.get(peer), "messageId": str(getattr(message, "message_id", "")),
                  "text": text, "hasFile": bool(has_file), "fromSelf": sess.me_id is not None and getattr(message, "sender_id", None) == sess.me_id,
                  "date": getattr(message, "date", None)}
            t = asyncio.ensure_future(forward(ref, ev))
            state.pending.add(t); t.add_done_callback(state.pending.discard)
        return on_message

    async def attach(request: web.Request):
        j = await body(request)
        ref = ref_of(j)
        tok = j.get("token")
        if not isinstance(tok, str) or not tok:
            return err(400, "bad_request")
        old = state.sessions.pop(ref, None)
        if old:
            await _stop(old.client)
        client = None
        step = "load"
        try:
            client = state.session_factory(tok, make_handler(ref))
            step = "connect"
            await asyncio.wait_for(client.start(run_in_background=True, signal_handling=False), ATTACH_TIMEOUT_S)
            step = "get_me"
            me = await asyncio.wait_for(client.get_me(), ATTACH_TIMEOUT_S)
        except Exception as e:
            if client is not None:
                await _stop(client)
            code_ = error_code(e)
            log.warning("/v1/session/attach failed step=%s code=%s %s", step, code_, describe(e))
            return err(STATUS[code_], code_, step)
        uid = getattr(getattr(me, "user", me), "id", None)
        sess = Session(client=client, me_id=uid, attached_mono=state.clock(), attached_wall=state.wall())
        sess.probed = instrument(sess, state.clock, state.wall)
        state.sessions[ref] = sess
        return web.json_response({"ok": True, "baleUserId": str(uid) if uid is not None else None})

    async def detach(request: web.Request):
        j = await body(request)
        s = state.sessions.pop(ref_of(j), None)
        if s:
            await _stop(s.client)
        return web.json_response({"ok": True})

    async def send(request: web.Request):
        j = await body(request)
        ref = ref_of(j)
        phone, text, peer = str(j.get("phone", "")), j.get("text"), j.get("peerId")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or not phone_ok(phone, peer):
            return err(400, "bad_request")
        try:
            typing_ms = max(0, min(MAX_TYPING_MS, int(j.get("typingMs", 0))))
        except (TypeError, ValueError):
            typing_ms = 0
        sess = state.sessions.get(ref)
        if sess is None:
            return err(409, "not_attached")
        c = sess.client
        pt = private_chat_type()
        try:
            chat_id = int(peer) if isinstance(peer, (str, int)) and str(peer).isdigit() else None
            if chat_id is None:
                found = await c.search_contact("98" + phone[1:])  # lookup only: never import into the expert's contacts
                if not found or getattr(found, "id", None) is None:
                    return err(404, "peer_not_found")
                chat_id = int(found.id)
            if phone:
                sess.peer_phone[str(chat_id)] = phone
            if typing_ms:
                try:
                    await c.start_typing(chat_id, pt)
                    await state.sleep(typing_ms / 1000)
                finally:
                    try:
                        await c.stop_typing(chat_id, pt)
                    except Exception:
                        pass
            msg = await c.send_message(text, chat_id, pt)
        except Exception as e:
            code_ = error_code(e)
            log.warning("/v1/send error %s", describe(e))
            if code_ in ("session_invalid", "account_banned"):
                state.sessions.pop(ref, None)
                await _stop(c)
            log.warning("/v1/send failed %s", code_)
            return err(STATUS[code_], code_)
        if isinstance(msg, list):
            msg = msg[0] if msg else None
        mid = getattr(msg, "message_id", None)
        if mid is None:
            return err(502, "unknown")
        return web.json_response({"messageId": str(mid), "peerId": str(chat_id)})

    async def send_file(request: web.Request):
        """One plan file (document) with a caption. Same pipe semantics as /v1/send: the API already decided everything
        (switch, approval, caps, gaps, quiet hours, live session, peer-block policy); this only checks the bytes."""
        try:
            j = await request.clone(client_max_size=MAX_FILE_BODY).json()
        except Exception:
            return err(400, "bad_request")
        if not isinstance(j, dict):
            return err(400, "bad_request")
        ref = ref_of(j)
        phone, peer, caption = str(j.get("phone", "")), j.get("peerId"), j.get("caption")
        name, mime, b64, sha = j.get("fileName"), j.get("mime"), j.get("fileB64"), j.get("sha256")
        if (not phone_ok(phone, peer) or not isinstance(caption, str) or len(caption) > MAX_CAPTION or not isinstance(name, str)
                or not name.strip() or len(name) > 120 or "/" in name or "\\" in name or not isinstance(mime, str) or not isinstance(b64, str)
                or not isinstance(sha, str)):
            return err(400, "bad_request")
        try:
            data = base64.b64decode(b64, validate=True)
        except Exception:
            return err(400, "bad_request")
        if not file_ok(data, mime) or not hmac.compare_digest(hashlib.sha256(data).hexdigest(), sha.lower()):
            return err(400, "bad_request")
        try:
            typing_ms = max(0, min(MAX_TYPING_MS, int(j.get("typingMs", 0))))
        except (TypeError, ValueError):
            typing_ms = 0
        sess = state.sessions.get(ref)
        if sess is None:
            return err(409, "not_attached")
        c = sess.client
        pt = private_chat_type()
        try:
            chat_id = int(peer) if isinstance(peer, (str, int)) and str(peer).isdigit() else None
            if chat_id is None:
                found = await c.search_contact("98" + phone[1:])  # lookup only: never import into the expert's contacts
                if not found or getattr(found, "id", None) is None:
                    return err(404, "peer_not_found")
                chat_id = int(found.id)
            if phone:
                sess.peer_phone[str(chat_id)] = phone
            if typing_ms:
                try:
                    await c.start_typing(chat_id, pt)
                    await state.sleep(typing_ms / 1000)
                finally:
                    try:
                        await c.stop_typing(chat_id, pt)
                    except Exception:
                        pass
            msg = await c.send_document(make_file_input(data, name.strip(), mime), chat_id, pt, caption=caption.strip() or None)
        except Exception as e:
            code_ = error_code(e)
            log.warning("/v1/send-file error %s", describe(e))
            if code_ in ("session_invalid", "account_banned"):
                state.sessions.pop(ref, None)
                await _stop(c)
            log.warning("/v1/send-file failed %s", code_)
            return err(STATUS[code_], code_)
        if isinstance(msg, list):
            msg = msg[0] if msg else None
        mid = getattr(msg, "message_id", None)
        if mid is None:
            return err(502, "unknown")
        return web.json_response({"messageId": str(mid), "peerId": str(chat_id)})

    async def contacts(request: web.Request):
        """READ-ONLY contact list of one attached account («اسکن بله و اتصال مشتری»). Rate-limited per account; the result
        lives only in this response (never logged, never stored here)."""
        j = await body(request)
        ref = ref_of(j)
        sess = state.sessions.get(ref)
        if sess is None:
            return err(409, "not_attached")
        now = state.clock()
        last = state.contacts_at.get(ref)
        if last is not None and now - last < CONTACTS_COOLDOWN_S:
            return web.json_response({"error": "rate_limited", "retryAfterS": int(CONTACTS_COOLDOWN_S - (now - last)) + 1}, status=429)
        state.contacts_at[ref] = now
        try:
            res = await read_contacts(sess.client, state.sleep)
        except Exception as e:
            code_ = error_code(e)
            log.warning("/v1/contacts error %s", describe(e))
            if code_ in ("session_invalid", "account_banned"):
                state.sessions.pop(ref, None)
                await _stop(sess.client)
            return err(STATUS[code_], code_)
        log.info("/v1/contacts ok source=%s n=%d", res["source"], len(res["contacts"]))
        return web.json_response(res)

    async def watchdog() -> None:
        while True:
            await asyncio.sleep(state.watch_every_s)
            try:
                sweep_dead(state)
            except Exception as e:  # keep watching
                log.error("watchdog error %s", type(e).__name__)

    async def on_startup(app: web.Application) -> None:
        if state.watch_every_s and state.watch_every_s > 0:
            app[WATCHDOG_KEY] = asyncio.ensure_future(watchdog())

    async def on_cleanup(app: web.Application) -> None:
        w = app.get(WATCHDOG_KEY)
        if w is not None:
            w.cancel()
        for ref in list(state.sessions):
            await _stop(state.sessions.pop(ref).client)
        for t in list(state.pending):
            t.cancel()

    app = web.Application(middlewares=[guard], client_max_size=MAX_BODY)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_post("/v1/session/attach", attach)
    app.router.add_post("/v1/session/detach", detach)
    app.router.add_post("/v1/send", send)
    app.router.add_post("/v1/send-file", send_file)
    app.router.add_post("/v1/contacts", contacts)
    app.router.add_get("/v1/health", health)
    app.router.add_post("/v1/auth/start", start)
    app.router.add_post("/v1/auth/code", code)
    app.router.add_post("/v1/auth/password", password)
    app.router.add_post("/v1/auth/cancel", cancel)
    app.router.add_post("/v1/session/signout", signout)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("aiobale").setLevel(logging.WARNING)
    host = os.environ.get("BALE_SIDECAR_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "::1"):
        raise SystemExit("sidecar must listen on loopback only")
    port = int(os.environ.get("BALE_SIDECAR_PORT", "18470"))
    inbound = os.environ.get("BALE_INBOUND_URL") or None
    if inbound and not is_loopback_http(inbound):
        raise SystemExit("BALE_INBOUND_URL must be loopback http (direct to the API port, not nginx)")
    state = State(token=read_token(os.environ.get("BALE_SIDECAR_TOKEN_FILE")), inbound_url=inbound)
    web.run_app(make_app(state), host=host, port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
