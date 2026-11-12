// v2.0 پرونده helpers: steps, completeness, chips, labels. No DB, no network, no PII.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(pathToFileURL(path.join(root, "package.json")).href);
// Resolve TS via experimental strip when run as:
// node --experimental-strip-types scripts/today-layout-v20-dossier-fixture.mjs
const m = await import("../src/features/daily-customer-inline/file-dossier.ts");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const full = {
  ...m.emptyFile(),
  city: "تهران",
  amount: "350000000",
  amount_range: "100m_300m",
  loan_purpose: "goods",
  job_status: "employee",
  documents: ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor"],
  has_military_card: "yes",
  can_refer_retiree: "no",
  has_bounced_or_overdue: "no",
  need_timing: "this_week",
  credit_rank: "B2",
  g_job_status: "employee",
  g_credit_rank: "C1",
  g_conditions: "چک ضامن",
  customer_note: "مدارک را می‌فرستم.",
  note: "تأیید شد.",
};

ok("empty is neither complete nor (wait) empty is not partial after complete check", () => {
  const e = m.emptyFile();
  assert.equal(m.fileComplete(e), false);
  assert.equal(m.filePartial(e), false);
});

ok("complete file needs exact amount and guarantor extras; note and purpose optional", () => {
  assert.equal(m.fileComplete(full), true);
  assert.equal(m.fileComplete({ ...full, loan_purpose: "", note: "" }), true);
  assert.equal(m.fileComplete({ ...full, amount: "" }), false);
  assert.equal(m.fileComplete({ ...full, g_conditions: "" }), false);
  const noG = m.setDocFlag({ ...full, documents: ["payslip"] }, "guarantor", false);
  assert.equal(m.hasGuarantor(noG), false);
  assert.equal(m.fileComplete({ ...noG, g_job_status: "", g_credit_rank: "", g_conditions: "" }), true);
});

ok("N is 9 without guarantor and 10 with", () => {
  assert.deepEqual(m.visSteps(full).length, 10);
  assert.ok(m.visSteps(full).includes("gjr"));
  const noG = m.setDocFlag({ ...full, documents: ["payslip"] }, "guarantor", false);
  assert.deepEqual(m.visSteps(noG).length, 9);
  assert.ok(!m.visSteps(noG).includes("gjr"));
  assert.equal(m.visSteps(noG)[0], "city");
  assert.equal(m.visSteps(noG).at(-1), "note");
});

ok("amount chip prefers exact toman, else site range, else simple-form band", () => {
  assert.equal(m.amountChip(full), "۳۵۰٬۰۰۰٬۰۰۰ تومان");
  assert.equal(m.amountChip({ ...m.emptyFile(), amount_range: "100m_300m" }), "سایت: ۱۰۰ تا ۳۰۰ میلیون");
  assert.equal(m.amountChip({ ...m.emptyFile(), amountBand: "100-300" }), "سایت: ۱۰۰ تا ۳۰۰ میلیون");
  assert.equal(m.amountChip({ ...m.emptyFile(), amount: "1000", amount_range: "up_to_50m" }).includes("تومان"), true);
});

ok("plan chip uses server name + term; no invented name when name is missing", () => {
  assert.equal(m.planChip({ ...m.emptyFile(), planName: "طرح نفیس", term: "12" }), "طرح نفیس، ۱۲ ماهه");
  assert.equal(m.planChip({ ...m.emptyFile(), planId: "7", term: "12" }), "۱۲ ماهه");
  assert.equal(m.planChip({ ...m.emptyFile(), planId: "7" }), "");
});

ok("contact chip and need stay separate from loan_purpose", () => {
  assert.equal(m.contactChip({ ...m.emptyFile(), contactTime: "now" }), "زمان تماس ترجیحی: همین الان");
  const rows = m.fileKvRows({ ...m.emptyFile(), need: "cash", loan_purpose: "" }, true);
  assert.ok(rows.some((r) => r.key === "need" && r.value === "پول نقد (وام)"));
  assert.ok(!rows.some((r) => r.key === "loan_purpose"));
});

ok("staff labels match site-lead-fields mismatches", () => {
  assert.equal(m.AMOUNT_RANGE_FA.not_sure, "هنوز نمی‌داند");
  assert.equal(m.MILITARY_FA.yes, "دارد");
  assert.equal(m.REFER_FA.yes, "بله، می‌تواند معرفی کند");
  assert.equal(m.BOUNCED_FA.yes, "بله، دارد");
  assert.equal(m.TIMING_FA.just_browsing, "فقط دارد بررسی می‌کند");
});

ok("compact kv is the six key lines; notes are not in the kv list", () => {
  const compact = m.fileKvRows(full, false);
  assert.deepEqual(compact.map((r) => r.key), m.KV_COMPACT);
  const all = m.fileKvRows(full, true);
  assert.ok(all.length > compact.length);
  assert.ok(!all.some((r) => /یادداشت/.test(r.label)));
});

ok("canonDocs keeps none exclusive and official order", () => {
  assert.deepEqual(m.canonDocs(["guarantor", "none", "payslip"]), ["payslip", "guarantor"]);
  assert.deepEqual(m.canonDocs(["none"]), ["none"]);
});

ok("site-credit-noinst v1.1: ask rows — «از سایت» on site values, «بپرسید» on empty ones, mockup order", () => {
  const st = { ...m.emptyFile(), job_status: "employee", credit_rank: "B", amount_range: "100m_300m" };
  const rows = m.fileAskRows(st, ["job_status", "credit_rank", "amount_range"]);
  assert.deepEqual(rows.slice(0, 10).map((r) => r.key), ["city", "loan_purpose", "job_status", "credit_rank", "has_military_card",
    "has_bounced_or_overdue", "documents", "guarantor", "can_refer_retiree", "need_timing"]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.job_status.from, "site"); assert.equal(by.job_status.value, "کارمند");
  assert.equal(by.credit_rank.from, "site"); assert.equal(by.credit_rank.value, "B");
  assert.equal(by.city.from, "ask"); assert.equal(by.documents.from, "ask"); assert.equal(by.guarantor.from, "ask");
  const expert = m.fileAskRows({ ...st, city: "تهران", credit_rank: "B2" }, ["job_status"]);
  assert.equal(expert.find((r) => r.key === "city").from, "set");
  assert.equal(expert.find((r) => r.key === "credit_rank").from, "set");
  const quick = m.fileAskRows(m.emptyFile(), []);
  assert.ok(quick.every((r) => r.from === "ask") && quick.length === 10);
  assert.equal(m.gradeFa("unknown"), "نمی‌دونه");
});

ok("turning guarantor off keeps g_* answers in state until a later final clear", () => {
  const off = m.setDocFlag(full, "guarantor", false);
  assert.equal(m.hasGuarantor(off), false);
  assert.equal(off.g_job_status, "employee");
  assert.equal(off.g_credit_rank, "C1");
  assert.equal(off.g_conditions, "چک ضامن");
  assert.ok(!m.visSteps(off).includes("gjr"));
});

console.log(`passed ${passed}`);
