"""BALE-FIXB-66: dead-connection watchdog. Offline; fake aiobale-shaped clients (never talks to Bale, never sends anything).
Run: python -m unittest discover -s tests"""
import asyncio
import io
import logging
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sidecar  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

TOKEN = "t" * 40
DH = "0b7c3f5e-1d2a-4c3b-9e8f-112233445566"


class FakeWsSession:
    """Shape of aiobale's AiohttpSession as far as the watchdog looks at it."""
    def __init__(self):
        self.closed = False; self.running = True; self.ws = SimpleNamespace(closed=False); self.sent = []; self.raise_closed = False

    def is_closed(self):
        if self.raise_closed:
            raise ValueError("probe bug")
        return self.closed

    async def send_bytes(self, data, future_key, timeout=None):
        self.sent.append(future_key)  # only the library's own ping frames reach this in the tests
        return SimpleNamespace(pong=True)

    async def _handle_received_data(self, data):
        return None


class ProbedLive:
    instances = []

    def __init__(self, token, handler):
        self.token = token; self.handler = handler; self.calls = []; self.stopped = False
        self.session = FakeWsSession(); self._ping_task = None
        ProbedLive.instances.append(self)

    async def start(self, run_in_background=True, signal_handling=False):
        self._ping_task = asyncio.get_running_loop().create_future()  # pending = ping loop alive

    async def get_me(self):
        return SimpleNamespace(id=4242)

    async def send_message(self, *a, **k):
        self.calls.append(("send",)); raise AssertionError("watchdog must never send")

    async def stop(self):
        self.stopped = True; self.session.closed = True


class WatchdogTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        ProbedLive.instances.clear(); self.posts = []
        self.now = [1000.0]; self.wall = [1_767_000_000.0]

        async def poster(url, token, payload):
            self.posts.append(payload); return 200
        self.state = sidecar.State(token=TOKEN, session_factory=ProbedLive, inbound_url="http://127.0.0.1:1/internal/bale/inbound",
                                   poster=poster, clock=lambda: self.now[0], wall=lambda: self.wall[0], watch_every_s=0)
        self.logbuf = io.StringIO(); h = logging.StreamHandler(self.logbuf); sidecar.log.addHandler(h); sidecar.log.setLevel(logging.DEBUG); self._h = h
        self.c = TestClient(TestServer(sidecar.make_app(self.state))); await self.c.start_server()

    async def asyncTearDown(self):
        await self.c.close(); sidecar.log.removeHandler(self._h)

    async def attach(self, ref="acc-1"):
        r = await self.c.post("/v1/session/attach", json={"accountRef": ref, "token": "JWT-LIVE", "deviceHash": DH}, headers={"x-bale-internal-token": TOKEN})
        self.assertEqual(r.status, 200); return ProbedLive.instances[-1]

    async def health(self):
        r = await self.c.get("/v1/health", headers={"x-bale-internal-token": TOKEN}); return await r.json()

    def tick(self, s):
        self.now[0] += s; self.wall[0] += s

    async def pong(self, live, n=1):
        await live.session.send_bytes(b"\x12\x02\x08\x01", f"ping_{n}")  # what aiobale's _send_ping does

    async def settle(self):
        for _ in range(10):
            await asyncio.sleep(0)

    async def test_health_reports_last_pong_and_attach_time(self):
        live = await self.attach()
        h = await self.health(); self.assertEqual(h["version"], "1b-0.6"); self.assertEqual(h["attached"], ["acc-1"])
        self.assertEqual(h["live"]["acc-1"], {"attachedAt": 1_767_000_000_000, "lastPongAt": None, "lastRxAt": None, "probe": "ping"})
        self.tick(5); await self.pong(live); await live.session._handle_received_data(b"x")
        h = await self.health(); self.assertEqual(h["live"]["acc-1"]["lastPongAt"], 1_767_000_005_000); self.assertEqual(h["live"]["acc-1"]["lastRxAt"], 1_767_000_005_000)
        self.assertEqual(h["drops"], {}); self.assertEqual(h["pongStaleS"], sidecar.PONG_STALE_S)

    async def test_regular_pongs_keep_it_alive_and_silence_drops_it(self):
        live = await self.attach()
        for i in range(6):
            self.tick(40); await self.pong(live, i)
            self.assertEqual((await self.health())["attached"], ["acc-1"])
        self.tick(sidecar.PONG_STALE_S + 1)
        h = await self.health(); await self.settle()
        self.assertEqual(h["attached"], []); self.assertEqual(h["drops"]["acc-1"]["reason"], "no_pong"); self.assertEqual(h["drops"]["acc-1"]["count"], 1)
        self.assertTrue(live.stopped); self.assertIn("session dropped ref=acc-1 reason=no_pong", self.logbuf.getvalue())
        self.assertNotIn("JWT-LIVE", self.logbuf.getvalue())

    async def test_no_pong_ever_after_attach_drops(self):
        await self.attach(); self.tick(sidecar.PONG_STALE_S - 1)
        self.assertEqual((await self.health())["attached"], ["acc-1"])
        self.tick(2); self.assertEqual((await self.health())["attached"], [])

    async def test_each_dead_transport_signal_drops(self):
        for why, kill in [("transport_closed", lambda l: setattr(l.session, "closed", True)),
                          ("listener_stopped", lambda l: setattr(l.session, "running", False)),
                          ("ws_closed", lambda l: setattr(l.session.ws, "closed", True)),
                          ("ping_loop_stopped", lambda l: l._ping_task.set_result(None)),
                          ("transport_closed", lambda l: setattr(l, "session", None))]:
            live = await self.attach(); await self.pong(live)
            kill(live)
            h = await self.health(); await self.settle()
            self.assertEqual(h["attached"], [], why); self.assertEqual(h["drops"]["acc-1"]["reason"], why); self.assertTrue(live.stopped or live.session is None)

    async def test_reattach_after_drop_works_and_counts(self):
        live = await self.attach(); live.session.closed = True; await self.health()
        live2 = await self.attach(); await self.pong(live2)
        h = await self.health(); self.assertEqual(h["attached"], ["acc-1"]); self.assertEqual(h["drops"]["acc-1"]["count"], 1)
        live2.session.running = False; h = await self.health(); self.assertEqual(h["drops"]["acc-1"]["count"], 2)

    async def test_only_the_dead_account_is_dropped(self):
        a = await self.attach("acc-1"); b = await self.attach("acc-2")
        self.tick(30); await self.pong(a); self.tick(30)
        h = await self.health(); self.assertEqual(h["attached"], ["acc-1"]); self.assertEqual(list(h["drops"]), ["acc-2"]); self.assertFalse(a.stopped)

    async def test_probe_bug_never_drops(self):
        live = await self.attach(); live.session.raise_closed = True; self.tick(1)
        self.assertEqual((await self.health())["attached"], ["acc-1"]); self.assertIn("liveness probe error ValueError", self.logbuf.getvalue())

    async def test_watchdog_never_sends_logs_in_or_posts(self):
        live = await self.attach(); self.tick(999); await self.health(); await self.settle()
        self.assertEqual(live.calls, []); self.assertEqual(self.posts, [])
        self.assertEqual(live.session.sent, [])  # the watchdog itself wrote nothing to the socket

    async def test_unobservable_clients_are_left_alone(self):
        class Plain:
            def __init__(self, token, handler): self.stopped = False
            async def start(self, **k): pass
            async def get_me(self): return SimpleNamespace(id=1)
            async def stop(self): self.stopped = True
        self.state.session_factory = Plain
        r = await self.c.post("/v1/session/attach", json={"accountRef": "acc-3", "token": "JWT-LIVE", "deviceHash": DH}, headers={"x-bale-internal-token": TOKEN})
        self.assertEqual(r.status, 200); self.tick(10_000)
        h = await self.health(); self.assertEqual(h["attached"], ["acc-3"]); self.assertEqual(h["live"]["acc-3"]["probe"], "none")


class BackgroundWatchdogTest(unittest.IsolatedAsyncioTestCase):
    async def test_background_task_drops_without_a_health_call(self):
        ProbedLive.instances.clear()
        st = sidecar.State(token=TOKEN, session_factory=ProbedLive, watch_every_s=0.05, pong_stale_s=0.2)
        c = TestClient(TestServer(sidecar.make_app(st))); await c.start_server()
        try:
            r = await c.post("/v1/session/attach", json={"accountRef": "acc-1", "token": "JWT-LIVE", "deviceHash": DH}, headers={"x-bale-internal-token": TOKEN})
            self.assertEqual(r.status, 200); live = ProbedLive.instances[-1]
            for _ in range(6):
                await asyncio.sleep(0.05); await live.session.send_bytes(b"", "ping_1")
            self.assertIn("acc-1", st.sessions)
            await asyncio.sleep(0.5)
            self.assertNotIn("acc-1", st.sessions); self.assertEqual(st.drops["acc-1"]["reason"], "no_pong"); self.assertTrue(live.stopped)
        finally:
            await c.close()


if __name__ == "__main__":
    unittest.main()
