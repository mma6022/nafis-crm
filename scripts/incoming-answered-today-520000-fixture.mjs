/**
 * Hotfix 20261117520000: (1) an incoming call this expert answered today puts that customer
 * in-scope for note/report save (POST /api/calls) for the rest of the Tehran day;
 * (2) the same save is allowed for ANY customer the expert owns (e.g. from «مشتریان من»),
 * even when the customer is not on today's list.
 * Runs on a temp COPY of a masked DB; synthetic customer + events only; never prints
 * customer data; no network, no SMS, no live writes.
 * Usage: INCOMING_TODAY_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/incoming-answered-today-520000-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.INCOMING_TODAY_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB;
if (!src) { console.log("SKIP (set INCOMING_TODAY_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inc-today-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SMS_DISABLED: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  SAB_FEEDER: "0", BALE_BOT_WORKER: "0", LOAN_REQUEST_DRAFTS_JOBS: "off", SITE_LEAD_ALERTS: "off",
});
globalThis.fetch = async () => { throw new Error("unexpected network call in incoming-today fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { dpToday } = await import("../src/lib/daily-plan.ts");
  const { queryRow, execute } = db;
  const express = (await import("express")).default;

  const flag = (k, v) => execute(
    "INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [k, v],
  );
  flag("flag.expert_lockdown", "1");

  const ghasemi = { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", permissions: ["calls.create", "calls.view", "customers.view"], customerScope: "assigned", active: true };
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: ["calls.create", "calls.view", "customers.view"], customerScope: "assigned", active: true };
  assert.equal(el.elLocked(ghasemi), true, "ghasemi must be locked");
  assert.equal(el.elLocked(kazemi), true, "kazemi must be locked");

  const now = new Date();
  const day = dpToday(now);
  const todayStart = new Date(`${day}T10:00:00+03:30`);
  const todayIso = todayStart.toISOString();
  const todayEnd = new Date(todayStart.getTime() + 8 * 60000).toISOString();
  const yesterday = new Date(todayStart.getTime() - 24 * 3600 * 1000).toISOString();
  const yesterdayEnd = new Date(todayStart.getTime() - 24 * 3600 * 1000 + 8 * 60000).toISOString();

  // Synthetic customer owned by Ghasemi, not on today's plan, no case, no grant.
  execute("INSERT INTO customers(name, phone, salesperson_id, status, priority, created_at) VALUES(?,?,?,?,?,?)",
    ["fx-incoming-today", "09120000999", 4, "in_progress", 1, todayIso]);
  const cid = Number(queryRow("SELECT id FROM customers WHERE phone='09120000999' AND name='fx-incoming-today'").id);
  assert.ok(cid > 0);
  execute("DELETE FROM dp_items WHERE customer_id=?", [cid]);
  execute("DELETE FROM el_grants WHERE customer_id=?", [cid]);
  execute("DELETE FROM loan_applications WHERE customer_id=?", [cid]);
  try { execute("DELETE FROM goods_purchases WHERE customer_id=?", [cid]); } catch { /* optional */ }
  try { execute("DELETE FROM customer_payment_orders WHERE customer_id=?", [cid]); } catch { /* optional */ }

  await ok("own customer with no plan/case/grant is out of scope", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });

  const evCols = queryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='voip_after_call_events'");
  assert.ok(evCols, "voip_after_call_events must exist");
  const insertEv = (id, expertUserId, started, ended, status, isLive, direction = "incoming") => {
    execute(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,salesperson_id,customer_id,has_recording,is_live)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      [id, `fx-${id}`, "09120000999", direction, status, started, ended, "211", '["211"]', expertUserId, expertUserId === 3 ? 4 : 6, cid, isLive]);
  };

  insertEv(991001, 3, yesterday, yesterdayEnd, "ANSWERED", 0);
  await ok("yesterday's answered incoming does not grant today", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });

  insertEv(991002, 3, todayIso, todayEnd, "NO ANSWER", 0);
  await ok("today's missed incoming does not grant", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });

  insertEv(991003, 8, todayIso, todayEnd, "ANSWERED", 0);
  await ok("another expert's answered incoming does not grant this expert", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });

  insertEv(991004, 3, todayIso, todayEnd, "ANSWERED", 0);
  await ok("answered incoming today puts the customer in-scope as incoming", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), "incoming");
  });
  // Drop Ghasemi's answered event again so the next block can prove owner-save without it.
  execute("DELETE FROM voip_after_call_events WHERE id=991004");
  await ok("after dropping that event, access is null again (Kazemi's answered event 991003 remains)", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });

  // HTTP: lockdown guard + stub POST /calls (the path that returned 403 / 229 bytes on live)
  const app = express(); app.use(express.json());
  const actors = { ghasemi, kazemi };
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", (req, res, next) => el.expertLockdownGuard(req, res, next));
  app.post("/api/calls", (req, res) => res.status(201).json({ ok: true }));
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (actor, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api/calls", method: "POST", headers: { "x-actor": actor, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
        let j = null; try { j = JSON.parse(s); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j, raw: s, bytes: Buffer.byteLength(s) });
      });
    });
    r.on("error", reject); r.write(payload); r.end();
  });

  // 991003 (Kazemi answered today on Ghasemi's customer) already exists; 991004 not yet inserted
  // until the next block. Owner save must already work (t830u). Non-owner save works only via incoming.
  await ok("POST /api/calls is 201 for the owner even with no answered-incoming of their own (t830u)", async () => {
    const r = await call("ghasemi", { customerId: cid, expertNotes: "یادداشت آزمایشی برای ثبت نتیجه تماس مالک" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
  });
  await ok("non-owner who answered incoming today can also POST /api/calls (t829u)", async () => {
    assert.equal(el.elCustomerAccess(kazemi, cid, now), "incoming");
    const r = await call("kazemi", { customerId: cid, expertNotes: "یادداشت آزمایشی تماس ورودی کارشناس دیگر" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  // Unrelated write on an out-of-scope own customer stays 403 (lockdown not lifted for other families).
  app.post("/api/customers/:id/not-a-call-write", (req, res) => res.status(200).json({ ok: true }));
  const otherWrite = (actor, id) => new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, path: `/api/customers/${id}/not-a-call-write`, method: "POST", headers: { "x-actor": actor, "content-length": 0 } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
        let j = null; try { j = JSON.parse(s); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j, bytes: Buffer.byteLength(s) });
      });
    });
    r.on("error", reject); r.end();
  });
  await ok("other writes on an out-of-scope own customer stay 403", async () => {
    const r = await otherWrite("ghasemi", cid);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "expert_lockdown_customer");
    assert.equal(r.bytes, 229);
  });

  insertEv(991004, 3, todayIso, todayEnd, "ANSWERED", 0);
  await ok("POST /api/calls is 201 once the answered incoming exists", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), "incoming");
    const r = await call("ghasemi", { customerId: cid, expertNotes: "یادداشت آزمایشی برای ثبت نتیجه تماس ورودی" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  // Remove today's answered event; access drops, but the owner's call save stays open (t830u).
  execute("DELETE FROM voip_after_call_events WHERE id=991004");
  await ok("removing today's answered event returns elCustomerAccess to null, owner POST /calls stays 201", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
    const r = await call("ghasemi", { customerId: cid, expertNotes: "یادداشت آزمایشی برای ثبت نتیجه تماس مالک" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  // Drop Kazemi's answered event too: non-owner is refused with the known 229-byte body.
  execute("DELETE FROM voip_after_call_events WHERE id=991003");
  await ok("POST /api/calls is 403 for another expert with the known body", async () => {
    assert.equal(el.elCustomerAccess(kazemi, cid, now), null);
    const r = await call("kazemi", { customerId: cid, expertNotes: "یادداشت آزمایشی تماس ورودی کارشناس دیگر" });
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "expert_lockdown_customer");
    assert.equal(r.body?.message, "این مشتری فعلاً برای شما باز نیست (فقط مشتری‌های «کارهای امروز»، پرونده‌های خودت یا «تماس ورودی»).");
    assert.equal(r.bytes, 229);
  });

  // Live incoming still ringing also counts
  insertEv(991005, 3, todayIso, todayEnd, "RINGING", 1);
  await ok("a live incoming still on this expert counts as in-scope", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), "incoming");
    const r = await call("ghasemi", { customerId: cid, expertNotes: "یادداشت آزمایشی برای ثبت نتیجه تماس ورودی" });
    assert.equal(r.status, 201);
  });

  console.log(`PASS ${passed}/13 incoming-answered-today-520000`);
} catch (e) {
  console.error("FAIL after", passed, e);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
