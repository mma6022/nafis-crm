/** Today-layout v2.0 پرونده helpers. Labels match site-lead-fields.md staff wording. */
export type FileState = {
  city: string;
  amount: string;
  amount_range: string;
  loan_purpose: string;
  job_status: string;
  retired_kind: string;
  documents: string[];
  has_military_card: string;
  can_refer_retiree: string;
  has_bounced_or_overdue: string;
  has_cheque_bounced: string;
  has_overdue: string;
  overdue_rows: OverdueRow[];
  need_timing: string;
  credit_rank: string;
  g_job_status: string;
  g_retired_kind: string;
  g_credit_rank: string;
  g_conditions: string;
  customer_note: string;
  note: string;
  need: string;
  amountBand: string;
  contactTime: string;
  planId: string;
  planName: string;
  term: string;
};

export const AMOUNT_RANGE_FA: Record<string, string> = {
  up_to_50m: "تا ۵۰ میلیون تومان", "50m_100m": "۵۰ تا ۱۰۰ میلیون تومان", "100m_300m": "۱۰۰ تا ۳۰۰ میلیون تومان",
  "300m_500m": "۳۰۰ تا ۵۰۰ میلیون تومان", over_500m: "بیشتر از ۵۰۰ میلیون تومان", not_sure: "هنوز نمی‌داند",
};
export const AMOUNT_RANGE_CHIP: Record<string, string> = {
  up_to_50m: "تا ۵۰ میلیون", "50m_100m": "۵۰ تا ۱۰۰ میلیون", "100m_300m": "۱۰۰ تا ۳۰۰ میلیون",
  "300m_500m": "۳۰۰ تا ۵۰۰ میلیون", over_500m: "بیشتر از ۵۰۰ میلیون", not_sure: "مبلغ هنوز مشخص نیست",
};
export const AMOUNT_RANGE_OPTS = Object.entries(AMOUNT_RANGE_FA);
export const PURPOSE_FA: Record<string, string> = {
  goods: "خرید کالا", wedding: "جهیزیه و ازدواج", medical: "درمان", home: "خانه و تعمیرات", business: "کسب‌وکار", other: "کار دیگر",
};
export const PURPOSE_OPTS = Object.entries(PURPOSE_FA);
export const JOB_FA: Record<string, string> = {
  employee: "کارمند", retired: "بازنشسته", self_employed: "آزاد", no_fixed_income: "بدون درآمد ثابت",
};
export const JOB_OPTS = Object.entries(JOB_FA);
export const RETIRED_KINDS = ["civil", "tamin", "military"] as const;
export type RetiredKind = (typeof RETIRED_KINDS)[number];
export const RETIRED_KIND_FA: Record<string, string> = {
  civil: "بازنشسته‌ی کشوری",
  tamin: "بازنشسته‌ی تأمین اجتماعی",
  military: "بازنشسته‌ی نیروهای مسلح",
};
export const RETIRED_KIND_OPTS: [string, string][] = Object.entries(RETIRED_KIND_FA);
export const RETIRED_KIND_UNKNOWN = "بازنشسته، نوع نامشخص";
export const RETIRED_KIND_ERR = "نوع بازنشستگی را انتخاب کنید.";
export const OVERDUE_ROWS_ERR = "مبلغ و بانک معوق را برای دست‌کم یک بانک وارد کنید.";
export const BOUNCED_SPLIT_OPTS: [string, string][] = [
  ["no", "خیر"],
  ["cheque", "چک برگشتی"],
  ["overdue", "معوق"],
];
export const IR_BANKS: { id: string; label: string }[] = [
  { id: "melli", label: "ملی" }, { id: "mellat", label: "ملت" }, { id: "tejarat", label: "تجارت" },
  { id: "saderat", label: "صادرات" }, { id: "sepah", label: "سپه" }, { id: "keshavarzi", label: "کشاورزی" },
  { id: "maskan", label: "مسکن" }, { id: "refah", label: "رفاه" }, { id: "pasargad", label: "پاسارگاد" },
  { id: "saman", label: "سامان" }, { id: "eghtesad_novin", label: "اقتصاد نوین" }, { id: "parsian", label: "پارسیان" },
  { id: "sina", label: "سینا" }, { id: "shahr", label: "شهر" }, { id: "ayandeh", label: "آینده" },
  { id: "mehr_iran", label: "مهر ایران" }, { id: "resalat", label: "رسالت" }, { id: "iran_zamin", label: "ایران زمین" },
  { id: "khavarmianeh", label: "خاورمیانه" }, { id: "gardeshgari", label: "گردشگری" }, { id: "dey", label: "دی" },
  { id: "sarmayeh", label: "سرمایه" }, { id: "karafarin", label: "کارآفرین" }, { id: "postbank", label: "پست بانک" },
  { id: "sanat_madan", label: "صنعت و معدن" }, { id: "tosee_saderat", label: "توسعه صادرات" },
  { id: "tosee_taavon", label: "توسعه تعاون" }, { id: "other", label: "سایر" },
];
const BANK_IDS = new Set(IR_BANKS.map((b) => b.id));
const BANK_LABEL: Record<string, string> = Object.fromEntries(IR_BANKS.map((b) => [b.id, b.label]));
export type OverdueRow = { amount_toman: string; bank: string; bank_other: string; note: string };
export function emptyOverdueRow(): OverdueRow { return { amount_toman: "", bank: "", bank_other: "", note: "" }; }
export function isRetiredKind(v: unknown): v is RetiredKind {
  return typeof v === "string" && (RETIRED_KINDS as readonly string[]).includes(v);
}
export function jobLabel(job: string, kind = ""): string {
  if (job !== "retired") return JOB_FA[job] || job || "";
  if (isRetiredKind(kind)) return RETIRED_KIND_FA[kind];
  return job ? RETIRED_KIND_UNKNOWN : "";
}
export function retiredKindComplete(job: string, kind: string): boolean {
  return job !== "retired" || isRetiredKind(kind);
}
export function jobKindUnknown(job: string, kind: string): boolean {
  return job === "retired" && !isRetiredKind(kind);
}
export function bankLabel(row: Pick<OverdueRow, "bank" | "bank_other">): string {
  if (row.bank === "other") return (row.bank_other || "").trim() || "سایر";
  return BANK_LABEL[row.bank] || row.bank || "";
}
export function parseOverdueRows(raw: unknown): OverdueRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OverdueRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const amount = toLatinDigits(String(r.amount_toman ?? r.amountToman ?? r.amount ?? "")).replace(/\D/g, "").replace(/^0+(?=\d)/, "") || "";
    const bankRaw = typeof r.bank === "string" ? r.bank.trim() : "";
    const bank = BANK_IDS.has(bankRaw) ? bankRaw : "";
    const bank_other = String(r.bank_other ?? r.bankOther ?? "").trim().slice(0, 80);
    const note = String(r.note ?? "").trim().slice(0, 240);
    if (!amount && !bank && !bank_other && !note) continue;
    out.push({ amount_toman: amount, bank, bank_other, note });
  }
  return out;
}
export function overdueRowComplete(row: OverdueRow): boolean {
  if (!row.amount_toman || !row.bank) return false;
  if (row.bank === "other" && !row.bank_other.trim()) return false;
  return true;
}
export function overdueRowsComplete(rows: OverdueRow[]): boolean {
  return (rows || []).some(overdueRowComplete);
}
export function applyBouncedPick(st: FileState, pick: "no" | "cheque" | "overdue"): Pick<FileState, "has_cheque_bounced" | "has_overdue" | "has_bounced_or_overdue" | "overdue_rows"> {
  if (pick === "no") {
    return { has_cheque_bounced: "no", has_overdue: "no", has_bounced_or_overdue: "no", overdue_rows: [] };
  }
  const cheque = pick === "cheque" ? (st.has_cheque_bounced === "yes" ? "no" : "yes") : (st.has_cheque_bounced === "yes" ? "yes" : "no");
  const overdue = pick === "overdue" ? (st.has_overdue === "yes" ? "no" : "yes") : (st.has_overdue === "yes" ? "yes" : "no");
  const rows = overdue === "yes" ? ((st.overdue_rows || []).length ? st.overdue_rows : [emptyOverdueRow()]) : (st.overdue_rows || []);
  if (cheque === "yes" || overdue === "yes") {
    return { has_cheque_bounced: cheque === "yes" ? "yes" : "no", has_overdue: overdue === "yes" ? "yes" : "no", has_bounced_or_overdue: "yes", overdue_rows: rows };
  }
  return { has_cheque_bounced: "", has_overdue: "", has_bounced_or_overdue: "", overdue_rows: st.overdue_rows || [] };
}
export function bouncedLabel(st: Pick<FileState, "has_cheque_bounced" | "has_overdue" | "has_bounced_or_overdue">): string {
  const parts: string[] = [];
  if (st.has_cheque_bounced === "yes") parts.push("چک برگشتی");
  if (st.has_overdue === "yes") parts.push("معوق");
  if (parts.length) return parts.join("، ");
  if (st.has_bounced_or_overdue === "yes") return "بله، دارد";
  if (st.has_bounced_or_overdue === "no" || (st.has_cheque_bounced === "no" && st.has_overdue === "no")) return "خیر";
  return "";
}
export function stepLeaveError(id: string, st: FileState): string {
  if (id === "job" && !retiredKindComplete(st.job_status, st.retired_kind)) return RETIRED_KIND_ERR;
  if (id === "gjr" && !retiredKindComplete(st.g_job_status, st.g_retired_kind)) return RETIRED_KIND_ERR;
  if (id === "mil" && st.has_overdue === "yes" && !overdueRowsComplete(st.overdue_rows)) return OVERDUE_ROWS_ERR;
  return "";
}
export const DOC_FA: Record<string, string> = {
  payslip: "فیش حقوقی", salary_deduction_cert: "گواهی کسر از حقوق", sayadi_cheque: "چک صیادی", guarantor: "ضامن", none: "هیچ‌کدام",
};
export const DOC_ORDER = ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor", "none"] as const;
export const DOC_OTHER: [string, string][] = [["payslip", "فیش حقوقی"], ["sayadi_cheque", "چک صیادی"]];
// t862 (Mohammad t862s2908): «خانم» next to «مشمول نیست»; plan matching treats it as exempt (never removes a plan).
export const MILITARY_FA: Record<string, string> = { yes: "دارد", no: "ندارد", not_applicable: "مشمول نیست", female: "خانم" };
export const MILITARY_OPTS = Object.entries(MILITARY_FA);
export const REFER_FA: Record<string, string> = { yes: "بله، می‌تواند معرفی کند", no: "خیر" };
export const REFER_OPTS = Object.entries(REFER_FA);
export const BOUNCED_FA: Record<string, string> = { yes: "بله، دارد", no: "خیر" };
export const BOUNCED_OPTS = Object.entries(BOUNCED_FA);
export const TIMING_FA: Record<string, string> = { this_week: "همین هفته", this_month: "این ماه", just_browsing: "فقط دارد بررسی می‌کند" };
export const TIMING_OPTS = Object.entries(TIMING_FA);
export const NEED_FA: Record<string, string> = {
  cash: "پول نقد (وام)", goods: "خرید کالا به‌صورت قسطی", help: "نمی‌داند، راهنمایی می‌خواهد",
};
export const AMOUNT_BAND_CHIP: Record<string, string> = {
  "0-100": "تا ۱۰۰ میلیون", "100-200": "۱۰۰ تا ۲۰۰ میلیون", "200-300": "۲۰۰ تا ۳۰۰ میلیون",
  "300-500": "۳۰۰ تا ۵۰۰ میلیون", "500-1000": "۵۰۰ تا ۱۰۰۰ میلیون", "1000-up": "بیش از ۱۰۰۰ میلیون",
  upto100: "تا ۱۰۰ میلیون", "100-300": "۱۰۰ تا ۳۰۰ میلیون", "500plus": "بیش از ۵۰۰ میلیون",
  unsure: "مبلغ مشخص نکرده",
};
export const TIME_FA: Record<string, string> = { morning: "صبح", evening: "عصر", any: "فرقی نمی‌کند", now: "همین الان" };
export const YN: [string, string][] = [["yes", "بله"], ["no", "خیر"]];
export const GRADES = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "D3", "E1", "E2", "E3"] as const;
export const gradeFa = (v: string) => (v === "unknown" ? "نمی‌دونه" : v || "");

const FD = "۰۱۲۳۴۵۶۷۸۹";
export const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
export function toLatinDigits(v: string): string {
  return String(v || "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
export function formatTomanFa(raw: string): string {
  const digits = toLatinDigits(String(raw)).replace(/\D/g, "");
  if (!digits) return "";
  return fd(digits.replace(/\B(?=(\d{3})+(?!\d))/g, "٬"));
}

export function emptyFile(): FileState {
  return {
    city: "", amount: "", amount_range: "", loan_purpose: "", job_status: "", retired_kind: "",
    documents: [], has_military_card: "", can_refer_retiree: "", has_bounced_or_overdue: "",
    has_cheque_bounced: "", has_overdue: "", overdue_rows: [],
    need_timing: "", credit_rank: "", g_job_status: "", g_retired_kind: "", g_credit_rank: "", g_conditions: "",
    customer_note: "", note: "",
    need: "", amountBand: "", contactTime: "", planId: "", planName: "", term: "",
  };
}

export function canonDocs(list: unknown): string[] {
  const set = new Set(Array.isArray(list) ? list.map(String) : []);
  if (set.has("none") && set.size > 1) set.delete("none");
  return DOC_ORDER.filter((k) => set.has(k));
}
export function hasDoc(st: FileState, k: string): boolean { return (st.documents || []).includes(k); }
export function hasGuarantor(st: FileState): boolean { return hasDoc(st, "guarantor"); }
export function setDocFlag(st: FileState, key: string, on: boolean): FileState {
  let d = (st.documents || []).filter((x) => x !== "none" && x !== key);
  if (on) d.push(key);
  return { ...st, documents: d.length ? canonDocs(d) : ["none"] };
}

export function fileComplete(st: FileState): boolean {
  const need = !!(st.city && st.amount && st.amount_range && st.job_status && (st.documents || []).length
    && st.has_military_card && st.can_refer_retiree && st.has_bounced_or_overdue && st.need_timing && st.credit_rank);
  if (!need) return false;
  if (hasGuarantor(st) && !(st.g_job_status && st.g_credit_rank && st.g_conditions)) return false;
  if (!retiredKindComplete(st.job_status, st.retired_kind)) return false;
  if (hasGuarantor(st) && !retiredKindComplete(st.g_job_status, st.g_retired_kind)) return false;
  if (st.has_overdue === "yes" && !overdueRowsComplete(st.overdue_rows)) return false;
  return true;
}
export function filePartial(st: FileState): boolean {
  if (fileComplete(st)) return false;
  return !!(st.city || st.amount || st.amount_range || st.loan_purpose || st.job_status || (st.documents || []).length
    || st.has_military_card || st.can_refer_retiree || st.has_bounced_or_overdue || st.need_timing || st.credit_rank
    || st.customer_note || st.need || st.amountBand || st.contactTime || st.planName || st.term || st.note
    || st.g_job_status || st.g_retired_kind || st.g_credit_rank || st.g_conditions
    || st.retired_kind || st.has_cheque_bounced || st.has_overdue || (st.overdue_rows || []).length);
}

export const WIZ_STEPS_BASE = ["city", "amt", "purpose", "job", "mil", "rank", "docs", "g"] as const;
export type WizStep = typeof WIZ_STEPS_BASE[number] | "gjr" | "note";
export function visSteps(st: FileState): WizStep[] {
  const ids: WizStep[] = [...WIZ_STEPS_BASE];
  if (hasGuarantor(st)) ids.push("gjr");
  ids.push("note");
  return ids;
}

export function amountChip(st: FileState): string {
  if (st.amount) return `${formatTomanFa(st.amount)} تومان`;
  if (st.amount_range && AMOUNT_RANGE_CHIP[st.amount_range]) return `سایت: ${AMOUNT_RANGE_CHIP[st.amount_range]}`;
  if (st.amountBand && AMOUNT_BAND_CHIP[st.amountBand]) return `سایت: ${AMOUNT_BAND_CHIP[st.amountBand]}`;
  return "";
}
export function planChip(st: FileState): string {
  const name = (st.planName || "").trim();
  const term = st.term ? `${fd(st.term)} ماهه` : "";
  if (name && term) return `${name}، ${term}`;
  return name || term;
}
export function contactChip(st: FileState): string {
  const lab = TIME_FA[st.contactTime];
  return lab ? `زمان تماس ترجیحی: ${lab}` : "";
}

function docsLine(st: FileState): string {
  const d = (st.documents || []).filter((k) => k !== "none" && k !== "guarantor" && k !== "salary_deduction_cert");
  if ((st.documents || []).includes("none") && !d.length) return "هیچ‌کدام";
  return d.map((k) => DOC_FA[k]).filter(Boolean).join("، ");
}

export type KvKey = "city" | "loan_purpose" | "need" | "job_status" | "guarantor" | "credit_rank" | "has_military_card"
  | "need_timing" | "salary_deduction" | "has_bounced_or_overdue" | "documents" | "can_refer_retiree"
  | "g_job_status" | "g_credit_rank" | "g_conditions";

export const KV_ALL: { key: KvKey; label: string; value: (st: FileState) => string }[] = [
  { key: "city", label: "شهر", value: (st) => st.city },
  { key: "loan_purpose", label: "برای", value: (st) => PURPOSE_FA[st.loan_purpose] || "" },
  { key: "need", label: "نوع نیاز", value: (st) => NEED_FA[st.need] || "" },
  { key: "job_status", label: "شغل", value: (st) => jobLabel(st.job_status, st.retired_kind) },
  { key: "guarantor", label: "ضامن", value: (st) => (st.documents || []).length ? (hasGuarantor(st) ? "ضامن دارد" : "ضامن ندارد") : "" },
  { key: "credit_rank", label: "رتبه‌ی اعتبارسنجی", value: (st) => gradeFa(st.credit_rank) },
  { key: "has_military_card", label: "پایان خدمت", value: (st) => MILITARY_FA[st.has_military_card] || "" },
  { key: "need_timing", label: "زمان نیاز", value: (st) => TIMING_FA[st.need_timing] || "" },
  { key: "salary_deduction", label: "گواهی کسر از حقوق", value: (st) => (st.documents || []).length ? (hasDoc(st, "salary_deduction_cert") ? "بله" : "خیر") : "" },
  { key: "has_bounced_or_overdue", label: "چک برگشتی / معوق", value: (st) => bouncedLabel(st) },
  { key: "documents", label: "مدارک", value: (st) => docsLine(st) },
  { key: "can_refer_retiree", label: "معرفی بازنشسته", value: (st) => REFER_FA[st.can_refer_retiree] || "" },
  { key: "g_job_status", label: "شغل ضامن", value: (st) => hasGuarantor(st) ? jobLabel(st.g_job_status, st.g_retired_kind) : "" },
  { key: "g_credit_rank", label: "رتبه‌ی اعتبارسنجی ضامن", value: (st) => hasGuarantor(st) ? gradeFa(st.g_credit_rank) : "" },
  { key: "g_conditions", label: "شرایط ضامن", value: (st) => hasGuarantor(st) ? (st.g_conditions || "") : "" },
];
export const KV_COMPACT: KvKey[] = ["city", "loan_purpose", "job_status", "guarantor", "credit_rank", "has_military_card"];

export function fileKvRows(st: FileState, all: boolean): { key: KvKey; label: string; value: string }[] {
  const keys = all ? null : new Set(KV_COMPACT);
  const showBounced = st.has_overdue === "yes" || st.has_cheque_bounced === "yes" || (st.overdue_rows || []).length > 0 || (st.has_bounced_or_overdue === "yes" && st.has_cheque_bounced !== "no");
  const rows: { key: KvKey; label: string; value: string }[] = [];
  for (const row of KV_ALL) {
    if (keys && !keys.has(row.key) && !(showBounced && row.key === "has_bounced_or_overdue")) continue;
    const v = row.value(st);
    if (v) rows.push({ key: row.key, label: row.label, value: v });
  }
  return rows;
}

/**
 * site-credit-noinst v1.1 (Armita spec §5): the file box of a lead that is not complete yet lists every first-call field;
 * a filled one carries «از سایت» when the value is the customer's own site answer, an empty one shows «بپرسید».
 * Order = the mockup's file scene. «نوع نیاز» / «گواهی کسر از حقوق» / guarantor extras appear only when they hold a value.
 */
export const ASK_ORDER: KvKey[] = ["city", "loan_purpose", "job_status", "credit_rank", "has_military_card", "has_bounced_or_overdue",
  "documents", "guarantor", "can_refer_retiree", "need_timing"];
export type AskRow = { key: KvKey; label: string; value: string; from: "site" | "ask" | "set" };
const SITE_KEY: Partial<Record<KvKey, string>> = { guarantor: "documents", salary_deduction: "documents" };
export function fileAskRows(st: FileState, siteFields: readonly string[] = []): AskRow[] {
  const site = new Set(siteFields);
  const byKey = new Map(KV_ALL.map((r) => [r.key, r] as const));
  const out: AskRow[] = [];
  for (const key of ASK_ORDER) {
    const r = byKey.get(key)!;
    const value = r.value(st);
    out.push({ key, label: r.label, value, from: !value ? "ask" : site.has(SITE_KEY[key] ?? key) ? "site" : "set" });
  }
  for (const r of KV_ALL) {
    if (ASK_ORDER.includes(r.key)) continue;
    const value = r.value(st);
    if (value) out.push({ key: r.key, label: r.label, value, from: site.has(SITE_KEY[r.key] ?? r.key) ? "site" : "set" });
  }
  return out;
}

export function stateFromDossier(raw: unknown): FileState {
  const st = emptyFile();
  if (!raw || typeof raw !== "object") return st;
  const d = raw as Record<string, unknown>;
  const take = (k: keyof FileState) => (typeof d[k] === "string" || typeof d[k] === "number" ? String(d[k]) : st[k]);
  (Object.keys(st) as (keyof FileState)[]).forEach((k) => {
    if (k === "documents") st.documents = canonDocs(d.documents);
    else if (k === "overdue_rows") st.overdue_rows = parseOverdueRows(d.overdue_rows ?? d.overdueRows);
    else (st[k] as string) = take(k) as string;
  });
  if (!st.amount && (d.amount_toman != null || d.amountToman != null)) st.amount = String(d.amount_toman ?? d.amountToman ?? "");
  if (st.job_status !== "retired") st.retired_kind = "";
  if (st.g_job_status !== "retired") st.g_retired_kind = "";
  return st;
}

export const DRAFT_KEY = (userId: number | undefined, customerId: number) => `nafis-dci-dossier-draft:${userId ?? 0}:${customerId}`;
export function readDraft(userId: number | undefined, customerId: number): FileState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(userId, customerId));
    if (!raw) return null;
    return stateFromDossier(JSON.parse(raw));
  } catch { return null; }
}
export function writeDraft(userId: number | undefined, customerId: number, st: FileState): void {
  try { localStorage.setItem(DRAFT_KEY(userId, customerId), JSON.stringify(st)); } catch { /* quota / private mode */ }
}
