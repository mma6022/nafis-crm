/**
 * General ledger — package G5 (2026-10-27): REPORTS + NIGHTLY COMPARE (read-only).
 *
 * - Every report reads SEALED vouchers only (JOIN gl_voucher_seals). Amounts are integer rial; the page shows toman.
 * - Memo accounts (kol 81) are listed apart and never enter the trial-balance totals.
 * - Reports sit behind gl.reports (OFF); the nightly compare behind gl.nightly_compare (OFF). Flags change only by a release.
 * - The nightly compare only REPORTS: it never fixes data, never posts, never notifies a customer. It writes one row per
 *   Tehran day into gl_reconciliation_runs (append-only). An internal manager notification is deferred (no gl_* source in
 *   site notifications).
 * - Compares (ACCOUNTING-DESIGN §5-4): 4 wallets vs 2201 (8101 deferred: Q7), 5 plan wallets vs 1201 and the company cash
 *   wallet vs 4103, 6 salespersons vs 2102, 7 payment orders vs 2101, 9 Zarinpal vs 1103. Report 8 (bank) is G10.
 */
import type { DatabaseSync } from "node:sqlite";
import { financeSettingAsOf } from "./ledger";
import { openingBaseDate, opening2101Check, openingApprovalReadiness, tehranDateOf, tomanToRial } from "./gl-posting";

export const GL_REPORTS_MIGRATION = "general-ledger-g5-reports";
export const GL_REPORTS_DDL = `
CREATE TABLE IF NOT EXISTS gl_reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL UNIQUE CHECK(run_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  trigger_kind TEXT NOT NULL DEFAULT 'nightly' CHECK(trigger_kind IN ('nightly')),
  status TEXT NOT NULL CHECK(status IN ('ok','mismatch','not_started','error')),
  mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK(mismatch_count >= 0),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS gl_recon_runs_no_update BEFORE UPDATE ON gl_reconciliation_runs BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_recon_runs_no_delete BEFORE DELETE ON gl_reconciliation_runs BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
`;

/** Idempotent, additive. Call after ensureLedgerSchema. */
export function ensureGlReportsSchema(db: DatabaseSync, nowIso: string = new Date().toISOString()): void {
  db.exec("SAVEPOINT gl_reports_ensure");
  try {
    db.exec(GL_REPORTS_DDL);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(GL_REPORTS_MIGRATION, nowIso);
    db.exec("RELEASE gl_reports_ensure");
  } catch (e) { db.exec("ROLLBACK TO gl_reports_ensure"); db.exec("RELEASE gl_reports_ensure"); throw e; }
}

const one = <T>(db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
const all = <T>(db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];
const hasTable = (db: DatabaseSync, t: string) => !!one(db, "SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", t);
export const glFlagOn = (db: DatabaseSync, key: string) => {
  try { return one<{ value: string }>(db, "SELECT value FROM gl_settings WHERE key=?", key)?.value === "1"; } catch { return false; }
};

/** Sealed lines only, with their voucher date. */
const SEALED = `FROM gl_voucher_lines l JOIN gl_vouchers v ON v.id=l.voucher_id JOIN gl_voucher_seals s ON s.voucher_id=v.id JOIN gl_accounts a ON a.id=l.account_id`;

export type TbLevel = "kol" | "moein" | "tafsili";
export type TbRow = { key: string; code: string; title: string; kol: string; tafsiliId: number | null; tafsiliCode: string | null; tafsiliTitle: string | null;
  memo: boolean; openDr: number; openCr: number; dr: number; cr: number; balDr: number; balCr: number };
export function trialBalance(db: DatabaseSync, q: { from: string; to: string; level: TbLevel }) {
  const grp = q.level === "kol" ? "substr(a.code,1,2)" : q.level === "moein" ? "a.code" : "a.code, l.tafsili_id";
  const rows = all<any>(db, `SELECT ${q.level === "kol" ? "substr(a.code,1,2)" : "a.code"} code, ${q.level === "tafsili" ? "l.tafsili_id" : "NULL"} tafsili_id,
      SUM(CASE WHEN v.event_date < ? THEN l.debit_rial ELSE 0 END) od, SUM(CASE WHEN v.event_date < ? THEN l.credit_rial ELSE 0 END) oc,
      SUM(CASE WHEN v.event_date >= ? THEN l.debit_rial ELSE 0 END) d, SUM(CASE WHEN v.event_date >= ? THEN l.credit_rial ELSE 0 END) c
    ${SEALED} WHERE v.event_date <= ? GROUP BY ${grp} ORDER BY 1, 2`, q.from, q.from, q.from, q.from, q.to);
  const titles = new Map(all<{ code: string; title: string }>(db, "SELECT code,title FROM gl_accounts").map((r) => [r.code, r.title]));
  const tf = new Map(all<{ id: number; code: string; title: string }>(db, "SELECT id,code,title FROM gl_tafsili").map((r) => [r.id, r]));
  const out: TbRow[] = rows.map((r) => {
    const net = r.od + r.d - r.oc - r.c; const t = r.tafsili_id ? tf.get(r.tafsili_id) : undefined;
    return { key: `${r.code}:${r.tafsili_id ?? ""}`, code: r.code, title: titles.get(r.code) ?? r.code, kol: String(r.code).slice(0, 2), tafsiliId: r.tafsili_id ?? null,
      tafsiliCode: t?.code ?? null, tafsiliTitle: t?.title ?? null, memo: String(r.code).startsWith("81"),
      openDr: r.od, openCr: r.oc, dr: r.d, cr: r.c, balDr: net > 0 ? net : 0, balCr: net < 0 ? -net : 0 };
  });
  const sum = (rs: TbRow[]) => rs.reduce((s, r) => ({ openDr: s.openDr + r.openDr, openCr: s.openCr + r.openCr, dr: s.dr + r.dr, cr: s.cr + r.cr, balDr: s.balDr + r.balDr, balCr: s.balCr + r.balCr }),
    { openDr: 0, openCr: 0, dr: 0, cr: 0, balDr: 0, balCr: 0 });
  const main = out.filter((r) => !r.memo), memo = out.filter((r) => r.memo);
  const totals = sum(main);
  return { level: q.level, from: q.from, to: q.to, rows: main, memoRows: memo, totals, memoTotals: sum(memo),
    balanced: totals.dr === totals.cr && totals.openDr === totals.openCr && totals.balDr === totals.balCr };
}

export function journal(db: DatabaseSync, q: { from: string; to: string; page: number; limit: number }) {
  const total = one<{ n: number }>(db, "SELECT COUNT(*) n FROM gl_vouchers v JOIN gl_voucher_seals s ON s.voucher_id=v.id WHERE v.event_date BETWEEN ? AND ?", q.from, q.to)!.n;
  const vs = all<any>(db, `SELECT v.id,v.ref_no,v.temp_no,v.final_period,v.final_seq,v.event_date,v.kind,v.description,v.source_type,v.source_id,v.reverses_voucher_id,v.total_rial,
      (SELECT r.id FROM gl_vouchers r WHERE r.reverses_voucher_id=v.id) reversed_by
    FROM gl_vouchers v JOIN gl_voucher_seals s ON s.voucher_id=v.id WHERE v.event_date BETWEEN ? AND ? ORDER BY v.event_date, v.fiscal_year_id, v.temp_no LIMIT ? OFFSET ?`,
  q.from, q.to, q.limit, (q.page - 1) * q.limit);
  const lines = vs.length ? all<any>(db, `SELECT l.voucher_id,l.line_no,a.code,a.title,t.code tcode,t.title ttitle,l.debit_rial,l.credit_rial,l.description
    FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id LEFT JOIN gl_tafsili t ON t.id=l.tafsili_id
    WHERE l.voucher_id IN (${vs.map(() => "?").join(",")}) ORDER BY l.voucher_id,l.line_no`, ...vs.map((v) => v.id)) : [];
  return { total, page: q.page, limit: q.limit, items: vs.map((v) => ({
    id: v.id, refNo: v.ref_no, tempNo: v.temp_no, finalNo: v.final_seq ? { period: v.final_period, seq: v.final_seq } : null, eventDate: v.event_date, kind: v.kind,
    description: v.description, sourceType: v.source_type, sourceId: v.source_id, reversesVoucherId: v.reverses_voucher_id, reversedByVoucherId: v.reversed_by ?? null, totalRial: v.total_rial,
    lines: lines.filter((l) => l.voucher_id === v.id).map((l) => ({ lineNo: l.line_no, code: l.code, title: l.title, tafsiliCode: l.tcode, tafsiliTitle: l.ttitle, debitRial: l.debit_rial, creditRial: l.credit_rial, description: l.description })),
  })) };
}

export function accountList(db: DatabaseSync) {
  return {
    accounts: all<any>(db, "SELECT code,title,level,nature,tafsili_types,postable,active FROM gl_accounts ORDER BY code").map((a) => ({ code: a.code, title: a.title, level: a.level, nature: a.nature, tafsiliTypes: a.tafsili_types, postable: !!a.postable, active: !!a.active })),
    tafsili: all<any>(db, `SELECT DISTINCT t.id,t.type,t.code,t.title,a.code account FROM gl_tafsili t JOIN gl_voucher_lines l ON l.tafsili_id=t.id JOIN gl_accounts a ON a.id=l.account_id ORDER BY a.code,t.code LIMIT 5000`)
      .map((t) => ({ id: t.id, type: t.type, code: t.code, title: t.title, account: t.account })),
  };
}

/** GL / sub-ledger of one account (moein code, or a kol code) with an opening balance and a running balance (dr - cr). */
export function accountLedger(db: DatabaseSync, q: { code: string; tafsiliId: number | null; from: string; to: string; page: number; limit: number }) {
  const acc = one<{ code: string; title: string; level: string; nature: string }>(db, "SELECT code,title,level,nature FROM gl_accounts WHERE code=?", q.code);
  if (!acc) return null;
  const match = acc.level === "kol" ? "substr(a.code,1,2)=?" : "a.code=?";
  const tf = q.tafsiliId === null ? "" : " AND l.tafsili_id=?";
  const args = q.tafsiliId === null ? [q.code] : [q.code, q.tafsiliId];
  const open = one<{ d: number; c: number }>(db, `SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED} WHERE ${match}${tf} AND v.event_date < ?`, ...args, q.from)!;
  const opening = open.d - open.c;
  const total = one<{ n: number }>(db, `SELECT COUNT(*) n ${SEALED} WHERE ${match}${tf} AND v.event_date BETWEEN ? AND ?`, ...args, q.from, q.to)!.n;
  const rows = all<any>(db, `SELECT * FROM (SELECT v.id voucher_id,v.ref_no,v.temp_no,v.event_date,v.kind,v.description vdesc,l.line_no,a.code,t.code tcode,t.title ttitle,l.debit_rial,l.credit_rial,l.description,
        ? + SUM(l.debit_rial - l.credit_rial) OVER (ORDER BY v.event_date, v.fiscal_year_id, v.temp_no, l.line_no ROWS UNBOUNDED PRECEDING) running
      ${SEALED} LEFT JOIN gl_tafsili t ON t.id=l.tafsili_id WHERE ${match}${tf} AND v.event_date BETWEEN ? AND ?)
    ORDER BY event_date, temp_no, line_no LIMIT ? OFFSET ?`, opening, ...args, q.from, q.to, q.limit, (q.page - 1) * q.limit);
  const tot = one<{ d: number; c: number }>(db, `SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED} WHERE ${match}${tf} AND v.event_date BETWEEN ? AND ?`, ...args, q.from, q.to)!;
  const t = q.tafsiliId === null ? null : one<{ id: number; code: string; title: string }>(db, "SELECT id,code,title FROM gl_tafsili WHERE id=?", q.tafsiliId) ?? null;
  return { account: acc, tafsili: t, from: q.from, to: q.to, openingRial: opening, debitRial: tot.d, creditRial: tot.c, closingRial: opening + tot.d - tot.c,
    total, page: q.page, limit: q.limit,
    items: rows.map((r) => ({ voucherId: r.voucher_id, refNo: r.ref_no, tempNo: r.temp_no, eventDate: r.event_date, kind: r.kind, description: r.description || r.vdesc, code: r.code,
      tafsiliCode: r.tcode, tafsiliTitle: r.ttitle, debitRial: r.debit_rial, creditRial: r.credit_rial, runningRial: r.running })) };
}

/** The posting queue and the exceptions ledger (W9). Read-only; retry stays manager-only and is not part of G5. */
export function postingQueue(db: DatabaseSync) {
  const counts = Object.fromEntries(all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) n FROM gl_posting_queue GROUP BY status").map((r) => [r.status, r.n]));
  const items = all<any>(db, `SELECT id,source_key,event_type,source_type,source_id,status,attempts,next_attempt_at,last_error,voucher_id,created_at,updated_at
    FROM gl_posting_queue WHERE status IN ('pending','failed') ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END, id LIMIT 200`)
    .map((r) => ({ id: r.id, sourceKey: r.source_key, eventType: r.event_type, sourceType: r.source_type, sourceId: r.source_id, status: r.status, attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at }));
  const skipped = all<{ code: string; n: number }>(db, "SELECT COALESCE(last_error,'-') code, COUNT(*) n FROM gl_posting_queue WHERE status='skipped' GROUP BY 1 ORDER BY 2 DESC LIMIT 50");
  const exceptions = all<{ code: string; n: number }>(db, "SELECT code, COUNT(*) n FROM gl_exceptions GROUP BY code ORDER BY n DESC LIMIT 50");
  return { counts: { pending: counts.pending ?? 0, failed: counts.failed ?? 0, posted: counts.posted ?? 0, skipped: counts.skipped ?? 0 }, items, skipped, exceptions };
}

/* ------------------------------------------------------------------ reconciliation (reports 4, 5, 6, 7, 9) */

export type RecRow = { ref: string; refId: number | null; label: string; glRial: number; systemRial: number; diffRial: number };
export type RecSection = { key: string; title: string; description: string; status: "ok" | "mismatch" | "deferred"; deferred?: string;
  mismatchCount: number; checked: number; glTotalRial: number; systemTotalRial: number; rows: RecRow[]; notes: string[] };
const toRial = (v: unknown) => { try { return tomanToRial(String(v ?? "0")); } catch { return 0; } };

/** GL balance per tafsili ref_id of one type on one account (sign: debit-nature => dr-cr, credit-nature => cr-dr). */
function glByRef(db: DatabaseSync, account: string, type: string, sign: 1 | -1, to: string): { byRef: Map<number, number>; untagged: number } {
  const byRef = new Map<number, number>(); let untagged = 0;
  for (const r of all<{ ref_id: number | null; d: number; c: number }>(db, `SELECT t.ref_id, SUM(l.debit_rial) d, SUM(l.credit_rial) c ${SEALED}
      LEFT JOIN gl_tafsili t ON t.id=l.tafsili_id AND t.type=? WHERE a.code=? AND v.event_date <= ? GROUP BY t.ref_id`, type, account, to)) {
    const b = sign * (r.d - r.c);
    if (r.ref_id === null) untagged += b; else byRef.set(r.ref_id, b);
  }
  return { byRef, untagged };
}
function section(key: string, title: string, description: string, sys: Map<number, number>, gl: { byRef: Map<number, number>; untagged: number }, label: (id: number) => string, refPrefix: string, notes: string[] = []): RecSection {
  const ids = new Set([...sys.keys(), ...gl.byRef.keys()]);
  const rows: RecRow[] = [];
  let glTotal = gl.untagged, sysTotal = 0;
  for (const id of [...ids].sort((a, b) => a - b)) {
    const s = sys.get(id) ?? 0, g = gl.byRef.get(id) ?? 0; glTotal += g; sysTotal += s;
    if (s !== g) rows.push({ ref: `${refPrefix}-${id}`, refId: id, label: label(id), glRial: g, systemRial: s, diffRial: g - s });
  }
  if (gl.untagged !== 0) rows.push({ ref: `${refPrefix}-?`, refId: null, label: "بدون تفصیلی", glRial: gl.untagged, systemRial: 0, diffRial: gl.untagged });
  return { key, title, description, status: rows.length ? "mismatch" : "ok", mismatchCount: rows.length, checked: ids.size, glTotalRial: glTotal, systemTotalRial: sysTotal, rows: rows.slice(0, 200), notes };
}
const nameMap = (db: DatabaseSync, sql: string) => { try { return new Map(all<{ id: number; name: string }>(db, sql).map((r) => [r.id, r.name])); } catch { return new Map<number, string>(); } };

export type Reconciliation = { state: "not_started"; reason: string } | { state: "ready"; asOf: string; ledgerStartDate: string; mismatchCount: number; sections: RecSection[]; queueOpen: number };
export function reconcile(db: DatabaseSync, asOf: string): Reconciliation {
  const start = financeSettingAsOf(db, "gl.ledger_start_date", asOf);
  if (!start) return { state: "not_started", reason: "finance_setting_missing:gl.ledger_start_date" };
  if (!one(db, "SELECT 1 x FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date", asOf)) return { state: "not_started", reason: "gl_no_fiscal_year" };
  const sections: RecSection[] = [];
  const customers = nameMap(db, "SELECT id, name FROM customers");
  const cuLabel = (id: number) => `${customers.get(id) ?? "مشتری"} #${id}`;
  // 4. customer wallets
  if (hasTable(db, "wallet_accounts_v2")) {
    const cash = new Map<number, number>();
    for (const w of all<{ customer_id: number; balance: string }>(db, "SELECT customer_id, balance FROM wallet_accounts_v2 WHERE wallet_type='cash'")) cash.set(w.customer_id, (cash.get(w.customer_id) ?? 0) + toRial(w.balance));
    for (const [k, v] of cash) if (v === 0) cash.delete(k);
    sections.push(section("wallet_cash", "کیف نقدی مشتریان", "۲۲۰۱ به تفکیک مشتری با ماندهٔ کیف نقدی", cash, glByRef(db, "2201", "CU", -1, asOf), cuLabel, "CU"));
    sections.push({ key: "wallet_credit", title: "کیف اعتباری مشتریان", description: "۸۱۰۱ به تفکیک مشتری با ماندهٔ کیف اعتباری", status: "deferred", deferred: "Q7",
      mismatchCount: 0, checked: 0, glTotalRial: 0, systemTotalRial: 0, rows: [], notes: ["سندهای انتظامی ۸۱۰۱/۸۱۰۲ منتظر پاسخ Q7 است؛ این مقایسه بعد از آن روشن می‌شود."] });
  }
  // 5. plan (company share) wallets vs 1201 and the company cash wallet vs 4103
  if (hasTable(db, "goods_company_wallets")) {
    const plans = nameMap(db, "SELECT id, name FROM loan_plans");
    const sys = new Map<number, number>();
    for (const w of all<{ plan_id: number; balance_toman: string }>(db, "SELECT plan_id, balance_toman FROM goods_company_wallets")) { const r = toRial(w.balance_toman); if (r !== 0) sys.set(w.plan_id, r); }
    sections.push(section("plans", "طرح‌ها", "۱۲۰۱ هر طرح با سهم شرکت طرح", sys, glByRef(db, "1201", "PL", 1, asOf), (id) => `${plans.get(id) ?? "طرح"} #${id}`, "PL",
      ["دریافت از تأمین‌کننده (W6) هنوز ثبت نمی‌شود؛ سهم شرکت تا آن زمان کامل در ۱۲۰۱ می‌ماند."]));
  }
  if (hasTable(db, "company_wallet_accounts")) {
    const cw = toRial(one<{ balance: string }>(db, "SELECT balance FROM company_wallet_accounts WHERE wallet_type='cash'")?.balance ?? "0");
    const g = one<{ d: number; c: number }>(db, `SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED} WHERE a.code='4103' AND v.event_date <= ?`, asOf)!;
    const gl = g.c - g.d;
    sections.push({ key: "company_fee", title: "کیف نقدی شرکت", description: "۴۱۰۳ (درآمد هزینهٔ تشکیل پرونده) با ماندهٔ کیف نقدی شرکت", status: gl === cw ? "ok" : "mismatch", mismatchCount: gl === cw ? 0 : 1, checked: 1,
      glTotalRial: gl, systemTotalRial: cw, rows: gl === cw ? [] : [{ ref: "company-cash", refId: null, label: "کیف نقدی شرکت", glRial: gl, systemRial: cw, diffRial: gl - cw }],
      notes: ["واریز/برداشت دستی کیف شرکت در نگاشت فعلی سند ندارد و اگر باشد این‌جا اختلاف نشان می‌دهد."] });
  }
  // 6. salesperson wallets vs 2102
  if (hasTable(db, "goods_salesperson_wallets")) {
    const sps = nameMap(db, "SELECT id, name FROM salespersons");
    const sys = new Map<number, number>();
    for (const w of all<{ salesperson_id: number; balance_toman: string }>(db, "SELECT salesperson_id, balance_toman FROM goods_salesperson_wallets")) { const r = toRial(w.balance_toman); if (r !== 0) sys.set(w.salesperson_id, r); }
    sections.push(section("salespersons", "فروشنده‌ها", "۲۱۰۲ هر فروشنده با کیف فروشنده", sys, glByRef(db, "2102", "SP", -1, asOf), (id) => `${sps.get(id) ?? "فروشنده"} #${id}`, "SP"));
  }
  // 7. payment orders vs 2101 (control total; the opening voucher holds 2101 as one control line)
  if (hasTable(db, "customer_payment_orders") && hasTable(db, "goods_purchases")) {
    const prior = hasTable(db, "payment_order_prior_payments");
    const open = all<{ id: number; customer_id: number; amount_toman: string }>(db, `SELECT o.id, o.customer_id, o.amount_toman FROM customer_payment_orders o
      WHERE o.stage <> 'paid'${prior ? ` AND NOT EXISTS (SELECT 1 FROM payment_order_prior_payments p WHERE p.payment_order_id=o.id AND p.pre_start=1
        AND NOT EXISTS (SELECT 1 FROM payment_order_prior_payment_voids x WHERE x.prior_payment_id=p.id))` : ""}`);
    const noOrder = all<{ id: number; customer_id: number; payout_amount_toman: string }>(db, `SELECT p.id, p.customer_id, p.payout_amount_toman FROM goods_purchases p
      WHERE p.stage='completed' AND NOT EXISTS (SELECT 1 FROM customer_payment_orders o WHERE o.purchase_id=p.id)`);
    const sysTotal = open.reduce((s, o) => s + toRial(o.amount_toman), 0) + noOrder.reduce((s, p) => s + toRial(p.payout_amount_toman), 0);
    const g = one<{ d: number; c: number }>(db, `SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED} WHERE a.code='2101' AND v.event_date <= ?`, asOf)!;
    const gl = g.c - g.d;
    const rows: RecRow[] = gl === sysTotal ? [] : [{ ref: "2101", refId: null, label: "جمع ۲۱۰۱", glRial: gl, systemRial: sysTotal, diffRial: gl - sysTotal }];
    for (const p of noOrder) rows.push({ ref: `GP-${p.id}`, refId: p.id, label: `خرید #${p.id} بدون دستور پرداخت (${cuLabel(p.customer_id)})`, glRial: 0, systemRial: toRial(p.payout_amount_toman), diffRial: 0 });
    sections.push({ key: "payment_orders", title: "دستورهای پرداخت", description: "۲۱۰۱ با خریدهای تسویه‌شدهٔ پرداخت‌نشده", status: rows.length ? "mismatch" : "ok", mismatchCount: rows.length,
      checked: open.length + noOrder.length, glTotalRial: gl, systemTotalRial: sysTotal, rows, notes: ["خرید تسویه‌شده بدون دستور پرداخت جدا فهرست می‌شود (بدون اصلاح خودکار)."] });
  }
  // 9. Zarinpal vs 1103
  if (hasTable(db, "wallet_payment_intents")) {
    const credited = one<{ s: number | null; n: number }>(db, "SELECT SUM(CAST(amount_rial AS INTEGER)) s, COUNT(*) n FROM wallet_payment_intents WHERE status='credited'")!;
    const stale = one<{ n: number }>(db, "SELECT COUNT(*) n FROM wallet_payment_intents WHERE status='verification_pending' AND created_at < ?", new Date(Date.parse(`${asOf}T00:00:00+03:30`) - 86400000).toISOString())!.n;
    const g = one<{ d: number; c: number }>(db, `SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED} WHERE a.code='1103' AND v.event_date <= ?`, asOf)!;
    const gl = g.d - g.c, sys = credited.s ?? 0;
    const rows: RecRow[] = gl === sys ? [] : [{ ref: "1103", refId: null, label: "درگاه زرین‌پال", glRial: gl, systemRial: sys, diffRial: gl - sys }];
    sections.push({ key: "zarinpal", title: "زرین‌پال", description: "۱۱۰۳ با پرداخت‌های تأییدشدهٔ تسویه‌نشده", status: rows.length ? "mismatch" : "ok", mismatchCount: rows.length + (stale ? 1 : 0),
      checked: credited.n, glTotalRial: gl, systemTotalRial: sys, rows, notes: ["تسویهٔ درگاه (W7) هنوز ثبت نمی‌شود؛ تا آن زمان همهٔ پرداخت‌های تأییدشده تسویه‌نشده حساب می‌شوند.",
        ...(stale ? [`${stale} پرداخت بیش از ۲۴ ساعت در انتظار تأیید مانده است.`] : [])] });
  }
  const queueOpen = one<{ n: number }>(db, "SELECT COUNT(*) n FROM gl_posting_queue WHERE status IN ('pending','failed')")!.n;
  return { state: "ready", asOf, ledgerStartDate: start, mismatchCount: sections.reduce((s, x) => s + x.mismatchCount, 0), sections, queueOpen };
}

/** Header facts for the page: flags (read-only), dates from settings, opening status and the 2101 warning (scenes 134-136). */
export function ledgerStatus(db: DatabaseSync, today: string) {
  const flags = Object.fromEntries(all<{ key: string; value: string }>(db, "SELECT key,value FROM gl_settings WHERE key LIKE 'gl.%' ORDER BY key").map((r) => [r.key, r.value === "1"]));
  const base = openingBaseDate(db, today);
  const fiscal = all<any>(db, "SELECT id,title,start_date,end_date,status,locked_until FROM gl_fiscal_years ORDER BY start_date")
    .map((f) => ({ id: f.id, title: f.title, startDate: f.start_date, endDate: f.end_date, status: f.status, lockedUntil: f.locked_until }));
  const set = one<{ id: number; as_of_date: string; approved_by_user_id: number | null; voucher_id: number | null; prior_payments_confirmed_at: string | null }>(db,
    `SELECT s.id,s.as_of_date,s.approved_by_user_id,s.voucher_id,s.prior_payments_confirmed_at FROM gl_opening_balance_sets s
     WHERE NOT EXISTS (SELECT 1 FROM gl_opening_balance_sets n WHERE n.supersedes_set_id=s.id) ORDER BY s.id DESC LIMIT 1`);
  let opening: Record<string, unknown> = { state: "none" };
  if (set) {
    const r = openingApprovalReadiness(db, set.id, null, today);
    opening = { state: set.voucher_id ? "posted" : "draft", setId: set.id, asOfDate: set.as_of_date, step4Done: !!set.prior_payments_confirmed_at,
      approvalLocked: !set.voucher_id && !r.ok, lockReasons: set.voucher_id ? [] : r.reasons, check2101: r.check2101 };
  } else if (base.ok && hasTable(db, "customer_payment_orders")) opening = { state: "none", check2101: opening2101Check(db, null, base.baseDate) };
  const c = one<{ v: number; q: number; f: number }>(db, `SELECT (SELECT COUNT(*) FROM gl_vouchers) v, (SELECT COUNT(*) FROM gl_posting_queue WHERE status='pending') q,
    (SELECT COUNT(*) FROM gl_posting_queue WHERE status='failed') f`)!;
  const last = hasTable(db, "gl_reconciliation_runs") ? one<any>(db, "SELECT run_date,status,mismatch_count,finished_at FROM gl_reconciliation_runs ORDER BY run_date DESC LIMIT 1") : undefined;
  return { today, flags, ledgerStartDate: base.ledgerStartDate, baseDate: base.baseDate, baseOk: base.ok, baseError: base.ok ? null : base.code, fiscalYears: fiscal, opening,
    vouchers: c.v, queuePending: c.q, queueFailed: c.f, financeRoles: financeRoles(db),
    lastRun: last ? { runDate: last.run_date, status: last.status, mismatchCount: last.mismatch_count, finishedAt: last.finished_at } : null };
}

/* ------------------------------------------------------------------ G6c: finance roles (two-person rule) */
export const GL_FINANCE_TRAINEE_SALESPERSON_IDS = [5, 19, 20]; // same as MANAGER_TRAINEE_SALESPERSON_IDS: trainees never get a finance role
export const GL_FINANCE_EXCLUDED_USER_IDS = [29]; // never listed
const ROLE_ACC = "gl_accountant", ROLE_APR = "gl_voucher_approver";
type FinUser = { id: number; role: string };
function eligibleFinanceUsers(db: DatabaseSync): FinUser[] {
  if (!hasTable(db, "users")) return [];
  const cols = all<{ name: string }>(db, "PRAGMA table_info(users)").map((c) => c.name);
  const sp = cols.includes("salesperson_id") ? "salesperson_id" : "NULL";
  return all<{ id: number; role: string; sp: number | null }>(db, `SELECT id, role, ${sp} sp FROM users WHERE active=1 AND role IN ('admin','${ROLE_ACC}','${ROLE_APR}')`)
    .filter((u) => !GL_FINANCE_EXCLUDED_USER_IDS.includes(Number(u.id)) && !(u.sp != null && GL_FINANCE_TRAINEE_SALESPERSON_IDS.includes(Number(u.sp))))
    .map((u) => ({ id: Number(u.id), role: u.role }));
}
/** Who can draft (admin / gl_accountant) and who can approve (admin / gl_voucher_approver) a manual voucher; solo = no distinct pair. */
export function financeRoles(db: DatabaseSync) {
  const users = eligibleFinanceUsers(db);
  const creators = users.filter((u) => u.role === "admin" || u.role === ROLE_ACC).map((u) => u.id);
  const approvers = users.filter((u) => u.role === "admin" || u.role === ROLE_APR).map((u) => u.id);
  const pair = creators.some((c) => approvers.some((a) => a !== c));
  const assigned = { accountants: users.filter((u) => u.role === ROLE_ACC).length, approvers: users.filter((u) => u.role === ROLE_APR).length };
  const financeUsers = new Set([...creators, ...approvers]).size;
  return { assigned, creators: creators.length, approvers: approvers.length, financeUsers, twoPersonOk: pair, solo: !pair,
    noAssigned: assigned.accountants === 0 && assigned.approvers === 0 };
}
/** Server-side two-person check for a manual voucher (DB CHECKs are the last word). Throws a code; never logs a name. */
export function assertManualVoucherApprover(db: DatabaseSync, approver: { id: number; role: string; permissions?: string[] }, createdByUserId: number): void {
  if (approver.role !== "admin" && !(approver.permissions ?? []).includes("gl.manual_voucher.approve")) throw new Error("gl_approver_forbidden");
  if (Number(approver.id) === Number(createdByUserId)) throw new Error("gl_approver_is_creator");
  if (!eligibleFinanceUsers(db).some((u) => u.id === Number(approver.id))) throw new Error("gl_approver_not_eligible");
}

/* ------------------------------------------------------------------ G6c / N2: commission totals per seller (read-only) */
const COMMISSION_KINDS_N2 = ["salesperson_commission", "p1_referral_share", "data_accuracy_bonus", "returned_case_deduction", "paid_mark_reversal", "team_bonus"];
const NEUTRALIZED_N2 = "EXISTS (SELECT 1 FROM team_commission_ledger_meta r WHERE r.kind='paid_mark_reversal' AND CAST(json_extract(r.meta_json,'$.reversedLedgerId') AS INTEGER)=l.id)";
/**
 * One row per seller: name only (no mobile), number of cases, registered commission (system ledger; a neutralized row and its paid_mark_reversal both out, as in staff-wallet: same net as v1.3),
 * payable (seller wallet) and the ledger side (6101 / 2102 by SP tafsili, sealed vouchers). No per-case amounts, no actions.
 * «پرداخت‌شده» is not recorded in the system yet: returned as null, never guessed.
 */
export function commissionTotals(db: DatabaseSync, asOf: string) {
  if (!hasTable(db, "goods_finance_ledger") || !hasTable(db, "salespersons")) return { asOf, rows: [], totals: { cases: 0, registeredRial: 0, payableRial: 0, glExpenseRial: 0, glPayableRial: 0 }, paidTracked: false };
  const meta = hasTable(db, "team_commission_ledger_meta");
  const reg = all<{ sp: number; cases: number; amt: string }>(db, `SELECT l.salesperson_id sp, COUNT(DISTINCT l.purchase_id) cases,
      CAST(COALESCE(SUM(CAST(l.amount_toman AS INTEGER)),0) AS TEXT) amt FROM goods_finance_ledger l
    WHERE l.salesperson_id IS NOT NULL AND l.kind IN (${COMMISSION_KINDS_N2.map(() => "?").join(",")})${meta ? ` AND NOT ${NEUTRALIZED_N2}` : ""} AND l.kind<>'paid_mark_reversal' GROUP BY l.salesperson_id`, ...COMMISSION_KINDS_N2);
  const wal = new Map<number, number>();
  if (hasTable(db, "goods_salesperson_wallets")) for (const w of all<{ salesperson_id: number; balance_toman: string }>(db, "SELECT salesperson_id, balance_toman FROM goods_salesperson_wallets")) wal.set(Number(w.salesperson_id), toRial(w.balance_toman));
  const gl = (code: string, sign: 1 | -1) => new Map(all<{ ref: number; d: number; c: number }>(db, `SELECT t.ref_id ref, COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c ${SEALED}
      JOIN gl_tafsili t ON t.id=l.tafsili_id WHERE a.code=? AND t.type='SP' AND v.event_date <= ? GROUP BY t.ref_id`, code, asOf).map((r) => [Number(r.ref), sign * (r.d - r.c)]));
  const exp = gl("6101", 1), pay = gl("2102", -1);
  const names = nameMap(db, "SELECT id, name FROM salespersons");
  const ids = new Set<number>([...reg.map((r) => Number(r.sp)), ...[...wal.entries()].filter(([, v]) => v !== 0).map(([k]) => k), ...exp.keys(), ...pay.keys()]);
  const regMap = new Map(reg.map((r) => [Number(r.sp), r]));
  const rows = [...ids].sort((a, b) => a - b).map((id) => ({ salespersonId: id, name: names.get(id) ?? `فروشنده #${id}`, cases: Number(regMap.get(id)?.cases ?? 0),
    registeredRial: toRial(regMap.get(id)?.amt ?? "0"), paidRial: null as number | null, payableRial: wal.get(id) ?? 0, glExpenseRial: exp.get(id) ?? 0, glPayableRial: pay.get(id) ?? 0 }));
  const sum = (k: "cases" | "registeredRial" | "payableRial" | "glExpenseRial" | "glPayableRial") => rows.reduce((s, r) => s + r[k], 0);
  return { asOf, rows, totals: { cases: sum("cases"), registeredRial: sum("registeredRial"), payableRial: sum("payableRial"), glExpenseRial: sum("glExpenseRial"), glPayableRial: sum("glPayableRial") }, paidTracked: false };
}

/* ------------------------------------------------------------------ nightly compare (report only) */
export const NIGHTLY_HOUR_TEHRAN = 2; // well after the 00:01 backup
const tehranHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", hour12: false }).format(d)) % 24;

/** One run for the Tehran date of `now` (idempotent per day). Returns null when the flag is OFF or the day already ran. */
export function runNightlyCompare(db: DatabaseSync, now: Date = new Date()): { runDate: string; status: string; mismatchCount: number } | null {
  if (!glFlagOn(db, "gl.nightly_compare")) return null;
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) return null;
  const runDate = tehranDateOf(now);
  if (one(db, "SELECT 1 x FROM gl_reconciliation_runs WHERE run_date=?", runDate)) return null;
  const startedAt = now.toISOString();
  let status = "error", mismatch = 0, summary: unknown = {};
  try {
    const r = reconcile(db, runDate);
    if (r.state === "not_started") { status = "not_started"; summary = { reason: r.reason }; }
    else { mismatch = r.mismatchCount; status = mismatch ? "mismatch" : "ok"; summary = { sections: r.sections.map((s) => ({ key: s.key, status: s.status, mismatchCount: s.mismatchCount, checked: s.checked, glTotalRial: s.glTotalRial, systemTotalRial: s.systemTotalRial, refs: s.rows.slice(0, 50).map((x) => x.ref) })), queueOpen: r.queueOpen }; }
  } catch (e) { summary = { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
  db.prepare("INSERT OR IGNORE INTO gl_reconciliation_runs(run_date,trigger_kind,status,mismatch_count,summary_json,started_at,finished_at) VALUES(?,'nightly',?,?,?,?,?)")
    .run(runDate, status, mismatch, JSON.stringify(summary), startedAt, new Date().toISOString());
  return { runDate, status, mismatchCount: mismatch };
}

let nightly: ReturnType<typeof setInterval> | null = null;
/** Inert unless gl.nightly_compare is ON (checked every tick). Runs once per Tehran day after 02:00. Never throws. */
export function startGlNightlyCompare(db: DatabaseSync, log: { error: (o: unknown, m: string) => void }, everyMs = 10 * 60000): void {
  if (nightly) return;
  nightly = setInterval(() => {
    try {
      if (!glFlagOn(db, "gl.nightly_compare")) return;
      const now = new Date();
      if (tehranHour(now) < NIGHTLY_HOUR_TEHRAN) return;
      runNightlyCompare(db, now);
    } catch (err) { log.error({ err }, "gl nightly compare failed"); }
  }, everyMs);
  nightly.unref?.();
}
