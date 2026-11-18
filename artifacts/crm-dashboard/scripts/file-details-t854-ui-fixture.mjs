// t854 UI helpers: retiree labels, معوق rows, خیر exclusivity, old-file render. No network, no live DB.
import assert from "node:assert/strict";
import {
  RETIRED_KIND_ERR, RETIRED_KIND_UNKNOWN, applyBouncedPick, bouncedLabel, emptyFile, emptyOverdueRow,
  fileComplete, fileKvRows, jobKindUnknown, jobLabel, overdueRowsComplete, stateFromDossier, stepLeaveError,
} from "../src/features/daily-customer-inline/file-dossier.ts";

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const completeBase = {
  ...emptyFile(),
  city: "تهران", amount: "150000000", amount_range: "100m_300m", job_status: "employee",
  documents: ["payslip"], has_military_card: "yes", can_refer_retiree: "no",
  has_bounced_or_overdue: "no", need_timing: "this_week", credit_rank: "B2",
};

ok("mandatory retiree type for the customer and the guarantor", () => {
  const retired = { ...completeBase, job_status: "retired", retired_kind: "" };
  assert.equal(fileComplete(retired), false);
  assert.equal(stepLeaveError("job", retired), RETIRED_KIND_ERR);
  assert.equal(jobLabel("retired", ""), RETIRED_KIND_UNKNOWN);
  assert.equal(jobKindUnknown("retired", ""), true);
  assert.equal(fileComplete({ ...retired, retired_kind: "tamin" }), true);
  assert.equal(jobLabel("retired", "tamin"), "بازنشسته‌ی تأمین اجتماعی");
  const g = { ...completeBase, documents: ["payslip", "guarantor"], g_job_status: "retired", g_retired_kind: "", g_credit_rank: "C1", g_conditions: "چک" };
  assert.equal(fileComplete(g), false);
  assert.equal(stepLeaveError("gjr", g), RETIRED_KIND_ERR);
  assert.equal(fileComplete({ ...g, g_retired_kind: "military" }), true);
  assert.equal(jobLabel("retired", "military"), "بازنشسته‌ی نیروهای مسلح");
});

ok("معوق rows must include amount and bank; multiple rows are kept", () => {
  const st = {
    ...completeBase,
    has_bounced_or_overdue: "yes", has_cheque_bounced: "yes", has_overdue: "yes",
    overdue_rows: [{ ...emptyOverdueRow(), amount_toman: "15000000", bank: "" }],
  };
  assert.equal(overdueRowsComplete(st.overdue_rows), false);
  assert.equal(fileComplete(st), false);
  const okRows = [
    { amount_toman: "15000000", bank: "tejarat", bank_other: "", note: "قسط مهر" },
    { amount_toman: "8000000", bank: "mellat", bank_other: "", note: "" },
  ];
  assert.equal(overdueRowsComplete(okRows), true);
  assert.equal(fileComplete({ ...st, overdue_rows: okRows }), true);
});

ok("خیر clears both; چک برگشتی and معوق can both be selected", () => {
  let st = { ...emptyFile(), overdue_rows: [{ amount_toman: "1", bank: "tejarat", bank_other: "", note: "" }] };
  st = { ...st, ...applyBouncedPick(st, "cheque") };
  st = { ...st, ...applyBouncedPick(st, "overdue") };
  assert.equal(st.has_cheque_bounced, "yes");
  assert.equal(st.has_overdue, "yes");
  assert.equal(bouncedLabel(st), "چک برگشتی، معوق");
  st = { ...st, ...applyBouncedPick(st, "no") };
  assert.equal(st.has_cheque_bounced, "no");
  assert.equal(st.has_overdue, "no");
  assert.deepEqual(st.overdue_rows, []);
  assert.equal(bouncedLabel(st), "خیر");
});

ok("old files render the unknown chip and legacy «بله، دارد»", () => {
  const st = stateFromDossier({
    city: "قم", amount: "100000000", amount_range: "50m_100m", job_status: "retired",
    documents: ["payslip"], has_military_card: "yes", can_refer_retiree: "no",
    has_bounced_or_overdue: "yes", need_timing: "this_week", credit_rank: "A2",
  });
  assert.equal(st.retired_kind, "");
  assert.equal(jobLabel(st.job_status, st.retired_kind), RETIRED_KIND_UNKNOWN);
  assert.equal(bouncedLabel(st), "بله، دارد");
  assert.equal(fileComplete({ ...completeBase, job_status: "retired", has_bounced_or_overdue: "yes" }), false);
  const rows = fileKvRows(st, true);
  const job = rows.find((r) => r.key === "job_status");
  const bounced = rows.find((r) => r.key === "has_bounced_or_overdue");
  assert.equal(job?.value, RETIRED_KIND_UNKNOWN);
  assert.equal(bounced?.value, "بله، دارد");
});

console.log(`passed ${passed}`);
