/**
 * crm-default-owner: «ثبت‌شده‌ها بر اساس ثبت‌کننده» (admin page + Ahmad's read-only manager endpoint). Counts only —
 * never a customer id, name or phone.
 *
 * Cohort  = customers whose created_at falls in [from, to] (Tehran calendar dates, inclusive, UTC+03:30), not merged,
 *           test customers excluded when the assistants' «حذف مشتری‌های تستی» switch is ON. User 29 is never a row.
 * registrar = customers.registered_by (users.id). NULL = a system intake (site form / Instagram automation / portal) or a
 *           customer created before the column existed («نامشخص»).
 * source  = customers.registration_source; for older rows (NULL) it is inferred from the link tables (inferred=true):
 *           public_leads → site_lead, callback_requests → site_callback, instagram_crm_automation_sessions → instagram_auto,
 *           instagram_threads → instagram, customer_portal_registrations → portal, else «unknown».
 * reachedRegistration = the customer has a non-deleted loan application that ever entered «بررسی مدارک مشتری»
 *           (loan_application_stage_history.to_stage='customer_documents_review'; same stage as the expert report's
 *           sentToRegistration), at any time up to now.
 * reachedDeposit = the customer has a goods purchase at «واریز شد» (goods_purchases.stage='completed' AND completed_at set)
 *           OR a paid payment order (customer_payment_orders.stage='paid'), at any time up to now.
 */
import type { DatabaseSync } from "node:sqlite";
import { REGISTRATION_SOURCES, DEFAULT_OWNER_EXCLUDED_USER_IDS } from "./registration-sources";
import { testCustomerSql } from "./test-customers";

const OFFSET_MS = 3.5 * 3600_000;
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const hasCol = (db: DatabaseSync, t: string, c: string) => Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name=?`).get(c));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const tehranToday = (now: Date) => new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const startUtc = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - OFFSET_MS).toISOString();

export const REGISTERED_BY_DEFINITIONS = {
  cohort: "مشتری‌هایی که در بازه‌ی انتخاب‌شده (به وقت تهران، هر دو روز شامل) ساخته شده‌اند؛ مشتری‌های ادغام‌شده و (اگر کلید فعال باشد) مشتری‌های تستی حساب نمی‌شوند.",
  registrar: "کاربری که مشتری را ثبت کرده (customers.registered_by). «سیستم / نامشخص» یعنی ورود خودکار (سایت، اینستاگرام خودکار، پرتال) یا مشتری قدیمی که ثبت‌کننده‌اش ذخیره نشده.",
  reachedRegistration: "مشتری حداقل یک پرونده‌ی تسهیلات (حذف‌نشده) دارد که تا امروز وارد مرحله‌ی «بررسی مدارک مشتری» شده است.",
  reachedDeposit: "مشتری تا امروز یا خرید کالای «واریز شد» (goods_purchases.stage=completed) یا دستور پرداخت «پرداخت‌شده» (customer_payment_orders.stage=paid) دارد.",
  sourceInferred: "برای مشتری‌های قبل از این نسخه، منبع از جدول‌های اتصال حدس زده شده است (inferred).",
} as const;
export const UNKNOWN_SOURCE_LABEL = "نامشخص";

export type RegisteredByRange = { from: string; to: string };
export function registeredByRange(q: { from?: unknown; to?: unknown }, now: Date): RegisteredByRange | { error: string } {
  const today = tehranToday(now);
  const to = q.to == null || q.to === "" ? today : String(q.to);
  const from = q.from == null || q.from === "" ? addDays(to, -29) : String(q.from);
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return { error: "invalid_date" };
  if (from > to) return { error: "from_after_to" };
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) return { error: "range_too_long" };
  return { from, to };
}

type Row = { registrar: number | null; source: string; inferred: number; reg: number; dep: number; goods: number; po: number };
export function registeredByReport(db: DatabaseSync, range: RegisteredByRange, opts: { excludeTest: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const fromIso = startUtc(range.from), toIso = startUtc(addDays(range.to, 1));
  const rb = hasCol(db, "customers", "registered_by"), rs = hasCol(db, "customers", "registration_source");
  const infer: string[] = [];
  if (has(db, "public_leads")) infer.push("WHEN EXISTS (SELECT 1 FROM public_leads x WHERE x.customer_id=c.id) THEN 'site_lead'");
  if (has(db, "callback_requests")) infer.push("WHEN EXISTS (SELECT 1 FROM callback_requests x WHERE x.customer_id=c.id) THEN 'site_callback'");
  if (has(db, "instagram_crm_automation_sessions") && hasCol(db, "instagram_crm_automation_sessions", "customer_id")) infer.push("WHEN EXISTS (SELECT 1 FROM instagram_crm_automation_sessions x WHERE x.customer_id=c.id) THEN 'instagram_auto'");
  if (has(db, "instagram_threads")) infer.push("WHEN EXISTS (SELECT 1 FROM instagram_threads x WHERE x.customer_id=c.id) THEN 'instagram'");
  if (has(db, "customer_portal_registrations")) infer.push("WHEN EXISTS (SELECT 1 FROM customer_portal_registrations x WHERE x.customer_id=c.id) THEN 'portal'");
  const inferred = `CASE ${infer.join(" ")} ${infer.length ? "" : "WHEN 0 THEN NULL"} ELSE 'unknown' END`;
  const src = rs ? `COALESCE(c.registration_source, ${inferred})` : inferred;
  const inf = rs ? "CASE WHEN c.registration_source IS NULL THEN 1 ELSE 0 END" : "1";
  const regSql = has(db, "loan_applications") && has(db, "loan_application_stage_history")
    ? `EXISTS (SELECT 1 FROM loan_applications a JOIN loan_application_stage_history h ON h.application_id=a.id
        WHERE a.customer_id=c.id AND a.deleted_at IS NULL AND h.to_stage='customer_documents_review')` : "0";
  const goodsSql = has(db, "goods_purchases") ? "EXISTS (SELECT 1 FROM goods_purchases g WHERE g.customer_id=c.id AND g.stage='completed' AND g.completed_at IS NOT NULL)" : "0";
  const poSql = has(db, "customer_payment_orders") ? "EXISTS (SELECT 1 FROM customer_payment_orders p WHERE p.customer_id=c.id AND p.stage='paid')" : "0";
  const excl = DEFAULT_OWNER_EXCLUDED_USER_IDS.join(",");
  const rows = db.prepare(`SELECT registrar, source, inferred, SUM(reg) reg, SUM(goods OR po) dep, SUM(goods) goods, SUM(po) po, COUNT(*) n FROM (
      SELECT ${rb ? "c.registered_by" : "NULL"} registrar, ${src} source, ${inf} inferred,
             (${regSql}) reg, (${goodsSql}) goods, (${poSql}) po
      FROM customers c
      WHERE c.merged_into_customer_id IS NULL AND julianday(c.created_at)>=julianday(?) AND julianday(c.created_at)<julianday(?)
        ${rb ? `AND (c.registered_by IS NULL OR c.registered_by NOT IN (${excl}))` : ""}
        ${opts.excludeTest ? `AND NOT ${testCustomerSql("c")}` : ""})
    GROUP BY registrar, source, inferred`).all(fromIso, toIso) as unknown as (Row & { n: number })[];
  const users = new Map((db.prepare("SELECT u.id, u.full_name, u.username, u.salesperson_id, u.role FROM users u").all() as any[]).map((u) => [Number(u.id), u]));
  const sps = new Map((db.prepare("SELECT id, name FROM salespersons").all() as any[]).map((s) => [Number(s.id), String(s.name ?? "")]));
  type Out = { userId: number | null; name: string; salespersonId: number | null; salespersonName: string | null; registered: number;
    reachedRegistration: number; reachedDeposit: number; depositGoods: number; depositPaymentOrders: number;
    bySource: { source: string; label: string; count: number; inferred: number }[] };
  const by = new Map<string, Out>();
  for (const r of rows) {
    const key = r.registrar == null ? "none" : String(r.registrar);
    let o = by.get(key);
    if (!o) {
      const u = r.registrar == null ? null : users.get(Number(r.registrar));
      const sp = u?.salesperson_id == null ? null : Number(u.salesperson_id);
      o = { userId: r.registrar == null ? null : Number(r.registrar), name: r.registrar == null ? "سیستم / نامشخص" : String(u?.full_name || u?.username || `کاربر ${r.registrar}`),
        salespersonId: sp, salespersonName: sp == null ? null : sps.get(sp) ?? null, registered: 0, reachedRegistration: 0, reachedDeposit: 0, depositGoods: 0, depositPaymentOrders: 0, bySource: [] };
      by.set(key, o);
    }
    const n = Number(r.n);
    o.registered += n; o.reachedRegistration += Number(r.reg); o.reachedDeposit += Number(r.dep); o.depositGoods += Number(r.goods); o.depositPaymentOrders += Number(r.po);
    let s = o.bySource.find((x) => x.source === r.source);
    if (!s) { s = { source: r.source, label: (REGISTRATION_SOURCES as Record<string, string>)[r.source] ?? UNKNOWN_SOURCE_LABEL, count: 0, inferred: 0 }; o.bySource.push(s); }
    s.count += n; if (Number(r.inferred)) s.inferred += n;
  }
  const registrars = [...by.values()].map((o) => ({ ...o, bySource: o.bySource.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) }))
    .sort((a, b) => (a.userId == null ? 1 : 0) - (b.userId == null ? 1 : 0) || b.registered - a.registered || Number(a.userId) - Number(b.userId));
  const sum = (k: "registered" | "reachedRegistration" | "reachedDeposit" | "depositGoods" | "depositPaymentOrders") => registrars.reduce((t, o) => t + o[k], 0);
  const bySource = new Map<string, { source: string; label: string; count: number; inferred: number }>();
  for (const o of registrars) for (const s of o.bySource) { const t = bySource.get(s.source) ?? { ...s, count: 0, inferred: 0 }; t.count += s.count; t.inferred += s.inferred; bySource.set(s.source, t); }
  return {
    from: range.from, to: range.to, timezone: "Asia/Tehran (UTC+03:30)", generatedAt: now.toISOString(), testCustomersExcluded: opts.excludeTest,
    countsOnly: true, definitions: REGISTERED_BY_DEFINITIONS,
    totals: { registered: sum("registered"), reachedRegistration: sum("reachedRegistration"), reachedDeposit: sum("reachedDeposit"),
      depositGoods: sum("depositGoods"), depositPaymentOrders: sum("depositPaymentOrders"),
      bySource: [...bySource.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) },
    registrars,
  };
}
