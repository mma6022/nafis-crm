/**
 * t848u: (1) an answered/live incoming whose voip event has customer_id NULL still
 *     matches the existing customer by phone — the queue shows the saved name, and
 *     PATCH /customers/:id/name is allowed for the expert who received the call;
 * (2) a different incoming number does not open another own customer;
 * (3) a truly unknown number stays unknown; name-first still works for that expert;
 * (4) cneSplitName drops digit tokens so a name like «اقای دوست 0914 …» does not
 *     put the phone into lastName. The heading still uses the full stored name.
 * Runs on a temp COPY of a masked DB; synthetic rows only; no network, no SMS, no live writes.
 * Usage: INCOMING_NAME_T848_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/incoming-name-t848-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.INCOMING_NAME_T848_FIXTURE_DB || process.env.INCOMING_TODAY_FIXTURE_DB || process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set INCOMING_NAME_T848_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inc-name-t848-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SMS_DISABLED: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  SAB_FEEDER: "0", BALE_BOT_WORKER: "0", LOAN_REQUEST_DRAFTS_JOBS: "off", SITE_LEAD_ALERTS: "off",
});
globalThis.fetch = async () => { throw new Error("unexpected network call in incoming-name t848 fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { dpToday } = await import("../src/lib/daily-plan.ts");
  const { cneSplitName, cnePatch } = await import("../src/lib/customer-name-edit.ts");
  const { dqQueue } = await import("../src/lib/dci-queue.ts");
  const { queryRow, execute } = db;
  const express = (await import("express")).default;

  const flag = (k, v) => execute(
    "INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [k, v],
  );
  flag("flag.expert_lockdown", "1");
  flag("flag.customer_name_edit", "1");
  flag("flag.dci_queue_v21", "1");

  const ghasemi = { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", permissions: ["calls.create", "calls.view", "customers.view", "customers.update"], customerScope: "assigned", active: true };
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: ["calls.create", "calls.view", "customers.view", "customers.update"], customerScope: "assigned", active: true };
  assert.equal(el.elLocked(ghasemi), true);
  assert.equal(el.elLocked(kazemi), true);

  const now = new Date();
  const day = dpToday(now);
  const todayStart = new Date(`${day}T10:32:00+03:30`);
  const todayIso = todayStart.toISOString();
  const todayEnd = new Date(todayStart.getTime() + 8 * 60000).toISOString();

  const PH = "09120000848";
  const PH_OTHER = "09120000849";
  const PH_UNKNOWN = "09120000850";
  execute("INSERT INTO customers(name, phone, salesperson_id, status, priority, created_at) VALUES(?,?,?,?,?,?)",
    ["اقای دوست 09120000848", PH, 4, "in_progress", 3, todayIso]);
  const cid = Number(queryRow("SELECT id FROM customers WHERE phone=? AND name='اقای دوست 09120000848'", [PH]).id);
  execute("INSERT INTO customers(name, phone, salesperson_id, status, priority, created_at) VALUES(?,?,?,?,?,?)",
    ["مشتری دیگر آزمایشی", PH_OTHER, 4, "in_progress", 1, todayIso]);
  const otherId = Number(queryRow("SELECT id FROM customers WHERE phone=?", [PH_OTHER]).id);
  assert.ok(cid > 0 && otherId > 0 && cid !== otherId);
  for (const id of [cid, otherId]) {
    execute("DELETE FROM dp_items WHERE customer_id=?", [id]);
    execute("DELETE FROM el_grants WHERE customer_id=?", [id]);
    execute("DELETE FROM loan_applications WHERE customer_id=?", [id]);
    try { execute("DELETE FROM goods_purchases WHERE customer_id=?", [id]); } catch { /* optional */ }
    try { execute("DELETE FROM customer_payment_orders WHERE customer_id=?", [id]); } catch { /* optional */ }
  }

  await ok("cneSplitName drops the phone tokens from a nickname+number name", async () => {
    const s = cneSplitName("اقای دوست 09120000848", null, null);
    assert.equal(s.firstName, "اقای");
    assert.equal(s.lastName, "دوست");
    const kept = cneSplitName("علی رضایی", "علی", "رضایی");
    assert.equal(kept.firstName, "علی");
    assert.equal(kept.lastName, "رضایی");
  });

  await ok("own customer with no plan/case/grant and no event is out of scope", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), null);
    assert.equal(el.elCustomerAccess(ghasemi, otherId, now), null);
  });

  const insertUnlinked = (id, expertUserId, phone, status, isLive) => {
    execute(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,salesperson_id,customer_id,has_recording,is_live)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,0,?)`,
      [id, `fx-t848-${id}`, phone, "incoming", status, todayIso, todayEnd, "211", '["211"]', expertUserId, expertUserId === 3 ? 4 : 6, isLive]);
  };

  insertUnlinked(848001, 3, PH, "ANSWERED", 0);
  await ok("unlinked answered incoming whose phone matches the customer is in-scope as incoming", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, cid, now), "incoming");
  });
  await ok("that incoming does not open a different own customer", async () => {
    assert.equal(el.elCustomerAccess(ghasemi, otherId, now), null);
  });
  await ok("another expert does not get incoming access from this unlinked event", async () => {
    assert.equal(el.elCustomerAccess(kazemi, cid, now), null);
  });

  const q = dqQueue(ghasemi, now);
  await ok("queue shows the saved name and customer id for the unlinked matching incoming", async () => {
    const it = q.items.find((x) => x.call_id === 848001);
    assert.ok(it, "queue item for event 848001");
    assert.equal(it.customer_id, cid);
    assert.equal(it.name, "اقای دوست 09120000848");
    assert.notEqual(it.detected, "unknown");
    assert.equal(it.kind, "incoming_call");
  });

  const app = express(); app.use(express.json());
  const actors = { ghasemi, kazemi };
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", (req, res, next) => el.expertLockdownGuard(req, res, next));
  app.patch("/api/customers/:id/name", (req, res) => {
    const result = cnePatch(res.locals.authUser, Number(req.params.id), req.body ?? {});
    if (!result.ok) { res.status(result.status).json({ error: result.error, message: result.message }); return; }
    res.json({ ok: true, name: result.name, firstName: result.firstName, lastName: result.lastName, unchanged: result.unchanged });
  });
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const patchName = (actor, id, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: `/api/customers/${id}/name`, method: "PATCH", headers: { "x-actor": actor, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
        let j = null; try { j = JSON.parse(s); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on("error", reject); r.write(payload); r.end();
  });

  await ok("the receiving expert can save the name on the matched incoming customer", async () => {
    const r = await patchName("ghasemi", cid, { firstName: "کاظم", lastName: "جهانگیری" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.name, "کاظم جهانگیری");
    const row = queryRow("SELECT name, first_name, last_name FROM customers WHERE id=?", [cid]);
    assert.equal(row.name, "کاظم جهانگیری");
    assert.equal(row.first_name, "کاظم");
    assert.equal(row.last_name, "جهانگیری");
  });
  await ok("name save on a different own customer stays 403 while the incoming is for the other number", async () => {
    const r = await patchName("ghasemi", otherId, { firstName: "نام", lastName: "آزمایشی" });
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "expert_lockdown_customer");
    assert.equal(r.body?.message, "این مشتری فعلاً برای شما باز نیست (فقط مشتری‌های «کارهای امروز»، پرونده‌های خودت یا «تماس ورودی»).");
  });
  await ok("a different expert cannot save the name (403)", async () => {
    const r = await patchName("kazemi", cid, { firstName: "کاظم", lastName: "جهانگیری" });
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "expert_lockdown_customer");
  });

  insertUnlinked(848002, 8, PH_UNKNOWN, "ANSWERED", 1);
  await ok("a truly unknown incoming stays unknown in the receiver's queue", async () => {
    const qk = dqQueue(kazemi, now);
    const it = qk.items.find((x) => x.call_id === 848002);
    assert.ok(it, "queue item for unknown event");
    assert.equal(it.customer_id, null);
    assert.equal(it.detected, "unknown");
  });
  await ok("unknown incoming does not open the other expert's customer by mistake", async () => {
    assert.equal(el.elCustomerAccess(kazemi, cid, now), null);
    assert.equal(el.elCustomerAccess(kazemi, otherId, now), null);
  });

  console.log(`PASS ${passed}/11 incoming-name-t848`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
