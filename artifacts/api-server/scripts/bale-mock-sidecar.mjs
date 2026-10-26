// MOCK Bale sidecar (same HTTP contract as artifacts/bale-sidecar/sidecar.py). Never talks to Bale; used by the fixture
// and the masked screenshot kit. Rules: code 11111 → connected; 22222 → password_needed (then password "mock-2fa" → connected);
// 00000 → wrong_code; 99999 → code_expired. Phone 09990000009 → number_banned. CLI: MOCK_BALE_PORT=18470 MOCK_BALE_TOKEN_FILE=… node bale-mock-sidecar.mjs
import http from "node:http"; import crypto from "node:crypto"; import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function startMockBaleSidecar({ token, port = 0, host = "127.0.0.1" }) {
  const flows = new Map(); const log = []; const state = { failSignOut: false, down: false };
  const srv = http.createServer((req, res) => {
    const send = (s, j) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (state.down) { req.socket.destroy(); return; }
    if (req.headers["x-bale-internal-token"] !== token) return send(401, { error: "unauthorized" });
    let b = ""; req.on("data", c => { b += c; if (b.length > 16384) req.destroy(); });
    req.on("end", () => {
      let j = {}; try { j = b ? JSON.parse(b) : {}; } catch { return send(400, { error: "unknown" }); }
      log.push({ path: req.url, body: j });
      if (req.url === "/v1/health") return send(200, { ok: true, version: "mock-1", sessions: 0 });
      if (req.url === "/v1/auth/start") {
        if (!/^09\d{9}$/.test(String(j.phone))) return send(422, { error: "phone_invalid" });
        if (j.phone === "09990000009") return send(403, { error: "number_banned" });
        if (!j.deviceHash || j.deviceHash.startsWith("ce5ced83")) return send(400, { error: "unknown" });
        const flowId = crypto.randomBytes(18).toString("base64url"); flows.set(flowId, { step: "code", deviceHash: j.deviceHash });
        return send(200, { flowId, codeType: "app", expiresInS: 300 });
      }
      const f = flows.get(j.flowId);
      const connected = () => { flows.delete(j.flowId); return send(200, { status: "connected", token: `mock.${crypto.randomBytes(24).toString("base64url")}.sig`, baleUserId: "777000111" }); };
      if (req.url === "/v1/auth/code") {
        if (!f || f.step !== "code") return send(410, { error: "flow_expired" });
        if (j.code === "11111") return connected();
        if (j.code === "22222") { f.step = "password"; return send(200, { status: "password_needed" }); }
        if (j.code === "99999") { flows.delete(j.flowId); return send(410, { error: "code_expired" }); }
        return send(422, { error: "wrong_code" });
      }
      if (req.url === "/v1/auth/password") {
        if (!f || f.step !== "password") return send(410, { error: "flow_expired" });
        return j.password === "mock-2fa" ? connected() : send(422, { error: "wrong_password" });
      }
      if (req.url === "/v1/auth/cancel") { flows.delete(j.flowId); return send(200, { ok: true }); }
      if (req.url === "/v1/session/signout") return state.failSignOut ? send(502, { error: "unknown" }) : send(200, { ok: true });
      send(404, { error: "unknown" });
    });
  });
  return new Promise(r => srv.listen(port, host, () => r({ srv, port: srv.address().port, log, flows, state, close: () => new Promise(c => srv.close(c)) })));
}

if (process.argv[1]?.endsWith("bale-mock-sidecar.mjs") && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = fs.readFileSync(process.env.MOCK_BALE_TOKEN_FILE, "utf8").trim();
  const m = await startMockBaleSidecar({ token, port: Number(process.env.MOCK_BALE_PORT || 18470) });
  console.log("mock bale sidecar on 127.0.0.1:" + m.port);
}
