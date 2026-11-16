// v82 site-apply fixture: pure priority rule + strict validator. Throwaway DB only; never touches live; sends nothing.
// site-credit-noinst v1.1: optional answers, credit_rank, 3 s quick minimum, record + file prefill on the temp copy.
// Usage: SITE_APPLY_FIXTURE_DB=/path/to/scrubbed-copy.db NODE_ENV=production node scripts/run-bundled-fixture.mjs scripts/site-apply-fixture.mjs
// (the DB is copied to a temp dir first; only needed because crm-db initialises its schema on import)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-apply-"));
if (!process.env.SITE_APPLY_FIXTURE_DB) throw new Error("SITE_APPLY_FIXTURE_DB (a scrubbed copy) is required");
if (path.resolve(process.env.SITE_APPLY_FIXTURE_DB) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret`;
fs.copyFileSync(process.env.SITE_APPLY_FIXTURE_DB, path.join(tmp, "t.db"));
process.env.CRM_DATABASE_PATH = path.join(tmp, "t.db");
const { computeSiteApplyPriority, hasCoreDocuments, validateSiteApply, siteApplySummary, recordSiteApply, siteAnswersForCustomer,
  SITE_APPLY_MIN_FILL_MS, SITE_APPLY_QUICK_MIN_FILL_MS, DOCUMENTS } = await import("../src/lib/site-apply.ts");
const { enrichFileCard, saveDossier } = await import("../src/lib/customer-dossier.ts");
const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
const { validatePublicLead } = await import("../src/lib/public-leads.ts");

let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const subsets = (arr) => arr.reduce((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
const realDocs = ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor"];

ok("core docs = (payslip OR salary_deduction_cert) AND (sayadi_cheque OR guarantor)", () => {
  for (const s of subsets(realDocs)) {
    const expect = (s.includes("payslip") || s.includes("salary_deduction_cert")) && (s.includes("sayadi_cheque") || s.includes("guarantor"));
    assert.equal(hasCoreDocuments(s), expect, JSON.stringify(s));
  }
  assert.equal(hasCoreDocuments(["none"]), false);
});

ok("exhaustive priority table (all doc sets × referral × bounced × timing × military)", () => {
  const docSets = [...subsets(realDocs).filter((s) => s.length), ["none"]];
  let n = 0;
  for (const documents of docSets) for (const can_refer_retiree of ["yes", "no"]) for (const has_bounced_or_overdue of ["yes", "no"])
    for (const need_timing of ["this_week", "this_month", "just_browsing"]) for (const has_military_card of ["yes", "no", "not_applicable"]) {
      const a = { documents, can_refer_retiree, has_bounced_or_overdue, need_timing, has_military_card };
      const core = hasCoreDocuments(documents);
      const want = can_refer_retiree === "yes" ? 1
        : core && has_bounced_or_overdue === "no" && need_timing === "this_week" ? 1
        : documents.includes("none") || need_timing === "just_browsing" ? 3 : 2;
      assert.equal(computeSiteApplyPriority(a).priority, want, JSON.stringify(a));
      n++;
    }
  assert.equal(n, 16 * 2 * 2 * 3 * 3);
});

ok("named cases", () => {
  const p = (o) => computeSiteApplyPriority({ documents: ["payslip", "sayadi_cheque"], can_refer_retiree: "no", has_bounced_or_overdue: "no", need_timing: "this_week", ...o });
  assert.deepEqual(p({}), { priority: 1, rule: "core_docs_clean_this_week" });
  assert.equal(p({ documents: ["salary_deduction_cert", "guarantor"] }).priority, 1);
  assert.equal(p({ documents: ["payslip"] }).priority, 2);
  assert.equal(p({ documents: ["sayadi_cheque", "guarantor"] }).priority, 2);
  assert.equal(p({ has_bounced_or_overdue: "yes" }).priority, 2);
  assert.equal(p({ need_timing: "this_month" }).priority, 2);
  assert.equal(p({ need_timing: "just_browsing" }).priority, 3);
  assert.equal(p({ documents: ["none"] }).priority, 3);
  assert.deepEqual(p({ documents: ["none"], need_timing: "just_browsing", has_bounced_or_overdue: "yes", can_refer_retiree: "yes" }), { priority: 1, rule: "retiree_referral" });
});

const T0 = 1_800_000_000_000;
const base = (o = {}) => ({ type: "apply", name: "سارا نمونه", phone: "09120000000", amount_range: "100m_300m", loan_purpose: null,
  job_status: "employee", documents: ["payslip"], has_military_card: "not_applicable", can_refer_retiree: "no", has_bounced_or_overdue: "no",
  need_timing: "this_month", consent: true, website: "", startedAt: T0 - 20_000, fillMs: 20_000, ...o });

ok("valid body accepted; Persian/+98 mobile normalised; docs canonical order", () => {
  const r = validateSiteApply(base({ phone: "+98 912 000 0000", documents: ["guarantor", "payslip"], loan_purpose: "home", src: "home", planId: 3, term: 12, utm_source: "ig" }), T0);
  assert.equal(r.ok, true); assert.equal(r.apply.phone, "09120000000"); assert.deepEqual(r.apply.answers.documents, ["payslip", "guarantor"]);
  assert.equal(r.apply.planId, 3); assert.equal(r.apply.term, 12); assert.equal(r.apply.src, "home");
  const fa = validateSiteApply(base({ phone: "۰۹۱۲۰۰۰۰۰۰۰" }), T0); assert.equal(fa.ok, true);
});
ok("8 s minimum fill for this form only (lead form keeps 3 s)", () => {
  assert.equal(SITE_APPLY_MIN_FILL_MS, 8000);
  const fast = validateSiteApply(base({ fillMs: 7999, startedAt: T0 - 7999 }), T0);
  assert.deepEqual([fast.ok, fast.error, fast.status], [false, "too_fast", 422]);
  assert.equal(validateSiteApply(base({ fillMs: 8000, startedAt: T0 - 8000 }), T0).ok, true);
  const lead = validatePublicLead({ name: "سارا نمونه", phone: "09120000000", amountBand: "100-300", contactTime: "any", consent: true, website: "", startedAt: T0 - 5000, fillMs: 5000 }, T0);
  assert.equal(lead.ok, true, JSON.stringify(lead));
});
ok("honeypot → spam; unknown key → invalid; missing consent → invalid", () => {
  const hp = validateSiteApply(base({ website: "x" }), T0); assert.equal(hp.ok, false); assert.equal(hp.error, "spam");
  assert.equal(validateSiteApply(base({ rate: 5 }), T0).ok, false);
  const c = validateSiteApply(base({ consent: false }), T0); assert.ok(c.fields.includes("consent"));
});
ok("enum / documents rules", () => {
  const bad = (o, f) => { const r = validateSiteApply(base(o), T0); assert.equal(r.ok, false, JSON.stringify(o)); assert.ok(r.fields.includes(f), JSON.stringify(r)); };
  bad({ amount_range: "1000" }, "amount_range"); bad({ loan_purpose: "car" }, "loan_purpose"); bad({ job_status: "x" }, "job_status");
  bad({ documents: ["none", "payslip"] }, "documents"); bad({ documents: ["payslip", "payslip"] }, "documents");
  bad({ documents: "payslip" }, "documents"); bad({ has_military_card: "maybe" }, "has_military_card"); bad({ can_refer_retiree: true }, "can_refer_retiree");
  bad({ has_bounced_or_overdue: "maybe" }, "has_bounced_or_overdue"); bad({ need_timing: "today" }, "need_timing"); bad({ phone: "0912" }, "phone");
  bad({ credit_rank: "B2" }, "credit_rank"); bad({ credit_rank: "F" }, "credit_rank");
  bad({ name: "" }, "name"); bad({ planId: -1 }, "planId");
  assert.equal(validateSiteApply(base({ loan_purpose: "" }), T0).apply.answers.loan_purpose, null);
  assert.deepEqual(DOCUMENTS, ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor", "none"]);
});
ok("staff summary: answers only — no rate/percent/offer/banned words", () => {
  const r = validateSiteApply(base({ documents: ["payslip", "sayadi_cheque"], loan_purpose: "wedding" }), T0);
  const s = siteApplySummary(r.apply.answers, "طرح نمونه", 3, 12);
  for (const w of ["سپرده", "برآورد", "تخمینی", "سود", "نرخ", "درصد", "%", "٪", "اولویت", "پیشنهاد"]) assert.ok(!s.includes(w), w);
  assert.match(s, /فیش حقوقی، چک صیادی/); assert.match(s, /جهیزیه و ازدواج/);
});
// ---- site-credit-noinst v1.1 ----
const bare = (o = {}) => ({ type: "apply", name: "سارا نمونه", phone: "09120000000", consent: true, website: "", startedAt: T0 - 3_500, fillMs: 3_500, ...o });
ok("v1.1: only name + mobile required; skipped answers → null / []", () => {
  const r = validateSiteApply(bare(), T0);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.apply.answers, { amount_range: null, loan_purpose: null, job_status: null, credit_rank: null, documents: [],
    has_military_card: null, can_refer_retiree: null, has_bounced_or_overdue: null, need_timing: null });
  const part = validateSiteApply(bare({ amount_range: "100m_300m", credit_rank: "B", fillMs: 9000, startedAt: T0 - 9000 }), T0);
  assert.equal(part.ok, true); assert.equal(part.apply.answers.credit_rank, "B"); assert.equal(part.apply.answers.job_status, null);
  for (const k of ["A", "B", "C", "D", "E", "unknown"]) assert.equal(validateSiteApply(base({ credit_rank: k }), T0).ok, true, k);
  assert.ok(validateSiteApply(bare({ name: "" }), T0).fields.includes("name"));
  assert.ok(validateSiteApply(bare({ consent: undefined }), T0).fields.includes("consent"));
});
ok("v1.1 min fill: 3 s for name + mobile only, 8 s as soon as any answer is sent", () => {
  assert.equal(SITE_APPLY_QUICK_MIN_FILL_MS, 3000);
  assert.equal(validateSiteApply(bare({ fillMs: 3000, startedAt: T0 - 3000 }), T0).ok, true);
  assert.equal(validateSiteApply(bare({ fillMs: 2999, startedAt: T0 - 2999 }), T0).error, "too_fast");
  assert.equal(validateSiteApply(bare({ credit_rank: "unknown", fillMs: 5000, startedAt: T0 - 5000 }), T0).error, "too_fast");
  assert.equal(validateSiteApply(bare({ documents: [], fillMs: 3000, startedAt: T0 - 3000 }), T0).ok, true, "empty documents is not an answer");
});
ok("v1.1 summary: skipped → «بی‌جواب»; name + mobile only → one line; rank line", () => {
  const q = siteApplySummary(validateSiteApply(bare(), T0).apply.answers);
  assert.match(q, /فقط نام و موبایل/);
  const p = siteApplySummary(validateSiteApply(bare({ job_status: "employee", credit_rank: "unknown", fillMs: 9000, startedAt: T0 - 9000 }), T0).apply.answers);
  assert.match(p, /شغل: کارمند/); assert.match(p, /رتبه‌ی اعتباری: نمی‌داند/); assert.match(p, /مبلغ: بی‌جواب/);
  for (const w of ["سپرده", "سود", "نرخ", "٪", "اولویت", "قسط"]) assert.ok(!p.includes(w), w);
});

// record + CRM file prefill on the temp copy (nothing is sent: recordSiteApply never notifies; the route does)
const MOB = "09129990" + String(Date.now() % 1000).padStart(3, "0");
const at = (min) => new Date(Date.parse("2026-11-12T08:00:00Z") + min * 60_000);
const rec = (body, min) => { const v = validateSiteApply({ ...body, phone: MOB }, T0); assert.equal(v.ok, true, JSON.stringify(v)); return recordSiteApply(v.apply, "fixture-ip", "fixture-ua", at(min)); };
let cid;
ok("record: new mobile → customer; skipped answers stored as '' in NOT NULL columns + credit_rank column", () => {
  const r = rec(base({ amount_range: "100m_300m", job_status: "employee", credit_rank: "B", documents: [], has_military_card: undefined,
    can_refer_retiree: undefined, has_bounced_or_overdue: undefined, need_timing: undefined }), 0);
  assert.equal(r.created, true); cid = r.customerId;
  const row = queryRow("SELECT amount_range, job_status, need_timing, documents_json, credit_rank FROM site_apply_answers WHERE id=?", [r.answersId]);
  assert.deepEqual({ ...row }, { amount_range: "100m_300m", job_status: "employee", need_timing: "", documents_json: "[]", credit_rank: "B" });
  const v = siteAnswersForCustomer(cid).latest;
  assert.equal(v.answers.need_timing, null); assert.equal(v.answers.credit_rank, "B");
});
ok("file: «از سایت» fields + siteLead; empty fields stay empty («بپرسید» in the UI); letter rank kept out of legacy answers", () => {
  const c = enrichFileCard({ customerId: cid, answers: null });
  assert.equal(c.siteLead, true);
  assert.deepEqual(c.siteFields.sort(), ["amount_range", "credit_rank", "job_status"]);
  assert.equal(c.dossier.credit_rank, "B"); assert.equal(c.dossier.job_status, "employee"); assert.equal(c.dossier.city, "");
  assert.equal(c.dossier.need_timing, ""); assert.equal(c.dossierComplete, false); assert.equal(c.dossierPartial, true);
  assert.ok(!(c.answers && c.answers.creditRank), "bare letter is not a legacy creditRank");
});
ok("repeat submit (same mobile): same customer + repeat row; new answers fill empty fields and update earlier site answers; skipped never clears", () => {
  const r = rec(bare({ job_status: "retired", need_timing: "this_week", fillMs: 9000, startedAt: T0 - 9000 }), 30);
  assert.equal(r.created, false); assert.equal(r.customerId, cid);
  assert.ok(queryRow("SELECT 1 AS x FROM customer_repeat_requests WHERE customer_id=?", [cid]));
  const c = enrichFileCard({ customerId: cid, answers: null });
  assert.equal(c.dossier.job_status, "retired", "newer site answer updates the older site answer");
  assert.equal(c.dossier.need_timing, "this_week");
  assert.equal(c.dossier.credit_rank, "B", "skipped in the newer submission → kept");
  assert.equal(c.dossier.amount_range, "100m_300m");
  assert.equal(queryRows("SELECT id FROM customers WHERE phone=?", [MOB]).length, 1);
});
ok("expert value wins: a later site submission never overwrites the saved file", () => {
  const actor = { id: 0, role: "admin", username: "fixture" };
  try {
    saveDossier(cid, actor, { ...enrichFileCard({ customerId: cid, answers: null }).dossier, job_status: "self_employed", credit_rank: "B2", city: "تهران" });
  } catch (e) {
    // fixture actor may lack first-call edit rights on this copy: write the expert row directly (same table/columns)
    execute("INSERT INTO customer_dossier(customer_id, credit_rank, city, answers_json, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET credit_rank=excluded.credit_rank, city=excluded.city, answers_json=excluded.answers_json",
      [cid, "B2", "تهران", JSON.stringify({ job_status: "self_employed" }), new Date().toISOString()]);
  }
  rec(bare({ job_status: "employee", credit_rank: "D", fillMs: 9000, startedAt: T0 - 9000 }), 60);
  const c = enrichFileCard({ customerId: cid, answers: null });
  assert.equal(c.dossier.credit_rank, "B2"); assert.equal(c.dossier.job_status, "self_employed"); assert.equal(c.dossier.city, "تهران");
  assert.ok(!c.siteFields.includes("credit_rank") && !c.siteFields.includes("job_status"));
});
ok("name + mobile only (quick) → customer still created, file shows only «بپرسید»", () => {
  const v = validateSiteApply({ ...bare(), phone: "09129991" + String(Date.now() % 1000).padStart(3, "0") }, T0);
  const r = recordSiteApply(v.apply, "fixture-ip", null, at(90));
  const c = enrichFileCard({ customerId: r.customerId, answers: null });
  assert.equal(c.siteLead, true); assert.deepEqual(c.siteFields, []); assert.equal(c.dossierComplete, false);
});
console.log(`site-apply fixture: ${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
