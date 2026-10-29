/**
 * lead_annotator (PM 2026-10-27 22:37): a separate capability, assignable to a user (and, later, to an assistant —
 * subject_kind 'assistant' is reserved in the table; nothing reads it yet). It is ADDITIVE to the user's role and allows,
 * on ANY customer, exactly two actions (routes/lead-annotator.ts):
 *   (a) add a note — stored with the actor's name and the «اینستاگرام» label (customer_annotations);
 *   (b) set / clear «مشتری فوری» with a REQUIRED reason — history row with the actor + one bell to the case's current owner
 *       (and Kazemi), lib/customer-urgent.ts.
 * Nothing else: no editing, no call / tel link, no transfer, no financial data. Its customer view is id, name, masked phone,
 * the urgent tick, the annotations and the urgent history — nothing more.
 *
 * Phone masking (PM 22:37, REQUIRED): for a user holding the capability, EVERY JSON / text response under /api is passed through
 * maskPhonesDeep (leadAnnotatorMask middleware in app.ts) — phone-ish keys are masked whole, and any Iranian mobile inside any
 * string (Latin / Persian / Arabic digits, 0 / 98 / +98 / 0098 prefix, spaces or dashes) becomes «0912*****67». Binary bodies
 * (files, audio) are not rewritten; no lead_annotator route returns one.
 *
 * Grant / revoke is a DB row (access_capabilities) written only by the release's lead_annotator.py (or an admin later); every
 * change is logged in access_capability_log. Never user 29; never the trainees 5 / 19 / 20.
 * db-injected (no crm-db import).
 */
import type { DatabaseSync } from "node:sqlite";

export const LEAD_ANNOTATOR = "lead_annotator";
export const LEAD_ANNOTATOR_NOTE_LABEL = "اینستاگرام";
export const LEAD_ANNOTATOR_BLOCKED_USERS = [29];
export const LEAD_ANNOTATOR_BLOCKED_SALESPERSONS = [5, 19, 20];
export const NOTE_MAX = null;

export function ensureLeadAnnotatorSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS access_capabilities (
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('user','assistant')),
      subject_id INTEGER NOT NULL,
      capability TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY(subject_kind, subject_id, capability));
    CREATE TABLE IF NOT EXISTS access_capability_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL, capability TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('grant','revoke')), by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS customer_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, body TEXT NOT NULL, label TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','assistant')), actor_user_id INTEGER, assistant_id INTEGER,
      actor_label TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_customer_annotations_customer ON customer_annotations(customer_id, id DESC);
    CREATE TABLE IF NOT EXISTS lead_annotator_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, customer_id INTEGER,
      result_count INTEGER, created_at TEXT NOT NULL);`);
}

let ready = new WeakSet<object>();
export function hasLeadAnnotator(db: DatabaseSync, userId: number): boolean {
  if (LEAD_ANNOTATOR_BLOCKED_USERS.includes(Number(userId))) return false;
  try {
    if (!ready.has(db)) { ensureLeadAnnotatorSchema(db); ready.add(db); }
    return Boolean(db.prepare("SELECT 1 x FROM access_capabilities WHERE subject_kind='user' AND subject_id=? AND capability=?").get(Number(userId), LEAD_ANNOTATOR));
  } catch { return false; }
}
export function resetLeadAnnotatorCache(): void { ready = new WeakSet(); }

/* ---------------- phone masking ---------------- */
const D = "[0-9۰-۹٠-٩]";
const SEP = "[\\s\\-\\u200c]?";
// optional prefix, then 9 + 9 more digits (Iranian mobile), not glued to other digits
const MOBILE_RE = new RegExp(`(?<![0-9۰-۹٠-٩])(?:\\+?98|0098|0|۰|٠|\\+?۹۸|۰۰۹۸)?${SEP}(?:9|۹|٩)${D}{2}${SEP}${D}{3}${SEP}${D}{2}${SEP}?${D}{2}(?![0-9۰-۹٠-٩])`, "g");
const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
function maskOne(m: string): string {
  const digits = latin(m).replace(/\D/g, "");
  const core = digits.slice(-10); // 9xxxxxxxxx
  return `0${core.slice(0, 3)}*****${core.slice(-2)}`;
}
export function maskPhonesInText(s: string): string { return s.replace(MOBILE_RE, maskOne); }
const PHONE_KEY = /(phone|mobile|tel$|^tel|msisdn|caller|callee|cell)/i;
function maskPhoneValue(v: string): string {
  if (v.includes("*")) return maskPhonesInText(v); // already masked («0912*****67»)
  const digits = latin(v).replace(/\D/g, "");
  if (digits.length < 5) return maskPhonesInText(v);
  return maskPhonesInText(v) !== v ? maskPhonesInText(v) : `${"*".repeat(Math.max(3, digits.length - 2))}${digits.slice(-2)}`;
}
/** Deep copy with every phone masked. Keys that look like a phone field are masked whole; every string is scanned. */
export function maskPhonesDeep(value: unknown, key = "", depth = 0): unknown {
  if (depth > 40) return value;
  if (typeof value === "string") return PHONE_KEY.test(key) ? maskPhoneValue(value) : maskPhonesInText(value);
  if (typeof value === "number" && PHONE_KEY.test(key) && String(value).length >= 5) return maskPhoneValue(String(value));
  if (Array.isArray(value)) return value.map((v) => maskPhonesDeep(v, key, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskPhonesDeep(v, k, depth + 1);
    return out;
  }
  return value;
}

/* ---------------- grant helpers (used by the release script's tests and a future admin page) ---------------- */
export function grantLeadAnnotator(db: DatabaseSync, userId: number, by: string): "granted" | "already" {
  ensureLeadAnnotatorSchema(db);
  const u = db.prepare("SELECT id, active, salesperson_id FROM users WHERE id=?").get(userId) as { id: number; active: number; salesperson_id: number | null } | undefined;
  if (!u || Number(u.active) !== 1) throw new Error("user_not_active");
  if (LEAD_ANNOTATOR_BLOCKED_USERS.includes(userId) || LEAD_ANNOTATOR_BLOCKED_SALESPERSONS.includes(Number(u.salesperson_id))) throw new Error("user_not_allowed");
  const at = new Date().toISOString();
  const r = db.prepare("INSERT OR IGNORE INTO access_capabilities(subject_kind,subject_id,capability,granted_by,granted_at) VALUES('user',?,?,?,?)").run(userId, LEAD_ANNOTATOR, by, at);
  if (!Number(r.changes)) return "already";
  db.prepare("INSERT INTO access_capability_log(subject_kind,subject_id,capability,action,by,at) VALUES('user',?,?,'grant',?,?)").run(userId, LEAD_ANNOTATOR, by, at);
  return "granted";
}
export function revokeLeadAnnotator(db: DatabaseSync, userId: number, by: string): "revoked" | "absent" {
  ensureLeadAnnotatorSchema(db);
  const r = db.prepare("DELETE FROM access_capabilities WHERE subject_kind='user' AND subject_id=? AND capability=?").run(userId, LEAD_ANNOTATOR);
  if (!Number(r.changes)) return "absent";
  db.prepare("INSERT INTO access_capability_log(subject_kind,subject_id,capability,action,by,at) VALUES('user',?,?,'revoke',?,?)").run(userId, LEAD_ANNOTATOR, by, new Date().toISOString());
  return "revoked";
}
