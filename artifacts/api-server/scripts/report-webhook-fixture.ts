// Unit/integration test for the «گزارش خطا» webhook forwarder (local dummy receiver).
// Never uses the live database. Secrets used here are fixture-only.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express, { type RequestHandler } from "express";
import { authHeaders, createReportForwarder, webhookConfigFromEnv } from "../src/lib/report-webhook";
import { REPORT_WEBHOOK_FLAG, createDiagnosticRouter } from "../src/lib/diagnostic-reports";

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
  report: { id, text: "d", page: "/", createdAt: "x", release: null },
  reporter: { id: 1, role: "admin" } });
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

function seedFlag(db: DatabaseSync, on: boolean) {
  db.exec("CREATE TABLE IF NOT EXISTS call_queue_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)");
  if (on) db.prepare("INSERT INTO call_queue_settings VALUES(?,?,?)").run(REPORT_WEBHOOK_FLAG, "1", "x");
}

await test("router: flag ON, save returns 201 immediately while webhook hangs; slim masked payload, admin read, no queue for Replit", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, mobile TEXT, full_name TEXT, national_id TEXT)");
  db.prepare("INSERT INTO users VALUES(5,'sara','sales','09120000000','Sara Customerish','0012345678')").run();
  db.prepare("INSERT INTO users VALUES(1,'boss','admin',NULL,NULL,NULL)").run();
  seedFlag(db, true);
  let mode: "hang" | 200 = "hang";
  const ep = await mockEndpoint(() => mode);
  const READ = "r".repeat(40);
  const forwarder = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log, sleep: async () => {}, timeoutMs: 300 });
  const actor: Record<string, any> = { id: 5, role: "sales" };
  const requireAuth: RequestHandler = (_req, res, next) => { res.locals.authUser = actor; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createDiagnosticRouter({ db, requireAuth, workerSecret: () => undefined, currentBuild: () => ({ release: "20261110200000", sha256: "a".repeat(64) }),
    healthy: async () => true, forwarder, readKey: () => READ, localPort: () => 5001 }));
  const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const av = await (await fetch(base + "/api/diagnostics/availability")).json();
  assert.equal(av.connected, true); assert.equal(av.automaticPublishing, false);

  const t0 = Date.now();
  const ok = await fetch(base + "/api/diagnostics/reports", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 test" },
    body: JSON.stringify({ clientId: "client-abcdefghijklmnop", description: "Saving the customer form fails, call me on 09121234567 nid 0012345678", page: "/customers/42?tab=docs#x",
      browserEvents: [{ kind: "request", message: "POST 500", at: "2026-10-23T11:30:00.000Z", path: "/api/customers/42", status: 500 }] }) });
  const elapsed = Date.now() - t0;
  assert.equal(ok.status, 201); const dto = await ok.json();
  assert.equal(dto.status, "received"); assert.ok(elapsed < 250, `save must not wait for webhook (${elapsed}ms)`);
  await wait(() => ep.hits.length >= 1);
  const body = ep.hits[0].body;
  assert.equal(body.type, "nafis.bug_report.created");
  assert.equal(body.report.id, dto.id); assert.equal(body.report.page, "/customers/42");
  assert.equal(body.report.release, "20261110200000");
  assert.ok(typeof body.report.createdAt === "string" && body.report.createdAt.length > 0);
  assert.ok(body.report.text.includes("[number]") && !body.report.text.includes("09121234567"), "phone must be masked");
  assert.ok(!body.report.text.includes("0012345678"), "national id must be masked");
  assert.deepEqual(body.reporter, { id: 5, role: "sales" });
  assert.equal(body.reporter.username, undefined);
  assert.equal(body.report.userAgent, undefined);
  assert.equal(body.browserEvents, undefined);
  assert.equal(body.serverEvents, undefined);
  assert.equal(body.links, undefined);
  const dumped = JSON.stringify(body);
  assert.ok(!dumped.includes("09120000000") && !dumped.includes("09121234567") && !dumped.includes("0012345678"), "no phones or national ids in payload");
  assert.ok(!dumped.includes(KEY), "key must not appear in payload");
  assert.deepEqual(Object.keys(body).sort(), ["report", "reporter", "schemaVersion", "type"]);
  assert.deepEqual(Object.keys(body.report).sort(), ["createdAt", "id", "page", "release", "text"]);
  assert.deepEqual(Object.keys(body.reporter).sort(), ["id", "role"]);

  // Flag-ON report is terminal 'received' and is not claimed by the Replit runner.
  assert.equal((db.prepare("SELECT COUNT(*) n FROM diagnostic_reports WHERE status IN ('queued','awaiting_connection')").get() as any).n, 0);

  const list = await (await fetch(`${base}/api/diagnostics-admin/reports`, { headers: { "X-Report-Read-Key": READ } })).json();
  assert.equal(list.reports.length, 1);
  assert.equal(list.reports[0].user_id, 5);
  assert.equal(list.reports[0].role, "sales");
  const detail = await (await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}`, { headers: { "X-Report-Read-Key": READ } })).json();
  assert.equal(detail.report.id, dto.id);
  assert.ok(!JSON.stringify(detail).includes("09121234567") && !JSON.stringify(detail).includes("0012345678"));

  // Manual re-send once the endpoint is healthy.
  mode = 200;
  const resend = await fetch(`${base}/api/diagnostics-admin/reports/${dto.id}/forward`, { method: "POST", headers: { "X-Report-Read-Key": READ } });
  assert.equal(resend.status, 200);
  assert.equal((db.prepare("SELECT forward_status s FROM diagnostic_reports WHERE id=?").get(dto.id) as any).s, "delivered");
  srv.closeAllConnections(); srv.close(); ep.close();
});

await test("flag OFF even with env set: legacy behaviour, no webhook call", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
  seedFlag(db, false);
  const ep = await mockEndpoint(() => 200);
  const forwarder = createReportForwarder({ config: () => webhookConfigFromEnv({ REPORT_WEBHOOK_URL: ep.url, REPORT_WEBHOOK_KEY: KEY }), log });
  const requireAuth: RequestHandler = (_req, res, next) => { res.locals.authUser = { id: 3, role: "sales" }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createDiagnosticRouter({ db, requireAuth, workerSecret: () => undefined, currentBuild: () => null, healthy: async () => true, forwarder }));
  const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const r = await (await fetch(base + "/api/diagnostics/reports", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "client-flagoff-abcdefgh", description: "Legacy path report text", page: "/" }) })).json();
  assert.equal(r.status, "awaiting_connection");
  assert.equal((await (await fetch(base + "/api/diagnostics/availability")).json()).automaticPublishing, true);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(ep.hits.length, 0, "webhook must not be called while the flag is OFF");
  srv.closeAllConnections(); srv.close(); ep.close();
});

await test("forwarding disabled (no env): legacy behaviour unchanged even if flag is ON", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
  seedFlag(db, true);
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
