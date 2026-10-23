import type { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./auth";
import { paymentOrderListScope } from "./payment-order-scope";

type Actor = Pick<AuthUser, "role" | "customerScope" | "salespersonId">;
export function suggestionInput(query: Record<string, unknown>) {
  const raw = String(query.page ?? "1");
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error("invalid_suggestion_page");
  return { page: Number(raw), limit: 10, search: String(query.q ?? "").trim().slice(0, 100) };
}
const positive = (value: unknown) => /^\d+$/.test(String(value ?? "")) && BigInt(String(value)) > 0n;

/** Read-only: no wallet allocation, reservation, signature or accounting side effects. */
export function goodsRegistrationSuggestions(db: DatabaseSync, actor: Actor, query: Record<string, unknown>) {
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
  const total = (db.prepare(`SELECT COUNT(*) total ${from} ${where}`).get(...args) as any).total;
  const rows = db.prepare(`SELECT a.id applicationId,c.id customerId,c.name customerName,
    c.phone,p.id planId,p.name planName,s.name customerSalespersonName,
    a.updated_at completedAt,COALESCE(w.balance_toman,'0') balanceToman,
    EXISTS(SELECT 1 FROM goods_purchases reserved WHERE reserved.wallet_id=w.id
      AND reserved.stage IN ('discharge_pending','invoice_draft','invoice_signature','settlement_pending')) reserved,
    EXISTS(SELECT 1 FROM goods_credit_lots lot WHERE lot.application_id=a.id
      AND lot.purchase_id IS NULL AND lot.consumed=0) attributed
    ${from} ${where} ORDER BY a.updated_at ASC,a.id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit) as any[];
  return { page, limit, total, items: rows.map(({ reserved, attributed, ...row }) => ({
    ...row, canCreate: !reserved && !!attributed && positive(row.balanceToman),
    unavailableReason: reserved ? "کیف پول این طرح خرید در حال انجام دارد."
      : !attributed ? "اعتبار این پرونده هنوز به کیف پول طرح متصل نشده؛ نیاز به بررسی مالی دارد."
        : !positive(row.balanceToman) ? "کیف پول این طرح موجودی قابل استفاده ندارد." : null,
  })) };
}

export function paymentRegistrationSuggestions(db: DatabaseSync, actor: Actor, query: Record<string, unknown>) {
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
  const total = (db.prepare(`SELECT COUNT(*) total ${from} ${where}`).get(...args) as any).total;
  const rows = db.prepare(`SELECT g.id purchaseId,c.id customerId,c.name customerName,c.phone,
    s.name customerSalespersonName,p.name planName,g.completed_at completedAt,
    g.payout_amount_toman amountToman ${from} ${where}
    ORDER BY g.completed_at ASC,g.id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit) as any[];
  return { page, limit, total, items: rows.map(row => ({
    ...row, canCreate: positive(row.amountToman),
    unavailableReason: positive(row.amountToman) ? null : "مبلغ پرداخت این خرید معتبر نیست؛ نیاز به بررسی مالی دارد.",
  })) };
}
