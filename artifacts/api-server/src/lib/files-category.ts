/**
 * REL-83 «پرونده‌های من» priority order (Mohammad t627u; t138u via Ahmad; PM answers t628u; Armita crm-files-priority v1.0 HANDOFF).
 * One order for cards and the full list: sort = [priority_group, sub_rank, sort_at (returned_at for returns, else last_activity_at) asc, file_id].
 *  1 returned            — sent back to the sales expert for any reason, still with the expert. One category, oldest return first (PM 2).
 *  2 signature_rejected (0) / signature_pending (1) — a contract sent to the customer and unsigned (any stage), or a *_pending_signature stage.
 *  3 collateral_stage / guarantor_stage — collateral_upload / guarantor_registration / guarantor_documents_upload («بررسی وثیقه» is not here).
 *  4 stale               — any other open file with no activity (call, note, expert follow-up, stage change — PM 1) for ≥ fc_old_days (14).
 *  5 open_other          — the rest of the open files.
 *  6 completed, 7 cancelled (status='rejected') — list only, never cards, always last; current CRM access unchanged (PM 5).
 * A file sits in the FIRST group it matches. Pure: fcCategorize/fcCompare take plain signals; fcSignals() is read-only SQL.
 */
import { queryRow, queryRows } from "./crm-db";

/** Stages whose actionPolicy (routes/loan-applications.ts) includes «salesperson». A test pins this against the route. */
export const FC_SALES_STAGES = [
  "draft", "customer_documents_upload", "guarantor_registration", "guarantor_documents_upload", "collateral_upload",
  "physical_documents_submission", "physical_documents_correction", "funder_documents_correction", "funder_amendment_pending_signature",
  "primary_contract_pending_signature", "approved_contract_pending_signature", "final_invoice_pending_signature",
] as const;
/** signature_type per pending-signature stage (HANDOFF: contract / replacement_contract / addendum / invoice). */
export const FC_SIGNATURE_STAGE_TYPE: Record<string, FcSigType> = {
  primary_contract_pending_signature: "contract", approved_contract_pending_signature: "replacement_contract",
  funder_amendment_pending_signature: "addendum", final_invoice_pending_signature: "invoice",
};
export type FcSigType = "contract" | "replacement_contract" | "addendum" | "invoice";
export const FC_SIG_TYPE_LABELS: Record<FcSigType, string> = { contract: "قرارداد", replacement_contract: "قرارداد جایگزین", addendum: "الحاقیه", invoice: "صورت‌حساب" };
export const FC_C3_STAGES: Record<string, "collateral_stage" | "guarantor_stage"> = {
  collateral_upload: "collateral_stage", guarantor_registration: "guarantor_stage", guarantor_documents_upload: "guarantor_stage",
};
export const FC_CORRECTION_STAGES: Record<string, string> = { physical_documents_correction: "physical", funder_documents_correction: "funder_documents" };
/** Recorded return / reject actions → return_reason code (PM 3: derived from the action type; no new typed field). */
export const FC_RETURN_ACTIONS: Record<string, string> = {
  "return-customer-documents": "customer_documents", "return-guarantor-documents": "guarantor_documents", "guarantor-review-reopened-for-upload": "guarantor_documents",
  "return-collateral": "collateral", "return-physical-documents": "physical", "return-funder-documents": "funder_documents",
  "funder-initial-reject": "funder_reject", "expert-reject": "expert_reject", "admin-reject": "admin_reject",
};
/** v1.0.1 return_type (HANDOFF enum). Derived server-side from the recorded return action + the per-item rejections the registrar
 *  recorded just before it; anything else → "other". No new input field (PM). */
export type FcReturnType = "missing_documents" | "guarantor_documents_missing" | "collateral_rejected" | "payslip_missing" | "id_card_unreadable" | "other";
export const FC_RETURN_TYPE_LABELS: Record<FcReturnType, string> = {
  missing_documents: "نقص مدارک", guarantor_documents_missing: "نقص مدارک ضامن", collateral_rejected: "رد وثیقه",
  payslip_missing: "نقص فیش حقوقی", id_card_unreadable: "کارت ملی ناخوانا", other: "سایر",
};
/** A rejected item recorded before the return: identity doc type, or a plan document's requirement_key + label. */
export type FcRejItem = { kind: "identity" | "customer" | "collateral" | "guarantor" | "contract"; key: string | null; label?: string | null };
const PAYSLIP_RE = /payslip|pay_slip|salary_slip|fish|فیش/i;
export function fcReturnType(code: string, items: FcRejItem[]): FcReturnType {
  if (code === "guarantor_documents") return "guarantor_documents_missing";
  if (code === "collateral") return "collateral_rejected";
  if (code !== "customer_documents") return "other";
  const docs = items.filter(i => i.kind === "identity" || i.kind === "customer");
  if (docs.length && docs.every(i => i.kind === "identity" && /^national_card/.test(i.key ?? ""))) return "id_card_unreadable";
  if (docs.length && docs.every(i => i.kind === "customer" && (PAYSLIP_RE.test(i.key ?? "") || PAYSLIP_RE.test(i.label ?? "")))) return "payslip_missing";
  return "missing_documents";
}
export const FC_STAGE_SHORT: Record<string, string> = {
  draft: "پیش‌نویس", customer_documents_upload: "بارگذاری مدارک مشتری", customer_documents_review: "بررسی مدارک با کارشناس ثبت",
  guarantor_registration: "ثبت ضامن", guarantor_documents_upload: "بارگذاری مدارک ضامن", guarantor_documents_review: "بررسی مدارک ضامن با کارشناس ثبت",
  collateral_upload: "بارگذاری وثیقه", collateral_review: "بررسی وثیقه با کارشناس ثبت", funder_initial_approval: "در صف تأمین‌کننده",
  expert_approval: "در صف تأمین‌کننده", funder_result_review: "بررسی نتیجه‌ی تأمین‌کننده", funder_amendment_review: "بررسی الحاقیه",
  physical_documents_submission: "ارسال مدارک فیزیکی", physical_documents_review: "بررسی مدارک فیزیکی", physical_documents_correction: "رفع نقص مدارک فیزیکی",
  funder_documents_correction: "اصلاح مدارک مردود", wallet_charge_pending: "در انتظار شارژ اعتبار", admin_approval: "تأیید نهایی مدیر",
  primary_contract_pending_signature: "امضای قرارداد", approved_contract_pending_signature: "امضای قرارداد جایگزین",
  funder_amendment_pending_signature: "امضای الحاقیه", final_invoice_pending_signature: "امضای صورت‌حساب",
};
export type FcPriorityCategory = "returned" | "signature_rejected" | "signature_pending" | "collateral_stage" | "guarantor_stage" | "stale" | "open_other" | "completed" | "cancelled";
export const FC_CATEGORY_MAIN: Record<FcPriorityCategory, string> = {
  returned: "برگشتی", signature_rejected: "امضا رد شد", signature_pending: "امضا نشده", collateral_stage: "مرحله وثیقه", guarantor_stage: "مرحله ضامن",
  stale: "بی‌فعالیت", open_other: "باز", completed: "تکمیل شده", cancelled: "لغو شده",
};
export const FC_GROUP_LABELS83: Record<number, string> = { 1: "برگشتی", 2: "امضا", 3: "وثیقه و ضامن", 4: "بی‌فعالیت", 5: "باز", 6: "تکمیل شده", 7: "لغو شده" };
export const FC_OLD_DAYS_KEY = "fc_old_days", FC_OLD_DAYS_DEFAULT = 14;

export type FcSignals = {
  id: number; stage: string; status: string; createdAt: string;
  /** Latest stage-history row that moved the stage or is a return action (cancel/uncancel/notes excluded). */
  lastMove: { action: string; toStage: string; at: string; reason: string | null; by?: number | null } | null;
  /** Items the registrar rejected in the round that ended with lastMove (or open rejected plan documents). */
  rejItems?: FcRejItem[];
  defects: { documents: number; collateral: number; guarantorDocuments: number; physical: number };
  /** Live (not deleted/superseded) generations of the file with status 'sent' (unsigned). rejected = the customer rejected that delivery. */
  sigDocs: Array<{ type: FcSigType; sentAt: string | null; rejected: boolean; rejectReason?: string | null }>;
  lastActivityAt: string | null;
  closedAt: string | null; cancelReason: string | null;
};
export type FcCategory = {
  priority_group: number; priority_category: FcPriorityCategory; sub_rank: number; label_main: string; label_detail: string | null; label: string;
  return_type: FcReturnType | null; return_note: string | null; returned_at: string | null; returned_by: number | null;
  signature_type: FcSigType | null; signature_status: "pending" | "rejected" | null; signature_sent_at: string | null; signature_reject_reason: string | null;
  /** Unsigned items (pending + rejected) incl. the one shown; «+N» = count − 1. */
  pending_signature_count: number; pending_item: string | null;
  last_activity_at: string | null; idle_days: number | null; sort_at: string; card: boolean; closed_at: string | null;
};
export const faDigits = (s: string | number) => String(s).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
const DAY = 86_400_000;
/** Free text written by staff (registrar comment / cancel reason): one line, digits masked (no amounts / phones on this page), ≤ max. */
export const fcBrief = (t: string | null | undefined, max = 60): string | null => {
  if (t == null) return null;
  let s = String(t);
  try { const j = JSON.parse(s); if (j && typeof j === "object" && typeof j.reason === "string") s = j.reason; } catch { /* plain text */ }
  s = s.replace(/\s+/g, " ").trim().replace(/[0-9\u06F0-\u06F9\u0660-\u0669]/g, "•").replace(/•(?:[•/,٬.\s]*•)+/g, "…");
  if (!s) return null;
  return [...s].length > max ? [...s].slice(0, max - 1).join("") + "…" : s;
};
/** Stale label (Armita v1.0): 14–27 days → «n روز», 28–62 → «n هفته» (floor), 63+ → «بیش از ۲ ماه» (pri.js stale()). */
export const fcStaleText = (days: number) => days >= 63 ? "بیش از ۲ ماه بی‌فعالیت" : days >= 28 ? `${faDigits(Math.floor(days / 7))} هفته بی‌فعالیت` : `${faDigits(days)} روز بی‌فعالیت`;
const JFMT = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", day: "numeric", month: "long" });
const jDate = (iso: string | null) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : JFMT.format(d); };
/** Expert-step stages = the 82 deck; cat-5 files are cards only there. */
export const FC_EXPERT_STEP = new Set<string>([...Object.keys(FC_SIGNATURE_STAGE_TYPE), ...Object.keys(FC_C3_STAGES),
  "customer_documents_upload", "physical_documents_submission", "physical_documents_correction", "funder_documents_correction", "draft"]);

export function fcCategorize(s: FcSignals, now: Date, oldDays = FC_OLD_DAYS_DEFAULT): FcCategory {
  const last = s.lastActivityAt ?? s.createdAt;
  const idleRaw = Math.floor((now.getTime() - Date.parse(last)) / DAY); const idle = Number.isFinite(idleRaw) ? Math.max(0, idleRaw) : null;
  const base = { return_type: null, return_note: null, returned_at: null, returned_by: null, signature_type: null, signature_status: null,
    signature_sent_at: null, signature_reject_reason: null, pending_signature_count: 0, pending_item: null, last_activity_at: last, idle_days: idle, closed_at: null, sub_rank: 0, card: false, label_detail: null } as const;
  const mk = (group: number, cat: FcPriorityCategory, o: Partial<FcCategory>): FcCategory => {
    const detail = o.label_detail ?? null; const main = FC_CATEGORY_MAIN[cat];
    return { ...base, ...o, priority_group: group, priority_category: cat, label_main: o.label_main ?? main, label_detail: detail,
      label: o.label ?? (detail ? `${o.label_main ?? main}: ${detail}` : (o.label_main ?? main)), sort_at: o.sort_at ?? last } as FcCategory;
  };
  if (s.status === "rejected") return mk(7, "cancelled", { label_detail: fcBrief(s.cancelReason, 40), closed_at: s.closedAt });
  if (s.stage === "completed") return mk(6, "completed", { label_detail: jDate(s.closedAt), closed_at: s.closedAt });
  // 1 — returned to the sales expert
  if ((FC_SALES_STAGES as readonly string[]).includes(s.stage)) {
    let code: string | null = null; let at: string | null = null; let note: string | null = null; let by: number | null = null;
    const m = s.lastMove;
    if (m && FC_RETURN_ACTIONS[m.action] && m.toStage === s.stage) { code = FC_RETURN_ACTIONS[m.action]; at = m.at; note = fcBrief(m.reason, 300); by = m.by ?? null; }
    else if (FC_CORRECTION_STAGES[s.stage]) { code = FC_CORRECTION_STAGES[s.stage]; at = m?.at ?? null; }
    else {
      // an open defect counts only on the stage where the expert fixes it (rows left on later stages are history, not a return)
      const d = s.defects, st = s.stage;
      code = st === "customer_documents_upload" && d.documents ? "customer_documents" : st === "collateral_upload" && d.collateral ? "collateral"
        : (st === "guarantor_documents_upload" || st === "guarantor_registration") && d.guarantorDocuments ? "guarantor_documents"
        : st === "physical_documents_submission" && d.physical ? "physical" : null;
      if (code) at = m?.at ?? null;
    }
    if (code) { const rt = fcReturnType(code, s.rejItems ?? []);
      return mk(1, "returned", { label_detail: FC_RETURN_TYPE_LABELS[rt], return_type: rt, return_note: note, returned_at: at ?? s.createdAt, returned_by: by,
        sort_at: at ?? s.createdAt, card: true }); }
  }
  // 2 — signature with the customer: rejected first, then the oldest; «+n» for the rest (PM 4)
  const stageType = FC_SIGNATURE_STAGE_TYPE[s.stage];
  const docs = [...s.sigDocs];
  if (stageType && !docs.some(d => d.type === stageType)) docs.push({ type: stageType, sentAt: null, rejected: false });
  if (docs.length) {
    docs.sort((a, b) => Number(b.rejected) - Number(a.rejected) || (a.sentAt ?? "\uffff").localeCompare(b.sentAt ?? "\uffff"));
    const top = docs[0]; const more = docs.length - 1;
    const detail = FC_SIG_TYPE_LABELS[top.type] + (more ? ` +${faDigits(more)}` : "") + (top.sentAt || top.rejected ? "" : " (ارسال‌نشده)");
    return mk(2, top.rejected ? "signature_rejected" : "signature_pending", { sub_rank: top.rejected ? 0 : 1, label_detail: detail,
      signature_type: top.type, signature_status: top.rejected ? "rejected" : "pending", signature_sent_at: top.sentAt,
      signature_reject_reason: top.rejected ? fcBrief(top.rejectReason ?? null, 120) : null, pending_signature_count: docs.length, card: true });
  }
  // 3 — collateral / guarantor with the expert
  const c3 = FC_C3_STAGES[s.stage];
  if (c3) return mk(3, c3, { label_detail: FC_STAGE_SHORT[s.stage], pending_item: c3 === "collateral_stage" ? "collateral" : "guarantor", card: true });
  // 4 — stale (only files not in 1–3)
  if (idle != null && idle >= oldDays) return mk(4, "stale", { label_main: fcStaleText(idle), label: fcStaleText(idle), card: true });
  // 5 — the rest (a card only while the step is the expert's)
  return mk(5, "open_other", { label_detail: FC_STAGE_SHORT[s.stage] ?? s.stage, card: FC_EXPERT_STEP.has(s.stage) });
}

/** HANDOFF sort: priority_group, sub_rank, sort_at asc, file_id asc. */
export const fcCompare = (a: { id: number; c: FcCategory }, b: { id: number; c: FcCategory }) =>
  a.c.priority_group - b.c.priority_group || a.c.sub_rank - b.c.sub_rank || a.c.sort_at.localeCompare(b.c.sort_at) || a.id - b.id;
/** Same, after group + sub_rank (used inside a group). */
export const fcInGroupCompare = (a: { id: number; c: FcCategory }, b: { id: number; c: FcCategory }) => a.c.sort_at.localeCompare(b.c.sort_at) || a.id - b.id;

/* ---------------- signals (read-only SQL) ---------------- */
const RET_LIST = Object.keys(FC_RETURN_ACTIONS);
const tableExists = (t: string) => Boolean(queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]));
export function fcSignals(ids: number[]): Map<number, FcSignals> {
  const out = new Map<number, FcSignals>();
  if (!ids.length) return out;
  const hasNotes = tableExists("loan_application_notes"), hasFc = tableExists("fc_followups"), hasRej = tableExists("contract_generation_rejected_deliveries");
  const ph = ids.map(() => "?").join(",");
  const linked = `(g.loan_application_id=a.id OR g.id IN (SELECT gd.contract_generation_id FROM loan_application_generated_documents gd WHERE gd.application_id=a.id))`;
  const rows = queryRows<any>(`SELECT a.id, a.stage, a.status, a.created_at,
      (SELECT json_object('action',h.action,'toStage',h.to_stage,'at',h.created_at,'reason',h.reason,'by',h.actor_id) FROM loan_application_stage_history h
        WHERE h.application_id=a.id AND h.action NOT IN ('cancel-case','uncancel-case','case-note-added') AND (h.from_stage IS NOT h.to_stage OR h.action IN (${RET_LIST.map(() => "?").join(",")}))
        ORDER BY h.created_at DESC, h.id DESC LIMIT 1) last_move,
      (SELECT COUNT(*) FROM loan_application_documents d WHERE d.application_id=a.id AND d.status IN ('rejected','incomplete')) d_docs,
      (SELECT COUNT(*) FROM loan_application_collateral d WHERE d.application_id=a.id AND d.status IN ('rejected','incomplete')) d_coll,
      (SELECT COUNT(*) FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=a.id AND d.status IN ('rejected','incomplete')) d_gdocs,
      (SELECT COUNT(*) FROM loan_physical_checks d WHERE d.application_id=a.id AND d.status IN ('rejected','incomplete')) d_phys,
      (SELECT json_group_array(json_object('purpose',g.generation_purpose,'at',COALESCE(g.sent_at,g.updated_at,g.created_at),
          'rr', (SELECT gd.review_reason FROM loan_application_generated_documents gd WHERE gd.contract_generation_id=g.id AND gd.status='rejected' ORDER BY gd.id DESC LIMIT 1),
          'rej', CASE WHEN EXISTS(SELECT 1 FROM loan_application_generated_documents gd WHERE gd.contract_generation_id=g.id AND gd.status='rejected')
            ${hasRej ? `OR EXISTS(SELECT 1 FROM contract_generation_rejected_deliveries r WHERE r.generation_id=g.id AND lower(r.provider_status) IN ('reject','rejected','declined','ردشد','ردشده'))` : ""} THEN 1 ELSE 0 END))
        FROM contract_generations g WHERE g.status='sent' AND g.deleted_at IS NULL AND g.superseded_at IS NULL AND ${linked}) sig_docs,
      (SELECT MAX(h.created_at) FROM loan_application_stage_history h WHERE h.application_id=a.id) act_hist,
      ${hasNotes ? "(SELECT MAX(n.created_at) FROM loan_application_notes n WHERE n.application_id=a.id)" : "NULL"} act_note,
      ${hasFc ? "(SELECT MAX(f.created_at) FROM fc_followups f WHERE f.file_id=a.id)" : "NULL"} act_fc,
      (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id IN (cc.id, a.customer_id)) act_call,
      (SELECT MAX(d.created_at) FROM loan_application_documents d WHERE d.application_id=a.id AND d.storage_path IS NOT NULL) act_doc,
      (SELECT MAX(d.created_at) FROM loan_physical_documents d WHERE d.application_id=a.id) act_phys,
      (SELECT MAX(d.created_at) FROM loan_application_collateral d WHERE d.application_id=a.id AND d.storage_path IS NOT NULL) act_coll,
      (SELECT MAX(d.created_at) FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=a.id AND d.storage_path IS NOT NULL) act_gdoc,
      (SELECT MAX(d.created_at) FROM customer_identity_documents d WHERE d.customer_id IN (cc.id, a.customer_id)) act_id,
      (SELECT MAX(CASE WHEN g.status='signed' THEN g.updated_at ELSE g.sent_at END) FROM contract_generations g WHERE g.deleted_at IS NULL AND ${linked}) act_sig,
      COALESCE((SELECT MAX(h.created_at) FROM loan_application_stage_history h WHERE h.application_id=a.id AND (h.to_stage='completed' OR h.action='cancel-case' OR (a.status='rejected' AND h.action LIKE '%reject%'))), a.updated_at) closed_at,
      (SELECT h.reason FROM loan_application_stage_history h WHERE h.application_id=a.id AND (h.action='cancel-case' OR h.action LIKE '%reject%') ORDER BY h.created_at DESC, h.id DESC LIMIT 1) cancel_reason
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    LEFT JOIN customer_merge_audit ma ON ma.source_customer_id=c.id AND ma.survivor_customer_id=c.merged_into_customer_id
    LEFT JOIN customers cc ON cc.id=CASE WHEN c.merged_into_customer_id IS NULL THEN c.id ELSE ma.survivor_customer_id END
    WHERE a.id IN (${ph})`, [...RET_LIST, ...ids]);
  const hist = queryRows<{ application_id: number; action: string; from_stage: string | null; to_stage: string; created_at: string }>(
    `SELECT application_id, action, from_stage, to_stage, created_at FROM loan_application_stage_history WHERE application_id IN (${ph}) ORDER BY created_at, id`, ids);
  const byApp = new Map<number, typeof hist>();
  for (const h of hist) { const k = Number(h.application_id); if (!byApp.has(k)) byApp.set(k, []); byApp.get(k)!.push(h); }
  const REJ = /^(identity_document|customer_document|collateral|guarantor_document|primary_contract)_rejected:(\d+)$/;
  const wantId = new Set<number>(), wantDoc = new Set<number>();
  for (const h of hist) { const m = REJ.exec(h.action); if (m?.[1] === "identity_document") wantId.add(Number(m[2])); if (m?.[1] === "customer_document") wantDoc.add(Number(m[2])); }
  const inList = (sql: string, set: Set<number>) => set.size ? queryRows<any>(sql.replace("(?)", `(${[...set].map(() => "?").join(",")})`), [...set]) : [];
  const idType = new Map<number, string>(inList("SELECT id, document_type k FROM customer_identity_documents WHERE id IN (?)", wantId).map(x => [Number(x.id), x.k]));
  const docKey = new Map<number, { k: string; l: string }>(inList("SELECT id, requirement_key k, label l FROM loan_application_documents WHERE id IN (?)", wantDoc).map(x => [Number(x.id), { k: x.k, l: x.l }]));
  /** Items rejected in the review round that ended with the return at `at`: «*_rejected:<id>» rows after the previous stage move. */
  const rejItems = (id: number, at: string | null): FcRejItem[] => {
    const hs = byApp.get(id) ?? []; const items: FcRejItem[] = [];
    if (at) for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i]; if (h.created_at > at) continue;
      const m = REJ.exec(h.action);
      if (!m) { if (h.created_at < at && (h.from_stage !== h.to_stage || RET_LIST.includes(h.action))) break; continue; }
      const n = Number(m[2]);
      items.push(m[1] === "identity_document" ? { kind: "identity", key: idType.get(n) ?? null }
        : m[1] === "customer_document" ? { kind: "customer", key: docKey.get(n)?.k ?? null, label: docKey.get(n)?.l ?? null }
        : { kind: m[1] === "collateral" ? "collateral" : m[1] === "guarantor_document" ? "guarantor" : "contract", key: null });
    }
    if (!items.length) for (const d of queryRows<any>("SELECT requirement_key k, label l FROM loan_application_documents WHERE application_id=? AND status IN ('rejected','incomplete')", [id]))
      items.push({ kind: "customer", key: d.k, label: d.l });
    return items;
  };
  const mx = (...v: (string | null)[]) => v.filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  for (const r of rows) {
    const lm = r.last_move ? JSON.parse(r.last_move) : null;
    const replacementStage = r.stage === "approved_contract_pending_signature";
    const sigDocs = (r.sig_docs ? JSON.parse(r.sig_docs) : []).map((g: any) => ({
      type: (g.purpose === "legacy_toman_replacement" || replacementStage ? "replacement_contract" : "contract") as FcSigType, sentAt: g.at ?? null,
      rejected: Boolean(Number(g.rej)), rejectReason: g.rr ?? null }));
    out.set(Number(r.id), { id: Number(r.id), stage: r.stage, status: r.status, createdAt: r.created_at,
      lastMove: lm ? { action: lm.action, toStage: lm.toStage, at: lm.at, reason: lm.reason ?? null, by: lm.by == null ? null : Number(lm.by) } : null,
      rejItems: rejItems(Number(r.id), lm?.at ?? null),
      defects: { documents: Number(r.d_docs), collateral: Number(r.d_coll), guarantorDocuments: Number(r.d_gdocs), physical: Number(r.d_phys) },
      sigDocs, lastActivityAt: mx(r.created_at, r.act_hist, r.act_note, r.act_fc, r.act_call, r.act_doc, r.act_phys, r.act_coll, r.act_gdoc, r.act_id, r.act_sig), closedAt: r.closed_at ?? null, cancelReason: r.cancel_reason ?? null });
  }
  return out;
}
export function fcOldDays(raw: (k: string) => string | null): number {
  try { const n = Number(raw(FC_OLD_DAYS_KEY)); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : FC_OLD_DAYS_DEFAULT; } catch { return FC_OLD_DAYS_DEFAULT; }
}
export function fcCategories(ids: number[], now: Date, oldDays: number): Map<number, FcCategory> {
  const sig = fcSignals(ids); const out = new Map<number, FcCategory>();
  for (const [id, s] of sig) out.set(id, fcCategorize(s, now, oldDays));
  return out;
}
