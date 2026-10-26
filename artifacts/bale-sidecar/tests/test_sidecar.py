"""Offline tests for sidecar.py with a FAKE aiobale client (never talks to Bale, never sends a code).
Run: python -m unittest discover -s tests   (from artifacts/bale-sidecar, with requirements.txt installed)"""
import asyncio
import io
import logging
import os
import sys
import tempfile
import unittest
from enum import Enum
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sidecar  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

TOKEN = "t" * 40
DH = "0b7c3f5e-1d2a-4c3b-9e8f-112233445566"


class AE(Enum):
    UNKNOWN = 0; NUMBER_BANNED = 1; WRONG_CODE = 3; PASSWORD_NEEDED = 4; SIGN_UP_NEEDED = 5; WRONG_PASSWORD = 6; RATE_LIMIT = 7; INVALID = 8


class FakeClient:
    instances = []

    def __init__(self, token=None):
        self.token = token; self.calls = []; self.stopped = False
        FakeClient.instances.append(self)

    async def start_phone_auth(self, phone, device_title, device_hash):
        self.calls.append(("start", phone, device_title, device_hash))
        if phone == 989990000009:
            return AE.NUMBER_BANNED
        if phone == 989990000007:
            return AE.RATE_LIMIT
        return SimpleNamespace(transaction_hash="TX-SECRET", sent_code_type=SimpleNamespace(name="BALEONLY"))

    async def validate_code(self, code, tx):
        self.calls.append(("code", tx))
        if code == "11111":
            return SimpleNamespace(jwt=SimpleNamespace(value="JWT-SECRET"), user=SimpleNamespace(id=4242))
        if code == "22222":
            return AE.PASSWORD_NEEDED
        if code == "33333":
            return AE.SIGN_UP_NEEDED
        return AE.WRONG_CODE

    async def validate_password(self, pw, tx):
        self.calls.append(("pw", tx))
        return SimpleNamespace(jwt=SimpleNamespace(value="JWT-2FA"), user=SimpleNamespace(id=7)) if pw == "ok-2fa" else AE.WRONG_PASSWORD

    async def sign_out(self, delete_session=True):
        assert delete_session is False
        self.calls.append(("signout", self.token))

    async def stop(self):
        self.stopped = True


class SidecarTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeClient.instances.clear()
        self.now = [1000.0]
        self.state = sidecar.State(token=TOKEN, client_factory=lambda token=None: FakeClient(token), clock=lambda: self.now[0])
        self.logbuf = io.StringIO(); h = logging.StreamHandler(self.logbuf); sidecar.log.addHandler(h); sidecar.log.setLevel(logging.DEBUG); self._h = h
        self.c = TestClient(TestServer(sidecar.make_app(self.state))); await self.c.start_server()

    async def asyncTearDown(self):
        await self.c.close(); sidecar.log.removeHandler(self._h)

    async def post(self, path, body, token=TOKEN):
        r = await self.c.post(path, json=body, headers={"x-bale-internal-token": token})
        return r.status, await r.json()

    async def test_requires_token(self):
        r = await self.c.get("/v1/health"); self.assertEqual(r.status, 401)
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": DH}, token="wrong" * 10); self.assertEqual(s, 401)
        self.assertEqual(FakeClient.instances, [])
        r = await self.c.get("/v1/health", headers={"x-bale-internal-token": TOKEN}); self.assertEqual((await r.json())["ok"], True)

    async def test_code_flow_and_no_leaks(self):
        s, j = await self.post("/v1/auth/start", {"accountRef": "user-2", "phone": "09120000000", "deviceHash": DH, "deviceTitle": "Nafis CRM, Linux"})
        self.assertEqual(s, 200); self.assertEqual(j["codeType"], "app"); self.assertNotIn("TX-SECRET", str(j))
        self.assertEqual(FakeClient.instances[0].calls[0], ("start", 989120000000, "Nafis CRM, Linux", DH))
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "00000"}); self.assertEqual((s, j2["error"]), (422, "wrong_code"))
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "11111"})
        self.assertEqual(s, 200); self.assertEqual(j2, {"status": "connected", "token": "JWT-SECRET", "baleUserId": "4242"})
        await asyncio.sleep(0); self.assertTrue(FakeClient.instances[0].stopped); self.assertEqual(self.state.flows, {})
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "11111"}); self.assertEqual(s, 410)
        logs = self.logbuf.getvalue()
        for secret in ["09120000000", "989120000000", "11111", "00000", "JWT-SECRET", "TX-SECRET", TOKEN, DH]:
            self.assertNotIn(secret, logs)

    async def test_2fa_flow(self):
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": DH})
        s, j2 = await self.post("/v1/auth/password", {"flowId": j["flowId"], "password": "ok-2fa"}); self.assertEqual(s, 410)  # wrong step
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "22222"}); self.assertEqual(j2, {"status": "password_needed"})
        s, j2 = await self.post("/v1/auth/password", {"flowId": j["flowId"], "password": "nope"}); self.assertEqual((s, j2["error"]), (422, "wrong_password"))
        s, j2 = await self.post("/v1/auth/password", {"flowId": j["flowId"], "password": "ok-2fa"}); self.assertEqual(j2["token"], "JWT-2FA")
        self.assertNotIn("ok-2fa", self.logbuf.getvalue())

    async def test_errors_and_device_hash(self):
        s, j = await self.post("/v1/auth/start", {"phone": "0912", "deviceHash": DH}); self.assertEqual((s, j["error"]), (422, "phone_invalid"))
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": sidecar.LIB_DEFAULT_DEVICE_HASH}); self.assertEqual(s, 400)
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": "not-a-uuid"}); self.assertEqual(s, 400)
        s, j = await self.post("/v1/auth/start", {"phone": "09990000009", "deviceHash": DH}); self.assertEqual((s, j["error"]), (403, "number_banned"))
        s, j = await self.post("/v1/auth/start", {"phone": "09990000007", "deviceHash": DH}); self.assertEqual((s, j["error"]), (429, "rate_limited"))
        self.assertTrue(all(c.stopped for c in FakeClient.instances))
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": DH})
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "33333"}); self.assertEqual(j2["error"], "sign_up_needed")
        self.assertEqual(self.state.flows, {})

    async def test_ttl_and_cancel(self):
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": DH})
        self.now[0] += sidecar.FLOW_TTL_S + 1
        s, j2 = await self.post("/v1/auth/code", {"flowId": j["flowId"], "code": "11111"}); self.assertEqual(s, 410)
        s, j = await self.post("/v1/auth/start", {"phone": "09120000000", "deviceHash": DH})
        s, _ = await self.post("/v1/auth/cancel", {"flowId": j["flowId"]}); self.assertEqual(s, 200); self.assertEqual(self.state.flows, {})

    async def test_signout(self):
        s, j = await self.post("/v1/session/signout", {"accountRef": "acc-1", "token": "JWT-X", "deviceHash": DH})
        self.assertEqual(s, 200); self.assertEqual(FakeClient.instances[0].calls, [("signout", "JWT-X")]); self.assertTrue(FakeClient.instances[0].stopped)


class BaleErr(Exception):
    def __init__(self, message, topic=1):
        super().__init__(message); self.message = message; self.topic = topic


class FakeLive:
    """A fake long-lived aiobale client: records calls, never touches the network."""
    instances = []

    def __init__(self, token, on_message):
        self.token = token; self.on_message = on_message; self.calls = []; self.stopped = False; self.fail_send = None
        FakeLive.instances.append(self)

    async def start(self, run_in_background=False, signal_handling=True):
        assert run_in_background is True and signal_handling is False
        if self.token == "BAD-JWT":
            raise BaleErr("AUTH_REQUIRED")

    async def get_me(self):
        return SimpleNamespace(id=4242)

    async def search_contact(self, phone):
        self.calls.append(("search", phone))
        return None if phone == "989120000099" else SimpleNamespace(id=777)

    async def start_typing(self, chat_id, ct):
        self.calls.append(("typing", chat_id))

    async def stop_typing(self, chat_id, ct):
        self.calls.append(("typing_off", chat_id))

    async def send_message(self, text, chat_id, ct):
        self.calls.append(("send", chat_id, text))
        if self.fail_send:
            raise BaleErr(self.fail_send)
        return SimpleNamespace(message_id=9001)

    async def stop(self):
        self.stopped = True


def msg(chat_id, sender, text=None, doc=False, ctype=1, mid=55):
    return SimpleNamespace(chat=SimpleNamespace(type=SimpleNamespace(value=ctype), id=chat_id), sender_id=sender, message_id=mid, date=1767000000000,
                           content=SimpleNamespace(text=SimpleNamespace(value=text) if text is not None else None, document=object() if doc else None))


class LiveSessionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeLive.instances.clear(); self.posts = []; self.post_status = [200]; self.slept = []

        async def poster(url, token, payload):
            self.posts.append((url, token, payload)); return self.post_status.pop(0) if len(self.post_status) > 1 else self.post_status[0]

        async def sleep(s):
            self.slept.append(s)
        self.state = sidecar.State(token=TOKEN, client_factory=lambda token=None: FakeClient(token), session_factory=FakeLive,
                                   inbound_url="http://127.0.0.1:8080/internal/bale/inbound", poster=poster, sleep=sleep)
        self.logbuf = io.StringIO(); h = logging.StreamHandler(self.logbuf); sidecar.log.addHandler(h); sidecar.log.setLevel(logging.DEBUG); self._h = h
        self.c = TestClient(TestServer(sidecar.make_app(self.state))); await self.c.start_server()

    async def asyncTearDown(self):
        await self.c.close(); sidecar.log.removeHandler(self._h)

    async def post(self, path, body, token=TOKEN):
        r = await self.c.post(path, json=body, headers={"x-bale-internal-token": token})
        return r.status, await r.json()

    async def health(self):
        r = await self.c.get("/v1/health", headers={"x-bale-internal-token": TOKEN}); return await r.json()

    async def drain(self):
        for _ in range(20):
            await asyncio.sleep(0)

    async def test_attach_health_detach_and_restart_semantics(self):
        h0 = await self.health(); self.assertEqual((h0["sessions"], h0["attached"]), (0, [])); self.assertEqual(len(h0["bootId"]), 16)
        s, j = await self.post("/v1/session/attach", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH})
        self.assertEqual((s, j), (200, {"ok": True, "baleUserId": "4242"}))
        h = await self.health(); self.assertEqual(h["attached"], ["acc-1"]); self.assertEqual(h["bootId"], h0["bootId"])
        s, j = await self.post("/v1/session/attach", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH})  # idempotent: old one closed
        self.assertTrue(FakeLive.instances[0].stopped); self.assertEqual(len(self.state.sessions), 1)
        s, j = await self.post("/v1/session/attach", {"accountRef": "acc-2", "token": "BAD-JWT", "deviceHash": DH})
        self.assertEqual((s, j["error"]), (401, "session_invalid")); self.assertTrue(FakeLive.instances[-1].stopped)
        s, j = await self.post("/v1/session/attach", {"accountRef": "../x", "token": "JWT-LIVE"}); self.assertEqual(s, 400)
        s, _ = await self.post("/v1/session/detach", {"accountRef": "acc-1"}); self.assertEqual(s, 200)
        self.assertEqual((await self.health())["attached"], []); self.assertTrue(FakeLive.instances[1].stopped)
        other = sidecar.State(token=TOKEN); self.assertNotEqual(other.boot_id, self.state.boot_id)  # a restart = a new bootId, no sessions
        self.assertNotIn("JWT-LIVE", self.logbuf.getvalue())

    async def test_send_typing_peer_lookup_and_errors(self):
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": None, "text": "سلام", "typingMs": 1500})
        self.assertEqual((s, j["error"]), (409, "not_attached"))
        await self.post("/v1/session/attach", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH}); live = FakeLive.instances[0]
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": None, "text": "سلام", "typingMs": 99999})
        self.assertEqual((s, j), (200, {"messageId": "9001", "peerId": "777"}))
        self.assertEqual(live.calls, [("search", "989120000001"), ("typing", 777), ("typing_off", 777), ("send", 777, "سلام")])
        self.assertEqual(self.slept, [sidecar.MAX_TYPING_MS / 1000])  # typing capped
        live.calls.clear()
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": "777", "text": "دوباره", "typingMs": 0})
        self.assertEqual(s, 200); self.assertEqual(live.calls, [("send", 777, "دوباره")])  # known peer: no lookup, no typing
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000099", "peerId": None, "text": "x", "typingMs": 0})
        self.assertEqual((s, j["error"]), (404, "peer_not_found"))
        for bad in [{"text": ""}, {"text": "x" * 4001}, {"phone": "123"}]:
            b = {"accountRef": "acc-1", "phone": "09120000001", "peerId": "777", "text": "x", "typingMs": 0}; b.update(bad)
            s, j = await self.post("/v1/send", b); self.assertEqual((s, j["error"]), (400, "bad_request"))
        live.fail_send = "FLOOD_WAIT"
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": "777", "text": "x", "typingMs": 0})
        self.assertEqual((s, j["error"]), (429, "rate_limited")); self.assertIn("acc-1", self.state.sessions)  # rate limit keeps the session
        live.fail_send = "USER_DEACTIVATED_BAN"
        s, j = await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": "777", "text": "x", "typingMs": 0})
        self.assertEqual((s, j["error"]), (403, "account_banned")); self.assertNotIn("acc-1", self.state.sessions); self.assertTrue(live.stopped)
        logs = self.logbuf.getvalue()
        for secret in ["09120000001", "989120000001", "سلام", "دوباره", "JWT-LIVE", TOKEN]:
            self.assertNotIn(secret, logs)

    async def test_error_mapping(self):
        m = sidecar.bale_error_code
        self.assertEqual([m(BaleErr(x)) for x in ["FLOOD_WAIT_30", "TOO_MANY_REQUESTS", "USER_BANNED", "AUTH_KEY_INVALID", "PEER_ID_INVALID", "WHATEVER"]],
                         ["rate_limited", "rate_limited", "account_banned", "session_invalid", "peer_not_found", "unknown"])
        self.assertEqual(m(ValueError("x")), "unknown")

    async def test_inbound_forwarding(self):
        await self.post("/v1/session/attach", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH}); live = FakeLive.instances[0]
        await self.post("/v1/send", {"accountRef": "acc-1", "phone": "09120000001", "peerId": None, "text": "سلام", "typingMs": 0})
        await live.on_message(msg(777, 777, "خصوصی-جواب")); await self.drain()
        url, tok, p = self.posts[-1]
        self.assertEqual(url, "http://127.0.0.1:8080/internal/bale/inbound"); self.assertEqual(tok, TOKEN)
        self.assertEqual(p, {"accountRef": "acc-1", "events": [{"peerId": "777", "peerPhone": "09120000001", "messageId": "55", "text": "خصوصی-جواب",
                                                               "hasFile": False, "fromSelf": False, "date": 1767000000000}]})
        await live.on_message(msg(888, 4242, "از گوشی خودم", mid=56)); await self.drain()
        ev = self.posts[-1][2]["events"][0]; self.assertEqual((ev["fromSelf"], ev["peerPhone"]), (True, None))
        await live.on_message(msg(888, 888, None, doc=True, mid=57)); await self.drain()
        ev = self.posts[-1][2]["events"][0]; self.assertEqual((ev["text"], ev["hasFile"]), (None, True))
        n = len(self.posts)
        await live.on_message(msg(-5, 888, "group", ctype=2)); await self.drain(); self.assertEqual(len(self.posts), n)  # groups/channels ignored
        self.post_status[:] = [503, 503, 200]
        await live.on_message(msg(777, 777, "retry", mid=58)); await self.drain()
        self.assertEqual(len(self.posts), n + 3); self.assertEqual(self.slept[-2:], [1.0, 3.0])
        self.post_status[:] = [403]
        await live.on_message(msg(777, 777, "refused", mid=59)); await self.drain(); self.assertEqual(len(self.posts), n + 4)  # no retry on 403
        self.assertNotIn("خصوصی-جواب", self.logbuf.getvalue()); self.assertNotIn("09120000001", self.logbuf.getvalue())

    async def test_signout_detaches(self):
        await self.post("/v1/session/attach", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH})
        s, _ = await self.post("/v1/session/signout", {"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH})
        self.assertEqual(s, 200); self.assertEqual(self.state.sessions, {}); self.assertTrue(FakeLive.instances[0].stopped)

    async def test_inbound_url_must_be_loopback(self):
        self.assertTrue(sidecar.is_loopback_http("http://127.0.0.1:8080/internal/bale/inbound"))
        for u in ["https://127.0.0.1/x", "http://10.0.0.5/x", "http://crm.example.com/internal/bale/inbound", "", None]:
            self.assertFalse(sidecar.is_loopback_http(u))


class VendoredLibTest(unittest.TestCase):
    def test_vendored_client_never_writes_a_session(self):
        d = tempfile.mkdtemp(); cwd = os.getcwd(); os.chdir(d)
        try:
            async def go():
                c = sidecar.default_client_factory()
                c._write_session_content(b"x")  # what validate_code calls on success
                await c.stop()
            asyncio.run(go())
            self.assertEqual(os.listdir(d), [])
        finally:
            os.chdir(cwd)

    def test_default_session_factory_builds_a_diskless_listening_client(self):
        d = tempfile.mkdtemp(); cwd = os.getcwd(); os.chdir(d)
        try:
            async def go():
                async def h(m):
                    pass
                c = sidecar.default_session_factory("x.y.z", h)
                self.assertIsNotNone(c.dispatcher)
                await c.stop()
            asyncio.run(go())
            self.assertEqual(os.listdir(d), [])
        finally:
            os.chdir(cwd)

    def test_main_refuses_non_loopback_inbound_url(self):
        os.environ["BALE_INBOUND_URL"] = "http://crm.example.com/internal/bale/inbound"
        try:
            with self.assertRaisesRegex(SystemExit, "BALE_INBOUND_URL"):
                sidecar.main()
        finally:
            del os.environ["BALE_INBOUND_URL"]

    def test_main_refuses_non_loopback(self):
        os.environ["BALE_SIDECAR_HOST"] = "0.0.0.0"
        try:
            with self.assertRaises(SystemExit):
                sidecar.main()
        finally:
            del os.environ["BALE_SIDECAR_HOST"]


if __name__ == "__main__":
    unittest.main()
