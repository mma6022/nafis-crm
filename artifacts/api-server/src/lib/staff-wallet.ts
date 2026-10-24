/**
 * Staff wallet («کیف پول من») and commission status («وضعیت تراکنش‌ها») read models.
 *
 * READ-ONLY: every function here only SELECTs from the existing commission ledger, team-commission purchases and payment orders.
 * Nothing is written, nothing is recomputed, no notification or SMS is sent.
 * Visibility (decision 5): a salesperson sees only their own wallet; admin sees everyone; accounting sees commission STATUS only, no amounts.
 */
import { queryRow, queryRows } from "./crm-db";
import { toLatinDigits } from "./customer-id-search";
import type { AuthUser } from "./auth";
import {
  COMMISSION_KINDS, ensureTeamCommissionSchema, jalaliDateStart, nextPersianMonth, persianMonthOf, qualifierP1Event, salespersonBreakdown, settingsAt, teamMembers,
  type TeamCommissionSettings,
} from "./team-commission";

const MONTH_SQL = "COALESCE(m.commission_month,g.commission_month,'')";
const NEUTRALIZED_SQL = "EXISTS (SELECT 1 FROM team_commission_ledger_meta r WHERE r.kind='paid_mark_reversal' AND CAST(json_extract(r.meta_json,'$.reversedLedgerId') AS INTEGER)=l.id)";
const big = (v: unknown): bigint => { const s = String(v ?? "0"); return /^-?\d{1,30}$/.test(s) ? BigInt(s) : 0n; };
const json = (s: unknown) => { try { return typeof s === "string" && s ? JSON.parse(s) : null; } catch { return null; } };

export class StaffWalletError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type MemberRole = "closer" | "qualifier" | "other";
function memberRole(id: number): MemberRole {
  const { qualifierId, closerIds } = teamMembers();
  return Number(qualifierId) === id ? "qualifier" : closerIds.map(Number).includes(id) ? "closer" : "other";
}
const isAdmin = (u: AuthUser) => u.role === "admin";
/** Accounting-like: may mark payment orders paid (decision 2). Sees commission status without amounts. */
export const canSeeCommissionStatus = (u: AuthUser) => isAdmin(u) || u.permissions.includes("payment_orders.pay");

/** Which salesperson's wallet the viewer may open. Non-admins: only their own. */
export function resolveWalletOwner(u: AuthUser, requested: unknown): number {
  const asked = requested === undefined || requested === null || requested === "" ? null : Number(requested);
  if (asked !== null && (!Number.isInteger(asked) || asked <= 0)) throw new StaffWalletError(400, "کارشناس نامعتبر است.");
  if (isAdmin(u)) {
    if (asked !== null) {
      if (!queryRow("SELECT 1 FROM salespersons WHERE id=?", [asked])) throw new StaffWalletError(404, "کارشناس پیدا نشد.");
      return asked;
    }
    const first = walletPickers()[0];
    if (!first) throw new StaffWalletError(404, "کارشناسی برای نمایش نیست.");
    return first.id;
  }
  if (u.salespersonId == null) throw new StaffWalletError(403, "کیف پول فقط برای کارشناس‌های فروش است.");
  if (asked !== null && asked !== Number(u.salespersonId)) throw new StaffWalletError(403, "هر کارشناس فقط کیف پول خودش را می‌بیند.");
  return Number(u.salespersonId);
}

/** Admin picker: team members first (closers, then qualifier), then anyone else with a commission wallet or ledger row. */
export function walletPickers(): Array<{ id: number; name: string; role: MemberRole }> {
  const { qualifierId, closerIds } = teamMembers();
  const team = [...closerIds.map(Number), Number(qualifierId)];
  const others = queryRows<any>(`SELECT DISTINCT id FROM (SELECT salesperson_id id FROM goods_salesperson_wallets UNION SELECT salesperson_id FROM goods_finance_ledger
    WHERE kind IN (${COMMISSION_KINDS.map(() => "?").join(",")}) AND salesperson_id IS NOT NULL) ORDER BY id`, [...COMMISSION_KINDS]).map((r) => Number(r.id));
  const ids = [...new Set([...team, ...others])];
  return ids.flatMap((id) => {
    const s = queryRow<any>("SELECT name FROM salespersons WHERE id=?", [id]);
    return s ? [{ id, name: s.name ?? `#${id}`, role: memberRole(id) }] : [];
  });
}

function tierInfo(salespersonId: number, month: string) {
  const t = queryRow<any>("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?", [salespersonId]);
  if (!t) return null;
  // Same month total the posting uses for the tier: completed purchases with a commission in this month, reversed cases excluded.
  const sales = queryRows<any>(`SELECT COALESCE(tp.basis_amount_toman,g.base_payout_amount_toman,g.payout_amount_toman) amt FROM goods_purchases g
    LEFT JOIN team_commission_purchases tp ON tp.purchase_id=g.id
    WHERE g.salesperson_id=? AND g.stage='completed' AND g.commission_month=? AND g.commission_toman IS NOT NULL AND (tp.status IS NULL OR tp.status<>'reversed')`,
    [salespersonId, month]).reduce((s, r) => s + big(r.amt), 0n);
  const targets = [big(t.target1_toman), big(t.target2_toman), big(t.target3_toman)];
  const rates = [t.rate0_bps, t.rate1_bps, t.rate2_bps, t.rate3_bps].map(Number);
  const tier = sales >= targets[2] ? 3 : sales >= targets[1] ? 2 : sales >= targets[0] ? 1 : 0;
  const next = tier < 3 ? targets[tier] : null;
  return {
    salesToman: sales.toString(), tier, rateBps: rates[tier],
    nextTier: tier < 3 ? tier + 1 : null, nextTargetToman: next?.toString() ?? null, remainingToman: next !== null ? (next - sales).toString() : null,
    tiers: [0, 1, 2, 3].map((i) => ({ tier: i, fromToman: i === 0 ? "0" : targets[i - 1].toString(), rateBps: rates[i] })),
  };
}

type PendingItem = {
  purchaseId: number; customerId: number; customerName: string | null; kind: "salesperson_commission" | "p1_referral_share";
  closerName: string | null; paymentOrderId: number | null; paymentOrderStage: string | null; state: string; since: string | null;
};
/** Purchases waiting for «پرداخت‌شده» that will earn this salesperson something. No amounts (decision 2). */
function pendingFor(salespersonId: number): PendingItem[] {
  const role = memberRole(salespersonId);
  const rows = queryRows<any>(`SELECT t.purchase_id,t.customer_id,t.salesperson_id,t.settings_json,t.entered_at,t.last_error,c.name customer_name,s.name closer_name,
      o.id order_id,o.stage order_stage,o.paid_at,COALESCE(o.updated_at,o.created_at) order_changed
    FROM team_commission_purchases t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN salespersons s ON s.id=t.salesperson_id
    LEFT JOIN customer_payment_orders o ON o.purchase_id=t.purchase_id
    WHERE t.status='pending_payout' ${role === "qualifier" ? "" : "AND t.salesperson_id=?"} ORDER BY t.entered_at DESC LIMIT 300`, role === "qualifier" ? [] : [salespersonId]);
  const { closerIds } = teamMembers();
  const out: PendingItem[] = [];
  for (const r of rows) {
    const s = json(r.settings_json) as TeamCommissionSettings | null;
    // A deposit dated before the model start never earns a new-model commission: not "pending".
    if (r.order_stage === "paid" && r.paid_at && s?.modelStartDate && new Date(r.paid_at) < jalaliDateStart(s.modelStartDate)) continue;
    let kind: PendingItem["kind"] | null = null;
    if (Number(r.salesperson_id) === salespersonId) kind = "salesperson_commission";
    else if (role === "qualifier" && s && closerIds.map(Number).includes(Number(r.salesperson_id)) && qualifierP1Event(Number(r.customer_id), s)) kind = "p1_referral_share";
    if (!kind) continue;
    out.push({
      purchaseId: Number(r.purchase_id), customerId: Number(r.customer_id), customerName: r.customer_name ?? null, kind,
      closerName: kind === "p1_referral_share" ? (r.closer_name ?? null) : null,
      paymentOrderId: r.order_id ?? null, paymentOrderStage: r.order_stage ?? null,
      state: r.order_stage === "paid" ? "manager" : r.order_stage ?? "no_order",
      since: r.order_changed ?? r.entered_at ?? null,
    });
  }
  return out;
}

const LEDGER_SELECT = `SELECT l.id,l.purchase_id purchaseId,l.customer_id customerId,c.name customerName,l.kind,l.amount_toman amountToman,l.created_at createdAt,
    ${MONTH_SQL} month,m.meta_json metaJson,m.settings_version_id settingsVersionId,${NEUTRALIZED_SQL} neutralized,
    g.completed_at completedAt,o.id paymentOrderId,o.stage paymentOrderStage,
    (SELECT MAX(e.created_at) FROM goods_purchase_events e WHERE e.purchase_id=l.purchase_id AND e.action='team_commission_posted' AND e.created_at<=l.created_at) depositAt,
    (SELECT pu.role FROM users pu WHERE pu.id=o.paid_by) paidByRole
  FROM goods_finance_ledger l LEFT JOIN team_commission_ledger_meta m ON m.ledger_id=l.id LEFT JOIN goods_purchases g ON g.id=l.purchase_id
  LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN customer_payment_orders o ON o.purchase_id=l.purchase_id`;
function ledgerRow(r: any) {
  const meta = json(r.metaJson);
  const model = Boolean(meta && (meta.model === "team" || meta.p1Kind));
  return {
    id: Number(r.id), purchaseId: r.purchaseId ?? null, customerId: r.customerId ?? null, customerName: r.customerName ?? null, kind: r.kind,
    amountToman: String(r.amountToman), month: r.month || null, createdAt: r.createdAt, model: model ? "team" : meta ? "team" : "legacy",
    // «تاریخ واقعی واریز»: the posting event of a team-model row carries the deposit date entered with «پرداخت‌شده».
    date: model && r.depositAt ? r.depositAt : r.createdAt,
    neutralized: Boolean(r.neutralized), completedAt: r.completedAt ?? null, paymentOrderId: r.paymentOrderId ?? null, paymentOrderStage: r.paymentOrderStage ?? null,
    paidByRole: model ? (r.paidByRole ?? null) : null, settingsVersionId: r.settingsVersionId ?? null,
    meta: meta ? {
      tier: meta.tier ?? null, rateBps: meta.rateBps ?? null, basisAmountToman: meta.basisAmountToman ?? null, p1Kind: meta.p1Kind ?? null,
      reversedLedgerId: meta.reversedLedgerId ?? null, reversedKind: meta.reversedKind ?? null, reason: meta.reason ?? null,
    } : null,
  };
}

export function staffWallet(u: AuthUser, query: { salespersonId?: unknown; month?: unknown }) {
  ensureTeamCommissionSchema();
  const id = resolveWalletOwner(u, query.salespersonId);
  const currentMonth = persianMonthOf(new Date());
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(query.month ?? "")) ? String(query.month) : currentMonth;
  const sp = queryRow<any>("SELECT id,name FROM salespersons WHERE id=?", [id]);
  const role = memberRole(id);
  const report = salespersonBreakdown(id, month, null);
  const settings = settingsAt().settings;
  const kinds = COMMISSION_KINDS as readonly string[];
  const ledger = queryRows<any>(`${LEDGER_SELECT} WHERE l.salesperson_id=? AND l.kind IN (${kinds.map(() => "?").join(",")}) ORDER BY l.id DESC LIMIT 500`, [id, ...kinds]).map(ledgerRow);
  const monthRows = report.breakdown.reduce((n, b) => n + b.count, 0);
  const p1 = report.breakdown.find((b) => b.kind === "p1_referral_share");
  return {
    viewer: isAdmin(u) ? "admin" : "self",
    salesperson: { id, name: sp?.name ?? `#${id}`, role },
    pickers: isAdmin(u) ? walletPickers() : undefined,
    currentMonth, month,
    balanceToman: String(queryRow<any>("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=?", [id])?.balance_toman ?? "0"),
    monthPostedToman: report.monthTotalToman, monthRowCount: monthRows,
    breakdown: report.breakdown, stats: report.stats,
    tier: role === "qualifier" ? null : tierInfo(id, month),
    p1Month: { totalToman: p1?.totalToman ?? "0", count: p1?.count ?? 0 },
    teamBonusEnabled: Boolean(settings.teamBonusEnabled),
    modelEnabled: Boolean(settings.enabled), modelStartDate: settings.modelStartDate,
    pending: pendingFor(id),
    ledger,
  };
}

// ---------------------------------------------------------------- commission status («وضعیت تراکنش‌ها» › پورسانت‌ها)
const GROUP_SQL = `CASE WHEN t.status='posted' THEN 'paid' WHEN t.status='reversed' THEN 'back' WHEN o.stage='paid' THEN 'err' ELSE 'wait' END`;
const CHANGED_SQL = `COALESCE(t.reversed_at,t.posted_at,CASE WHEN o.stage='paid' THEN o.paid_at END,o.updated_at,o.created_at,t.entered_at)`;
const PO_STAGES = ["sales_approval", "admin_approval", "awaiting_payment", "paid"];
const dateParam = (v: unknown) => (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(v ?? "")) ? String(v) : null);

export function commissionStatusList(u: AuthUser, q: Record<string, unknown>) {
  if (!canSeeCommissionStatus(u)) throw new StaffWalletError(403, "این بخش فقط برای مدیر و حسابداری است.");
  ensureTeamCommissionSchema();
  const admin = isAdmin(u);
  const page = Math.max(1, Math.min(100000, Number(q.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 25));
  const groups = admin ? ["wait", "paid", "back", "err"] : ["wait", "paid", "back"];
  const group = groups.includes(String(q.group)) ? String(q.group) : "all";
  const where: string[] = [];
  const params: Array<string | number> = [];
  const search = String(q.search ?? "").trim().slice(0, 100);
  if (search) {
    // A number (Latin/Persian/Arabic digits, optional «#») = purchase #, order #, customer id (shared customer-ID search) or mobile part.
    const digits = toLatinDigits(search).replace(/^[#＃]\s*/, "");
    if (/^\d{1,9}$/.test(digits)) { where.push("(t.purchase_id=? OR o.id=? OR c.id=? OR c.phone LIKE ?)"); params.push(Number(digits), Number(digits), Number(digits), `%${digits}%`); }
    else { where.push("crm_persian_search_key(c.name) LIKE crm_persian_search_key(?)"); params.push(`%${search}%`); }
  }
  if (q.salespersonId && Number.isInteger(Number(q.salespersonId))) { where.push("(t.salesperson_id=? OR t.qualifier_salesperson_id=?)"); params.push(Number(q.salespersonId), Number(q.salespersonId)); }
  if (PO_STAGES.includes(String(q.stage))) { where.push("o.stage=?"); params.push(String(q.stage)); }
  const from = dateParam(q.from), to = dateParam(q.to);
  if (from) { where.push(`${CHANGED_SQL}>=?`); params.push(from); }
  if (to) { where.push(`${CHANGED_SQL}<=?`); params.push(to); }
  const base = `FROM team_commission_purchases t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN customer_payment_orders o ON o.purchase_id=t.purchase_id`;
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRows = queryRows<any>(`SELECT ${GROUP_SQL} grp,COUNT(*) n ${base} ${w} GROUP BY grp`, params);
  const counts: Record<string, number> = { all: 0, wait: 0, paid: 0, back: 0, ...(admin ? { err: 0 } : {}) };
  for (const r of countRows) {
    const g = !admin && r.grp === "err" ? "paid" : r.grp; // accounting: «خطای ثبت» rows show as paid (decision 3)
    counts[g] = (counts[g] ?? 0) + Number(r.n); counts.all += Number(r.n);
  }
  const groupWhere = group === "all" ? "" : !admin && group === "paid" ? `${GROUP_SQL} IN ('paid','err')` : `${GROUP_SQL}=?`;
  const fullWhere = [w ? where.join(" AND ") : "", groupWhere].filter(Boolean).join(" AND ");
  const listParams = [...params, ...(groupWhere && groupWhere.endsWith("=?") ? [group] : [])];
  const total = Number(queryRow<any>(`SELECT COUNT(*) n ${base} ${fullWhere ? `WHERE ${fullWhere}` : ""}`, listParams)?.n ?? 0);
  const rows = queryRows<any>(`SELECT t.*,${GROUP_SQL} grp,${CHANGED_SQL} changed_at,c.name customer_name,s.name salesperson_name,q.name qualifier_name,
      o.id order_id,o.stage order_stage,o.paid_at
    ${base} LEFT JOIN salespersons s ON s.id=t.salesperson_id LEFT JOIN salespersons q ON q.id=t.qualifier_salesperson_id
    ${fullWhere ? `WHERE ${fullWhere}` : ""} ORDER BY changed_at DESC,t.purchase_id DESC LIMIT ? OFFSET ?`, [...listParams, limit, (page - 1) * limit]);
  const items = rows.map((r) => statusItem(r, admin));
  const salespersons = queryRows<any>(`SELECT DISTINCT s.id,s.name FROM team_commission_purchases t JOIN salespersons s ON s.id IN (t.salesperson_id,t.qualifier_salesperson_id) ORDER BY s.name`)
    .map((s) => ({ id: Number(s.id), name: s.name }));
  return { items, total, page, limit, counts, salespersons, viewer: admin ? "admin" : "accounting" };
}

function ledgerFor(purchaseId: number) {
  return queryRows<any>(`SELECT l.id,l.kind,l.amount_toman,l.salesperson_id,s.name salesperson_name,l.created_at,${NEUTRALIZED_SQL} neutralized,
      m.commission_month month,m.meta_json
    FROM goods_finance_ledger l LEFT JOIN team_commission_ledger_meta m ON m.ledger_id=l.id LEFT JOIN salespersons s ON s.id=l.salesperson_id
    WHERE l.purchase_id=? AND m.ledger_id IS NOT NULL AND l.kind IN (${COMMISSION_KINDS.map(() => "?").join(",")}) ORDER BY l.id`, [purchaseId, ...COMMISSION_KINDS]);
}

function statusItem(r: any, admin: boolean) {
  const grp = !admin && r.grp === "err" ? "paid" : r.grp;
  const base = {
    purchaseId: Number(r.purchase_id), customerId: Number(r.customer_id), customerName: r.customer_name ?? null,
    salespersonId: Number(r.salesperson_id), salespersonName: r.salesperson_name ?? null,
    group: grp, paymentOrderId: r.order_id ?? null, paymentOrderStage: r.order_stage ?? null,
    enteredAt: r.entered_at ?? null, paidAt: r.order_stage === "paid" ? r.paid_at ?? null : null, postedAt: r.posted_at ?? null, reversedAt: r.reversed_at ?? null,
    changedAt: r.changed_at ?? null, commissionMonth: r.commission_month ?? null, reversalMonth: r.reversal_month ?? null,
    // Accounting sees the status only: posted («ثبت شد»), not posted («—») or with the manager («در دست مدیر»).
    commissionState: r.grp === "paid" ? "posted" : r.grp === "back" ? "reversed" : r.grp === "err" ? "manager" : "none",
  };
  if (!admin) return base;
  const rows = ledgerFor(Number(r.purchase_id));
  const live = rows.filter((x) => !x.neutralized && x.kind !== "paid_mark_reversal");
  const net = live.reduce((s, x) => s + big(x.amount_toman), 0n);
  const closerLedger = live.find((x) => x.kind === "salesperson_commission");
  return {
    ...base, rawStatus: r.status, lastError: r.last_error ?? null, reversalReason: r.reversal_reason ?? null,
    basisAmountToman: r.basis_amount_toman ?? null, closerRateBps: r.closer_rate_bps ?? null, closerCommissionToman: r.closer_commission_toman ?? null,
    p1Kind: r.p1_kind ?? null, p1ShareToman: r.p1_share_toman ?? null, qualifierName: r.qualifier_name ?? null,
    netToman: rows.length ? net.toString() : null, ledgerId: closerLedger ? Number(closerLedger.id) : null,
  };
}

export function commissionStatusDetail(u: AuthUser, purchaseId: number) {
  if (!canSeeCommissionStatus(u)) throw new StaffWalletError(403, "این بخش فقط برای مدیر و حسابداری است.");
  ensureTeamCommissionSchema();
  const admin = isAdmin(u);
  const r = queryRow<any>(`SELECT t.*,${GROUP_SQL} grp,${CHANGED_SQL} changed_at,c.name customer_name,s.name salesperson_name,q.name qualifier_name,
      o.id order_id,o.stage order_stage,o.paid_at,g.completed_at
    FROM team_commission_purchases t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN customer_payment_orders o ON o.purchase_id=t.purchase_id
    LEFT JOIN salespersons s ON s.id=t.salesperson_id LEFT JOIN salespersons q ON q.id=t.qualifier_salesperson_id LEFT JOIN goods_purchases g ON g.id=t.purchase_id
    WHERE t.purchase_id=?`, [purchaseId]);
  if (!r) throw new StaffWalletError(404, "این خرید در مدل فروش تیمی نیست.");
  const item = statusItem(r, admin);
  const timeline: Array<{ at: string; action: string; actorName?: string | null; actorRole?: string | null; detail?: Record<string, unknown> | null }> = [];
  timeline.push({ at: r.entered_at ?? r.completed_at, action: "entered" });
  if (r.order_id) {
    const ev = queryRows<any>(`SELECT e.action,e.created_at,e.detail,COALESCE(NULLIF(u.full_name,''),u.username) actor_name,u.role actor_role FROM customer_payment_order_events e
      LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=? AND e.action IN ('created','sales_approved','admin_approved','payment_recorded','payment_reverted') ORDER BY e.created_at,e.id`, [r.order_id]);
    for (const e of ev) {
      const d = json(e.detail);
      timeline.push({ at: e.created_at, action: `order_${e.action}`, actorName: e.actor_name ?? null, actorRole: e.actor_role ?? null,
        detail: e.action === "payment_reverted" ? { reason: d?.reason ?? null } : null });
    }
  }
  const lastPaid = [...timeline].reverse().find((t) => t.action === "order_payment_recorded");
  if (lastPaid && r.order_stage === "paid") lastPaid.detail = { paidAt: r.paid_at ?? null }; // «تاریخ واقعی واریز» entered with «پرداخت‌شده»
  const pev = queryRows<any>(`SELECT e.action,e.created_at,e.detail,COALESCE(NULLIF(u.full_name,''),u.username) actor_name FROM goods_purchase_events e LEFT JOIN users u ON u.id=e.actor_user_id
    WHERE e.purchase_id=? AND e.action IN ('team_commission_posted','team_commission_reversed','team_commission_unposted') ORDER BY e.created_at,e.id`, [purchaseId]);
  for (const e of pev) {
    const d = json(e.detail);
    timeline.push({ at: e.created_at, action: e.action, actorName: admin ? e.actor_name ?? null : null,
      detail: e.action === "team_commission_reversed" ? { month: d?.month ?? null, reason: d?.reason ?? null } : e.action === "team_commission_posted" ? { month: d?.month ?? null } : null });
  }
  timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const ledger = admin ? ledgerFor(purchaseId).map((x) => ({ id: Number(x.id), kind: x.kind, amountToman: String(x.amount_toman), salespersonName: x.salesperson_name ?? null,
    month: x.month ?? null, createdAt: x.created_at, neutralized: Boolean(x.neutralized) })) : [];
  return {
    ...item, timeline, ledger, viewer: admin ? "admin" : "accounting",
    canRetry: admin && r.grp === "err", canReverse: admin && r.grp === "paid" && r.order_stage === "paid", canUnpay: admin && r.order_stage === "paid" && r.grp !== "back",
    canOpenOrder: Boolean(r.order_id) && r.order_stage === "awaiting_payment",
    reverseMonth: admin ? nextPersianMonth(persianMonthOf(new Date())) : null,
  };
}
