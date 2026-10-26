/**
 * General ledger — package G3 (2026-10-26): NON-BANK SHADOW POSTING (P1, P2, P4, P5, P6, P7, P10, P11, P12).
 * Package G4 (2026-10-27): BANK SHADOW POSTING (P8 pay, P9 unpay reversal, P18 manual bank document) — NON-BLOCKING:
 *    capture trigger on accounting_documents (only when gl.shadow_bank = '1'), same queue/worker. /pay never waits for the
 *    ledger; the existing accounting_require_payment_journal trigger is untouched. Blocking mode (gl.bank_blocking) is NOT
 *    built (needs a month of zero mismatches). P18 needs the W3 counter account -> exception 'gl_deferred:W3:counter_account'.
 *    Bank opening documents (source='opening') are not captured: bank opening balances go through the opening voucher.
 *
 * How it stays harmless:
 *  - Capture: AFTER INSERT triggers on the existing source tables write ONE row into gl_posting_queue, in the same
 *    transaction as the business write, and ONLY when gl.shadow_nonbank = '1' (OFF by default; WHEN clause is false otherwise).
 *    INSERT OR IGNORE + COALESCE: the capture can never make a business write fail. The source tables are never changed.
 *  - Post: a worker (only when the flag is ON) turns queued rows into vouchers, each in its own IMMEDIATE transaction with a
 *    SAVEPOINT; a failure rolls back just that voucher and leaves the queue row 'failed' with last_error (pending report).
 *  - Mapping event -> accounts lives in gl_event_mappings (versioned, effective-dated, append-only), not in code.
 *  - Values Mohammad has not set (finance settings) => gl_exceptions row + queue 'skipped'; never a guessed voucher.
 *  - Deferred (open questions): P1/P6 and the P7 memo voucher use memo accounts 8101/8102 (Q7) -> 'skipped' with an
 *    exception; P7 with a deposit method other than 'gross' or a 'marketing_expense' discount needs inactive accounts
 *    2104/6104/6103 (codes awaiting confirmation) -> exception. No SMS, no notification, gl_* not a notification source.
 */
import type { DatabaseSync } from "node:sqlite";
import { financeSettingAsOf } from "./ledger";
import { ensureTafsili, postVoucher, reverseVoucher, recordGlException, tehranDateOf, tomanToRial, type GlLineInput } from "./gl-posting";

export const GL_SHADOW_MIGRATION = "general-ledger-g3-shadow-nonbank";
export const GL_SHADOW_BANK_MIGRATION = "general-ledger-g4-shadow-bank";
const FLAG = `(SELECT value FROM gl_settings WHERE key='gl.shadow_nonbank')='1'`;
const BANK_FLAG = `(SELECT value FROM gl_settings WHERE key='gl.shadow_bank')='1'`;
export const GL_NONBANK_EVENTS = ["P1", "P2", "P4", "P5", "P6", "P7", "P10", "P11", "P12"];
export const GL_BANK_EVENTS = ["P8", "P9", "P18"];
const NOWSQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const GL_MAPPING_DDL = `
CREATE TABLE IF NOT EXISTS gl_event_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL CHECK(event_code GLOB 'P[0-9]*'), version INTEGER NOT NULL CHECK(version >= 1),
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  UNIQUE(event_code, version), UNIQUE(event_code, effective_from));
CREATE TRIGGER IF NOT EXISTS gl_event_mappings_no_update BEFORE UPDATE ON gl_event_mappings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_event_mappings_no_delete BEFORE DELETE ON gl_event_mappings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
`;

/** Version 1 of the event -> account mapping (ACCOUNTING-DESIGN §4). A change = a new version with a later effective_from. */
export const GL_MAPPING_V1: Array<[string, Record<string, unknown>, string]> = [
  ["P1", { dr: "8101", cr: "8102", deferred: "Q7" }, "تخصیص اعتبار وام (انتظامی؛ منتظر Q7)"],
  ["P2", { dr: "1103", cr: "2201" }, "پرداخت زرین‌پال تأییدشده"],
  ["P4", { dr: "2201", cr: "4103" }, "هزینه‌ی تشکیل پرونده"],
  ["P5", { dr: "2201", cr: "2201" }, "انتقال نقدی بین مشتریان"],
  ["P6", { dr: "8101", cr: "8101", deferred: "Q7" }, "انتقال اعتباری (انتظامی؛ منتظر Q7)"],
  ["P7", { receivable: "1201", cogs: "5101", sales: "4101", payable: "2101",
    discount: { revenue_reduction: "4102", marketing_expense: "6103" }, supported_methods: ["gross"], memo: { dr: "8102", cr: "8101", deferred: "Q7" } }, "تسویه‌ی خرید کالا"],
  ["P10", { expense: "6101", payable: "2102", kinds: ["salesperson_commission", "p1_referral_share"] }, "پورسانت فروشنده"],
  ["P11", { expense: "6102", payable: "2102", kinds: ["data_accuracy_bonus", "team_bonus"] }, "پاداش دقت داده و تیمی"],
  ["P8", { dr: "2101", cr: "1102" }, "پرداخت دستور پرداخت به مشتری"],
  ["P9", { reverses: "P8" }, "برگشت «پرداخت‌شده‌ی اشتباه»"],
  ["P18", { counter: "W3", deferred_counter: "W3" }, "واریز/برداشت دستی بانک (حساب مقابل از ویزارد W3)"],
  ["P12", { kinds: ["returned_case_deduction", "paid_mark_reversal"], expense_of: { salesperson_commission: "6101", p1_referral_share: "6101", data_accuracy_bonus: "6102", team_bonus: "6102" }, default_expense: "6101", payable: "2102" }, "کسر پورسانت"],
];

const COMMISSION_KINDS = ["salesperson_commission", "p1_referral_share", "data_accuracy_bonus", "team_bonus", "returned_case_deduction", "paid_mark_reversal"];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Capture triggers (one per source table). Created only for tables that exist. */
function captureTriggers(db: DatabaseSync): string[] {
  const has = (t: string) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const ins = (key: string, ev: string, st: string, sid: string, payload: string) =>
    `INSERT OR IGNORE INTO gl_posting_queue(source_key,event_type,source_type,source_id,payload_json,status,attempts,created_at,updated_at)
     VALUES(${key}, ${ev}, ${q(st)}, CAST(${sid} AS TEXT), COALESCE(${payload},'{}'), 'pending', 0, ${NOWSQL}, ${NOWSQL});`;
  const out: string[] = [];
  if (has("wallet_ledger_v2")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_wallet_ledger AFTER INSERT ON wallet_ledger_v2
    WHEN ${FLAG} AND (NEW.kind='cash_payment' OR NEW.kind LIKE 'loan_credit:%')
    BEGIN ${ins(`CASE WHEN NEW.kind='cash_payment' THEN 'gl:'||NEW.idempotency_key ELSE 'gl:loan-credit:'||NEW.id END`,
      `CASE WHEN NEW.kind='cash_payment' THEN 'P2' ELSE 'P1' END`, "wallet_ledger_v2", "NEW.id", `json_object('at',NEW.created_at)`)} END;`);
  if (has("loan_filing_fee_charges")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_filing_fee AFTER INSERT ON loan_filing_fee_charges
    WHEN ${FLAG} AND NEW.amount_toman NOT IN ('0','')
    BEGIN ${ins(`'gl:filing-fee:'||NEW.id`, `'P4'`, "loan_filing_fee_charges", "NEW.id", `json_object('at',NEW.created_at)`)} END;`);
  if (has("wallet_transfers")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_wallet_transfer AFTER INSERT ON wallet_transfers
    WHEN ${FLAG} AND NEW.status='completed'
    BEGIN ${ins(`'gl:wallet-transfer:'||NEW.id`, `CASE NEW.wallet_type WHEN 'cash' THEN 'P5' ELSE 'P6' END`, "wallet_transfers", "NEW.id", `json_object('at',NEW.created_at)`)} END;`);
  if (has("goods_finance_ledger") && has("goods_purchases")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_goods_finance AFTER INSERT ON goods_finance_ledger
    WHEN ${FLAG} AND (NEW.kind='company_credit' OR NEW.kind IN (${COMMISSION_KINDS.map(q).join(",")}))
    BEGIN ${ins(`CASE WHEN NEW.kind='company_credit' THEN 'gl:goods:'||NEW.purchase_id||':settle' ELSE 'gl:goods-fin:'||NEW.id END`,
      `CASE WHEN NEW.kind='company_credit' THEN 'P7' WHEN NEW.kind IN ('salesperson_commission','p1_referral_share') THEN 'P10' WHEN NEW.kind IN ('data_accuracy_bonus','team_bonus') THEN 'P11' ELSE 'P12' END`,
      "goods_finance_ledger", "NEW.id",
      `CASE WHEN NEW.kind='company_credit' THEN (SELECT json_object('at',NEW.created_at,'purchase_id',p.id,'plan_id',p.plan_id,'customer_id',p.customer_id,
          'credit',p.credit_amount_toman,'payout',p.payout_amount_toman,'base_payout',p.base_payout_amount_toman,'discount',p.development_discount_toman,
          'company',p.company_credit_toman,'fee_discount',p.fee_discount_toman) FROM goods_purchases p WHERE p.id=NEW.purchase_id)
        ELSE json_object('at',NEW.created_at) END`)} END;`);
  if (has("accounting_documents")) {
    // request_key: 'payment:<order>' (r0) | 'payment:<order>:r<n>' ; 'payment-revert:<order>:<revision>' reverses r<revision-1>.
    const rev = `CASE WHEN instr(NEW.request_key,':r')>0 THEN substr(NEW.request_key,instr(NEW.request_key,':r')+2) ELSE '0' END`;
    const rest = `substr(NEW.request_key,16)`;
    const rOrder = `substr(${rest},1,instr(${rest},':')-1)`, rRev = `CAST(substr(${rest},instr(${rest},':')+1) AS INTEGER)`;
    out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_accounting_doc AFTER INSERT ON accounting_documents
    WHEN ${BANK_FLAG} AND (NEW.source='payment_order' OR NEW.source='manual')
    BEGIN ${ins(
      `CASE WHEN NEW.source='payment_order' THEN 'gl:payment-order:'||NEW.source_order_id||':r'||${rev}
            WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN 'gl:payment-order:'||${rOrder}||':r'||(${rRev}-1)||':reversal'
            ELSE 'gl:acc-doc:'||NEW.id END`,
      `CASE WHEN NEW.source='payment_order' THEN 'P8' WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN 'P9' ELSE 'P18' END`,
      "accounting_documents", "NEW.id",
      `CASE WHEN NEW.source='payment_order' THEN json_object('at',NEW.created_at,'event_date',NEW.transaction_date,'order_id',NEW.source_order_id,'rev',${rev})
            WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN json_object('at',NEW.created_at,'event_date',NEW.document_date,'order_id',${rOrder},'orig_key','gl:payment-order:'||${rOrder}||':r'||(${rRev}-1))
            ELSE json_object('at',NEW.created_at,'event_date',NEW.transaction_date) END`)} END;`);
  }
  return out;
}

/** Idempotent, additive. Call after the CRM's own schemas exist (and after ensureLedgerSchema). */
export function ensureGlShadowSchema(db: DatabaseSync, nowIso: string = new Date().toISOString()): void {
  db.exec("SAVEPOINT gl_shadow_ensure");
  try {
    db.exec(GL_MAPPING_DDL);
    const seed = db.prepare("INSERT OR IGNORE INTO gl_event_mappings(event_code,version,effective_from,mapping_json,note,created_at) VALUES(?,1,'2000-01-01',?,?,?)");
    for (const [ev, m, note] of GL_MAPPING_V1) seed.run(ev, JSON.stringify(m), note, nowIso);
    for (const sql of captureTriggers(db)) db.exec(sql);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(GL_SHADOW_MIGRATION, nowIso);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(GL_SHADOW_BANK_MIGRATION, nowIso);
    db.exec("RELEASE gl_shadow_ensure");
  } catch (e) { db.exec("ROLLBACK TO gl_shadow_ensure"); db.exec("RELEASE gl_shadow_ensure"); throw e; }
}

export function glMappingAsOf(db: DatabaseSync, eventCode: string, eventDate: string): { version: number; m: any } {
  const r = db.prepare("SELECT version,mapping_json FROM gl_event_mappings WHERE event_code=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(eventCode, eventDate) as { version: number; mapping_json: string } | undefined;
  if (!r) throw new Error(`gl_mapping_missing:${eventCode}`);
  return { version: r.version, m: JSON.parse(r.mapping_json) };
}

type QueueRow = { id: number; source_key: string; event_type: string; source_type: string | null; source_id: string | null; payload_json: string; attempts: number };
export type BuildResult = { post: Parameters<typeof postVoucher>[1] } | { skip: string; note: string }
  | { reverse: { voucherId: number; eventDate: string; reason: string; sourceKey: string } };
const one = <T>(db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
const cu = (db: DatabaseSync, id: number, now: string) => ensureTafsili(db, "CU", id, `مشتری #${id}`, now);
const sp = (db: DatabaseSync, id: number, now: string) => ensureTafsili(db, "SP", id, `فروشنده #${id}`, now);
const pl = (db: DatabaseSync, id: number, now: string) => ensureTafsili(db, "PL", id, `طرح #${id}`, now);
const bk = (db: DatabaseSync, id: number, now: string) => ensureTafsili(db, "BK", id, `بانک #${id}`, now);
const absToman = (v: string) => { const s = String(v).trim(); return s.startsWith("-") ? s.slice(1) : s; };

/** Builds the voucher for one queued event from the source rows (read-only on the old tables). Shared with G6 backfill. */
export function buildShadowVoucher(db: DatabaseSync, row: QueueRow, nowIso: string): BuildResult {
  const payload = JSON.parse(row.payload_json || "{}") as Record<string, string | number | null>;
  const at = String(payload.at ?? "");
  const ev = String(payload.event_date ?? "");
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(ev) ? ev : tehranDateOf(at);
  const start = financeSettingAsOf(db, "gl.ledger_start_date", eventDate);
  if (!start) throw new Error("finance_setting_missing:gl.ledger_start_date");
  if (eventDate < start) return { skip: "gl_before_ledger_start", note: "پیش از شروع دفتر؛ در افتتاحیه/بازپخش" };
  const { version, m } = glMappingAsOf(db, row.event_type, eventDate);
  if (m.deferred) return { skip: `gl_deferred:${m.deferred}`, note: `رویداد ${row.event_type} منتظر پاسخ ${m.deferred}` };
  const base = { eventDate, kind: "auto" as const, sourceKey: row.source_key, sourceType: row.source_type, sourceId: row.source_id, nowIso };
  const sid = Number(row.source_id);
  const desc = (t: string) => `${t} (نگاشت ${row.event_type} نسخه ${version})`;
  switch (row.event_type) {
    case "P2": {
      const l = one<{ amount: string; customer_id: number; key: string }>(db, "SELECT l.amount, w.customer_id, l.idempotency_key key FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id WHERE l.id=?", sid);
      if (!l) throw new Error("gl_source_missing");
      const r = tomanToRial(l.amount);
      return { post: { ...base, description: desc("پرداخت زرین‌پال"), lines: [{ account: m.dr, debitRial: r }, { account: m.cr, tafsiliId: cu(db, l.customer_id, nowIso), creditRial: r }] } };
    }
    case "P4": {
      const f = one<{ amount_toman: string; customer_id: number; plan_id: number }>(db, "SELECT amount_toman, customer_id, plan_id FROM loan_filing_fee_charges WHERE id=?", sid);
      if (!f) throw new Error("gl_source_missing");
      const r = tomanToRial(f.amount_toman);
      if (r === 0) return { skip: "gl_zero_amount", note: "هزینه‌ی صفر سند ندارد" };
      return { post: { ...base, description: desc("هزینه‌ی تشکیل پرونده"), lines: [{ account: m.dr, tafsiliId: cu(db, f.customer_id, nowIso), debitRial: r }, { account: m.cr, tafsiliId: pl(db, f.plan_id, nowIso), creditRial: r }] } };
    }
    case "P5": {
      const t = one<{ from_customer_id: number; to_customer_id: number; amount_toman: string }>(db, "SELECT from_customer_id,to_customer_id,amount_toman FROM wallet_transfers WHERE id=? AND status='completed'", sid);
      if (!t) throw new Error("gl_source_missing");
      const r = tomanToRial(t.amount_toman);
      return { post: { ...base, description: desc("انتقال نقدی بین مشتریان"), lines: [{ account: m.dr, tafsiliId: cu(db, t.from_customer_id, nowIso), debitRial: r }, { account: m.cr, tafsiliId: cu(db, t.to_customer_id, nowIso), creditRial: r }] } };
    }
    case "P7": {
      const pid = Number(payload.purchase_id), planId = Number(payload.plan_id), custId = Number(payload.customer_id);
      if (!pid || !planId || !custId) throw new Error("gl_source_missing");
      recordGlException(db, "goods_purchases", pid, "gl_deferred:Q7:memo", "سند انتظامی ۸۱۰۱/۸۱۰۲ منتظر Q7", nowIso);
      const method = financeSettingAsOf(db, "plan.supplier_deposit_method", eventDate, { type: "loan_plan", id: planId });
      const nature = financeSettingAsOf(db, "discount.development.nature", eventDate);
      const missing = [!method && "plan.supplier_deposit_method", !nature && "discount.development.nature"].filter(Boolean) as string[];
      if (missing.length) return { skip: `finance_setting_missing:${missing.join(",")}`, note: "تنظیم مالی در تاریخ رویداد خالی است" };
      if (!(m.supported_methods as string[]).includes(method!)) return { skip: `gl_deferred:deposit_method:${method}`, note: "حساب‌های این روش (۲۱۰۴/۶۱۰۴) هنوز فعال نیستند" };
      const discountAcc = m.discount[nature!];
      if (!discountAcc || nature === "marketing_expense") return { skip: `gl_deferred:discount_nature:${nature}`, note: "حساب ۶۱۰۳ و ذی‌نفع هنوز فعال نیستند" };
      const credit = tomanToRial(String(payload.credit)), discount = tomanToRial(String(payload.discount)), company = tomanToRial(String(payload.company)), payout = tomanToRial(String(payload.payout));
      if (company + discount !== credit) throw new Error("gl_p7_amounts_inconsistent");
      const plT = pl(db, planId, nowIso), cuT = cu(db, custId, nowIso);
      const lines: GlLineInput[] = [
        { account: m.receivable, tafsiliId: plT, debitRial: company, description: "سهم شرکت" },
        { account: discountAcc, tafsiliId: plT, debitRial: discount, description: "تخفیف توسعه" },
        { account: m.cogs, tafsiliId: plT, debitRial: payout, description: `پرداختی مشتری (پایه ${payload.base_payout ?? "-"} ، کسر کارمزد ${payload.fee_discount ?? "0"} تومان)` },
        { account: m.sales, tafsiliId: plT, creditRial: credit, description: "فروش اعتباری" },
        { account: m.payable, tafsiliId: cuT, creditRial: payout, description: "تعهد پرداخت به مشتری" },
      ].filter((l) => (l.debitRial ?? 0) > 0 || (l.creditRial ?? 0) > 0);
      return { post: { ...base, sourceType: "goods_purchases", sourceId: pid, description: desc(`تسویه‌ی خرید #${pid}`), lines } };
    }
    case "P10": case "P11": case "P12": {
      const g = one<{ kind: string; amount_toman: string; salesperson_id: number | null; id: number }>(db, "SELECT id,kind,amount_toman,salesperson_id FROM goods_finance_ledger WHERE id=?", sid);
      if (!g) throw new Error("gl_source_missing");
      if (!g.salesperson_id) throw new Error("gl_salesperson_missing");
      const neg = String(g.amount_toman).trim().startsWith("-");
      const r = tomanToRial(absToman(g.amount_toman));
      if (r === 0) return { skip: "gl_zero_amount", note: "ردیف صفر" };
      let expense: string = m.expense;
      if (row.event_type === "P12") {
        const meta = one<{ meta_json: string | null }>(db, "SELECT meta_json FROM team_commission_ledger_meta WHERE ledger_id=?", g.id);
        const rk = meta?.meta_json ? (JSON.parse(meta.meta_json).reversedKind as string | undefined) : undefined;
        expense = (rk && m.expense_of[rk]) || m.default_expense;
      }
      const spT = sp(db, g.salesperson_id, nowIso);
      const reverse = row.event_type === "P12" || neg;
      const lines: GlLineInput[] = reverse
        ? [{ account: m.payable, tafsiliId: spT, debitRial: r }, { account: expense, tafsiliId: spT, creditRial: r }]
        : [{ account: expense, tafsiliId: spT, debitRial: r }, { account: m.payable, tafsiliId: spT, creditRial: r }];
      return { post: { ...base, description: desc(`${g.kind}`), lines } };
    }
    case "P8": {
      const d = one<{ fund_id: number; amount_toman: string; transaction_type: string; source: string }>(db, "SELECT fund_id,amount_toman,transaction_type,source FROM accounting_documents WHERE id=?", sid);
      if (!d || d.source !== "payment_order" || d.transaction_type !== "withdrawal") throw new Error("gl_source_missing");
      const oid = Number(payload.order_id);
      const o = one<{ customer_id: number; purchase_id: number | null }>(db, "SELECT customer_id,purchase_id FROM customer_payment_orders WHERE id=?", oid);
      if (!o) throw new Error("gl_source_missing");
      const r = tomanToRial(d.amount_toman);
      return { post: { ...base, sourceType: "customer_payment_orders", sourceId: oid, description: desc(`پرداخت دستور پرداخت #${oid} (r${payload.rev ?? 0})`),
        lines: [{ account: m.dr, tafsiliId: cu(db, o.customer_id, nowIso), debitRial: r, description: o.purchase_id ? `خرید #${o.purchase_id}` : "" }, { account: m.cr, tafsiliId: bk(db, d.fund_id, nowIso), creditRial: r }] } };
    }
    case "P9": {
      const origKey = String(payload.orig_key ?? "");
      const v = one<{ id: number }>(db, "SELECT id FROM gl_vouchers WHERE source_key=?", origKey);
      if (v) return { reverse: { voucherId: v.id, eventDate, reason: `برگشت «پرداخت‌شده‌ی اشتباه» دستور #${payload.order_id}`, sourceKey: row.source_key } };
      const q0 = one<{ status: string; last_error: string | null }>(db, "SELECT status,last_error FROM gl_posting_queue WHERE source_key=?", origKey);
      if (!q0) return { skip: "gl_original_not_captured", note: `سند پرداخت ${origKey} در صف نیست (پیش از روشن شدن پرچم؛ جبران G6)` };
      if (q0.status === "skipped") return { skip: `gl_original_skipped:${q0.last_error ?? "-"}`, note: `سند پرداخت اصلی ثبت نشده بود؛ برگشت هم سند ندارد` };
      throw new Error("gl_original_pending"); // original still pending/failed: retry later
    }
    case "P18":
      return { skip: "gl_deferred:W3:counter_account", note: "سند دستی بانک: حساب مقابل باید در ویزارد W3 انتخاب شود" };
    default:
      throw new Error(`gl_event_unknown:${row.event_type}`);
  }
}

export const GL_QUEUE_MAX_ATTEMPTS = 5;
/** One queued event, in its own IMMEDIATE transaction. Never throws. */
export function processQueueRow(db: DatabaseSync, row: QueueRow, nowIso: string, post: typeof postVoucher = postVoucher): "posted" | "skipped" | "failed" {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("SAVEPOINT gl_post");
    let status: "posted" | "skipped" = "posted", voucherId: number | null = null, note: string | null = null;
    try {
      const b = buildShadowVoucher(db, row, nowIso);
      if ("skip" in b) {
        status = "skipped"; note = b.skip;
        recordGlException(db, row.source_type ?? "gl_posting_queue", row.source_id ?? row.id, b.skip, b.note, nowIso);
      } else if ("reverse" in b) {
        voucherId = reverseVoucher(db, b.reverse.voucherId, { eventDate: b.reverse.eventDate, reason: b.reverse.reason, sourceKey: b.reverse.sourceKey, nowIso }).voucherId;
      } else voucherId = post(db, b.post).voucherId;
      db.exec("RELEASE gl_post");
    } catch (e) {
      db.exec("ROLLBACK TO gl_post"); db.exec("RELEASE gl_post");
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      const attempts = row.attempts + 1;
      const next = attempts >= GL_QUEUE_MAX_ATTEMPTS ? null : new Date(Date.parse(nowIso) + 60000 * 2 ** attempts).toISOString();
      db.prepare("UPDATE gl_posting_queue SET status='failed', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?").run(attempts, msg, next, nowIso, row.id);
      db.exec("COMMIT");
      return "failed";
    }
    db.prepare("UPDATE gl_posting_queue SET status=?, attempts=attempts+1, last_error=?, voucher_id=?, next_attempt_at=NULL, updated_at=? WHERE id=?").run(status, note, voucherId, nowIso, row.id);
    db.exec("COMMIT");
    return status;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    return "failed";
  }
}

const flagOn = (db: DatabaseSync, key: string) => one<{ value: string }>(db, "SELECT value FROM gl_settings WHERE key=?", key)?.value === "1";
/** Drains due queue rows. Non-bank events only while gl.shadow_nonbank = '1', bank events only while gl.shadow_bank = '1'; null when both OFF. */
export function processGlShadowQueue(db: DatabaseSync, opts: { limit?: number; nowIso?: string; events?: string[]; post?: typeof postVoucher } = {}): { posted: number; skipped: number; failed: number } | null {
  const allowed = [...(flagOn(db, "gl.shadow_nonbank") ? GL_NONBANK_EVENTS : []), ...(flagOn(db, "gl.shadow_bank") ? GL_BANK_EVENTS : [])];
  if (!allowed.length) return null;
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) return null; // never inside a caller's transaction
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const events = (opts.events ?? allowed).filter((e) => allowed.includes(e));
  if (!events.length) return { posted: 0, skipped: 0, failed: 0 };
  const rows = db.prepare(`SELECT id,source_key,event_type,source_type,source_id,payload_json,attempts FROM gl_posting_queue
    WHERE event_type IN (${events.map(() => "?").join(",")}) AND (status='pending' OR (status='failed' AND attempts<? AND next_attempt_at IS NOT NULL AND next_attempt_at<=?))
    ORDER BY id LIMIT ?`).all(...events, GL_QUEUE_MAX_ATTEMPTS, nowIso, opts.limit ?? 50) as QueueRow[];
  const out = { posted: 0, skipped: 0, failed: 0 };
  for (const r of rows) out[processQueueRow(db, r, nowIso, opts.post)]++;
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Inert unless gl.shadow_nonbank or gl.shadow_bank is ON (checked every tick). Never throws. */
export function startGlShadowWorker(db: DatabaseSync, log: { error: (o: unknown, m: string) => void }, everyMs = 60000): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      if (!flagOn(db, "gl.shadow_nonbank") && !flagOn(db, "gl.shadow_bank")) return;
      ensureGlShadowSchema(db); // tables created lazily after start get their capture trigger
      processGlShadowQueue(db);
    } catch (err) { log.error({ err }, "gl shadow worker tick failed"); }
  }, everyMs);
  timer.unref?.();
}
