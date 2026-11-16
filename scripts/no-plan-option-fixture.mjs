// crm-no-plan-option fixture: pure profile/priority rules + DB flows on a throwaway DB copy. Never touches live; sends nothing.
// Usage: NO_PLAN_OPTION_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/no-plan-option-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
import { computeLeadPriority, evaluatePlans, plansFromRows } from "../src/lib/team-sales-rules.ts";
import { profileReasons, profileReasonText, rowAllowsProfile, cleanProfile, JOB_CODES, MILITARY_STATUSES } from "../src/lib/plan-profile-match.ts";

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const now = new Date("2026-10-24T10:00:00+03:30");
const v2 = { mode: "simple", callResult: "answered", urgency: "now", amountMillion: 100, docsReady: "all", creditRank: "B2",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no" };
const fakeMatch = [{ planId: 1, planName: "x", conditionId: 1, max: 300e6, assumptions: [], amountFits: true }];

/* ---------- pure: profile reasons ---------- */
const cond = (o = {}) => ({ jobs: [], gJobs: [], needsMilitary: false, ...o });
await ok("job: known mismatch → violated with reason; allowed → met; unknown → depends", () => {
  const c = cond({ jobs: ["employee_with_insurance", "retired"] });
  const bad = profileReasons(c, { jobType: "no_doc" });
  assert.equal(bad[0].kind, "violated"); assert.match(profileReasonText(bad[0]), /مجاز نیست/);
  assert.equal(profileReasons(c, { jobType: "retired" })[0].kind, "met");
  for (const j of [null, "unknown", undefined]) assert.equal(profileReasons(c, { jobType: j })[0].kind, "unknown");
});
await ok("no job restriction (empty or all six) → no reason at all", () => {
  assert.deepEqual(profileReasons(cond(), { jobType: "unemployed" }), []);
  assert.deepEqual(profileReasons(cond({ jobs: [...JOB_CODES] }), { jobType: "unemployed" }), []);
});
await ok("military: required + no_card → «نیاز به پایان خدمت»; female exempt; unknown → «اگر پایان خدمت داشته باشد»", () => {
  const c = cond({ needsMilitary: true });
  const r = (m) => profileReasons(c, { military: m })[0];
  assert.equal(r("no_card").kind, "violated"); assert.equal(profileReasonText(r("no_card")), "نیاز به پایان خدمت");
  assert.equal(r("has_card").kind, "met"); assert.equal(r("female").kind, "met");
  assert.equal(r("unknown").kind, "unknown"); assert.equal(profileReasonText(r(null)), "اگر پایان خدمت داشته باشد");
  assert.deepEqual(profileReasons(cond(), { military: "no_card" }), [], "no requirement (the default) → nothing");
});
await ok("guarantor job only compared when there is a guarantor", () => {
  const c = cond({ gJobs: ["employee_with_insurance"] });
  assert.equal(profileReasons(c, { gJobType: "no_doc" }, "yes")[0].kind, "violated");
  assert.equal(profileReasons(c, { gJobType: "no_doc" }, "unknown")[0].kind, "unknown");
  assert.deepEqual(profileReasons(c, { gJobType: "no_doc" }, "no"), []);
});
await ok("cleanProfile drops junk values", () => {
  assert.deepEqual(cleanProfile({ jobType: "x", gJobType: "retired", military: "maybe" }), { jobType: null, gJobType: "retired", military: null });
});
await ok("wizard/portal parity: rowAllowsProfile == (first-call evaluation is not «no») for every job × military", () => {
  const planRow = { id: 1, name: "fx", active: 1, principal_amount: 500e6 };
  for (const needs of [0, 1]) for (const jobs of [[], ["employee_with_insurance", "retired"], ["business"]]) {
    const row = { id: 11, plan_id: 1, max_principal: 500e6, customer_ranks: "[]", customer_jobs: JSON.stringify(jobs), collateral_type: "none",
      needs_guarantor: 0, guarantor_ranks: "[]", guarantor_jobs: "[]", needs_military_service: needs };
    const plans = plansFromRows([planRow], [row]);
    for (const jobType of [...JOB_CODES, "unknown", null]) for (const military of [...MILITARY_STATUSES, null]) {
      const profile = { jobType, military, gJobType: null };
      const ev = evaluatePlans({ ...v2, jobType, military }, plans)[0];
      assert.equal(rowAllowsProfile(row, profile), ev.status !== "no", `${needs} ${jobs} ${jobType} ${military}`);
    }
  }
});

await ok("Mohammad 14:59 military table: plan «بله» → no_card «نامناسب», has_card/female «مناسب», unknown/not recorded «بستگی دارد»; plan «خیر» (default) → always «مناسب»", () => {
  const planRow = { id: 1, name: "fx", active: 1, principal_amount: 500e6 };
  const rowOf = (needs) => ({ id: 11, plan_id: 1, max_principal: 500e6, customer_ranks: "[]", customer_jobs: "[]", collateral_type: "none",
    needs_guarantor: 0, guarantor_ranks: "[]", guarantor_jobs: "[]", needs_military_service: needs });
  const status = (needs, military) => evaluatePlans({ ...v2, military }, plansFromRows([planRow], [rowOf(needs)]))[0].status;
  const expected = { no_card: "no", has_card: "fit", female: "fit", unknown: "depends" };
  for (const [m, st] of Object.entries(expected)) assert.equal(status(1, m), st, `plan=بله, ${m}`);
  assert.equal(status(1, null), "depends", "plan=بله, not recorded");
  assert.equal(status(1, undefined), "depends", "plan=بله, older form without the question");
  for (const needs of [0, null, undefined]) for (const m of [...MILITARY_STATUSES, null])
    assert.equal(status(needs, m), "fit", `plan=خیر (${needs}), ${m}`);
  // wizard / portal agree: only the known «بدون پایان خدمت» rules the plan out
  assert.equal(rowAllowsProfile(rowOf(1), { military: "no_card" }), false);
  for (const m of ["has_card", "female", "unknown", null]) assert.equal(rowAllowsProfile(rowOf(1), { military: m }), true, m);
});

/* ---------- pure: priority ---------- */
await ok("noPlanFit: H7 case (now + all docs + plan) → P2, never P1, with the reason", () => {
  const plain = computeLeadPriority(v2, fakeMatch, 0, now); assert.equal(plain.priority, 1);
  const r = computeLeadPriority({ ...v2, noPlanFit: true }, fakeMatch, 0, now);
  assert.equal(r.priority, 2); assert.ok(r.reasons.some((x) => x.includes("هیچ طرحی")));
});
await ok("noPlanFit: high score without H7 → P2; low score (answered, real intent) → also P2 (crm-no-plan-p2)", () => {
  const hi = { ...v2, urgency: "month", docsReady: "partial" };
  assert.equal(computeLeadPriority(hi, fakeMatch, 0, now).priority, 1);
  assert.equal(computeLeadPriority({ ...hi, noPlanFit: true }, fakeMatch, 0, now).priority, 2);
  const lo = { ...v2, urgency: "later", docsReady: "none" };
  assert.notEqual(computeLeadPriority(lo, fakeMatch, 0, now).priority, 1);
  assert.equal(computeLeadPriority({ ...lo, noPlanFit: true }, fakeMatch, 0, now).priority, 2);
});
await ok("noPlanFit is ignored outside the first-call form (old form unchanged)", () => {
  const { formVersion, ...old } = v2;
  assert.equal(computeLeadPriority({ ...old, noPlanFit: true }, fakeMatch, 0, now).priority, 1);
});

/* ---------- DB flows on a copy ---------- */
const src = process.env.NO_PLAN_OPTION_FIXTURE_DB;
if (!src) { console.log(`SKIP DB section (set NO_PLAN_OPTION_FIXTURE_DB). ${passed} passed`); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-plan-option-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const { queryRow, queryRows, execute } = db;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi" };
  const note = "مشتری جواب داد؛ مدارک آماده است ولی شرایط هیچ طرحی را ندارد، توضیح کامل.";
  // Fixture-only: reset priority on a few of Kazemi's in-progress customers in the temp copy so the first-call form applies.
  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 14`).map((r) => Number(r.id));
  assert.ok(pool.length >= 8, "need 8 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET priority=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const { installSiteNotifications } = await import("../src/lib/site-notifications.ts");
  installSiteNotifications();
  const bells = (id) => Number(queryRow("SELECT count(*) n FROM site_notification_events WHERE customer_id=? AND resource_type='customer'", [id]).n);

  await ok("[db] military column exists and is NULL/0 on every plan condition (nothing set)", () => {
    const n = queryRow("SELECT count(*) n FROM loan_plan_conditions WHERE COALESCE(needs_military_service,0)<>0").n;
    assert.equal(Number(n), 0);
  });
  await ok("[db] exclusivity: noPlanFit + selected plans → 400, nothing written", () => {
    const id = next(); const opts = ts.planOptions(id, v2, now);
    const pick = opts.plans.find((p) => p.status !== "no");
    const before = Number(queryRow("SELECT count(*) n FROM team_sales_qualifications").n);
    assert.throws(() => ts.submitQualification(id, kazemi, { ...v2, noPlanFit: true }, note, now, pick ? [pick.planId] : [999999]), (x) => x.status === 400);
    assert.equal(Number(queryRow("SELECT count(*) n FROM team_sales_qualifications").n), before);
    pool.push(id);
  });
  await ok("[db] «چرا؟» without noPlanFit → 400; >200 chars → 400", () => {
    const id = next();
    assert.throws(() => ts.submitQualification(id, kazemi, v2, note, now, [], "دلیل"), (x) => x.status === 400);
    assert.throws(() => ts.submitQualification(id, kazemi, { ...v2, noPlanFit: true }, note, now, [], "ا".repeat(201)), (x) => x.status === 400);
    pool.push(id);
  });
  let npId;
  await ok("[db] H7 answers + noPlanFit → P2, no handoff, note + call-log line saved", () => {
    npId = next();
    const r = ts.submitQualification(npId, kazemi, { ...v2, noPlanFit: true, city: "شهر نمونه" }, note, now, [], "  سن بالا   برای طرح‌ها  ");
    assert.equal(r.result.priority, 2); assert.equal(r.handoff, null); assert.equal(r.noPlanFit, true);
    assert.equal(r.noPlanNote, "سن بالا برای طرح‌ها");
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [npId]).p), 2);
    assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [npId]).s), 6, "no closer handoff");
    const q = queryRow("SELECT no_plan_fit f, no_plan_note n, selected_plans_json s FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC LIMIT 1", [npId]);
    assert.equal(Number(q.f), 1); assert.equal(q.n, "سن بالا برای طرح‌ها"); assert.equal(q.s, "[]");
    assert.match(queryRow("SELECT expert_notes e FROM call_logs WHERE id=?", [r.callLogId]).e, /هیچ طرحی به این مشتری نمی‌خوره: سن بالا برای طرح‌ها/);
  });
  await ok("[db] the same answers without noPlanFit still give P1 (control)", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, v2, note, now);
    assert.equal(r.result.priority, 1); assert.equal(r.noPlanFit, false);
  });
  await ok("[db] lower score + noPlanFit → the usual P2/P3 (score / H4), never P1", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, { ...v2, urgency: "later", docsReady: "none", noPlanFit: true }, note, now);
    assert.ok([2, 3].includes(r.result.priority));
    const id2 = next(); const r2 = ts.submitQualification(id2, kazemi, { ...v2, urgency: "curious", noPlanFit: true }, note, now);
    assert.equal(r2.result.priority, 3);
  });
  await ok("[db] latestNoPlanFit / latestFirstCall reflect the latest answered form", () => {
    assert.ok(ts.latestNoPlanFit([npId, pool[0]]).has(npId));
    const fc = ts.latestFirstCall(npId); assert.equal(fc.noPlanFit, true); assert.equal(fc.noPlanNote, "سن بالا برای طرح‌ها");
    assert.equal(fc.answers.city, "شهر نمونه");
  });
  await ok("[db] manual «ارتقا به اولویت ۱» still works after «هیچ طرحی»", () => {
    const r = ts.promoteToPriorityOne(npId, { id: 1, role: "admin", salespersonId: null, fullName: "admin" }, "تصمیم مدیر", now);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [npId]).p), 1); assert.ok(r);
  });
  await ok("[db] city: written only when empty, never overwritten, no bell event", () => {
    const id = next(); execute("UPDATE customers SET city=NULL WHERE id=?", [id]);
    const b0 = bells(id);
    const r1 = ts.submitQualification(id, kazemi, { ...v2, urgency: "later", city: "  شهر الف " }, note, now);
    assert.equal(r1.cityWritten, true); assert.equal(queryRow("SELECT city c FROM customers WHERE id=?", [id]).c, "شهر الف");
    execute("UPDATE customers SET priority=NULL WHERE id=?", [id]);
    const r2 = ts.submitQualification(id, kazemi, { ...v2, urgency: "later", city: "شهر ب" }, note, now);
    assert.equal(r2.cityWritten, false); assert.equal(queryRow("SELECT city c FROM customers WHERE id=?", [id]).c, "شهر الف");
    // only the priority change may ring (customer row); a city-only update never does
    const b1 = bells(id); execute("UPDATE customers SET city=? WHERE id=?", ["شهر ج", id]); assert.equal(bells(id), b1);
    execute("UPDATE customers SET city=? WHERE id=?", ["شهر الف", id]); assert.ok(b1 >= b0); assert.ok(ts.citySuggestions("الف").includes("شهر الف"));
  });
  await ok("[db] latestApplicantProfile: known answers → profile; none → null", () => {
    const id = next();
    ts.submitQualification(id, kazemi, { ...v2, urgency: "later", jobType: "retired", military: "has_card", guarantorAvailable: "yes", guarantorCheque: "unknown", gRank: "unknown", gJobType: "business" }, note, now);
    assert.deepEqual(ts.latestApplicantProfile(id), { jobType: "retired", gJobType: "business", military: "has_card" });
    const id2 = next(); ts.submitQualification(id2, kazemi, { ...v2, urgency: "later" }, note, now);
    assert.equal(ts.latestApplicantProfile(id2), null);
  });
  await ok("[db] guarantor job dropped when there is no guarantor", () => {
    const id = next();
    ts.submitQualification(id, kazemi, { ...v2, urgency: "later", jobType: "retired", guarantorAvailable: "no", gJobType: "business" }, note, now);
    assert.equal(ts.latestApplicantProfile(id).gJobType, null);
  });
  await ok("[db] planOptions.noPlanDefault true only when nothing is fit/depends", () => {
    const id = pool[0];
    assert.equal(ts.planOptions(id, v2, now).noPlanDefault, false);
    const none = ts.planOptions(id, { ...v2, creditRank: "E3", checkStatus: "none", canPromissory: "no" }, now);
    assert.equal(none.noPlanDefault, !none.plans.some((p) => p.status !== "no"));
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
process.exit(0);
