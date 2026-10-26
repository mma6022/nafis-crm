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

    def test_main_refuses_non_loopback(self):
        os.environ["BALE_SIDECAR_HOST"] = "0.0.0.0"
        try:
            with self.assertRaises(SystemExit):
                sidecar.main()
        finally:
            del os.environ["BALE_SIDECAR_HOST"]


if __name__ == "__main__":
    unittest.main()
