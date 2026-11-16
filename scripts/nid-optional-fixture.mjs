// crm-nid-optional (PM 16:03) fixture: «کد ملی» is optional on every customer-name edit route.
//  PATCH /customers/:id (full edit + quick edit) and POST /calls (old call form profile):
//  name edit without a code succeeds; a stored code survives omitted / null / "" (untouched); only the explicit
//  `clearNationalCode: true` erases it (logged to customer_national_code_changes); invalid codes are rejected.
// Runs on a throwaway copy of a scrubbed DB over a unix socket. Never touches live; no inquiry, no SMS.
// Usage: NID_OPTIONAL_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/nid-optional-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.NID_OPTIONAL_FIXTURE_DB;
if (!src) { console.log("SKIP (set NID_OPTIONAL_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nid-optional-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";

// Fake but checksum-valid national codes (fixture only).
const nc = (nine) => { const d = nine.split("").map(Number); const s = d.reduce((t, x, i) => t + x * (10 - i), 0) % 11; return nine + (s < 2 ? s : 11 - s); };
const NC_A = nc("001234567"), NC_B = nc("001765432"), NC_C = nc("002468013"), NC_D = nc("003579246");
const badDigit = (code) => code.slice(0, 9) + ((Number(code[9]) + 1) % 10);
const fa = (code) => code.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const cp = await import("../src/lib/consult-profile.ts");
  const { queryRow, queryRows, execute } = db;
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

  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 10`).map((r) => Number(r.id));
  assert.ok(pool.length >= 8, "need 8 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET national_code=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const code = (id) => queryRow("SELECT national_code n FROM customers WHERE id=?", [id]).n ?? null;
  const name = (id) => queryRow("SELECT name n FROM customers WHERE id=?", [id]).n;
  cp.ensureIdentityLogSchema();
  const logs = (id) => queryRows(`SELECT * FROM ${cp.IDENTITY_LOG_TABLE} WHERE customer_id=? ORDER BY id`, [id]);
  const checks = () => Number(queryRow("SELECT count(*) n FROM customer_credit_checks").n);
  const checks0 = checks();

  const withCode = next(), noCode = next(), clearOne = next(), setOne = next(), callOne = next(), callNoCode = next(), badOne = next();
  execute("UPDATE customers SET national_code=? WHERE id=?", [NC_A, withCode]);
  execute("UPDATE customers SET national_code=? WHERE id=?", [NC_B, clearOne]);
  execute("UPDATE customers SET national_code=? WHERE id=?", [NC_C, callOne]);
  execute("UPDATE customers SET national_code=? WHERE id=?", [NC_D, badOne]);

  for (const actor of ["admin", "kazemi"]) {
    await ok(`PATCH /customers/:id (${actor}): name only, customer WITHOUT a code → 200, still no code`, async () => {
      const r = await call("PATCH", `/customers/${noCode}`, actor, { name: `بدون کد ملی ${actor}` });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(name(noCode), `بدون کد ملی ${actor}`); assert.equal(code(noCode), null);
    });
    await ok(`PATCH /customers/:id (${actor}): name + nationalCode null / "" without a code → 200 (optional)`, async () => {
      for (const v of [null, ""]) assert.equal((await call("PATCH", `/customers/${noCode}`, actor, { name: "نام تازه", nationalCode: v })).status, 200, String(v));
      assert.equal(code(noCode), null);
    });
    await ok(`PATCH /customers/:id (${actor}): name edit preserves an existing code when omitted / null / "" (untouched)`, async () => {
      for (const extra of [{}, { nationalCode: null }, { nationalCode: "" }, { nationalCode: "   " }, { clearNationalCode: false }, { clearNationalCode: "true" }]) {
        const r = await call("PATCH", `/customers/${withCode}`, actor, { name: "حفظ کد ملی", ...extra });
        assert.ok([200, 400].includes(r.status));
        if (extra.nationalCode === "   ") { assert.equal(code(withCode), NC_A); continue; } // whitespace: either rejected by schema or ignored — never a wipe
        assert.equal(r.status, 200, JSON.stringify(extra) + JSON.stringify(r.body));
        assert.equal(code(withCode), NC_A, JSON.stringify(extra));
      }
      assert.equal(logs(withCode).length, 0, "nothing logged when the code did not change");
    });
    await ok(`PATCH /customers/:id (${actor}): same code re-sent (Persian digits) → kept, not logged`, async () => {
      assert.equal((await call("PATCH", `/customers/${withCode}`, actor, { name: "حفظ کد ملی", nationalCode: fa(NC_A) })).status, 200);
      assert.equal(code(withCode), NC_A); assert.equal(logs(withCode).length, 0);
    });
  }
  await ok("PATCH /customers/:id: invalid codes (length / check digit / repeated) → 400, nothing written", async () => {
    for (const bad of ["123", badDigit(NC_A), "1111111111", "12345678901"]) {
      const r = await call("PATCH", `/customers/${badOne}`, "kazemi", { name: "نام نامعتبر", nationalCode: bad });
      assert.equal(r.status, 400, bad);
    }
    assert.equal(code(badOne), NC_D); assert.notEqual(name(badOne), "نام نامعتبر"); assert.equal(logs(badOne).length, 0);
  });
  await ok("PATCH /customers/:id: clearNationalCode together with a value → 400 (ambiguous), nothing written", async () => {
    assert.equal((await call("PATCH", `/customers/${clearOne}`, "kazemi", { name: "x", nationalCode: NC_C, clearNationalCode: true })).status, 400);
    assert.equal(code(clearOne), NC_B);
  });
  await ok("PATCH /customers/:id: explicit clear (field touched + emptied) → code NULL, logged as customer_update '' ", async () => {
    const r = await call("PATCH", `/customers/${clearOne}`, "kazemi", { name: "پاک کردن کد", nationalCode: null, clearNationalCode: true });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(code(clearOne), null); assert.equal(name(clearOne), "پاک کردن کد");
    const l = logs(clearOne); assert.equal(l.length, 1);
    assert.equal(l[0].old_national_code, NC_B); assert.equal(l[0].new_national_code, ""); assert.equal(l[0].source, "customer_update"); assert.equal(Number(l[0].actor_user_id), 8);
  });
  await ok("PATCH /customers/:id: clear without a stored code is a harmless no-op (name still saved)", async () => {
    assert.equal((await call("PATCH", `/customers/${clearOne}`, "admin", { name: "بدون کد", clearNationalCode: true })).status, 200);
    assert.equal(name(clearOne), "بدون کد"); assert.equal(logs(clearOne).length, 1);
  });
  await ok("PATCH /customers/:id: a valid new code is saved and logged (customer_update)", async () => {
    assert.equal((await call("PATCH", `/customers/${setOne}`, "kazemi", { name: "کد جدید", nationalCode: nc("004444444") })).status, 200);
    const l = logs(setOne); assert.equal(l.length, 1); assert.equal(l[0].old_national_code, null); assert.equal(l[0].new_national_code, nc("004444444")); assert.equal(l[0].source, "customer_update");
    assert.equal(code(setOne), nc("004444444"));
  });
  const callBody = (customerId, profile) => ({ customerId, subject: "پیگیری", customerRequest: "تماس", expertNotes: "یادداشت تست", profile });
  await ok("POST /calls (old call form): empty / blank profile code keeps the stored code (no wipe)", async () => {
    for (const v of [null, ""]) {
      const r = await call("POST", "/calls", "kazemi", callBody(callOne, { nationalCode: v, postalCode: null, birthDateJalali: null }));
      assert.equal(r.status < 300, true, JSON.stringify(r.body)); assert.equal(code(callOne), NC_C, String(v));
    }
    assert.equal(logs(callOne).length, 0);
  });
  await ok("POST /calls: customer without a code + empty profile → saved, still no code", async () => {
    const r = await call("POST", "/calls", "kazemi", callBody(callNoCode, { nationalCode: null, postalCode: null, birthDateJalali: null }));
    assert.ok(r.status < 300, JSON.stringify(r.body)); assert.equal(code(callNoCode), null);
  });
  await ok("POST /calls: invalid profile code → 4xx, stored code untouched", async () => {
    const r = await call("POST", "/calls", "kazemi", callBody(callOne, { nationalCode: badDigit(NC_C), postalCode: null, birthDateJalali: null }));
    assert.ok(r.status >= 400, String(r.status)); assert.equal(code(callOne), NC_C);
  });
  await ok("POST /calls: a valid new profile code is saved and logged (call_profile)", async () => {
    const r = await call("POST", "/calls", "kazemi", callBody(callNoCode, { nationalCode: nc("005555555"), postalCode: null, birthDateJalali: null }));
    assert.ok(r.status < 300, JSON.stringify(r.body)); assert.equal(code(callNoCode), nc("005555555"));
    const l = logs(callNoCode); assert.equal(l.length, 1); assert.equal(l[0].source, "call_profile"); assert.equal(l[0].old_national_code, null);
  });
  await ok("no credit inquiry was started by any of the above", async () => { assert.equal(checks(), checks0); });
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
process.exit(0);
