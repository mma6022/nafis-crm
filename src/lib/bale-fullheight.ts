/**
 * t984 «گفتگوهای بله تمام‌قد» v1.1 (Armita bale-chat-fullheight): read-only customer wallet view for the Bale inbox.
 * Flag: flag.bale_fullheight_v1 (call_queue_settings; only '1' is ON; absent = OFF). OFF → /bale-workspace/chats/:id/wallet answers 404 and
 * /bale-workspace/me carries no `fullHeight`, so the inbox renders exactly as before.
 *
 * Data: the SAME tables the customer file reads (wallet_accounts_v2 + wallet_ledger_v2, cash + credit), through plain SELECTs only:
 * unlike getWalletSummary() this never creates a missing wallet account, and nothing here writes (no INSERT/UPDATE/DELETE, no schema).
 * Who may read: exactly who may read GET /api/customers/:id/wallet (customers.view + staff role + customer scope, or an SMC view grant)
 * AND whom the workspace already shows the customer in full (bwsSeesCustomer) — see bfhCanViewWallet.
 * Amounts are toman strings (as stored). No actor, phone, national id or message text is returned.
 */
import { queryRow, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";
import { smcCanViewCustomer } from "./smc-access-scope";

export const BFH_FLAG = "flag.bale_fullheight_v1";
export const bfhOn = (): boolean => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [BFH_FLAG])?.value === "1"; } catch { return false; }
};
export const BFH_LEDGER_LIMIT = 100;
const STAFF_ROLES = new Set(["admin", "salesperson", "registrar"]);

/** Mirrors `scopedCustomer` in routes/wallets.ts (GET): same role, permission and scope rule, so the wallet is never wider than the customer file's. */
export function bfhCanViewWallet(u: AuthUser | undefined, customerId: number): boolean {
  if (!u || !STAFF_ROLES.has(u.role) || !u.permissions.includes("customers.view")) return false;
  const c = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c) return false;
  if (u.customerScope === "assigned" && c.salesperson_id !== u.salespersonId && !smcCanViewCustomer(u, customerId, "customers")) return false;
  return true;
}

export type BfhWalletItem = { id: number; wallet: "cash" | "credit"; dir: "in" | "out"; amountToman: string; label: string; at: string; balanceAfterToman: string | null };
export type BfhWallet = { customerId: number; cashToman: string; creditToman: string; items: BfhWalletItem[]; truncated: boolean };

/** withdrawal kinds: *_out / *_debit (+ the legacy withdrawals). Everything else is a deposit. */
export const bfhDir = (kind: string): "in" | "out" => (/(_out|_debit)$/.test(kind) || kind === "legacy_filing_fee" || kind === "legacy_manual_withdrawal" ? "out" : "in");
export function bfhLabel(kind: string): string {
  if (kind === "cash_payment") return "شارژ نقدی از درگاه";
  if (kind === "transfer_in") return "دریافت انتقال از مشتری دیگر";
  if (kind === "transfer_out") return "انتقال به مشتری دیگر";
  if (kind.startsWith("loan_credit")) return "شارژ اعتبار تسهیلات";
  if (kind === "credit_correction_debit") return "اصلاح کسر اقساط تسهیلات";
  if (kind === "goods_purchase_debit") return "خرید کالا از اعتبار";
  if (kind === "filing_fee_out" || kind === "legacy_filing_fee") return "کارمزد بررسی پرونده";
  if (kind === "legacy_manual_deposit") return "واریز دستی";
  if (kind === "legacy_manual_withdrawal") return "برداشت دستی";
  return "سابقه کیف پول";
}

export function bfhWallet(customerId: number): BfhWallet {
  const items: BfhWalletItem[] = []; const bal: Record<"cash" | "credit", string> = { cash: "0", credit: "0" }; let truncated = false;
  for (const type of ["cash", "credit"] as const) {
    const acc = queryRow<{ id: number; balance: string }>("SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?", [customerId, type]);
    if (!acc) continue;
    bal[type] = String(acc.balance);
    const rows = queryRows<{ id: number; amount: string; kind: string; created_at: string }>("SELECT id,amount,kind,created_at FROM wallet_ledger_v2 WHERE wallet_id=? ORDER BY id DESC LIMIT ?", [acc.id, BFH_LEDGER_LIMIT + 1]);
    if (rows.length > BFH_LEDGER_LIMIT) { truncated = true; rows.pop(); }
    let run: bigint | null = /^\d+$/.test(String(acc.balance)) ? BigInt(acc.balance) : null; // newest first: «مانده پس از تراکنش» walks back from the current balance
    for (const r of rows) {
      const dir = bfhDir(r.kind);
      items.push({ id: Number(r.id), wallet: type, dir, amountToman: String(r.amount), label: bfhLabel(r.kind), at: r.created_at, balanceAfterToman: run != null && run >= 0n ? run.toString() : null });
      if (run != null && /^\d+$/.test(String(r.amount))) { const a = BigInt(r.amount); run = dir === "in" ? run - a : run + a; } else run = null;
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  return { customerId, cashToman: bal.cash, creditToman: bal.credit, items, truncated };
}
