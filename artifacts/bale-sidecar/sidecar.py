"""Nafis CRM — Bale personal-account sidecar (piece 1a: login + sign-out only).

A "pipe" between the CRM API and Bale. It listens on 127.0.0.1 ONLY, requires the internal token
(`x-bale-internal-token`, read from BALE_SIDECAR_TOKEN_FILE) on every request, has no DB access and makes no decisions:
eligibility, switches, rate limits and audit all live in the API (artifacts/api-server/src/lib/bale.ts).

Security rules:
  * No session is ever written to disk: every aiobale Client is created with session_file=None.
  * The Bale transaction_hash stays in this process's memory only (flow TTL 5 min) and is never returned.
  * Each login uses the per-expert device id sent by the API — never aiobale's shared default device hash.
  * Phone numbers, codes, 2FA passwords and session tokens are never logged; access logging is off and the only
    log lines are "<route> <outcome>".
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
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from aiohttp import web  # noqa: E402

VERSION = "1a-0.1"
FLOW_TTL_S = 300
MAX_BODY = 16 * 1024
LIB_DEFAULT_DEVICE_HASH = "ce5ced83-a9ab-47fa-80c8-ed425eeb2ace"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PHONE_RE = re.compile(r"^09\d{9}$")
log = logging.getLogger("bale-sidecar")


def default_client_factory(token: Optional[str] = None):
    from aiobale import Client  # vendored
    return Client(session_file=None, token=token)


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


STATUS = {"phone_invalid": 422, "wrong_code": 422, "wrong_password": 422, "sign_up_needed": 422, "rate_limited": 429,
          "number_banned": 403, "flow_expired": 410, "code_expired": 410, "unknown": 502}


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
        return web.json_response({"ok": True, "version": VERSION, "sessions": 0, "flows": len(state.flows)})

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
        client = state.client_factory(token=tok)
        try:
            await client.sign_out(delete_session=False)
        finally:
            await _stop(client)
        return web.json_response({"ok": True})

    app = web.Application(middlewares=[guard], client_max_size=MAX_BODY)
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
    state = State(token=read_token(os.environ.get("BALE_SIDECAR_TOKEN_FILE")))
    web.run_app(make_app(state), host=host, port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
