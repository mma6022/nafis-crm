// «در انتظار ثبت»: server-side drafts of the «درخواست تسهیلات» wizard.
// A draft is NOT a loan case: it never appears in case lists, counts, contracts or commissions.
// Money rules: a draft only *points* at an existing loan_filing_fee_charges row. Nothing here moves,
// refunds or re-prices money; pricing and reuse stay in routes/loan-applications.ts.
// Notifications are in-CRM rows in site_notification_events only (no SMS / outbound message).
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction, type SqlValue } from "./crm-db";
import type { AuthUser } from "./auth";

export const DRAFT_STEP_LABELS = [
  "انتخاب مشتری", "اطلاعات هویتی", "احراز هویت", "رتبه اعتباری", "طرح و شرط",
  "مبلغ و مدت", "هزینه تشکیل پرونده", "مدارک هویتی", "اطلاعات تکمیلی قرارداد", "بازبینی و ثبت",
] as const;
export const DRAFT_TOTAL_STEPS = DRAFT_STEP_LABELS.length;
export const UNPAID_TTL_DAYS = 30;
export const WARN_BEFORE_DAYS = 5; // HANDOFF §3/1: warning from day 25
export const PAID_REMINDER_AFTER_HOURS = 24;
/** Tehran is UTC+03:30 all year (no DST since 2022). */
export const TEHRAN_OFFSET_MINUTES = 210;
export const DAILY_JOB_HOUR_TEHRAN = 12;
/**
 * Auto-delete of unpaid drafts (30 days, warning first) ships OFF (PM, 24 Oct): no expiry warnings, no deletes.
 * Server-side guard: only the exact value LOAN_REQUEST_DRAFTS_AUTO_DELETE=on enables it; unset / anything else = off.
 */
export function autoDeleteEnabled(env: Record<string, string | undefined> = process.env) { return env.LOAN_REQUEST_DRAFTS_AUTO_DELETE === "on"; }
const DAY_MS = 86_400_000;

export const DRAFTS_DDL = `
  CREATE TABLE IF NOT EXISTS loan_request_drafts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending_registration' CHECK(status IN ('pending_registration','submitted','deleted','expired')),
    source TEXT NOT NULL DEFAULT 'crm' CHECK(source IN ('crm','portal')),
    created_by_user_id INTEGER,
    salesperson_id INTEGER,
    step INTEGER NOT NULL DEFAULT 1 CHECK(step BETWEEN 1 AND 10),
    payload_json TEXT NOT NULL DEFAULT '{}',
    fee_charge_id INTEGER UNIQUE REFERENCES loan_filing_fee_charges(id) ON DELETE RESTRICT,
    application_id INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER,
    expiry_warned_at TEXT,
    last_reminded_on TEXT,
    deleted_at TEXT,
    deleted_by INTEGER,
    delete_reason TEXT,
    delete_kind TEXT CHECK(delete_kind IS NULL OR delete_kind IN ('manual','auto_expired'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_request_drafts_one_open ON loan_request_drafts(customer_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_loan_request_drafts_open ON loan_request_drafts(deleted_at,updated_at);
  CREATE TABLE IF NOT EXISTS loan_request_draft_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_user_id INTEGER,
    reason TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_loan_request_draft_events_customer ON loan_request_draft_events(customer_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_loan_request_draft_events_draft ON loan_request_draft_events(draft_id,id);
  CREATE TABLE IF NOT EXISTS loan_request_draft_job_runs(
    job TEXT NOT NULL, day TEXT NOT NULL, ran_at TEXT NOT NULL, detail_json TEXT, PRIMARY KEY(job,day)
  );`;

let ensured = false;
export function ensureLoanRequestDraftSchema() {
  if (ensured) return;
  crmDb.exec(DRAFTS_DDL);
  ensured = true;
}

export class DraftError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

// ---------------------------------------------------------------- access
/** Admin and any «all»-scope role (e.g. registrar) may see/continue every draft; «assigned» roles only their customers'. */
export function seesAllDrafts(u: AuthUser) { return u.role === "admin" || u.customerScope === "all"; }
export function canCreateDrafts(u: AuthUser) { return u.role === "admin" || u.permissions.includes("loan_applications.create"); }
/** Drafts are pre-case work: only roles that can start a request (admin, registrar, salesperson), not funder/accounting. */
export function canViewDrafts(u: AuthUser) { return canCreateDrafts(u); }
function scopeSql(u: AuthUser, alias = "c"): { sql: string; params: SqlValue[] } {
  return seesAllDrafts(u) ? { sql: "", params: [] } : { sql: ` AND ${alias}.salesperson_id=?`, params: [u.salespersonId ?? -1] };
}

// ---------------------------------------------------------------- payload
const PAYLOAD_KEYS = new Set(["planId", "planName", "conditionId", "amount", "duration", "ignoreCreditRank", "manualValues"]);
export function cleanPayload(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new DraftError(400, "invalid_draft_payload");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!PAYLOAD_KEYS.has(k)) continue; // documents, OTPs, credit results never live in a draft
    if (k === "planId" || k === "conditionId") { if (v == null || v === "") out[k] = null; else if (Number.isSafeInteger(Number(v)) && Number(v) > 0) out[k] = Number(v); else throw new DraftError(400, "invalid_draft_payload"); }
    else if (k === "amount" || k === "duration") { const s = String(v ?? "").trim(); if (s && !/^\d{1,18}$/.test(s)) throw new DraftError(400, "invalid_draft_payload"); out[k] = s; }
    else if (k === "planName") out[k] = v == null ? null : String(v).slice(0, 200);
    else if (k === "ignoreCreditRank") out[k] = v === true;
    else if (k === "manualValues") {
      if (v == null) { out[k] = {}; continue; }
      if (typeof v !== "object" || Array.isArray(v)) throw new DraftError(400, "invalid_draft_payload");
      const mv: Record<string, string> = {};
      for (const [mk, mval] of Object.entries(v as Record<string, unknown>).slice(0, 60)) if (/^[\w.\-\u0600-\u06FF ]{1,80}$/.test(mk)) mv[mk] = String(mval ?? "").slice(0, 2000);
      out[k] = mv;
    }
  }
  if (JSON.stringify(out).length > 32_000) throw new DraftError(413, "draft_payload_too_large");
  return out;
}
function parsePayload(raw: unknown): Record<string, any> { try { const v = JSON.parse(String(raw ?? "{}")); return v && typeof v === "object" ? v : {}; } catch { return {}; } }

// ---------------------------------------------------------------- reading
const SELECT = `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, c.salesperson_id AS customer_salesperson_id,
    sp.name AS salesperson_name, cu.full_name AS created_by_name, cu.username AS created_by_username,
    uu.full_name AS updated_by_name, uu.username AS updated_by_username,
    f.amount_toman AS fee_amount_toman, f.created_at AS fee_paid_at, f.plan_id AS fee_plan_id, f.application_id AS fee_application_id,
    f.actor_customer_id AS fee_actor_customer_id, lp.name AS fee_plan_name,
    (SELECT MAX(cc.completed_at) FROM customer_credit_checks cc WHERE cc.customer_id=d.customer_id AND cc.status='report_generated') AS credit_completed_at
  FROM loan_request_drafts d
  JOIN customers c ON c.id=d.customer_id AND c.merged_into_customer_id IS NULL
  LEFT JOIN salespersons sp ON sp.id=c.salesperson_id
  LEFT JOIN users cu ON cu.id=d.created_by_user_id
  LEFT JOIN users uu ON uu.id=d.updated_by_user_id
  LEFT JOIN loan_filing_fee_charges f ON f.id=d.fee_charge_id
  LEFT JOIN loan_plans lp ON lp.id=f.plan_id`;
/** Open = not deleted and its fee (if any) has not become a case through another path. */
const OPEN = "d.deleted_at IS NULL AND (f.id IS NULL OR f.application_id IS NULL)";
const isPaidSql = "(f.id IS NOT NULL AND CAST(f.amount_toman AS INTEGER)>0)";

export function hasPayment(row: { fee_charge_id?: unknown; fee_amount_toman?: unknown }) {
  return row.fee_charge_id != null && /^\d+$/.test(String(row.fee_amount_toman ?? "")) && BigInt(String(row.fee_amount_toman)) > 0n;
}

export function shapeDraft(r: any, u: AuthUser | null, nowMs = Date.now()) {
  const payload = parsePayload(r.payload_json);
  const paid = hasPayment(r);
  const updatedMs = Date.parse(r.updated_at);
  const paidMs = r.fee_paid_at ? Date.parse(r.fee_paid_at) : null;
  const waitFrom = updatedMs; // HANDOFF §6: waiting time (and its colour) counts from the last save
  const autoDeleteAt = r.fee_charge_id == null && autoDeleteEnabled() ? new Date(updatedMs + UNPAID_TTL_DAYS * DAY_MS).toISOString() : null;
  const creditFresh = !!r.credit_completed_at && Date.parse(r.credit_completed_at) >= nowMs - DAY_MS;
  return {
    id: Number(r.id), customerId: Number(r.customer_id), customerName: r.customer_name, customerPhone: r.customer_phone,
    status: r.deleted_at ? r.status : "pending_registration", source: r.source,
    step: Number(r.step), stepLabel: DRAFT_STEP_LABELS[Number(r.step) - 1] ?? "", totalSteps: DRAFT_TOTAL_STEPS,
    payload, planId: r.fee_plan_id ?? payload.planId ?? null, planName: r.fee_plan_name ?? payload.planName ?? null,
    feeChargeId: r.fee_charge_id == null ? null : Number(r.fee_charge_id),
    feeAmountToman: r.fee_charge_id == null ? null : String(r.fee_amount_toman), feePaidAt: r.fee_paid_at ?? null,
    feeByCustomer: r.fee_actor_customer_id != null,
    paid, locked: r.fee_charge_id != null,
    salespersonId: r.customer_salesperson_id ?? null, salespersonName: r.salesperson_name ?? null,
    createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name || r.created_by_username || null,
    updatedByName: r.updated_by_name || r.updated_by_username || null,
    createdAt: r.created_at, updatedAt: r.updated_at, version: Number(r.version),
    waitingHours: Math.max(0, Math.floor((nowMs - waitFrom) / 3_600_000)),
    paidOver24h: paid && !!paidMs && nowMs - paidMs >= PAID_REMINDER_AFTER_HOURS * 3_600_000,
    autoDeleteAt, expiringSoon: !!autoDeleteAt && Date.parse(autoDeleteAt) - nowMs <= WARN_BEFORE_DAYS * DAY_MS,
    daysUntilAutoDelete: autoDeleteAt ? Math.max(0, Math.ceil((Date.parse(autoDeleteAt) - nowMs) / DAY_MS)) : null,
    creditFresh, creditCheckAt: r.credit_completed_at ?? null,
    applicationId: r.application_id ?? r.fee_application_id ?? null,
    deletedAt: r.deleted_at ?? null, deleteReason: r.delete_reason ?? null,
    canContinue: !!u && !r.deleted_at && canCreateDrafts(u) && (seesAllDrafts(u) || r.customer_salesperson_id === u.salespersonId),
    canDelete: !!u && !r.deleted_at && u.role === "admin" && r.fee_charge_id == null,
  };
}

export function listDrafts(u: AuthUser, opts: { scope?: "mine" | "all"; paidOnly?: boolean; search?: string; customerId?: number } = {}, nowMs = Date.now()) {
  syncDraftsWithCases(nowMs);
  const s = scopeSql(u);
  // Params are bound in SQL order: filters first, then the role scope (its SQL is appended last below).
  const where: string[] = [OPEN]; const params: SqlValue[] = [];
  if (opts.scope === "mine") { where.push("(d.created_by_user_id=? OR c.salesperson_id=?)"); params.push(u.id, u.salespersonId ?? -1); }
  if (opts.paidOnly) where.push(isPaidSql);
  if (opts.customerId) { where.push("d.customer_id=?"); params.push(opts.customerId); }
  if (opts.search?.trim()) {
    const q = opts.search.trim();
    where.push("(c.name LIKE ? OR c.phone LIKE ? OR CAST(c.id AS TEXT)=? OR c.national_code=?)");
    params.push(`%${q}%`, `%${q}%`, q.replace(/^#/, ""), q);
  }
  params.push(...s.params);
  const rows = queryRows<any>(`${SELECT} WHERE ${where.join(" AND ")}${s.sql} ORDER BY ${isPaidSql} DESC, d.updated_at ASC, d.id ASC LIMIT 500`, params);
  return rows.map(r => shapeDraft(r, u, nowMs));
}

export function draftCounts(u: AuthUser, nowMs = Date.now()) {
  const items = listDrafts(u, {}, nowMs);
  return {
    total: items.length,
    paid: items.filter(i => i.paid).length,
    paidOver24h: items.filter(i => i.paidOver24h).length,
    expiringSoon: items.filter(i => i.expiringSoon).length,
    mine: items.filter(i => i.createdByUserId === u.id || (u.salespersonId != null && i.salespersonId === u.salespersonId)).length,
    orphanFees: listOrphanPaidFees(u, {}, nowMs).length, // 0 for every non-admin role
    legacyCases: listLegacyPreRegistrations(u, {}, nowMs).length,
    autoDelete: autoDeleteEnabled(),
  };
}

// ---------------------------------------------------------------- read-only rows shown in the same queue (computed at read time, nothing written)
const searchSql = (q: string | undefined, params: SqlValue[]) => {
  if (!q?.trim()) return "";
  const t = q.trim(); params.push(`%${t}%`, `%${t}%`, t.replace(/^#/, ""), t);
  return " AND (c.name LIKE ? OR c.phone LIKE ? OR CAST(c.id AS TEXT)=? OR c.national_code=?)";
};
const hoursSince = (iso: string | null | undefined, nowMs: number) => (iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 3_600_000)) : 0);

/** «هزینه‌ی واریزشده بدون پرونده»: paid filing-fee charges with no case and no open draft. ADMIN ONLY; never converted. */
export function listOrphanPaidFees(u: AuthUser, opts: { scope?: "mine" | "all"; search?: string; customerId?: number } = {}, nowMs = Date.now()) {
  if (u.role !== "admin") return [];
  ensureLoanRequestDraftSchema();
  const params: SqlValue[] = [];
  let where = `f.application_id IS NULL AND CAST(f.amount_toman AS INTEGER)>0
    AND NOT EXISTS (SELECT 1 FROM loan_request_drafts d WHERE d.fee_charge_id=f.id AND d.deleted_at IS NULL)`;
  if (opts.scope === "mine") { where += " AND (f.actor_user_id=? OR c.salesperson_id=?)"; params.push(u.id, u.salespersonId ?? -1); }
  if (opts.customerId) { where += " AND f.customer_id=?"; params.push(opts.customerId); }
  where += searchSql(opts.search, params);
  const rows = queryRows<any>(`SELECT f.id,f.customer_id,f.plan_id,f.amount_toman,f.created_at,f.actor_user_id,f.actor_customer_id,
      c.name customer_name,c.phone customer_phone,c.salesperson_id,sp.name salesperson_name,lp.name plan_name,
      au.full_name actor_name,au.username actor_username
    FROM loan_filing_fee_charges f JOIN customers c ON c.id=f.customer_id
    LEFT JOIN salespersons sp ON sp.id=c.salesperson_id LEFT JOIN loan_plans lp ON lp.id=f.plan_id LEFT JOIN users au ON au.id=f.actor_user_id
    WHERE ${where} ORDER BY f.created_at ASC, f.id ASC LIMIT 500`, params);
  return rows.map((r) => ({
    kind: "orphan_fee" as const, chargeId: Number(r.id), customerId: Number(r.customer_id), customerName: r.customer_name, customerPhone: r.customer_phone,
    amountToman: String(r.amount_toman), paidAt: r.created_at, planId: r.plan_id == null ? null : Number(r.plan_id), planName: r.plan_name ?? null,
    byCustomer: r.actor_customer_id != null, chargedByName: r.actor_name || r.actor_username || null,
    salespersonId: r.salesperson_id ?? null, salespersonName: r.salesperson_name ?? null,
    waitingHours: hoursSince(r.created_at, nowMs), readOnly: true as const,
  }));
}

/**
 * Old pre-registration cases left at stage 'draft' (hidden from the case list by
 * `COALESCE(is_pre_registration,0)=0 OR stage<>'draft'`). Display only. Visibility: admin / «all»-scope roles see all,
 * «assigned» roles (salesperson) only their customers' — same rule as drafts.
 */
export function listLegacyPreRegistrations(u: AuthUser, opts: { scope?: "mine" | "all"; search?: string; customerId?: number } = {}, nowMs = Date.now()) {
  const s = scopeSql(u);
  const params: SqlValue[] = [...s.params];
  let where = `a.deleted_at IS NULL AND a.stage='draft' AND COALESCE(a.is_pre_registration,0)=1${s.sql}`;
  if (opts.scope === "mine") { where += " AND (a.requested_by_user_id=? OR c.salesperson_id=?)"; params.push(u.id, u.salespersonId ?? -1); }
  if (opts.customerId) { where += " AND a.customer_id=?"; params.push(opts.customerId); }
  where += searchSql(opts.search, params);
  const rows = queryRows<any>(`SELECT a.id,a.customer_id,a.plan_id,a.requested_amount,a.duration_months,a.status,a.created_at,a.updated_at,a.requested_by_user_id,
      c.name customer_name,c.phone customer_phone,c.salesperson_id,sp.name salesperson_name,lp.name plan_name,ru.full_name req_name,ru.username req_username
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    LEFT JOIN salespersons sp ON sp.id=c.salesperson_id LEFT JOIN loan_plans lp ON lp.id=a.plan_id LEFT JOIN users ru ON ru.id=a.requested_by_user_id
    WHERE ${where} ORDER BY a.updated_at ASC, a.id ASC LIMIT 200`, params);
  return rows.map((r) => ({
    kind: "legacy_case" as const, applicationId: Number(r.id), customerId: Number(r.customer_id), customerName: r.customer_name, customerPhone: r.customer_phone,
    planId: r.plan_id == null ? null : Number(r.plan_id), planName: r.plan_name ?? null,
    requestedAmount: r.requested_amount == null ? null : String(r.requested_amount), durationMonths: r.duration_months == null ? null : Number(r.duration_months),
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, requestedByName: r.req_name || r.req_username || null,
    salespersonId: r.salesperson_id ?? null, salespersonName: r.salesperson_name ?? null,
    waitingHours: hoursSince(r.updated_at, nowMs), readOnly: true as const,
  }));
}

function rowById(id: number) { return queryRow<any>(`${SELECT} WHERE d.id=?`, [id]); }
export function getDraft(id: number, u: AuthUser, nowMs = Date.now()) {
  const r = rowById(id);
  if (!r || (!seesAllDrafts(u) && r.customer_salesperson_id !== u.salespersonId)) throw new DraftError(404, "draft_not_found");
  return shapeDraft(r, u, nowMs);
}
export function openDraftForCustomer(customerId: number, u: AuthUser | null) {
  const r = queryRow<any>(`${SELECT} WHERE d.customer_id=? AND ${OPEN}`, [customerId]);
  return r ? shapeDraft(r, u) : null;
}

// ---------------------------------------------------------------- writing
function audit(draftId: number, customerId: number, action: string, actorId: number | null, reason: string | null = null, detail: unknown = null, ts = new Date().toISOString()) {
  execute("INSERT INTO loan_request_draft_events(draft_id,customer_id,action,actor_user_id,reason,detail_json,created_at) VALUES(?,?,?,?,?,?,?)",
    [draftId, customerId, action, actorId, reason, detail == null ? null : JSON.stringify(detail), ts]);
}
function scopedCustomer(customerId: number, u: AuthUser) {
  const s = scopeSql(u);
  return queryRow<any>(`SELECT c.id,c.name,c.salesperson_id FROM customers c WHERE c.id=? AND c.merged_into_customer_id IS NULL${s.sql}`, [customerId, ...s.params]);
}
/** Row for continuing/changing: must exist, be open and be continuable by this user. */
function writableRow(id: number, u: AuthUser) {
  const r = rowById(id);
  if (!r || (!seesAllDrafts(u) && r.customer_salesperson_id !== u.salespersonId)) throw new DraftError(404, "draft_not_found");
  if (r.deleted_at || r.fee_application_id) throw new DraftError(410, "draft_closed", { applicationId: r.application_id ?? r.fee_application_id ?? null });
  if (!canCreateDrafts(u)) throw new DraftError(403, "Forbidden");
  return r;
}
function clampStep(v: unknown, fallback = 1) { const n = Number(v); return Number.isInteger(n) ? Math.min(Math.max(n, 1), DRAFT_TOTAL_STEPS) : fallback; }

export function createDraft(u: AuthUser, body: any) {
  if (!canCreateDrafts(u)) throw new DraftError(403, "Forbidden");
  const customerId = Number(body?.customerId);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new DraftError(400, "invalid_customer");
  const payload = cleanPayload(body?.payload);
  if (payload.ignoreCreditRank === true && !["admin", "salesperson"].includes(u.role)) payload.ignoreCreditRank = false;
  return runImmediateTransaction(() => {
    const customer = scopedCustomer(customerId, u);
    if (!customer) throw new DraftError(404, "customer_not_found");
    syncDraftsWithCases(Date.now(), customerId);
    const existing = queryRow<any>(`${SELECT} WHERE d.customer_id=? AND ${OPEN}`, [customerId]);
    if (existing) throw new DraftError(409, "draft_exists", { draft: shapeDraft(existing, u) });
    const ts = new Date().toISOString();
    const id = execute(`INSERT INTO loan_request_drafts(customer_id,source,created_by_user_id,salesperson_id,step,payload_json,created_at,updated_at,updated_by_user_id)
      VALUES(?,?,?,?,?,?,?,?,?)`, [customerId, "crm", u.id, customer.salesperson_id ?? null, clampStep(body?.step, 2), JSON.stringify(payload), ts, ts, u.id]);
    audit(id, customerId, "created", u.id, null, null, ts);
    return shapeDraft(rowById(id), u);
  });
}

export function updateDraft(id: number, u: AuthUser, body: any, ifMatch?: string | null) {
  const version = Number(body?.version ?? String(ifMatch ?? "").replace(/^W\//, "").replace(/"/g, ""));
  if (!Number.isSafeInteger(version) || version < 1) throw new DraftError(428, "draft_version_required");
  const incoming = cleanPayload(body?.payload);
  return runImmediateTransaction(() => {
    const r = writableRow(id, u);
    if (Number(r.version) !== version) throw new DraftError(409, "draft_version_conflict", { draft: shapeDraft(r, u) });
    const current = parsePayload(r.payload_json);
    const next: Record<string, unknown> = { ...current, ...incoming };
    if (next.ignoreCreditRank === true && !["admin", "salesperson"].includes(u.role)) next.ignoreCreditRank = current.ignoreCreditRank === true;
    if (r.fee_charge_id != null) {
      // Paid/locked: the plan is bound to the charge. The requested amount stays as saved unless an admin edits it.
      next.planId = Number(r.fee_plan_id);
      if (u.role !== "admin" && hasPayment(r) && current.amount && incoming.amount !== undefined && incoming.amount !== current.amount)
        throw new DraftError(409, "draft_amount_locked");
    }
    const step = body?.step === undefined ? Number(r.step) : clampStep(body.step, Number(r.step));
    const ts = new Date().toISOString();
    const changed = executeChanges(`UPDATE loan_request_drafts SET step=?,payload_json=?,version=version+1,updated_at=?,updated_by_user_id=?,expiry_warned_at=NULL
      WHERE id=? AND version=? AND deleted_at IS NULL`, [step, JSON.stringify(next), ts, u.id, id, version]);
    if (changed !== 1) throw new DraftError(409, "draft_version_conflict", { draft: shapeDraft(rowById(id), u) });
    if (step !== Number(r.step)) audit(id, Number(r.customer_id), "step", u.id, null, { from: Number(r.step), to: step }, ts);
    return shapeDraft(rowById(id), u);
  });
}

export function deleteDraft(id: number, u: AuthUser, body: any) {
  if (u.role !== "admin") throw new DraftError(403, "admin_role_required");
  const reason = String(body?.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new DraftError(422, "delete_reason_required");
  return runImmediateTransaction(() => {
    const r = rowById(id);
    if (!r) throw new DraftError(404, "draft_not_found");
    if (r.deleted_at) throw new DraftError(410, "draft_closed");
    // Phase 1 (HANDOFF §8.2): a draft with any fee charge is not deletable; money is never refunded or moved.
    if (r.fee_charge_id != null) throw new DraftError(409, "PAID_DRAFT_NOT_DELETABLE");
    const ts = new Date().toISOString();
    const changed = executeChanges(`UPDATE loan_request_drafts SET status='deleted',delete_kind='manual',deleted_at=?,deleted_by=?,delete_reason=?,updated_at=?
      WHERE id=? AND deleted_at IS NULL AND fee_charge_id IS NULL`,
      [ts, u.id, reason, ts, id]);
    if (changed !== 1) throw new DraftError(409, "PAID_DRAFT_NOT_DELETABLE");
    audit(id, Number(r.customer_id), "deleted", u.id, reason, { step: Number(r.step), feeChargeId: r.fee_charge_id ?? null }, ts);
    notify(r, "draft_deleted", "درخواست «در انتظار ثبت» حذف شد", `مدیر سیستم این درخواست را حذف کرد. دلیل: ${reason}`.slice(0, 300), ts);
    return { ok: true };
  });
}

/** Called inside the fee-charge transaction (routes/loan-applications.ts). Never creates or prices a charge. */
export function draftForFeeCharge(draftId: unknown, customerId: number, planId: number, u: AuthUser) {
  if (draftId == null || draftId === "") return null;
  const id = Number(draftId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_draft");
  const r = rowById(id);
  if (!r || Number(r.customer_id) !== customerId || (!seesAllDrafts(u) && r.customer_salesperson_id !== u.salespersonId)) throw new Error("draft_not_found");
  if (r.deleted_at || r.fee_application_id) throw new Error("draft_closed");
  if (r.fee_charge_id != null && Number(r.fee_plan_id) !== planId) throw new Error("draft_fee_plan_locked");
  return r;
}
export function linkDraftFee(draft: any, chargeId: number, u: AuthUser) {
  if (!draft) return;
  if (draft.fee_charge_id != null) return;
  const charge = queryRow<any>("SELECT id,plan_id,application_id FROM loan_filing_fee_charges WHERE id=?", [chargeId]);
  if (!charge || charge.application_id != null) return;
  if (queryRow("SELECT 1 FROM loan_request_drafts WHERE fee_charge_id=? AND id<>?", [chargeId, draft.id])) return;
  const ts = new Date().toISOString();
  const payload = { ...parsePayload(draft.payload_json), planId: Number(charge.plan_id) };
  executeChanges(`UPDATE loan_request_drafts SET fee_charge_id=?,payload_json=?,step=MAX(step,?),version=version+1,updated_at=?,updated_by_user_id=?,expiry_warned_at=NULL
    WHERE id=? AND fee_charge_id IS NULL AND deleted_at IS NULL`, [chargeId, JSON.stringify(payload), 7, ts, u.id, draft.id]);
  audit(Number(draft.id), Number(draft.customer_id), "fee_linked", u.id, null, { feeChargeId: chargeId }, ts);
}
/** Called inside the create-case transaction: validates the draft before, closes it after. */
export function draftForSubmit(draftId: unknown, customerId: number, feeChargeId: number, u: AuthUser) {
  if (draftId == null || draftId === "") return null;
  const r = draftForFeeCharge(draftId, customerId, Number(queryRow<any>("SELECT plan_id FROM loan_filing_fee_charges WHERE id=?", [feeChargeId])?.plan_id), u);
  if (r && r.fee_charge_id != null && Number(r.fee_charge_id) !== feeChargeId) throw new Error("draft_fee_mismatch");
  return r;
}
export function closeDraftsForCase(customerId: number, feeChargeId: number, applicationId: number, actorId: number | null, draftId?: number | null) {
  const ts = new Date().toISOString();
  const rows = queryRows<any>(`SELECT id,customer_id FROM loan_request_drafts WHERE deleted_at IS NULL AND customer_id=? AND (fee_charge_id=? OR id=?)`,
    [customerId, feeChargeId, draftId ?? -1]);
  for (const r of rows) {
    executeChanges(`UPDATE loan_request_drafts SET status='submitted',application_id=?,deleted_at=?,deleted_by=?,delete_reason='submitted',updated_at=?,
      fee_charge_id=COALESCE(fee_charge_id,?) WHERE id=? AND deleted_at IS NULL`, [applicationId, ts, actorId, ts, feeChargeId, r.id]);
    audit(Number(r.id), customerId, "submitted", actorId, null, { applicationId, feeChargeId }, ts);
  }
}

// ---------------------------------------------------------------- background (in-process; inert in fixtures unless called)
function notify(r: { customer_id: unknown; id: unknown }, kind: string, title: string, body: string, ts: string) {
  const c = queryRow<any>("SELECT name,salesperson_id FROM customers WHERE id=?", [Number(r.customer_id)]);
  if (!c) return;
  // Delivered by site-notifications to the owning salesperson and admins only.
  execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [Number(r.customer_id), c.name ?? "مشتری", c.salesperson_id ?? null, "loan_draft", Number(r.id), kind, title, body, "loan_applications.view", ts]);
}

/** Close drafts whose fee became a case through any path (portal, older client, admin tools). */
export function syncDraftsWithCases(nowMs = Date.now(), customerId?: number) {
  ensureLoanRequestDraftSchema();
  const rows = queryRows<any>(`SELECT d.id,d.customer_id,d.fee_charge_id,f.application_id FROM loan_request_drafts d JOIN loan_filing_fee_charges f ON f.id=d.fee_charge_id
    WHERE d.deleted_at IS NULL AND f.application_id IS NOT NULL${customerId ? " AND d.customer_id=?" : ""}`, customerId ? [customerId] : []);
  for (const r of rows) closeDraftsForCase(Number(r.customer_id), Number(r.fee_charge_id), Number(r.application_id), null);
  void nowMs;
  return rows.length;
}

export function tehranDay(nowMs: number) { return new Date(nowMs + TEHRAN_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10); }
export function tehranHour(nowMs: number) { return new Date(nowMs + TEHRAN_OFFSET_MINUTES * 60_000).getUTCHours(); }

/**
 * Daily maintenance. Expiry warnings and auto-delete run only when autoDeleteEnabled() (default OFF).
 * Unpaid = no fee charge row at all. Anything with a charge row (paid or 0-toman) is never auto-deleted.
 * Warning first (day 23 after the last save), deletion only at ≥30 days AND ≥24h after a warning that is newer than the last save.
 */
export function runDraftMaintenance(nowMs = Date.now()) {
  ensureLoanRequestDraftSchema();
  const ts = new Date(nowMs).toISOString();
  const warnBefore = new Date(nowMs - (UNPAID_TTL_DAYS - WARN_BEFORE_DAYS) * DAY_MS).toISOString();
  const expireBefore = new Date(nowMs - UNPAID_TTL_DAYS * DAY_MS).toISOString();
  const warnedBefore = new Date(nowMs - DAY_MS).toISOString();
  const result = { closed: 0, warned: [] as number[], expired: [] as number[], reminded: [] as number[], autoDelete: autoDeleteEnabled() };
  result.closed = syncDraftsWithCases(nowMs);
  // Orphan fee charges are never converted into drafts (PM, 24 Oct); admins see them read-only via listOrphanPaidFees().
  runImmediateTransaction(() => {
    const noMoney = `d.fee_charge_id IS NULL AND NOT EXISTS (SELECT 1 FROM loan_filing_fee_charges f2 WHERE f2.customer_id=d.customer_id AND f2.application_id IS NULL AND CAST(f2.amount_toman AS INTEGER)>0)`;
    if (result.autoDelete) for (const r of queryRows<any>(`SELECT d.* FROM loan_request_drafts d WHERE d.deleted_at IS NULL AND ${noMoney}
        AND d.updated_at<=? AND d.updated_at<=? AND (d.expiry_warned_at IS NULL OR d.expiry_warned_at<d.updated_at)`, [warnBefore, ts])) {
      executeChanges("UPDATE loan_request_drafts SET expiry_warned_at=? WHERE id=? AND deleted_at IS NULL AND fee_charge_id IS NULL", [ts, r.id]);
      const left = Math.max(1, Math.ceil((Date.parse(r.updated_at) + UNPAID_TTL_DAYS * DAY_MS - nowMs) / DAY_MS));
      notify(r, "draft_expiring", "درخواست «در انتظار ثبت» به‌زودی حذف می‌شود",
        `این درخواست هزینه‌ای ندارد و ${left.toLocaleString("fa-IR")} روز دیگر به‌طور خودکار حذف می‌شود. برای نگه داشتن، آن را ادامه دهید.`, ts);
      audit(Number(r.id), Number(r.customer_id), "expiry_warned", null, null, { daysLeft: left }, ts);
      result.warned.push(Number(r.id));
    }
    if (result.autoDelete) for (const r of queryRows<any>(`SELECT d.* FROM loan_request_drafts d WHERE d.deleted_at IS NULL AND ${noMoney}
        AND d.updated_at<=? AND d.expiry_warned_at IS NOT NULL AND d.expiry_warned_at>=d.updated_at AND d.expiry_warned_at<=?`, [expireBefore, warnedBefore])) {
      const changed = executeChanges(`UPDATE loan_request_drafts SET status='expired',delete_kind='auto_expired',deleted_at=?,delete_reason='auto_expired_unpaid_30d',updated_at=?
        WHERE id=? AND deleted_at IS NULL AND fee_charge_id IS NULL AND updated_at=?`, [ts, ts, r.id, r.updated_at]);
      if (changed !== 1) continue;
      audit(Number(r.id), Number(r.customer_id), "auto_expired", null, "auto_expired_unpaid_30d", { lastSavedAt: r.updated_at, warnedAt: r.expiry_warned_at }, ts);
      result.expired.push(Number(r.id));
    }
    if (tehranHour(nowMs) >= DAILY_JOB_HOUR_TEHRAN) {
      const day = tehranDay(nowMs);
      const paidBefore = new Date(nowMs - PAID_REMINDER_AFTER_HOURS * 3_600_000).toISOString();
      for (const r of queryRows<any>(`SELECT d.*,f.amount_toman,f.created_at fee_at FROM loan_request_drafts d JOIN loan_filing_fee_charges f ON f.id=d.fee_charge_id
          WHERE d.deleted_at IS NULL AND f.application_id IS NULL AND CAST(f.amount_toman AS INTEGER)>0 AND f.created_at<=? AND (d.last_reminded_on IS NULL OR d.last_reminded_on<>?)`, [paidBefore, day])) {
        executeChanges("UPDATE loan_request_drafts SET last_reminded_on=? WHERE id=?", [day, r.id]);
        const days = Math.floor((nowMs - Date.parse(r.fee_at)) / DAY_MS);
        notify(r, "draft_paid_pending", "هزینه پرداخت شده ولی پرونده ثبت نشده",
          `هزینه تشکیل پرونده ${BigInt(r.amount_toman).toLocaleString("fa-IR")} تومان ${days.toLocaleString("fa-IR")} روز پیش پرداخت شده و درخواست هنوز «در انتظار ثبت» است.`, ts);
        result.reminded.push(Number(r.id));
      }
    }
  });
  return result;
}

let timer: NodeJS.Timeout | null = null;
/** Every 5 minutes: close drafts whose fee became a case; (auto-delete only if enabled — default off); the warning/expiry pass is cheap and idempotent; paid reminders at most once per Tehran day after 12:00. */
export function startLoanRequestDraftScheduler() {
  if (timer || process.env.LOAN_REQUEST_DRAFTS_JOBS === "off") return;
  const tick = () => { try { runDraftMaintenance(); } catch (e) { console.warn("loan request drafts job skipped:", e instanceof Error ? e.message : e); } };
  timer = setInterval(tick, 5 * 60_000); timer.unref?.();
  setTimeout(tick, 90_000).unref?.();
}
