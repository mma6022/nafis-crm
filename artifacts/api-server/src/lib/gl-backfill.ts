/**
 * General ledger — package G6 (2026-10-27): BACKFILL / CATCH-UP LIBRARY (ACCOUNTING-DESIGN phase 3, DEV-REVIEW §3).
 *
 * Not wired to any route, hook or timer. Used only by the operator CLI (dist/gl-backfill-cli.mjs) and the fixtures.
 * Rules:
 *  - reads the old tables only (never UPDATE/DELETE on them); writes only gl_* rows.
 *  - replays, in created_at then id order: wallet_ledger_v2 (P2 / P1), loan_filing_fee_charges (P4, amount only),
 *    wallet_transfers (P5/P6), goods_finance_ledger (P7 original, P7C settings correction, P10-P12), accounting_documents (P8/P9/P18).
 *    wallet_payment_intents are NOT replayed: a credited intent is already the wallet_ledger_v2 cash_payment row (P2).
 *  - the source key is the SAME key the G3/G4 capture triggers use (gl:<event>:<id>); before posting both that key and
 *    gl:backfill:<table>:<id> are checked, so one event never gets two vouchers (worker + backfill).
 *  - N7 / G6 2101 rule: every event dated before gl.ledger_start_date gets a status only (no voucher; the opening voucher
 *    holds the control totals). P7 credits additionally need gl.opening_base_date and are excluded when dated on/before it,
 *    or when their payment order already sits in the opening 2101 total (created before the end of the base date) -> no overlap.
 *  - purchase #2 style corrections (company_credit with a non-standard key, e.g. goods:2:settings-correction:...) are a
 *    second voucher (P7C) with the reverse sign of the moved amount; the original P7 uses the original rows.
 *  - --exclude-fee ids get status only (gl_excluded:fee_list) and are listed as exceptions.
 *  - dry-run: everything inside one transaction that is ROLLED BACK -> no write survives; report = counts, account totals, exceptions.
 *  - apply: one BEGIN IMMEDIATE per batch of 50 events; re-running continues where it stopped (idempotent; 2nd apply = 0 new).
 */
import type { DatabaseSync } from "node:sqlite";
import { buildShadowVoucher, ensureGlShadowSchema, glMappingAsOf } from "./gl-shadow";
import { postVoucher, reverseVoucher, recordGlException, tehranDateOf, addDays, tomanToRial, ensureTafsili, type GlLineInput } from "./gl-posting";
import { financeSettingAsOf } from "./ledger";

export type BackfillEvent = {
  at: string; table: string; id: number; eventType: string; sourceKey: string; backfillKey: string;
  sourceType: string; sourceId: string; payload: Record<string, unknown>;
};
export type BackfillStatus = "post" | "already" | "skip" | "excluded" | "fail";
export type BackfillItem = { table: string; id: number; eventType: string; sourceKey: string; eventDate: string | null; status: BackfillStatus; code: string | null; voucherId: number | null };
export type BackfillReport = {
  mode: "dry-run" | "apply"; events: number; created: number;
  byType: Record<string, Record<string, number>>;
  accounts: Record<string, { debitRial: number; creditRial: number }>;
  exceptions: Array<{ table: string; id: number; eventType: string; code: string }>;
  controls: BackfillControls; items: BackfillItem[];
};
export type BackfillControls = {
  tbBalanced: boolean; totalDebitRial: number; totalCreditRial: number;
  gl4103Rial: number; feesInScopeRial: number; gl4101Rial: number; salesInScopeRial: number;
  gl2102Rial: number; commissionsInScopeRial: number; gl2101Rial: number; opening2101Rial: number; postStartP7PayoutRial: number; p8PaidRial: number;
  p7Overlap: number[]; p7Gaps: number[];
};

const has = (db: DatabaseSync, t: string) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(t);
const iso = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : v; };
const one = <T>(db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
const STD_P7 = /^goods:(\d+):company_credit$/;
const COMMISSION: Record<string, string> = { salesperson_commission: "P10", p1_referral_share: "P10", data_accuracy_bonus: "P11", team_bonus: "P11", returned_case_deduction: "P12", paid_mark_reversal: "P12" };

/** All replayable events, oldest first (created_at, then table, then id). Read-only. */
export function collectBackfillEvents(db: DatabaseSync): BackfillEvent[] {
  const out: BackfillEvent[] = [];
  const push = (e: Omit<BackfillEvent, "backfillKey" | "at"> & { at: string }) => out.push({ ...e, at: iso(e.at), backfillKey: `gl:backfill:${e.table}:${e.id}` });
  if (has(db, "wallet_ledger_v2")) {
    for (const r of db.prepare("SELECT id,kind,idempotency_key k,created_at FROM wallet_ledger_v2 WHERE kind='cash_payment' OR kind LIKE 'loan_credit:%'").all() as Array<{ id: number; kind: string; k: string; created_at: string }>) {
      const p2 = r.kind === "cash_payment";
      push({ at: r.created_at, table: "wallet_ledger_v2", id: r.id, eventType: p2 ? "P2" : "P1", sourceKey: p2 ? `gl:${r.k}` : `gl:loan-credit:${r.id}`, sourceType: "wallet_ledger_v2", sourceId: String(r.id), payload: { at: r.created_at } });
    }
  }
  if (has(db, "loan_filing_fee_charges")) {
    for (const r of db.prepare("SELECT id,created_at FROM loan_filing_fee_charges WHERE amount_toman NOT IN ('0','')").all() as Array<{ id: number; created_at: string }>)
      push({ at: r.created_at, table: "loan_filing_fee_charges", id: r.id, eventType: "P4", sourceKey: `gl:filing-fee:${r.id}`, sourceType: "loan_filing_fee_charges", sourceId: String(r.id), payload: { at: r.created_at } });
  }
  if (has(db, "wallet_transfers")) {
    for (const r of db.prepare("SELECT id,wallet_type,created_at FROM wallet_transfers WHERE status='completed'").all() as Array<{ id: number; wallet_type: string; created_at: string }>)
      push({ at: r.created_at, table: "wallet_transfers", id: r.id, eventType: r.wallet_type === "cash" ? "P5" : "P6", sourceKey: `gl:wallet-transfer:${r.id}`, sourceType: "wallet_transfers", sourceId: String(r.id), payload: { at: r.created_at } });
  }
  if (has(db, "goods_finance_ledger") && has(db, "goods_purchases")) {
    const rows = db.prepare("SELECT id,purchase_id,kind,amount_toman,idempotency_key k,created_at FROM goods_finance_ledger ORDER BY id").all() as Array<{ id: number; purchase_id: number | null; kind: string; amount_toman: string; k: string; created_at: string }>;
    const corrections = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.kind === "company_credit") {
        const std = STD_P7.exec(r.k);
        if (std && Number(std[1]) === r.purchase_id) {
          const p = one<{ id: number; plan_id: number; customer_id: number; credit_amount_toman: string; payout_amount_toman: string; base_payout_amount_toman: string | null; fee_discount_toman: string }>(db,
            "SELECT id,plan_id,customer_id,credit_amount_toman,payout_amount_toman,base_payout_amount_toman,fee_discount_toman FROM goods_purchases WHERE id=?", r.purchase_id);
          const disc = one<{ a: string }>(db, "SELECT amount_toman a FROM goods_finance_ledger WHERE idempotency_key=?", `goods:${r.purchase_id}:development_discount`)?.a ?? "0";
          const credit = (BigInt(String(r.amount_toman).trim()) + BigInt(String(disc).trim())).toString();
          push({ at: r.created_at, table: "goods_finance_ledger", id: r.id, eventType: "P7", sourceKey: `gl:goods:${r.purchase_id}:settle`, sourceType: "goods_finance_ledger", sourceId: String(r.id),
            payload: p ? { at: r.created_at, purchase_id: p.id, plan_id: p.plan_id, customer_id: p.customer_id, credit, payout: p.payout_amount_toman, base_payout: p.base_payout_amount_toman,
              discount: disc, company: r.amount_toman, fee_discount: p.fee_discount_toman, purchase_credit: p.credit_amount_toman } : { at: r.created_at } });
        } else {
          const prefix = r.k.endsWith(":company_credit") ? r.k.slice(0, -":company_credit".length) : r.k;
          corrections.set(prefix, [...(corrections.get(prefix) ?? []), r]);
        }
      } else if (COMMISSION[r.kind]) {
        push({ at: r.created_at, table: "goods_finance_ledger", id: r.id, eventType: COMMISSION[r.kind], sourceKey: `gl:goods-fin:${r.id}`, sourceType: "goods_finance_ledger", sourceId: String(r.id), payload: { at: r.created_at } });
      }
    }
    for (const [prefix, cc] of corrections) {
      const all = rows.filter((r) => r.k.startsWith(`${prefix}:`) && (r.kind === "company_credit" || r.kind === "development_discount"));
      const first = cc[0];
      push({ at: first.created_at, table: "goods_finance_ledger", id: first.id, eventType: "P7C", sourceKey: `gl:goods:${first.purchase_id}:correction:${first.id}`, sourceType: "goods_finance_ledger", sourceId: String(first.id),
        payload: { at: first.created_at, purchase_id: first.purchase_id, rows: all.map((r) => [r.id, r.kind, r.amount_toman]) } });
    }
  }
  if (has(db, "accounting_documents")) {
    for (const d of db.prepare("SELECT id,source,source_order_id,request_key,transaction_date,document_date,created_at FROM accounting_documents WHERE source IN ('payment_order','manual')").all() as Array<{ id: number; source: string; source_order_id: number | null; request_key: string | null; transaction_date: string | null; document_date: string | null; created_at: string }>) {
      const rk = String(d.request_key ?? "");
      const rev = rk.includes(":r") ? rk.slice(rk.indexOf(":r") + 2) : "0";
      const m = /^payment-revert:([^:]+):(\d+)$/.exec(rk);
      if (d.source === "payment_order") push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P8", sourceKey: `gl:payment-order:${d.source_order_id}:r${rev}`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.transaction_date, order_id: d.source_order_id, rev } });
      else if (m) push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P9", sourceKey: `gl:payment-order:${m[1]}:r${Number(m[2]) - 1}:reversal`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.document_date, order_id: m[1], orig_key: `gl:payment-order:${m[1]}:r${Number(m[2]) - 1}` } });
      else push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P18", sourceKey: `gl:acc-doc:${d.id}`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.transaction_date } });
    }
  }
  const tOrder = ["wallet_ledger_v2", "loan_filing_fee_charges", "wallet_transfers", "goods_finance_ledger", "accounting_documents"];
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : tOrder.indexOf(a.table) - tOrder.indexOf(b.table) || a.id - b.id));
}

const eventDateOf = (e: BackfillEvent) => { const ev = String(e.payload.event_date ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(ev) ? ev : tehranDateOf(String(e.payload.at ?? e.at)); };
/** End of a Tehran calendar date as a UTC instant (UTC+03:30, no DST since 2022). */
const endOfTehranDay = (d: string) => new Date(Date.parse(`${addDays(d, 1)}T00:00:00+03:30`)).toISOString();

type Built = { skip: string; note: string } | { post: Parameters<typeof postVoucher>[1] } | { reverse: { voucherId: number; eventDate: string; reason: string; sourceKey: string } };

/** P7 / P7C: the G6 2101 rule on top of the shared builder. */
function buildEvent(db: DatabaseSync, e: BackfillEvent, nowIso: string): Built {
  const row = { id: 0, source_key: e.sourceKey, event_type: e.eventType, source_type: e.sourceType, source_id: e.sourceId, payload_json: JSON.stringify(e.payload), attempts: 0 };
  if (e.eventType !== "P7" && e.eventType !== "P7C") return buildShadowVoucher(db, row, nowIso) as Built;
  const eventDate = eventDateOf(e);
  const start = financeSettingAsOf(db, "gl.ledger_start_date", eventDate);
  if (!start) throw new Error("finance_setting_missing:gl.ledger_start_date");
  if (eventDate < start) return { skip: "gl_before_ledger_start", note: "پیش از شروع دفتر؛ مانده در سند افتتاحیه" };
  const base = financeSettingAsOf(db, "gl.opening_base_date", eventDate);
  if (!base) throw new Error("finance_setting_missing:gl.opening_base_date");
  if (eventDate <= base) return { skip: "gl_before_opening_base", note: "تا تاریخ مبنا؛ مانده‌ی ۲۱۰۱ در سند افتتاحیه" };
  const pid = Number(e.payload.purchase_id);
  if (has(db, "customer_payment_orders")) {
    const inOpening = one<{ id: number }>(db, "SELECT id FROM customer_payment_orders WHERE purchase_id=? AND created_at < ? LIMIT 1", pid, endOfTehranDay(base));
    if (inOpening) return { skip: "gl_in_opening_2101", note: `دستور پرداخت #${inOpening.id} در جمع ۲۱۰۱ افتتاحیه است` };
  }
  // P7 original: built from the original rows (a later correction is its own P7C voucher)
  if (e.eventType === "P7") return buildShadowVoucher(db, row, nowIso) as Built;
  // P7C: settings correction moving amounts between 1201 (company share) and the discount account; credit unchanged
  const { version, m } = glMappingAsOf(db, "P7", eventDate);
  const nature = financeSettingAsOf(db, "discount.development.nature", eventDate);
  if (!nature) return { skip: "finance_setting_missing:discount.development.nature", note: "تنظیم مالی در تاریخ رویداد خالی است" };
  const discountAcc = m.discount[nature];
  if (!discountAcc || nature === "marketing_expense") return { skip: `gl_deferred:discount_nature:${nature}`, note: "حساب ۶۱۰۳ و ذی‌نفع هنوز فعال نیستند" };
  const p = one<{ plan_id: number }>(db, "SELECT plan_id FROM goods_purchases WHERE id=?", pid);
  if (!p) throw new Error("gl_source_missing");
  const plT = ensureTafsili(db, "PL", p.plan_id, `طرح #${p.plan_id}`, nowIso);
  const lines: GlLineInput[] = [];
  let sum = 0n;
  for (const [, kind, amt] of e.payload.rows as Array<[number, string, string]>) {
    const v = BigInt(String(amt).trim()); sum += v;
    if (v === 0n) continue;
    const r = tomanToRial((v < 0n ? -v : v).toString());
    const acc = kind === "company_credit" ? m.receivable : discountAcc;
    lines.push(v > 0n ? { account: acc, tafsiliId: plT, debitRial: r, description: kind } : { account: acc, tafsiliId: plT, creditRial: r, description: kind });
  }
  if (sum !== 0n) throw new Error("gl_p7_correction_changes_credit");
  if (lines.length < 2) return { skip: "gl_zero_amount", note: "اصلاحیه‌ی بی‌اثر" };
  return { post: { eventDate, kind: "backfill", sourceKey: e.sourceKey, sourceType: "goods_purchases", sourceId: pid, nowIso,
    description: `اصلاح تسویه‌ی خرید #${pid} (علامت برگشتی، نگاشت P7 نسخه ${version})`, lines } };
}

export type BackfillOptions = { apply: boolean; excludeFees?: number[]; retrySkipped?: boolean; batchSize?: number; nowIso?: string; keepItems?: boolean };

/** Runs the backfill. dry-run: one transaction, rolled back. apply: batches of 50 in BEGIN IMMEDIATE. Never call inside a transaction. */
export function runGlBackfill(db: DatabaseSync, opts: BackfillOptions): BackfillReport {
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) throw new Error("gl_backfill_in_transaction");
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const exclude = new Set(opts.excludeFees ?? []);
  const batch = Math.max(1, Math.min(opts.batchSize ?? 50, 50));
  const report: BackfillReport = { mode: opts.apply ? "apply" : "dry-run", events: 0, created: 0, byType: {}, accounts: {}, exceptions: [], controls: null as unknown as BackfillControls, items: [] };
  // the ledger schema (G1) must already exist; the backfill never creates it
  if (!has(db, "gl_vouchers") || !has(db, "gl_accounts")) throw new Error("gl_ledger_schema_missing");
  const vBefore = one<{ m: number }>(db, "SELECT COALESCE(MAX(id),0) m FROM gl_vouchers")?.m ?? 0;
  const begin = () => db.exec(opts.apply ? "BEGIN IMMEDIATE" : "BEGIN");
  begin();
  try {
    ensureGlShadowSchema(db, nowIso);
    const events = collectBackfillEvents(db);
    report.events = events.length;
    let inBatch = 0;
    for (const e of events) {
      const item = processOne(db, e, exclude, !!opts.retrySkipped, nowIso);
      report.items.push(item);
      (report.byType[e.eventType] ??= {})[item.status] = ((report.byType[e.eventType] ??= {})[item.status] ?? 0) + 1;
      if (item.status === "skip" || item.status === "excluded" || item.status === "fail")
        if (item.code !== "gl_before_ledger_start") report.exceptions.push({ table: e.table, id: e.id, eventType: e.eventType, code: item.code ?? "-" });
      if (opts.apply && ++inBatch >= batch) { db.exec("COMMIT"); begin(); inBatch = 0; }
    }
    for (const r of db.prepare(`SELECT a.code, SUM(l.debit_rial) d, SUM(l.credit_rial) c FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.voucher_id > ? GROUP BY a.code ORDER BY a.code`).all(vBefore) as Array<{ code: string; d: number; c: number }>)
      report.accounts[r.code] = { debitRial: r.d, creditRial: r.c };
    report.created = one<{ n: number }>(db, "SELECT COUNT(*) n FROM gl_vouchers WHERE id > ?", vBefore)!.n;
    report.controls = backfillControls(db, report.items);
    db.exec(opts.apply ? "COMMIT" : "ROLLBACK");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* closed */ }
    throw err;
  }
  if (!opts.keepItems) report.items = report.items.filter((i) => i.status === "fail");
  return report;
}

function processOne(db: DatabaseSync, e: BackfillEvent, exclude: Set<number>, retrySkipped: boolean, nowIso: string): BackfillItem {
  const base = { table: e.table, id: e.id, eventType: e.eventType, sourceKey: e.sourceKey };
  const v = one<{ id: number; event_date: string }>(db, "SELECT id,event_date FROM gl_vouchers WHERE source_key IN (?,?) LIMIT 1", e.sourceKey, e.backfillKey);
  if (v) return { ...base, eventDate: v.event_date, status: "already", code: null, voucherId: v.id };
  const q = one<{ id: number; status: string; last_error: string | null; attempts: number }>(db, "SELECT id,status,last_error,attempts FROM gl_posting_queue WHERE source_key=?", e.sourceKey);
  if (q && q.status === "skipped" && !retrySkipped) return { ...base, eventDate: null, status: "already", code: q.last_error, voucherId: null };
  const upsert = (status: "posted" | "skipped" | "failed", err: string | null, voucherId: number | null) =>
    db.prepare(`INSERT INTO gl_posting_queue(source_key,event_type,source_type,source_id,payload_json,status,attempts,next_attempt_at,last_error,voucher_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,NULL,?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET status=excluded.status, attempts=attempts+1, next_attempt_at=NULL, last_error=excluded.last_error, voucher_id=excluded.voucher_id, updated_at=excluded.updated_at
      WHERE gl_posting_queue.status<>'posted'`).run(e.sourceKey, e.eventType, e.sourceType, e.sourceId, JSON.stringify(e.payload), status, err, voucherId, nowIso, nowIso);
  let eventDate: string | null = null;
  try { eventDate = eventDateOf(e); } catch { eventDate = null; }
  if (e.eventType === "P4" && exclude.has(e.id)) {
    recordGlException(db, "loan_filing_fee_charges", e.id, "gl_excluded:fee_list", "هزینه‌ی بدون پرونده، طبق فهرست استثنا (--exclude-fee)", nowIso);
    upsert("skipped", "gl_excluded:fee_list", null);
    return { ...base, eventDate, status: "excluded", code: "gl_excluded:fee_list", voucherId: null };
  }
  db.exec("SAVEPOINT gl_backfill_one");
  try {
    const b = buildEvent(db, e, nowIso);
    let out: BackfillItem;
    if ("skip" in b) {
      recordGlException(db, e.sourceType, e.sourceId, b.skip, b.note, nowIso);
      upsert("skipped", b.skip, null);
      out = { ...base, eventDate, status: "skip", code: b.skip, voucherId: null };
    } else {
      const r = "reverse" in b
        ? reverseVoucher(db, b.reverse.voucherId, { eventDate: b.reverse.eventDate, reason: b.reverse.reason, sourceKey: b.reverse.sourceKey, nowIso })
        : postVoucher(db, { ...b.post, kind: "backfill" });
      upsert("posted", null, r.voucherId);
      out = { ...base, eventDate, status: r.created ? "post" : "already", code: null, voucherId: r.voucherId };
    }
    db.exec("RELEASE gl_backfill_one");
    return out;
  } catch (err) {
    db.exec("ROLLBACK TO gl_backfill_one"); db.exec("RELEASE gl_backfill_one");
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    upsert("failed", msg, null);
    return { ...base, eventDate, status: "fail", code: msg.split(" ")[0].slice(0, 120), voucherId: null };
  }
}

const accBal = (db: DatabaseSync, code: string) => one<{ n: number }>(db, "SELECT COALESCE(SUM(l.credit_rial),0)-COALESCE(SUM(l.debit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE a.code=?", code)!.n;
/** Reconciliation controls (DEV-REVIEW §3-3) over the whole ledger after the run. Ids only, no names. */
export function backfillControls(db: DatabaseSync, items: BackfillItem[]): BackfillControls {
  const t = one<{ d: number; c: number }>(db, "SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM gl_voucher_lines")!;
  const inScope = (ev: string) => items.filter((i) => i.eventType === ev && (i.status === "post" || (i.status === "already" && i.voucherId)));
  const sumSrc = (ids: number[], sql: string) => ids.reduce((s, id) => s + tomanToRial(String((one<{ a: string }>(db, sql, id)?.a ?? "0")).replace(/^-/, "")), 0);
  const fees = sumSrc(inScope("P4").map((i) => i.id), "SELECT amount_toman a FROM loan_filing_fee_charges WHERE id=?");
  const p7 = inScope("P7");
  const purchaseOf = (gflId: number) => one<{ p: number }>(db, "SELECT purchase_id p FROM goods_finance_ledger WHERE id=?", gflId)!.p;
  const p7Purchases = p7.map((i) => purchaseOf(i.id));
  const sales = sumSrc(p7Purchases, "SELECT credit_amount_toman a FROM goods_purchases WHERE id=?");
  const payout = sumSrc(p7Purchases, "SELECT payout_amount_toman a FROM goods_purchases WHERE id=?");
  const comm = ["P10", "P11"].flatMap(inScope).map((i) => i.id), neg = inScope("P12").map((i) => i.id);
  const commissions = sumSrc(comm, "SELECT amount_toman a FROM goods_finance_ledger WHERE id=?") - sumSrc(neg, "SELECT amount_toman a FROM goods_finance_ledger WHERE id=?");
  const opening2101 = one<{ n: number }>(db, "SELECT COALESCE(SUM(l.credit_rial),0)-COALESCE(SUM(l.debit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id JOIN gl_vouchers v ON v.id=l.voucher_id WHERE a.code='2101' AND v.kind='opening'")!.n;
  const p8 = one<{ n: number }>(db, "SELECT COALESCE(SUM(l.debit_rial),0)-COALESCE(SUM(l.credit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id JOIN gl_vouchers v ON v.id=l.voucher_id WHERE a.code='2101' AND v.kind<>'opening' AND v.source_key LIKE 'gl:payment-order:%'")!.n;
  // overlap: a purchase both in the opening 2101 (its order created by the end of the base date) and with a P7 voucher
  let overlap: number[] = [], gaps: number[] = [];
  const base = one<{ value: string }>(db, "SELECT value FROM finance_settings WHERE key='gl.opening_base_date' AND scope_type='global' ORDER BY effective_from DESC, id DESC LIMIT 1")?.value;
  if (base && has(db, "customer_payment_orders")) {
    const cutoff = endOfTehranDay(base);
    const inOpening = new Set((db.prepare("SELECT purchase_id p FROM customer_payment_orders WHERE purchase_id IS NOT NULL AND created_at < ?").all(cutoff) as Array<{ p: number }>).map((r) => r.p));
    overlap = p7Purchases.filter((p) => inOpening.has(p));
    // gap: settled (company_credit row) but in neither the opening 2101 nor a P7 voucher, and not before the start by design
    const p7Set = new Set(p7Purchases);
    gaps = items.filter((i) => i.eventType === "P7" && i.status !== "post" && !i.voucherId && i.code !== "gl_in_opening_2101").map((i) => purchaseOf(i.id))
      .filter((p) => !inOpening.has(p) && !p7Set.has(p));
  }
  return { tbBalanced: t.d === t.c, totalDebitRial: t.d, totalCreditRial: t.c,
    gl4103Rial: accBal(db, "4103"), feesInScopeRial: fees, gl4101Rial: accBal(db, "4101"), salesInScopeRial: sales,
    gl2102Rial: accBal(db, "2102"), commissionsInScopeRial: commissions, gl2101Rial: accBal(db, "2101"), opening2101Rial: opening2101,
    postStartP7PayoutRial: payout, p8PaidRial: p8, p7Overlap: overlap, p7Gaps: [...new Set(gaps)].sort((a, b) => a - b) };
}
