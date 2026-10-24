// crm-nid-quick (PM 16:37) fixture: «ویرایش سریع» (CustomerForm → PATCH /customers/:id) never needs «کد ملی».
//  - the exact quick-edit payload (no nationalCode key) saves for salesperson (kazemi) and admin; a stored code is kept;
//  - re-saving an unchanged phone / code is not blocked by a legacy duplicate (API check + DB trigger);
//  - a real new conflict is still rejected with a message naming the colliding field.
// Runs on a throwaway copy of a scrubbed DB over a unix socket. Never touches live; no inquiry, no SMS.
// Usage: NID_QUICK_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/nid-quick-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.NID_QUICK_FIXTURE_DB;
if (!src) { console.log("SKIP (set NID_QUICK_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nid-quick-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";

const nc = (nine) => { const d = nine.split("").map(Number); const s = d.reduce((t, x, i) => t + x * (10 - i), 0) % 11; return nine + (s < 2 ? s : 11 - s); };
const NC_A = nc("001234567"), NC_DUP = nc("006543210"), NC_NEW = nc("007777770");

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const integrity = await import("../src/lib/customer-integrity.ts");
  const { queryRow, queryRows, execute, crmDb } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const P = ["customers.view", "customers.update", "calls.create"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", crmRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 12`).map((r) => Number(r.id));
  assert.ok(pool.length >= 10, "need 10 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET national_code=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const row = (id) => queryRow("SELECT name,phone,national_code nc,status,salesperson_id sp FROM customers WHERE id=?", [id]);
  const checks = () => Number(queryRow("SELECT count(*) n FROM customer_credit_checks").n);
  const checks0 = checks();
  // Exactly what CustomerForm («ویرایش سریع») sends when «کد ملی» was not touched.
  const quickPayload = (id, actor, name) => {
    const r = row(id);
    return { name, phone: r.phone, postalCode: null, birthDateJalali: null, description: "ویرایش سریع تست", priority: null, status: r.status, isUrgent: false,
      ...(actor === "admin" ? { salespersonId: 6, allocationProgramId: null } : {}) };
  };

  const withCode = next(), noCode = next(), dupA = next(), dupB = next(), phA = next(), phB = next(), target = next(), other = next(), cancelled = next(), cancelledTwin = next();
  execute("UPDATE customers SET national_code=? WHERE id=?", [NC_A, withCode]);

  for (const actor of ["kazemi", "admin"]) {
    await ok(`quick edit (${actor}): name change without «کد ملی», customer WITH a stored code → 200, code kept`, async () => {
      const r = await call("PATCH", `/customers/${withCode}`, actor, quickPayload(withCode, actor, `ویرایش سریع ${actor}`));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(row(withCode).name, `ویرایش سریع ${actor}`); assert.equal(row(withCode).nc, NC_A);
    });
    await ok(`quick edit (${actor}): customer WITHOUT a code → 200, still no code`, async () => {
      const r = await call("PATCH", `/customers/${noCode}`, actor, quickPayload(noCode, actor, `بدون کد ${actor}`));
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(row(noCode).nc, null); assert.equal(row(noCode).name, `بدون کد ${actor}`);
    });
  }

  // Legacy duplicates (created before the guards): bypass the trigger once, then reinstall it.
  crmDb.exec("DROP TRIGGER customers_unique_mobile_update");
  execute("UPDATE customers SET national_code=? WHERE id IN (?,?)", [NC_DUP, dupA, dupB]);
  execute("UPDATE customers SET phone=(SELECT phone FROM customers WHERE id=?) WHERE id=?", [phA, phB]);
  integrity.installCustomerIdentityGuards(crmDb);

  for (const actor of ["kazemi", "admin"]) {
    await ok(`quick edit (${actor}): unchanged «کد ملی» shared with a legacy duplicate → 200 (not blocked)`, async () => {
      const r = await call("PATCH", `/customers/${dupA}`, actor, quickPayload(dupA, actor, `کد تکراری ${actor}`));
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(row(dupA).nc, NC_DUP);
    });
    await ok(`quick edit (${actor}): unchanged phone shared with a legacy duplicate → 200 (not blocked)`, async () => {
      const r = await call("PATCH", `/customers/${phB}`, actor, quickPayload(phB, actor, `موبایل تکراری ${actor}`));
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(row(phB).name, `موبایل تکراری ${actor}`);
    });
  }
  await ok("a NEW phone conflict is still rejected (409) and the message names «شماره همراه», not «کد ملی»", async () => {
    const before = row(target);
    const r = await call("PATCH", `/customers/${target}`, "kazemi", { ...quickPayload(target, "kazemi", "تداخل موبایل"), phone: row(other).phone });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /شماره همراه/); assert.doesNotMatch(r.body.error, /کد ملی/);
    assert.deepEqual(row(target), before);
  });
  await ok("a NEW «کد ملی» conflict is still rejected (409) and names «کد ملی»", async () => {
    const r = await call("PATCH", `/customers/${target}`, "kazemi", { ...quickPayload(target, "kazemi", "تداخل کد"), nationalCode: NC_DUP });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /کد ملی/); assert.equal(row(target).nc, null);
  });
  await ok("DB trigger still blocks a direct write that creates a new duplicate", async () => {
    assert.throws(() => execute("UPDATE customers SET phone=(SELECT phone FROM customers WHERE id=?) WHERE id=?", [other, target]), /ACTIVE_CUSTOMER_MOBILE_CONFLICT/);
    assert.throws(() => execute("UPDATE customers SET national_code=? WHERE id=?", [NC_DUP, target]), /ACTIVE_CUSTOMER_NATIONAL_CODE_CONFLICT/);
  });
  await ok("reactivating a cancelled customer whose phone is taken is still rejected", async () => {
    execute("UPDATE customers SET status='cancelled' WHERE id=?", [cancelled]);
    crmDb.exec("DROP TRIGGER customers_unique_mobile_update");
    execute("UPDATE customers SET phone=(SELECT phone FROM customers WHERE id=?) WHERE id=?", [cancelledTwin, cancelled]);
    integrity.installCustomerIdentityGuards(crmDb);
    assert.throws(() => execute("UPDATE customers SET status='in_progress' WHERE id=?", [cancelled]), /ACTIVE_CUSTOMER_MOBILE_CONFLICT/);
    const r = await call("PATCH", `/customers/${cancelled}`, "admin", { ...quickPayload(cancelled, "admin", "فعال‌سازی"), status: "in_progress" });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.match(r.body.error, /شماره همراه/); assert.equal(row(cancelled).status, "cancelled");
  });
  await ok("no credit inquiry was started by any of the above", async () => { assert.equal(checks(), checks0); });
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
process.exit(0);
