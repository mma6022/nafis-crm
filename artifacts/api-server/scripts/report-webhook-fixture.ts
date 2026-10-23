// Unit/integration test for the «گزارش خطا» webhook forwarder (mocked endpoint).
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express, { type RequestHandler } from "express";
import { authHeaders, createReportForwarder, webhookConfigFromEnv } from "../src/lib/report-webhook";
import { createDiagnosticRouter } from "../src/lib/diagnostic-reports";

type Hit = { headers: http.IncomingHttpHeaders; body: any };
const logs: { level: string; obj: any; msg: string }[] = [];
const log = { info: (obj: object, msg: string) => logs.push({ level: "info", obj, msg }),
  warn: (obj: object, msg: string) => logs.push({ level: "warn", obj, msg }),
  error: (obj: object, msg: string) => logs.push({ level: "error", obj, msg }) };
const KEY = "test-webhook-key-0123456789abcdef0123456789";

async function mockEndpoint(plan: (n: number) => number | "hang") {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", () => {
      hits.push({ headers: req.headers, body: JSON.parse(raw || "null") });
      const s = plan(hits.length);
      if (s === "hang") return; // never responds
      res.writeHead(s, { "Content-Type": "application/json" }); res.end("{}");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { hits, url, close: () => { server.closeAllConnections(); server.close(); } };
}
const wait = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 10)); }
};
const payload = (id: number) => ({ type: "nafis.bug_report.created" as const, schemaVersion: 1 as const,
  report: { id, createdAt: "x", page: "/", pageUrl: "https://x/", description: "d", userAgent: null, release: null },
  reporter: { id: 1, username: "u", role: "admin" }, browserEvents: [], serverEvents: [], screenshot: null,
  links: { details: "", detailsLocal: "", forwardLocal: "" } });
let passed = 0; const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log("ok -", name); };

await test("config: disabled without URL/key, rejects plain http to remote, credentials in URL, bad header", async () => {
  assert.equal(webhookConfigFromEnv({}), null);
  assert.equal(webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "https://h.example/x" }), null);
  assert.equal(webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "http://h.example/x", REPORT_WEBHOOK_KEY: "k" }), null);
  assert.equal(webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "https://a:b@h.example/x", REPORT_WEBHOOK_KEY: "k" }), null);
  assert.equal(webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "https://h.example/x", REPORT_WEBHOOK_KEY: "k", REPORT_WEBHOOK_KEY_HEADER: "Bad Header" }), null);
  const c = webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "https://h.example/x", REPORT_WEBHOOK_KEY: "k" })!;
  assert.deepEqual(authHeaders(c), { Authorization: "Bearer k" });
  const c2 = webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "https://h.example/x", REPORT_WEBHOOK_KEY: "k", REPORT_WEBHOOK_KEY_HEADER: "X-Wake-Key" })!;
  assert.deepEqual(authHeaders(c2), { "X-Wake-Key": "k" });
  assert.ok(webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "http://127.0.0.1:9/x", REPORT_WEBHOOK_KEY: "k" }));
});

await test("retries 5xx with backoff then delivers on 3rd try; bearer header sent", async () => {
  const ep = await mockEndpoint(n => n < 3 ? 503 : 200);
  const sleeps: number[] = [];
  const f = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log,
    sleep: async ms => { sleeps.push(ms); } });
  const r = await f.deliver(payload(7));
  assert.deepEqual(r, { delivered: true, attempts: 3, status: 200 });
  assert.deepEqual(sleeps, [2000, 8000]);
  assert.equal(ep.hits.length, 3);
  assert.equal(ep.hits[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(ep.hits[0].headers["idempotency-key"], "nafis-report-7");
  assert.equal(ep.hits[2].body.report.id, 7);
  ep.close();
});

await test("custom header name carries raw key", async () => {
  const ep = await mockEndpoint(() => 204);
  const f = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY, REPORT_WEBHOOK_KEY_HEADER: "X-Wake-Key" }), log, sleep: async () => {} });
  assert.equal((await f.deliver(payload(8))).delivered, true);
  assert.equal(ep.hits[0].headers["x-wake-key"], KEY);
  assert.equal(ep.hits[0].headers.authorization, undefined);
  ep.close();
});

await test("non-retryable 4xx stops after 1 try; 3 tries max on network error; failures logged without key", async () => {
  const ep = await mockEndpoint(() => 401);
  const f = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log, sleep: async () => {} });
  assert.deepEqual(await f.deliver(payload(9)), { delivered: false, attempts: 1, status: 401, error: "http_401" });
  ep.close();
  const dead = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: "http://127.0.0.1:1/x", REPORT_WEBHOOK_KEY: KEY }), log, sleep: async () => {} });
  const r = await dead.deliver(payload(10));
  assert.equal(r.attempts, 3); assert.equal(r.error, "network_error");
  assert.ok(logs.some(l => l.level === "error" && l.msg === "report_webhook_failed" && l.obj.reportId === 10));
  assert.ok(!JSON.stringify(logs).includes(KEY), "key must never be logged");
});

await test("timeout per attempt; forward() never throws even if callback throws", async () => {
  const ep = await mockEndpoint(() => "hang");
  const f = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log, sleep: async () => {}, timeoutMs: 100 });
  let result: any;
  f.forward(payload(11), (_id, r) => { result = r; throw new Error("db down"); });
  await wait(() => result !== undefined);
  assert.equal(result.error, "timeout"); assert.equal(result.attempts, 3);
  assert.ok(logs.some(l => l.msg === "report_webhook_state_write_failed"));
  ep.close();
});

await test("router: save returns 201 immediately while webhook hangs; payload, state, admin read, no queue for Replit", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, mobile TEXT, full_name TEXT)");
  db.prepare("INSERT INTO users VALUES(5,'sara','sales','09120000000','Sara Customerish')").run();
  db.prepare("INSERT INTO users VALUES(1,'boss','admin',NULL,NULL)").run();
  let mode: "hang" | 200 = "hang";
  const ep = await mockEndpoint(() => mode);
  const READ = "r".repeat(40);
  const forwarder = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log, sleep: async () => {}, timeoutMs: 300 });
  const actor: Record<string, any> = { id: 5, role: "sales" };
  const requireAuth: RequestHandler = (_req, res, next) => { res.locals.authUser = actor; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createDiagnosticRouter({ db, requireAuth, workerSecret: () => undefined, currentBuild: () => ({ release: "20261023112017", sha256: "a".repeat(64) }),
    healthy: async () => true, forwarder, publicOrigin: () => "https://crm.nafisvam.com", readKey: () => READ, localPort: () => 5001 }));
  const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const av = await (await fetch(base + "/api/diagnostics/availability")).json();
  assert.equal(av.connected, true); assert.equal(av.automaticPublishing, false);

  const t0 = Date.now();
  const ok = await fetch(base + "/api/diagnostics/reports", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 test" },
    body: JSON.stringify({ clientId: "client-abcdefghijklmnop", description: "Saving the customer form fails, call me on 09121234567", page: "/customers/42?tab=docs#x",
      browserEvents: [{ kind: "request", message: "POST 500", at: "2026-10-23T11:30:00.000Z", path: "/api/customers/42", status: 500 }] }) });
  const elapsed = Date.now() - t0;
  assert.equal(ok.status, 201); const dto = await ok.json();
  assert.equal(dto.status, "received"); assert.ok(elapsed < 250, `save must not wait for webhook (${elapsed}ms)`);
  await wait(() => ep.hits.length >= 1);
  const body = ep.hits[0].body;
  assert.equal(body.type, "nafis.bug_report.created");
  assert.equal(body.report.id, dto.id); assert.equal(body.report.page, "/customers/42");
  assert.equal(body.report.pageUrl, "https://crm.nafisvam.com/customers/42");
  assert.equal(body.report.userAgent, "Mozilla/5.0 test"); assert.equal(body.report.release, "20261023112017");
  assert.ok(body.report.description.includes("[number]") && !body.report.description.includes("09121234567"), "stored redaction applies");
  assert.deepEqual(body.reporter, { id: 5, username: "sara", role: "sales" });
  assert.ok(!JSON.stringify(body).includes("09120000000") && !JSON.stringify(body).includes("Customerish"), "no user PII");
  assert.equal(body.screenshot, null);
  assert.equal(body.links.detailsLocal, `http://127.0.0.1:5001/api/diagnostics-admin/reports/${dto.id}`);
  await wait(() => (db.prepare("SELECT forward_status s FROM diagnostic_reports WHERE id=?").get(dto.id) as any).s === "failed");

  // A received report is terminal: the reporter can file another one (no 409 pending).
  const again = await fetch(base + "/api/diagnostics/reports", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "client-second-abcdefgh", description: "Second problem report text", page: "/" }) });
  assert.equal(again.status, 201);

  // Admin read: non-admin session is refused; loopback key works; proxied header is refused.
  assert.equal((await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}`)).status, 403);
  assert.equal((await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}`, { headers: { "X-Report-Read-Key": READ, "X-Forwarded-For": "1.2.3.4" } })).status, 403);
  assert.equal((await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}`, { headers: { "X-Report-Read-Key": "wrong".repeat(10) } })).status, 403);
  const detail = await (await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}`, { headers: { "X-Report-Read-Key": READ } })).json();
  assert.equal(detail.report.id, dto.id); assert.equal(detail.state.forwardStatus, "failed"); assert.equal(detail.state.forwardAttempts, 3);
  actor.role = "admin";
  const list = await (await fetch(`${base}/api/diagnostics-admin/reports`)).json();
  assert.equal(list.reports.length, 2);

  // Manual re-send once the endpoint is healthy.
  mode = 200;
  const resend = await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}/forward`, { method: "POST", headers: { "X-Report-Read-Key": READ } });
  assert.equal(resend.status, 200);
  assert.equal((db.prepare("SELECT forward_status s FROM diagnostic_reports WHERE id=?").get(dto.id) as any).s, "delivered");
  // The Replit runner would only claim queued/awaiting_connection rows.
  assert.equal((db.prepare("SELECT COUNT(*) n FROM diagnostic_reports WHERE status IN ('queued','awaiting_connection')").get() as any).n, 0);
  srv.closeAllConnections(); srv.close(); ep.close();
});

await test("forwarding disabled (no env): legacy behaviour unchanged", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
  const forwarder = createReportForwarder({ config: () => webhookConfigFromEnv({}), log });
  const requireAuth: RequestHandler = (_req, res, next) => { res.locals.authUser = { id: 3, role: "sales" }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createDiagnosticRouter({ db, requireAuth, workerSecret: () => undefined, currentBuild: () => null, healthy: async () => true, forwarder }));
  const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const r = await (await fetch(base + "/api/diagnostics/reports", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "client-legacy-abcdefgh", description: "Legacy path report text", page: "/" }) })).json();
  assert.equal(r.status, "awaiting_connection");
  assert.equal((await (await fetch(base + "/api/diagnostics/availability")).json()).automaticPublishing, true);
  srv.closeAllConnections(); srv.close();
});

console.log(`report-webhook: ${passed} tests passed`);
