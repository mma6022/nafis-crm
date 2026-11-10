// daily-customer-inline v1.1 fixture (flag.daily_customer_inline_v1):
// flag OFF = 404 dci_off, no dci_ tables, existing settings unchanged;
// flag ON = timeline + board; experts 8/2/3 own 200 / other 403; optional inbound note;
// no inquiry code in payload; no network. Runs on a temp COPY of a masked DB.
// Usage: DCI_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/daily-customer-inline-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.DCI_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB || process.env.CT_CHAT_FIXTURE_DB;
if (!src) { console.log("SKIP (set DCI_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dci-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error("unexpected network call in dci fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const dci = await import("../src/lib/daily-customer-inline.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const dciRouter = (await import("../src/routes/daily-customer-inline.ts")).default;
  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: P, customerScope: "all", active: true, salesManager: false },
    manager: { id: 5, role: "sales_manager", salespersonId: null, fullName: "manager", permissions: P, customerScope: "all", active: true, salesManager: true },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true },
    hasani: { id: 2, role: "salesperson", salespersonId: 3, fullName: "hasani", permissions: P, customerScope: "assigned", active: true },
    ghasemi: { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", permissions: P, customerScope: "assigned", active: true },
  };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  execute("DELETE FROM call_queue_settings WHERE key LIKE 'flag.daily_customer_inline_v1%'");
  const dciTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dci\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name);
  const settingsSnap = () => queryRows("SELECT key, value FROM call_queue_settings ORDER BY key").map((r) => `${r.key}=${r.value}`);
  const beforeSettings = settingsSnap();

  const ts = new Date().toISOString();
  const CID_K = 910021, CID_H = 910022, CID_G = 910023;
  const PH_K = "09120000021", PH_H = "09120000022", PH_G = "09120000023";
  for (const c of [
    [CID_K, "Samira", PH_K, 6],
    [CID_H, "Mehdi", PH_H, 3],
    [CID_G, "Narges", PH_G, 4],
  ]) {
    execute("DELETE FROM customers WHERE id=?", [c[0]]);
    execute(`INSERT INTO customers(id,name,phone,salesperson_id,status,priority,created_at,verification_status,is_urgent,verification_version,national_code,credit_rank)
      VALUES(?,?,?,?, 'in_progress', NULL, ?, 'unverified', 0, 0, NULL, ?)`,
      [c[0], c[1], c[2], c[3], ts, c[0] === 910021 ? "B2" : null]);
  }

  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", dciRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  const leak = (obj) => JSON.stringify(obj).includes("OPENAI") || JSON.stringify(obj).includes("SESSION_SECRET");
  const hasCode = (obj) => {
    const s = JSON.stringify(obj);
    return /inquiryCode|otpCode|"otp"|request_code|tracking_code/.test(s);
  };
  const forbidden = (obj) => /سپرده|برآورد|تخمینی/.test(JSON.stringify(obj));

  await ok("flag OFF: status disabled, data 404 dci_off, no dci tables, settings unchanged", async () => {
    assert.equal(dci.dciFlagOn(8), false);
    assert.deepEqual((await call("GET", "/daily-customer-inline/status", "kazemi")).body, { enabled: false });
    for (const [m, u] of [
      ["GET", "/daily-customer-inline/today"],
      ["GET", `/daily-customer-inline/customers/${CID_K}`],
      ["POST", `/daily-customer-inline/customers/${CID_K}/notes`],
      ["POST", "/daily-customer-inline/inbounds/1/note"],
    ]) {
      const r = await call(m, u, "kazemi", m === "POST" ? { body: "x" } : undefined);
      assert.equal(r.status, 404, u);
      assert.equal(r.body.error, "dci_off");
    }
    assert.deepEqual(dciTables(), []);
    assert.deepEqual(settingsSnap(), beforeSettings);
  });

  flag("flag.daily_customer_inline_v1.user.8", "1");
  await ok("per-user flag: only kazemi (8) enabled; hasani/ghasemi still 404", async () => {
    assert.equal(dci.dciFlagOn(8), true);
    assert.equal(dci.dciFlagOn(2), false);
    assert.equal(dci.dciFlagOn(3), false);
    assert.equal((await call("GET", "/daily-customer-inline/status", "kazemi")).body.enabled, true);
    assert.equal((await call("GET", "/daily-customer-inline/status", "hasani")).body.enabled, false);
    assert.equal((await call("GET", "/daily-customer-inline/today", "hasani")).status, 404);
    assert.equal((await call("GET", "/daily-customer-inline/today", "ghasemi")).status, 404);
    const today = await call("GET", "/daily-customer-inline/today", "kazemi");
    assert.equal(today.status, 200);
    assert.equal(today.body.enabled, true);
    assert.ok(Array.isArray(today.body.tasks));
    assert.equal(hasCode(today.body), false);
    assert.equal(forbidden(today.body), false);
  });

  await ok("lockdown 8/2/3: own 200, other 403, no phone/wallet/cases on 403", async () => {
    flag("flag.daily_customer_inline_v1", "1"); // global so 2 and 3 can call
    const ownK = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "kazemi");
    assert.equal(ownK.status, 200, "kazemi own");
    assert.equal(ownK.body.customer.id, CID_K);
    assert.ok(ownK.body.customer.phone);
    assert.ok(ownK.body.wallet === null || ownK.body.wallet);
    assert.equal(hasCode(ownK.body), false);
    assert.equal(forbidden(ownK.body), false);
    assert.equal(leak(ownK.body), false);
    const otherKH = await call("GET", `/daily-customer-inline/customers/${CID_H}`, "kazemi");
    assert.equal(otherKH.status, 403);
    assert.equal(otherKH.body.error, "not_owner");
    assert.equal(otherKH.body.message, "مشتری شما نیست");
    assert.ok(!("phone" in (otherKH.body.customer || {})));
    assert.ok(!otherKH.body.wallet);
    assert.ok(!otherKH.body.cases);
    const ownH = await call("GET", `/daily-customer-inline/customers/${CID_H}`, "hasani");
    assert.equal(ownH.status, 200, "hasani own");
    const otherHK = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "hasani");
    assert.equal(otherHK.status, 403, "hasani other");
    const ownG = await call("GET", `/daily-customer-inline/customers/${CID_G}`, "ghasemi");
    assert.equal(ownG.status, 200, "ghasemi own");
    const otherGK = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "ghasemi");
    assert.equal(otherGK.status, 403, "ghasemi other");
  });

  await ok("manager sees other customer and wallet; inbound optional note does not block", async () => {
    const mgr = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "manager");
    assert.equal(mgr.status, 200);
    assert.ok(mgr.body.wallet);
    const ev = 991001;
    execute(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,customer_id,has_recording,recording_file,duration_seconds,expert_notes,is_live,report_revision,auto_capture,auto_queued)
      VALUES (?,?,'09120000021','incoming','ANSWERED',datetime('now'),datetime('now'),'214','["214"]',8,?,1,'fx.wav',40,'',0,0,0,0)`, [ev, `dci-fx-${ev}`, CID_K]);
    if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_recording_transcripts'")) {
      execute("INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,result_json,created_at,updated_at,completed_at) VALUES (?,?,'2026-11-01','2026-11-10',5,'completed',?,datetime('now'),datetime('now'),datetime('now'))",
        [`dci-fx-${ev}`, "fx.wav", JSON.stringify({ text: "گفت مدارک را می فرستد.", summary: "مدارک را امروز می فرستد." })]);
    }
    const board = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "kazemi");
    assert.equal(board.status, 200);
    assert.ok(Array.isArray(board.body.inbounds));
    const empty = await call("POST", `/daily-customer-inline/inbounds/${ev}/note`, "kazemi", { body: "" });
    assert.ok(empty.status === 200 || empty.status === 404, `empty note status ${empty.status}`);
    if (empty.status === 200) assert.equal(empty.body.ok, true);
    const wrote = await call("POST", `/daily-customer-inline/inbounds/${ev}/note`, "kazemi", { body: "یادداشت اختیاری آزمایشی" });
    assert.equal(wrote.status, 200);
    const note = await call("POST", `/daily-customer-inline/customers/${CID_K}/notes`, "kazemi", { body: "پیگیری مدارک" });
    assert.equal(note.status, 200);
    assert.ok(note.body.notes.some((n) => n.body === "پیگیری مدارک"));
  });

  await ok("flag off again: 404 and no further schema change required; net unused", async () => {
    flag("flag.daily_customer_inline_v1", "0");
    flag("flag.daily_customer_inline_v1.user.8", "0");
    assert.equal(dci.dciFlagOn(8), false);
    const r = await call("GET", "/daily-customer-inline/today", "kazemi");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "dci_off");
    assert.equal(netCalls, 0);
  });

  console.log(`daily-customer-inline fixture passed ${passed} checks`);
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  if (server) await new Promise((r) => server.close(r));
}
