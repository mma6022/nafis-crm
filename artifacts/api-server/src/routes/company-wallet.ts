import { Router } from "express";
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";

const router = Router();
router.use("/company-wallet", requirePermission("wallets.view"), (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/company-wallet", (_req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (actor.role !== "admin") return res.status(403).json({ error: "admin_required" });
  const accounts = queryRows<{ wallet_type: string; balance: string }>(
    "SELECT wallet_type,balance FROM company_wallet_accounts ORDER BY wallet_type");
  const entries = queryRows<any>(`WITH RECURSIVE
    entries AS (
      SELECT l.id,l.wallet_type AS walletType,l.amount_toman AS amountToman,
        CASE WHEN l.purchase_id IS NOT NULL THEN 'goods_purchase' ELSE l.kind END AS kind,
        l.reason,l.created_at AS createdAt,l.fee_charge_id AS feeChargeId,l.purchase_id AS purchaseId,
        COALESCE(f.customer_id,p.customer_id) AS customerId,c.name AS customerName,
        COALESCE(NULLIF(u.full_name,''),u.username) AS actorName
      FROM company_wallet_ledger l
      LEFT JOIN loan_filing_fee_charges f ON f.id=l.fee_charge_id
      LEFT JOIN goods_purchases p ON p.id=l.purchase_id
      LEFT JOIN customers c ON c.id=COALESCE(f.customer_id,p.customer_id)
      LEFT JOIN users u ON u.id=l.actor_user_id
      ORDER BY l.id DESC LIMIT 200
    ),
    customer_chain(entry_id,customer_id,merged_into_customer_id) AS (
      SELECT entries.id,c.id,c.merged_into_customer_id
      FROM entries JOIN customers c ON c.id=entries.customerId
      UNION ALL
      SELECT previous.entry_id,target.id,target.merged_into_customer_id
      FROM customer_chain previous
      JOIN customer_merge_audit audit ON audit.source_customer_id=previous.customer_id
        AND audit.survivor_customer_id=previous.merged_into_customer_id
      JOIN customers target ON target.id=audit.survivor_customer_id
    ),
    owner_by_entry AS (
      SELECT customer_chain.entry_id,salesperson.name customerSalespersonName
      FROM customer_chain JOIN customers survivor ON survivor.id=customer_chain.customer_id
      LEFT JOIN salespersons salesperson ON salesperson.id=survivor.salesperson_id
      WHERE customer_chain.merged_into_customer_id IS NULL
    )
    SELECT entries.*,owner_by_entry.customerSalespersonName
    FROM entries LEFT JOIN owner_by_entry ON owner_by_entry.entry_id=entries.id
    ORDER BY entries.id DESC`);
  return res.json({
    cashBalanceToman: accounts.find((a) => a.wallet_type === "cash")?.balance ?? "0",
    creditBalanceToman: accounts.find((a) => a.wallet_type === "credit")?.balance ?? "0",
    entries,
  });
});

router.post("/company-wallet/adjustments", requirePermission("wallets.transfer"), (req, res) => {
  const actor = res.locals.authUser as AuthUser;
  if (actor.role !== "admin") return res.status(403).json({ error: "admin_required" });
  const walletType = req.body?.walletType, direction = req.body?.direction;
  const amount = String(req.body?.amountToman ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  const key = String(req.header("Idempotency-Key") ?? "");
  if (!["cash", "credit"].includes(walletType) || !["deposit", "withdrawal"].includes(direction)
    || !/^[1-9]\d*$/.test(amount) || amount.length > 30 || reason.length < 3 || reason.length > 500
    || !/^[\x20-\x7e]{8,200}$/.test(key)) return res.status(400).json({ error: "invalid_adjustment" });
  const kind = direction === "deposit" ? "manual_deposit" : "manual_withdrawal";
  try {
    const result = runTransaction(() => {
      const previous = queryRow<any>("SELECT * FROM company_wallet_ledger WHERE idempotency_key=?", [key]);
      if (previous) {
        if (previous.wallet_type !== walletType || previous.kind !== kind || previous.amount_toman !== amount || previous.reason !== reason)
          throw new Error("adjustment_idempotency_conflict");
        return { id: previous.id, balanceToman: queryRow<{ balance: string }>("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?", [walletType])?.balance, repeated: true };
      }
      const account = queryRow<{ balance: string }>("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?", [walletType]);
      if (!account || !/^\d+$/.test(account.balance)) throw new Error("invalid_wallet_balance");
      if (kind === "manual_withdrawal" && BigInt(account.balance) < BigInt(amount)) throw new Error("insufficient_balance");
      const balance = (BigInt(account.balance) + (kind === "manual_deposit" ? BigInt(amount) : -BigInt(amount))).toString();
      executeChanges("UPDATE company_wallet_accounts SET balance=? WHERE wallet_type=?", [balance, walletType]);
      const id = execute("INSERT INTO company_wallet_ledger(wallet_type,amount_toman,kind,reason,actor_user_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)",
        [walletType, amount, kind, reason, actor.id, key, new Date().toISOString()]);
      return { id, balanceToman: balance, repeated: false };
    });
    return res.status(result.repeated ? 200 : 201).json({ id: result.id, balanceToman: result.balanceToman });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (["adjustment_idempotency_conflict", "insufficient_balance"].includes(code)) return res.status(409).json({ error: code });
    req.log.error({ err: e }, "company wallet adjustment failed");
    return res.status(500).json({ error: "adjustment_failed" });
  }
});

export default router;