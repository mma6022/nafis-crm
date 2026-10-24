/**
 * Team-sales model (qualifier Kazemi -> closers Hasani/Ghasemi), server side.
 * Inert unless notification_settings.team_sales_config has {"enabled":true}.
 * Priority-history logging (customer_priority_history) is always on: it is additive and invisible.
 * Never sends SMS (customers or staff): closer reminders are in-app only (reminder_sms_deliveries pre-marked).
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import {
  addWorkingHours, computeLeadPriority, matchPlans, mergeTeamSalesConfig, plansFromRows, validateAnswers,
  type LeadOutcome, type PlanMatch, type QualifierAnswers, type TeamSalesConfig,
} from "./team-sales-rules";

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
  schemaReady = true;
}

export function getTeamSalesConfig(): TeamSalesConfig {
  const row = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [TEAM_SALES_CONFIG_KEY]);
  if (!row) return mergeTeamSalesConfig(null);
  try { return mergeTeamSalesConfig(JSON.parse(row.value)); } catch { return mergeTeamSalesConfig(null); }
}

export type PriorityChange = {
  customerId: number; oldPriority: number | null; newPriority: number | null;
  oldSalespersonId: number | null; newSalespersonId: number | null;
  actorUserId: number | null; source: "customer_update" | "promote" | "qualifier_form" | "no_answer_archive";
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

/** Preview only: no writes. */
export function previewQualification(customerId: number, answers: QualifierAnswers, now = new Date()) {
  ensureTeamSalesSchema();
  const cfg = getTeamSalesConfig();
  const err = validateAnswers(answers, now);
  if (err) throw new TeamSalesError(400, err);
  const matches = answers.callResult === "answered" ? matchPlans(answers, activePlans()) : [];
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
export function submitQualification(customerId: number, actor: Actor, answers: QualifierAnswers, note: string, now = new Date()) {
  ensureTeamSalesSchema();
  const cfg = getTeamSalesConfig();
  const err = validateAnswers(answers, now);
  if (err) throw new TeamSalesError(400, err);
  const cleanNote = String(note ?? "").trim();
  if ([...cleanNote].length < cfg.noteMinLength)
    throw new TeamSalesError(400, `یادداشت تماس الزامی است (حداقل ${cfg.noteMinLength} نویسه).`);
  const plans = answers.callResult === "answered" ? activePlans() : [];
  return runImmediateTransaction(() => {
    const c = loadCustomer(customerId);
    assertQualifierAccess(actor, c, cfg);
    // The first-call form decides the priority, so it is only for customers that have none yet (P1/P2/P3 use the normal call form).
    if (c.priority != null)
      throw new TeamSalesError(409, "فرم تماس اول فقط برای مشتریان بدون اولویت است؛ برای این مشتری از فرم ثبت تماس معمولی استفاده کنید.");
    const matches: PlanMatch[] = answers.callResult === "answered" ? matchPlans(answers, plans) : [];
    const result: LeadOutcome = computeLeadPriority(answers, matches, consecutiveNoAnswers(customerId), now, cfg);
    const spName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [c.salesperson_id])?.name ?? null;
    const callLogId = execute(
      `INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.salesperson_id, CALL_SUBJECT[answers.callResult], null,
        `${cleanNote}\n\n— نتیجهٔ فرم: ${result.priority == null ? `بدون اولویت، بی‌پاسخ ${result.attempts} از ${cfg.maxNoAnswerAttempts}` : `اولویت ${result.priority}`} (${result.reasons.join("؛ ")})`, now.toISOString(), spName]);
    execute(
      `INSERT INTO team_sales_qualifications (customer_id, actor_user_id, call_log_id, call_result, answers_json, matches_json,
        priority, outcome, score, reasons_json, next_action_at, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.id, actor.id, callLogId, answers.callResult, JSON.stringify(answers), JSON.stringify(matches.slice(0, 5)),
        result.priority ?? 0, result.outcome, result.score, JSON.stringify(result.reasons), result.nextActionAt, cleanNote, now.toISOString()]);
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
    return { callLogId, result, matches: matches.slice(0, 5), handoff };
  });
}
