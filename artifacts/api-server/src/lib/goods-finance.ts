import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import type { AuthUser } from "./auth";
import { goodsDocumentState, assertInvoiceEditable, invalidateGoodsInvoice } from "./goods-documents";
import { assertArchivedCustomerSurvivorAccess } from "./customer-merge-access";
import { postCompanyPurchaseReceipt } from "./company-purchase-receipts";
import { goodsSettlementAmounts } from "./goods-settlement-amounts";
import { onGoodsPurchaseCompletion } from "./team-commission";

const now = () => new Date().toISOString();
export function money(value: unknown): bigint {
  if (!/^\d{1,30}$/.test(String(value ?? ""))) throw new Error("invalid_amount_toman");
  return BigInt(String(value));
}
export function percentBps(value: unknown): number {
  const s = String(value ?? "");
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(s)) throw new Error("invalid_percent");
  const [whole, fraction = ""] = s.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bps > 10000) throw new Error("invalid_percent");
  return bps;
}
export const percentage = (amount: bigint, bps: number) => amount * BigInt(bps) / 10000n;
export function persianMonth(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}
export function assertGoodsCustomerScope(customerId: number, actor: AuthUser): void {
  const c = queryRow<any>("SELECT id,salesperson_id,merged_into_customer_id FROM customers WHERE id=?", [customerId]);
  if (c?.merged_into_customer_id != null) throw new Error("customer_merged_archived");
  if (!c || (actor.role !== "admin" && actor.customerScope === "assigned" && c.salesperson_id !== actor.salespersonId)) throw new Error("customer_not_found");
}
export function assertGoodsPurchaseScope(purchaseId: number, actor: AuthUser): void {
  const purchase = queryRow<any>("SELECT id,customer_id FROM goods_purchases WHERE id=?", [purchaseId]);
  if (!purchase) throw new Error("purchase_not_found");
  const source = queryRow<any>("SELECT id,salesperson_id,merged_into_customer_id FROM customers WHERE id=?", [purchase.customer_id]);
  if (!source) throw new Error("customer_not_found");
  if (source.merged_into_customer_id == null) {
    assertGoodsCustomerScope(Number(source.id), actor);
    return;
  }
  assertArchivedCustomerSurvivorAccess(crmDb, Number(source.id), actor);
}
export function ensureGoodsFinanceSchema(): void {
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS goods_plan_settings (
      plan_id INTEGER PRIMARY KEY REFERENCES loan_plans(id), customer_payout_bps INTEGER NOT NULL,
      development_discount_bps INTEGER NOT NULL, acknowledgement_template_id INTEGER REFERENCES contract_templates(id), updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goods_plan_wallets (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), plan_id INTEGER NOT NULL REFERENCES loan_plans(id),
      balance_toman TEXT NOT NULL DEFAULT '0', UNIQUE(customer_id,plan_id));
    CREATE TABLE IF NOT EXISTS goods_credit_lots (
      ledger_id INTEGER PRIMARY KEY REFERENCES wallet_ledger_v2(id), wallet_id INTEGER NOT NULL REFERENCES goods_plan_wallets(id),
      application_id INTEGER NOT NULL REFERENCES loan_applications(id), amount_toman TEXT NOT NULL, principal_toman TEXT NOT NULL,
      purchase_id INTEGER, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER IF NOT EXISTS goods_one_allocation_per_application
      BEFORE INSERT ON goods_credit_lots WHEN EXISTS(SELECT 1 FROM goods_credit_lots WHERE application_id=NEW.application_id)
      BEGIN SELECT RAISE(ABORT,'application_credit_requires_reconciliation'); END;
    CREATE TABLE IF NOT EXISTS goods_purchases (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), plan_id INTEGER NOT NULL REFERENCES loan_plans(id),
      salesperson_id INTEGER REFERENCES salespersons(id), wallet_id INTEGER NOT NULL REFERENCES goods_plan_wallets(id),
      stage TEXT NOT NULL, credit_amount_toman TEXT NOT NULL, principal_amount_toman TEXT NOT NULL, payout_amount_toman TEXT NOT NULL,
      development_discount_toman TEXT NOT NULL, company_credit_toman TEXT NOT NULL, payout_bps INTEGER NOT NULL,
      development_discount_bps INTEGER NOT NULL, acknowledgement_template_id INTEGER REFERENCES contract_templates(id),
      invoice_version INTEGER NOT NULL DEFAULT 0, invoice_signed_version INTEGER, acknowledgement_signed INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT,
      commission_bps INTEGER, commission_toman TEXT, commission_month TEXT, commission_settings_json TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS goods_wallet_reservation ON goods_purchases(wallet_id)
      WHERE stage IN ('discharge_pending','invoice_draft','invoice_signature','settlement_pending');
    CREATE TABLE IF NOT EXISTS goods_invoice_items (
      id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES goods_purchases(id), title TEXT NOT NULL,
      quantity INTEGER NOT NULL, unit_price_toman TEXT NOT NULL, total_toman TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goods_purchase_events (
      id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES goods_purchases(id), action TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id), detail TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goods_company_wallets (plan_id INTEGER PRIMARY KEY REFERENCES loan_plans(id), balance_toman TEXT NOT NULL DEFAULT '0');
    CREATE TABLE IF NOT EXISTS goods_finance_ledger (
      id INTEGER PRIMARY KEY, purchase_id INTEGER REFERENCES goods_purchases(id), plan_id INTEGER REFERENCES loan_plans(id),
      customer_id INTEGER REFERENCES customers(id), salesperson_id INTEGER REFERENCES salespersons(id),
      kind TEXT NOT NULL, amount_toman TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      actor_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goods_salesperson_settings (
      salesperson_id INTEGER PRIMARY KEY REFERENCES salespersons(id), target1_toman TEXT NOT NULL, target2_toman TEXT NOT NULL,
      target3_toman TEXT NOT NULL, rate0_bps INTEGER NOT NULL, rate1_bps INTEGER NOT NULL, rate2_bps INTEGER NOT NULL, rate3_bps INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goods_salesperson_wallets (salesperson_id INTEGER PRIMARY KEY REFERENCES salespersons(id), balance_toman TEXT NOT NULL DEFAULT '0');
  `);
  if (!queryRows<any>("PRAGMA table_info(goods_purchases)").some(c=>c.name==="commission_settings_json")) crmDb.exec("ALTER TABLE goods_purchases ADD COLUMN commission_settings_json TEXT");
  const purchaseColumns = queryRows<any>("PRAGMA table_info(goods_purchases)");
  if (!purchaseColumns.some(c=>c.name==="base_payout_amount_toman")) crmDb.exec("ALTER TABLE goods_purchases ADD COLUMN base_payout_amount_toman TEXT");
  if (!purchaseColumns.some(c=>c.name==="fee_discount_toman")) crmDb.exec("ALTER TABLE goods_purchases ADD COLUMN fee_discount_toman TEXT NOT NULL DEFAULT '0'");
  executeChanges("UPDATE goods_purchases SET base_payout_amount_toman=payout_amount_toman WHERE base_payout_amount_toman IS NULL");
  if (!queryRow("SELECT 1 FROM schema_migrations WHERE version='goods-plan-allocation-v1'")) {
    runTransaction(() => {
      for (const account of queryRows<any>("SELECT id,customer_id,balance FROM wallet_accounts_v2 WHERE wallet_type='credit'")) {
        const entries = queryRows<any>("SELECT l.*,a.plan_id,a.customer_id application_customer_id,a.approved_amount,a.requested_amount FROM wallet_ledger_v2 l LEFT JOIN loan_applications a ON a.id=l.application_id WHERE l.wallet_id=?", [account.id]);
        // Any unknown/transfer/debit origin makes attribution ambiguous: retain all
        // that account's historical credit in its explicitly unassigned bucket.
        if (!entries.length || entries.some(e => !e.plan_id || e.application_customer_id!==account.customer_id || !/^loan_credit:actor:/.test(e.kind))) continue;
        if (new Set(entries.map(e=>e.application_id)).size !== entries.length) continue;
        if (entries.reduce((sum, e) => sum + money(e.amount), 0n) !== money(account.balance)) continue;
        for (const e of entries) allocateGoodsLoanCredit(e.application_id, account.customer_id, e.amount, e.id);
      }
      execute("INSERT INTO schema_migrations(version,applied_at) VALUES('goods-plan-allocation-v1',?)", [now()]);
    });
  }
}
export function allocateGoodsLoanCredit(applicationId: number, customerId: number, amount: string, ledgerId: number): void {
  const app = queryRow<any>("SELECT plan_id,customer_id,approved_amount,requested_amount FROM loan_applications WHERE id=?", [applicationId]);
  if (!app?.plan_id || queryRow("SELECT ledger_id FROM goods_credit_lots WHERE ledger_id=?", [ledgerId])) return;
  if (app.customer_id!==customerId) throw new Error("application_credit_requires_reconciliation");
  if (queryRow("SELECT 1 FROM goods_credit_lots WHERE application_id=?", [applicationId])) throw new Error("application_credit_requires_reconciliation");
  execute("INSERT OR IGNORE INTO goods_plan_wallets(customer_id,plan_id,balance_toman) VALUES(?,?,'0')", [customerId, app.plan_id]);
  const w = queryRow<any>("SELECT * FROM goods_plan_wallets WHERE customer_id=? AND plan_id=?", [customerId, app.plan_id])!;
  execute("INSERT INTO goods_credit_lots(ledger_id,wallet_id,application_id,amount_toman,principal_toman) VALUES(?,?,?,?,?)", [ledgerId, w.id, applicationId, amount, money(app.approved_amount ?? app.requested_amount).toString()]);
  executeChanges("UPDATE goods_plan_wallets SET balance_toman=? WHERE id=?", [(money(w.balance_toman) + money(amount)).toString(), w.id]);
}
export function goodsEvent(id: number, action: string, actorId: number | null, detail: unknown = null): void {
  execute("INSERT INTO goods_purchase_events(purchase_id,action,actor_user_id,detail,created_at) VALUES(?,?,?,?,?)", [id, action, actorId, detail === null ? null : JSON.stringify(detail), now()]);
}
export function unassignedGoodsCredit(customerId: number): bigint {
  const pooled = money(queryRow<any>("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'",[customerId])?.balance ?? "0");
  const assigned = queryRows<any>("SELECT balance_toman FROM goods_plan_wallets WHERE customer_id=?",[customerId]).reduce((sum,w)=>sum+money(w.balance_toman),0n);
  if (pooled < assigned) throw new Error("credit_attribution_requires_reconciliation");
  return pooled - assigned;
}
function assertUniquePrincipals(lots: any[]): void {
  if (new Set(lots.map(l=>l.application_id)).size !== lots.length || lots.some(l => queryRow<any>("SELECT count(*) n FROM goods_credit_lots WHERE application_id=?",[l.application_id])!.n !== 1)) throw new Error("application_credit_requires_reconciliation");
}
export function getGoodsPurchase(id: number): any {
  const p = queryRow<any>(`SELECT p.*,c.name customer_name,c.merged_into_customer_id mergedIntoCustomerId,
      current_salesperson.name customer_salesperson_name,l.name plan_name
    FROM goods_purchases p JOIN customers c ON c.id=p.customer_id
    LEFT JOIN customers current_customer ON current_customer.id=COALESCE(c.merged_into_customer_id,c.id) AND current_customer.merged_into_customer_id IS NULL
    LEFT JOIN salespersons current_salesperson ON current_salesperson.id=current_customer.salesperson_id
    JOIN loan_plans l ON l.id=p.plan_id WHERE p.id=?`, [id]);
  if (!p) throw new Error("purchase_not_found");
  return { ...p, customerId: p.customer_id, customerName: p.customer_name, customerSalespersonName: p.customer_salesperson_name ?? null, salespersonId: p.salesperson_id, planId: p.plan_id, planName: p.plan_name,
    creditAmountToman: p.credit_amount_toman, principalAmountToman: p.principal_amount_toman, payoutAmountToman: p.payout_amount_toman,
    basePayoutAmountToman: p.base_payout_amount_toman, feeDiscountToman: p.fee_discount_toman,
    developmentDiscountToman: p.development_discount_toman, companyCreditToman: p.company_credit_toman, createdAt: p.created_at, completedAt: p.completed_at,
    invoiceDocument: goodsDocumentState(id,"invoice"), acknowledgementDocument: goodsDocumentState(id,"acknowledgement"),
    items: queryRows<any>("SELECT id,title,quantity,unit_price_toman unitPriceToman,total_toman totalToman FROM goods_invoice_items WHERE purchase_id=? ORDER BY id", [id]),
    events: queryRows<any>("SELECT action,actor_user_id actorUserId,detail,created_at createdAt FROM goods_purchase_events WHERE purchase_id=? ORDER BY id", [id]) };
}
export function createGoodsPurchase(customerId: number, planId: number, actor: AuthUser): any {
  return runTransaction(() => {
    assertGoodsCustomerScope(customerId, actor);
    const settings = queryRow<any>("SELECT * FROM goods_plan_settings WHERE plan_id=?", [planId]);
    if (!settings || !settings.acknowledgement_template_id) throw new Error("plan_finance_configuration_required");
    const c = queryRow<any>("SELECT salesperson_id FROM customers WHERE id=?", [customerId])!;
    const commissionSettings = queryRow<any>("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?", [c.salesperson_id]);
    if (!c.salesperson_id || !commissionSettings) throw new Error("salesperson_commission_configuration_required");
    const w = queryRow<any>("SELECT * FROM goods_plan_wallets WHERE customer_id=? AND plan_id=?", [customerId, planId]);
    if (!w || money(w.balance_toman) === 0n) throw new Error("no_available_credit");
    unassignedGoodsCredit(customerId);
    if (queryRow("SELECT 1 FROM goods_purchases WHERE wallet_id=? AND stage IN ('discharge_pending','invoice_draft','invoice_signature','settlement_pending')", [w.id])) throw new Error("wallet_reserved");
    const lots = queryRows<any>("SELECT * FROM goods_credit_lots WHERE wallet_id=? AND consumed=0 AND purchase_id IS NULL", [w.id]);
    assertUniquePrincipals(lots);
    if (lots.reduce((s, l) => s + money(l.amount_toman), 0n) !== money(w.balance_toman)) throw new Error("credit_attribution_requires_reconciliation");
    const principal = lots.reduce((s, l) => s + money(l.principal_toman), 0n);
    const amount = money(w.balance_toman), discount = percentage(amount, settings.development_discount_bps);
    const id = execute(`INSERT INTO goods_purchases(customer_id,plan_id,salesperson_id,wallet_id,stage,credit_amount_toman,principal_amount_toman,payout_amount_toman,development_discount_toman,company_credit_toman,payout_bps,development_discount_bps,acknowledgement_template_id,created_by,created_at) VALUES(?,?,?,?,'discharge_pending',?,?,?,?,?,?,?,?,?,?)`,
      [customerId, planId, c.salesperson_id, w.id, amount.toString(), principal.toString(), percentage(principal, settings.customer_payout_bps).toString(), discount.toString(), (amount-discount).toString(), settings.customer_payout_bps, settings.development_discount_bps, settings.acknowledgement_template_id, actor.id, now()]);
    executeChanges("UPDATE goods_credit_lots SET purchase_id=? WHERE wallet_id=? AND consumed=0 AND purchase_id IS NULL", [id, w.id]);
    executeChanges("UPDATE goods_purchases SET commission_settings_json=?,base_payout_amount_toman=payout_amount_toman WHERE id=?", [JSON.stringify(commissionSettings),id]);
    goodsEvent(id, "created", actor.id);
    return getGoodsPurchase(id);
  });
}
export function saveGoodsInvoice(id: number, items: any[], actorId: number): any {
  return runTransaction(() => {
    const p = getGoodsPurchase(id);
    if (p.stage !== "invoice_draft") throw new Error("invalid_purchase_stage");
    assertInvoiceEditable(id);
    if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("invalid_invoice_items");
    const parsed = items.map(i => {
      const title = String(i.title ?? "").trim(), quantity = Number(i.quantity);
      if (!title || title.length > 250 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error("invalid_invoice_items");
      const unit = money(i.unitPriceToman); if (!unit) throw new Error("invalid_invoice_items");
      return {title,quantity,unit,total: unit * BigInt(quantity)};
    });
    if (parsed.reduce((s,i)=>s+i.total,0n) !== money(p.credit_amount_toman)) throw new Error("invoice_total_must_equal_credit");
    executeChanges("DELETE FROM goods_invoice_items WHERE purchase_id=?", [id]);
    for (const i of parsed) execute("INSERT INTO goods_invoice_items(purchase_id,title,quantity,unit_price_toman,total_toman) VALUES(?,?,?,?,?)", [id,i.title,i.quantity,i.unit.toString(),i.total.toString()]);
    executeChanges("UPDATE goods_purchases SET invoice_version=invoice_version+1,invoice_signed_version=NULL WHERE id=?", [id]);
    invalidateGoodsInvoice(id);
    goodsEvent(id,"invoice_saved",actorId);
    return getGoodsPurchase(id);
  });
}
export function setGoodsDocumentStatus(id: number, kind: "invoice" | "acknowledgement", status: "pending" | "signed" | "rejected", version: number, actorId: number | null): void {
  runTransaction(() => {
    const p = getGoodsPurchase(id);
    if (kind === "invoice") {
      if (version !== p.invoice_version || !["invoice_draft","invoice_signature","settlement_pending"].includes(p.stage)) throw new Error("stale_invoice_document");
      if (p.invoice_signed_version === version) return;
      const stage = status === "signed" ? "settlement_pending" : status === "rejected" ? "invoice_draft" : "invoice_signature";
      executeChanges("UPDATE goods_purchases SET stage=?,invoice_signed_version=? WHERE id=?", [stage,status === "signed" ? version : null,id]);
    } else {
      if (!["acknowledgement_signature","registrar_confirmation"].includes(p.stage)) throw new Error("invalid_purchase_stage");
      if (p.acknowledgement_signed) return;
      executeChanges("UPDATE goods_purchases SET stage=?,acknowledgement_signed=? WHERE id=?", [status === "signed" ? "registrar_confirmation" : "acknowledgement_signature",status === "signed" ? 1 : 0,id]);
    }
    goodsEvent(id,`${kind}_${status}`,actorId);
  });
}
function financialEntry(p: any, kind: string, amount: bigint, actorId: number): void {
  execute("INSERT INTO goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", [p.id,p.plan_id,p.customer_id,p.salesperson_id,kind,amount.toString(),`goods:${p.id}:${kind}`,actorId,now()]);
}
export function settleGoodsPurchase(id: number, actorId: number, feeDiscountToman?: unknown): any {
  return runTransaction(() => {
    const p = getGoodsPurchase(id);
    if (["acknowledgement_signature","registrar_confirmation","completed"].includes(p.stage)) {
      if (feeDiscountToman !== undefined && goodsSettlementAmounts(p.base_payout_amount_toman, feeDiscountToman).feeDiscountToman !== p.fee_discount_toman) {
        throw new Error("settlement_discount_locked");
      }
      postCompanyPurchaseReceipt(crmDb, id);
      return p;
    }
    const invoice = goodsDocumentState(id,"invoice");
    if (p.stage !== "settlement_pending" || p.invoice_signed_version !== p.invoice_version || !p.invoice_version || !invoice?.signed || invoice.invoiceVersion!==p.invoice_version) throw new Error("signed_invoice_required");
    const w = queryRow<any>("SELECT * FROM goods_plan_wallets WHERE id=?", [p.wallet_id])!;
    const pooled = queryRow<any>("SELECT * FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'", [p.customer_id])!;
    const amount = money(p.credit_amount_toman);
    unassignedGoodsCredit(p.customer_id);
    const reserved = queryRows<any>("SELECT * FROM goods_credit_lots WHERE purchase_id=?",[id]);
    assertUniquePrincipals(reserved);
    if (!reserved.length || reserved.some(l=>l.consumed!==0 || l.wallet_id!==p.wallet_id) || reserved.reduce((s,l)=>s+money(l.amount_toman),0n)!==amount || reserved.reduce((s,l)=>s+money(l.principal_toman),0n)!==money(p.principal_amount_toman)) throw new Error("credit_reservation_requires_reconciliation");
    if (money(w.balance_toman) < amount || money(pooled.balance) < amount) throw new Error("insufficient_credit");
    const settlement = goodsSettlementAmounts(p.base_payout_amount_toman, feeDiscountToman === undefined ? "0" : feeDiscountToman);
    executeChanges("UPDATE goods_purchases SET payout_amount_toman=?,fee_discount_toman=? WHERE id=?",
      [settlement.payoutAmountToman,settlement.feeDiscountToman,id]);
    executeChanges("UPDATE goods_plan_wallets SET balance_toman=? WHERE id=?", [(money(w.balance_toman)-amount).toString(),w.id]);
    executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(money(pooled.balance)-amount).toString(),pooled.id]);
    execute("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(?,?,'goods_purchase_debit',?,?,?)", [pooled.id,amount.toString(),`goods:${id}:debit`,actorId,now()]);
    executeChanges("UPDATE goods_credit_lots SET consumed=1 WHERE purchase_id=?", [id]);
    execute("INSERT OR IGNORE INTO goods_company_wallets(plan_id,balance_toman) VALUES(?,'0')", [p.plan_id]);
    const company = queryRow<any>("SELECT balance_toman FROM goods_company_wallets WHERE plan_id=?", [p.plan_id])!;
    executeChanges("UPDATE goods_company_wallets SET balance_toman=? WHERE plan_id=?", [(money(company.balance_toman)+money(p.company_credit_toman)).toString(),p.plan_id]);
    financialEntry(p,"customer_credit_debit",amount,actorId);
    financialEntry(p,"development_discount",money(p.development_discount_toman),actorId);
    financialEntry(p,"company_credit",money(p.company_credit_toman),actorId);
    postCompanyPurchaseReceipt(crmDb, id);
    executeChanges("UPDATE goods_purchases SET stage='acknowledgement_signature' WHERE id=?", [id]);
    goodsEvent(id,"settled",actorId,settlement);
    return getGoodsPurchase(id);
  });
}
export function completeGoodsPurchase(id: number, actorId: number): any {
  return runTransaction(() => {
    const p = getGoodsPurchase(id); if (p.stage === "completed") return p;
    const acknowledgement = goodsDocumentState(id,"acknowledgement");
    if (p.stage !== "registrar_confirmation" || !p.acknowledgement_signed || !acknowledgement?.signed || acknowledgement.invoiceVersion!==p.invoice_version) throw new Error("signed_acknowledgement_required");
    const config = p.commission_settings_json ? JSON.parse(p.commission_settings_json) : null;
    if (!config) throw new Error("salesperson_commission_configuration_required");
    // Team-sales commission model (OFF by default): for team members from its start date it either defers posting
    // to the payment order «پرداخت‌شده» moment or posts on its own basis. Everyone else continues below, unchanged.
    const team = onGoodsPurchaseCompletion(p, actorId);
    if (team !== "legacy") { goodsEvent(id,"completed",actorId,{model:"team",commission:team}); return getGoodsPurchase(id); }
    const month = persianMonth();
    const prior = queryRows<any>("SELECT COALESCE(base_payout_amount_toman,payout_amount_toman) sales_amount FROM goods_purchases WHERE salesperson_id=? AND stage='completed' AND commission_month=?", [p.salesperson_id,month]).reduce((s,r)=>s+money(r.sales_amount),0n);
    // Fee discounts adjust the customer's bank payout, not the agreed sale
    // volume, tier thresholds or salesperson commission.
    const saleAmount = money(p.base_payout_amount_toman);
    const sales = prior + saleAmount;
    const tier = sales >= money(config.target3_toman) ? 3 : sales >= money(config.target2_toman) ? 2 : sales >= money(config.target1_toman) ? 1 : 0;
    const rate = config[`rate${tier}_bps`], commission = percentage(saleAmount,rate);
    execute("INSERT OR IGNORE INTO goods_salesperson_wallets(salesperson_id,balance_toman) VALUES(?,'0')", [p.salesperson_id]);
    const w = queryRow<any>("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=?", [p.salesperson_id])!;
    executeChanges("UPDATE goods_salesperson_wallets SET balance_toman=? WHERE salesperson_id=?", [(money(w.balance_toman)+commission).toString(),p.salesperson_id]);
    financialEntry(p,"salesperson_commission",commission,actorId);
    executeChanges("UPDATE goods_purchases SET stage='completed',completed_at=?,commission_bps=?,commission_toman=?,commission_month=? WHERE id=?", [now(),rate,commission.toString(),month,id]);
    goodsEvent(id,"completed",actorId,{month,postSaleTotalToman:sales.toString(),rateBps:rate,rounding:"floor_toman"});
    return getGoodsPurchase(id);
  });
}