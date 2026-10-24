// crm-grade-followups fixture: guarantor-grade rule, identity-change rule, «نادیده گرفتن رتبه» reason + audit log,
// migration/rollback. Pure tests always run; the DB section runs on a throwaway copy. Never touches live; sends nothing.
// Usage: GRADE_FOLLOWUPS_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/grade-followups-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normIdentityValue, identityValueChanged, identityValuesChanged } from "../src/lib/identity-change.ts";
import { normalizeOverrideReason, CREDIT_RANK_OVERRIDE_REASON_MIN } from "../src/lib/credit-rank-override-reason.ts";
import { guarantorGradeVerdict, guarantorGradeAllows, pickGuarantorGrade, isUnknownGuarantorGrade } from "../src/lib/guarantor-grade-rule.ts";
import { loanCreditRankOverrideError, loanRankOverrideSnapshot } from "../src/lib/loan-credit-rank-override.ts";
import { TABLE, INDEXES, DDL, tableState, migrate } from "./credit-rank-override-log-migrate.mjs";
import { planRollback, exportRows, backup, applyRollback } from "./credit-rank-override-log-rollback.mjs";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const here = path.dirname(new URL(import.meta.url).pathname);
const srcRoot = fs.existsSync(path.join(here, "../src")) ? path.join(here, "../src") : path.resolve(process.cwd(), "src");
const read = (p) => fs.readFileSync(path.join(srcRoot, p), "utf8");

/* ---------- (2) identity-change rule ---------- */
await ok("identity: empty -> filled is NOT a change (null, '', whitespace, ZWNJ)", () => {
  for (const empty of [null, undefined, "", "   ", "\u200c"]) assert.equal(identityValueChanged(empty, "0012345678"), false);
});
await ok("identity: Persian/Arabic digits and whitespace normalise equal", () => {
  assert.equal(identityValueChanged("۰۰۱۲۳۴۵۶۷۸", "0012345678"), false);
  assert.equal(identityValueChanged("٠٠١٢٣٤٥٦٧٨", " 0012345678 "), false);
  assert.equal(identityValueChanged("1370/01/05", "۱۳۷۰/۰۱/۰۵"), false);
  assert.equal(identityValueChanged("علي  رضايي", "علی\u200cرضایی".replace("\u200c", " ")), false);
  assert.equal(normIdentityValue("  ك ي\u200f "), "ک ی");
});
await ok("identity: real replacement and clearing ARE changes", () => {
  assert.equal(identityValueChanged("1370/01/05", "1370/01/06"), true);
  assert.equal(identityValueChanged("0012345678", ""), true);
  assert.equal(identityValuesChanged([[null, "x"], ["", "y"]]), false);
  assert.equal(identityValuesChanged([[null, "x"], ["1", "2"]]), true);
});
await ok("identity: every identity_changed_at writer goes through the rule", () => {
  const crm = read("routes/crm.ts"), portal = read("routes/customer-portal-profile.ts");
  assert.match(crm, /from "\.\.\/lib\/identity-change"/);
  assert.match(portal, /from "\.\.\/lib\/identity-change"/);
  assert.ok((crm.match(/customerIdentityStampChanged\(/g) ?? []).length >= 4, "crm.ts stamp sites");
  assert.match(crm, /identity_changed_at=CASE WHEN \? THEN \? ELSE identity_changed_at END/);
  // No writer may set identity_changed_at from a raw "!==" difference any more.
  for (const [file, text] of [["crm.ts", crm], ["customer-portal-profile.ts", portal]])
    assert.doesNotMatch(text, /identity_changed_at\s*=\s*\?\s*,?[^\n]*\bchanged\s*\?\s*now/i, file);
});

/* ---------- (3) override reason ---------- */
await ok("reason: required, trimmed, min length, max length", () => {
  assert.deepEqual(normalizeOverrideReason(undefined), { error: "credit_rank_override_reason_required" });
  assert.deepEqual(normalizeOverrideReason("   "), { error: "credit_rank_override_reason_required" });
  assert.deepEqual(normalizeOverrideReason("کوتاه"), { error: "credit_rank_override_reason_too_short" });
  assert.deepEqual(normalizeOverrideReason("x".repeat(501)), { error: "credit_rank_override_reason_too_long" });
  assert.deepEqual(normalizeOverrideReason(42), { error: "invalid_credit_rank_override_reason" });
  assert.equal(CREDIT_RANK_OVERRIDE_REASON_MIN, 10);
  assert.deepEqual(normalizeOverrideReason("  تأیید مدیر فروش برای این پرونده  "), { reason: "تأیید مدیر فروش برای این پرونده" });
});
await ok("override: server rejects an enabled override without a valid reason (body + query)", () => {
  assert.deepEqual(loanCreditRankOverrideError(true, "salesperson"), { status: 400, code: "credit_rank_override_reason_required" });
  assert.deepEqual(loanCreditRankOverrideError("true", "admin", true, "short"), { status: 400, code: "credit_rank_override_reason_too_short" });
  assert.equal(loanCreditRankOverrideError(true, "salesperson", false, "مشتری سابقهٔ خوش‌حسابی دارد"), null);
  assert.equal(loanCreditRankOverrideError(false, "salesperson"), null);
  assert.equal(loanCreditRankOverrideError(undefined, "salesperson"), null);
  assert.deepEqual(loanCreditRankOverrideError(true, "registrar", false, "مشتری سابقهٔ خوش‌حسابی دارد"), { status: 403, code: "action_forbidden" });
});
await ok("override snapshot carries the reason", () => {
  const snap = loanRankOverrideSnapshot({ customer_ranks: '["A"]', guarantor_ranks: '["A","B"]' }, 7, "2026-10-24T00:00:00.000Z", "100", "دلیل آزمایشی کافی");
  assert.equal(snap.credit_rank_override.reason, "دلیل آزمایشی کافی"); assert.equal(snap.credit_rank_override.originalGuarantorRanks, '["A","B"]');
});

/* ---------- (1) guarantor grade ---------- */
const cond = { needs_guarantor: 1, guarantor_ranks: '["A","B"]' };
await ok("guarantor: unknown/missing grade keeps the condition with an assumption note", () => {
  for (const r of [null, "", "unknown", "UNKNOWN"]) {
    const v = guarantorGradeVerdict(cond, r);
    assert.equal(v.status, "unknown"); assert.equal(guarantorGradeAllows(v), true); assert.match(v.note, /^رتبهٔ ضامن باید/);
  }
  assert.equal(isUnknownGuarantorGrade(" "), true);
});
await ok("guarantor: known matching grade ok (sub-grades too); non-matching excludes", () => {
  assert.equal(guarantorGradeVerdict(cond, "B").status, "ok");
  assert.equal(guarantorGradeVerdict(cond, "b").status, "ok");
  const bad = guarantorGradeVerdict(cond, "D");
  assert.equal(bad.status, "violated"); assert.equal(guarantorGradeAllows(bad), false); assert.match(bad.note, /D/);
});
await ok("guarantor: no guarantor needed / no rank rule => not checked; plan-level needs_guarantor inherited", () => {
  assert.equal(guarantorGradeVerdict({ needs_guarantor: 0, guarantor_ranks: '["A"]' }, "E").status, "not_required");
  assert.equal(guarantorGradeVerdict({ needs_guarantor: 1, guarantor_ranks: null }, "E").status, "no_rule");
  assert.equal(guarantorGradeVerdict({ needs_guarantor: null, guarantor_ranks: '["A"]' }, "E", { needs_guarantor: 1 }).status, "violated");
});
await ok("guarantor source: newest declaration wins; «ضامن ندارد»/«نمی‌دونه» => no rank", () => {
  const c = { id: 1, has_guarantor: 1, guarantor_credit_rank: "C", created_at: "2026-10-01T00:00:00Z" };
  const f = { id: 2, guarantorAvailable: "yes", gRank: "A", created_at: "2026-10-02T00:00:00Z" };
  assert.deepEqual([pickGuarantorGrade(c, f).rank, pickGuarantorGrade(c, f).source], ["A", "call_form"]);
  assert.deepEqual([pickGuarantorGrade(c, { ...f, created_at: "2026-09-01" }).rank], ["C"]);
  assert.equal(pickGuarantorGrade({ ...c, has_guarantor: 0 }).rank, null);
  assert.equal(pickGuarantorGrade(null, { ...f, guarantorAvailable: "unknown" }).rank, null);
  assert.equal(pickGuarantorGrade(null, { ...f, guarantorAvailable: "no" }).hasGuarantor, false);
  assert.equal(pickGuarantorGrade(null, null).source, null);
});
await ok("guarantor rule wired into staff wizard, portal and wallet share", () => {
  const staff = read("routes/loan-applications.ts"), portal = read("routes/customer-portal-loans.ts"), wallets = read("routes/wallets.ts");
  for (const [file, text] of [["loan-applications", staff], ["customer-portal-loans", portal], ["wallets", wallets]]) {
    assert.match(text, /guarantorGradeVerdict/, file); assert.match(text, /customerGuarantorGrade/, file);
  }
  assert.match(staff, /loan_plan_guarantor_grade_not_matched/);
  assert.match(staff, /creditRankOverrideReason/); assert.match(wallets, /creditRankOverrideReason/);
  assert.match(staff, /logCreditRankOverride\(/); assert.match(wallets, /logCreditRankOverride\(/);
  assert.match(read("lib/loan-case-admin-controls.ts"), /logCreditRankOverride\(/);
});

/* ---------- migration / rollback (synthetic DB) ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-followups-fx-"));
try {
  await ok("migration: dry state, apply, idempotent, DDL matches the server lib", () => {
    const db = new DatabaseSync(path.join(dir, "m.db"));
    db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY)"); db.exec("INSERT INTO customers VALUES (1)");
    assert.deepEqual(tableState(db), { table: false, indexes: [], rows: 0 });
    assert.equal(migrate(db).applied, true);
    assert.deepEqual(tableState(db), { table: true, indexes: INDEXES, rows: 0 });
    assert.equal(migrate(db).applied, false);
    assert.equal(db.prepare("SELECT count(*) n FROM customers").get().n, 1);
    const lib = read("lib/credit-rank-override-log.ts").replace(/\$\{CREDIT_RANK_OVERRIDE_TABLE\}/g, TABLE);
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    for (const stmt of DDL.split(";").map(norm).filter(Boolean)) assert.ok(norm(lib).includes(stmt), `lib DDL drift: ${stmt.slice(0, 60)}`);
    db.close();
  });
  await ok("rollback: export rows, VACUUM INTO backup verified, drop only the log table", () => {
    const db = new DatabaseSync(path.join(dir, "m.db"));
    db.prepare(`INSERT INTO ${TABLE} (action,user_id,customer_id,reason,created_at) VALUES ('preview_enabled',1,1,'دلیل آزمایشی کافی','2026-10-24')`).run();
    assert.equal(planRollback(db).rows, 1);
    assert.equal(exportRows(db).length, 1);
    const b = path.join(dir, "backup.db"); backup(db, b);
    assert.throws(() => backup(db, b), /exists/);
    assert.deepEqual(applyRollback(db), { applied: true });
    assert.equal(tableState(db).table, false);
    assert.equal(db.prepare("SELECT count(*) n FROM customers").get().n, 1);
    assert.equal(applyRollback(db).applied, false);
    const bk = new DatabaseSync(b, { readOnly: true }); assert.equal(bk.prepare(`SELECT count(*) n FROM ${TABLE}`).get().n, 1); bk.close();
    db.close();
  });

  /* ---------- DB section (throwaway copy of a real-schema DB) ---------- */
  const src = process.env.GRADE_FOLLOWUPS_FIXTURE_DB;
  if (!src) { console.log(`SKIP DB section (set GRADE_FOLLOWUPS_FIXTURE_DB). ${passed} passed`); process.exit(0); }
  const dbPath = path.join(dir, "customers.db");
  fs.copyFileSync(src, dbPath);
  process.env.CRM_DATABASE_PATH = dbPath;
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "warn";
  const { queryRow, execute } = await import("../src/lib/crm-db.ts");
  const log = await import("../src/lib/credit-rank-override-log.ts");
  const { customerGuarantorGrade } = await import("../src/lib/guarantor-grade-source.ts");
  const { ensureTeamSalesSchema } = await import("../src/lib/team-sales.ts");

  const cust = Number(queryRow("SELECT id FROM customers ORDER BY id DESC LIMIT 1").id);
  await ok("log: insert, per-case list (incl. pre-case rows of the customer), admin list", () => {
    const actor = { id: 1, username: "fx", fullName: "Fixture", role: "salesperson" };
    const a = log.logCreditRankOverride({ action: "preview_enabled", actor, customerId: cust, reason: "دلیل آزمایشی کافی" });
    const b = log.logCreditRankOverride({ action: "case_created", actor, customerId: cust, applicationId: 999999, planId: 1, conditionId: 2, reason: "دلیل آزمایشی کافی" });
    assert.ok(a > 0 && b > a);
    const forCase = log.creditRankOverridesForApplication(999999, cust).map((e) => e.id);
    assert.ok(forCase.includes(a) && forCase.includes(b));
    assert.deepEqual(log.creditRankOverridesForApplication(999998, cust + 1).filter((e) => e.id === a || e.id === b), []);
    assert.equal(log.listCreditRankOverrides(10)[0].id, b);
    assert.throws(() => log.logCreditRankOverride({ action: "preview_enabled", actor, customerId: cust, reason: "" }));
  });
  await ok("guarantor source on the real schema: consultation, then newer call form", () => {
    const base = customerGuarantorGrade(cust);
    assert.ok(base && "rank" in base);
    execute("INSERT INTO consultation_forms (customer_id, has_guarantor, guarantor_credit_rank, created_at, updated_at) VALUES (?,1,'C','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')", [cust]);
    assert.deepEqual([customerGuarantorGrade(cust).rank, customerGuarantorGrade(cust).source], ["C", "consultation"]);
    if (ensureTeamSalesSchema) ensureTeamSalesSchema();
    if (queryRow("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='team_sales_qualifications'")) {
      execute(`INSERT INTO team_sales_qualifications (customer_id,actor_user_id,call_result,answers_json,matches_json,priority,outcome,reasons_json,note,created_at)
               VALUES (?,1,'answered',?,'[]',3,'x','[]','', '2099-02-01T00:00:00.000Z')`, [cust, JSON.stringify({ guarantorAvailable: "no" })]);
      const g = customerGuarantorGrade(cust);
      assert.deepEqual([g.rank, g.hasGuarantor, g.source], [null, false, "call_form"]);
    }
  });
  console.log(`${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
