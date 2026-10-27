/**
 * crm-instagram-leads (spec /nafis-design/screens/crm-instagram-leads §0 1–12, §2, §8 1–10) + urgent v1.1 (§0 13–25, §8 11–16).
 *
 * New-customer intake fields (all optional, server-validated):
 *   customers.lead_source        instagram | referral | inbound_call | site | other | none   (default none; per-seller default
 *                                 from the SETTING lead_intake_settings.default_source_by_seller, e.g. {"22":"instagram"})
 *   customers.lead_source_other  ≤ 40 chars, required with «other»
 *   customers.intake_credit_rank A | B | C1 | C2 | D | E | unknown (default unknown) — separate from credit_rank; owner/admin edit, logged
 *   customers.registrar_note     ≤ 500 chars, read-only after save
 *   customers.registered_by_seller_id / registered_at — server-filled (never from the client)
 * A duplicate phone never creates a customer: it is a customer_repeat_requests row on the existing case (source / rank / note
 * stored on that row), no owner change, and the report never counts it as «ثبت».
 * Everything here is a CRM DB row only: no SMS, no Bale, no message to anyone.
 * db-injected (DatabaseSync parameter).
 */
import type { DatabaseSync } from "node:sqlite";
import { ensureUrgentSchema, parseStaffUrgentReason, parseUrgentReason, recordUrgentAttempt, setCustomerUrgent, URGENT_CLEAR_NOTE_MAX, URGENT_CLEAR_REASONS, type UrgentActor } from "./customer-urgent";

export const LEAD_SOURCES = {
  instagram: "اینستاگرام", referral: "معرفی", inbound_call: "تماس ورودی", site: "سایت", other: "سایر", none: "منبع ثبت نشده",
} as const;
export type LeadSource = keyof typeof LEAD_SOURCES;
export const isLeadSource = (v: unknown): v is LeadSource => typeof v === "string" && Object.prototype.hasOwnProperty.call(LEAD_SOURCES, v);
export const INTAKE_RANKS = ["A", "B", "C1", "C2", "D", "E", "unknown"] as const;
export type IntakeRank = (typeof INTAKE_RANKS)[number];
export const RANK_LABEL = (r: string | null | undefined) => r == null || r === "unknown" ? "نامشخص" : r;
export const LEAD_SOURCE_OTHER_MAX = 40, REGISTRAR_NOTE_MAX = 500;
/** Code default when the setting row is missing; the boot seed writes the PM-approved {22: instagram} once (replaces the old user-31 constant). */
export const DEFAULT_SOURCE_BY_SELLER_SEED: Record<string, LeadSource> = { "22": "instagram" };
const SETTINGS = "lead_intake_settings";

const cols = (db: DatabaseSync, t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
const addCol = (db: DatabaseSync, t: string, c: string, d: string) => { if (!cols(db, t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
const hasTable = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));

const done = new WeakSet<object>();
let triggersDone = new WeakSet<object>();
/** Idempotent migration (ALTER ADD COLUMN / CREATE IF NOT EXISTS only; old rows stay NULL = «before start», no card / not in the source filter). */
export function ensureLeadIntakeSchema(db: DatabaseSync): void {
  if (!done.has(db)) {
    for (const [c, d] of [["lead_source", "TEXT"], ["lead_source_other", "TEXT"], ["intake_credit_rank", "TEXT"], ["registrar_note", "TEXT"],
      ["registered_by_seller_id", "INTEGER"], ["registered_at", "TEXT"]] as const) addCol(db, "customers", c, d);
    if (hasTable(db, "customer_repeat_requests"))
      for (const [c, d] of [["lead_source", "TEXT"], ["lead_source_other", "TEXT"], ["intake_credit_rank", "TEXT"], ["registrar_note", "TEXT"]] as const) addCol(db, "customer_repeat_requests", c, d);
    db.exec(`CREATE TABLE IF NOT EXISTS ${SETTINGS} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
      CREATE TABLE IF NOT EXISTS ${SETTINGS}_log (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL,
        actor_user_id INTEGER, via TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customer_intake_events (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, kind TEXT NOT NULL,
        old_value TEXT, new_value TEXT, actor_user_id INTEGER, actor_label TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_customer_intake_events_customer ON customer_intake_events(customer_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_customers_registered_at ON customers(registered_at);`);
    const at = new Date().toISOString();
    // Seeds (INSERT OR IGNORE: written once, never overwrite an admin's later value). intake_started_at = the moment this
    // release first booted = «شروع»; the report's source filter and the registrar card start there.
    for (const [k, v] of [["default_source_by_seller", JSON.stringify(DEFAULT_SOURCE_BY_SELLER_SEED)], ["intake_started_at", at]] as const) {
      const r = db.prepare(`INSERT OR IGNORE INTO ${SETTINGS}(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,NULL)`).run(k, v, at);
      if (Number(r.changes)) db.prepare(`INSERT INTO ${SETTINGS}_log(key,old_value,new_value,actor_user_id,via,created_at) VALUES(?,NULL,?,NULL,'seed',?)`).run(k, v, at);
    }
    ensureUrgentSchema(db);
    done.add(db);
  }
  ensureUrgentAutoClearTriggers(db);
}

/**
 * §0-19 / §8-14: the result of the first CRM-started call (call_logs.source='crm_button' with report_saved_at set — the call-queue
 * R2 report path) closes an open urgent flag as auto_call. Done as SQLite triggers so every report path (queue modal, first-call
 * form, due modal) is covered without touching call-queue code. No bell (§0-20/22). Rollback note: R.sh drops both triggers.
 */
export function ensureUrgentAutoClearTriggers(db: DatabaseSync): void {
  if (triggersDone.has(db)) return;
  const c = cols(db, "call_logs");
  if (!c.has("source") || !c.has("report_saved_at") || !c.has("customer_id")) return; // call-queue schema not there yet; retried next call
  const uid = c.has("created_by_user_id") ? "NEW.created_by_user_id" : "NULL";
  const body = `BEGIN
      INSERT INTO customer_urgent_history(customer_id,old_value,new_value,actor_kind,actor_user_id,actor_label,via,bell_event_id,created_at,reason,bell_recipients,event,clear_reason_code,call_log_id)
        SELECT NEW.customer_id,1,0,'system',${uid},'تماس CRM','auto_call',NULL,NEW.report_saved_at,NULL,'[]','auto_clear','auto_call',NEW.id
        FROM customers WHERE id=NEW.customer_id AND is_urgent=1;
      UPDATE customers SET is_urgent=0 WHERE id=NEW.customer_id AND is_urgent=1;
    END`;
  const when = "WHEN NEW.customer_id IS NOT NULL AND NEW.source='crm_button' AND NEW.report_saved_at IS NOT NULL";
  db.exec(`CREATE TRIGGER IF NOT EXISTS urgent_auto_clear_crm_call_upd AFTER UPDATE OF report_saved_at ON call_logs ${when} AND OLD.report_saved_at IS NULL ${body};
    CREATE TRIGGER IF NOT EXISTS urgent_auto_clear_crm_call_ins AFTER INSERT ON call_logs ${when} ${body};`);
  triggersDone.add(db);
}
export function resetLeadIntakeCache(): void { triggersDone = new WeakSet(); }

export function intakeSetting(db: DatabaseSync, key: string): string | null {
  ensureLeadIntakeSchema(db);
  return (db.prepare(`SELECT value FROM ${SETTINGS} WHERE key=?`).get(key) as { value: string } | undefined)?.value ?? null;
}
export function defaultSourceBySeller(db: DatabaseSync): Record<string, LeadSource> {
  const raw = intakeSetting(db, "default_source_by_seller");
  try {
    const o = raw ? JSON.parse(raw) : {};
    const out: Record<string, LeadSource> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (/^\d+$/.test(k) && isLeadSource(v)) out[k] = v;
    return out;
  } catch { return {}; }
}
export function intakeStartedAt(db: DatabaseSync): string | null { return intakeSetting(db, "intake_started_at"); }

export function validateDefaultSourceBySeller(db: DatabaseSync, raw: unknown): { ok: true; value: Record<string, LeadSource> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "نگاشت منبع پیش‌فرض نامعتبر است." };
  const out: Record<string, LeadSource> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !isLeadSource(v) || v === "other") return { ok: false, error: "کلید باید شناسه‌ی فروشنده و مقدار یکی از منبع‌ها (به‌جز «سایر») باشد." };
    if ([5, 19, 20].includes(Number(k))) return { ok: false, error: "کارآموزها منبع پیش‌فرض ندارند." };
    if (!db.prepare("SELECT 1 FROM salespersons WHERE id=?").get(Number(k))) return { ok: false, error: `فروشنده‌ی ${k} پیدا نشد.` };
    out[String(Number(k))] = v;
  }
  return { ok: true, value: out };
}
export function saveIntakeSetting(db: DatabaseSync, key: string, value: string, actorUserId: number | null, via = "admin_page"): void {
  ensureLeadIntakeSchema(db);
  const old = intakeSetting(db, key); const at = new Date().toISOString();
  db.prepare(`INSERT INTO ${SETTINGS}(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,
    updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id`).run(key, value, at, actorUserId);
  db.prepare(`INSERT INTO ${SETTINGS}_log(key,old_value,new_value,actor_user_id,via,created_at) VALUES(?,?,?,?,?,?)`).run(key, old, value, actorUserId, via, at);
}

export function sellerOfUser(db: DatabaseSync, userId: number | null | undefined): number | null {
  if (userId == null) return null;
  const u = db.prepare("SELECT salesperson_id FROM users WHERE id=?").get(Number(userId)) as { salesperson_id: number | null } | undefined;
  return u?.salesperson_id == null ? null : Number(u.salesperson_id);
}
/** §8-3: the form's default source for this registrar (by users.salesperson_id), or none. */
export function defaultLeadSourceForUser(db: DatabaseSync, userId: number | null | undefined): LeadSource {
  const sp = sellerOfUser(db, userId);
  return sp == null ? "none" : defaultSourceBySeller(db)[String(sp)] ?? "none";
}
/** Lead source of a system intake (no form). */
export function leadSourceForChannel(registrationSource: string): LeadSource {
  if (registrationSource === "instagram" || registrationSource === "instagram_auto") return "instagram";
  if (registrationSource === "site_lead" || registrationSource === "site_callback" || registrationSource === "portal") return "site";
  return "none";
}

export type IntakeInput = { leadSource?: LeadSource; leadSourceOther?: string | null; intakeCreditRank?: IntakeRank; registrarNote?: string | null };
/** Body → intake fields. Missing keys stay undefined (the server default applies); bad values are errors. */
export function parseIntake(body: any): { ok: true; value: IntakeInput } | { ok: false; error: string; field: string } {
  const v: IntakeInput = {};
  if (body?.leadSource != null && body.leadSource !== "") {
    if (!isLeadSource(body.leadSource)) return { ok: false, error: "منبع نامعتبر است.", field: "leadSource" };
    v.leadSource = body.leadSource;
  }
  const other = typeof body?.leadSourceOther === "string" ? body.leadSourceOther.trim() : "";
  if (v.leadSource === "other") {
    if (!other) return { ok: false, error: "بنویس منبع دیگر چه بوده؛ یا یکی از گزینه‌های بالا را بزن.", field: "leadSourceOther" };
    if ([...other].length > LEAD_SOURCE_OTHER_MAX) return { ok: false, error: "توضیح منبع حداکثر ۴۰ نویسه است.", field: "leadSourceOther" };
    v.leadSourceOther = other;
  } else if (v.leadSource) v.leadSourceOther = null;
  if (body?.intakeCreditRank != null && body.intakeCreditRank !== "") {
    if (!(INTAKE_RANKS as readonly string[]).includes(body.intakeCreditRank)) return { ok: false, error: "رتبه‌ی اعتباری نامعتبر است.", field: "intakeCreditRank" };
    v.intakeCreditRank = body.intakeCreditRank;
  }
  if (body?.registrarNote != null) {
    if (typeof body.registrarNote !== "string") return { ok: false, error: "یادداشت نامعتبر است.", field: "registrarNote" };
    const n = body.registrarNote.trim();
    if ([...n].length > REGISTRAR_NOTE_MAX) return { ok: false, error: "یادداشت ثبت‌کننده حداکثر ۵۰۰ نویسه است.", field: "registrarNote" };
    v.registrarNote = n || null;
  }
  return { ok: true, value: v };
}

/** Intake column values for a new customer's INSERT (one statement, so no customers-UPDATE trigger fires). */
export function intakeValuesForCreate(db: DatabaseSync, registrationSource: string, registrarUserId: number | null | undefined, input: IntakeInput | undefined, at: string) {
  ensureLeadIntakeSchema(db);
  const ls: LeadSource = input?.leadSource ?? (registrationSource === "staff_form" ? defaultLeadSourceForUser(db, registrarUserId) : leadSourceForChannel(registrationSource));
  return { leadSource: ls, leadSourceOther: ls === "other" ? input?.leadSourceOther ?? null : null, intakeCreditRank: input?.intakeCreditRank ?? "unknown",
    registrarNote: input?.registrarNote ?? null, registeredBySellerId: sellerOfUser(db, registrarUserId), registeredAt: at };
}

const userLabel = (db: DatabaseSync, id: number | null | undefined) => {
  if (id == null) return null;
  const u = db.prepare("SELECT full_name, username FROM users WHERE id=?").get(Number(id)) as { full_name: string | null; username: string } | undefined;
  return u ? (u.full_name || u.username) : `کاربر ${id}`;
};

/** «جدید» = no CRM-started call yet (call_queue_calls = a click on the CRM «تماس» button; spec §5 «تماس»). */
export function crmCallStartedSql(db: DatabaseSync, c = "c"): string {
  return hasTable(db, "call_queue_calls") ? `EXISTS (SELECT 1 FROM call_queue_calls q WHERE q.customer_id=${c}.id)` : "0";
}

export function setIntakeRank(db: DatabaseSync, customerId: number, rank: IntakeRank, actor: { id: number; label: string }): { changed: boolean; old: string | null } {
  ensureLeadIntakeSchema(db);
  const cur = db.prepare("SELECT intake_credit_rank r, registered_at FROM customers WHERE id=? AND merged_into_customer_id IS NULL").get(customerId) as { r: string | null; registered_at: string | null } | undefined;
  if (!cur) throw new Error("customer_not_found");
  const old = cur.r ?? "unknown";
  if (old === rank) return { changed: false, old };
  const at = new Date().toISOString();
  db.prepare("UPDATE customers SET intake_credit_rank=? WHERE id=?").run(rank, customerId);
  db.prepare("INSERT INTO customer_intake_events(customer_id,kind,old_value,new_value,actor_user_id,actor_label,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(customerId, "rank_change", old, rank, actor.id, actor.label, at);
  return { changed: true, old };
}

/** Open urgent flag of a customer from the history (latest set row after the latest clear), or null. */
export function openUrgentFlag(db: DatabaseSync, customerId: number) {
  ensureLeadIntakeSchema(db);
  const c = db.prepare("SELECT is_urgent FROM customers WHERE id=?").get(customerId) as { is_urgent: number } | undefined;
  if (!c || Number(c.is_urgent) !== 1) return null;
  const set = db.prepare(`SELECT id, actor_kind, actor_user_id, assistant_id, actor_label, reason, reason_code, created_at FROM customer_urgent_history
    WHERE customer_id=? AND new_value=1 AND old_value=0 ORDER BY id DESC LIMIT 1`).get(customerId) as any;
  const attempts = set ? Number((db.prepare("SELECT COUNT(*) n FROM customer_urgent_history WHERE customer_id=? AND id>? AND event='attempt'").get(customerId, set.id) as any).n) : 0;
  return {
    flaggedAt: set?.created_at ?? null, flaggedByUserId: set?.actor_user_id ?? null, flaggedByAssistantId: set?.assistant_id ?? null,
    flaggedBy: set ? (set.actor_kind === "user" ? userLabel(db, set.actor_user_id) ?? set.actor_label : set.actor_label || (set.actor_kind === "system" ? "سیستم" : "دستیار")) : null,
    reason: set?.reason ?? null, reasonCode: set?.reason_code ?? null, attempts,
  };
}
/** Batch: open-flag time + flagger + reason for many customers (queue badges / ordering). */
export function openUrgentFlags(db: DatabaseSync, ids: number[]): Map<number, { at: string | null; by: string | null; reason: string | null }> {
  ensureLeadIntakeSchema(db);
  const out = new Map<number, { at: string | null; by: string | null; reason: string | null }>();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT h.customer_id cid, h.created_at at, h.actor_kind k, h.actor_user_id uid, h.actor_label lbl, h.reason, u.full_name fn, u.username un
    FROM customer_urgent_history h JOIN customers c ON c.id=h.customer_id AND c.is_urgent=1 LEFT JOIN users u ON u.id=h.actor_user_id
    WHERE h.customer_id IN (${ids.map(() => "?").join(",")}) AND h.new_value=1 AND h.old_value=0
      AND h.id=(SELECT MAX(x.id) FROM customer_urgent_history x WHERE x.customer_id=h.customer_id AND x.new_value=1 AND x.old_value=0)`).all(...ids) as any[];
  for (const r of rows) out.set(Number(r.cid), { at: r.at, by: r.k === "user" ? (r.fn || r.un || r.lbl) : (r.lbl || (r.k === "system" ? "سیستم" : "دستیار")), reason: r.reason ?? null });
  return out;
}

export function lastUrgentClear(db: DatabaseSync, customerId: number) {
  const r = db.prepare(`SELECT h.*, cl.outcome FROM customer_urgent_history h LEFT JOIN call_logs cl ON cl.id=h.call_log_id
    WHERE h.customer_id=? AND h.old_value=1 AND h.new_value=0 ORDER BY h.id DESC LIMIT 1`).get(customerId) as any;
  if (!r) return null;
  const set = db.prepare("SELECT created_at FROM customer_urgent_history WHERE customer_id=? AND id<? AND old_value=0 AND new_value=1 ORDER BY id DESC LIMIT 1").get(customerId, r.id) as any;
  const waitedMin = set ? Math.max(0, Math.round((Date.parse(r.created_at) - Date.parse(set.created_at)) / 60000)) : null;
  return { at: r.created_at, auto: r.clear_reason_code === "auto_call" || r.event === "auto_clear", clearReasonCode: r.clear_reason_code ?? null, note: r.clear_note ?? null,
    by: r.actor_user_id != null ? userLabel(db, r.actor_user_id) : r.actor_label ?? null, callOutcome: r.outcome ?? null, waitedMin };
}

export const URGENT_ERRORS: Record<string, string> = {
  reason_required: "یکی از دلیل‌ها را بزن.", bad_reason_code: "یکی از دلیل‌ها را بزن.",
  other_text_required: "برای «سایر» یک جمله‌ی کوتاه بنویس که چرا فوری است.", other_text_too_long: "توضیح «سایر» حداکثر ۸۰ نویسه است.",
  clear_reason_required: "یکی از دلیل‌های برداشتن را بزن.", clear_note_required: "برای «سایر» یک جمله‌ی کوتاه بنویس.",
  clear_note_too_long: "توضیح حداکثر ۸۰ نویسه است.", urgent_clear_admin_only: "برداشتن علامت فوری فقط با مدیر است.",
};
/** null = ok, else the error code. */
export function validateUrgentClear(body: any): string | null {
  const code = typeof body?.clearReasonCode === "string" ? body.clearReasonCode : "";
  if (!URGENT_CLEAR_REASONS.some((r) => r.code === code)) return "clear_reason_required";
  const note = typeof body?.clearNote === "string" ? body.clearNote.trim() : "";
  if (code === "other" && !note) return "clear_note_required";
  if ([...note].length > URGENT_CLEAR_NOTE_MAX) return "clear_note_too_long";
  return null;
}
export type StaffUrgentResult = { status: number; body: Record<string, unknown> };
/**
 * urgent v1.1 policy for every STAFF path (customer edit, PATCH /urgent, lead_annotator, /lead-intake flag / clear):
 *  set   — a reason is required (two fixed chips or «سایر» + ≤ 80); already urgent → one 'attempt' row, no bell, no change (§0-16);
 *          bells keep the PM 22:37 rule (owner + Kazemi, lib/customer-urgent.ts).
 *  clear — admin only (§0-20; there is no «مدیر» role besides admin; never user 29) with a clear reason; no bell.
 * legacyFreeReason: the lead_annotator body {reason: free text} still accepted when no reasonCode is sent (Milad's v1 picker).
 */
export function applyStaffUrgent(db: DatabaseSync, customerId: number, isUrgent: boolean, actor: UrgentActor, isAdmin: boolean, body: any, via: string, legacyFreeReason = false): StaffUrgentResult {
  ensureLeadIntakeSchema(db);
  const cur = db.prepare("SELECT is_urgent FROM customers WHERE id=? AND merged_into_customer_id IS NULL").get(customerId) as { is_urgent: number } | undefined;
  if (!cur) return { status: 404, body: { error: "Customer not found" } };
  const was = Number(cur.is_urgent) === 1;
  if (isUrgent) {
    const pr = legacyFreeReason && !body?.reasonCode ? parseUrgentReason(body, true) : parseStaffUrgentReason(body);
    if ("error" in pr) return { status: 422, body: { error: pr.error, message: URGENT_ERRORS[pr.error] ?? pr.error } };
    if (was) {
      recordUrgentAttempt(db, customerId, actor, via, pr.reason, pr.code);
      return { status: 200, body: { id: customerId, isUrgent: true, changed: false, alreadyUrgent: true, flag: openUrgentFlag(db, customerId) } };
    }
    const r = setCustomerUrgent(db, customerId, true, actor, via, pr.reason, { reasonCode: pr.code });
    return { status: 200, body: { id: customerId, isUrgent: true, changed: r.changed, flag: openUrgentFlag(db, customerId) } };
  }
  if (!isAdmin) return { status: 403, body: { error: "urgent_clear_admin_only", message: URGENT_ERRORS.urgent_clear_admin_only } };
  if (!was) return { status: 200, body: { id: customerId, isUrgent: false, changed: false } };
  const bad = validateUrgentClear(body);
  if (bad) return { status: 422, body: { error: bad, message: URGENT_ERRORS[bad] } };
  const code = String(body.clearReasonCode);
  const note = typeof body?.clearNote === "string" ? body.clearNote.trim() : "";
  const label = URGENT_CLEAR_REASONS.find((r) => r.code === code)!.label;
  const r = setCustomerUrgent(db, customerId, false, actor, via, note ? `${label}: ${note}` : label, { noBell: true, clearReasonCode: code, clearNote: note || null });
  return { status: 200, body: { id: customerId, isUrgent: false, changed: r.changed } };
}
