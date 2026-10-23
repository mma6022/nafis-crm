import { Router } from "express";
import { execute, queryRow, queryRows, runTransaction, executeChanges } from "../lib/crm-db";
import { requirePermission } from "../lib/access-control";
import { wallet, type WalletType } from "../lib/wallets";
import type { AuthUser } from "../lib/auth";

const router = Router();
const currentUser = (res: any) => res.locals.authUser as AuthUser;
const now = () => new Date().toISOString();
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const survivorOwnerId = (customerId: string) => `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
  SELECT id,merged_into_customer_id FROM customers WHERE id=${customerId}
  UNION ALL SELECT target.id,target.merged_into_customer_id
    FROM customer_chain previous
    JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
      AND audit.survivor_customer_id=previous.merged_into_customer_id
    JOIN customers target ON target.id=audit.survivor_customer_id
)
SELECT survivor.salesperson_id FROM customer_chain
JOIN customers survivor ON survivor.id=customer_chain.id
WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;
const survivorOwnerName = (customerId: string) => `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
  SELECT id,merged_into_customer_id FROM customers WHERE id=${customerId}
  UNION ALL SELECT target.id,target.merged_into_customer_id
    FROM customer_chain previous
    JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
      AND audit.survivor_customer_id=previous.merged_into_customer_id
    JOIN customers target ON target.id=audit.survivor_customer_id
)
SELECT salesperson.name FROM customer_chain
JOIN customers survivor ON survivor.id=customer_chain.id
LEFT JOIN salespersons salesperson ON salesperson.id=survivor.salesperson_id
WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;

router.use("/wallet-management", requirePermission("wallets.view"), (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/wallet-management/accounts", (req, res): void => {
  const u = currentUser(res);
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const search = String(req.query.search ?? "").trim().slice(0, 100);
  const name = String(req.query.name ?? "").trim().slice(0, 100);
  const phone = String(req.query.phone ?? "").trim().slice(0, 30);
  const sortBy = String(req.query.sortBy ?? "");
  const sortDir = String(req.query.sortDir ?? "desc");
  const rawBounds = ["minCash", "maxCash", "minCredit", "maxCredit"].map((key) => String(req.query[key] ?? ""));
  if (!["", "customerName", "phone", "cashBalanceToman", "creditBalanceToman"].includes(sortBy)
    || !["asc", "desc"].includes(sortDir)
    || rawBounds.some((bound) => bound && !/^\d{1,30}$/.test(bound))) {
    res.status(400).json({ error: "invalid_filters" }); return;
  }
  const [minCash, maxCash, minCredit, maxCredit] = rawBounds.map((bound) => bound.replace(/^0+(?=\d)/, ""));
  const exceeds = (min: string, max: string) => min && max && (min.length > max.length || (min.length === max.length && min > max));
  if (exceeds(minCash, maxCash) || exceeds(minCredit, maxCredit)) {
    res.status(400).json({ error: "invalid_filters" }); return;
  }
  const cashBalance = "COALESCE(NULLIF(LTRIM(cash.balance,'0'),''),'0')";
  const creditBalance = "COALESCE(NULLIF(LTRIM(credit.balance,'0'),''),'0')";
  const joins = `FROM customers c
    LEFT JOIN wallet_accounts_v2 cash ON cash.customer_id=c.id AND cash.wallet_type='cash'
    LEFT JOIN wallet_accounts_v2 credit ON credit.customer_id=c.id AND credit.wallet_type='credit'`;
  const conditions = ["1=1"];
  const params: Array<string | number | null> = [];
  if (u.customerScope === "assigned") { conditions.push(`${survivorOwnerId("c.id")}=?`); params.push(u.salespersonId); }
  if (search) { conditions.push("(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ? OR CAST(c.id AS TEXT)=?)"); params.push(`%${search}%`, `%${search}%`, search); }
  if (name) { conditions.push("crm_persian_search_key(c.name) LIKE crm_persian_search_key(?)"); params.push(`%${name}%`); }
  if (phone) { conditions.push("c.phone LIKE ?"); params.push(`%${phone}%`); }
  const range = (balance: string, min: string, max: string) => {
    if (min) { conditions.push(`(LENGTH(${balance}) > ? OR (LENGTH(${balance}) = ? AND ${balance} COLLATE BINARY >= ?))`); params.push(min.length, min.length, min); }
    if (max) { conditions.push(`(LENGTH(${balance}) < ? OR (LENGTH(${balance}) = ? AND ${balance} COLLATE BINARY <= ?))`); params.push(max.length, max.length, max); }
  };
  range(cashBalance, minCash, maxCash);
  range(creditBalance, minCredit, maxCredit);
  const where = conditions.join(" AND ");
  const total = queryRow<{ count: number }>(`SELECT COUNT(*) count ${joins} WHERE ${where}`, params)?.count ?? 0;
  const direction = sortDir === "asc" ? "ASC" : "DESC";
  const orderBy: Record<string, string> = {
    customerName: `c.name COLLATE NOCASE ${direction}`,
    phone: `c.phone COLLATE BINARY ${direction}`,
    cashBalanceToman: `LENGTH(${cashBalance}) ${direction},${cashBalance} COLLATE BINARY ${direction}`,
    creditBalanceToman: `LENGTH(${creditBalance}) ${direction},${creditBalance} COLLATE BINARY ${direction}`,
  };
  const exactIdFirst = !sortBy && search ? "CASE WHEN CAST(c.id AS TEXT)=? THEN 0 ELSE 1 END," : "";
  const rows = queryRows<any>(`
    SELECT c.id customerId,c.name customerName,c.phone,${survivorOwnerName("c.id")} customerSalespersonName,
      COALESCE(cash.balance,'0') cashBalanceToman,COALESCE(credit.balance,'0') creditBalanceToman
    ${joins}
    WHERE ${where} ORDER BY ${exactIdFirst}${orderBy[sortBy] ? `${orderBy[sortBy]},` : ""} c.id DESC LIMIT ? OFFSET ?`,
    [...params, ...(exactIdFirst ? [search] : []), limit, (page - 1) * limit]);
  res.json({ items: rows, total, page, limit });
});

router.get("/wallet-management/transactions", (req, res): void => {
  const u = currentUser(res);
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const customerId = req.query.customerId ? Number(req.query.customerId) : null;
  const actorId = req.query.actorId ? Number(req.query.actorId) : null;
  const walletType = String(req.query.walletType ?? "");
  const kind = String(req.query.kind ?? "");
  const status = String(req.query.status ?? "");
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  const search = String(req.query.search ?? "").trim().slice(0, 100);
  if ((customerId !== null && !validId(customerId)) || (actorId !== null && !validId(actorId))
    || (walletType && !["cash", "credit"].includes(walletType))
    || (kind && !["payment", "loan_credit", "transfer", "legacy", "filing_fee"].includes(kind))
    || (status && !["requested", "gateway_ready", "failed", "cancelled", "credited", "verification_pending", "requires_reconciliation", "completed"].includes(status))
    || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))
    || (from && to && from > to)) { res.status(400).json({ error: "invalid_filters" }); return; }

  const scope = u.customerScope === "assigned" ? `AND ${survivorOwnerId("c.id")}=?` : "";
  const transferScope = u.customerScope === "assigned"
    ? `AND ${survivorOwnerId("source.id")}=? AND ${survivorOwnerId("target.id")}=?`
    : "";
  const scopeParams = u.customerScope === "assigned" ? [u.salespersonId, u.salespersonId, u.salespersonId, u.salespersonId] : [];
  const base = `
    WITH entries AS (
      SELECT 'payment' kind,'cash' walletType,a.id recordId,a.customer_id customerId,c.name customerName,
        ${survivorOwnerName("c.id")} customerSalespersonName,NULL otherCustomerId,NULL otherCustomerName,NULL otherCustomerSalespersonName,a.amount_toman amountToman,a.status,
        a.initiated_by_user_id actorId,COALESCE(NULLIF(u.full_name,''),u.username) actorName,
        a.error_code errorCode,NULL reason,a.created_at createdAt,a.updated_at updatedAt
      FROM wallet_payment_attempts a JOIN customers c ON c.id=a.customer_id
      LEFT JOIN users u ON u.id=a.initiated_by_user_id WHERE 1=1 ${scope}
      UNION ALL
       SELECT CASE WHEN l.kind LIKE 'legacy_%' THEN 'legacy' WHEN l.kind='filing_fee_out' THEN 'filing_fee'
         WHEN l.kind='goods_purchase_debit' THEN 'goods_purchase' ELSE 'loan_credit' END,
        w.wallet_type,l.id,c.id,c.name,${survivorOwnerName("c.id")},NULL,NULL,NULL,l.amount,'completed',
        COALESCE(l.actor_user_id,CASE WHEN l.kind LIKE 'loan_credit:actor:%' THEN CAST(SUBSTR(l.kind,19) AS INTEGER) END),
        COALESCE(NULLIF(u.full_name,''),u.username),NULL,
         CASE WHEN l.kind LIKE 'legacy_%' THEN l.kind WHEN l.kind='filing_fee_out' THEN 'هزینه تشکیل پرونده'
           WHEN l.kind='goods_purchase_debit' THEN 'کسر بابت خرید کالا' ELSE CAST(l.application_id AS TEXT) END,
        l.created_at,l.created_at
      FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id
      JOIN customers c ON c.id=w.customer_id
      LEFT JOIN users u ON u.id=COALESCE(l.actor_user_id,CASE WHEN l.kind LIKE 'loan_credit:actor:%' THEN CAST(SUBSTR(l.kind,19) AS INTEGER) END)
      WHERE l.kind<>'cash_payment' AND l.kind NOT IN ('transfer_out','transfer_in') ${scope}
      UNION ALL
      SELECT 'transfer',t.wallet_type,t.id,source.id,source.name,${survivorOwnerName("source.id")},target.id,target.name,${survivorOwnerName("target.id")},t.amount_toman,t.status,
        t.actor_user_id,COALESCE(NULLIF(u.full_name,''),u.username),t.error_code,t.reason,t.created_at,t.created_at
      FROM wallet_transfers t JOIN customers source ON source.id=t.from_customer_id
      JOIN customers target ON target.id=t.to_customer_id LEFT JOIN users u ON u.id=t.actor_user_id
      WHERE 1=1 ${transferScope}
    )`;
  const filters: string[] = ["1=1"];
  const params: Array<string | number | null> = [];
  if (customerId !== null) { filters.push("(customerId=? OR otherCustomerId=?)"); params.push(customerId, customerId); }
  if (actorId !== null) { filters.push("actorId=?"); params.push(actorId); }
  if (walletType) { filters.push("walletType=?"); params.push(walletType); }
  if (kind) { filters.push("kind=?"); params.push(kind); }
  if (status) { filters.push("status=?"); params.push(status); }
  if (from) { filters.push("createdAt>=?"); params.push(`${from}T00:00:00`); }
  if (to) { filters.push("createdAt<?"); params.push(`${to}T23:59:59.999Z`); }
  if (search) { filters.push("(crm_persian_search_key(customerName) LIKE crm_persian_search_key(?) OR crm_persian_search_key(otherCustomerName) LIKE crm_persian_search_key(?) OR CAST(recordId AS TEXT)=?)"); params.push(`%${search}%`, `%${search}%`, search); }
  const where = filters.join(" AND ");
  const total = queryRow<{ count: number }>(`${base} SELECT COUNT(*) count FROM entries WHERE ${where}`, [...scopeParams, ...params])?.count ?? 0;
  const items = queryRows<any>(`${base} SELECT * FROM entries WHERE ${where} ORDER BY createdAt DESC,kind,recordId DESC LIMIT ? OFFSET ?`,
    [...scopeParams, ...params, limit, (page - 1) * limit]);
  res.json({ items, total, page, limit });
});

router.post("/wallet-management/transfers", requirePermission("wallets.transfer"), (req, res): void => {
  const actor = currentUser(res);
  if (actor.role !== "admin") { res.status(403).json({ error: "admin_required" }); return; }
  const fromId = req.body?.fromCustomerId, toId = req.body?.toCustomerId;
  const type = req.body?.walletType as WalletType;
  const amount = String(req.body?.amountToman ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  const key = String(req.header("Idempotency-Key") ?? "");
  if (!validId(fromId) || !validId(toId) || fromId === toId || !["cash", "credit"].includes(type)
    || !/^[1-9]\d*$/.test(amount) || reason.length < 3 || reason.length > 500
    || !/^[\x20-\x7e]{8,200}$/.test(key)) { res.status(400).json({ error: "invalid_transfer" }); return; }
  const existing = queryRow<any>("SELECT * FROM wallet_transfers WHERE idempotency_key=?", [key]);
  if (existing) {
    if (existing.from_customer_id !== fromId || existing.to_customer_id !== toId || existing.wallet_type !== type || existing.amount_toman !== amount || existing.reason !== reason) {
      res.status(409).json({ error: "transfer_idempotency_conflict" }); return;
    }
    res.status(existing.status === "completed" ? 200 : 409).json({ id: existing.id, status: existing.status, errorCode: existing.error_code }); return;
  }
  const customers = queryRow<{ count: number }>("SELECT COUNT(*) count FROM customers WHERE id IN (?,?) AND merged_into_customer_id IS NULL", [fromId, toId]);
  if (customers?.count !== 2) { res.status(404).json({ error: "customer_not_found" }); return; }
  try {
    const result = runTransaction(() => {
      const source = wallet(fromId, type), target = wallet(toId, type);
      if (!/^\d+$/.test(source.balance) || !/^\d+$/.test(target.balance)) throw new Error("invalid_wallet_balance");
      // Plan-attributed credit may only leave through its own purchase ledger.
      // Generic transfers remain possible for the preserved unassigned bucket.
      const assigned = type === "credit" ? queryRows<{ balance_toman: string }>("SELECT balance_toman FROM goods_plan_wallets WHERE customer_id=?", [fromId]).reduce((sum,row)=>sum+BigInt(row.balance_toman),0n) : 0n;
      const enough = BigInt(source.balance) - assigned >= BigInt(amount);
      const failure = BigInt(source.balance) < assigned ? "credit_attribution_requires_reconciliation" : "insufficient_balance";
      const id = execute(
        "INSERT INTO wallet_transfers(from_customer_id,to_customer_id,wallet_type,amount_toman,status,error_code,reason,actor_user_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [fromId, toId, type, amount, enough ? "completed" : "failed", enough ? null : failure, reason, actor.id, key, now()]);
      if (enough) {
        executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(source.balance) - BigInt(amount)).toString(), source.id]);
        executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(target.balance) + BigInt(amount)).toString(), target.id]);
        for (const [walletId, kind] of [[source.id, "transfer_out"], [target.id, "transfer_in"]] as const) {
          execute("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
            [walletId, amount, kind, `wallet-transfer:${id}:${kind}`, actor.id, now()]);
        }
      }
      return { id, status: enough ? "completed" : "failed", errorCode: enough ? null : "insufficient_balance" };
    });
    res.status(result.status === "completed" ? 201 : 409).json(result);
  } catch (e) {
    req.log.error({ err: e }, "wallet transfer failed");
    res.status(500).json({ error: "transfer_failed" });
  }
});

export default router;