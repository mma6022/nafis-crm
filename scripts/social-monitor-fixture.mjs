// Isolated, synthetic SQLite fixture: never imports the CRM runtime or reads a CRM database.
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import vm from "node:vm";
import { safeResponseHeaders } from "../../../deploy/social-proxy/response-headers.mjs";
const require = createRequire(path.resolve("artifacts/api-server/package.json"));
const express = require("express"), { build } = require("esbuild");
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER);
  INSERT INTO users VALUES(1,'fixture-admin','Fixture Admin','admin',1),
    (2,'fixture-expert','Fixture Expert','salesperson',1),(3,'fixture-inactive','Inactive','salesperson',0);
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,first_name TEXT,last_name TEXT,merged_into_customer_id INTEGER);
  INSERT INTO customers VALUES(1,'Synthetic Contact','Synthetic','Contact',NULL),
    (2,'مشتری هم‌نام','','',NULL),(3,'مشتري هم نام','','',NULL);`);
process.env.SOCIAL_SECRET = "fixture-social-secret";
const auth = (req, res, next) => {
  const user = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(Number(req.header("x-fixture-user") || 0));
  if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
  res.locals.authUser = user; next();
};
let summaryCalls = 0, summaryLines = [], failSummary = false;
const bindings = { Router: express.Router, crmDb: db,
  queryRows: (sql, args = []) => db.prepare(sql).all(...args),
  execute: (sql, args = []) => db.prepare(sql).run(...args),
  requireAuth: auth, requireAdmin: (_req, res, next) => res.locals.authUser?.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }),
  socialSummaryConfigured: () => true,
  summarizeSocialTranscript: async lines => { summaryCalls++; summaryLines = lines; await new Promise(r => setTimeout(r, 25));
    if (failSummary) throw new Error("Synthetic provider unavailable"); return "خلاصهٔ آزمایشیِ تمام تاریخچه"; },
};
const compiled = await build({
  stdin: { contents: 'export {socialMonitorFeature} from "./src/lib/social-monitor";', resolveDir: path.resolve("artifacts/api-server"), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "iife", globalName: "__fixtureFeature",
  plugins: [{ name: "fixture", setup(b) {
    b.onResolve({ filter: /^express$|(?:^|\/)(crm-db|auth|social-thread-summary)$/ }, a => ({ path: a.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, a => {
      const names = a.path === "express" ? ["Router"] : a.path.endsWith("crm-db") ? ["crmDb", "queryRows", "execute"]
        : a.path.endsWith("social-thread-summary") ? ["socialSummaryConfigured", "summarizeSocialTranscript"] : ["requireAuth", "requireAdmin"];
      return { contents: names.map(n => `export const ${n}=__bindings.${n};`).join("\n") };
    });
  } }],
});
const feature = new Function("__bindings", "require", compiled.outputFiles[0].text + "\nreturn __fixtureFeature.socialMonitorFeature;")(bindings, require);
const app = express(); app.use(express.json());
app.get("/fixture-session", (_req, res) => res.json({ user: { id: 2, fullName: "Fixture Expert", role: "salesperson", active: true, permissions: ["internal_chat.use"] } }));
app.use("/api/social-monitor", feature.ingestRouter);
app.use("/api", feature.reportRouter);
app.get("/api/unrelated", auth, (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let proxy;
const payload = {
  employeeId: 2, service: "wa", contactName: "Synthetic Contact", conversationKey: "fixture-conversation",
  messages: [
    { key: "one", text: "Synthetic customer message", direction: "inbound", occurredAt: "2026-10-19T06:00:00.000Z", timestampKnown: false },
    { key: "two", text: "Synthetic expert response", direction: "outbound", occurredAt: "2026-10-19T06:01:00.000Z", timestampKnown: true },
  ],
};
function signed(body = payload) {
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString("hex"), text = JSON.stringify(body);
  const signature = createHmac("sha256", process.env.SOCIAL_SECRET).update(`${timestamp}.${nonce}.${text}`).digest("hex");
  return { method: "POST", headers: { "content-type": "application/json", "x-social-timestamp": timestamp, "x-social-nonce": nonce, "x-social-signature": signature }, body: text };
}
try {
  assert.deepEqual(safeResponseHeaders({ "content-type": "image/png", "content-disposition": 'attachment; filename="نام فارسی.png"' }), { "content-type": "image/png" });
  const request = signed();
  assert.equal((await fetch(base + "/api/social-monitor/ingest", request)).status, 202);
  assert.equal((await fetch(base + "/api/social-monitor/ingest", request)).status, 409, "Replay must be rejected");
  const invalid = signed(); invalid.headers["x-social-signature"] = "0".repeat(64);
  assert.equal((await fetch(base + "/api/social-monitor/ingest", invalid)).status, 401);
  assert.equal((await fetch(base + "/api/social-monitor/ingest", signed({ ...payload, employeeId: 3 }))).status, 403);
  const changedDate = { ...payload, messages: payload.messages.map(m => ({ ...m, occurredAt: "2026-10-20T06:00:00.000Z" })) };
  assert.equal((await fetch(base + "/api/social-monitor/ingest", signed(changedDate))).status, 202);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_monitor_messages").get().n, 2, "Reopening a chat must not duplicate messages");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_monitor_daily_summaries").get().n, 1, "A repeat observation must keep its first date");
  const url = base + "/api/social-monitor/reports?from=2026-10-19&to=2026-10-19";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { "x-fixture-user": "2" } })).status, 403);
  const reportResponse = await fetch(url, { headers: { "x-fixture-user": "1" } });
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.days[0].inboundCount, 1); assert.equal(report.days[0].outboundCount, 1);
  assert.equal(report.days[0].conversationCount, 1); assert(report.days[0].summary);
  assert.equal(report.conversations[0].employeeId, 2);
  const messagesResponse = await fetch(base + "/api/social-monitor/messages?employeeId=2&service=wa&conversationKey=fixture-conversation&day=2026-10-19", { headers: { "x-fixture-user": "1" } });
  const detail = await messagesResponse.json(); assert.equal(detail.messages.length, 2); assert.equal(detail.messages[0].timestampKnown, false);
  const admin = { "x-fixture-user": "1" }, expert = { "x-fixture-user": "2" };
  for (let offset = 0; offset < 225; offset += 25) {
    const batch = { ...payload, service: "bale", conversationKey: "fixture-another-capture-key", messages: Array.from({ length: Math.min(25, 225 - offset) }, (_, i) => ({
      key: `history-${offset + i}`, text: `Synthetic full-history message ${offset + i}`, direction: (offset + i) % 2 ? "inbound" : "outbound",
      occurredAt: new Date(Date.parse("2026-10-20T06:00:00Z") + (offset + i) * 60000).toISOString(), timestampKnown: true,
    })) };
    assert.equal((await fetch(base + "/api/social-monitor/ingest", signed(batch))).status, 202);
  }
  const reportAll = await (await fetch(base + "/api/social-monitor/reports?from=2026-10-19&to=2026-10-21", { headers: admin })).json();
  assert.equal(reportAll.conversations.length, 1, "Same customer appears once across days, services and capture keys");
  const thread = reportAll.conversations[0], threadPath = base + "/api/social-monitor/threads/" + thread.threadId;
  assert.equal(thread.customerId, 1); assert.equal(thread.customerMatch, "exact");
  assert.equal(thread.day, "2026-10-20", "Already-open legacy clients retain a real source day until reload");
  assert.equal(thread.messageCount, 227); assert.equal(thread.sourceCount, 2);
  const filteredReport = await (await fetch(url, { headers: admin })).json();
  assert.equal(filteredReport.conversations[0].messageCount, 2, "List counts still honor report dates");
  let page = await (await fetch(threadPath + "/messages", { headers: admin })).json();
  assert.equal(page.messages.length, 200); assert.equal(page.hasMore, true);
  const older = await (await fetch(threadPath + "/messages?before=" + page.olderCursor, { headers: admin })).json();
  assert.equal(older.messages.length, 27); assert.equal(older.hasMore, false);
  const complete = [...older.messages, ...page.messages];
  assert.equal(new Set(complete.map(m => m.id)).size, 227);
  assert(complete.every((m, i) => !i || m.occurredAt >= complete[i - 1].occurredAt), "Continuous history is chronologically ordered");
  assert.equal((await fetch(threadPath + "/messages?before=garbage", { headers: admin })).status, 400);
  for (const endpoint of [threadPath + "/messages", threadPath + "/summary", base + "/api/social-monitor/customers?search=Syn"]) {
    assert.equal((await fetch(endpoint, { headers: expert })).status, 403);
    assert.equal((await fetch(endpoint)).status, 401);
  }
  const postAdmin = body => ({ method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(threadPath + "/summary", { ...postAdmin({}), headers: { ...expert, "content-type": "application/json" } })).status, 403);
  assert.equal(summaryCalls, 0, "Viewing and non-admin attempts must never send text to AI");
  assert.equal((await fetch(threadPath + "/summary", postAdmin({}))).status, 202);
  await new Promise(r => setTimeout(r, 50));
  let summary = await (await fetch(threadPath + "/summary", { headers: admin })).json();
  assert.equal(summary.status, "ready"); assert.equal(summary.stale, false);
  assert.equal(summaryLines.length, 227, "Summary includes all dates and pages, not just the latest 200");
  assert(summaryLines.some(s => s.includes("Synthetic customer message")));
  assert(summaryLines.some(s => s.includes("full-history message 224")));
  assert.equal((await fetch(threadPath + "/summary", postAdmin({}))).status, 200);
  assert.equal(summaryCalls, 1, "Unchanged summaries must be reused without another provider call");
  assert.equal((await fetch(base + "/api/social-monitor/ingest", signed({ ...payload, messages: [{ ...payload.messages[0], text: "Synthetic edited message" }] }))).status, 202);
  summary = await (await fetch(threadPath + "/summary", { headers: admin })).json();
  assert.equal(summary.stale, true, "Content edits invalidate cached summaries");
  failSummary = true;
  await fetch(threadPath + "/summary", postAdmin({})); await new Promise(r => setTimeout(r, 50));
  summary = await (await fetch(threadPath + "/summary", { headers: admin })).json();
  assert.equal(summary.status, "error"); assert.match(summary.error, /unavailable/); failSummary = false;
  await fetch(threadPath + "/summary", postAdmin({})); await new Promise(r => setTimeout(r, 50));
  assert.equal((await (await fetch(threadPath + "/summary", { headers: admin })).json()).status, "ready");
  assert.equal((await fetch(base + "/api/social-monitor/ingest", signed({ ...payload, contactName: "مشتري هم نام", conversationKey: "ambiguous-source" }))).status, 202);
  const ambiguousReport = await (await fetch(url, { headers: admin })).json();
  const ambiguous = ambiguousReport.conversations.find(t => t.customerMatch === "ambiguous");
  assert(ambiguous); assert.equal(ambiguous.customerId, null); assert.equal(ambiguous.customerCandidates.length, 2);
  assert.equal((await fetch(base + `/api/social-monitor/threads/${ambiguous.threadId}/customer`, postAdmin({ customerId: 2 }))).status, 200);
  const linkedReport = await (await fetch(url, { headers: admin })).json();
  const linkedThread = linkedReport.conversations.find(t => t.customerId === 2);
  assert.equal(linkedThread.customerMatch, "linked");
  assert.equal(db.prepare("SELECT linked_by FROM social_monitor_customer_links WHERE customer_id=2").get().linked_by, 1);
  assert.equal((await fetch(base + `/api/social-monitor/threads/${ambiguous.threadId}/messages`, { headers: admin })).status, 404, "Old thread identity must not expose a different regrouped customer");
  for (const query of ["1", "۱", "١"]) {
    const found = await (await fetch(base + "/api/social-monitor/customers?search=" + encodeURIComponent(query), { headers: admin })).json();
    assert.deepEqual(found.customers.map(c => c.id), [1], "Manual search accepts complete Latin/Persian/Arabic IDs");
  }
  assert.equal((await fetch(base + "/api/social-monitor/ingest", signed({
    ...payload, contactName: "Synthetic Contact - CRM: ۱", conversationKey: "name-and-id-source",
  }))).status, 202);
  const idReport = await (await fetch(url, { headers: admin })).json();
  const idThread = idReport.conversations.find(t => t.customerId === 1);
  assert.equal(idThread.customerMatch, "exact");
  assert.equal(idThread.sourceCount, 3, "Name+CRM-ID source joins the same continuous customer thread");
  assert.equal((await fetch(base + `/api/social-monitor/threads/${idThread.threadId}/customer`, {
    ...postAdmin({ customerId: 2 }), headers: { ...expert, "content-type": "application/json" },
  })).status, 403, "Manual links remain administrator-only");
  console.log("continuous threads fixture: customer matching, ambiguity, all-history pagination, role isolation, full-history summaries, cache invalidation and provider errors passed");
  assert.equal((await fetch(base + "/api/unrelated", { headers: { "x-fixture-user": "2" } })).status, 200, "Manager-only report middleware must not block unrelated expert routes");
  proxy = spawn(process.execPath, [path.resolve("deploy/social-proxy/server.mjs")], { env: {
    PATH: process.env.PATH, PORT: "5993", SOCIAL_SECRET: process.env.SOCIAL_SECRET, SOCIAL_SCHEME: "http",
    SOCIAL_CRM_HOST: "crm.fixture.test", SOCIAL_HOST_WA: "wa.fixture.test",
    CRM_AUTH_URL: base + "/fixture-session", SOCIAL_INGEST_URL: base + "/api/social-monitor/ingest",
  }, stdio: "pipe" });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Proxy startup timeout")), 6000);
    proxy.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    proxy.once("error", reject);
  });
  const proxyRequest = (route, host, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest("http://127.0.0.1:5993" + route, {
      method: options.method || "GET", headers: { host, ...options.headers },
    }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => body += chunk);
      res.on("end", () => resolve(new Response(body, { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject); req.end(options.body);
  });
  const entry = await proxyRequest("/_social/enter?svc=wa", "crm.fixture.test");
  assert.equal(entry.status, 302);
  const ticket = new URL(entry.headers.get("location"));
  const login = await proxyRequest(ticket.pathname + ticket.search, "wa.fixture.test");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/__capture/open", "Every CRM entry must bypass the messenger's cached app-shell navigation");
  const font = await proxyRequest("/__capture/font.woff2", "wa.fixture.test", { headers: { cookie } });
  assert.equal(font.status, 200); assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.equal((await proxyRequest("/__capture/context", "wa.fixture.test", { headers: { "sec-fetch-dest": "serviceworker" } })).status, 403, "Worker header must not bypass capture authentication");
  const workerShim = await (await proxyRequest("/__shim.js", "wa.fixture.test", { headers: { cookie } })).text();
  const listeners = new Map(), network = [];
  class WorkerScope {}
  const worker = new WorkerScope();
  Object.assign(worker, { location: new URL("http://wa.fixture.test/serviceworker.js"),
    fetch: async req => { network.push(req.url || req); return "network-response"; },
    addEventListener: (name, callback) => listeners.set(name, callback),
    skipWaiting: async () => {}, clients: { claim: async () => {} } });
  vm.runInNewContext(workerShim, { self: worker, ServiceWorkerGlobalScope: WorkerScope, URL });
  for (const [pathname, mode] of [["/__capture", "cors"], ["/", "navigate"]]) {
    let response, stopped = false;
    listeners.get("fetch")({ request: { url: "http://wa.fixture.test" + pathname, mode },
      stopImmediatePropagation() { stopped = true; }, respondWith(value) { response = value; } });
    assert(stopped); assert.equal(await response, "network-response");
  }
  assert.equal(network.length, 2, "Capture and navigation must bypass the provider's stale worker cache");
  const context = await proxyRequest("/__capture/context", "wa.fixture.test", { headers: { cookie } });
  const contextBody = await context.json();
  assert.equal(contextBody.id, 2); assert.equal(contextBody.name, "Fixture Expert");
  assert.match(contextBody.sessionKey, /^[a-f0-9]{24}$/); assert(contextBody.expiresAt > Date.now());
  const capture = { ...payload, captureActorId: 2, captureSessionKey: contextBody.sessionKey, employeeId: 1 };
  const captureOptions = body => ({ method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await proxyRequest("/__capture", "wa.fixture.test", captureOptions(capture))).status, 202);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_monitor_messages WHERE employee_user_id=1").get().n, 0, "Proxy must ignore forged employeeId");
  assert.equal((await proxyRequest("/__capture", "wa.fixture.test", captureOptions({ ...capture, captureActorId: 1 }))).status, 409, "Changed browser identity must stop capture");
  assert.equal((await proxyRequest("/__capture", "wa.fixture.test", captureOptions({ ...capture, captureSessionKey: "different-session" }))).status, 409, "Consent must be bound to the signed proxy session");
  db.prepare("DELETE FROM role_permissions WHERE role_slug='salesperson' AND permission='internal_chat.use'").run();
  assert.equal((await proxyRequest("/__capture", "wa.fixture.test", captureOptions(capture))).status, 403, "Revoked real role permission must stop capture despite an existing proxy cookie");
  console.log("proxy-to-API fixture: CRM identity ticket, context, HMAC forwarding and actor-change protection passed");
  console.log("social-monitor fixture: signed ingest, replay/tamper/inactive guards, idempotency, stored daily summaries, admin-only reports and unrelated expert access passed");
} finally {
  if (proxy) {
    proxy.kill();
    if (proxy.exitCode === null) await new Promise(resolve => { proxy.once("exit", resolve); setTimeout(resolve, 2000); });
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
}
