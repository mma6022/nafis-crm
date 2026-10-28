/**
 * expert_lockdown (assistants54, Mohammad 2026-10-28 09:37 Tehran): while flag.expert_lockdown = '1' (call_queue_settings),
 * the three sales experts Kazemi (user 8 / sp 6), Hasani (user 2 / sp 3) and Ghasemi (user 3 / sp 4) may use ONLY
 * «کارهای امروز من», «پرونده‌های من», «دستور پرداخت», «خرید کالا» and the messengers. Every other staff API returns
 * 403 expert_lockdown. A single customer (page + its APIs, by path /customers/:id…, query or body customerId) is open only if
 *  (a) it is in the expert's own daily plan for today, (b) the expert's own «تماس ورودی» search found it (own customer only)
 *  in the last EL_GRANT_MINUTES, or (c) it is the expert's own customer with one of their cases (loan application, goods purchase
 *  or payment order); otherwise 403 expert_lockdown_customer.
 * Everybody else (admins, trainees, registrars, Milad, user 29, the assistant runner tokens) never reaches any check here:
 * the guard returns next() before touching the DB. Flag OFF (or absent) = old behaviour exactly.
 * «تماس ورودی دارم»: exact full mobile or exact full name only; never a list; rate-limited; every click/search is logged
 * (el_incoming_log — the query is stored only as an HMAC hash, never raw). Another expert's customer → owner name only + ONE
 * CRM bell «تماس ورودی» to the owner (no SMS, no Bale).
 */
import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { crmDb, execute, queryRow, queryRows, runTransaction } from "./crm-db";
import { cqRaw } from "./call-queue";
import { dpToday } from "./daily-plan";
import { exactLookupOf } from "./cross-owner-search";
import { insertCustomerRecord } from "./customer-create";
import { normalizeCustomerMobile } from "./customer-integrity";

export const EL_FLAG_KEY = "flag.expert_lockdown";
/** users.id → their salespersons.id (checked against the session: a user whose salespersonId differs is not locked). */
export const EL_USERS: Readonly<Record<number, number>> = { 8: 6, 2: 3, 3: 4 };
export const EL_GRANT_MINUTES = 30;
export const EL_SEARCH_LIMIT = 12;           // searches per user per window
export const EL_SEARCH_WINDOW_MS = 10 * 60_000;
export const EL_BELL_WINDOW_MS = 30 * 60_000; // at most one owner bell per caller + customer in this window
export const EL_ADMIN_USER_IDS = [1, 5];
/** Dashboard routes (hrefs) the locked experts keep. */
export const EL_ALLOWED_PAGES = ["/today", "/loan-applications", "/payment-orders", "/goods-purchases", "/messengers", "/internal-chat"];

type U = { id: number; role: string; salespersonId: number | null; fullName?: string | null; customerScope?: string };

export const elFlagOn = (): boolean => { try { return cqRaw(EL_FLAG_KEY) === "1"; } catch { return false; } };
export const elTarget = (u: U | null | undefined): boolean =>
  Boolean(u && u.role === "salesperson" && EL_USERS[Number(u.id)] != null && Number(u.salespersonId) === EL_USERS[Number(u.id)]);
export const elLocked = (u: U | null | undefined): boolean => elTarget(u) && elFlagOn();

let ready = false;
export function ensureElSchema(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS el_incoming_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, salesperson_id INTEGER,
      action TEXT NOT NULL, query_kind TEXT, query_hash TEXT, result TEXT, customer_id INTEGER, owner_salesperson_id INTEGER,
      notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_el_incoming_user ON el_incoming_log(user_id, created_at);
    CREATE TABLE IF NOT EXISTS el_grants(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
      source TEXT NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_el_grants_user ON el_grants(user_id, customer_id, expires_at);
    -- SEARCH-65b: additive plain-column index for «تماس ورودی داشتم» live search (own customers by salesperson, phone stored normalized 09xxxxxxxxx).
    CREATE INDEX IF NOT EXISTS idx_customers_sp_phone ON customers(salesperson_id, phone);`);
  ready = true;
}

/* ---------------- customer access (a)/(b)/(c) ---------------- */
export function elCustomerAccess(u: U, customerId: number, now = new Date()): "plan" | "incoming" | "registered" | "case" | null {
  const sp = Number(u.salespersonId);
  if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='dp_items'") &&
      queryRow("SELECT 1 x FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id WHERE p.salesperson_id=? AND p.day=? AND i.customer_id=? LIMIT 1", [sp, dpToday(now), customerId])) return "plan";
  ensureElSchema();
  const own = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!own || Number(own.salesperson_id) !== sp) return null;
  if (queryRow("SELECT 1 x FROM el_grants WHERE user_id=? AND customer_id=? AND expires_at>? LIMIT 1", [Number(u.id), customerId, now.toISOString()])) return "incoming";
  // NEWCUST-65 (= incoming2-59 (d)): a customer this expert registered through «تماس ورودی داشتم › ثبت مشتری جدید» (still their own).
  if (queryRow("SELECT 1 x FROM el_incoming_log l JOIN customers c ON c.id=l.customer_id WHERE l.user_id=? AND l.customer_id=? AND l.action='new_create' AND l.result='created' AND c.registered_by=? LIMIT 1",
    [Number(u.id), customerId, Number(u.id)])) return "registered";
  if (queryRow("SELECT 1 x FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL LIMIT 1", [customerId])) return "case";
  if (queryRow("SELECT 1 x FROM goods_purchases WHERE customer_id=? LIMIT 1", [customerId])) return "case";
  if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='customer_payment_orders'") &&
      queryRow("SELECT 1 x FROM customer_payment_orders WHERE customer_id=? LIMIT 1", [customerId])) return "case";
  return null;
}

/* ---------------- API guard ---------------- */
/** API families the five allowed areas need (paths are relative to /api). Customer-bearing requests are re-checked below. */
const ALLOW: RegExp[] = [
  // session / profile / shell
  /^\/(session|me|logout|profile)(\/|$)/, /^\/avatars(\/|$)/, /^\/users\/\d+\/avatar$/, /^\/healthz$/, /^\/roles\/me$/,
  /^\/expert-lockdown\//,
  // shell reads that list no customers (feature switches / telemetry / staff names / form options)
  /^\/(lead-annotator|registrar-view)\/me$/, /^\/page-usage(\/config)?$/, /^\/voip\/config$/, /^\/salespersons$/, /^\/team-sales\/config$/,
  /^\/lead-intake\/options$/, /^\/customer-tags$/, /^\/consult-options$/, /^\/call-queue\/discipline\/me$/,
  // bell
  /^\/site-notifications(\/|$)/,
  // «کارهای امروز من» + the call form (outcome / one-line note) + voice-to-text + after-call
  /^\/daily-plans\/(today|config|calls|items)(\/|$)/, /^\/call-queue\/(config|pre-call|after-save|pending|calls|reminders|suggestions)(\/|$)/,
  /^\/voice-notes(\/|$)/, /^\/voip\/after-call(\/|$)/,
  // FIRSTCALL-62: the first-call form's city autocomplete (city names only; ?customerId= is still checked below).
  /^\/team-sales\/cities$/,
  // «پرونده‌های من» + «خرید کالا» + «دستور پرداخت» (+ the reads used inside them)
  /^\/loan-applications(\/|$)/, /^\/loan-request-drafts(\/|$)/, /^\/applications(\/|$)/, /^\/loan-plans(\/|$)/, /^\/loan-plan-rates(\/|$)/,
  /^\/loan-options(\/|$)/, /^\/plan-quote(\/|$)/, /^\/filing-fee(\/|$)/, /^\/identity-documents(\/|$)/, /^\/credit-checks(\/|$)/, /^\/smart-filing\/eligibility\/\d+$/,
  /^\/goods-purchases(\/|$)/, /^\/goods-documents(\/|$)/, /^\/payment-orders(\/|$)/, /^\/contracts\/[^/]+/, /^\/contract-updates(\/|$)/,
  // messengers + internal chat + the assistant chat drawer
  /^\/bale(\/|$)/, /^\/messengers(\/|$)/, /^\/internal-chat(\/|$)/, /^\/assistant\/(mine|prefs)$/, /^\/assistant\/threads\/\d+\/messages$/,
];
/** The single-customer page and its APIs: allowed only for an accessible customer. */
const CUSTOMER_PATH = /(?:^|\/)customers\/(\d+)(?=\/|$)/g;
const idsOf = (req: Request): number[] => {
  const out: number[] = [];
  for (const m of req.path.matchAll(CUSTOMER_PATH)) out.push(Number(m[1]));
  const add = (v: unknown) => { const n = Number(v); if (Number.isSafeInteger(n) && n > 0) out.push(n); };
  const qy = req.query as Record<string, unknown>;
  for (const k of ["customerId", "customer_id"]) if (typeof qy?.[k] === "string") add(qy[k]);
  const b = req.body as Record<string, unknown> | undefined;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    for (const k of ["customerId", "customer_id"]) if (b[k] != null) add(b[k]);
    if (Array.isArray(b.customerIds)) for (const v of b.customerIds) add(v);
  }
  return [...new Set(out)];
};
const deny = (res: Response, error: string, message: string) => void res.status(403).json({ error, message });

export function expertLockdownGuard(req: Request, res: Response, next: NextFunction): void {
  const u = res.locals.authUser as U | undefined;
  if (!elTarget(u)) { next(); return; }            // everybody else: no DB read, no change
  if (!elFlagOn()) { next(); return; }
  const path = req.path.replace(/\/+$/, "") || "/";
  // NEWCUST-65: the first-call mirror scopes itself (call by this expert, customer theirs or just moved by them to Kazemi),
  // so a P2/P3 customer that left them in the same save can still get its «منتقل شد» entry.
  const ids = path === "/expert-lockdown/incoming/first-call-logged" ? [] : idsOf(req);
  const customerRoute = /^\/(lead-intake\/)?customers\/\d+(\/|$)/.test(path) || /^\/team-sales\/customers\/\d+(\/|$)/.test(path);
  // POST /calls (the normal call form, incl. «خارج از لیست») and POST /voip/calls (click-to-call) carry the customer in the body.
  const customerWrite = req.method === "POST" && /^\/(calls|voip\/calls|voip\/click-to-call)$/.test(path);
  const listedCustomerRead = req.method === "GET" && ids.length === 1 && EL_CUSTOMER_SCOPED_READS.some((re) => re.test(path));
  if (!customerRoute && !customerWrite && !listedCustomerRead && !ALLOW.some((re) => re.test(path))) {
    if (process.env.EL_TRACE === "1") console.warn(`[expert-lockdown] deny ${req.method} ${path}`);
    return deny(res, "expert_lockdown", "این بخش فعلاً برای شما بسته است. از «کارهای امروز من» کار کن.");
  }
  if ((customerRoute || customerWrite) && !ids.length) return deny(res, "expert_lockdown", "این بخش فعلاً برای شما بسته است.");
  for (const id of ids) {
    if (!elCustomerAccess(u!, id)) {
      if (process.env.EL_TRACE === "1") console.warn(`[expert-lockdown] deny-customer ${req.method} ${path}`);
      return deny(res, "expert_lockdown_customer", "این مشتری فعلاً برای شما باز نیست (فقط مشتری‌های «کارهای امروز»، پرونده‌های خودت یا «تماس ورودی»).");
    }
  }
  next();
}
/** List endpoints the customer page calls with ?customerId=N (scoped to that one customer). */
export const EL_CUSTOMER_SCOPED_READS: RegExp[] = [/^\/calls$/, /^\/consultations$/, /^\/reminders$/, /^\/callback-requests$/, /^\/voip\/calls$/,
  /^\/chat(\/|$)/, /^\/wallet(\/|$)/, /^\/contracts$/, /^\/call-reports(\/|$)/, /^\/mobile-calls$/, /^\/recordings(\/|$)/];

/* ---------------- «تماس ورودی دارم» ---------------- */
const hashQuery = (kind: string, value: string): string =>
  createHmac("sha256", process.env.SESSION_SECRET || "nafis-el-fallback").update(`el:${kind}:${value}`).digest("hex").slice(0, 32);
function log(u: U, row: { action: string; kind?: string | null; hash?: string | null; result?: string | null; customerId?: number | null; ownerSp?: number | null; notified?: boolean }, at: string) {
  ensureElSchema();
  execute(`INSERT INTO el_incoming_log(user_id,salesperson_id,action,query_kind,query_hash,result,customer_id,owner_salesperson_id,notified,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [Number(u.id), Number(u.salespersonId), row.action, row.kind ?? null, row.hash ?? null, row.result ?? null,
    row.customerId ?? null, row.ownerSp ?? null, row.notified ? 1 : 0, at]);
}
export function elIncomingOpen(u: U, now = new Date()) { log(u, { action: "open" }, now.toISOString()); return { ok: true }; }

/* ---------------- NEWCUST-65 «ثبت مشتری جدید» (interim, ahead of incoming2-59; same endpoints/shape as 59) ---------------- */
const rateLimited = (u: U, now: Date) => Number(queryRow<{ n: number }>("SELECT count(*) n FROM el_incoming_log WHERE user_id=? AND action IN ('search','new_check','new_create') AND created_at>?",
  [Number(u.id), new Date(now.getTime() - EL_SEARCH_WINDOW_MS).toISOString()])?.n ?? 0) >= EL_SEARCH_LIMIT;
/** Same match as POST /customers' duplicate check (findCustomerByPhone): crm_customer_mobile_key(phone), any status, merged → survivor. */
function phoneOwner(phone: string): { id: number; name: string; sp: number | null; owner_name: string | null } | null {
  const rows = queryRows<{ id: number; merged: number | null }>(`SELECT c.id, c.merged_into_customer_id merged FROM customers c WHERE crm_customer_mobile_key(c.phone)=?
    ORDER BY CASE WHEN c.merged_into_customer_id IS NULL AND COALESCE(c.status,'in_progress')<>'cancelled' THEN 0 WHEN c.merged_into_customer_id IS NULL THEN 1 ELSE 2 END,
      c.created_at DESC, c.id DESC LIMIT 1`, [phone]);
  if (!rows.length) return null;
  let id = Number(rows[0].id), merged = rows[0].merged;
  for (let i = 0; merged != null && i < 10; i++) {
    const n = queryRow<{ id: number; merged: number | null }>("SELECT id, merged_into_customer_id merged FROM customers WHERE id=?", [Number(merged)]);
    if (!n) break; id = Number(n.id); merged = n.merged;
  }
  return queryRow<{ id: number; name: string; sp: number | null; owner_name: string | null }>(
    "SELECT c.id, c.name, c.salesperson_id sp, s.name owner_name FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?", [id]) ?? null;
}
const mobileOf = (raw: unknown): string | null => { const p = normalizeCustomerMobile(String(raw ?? "").slice(0, 40)); return /^09\d{9}$/.test(p) ? p : null; };
export type ElNewResult =
  | { result: "new" }
  | { result: "duplicate"; ownerName: string; mine: boolean }
  | { result: "created"; customer: { id: number; name: string } }
  | { result: "invalid" | "rate_limited"; message: string; field?: string };
const INVALID_PHONE = { result: "invalid" as const, field: "phone", message: "شماره‌ی موبایل کامل ۱۱ رقمی را بنویس (مثلاً ۰۹۱۲۱۲۳۴۵۶۷)." };
const RATE_LIMITED = { result: "rate_limited" as const, message: "تعداد جست‌وجوها زیاد شد؛ چند دقیقه بعد دوباره امتحان کن." };
/** Duplicate: the owner's (expert's) name only — no customer data. NEWCUST-65: no bell / SMS / notification to anyone. */
const dupResult = (u: U, o: { sp: number | null; owner_name: string | null }): ElNewResult =>
  ({ result: "duplicate", ownerName: o.sp == null ? "بدون کارشناس" : String(o.owner_name ?? "") || "بدون کارشناس", mine: o.sp != null && Number(o.sp) === Number(u.salespersonId) });
/** Step 1: phone only → exact duplicate check. Nothing is created; a duplicate answers the owner's name only. */
export function elNewCheck(u: U, raw: unknown, now = new Date()): ElNewResult {
  ensureElSchema(); const at = now.toISOString();
  if (rateLimited(u, now)) { log(u, { action: "search_limited", result: "rate_limited" }, at); return RATE_LIMITED; }
  const phone = mobileOf(raw);
  if (!phone) { log(u, { action: "new_check", kind: "invalid", result: "invalid" }, at); return INVALID_PHONE; }
  const hash = hashQuery("phone", phone);
  const o = phoneOwner(phone);
  if (o) { log(u, { action: "new_check", kind: "phone", hash, result: "duplicate", customerId: Number(o.id), ownerSp: o.sp == null ? null : Number(o.sp) }, at); return dupResult(u, o); }
  log(u, { action: "new_check", kind: "phone", hash, result: "new" }, at);
  return { result: "new" };
}
export const EL_NEW_NAME_MAX = 80, EL_NEW_NOTE_MAX = 500;
/** Last step: create. Re-checks the duplicate on the server; owner = this expert, registered_by = this expert, lead source «تماس ورودی»,
 *  «قانون ثبت» not applied, no priority (no non-P1 hand-off), not urgent, and NO notifyNewCustomer (no Telegram / SMS / Bale / welcome / intro). */
export function elNewCreate(u: U, body: Record<string, unknown> | undefined, now = new Date()): ElNewResult {
  ensureElSchema(); const at = now.toISOString();
  if (rateLimited(u, now)) { log(u, { action: "search_limited", result: "rate_limited" }, at); return RATE_LIMITED; }
  const phone = mobileOf(body?.phone);
  if (!phone) { log(u, { action: "new_create", kind: "invalid", result: "invalid" }, at); return INVALID_PHONE; }
  const hash = hashQuery("phone", phone);
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();
  if ([...name].length < 3 || [...name].length > EL_NEW_NAME_MAX || /[\d۰-۹٠-٩]/.test(name) || !name.includes(" ")) {
    log(u, { action: "new_create", kind: "phone", hash, result: "invalid" }, at);
    return { result: "invalid", field: "name", message: "نام و نام خانوادگی مشتری را کامل بنویس (بدون عدد)." };
  }
  const note = typeof body?.description === "string" ? body.description.trim() : "";
  if ([...note].length > EL_NEW_NOTE_MAX) { log(u, { action: "new_create", kind: "phone", hash, result: "invalid" }, at);
    return { result: "invalid", field: "description", message: "توضیح حداکثر ۵۰۰ نویسه است." }; }
  const dupe = phoneOwner(phone);
  if (dupe) { log(u, { action: "new_create", kind: "phone", hash, result: "duplicate", customerId: Number(dupe.id), ownerSp: dupe.sp == null ? null : Number(dupe.sp) }, at); return dupResult(u, dupe); }
  let id: number;
  try {
    id = runTransaction(() => {
      const newId = insertCustomerRecord({ name, phone, description: note || null, registeredByUserId: Number(u.id), registrationSource: "staff_form",
        assignedSalespersonId: Number(u.salespersonId), intake: { leadSource: "inbound_call" }, skipDefaultOwnerRule: true });
      log(u, { action: "new_create", kind: "phone", hash, result: "created", customerId: newId, ownerSp: Number(u.salespersonId) }, at);
      return newId;
    });
  } catch (error) {
    if (error instanceof Error && /ACTIVE_CUSTOMER_(MOBILE|NATIONAL_CODE)_CONFLICT/.test(error.message)) {
      const o = phoneOwner(phone);
      log(u, { action: "new_create", kind: "phone", hash, result: "duplicate", customerId: o ? Number(o.id) : null, ownerSp: o?.sp == null ? null : Number(o.sp) }, at);
      return o ? dupResult(u, o) : { result: "duplicate", ownerName: "بدون کارشناس", mine: false };
    }
    throw error;
  }
  return { result: "created", customer: { id, name } };
}


export type ElSearchResult =
  | { result: "own"; customer: { id: number; name: string }; windowMinutes: number }
  | { result: "other"; ownerName: string; notified: boolean }
  | { result: "none" | "ambiguous" | "invalid" | "rate_limited"; message: string };

export function elIncomingSearch(u: U, raw: unknown, now = new Date()): ElSearchResult {
  ensureElSchema();
  const at = now.toISOString();
  const recent = Number(queryRow<{ n: number }>("SELECT count(*) n FROM el_incoming_log WHERE user_id=? AND action IN ('search','new_check','new_create') AND created_at>?",
    [Number(u.id), new Date(now.getTime() - EL_SEARCH_WINDOW_MS).toISOString()])?.n ?? 0);
  if (recent >= EL_SEARCH_LIMIT) { log(u, { action: "search_limited", result: "rate_limited" }, at);
    return { result: "rate_limited", message: "تعداد جست‌وجوها زیاد شد؛ چند دقیقه بعد دوباره امتحان کن." }; }
  const lk = exactLookupOf(String(raw ?? "").slice(0, 120));
  if (!lk || lk.kind === "id") { log(u, { action: "search", kind: lk?.kind ?? "invalid", result: "invalid" }, at);
    return { result: "invalid", message: "شماره‌ی موبایل کامل (۱۱ رقم) یا نام و نام خانوادگی کامل مشتری را بنویس." }; }
  const hash = hashQuery(lk.kind, lk.kind === "phone" ? lk.phone : lk.name);
  const match = lk.kind === "phone"
    ? { sql: "crm_customer_mobile_key(c.phone)=?", p: lk.phone }
    : { sql: "trim(replace(replace(replace(replace(crm_persian_search_key(c.name),char(8204),' '),'   ',' '),'  ',' '),'  ',' '))=?", p: lk.name };
  const rows = queryRows<{ id: number; name: string; sp: number | null; owner_name: string | null }>(
    `SELECT c.id, c.name, c.salesperson_id sp, s.name owner_name FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
      WHERE c.merged_into_customer_id IS NULL AND ${match.sql} ORDER BY c.id LIMIT 3`, [match.p]);
  if (!rows.length) { log(u, { action: "search", kind: lk.kind, hash, result: "none" }, at);
    return { result: "none", message: "مشتری‌ای با این مشخصات پیدا نشد." }; }
  if (rows.length > 1) { log(u, { action: "search", kind: lk.kind, hash, result: "ambiguous" }, at);
    return { result: "ambiguous", message: "بیش از یک مشتری با این نام هست؛ با شماره‌ی موبایل کامل جست‌وجو کن." }; }
  const c = rows[0];
  if (Number(c.sp) === Number(u.salespersonId)) {
    execute("INSERT INTO el_grants(user_id,customer_id,source,granted_at,expires_at) VALUES(?,?,?,?,?)",
      [Number(u.id), Number(c.id), "incoming_call", at, new Date(now.getTime() + EL_GRANT_MINUTES * 60_000).toISOString()]);
    log(u, { action: "search", kind: lk.kind, hash, result: "own", customerId: Number(c.id), ownerSp: Number(c.sp) }, at);
    return { result: "own", customer: { id: Number(c.id), name: String(c.name ?? "") }, windowMinutes: EL_GRANT_MINUTES };
  }
  // another expert's (or nobody's) customer: owner name only + one CRM bell to the owner
  let notified = false;
  const owner = c.sp == null ? null : queryRow<{ id: number }>("SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' AND active=1 ORDER BY id LIMIT 1", [Number(c.sp)]);
  if (owner && Number(owner.id) !== 29) {
    const dup = queryRow("SELECT 1 x FROM el_incoming_log WHERE user_id=? AND customer_id=? AND notified=1 AND created_at>? LIMIT 1",
      [Number(u.id), Number(c.id), new Date(now.getTime() - EL_BELL_WINDOW_MS).toISOString()]);
    if (!dup) {
      if (process.env.DP_TEST_NO_BELLS === "1") {
        execute("CREATE TABLE IF NOT EXISTS dp_test_bells(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, resource_id INTEGER, recipient_user_id INTEGER, title TEXT, created_at TEXT)");
        execute("INSERT INTO dp_test_bells(kind,resource_id,recipient_user_id,title,created_at) VALUES(?,?,?,?,?)", ["incoming-call", Number(c.id), Number(owner.id), "تماس ورودی", at]);
      } else {
        const caller = String(u.fullName ?? "").trim() || "یکی از همکاران";
        execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
          VALUES(?,?,?,'customer',?,'incoming-call','تماس ورودی',?,'customers.view',?,?,?)`,
          [Number(c.id), String(c.name || "مشتری"), Number(c.sp), Number(c.id), `مشتری‌ات با ${caller} تماس گرفته؛ با او تماس بگیر.`, at, `expert-lockdown:${Number(u.id)}`, Number(owner.id)]);
      }
      notified = true;
    }
  }
  log(u, { action: "search", kind: lk.kind, hash, result: "other", customerId: Number(c.id), ownerSp: c.sp == null ? null : Number(c.sp), notified }, at);
  return { result: "other", ownerName: String(c.owner_name ?? "") || "بدون کارشناس", notified };
}

/* ---------------- SEARCH-65b: live «تماس ورودی داشتم» search (own customers only) ---------------- */
export const EL_SUGGEST_MAX = 8;
export const EL_SUGGEST_PER_MIN = 90;          // keystroke-debounced calls per user per minute (in memory; not logged)
const suggestHits = new Map<number, number[]>();
const toLatin = (v: string) => v.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
/** Name key: Persian ي/ى→ی, ك→ک, ZWNJ / tatweel / any whitespace → one space. Same mapping as crm_persian_search_key + ZWNJ folding. */
export function elNameKey(v: unknown): string {
  return toLatin(String(v ?? "").normalize("NFC")).replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[\u200c\u200d\u200e\u200f\u0640]/g, " ").replace(/\s+/g, " ").trim();
}
/** Phone query: Persian/Arabic digits → Latin; spaces, dashes, dots, parentheses dropped; +98 / 0098 / 98 / leading 9 → 09 form. null = not a phone query. */
export function elPhoneQuery(raw: unknown): { digits: string; canon: string } | null {
  const s = toLatin(String(raw ?? "")).replace(/[\s\-–—_.()\[\]\/]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  const d = s.replace(/^\+/, "");
  let canon = d;
  if (/^0098/.test(d)) canon = `0${d.slice(4)}`;
  else if (s.startsWith("+98") || /^989/.test(d)) canon = `0${d.slice(2)}`;
  else if (/^9/.test(d)) canon = `0${d}`;
  return { digits: d, canon };
}
const likeEsc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
export type ElSuggestItem = { id: number; name: string; phoneLast4: string; priority: number | null; match: "exact" | "phone" | "name" };
export type ElSuggestResult = { result: "ok"; kind: "phone" | "name"; items: ElSuggestItem[]; phone?: string } | { result: "short" | "rate_limited"; message: string };

export function elIncomingSuggest(u: U, raw: unknown, now = Date.now()): ElSuggestResult {
  const uid = Number(u.id), sp = Number(u.salespersonId);
  const hits = (suggestHits.get(uid) ?? []).filter((t) => t > now - 60_000);
  if (hits.length >= EL_SUGGEST_PER_MIN) { suggestHits.set(uid, hits); return { result: "rate_limited", message: "کمی صبر کن و دوباره بنویس." }; }
  hits.push(now); suggestHits.set(uid, hits);
  ensureElSchema();
  const q = String(raw ?? "").slice(0, 60);
  const ph = elPhoneQuery(q);
  type Row = { id: number; name: string; phone: string | null; priority: number | null; rk: number };
  const out = (rows: Row[], kind: "phone" | "name", phone?: string): ElSuggestResult => ({ result: "ok", kind, phone,
    items: rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), phoneLast4: String(r.phone ?? "").slice(-4),
      priority: r.priority == null ? null : Number(r.priority), match: r.rk === 0 ? "exact" : kind === "phone" ? "phone" : "name" })) });
  if (ph) {
    if (ph.digits.length < 4) return { result: "short", message: "حداقل ۴ رقم بنویس." };
    const d = likeEsc(ph.digits), c = likeEsc(ph.canon);
    // exact (0) → canonical prefix (1) → suffix (2) → anywhere (3); own, not merged; uses idx_customers_sp_phone.
    const rows = queryRows<Row>(`SELECT c.id, c.name, c.phone, c.priority,
        CASE WHEN c.phone=? THEN 0 WHEN c.phone LIKE ? ESCAPE '\\' THEN 1 WHEN c.phone LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END rk
      FROM customers c WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL
        AND (c.phone LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')
      ORDER BY rk, c.id DESC LIMIT ${EL_SUGGEST_MAX}`,
      [ph.canon, `${c}%`, `%${d}`, sp, `%${d}%`, `${c}%`]);
    return out(rows, "phone", /^09\d{9}$/.test(ph.canon) ? ph.canon : undefined);
  }
  const key = elNameKey(q);
  if (key.replace(/\s/g, "").length < 2) return { result: "short", message: "حداقل ۲ حرف بنویس." };
  const toks = key.split(" ").filter(Boolean).slice(0, 4);
  // name key in SQL: same folding as elNameKey (ي/ك via crm_persian_search_key, ZWNJ / tatweel → space, Persian/Arabic digits → Latin).
  let nk = "replace(replace(crm_persian_search_key(c.name),char(8204),' '),char(1600),' ')";
  for (const [i, d] of [..."۰۱۲۳۴۵۶۷۸۹"].entries()) nk = `replace(${nk},'${d}','${i}')`;
  for (const [i, d] of [..."٠١٢٣٤٥٦٧٨٩"].entries()) nk = `replace(${nk},'${d}','${i}')`;
  const rows = queryRows<Row>(`SELECT c.id, c.name, c.phone, c.priority,
      CASE WHEN ${nk}=? THEN 0 WHEN ${nk} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END rk
    FROM customers c WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL
      AND ${toks.map(() => `${nk} LIKE ? ESCAPE '\\'`).join(" AND ")}
    ORDER BY rk, c.id DESC LIMIT ${EL_SUGGEST_MAX}`,
    [key, `${likeEsc(key)}%`, sp, ...toks.map((t) => `%${likeEsc(t)}%`)]);
  return out(rows, "name");
}

/** SEARCH-65b: tapping one live result = the existing «own» path (30-min window + log), scoped to the expert's own customer. */
export function elIncomingPick(u: U, rawId: unknown, now = new Date()): ElSearchResult {
  ensureElSchema();
  const at = now.toISOString();
  const id = Number(rawId);
  const c = Number.isSafeInteger(id) && id > 0
    ? queryRow<{ id: number; name: string; sp: number | null }>("SELECT id, name, salesperson_id sp FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]) : null;
  if (!c || Number(c.sp) !== Number(u.salespersonId)) { log(u, { action: "pick", kind: "pick", result: "none" }, at);
    return { result: "none", message: "این مشتری در فهرست مشتری‌های تو نیست." }; }
  execute("INSERT INTO el_grants(user_id,customer_id,source,granted_at,expires_at) VALUES(?,?,?,?,?)",
    [Number(u.id), Number(c.id), "incoming_call", at, new Date(now.getTime() + EL_GRANT_MINUTES * 60_000).toISOString()]);
  log(u, { action: "pick", kind: "pick", result: "own", customerId: Number(c.id), ownerSp: Number(c.sp) }, at);
  return { result: "own", customer: { id: Number(c.id), name: String(c.name ?? "") }, windowMinutes: EL_GRANT_MINUTES };
}

/** Admin card: per-expert counts for one Tehran day. */
export function elDailyCounts(day: string) {
  ensureElSchema();
  const from = new Date(`${day}T00:00:00+03:30`).toISOString(), to = new Date(new Date(`${day}T00:00:00+03:30`).getTime() + 86_400_000).toISOString();
  const rows = queryRows<any>(`SELECT l.user_id, s.name, SUM(action='open') opens, SUM(action='search') searches, SUM(result='own') own,
      SUM(result='other') other, SUM(result IN ('none','ambiguous','invalid')) none, SUM(action='search_limited') limited, SUM(notified) bells
    FROM el_incoming_log l LEFT JOIN salespersons s ON s.id=l.salesperson_id WHERE l.created_at>=? AND l.created_at<? GROUP BY l.user_id ORDER BY l.user_id`, [from, to]);
  const logged = (sp: number) => queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='dp_items'")
    ? Number(queryRow<{ n: number }>("SELECT count(*) n FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id WHERE p.salesperson_id=? AND p.day=? AND i.bucket='outside'", [sp, day])?.n ?? 0) : 0;
  const experts = Object.entries(EL_USERS).map(([uid, sp]) => {
    const r = rows.find((x) => Number(x.user_id) === Number(uid));
    const name = r?.name ?? queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [sp])?.name ?? "";
    return { userId: Number(uid), salespersonId: sp, name, opens: Number(r?.opens ?? 0), searches: Number(r?.searches ?? 0), own: Number(r?.own ?? 0),
      other: Number(r?.other ?? 0), none: Number(r?.none ?? 0), limited: Number(r?.limited ?? 0), bells: Number(r?.bells ?? 0), loggedOutOfList: logged(sp) };
  });
  return { day, flag: elFlagOn(), experts };
}
