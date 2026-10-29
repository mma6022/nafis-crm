/**
 * instant-credit-check v1 (Armita sales-shell v1.0.3 §4د, Mohammad's approval): guard rails around the
 * existing ICS24 credit-check routes.
 *  - Rate limits (expert role only; admins/registrars unchanged): per expert and per customer per 24h on new
 *    inquiries, and per-check caps on OTP attempts and OTP re-sends.
 *  - An additive audit table (credit_check_audit): who, which customer/check, what action, source, consent and
 *    outcome. The OTP is NEVER written here (no column for it; detail text is scrubbed of it as well).
 */
import { crmDb, execute, queryRow } from "./crm-db";

export const CREDIT_LIMITS = {
  /** new inquiries an expert may start in 24h (all customers). */
  expertPerDay: envInt("CREDIT_CHECK_EXPERT_PER_DAY", 20),
  /** new inquiries for one customer in 24h (all users). */
  customerPerDay: envInt("CREDIT_CHECK_CUSTOMER_PER_DAY", 3),
  /** OTP submissions per check. */
  otpAttemptsPerCheck: envInt("CREDIT_CHECK_OTP_ATTEMPTS", 5),
  /** OTP re-sends per check. */
  renewsPerCheck: envInt("CREDIT_CHECK_RENEWS", 3),
};
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

let ready = false;
export function ensureCreditAuditSchema(): void {
  if (ready) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS credit_check_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      check_id INTEGER,
      action TEXT NOT NULL,
      source TEXT,
      consent INTEGER,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credit_check_audit_check ON credit_check_audit(check_id, action);
    CREATE INDEX IF NOT EXISTS idx_credit_check_audit_customer ON credit_check_audit(customer_id, created_at);
  `);
  ready = true;
}

export type CreditAuditAction = "initiate" | "validate" | "renew";
/** Replace every occurrence of the OTP (and any 4-8 digit run when an OTP was in play) before anything is stored or sent back. */
export function scrubOtp(text: string, otp?: string | null): string {
  let out = text;
  if (otp) {
    const digits = otp.trim();
    if (digits) out = out.split(digits).join("[کد]");
    out = out.replace(/(?<![\d])[0-9۰-۹٠-٩]{4,8}(?![\d])/g, "[کد]");
  }
  return out.slice(0, 240);
}
export function auditCredit(entry: {
  actorUserId: number; customerId: number; checkId?: number | null; action: CreditAuditAction;
  source?: string | null; consent?: boolean | null; outcome: string; detail?: string | null; otp?: string | null;
}): void {
  try {
    ensureCreditAuditSchema();
    execute(
      `INSERT INTO credit_check_audit (created_at,actor_user_id,customer_id,check_id,action,source,consent,outcome,detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [new Date().toISOString(), entry.actorUserId, entry.customerId, entry.checkId ?? null, entry.action,
        entry.source ?? null, entry.consent == null ? null : entry.consent ? 1 : 0, entry.outcome,
        entry.detail ? scrubOtp(entry.detail, entry.otp) : null],
    );
  } catch {
    // Audit must never break the inquiry itself (and never logs the payload).
  }
}

const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
/** Expert-only limits for a NEW provider inquiry. Returns a Persian message when blocked. */
export function initiateLimit(user: { id: number; role: string }, customerId: number): string | null {
  if (user.role !== "salesperson") return null;
  const since = dayAgo();
  const mine = queryRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_credit_checks WHERE requested_by_user_id=? AND created_at>=?", [user.id, since])?.n ?? 0;
  if (mine >= CREDIT_LIMITS.expertPerDay) {
    return `سقف استعلام امروز شما (${CREDIT_LIMITS.expertPerDay} استعلام در ۲۴ ساعت) پر شده است. فرم تماس را بدون استعلام ثبت کن.`;
  }
  const forCustomer = queryRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_credit_checks WHERE customer_id=? AND created_at>=?", [customerId, since])?.n ?? 0;
  if (forCustomer >= CREDIT_LIMITS.customerPerDay) {
    return `برای این مشتری در ۲۴ ساعت گذشته ${CREDIT_LIMITS.customerPerDay} استعلام انجام شده است؛ فردا دوباره امتحان کن.`;
  }
  return null;
}
/** Per-check caps (all roles): OTP attempts and re-sends, counted from the audit table. */
export function perCheckLimit(checkId: number, action: "validate" | "renew"): string | null {
  ensureCreditAuditSchema();
  const n = queryRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM credit_check_audit WHERE check_id=? AND action=? AND outcome<>'rate_limited'", [checkId, action])?.n ?? 0;
  if (action === "validate" && n >= CREDIT_LIMITS.otpAttemptsPerCheck) {
    return "دفعات واردکردن کد برای این استعلام تمام شد؛ استعلام تازه‌ای شروع کن.";
  }
  if (action === "renew" && n >= CREDIT_LIMITS.renewsPerCheck) {
    return "دفعات ارسال دوباره‌ی کد برای این استعلام تمام شد.";
  }
  return null;
}
