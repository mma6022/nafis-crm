// Credit sub-grades (A1…E3) fixture: matching, editing rule, dictionary, migration + rollback.
// Runs on a throwaway empty DB in a temp dir. Never touches live; sends nothing.
// Usage: node scripts/run-bundled-fixture.mjs scripts/credit-subgrades-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
import {
  CREDIT_SUBGRADES, GRADE_EDIT_ERROR, acceptedGradeEdit, compactRankList, compactRankJson, expandRankList,
  gradeMatches, isLegacyGradeLetter, isSubgrade, normalizeGrade,
} from "../src/lib/credit-subgrades.ts";
import { conditionAcceptsCreditRank } from "../src/lib/credit-rank-eligibility.ts";
import { consultationRankMatches } from "../src/lib/consultation-questionnaire.ts";
import { RANKS, matchPlans, plansFromRows, validateAnswers } from "../src/lib/team-sales-rules.ts";
import { applyMigration, planMigration, expandStoredList, MARKER } from "./credit-subgrades-migrate.mjs";
import { applyRollback } from "./credit-subgrades-rollback.mjs";

let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

/* ---------- basics ---------- */
ok("15 sub-grades, A1 first, E3 last", () => { assert.equal(CREDIT_SUBGRADES.length, 15); assert.equal(CREDIT_SUBGRADES[0], "A1"); assert.equal(CREDIT_SUBGRADES[14], "E3"); });
ok("normalize: Persian digits, case, spaces", () => { assert.equal(normalizeGrade(" b۲ "), "B2"); assert.equal(normalizeGrade("c ٣"), "C3"); });
ok("sub-grade / legacy letter detection", () => { assert.ok(isSubgrade("D3")); assert.ok(!isSubgrade("D")); assert.ok(!isSubgrade("D4")); assert.ok(isLegacyGradeLetter("d")); assert.ok(!isLegacyGradeLetter("D1")); });
ok("expand keeps order, dedupes", () => assert.deepEqual(expandRankList(["B", "A2", "A", "B3"]), ["B1", "B2", "B3", "A2", "A1", "A3"]));
ok("compact collapses only full groups", () => assert.deepEqual(compactRankList(["A1", "A2", "A3", "B2"]), ["A", "B2"]));
ok("compactRankJson leaves unchanged JSON byte-identical", () => { const raw = '["A2", "B1"]'; assert.equal(compactRankJson(raw), raw); });

/* ---------- (a) legacy letters match as before ---------- */
ok("(a) letter value vs migrated letter group", () => assert.ok(gradeMatches("B", ["B1", "B2", "B3"])));
ok("(a) letter value vs a single sub-grade of that letter", () => assert.ok(gradeMatches("B", ["B2"])));
ok("(a) letter value vs other letter's sub-grades", () => assert.ok(!gradeMatches("B", ["A1", "C3"])));
ok("(a) unmigrated plan letter accepts its sub-grades", () => { assert.ok(gradeMatches("C2", ["C"])); assert.ok(!gradeMatches("D1", ["C"])); });
ok("(a) eligibility: empty plan list accepts anyone", () => assert.ok(conditionAcceptsCreditRank("E3", [])));
ok("(a) eligibility before/after migration same for every grade", () => {
  for (const v of [...CREDIT_SUBGRADES, "A", "B", "C", "D", "E", "unknown", null, ""]) for (const list of [["A"], ["A", "C"], ["B", "D", "E"], ["A", "B", "C", "D", "E"]])
    assert.equal(conditionAcceptsCreditRank(v, list), conditionAcceptsCreditRank(v, expandRankList(list)), `${v} vs ${list}`);
});
ok("(a) consultation matcher: legacy letter consultation", () => { assert.ok(consultationRankMatches("A", ["A1", "A2", "A3"])); assert.ok(!consultationRankMatches("C", ["A1", "B2"])); });
ok("(a) team-sales: legacy letter answer matches its group", () => {
  const plans = plansFromRows([{ id: 1, name: "p", active: 1, principal_amount: 100000000 }], [{ id: 1, plan_id: 1, customer_ranks: '["B1","B2","B3"]', max_principal: 100000000 }]);
  const base = { callResult: "answered", urgency: "now", amountMillion: 50, mode: "simple", checkStatus: "any", canPromissory: "yes", bouncedCheque: "no" };
  assert.equal(matchPlans({ ...base, creditRank: "B" }, plans).length, matchPlans({ ...base, creditRank: "B2" }, plans).length);
  assert.equal(matchPlans({ ...base, creditRank: "C" }, plans).length, 0);
});

/* ---------- (c) exact sub-grade matching ---------- */
ok("(c) exact: B1 only matches B1", () => { assert.ok(gradeMatches("B1", ["B1"])); assert.ok(!gradeMatches("B1", ["B2", "B3"])); });
ok("(c) exact in eligibility", () => { assert.ok(conditionAcceptsCreditRank("A2", ["A2", "B1"])); assert.ok(!conditionAcceptsCreditRank("A1", ["A2", "B1"])); });
ok("(c) exact in consultation matcher", () => assert.ok(!consultationRankMatches("D3", ["D1", "D2"])));
ok("(c) exact in team-sales", () => {
  const plans = plansFromRows([{ id: 1, name: "p", active: 1, principal_amount: 100000000 }], [{ id: 1, plan_id: 1, customer_ranks: '["B2"]', max_principal: 100000000 }]);
  const base = { callResult: "answered", urgency: "now", amountMillion: 50, mode: "simple", checkStatus: "any", canPromissory: "yes", bouncedCheque: "no" };
  assert.ok(matchPlans({ ...base, creditRank: "B2" }, plans).length > 0);
  assert.equal(matchPlans({ ...base, creditRank: "B1" }, plans).length, 0);
});
ok("(c) unknown never matches a ranked list", () => assert.ok(!gradeMatches("unknown", ["A1"])));
ok("(c) empty value never matches", () => assert.ok(!gradeMatches("", ["A1"])));

/* ---------- (d) editing rule ---------- */
ok("(d) unchanged legacy letter is kept as-is", () => assert.deepEqual(acceptedGradeEdit("B", "B"), { ok: true, value: "B" }));
ok("(d) unchanged legacy letter, other spelling, kept", () => assert.deepEqual(acceptedGradeEdit("b", "B"), { ok: true, value: "B" }));
ok("(d) changed value must be a sub-grade", () => { assert.equal(acceptedGradeEdit("C", "B").ok, false); assert.equal(acceptedGradeEdit("C", null).ok, false); });
ok("(d) sub-grade accepted and normalized", () => assert.deepEqual(acceptedGradeEdit("c۲", "B"), { ok: true, value: "C2" }));
ok("(d) clearing is allowed", () => assert.deepEqual(acceptedGradeEdit("", "B"), { ok: true, value: null }));
ok("(d) an active dictionary option (e.g. «نمی‌دونه») is accepted", () => assert.equal(acceptedGradeEdit("unknown", null, ["unknown"]).ok, true));
ok("(d) error text names A1…E3", () => assert.match(GRADE_EDIT_ERROR, /A1.*E3/));
ok("(d) team-sales RANKS = 15 sub-grades + unknown", () => assert.deepEqual(RANKS, [...CREDIT_SUBGRADES, "unknown"]));
ok("(d) team-sales: letter only as unchanged legacy", () => {
  const a = { callResult: "answered", urgency: "now", amountMillion: 50, mode: "simple", docsReady: "all", checkStatus: "any", canPromissory: "yes", bouncedCheque: "no" };
  assert.equal(validateAnswers({ ...a, creditRank: "B2" }), null);
  assert.ok(validateAnswers({ ...a, creditRank: "B" }));
  assert.equal(validateAnswers({ ...a, creditRank: "B" }, new Date(), { creditRank: "B" }), null);
  assert.ok(validateAnswers({ ...a, creditRank: "C" }, new Date(), { creditRank: "B" }));
});

/* ---------- migration script (pure) ---------- */
ok("migrate: expandStoredList", () => {
  assert.equal(expandStoredList('["A","C"]'), '["A1","A2","A3","C1","C2","C3"]');
  assert.equal(expandStoredList('["A1","B2"]'), null);
  assert.equal(expandStoredList("A,B"), null);
  assert.equal(expandStoredList(null), null);
});

/* ---------- DB: dictionary (b) + migration + rollback ---------- */
// Always: a minimal synthetic schema (pure migration/rollback). Optionally, with CREDIT_SUBGRADES_FIXTURE_DB
// pointing at a scrubbed local copy, the same checks run on a temp copy of it through the real options builder.
async function dbChecks(label, file, withCrm) {
  const raw = new DatabaseSync(file);
  const cols = (t) => raw.prepare(`PRAGMA table_info("${t}")`).all();
  const insertRow = (t, values) => {
    const req = cols(t).filter((c) => c.notnull && c.dflt_value == null && !c.pk && !(c.name in values));
    for (const c of req) values[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : "x";
    const k = Object.keys(values);
    return Number(raw.prepare(`INSERT INTO "${t}"(${k.map((x) => `"${x}"`).join(",")}) VALUES(${k.map(() => "?").join(",")})`).run(...k.map((x) => values[x])).lastInsertRowid);
  };
  const set = (sql, args) => raw.prepare(sql).run(...args);
  if (withCrm) {
    // Fixture-only plans: retire every real plan in the temp copy so counts are deterministic.
    raw.exec("UPDATE loan_plans SET active=0");
    raw.exec("DELETE FROM consult_options WHERE field_key IN ('credit_rank','guarantor_credit_rank')");
  }
  for (const field of ["credit_rank", "guarantor_credit_rank"]) {
    ["A", "B", "C", "D", "E"].forEach((l, i) => insertRow("consult_options", { field_key: field, option_value: l, label_fa: l, sort_order: i + 1, active: 1 }));
    insertRow("consult_options", { field_key: field, option_value: "unknown", label_fa: "نمی‌دونه", sort_order: 6, active: 1 });
  }
  const p1 = insertRow("loan_plans", { name: "fixture plan", active: 1, customer_ranks: '["A","B"]', guarantor_ranks: '["C"]' });
  const c1 = insertRow("loan_plan_conditions", { plan_id: p1, customer_ranks: '["A","B2"]', guarantor_ranks: '["D","E"]', sort_order: 1 });
  const c2 = insertRow("loan_plan_conditions", { plan_id: p1, customer_ranks: '["C1"]', guarantor_ranks: null, sort_order: 2 });
  const state = () => ["consult_options", "loan_plan_conditions", "loan_plans"].map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t}" ORDER BY id`).all())).join("");
  let snapshotBefore = state();
  const pending = planMigration(raw);
  let activeRanks = (field) => raw.prepare("SELECT option_value v FROM consult_options WHERE field_key=? AND active=1 ORDER BY sort_order,id").all(field).map((r) => r.v);
  if (withCrm) {
    process.env.CRM_DATABASE_PATH = file;
    const { consultationQuestionnaireOptions } = await import("../src/routes/crm.ts");
    activeRanks = (field) => consultationQuestionnaireOptions().filter((o) => o.fieldKey === field).map((o) => o.value);
    // Loading the CRM runs its additive startup columns (e.g. loan_plan_conditions.needs_military_service, NULL);
    // re-take the snapshot so "byte-identical" compares only what this migration/rollback touches.
    snapshotBefore = state();
    ok(`${label} (b) before migration: plan letters are not added as extra options`, () => {
      const vals = activeRanks("credit_rank");
      assert.ok(vals.includes("B2") && vals.includes("C1"));
      assert.equal(vals.filter((v) => v === "A").length, 1); // only the not-yet-retired dictionary row
    });
  }
  ok(`${label} migrate: dry plan counts`, () => {
    assert.ok(pending.rankLists.filter((r) => [p1, c1, c2].includes(r.id)).length >= 4);
    assert.equal(pending.options.insert.length, 30); assert.equal(pending.options.deactivate.length, 10);
  });
  const run = applyMigration(raw, "2026-10-24T00:00:00.000Z");
  ok(`${label} migrate: applied once, idempotent`, () => { assert.equal(run.applied, true); assert.equal(applyMigration(raw).applied, false); });
  ok(`${label} migrate: lists expanded in order`, () => {
    assert.equal(raw.prepare("SELECT customer_ranks v FROM loan_plan_conditions WHERE id=?").get(c1).v, '["A1","A2","A3","B2"]');
    assert.equal(raw.prepare("SELECT guarantor_ranks v FROM loan_plan_conditions WHERE id=?").get(c1).v, '["D1","D2","D3","E1","E2","E3"]');
    assert.equal(raw.prepare("SELECT customer_ranks v FROM loan_plan_conditions WHERE id=?").get(c2).v, '["C1"]');
    assert.equal(raw.prepare("SELECT customer_ranks v FROM loan_plans WHERE id=?").get(p1).v, '["A1","A2","A3","B1","B2","B3"]');
  });
  ok(`${label} (b) after migration: A–E never active, sub-grades sort 1–15`, () => {
    for (const field of ["credit_rank", "guarantor_credit_rank"]) {
      const vals = activeRanks(field);
      for (const l of ["A", "B", "C", "D", "E"]) assert.ok(!vals.includes(l), `${field} ${l}`);
      for (const g of CREDIT_SUBGRADES) assert.ok(vals.includes(g), `${field} ${g}`);
      assert.ok(vals.includes("unknown"));
      const sorts = raw.prepare("SELECT option_value v, sort_order s FROM consult_options WHERE field_key=? AND active=1 AND option_value GLOB '[A-E][1-3]' ORDER BY sort_order").all(field);
      assert.deepEqual(sorts.map((r) => r.v), CREDIT_SUBGRADES); assert.deepEqual(sorts.map((r) => Number(r.s)), CREDIT_SUBGRADES.map((_, i) => i + 1));
    }
    const old = raw.prepare("SELECT label_fa l, active a FROM consult_options WHERE field_key='credit_rank' AND option_value='B'").get();
    assert.equal(Number(old.a), 0); assert.equal(old.l, "B (قدیمی)");
  });
  if (withCrm) ok(`${label} (b) a stray letter in a plan rule does not come back as an option`, () => {
    set("UPDATE loan_plan_conditions SET customer_ranks=? WHERE id=?", ['["D"]', c2]);
    assert.ok(!activeRanks("credit_rank").includes("D")); assert.ok(!activeRanks("guarantor_credit_rank").includes("D"));
    set("UPDATE loan_plan_conditions SET customer_ranks=? WHERE id=?", ['["C1"]', c2]);
  });
  ok(`${label} rollback: conflict aborts without --force`, () => {
    set("UPDATE loan_plan_conditions SET customer_ranks=? WHERE id=?", ['["A1"]', c1]);
    const r = applyRollback(raw); assert.equal(r.applied, false); assert.equal(r.conflicts.length, 1);
    set("UPDATE loan_plan_conditions SET customer_ranks=? WHERE id=?", ['["A1","A2","A3","B2"]', c1]);
  });
  ok(`${label} rollback: restores everything byte-identical`, () => {
    const r = applyRollback(raw); assert.equal(r.applied, true);
    assert.equal(state(), snapshotBefore);
    assert.equal(raw.prepare("SELECT count(*) n FROM schema_migrations WHERE version=?").get(MARKER).n, 0);
  });
  ok(`${label} re-apply after rollback works`, () => assert.equal(applyMigration(raw).applied, true));
  raw.close();
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-subgrades-fixture-"));
try {
  const synth = path.join(dir, "synthetic.db");
  const s = new DatabaseSync(synth);
  s.exec(`CREATE TABLE consult_options(id INTEGER PRIMARY KEY AUTOINCREMENT, field_key TEXT NOT NULL, option_value TEXT NOT NULL, label_fa TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, UNIQUE(field_key, option_value));
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, customer_ranks TEXT, guarantor_ranks TEXT);
    CREATE TABLE loan_plan_conditions(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, customer_ranks TEXT, guarantor_ranks TEXT, sort_order INTEGER NOT NULL DEFAULT 0);`);
  s.close();
  await dbChecks("[synthetic]", synth, false);
  if (process.env.CREDIT_SUBGRADES_FIXTURE_DB) {
    const copy = path.join(dir, "copy.db");
    fs.copyFileSync(process.env.CREDIT_SUBGRADES_FIXTURE_DB, copy);
    process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "silent";
    // The routes module refuses to load without these; fixture-only dummies, nothing is contacted.
    process.env.SESSION_SECRET ??= "credit-subgrades-fixture-only-not-a-secret";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "fixture-dummy";
    await dbChecks("[db copy]", copy, true);
  } else console.log("SKIP options-builder section (set CREDIT_SUBGRADES_FIXTURE_DB to a scrubbed local copy).");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
process.exit(0);
