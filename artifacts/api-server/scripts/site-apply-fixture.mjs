// v82 site-apply fixture: pure priority rule + strict validator. Throwaway DB only; never touches live; sends nothing.
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
fs.copyFileSync(process.env.SITE_APPLY_FIXTURE_DB, path.join(tmp, "t.db"));
process.env.CRM_DATABASE_PATH = path.join(tmp, "t.db");
const { computeSiteApplyPriority, hasCoreDocuments, validateSiteApply, siteApplySummary, SITE_APPLY_MIN_FILL_MS, DOCUMENTS } = await import("../src/lib/site-apply.ts");
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
  bad({ documents: [] }, "documents"); bad({ documents: ["none", "payslip"] }, "documents"); bad({ documents: ["payslip", "payslip"] }, "documents");
  bad({ documents: "payslip" }, "documents"); bad({ has_military_card: "maybe" }, "has_military_card"); bad({ can_refer_retiree: true }, "can_refer_retiree");
  bad({ has_bounced_or_overdue: "" }, "has_bounced_or_overdue"); bad({ need_timing: "today" }, "need_timing"); bad({ phone: "0912" }, "phone");
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
console.log(`site-apply fixture: ${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
