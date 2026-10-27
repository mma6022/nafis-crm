/**
 * crm-urgent-history (PM 2026-10-27 22:28, amended 22:37): every set / clear of «مشتری فوری» (customers.is_urgent) writes one
 * history row with the actor (user, assistant or system) and an optional reason (REQUIRED on the lead_annotator path), and sends
 * one bell to the case's CURRENT owner (the active salesperson user of customers.salesperson_id) plus one to Kazemi (user 8) —
 * deduplicated, so when Kazemi owns the case he gets exactly one. Trainee owners (5, 19, 20) and user 29 never get one.
 * No SMS, no Bale, no customer message: a bell is only a DB row read by the CRM's own bell list.
 * The generic «پروندهٔ مشتری تغییر کرد» trigger ignores is_urgent-only changes (lib/site-notifications.ts), so no double bell.
 *
 * db-injected (DatabaseSync parameter, no crm-db import) so lib/assistants.ts can use it on the same handle.
 * (The 22:28 «registered_by=31 only» grant was replaced by the lead_annotator capability — lib/lead-annotator.ts.)
 */
import type { DatabaseSync } from "node:sqlite";

export const URGENT_BELL_USER_ID = 8;
const NO_BELL_SALESPERSONS = [5, 19, 20];
const NO_BELL_USERS = [29];
/** assistant_settings key; '0' (default) = the assistant-runner urgent endpoint answers 423. Needs Mohammad's own OK to turn on. */
export const ASSISTANT_URGENT_WRITE_KEY = "assistant_urgent_write";
export const URGENT_REASON_MAX = 300;
/** Mohammad 2026-10-27 23:42: the assistant write is per-assistant — comma-separated assistant ids (Somayeh 1, Mohaddeseh 2, Masoud 3). Empty = nobody. */
export const ASSISTANT_URGENT_IDS_KEY = "assistant_urgent_write_ids";
/** The fixed reasons (assistants and the lead_annotator picker). «سایر» needs a free text. */
export const URGENT_REASONS = [
  { code: "no_callback", label: "شاکیه کسی زنگ نزده" },
  { code: "urgent_call", label: "درخواست تماس فوری" },
  { code: "other", label: "سایر" },
] as const;
export const URGENT_OTHER_MIN = 3, URGENT_OTHER_MAX = 280;
/** body {reasonCode, reasonText} (or reason = one of the labels / «سایر: …»). allowFree: any 3–300 char text (lead_annotator legacy). */
export function parseUrgentReason(body: any, allowFree = false): { reason: string; code: string } | { error: string } {
  const code = typeof body?.reasonCode === "string" ? body.reasonCode.trim() : "";
  let text = typeof body?.reasonText === "string" ? body.reasonText.trim() : "";
  const raw = typeof body?.reason === "string" ? body.reason.trim() : "";
  let opt: (typeof URGENT_REASONS)[number] | undefined;
  if (code) { opt = URGENT_REASONS.find((o) => o.code === code); if (!opt) return { error: "bad_reason_code" }; }
  else if (raw) {
    opt = URGENT_REASONS.find((o) => o.label === raw || o.code === raw);
    const m = /^سایر\s*[:：،-]\s*(.+)$/s.exec(raw);
    if (!opt && m) { opt = URGENT_REASONS[2]; text = m[1].trim(); }
    if (!opt) {
      if (allowFree && raw.length >= 3 && raw.length <= URGENT_REASON_MAX) return { reason: raw, code: "free" };
      return { error: "reason_required" };
    }
  } else return { error: "reason_required" };
  if (opt.code !== "other") return { reason: opt.label, code: opt.code };
  if (text.length < URGENT_OTHER_MIN || text.length > URGENT_OTHER_MAX) return { error: "other_text_required" };
  return { reason: `سایر: ${text}`, code: "other" };
}
export type UrgentBellOpts = { ownerOnly?: boolean };

export type UrgentActor = { kind: "user" | "assistant" | "system"; userId?: number | null; assistantId?: number | null; label?: string | null };

const colsOf = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

export function ensureUrgentSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS customer_urgent_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      old_value INTEGER NOT NULL,
      new_value INTEGER NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_user_id INTEGER,
      assistant_id INTEGER,
      actor_label TEXT,
      via TEXT NOT NULL,
      bell_event_id INTEGER,
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_customer_urgent_history_customer ON customer_urgent_history(customer_id, id DESC);`);
  const cols = colsOf(db, "customer_urgent_history");
  if (!cols.includes("reason")) db.exec("ALTER TABLE customer_urgent_history ADD COLUMN reason TEXT");
  if (!cols.includes("bell_recipients")) db.exec("ALTER TABLE customer_urgent_history ADD COLUMN bell_recipients TEXT");
}

/** Owner user of the case + Kazemi, deduplicated, active only, never a trainee owner or user 29. */
/** The case owner's user (active salesperson; never a trainee owner or user 29), or null. */
export function urgentOwnerUser(db: DatabaseSync, customerId: number): number | null {
  const c = db.prepare("SELECT salesperson_id FROM customers WHERE id=?").get(customerId) as { salesperson_id: number | null } | undefined;
  if (c?.salesperson_id == null || NO_BELL_SALESPERSONS.includes(Number(c.salesperson_id))) return null;
  const o = db.prepare("SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' AND active=1 ORDER BY id LIMIT 1").get(Number(c.salesperson_id)) as { id: number } | undefined;
  return o && !NO_BELL_USERS.includes(Number(o.id)) ? Number(o.id) : null;
}
export function urgentBellRecipients(db: DatabaseSync, customerId: number, opts: UrgentBellOpts = {}): number[] {
  const out: number[] = [];
  const owner = urgentOwnerUser(db, customerId);
  if (owner != null) out.push(owner);
  if (opts.ownerOnly) return out;
  if (db.prepare("SELECT id FROM users WHERE id=? AND active=1").get(URGENT_BELL_USER_ID) && !out.includes(URGENT_BELL_USER_ID)) out.push(URGENT_BELL_USER_ID);
  return out;
}

function bells(db: DatabaseSync, customerId: number, isUrgent: boolean, actor: UrgentActor, reason: string | null, at: string, opts: UrgentBellOpts = {}): number[] {
  if (!colsOf(db, "site_notification_events").includes("recipient_user_id")) return [];
  const c = db.prepare("SELECT name, salesperson_id FROM customers WHERE id=?").get(customerId) as { name: string | null; salesperson_id: number | null } | undefined;
  if (!c) return [];
  const who = actor.kind === "assistant" ? (actor.label || "دستیار") : actor.kind === "system" ? "سیستم" : (actor.label || "یکی از همکاران");
  const body = `${who} ${isUrgent ? "این مشتری را «فوری» علامت زد" : "علامت «فوری» این مشتری را برداشت"}.${reason ? ` دلیل: ${reason}` : ""}`;
  const ins = db.prepare(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(?,?,?,'customer',?,'urgent-change',?,?,'customers.view',?,?,?)`);
  return urgentBellRecipients(db, customerId, opts).map((uid) => Number(ins.run(
    customerId, String(c.name || "مشتری"), c.salesperson_id, customerId, isUrgent ? "مشتری فوری شد" : "علامت فوری برداشته شد", body,
    at, actor.kind === "assistant" ? `assistant:${actor.assistantId ?? ""}` : actor.kind === "user" ? `user:${actor.userId ?? ""}` : "system", uid).lastInsertRowid));
}

/** Record an already-written change (old !== new). Returns the history id, or null when nothing changed. */
export function recordUrgentChange(db: DatabaseSync, customerId: number, oldValue: unknown, newValue: unknown, actor: UrgentActor, via: string, reason: string | null = null, opts: UrgentBellOpts = {}): number | null {
  const o = Number(oldValue) === 1 ? 1 : 0, n = Number(newValue) === 1 ? 1 : 0;
  if (o === n) return null;
  ensureUrgentSchema(db);
  const at = new Date().toISOString();
  const why = reason && reason.trim() ? reason.trim().slice(0, URGENT_REASON_MAX) : null;
  const ids = bells(db, customerId, n === 1, actor, why, at, opts);
  const r = db.prepare(`INSERT INTO customer_urgent_history(customer_id,old_value,new_value,actor_kind,actor_user_id,assistant_id,actor_label,via,bell_event_id,created_at,reason,bell_recipients)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(customerId, o, n, actor.kind, actor.userId ?? null, actor.assistantId ?? null, actor.label ?? null, via.slice(0, 60),
    ids[0] ?? null, at, why, JSON.stringify(ids));
  return Number(r.lastInsertRowid);
}

/** Set the tick (only is_urgent) and record it. Caller does the authorization. */
export function setCustomerUrgent(db: DatabaseSync, customerId: number, isUrgent: boolean, actor: UrgentActor, via: string, reason: string | null = null, opts: UrgentBellOpts = {}): { changed: boolean; isUrgent: boolean; historyId: number | null } {
  const cur = db.prepare("SELECT is_urgent FROM customers WHERE id=? AND merged_into_customer_id IS NULL").get(customerId) as { is_urgent: number } | undefined;
  if (!cur) throw new Error("customer_not_found");
  const old = Number(cur.is_urgent) === 1;
  if (old === isUrgent) return { changed: false, isUrgent, historyId: null };
  db.prepare("UPDATE customers SET is_urgent=? WHERE id=?").run(isUrgent ? 1 : 0, customerId);
  return { changed: true, isUrgent, historyId: recordUrgentChange(db, customerId, old ? 1 : 0, isUrgent ? 1 : 0, actor, via, reason, opts) };
}

export function urgentHistory(db: DatabaseSync, customerId: number, limit = 20) {
  ensureUrgentSchema(db);
  return db.prepare("SELECT id, old_value oldValue, new_value newValue, actor_kind actorKind, actor_label actorLabel, reason, via, created_at createdAt FROM customer_urgent_history WHERE customer_id=? ORDER BY id DESC LIMIT ?").all(customerId, limit);
}
