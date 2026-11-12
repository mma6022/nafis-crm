/**
 * Today-layout v2.0 «پرونده‌ی مشتری» dossier.
 * Additive only: new table + new API fields. Does not alter existing columns,
 * contracts, loan_plans rows, team_sales_config, or notification_settings.
 *
 * Schema (list for the PostgreSQL cutover):
 *   CREATE TABLE customer_dossier (
 *     customer_id INTEGER PRIMARY KEY,
 *     city TEXT,
 *     amount_toman BIGINT,
 *     credit_rank TEXT,
 *     g_job_status TEXT,
 *     g_credit_rank TEXT,
 *     g_conditions TEXT,
 *     customer_note TEXT,
 *     answers_json TEXT,
 *     updated_at TEXT,
 *     actor_user_id INTEGER,
 *     actor_name TEXT
 *   );
 * All seven §5.2 fields are nullable. answers_json holds the rest of the wizard
 * (site keys, documents, expert note, simple-form extras).
 */
import { execute, queryRow, queryRows } from "./crm-db";
import { CREDIT_SUBGRADES, GRADE_LETTERS } from "./credit-subgrades";
import { siteAnswersForCustomer } from "./site-apply";
import { TeamSalesError, firstCallEditAccess, type Actor } from "./team-sales";

export const DOSSIER_TABLE = "customer_dossier";
export const SITE_JOB = ["employee", "retired", "self_employed", "no_fixed_income"] as const;
export const SITE_PURPOSE = ["goods", "wedding", "medical", "home", "business", "other"] as const;
export const SITE_AMOUNT_RANGE = ["up_to_50m", "50m_100m", "100m_300m", "300m_500m", "over_500m", "not_sure"] as const;
export const SITE_DOCS = ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor", "none"] as const;
export const SITE_MILITARY = ["yes", "no", "not_applicable"] as const;
export const SITE_YES_NO = ["yes", "no"] as const;
export const SITE_TIMING = ["this_week", "this_month", "just_browsing"] as const;
export const RANKS: readonly string[] = [...CREDIT_SUBGRADES, "unknown"];
/** site-credit-noinst v1.0 §4: the customer's own rank may be a bare letter from the site (A–E) until the expert refines it
 *  to A1–E3. Only the customer's credit_rank accepts letters; the guarantor rank and the legacy answers.creditRank stay subgrades. */
export const CUSTOMER_RANKS: readonly string[] = [...RANKS, ...GRADE_LETTERS];
export const LEAD_NEED = ["cash", "goods", "help"] as const;
export const LEAD_BANDS = [
  "0-100", "100-200", "200-300", "300-500", "500-1000", "1000-up",
  "upto100", "100-300", "500plus", "unsure",
] as const;
export const LEAD_TIMES = ["morning", "evening", "any", "now"] as const;

export type DossierState = {
  city: string;
  amount: string;
  amount_range: string;
  loan_purpose: string;
  job_status: string;
  documents: string[];
  has_military_card: string;
  can_refer_retiree: string;
  has_bounced_or_overdue: string;
  need_timing: string;
  credit_rank: string;
  g_job_status: string;
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

const DOC_ORDER = [...SITE_DOCS];
const oneOf = (set: readonly string[], v: unknown) => typeof v === "string" && set.includes(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const digitStr = (v: unknown) => {
  const s = String(v ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");
  return s.replace(/^0+(?=\d)/, "") || (s === "0" ? "0" : "");
};

export function emptyDossier(): DossierState {
  return {
    city: "", amount: "", amount_range: "", loan_purpose: "", job_status: "",
    documents: [], has_military_card: "", can_refer_retiree: "", has_bounced_or_overdue: "",
    need_timing: "", credit_rank: "", g_job_status: "", g_credit_rank: "", g_conditions: "",
    customer_note: "", note: "",
    need: "", amountBand: "", contactTime: "", planId: "", planName: "", term: "",
  };
}

export function canonDocs(list: unknown): string[] {
  const set = new Set(Array.isArray(list) ? list.map(String) : []);
  if (set.has("none") && set.size > 1) set.delete("none");
  return DOC_ORDER.filter((k) => set.has(k));
}

export function setDocFlag(st: DossierState, key: string, on: boolean): void {
  let d = (st.documents || []).filter((x) => x !== "none" && x !== key);
  if (on) d.push(key);
  st.documents = d.length ? canonDocs(d) : ["none"];
}

export function hasGuarantor(st: Pick<DossierState, "documents">): boolean {
  return (st.documents || []).includes("guarantor");
}

/** §6 #21: exact amount required for a complete file; guarantor extras only when guarantor is present. loan_purpose and expert note are optional. */
export function dossierComplete(st: DossierState): boolean {
  const need = !!(st.city && st.amount && st.amount_range && st.job_status && (st.documents || []).length
    && st.has_military_card && st.can_refer_retiree && st.has_bounced_or_overdue && st.need_timing && st.credit_rank);
  if (!need) return false;
  if (hasGuarantor(st) && !(st.g_job_status && st.g_credit_rank && st.g_conditions)) return false;
  return true;
}

export function dossierPartial(st: DossierState): boolean {
  if (dossierComplete(st)) return false;
  return !!(st.city || st.amount || st.amount_range || st.loan_purpose || st.job_status || (st.documents || []).length
    || st.has_military_card || st.can_refer_retiree || st.has_bounced_or_overdue || st.need_timing || st.credit_rank
    || st.customer_note || st.need || st.amountBand || st.contactTime || st.planName || st.term || st.note
    || st.g_job_status || st.g_credit_rank || st.g_conditions);
}

export function amountTomanFromLegacy(a: Record<string, unknown>): string {
  const direct = digitStr(a.amount_toman ?? a.amountToman ?? a.amount);
  if (direct && Number(direct) >= 10_000) return direct;
  const n = Number(a.amountMillion ?? "");
  if (Number.isFinite(n) && n > 0) return String(n >= 10_000 ? Math.round(n) : Math.round(n * 1e6));
  return direct;
}

let ready = false;
export function ensureDossierSchema(): void {
  if (ready) return;
  execute(`CREATE TABLE IF NOT EXISTS ${DOSSIER_TABLE} (
    customer_id INTEGER PRIMARY KEY,
    city TEXT,
    amount_toman INTEGER,
    credit_rank TEXT,
    g_job_status TEXT,
    g_credit_rank TEXT,
    g_conditions TEXT,
    customer_note TEXT,
    answers_json TEXT,
    updated_at TEXT,
    actor_user_id INTEGER,
    actor_name TEXT
  )`);
  ready = true;
}

function tableOk(sql: string, params: (string | number | null)[] = []): boolean {
  try { queryRow(sql, params); return true; } catch { return false; }
}

function relatedIds(customerId: number): number[] {
  try {
    return queryRows<{ id: number }>("SELECT id FROM customers WHERE id=? OR merged_into_customer_id=?", [customerId, customerId]).map((r) => Number(r.id));
  } catch { return [customerId]; }
}

type LeadRow = { need: string | null; amount_band: string | null; contact_time: string | null; plan_id: number | null; term: number | null; plan_name: string | null };

function latestPublicLead(customerId: number): LeadRow | null {
  const ids = relatedIds(customerId);
  if (!ids.length || !tableOk("SELECT 1 AS x FROM public_leads LIMIT 1")) return null;
  const ph = ids.map(() => "?").join(",");
  return queryRow<LeadRow>(
    `SELECT p.need, p.amount_band, p.contact_time, p.plan_id, p.term, lp.name AS plan_name
     FROM public_leads p LEFT JOIN loan_plans lp ON lp.id=p.plan_id
     WHERE p.customer_id IN (${ph}) ORDER BY p.created_at DESC, p.id DESC LIMIT 1`, ids) ?? null;
}

function latestCallback(customerId: number): LeadRow | null {
  const ids = relatedIds(customerId);
  if (!ids.length || !tableOk("SELECT 1 AS x FROM callback_requests LIMIT 1")) return null;
  const ph = ids.map(() => "?").join(",");
  return queryRow<LeadRow>(
    `SELECT c.need, NULL AS amount_band, c.contact_time, c.plan_id, NULL AS term, lp.name AS plan_name
     FROM callback_requests c LEFT JOIN loan_plans lp ON lp.id=c.plan_id
     WHERE c.customer_id IN (${ph}) ORDER BY c.created_at DESC, c.id DESC LIMIT 1`, ids) ?? null;
}

function applyPlan(st: DossierState, planId: unknown, planName: unknown, term: unknown) {
  if (!st.planId && planId != null && String(planId) !== "") st.planId = String(planId);
  if (!st.planName) st.planName = str(planName);
  if (!st.term && term != null && String(term) !== "") st.term = String(term);
}

/** Keys a site submission can fill (the «از سایت» badge in the file box). */
export const SITE_FIELD_KEYS = ["amount_range", "loan_purpose", "job_status", "credit_rank", "documents", "has_military_card",
  "can_refer_retiree", "has_bounced_or_overdue", "need_timing"] as const;

/**
 * site-credit-noinst v1.1: every submission counts, newest first, per field — a newer submission updates a field an older
 * one filled, and a step skipped in the newer one (null) never clears it. Runs first in buildDossier, so the stored
 * (expert) dossier still wins over every site value.
 */
function applySite(st: DossierState, customerId: number) {
  try {
    const all = siteAnswersForCustomer(customerId);
    for (const sub of [all.latest, ...all.previous]) {
      if (!sub) continue;
      const a = sub.answers;
      if (!st.amount_range && oneOf(SITE_AMOUNT_RANGE, a.amount_range)) st.amount_range = String(a.amount_range);
      if (!st.loan_purpose && oneOf(SITE_PURPOSE, a.loan_purpose)) st.loan_purpose = String(a.loan_purpose);
      if (!st.job_status && oneOf(SITE_JOB, a.job_status)) st.job_status = String(a.job_status);
      if (!st.credit_rank && oneOf(CUSTOMER_RANKS, a.credit_rank)) st.credit_rank = String(a.credit_rank);
      if (!(st.documents || []).length && Array.isArray(a.documents) && a.documents.length) st.documents = canonDocs(a.documents);
      if (!st.has_military_card && oneOf(SITE_MILITARY, a.has_military_card)) st.has_military_card = String(a.has_military_card);
      if (!st.can_refer_retiree && oneOf(SITE_YES_NO, a.can_refer_retiree)) st.can_refer_retiree = String(a.can_refer_retiree);
      if (!st.has_bounced_or_overdue && oneOf(SITE_YES_NO, a.has_bounced_or_overdue)) st.has_bounced_or_overdue = String(a.has_bounced_or_overdue);
      if (!st.need_timing && oneOf(SITE_TIMING, a.need_timing)) st.need_timing = String(a.need_timing);
      applyPlan(st, sub.planId, sub.planName, sub.term);
    }
  } catch { /* table may be absent on older copies */ }
}

/** Site-only view (no lead/legacy/stored layers): which file fields the customer filled on the site. */
function siteOnly(customerId: number): { st: DossierState; any: boolean } {
  const st = emptyDossier();
  let any = false;
  try { any = siteAnswersForCustomer(customerId).count > 0; } catch { any = false; }
  if (any) applySite(st, customerId);
  return { st, any };
}

function applyLead(st: DossierState, row: LeadRow | null) {
  if (!row) return;
  // site-credit-noinst v1.1: the apply wizard's public_leads row carries placeholders (need 'help', contact_time 'any',
  // amount_band 'apply:…') — the customer never answered those, so they must not show as «نوع نیاز» / «زمان تماس ترجیحی».
  if (String(row.amount_band ?? "").startsWith("apply:")) { applyPlan(st, row.plan_id, row.plan_name, row.term); return; }
  if (!st.need && oneOf(LEAD_NEED, row.need)) st.need = String(row.need);
  if (!st.amountBand && oneOf(LEAD_BANDS, row.amount_band)) st.amountBand = String(row.amount_band);
  if (!st.contactTime && oneOf(LEAD_TIMES, row.contact_time)) st.contactTime = String(row.contact_time);
  applyPlan(st, row.plan_id, row.plan_name, row.term);
}

function applyLegacyAnswers(st: DossierState, answers: Record<string, unknown> | null, city: string | null, note: string | null) {
  if (!answers && !city && !note) return;
  const a = answers ?? {};
  if (!st.city) st.city = str(a.city) || str(city);
  if (!st.amount) st.amount = amountTomanFromLegacy(a);
  if (!st.amount_range && oneOf(SITE_AMOUNT_RANGE, a.amount_range)) st.amount_range = String(a.amount_range);
  if (!st.loan_purpose && oneOf(SITE_PURPOSE, a.loan_purpose)) st.loan_purpose = String(a.loan_purpose);
  if (!st.job_status && oneOf(SITE_JOB, a.job_status)) st.job_status = String(a.job_status);
  if (!(st.documents || []).length && Array.isArray(a.documents)) st.documents = canonDocs(a.documents);
  if (!st.has_military_card && oneOf(SITE_MILITARY, a.has_military_card)) st.has_military_card = String(a.has_military_card);
  if (!st.can_refer_retiree && oneOf(SITE_YES_NO, a.can_refer_retiree)) st.can_refer_retiree = String(a.can_refer_retiree);
  if (!st.has_bounced_or_overdue && oneOf(SITE_YES_NO, a.has_bounced_or_overdue)) st.has_bounced_or_overdue = String(a.has_bounced_or_overdue);
  if (!st.need_timing && oneOf(SITE_TIMING, a.need_timing)) st.need_timing = String(a.need_timing);
  if (!st.credit_rank && oneOf(RANKS, a.credit_rank ?? a.creditRank)) st.credit_rank = String(a.credit_rank ?? a.creditRank);
  if (!st.g_job_status && oneOf(SITE_JOB, a.g_job_status ?? a.gJobStatus)) st.g_job_status = String(a.g_job_status ?? a.gJobStatus);
  if (!st.g_credit_rank && oneOf(RANKS, a.g_credit_rank ?? a.gRank)) st.g_credit_rank = String(a.g_credit_rank ?? a.gRank);
  if (!st.customer_note) st.customer_note = str(a.customer_note ?? a.customerNote);
  if (!st.need && oneOf(LEAD_NEED, a.need)) st.need = String(a.need);
  if (!st.amountBand && oneOf(LEAD_BANDS, a.amountBand ?? a.amount_band)) st.amountBand = String(a.amountBand ?? a.amount_band);
  if (!st.contactTime && oneOf(LEAD_TIMES, a.contactTime ?? a.contact_time)) st.contactTime = String(a.contactTime ?? a.contact_time);
  applyPlan(st, a.planId ?? a.plan_id, a.planName ?? a.plan_name, a.term);
  const rawNote = str(a.note) || str(note);
  const m = rawNote.match(/^(.*?)(?:\n)?شرایط ضامن:\s*(.*)$/s);
  const needTxt = m ? m[1].trim() : rawNote;
  const gcond = m ? m[2].trim() : "";
  if (!st.g_conditions) st.g_conditions = str(a.g_conditions ?? a.gConditions) || gcond;
  if (!st.note) st.note = needTxt;
  if (!(st.documents || []).length) {
    const g = a.guarantorAvailable;
    if (g === "yes") setDocFlag(st, "guarantor", true);
    else if (g === "no") st.documents = st.documents.length ? st.documents : [];
  }
}

function loadRow(customerId: number): { city: string | null; amount_toman: number | null; credit_rank: string | null;
  g_job_status: string | null; g_credit_rank: string | null; g_conditions: string | null; customer_note: string | null;
  answers_json: string | null; updated_at: string | null } | null {
  if (!ready && !tableOk(`SELECT 1 AS x FROM ${DOSSIER_TABLE} LIMIT 1`)) return null;
  return queryRow(`SELECT city, amount_toman, credit_rank, g_job_status, g_credit_rank, g_conditions, customer_note, answers_json, updated_at
    FROM ${DOSSIER_TABLE} WHERE customer_id=?`, [customerId]) ?? null;
}

function applyStored(st: DossierState, row: NonNullable<ReturnType<typeof loadRow>>) {
  let extra: Record<string, unknown> = {};
  try { extra = row.answers_json ? JSON.parse(row.answers_json) as Record<string, unknown> : {}; } catch { extra = {}; }
  // Stored dossier wins over site/legacy for every key it actually holds.
  if (row.city != null && String(row.city).trim()) st.city = String(row.city).trim();
  if (row.amount_toman != null && Number(row.amount_toman) > 0) st.amount = String(Math.round(Number(row.amount_toman)));
  if (oneOf(CUSTOMER_RANKS, row.credit_rank)) st.credit_rank = String(row.credit_rank);
  if (oneOf(SITE_JOB, row.g_job_status)) st.g_job_status = String(row.g_job_status);
  if (oneOf(RANKS, row.g_credit_rank)) st.g_credit_rank = String(row.g_credit_rank);
  if (row.g_conditions != null && String(row.g_conditions).trim()) st.g_conditions = String(row.g_conditions).trim();
  if (row.customer_note != null && String(row.customer_note).trim()) st.customer_note = String(row.customer_note).trim();
  // site-credit-noinst v1.1: the expert's saved answers (answers_json) beat site answers for the keys they hold — before this,
  // applyLegacyAnswers only filled EMPTY keys, so a site value merged first could hide an expert correction.
  const ov = <T extends readonly string[]>(k: "amount_range" | "loan_purpose" | "job_status" | "has_military_card" | "can_refer_retiree"
    | "has_bounced_or_overdue" | "need_timing", set: T) => { if (oneOf(set, extra[k])) st[k] = String(extra[k]); };
  ov("amount_range", SITE_AMOUNT_RANGE); ov("loan_purpose", SITE_PURPOSE); ov("job_status", SITE_JOB);
  ov("has_military_card", SITE_MILITARY); ov("can_refer_retiree", SITE_YES_NO); ov("has_bounced_or_overdue", SITE_YES_NO);
  ov("need_timing", SITE_TIMING);
  if (Array.isArray(extra.documents) && extra.documents.length) st.documents = canonDocs(extra.documents);
  applyLegacyAnswers(st, extra, null, str(extra.note));
  // Re-apply column values so JSON cannot clobber the typed columns.
  if (row.city != null && String(row.city).trim()) st.city = String(row.city).trim();
  if (row.amount_toman != null && Number(row.amount_toman) > 0) st.amount = String(Math.round(Number(row.amount_toman)));
  if (oneOf(CUSTOMER_RANKS, row.credit_rank)) st.credit_rank = String(row.credit_rank);
  if (oneOf(SITE_JOB, row.g_job_status)) st.g_job_status = String(row.g_job_status);
  if (oneOf(RANKS, row.g_credit_rank)) st.g_credit_rank = String(row.g_credit_rank);
  if (row.g_conditions != null && String(row.g_conditions).trim()) st.g_conditions = String(row.g_conditions).trim();
  if (row.customer_note != null && String(row.customer_note).trim()) st.customer_note = String(row.customer_note).trim();
}

/** Merge site / simple / callback / first-call / stored dossier into one state. Later sources win only for keys they set. */
export function buildDossier(customerId: number, base: { answers?: Record<string, unknown> | null; city?: string | null; note?: string | null }): DossierState {
  ensureDossierSchema();
  const st = emptyDossier();
  applySite(st, customerId);
  applyLead(st, latestPublicLead(customerId));
  applyLead(st, latestCallback(customerId));
  applyLegacyAnswers(st, base.answers ?? null, base.city ?? null, base.note ?? null);
  const row = loadRow(customerId);
  if (row) applyStored(st, row);
  return st;
}

export function enrichFileCard<T extends { answers?: Record<string, unknown> | null; city?: string | null; note?: string | null; customerId?: number }>(card: T, customerId = card.customerId): T & {
  dossier: DossierState; dossierComplete: boolean; dossierPartial: boolean; sitePrefill: boolean;
  /** site-credit-noinst v1.1 (additive): file keys whose shown value is the customer's own site answer → «از سایت» */
  siteFields: string[];
  /** the customer submitted the site wizard at least once (even name + mobile only) → empty rows show «بپرسید» */
  siteLead: boolean;
} {
  const id = Number(customerId);
  const ok = Number.isFinite(id) && id > 0;
  const dossier = ok ? buildDossier(id, card) : emptyDossier();
  const site = ok ? siteOnly(id) : { st: emptyDossier(), any: false };
  const siteFields = SITE_FIELD_KEYS.filter((k) => k === "documents"
    ? site.st.documents.length > 0 && site.st.documents.join() === (dossier.documents || []).join()
    : !!site.st[k] && site.st[k] === dossier[k]);
  const sitePrefill = !!(dossier.amount_range || dossier.loan_purpose || dossier.job_status || (dossier.documents || []).length
    || dossier.has_military_card || dossier.can_refer_retiree || dossier.has_bounced_or_overdue || dossier.need_timing
    || dossier.need || dossier.amountBand || dossier.contactTime || dossier.planName || dossier.term || dossier.customer_note);
  // Additive keys on answers so existing readers keep working and the client can use one object.
  const answers = { ...(card.answers ?? {}) } as Record<string, unknown>;
  if (dossier.city) answers.city = dossier.city;
  if (dossier.amount) {
    answers.amount_toman = Number(dossier.amount);
    const m = Math.max(1, Math.round(Number(dossier.amount) / 1e6));
    if (!answers.amountMillion) answers.amountMillion = m;
  }
  // legacy readers expect A1–E3 | unknown: a bare site letter stays in the dossier only
  if (dossier.credit_rank && RANKS.includes(dossier.credit_rank)) answers.creditRank = answers.creditRank ?? dossier.credit_rank;
  if (dossier.note && answers.note == null) answers.note = dossier.note;
  if (hasGuarantor(dossier) && answers.guarantorAvailable == null) answers.guarantorAvailable = "yes";
  if ((dossier.documents || []).includes("guarantor") === false && (dossier.documents || []).length && answers.guarantorAvailable == null) {
    answers.guarantorAvailable = "no";
  }
  return {
    ...card,
    answers: Object.keys(answers).length ? answers : card.answers ?? null,
    city: dossier.city || card.city || null,
    dossier,
    dossierComplete: dossierComplete(dossier),
    dossierPartial: dossierPartial(dossier),
    sitePrefill: sitePrefill || siteFields.length > 0,
    siteFields,
    siteLead: site.any,
  };
}

function asEnum(v: unknown, set: readonly string[]): string {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  if (!s) return "";
  if (!set.includes(s)) throw new TeamSalesError(400, "مقدار نامعتبر است.");
  return s;
}

function asCity(v: unknown): string {
  const s = str(v).replace(/\s+/g, " ");
  if ([...s].length > 60) throw new TeamSalesError(400, "شهر حداکثر ۶۰ نویسه است.");
  return s;
}

function asAmount(v: unknown): string {
  const d = digitStr(v);
  if (!d) return "";
  if (d.length > 15) throw new TeamSalesError(400, "مبلغ معتبر نیست.");
  return d;
}

function asText(v: unknown, max: number, label: string): string {
  const s = str(v);
  if ([...s].length > max) throw new TeamSalesError(400, `${label} خیلی بلند است.`);
  return s;
}

export function parseDossierInput(raw: unknown): DossierState {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const st = emptyDossier();
  st.city = asCity(src.city);
  st.amount = asAmount(src.amount ?? src.amount_toman ?? src.amountToman);
  st.amount_range = asEnum(src.amount_range, SITE_AMOUNT_RANGE);
  st.loan_purpose = asEnum(src.loan_purpose, SITE_PURPOSE);
  st.job_status = asEnum(src.job_status, SITE_JOB);
  st.documents = canonDocs(src.documents);
  st.has_military_card = asEnum(src.has_military_card, SITE_MILITARY);
  st.can_refer_retiree = asEnum(src.can_refer_retiree, SITE_YES_NO);
  st.has_bounced_or_overdue = asEnum(src.has_bounced_or_overdue, SITE_YES_NO);
  st.need_timing = asEnum(src.need_timing, SITE_TIMING);
  st.credit_rank = asEnum(src.credit_rank, CUSTOMER_RANKS);
  st.g_job_status = asEnum(src.g_job_status, SITE_JOB);
  st.g_credit_rank = asEnum(src.g_credit_rank, RANKS);
  st.g_conditions = asText(src.g_conditions, 500, "شرایط ضامن");
  st.customer_note = asText(src.customer_note, 2000, "یادداشت مشتری");
  st.note = asText(src.note, 2000, "یادداشت کارشناس");
  st.need = asEnum(src.need, LEAD_NEED);
  st.amountBand = asEnum(src.amountBand ?? src.amount_band, LEAD_BANDS);
  st.contactTime = asEnum(src.contactTime ?? src.contact_time, LEAD_TIMES);
  st.planId = src.planId == null || src.planId === "" ? "" : String(src.planId);
  st.planName = asText(src.planName ?? src.plan_name, 200, "نام طرح"); // stored as given by the server, never invented here
  st.term = src.term == null || src.term === "" ? "" : String(digitStr(src.term) || src.term);
  if (!hasGuarantor(st)) {
    st.g_job_status = "";
    st.g_credit_rank = "";
    st.g_conditions = "";
  }
  return st;
}

function actorNameOf(actor: Actor): string | null {
  const n = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId ?? -1]);
  return n?.name ?? actor.fullName ?? null;
}

/**
 * Partial or final upsert. Completeness is not required (spec §6 #19).
 * Does not change priority, owner, status, contracts, loan_plans, or send messages.
 */
export function saveDossier(customerId: number, actor: Actor, raw: unknown, now = new Date()) {
  ensureDossierSchema();
  const c = queryRow<{ id: number; salesperson_id: number | null; status: string; priority: number | null; merged_into_customer_id: number | null }>(
    "SELECT id, salesperson_id, status, priority, merged_into_customer_id FROM customers WHERE id=?", [customerId]);
  if (!c || c.merged_into_customer_id != null) throw new TeamSalesError(404, "Customer not found");
  if (!firstCallEditAccess(actor, c).canEdit) throw new TeamSalesError(403, "تکمیل پرونده فقط برای مدیر، کارشناس تماس اول و کارشناس همین مشتری است.");
  const st = parseDossierInput(raw);
  const amount = st.amount ? Number(st.amount) : null;
  const extra = {
    amount_range: st.amount_range || null,
    loan_purpose: st.loan_purpose || null,
    job_status: st.job_status || null,
    documents: st.documents,
    has_military_card: st.has_military_card || null,
    can_refer_retiree: st.can_refer_retiree || null,
    has_bounced_or_overdue: st.has_bounced_or_overdue || null,
    need_timing: st.need_timing || null,
    note: st.note || null,
    need: st.need || null,
    amountBand: st.amountBand || null,
    contactTime: st.contactTime || null,
    planId: st.planId || null,
    planName: st.planName || null,
    term: st.term || null,
  };
  const at = now.toISOString();
  const name = actorNameOf(actor);
  execute(
    `INSERT INTO ${DOSSIER_TABLE} (
      customer_id, city, amount_toman, credit_rank, g_job_status, g_credit_rank, g_conditions, customer_note,
      answers_json, updated_at, actor_user_id, actor_name
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (customer_id) DO UPDATE SET
      city=excluded.city, amount_toman=excluded.amount_toman, credit_rank=excluded.credit_rank,
      g_job_status=excluded.g_job_status, g_credit_rank=excluded.g_credit_rank, g_conditions=excluded.g_conditions,
      customer_note=excluded.customer_note, answers_json=excluded.answers_json, updated_at=excluded.updated_at,
      actor_user_id=excluded.actor_user_id, actor_name=excluded.actor_name`,
    [
      c.id, st.city || null, amount, st.credit_rank || null, st.g_job_status || null, st.g_credit_rank || null,
      st.g_conditions || null, st.customer_note || null, JSON.stringify(extra), at, actor.id, name,
    ],
  );
  return { ok: true, complete: dossierComplete(st), partial: dossierPartial(st) };
}
