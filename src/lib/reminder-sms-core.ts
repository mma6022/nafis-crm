import type { DatabaseSync } from "node:sqlite";

export type ReminderSmsSender = (mobile: string, name: string) => Promise<string>;

// Kept independent of the application bootstrap so synthetic tests never start
// provider workers or read customer records.
export const REMINDER_SMS_OFF = true;

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
      // SMS-OFF-71 (Mohammad 2026-10-28 15:06 Tehran): «پیامک یادآور نره، فقط داخل CRM باشه».
      // Reminders from every path stay in-app only: new rows are pre-marked in_app_only, any
      // leftover pending/blocked row is closed, and nothing is ever handed to the SMS sender.
      void send; // kept for signature compatibility; never called
      db.prepare(`INSERT OR IGNORE INTO reminder_sms_deliveries(reminder_id,status,error_code)
        SELECT r.id, CASE WHEN r.sent_sms=1 THEN 'sent'
          WHEN julianday(r.remind_at)<julianday(a.activated_at) THEN 'legacy_skipped'
          ELSE 'rejected' END,
          CASE WHEN r.sent_sms=1 OR julianday(r.remind_at)<julianday(a.activated_at) THEN NULL ELSE 'in_app_only' END
        FROM reminders r CROSS JOIN reminder_sms_activation a WHERE a.id=1`).run();
      db.prepare(`UPDATE reminder_sms_deliveries SET status='rejected',error_code='in_app_only',next_attempt_at=NULL
        WHERE status IN ('pending','blocked')`).run();
      // A dead process may have reached the provider before SMS-OFF-71. Quarantine, never retry.
      db.prepare(`UPDATE reminder_sms_deliveries SET status='uncertain',error_code='sms_delivery_unknown'
        WHERE status='sending' AND julianday(attempted_at)<julianday(?,'-2 minutes')`).run(time);
    } finally { running=false; }
  }
  return { tick };
}
