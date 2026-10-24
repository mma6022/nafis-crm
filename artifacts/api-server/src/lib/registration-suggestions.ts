import type { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./auth";
import { paymentOrderListScope } from "./payment-order-scope";

type Actor = Pick<AuthUser, "role" | "customerScope" | "salespersonId">;
type AccessActor = Actor & Pick<AuthUser, "permissions">;
export type QueueAccess = { mode: "create" | "view"; actor: Actor } | null;
const permitted = (u: AccessActor, p: string) => u.role === "admin" || (u.permissions ?? []).includes(p);

/**
 * «در انتظار ایجاد» visibility (approved 2 Aban): creators (admin, registrar — whoever already holds the create
 * permission) get the queue with its buttons and their normal customer scope. A salesperson (any non-finance role
 * bound to a salesperson identity, holding the view permission) sees the queue read-only, always limited to their own
 * customers, whatever their role's customer scope. Accounting and funders get nothing. Permissions are not changed.
 */
export function goodsQueueAccess(u: AccessActor): QueueAccess {
  if (!permitted(u, "goods_purchases.view")) return null;
  if (permitted(u, "goods_purchases.manage") && !["salesperson", "accounting", "funder"].includes(u.role)) return { mode: "create", actor: u };
  return ownOnly(u);
}
export function paymentQueueAccess(u: AccessActor): QueueAccess {
  if (!permitted(u, "payment_orders.view")) return null;
  if (permitted(u, "payment_orders.create")) return { mode: "create", actor: u };
  return ownOnly(u);
}
function ownOnly(u: AccessActor): QueueAccess {
  if (u.role === "admin" || u.role === "accounting" || u.role === "funder" || u.salespersonId == null) return null;
  return { mode: "view", actor: { role: u.role, customerScope: "assigned", salespersonId: u.salespersonId } };
}

/**
 * Whole Tehran calendar days between `col` and now (Iran has had a fixed UTC+03:30 offset since 2022), so a row that
 * became ready yesterday evening is «۱ روز» this morning, not «از امروز».
 */
const waitDaysSql = (col: string) =>
  `CAST(julianday(date('now','+210 minutes')) - julianday(date(${col},'+210 minutes')) AS INTEGER)`;
export const OLD_WAIT_DAYS = 7;
const positiveSql = (col: string) => `(${col} GLOB '[0-9]*' AND ${col} NOT GLOB '*[^0-9]*' AND ltrim(${col},'0')<>'')`;
export function suggestionInput(query: Record<string, unknown>) {
  const raw = String(query.page ?? "1");
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error("invalid_suggestion_page");
  return { page: Number(raw), limit: 10, search: String(query.q ?? "").trim().slice(0, 100) };
}
const positive = (value: unknown) => /^\d+$/.test(String(value ?? "")) && BigInt(String(value)) > 0n;

/** Read-only: no wallet allocation, reservation, signature or accounting side effects. */
export function goodsRegistrationSuggestions(db: DatabaseSync, actor: Actor, query: Record<string, unknown>, opts: { viewOnly?: boolean } = {}) {
  const { page, limit, search } = suggestionInput(query);
  const args: (number | string)[] = [];
  let where = `WHERE a.stage='completed' AND a.status='approved' AND a.deleted_at IS NULL
    AND c.merged_into_customer_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM goods_credit_lots used
      WHERE used.application_id=a.id AND (used.purchase_id IS NOT NULL OR used.consumed=1))
    AND (EXISTS (SELECT 1 FROM goods_credit_lots free WHERE free.application_id=a.id)
      OR NOT EXISTS (SELECT 1 FROM goods_purchases old
        WHERE old.customer_id=a.customer_id AND old.plan_id=a.plan_id))`;
  if (actor.role !== "admin" && actor.customerScope === "assigned") {
    where += " AND c.salesperson_id=?";
    args.push(actor.salespersonId ?? -1);
  }
  if (search) {
    where += ` AND (crm_persian_search_key(c.name) LIKE crm_persian_search_key(?)
      OR c.phone LIKE ? OR CAST(a.id AS TEXT)=?)`;
    args.push(`%${search}%`, `%${search}%`, search);
  }
  const from = `FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    JOIN loan_plans p ON p.id=a.plan_id
    LEFT JOIN salespersons s ON s.id=c.salesperson_id
    LEFT JOIN goods_plan_wallets w ON w.customer_id=c.id AND w.plan_id=a.plan_id`;
  // Wait time starts when the case reached «completed» (stage history), not at its last unrelated edit (updated_at).
  // Cases completed before stage history existed fall back to updated_at so they are never dropped.
  const readySince = `COALESCE((SELECT MAX(h.created_at) FROM loan_application_stage_history h
    WHERE h.application_id=a.id AND h.to_stage='completed'),a.updated_at)`;
  const reservedSql = `EXISTS(SELECT 1 FROM goods_purchases reserved WHERE reserved.wallet_id=w.id
      AND reserved.stage IN ('discharge_pending','invoice_draft','invoice_signature','settlement_pending'))`;
  const attributedSql = `EXISTS(SELECT 1 FROM goods_credit_lots lot WHERE lot.application_id=a.id
      AND lot.purchase_id IS NULL AND lot.consumed=0)`;
  const actionableSql = `(NOT ${reservedSql} AND ${attributedSql} AND ${positiveSql("COALESCE(w.balance_toman,'0')")})`;
  const summary = db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(${actionableSql}),0) actionable,
    COALESCE(SUM(${waitDaysSql(readySince)}>=${OLD_WAIT_DAYS}),0) old ${from} ${where}`).get(...args) as any;
  const rows = db.prepare(`SELECT a.id applicationId,c.id customerId,c.name customerName,
    c.phone,p.id planId,p.name planName,s.name customerSalespersonName,
    ${readySince} readySince,${waitDaysSql(readySince)} waitingDays,COALESCE(w.balance_toman,'0') balanceToman,
    ${reservedSql} reserved,${attributedSql} attributed
    ${from} ${where} ORDER BY ${readySince} ASC,a.id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit) as any[];
  const viewOnly = !!opts.viewOnly;
  // HANDOFF server 14/15: `canCreate` = the viewer's permission (separate from each row's canCreate);
  // `actionable` is what tab/badge count (locked rows excluded); `total` stays the listed-row count for paging.
  const actionable = viewOnly ? 0 : summary.actionable, blocked = summary.total - summary.actionable;
  return { page, limit, total: summary.total, canCreate: !viewOnly, viewOnly,
    actionable, actionableCount: actionable, blocked, blockedCount: blocked, old: summary.old, oldCount: summary.old,
    items: rows.map(({ reserved, attributed, ...row }) => {
      const ready = !reserved && !!attributed && positive(row.balanceToman);
      return {
        ...row, completedAt: row.readySince, waitingDays: Math.max(0, Number(row.waitingDays) || 0),
        canCreate: ready && !viewOnly, blocked: !ready,
        unavailableReason: reserved ? "کیف پول این طرح خرید در حال انجام دارد."
          : !attributed ? "اعتبار این پرونده هنوز به کیف پول طرح متصل نشده؛ نیاز به بررسی مالی دارد."
            : !positive(row.balanceToman) ? "کیف پول این طرح موجودی قابل استفاده ندارد." : null,
      };
    }) };
}

export function paymentRegistrationSuggestions(db: DatabaseSync, actor: Actor, query: Record<string, unknown>, opts: { viewOnly?: boolean } = {}) {
  const { page, limit, search } = suggestionInput(query);
  const scope = paymentOrderListScope(actor);
  const args: (number | string)[] = [...scope.params];
  let where = `WHERE g.stage='completed'
    AND NOT EXISTS (SELECT 1 FROM customer_payment_orders existing WHERE existing.purchase_id=g.id)
    ${scope.sql}`;
  if (search) {
    where += ` AND (crm_persian_search_key(c.name) LIKE crm_persian_search_key(?)
      OR c.phone LIKE ? OR CAST(g.id AS TEXT)=?)`;
    args.push(`%${search}%`, `%${search}%`, search);
  }
  const from = `FROM goods_purchases g JOIN customers c ON c.id=g.customer_id
    LEFT JOIN customers current_customer ON current_customer.id=COALESCE(c.merged_into_customer_id,c.id)
      AND current_customer.merged_into_customer_id IS NULL
    LEFT JOIN salespersons s ON s.id=current_customer.salesperson_id
    JOIN loan_plans p ON p.id=g.plan_id`;
  const summary = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(${positiveSql("COALESCE(g.payout_amount_toman,'')")}),0) actionable,
    COALESCE(SUM(${waitDaysSql("g.completed_at")}>=${OLD_WAIT_DAYS}),0) old ${from} ${where}`).get(...args) as any;
  const rows = db.prepare(`SELECT g.id purchaseId,c.id customerId,c.name customerName,c.phone,
    s.name customerSalespersonName,p.id planId,p.name planName,g.completed_at completedAt,g.completed_at readySince,
    ${waitDaysSql("g.completed_at")} waitingDays,g.payout_amount_toman amountToman ${from} ${where}
    ORDER BY g.completed_at ASC,g.id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit) as any[];
  const viewOnly = !!opts.viewOnly;
  // HANDOFF server 14/15: `canCreate` = the viewer's permission (separate from each row's canCreate);
  // `actionable` is what tab/badge count (locked rows excluded); `total` stays the listed-row count for paging.
  const actionable = viewOnly ? 0 : summary.actionable, blocked = summary.total - summary.actionable;
  return { page, limit, total: summary.total, canCreate: !viewOnly, viewOnly,
    actionable, actionableCount: actionable, blocked, blockedCount: blocked, old: summary.old, oldCount: summary.old,
    items: rows.map(row => ({
      ...row, waitingDays: Math.max(0, Number(row.waitingDays) || 0),
      canCreate: positive(row.amountToman) && !viewOnly, blocked: !positive(row.amountToman),
      unavailableReason: positive(row.amountToman) ? null : "مبلغ پرداخت این خرید معتبر نیست؛ نیاز به بررسی مالی دارد.",
    })) };
}

/** Light badge counts: actionable rows only (locked rows are listed but never counted); null = no create right. */
export function pendingCreateCounts(db: DatabaseSync, u: AccessActor) {
  const goods = goodsQueueAccess(u), payments = paymentQueueAccess(u);
  return {
    goods: goods?.mode === "create" ? goodsRegistrationSuggestions(db, goods.actor, {}).actionable : null,
    payments: payments?.mode === "create" ? paymentRegistrationSuggestions(db, payments.actor, {}).actionable : null,
  };
}
