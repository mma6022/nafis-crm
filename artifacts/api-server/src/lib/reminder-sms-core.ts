import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

type DueReminder = { id: number; mobile: string | null; full_name: string; username: string; active: number };
export type ReminderSmsSender = (mobile: string, name: string) => Promise<string>;

// Kept independent of the application bootstrap so synthetic tests never start
// provider workers or read customer records.
export function createReminderSmsQueue(db: DatabaseSync, send: ReminderSmsSender, now = () => new Date().toISOString()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_sms_activation (
      id INTEGER PRIMARY KEY CHECK(id=1), activated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminder_sms_deliveries (
      reminder_id INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
      status TEXT NOT NULL, claim_token TEXT, attempted_at TEXT,
      next_attempt_at TEXT, sent_at TEXT, provider_id TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_sms_pending
      ON reminder_sms_deliveries(status,next_attempt_at);
  `);
  db.prepare("INSERT OR IGNORE INTO reminder_sms_activation VALUES(1,?)").run(now());
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const time = now();
      // Activation cutoff is durable: never mass-send historical overdue
      // reminders; future reminders missed during a restart still run.
      db.prepare(`INSERT OR IGNORE INTO reminder_sms_deliveries(reminder_id,status)
        SELECT r.id, CASE WHEN r.sent_sms=1 THEN 'sent'
          WHEN julianday(r.remind_at)<julianday(a.activated_at) THEN 'legacy_skipped'
          ELSE 'pending' END
        FROM reminders r CROSS JOIN reminder_sms_activation a WHERE a.id=1`).run();
      // A dead process may have reached the provider. Quarantine that claim
      // instead of risking another charge/message by automatically retrying.
      db.prepare(`UPDATE reminder_sms_deliveries SET status='uncertain',error_code='sms_delivery_unknown'
        WHERE status='sending' AND julianday(attempted_at)<julianday(?,'-2 minutes')`).run(time);
      const due = db.prepare(`SELECT r.id,u.mobile,u.full_name,u.username,u.active
        FROM reminders r JOIN users u ON u.id=r.user_id
        JOIN reminder_sms_deliveries d ON d.reminder_id=r.id
        WHERE r.done=0 AND r.sent_sms=0 AND julianday(r.remind_at)<=julianday(?)
          AND d.status IN ('pending','blocked')
          AND (d.next_attempt_at IS NULL OR julianday(d.next_attempt_at)<=julianday(?))
        ORDER BY julianday(r.remind_at),r.id LIMIT 50`).all(time,time) as DueReminder[];
      for (const reminder of due) {
        const token = randomUUID();
        const claim = db.prepare(`UPDATE reminder_sms_deliveries SET status='sending',
          claim_token=?,attempted_at=?,error_code=NULL WHERE reminder_id=?
          AND status IN ('pending','blocked')
          AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?))
          AND EXISTS(SELECT 1 FROM reminders r WHERE r.id=reminder_id AND r.done=0 AND r.sent_sms=0)`)
          .run(token,now(),reminder.id,time);
        if (Number(claim.changes)!==1) continue;
        try {
          if (!reminder.active) throw new Error("expert_inactive");
          if (!reminder.mobile) throw new Error("expert_mobile_missing");
          const providerId = await send(reminder.mobile,reminder.full_name || reminder.username);
          if (!providerId) throw new Error("sms_delivery_unknown");
          const sentAt = now();
          db.exec("BEGIN IMMEDIATE");
          try {
            const posted = db.prepare(`UPDATE reminder_sms_deliveries SET status='sent',
              sent_at=?,provider_id=?,next_attempt_at=NULL,error_code=NULL
              WHERE reminder_id=? AND claim_token=? AND status='sending'`).run(sentAt,providerId,reminder.id,token);
            if (Number(posted.changes)!==1) throw new Error("sms_claim_lost");
            db.prepare("UPDATE reminders SET sent_sms=1 WHERE id=?").run(reminder.id);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        } catch (error) {
          const code = error instanceof Error ? error.message : "sms_delivery_unknown";
          const blocked = ["expert_inactive","expert_mobile_missing","invalid_phone","sms_disabled","sms_relay_not_configured"].includes(code);
          const status = blocked ? "blocked" : code==="sms_provider_rejected" ? "rejected" : "uncertain";
          const safeCode = blocked || code==="sms_provider_rejected" ? code : "sms_delivery_unknown";
          const retry = blocked ? new Date(Date.parse(now())+5*60_000).toISOString() : null;
          db.prepare(`UPDATE reminder_sms_deliveries SET status=?,error_code=?,next_attempt_at=?
            WHERE reminder_id=? AND claim_token=? AND status='sending'`)
            .run(status,safeCode,retry,reminder.id,token);
        }
      }
    } finally { running=false; }
  }
  return { tick };
}
