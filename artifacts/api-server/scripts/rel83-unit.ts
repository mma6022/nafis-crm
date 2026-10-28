/** REL-83 unit tests (pure): priority categories, labels, sort, callOutcome. Run: esbuild bundle → node (CRM_DATABASE_PATH = a throwaway copy). */
import { readFileSync } from "node:fs";
import { callOutcome } from "../src/lib/sales-report";
import { fcBrief, fcCategorize, fcCompare, fcStaleText, FC_SALES_STAGES, type FcSignals } from "../src/lib/files-category";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, info: unknown = "") => { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + JSON.stringify(info)}`); };
const NOW = new Date("2026-10-29T06:00:00Z");
const ago = (d: number, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000).toISOString();
let nid = 100;
const S = (o: Partial<FcSignals>): FcSignals => ({ id: nid++, stage: "customer_documents_review", status: "pending", createdAt: ago(40), lastMove: null,
  defects: { documents: 0, collateral: 0, guarantorDocuments: 0, physical: 0 }, sigDocs: [], lastActivityAt: ago(1), closedAt: null, cancelReason: null, ...o });
const C = (o: Partial<FcSignals>, oldDays = 14) => fcCategorize(S(o), NOW, oldDays);

// callOutcome (release 81 regression; 10 cases)
const co: Array<[any, any, any, string]> = [["COMPLETED", null, null, "unknown"], ["completed", null, null, "unknown"], ["COMPLETED", null, "no_answer", "no"],
  ["ANSWERED", null, "off_or_busy", "no"], ["NO_ANSWER", null, "answered", "yes"], ["ANSWERED", null, null, "yes"], ["BUSY", null, null, "no"],
  [null, "2026-10-28T10:00:00Z", null, "yes"], [null, null, "garbage", "unknown"], ["COMPLETED", null, "off_or_busy", "no"]];
for (const [a, b, c, e] of co) ok(`callOutcome ${JSON.stringify([a, b, c])} → ${e}`, callOutcome(a, b, c) === e, callOutcome(a, b, c));

// closed
let c = C({ status: "rejected", stage: "customer_documents_upload", cancelReason: "مشتری کد 4455 گفت نیازی نیست", closedAt: ago(3) });
ok("cancelled → group 7, not a card", c.priority_group === 7 && c.priority_category === "cancelled" && !c.card, c);
ok("cancel reason digits masked", !/\d|[۰-۹]/.test(c.label), c.label);
c = C({ stage: "completed", closedAt: ago(5) });
ok("completed → group 6, not a card", c.priority_group === 6 && !c.card && c.label.startsWith("تکمیل شده"), c);
c = C({ stage: "completed", status: "rejected" });
ok("cancelled wins over completed", c.priority_group === 7, c);

// group 1 returned (v1.0.1 return_type enum)
const R = (action: string, stage: string, o: Partial<FcSignals> = {}, reason: string | null = null) =>
  C({ stage, lastMove: { action, toStage: stage, at: ago(2), reason, by: 7 }, ...o });
c = R("return-customer-documents", "customer_documents_upload", { lastActivityAt: ago(30) }, "تصویر واضح نیست");
ok("return action → group 1 even if 30d idle", c.priority_group === 1 && c.priority_category === "returned" && c.card, c);
ok("no rejected items → missing_documents «برگشتی: نقص مدارک»", c.return_type === "missing_documents" && c.label === "برگشتی: نقص مدارک", c.label);
ok("return_note = registrar comment; returned_by", c.return_note === "تصویر واضح نیست" && c.returned_by === 7, c);
ok("sort_at = returned_at", c.sort_at === ago(2) && c.returned_at === ago(2), c.sort_at);
c = R("return-customer-documents", "customer_documents_upload", { rejItems: [{ kind: "identity", key: "national_card_front" }, { kind: "identity", key: "national_card_back" }] });
ok("only national-card rejections → id_card_unreadable", c.return_type === "id_card_unreadable" && c.label_detail === "کارت ملی ناخوانا", c);
c = R("return-customer-documents", "customer_documents_upload", { rejItems: [{ kind: "identity", key: "national_card_front" }, { kind: "identity", key: "birth_cert_p1" }] });
ok("card + birth cert → missing_documents", c.return_type === "missing_documents", c);
c = R("return-customer-documents", "customer_documents_upload", { rejItems: [{ kind: "customer", key: "payslip_last_month", label: "فیش حقوقی" }] });
ok("payslip requirement → payslip_missing", c.return_type === "payslip_missing" && c.label_detail === "نقص فیش حقوقی", c);
c = R("return-customer-documents", "customer_documents_upload", { rejItems: [{ kind: "customer", key: "employment_proof", label: "مدرک شغلی" }] });
ok("employment_proof → missing_documents", c.return_type === "missing_documents", c);
const rt: Array<[string, string, string]> = [["return-guarantor-documents", "guarantor_documents_upload", "guarantor_documents_missing"],
  ["guarantor-review-reopened-for-upload", "guarantor_documents_upload", "guarantor_documents_missing"], ["return-collateral", "collateral_upload", "collateral_rejected"],
  ["return-physical-documents", "physical_documents_submission", "other"], ["return-funder-documents", "funder_documents_correction", "other"],
  ["funder-initial-reject", "customer_documents_upload", "other"], ["expert-reject", "customer_documents_upload", "other"], ["admin-reject", "draft", "other"]];
for (const [a, st, e] of rt) { c = R(a, st); ok(`${a} → ${e}`, c.priority_group === 1 && c.return_type === e, c); }
ok("other → «برگشتی: سایر»", R("admin-reject", "draft").label === "برگشتی: سایر");
c = R("funder-initial-reject", "customer_documents_upload", {}, JSON.stringify({ reason: "سقف اعتبار 120000000", returnedToSales: true }));
ok("JSON reason parsed + digits masked", c.return_note === "سقف اعتبار …", c.return_note);
c = R("return-collateral", "collateral_upload", {}, null);
ok("empty comment → return_note null", c.return_note === null, c.return_note);
c = C({ stage: "customer_documents_review", lastMove: { action: "return-customer-documents", toStage: "customer_documents_upload", at: ago(3), reason: null } });
ok("re-submitted (registrar stage) → not group 1", c.priority_group !== 1, c);
c = C({ stage: "physical_documents_correction" });
ok("correction stage → group 1 «سایر»", c.priority_group === 1 && c.return_type === "other", c);
c = C({ stage: "collateral_upload", defects: { documents: 0, collateral: 1, guarantorDocuments: 0, physical: 0 } });
ok("collateral defect on collateral_upload → collateral_rejected", c.priority_group === 1 && c.return_type === "collateral_rejected", c);
c = C({ stage: "primary_contract_pending_signature", defects: { documents: 2, collateral: 1, guarantorDocuments: 0, physical: 0 } });
ok("old defect rows on a later stage → not group 1", c.priority_group === 2, c);

// group 2 signature
c = C({ stage: "physical_documents_review", sigDocs: [{ type: "contract", sentAt: ago(4), rejected: false }] });
ok("sent unsigned contract → signature_pending sub 1", c.priority_category === "signature_pending" && c.sub_rank === 1 && c.label === "امضا نشده: قرارداد" && c.pending_signature_count === 1 && c.signature_sent_at === ago(4), c);
c = C({ stage: "approved_contract_pending_signature", sigDocs: [{ type: "replacement_contract", sentAt: ago(4), rejected: true, rejectReason: "مبلغ 5000 اشتباه" }] });
ok("rejected → signature_rejected sub 0 + reject reason masked", c.priority_category === "signature_rejected" && c.sub_rank === 0 && c.label === "امضا رد شد: قرارداد جایگزین" && c.signature_reject_reason === "مبلغ … اشتباه", c);
c = C({ stage: "funder_amendment_pending_signature", sigDocs: [{ type: "contract", sentAt: ago(9), rejected: false }] });
ok("2 items: oldest shown + «+۱», count 2", c.signature_type === "contract" && c.pending_signature_count === 2 && c.label === "امضا نشده: قرارداد +۱", c.label);
c = C({ stage: "final_invoice_pending_signature", sigDocs: [{ type: "contract", sentAt: ago(9), rejected: false }, { type: "replacement_contract", sentAt: ago(2), rejected: true }] });
ok("rejected beats older pending; «+۲»", c.signature_status === "rejected" && c.signature_type === "replacement_contract" && c.label === "امضا رد شد: قرارداد جایگزین +۲", c.label);
c = C({ stage: "funder_amendment_pending_signature" });
ok("addendum stage w/o sent doc → «(ارسال‌نشده)»", c.signature_type === "addendum" && c.label === "امضا نشده: الحاقیه (ارسال‌نشده)", c.label);
ok("invoice stage → invoice", C({ stage: "final_invoice_pending_signature" }).signature_type === "invoice");
c = R("return-customer-documents", "customer_documents_upload", { sigDocs: [{ type: "contract", sentAt: ago(3), rejected: true }] });
ok("returned beats signature", c.priority_group === 1, c);

// group 3
ok("collateral_upload → collateral_stage, pending_item", C({ stage: "collateral_upload" }).pending_item === "collateral");
ok("guarantor_registration → guarantor_stage", C({ stage: "guarantor_registration" }).priority_category === "guarantor_stage");
c = C({ stage: "guarantor_documents_upload", lastActivityAt: ago(40) });
ok("guarantor stage + 40d idle stays group 3", c.priority_group === 3 && c.label === "مرحله ضامن: بارگذاری مدارک ضامن", c.label);
c = C({ stage: "collateral_review", lastActivityAt: ago(2) });
ok("collateral_review → open_other, no card", c.priority_group === 5 && !c.card, c);

// group 4 stale
ok("13d23h → not stale", C({ lastActivityAt: ago(13, 23) }).priority_group === 5);
c = C({ lastActivityAt: ago(14) });
ok("14d → stale card «۱۴ روز بی‌فعالیت»", c.priority_group === 4 && c.card && c.label === "۱۴ روز بی‌فعالیت", c);
ok("27 → «۲۷ روز»", fcStaleText(27) === "۲۷ روز بی‌فعالیت");
ok("28 → «۴ هفته»", fcStaleText(28) === "۴ هفته بی‌فعالیت");
ok("59 → «۸ هفته»", fcStaleText(59) === "۸ هفته بی‌فعالیت");
ok("62 → «۸ هفته» (design: weeks until 63)", fcStaleText(62) === "۸ هفته بی‌فعالیت");
ok("63 → «بیش از ۲ ماه»", fcStaleText(63) === "بیش از ۲ ماه بی‌فعالیت");
c = C({ stage: "funder_initial_approval", lastActivityAt: null, createdAt: ago(20) });
ok("no activity → created_at counts", c.priority_group === 4 && c.idle_days === 20, c);
ok("fc_old_days=30 respected", C({ lastActivityAt: ago(20) }, 30).priority_group === 5);

// group 5
c = C({ stage: "draft", lastActivityAt: ago(1) });
ok("draft → «باز: پیش‌نویس», card", c.priority_group === 5 && c.card && c.label === "باز: پیش‌نویس", c);
ok("waiting on others → not a card", !C({ stage: "wallet_charge_pending" }).card);

// sort
const mk = (id: number, o: Partial<FcSignals>) => ({ id, c: fcCategorize({ ...S(o), id }, NOW, 14) });
const RM = (action: string, stage: string, d: number) => ({ stage, lastMove: { action, toStage: stage, at: ago(d), reason: null } });
const xs = [mk(9, { status: "rejected" }), mk(8, { stage: "completed" }), mk(7, { stage: "wallet_charge_pending" }), mk(6, { lastActivityAt: ago(20) }),
  mk(5, { stage: "collateral_upload" }), mk(4, { stage: "primary_contract_pending_signature", sigDocs: [{ type: "contract", sentAt: ago(1), rejected: false }] }),
  mk(3, { stage: "primary_contract_pending_signature", sigDocs: [{ type: "contract", sentAt: ago(1), rejected: true }] }),
  mk(2, RM("return-physical-documents", "physical_documents_correction", 1)), mk(1, RM("return-customer-documents", "customer_documents_upload", 3))];
const order = [...xs].sort(fcCompare).map(x => x.id);
ok("groups 1→7; completed + cancelled last", JSON.stringify(order) === "[1,2,3,4,5,6,7,8,9]", order);
const g1 = [mk(11, { ...RM("return-collateral", "collateral_upload", 1), lastActivityAt: ago(50) }), mk(12, { ...RM("return-collateral", "collateral_upload", 5), lastActivityAt: ago(0) })].sort(fcCompare).map(x => x.id);
ok("group 1: oldest return first", JSON.stringify(g1) === "[12,11]", g1);
const tie = [mk(22, { stage: "wallet_charge_pending", lastActivityAt: ago(2) }), mk(21, { stage: "wallet_charge_pending", lastActivityAt: ago(2) }), mk(23, { stage: "wallet_charge_pending", lastActivityAt: ago(3) })].sort(fcCompare).map(x => x.id);
ok("in group: oldest activity, then file_id", JSON.stringify(tie) === "[23,21,22]", tie);

// brief
const long = fcBrief("الف ".repeat(40)) ?? "";
ok("fcBrief ≤60 with …", [...long].length <= 60 && long.endsWith("…"), long);
ok("fcBrief null/empty", fcBrief(null) === null && fcBrief("   ") === null);
ok("fcBrief one line", fcBrief("خط اول\nخط دوم") === "خط اول خط دوم");

// FC_SALES_STAGES pinned against actionPolicy (routes/loan-applications.ts)
const src = readFileSync((process.env.API_DIR ?? ".") + "/src/routes/loan-applications.ts", "utf8");
const i0 = src.indexOf("actionPolicy"); const pol = src.slice(i0, src.indexOf("completed:", i0));
const sales = [...pol.matchAll(/(\w+): \[([^\]]*)\]/g)].filter(m => m[2].includes('"salesperson"')).map(m => m[1]).sort();
ok("FC_SALES_STAGES == actionPolicy salesperson stages", JSON.stringify(sales) === JSON.stringify([...FC_SALES_STAGES].sort()), { sales });

console.log(`TOTAL ${pass + fail} PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
