/**
 * t854 / Armita «جزئیات پرونده‌ی مشتری»: retiree type + معوق rows.
 * Additive answers_json keys only. Does not change loan_plans or plan matching.
 * job_status stays «retired»; plan match stays the generic retired code.
 */
export const RETIRED_KINDS = ["civil", "tamin", "military"] as const;
export type RetiredKind = (typeof RETIRED_KINDS)[number];

export const RETIRED_KIND_FA: Record<RetiredKind, string> = {
  civil: "بازنشسته‌ی کشوری",
  tamin: "بازنشسته‌ی تأمین اجتماعی",
  military: "بازنشسته‌ی نیروهای مسلح",
};
export const RETIRED_KIND_UNKNOWN = "بازنشسته، نوع نامشخص";
export const RETIRED_KIND_ERR = "نوع بازنشستگی را انتخاب کنید.";
export const OVERDUE_ROWS_ERR = "مبلغ و بانک معوق را برای دست‌کم یک بانک وارد کنید.";

export const IR_BANKS: readonly { id: string; label: string }[] = [
  { id: "melli", label: "ملی" },
  { id: "mellat", label: "ملت" },
  { id: "tejarat", label: "تجارت" },
  { id: "saderat", label: "صادرات" },
  { id: "sepah", label: "سپه" },
  { id: "keshavarzi", label: "کشاورزی" },
  { id: "maskan", label: "مسکن" },
  { id: "refah", label: "رفاه" },
  { id: "pasargad", label: "پاسارگاد" },
  { id: "saman", label: "سامان" },
  { id: "eghtesad_novin", label: "اقتصاد نوین" },
  { id: "parsian", label: "پارسیان" },
  { id: "sina", label: "سینا" },
  { id: "shahr", label: "شهر" },
  { id: "ayandeh", label: "آینده" },
  { id: "mehr_iran", label: "مهر ایران" },
  { id: "resalat", label: "رسالت" },
  { id: "iran_zamin", label: "ایران زمین" },
  { id: "khavarmianeh", label: "خاورمیانه" },
  { id: "gardeshgari", label: "گردشگری" },
  { id: "dey", label: "دی" },
  { id: "sarmayeh", label: "سرمایه" },
  { id: "karafarin", label: "کارآفرین" },
  { id: "postbank", label: "پست بانک" },
  { id: "sanat_madan", label: "صنعت و معدن" },
  { id: "tosee_saderat", label: "توسعه صادرات" },
  { id: "tosee_taavon", label: "توسعه تعاون" },
  { id: "other", label: "سایر" },
];

const BANK_IDS = new Set(IR_BANKS.map((b) => b.id));
const BANK_LABEL = Object.fromEntries(IR_BANKS.map((b) => [b.id, b.label]));

export type OverdueRow = {
  amount_toman: string;
  bank: string;
  bank_other: string;
  note: string;
};

export function emptyOverdueRow(): OverdueRow {
  return { amount_toman: "", bank: "", bank_other: "", note: "" };
}

const digitStr = (v: unknown) => {
  const s = String(v ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");
  return s.replace(/^0+(?=\d)/, "") || (s === "0" ? "0" : "");
};

export function isRetiredKind(v: unknown): v is RetiredKind {
  return typeof v === "string" && (RETIRED_KINDS as readonly string[]).includes(v);
}

export function jobLabel(job: string, kind: string, jobFa: Record<string, string>): string {
  if (job !== "retired") return jobFa[job] || job || "";
  if (isRetiredKind(kind)) return RETIRED_KIND_FA[kind];
  return job ? RETIRED_KIND_UNKNOWN : "";
}

export function retiredKindComplete(job: string, kind: string): boolean {
  if (job !== "retired") return true;
  return isRetiredKind(kind);
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
    const amount = digitStr(r.amount_toman ?? r.amountToman ?? r.amount);
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
  return rows.some(overdueRowComplete);
}

export function asYnFlag(v: unknown): string {
  return v === "yes" || v === "no" ? v : "";
}

/** «خیر» clears both; چک برگشتی and معوق may both be on. */
export function applyBouncedPick(
  cur: { has_cheque_bounced: string; has_overdue: string; has_bounced_or_overdue: string; overdue_rows: OverdueRow[] },
  pick: "no" | "cheque" | "overdue",
): { has_cheque_bounced: string; has_overdue: string; has_bounced_or_overdue: string; overdue_rows: OverdueRow[] } {
  if (pick === "no") {
    return { has_cheque_bounced: "no", has_overdue: "no", has_bounced_or_overdue: "no", overdue_rows: [] };
  }
  const cheque = pick === "cheque"
    ? (cur.has_cheque_bounced === "yes" ? "no" : "yes")
    : (cur.has_cheque_bounced === "yes" ? "yes" : "no");
  const overdue = pick === "overdue"
    ? (cur.has_overdue === "yes" ? "no" : "yes")
    : (cur.has_overdue === "yes" ? "yes" : "no");
  const rows = overdue === "yes" ? (cur.overdue_rows.length ? cur.overdue_rows : [emptyOverdueRow()]) : cur.overdue_rows;
  if (cheque === "yes" || overdue === "yes") {
    return { has_cheque_bounced: cheque === "yes" ? "yes" : "no", has_overdue: overdue === "yes" ? "yes" : "no", has_bounced_or_overdue: "yes", overdue_rows: rows };
  }
  // both toggled off without «خیر» → unanswered (not an explicit no)
  return { has_cheque_bounced: "", has_overdue: "", has_bounced_or_overdue: "", overdue_rows: cur.overdue_rows };
}

export function syncBouncedLegacy(
  has_cheque_bounced: string,
  has_overdue: string,
  has_bounced_or_overdue: string,
): string {
  if (has_cheque_bounced === "yes" || has_overdue === "yes") return "yes";
  if (has_cheque_bounced === "no" && has_overdue === "no") return "no";
  return has_bounced_or_overdue === "yes" || has_bounced_or_overdue === "no" ? has_bounced_or_overdue : "";
}

export function bouncedLabel(
  has_cheque_bounced: string,
  has_overdue: string,
  has_bounced_or_overdue: string,
): string {
  const parts: string[] = [];
  if (has_cheque_bounced === "yes") parts.push("چک برگشتی");
  if (has_overdue === "yes") parts.push("معوق");
  if (parts.length) return parts.join("، ");
  if (has_bounced_or_overdue === "yes") return "بله، دارد";
  if (has_bounced_or_overdue === "no" || (has_cheque_bounced === "no" && has_overdue === "no")) return "خیر";
  return "";
}

export type RetireeOverdueFields = {
  job_status: string;
  retired_kind: string;
  g_job_status: string;
  g_retired_kind: string;
  has_cheque_bounced: string;
  has_overdue: string;
  has_bounced_or_overdue: string;
  overdue_rows: OverdueRow[];
  documents: string[];
};

export function retireeOverdueError(st: RetireeOverdueFields, opts?: { requireGuarantor?: boolean }): string {
  if (!retiredKindComplete(st.job_status, st.retired_kind)) return RETIRED_KIND_ERR;
  const needG = opts?.requireGuarantor ?? (st.documents || []).includes("guarantor");
  if (needG && !retiredKindComplete(st.g_job_status, st.g_retired_kind)) return RETIRED_KIND_ERR;
  if (st.has_overdue === "yes" && !overdueRowsComplete(st.overdue_rows)) return OVERDUE_ROWS_ERR;
  return "";
}

export function canonicalOverdueRows(st: RetireeOverdueFields): OverdueRow[] {
  if (st.has_overdue !== "yes") return [];
  return st.overdue_rows.filter((r) => r.amount_toman || r.bank || r.bank_other || r.note);
}
