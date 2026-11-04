/** FILE-DETAIL v1.0 (Armita): per-user flag + guarded «resend signature link».
 *  Flag key: flag.file_detail_v1.user.N in call_queue_settings. Missing key = OFF. User 29 is never ON.
 *  Resend never creates, regenerates or re-templates a contract: it only addresses the SAME current
 *  generation that is already with the signing provider. Contract rows are only read here. */
import { crmDb, queryRow, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";

export const FD_FLAG_PREFIX = "flag.file_detail_v1.user.";
export const FD_BLOCKED_USERS = new Set([29]);
export const FD_RESEND_WINDOW_MS = 10 * 60_000;

export function fdOn(userId: number | null | undefined): boolean {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || FD_BLOCKED_USERS.has(id)) return false;
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [`${FD_FLAG_PREFIX}${id}`])?.value === "1"; }
  catch { return false; }
}

let schemaReady = false;
export function ensureFdSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS file_detail_link_resends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    generation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fd_link_resends_gen ON file_detail_link_resends(generation_id, sent_at);`);
  schemaReady = true;
}

/** Provider-side «send the same link again» is not part of the current signing integration
 *  (only login / files / sendContract / status are used, and calling sendContract again would
 *  create a NEW provider contract). Until the provider call is confirmed, delivery is refused
 *  honestly instead of creating anything. Replace this single function when it is confirmed. */
export type ResendDelivery = (gen: { id: number; providerContractId: string }) => Promise<"sent" | "unsupported">;
export const FD_RESEND_PROVIDER_READY = false;
export let fdDeliverResend: ResendDelivery = async () => "unsupported";
export function setFdDeliverResendForTests(fn: ResendDelivery) { fdDeliverResend = fn; }

/** Salespeople only see their own customers' files (same scope as the loan list). */
export function fdSeesApp(u: AuthUser, customerId: number): boolean {
  if (u.role !== "salesperson") return true;
  const owner = queryRow<{ sp: number | null }>("SELECT salesperson_id sp FROM customers WHERE id=?", [customerId]);
  return u.salespersonId != null && Number(owner?.sp) === Number(u.salespersonId);
}

export type ResendResult =
  | { ok: true; status: 200; sentAt: string }
  | { ok: false; status: number; error: string; message: string; retryAfterSeconds?: number };

const canSend = (u: AuthUser) => u.role === "admin" || (u.role === "salesperson" && u.permissions.includes("contracts.send"));
const fa = (n: number) => n.toLocaleString("fa-IR");

export async function fdResendSignatureLink(u: AuthUser, applicationId: number, generationId: number, now = new Date()): Promise<ResendResult> {
  const deny = (status: number, error: string, message: string): ResendResult => ({ ok: false, status, error, message });
  if (!fdOn(u.id)) return deny(404, "not_found", "این امکان برای شما فعال نیست.");
  if (!canSend(u)) return deny(403, "action_forbidden", "شما اجازه‌ی ارسال لینک امضا را ندارید.");
  const app = queryRow<any>("SELECT id, customer_id, status, stage, deleted_at, current_primary_generation_id FROM loan_applications WHERE id=?", [applicationId]);
  if (!app || app.deleted_at) return deny(404, "not_found", "پرونده پیدا نشد.");
  if (!fdSeesApp(u, Number(app.customer_id))) return deny(404, "not_found", "پرونده پیدا نشد.");
  if (app.status === "rejected" || ["completed"].includes(String(app.stage))) return deny(409, "file_closed", "این پرونده بسته شده است.");
  const gen = queryRow<any>(`SELECT id, status, provider_contract_id, loan_application_id, superseded_at, deleted_at, sent_at
    FROM contract_generations WHERE id=?`, [generationId]);
  if (!gen || Number(gen.loan_application_id) !== applicationId || gen.deleted_at || gen.superseded_at)
    return deny(409, "generation_not_current", "این قرارداد دیگر قرارداد جاری پرونده نیست.");
  if (String(gen.status) !== "sent" || !gen.provider_contract_id)
    return deny(409, "not_waiting_signature", "این قرارداد در انتظار امضای مشتری نیست.");
  ensureFdSchema();
  // «۱ بار در هر ۱۰ دقیقه برای هر قرارداد»: the original send counts too.
  const lastAt = fdLastSentAt(generationId, gen.sent_at);
  if (lastAt && now.getTime() - new Date(lastAt).getTime() < FD_RESEND_WINDOW_MS) {
    const wait = Math.max(1, Math.ceil((new Date(lastAt).getTime() + FD_RESEND_WINDOW_MS - now.getTime()) / 1000));
    const mins = Math.max(1, Math.ceil(wait / 60));
    return { ok: false, status: 429, error: "resend_rate_limited", retryAfterSeconds: wait,
      message: `لینک امضای این قرارداد کمتر از ۱۰ دقیقه پیش فرستاده شده است. ${fa(mins)} دقیقه‌ی دیگر دوباره امتحان کنید.` };
  }
  // Two quick presses must not send twice: one delivery per contract at a time.
  if (inFlight.has(generationId)) return { ok: false, status: 429, error: "resend_rate_limited", retryAfterSeconds: Math.ceil(FD_RESEND_WINDOW_MS / 1000),
    message: "لینک امضای این قرارداد همین الان در حال ارسال است." };
  inFlight.add(generationId);
  let outcome: "sent" | "unsupported";
  try { outcome = await fdDeliverResend({ id: Number(gen.id), providerContractId: String(gen.provider_contract_id) }); }
  catch { inFlight.delete(generationId); return deny(502, "resend_failed", "ارسال دوباره‌ی لینک انجام نشد. کمی بعد دوباره امتحان کنید."); }
  if (outcome !== "sent") { inFlight.delete(generationId); return deny(501, "resend_unavailable", "ارسال دوباره‌ی لینک از سامانه‌ی امضا هنوز فعال نیست."); }
  const sentAt = now.toISOString();
  try {
    crmDb.prepare("INSERT INTO file_detail_link_resends (application_id, generation_id, user_id, sent_at) VALUES (?,?,?,?)").run(applicationId, generationId, Number(u.id), sentAt);
    crmDb.prepare(`INSERT INTO loan_application_stage_history (application_id, from_stage, to_stage, action, reason, actor_id, created_at)
      VALUES (?,?,?,?,NULL,?,?)`).run(applicationId, app.stage ?? null, app.stage ?? null, `signature-link-resent:${generationId}`, Number(u.id), sentAt);
  } finally { inFlight.delete(generationId); }
  return { ok: true, status: 200, sentAt };
}
const inFlight = new Set<number>();

function fdLastSentAt(generationId: number, originalSentAt: string | null): string | null {
  const r = queryRow<{ last: string | null }>("SELECT MAX(sent_at) last FROM file_detail_link_resends WHERE generation_id=?", [generationId]);
  const c = [r?.last, originalSentAt].filter((x): x is string => typeof x === "string" && x !== "");
  return c.length ? c.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b)) : null;
}

/** Contracts of this file that are with the signing provider and not signed yet (status 'sent', current),
 *  with the last send time (first send or resend) and the seconds left in the 10-minute window. Read-only. */
export function fdLinkResendState(applicationId: number, now = new Date()) {
  ensureFdSchema();
  const gens = queryRows<any>(`SELECT id, generation_purpose, contract_number, provider_status, created_at, sent_at
    FROM contract_generations WHERE loan_application_id=? AND status='sent' AND provider_contract_id IS NOT NULL
      AND deleted_at IS NULL AND superseded_at IS NULL ORDER BY id DESC`, [applicationId]);
  return {
    available: FD_RESEND_PROVIDER_READY,
    items: gens.map((g) => {
      const last = fdLastSentAt(Number(g.id), g.sent_at ?? null);
      const left = last ? Math.ceil((new Date(last).getTime() + FD_RESEND_WINDOW_MS - now.getTime()) / 1000) : 0;
      return { generationId: Number(g.id), purpose: g.generation_purpose ?? "primary", contractNumber: g.contract_number ?? null,
        providerStatus: g.provider_status ?? null, createdAt: g.created_at, firstSentAt: g.sent_at ?? null,
        lastSentAt: last, retryAfterSeconds: Math.max(0, left) };
    }),
  };
}
