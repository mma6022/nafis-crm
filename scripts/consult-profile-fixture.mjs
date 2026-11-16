// crm-no-plan-option (14:51) fixture: «اطلاعات مشاوره» history/edit/backfill + «اعتبارسنجی سریع» national-code save.
// Runs on a throwaway copy of a scrubbed DB; HTTP goes over a unix socket inside the temp dir. Never touches live; no inquiry, no SMS.
// Usage: CONSULT_PROFILE_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/consult-profile-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.CONSULT_PROFILE_FIXTURE_DB;
if (!src) { console.log("SKIP (set CONSULT_PROFILE_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-profile-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";

// Fake but checksum-valid national codes (fixture only).
const nc = (nine) => { const d = nine.split("").map(Number); const s = d.reduce((t, x, i) => t + x * (10 - i), 0) % 11; return nine + (s < 2 ? s : 11 - s); };
const NC_A = nc("001234567"), NC_B = nc("001765432"), NC_C = nc("002468013");
const now = new Date("2026-10-24T10:00:00+03:30");
const v2 = { mode: "simple", callResult: "answered", urgency: "now", amountMillion: 100, docsReady: "all", creditRank: "A1",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no" };
const note = "مشتری جواب داد؛ مدارک آماده است، شرایط بررسی شد و توضیح کامل ثبت شد.";

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const cp = await import("../src/lib/consult-profile.ts");
  const { creditRankForScore } = await import("../src/lib/credit-rank.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const tsRouter = (await import("../src/routes/team-sales.ts")).default;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");

  const P = ["customers.view", "customers.update", "calls.create"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned" },
    otherAll: { id: 2, role: "salesperson", salespersonId: 3, fullName: "other", permissions: P, customerScope: "all" },
    otherAssigned: { id: 3, role: "salesperson", salespersonId: 4, fullName: "other2", permissions: P, customerScope: "assigned" },
    registrar: { id: 7, role: "registrar", salespersonId: null, fullName: "registrar", permissions: P, customerScope: "all" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", crmRouter); app.use("/api", tsRouter);
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
  assert.ok(pool.length >= 6, "need 6 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET priority=NULL, national_code=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const checks = () => Number(queryRow("SELECT count(*) n FROM customer_credit_checks").n);
  const checks0 = checks();

  /* ---------- «اعتبارسنجی سریع» national-code save ---------- */
  const qc = next(); const qcUrl = `/customers/${qc}/quick-credit/national-code`;
  await ok("quick-credit: not own salesperson (sees the customer) → 403; assigned-scope stranger → 404", async () => {
    assert.equal((await call("POST", qcUrl, "otherAll", { nationalCode: NC_A })).status, 403);
    assert.equal((await call("POST", qcUrl, "otherAssigned", { nationalCode: NC_A })).status, 404);
  });
  await ok("quick-credit: invalid code (length / check digit) → 400, nothing written", async () => {
    for (const bad of ["123", NC_A.slice(0, 9) + ((Number(NC_A[9]) + 1) % 10), "1111111111"])
      assert.equal((await call("POST", qcUrl, "kazemi", { nationalCode: bad })).status, 400, bad);
    assert.equal(queryRow("SELECT national_code n FROM customers WHERE id=?", [qc]).n, null);
  });
  await ok("quick-credit: own salesperson saves an empty code (Persian digits ok) → changed, logged, no inquiry started", async () => {
    const fa = NC_A.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
    const r = await call("POST", qcUrl, "kazemi", { nationalCode: fa });
    assert.equal(r.status, 200); assert.equal(r.body.changed, true); assert.equal(r.body.replaced, false);
    assert.equal(queryRow("SELECT national_code n FROM customers WHERE id=?", [qc]).n, NC_A);
    const log = queryRows(`SELECT * FROM ${cp.IDENTITY_LOG_TABLE} WHERE customer_id=?`, [qc]);
    assert.equal(log.length, 1); assert.equal(log[0].old_national_code, null); assert.equal(log[0].source, "quick_credit");
    assert.equal(log[0].identity_changed, 0, "empty → filled is completion, not an identity change");
    assert.equal(queryRow("SELECT identity_changed_at t FROM customers WHERE id=?", [qc]).t ?? null, null, "identity_changed_at not stamped on empty → filled");
    assert.equal(checks(), checks0, "no credit check row");
  });
  await ok("quick-credit: same code again → changed:false, no new log row", async () => {
    const r = await call("POST", qcUrl, "kazemi", { nationalCode: NC_A });
    assert.equal(r.status, 200); assert.equal(r.body.changed, false);
    assert.equal(Number(queryRow(`SELECT count(*) n FROM ${cp.IDENTITY_LOG_TABLE} WHERE customer_id=?`, [qc]).n), 1);
  });
  await ok("quick-credit: different code without confirm → 409 confirm_replace, unchanged", async () => {
    const r = await call("POST", qcUrl, "kazemi", { nationalCode: NC_B });
    assert.equal(r.status, 409); assert.equal(r.body.code, "confirm_replace");
    assert.equal(queryRow("SELECT national_code n FROM customers WHERE id=?", [qc]).n, NC_A);
  });
  await ok("quick-credit: replace with confirm → identity_changed_at set, verification reset, old code logged; old inquiry no longer official", async () => {
    // the first save (empty → NC_A) does not stamp identity_changed_at; the old report just needs to predate the replacement
    const t0 = new Date(Date.parse(queryRow("SELECT identity_changed_at t FROM customers WHERE id=?", [qc]).t ?? 0) + 1000).toISOString();
    await new Promise((r) => setTimeout(r, 1100));
    execute(`INSERT INTO customer_credit_checks(customer_id,national_code,status,score,created_at,updated_at,completed_at) VALUES(?,?,'report_generated',650,?,?,?)`, [qc, NC_A, t0, t0, t0]);
    assert.ok(cp.officialGrade(qc), "official grade before the change");
    execute("UPDATE customers SET verification_status='verified' WHERE id=?", [qc]);
    const r = await call("POST", qcUrl, "registrar", { nationalCode: NC_B, confirmReplace: true });
    assert.equal(r.status, 200); assert.equal(r.body.replaced, true); assert.equal(r.body.identityChanged, true);
    const c = queryRow("SELECT national_code, identity_changed_at, verification_status FROM customers WHERE id=?", [qc]);
    assert.equal(c.national_code, NC_B); assert.ok(c.identity_changed_at); assert.equal(c.verification_status, "unverified");
    const last = queryRow(`SELECT * FROM ${cp.IDENTITY_LOG_TABLE} WHERE customer_id=? ORDER BY id DESC LIMIT 1`, [qc]);
    assert.equal(last.old_national_code, NC_A); assert.equal(last.new_national_code, NC_B); assert.equal(Number(last.actor_user_id), 7);
    assert.equal(cp.officialGrade(qc), null, "the identity_changed_at rule invalidates the old inquiry");
  });
  await ok("quick-credit: code already used by another active customer → 409", async () => {
    const other = next();
    const r = await call("POST", `/customers/${other}/quick-credit/national-code`, "admin", { nationalCode: NC_B });
    assert.equal(r.status, 409); assert.notEqual(r.body.code, "confirm_replace");
    assert.equal(queryRow("SELECT national_code n FROM customers WHERE id=?", [other]).n, null);
    pool.push(other);
  });
  await ok("quick-credit never creates a credit check (no inquiry, no OTP)", () => {
    assert.equal(checks(), checks0 + 1, "only the fixture's own inserted report row");
  });

  /* ---------- «اطلاعات مشاوره»: history on submit, official grade, edit ---------- */
  const cid = next();
  await ok("first-call submit writes a 'first_call' version with the declared grade and the submitter", () => {
    ts.submitQualification(cid, actors.kazemi, { ...v2, urgency: "later", creditRank: "A1", jobType: "retired", military: "has_card", city: "شهر نمونه",
      guarantorAvailable: "yes", guarantorCheque: "yes", gRank: "B2", gJobType: "business" }, note, now);
    const p = cp.consultProfile(cid);
    assert.equal(p.versions.length, 1); assert.equal(p.latest.source, "first_call");
    const d = p.latest.data;
    assert.equal(d.creditRank, "A1"); assert.equal(d.jobType, "retired"); assert.equal(d.military, "has_card"); assert.equal(d.city, "شهر نمونه");
    assert.equal(d.gRank, "B2"); assert.equal(d.gJobType, "business"); assert.equal(d.urgency, "later"); assert.ok(d.formDate); assert.ok(d.submitterName);
    assert.equal(p.official, null);
  });
  await ok("official grade: shown next to the declared one, and plan matching uses it (stored answers keep the declared grade)", () => {
    const t = new Date(now.getTime() + 60000).toISOString();
    execute("UPDATE customers SET identity_changed_at=NULL WHERE id=?", [cid]);
    execute(`INSERT INTO customer_credit_checks(customer_id,national_code,status,score,created_at,updated_at,completed_at) VALUES(?,?,'report_generated',120,?,?,?)`, [cid, NC_C, t, t, t]);
    const rank = creditRankForScore(120); assert.ok(rank);
    assert.deepEqual(cp.officialGrade(cid), { rank, checkedAt: t });
    const declared = ts.planOptions(cid, { ...v2, creditRank: "A1" }, now).plans.map((p) => [p.planId, p.status]);
    const asOfficial = ts.planOptions(cid, { ...v2, creditRank: rank }, now).plans.map((p) => [p.planId, p.status]);
    assert.deepEqual(declared, asOfficial, "declared A1 is evaluated as the official rank");
    assert.equal(cp.consultProfile(cid).latest.data.creditRank, "A1");
    const stored = JSON.parse(queryRow("SELECT answers_json a FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC LIMIT 1", [cid]).a);
    assert.equal(stored.creditRank, "A1");
  });
  await ok("GET consult-profile: owner/admin/registrar canEdit; other salesperson sees it read-only; assigned stranger 404", async () => {
    for (const a of ["kazemi", "admin", "registrar"]) { const r = await call("GET", `/customers/${cid}/consult-profile`, a); assert.equal(r.status, 200); assert.equal(r.body.canEdit, true, a); }
    const o = await call("GET", `/customers/${cid}/consult-profile`, "otherAll"); assert.equal(o.status, 200); assert.equal(o.body.canEdit, false);
    assert.equal((await call("GET", `/customers/${cid}/consult-profile`, "otherAssigned")).status, 404);
  });
  await ok("PATCH: non-owner salesperson → 403; bad value → 400; no change → 400", async () => {
    assert.equal((await call("PATCH", `/customers/${cid}/consult-profile`, "otherAll", { changes: { jobType: "business" } })).status, 403);
    assert.equal((await call("PATCH", `/customers/${cid}/consult-profile`, "kazemi", { changes: { military: "maybe" } })).status, 400);
    assert.equal((await call("PATCH", `/customers/${cid}/consult-profile`, "kazemi", { changes: { jobType: "retired" } })).status, 400);
    assert.equal(cp.consultProfile(cid).versions.length, 1);
  });
  await ok("PATCH by the owner: new 'edit' version with changed fields; old versions kept; matcher follows the edit", async () => {
    const r = await call("PATCH", `/customers/${cid}/consult-profile`, "kazemi", { changes: { military: "no_card", city: "شهر دیگر" } });
    assert.equal(r.status, 200);
    const p = cp.consultProfile(cid);
    assert.equal(p.versions.length, 2); assert.equal(p.latest.source, "edit"); assert.deepEqual([...p.latest.changedFields].sort(), ["city", "military"]);
    assert.equal(p.versions[1].source, "first_call"); assert.equal(p.versions[1].data.military, "has_card", "history kept unchanged");
    assert.equal(ts.latestApplicantProfile(cid).military, "no_card");
  });
  await ok("PATCH guarantor → «نمی‌تونه» clears guarantor sub-answers; admin edit logged with actor", async () => {
    const r = await call("PATCH", `/customers/${cid}/consult-profile`, "admin", { changes: { guarantorAvailable: "no" } });
    assert.equal(r.status, 200);
    const p = cp.consultProfile(cid);
    assert.equal(p.versions.length, 3); assert.equal(p.latest.actorUserId, 1);
    assert.equal(p.latest.data.gRank, null); assert.equal(p.latest.data.gJobType, null); assert.equal(p.latest.data.guarantorCheque, null);
  });
  await ok("customer without a profile: GET latest null; PATCH → 404", async () => {
    const id = next();
    const g = await call("GET", `/customers/${id}/consult-profile`, "kazemi"); assert.equal(g.status, 200); assert.equal(g.body.latest, null);
    assert.equal((await call("PATCH", `/customers/${id}/consult-profile`, "kazemi", { changes: { city: "x" } })).status, 404);
    pool.push(id);
  });
  await ok("no-plan answer is stored on the profile", () => {
    const id = next();
    const opts = ts.planOptions(id, { ...v2, urgency: "later" }, now);
    ts.submitQualification(id, actors.kazemi, { ...v2, urgency: "later", noPlanFit: true }, note, now, [], "درآمد ثابت ندارد");
    const d = cp.consultProfile(id).latest.data;
    assert.equal(d.noPlanFit, true); assert.equal(d.noPlanNote, "درآمد ثابت ندارد"); assert.deepEqual(d.selectedPlans, []); assert.ok(opts);
  });

  /* ---------- backfill + rollback (scripts) on a second copy ---------- */
  const bf = await import("./consult-profile-backfill.mjs");
  const rb = await import("./consult-profile-backfill-rollback.mjs");
  const bfPath = path.join(dir, "backfill.db"); fs.copyFileSync(src, bfPath);
  const bdb = new DatabaseSync(bfPath);
  await ok("backfill dry-run: counts, trainee customers skipped, nothing written", () => {
    // make one answered first-call row belong to a trainee (fixture copy only) to prove the skip
    const q = bdb.prepare("SELECT id, customer_id FROM team_sales_qualifications WHERE call_result='answered' ORDER BY id LIMIT 1").get();
    const sp0 = bdb.prepare("SELECT salesperson_id s FROM customers WHERE id=?").get(q.customer_id).s;
    const plan0 = bf.planBackfill(bdb);
    bdb.prepare("UPDATE customers SET salesperson_id=19 WHERE id=?").run(q.customer_id);
    const plan = bf.planBackfill(bdb);
    assert.equal(plan.counts.skippedTrainee, plan0.counts.skippedTrainee + (plan0.rows.some((r) => r.qualificationId === Number(q.id)) ? 1 : 0));
    assert.ok(plan.rows.every((r) => r.customerId !== Number(q.customer_id)));
    bdb.prepare("UPDATE customers SET salesperson_id=? WHERE id=?").run(sp0, q.customer_id);
    assert.equal(bdb.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(bf.TABLE), undefined, "dry-run creates nothing");
    assert.equal(plan0.counts.toInsert, plan0.rows.length);
  });
  await ok("backfill apply → rows inserted as 'backfill'; second apply is a no-op (idempotent)", () => {
    const plan = bf.planBackfill(bdb); const r = bf.applyBackfill(bdb, plan);
    assert.equal(r.inserted, plan.rows.length);
    assert.equal(Number(bdb.prepare(`SELECT count(*) n FROM ${bf.TABLE} WHERE source='backfill'`).get().n), plan.rows.length);
    const again = bf.planBackfill(bdb); assert.equal(again.counts.toInsert, 0); assert.equal(again.counts.alreadyInHistory, plan.rows.length);
    assert.equal(bf.applyBackfill(bdb, again).inserted, 0);
  });
  await ok("rollback removes only 'backfill' rows; app 'edit' rows survive; --drop-table-if-empty refuses while rows remain", () => {
    const anyCustomer = bdb.prepare(`SELECT customer_id c FROM ${bf.TABLE} LIMIT 1`).get()?.c ?? pool[0];
    bdb.prepare(`INSERT INTO ${bf.TABLE}(customer_id,source,data_json,changed_fields_json,actor_user_id,actor_name,created_at) VALUES(?,'edit','{}','[]',1,'admin',datetime('now'))`).run(anyCustomer);
    const before = rb.planRollback(bdb); assert.equal(before.otherRows, 1);
    const r = rb.applyRollback(bdb, { dropIfEmpty: true });
    assert.equal(r.deleted, before.backfillRows); assert.equal(r.dropped, false);
    assert.equal(rb.planRollback(bdb).backfillRows, 0); assert.equal(rb.planRollback(bdb).otherRows, 1);
  });
  bdb.close();
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
process.exit(0);
