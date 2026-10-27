/**
 * crm-call-queue R3 (spec v1.6 §7ج-2/3, §7-v1.3 rpt_override, §8-27): «بررسی سپردن».
 * When Kazemi (or an admin) hands a customer to a closer (team-sales promoteInTx), the receiver's LIVE numbers are checked:
 * on-time report % > newPct (90) and overdue follow-ups < newMaxOverdue (5) — the same rule as cqDayStat.
 * transferMode "warn": the hand-off goes ahead only after the actor confirms with a mandatory reason (logged as override).
 * transferMode "block": no hand-off; Kazemi sees the reason and the receiver's way back; only an admin may override with a reason.
 * Never a receiver (no override): trainees, user 29, excludedReceivers (default [31]), anyone not eligible.
 * Behind flag.transfer_check (seeded '0'): OFF = no extra checks, no rows, responses unchanged. No lead routing, no owner-on-create,
 * team_sales_config / notification_settings untouched (a refused hand-off rolls the whole transaction back, cursor included).
 * Display / control only: no SMS, Bale, customer or staff message.
 */
import { execute, queryRow, queryRows } from "./crm-db";
import { CQ_EXCLUDED_USER_IDS, CQ_TRAINEE_SALESPERSON_IDS, CQ_TRAINEE_USER_IDS, cqDisciplineSettings, cqEligible, cqFlags, ensureCallQueueSchema, type CqUser } from "./call-queue";
import { cqDayStat, todayYmd } from "./call-queue-r2";
import { getTeamSalesConfig } from "./team-sales";

export const TRANSFER_REASON_MIN = 5;
export const TRANSFER_REASON_MAX = 500;

export type ReceiverCheck = {
  salespersonId: number; userId: number | null; name: string; eligible: boolean; excluded: boolean; ok: boolean;
  onTimePct: number | null; overdue: number; crmCalls: number; reasons: string[]; wayBack: string;
  settings: { newPct: number; newMaxOverdue: number; mode: "warn" | "block" };
};
export type TransferCheckPayload = ReceiverCheck & { canOverride: boolean; needReason: boolean; reasonError?: string; customerId: number };

/** Thrown inside promoteInTx when the hand-off must not happen as is. Carries the row to log after the rollback. */
export class TransferCheckError extends Error {
  constructor(public status: number, message: string, public payload: TransferCheckPayload, public logRow: TransferLogRow) { super(message); }
}

type TransferLogRow = { customerId: number; customerName: string | null; fromSp: number | null; toSp: number; toUser: number | null; actorUserId: number;
  source: string; mode: string; outcome: "ok" | "override" | "blocked"; reason: string | null; check: ReceiverCheck; at: string };

const fa = (v: string | number) => String(v).replace(/[0-9]/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

export function cqTransferCheckOn(): boolean { try { return cqFlags().transfer_check; } catch { return false; } }

/** Live check of one receiver (salesperson id). Read-only. No CRM-button call yet today = no % condition (counts as OK). */
export function cqReceiverCheck(toSp: number, now = new Date()): ReceiverCheck {
  const s = cqDisciplineSettings();
  const sp = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [toSp]);
  const u = queryRow<any>("SELECT id,role,salesperson_id salespersonId,active FROM users WHERE salesperson_id=? AND active=1 ORDER BY (role='salesperson') DESC, id LIMIT 1", [toSp]);
  const user: CqUser | null = u ? { id: Number(u.id), role: u.role, salespersonId: Number(u.salespersonId), active: Boolean(u.active) } : null;
  const excluded = CQ_TRAINEE_SALESPERSON_IDS.includes(toSp) || (user != null && (CQ_EXCLUDED_USER_IDS.includes(user.id) || CQ_TRAINEE_USER_IDS.includes(user.id)
    || s.excludedReceivers.includes(user.id)));
  const eligible = !excluded && cqEligible(user);
  const base = { salespersonId: toSp, userId: user?.id ?? null, name: sp?.name ?? "", settings: { newPct: s.newPct, newMaxOverdue: s.newMaxOverdue, mode: s.transferMode } };
  if (!eligible || !user) {
    return { ...base, eligible: false, excluded, ok: false, onTimePct: null, overdue: 0, crmCalls: 0,
      reasons: [excluded ? "این کاربر در فهرست مستثنای گیرنده‌ها است (کارآموز، کاربر مستثنا یا تا تأیید مدیر)." : "این کارشناس گیرنده‌ی مجاز سپردن نیست."],
      wayBack: "مدیر باید کارشناس پیگیری دیگری را در تنظیمات فروش تیمی تعیین کند." };
  }
  const d = cqDayStat(user, todayYmd(now), now);
  const way: string[] = [];
  if (d.onTimePct != null && d.onTimePct <= s.newPct) way.push(`گزارش تماس‌های بعدی را به‌موقع ثبت کند تا درصد به‌موقع از ${fa(s.newPct)}٪ بالاتر برود`);
  if (d.overdue >= s.newMaxOverdue) way.push(`${fa(d.overdue - s.newMaxOverdue + 1)} پیگیری عقب‌افتاده را انجام دهد تا کمتر از ${fa(s.newMaxOverdue)} بماند`);
  return { ...base, eligible: true, excluded: false, ok: d.ok, onTimePct: d.onTimePct, overdue: d.overdue, crmCalls: d.crmCalls,
    reasons: d.reasons, wayBack: way.length ? `راه برگشت: ${way.join("؛ ")}.` : "" };
}

/* Override context: set by the route for the duration of one synchronous call (node:sqlite is sync, so no interleaving). */
let overrideCtx: { reason: string | null } | null = null;
export function withTransferOverride<T>(reason: unknown, fn: () => T): T {
  const prev = overrideCtx;
  overrideCtx = { reason: typeof reason === "string" ? reason.trim().slice(0, TRANSFER_REASON_MAX + 1) || null : null };
  try { return fn(); } finally { overrideCtx = prev; }
}

function logRow(r: TransferLogRow): number {
  ensureCallQueueSchema();
  return execute(`INSERT INTO call_queue_transfers(customer_id,customer_name,from_salesperson_id,to_salesperson_id,to_user_id,actor_user_id,source,mode,outcome,override,override_reason,
      on_time_pct,overdue,reasons_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.customerId, r.customerName, r.fromSp, r.toSp, r.toUser, r.actorUserId, r.source, r.mode, r.outcome, r.outcome === "override" ? 1 : 0, r.reason,
      r.check.onTimePct, r.check.overdue, JSON.stringify(r.check.reasons), r.at]);
}
/** After a refused hand-off rolled back: keep the «blocked» row for the manager report (best effort, never throws). */
export function cqLogRefusedTransfer(e: TransferCheckError): void { try { logRow(e.logRow); } catch { /* never break the response */ } }

/**
 * Gate inside promoteInTx, after the closer is chosen and BEFORE any write of that hand-off.
 * Returns silently when OFF / ok / valid override (then the ok|override row is written in the same transaction); throws TransferCheckError otherwise.
 */
export function cqTransferGate(a: { customerId: number; customerName: string | null; fromSp: number | null; toSp: number;
  actor: { id: number; role: string }; source: string; now: Date }): void {
  if (!cqTransferCheckOn()) return;
  const s = cqDisciplineSettings();
  const check = cqReceiverCheck(a.toSp, a.now);
  const reason = overrideCtx?.reason ?? null;
  const row = (outcome: TransferLogRow["outcome"], why: string | null): TransferLogRow => ({ customerId: a.customerId, customerName: a.customerName, fromSp: a.fromSp,
    toSp: a.toSp, toUser: check.userId, actorUserId: a.actor.id, source: a.source, mode: s.transferMode, outcome, reason: why, check, at: a.now.toISOString() });
  if (check.ok) { logRow(row("ok", null)); return; }
  const isAdmin = a.actor.role === "admin";
  const canOverride = check.eligible && (s.transferMode === "warn" || isAdmin);
  const payload = (reasonError?: string): TransferCheckPayload => ({ ...check, customerId: a.customerId, canOverride, needReason: canOverride, ...(reasonError ? { reasonError } : {}) });
  if (canOverride && reason) {
    if (reason.length < TRANSFER_REASON_MIN || reason.length > TRANSFER_REASON_MAX) {
      throw new TransferCheckError(400, `دلیل نادیده گرفتن شرط باید بین ${fa(TRANSFER_REASON_MIN)} تا ${fa(TRANSFER_REASON_MAX)} نویسه باشد.`,
        payload("دلیل کوتاه یا بلند است."), row("blocked", reason.slice(0, TRANSFER_REASON_MAX)));
    }
    logRow(row("override", reason)); return;
  }
  const who = check.name || "کارشناس گیرنده";
  const msg = !check.eligible ? `سپردن به ${who} ممکن نیست: ${check.reasons.join("؛ ")}`
    : canOverride ? `${who} امروز شرط دریافت مشتری را ندارد (${check.reasons.join("؛ ")}). برای سپردن، دلیل نادیده گرفتن شرط را بنویسید.`
    : `سپردن انجام نشد: ${who} امروز شرط دریافت مشتری را ندارد (${check.reasons.join("؛ ")}). ${check.wayBack}`.trim();
  throw new TransferCheckError(409, msg, payload(), row("blocked", reason));
}

/** For the confirm dialog (GET /sales/next-closer): the receiver's check, only when the flag is on. */
export function cqTransferPreview(toSp: number, actorRole: string, now = new Date()) {
  if (!cqTransferCheckOn()) return null;
  const s = cqDisciplineSettings(); const c = cqReceiverCheck(toSp, now);
  return { ...c, canOverride: c.ok ? false : c.eligible && (s.transferMode === "warn" || actorRole === "admin"), needReason: !c.ok && c.eligible && (s.transferMode === "warn" || actorRole === "admin") };
}

/** Manager report (§7-v1.3 rpt_mgr «انتقال با نادیده گرفتن شرط»). */
export function cqTransfers(q: { outcome?: unknown; day?: unknown; limit?: unknown }) {
  if (!cqTransferCheckOn() && !queryRow("SELECT 1 FROM call_queue_transfers LIMIT 1")) return { enabled: false as const, items: [] };
  const where: string[] = []; const params: string[] = [];
  if (q.outcome === "override" || q.outcome === "blocked" || q.outcome === "ok") { where.push("t.outcome=?"); params.push(q.outcome); }
  if (typeof q.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.day)) { where.push("substr(t.created_at,1,10)=?"); params.push(q.day); }
  const lim = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const items = queryRows<any>(`SELECT t.id,t.customer_id customerId,t.customer_name customerName,t.from_salesperson_id fromSalespersonId,fs.name fromName,
      t.to_salesperson_id toSalespersonId,ts.name toName,t.actor_user_id actorUserId,COALESCE(u.full_name,u.username) actorName,t.source,t.mode,t.outcome,t.override,
      t.override_reason overrideReason,t.on_time_pct onTimePct,t.overdue,t.reasons_json reasonsJson,t.created_at createdAt
    FROM call_queue_transfers t LEFT JOIN salespersons fs ON fs.id=t.from_salesperson_id LEFT JOIN salespersons ts ON ts.id=t.to_salesperson_id LEFT JOIN users u ON u.id=t.actor_user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.id DESC LIMIT ${lim}`, params)
    .map(r => { let reasons: string[] = []; try { reasons = JSON.parse(r.reasonsJson ?? "[]"); } catch { /* */ } const { reasonsJson, ...rest } = r; return { ...rest, override: Boolean(r.override), reasons }; });
  const counts = Object.fromEntries(queryRows<{ outcome: string; n: number }>("SELECT outcome,count(*) n FROM call_queue_transfers GROUP BY outcome").map(r => [r.outcome, Number(r.n)]));
  return { enabled: cqTransferCheckOn(), items, counts };
}

/** ds_ok / ds_out line for the expert's own panel. */
export function cqMyReceiveLine(user: CqUser, now = new Date()) {
  if (!cqTransferCheckOn() || !cqEligible(user) || cqDisciplineSettings().excludedReceivers.includes(user.id)) return null;
  // Only closers receive hand-offs (the qualifier, Kazemi, hands them out).
  let closers: number[] = []; try { closers = getTeamSalesConfig().closerSalespersonIds; } catch { closers = []; }
  if (!closers.includes(Number(user.salespersonId))) return null;
  const c = cqReceiverCheck(Number(user.salespersonId), now);
  return c.ok ? { ok: true, text: "امروز می‌توانی مشتری تحویل بگیری." }
    : { ok: false, text: `امروز مشتری تازه به تو سپرده نمی‌شود چون ${c.reasons.join("؛ ")}. ${c.wayBack}`.trim() };
}
