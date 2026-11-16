/**
 * SITESMS (Mohammad, PM card t754s2995, 2026-11-03 17:56 Tehran: «پیامک مشتری جدید هم به مشتری سایت بره، هر دو پیامک»):
 * a website lead that creates a NEW CRM customer also gets the existing «مشتری جدید» customer SMS (notifyNewCustomer →
 * IPPanel pattern from notification_settings, unchanged). The expert-intro SMS (EINS) is separate and unchanged.
 * - Own switch: call_queue_settings key flag.site_lead_customer_sms = '1' (absent / anything else = OFF, the shipped state).
 *   No deploy needed to turn it on/off; notification_settings is never read for the switch and never written.
 * - Only customers CREATED by this submission (existing customer / repeat request → never) and created at or after the
 *   moment the flag was switched on (flag row updated_at) → no backfill.
 * - Once per customer: PRIMARY KEY(customer_id) claim in site_lead_customer_sms before the send; a customer who
 *   already has any IPPanel delivery (sent / failed / unknown) is skipped too. Failures are never retried.
 * - Skipped (no SMS): merged customer, invalid mobile, test/staff number (same list as the expert-intro SMS).
 * DB handle and clock are injected so the fixture runs it on a copy.
 */
import type { DatabaseSync } from "node:sqlite";
import { getExpertIntroSettings, isTestOrStaffPhone, mobileKey } from "./expert-intro-sms-core";

export const SITE_LEAD_SMS_FLAG = "flag.site_lead_customer_sms";
type Db = DatabaseSync;
const row = <T>(db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
const run = (db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));

const ready = new WeakSet<object>();
export function ensureSiteLeadSmsSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_lead_customer_sms (
      customer_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('claimed','sent','failed','not_sent','skipped')),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ready.add(db);
}

/** ON since (ISO) or null when OFF. */
export function siteLeadSmsOnSince(db: Db): string | null {
  try {
    const r = row<{ value: string; updated_at: string | null }>(db, "SELECT value, updated_at FROM call_queue_settings WHERE key=?", SITE_LEAD_SMS_FLAG);
    return r?.value === "1" ? (r.updated_at || null) : null;
  } catch { return null; }
}

export type SiteLeadSmsDecision = "send" | "off" | "existing" | "duplicate" | "skipped";

/**
 * Decide (and claim) the «مشتری جدید» SMS for a website submission. Only "send" means the caller passes customerSms:true.
 * Flag OFF → one SELECT, nothing written.
 */
export function claimSiteLeadSms(db: Db, customerId: number, created: boolean, now = new Date()): SiteLeadSmsDecision {
  const since = siteLeadSmsOnSince(db);
  if (!since) return "off";
  if (!created) return "existing";
  const c = row<{ id: number; phone: string | null; created_at: string | null; merged_into_customer_id: number | null }>(db,
    "SELECT id, phone, created_at, merged_into_customer_id FROM customers WHERE id=?", customerId);
  if (!c || !c.created_at) return "skipped";
  // No backfill: the customer row must be newer than the switch.
  if (Date.parse(c.created_at) < Date.parse(since)) return "existing";
  ensureSiteLeadSmsSchema(db);
  const iso = now.toISOString();
  let reason: string | null = null;
  if (c.merged_into_customer_id != null) reason = "merged";
  else if (!c.phone || !mobileKey(c.phone)) reason = "bad_mobile";
  else if (isTestOrStaffPhone(db, c.phone, getExpertIntroSettings(db))) reason = "test_or_staff";
  else if (row(db, "SELECT 1 AS x FROM notification_deliveries WHERE customer_id=? AND channel='ippanel'", customerId)) reason = "already_had_sms";
  const ch = run(db, "INSERT OR IGNORE INTO site_lead_customer_sms (customer_id, status, reason, created_at, updated_at) VALUES (?,?,?,?,?)",
    customerId, reason ? "skipped" : "claimed", reason, iso, iso).changes;
  if (!ch) return "duplicate";
  return reason ? "skipped" : "send";
}

/** After notifyNewCustomer: copy the outcome of the IPPanel delivery written since the claim (never retried). */
export function finishSiteLeadSms(db: Db, customerId: number, now = new Date()): string {
  ensureSiteLeadSmsSchema(db);
  const claim = row<{ created_at: string }>(db, "SELECT created_at FROM site_lead_customer_sms WHERE customer_id=? AND status='claimed'", customerId);
  if (!claim) return "none";
  const d = row<{ status: string; error_message: string | null }>(db,
    "SELECT status, error_message FROM notification_deliveries WHERE customer_id=? AND channel='ippanel' AND created_at>=? ORDER BY id DESC LIMIT 1",
    customerId, claim.created_at);
  const status = !d ? "not_sent" : d.status === "sent" ? "sent" : d.status === "failed" ? "failed" : "not_sent";
  const reason = d ? (d.status === "sent" ? null : `${d.status}${d.error_message ? `: ${d.error_message.slice(0, 120)}` : ""}`) : "no_delivery_row";
  run(db, "UPDATE site_lead_customer_sms SET status=?, reason=?, updated_at=? WHERE customer_id=? AND status='claimed'", status, reason, now.toISOString(), customerId);
  return status;
}
