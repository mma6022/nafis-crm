/**
 * t853u: extra customer mobile numbers (up to 3 including the primary).
 * Covers normalize/validation, the cap of 3, duplicate checks across primary+extras,
 * the access matrix, incoming-call matching on an extra number, and search.
 * Runs on a temp COPY of a masked DB; synthetic rows only; no network, no SMS, no live writes.
 * Usage: CUSTOMER_PHONES_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/customer-extra-phones-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.CUSTOMER_PHONES_FIXTURE_DB || process.env.INCOMING_NAME_T848_FIXTURE_DB || process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set CUSTOMER_PHONES_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cph-t853-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SMS_DISABLED: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  SAB_FEEDER: "0", BALE_BOT_WORKER: "0", LOAN_REQUEST_DRAFTS_JOBS: "off", SITE_LEAD_ALERTS: "off",
});
globalThis.fetch = async () => { throw new Error("unexpected network call in customer-extra-phones fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, execute, queryRows } = db;
  const cph = await import("../src/lib/customer-phones.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { dpToday } = await import("../src/lib/daily-plan.ts");
  const { customerMatcher } = await import("../src/lib/voip-after-call.ts");
  const { dqQueue } = await import("../src/lib/dci-queue.ts");
  const express = (await import("express")).default;

  cph.ensureCustomerPhonesSchema();

  const flag = (k, v) => execute(
    "INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [k, v],
  );
  flag("flag.expert_lockdown", "1");
  flag("flag.dci_queue_v21", "1");

  const admin = { id: 1, role: "admin", salespersonId: null, fullName: "admin", username: "admin", permissions: ["customers.view", "customers.update", "customers.create", "calls.create", "calls.view"], customerScope: "all", active: true };
  const ghasemi = { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", username: "ghasemi", permissions: ["calls.create", "calls.view", "customers.view", "customers.update"], customerScope: "assigned", active: true };
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", username: "kazemi", permissions: ["calls.create", "calls.view", "customers.view", "customers.update"], customerScope: "assigned", active: true };
  assert.equal(el.elLocked(ghasemi), true);
  assert.equal(el.elLocked(kazemi), true);

  const now = new Date();
  const day = dpToday(now);
  const todayStart = new Date(`${day}T10:32:00+03:30`);
  const todayIso = todayStart.toISOString();

  const P1 = "09120001901";
  const P2 = "09120001902";
  const P3 = "09120001903";
  const P4 = "09120001904";
  const PX = "09120001910";
  const PY = "09120001911";
  const PZ = "09120001912";
  const OTHER = "09120001920";
  const OTHER_EXTRA = "09120001921";

  const mk = (name, phone, sp) => {
    execute("INSERT INTO customers(name, phone, salesperson_id, status, priority, created_at) VALUES(?,?,?,?,?,?)",
      [name, phone, sp, "in_progress", 1, todayIso]);
    return Number(queryRow("SELECT id FROM customers WHERE phone=? AND name=?", [phone, name]).id);
  };
  const aId = mk("مشتری آزمایشی الف", P1, 4);
  const bId = mk("مشتری آزمایشی ب", OTHER, 6);
  assert.ok(aId > 0 && bId > 0 && aId !== bId);
  for (const id of [aId, bId]) {
    execute("DELETE FROM dp_items WHERE customer_id=?", [id]);
    try { execute("DELETE FROM el_grants WHERE customer_id=?", [id]); } catch { /* optional */ }
    execute("DELETE FROM loan_applications WHERE customer_id=?", [id]);
    try { execute("DELETE FROM goods_purchases WHERE customer_id=?", [id]); } catch { /* optional */ }
    try { execute("DELETE FROM customer_payment_orders WHERE customer_id=?", [id]); } catch { /* optional */ }
  }

  await ok("normalize accepts 09, +98, 98, 9 and Persian digits", async () => {
    const samples = ["09120001901", "+989120001901", "989120001901", "9120001901", "۰۹۱۲۰۰۰۱۹۰۱", "00989120001901"];
    for (const s of samples) {
      const r = cph.parseCustomerPhone(s);
      assert.equal(r.ok, true, s);
      if (r.ok) assert.equal(r.phone, "09120001901", s);
    }
  });

  await ok("validation rejects a short or landline number", async () => {
    for (const s of ["0912", "02122123456", "abcd", "", "0912000190"]) {
      const r = cph.parseCustomerPhone(s);
      assert.equal(r.ok, false, s);
      if (!r.ok) assert.match(r.message, /موبایل/);
    }
  });

  await ok("owner expert can add a second number", async () => {
    const r = cph.addCustomerPhone(ghasemi, aId, P2, "همسر", now, true);
    assert.equal(r.ok, true, r.ok ? "" : r.message);
    if (r.ok) {
      assert.equal(r.extra.phone, P2);
      assert.equal(r.extra.label, "همسر");
      assert.equal(r.view.total, 2);
      assert.equal(r.view.canAdd, true);
    }
  });

  await ok("the same number on this customer is rejected", async () => {
    const r = cph.addCustomerPhone(ghasemi, aId, P1, null, now, true);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.error, "same_customer"); assert.match(r.message, /همین مشتری/); }
    const r2 = cph.addCustomerPhone(ghasemi, aId, "9120001902", null, now, true);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error, "same_customer");
  });

  await ok("a number already used as another customer's primary is rejected with name and expert", async () => {
    const r = cph.addCustomerPhone(ghasemi, aId, OTHER, null, now, true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "duplicate_mobile");
      assert.match(r.message, /مشتری آزمایشی ب/);
      assert.match(r.message, /کارشناس/);
      assert.equal(r.customer && r.customer.id, bId);
    }
  });

  await ok("a number already used as another customer's extra is rejected", async () => {
    const addB = cph.addCustomerPhone(admin, bId, OTHER_EXTRA, "محل کار", now, false);
    assert.equal(addB.ok, true, addB.ok ? "" : addB.message);
    const r = cph.addCustomerPhone(ghasemi, aId, OTHER_EXTRA, null, now, true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "duplicate_mobile");
      assert.match(r.message, /مشتری آزمایشی ب/);
      assert.equal(r.customer && r.customer.id, bId);
    }
  });

  await ok("the third number is accepted and a fourth is rejected", async () => {
    const r = cph.addCustomerPhone(ghasemi, aId, P3, null, now, true);
    assert.equal(r.ok, true, r.ok ? "" : r.message);
    if (r.ok) { assert.equal(r.view.total, 3); assert.equal(r.view.canAdd, false); }
    const r4 = cph.addCustomerPhone(ghasemi, aId, P4, null, now, true);
    assert.equal(r4.ok, false);
    if (!r4.ok) { assert.equal(r4.error, "phone_limit"); assert.match(r4.message, /سه شماره/); }
  });

  await ok("the primary number cannot be deleted; an extra number can", async () => {
    const listed = cph.listCustomerPhones(ghasemi, aId, true);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.view.extras.length, 2);
    const extraId = listed.view.extras.find((x) => x.phone === P3).id;
    const noPrimary = cph.deleteCustomerPhone(ghasemi, aId, 0, true);
    assert.equal(noPrimary.ok, false);
    const del = cph.deleteCustomerPhone(ghasemi, aId, extraId, true);
    assert.equal(del.ok, true, del.ok ? "" : del.message);
    if (del.ok) assert.equal(del.view.total, 2);
  });

  await ok("access matrix: admin can add, the other expert cannot, lockdown without access cannot", async () => {
    const byAdmin = cph.addCustomerPhone(admin, aId, PX, null, now, false);
    assert.equal(byAdmin.ok, true, byAdmin.ok ? "" : byAdmin.message);
    // back to 2 extras already? a has P2 and PX now (P3 deleted). cap 3 including primary = 2 extras. PX is third number, canAdd false.
    // other expert, no lockdownAccess
    const other = cph.addCustomerPhone(kazemi, aId, PY, null, now, false);
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.status, 403);
    assert.equal(cph.canManageCustomerPhones(kazemi, aId, false), false);
    assert.equal(cph.canManageCustomerPhones(kazemi, aId, true), true);
    assert.equal(cph.canManageCustomerPhones(ghasemi, aId, false), true);
    assert.equal(cph.canManageCustomerPhones(admin, bId, false), true);
  });

  // incoming on extra: give a a free slot (delete PX) and use PZ as extra for incoming tests
  {
    const listed = cph.listCustomerPhones(ghasemi, aId, true);
    if (listed.ok) {
      const extra = listed.view.extras.find((x) => x.phone === PX);
      if (extra) cph.deleteCustomerPhone(ghasemi, aId, extra.id, true);
    }
    const add = cph.addCustomerPhone(ghasemi, aId, PZ, "تماس ورودی", now, true);
    assert.equal(add.ok, true, add.ok ? "" : add.message);
  }

  await ok("customerMatcher resolves an unlinked incoming on the extra number", async () => {
    const hit = customerMatcher()(PZ);
    assert.ok(hit, "expected a match");
    assert.equal(hit.id, aId);
    const miss = customerMatcher()("09120001999");
    assert.equal(miss, null);
    const primary = customerMatcher()(P1);
    assert.equal(primary && primary.id, aId);
  });

  await ok("incoming-call access and the today queue match the extra number (t848-style)", async () => {
    const evStart = todayIso;
    const evEnd = new Date(todayStart.getTime() + 5 * 60000).toISOString();
    const evId = 853001;
    execute("DELETE FROM voip_after_call_events WHERE id=?", [evId]);
    execute(
      `INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,expert_name,salesperson_id,customer_id,has_recording,is_live)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,0)`,
      [evId, `cph-in-${evId}`, PZ, "incoming", "ANSWERED", evStart, evEnd, "211", "[\"211\"]", ghasemi.id, "ghasemi", ghasemi.salespersonId],
    );
    assert.equal(el.elCustomerAccess(ghasemi, aId, todayStart), "incoming");
    const q = dqQueue(ghasemi, todayStart);
    const item = (q.items || []).find((it) => it.customer_id === aId);
    assert.ok(item, "queue should show the customer for the extra-number incoming");
    assert.match(String(item.name || item.customer_name || ""), /آزمایشی الف/);
  });

  await ok("search finds the customer by the extra number", async () => {
    const owner = cph.findOwnerByAnyPhone(PZ);
    assert.ok(owner);
    assert.equal(owner.id, aId);
    const rows = queryRows(
      `SELECT c.id FROM customers c WHERE c.merged_into_customer_id IS NULL AND (${cph.ANY_PHONE_LIKE_SQL})`,
      ["%09120001912%"],
    );
    assert.ok(rows.some((r) => Number(r.id) === aId));
    const byPrimary = cph.findOwnerByAnyPhone(P1);
    assert.equal(byPrimary && byPrimary.id, aId);
  });

  // HTTP + lockdown guard
  const app = express(); app.use(express.json());
  const actors = { admin, ghasemi, kazemi };
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", (req, res, next) => el.expertLockdownGuard(req, res, next));
  const phonesRouter = (await import("../src/routes/customer-phones.ts")).default;
  app.use("/api", phonesRouter);
  const sock = path.join(dir, "cph.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (actor, method, url, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const r = http.request({ socketPath: sock, path: url, method, headers: { "x-actor": actor, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });

  await ok("HTTP: locked other expert is 403; the answering expert and admin can list", async () => {
    const denied = await call("kazemi", "GET", `/api/customers/${aId}/phones`);
    assert.equal(denied.status, 403);
    const allowed = await call("ghasemi", "GET", `/api/customers/${aId}/phones`);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    assert.equal(allowed.data.primary.phone, P1);
    assert.ok(allowed.data.extras.some((x) => x.phone === PZ));
    const asAdmin = await call("admin", "GET", `/api/customers/${bId}/phones`);
    assert.equal(asAdmin.status, 200);
  });

  console.log(`customer-extra-phones fixture ${passed}/13`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
}
