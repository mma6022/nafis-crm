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
  * Inbound private messages are forwarded to BALE_INBOUND_URL (loopback HTTP only, straight to the API port, never
    through nginx) with the same internal token. Message text is never logged.
Contract: see CONTRACT.md. Run: BALE_SIDECAR_TOKEN_FILE=/etc/nafisvam/bale-sidecar.token python sidecar.py
"""
from __future__ import annotations

import asyncio
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

VERSION = "1b-0.1"
ATTACH_TIMEOUT_S = 25
MAX_TYPING_MS = 8000
MAX_TEXT = 4000
INBOUND_RETRIES = (1.0, 3.0, 10.0)
FLOW_TTL_S = 300
MAX_BODY = 16 * 1024
LIB_DEFAULT_DEVICE_HASH = "ce5ced83-a9ab-47fa-80c8-ed425eeb2ace"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PHONE_RE = re.compile(r"^09\d{9}$")
log = logging.getLogger("bale-sidecar")


def default_client_factory(token: Optional[str] = None):
    from aiobale import Client  # vendored
    return Client(session_file=None, token=token)


def default_session_factory(token: str, on_message: Callable[[Any], Any]):
    """A long-lived client with a message handler. Still session_file=None: nothing touches the disk."""
    from aiobale import Client, Dispatcher  # vendored
    dp = Dispatcher()
    dp.message()(on_message)
    return Client(dispatcher=dp, session_file=None, token=token)


def private_chat_type():
    try:
        from aiobale.enums import ChatType  # vendored
        return ChatType.PRIVATE
    except Exception:  # pragma: no cover
        return 1


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


def read_token(path: Optional[str]) -> str:
    if not path:
        raise SystemExit("BALE_SIDECAR_TOKEN_FILE is required")
    with open(path, "r", encoding="utf-8") as f:
        t = f.read().strip()
    if len(t) < 32:
        raise SystemExit("sidecar token file too short")
    return t


def err(status: int, code: str) -> web.Response:
    return web.json_response({"error": code}, status=status)


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


STATUS = {"phone_invalid": 422, "wrong_code": 422, "wrong_password": 422, "sign_up_needed": 422, "rate_limited": 429,
          "number_banned": 403, "flow_expired": 410, "code_expired": 410, "unknown": 502,
          "not_attached": 409, "peer_not_found": 404, "session_invalid": 401, "account_banned": 403, "peer_blocked": 403, "bad_request": 400}


async def _stop(client: Any) -> None:
    try:
        await client.stop()
    except Exception:  # best effort
        pass


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
        except Exception as e:  # never echo exception text: it may contain request data
            log.error("%s exception %s", request.path, type(e).__name__)
            return err(502, "unknown")
        log.info("%s %s", request.path, resp.status)
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
        return web.json_response({"ok": True, "version": VERSION, "sessions": len(state.sessions), "flows": len(state.flows),
                                  "bootId": state.boot_id, "attached": sorted(state.sessions.keys())})

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
        client = state.session_factory(tok, make_handler(ref))
        try:
            await asyncio.wait_for(client.start(run_in_background=True, signal_handling=False), ATTACH_TIMEOUT_S)
            me = await client.get_me()
        except asyncio.TimeoutError:
            await _stop(client)
            return err(502, "unknown")
        except Exception as e:
            await _stop(client)
            code_ = bale_error_code(e)
            return err(STATUS[code_], code_)
        uid = getattr(getattr(me, "user", me), "id", None)
        state.sessions[ref] = Session(client=client, me_id=uid)
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
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or not PHONE_RE.match(phone):
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
            code_ = bale_error_code(e)
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

    async def on_cleanup(_app: web.Application) -> None:
        for ref in list(state.sessions):
            await _stop(state.sessions.pop(ref).client)
        for t in list(state.pending):
            t.cancel()

    app = web.Application(middlewares=[guard], client_max_size=MAX_BODY)
    app.on_cleanup.append(on_cleanup)
    app.router.add_post("/v1/session/attach", attach)
    app.router.add_post("/v1/session/detach", detach)
    app.router.add_post("/v1/send", send)
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
