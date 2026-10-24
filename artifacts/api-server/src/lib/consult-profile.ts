/**
 * crm-no-plan-option (steering 2026-10-24 14:51): Kazemi's first-call answers stored on the customer as an
 * append-only history («اطلاعات مشاوره» card on the customer page).
 *
 * - Every answered first-call form writes one version (source "first_call"); every edit writes one more
 *   (source "edit", with the editor and the changed fields). Rows are never updated or deleted: the latest version is
 *   the current value, older versions are the history and the edit log.
 * - The grade fields are what the customer SAID («اظهار مشتری»). The official grade (the latest ICS24 report that the
 *   identity_changed_at rule has not invalidated, rank derived from the score like everywhere else) is shown next to it
 *   and is what plan matching uses when it exists.
 * - Additive only: one new table. No SMS, no inquiry, no change to plans/contracts.
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { creditRankForScore } from "./credit-rank";
import { CREDIT_SUBGRADES } from "./credit-subgrades";
import { JOB_CODES, MILITARY_STATUSES, cleanProfile, type ApplicantProfile } from "./plan-profile-match";

export const CONSULT_PROFILE_TABLE = "customer_consult_profile_versions";
export const CONSULT_PROFILE_FIELDS = [
  "jobType", "guarantorAvailable", "guarantorCheque", "creditRank", "gRank", "gJobType", "military", "city",
  "selectedPlans", "noPlanFit", "noPlanNote", "urgency", "formDate", "submitterName",
] as const;
export type ConsultProfileField = (typeof CONSULT_PROFILE_FIELDS)[number];
export type ConsultSelectedPlan = { id: number; name: string; status?: string | null };
export type ConsultProfileData = {
  jobType: string | null; guarantorAvailable: string | null; guarantorCheque: string | null;
  creditRank: string | null; gRank: string | null; gJobType: string | null; military: string | null; city: string | null;
  selectedPlans: ConsultSelectedPlan[]; noPlanFit: boolean; noPlanNote: string | null;
  urgency: string | null; formDate: string | null; submitterName: string | null;
};
/** Fields a later salesperson may edit (date / submitter / plan selection are facts of the original form). */
export const EDITABLE_FIELDS = ["jobType", "guarantorAvailable", "guarantorCheque", "creditRank", "gRank", "gJobType", "military", "city", "urgency"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export class ConsultProfileError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let ready = false;
export function ensureConsultProfileSchema(): void {
  if (ready) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS ${CONSULT_PROFILE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('first_call','edit','backfill')),
      qualification_id INTEGER,
      data_json TEXT NOT NULL,
      changed_fields_json TEXT,
      actor_user_id INTEGER,
      actor_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consult_profile_customer ON ${CONSULT_PROFILE_TABLE}(customer_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consult_profile_qualification
      ON ${CONSULT_PROFILE_TABLE}(qualification_id) WHERE qualification_id IS NOT NULL;
  `);
  ready = true;
}
function tableExists(): boolean {
  return Boolean(queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [CONSULT_PROFILE_TABLE]));
}

const TRI = ["yes", "no", "unknown"];
const URGENCY = ["now", "month", "later", "curious"];
const RANKS: readonly string[] = [...CREDIT_SUBGRADES, "unknown"];
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One version's data from a stored first-call answers object (team_sales_qualifications.answers_json, formVersion 2). */
export function dataFromAnswers(a: Record<string, unknown>, extra: {
  selectedPlans?: unknown; noPlanFit?: unknown; noPlanNote?: unknown; createdAt: string; submitterName: string | null;
}): ConsultProfileData {
  const guarantor = str(a.guarantorAvailable);
  const selected = Array.isArray(extra.selectedPlans) ? extra.selectedPlans : [];
  return {
    jobType: str(a.jobType), guarantorAvailable: guarantor,
    guarantorCheque: guarantor === "yes" ? str(a.guarantorCheque) : null,
    creditRank: str(a.creditRank), gRank: guarantor === "yes" ? str(a.gRank) : null,
    gJobType: guarantor === "yes" ? str(a.gJobType) : null,
    military: str(a.military), city: str(a.city),
    selectedPlans: selected.filter((p) => p && typeof p === "object").map((p) => {
      const o = p as Record<string, unknown>;
      return { id: Number(o.id), name: String(o.name ?? ""), status: o.status == null ? null : String(o.status) };
    }),
    noPlanFit: extra.noPlanFit === true || Number(extra.noPlanFit) === 1,
    noPlanNote: str(extra.noPlanNote),
    urgency: str(a.urgency), formDate: extra.createdAt, submitterName: extra.submitterName,
  };
}

/** Called inside submitQualification's transaction for an answered first-call form. */
export function recordFirstCallVersion(customerId: number, qualificationId: number, actor: { id: number; fullName?: string | null },
  data: ConsultProfileData, at: string): number {
  ensureConsultProfileSchema();
  return execute(
    `INSERT INTO ${CONSULT_PROFILE_TABLE} (customer_id, source, qualification_id, data_json, changed_fields_json, actor_user_id, actor_name, created_at)
     VALUES (?, 'first_call', ?, ?, NULL, ?, ?, ?)`,
    [customerId, qualificationId, JSON.stringify(data), actor.id, data.submitterName ?? actor.fullName ?? null, at]);
}

type VersionRow = { id: number; source: string; qualification_id: number | null; data_json: string; changed_fields_json: string | null;
  actor_user_id: number | null; actor_name: string | null; created_at: string };
function parseVersion(r: VersionRow) {
  let data: ConsultProfileData | null = null;
  try { data = JSON.parse(r.data_json); } catch { data = null; }
  let changed: string[] = [];
  try { changed = r.changed_fields_json ? JSON.parse(r.changed_fields_json) : []; } catch { changed = []; }
  return { id: Number(r.id), source: r.source, qualificationId: r.qualification_id == null ? null : Number(r.qualification_id),
    data, changedFields: changed, actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id), actorName: r.actor_name,
    createdAt: r.created_at };
}

/** Official grade: latest generated ICS24 report not invalidated by an identity change (rank from the score, never the label). */
export function officialGrade(customerId: number): { rank: string; checkedAt: string } | null {
  try {
    const row = queryRow<{ score: number | null; completed_at: string | null; created_at: string }>(
      `SELECT checks.score, checks.completed_at, checks.created_at FROM customer_credit_checks checks
       JOIN customers c ON c.id=checks.customer_id
       WHERE checks.customer_id=? AND checks.status='report_generated'
         AND (c.identity_changed_at IS NULL OR (checks.created_at>c.identity_changed_at AND COALESCE(checks.completed_at,checks.created_at)>c.identity_changed_at))
       ORDER BY COALESCE(checks.completed_at,checks.created_at) DESC, checks.id DESC LIMIT 1`, [customerId]);
    const rank = row ? creditRankForScore(row.score) : null;
    return row && rank ? { rank, checkedAt: row.completed_at ?? row.created_at } : null;
  } catch { return null; }
}

export function consultProfile(customerId: number) {
  const versions = tableExists()
    ? queryRows<VersionRow>(`SELECT * FROM ${CONSULT_PROFILE_TABLE} WHERE customer_id=? ORDER BY id DESC`, [customerId]).map(parseVersion)
    : [];
  return { latest: versions[0] ?? null, versions, official: officialGrade(customerId) };
}

/** Latest stored profile for plan matching in the wizard / portal (null = nothing known). Read-only. */
export function latestConsultApplicantProfile(customerId: number): ApplicantProfile | null | undefined {
  if (!tableExists()) return undefined;
  const row = queryRow<{ data_json: string }>(`SELECT data_json FROM ${CONSULT_PROFILE_TABLE} WHERE customer_id=? ORDER BY id DESC LIMIT 1`, [customerId]);
  if (!row) return undefined;
  try { return cleanProfile(JSON.parse(row.data_json) ?? {}); } catch { return undefined; }
}

function validateEdit(patch: Record<string, unknown>): Partial<Record<EditableField, string | null>> {
  const out: Partial<Record<EditableField, string | null>> = {};
  for (const [k, raw] of Object.entries(patch)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) throw new ConsultProfileError(400, `فیلد «${k}» قابل ویرایش نیست.`);
    const v = raw == null || raw === "" ? null : raw;
    if (v != null && typeof v !== "string") throw new ConsultProfileError(400, `مقدار «${k}» معتبر نیست.`);
    const ok = v == null || ({
      jobType: [...JOB_CODES, "unknown"], gJobType: [...JOB_CODES, "unknown"], military: [...MILITARY_STATUSES],
      guarantorAvailable: TRI, guarantorCheque: TRI, creditRank: RANKS, gRank: RANKS, urgency: URGENCY,
    } as Record<string, readonly string[]>)[k]?.includes(v) !== false;
    if (k === "city" && v != null && [...v.trim()].length > 60) throw new ConsultProfileError(400, "شهر حداکثر ۶۰ نویسه است.");
    if (!ok) throw new ConsultProfileError(400, `مقدار «${k}» معتبر نیست.`);
    out[k as EditableField] = k === "city" && v != null ? v.trim().replace(/\s+/g, " ") || null : (v as string | null);
  }
  return out;
}

/**
 * Edit = a new version (latest values + the patch); the previous version stays untouched.
 * Access (checked by the route): the customer is visible to the user (existing scoping) and the user is
 * admin, registrar or the customer's own salesperson.
 */
export function editConsultProfile(customerId: number, actor: { id: number; fullName?: string | null }, patch: Record<string, unknown>,
  now = new Date()) {
  ensureConsultProfileSchema();
  const clean = validateEdit(patch ?? {});
  const current = consultProfile(customerId).latest;
  if (!current?.data) throw new ConsultProfileError(404, "برای این مشتری هنوز اطلاعات مشاوره‌ای ثبت نشده است.");
  const next: ConsultProfileData = { ...current.data };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(clean) as [EditableField, string | null][]) {
    if ((next[k] ?? null) !== v) { (next as Record<string, unknown>)[k] = v; changed.push(k); }
  }
  if (next.guarantorAvailable !== "yes") {
    for (const k of ["guarantorCheque", "gRank", "gJobType"] as const) if (next[k] != null) { next[k] = null; if (!changed.includes(k)) changed.push(k); }
  }
  if (!changed.length) throw new ConsultProfileError(400, "تغییری ثبت نشد.");
  const id = execute(
    `INSERT INTO ${CONSULT_PROFILE_TABLE} (customer_id, source, qualification_id, data_json, changed_fields_json, actor_user_id, actor_name, created_at)
     VALUES (?, 'edit', NULL, ?, ?, ?, ?, ?)`,
    [customerId, JSON.stringify(next), JSON.stringify(changed), actor.id, actor.fullName ?? null, now.toISOString()]);
  return { id, changed, profile: consultProfile(customerId) };
}

/**
 * 14:51 role rule shared by the «اطلاعات مشاوره» edit and the quick-credit national-code save:
 * admin, registrar, or the customer's own salesperson. (Visibility is checked separately with the existing getCustomer scoping.)
 */
export function canActOnCustomerProfile(user: { role: string; salespersonId: number | null }, customerSalespersonId: number | null,
  isAdmin: (role: string) => boolean): boolean {
  if (isAdmin(user.role) || user.role === "registrar") return true;
  return user.salespersonId != null && customerSalespersonId != null && Number(user.salespersonId) === Number(customerSalespersonId);
}

/** Additive log of national-code replacements made from the quick-credit section (old value kept, never deleted). */
export const IDENTITY_LOG_TABLE = "customer_national_code_changes";
export function ensureIdentityLogSchema(): void {
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS ${IDENTITY_LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      old_national_code TEXT,
      new_national_code TEXT NOT NULL,
      identity_changed INTEGER NOT NULL,
      source TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_national_code_changes_customer ON ${IDENTITY_LOG_TABLE}(customer_id, id DESC);
  `);
}
