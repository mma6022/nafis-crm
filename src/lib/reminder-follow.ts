/**
 * REMINDERS-FOLLOW (Armita reminder-status-priority HANDOFF «فاز ۲», server + data only; UI later).
 *  - A customer reminder belongs to the CUSTOMER: every owner change (admin edit, nonp1 auto hand-off to Kazemi, P1 promote,
 *    merge, any other path) moves its open reminders to the new owner's user in the same statement (SQLite trigger), records
 *    transferred_from_user_id / transferred_at, and writes a hand-off row (expires_at = +7 days) for the read-only
 *    «واگذارشده‌ها» list of the previous owner. Personal reminders (customer_id NULL) never move.
 *  - One open reminder per customer, enforced in the same transaction (triggers): a new / reopened / merged-in open reminder
 *    closes the older open one(s) with void_reason='replaced', replaced_by, replaced_at (kept in history, read-only).
 *  - One-time data step: move open reminders whose owner differs from the customer's owner (in_progress customers only),
 *    then keep the newest open reminder per customer. Every touched row is copied to reminders_follow_backup first.
 *  - Reactivation (cancelled/completed → in_progress) audit: customer_reactivations (who, when, reason, previous status/priority).
 *  - Shared labels: «تکمیل‌شده» / «لغوشده» (server values completed / cancelled unchanged).
 * Never sends SMS, Bale, bells or customer messages; never changes stage, priority, contracts or templates.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";

export const RF_MIGRATION = "reminders_follow_customer_v1";
export const RF_HANDOFF_DAYS = 7;
export const RF_NOTE_MAX = 80;
export const RF_REACTIVATION_REASON_MAX = 120;
/** HANDOFF item 10 / v1.0.2: customer.reactivate needs a reason (1–120) and a source (call_form | admin_page). Leaving
 *  «لغوشده» is accepted ONLY through POST /customers/:id/reactivate (any other PATCH → 409 reactivation_required). */
export const RF_REACTIVATION_REASON_REQUIRED = true;
export const RF_REACTIVATION_SOURCES = ["call_form", "admin_page"] as const;
export type RfReactivationSource = typeof RF_REACTIVATION_SOURCES[number] | "customer_patch";

/** HANDOFF item 14: one shared label set for customer / reminder status (server values unchanged). */
export const CUSTOMER_STATUS_LABELS: Record<string, string> = { in_progress: "در حال پیگیری", completed: "تکمیل‌شده", cancelled: "لغوشده" };
export const REMINDER_STATUS_LABELS: Record<string, string> = { open: "باز", completed: "تکمیل‌شده", cancelled: "لغوشده", replaced: "جایگزین‌شده" };
export const HANDOFF_REASON_LABELS: Record<string, string> = {
  owner_change: "تغییر کارشناس", customer_update: "ویرایش توسط مدیر", nonp1_auto_transfer: "انتقال خودکار غیر اولویت ۱",
  reactivation: "فعال‌سازی دوباره", customer_merge: "ادغام مشتری", qualifier_form: "فرم واجد شرایط", expert_upgrade: "ارتقا به اولویت ۱ توسط کارشناس",
  promote: "ارتقا به اولویت ۱", site_apply_form: "فرم سایت",
};

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const EXPIRES = `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${RF_HANDOFF_DAYS} days')`;
/** The user that works a salesperson's customers (same choice as team-sales promote: salesperson role first, then lowest id). */
const userOf = (sp: string) => `(SELECT u.id FROM users u WHERE u.salesperson_id=${sp} AND u.active=1 ORDER BY (u.role='salesperson') DESC, u.id LIMIT 1)`;

const hasCol = (t: string, c: string) => (crmDb.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((r) => r.name === c);
const addCol = (t: string, c: string, d: string) => { if (!hasCol(t, c)) crmDb.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };

export const RF_TRIGGERS = ["rf_owner_follow", "rf_one_open_insert", "rf_one_open_reopen", "rf_one_open_move"] as const;

function replaceSql(customerExpr: string, keepExpr: string): string {
  return `UPDATE reminders SET done=1, voided_at=${NOW}, void_reason='replaced', replaced_by=${keepExpr}, replaced_at=${NOW}
    WHERE customer_id=${customerExpr} AND done=0 AND id<>${keepExpr};`;
}

export function ensureReminderFollowSchema(): void {
  for (const [c, d] of [["note", "TEXT"], ["replaced_by", "INTEGER"], ["replaced_at", "TEXT"], ["transferred_from_user_id", "INTEGER"], ["transferred_at", "TEXT"],
    ["created_by", "INTEGER"]] as const) addCol("reminders", c, d);
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS customer_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
      from_salesperson_id INTEGER, to_salesperson_id INTEGER, from_user_id INTEGER, to_user_id INTEGER,
      reason TEXT NOT NULL DEFAULT 'owner_change', reminders_moved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_customer_handoffs_from ON customer_handoffs(from_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_customer_handoffs_customer ON customer_handoffs(customer_id, id);
    CREATE TABLE IF NOT EXISTS customer_reactivations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, actor_user_id INTEGER NOT NULL, reason TEXT,
      prev_status TEXT NOT NULL, prev_priority INTEGER, restored_status TEXT NOT NULL, restored_priority INTEGER, created_at TEXT NOT NULL,
      source TEXT);
    CREATE INDEX IF NOT EXISTS idx_customer_reactivations_customer ON customer_reactivations(customer_id, id);
    CREATE TABLE IF NOT EXISTS reminders_follow_backup (
      id INTEGER PRIMARY KEY AUTOINCREMENT, migration TEXT NOT NULL, reminder_id INTEGER NOT NULL, action TEXT NOT NULL,
      row_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_customer_reminders_open ON reminders(customer_id, done);
    CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  if (!queryRows<{ name: string }>("PRAGMA table_info(customer_reactivations)").some((c) => c.name === "source"))
    crmDb.exec("ALTER TABLE customer_reactivations ADD COLUMN source TEXT");
  runMigrationOnce();
  crmDb.exec(`
    CREATE TRIGGER IF NOT EXISTS rf_owner_follow AFTER UPDATE OF salesperson_id ON customers
    WHEN NEW.salesperson_id IS NOT OLD.salesperson_id AND NEW.salesperson_id IS NOT NULL AND ${userOf("NEW.salesperson_id")} IS NOT NULL
    BEGIN
      INSERT INTO customer_handoffs(customer_id,from_salesperson_id,to_salesperson_id,from_user_id,to_user_id,reason,reminders_moved,created_at,expires_at)
        SELECT NEW.id, OLD.salesperson_id, NEW.salesperson_id, ${userOf("OLD.salesperson_id")}, ${userOf("NEW.salesperson_id")}, 'owner_change',
          (SELECT COUNT(*) FROM reminders r WHERE r.customer_id=NEW.id AND r.done=0 AND r.user_id<>${userOf("NEW.salesperson_id")}), ${NOW}, ${EXPIRES}
        WHERE OLD.salesperson_id IS NOT NULL;
      UPDATE reminders SET transferred_from_user_id=user_id, transferred_at=${NOW}, user_id=${userOf("NEW.salesperson_id")}, salesperson_id=NEW.salesperson_id
        WHERE customer_id=NEW.id AND done=0 AND user_id<>${userOf("NEW.salesperson_id")};
      UPDATE reminders SET salesperson_id=NEW.salesperson_id WHERE customer_id=NEW.id AND done=0 AND salesperson_id IS NOT NEW.salesperson_id;
    END;
    CREATE TRIGGER IF NOT EXISTS rf_one_open_insert AFTER INSERT ON reminders
    WHEN NEW.customer_id IS NOT NULL AND NEW.done=0
    BEGIN ${replaceSql("NEW.customer_id", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS rf_one_open_reopen AFTER UPDATE OF done ON reminders
    WHEN NEW.customer_id IS NOT NULL AND NEW.done=0 AND OLD.done<>0
    BEGIN ${replaceSql("NEW.customer_id", "NEW.id")} END;
    CREATE TRIGGER IF NOT EXISTS rf_one_open_move AFTER UPDATE OF customer_id ON reminders
    WHEN NEW.customer_id IS NOT NULL AND NEW.done=0 AND NEW.customer_id IS NOT OLD.customer_id
    BEGIN
      UPDATE reminders SET transferred_from_user_id=user_id, transferred_at=${NOW},
          user_id=${userOf("(SELECT c.salesperson_id FROM customers c WHERE c.id=NEW.customer_id)")},
          salesperson_id=(SELECT c.salesperson_id FROM customers c WHERE c.id=NEW.customer_id)
        WHERE id=NEW.id AND ${userOf("(SELECT c.salesperson_id FROM customers c WHERE c.id=NEW.customer_id)")} IS NOT NULL
          AND user_id<>${userOf("(SELECT c.salesperson_id FROM customers c WHERE c.id=NEW.customer_id)")};
      ${replaceSql("NEW.customer_id", "(SELECT MAX(x.id) FROM reminders x WHERE x.customer_id=NEW.customer_id AND x.done=0)")}
    END;
  `);
}

export type RfMigrationResult = { applied: boolean; moved: number; movedByUser: Record<string, number>; skippedNotInProgress: number[]; replaced: number; customersDeduped: number };

/** One-time data step (schema_migrations guard). Runs BEFORE the triggers exist so its own writes are not re-handled. */
export function runMigrationOnce(): RfMigrationResult {
  const res: RfMigrationResult = { applied: false, moved: 0, movedByUser: {}, skippedNotInProgress: [], replaced: 0, customersDeduped: 0 };
  if (queryRow("SELECT 1 x FROM schema_migrations WHERE version=?", [RF_MIGRATION])) return res;
  const at = new Date().toISOString();
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    const backup = (id: number, action: string) => execute(
      "INSERT INTO reminders_follow_backup(migration,reminder_id,action,row_json,created_at) SELECT ?,?,?,json_object('id',id,'user_id',user_id,'salesperson_id',salesperson_id,'done',done,'voided_at',voided_at,'void_reason',void_reason,'replaced_by',replaced_by,'replaced_at',replaced_at,'transferred_from_user_id',transferred_from_user_id,'transferred_at',transferred_at),? FROM reminders WHERE id=?",
      [RF_MIGRATION, id, action, at, id]);
    const mism = queryRows<{ id: number; user_id: number; sp: number; status: string | null; to_user: number }>(
      `SELECT r.id, r.user_id, c.salesperson_id sp, c.status, ${userOf("c.salesperson_id")} to_user
         FROM reminders r JOIN customers c ON c.id=r.customer_id
        WHERE r.done=0 AND r.customer_id IS NOT NULL AND c.merged_into_customer_id IS NULL AND c.salesperson_id IS NOT NULL
          AND ${userOf("c.salesperson_id")} IS NOT NULL AND r.user_id<>${userOf("c.salesperson_id")} ORDER BY r.id`);
    for (const m of mism) {
      if ((m.status ?? "in_progress") !== "in_progress") { res.skippedNotInProgress.push(Number(m.id)); continue; }
      backup(Number(m.id), "move");
      executeChanges("UPDATE reminders SET transferred_from_user_id=user_id, transferred_at=?, user_id=?, salesperson_id=? WHERE id=? AND done=0",
        [at, Number(m.to_user), Number(m.sp), Number(m.id)]);
      res.moved++; res.movedByUser[`${m.user_id}->${m.to_user}`] = (res.movedByUser[`${m.user_id}->${m.to_user}`] ?? 0) + 1;
    }
    const dups = queryRows<{ customer_id: number; keep: number }>(
      "SELECT customer_id, MAX(id) keep FROM reminders WHERE done=0 AND customer_id IS NOT NULL GROUP BY customer_id HAVING COUNT(*)>1 ORDER BY customer_id");
    for (const d of dups) {
      const others = queryRows<{ id: number }>("SELECT id FROM reminders WHERE customer_id=? AND done=0 AND id<>? ORDER BY id", [d.customer_id, d.keep]);
      for (const o of others) {
        backup(Number(o.id), "replace");
        res.replaced += executeChanges("UPDATE reminders SET done=1, voided_at=?, void_reason='replaced', replaced_by=?, replaced_at=? WHERE id=? AND done=0",
          [at, Number(d.keep), at, Number(o.id)]);
      }
      res.customersDeduped++;
    }
    execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", [RF_MIGRATION, at]);
    crmDb.exec("COMMIT");
  } catch (e) { crmDb.exec("ROLLBACK"); throw e; }
  res.applied = true;
  console.log(`[reminders-follow] migration ${RF_MIGRATION}: moved=${res.moved} ${JSON.stringify(res.movedByUser)} skipped_not_in_progress=${JSON.stringify(res.skippedNotInProgress)} replaced=${res.replaced} customers=${res.customersDeduped}`);
  return res;
}

/** Labels the hand-off row the trigger just wrote for this customer (the trigger cannot know why the owner changed). */
export function rfTagHandoff(customerId: number, reason: string): void {
  try {
    executeChanges(`UPDATE customer_handoffs SET reason=? WHERE id=(SELECT MAX(id) FROM customer_handoffs WHERE customer_id=?) AND reason='owner_change'
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 seconds')`, [reason, customerId]);
  } catch { /* schema not ready: nothing to tag */ }
}

export function rfCleanNote(v: unknown): { ok: true; note: string | null } | { ok: false; error: string; message: string } {
  if (v == null) return { ok: true, note: null };
  if (typeof v !== "string") return { ok: false, error: "note_invalid", message: "یادداشت یادآور معتبر نیست." };
  const n = v.replace(/\s+/g, " ").trim();
  if ([...n].length > RF_NOTE_MAX) return { ok: false, error: "note_too_long", message: `یادداشت یادآور حداکثر ${RF_NOTE_MAX} حرف است.` };
  return { ok: true, note: n || null };
}

export function rfCleanReactivationSource(v: unknown): { ok: true; source: RfReactivationSource } | { ok: false; error: string; message: string } {
  const s = typeof v === "string" ? v.trim() : "";
  if ((RF_REACTIVATION_SOURCES as readonly string[]).includes(s)) return { ok: true, source: s as RfReactivationSource };
  return { ok: false, error: "reactivation_source_invalid", message: "منبع فعال‌سازی دوباره باید call_form یا admin_page باشد." };
}

export function rfCleanReactivationReason(v: unknown, required = RF_REACTIVATION_REASON_REQUIRED): { ok: true; reason: string | null } | { ok: false; error: string; message: string } {
  const n = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (v != null && typeof v !== "string") return { ok: false, error: "reactivation_reason_invalid", message: "دلیل فعال‌سازی دوباره معتبر نیست." };
  if ([...n].length > RF_REACTIVATION_REASON_MAX) return { ok: false, error: "reactivation_reason_too_long", message: `دلیل فعال‌سازی دوباره حداکثر ${RF_REACTIVATION_REASON_MAX} حرف است.` };
  if (!n && required) return { ok: false, error: "reactivation_reason_required", message: "دلیل فعال‌سازی دوباره را بنویس." };
  return { ok: true, reason: n || null };
}

export function rfRecordReactivation(input: { customerId: number; actorUserId: number; reason: string | null; prevStatus: string; prevPriority: number | null; source: RfReactivationSource }): number {
  const c = queryRow<{ status: string; priority: number | null }>("SELECT status, priority FROM customers WHERE id=?", [input.customerId]);
  return execute(`INSERT INTO customer_reactivations(customer_id,actor_user_id,reason,prev_status,prev_priority,restored_status,restored_priority,created_at,source)
    VALUES (?,?,?,?,?,?,?,?,?)`, [input.customerId, input.actorUserId, input.reason, input.prevStatus, input.prevPriority,
    c?.status ?? "in_progress", c?.priority ?? null, new Date().toISOString(), input.source]);
}

type RemRow = { id: number; user_id: number; user_name: string | null; salesperson_id: number | null; customer_id: number | null; subject: string | null; message: string;
  remind_at: string; done: number; created_at: string; created_by: number | null; created_by_name: string | null; note: string | null; voided_at: string | null;
  void_reason: string | null; closed_at: string | null; replaced_by: number | null; replaced_at: string | null; transferred_from_user_id: number | null;
  transferred_from_name: string | null; transferred_at: string | null; source: string | null };

const REM_SELECT = `SELECT r.id, r.user_id, COALESCE(uu.full_name, uu.username) user_name, r.salesperson_id, r.customer_id, r.subject, r.message, r.remind_at, r.done,
  r.created_at, r.created_by, COALESCE(cu.full_name, cu.username) created_by_name, r.note, r.voided_at, r.void_reason, r.closed_at, r.replaced_by, r.replaced_at,
  r.transferred_from_user_id, COALESCE(tu.full_name, tu.username) transferred_from_name, r.transferred_at, r.source
  FROM reminders r LEFT JOIN users uu ON uu.id=r.user_id LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users tu ON tu.id=r.transferred_from_user_id`;

export function rfReminderStatus(r: { done: number; voided_at: string | null; void_reason: string | null }): string {
  if (!Number(r.done)) return "open";
  if (r.void_reason === "replaced") return "replaced";
  return r.voided_at ? "cancelled" : "completed";
}

export function rfReminderView(r: RemRow) {
  const status = rfReminderStatus(r);
  return {
    id: Number(r.id), customerId: r.customer_id == null ? null : Number(r.customer_id), userId: Number(r.user_id), userName: r.user_name ?? null,
    subject: r.subject || r.message.slice(0, 80), note: r.note ?? null, remindAt: r.remind_at, createdAt: r.created_at,
    createdBy: r.created_by == null ? null : { id: Number(r.created_by), name: r.created_by_name ?? null },
    status, statusLabel: REMINDER_STATUS_LABELS[status], voidReason: r.void_reason ?? null, closedAt: r.closed_at ?? r.voided_at ?? null,
    replacedBy: r.replaced_by == null ? null : Number(r.replaced_by), replacedAt: r.replaced_at ?? null,
    transferredFrom: r.transferred_from_user_id == null ? null : { userId: Number(r.transferred_from_user_id), name: r.transferred_from_name ?? null, at: r.transferred_at },
    personal: r.customer_id == null,
  };
}

export function rfOpenReminder(customerId: number) {
  const r = queryRow<RemRow>(`${REM_SELECT} WHERE r.customer_id=? AND r.done=0 ORDER BY r.id DESC LIMIT 1`, [customerId]);
  return r ? rfReminderView(r) : null;
}

export function rfCustomerHistory(customerId: number) {
  const rows = queryRows<RemRow>(`${REM_SELECT} WHERE r.customer_id=? ORDER BY r.id DESC LIMIT 200`, [customerId]);
  const re = queryRows<{ id: number; actor_user_id: number; actor_name: string | null; reason: string | null; prev_status: string; prev_priority: number | null;
    restored_status: string; restored_priority: number | null; created_at: string; source: string | null }>(
    `SELECT x.*, COALESCE(u.full_name,u.username) actor_name FROM customer_reactivations x LEFT JOIN users u ON u.id=x.actor_user_id
      WHERE x.customer_id=? ORDER BY x.id DESC LIMIT 50`, [customerId]);
  return {
    customerId, open: rfOpenReminder(customerId), reminders: rows.map(rfReminderView),
    reactivations: re.map((x) => ({ id: Number(x.id), actor: { id: Number(x.actor_user_id), name: x.actor_name ?? null }, reason: x.reason ?? null,
      prevStatus: x.prev_status, prevStatusLabel: CUSTOMER_STATUS_LABELS[x.prev_status] ?? x.prev_status, prevPriority: x.prev_priority,
      restoredStatus: x.restored_status, restoredPriority: x.restored_priority, source: x.source ?? null, createdAt: x.created_at })),
    labels: { customerStatus: CUSTOMER_STATUS_LABELS, reminderStatus: REMINDER_STATUS_LABELS },
  };
}

export function rfMyOpenReminders(userId: number) {
  return queryRows<RemRow>(`${REM_SELECT} WHERE r.user_id=? AND r.done=0 ORDER BY r.remind_at, r.id LIMIT 500`, [userId]).map(rfReminderView);
}

export function rfHandoffsFor(userId: number, mask: (n: unknown) => string, now = new Date()) {
  return queryRows<{ id: number; customer_id: number; name: string | null; to_user_id: number | null; to_name: string | null; to_sp_name: string | null;
    reason: string; reminders_moved: number; created_at: string; expires_at: string }>(
    `SELECT h.id, h.customer_id, c.name, h.to_user_id, COALESCE(u.full_name,u.username) to_name, s.name to_sp_name, h.reason, h.reminders_moved, h.created_at, h.expires_at
       FROM customer_handoffs h JOIN customers c ON c.id=h.customer_id LEFT JOIN users u ON u.id=h.to_user_id LEFT JOIN salespersons s ON s.id=h.to_salesperson_id
      WHERE h.from_user_id=? AND h.expires_at>? AND (h.to_user_id IS NULL OR h.to_user_id<>h.from_user_id) ORDER BY h.id DESC LIMIT 300`, [userId, now.toISOString()])
    .map((h) => ({ id: Number(h.id), customerId: Number(h.customer_id), customerName: mask(h.name), toUserId: h.to_user_id == null ? null : Number(h.to_user_id),
      toName: h.to_sp_name ?? h.to_name ?? null, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[h.reason] ?? "واگذاری",
      remindersMoved: Number(h.reminders_moved), createdAt: h.created_at, expiresAt: h.expires_at, readOnly: true as const }));
}
