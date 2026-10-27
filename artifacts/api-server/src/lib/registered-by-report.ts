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
 * channel = customers.source (staff / form / site / instagram / assistant / api; NULL for customers before this release),
 *           see CUSTOMER_SOURCE_BY_REGISTRATION in registration-sources.ts. byChannel groups by it.
 * reachedRegistration = the customer has a non-deleted loan application that ever entered «بررسی مدارک مشتری»
 *           (loan_application_stage_history.to_stage='customer_documents_review'; same stage as the expert report's
 *           sentToRegistration), at any time up to now.
 * called  = (crm-instagram-leads §5) at least one call started from the CRM «تماس» button (call_queue_calls row), any time up to now.
 * leadSource = customers.lead_source (crm-instagram-leads; NULL = created before the intake release = «قبل از شروع»). With a
 *           leadSource filter only customers registered after intake_started_at count, and «از» before that day is an error.
 * repeatRequests = «درخواست دوباره» rows (customer_repeat_requests) created by the registrar in the range — a duplicate phone,
 *           NEVER a registration (never in «ثبت» / the funnel).
 * urgentByFlagger = urgent v1.1 §0-24: flags set in the range by flagger, how each ended (auto by a CRM call result / manual
 *           clear / still open) and days with more than 5 flags.
 * reachedDeposit = the customer has a goods purchase at «واریز شد» (goods_purchases.stage='completed' AND completed_at set)
 *           OR a paid payment order (customer_payment_orders.stage='paid'), at any time up to now.
 */
import type { DatabaseSync } from "node:sqlite";
import { REGISTRATION_SOURCES, DEFAULT_OWNER_EXCLUDED_USER_IDS, CUSTOMER_SOURCE_LABELS } from "./registration-sources";
import { testCustomerSql } from "./test-customers";
import { intakeStartedAt, LEAD_SOURCES, isLeadSource, type LeadSource } from "./lead-intake";

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
export const LEGACY_LEAD_SOURCE_LABEL = "قبل از شروع";
export const SITE_AUTO_LABEL = "فرم سایت (خودکار)";
export const INTAKE_START_ERROR = "ثبت‌کننده و منبع از ۵ آبان ۱۴۰۵ ساعت ۲۲:۰۰ ذخیره می‌شوند. «از» را ۵ آبان یا بعد از آن بگذار.";
/** leadSource query → filter (all / missing = none). Error when the range starts before the intake start day (Tehran). */
export function leadSourceFilter(db: DatabaseSync, raw: unknown, range: RegisteredByRange): { leadSource: LeadSource | null } | { error: string; message: string } {
  if (raw == null || raw === "" || raw === "all") return { leadSource: null };
  if (!isLeadSource(raw)) return { error: "bad_lead_source", message: "منبع نامعتبر است." };
  const st = intakeStartedAt(db);
  if (st && range.from < tehranToday(new Date(st))) return { error: "before_intake_start", message: INTAKE_START_ERROR };
  return { leadSource: raw };
}

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

type Row = { registrar: number | null; source: string; ch: string | null; ls: string | null; inferred: number; called: number; reg: number; dep: number; goods: number; po: number };
export function registeredByReport(db: DatabaseSync, range: RegisteredByRange, opts: { excludeTest: boolean; now?: Date; leadSource?: LeadSource | null }) {
  const now = opts.now ?? new Date();
  const fromIso = startUtc(range.from), toIso = startUtc(addDays(range.to, 1));
  const rb = hasCol(db, "customers", "registered_by"), rs = hasCol(db, "customers", "registration_source"), cs = hasCol(db, "customers", "source");
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
  const lsc = hasCol(db, "customers", "lead_source") && hasCol(db, "customers", "registered_at");
  const calledSql = has(db, "call_queue_calls") ? "EXISTS (SELECT 1 FROM call_queue_calls q WHERE q.customer_id=c.id)" : "0";
  const lf = opts.leadSource ?? null;
  if (lf && !lsc) throw new Error("lead_source_column_missing");
  const rows = db.prepare(`SELECT registrar, source, ch, ls, inferred, SUM(called) called, SUM(reg) reg, SUM(goods OR po) dep, SUM(goods) goods, SUM(po) po, COUNT(*) n FROM (
      SELECT ${rb ? "c.registered_by" : "NULL"} registrar, ${src} source, ${cs ? "c.source" : "NULL"} ch, ${lsc ? "CASE WHEN c.registered_at IS NULL THEN NULL ELSE COALESCE(c.lead_source,'none') END" : "NULL"} ls, ${inf} inferred,
             (${calledSql}) called, (${regSql}) reg, (${goodsSql}) goods, (${poSql}) po
      FROM customers c
      WHERE c.merged_into_customer_id IS NULL AND julianday(c.created_at)>=julianday(?) AND julianday(c.created_at)<julianday(?)
        ${rb ? `AND (c.registered_by IS NULL OR c.registered_by NOT IN (${excl}))` : ""}
        ${lf ? "AND c.registered_at IS NOT NULL AND COALESCE(c.lead_source,'none')=?" : ""}
        ${opts.excludeTest ? `AND NOT ${testCustomerSql("c")}` : ""})
    GROUP BY registrar, source, ch, ls, inferred`).all(...(lf ? [fromIso, toIso, lf] : [fromIso, toIso])) as unknown as (Row & { n: number })[];
  // «درخواست دوباره» (duplicate phone): counted apart, never a registration.
  const rrCols = has(db, "customer_repeat_requests") ? hasCol(db, "customer_repeat_requests", "lead_source") : false;
  const repeats = has(db, "customer_repeat_requests") ? db.prepare(`SELECT r.created_by_user_id registrar, COUNT(*) n FROM customer_repeat_requests r
      WHERE julianday(r.created_at)>=julianday(?) AND julianday(r.created_at)<julianday(?)
        AND (r.created_by_user_id IS NULL OR r.created_by_user_id NOT IN (${excl}))
        ${lf ? (rrCols ? "AND COALESCE(r.lead_source,'none')=?" : "AND 0") : ""}
        ${opts.excludeTest ? `AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=r.customer_id AND ${testCustomerSql("c")})` : ""}
      GROUP BY r.created_by_user_id`).all(...(lf && rrCols ? [fromIso, toIso, lf] : [fromIso, toIso])) as { registrar: number | null; n: number }[] : [];
  const users = new Map((db.prepare("SELECT u.id, u.full_name, u.username, u.salesperson_id, u.role FROM users u").all() as any[]).map((u) => [Number(u.id), u]));
  const sps = new Map((db.prepare("SELECT id, name FROM salespersons").all() as any[]).map((s) => [Number(s.id), String(s.name ?? "")]));
  type Out = { key: string; userId: number | null; name: string; salespersonId: number | null; salespersonName: string | null; registered: number;
    called: number; repeatRequests: number; byLeadSource: { leadSource: string | null; label: string; count: number }[]; reachedRegistration: number; reachedDeposit: number; depositGoods: number; depositPaymentOrders: number;
    bySource: { source: string; label: string; count: number; inferred: number }[]; byChannel: { channel: string | null; label: string; count: number }[] };
  const by = new Map<string, Out>();
  const SITE_AUTO = new Set(["site_lead", "site_callback", "portal"]);
  const get = (registrar: number | null, source: string | null): Out => {
    const key = registrar != null ? String(registrar) : source && SITE_AUTO.has(source) ? "site_auto" : "none";
    let o = by.get(key);
    if (!o) {
      const u = registrar == null ? null : users.get(Number(registrar));
      const sp = u?.salesperson_id == null ? null : Number(u.salesperson_id);
      o = { key, userId: registrar == null ? null : Number(registrar),
        name: registrar == null ? (key === "site_auto" ? SITE_AUTO_LABEL : "سیستم / نامشخص") : String(u?.full_name || u?.username || `کاربر ${registrar}`),
        salespersonId: sp, salespersonName: sp == null ? null : sps.get(sp) ?? null, registered: 0, called: 0, repeatRequests: 0, byLeadSource: [],
        reachedRegistration: 0, reachedDeposit: 0, depositGoods: 0, depositPaymentOrders: 0, bySource: [], byChannel: [] };
      by.set(key, o);
    }
    return o;
  };
  for (const rr of repeats) get(rr.registrar == null ? null : Number(rr.registrar), null).repeatRequests += Number(rr.n);
  for (const r of rows) {
    const o = get(r.registrar == null ? null : Number(r.registrar), r.source);
    const n = Number(r.n);
    o.called += Number(r.called);
    const lk = r.ls == null ? null : String(r.ls);
    let l = o.byLeadSource.find((x) => x.leadSource === lk);
    if (!l) { l = { leadSource: lk, label: lk == null ? LEGACY_LEAD_SOURCE_LABEL : (LEAD_SOURCES as Record<string, string>)[lk] ?? lk, count: 0 }; o.byLeadSource.push(l); }
    l.count += n;
    o.registered += n; o.reachedRegistration += Number(r.reg); o.reachedDeposit += Number(r.dep); o.depositGoods += Number(r.goods); o.depositPaymentOrders += Number(r.po);
    let s = o.bySource.find((x) => x.source === r.source);
    if (!s) { s = { source: r.source, label: (REGISTRATION_SOURCES as Record<string, string>)[r.source] ?? UNKNOWN_SOURCE_LABEL, count: 0, inferred: 0 }; o.bySource.push(s); }
    s.count += n; if (Number(r.inferred)) s.inferred += n;
    const chn = r.ch == null ? null : String(r.ch);
    let h = o.byChannel.find((x) => x.channel === chn);
    if (!h) { h = { channel: chn, label: chn == null ? UNKNOWN_SOURCE_LABEL : CUSTOMER_SOURCE_LABELS[chn] ?? chn, count: 0 }; o.byChannel.push(h); }
    h.count += n;
  }
  const registrars = [...by.values()].map((o) => ({ ...o, bySource: o.bySource.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
      byLeadSource: o.byLeadSource.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => (a.userId == null ? 1 : 0) - (b.userId == null ? 1 : 0) || b.registered - a.registered || b.repeatRequests - a.repeatRequests || Number(a.userId) - Number(b.userId));
  const sum = (k: "registered" | "called" | "repeatRequests" | "reachedRegistration" | "reachedDeposit" | "depositGoods" | "depositPaymentOrders") => registrars.reduce((t, o) => t + o[k], 0);
  const bySource = new Map<string, { source: string; label: string; count: number; inferred: number }>();
  for (const o of registrars) for (const s of o.bySource) { const t = bySource.get(s.source) ?? { ...s, count: 0, inferred: 0 }; t.count += s.count; t.inferred += s.inferred; bySource.set(s.source, t); }
  const byChannel = new Map<string, { channel: string | null; label: string; count: number }>();
  for (const o of registrars) for (const h of o.byChannel) { const k = String(h.channel); const t = byChannel.get(k) ?? { ...h, count: 0 }; t.count += h.count; byChannel.set(k, t); }
  const byLeadSource = new Map<string, { leadSource: string | null; label: string; count: number }>();
  for (const o of registrars) for (const l of o.byLeadSource) { const k = String(l.leadSource); const t = byLeadSource.get(k) ?? { ...l, count: 0 }; t.count += l.count; byLeadSource.set(k, t); }
  return {
    from: range.from, to: range.to, timezone: "Asia/Tehran (UTC+03:30)", generatedAt: now.toISOString(), testCustomersExcluded: opts.excludeTest,
    countsOnly: true, definitions: REGISTERED_BY_DEFINITIONS, leadSource: lf, intakeStartedAt: lsc ? intakeStartedAt(db) : null,
    leadSources: Object.entries(LEAD_SOURCES).map(([key, label]) => ({ key, label })),
    totals: { registered: sum("registered"), called: sum("called"), repeatRequests: sum("repeatRequests"),
      byLeadSource: [...byLeadSource.values()].sort((a, b) => b.count - a.count), reachedRegistration: sum("reachedRegistration"), reachedDeposit: sum("reachedDeposit"),
      depositGoods: sum("depositGoods"), depositPaymentOrders: sum("depositPaymentOrders"),
      bySource: [...bySource.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
      byChannel: [...byChannel.values()].sort((a, b) => b.count - a.count) },
    registrars,
    urgentByFlagger: urgentByFlagger(db, range, { excludeTest: opts.excludeTest, leadSource: lf }),
  };
}

/**
 * urgent v1.1 §0-24 «علامت فوری بر اساس علامت‌زننده»: flags SET in the range (Tehran dates), by flagger (user / assistant /
 * system), and how each one ended: auto (a CRM call result, auto_call), manual (an admin clear or any older clear), open.
 * heavyDays = Tehran days on which this flagger set more than 5 flags («یک روز N علامت»). Counts only. User 29 never a row.
 */
export function urgentByFlagger(db: DatabaseSync, range: RegisteredByRange, opts: { excludeTest: boolean; leadSource?: LeadSource | null }) {
  if (!has(db, "customer_urgent_history")) return { rows: [], totals: { flagged: 0, autoCleared: 0, manualCleared: 0, open: 0 } };
  const fromIso = startUtc(range.from), toIso = startUtc(addDays(range.to, 1));
  const ev = hasCol(db, "customer_urgent_history", "event");
  const lf = opts.leadSource ?? null;
  const list = db.prepare(`SELECT h.id, h.actor_kind k, h.actor_user_id uid, h.assistant_id aid, h.actor_label lbl, h.created_at at,
      (SELECT ${ev ? "COALESCE(x.clear_reason_code,'') || '|' || COALESCE(x.via,'')" : "COALESCE(x.via,'')"} FROM customer_urgent_history x
        WHERE x.customer_id=h.customer_id AND x.id>h.id AND x.old_value=1 AND x.new_value=0 ORDER BY x.id LIMIT 1) closed
    FROM customer_urgent_history h WHERE h.old_value=0 AND h.new_value=1
      AND julianday(h.created_at)>=julianday(?) AND julianday(h.created_at)<julianday(?)
      AND (h.actor_user_id IS NULL OR h.actor_user_id NOT IN (${DEFAULT_OWNER_EXCLUDED_USER_IDS.join(",")}))
      ${lf ? "AND EXISTS (SELECT 1 FROM customers c WHERE c.id=h.customer_id AND c.registered_at IS NOT NULL AND COALESCE(c.lead_source,'none')=?)" : ""}
      ${opts.excludeTest ? `AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=h.customer_id AND ${testCustomerSql("c")})` : ""}`)
    .all(...(lf ? [fromIso, toIso, lf] : [fromIso, toIso])) as any[];
  const users = new Map((db.prepare("SELECT id, full_name, username FROM users").all() as any[]).map((u) => [Number(u.id), String(u.full_name || u.username)]));
  const asst = has(db, "assistants") ? new Map((db.prepare("SELECT id, display_name name FROM assistants").all() as any[]).map((a) => [Number(a.id), String(a.name ?? "")])) : new Map<number, string>();
  type R = { key: string; kind: string; userId: number | null; assistantId: number | null; name: string; flagged: number; autoCleared: number; manualCleared: number; open: number;
    maxPerDay: number; heavyDays: { date: string; count: number }[]; days: Map<string, number> };
  const by = new Map<string, R>();
  for (const f of list) {
    const key = f.k === "user" ? `u${f.uid}` : f.k === "assistant" ? `a${f.aid}` : "system";
    let r = by.get(key);
    if (!r) {
      r = { key, kind: f.k, userId: f.uid == null ? null : Number(f.uid), assistantId: f.aid == null ? null : Number(f.aid),
        name: f.k === "user" ? users.get(Number(f.uid)) ?? `کاربر ${f.uid}` : f.k === "assistant" ? (asst.get(Number(f.aid)) || f.lbl || "دستیار") : "سیستم",
        flagged: 0, autoCleared: 0, manualCleared: 0, open: 0, maxPerDay: 0, heavyDays: [], days: new Map() };
      by.set(key, r);
    }
    r.flagged++;
    if (f.closed == null) r.open++;
    else if (String(f.closed).startsWith("auto_call|") || String(f.closed).endsWith("auto_call")) r.autoCleared++;
    else r.manualCleared++;
    const d = tehranToday(new Date(f.at)); r.days.set(d, (r.days.get(d) ?? 0) + 1);
  }
  const rows = [...by.values()].map(({ days, ...r }) => {
    const ds = [...days.entries()];
    return { ...r, maxPerDay: ds.reduce((m, [, n]) => Math.max(m, n), 0), heavyDays: ds.filter(([, n]) => n > 5).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)) };
  }).sort((a, b) => b.flagged - a.flagged || a.key.localeCompare(b.key));
  const t = (k: "flagged" | "autoCleared" | "manualCleared" | "open") => rows.reduce((s, r) => s + r[k], 0);
  return { rows, totals: { flagged: t("flagged"), autoCleared: t("autoCleared"), manualCleared: t("manualCleared"), open: t("open") } };
}
