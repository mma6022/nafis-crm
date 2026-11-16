// MOCK Bale sidecar (same HTTP contract as artifacts/bale-sidecar/sidecar.py). Never talks to Bale; used by the fixture
// and the masked screenshot kit. Rules: code 11111 → connected; 22222 → password_needed (then password "mock-2fa" → connected);
// 00000 → wrong_code; 99999 → code_expired. Phone 09990000009 → number_banned. CLI: MOCK_BALE_PORT=18470 MOCK_BALE_TOKEN_FILE=… node bale-mock-sidecar.mjs
// 1b: /v1/session/attach (token must look like a mock token, else session_invalid), /v1/session/detach, /v1/send
// (not attached → not_attached; phone 09990000008 → peer_not_found; state.sendError = "rate_limited" | "account_banned" |
// "session_invalid" | … → that error), health { bootId, attached }, restart() = new bootId + every client dropped,
// inbound(apiBase, accountRef, events) = what the real sidecar POSTs to the API for incoming messages.
// /v1/send-file (plan file: fileB64 + sha256 + mime + caption; checks like the real sidecar) → state.sentFiles (no bytes kept, only size/sha).
// 1b-0.4: /v1/contacts (READ-ONLY) → state.contacts[accountRef] ?? state.contacts["*"] (fake list), state.contactsSource
// ("contacts" | "dialogs"), state.contactsCooldownMs (sidecar-side 429 rate_limited), state.contactsError; MOCK_BALE_CONTACTS_FILE seeds it.
// /v1/send + /v1/send-file accept phone "" when a numeric peerId is given (customer linked via «اسکن بله و اتصال مشتری»).
// state.blockedPhones (Set) → /v1/send answers peer_blocked for that phone (the UNVERIFIED "this customer blocked you" path).
import http from "node:http"; import crypto from "node:crypto"; import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function startMockBaleSidecar({ token, port = 0, host = "127.0.0.1" }) {
  const flows = new Map(); const log = []; const state = { failSignOut: false, down: false, sendError: null, attachError: null, blockedPhones: new Set(), sentFiles: [], contacts: {}, contactsSource: "contacts", contactsCooldownMs: 0, contactsError: null, contactsAt: {} };
  const attached = new Map(); const sent = []; let bootId = crypto.randomBytes(8).toString("hex"); let seq = 5000;
  const phoneOk = j => /^09\d{9}$/.test(String(j.phone)) || (j.phone === "" && /^\d{1,20}$/.test(String(j.peerId ?? "")));
  const peerOf = phone => String(800000000 + Number(String(phone).slice(-6)));
  const ERR_STATUS = { rate_limited: 429, account_banned: 403, session_invalid: 401, not_attached: 409, peer_not_found: 404, peer_blocked: 403, unknown: 502 };
  const srv = http.createServer((req, res) => {
    const send = (s, j) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (state.down) { req.socket.destroy(); return; }
    if (req.headers["x-bale-internal-token"] !== token) return send(401, { error: "unauthorized" });
    const cap = req.url === "/v1/send-file" ? 15 * 1024 * 1024 : 16384;
    let b = ""; req.on("data", c => { b += c; if (b.length > cap) req.destroy(); });
    req.on("end", () => {
      let j = {}; try { j = b ? JSON.parse(b) : {}; } catch { return send(400, { error: "unknown" }); }
      log.push({ path: req.url, body: req.url === "/v1/send-file" ? { ...j, fileB64: `<${String(j.fileB64 ?? "").length} b64 chars>` } : j });
      if (req.url === "/v1/health") return send(200, { ok: true, version: "mock-1b", sessions: flows.size, bootId, attached: [...attached.keys()] });
      if (req.url === "/v1/session/attach") {
        if (state.attachError) return send(ERR_STATUS[state.attachError] ?? 502, { error: state.attachError });
        if (!/^acc-\d+$/.test(String(j.accountRef)) || !String(j.token).startsWith("mock.")) return send(401, { error: "session_invalid" });
        attached.set(j.accountRef, { deviceHash: j.deviceHash }); return send(200, { ok: true, baleUserId: "777000111" });
      }
      if (req.url === "/v1/session/detach") { attached.delete(j.accountRef); return send(200, { ok: true }); }
      if (req.url === "/v1/send") {
        if (!attached.has(j.accountRef)) return send(409, { error: "not_attached" });
        if (state.sendError) return send(ERR_STATUS[state.sendError] ?? 502, { error: state.sendError });
        if (!phoneOk(j) || typeof j.text !== "string" || !j.text) return send(400, { error: "bad_request" });
        if (j.phone === "09990000008") return send(404, { error: "peer_not_found" });
        if (state.blockedPhones.has(j.phone)) return send(403, { error: "peer_blocked" }); // UNVERIFIED wording on real Bale
        const m = { accountRef: j.accountRef, phone: j.phone, peerId: j.peerId ?? peerOf(j.phone), text: j.text, typingMs: j.typingMs, messageId: String(++seq) };
        sent.push(m); return send(200, { messageId: m.messageId, peerId: m.peerId });
      }
      if (req.url === "/v1/contacts") {
        if (!attached.has(j.accountRef)) return send(409, { error: "not_attached" });
        if (state.contactsError) return send(ERR_STATUS[state.contactsError] ?? 502, { error: state.contactsError });
        const t = Date.now(); const last = state.contactsAt[j.accountRef] ?? 0;
        if (state.contactsCooldownMs && t - last < state.contactsCooldownMs) return send(429, { error: "rate_limited", retryAfterS: Math.ceil((last + state.contactsCooldownMs - t) / 1000) });
        state.contactsAt[j.accountRef] = t;
        const list = state.contacts[j.accountRef] ?? state.contacts["*"] ?? [];
        return send(200, { ok: true, source: state.contactsSource, truncated: false,
          contacts: list.map(c => state.contactsSource === "dialogs" ? { ...c, localName: null, phone: null } : c) });
      }
      if (req.url === "/v1/send-file") {
        if (!attached.has(j.accountRef)) return send(409, { error: "not_attached" });
        if (state.sendError) return send(ERR_STATUS[state.sendError] ?? 502, { error: state.sendError });
        if (!phoneOk(j) || typeof j.caption !== "string" || j.caption.length > 1024) return send(400, { error: "bad_request" });
        if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(j.mime) || !/^[^/\\]{1,120}$/.test(String(j.fileName ?? ""))) return send(400, { error: "bad_request" });
        const bytes = Buffer.from(String(j.fileB64 ?? ""), "base64");
        if (!bytes.length || bytes.length > 10 * 1024 * 1024 || crypto.createHash("sha256").update(bytes).digest("hex") !== j.sha256) return send(400, { error: "bad_request" });
        if (j.phone === "09990000008") return send(404, { error: "peer_not_found" });
        if (state.blockedPhones.has(j.phone)) return send(403, { error: "peer_blocked" });
        const m = { accountRef: j.accountRef, phone: j.phone, peerId: j.peerId ?? peerOf(j.phone), caption: j.caption, fileName: j.fileName, mime: j.mime, size: bytes.length, sha256: j.sha256, typingMs: j.typingMs, messageId: String(++seq) };
        state.sentFiles.push(m); return send(200, { messageId: m.messageId, peerId: m.peerId });
      }
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
      if (req.url === "/v1/session/signout") { attached.delete(j.accountRef); return state.failSignOut ? send(502, { error: "unknown" }) : send(200, { ok: true }); }
      send(404, { error: "unknown" });
    });
  });
  const restart = () => { attached.clear(); bootId = crypto.randomBytes(8).toString("hex"); };
  /** What the real sidecar does for an incoming Bale message: POST to the API's internal inbound route. */
  const inbound = async (apiBase, accountRef, events, headers = {}) => {
    const r = await fetch(`${apiBase}/internal/bale/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-bale-internal-token": token, ...headers },
      body: JSON.stringify({ accountRef, events }) });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  return new Promise(r => srv.listen(port, host, () => r({ srv, port: srv.address().port, log, flows, state, attached, sent, restart, inbound, peerOf,
    close: () => new Promise(c => srv.close(c)) })));
}

if (process.argv[1]?.endsWith("bale-mock-sidecar.mjs") && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = fs.readFileSync(process.env.MOCK_BALE_TOKEN_FILE, "utf8").trim();
  const m = await startMockBaleSidecar({ token, port: Number(process.env.MOCK_BALE_PORT || 18470) });
  if (process.env.MOCK_BALE_CONTACTS_FILE) { const c = JSON.parse(fs.readFileSync(process.env.MOCK_BALE_CONTACTS_FILE, "utf8")); m.state.contacts = c.contacts ?? c; if (c.source) m.state.contactsSource = c.source; }
  console.log("mock bale sidecar on 127.0.0.1:" + m.port);
}
