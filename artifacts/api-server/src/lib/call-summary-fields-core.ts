/**
 * «موارد اجباری خلاصه‌ی تماس» (design v1.2) — pure helpers shared by the first-call form paths (team-sales / history-a) and the
 * call-summary-fields service. Everything is behind flag.call_summary_fields_v1 (+ .user.<id>), default OFF. With the flag off none
 * of these helpers is reached: no schema, no payload key, identical behaviour.
 */
import { crmDb, execute, queryRow } from "./crm-db";

export const CS_FLAG = "flag.call_summary_fields_v1";
const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
const truthy = (v: string | null) => v === "1" || v === "true" || v === "on";
/** Global flag or the per-user variant. */
export function csOn(userId?: number | null): boolean {
  if (truthy(setting(CS_FLAG))) return true;
  return userId != null && truthy(setting(`${CS_FLAG}.user.${userId}`));
}
/** True when the flag is on globally or for at least one user (cheap gate for the summary-pipeline hook). */
export function csAnyOn(): boolean {
  if (truthy(setting(CS_FLAG))) return true;
  try { return !!queryRow<{ k: number }>("SELECT 1 k FROM call_queue_settings WHERE key LIKE ? AND value IN ('1','true','on') LIMIT 1", [`${CS_FLAG}.user.%`]); } catch { return false; }
}

export const CS_DOCS = ["national_card", "birth_cert", "payslip", "retirement_decree", "salary_deduction_cert", "sayadi_or_promissory"] as const;
export type CsDoc = (typeof CS_DOCS)[number];
export const CS_KEYS = ["creditRank", "gRank", "planType", "docs", "sso", "arrears", "bounced"] as const;
export type CsKey = (typeof CS_KEYS)[number];
export const CS_LABEL: Record<CsKey, string> = {
  creditRank: "رتبه‌ی متقاضی", gRank: "رتبه‌ی ضامن", planType: "نوع طرح", docs: "مدارک", sso: "بازنشسته‌ی تأمین اجتماعی", arrears: "معوقه", bounced: "چک برگشتی",
};
export const CS_DOC_LABEL: Record<CsDoc, string> = {
  national_card: "کارت ملی", birth_cert: "شناسنامه", payslip: "فیش حقوقی", retirement_decree: "حکم یا گواهی بازنشستگی",
  salary_deduction_cert: "گواهی کسر از حقوق", sayadi_or_promissory: "چک صیادی یا سفته",
};
/** docsReady is derived, never typed: all six → all, some → partial, none → none. */
export function docsStatus(docs: readonly string[]): "all" | "partial" | "none" {
  const n = new Set(docs.filter((d) => (CS_DOCS as readonly string[]).includes(d))).size;
  return n === CS_DOCS.length ? "all" : n > 0 ? "partial" : "none";
}
export const RANK_LETTER = /^[A-E]$/;
const SUB = /^[A-E][1-3]$/;
export const csRankOk = (v: unknown) => typeof v === "string" && (RANK_LETTER.test(v) || SUB.test(v) || v === "unknown");

export type CsMeta = { source: "transcript" | "confirmed" | "expert" | "no_answer"; reason?: string | null; at?: number | null };

/** Flag-on first-call answers carry `csFields: 1`. */
export const csMarked = (a: unknown) => !!a && typeof a === "object" && (a as { csFields?: unknown }).csFields === 1;

/**
 * Flag-on prepare: checks the new keys (arrears, docs[], docsNone) and derives docsReady. Empty items stay null in storage.
 * Returns the answers to store or a Persian error.
 */
export function csPrepare<T extends Record<string, unknown>>(raw: T): { answers: T; err: string | null } {
  const a: Record<string, unknown> = { ...raw, csFields: 1 };
  if (a.arrears != null && a.arrears !== "yes" && a.arrears !== "no") return { answers: a as T, err: "معوقه معتبر نیست." };
  if (a.docs != null && (!Array.isArray(a.docs) || a.docs.some((d) => !(CS_DOCS as readonly string[]).includes(String(d)))))
    return { answers: a as T, err: "فهرست مدارک معتبر نیست." };
  const docs = Array.isArray(a.docs) ? [...new Set((a.docs as string[]).map(String))].sort((x, y) => CS_DOCS.indexOf(x as CsDoc) - CS_DOCS.indexOf(y as CsDoc)) : [];
  const none = a.docsNone === true;
  if (none && docs.length) return { answers: a as T, err: "«هیچ‌کدام آماده نیست» با تیک مدارک هم‌زمان ممکن نیست." };
  if (none) { a.docs = []; a.docsNone = true; a.docsReady = "none"; }
  else if (docs.length) { a.docs = docs; a.docsNone = false; a.docsReady = docsStatus(docs); }
  else { a.docs = null; a.docsNone = false; a.docsReady = null; }
  for (const k of ["creditRank", "gRank"]) if (a[k] != null && !csRankOk(a[k])) return { answers: a as T, err: k === "gRank" ? "رتبهٔ ضامن معتبر نیست." : "رتبهٔ اعتباری معتبر نیست." };
  if (a.ssoRetiree != null && !["self", "family", "none"].includes(String(a.ssoRetiree))) return { answers: a as T, err: "بازنشستگی تأمین اجتماعی معتبر نیست." };
  return { answers: a as T, err: null };
}
/** What validateAnswers sees: empty items are allowed (Mohammad), letter ranks are accepted (gradeMatches understands them). */
export function csCheckView<T extends Record<string, unknown>>(a: T): T {
  const o: Record<string, unknown> = { ...a };
  if (o.creditRank == null || RANK_LETTER.test(String(o.creditRank))) o.creditRank = "unknown";
  if (o.bouncedCheque == null) o.bouncedCheque = "no";
  if (o.docsReady == null) o.docsReady = "none";
  if (o.guarantorAvailable === "yes") { if (o.gRank == null || RANK_LETTER.test(String(o.gRank))) o.gRank = "unknown"; if (o.guarantorCheque == null) o.guarantorCheque = "unknown"; }
  if (o.guarantorAvailable == null) o.guarantorAvailable = "unknown";
  return o as T;
}
/** What the plan rules / priority see: an empty rank is «نمی‌دانم» (the rules treat null as excluded). */
export function csRulesView<T extends Record<string, unknown>>(a: T): T {
  const o: Record<string, unknown> = { ...a };
  if (o.creditRank == null) o.creditRank = "unknown";
  if (o.guarantorAvailable === "yes" && o.gRank == null) o.gRank = "unknown";
  return o as T;
}
/** The 7 item values of a first-call / file answer set (plan comes from the caller). */
export function csValuesOfAnswers(a: Record<string, unknown> | null | undefined, plan: string | null): Record<CsKey, unknown> {
  const x = a ?? {};
  const docs = Array.isArray(x.docs) ? x.docs : x.docsNone === true ? [] : x.csFields === 1 && x.docs === null ? null : (x.docsReady as string | null | undefined) ?? null;
  return {
    creditRank: x.creditRank ?? null,
    gRank: x.guarantorAvailable === "no" ? "none" : x.gRank ?? null,
    planType: plan,
    docs,
    sso: x.ssoRetiree ?? null,
    arrears: x.arrears ?? null,
    bounced: x.bouncedCheque ?? null,
  };
}
/** Same value? A letter rank equals any sub-grade of that letter; a legacy docs status equals a list with that status (Q13). */
export function csSame(key: CsKey, a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (key === "creditRank" || key === "gRank") {
    const x = String(a), y = String(b);
    if (x === y) return true;
    if (RANK_LETTER.test(x) && SUB.test(y)) return y[0] === x;
    if (RANK_LETTER.test(y) && SUB.test(x)) return x[0] === y;
    return false;
  }
  if (key === "docs") {
    const ax = Array.isArray(a), bx = Array.isArray(b);
    if (ax && bx) { const s = new Set(a as string[]); return (b as string[]).length === s.size && (b as string[]).every((d) => s.has(d)); }
    if (ax) return docsStatus(a as string[]) === b;
    if (bx) return docsStatus(b as string[]) === a;
    return a === b;
  }
  if (key === "planType") return String(a).split("، ").includes(String(b)) || String(b).split("، ").includes(String(a));
  return a === b;
}
/** Answer patch that writes one item value into the file answers. */
export function csPatchFor(key: CsKey, v: unknown): Record<string, unknown> {
  switch (key) {
    case "creditRank": return { creditRank: v };
    case "gRank": return v === "none" ? { guarantorAvailable: "no", gRank: null, guarantorCheque: null, gJobType: null } : { guarantorAvailable: "yes", gRank: v };
    case "docs": return Array.isArray(v) ? { docs: v, docsNone: v.length === 0, docsReady: docsStatus(v as string[]), csFields: 1 } : { docsReady: v };
    case "sso": return { ssoRetiree: v, ...(v !== "family" ? { ssoRetireeRelation: null } : {}) };
    case "arrears": return { arrears: v, csFields: 1 };
    case "bounced": return { bouncedCheque: v };
    default: return {};
  }
}
/** Validates one item value typed in the call view / file. */
export function csValueOk(key: CsKey, v: unknown): boolean {
  if (v == null) return false;
  switch (key) {
    case "creditRank": return csRankOk(v);
    case "gRank": return csRankOk(v) || v === "none";
    case "docs": return Array.isArray(v) && v.every((d) => (CS_DOCS as readonly string[]).includes(String(d))) && new Set(v).size === v.length;
    case "sso": return ["self", "family", "none"].includes(String(v));
    case "arrears": case "bounced": return v === "yes" || v === "no";
    default: return false;
  }
}

/* ------------------------------------------------------------------ additive schema (lazy, flag-on only) */
let ensured = false;
export function ensureCsSchema(): void {
  if (ensured) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS cs_call_items (id INTEGER PRIMARY KEY AUTOINCREMENT, call_key TEXT NOT NULL, event_id INTEGER, qualification_id INTEGER,
      customer_id INTEGER, item_key TEXT NOT NULL, value_json TEXT, text TEXT, confidence TEXT, at_sec REAL, source TEXT NOT NULL, reason TEXT,
      user_id INTEGER, source_hash TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cs_call_items_key ON cs_call_items(call_key, item_key, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cs_call_items_customer ON cs_call_items(customer_id, id DESC);
    CREATE TABLE IF NOT EXISTS cs_extractions (event_id INTEGER PRIMARY KEY, source_hash TEXT, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cs_file_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
      item_key TEXT NOT NULL, file_value_json TEXT, new_value_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, decided_by INTEGER, decided_name TEXT, decided_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_cs_prop_customer ON cs_file_proposals(customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_cs_prop_event ON cs_file_proposals(event_id, item_key);
    CREATE TABLE IF NOT EXISTS cs_file_values (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, item_key TEXT NOT NULL, value_json TEXT,
      source TEXT NOT NULL, event_id INTEGER, qualification_id INTEGER, proposal_id INTEGER, approved_by INTEGER, approved_name TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cs_values_customer ON cs_file_values(customer_id, item_key, id DESC);
  `);
  ensured = true;
}
const META_SRC = ["transcript", "confirmed", "expert", "no_answer"];
/** Reads the form's per-item meta ({key:{source,reason?,at?}}) from the raw body; unknown keys are dropped. */
export function csMetaOf(raw: unknown): Partial<Record<CsKey, CsMeta>> {
  const out: Partial<Record<CsKey, CsMeta>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of CS_KEYS) {
    const m = (raw as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || !META_SRC.includes(String(m.source))) continue;
    const reason = typeof m.reason === "string" ? m.reason.trim().replace(/\s+/g, " ").slice(0, 120) || null : null;
    out[k] = { source: m.source as CsMeta["source"], reason, at: Number.isFinite(Number(m.at)) && m.at != null ? Number(m.at) : null };
  }
  return out;
}
/**
 * Flag-on first-call form save / edit (inside the caller's transaction): one 'form' row per item for the summary of that form
 * (call_key q:<id>) and one file-history row per item that has a value and changed (source first_call / first_call_edit).
 */
export function csRecordForm(o: { customerId: number; qualificationId: number; actorId: number; actorName: string | null; answers: Record<string, unknown>;
  plan: string | null; meta: Partial<Record<CsKey, CsMeta>>; at: string; edit?: boolean; before?: Record<CsKey, unknown> | null }): void {
  ensureCsSchema();
  const vals = csValuesOfAnswers(o.answers, o.plan);
  for (const k of CS_KEYS) {
    const m = o.meta[k];
    const v = vals[k];
    const src = v == null && m?.source === "no_answer" ? "no_answer" : m?.source === "transcript" || m?.source === "confirmed" ? "form_transcript" : v == null ? "form_empty" : m?.source === "expert" ? "expert" : "form";
    execute(`INSERT INTO cs_call_items (call_key, qualification_id, customer_id, item_key, value_json, text, confidence, at_sec, source, reason, user_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [`q:${o.qualificationId}`, o.qualificationId, o.customerId, k, v == null ? null : JSON.stringify(v), null, null,
      m?.at ?? null, src, src === "no_answer" ? m?.reason ?? null : null, o.actorId, o.at]);
    if (v != null && !(o.edit && o.before && JSON.stringify(o.before[k] ?? null) === JSON.stringify(v)))
      execute(`INSERT INTO cs_file_values (customer_id, item_key, value_json, source, qualification_id, approved_by, approved_name, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [o.customerId, k, JSON.stringify(v), o.edit ? "first_call_edit" : "first_call", o.qualificationId, o.actorId, o.actorName, o.at]);
  }
}
