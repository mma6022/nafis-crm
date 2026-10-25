/**
 * Team-sales model (qualifier Kazemi -> closers Hasani/Ghasemi), server side.
 * Inert unless notification_settings.team_sales_config has {"enabled":true}.
 * Priority-history logging (customer_priority_history) is always on: it is additive and invisible.
 * Never sends SMS (customers or staff): closer reminders are in-app only (reminder_sms_deliveries pre-marked).
 */
import { callNoteError } from "./call-note-rule";
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import {
  addWorkingHours, computeLeadPriority, evaluatePlans, isFirstCallForm, matchesFromEvaluation, matchPlans, mergeTeamSalesConfig,
  normalizeFirstCallAnswers, planReasonText, plansFromRows, validateAnswers, type LegacyRankRef,
  type LeadOutcome, type PlanEvaluation, type PlanMatch, type QualifierAnswers, type TeamSalesConfig,
} from "./team-sales-rules";
import { cleanProfile, type ApplicantProfile } from "./plan-profile-match";
import { consultProfile, dataFromAnswers, latestConsultApplicantProfile, officialGrade, recordFirstCallVersion, recordFirstCallEditVersion } from "./consult-profile";

export const TEAM_SALES_CONFIG_KEY = "team_sales_config";
export const TEAM_SALES_CURSOR_KEY = "team_sales_closer_cursor";

let schemaReady = false;
export function ensureTeamSalesSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS customer_priority_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      old_priority INTEGER,
      new_priority INTEGER,
      old_salesperson_id INTEGER,
      new_salesperson_id INTEGER,
      actor_user_id INTEGER,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customer_priority_history_customer
      ON customer_priority_history(customer_id, id DESC);
    CREATE TABLE IF NOT EXISTS team_sales_qualifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      call_log_id INTEGER,
      call_result TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      matches_json TEXT NOT NULL,
      priority INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      score INTEGER,
      reasons_json TEXT NOT NULL,
      next_action_at TEXT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_sales_qualifications_customer
      ON team_sales_qualifications(customer_id, id DESC);
  `);
  ensureSelectedPlansColumn();
  ensureNoPlanColumns();
  schemaReady = true;
}

/**
 * crm-call-form-plans (additive): plans Kazemi picked in the first-call form, snapshotted at submit time
 * ([{id,name,bank,max,status,conditionId,reasons}]). NULL for older rows / forms. Rollback: scripts/call-form-plans-rollback.mjs.
 */
export function ensureSelectedPlansColumn(): void {
  const cols = queryRows<{ name: string }>("SELECT name FROM pragma_table_info('team_sales_qualifications')");
  if (cols.length && !cols.some((c) => c.name === "selected_plans_json"))
    crmDb.exec("ALTER TABLE team_sales_qualifications ADD COLUMN selected_plans_json TEXT");
}

/**
 * crm-no-plan-option (additive): «هیچ طرحی به این مشتری نمی‌خوره» on the first-call form (1 = chosen, NULL otherwise)
 * and its optional short «چرا؟» note. Rollback: scripts/no-plan-option-rollback.mjs.
 */
export function ensureNoPlanColumns(): void {
  const cols = queryRows<{ name: string }>("SELECT name FROM pragma_table_info('team_sales_qualifications')");
  if (!cols.length) return;
  if (!cols.some((c) => c.name === "no_plan_fit")) crmDb.exec("ALTER TABLE team_sales_qualifications ADD COLUMN no_plan_fit INTEGER");
  if (!cols.some((c) => c.name === "no_plan_note")) crmDb.exec("ALTER TABLE team_sales_qualifications ADD COLUMN no_plan_note TEXT");
}
export const NO_PLAN_NOTE_MAX = 200;

export function getTeamSalesConfig(): TeamSalesConfig {
  const row = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [TEAM_SALES_CONFIG_KEY]);
  if (!row) return mergeTeamSalesConfig(null);
  try { return mergeTeamSalesConfig(JSON.parse(row.value)); } catch { return mergeTeamSalesConfig(null); }
}

export type PriorityChange = {
  customerId: number; oldPriority: number | null; newPriority: number | null;
  oldSalespersonId: number | null; newSalespersonId: number | null;
  actorUserId: number | null; source: "customer_update" | "promote" | "qualifier_form" | "no_answer_archive" | "first_call_edit";
  reason?: string | null; at?: string; always?: boolean;
};
export function logPriorityChange(c: PriorityChange): void {
  ensureTeamSalesSchema();
  if (!c.always && c.oldPriority === c.newPriority && c.oldSalespersonId === c.newSalespersonId) return;
  execute(
    `INSERT INTO customer_priority_history
     (customer_id, old_priority, new_priority, old_salesperson_id, new_salesperson_id, actor_user_id, source, reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [c.customerId, c.oldPriority, c.newPriority, c.oldSalespersonId, c.newSalespersonId, c.actorUserId,
      c.source, c.reason ?? null, c.at ?? new Date().toISOString()],
  );
}

export function priorityHistory(customerId: number) {
  ensureTeamSalesSchema();
  return queryRows<Record<string, unknown>>(
    `SELECT h.id, h.old_priority AS oldPriority, h.new_priority AS newPriority,
            h.old_salesperson_id AS oldSalespersonId, h.new_salesperson_id AS newSalespersonId,
            h.actor_user_id AS actorUserId, u.full_name AS actorName, h.source, h.reason, h.created_at AS createdAt
     FROM customer_priority_history h LEFT JOIN users u ON u.id = h.actor_user_id
     WHERE h.customer_id = ? ORDER BY h.id DESC LIMIT 200`, [customerId]);
}

/** Round-robin over active closers. Must run inside a write transaction. */
export function nextCloserSalespersonId(cfg: TeamSalesConfig): number {
  const active = new Set(queryRows<{ id: number }>(
    `SELECT id FROM salespersons WHERE active=1 AND id IN (${cfg.closerSalespersonIds.map(() => "?").join(",")})`,
    cfg.closerSalespersonIds).map((r) => Number(r.id)));
  const order = cfg.closerSalespersonIds.filter((id) => active.has(id));
  if (!order.length) throw new TeamSalesError(409, "هیچ کارشناس پیگیری فعالی تعریف نشده است.");
  const raw = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [TEAM_SALES_CURSOR_KEY]);
  const counter = Math.max(0, Number.parseInt(raw?.value ?? "0", 10) || 0);
  const chosen = order[counter % order.length];
  execute(
    `INSERT INTO notification_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [TEAM_SALES_CURSOR_KEY, String(counter + 1), new Date().toISOString()]);
  return chosen;
}

export class TeamSalesError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Actor = { id: number; role: string; salespersonId: number | null; fullName: string | null };

type CustomerState = { id: number; name: string; salesperson_id: number | null; priority: number | null;
  status: string; merged_into_customer_id: number | null };

function loadCustomer(id: number): CustomerState {
  const c = queryRow<CustomerState>(
    "SELECT id, name, salesperson_id, priority, status, merged_into_customer_id FROM customers WHERE id=?", [id]);
  if (!c || c.merged_into_customer_id != null) throw new TeamSalesError(404, "Customer not found");
  return c;
}

function assertQualifierAccess(actor: Actor, c: CustomerState, cfg: TeamSalesConfig) {
  if (!cfg.enabled) throw new TeamSalesError(404, "Team sales is not enabled");
  const isAdmin = actor.role === "admin";
  if (!isAdmin && actor.salespersonId !== cfg.qualifierSalespersonId)
    throw new TeamSalesError(403, "فقط کارشناس تماس اول یا مدیر می‌تواند این کار را انجام دهد.");
  if (!isAdmin && Number(c.salesperson_id) !== cfg.qualifierSalespersonId)
    throw new TeamSalesError(404, "Customer not found");
  if (c.status !== "in_progress") throw new TeamSalesError(409, "فقط پرونده‌های در جریان قابل ارتقا هستند.");
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
const WEEKDAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const TEHRAN_OFFSET_MS = 210 * 60 * 1000;
/** "امروز ۱۳:۱۵" / "فردا ۹:۳۰" / "شنبه ۱۱:۰۰" in Tehran wall-clock. */
export function formatDue(due: Date, now: Date): string {
  const d = new Date(due.getTime() + TEHRAN_OFFSET_MS), n = new Date(now.getTime() + TEHRAN_OFFSET_MS);
  const day = (x: Date) => Math.floor(x.getTime() / 86400000);
  const hm = `${fa(d.getUTCHours())}:${fa(String(d.getUTCMinutes()).padStart(2, "0"))}`;
  const diff = day(d) - day(n);
  return `${diff === 0 ? "امروز" : diff === 1 ? "فردا" : WEEKDAYS[d.getUTCDay()]} ${hm}`;
}
/** "آقای کاظمی" -> "کاظمی" for short labels. */
export const shortName = (name: string) => name.replace(/^(آقای|خانم)\s+/, "").trim();

function ensureReminderSmsTable() {
  // Same DDL as reminder-sms-core (idempotent); lets us mark a reminder as in-app only.
  crmDb.exec(`CREATE TABLE IF NOT EXISTS reminder_sms_deliveries (
      reminder_id INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
      status TEXT NOT NULL, claim_token TEXT, attempted_at TEXT,
      next_attempt_at TEXT, sent_at TEXT, provider_id TEXT, error_code TEXT
    )`);
}

export type PromoteResult = {
  customerId: number; closerSalespersonId: number; closerName: string; dueAt: string; dueLabel: string;
  reminderId: number | null; callLogId: number; notificationId: number | null; message: string;
};

/**
 * Inside ONE write transaction: priority=1 + next closer (round-robin) + history call_log
 * «ارتقا به اولویت ۱ توسط …» + one p1_assigned bell event for the closer + in-app reminder (no SMS) + history row.
 */
function promoteInTx(c: CustomerState, actor: Actor, cfg: TeamSalesConfig, source: PriorityChange["source"],
  reason: string | null, now: Date, note: string | null = null): PromoteResult {
  const closer = nextCloserSalespersonId(cfg);
  const nowIso = now.toISOString();
  const preMax = Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0);
  const changed = executeChanges(
    "UPDATE customers SET priority=1, salesperson_id=? WHERE id=? AND salesperson_id IS ? AND status='in_progress'",
    [closer, c.id, c.salesperson_id]);
  if (changed !== 1) throw new TeamSalesError(409, "پرونده همزمان تغییر کرد؛ دوباره تلاش کنید.");
  const nameOf = (id: number | null) => id == null ? null : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [id])?.name ?? null;
  const qualifierName = nameOf(cfg.qualifierSalespersonId) ?? "کارشناس تماس اول";
  const actorName = (actor.salespersonId != null ? nameOf(actor.salespersonId) : null) ?? actor.fullName ?? qualifierName;
  const closerName = nameOf(closer) ?? "کارشناس پیگیری";
  const due = addWorkingHours(now, cfg.closerFirstCallWorkingHours, cfg);
  const dueAt = due.toISOString();
  const dueLabel = formatDue(due, now);
  const prev = c.priority == null ? "بدون اولویت" : `اولویت ${fa(c.priority)}`;
  const fromForm = source === "qualifier_form";

  // Timeline row (shows in «خط زمانی ارتباط»).
  const callLogId = execute(
    `INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [c.id, actor.salespersonId ?? null, `ارتقا به اولویت ۱ توسط ${shortName(actorName)}`, null,
      [`واگذاری به ${closerName} (نوبت چرخشی) — قبلاً ${prev}${fromForm ? " — از فرم تماس اول" : ""}`,
        `مهلت تماس ${closerName}: ${fa(cfg.closerFirstCallWorkingHours)} ساعت کاری (تا ${dueLabel})`,
        note ? `یادداشت: ${note}` : null].filter(Boolean).join("\n"),
      nowIso, actorName]);

  // Exactly one bell event for the closer: reuse the customers-UPDATE trigger row, drop the call_logs one.
  const title = `مشتری اولویت ۱ جدید: ${c.name}`;
  const body = `${fromForm ? `از فرم تماس اول ${actorName}` : `ارتقا توسط ${actorName}`} — مهلت تماس تا ${dueLabel}`;
  const triggered = queryRows<{ id: number; resource_type: string }>(
    "SELECT id, resource_type FROM site_notification_events WHERE id>? AND customer_id=? ORDER BY id", [preMax, c.id]);
  const keep = triggered.find((e) => e.resource_type === "customer");
  const drop = triggered.filter((e) => e !== keep).map((e) => Number(e.id));
  if (drop.length) executeChanges(`DELETE FROM site_notification_events WHERE id IN (${drop.map(() => "?").join(",")})`, drop);
  let notificationId: number | null = null;
  if (keep) {
    executeChanges("UPDATE site_notification_events SET kind='p1_assigned', title=?, body=?, owner_id=? WHERE id=?",
      [title, body, closer, keep.id]);
    notificationId = Number(keep.id);
  } else {
    notificationId = execute(
      `INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at)
       VALUES (?,?,?,'customer',?,'p1_assigned',?,?,'customers.view',?)`,
      [c.id, c.name, closer, c.id, title, body, nowIso]);
  }

  // Older events of this customer become visible to the closer (scope = current owner): mark them read for them.
  const closerUser = queryRow<{ id: number }>(
    `SELECT id FROM users WHERE salesperson_id=? AND active=1 ORDER BY (role='salesperson') DESC, id LIMIT 1`, [closer]);
  if (closerUser && queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_notification_reads'")) {
    executeChanges(
      `INSERT OR IGNORE INTO site_notification_reads(user_id,event_id,read_at)
       SELECT ?, id, ? FROM site_notification_events WHERE customer_id=? AND id<=?`,
      [closerUser.id, nowIso, c.id, preMax]);
  }

  // In-app reminder at the deadline. SMS is explicitly disabled for it (delivery row pre-marked; worker skips it).
  let reminderId: number | null = null;
  if (closerUser) {
    reminderId = execute(
      `INSERT INTO reminders (user_id, salesperson_id, customer_id, subject, message, remind_at, sent_sms, done, created_at, call_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [closerUser.id, closer, c.id, "تماس با مشتری اولویت ۱",
        `${c.name}: ارتقا به اولویت ۱ توسط ${actorName}. مهلت اولین تماس: ${fa(cfg.closerFirstCallWorkingHours)} ساعت کاری.${note ? `\n${note}` : ""}`,
        dueAt, nowIso, callLogId]);
    ensureReminderSmsTable();
    execute(
      `INSERT INTO reminder_sms_deliveries (reminder_id, status, error_code) VALUES (?, 'rejected', 'in_app_only')
       ON CONFLICT(reminder_id) DO UPDATE SET status='rejected', error_code='in_app_only'`, [reminderId]);
  }
  logPriorityChange({ customerId: c.id, oldPriority: c.priority, newPriority: 1, oldSalespersonId: c.salesperson_id,
    newSalespersonId: closer, actorUserId: actor.id, source, reason: [reason, note].filter(Boolean).join(" — ") || null, at: nowIso });
  return { customerId: c.id, closerSalespersonId: closer, closerName, dueAt, dueLabel, reminderId, callLogId, notificationId,
    message: `به ${closerName} واگذار شد` };
}

/** Name of the closer whose turn is next, without reserving it. */
export function peekNextCloser(): { salespersonId: number; name: string } | null {
  const cfg = getTeamSalesConfig();
  const active = new Set(queryRows<{ id: number }>(
    `SELECT id FROM salespersons WHERE active=1 AND id IN (${cfg.closerSalespersonIds.map(() => "?").join(",")})`,
    cfg.closerSalespersonIds).map((r) => Number(r.id)));
  const order = cfg.closerSalespersonIds.filter((id) => active.has(id));
  if (!order.length) return null;
  const raw = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [TEAM_SALES_CURSOR_KEY]);
  const id = order[(Math.max(0, Number.parseInt(raw?.value ?? "0", 10) || 0)) % order.length];
  return { salespersonId: id, name: queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [id])?.name ?? "" };
}

export function promoteToPriorityOne(customerId: number, actor: Actor, note: string | null = null, now = new Date()) {
  ensureTeamSalesSchema();
  const cfg = getTeamSalesConfig();
  return runImmediateTransaction(() => {
    const c = loadCustomer(customerId);
    assertQualifierAccess(actor, c, cfg);
    if (c.priority === 1) throw new TeamSalesError(409, "این مشتری از قبل اولویت ۱ است.");
    return promoteInTx(c, actor, cfg, "promote", null, now, note);
  });
}

function activePlans(): ReturnType<typeof plansFromRows> {
  const plans = queryRows<Record<string, unknown>>("SELECT * FROM loan_plans WHERE active=1 ORDER BY id");
  const conds = queryRows<Record<string, unknown>>("SELECT * FROM loan_plan_conditions ORDER BY plan_id, sort_order, id");
  return plansFromRows(plans, conds);
}

function consecutiveNoAnswers(customerId: number): number {
  const rows = queryRows<{ call_result: string }>(
    "SELECT call_result FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC LIMIT 20", [customerId]);
  let n = 0;
  for (const r of rows) { if (r.call_result !== "no_answer") break; n++; }
  return n;
}

/** The customer's latest recorded grades: a retired A–E letter is accepted only when it repeats one of these unchanged. */
function legacyRanks(customerId: number): LegacyRankRef {
  const rows = queryRows<{ answers_json: string }>(
    "SELECT answers_json FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC LIMIT 20", [customerId]);
  const out: LegacyRankRef = {};
  for (const row of rows) {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(row.answers_json) ?? {}; } catch { continue; }
    if (out.creditRank === undefined && typeof a.creditRank === "string" && a.creditRank) out.creditRank = a.creditRank;
    if (out.gRank === undefined && typeof a.gRank === "string" && a.gRank) out.gRank = a.gRank;
  }
  return out;
}

/** Automatic matching that drives the priority: the first-call form uses the evaluator (fit + depends), older forms matchPlans. */
function autoMatches(answers: QualifierAnswers, plans: ReturnType<typeof plansFromRows>): { matches: PlanMatch[]; evals: PlanEvaluation[] } {
  if (answers.callResult !== "answered") return { matches: [], evals: [] };
  if (!isFirstCallForm(answers)) return { matches: matchPlans(answers, plans), evals: [] };
  const evals = evaluatePlans(answers, plans);
  return { matches: matchesFromEvaluation(evals), evals };
}

/**
 * crm-no-plan-option (14:51): plan matching uses the OFFICIAL grade when an inquiry report exists (not invalidated by an
 * identity change); the customer's declared grade stays in the stored answers («اظهار مشتری»).
 */
function withOfficialGrade(customerId: number, answers: QualifierAnswers): QualifierAnswers {
  if (!isFirstCallForm(answers) || answers.callResult !== "answered") return answers;
  const official = officialGrade(customerId);
  return official ? { ...answers, creditRank: official.rank } : answers;
}

/** Step 5 of the first-call form: every active plan with status fit|depends|no and structured reasons. No writes. */
export function planOptions(customerId: number, answers: QualifierAnswers, now = new Date()) {
  ensureTeamSalesSchema();
  const err = validateAnswers(answers, now, legacyRanks(customerId), { forPlans: true });
  if (err) throw new TeamSalesError(400, err);
  const plans = evaluatePlans(withOfficialGrade(customerId, answers), activePlans());
  // crm-no-plan-option: the form pre-checks «هیچ طرحی نمی‌خوره» when no plan is fit or depends.
  return { plans, noPlanDefault: !plans.some((p) => p.status !== "no") };
}

export type SelectedPlanSnapshot = {
  id: number; name: string; bank: string; max: number; status: "fit" | "depends";
  conditionId: number | string; reasons: string[];
};
function selectedSnapshot(selected: unknown, evals: PlanEvaluation[]): SelectedPlanSnapshot[] {
  if (selected == null) return [];
  if (!Array.isArray(selected)) throw new TeamSalesError(400, "فهرست طرح‌های انتخاب‌شده نامعتبر است.");
  const ids = [...new Set(selected.map((v) => Number(v)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new TeamSalesError(400, "فهرست طرح‌های انتخاب‌شده نامعتبر است.");
  if (ids.length > 50) throw new TeamSalesError(400, "تعداد طرح‌های انتخاب‌شده زیاد است.");
  return ids.map((id) => {
    const e = evals.find((x) => x.planId === id);
    if (!e) throw new TeamSalesError(400, "طرح انتخاب‌شده فعال نیست یا وجود ندارد.");
    if (e.status === "no") throw new TeamSalesError(400, `طرح «${e.planName}» با جواب‌های این تماس مناسب نیست و قابل انتخاب نیست.`);
    return { id: e.planId, name: e.planName, bank: e.bankName, max: e.max, status: e.status, conditionId: e.conditionId,
      reasons: e.reasons.filter((r) => r.kind === "unknown").map(planReasonText) };
  });
}

/** crm-no-plan-option: customers whose latest answered first-call form chose «هیچ طرحی نمی‌خوره» (grey list chip). */
export function latestNoPlanFit(customerIds: number[]): Set<number> {
  const out = new Set<number>();
  const ids = [...new Set(customerIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return out;
  ensureTeamSalesSchema();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = queryRows<{ customer_id: number }>(
      `SELECT q.customer_id FROM team_sales_qualifications q
       WHERE q.no_plan_fit=1 AND q.id IN (SELECT MAX(id) FROM team_sales_qualifications
                      WHERE call_result='answered' AND customer_id IN (${chunk.map(() => "?").join(",")}) GROUP BY customer_id)`, chunk);
    for (const r of rows) out.add(Number(r.customer_id));
  }
  return out;
}

/**
 * crm-no-plan-option: applicant job / guarantor job / military answers of the latest answered first-call form, used by the
 * request wizard and the portal so they rule plans out exactly like the form. null = nothing known (no change at all).
 * Read-only: does not create the table when it does not exist.
 */
export function latestApplicantProfile(customerId: number): ApplicantProfile | null {
  try {
    // 14:51: the «اطلاعات مشاوره» history (incl. later edits) wins when it exists.
    const stored = latestConsultApplicantProfile(customerId);
    if (stored !== undefined) {
      const known = (v: unknown) => v != null && v !== "unknown";
      return stored && (known(stored.jobType) || known(stored.gJobType) || known(stored.military)) ? stored : null;
    }
    const row = queryRow<{ answers_json: string }>(
      `SELECT answers_json FROM team_sales_qualifications WHERE customer_id=? AND call_result='answered' ORDER BY id DESC LIMIT 1`, [customerId]);
    if (!row) return null;
    const a = JSON.parse(row.answers_json) ?? {};
    if (a.formVersion !== 2) return null;
    const p = cleanProfile(a);
    const known = (v: unknown) => v != null && v !== "unknown";
    return known(p.jobType) || known(p.gJobType) || known(p.military) ? p : null;
  } catch { return null; }
}

/** City autocomplete for the first-call form: existing customer city values (no province/city list exists in the CRM). */
export function citySuggestions(query: string, limit = 12): string[] {
  const q = String(query ?? "").trim().slice(0, 40);
  try {
    return queryRows<{ city: string }>(
      `SELECT city, COUNT(*) AS n FROM customers WHERE city IS NOT NULL AND trim(city)<>'' ${q ? "AND city LIKE ? ESCAPE '\\'" : ""}
       GROUP BY city ORDER BY n DESC, city LIMIT ?`,
      q ? [`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, limit] : [limit]).map((r) => r.city);
  } catch { return []; }
}

/** Latest first-call selection per customer (for the list column / case box). */
export function latestSelectedPlans(customerIds: number[]): Map<number, SelectedPlanSnapshot[]> {
  const out = new Map<number, SelectedPlanSnapshot[]>();
  const ids = [...new Set(customerIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return out;
  ensureTeamSalesSchema();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = queryRows<{ customer_id: number; selected_plans_json: string | null }>(
      `SELECT q.customer_id, q.selected_plans_json FROM team_sales_qualifications q
       WHERE q.id IN (SELECT MAX(id) FROM team_sales_qualifications
                      WHERE call_result='answered' AND customer_id IN (${chunk.map(() => "?").join(",")}) GROUP BY customer_id)`, chunk);
    for (const r of rows) {
      const list = parseSelected(r.selected_plans_json);
      if (list.length) out.set(Number(r.customer_id), list);
    }
  }
  return out;
}
function parseSelected(raw: string | null): SelectedPlanSnapshot[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** The latest answered first-call form of a customer (case page: selected plans + «خلاصه‌ی تماس اول»). */
export function latestFirstCall(customerId: number) {
  ensureTeamSalesSchema();
  const row = queryRow<{ id: number; answers_json: string; selected_plans_json: string | null; note: string; created_at: string;
    priority: number; actor_name: string | null; sp_name: string | null; no_plan_fit: number | null; no_plan_note: string | null }>(
    `SELECT q.id, q.answers_json, q.selected_plans_json, q.note, q.created_at, q.priority, q.no_plan_fit, q.no_plan_note,
            u.full_name AS actor_name, s.name AS sp_name
     FROM team_sales_qualifications q LEFT JOIN users u ON u.id=q.actor_user_id LEFT JOIN salespersons s ON s.id=u.salesperson_id
     WHERE q.customer_id=? AND q.call_result='answered' ORDER BY q.id DESC LIMIT 1`, [customerId]);
  if (!row) return null;
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(row.answers_json) ?? {}; } catch { /* keep empty */ }
  if (a.formVersion !== 2) return null;
  const pick = (k: string) => (a[k] == null ? null : a[k]);
  return {
    id: Number(row.id), createdAt: row.created_at, priority: Number(row.priority) || null, note: row.note,
    actorName: row.sp_name ?? row.actor_name ?? null, selectedPlans: parseSelected(row.selected_plans_json),
    noPlanFit: Number(row.no_plan_fit) === 1, noPlanNote: row.no_plan_note ?? null,
    answers: {
      amountMillion: pick("amountMillion"), docsReady: pick("docsReady"), urgency: pick("urgency"), creditRank: pick("creditRank"),
      checkStatus: pick("checkStatus"), canPromissory: pick("canPromissory"), bouncedCheque: pick("bouncedCheque"),
      guarantorAvailable: pick("guarantorAvailable"), guarantorCheque: pick("guarantorCheque"), gRank: pick("gRank"),
      military: pick("military"), jobType: pick("jobType"), gJobType: pick("gJobType"), city: pick("city"),
    },
  };
}

/** Preview only: no writes. */
export function previewQualification(customerId: number, answers: QualifierAnswers, now = new Date()) {
  ensureTeamSalesSchema();
  const cfg = getTeamSalesConfig();
  const err = validateAnswers(answers, now, legacyRanks(customerId));
  if (err) throw new TeamSalesError(400, err);
  const { matches } = autoMatches(withOfficialGrade(customerId, isFirstCallForm(answers) ? normalizeFirstCallAnswers(answers) : answers), activePlans());
  return { result: computeLeadPriority(answers, matches, consecutiveNoAnswers(customerId), now, cfg), matches: matches.slice(0, 5) };
}

const CALL_SUBJECT: Record<string, string> = {
  answered: "تماس اولیه", no_answer: "تماس اولیه — بی‌پاسخ", callback: "تماس اولیه — تماس بعدی", wrong_number: "تماس اولیه — شماره اشتباه",
};

/**
 * Kazemi's form submit. Server recomputes priority; note is required (>= noteMinLength chars).
 * Writes: call_logs (a real call), team_sales_qualifications, priority (+history).
 * P1 -> handoff to next closer (round-robin) with reminder. No-answer 1..2 -> no priority, counter only
 * (team_sales_qualifications.priority stores 0 = "none" because the column is NOT NULL). 3x no-answer -> status cancelled.
 */
export function submitQualification(customerId: number, actor: Actor, rawAnswers: QualifierAnswers, note: string, now = new Date(),
  selectedPlans: unknown = null, noPlanNote: unknown = null) {
  ensureTeamSalesSchema();
  const cfg = getTeamSalesConfig();
  const err = validateAnswers(rawAnswers, now, legacyRanks(customerId));
  if (err) throw new TeamSalesError(400, err);
  const firstCall = isFirstCallForm(rawAnswers);
  const answers = firstCall ? normalizeFirstCallAnswers(rawAnswers) : rawAnswers;
  if (selectedPlans != null && (!firstCall || answers.callResult !== "answered") && !(Array.isArray(selectedPlans) && !selectedPlans.length))
    throw new TeamSalesError(400, "انتخاب طرح فقط در فرم تماس اول و برای تماس پاسخ‌داده‌شده ممکن است.");
  // crm-no-plan-option: only on an answered first-call form; exclusive with selected plans; optional short note.
  const noPlanFit = firstCall && answers.callResult === "answered" && answers.noPlanFit === true;
  if (noPlanNote != null && typeof noPlanNote !== "string") throw new TeamSalesError(400, "توضیح «چرا؟» معتبر نیست.");
  const cleanNoPlanNote = noPlanFit ? String(noPlanNote ?? "").trim().replace(/\s+/g, " ") || null : null;
  if (!noPlanFit && String(noPlanNote ?? "").trim()) throw new TeamSalesError(400, "توضیح «چرا؟» فقط با گزینه‌ی «هیچ طرحی نمی‌خوره» ثبت می‌شود.");
  if (cleanNoPlanNote && [...cleanNoPlanNote].length > NO_PLAN_NOTE_MAX)
    throw new TeamSalesError(400, `توضیح «چرا؟» حداکثر ${NO_PLAN_NOTE_MAX} نویسه است.`);
  if (noPlanFit && Array.isArray(selectedPlans) && selectedPlans.length)
    throw new TeamSalesError(400, "«هیچ طرحی به این مشتری نمی‌خوره» با انتخاب طرح هم‌زمان ممکن نیست؛ یکی را بردارید.");
  const cleanNote = String(note ?? "").trim();
  const noteErr = callNoteError(cleanNote, cfg.noteMinLength);
  if (noteErr) throw new TeamSalesError(400, noteErr);
  const plans = answers.callResult === "answered" ? activePlans() : [];
  return runImmediateTransaction(() => {
    const c = loadCustomer(customerId);
    assertQualifierAccess(actor, c, cfg);
    // The first-call form decides the priority, so it is only for customers that have none yet (P1/P2/P3 use the normal call form).
    if (c.priority != null)
      throw new TeamSalesError(409, "فرم تماس اول فقط برای مشتریان بدون اولویت است؛ برای این مشتری از فرم ثبت تماس معمولی استفاده کنید.");
    const { matches, evals } = autoMatches(withOfficialGrade(c.id, answers), plans);
    const selected = firstCall && answers.callResult === "answered" ? selectedSnapshot(selectedPlans, evals) : [];
    const result: LeadOutcome = computeLeadPriority(answers, matches, consecutiveNoAnswers(customerId), now, cfg);
    // Defence in depth: the rules never return P1 for «هیچ طرحی نمی‌خوره»; never hand off automatically if they ever did.
    if (noPlanFit && result.priority === 1) throw new TeamSalesError(500, "no_plan_fit_auto_p1_blocked");
    const spName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [c.salesperson_id])?.name ?? null;
    const callLogId = execute(
      `INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.salesperson_id, CALL_SUBJECT[answers.callResult], null,
        `${cleanNote}\n\n— نتیجهٔ فرم: ${result.priority == null ? `بدون اولویت، بی‌پاسخ ${result.attempts} از ${cfg.maxNoAnswerAttempts}` : `اولویت ${result.priority}`} (${result.reasons.join("؛ ")})${
          selected.length ? `\n— طرح‌های انتخاب‌شده: ${selected.map((p) => `${p.name}${p.status === "depends" ? " (مشروط)" : ""}`).join("، ")}` : ""}${
          noPlanFit ? `\n— هیچ طرحی به این مشتری نمی‌خوره${cleanNoPlanNote ? `: ${cleanNoPlanNote}` : ""}` : ""}`,
        now.toISOString(), spName]);
    const qualificationId = execute(
      `INSERT INTO team_sales_qualifications (customer_id, actor_user_id, call_log_id, call_result, answers_json, matches_json,
        priority, outcome, score, reasons_json, next_action_at, note, created_at, selected_plans_json, no_plan_fit, no_plan_note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, actor.id, callLogId, answers.callResult, JSON.stringify(answers), JSON.stringify(matches.slice(0, 5)),
        result.priority ?? 0, result.outcome, result.score, JSON.stringify(result.reasons), result.nextActionAt, cleanNote, now.toISOString(),
        firstCall && answers.callResult === "answered" ? JSON.stringify(selected) : null, noPlanFit ? 1 : null, cleanNoPlanNote]);
    // crm-no-plan-option (14:51): the answers also go to the customer's «اطلاعات مشاوره» history (append-only).
    if (firstCall && answers.callResult === "answered") {
      const submitter = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId ?? -1])?.name
        ?? actor.fullName ?? null;
      recordFirstCallVersion(c.id, qualificationId, actor, dataFromAnswers(answers as Record<string, unknown>, {
        selectedPlans: selected, noPlanFit, noPlanNote: cleanNoPlanNote, createdAt: now.toISOString(), submitterName: submitter }), now.toISOString());
    }
    // crm-no-plan-option: city of residence goes to the customer's city only when that is still empty (never overwritten).
    const cityWritten = firstCall && answers.callResult === "answered" && answers.city
      ? executeChanges("UPDATE customers SET city=? WHERE id=? AND (city IS NULL OR trim(city)='')", [answers.city, c.id]) > 0 : false;
    const reasonText = result.reasons.join("؛ ");
    let handoff: ReturnType<typeof promoteInTx> | null = null;
    if (result.priority === 1) {
      handoff = promoteInTx(c, actor, cfg, "qualifier_form", reasonText, now);
    } else if (result.outcome === "cold_archive" || result.outcome === "invalid") {
      executeChanges("UPDATE customers SET priority=?, status='cancelled' WHERE id=?", [result.priority, c.id]);
      logPriorityChange({ customerId: c.id, oldPriority: c.priority, newPriority: result.priority,
        oldSalespersonId: c.salesperson_id, newSalespersonId: c.salesperson_id, actorUserId: actor.id,
        source: "no_answer_archive", reason: `لغو: ${reasonText}`, at: now.toISOString(), always: true });
    } else if (result.priority == null) {
      // No-answer 1..(max-1): the customer keeps NO priority (so the first-call form opens again);
      // the qualification row above is the no-answer counter. Nothing else changes.
    } else {
      executeChanges("UPDATE customers SET priority=? WHERE id=?", [result.priority, c.id]);
      logPriorityChange({ customerId: c.id, oldPriority: c.priority, newPriority: result.priority,
        oldSalespersonId: c.salesperson_id, newSalespersonId: c.salesperson_id, actorUserId: actor.id,
        source: "qualifier_form", reason: reasonText, at: now.toISOString() });
    }
    return { callLogId, result, matches: matches.slice(0, 5), handoff, selectedPlans: selected, noPlanFit, noPlanNote: cleanNoPlanNote, cityWritten };
  });
}

/* ------------------------------------------------------------------ first-call edit (crm-first-call-edit) */
/**
 * «ویرایش» on «خلاصه‌ی تماس اول»: the same wizard, prefilled. Saving is NOT a call:
 * - no call_logs row, no new team_sales_qualifications row (Kazemi's first-call P1 share is untouched: it only reads
 *   customer_priority_history rows with source qualifier_form / promote);
 * - the latest answered first-call row is updated in place and the full previous version (answers, plans, note) is kept
 *   in team_sales_first_call_edits with who / when / changed fields (old → new); «اطلاعات مشاوره» gets one 'edit' version;
 * - plans and the suggested priority are recomputed with the existing rules; the priority is only ever RAISED
 *   (P3 → P2), never lowered, never P1 automatically, never a transfer;
 * - «ذخیره و ارسال به کارشناس فروش» = the existing «ارتقا به اولویت ۱» path (promoteInTx, source 'promote').
 * Access: admin, the qualifier (team_sales_config, read only) or the customer's current owner.
 */
export const FIRST_CALL_EDIT_TABLE = "team_sales_first_call_edits";
let editSchemaReady = false;
export function ensureFirstCallEditSchema(): void {
  if (editSchemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS ${FIRST_CALL_EDIT_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      qualification_id INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      actor_name TEXT,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      changed_json TEXT NOT NULL,
      priority_before INTEGER,
      priority_suggested INTEGER,
      priority_after INTEGER,
      sent_to_closer INTEGER NOT NULL DEFAULT 0,
      promote_call_log_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_first_call_edits_customer ON ${FIRST_CALL_EDIT_TABLE}(customer_id, id DESC);
  `);
  editSchemaReady = true;
}

type FirstCallVersion = { answers: Record<string, unknown>; note: string; selectedPlanIds: number[]; selectedPlanNames: string[];
  noPlanFit: boolean; noPlanNote: string | null };
const EDIT_FIELDS = ["amountMillion", "docsReady", "creditRank", "cheque", "bouncedCheque", "military", "jobType", "city",
  "guarantorAvailable", "guarantorCheque", "gRank", "gJobType", "selectedPlans", "noPlanFit", "noPlanNote", "urgency", "note"] as const;
export type FirstCallEditField = (typeof EDIT_FIELDS)[number];
const chequeOf = (a: Record<string, unknown>) =>
  a.checkStatus && a.checkStatus !== "none" ? "check" : a.canPromissory === "yes" ? "promissory" : a.checkStatus ? "none" : null;
function fieldValue(v: FirstCallVersion, f: FirstCallEditField): unknown {
  switch (f) {
    case "cheque": return chequeOf(v.answers);
    case "selectedPlans": return v.selectedPlanNames.length ? v.selectedPlanNames : null;
    case "noPlanFit": return v.noPlanFit;
    case "noPlanNote": return v.noPlanNote;
    case "note": return v.note;
    case "amountMillion": return v.answers.amountMillion == null ? null : Number(v.answers.amountMillion);
    default: return v.answers[f] ?? null;
  }
}
function diffVersions(before: FirstCallVersion, after: FirstCallVersion) {
  const out: Array<{ field: FirstCallEditField; old: unknown; new: unknown }> = [];
  for (const f of EDIT_FIELDS) {
    const o = fieldValue(before, f), n = fieldValue(after, f);
    if (f === "selectedPlans") {
      const same = JSON.stringify([...before.selectedPlanIds].sort()) === JSON.stringify([...after.selectedPlanIds].sort());
      if (!same) out.push({ field: f, old: o, new: n });
      continue;
    }
    if (JSON.stringify(o ?? null) !== JSON.stringify(n ?? null)) out.push({ field: f, old: o ?? null, new: n ?? null });
  }
  return out;
}

export type FirstCallEditAccess = { canEdit: boolean; canSend: boolean; sendBlockedReason: string | null; ownerIsCloser: boolean };
/** Who may edit / send (the route also applies the existing getCustomer visibility scoping). */
export function firstCallEditAccess(actor: Actor, c: { salesperson_id: number | null; status: string; priority: number | null },
  cfg: TeamSalesConfig = getTeamSalesConfig()): FirstCallEditAccess {
  const isAdmin = actor.role === "admin";
  const isQualifier = actor.salespersonId != null && actor.salespersonId === cfg.qualifierSalespersonId;
  const isOwner = actor.salespersonId != null && c.salesperson_id != null && Number(actor.salespersonId) === Number(c.salesperson_id);
  const canEdit = cfg.enabled && (isAdmin || isQualifier || isOwner);
  const ownerIsCloser = c.salesperson_id != null && cfg.closerSalespersonIds.includes(Number(c.salesperson_id));
  const ownerName = c.salesperson_id == null ? null
    : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [c.salesperson_id])?.name ?? null;
  let reason: string | null = null;
  if (!canEdit) reason = "اجازه‌ی ویرایش ندارید.";
  else if (ownerIsCloser) reason = `این مشتری از قبل دست کارشناس فروش${ownerName ? ` (${ownerName})` : ""} است؛ ارسال دوباره لازم نیست.`;
  else if (!isAdmin && !isQualifier) reason = "ارسال به کارشناس فروش فقط برای کارشناس تماس اول یا مدیر است.";
  else if (Number(c.salesperson_id) !== cfg.qualifierSalespersonId)
    reason = `این مشتری دست ${ownerName ?? "کارشناس دیگری"} است، نه کارشناس تماس اول؛ ارسال از این‌جا ممکن نیست.`;
  else if (c.status !== "in_progress") reason = "فقط پرونده‌های در جریان را می‌شود به کارشناس فروش فرستاد.";
  else if (c.priority === 1) reason = "این مشتری از قبل اولویت ۱ است.";
  return { canEdit, canSend: canEdit && reason == null, sendBlockedReason: reason, ownerIsCloser };
}

export function firstCallEditHistory(customerId: number) {
  ensureFirstCallEditSchema();
  return queryRows<{ id: number; actor_name: string | null; changed_json: string; priority_before: number | null; priority_suggested: number | null;
    priority_after: number | null; sent_to_closer: number; created_at: string }>(
    `SELECT id, actor_name, changed_json, priority_before, priority_suggested, priority_after, sent_to_closer, created_at
     FROM ${FIRST_CALL_EDIT_TABLE} WHERE customer_id=? ORDER BY id DESC LIMIT 100`, [customerId]).map((r) => {
    let changed: unknown[] = [];
    try { changed = JSON.parse(r.changed_json) ?? []; } catch { changed = []; }
    return { id: Number(r.id), actorName: r.actor_name, changed, priorityBefore: r.priority_before, suggestedPriority: r.priority_suggested,
      priorityAfter: r.priority_after, sentToCloser: Number(r.sent_to_closer) === 1, createdAt: r.created_at };
  });
}

export function firstCallEditInfo(customerId: number, actor: Actor) {
  ensureTeamSalesSchema();
  const c = loadCustomer(customerId);
  return { ...firstCallEditAccess(actor, c), edits: firstCallEditHistory(customerId) };
}

export function editFirstCall(customerId: number, actor: Actor, rawAnswers: QualifierAnswers, note: string, opts: {
  selectedPlans?: unknown; noPlanNote?: unknown; send?: boolean; baseId?: unknown; noteMin?: number; now?: Date;
} = {}) {
  ensureTeamSalesSchema();
  ensureFirstCallEditSchema();
  const now = opts.now ?? new Date();
  const cfg = getTeamSalesConfig();
  if (!cfg.enabled) throw new TeamSalesError(404, "Team sales is not enabled");
  if (!rawAnswers || !isFirstCallForm(rawAnswers) || rawAnswers.callResult !== "answered")
    throw new TeamSalesError(400, "ویرایش فقط برای فرم تماس اولِ پاسخ‌داده‌شده است.");
  const err = validateAnswers(rawAnswers, now, legacyRanks(customerId));
  if (err) throw new TeamSalesError(400, err);
  const answers = normalizeFirstCallAnswers(rawAnswers);
  const noPlanFit = answers.noPlanFit === true;
  const { selectedPlans, noPlanNote } = opts;
  if (noPlanNote != null && typeof noPlanNote !== "string") throw new TeamSalesError(400, "توضیح «چرا؟» معتبر نیست.");
  const cleanNoPlanNote = noPlanFit ? String(noPlanNote ?? "").trim().replace(/\s+/g, " ") || null : null;
  if (!noPlanFit && String(noPlanNote ?? "").trim()) throw new TeamSalesError(400, "توضیح «چرا؟» فقط با گزینه‌ی «هیچ طرحی نمی‌خوره» ثبت می‌شود.");
  if (cleanNoPlanNote && [...cleanNoPlanNote].length > NO_PLAN_NOTE_MAX) throw new TeamSalesError(400, `توضیح «چرا؟» حداکثر ${NO_PLAN_NOTE_MAX} نویسه است.`);
  if (noPlanFit && Array.isArray(selectedPlans) && selectedPlans.length)
    throw new TeamSalesError(400, "«هیچ طرحی به این مشتری نمی‌خوره» با انتخاب طرح هم‌زمان ممکن نیست؛ یکی را بردارید.");
  const noteMin = opts.noteMin ?? cfg.noteMinLength;
  const cleanNote = String(note ?? "").trim();
  const noteErr = callNoteError(cleanNote, noteMin);
  if (noteErr) throw new TeamSalesError(400, noteErr);
  if (cleanNote.length > 4000) throw new TeamSalesError(400, "یادداشت تماس حداکثر ۴۰۰۰ نویسه است.");
  const plans = activePlans();
  return runImmediateTransaction(() => {
    const c = loadCustomer(customerId);
    const access = firstCallEditAccess(actor, c, cfg);
    if (!access.canEdit) throw new TeamSalesError(403, "ویرایش خلاصه‌ی تماس اول فقط برای مدیر، کارشناس تماس اول و کارشناس همین مشتری است.");
    if (opts.send && !access.canSend) throw new TeamSalesError(409, access.sendBlockedReason ?? "ارسال به کارشناس فروش ممکن نیست.");
    const base = queryRow<{ id: number; answers_json: string; selected_plans_json: string | null; note: string; no_plan_fit: number | null;
      no_plan_note: string | null; created_at: string }>(
      `SELECT id, answers_json, selected_plans_json, note, no_plan_fit, no_plan_note, created_at FROM team_sales_qualifications
       WHERE customer_id=? AND call_result='answered' ORDER BY id DESC LIMIT 1`, [c.id]);
    let baseAnswers: Record<string, unknown> = {};
    try { baseAnswers = base ? JSON.parse(base.answers_json) ?? {} : {}; } catch { baseAnswers = {}; }
    if (!base || baseAnswers.formVersion !== 2) throw new TeamSalesError(404, "فرم تماس اولی برای ویرایش پیدا نشد.");
    if (opts.baseId != null && Number(opts.baseId) !== Number(base.id))
      throw new TeamSalesError(409, "خلاصه‌ی تماس اول در این فاصله عوض شد؛ صفحه را تازه کنید و دوباره ویرایش کنید.");
    const { matches, evals } = autoMatches(withOfficialGrade(c.id, answers), plans);
    const selected = selectedSnapshot(selectedPlans ?? null, evals);
    const result = computeLeadPriority(answers, matches, 0, now, cfg);
    if (noPlanFit && result.priority === 1) throw new TeamSalesError(500, "no_plan_fit_auto_p1_blocked");
    const baseSelected = parseSelected(base.selected_plans_json);
    const before: FirstCallVersion = { answers: baseAnswers, note: base.note, selectedPlanIds: baseSelected.map((p) => Number(p.id)),
      selectedPlanNames: baseSelected.map((p) => p.name), noPlanFit: Number(base.no_plan_fit) === 1, noPlanNote: base.no_plan_note ?? null };
    const storedAnswers = { ...answers } as Record<string, unknown>;
    const after: FirstCallVersion = { answers: storedAnswers, note: cleanNote, selectedPlanIds: selected.map((p) => p.id),
      selectedPlanNames: selected.map((p) => p.name), noPlanFit, noPlanNote: cleanNoPlanNote };
    const changed = diffVersions(before, after);
    if (!changed.length && !opts.send) throw new TeamSalesError(400, "تغییری ثبت نشد.");
    const nowIso = now.toISOString();
    const actorName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId ?? -1])?.name ?? actor.fullName ?? null;
    let cityWritten = false;
    if (changed.length) {
      executeChanges(
        `UPDATE team_sales_qualifications SET answers_json=?, matches_json=?, selected_plans_json=?, no_plan_fit=?, no_plan_note=?, note=? WHERE id=?`,
        [JSON.stringify(storedAnswers), JSON.stringify(matches.slice(0, 5)), JSON.stringify(selected), noPlanFit ? 1 : null, cleanNoPlanNote, cleanNote, base.id]);
      // «اطلاعات مشاوره»: one more 'edit' version (append-only), keeping the original form date / submitter.
      const latest = consultProfile(c.id).latest?.data ?? null;
      const data = dataFromAnswers(storedAnswers, { selectedPlans: selected, noPlanFit, noPlanNote: cleanNoPlanNote,
        createdAt: latest?.formDate ?? base.created_at, submitterName: latest?.submitterName ?? null });
      recordFirstCallEditVersion(c.id, { id: actor.id, fullName: actorName }, data, latest, nowIso);
      cityWritten = answers.city
        ? executeChanges("UPDATE customers SET city=? WHERE id=? AND (city IS NULL OR trim(city)='')", [answers.city, c.id]) > 0 : false;
    }
    // Priority: recomputed with the existing rules; only raised (P3 → P2), never lowered, never P1 / transfer automatically.
    let priorityAfter = c.priority;
    const suggested = result.priority;
    if (!opts.send && suggested === 2 && c.priority === 3 && c.status === "in_progress") {
      executeChanges("UPDATE customers SET priority=2 WHERE id=? AND priority=3", [c.id]);
      logPriorityChange({ customerId: c.id, oldPriority: 3, newPriority: 2, oldSalespersonId: c.salesperson_id, newSalespersonId: c.salesperson_id,
        actorUserId: actor.id, source: "first_call_edit", reason: `ویرایش خلاصه‌ی تماس اول: ${result.reasons.join("؛ ")}`, at: nowIso });
      priorityAfter = 2;
    }
    let handoff: PromoteResult | null = null;
    if (opts.send) {
      handoff = promoteInTx(c, actor, cfg, "promote", "ارسال پس از ویرایش خلاصه‌ی تماس اول", now, null);
      priorityAfter = 1;
    }
    const editId = changed.length || handoff ? execute(
      `INSERT INTO ${FIRST_CALL_EDIT_TABLE} (customer_id, qualification_id, actor_user_id, actor_name, before_json, after_json, changed_json,
        priority_before, priority_suggested, priority_after, sent_to_closer, promote_call_log_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, base.id, actor.id, actorName, JSON.stringify(before), JSON.stringify(after), JSON.stringify(changed),
        c.priority, suggested, priorityAfter, handoff ? 1 : 0, handoff?.callLogId ?? null, nowIso]) : null;
    return { editId, changed, suggestedPriority: suggested, reasons: result.reasons, priorityBefore: c.priority, priorityAfter,
      priorityRaised: priorityAfter !== c.priority && !handoff, handoff, selectedPlans: selected, noPlanFit, noPlanNote: cleanNoPlanNote,
      noSuitablePlan: !evals.some((e) => e.status !== "no"), cityWritten };
  });
}
