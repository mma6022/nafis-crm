/**
 * «دستیار هوشمند» — per-expert assistants (phase A v1).
 *
 * Four assistants: سمیه (Hasani, sp 3), محدثه (Ghasemi, sp 4), مسعود (Kazemi, sp 6) — kind "sales", bound to one
 * expert — and سارینا, kind "filing", bound to the registrar role («ثبت»), not to any expert.
 * An assistant is an outside runner (no inbound port) that talks to /api/assistant-runner with its own Bearer token
 * (sha256-hashed in assistant_tokens; separate from the smart-filing runner tokens, which stay untouched).
 *
 * Server-side scope (every runner read and write):
 *  - sales assistant: customers of its own expert (P1-only for closers), not merged/cancelled/completed;
 *  - Sarina: exactly the registrar smart-filing view — customers with a real smart-filing job on a panel-linked plan,
 *    plus customers with a panel-linked application in the funder-registration stage; every Sarina message is bound
 *    to such a case and recipients are ONLY the registrars and the admins (v6 decision: Sarina belongs to «ثبت» only —
 *    sales experts never get a Sarina thread, message, event or bell row; old rows stay in the DB and are filtered at read time).
 *  - never: priority, assignment, money, contracts, case advancement, SMS, customer messages. Trainees see nothing.
 * Out-of-scope customer → 404 not_found (+ audit); disabled → 423; bad/revoked token → 401; banned words → 422.
 *
 * v8 «احمد» — the sales-manager assistant (piece A). Talks ONLY to admins (never user 29). Reads every expert's customers,
 * trainees 5/19/20 included READ-ONLY (approved 10:18; flagged trainee:true), user 29 never; calls, notes, reminders and cases, plus /manager/* reports, alerts and the ready summaries.
 * Writes only chat messages / notifications to an admin and its own assistant notes; never reminders or proposals.
 * Storage: the assistants.kind CHECK only allows sales|filing (no destructive migration), so the row is kind='sales' with
 * scope_rule='manager', bound_role='admin' and no bound expert. Every load goes through norm(), which reports kind 'manager';
 * code that does not normalize (or an older release after a rollback) sees a sales row with no expert → scope "0", nobody eligible.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureSchemaObject } from "./schema-objects";
import { maskData, maskText, maskPhone } from "./smart-filing";
import { expertCallsToday, EXPERT_CALLS_DEFINITION, tehranDayStartMs } from "./expert-calls";
import { customerApplicationPayout } from "./customer-application-payout";
import { parseConsultAmountToman } from "./consultation-report";
import { EXCLUDE_TEST_CUSTOMERS_KEY, excludeTestOn, testCustomerSql, testCustomerIds } from "./test-customers";
import { openInvoices, registrationReport, REGISTRATION_RANGES, type RegistrationRange } from "./manager-work";
import { PAGE_USAGE_ENABLED_KEY, PAGE_USAGE_RANGES, ensurePageUsageSchema, pageUsageOn, pageUsageReport, recordPageUsage, type PageUsageRange } from "./page-usage";
import { MANAGER_RANGES, MANAGER_SLOTS, MANAGER_SETTING_KEYS, MANAGER_DEFAULTS, managerAlerts, managerExperts, managerReport, managerSummary,
  readManagerSettings, validateManagerSettings, type ManagerRange, type ManagerSlot, type SiteLeadLite } from "./assistant-manager";

export type Db = DatabaseSync;
export type Actor = { id: number; role: string; salespersonId: number | null; name: string };
/** v7: read-only CRM views injected by routes/assistants.ts so the runner reuses the exact CRM logic (never a copy). */
export type SalesReads = {
  /** lib/sales-assist.ts suggestionsFor — the «۳ مشتری پیشنهادی» box (site lead → from Kazemi → score). Pure read. */
  suggestions?: (salespersonId: number, now: Date) => { items: any[]; pool: number };
  /** lib/sales-assist.ts todayCounts — the box's «امروز» counters. */
  today?: (salespersonId: number, now: Date) => { calls: number; notNow: number };
  /** lib/consult-profile.ts consultProfile — «اطلاعات مشاوره» card (append-only versions). */
  consultProfile?: (customerId: number) => { latest: any; versions: any[] };
  /** lib/site-leads.ts siteLeadHistory — site/callback requests with the preferred call time. */
  siteLeadHistory?: (customerId: number) => any[];
  /** v8 manager: lib/site-leads.ts activeSiteLeads (unanswered site/callback requests with their call deadline). Pure read. */
  activeSiteLeads?: (now: Date) => Map<number, SiteLeadLite>;
};
export type Deps = { db: Db; now?: () => Date; actor: (res: Response) => Actor | null; sales?: SalesReads;
  /** Extra runner routes owned by another module (e.g. Bale POST /bale/send); mounted after auth, before the deny-by-default catch-all. */
  extendRunner?: (runner: Router, h: { inScope: (a: any, customerId: number) => boolean }) => void };

export const TRAINEE_SALESPERSON_IDS = [5, 19, 20];
export const EXCLUDED_USER_IDS = [29];
export const MAX_WAIT_S = 25;
export const STAFF_MAX_WAIT_S = 20;
export const LONG_POLL_TICK_MS = 1000;
export const MAX_WAITERS_PER_TOKEN = 6;
export const ONLINE_MS = 90_000;
export const MAX_BODY = 2000;
export const HIGH_PER_HOUR = 3;
export const BANNED_WORDS = ["سپرده", "برآورد", "تخمینی"];
const KINDS = ["text", "suggestion", "alert", "digest", "brief", "report"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;
const ACTIONS = ["call", "remind", "copy", "later"] as const;
export const REMINDER_PROPOSAL_MAX_DAYS = 30;

export const SEED = [
  { slug: "somayeh", name: "سمیه", kind: "sales", salespersonId: 3, scopeRule: "p1" },
  { slug: "mohaddeseh", name: "محدثه", kind: "sales", salespersonId: 4, scopeRule: "p1" },
  { slug: "masoud", name: "مسعود", kind: "sales", salespersonId: 6, scopeRule: "all" },
  { slug: "sarina", name: "سارینا", kind: "filing", salespersonId: null, scopeRule: "registrar" },
  // v8: stored as kind 'sales' (CHECK constraint) + scope_rule 'manager'; see norm().
  { slug: "ahmad", name: "احمد", kind: "manager", salespersonId: null, scopeRule: "manager" },
] as const;
/** Row → in-memory view: the manager row is reported as kind 'manager'. */
export function normAssistant<T extends { kind?: string; scope_rule?: string } | undefined | null>(a: T): T {
  if (a && a.scope_rule === "manager" && a.kind === "sales") return { ...a, kind: "manager" } as T;
  return a;
}

export function ensureAssistantSchema(db: Db, nowIso = new Date().toISOString()): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS assistants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('sales','filing')), bound_user_id INTEGER, bound_salesperson_id INTEGER, bound_role TEXT,
    scope_rule TEXT NOT NULL DEFAULT 'all', enabled INTEGER NOT NULL DEFAULT 0, max_msgs_per_hour INTEGER NOT NULL DEFAULT 6,
    last_seen_at TEXT, last_seen_ip TEXT, acked_event_id INTEGER NOT NULL DEFAULT 0, call_watermark INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
  CREATE TABLE IF NOT EXISTS assistant_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assistant_id INTEGER NOT NULL REFERENCES assistants(id), name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, created_by_user_id INTEGER,
    last_used_at TEXT, last_used_ip TEXT, revoked_at TEXT, revoked_by_user_id INTEGER);
  CREATE TABLE IF NOT EXISTS assistant_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assistant_id INTEGER NOT NULL REFERENCES assistants(id), user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(assistant_id, user_id));
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES assistant_threads(id),
    author TEXT NOT NULL CHECK(author IN ('user','assistant','system')), author_label TEXT,
    kind TEXT NOT NULL DEFAULT 'text', priority TEXT NOT NULL DEFAULT 'normal', body TEXT NOT NULL,
    customer_id INTEGER, actions_json TEXT, client_id TEXT, origin TEXT NOT NULL DEFAULT 'runner',
    created_at TEXT NOT NULL, picked_at TEXT, delivered_at TEXT, read_at TEXT, acted_at TEXT, action_taken TEXT,
    suppressed_reason TEXT, UNIQUE(thread_id, author, client_id));
  CREATE TABLE IF NOT EXISTS assistant_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assistant_id INTEGER NOT NULL REFERENCES assistants(id), type TEXT NOT NULL,
    thread_id INTEGER, user_id INTEGER, customer_id INTEGER, message_id INTEGER, data_json TEXT, created_at TEXT NOT NULL,
    picked_at TEXT);
  CREATE TABLE IF NOT EXISTS assistant_typing (thread_id INTEGER PRIMARY KEY, until TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_customer_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assistant_id INTEGER NOT NULL REFERENCES assistants(id), customer_id INTEGER NOT NULL,
    body TEXT NOT NULL, author_label TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_user_prefs (
    user_id INTEGER PRIMARY KEY, sound INTEGER NOT NULL DEFAULT 1, dnd_until TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assistant_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, assistant_id INTEGER, token_id INTEGER, user_id INTEGER, ip TEXT,
    actor_label TEXT, action TEXT NOT NULL, customer_id INTEGER, outcome TEXT NOT NULL, detail_json TEXT);
  CREATE TABLE IF NOT EXISTS assistant_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
  CREATE TABLE IF NOT EXISTS assistant_reminder_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, assistant_id INTEGER NOT NULL REFERENCES assistants(id), user_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL, remind_at TEXT NOT NULL, note TEXT, reason TEXT, message_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','expired')),
    decided_by_user_id INTEGER, decided_at TEXT, reminder_id INTEGER, created_at TEXT NOT NULL);
  `);
  ensureSchemaObject(db, "index", "idx_assistant_messages_thread", "CREATE INDEX idx_assistant_messages_thread ON assistant_messages(thread_id, id)");
  ensureSchemaObject(db, "index", "idx_assistant_events_assistant", "CREATE INDEX idx_assistant_events_assistant ON assistant_events(assistant_id, id)");
  ensureSchemaObject(db, "index", "idx_assistant_audit_assistant", "CREATE INDEX idx_assistant_audit_assistant ON assistant_audit(assistant_id, id)");
  ensureSchemaObject(db, "index", "idx_assistant_tokens_assistant", "CREATE INDEX idx_assistant_tokens_assistant ON assistant_tokens(assistant_id)");
  // Seed once (all disabled, global switch off). Bound users are looked up via salesperson_id, never hard-coded.
  db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES('global_enabled','0',?)").run(nowIso);
  // «اجازه‌ی استعلام»: who may grant the credit-inquiry permission in smart filing (manager|expert). Default manager.
  // Read-only for now: the live smart-filing flow has no expert permission step yet, so nothing consumes it.
  db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES('credit_inquiry_permission','manager',?)").run(nowIso);
  // v8 manager thresholds (new keys only — notification_settings / team_sales_config are not touched).
  for (const [k, key] of Object.entries(MANAGER_SETTING_KEYS))
    db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES(?,?,?)").run(key, String((MANAGER_DEFAULTS as any)[k]), nowIso);
  // Task B: «پیشنهاد دستیار فروش» P1 daily quota + red threshold (new keys only, INSERT OR IGNORE).
  db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES('sales_assist_p1_quota','10',?)").run(nowIso);
  db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES('sales_assist_p1_red_days','7',?)").run(nowIso);
  for (const s of SEED) {
    if (db.prepare("SELECT 1 FROM assistants WHERE slug=?").get(s.slug)) continue;
    const u = s.salespersonId
      ? db.prepare("SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' ORDER BY id LIMIT 1").get(s.salespersonId) as { id: number } | undefined
      : undefined;
    db.prepare(`INSERT INTO assistants(slug,display_name,kind,bound_user_id,bound_salesperson_id,bound_role,scope_rule,enabled,max_msgs_per_hour,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,0,6,?,?)`).run(s.slug, s.name, s.kind === "manager" ? "sales" : s.kind, u?.id ?? null, s.salespersonId,
        s.kind === "filing" ? "registrar" : s.kind === "manager" ? "admin" : null, s.scopeRule, nowIso, nowIso);
  }
  ensurePageUsageSchema(db); // v10: additive table page_usage_events + 2 indexes
}

/** ي/ك → ی/ک, drop ZWNJ/zero-width + tatweel, آ → ا, so «برآورد»/«براورد»/«برآ‌ورد» (ZWNJ inside) all match. */
export function normalizeFa(s: string): string {
  return String(s).replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\u200b-\u200f\u0640]/g, "").replace(/آ/g, "ا");
}
export function hasBannedWord(s: string): boolean {
  const n = normalizeFa(s).replace(/\s+/g, "");
  return BANNED_WORDS.some(w => n.includes(normalizeFa(w)));
}
export const hashAssistantToken = (t: string) => createHash("sha256").update(t).digest("hex");
/** Tehran quiet hours 20:00–08:30 (Iran has no DST). */
export function inQuietHours(d: Date): boolean {
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 210) % 1440;
  return m >= 20 * 60 || m < 8 * 60 + 30;
}

export function createAssistants(deps: Deps) {
  const db = deps.db;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const row = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const ip = (req: Request) => String((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "").slice(0, 64);
  const fail = (res: Response, status: number, error: string, message?: string) => { if (!res.headersSent) res.status(status).json({ error, ...(message ? { message } : {}) }); };
  const label = (a: any) => a.scope_rule === "manager" ? `${a.display_name} | مدیر فروش` : `دستیار ${a.display_name}`;
  const setting = (k: string, d: string) => row<{ value: string }>("SELECT value FROM assistant_settings WHERE key=?", k)?.value ?? d;
  const globalOn = () => row<{ value: string }>("SELECT value FROM assistant_settings WHERE key='global_enabled'")?.value === "1";
  const online = (a: any) => Boolean(a?.last_seen_at && now().getTime() - Date.parse(a.last_seen_at) < ONLINE_MS);

  function audit(o: { req?: Request; a?: any; tokenId?: number | null; userId?: number | null; actorLabel?: string; action: string; customerId?: number | null; outcome: string; detail?: unknown }) {
    run(`INSERT INTO assistant_audit(at,assistant_id,token_id,user_id,ip,actor_label,action,customer_id,outcome,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      iso(), o.a?.id ?? null, o.tokenId ?? null, o.userId ?? null, o.req ? ip(o.req) : null, o.actorLabel ?? (o.a ? label(o.a) : null),
      o.action, o.customerId ?? null, o.outcome, o.detail === undefined ? null : JSON.stringify(o.detail));
  }

  /* ---------------- scope ---------------- */
  const SF_PLAN = "COALESCE(a.plan_id, CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END)";
  const hasTable = (n: string) => Boolean(row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", n));
  /** SQL predicate over alias `c` + params: the customers this assistant may see. */
  function scopeSql(a: any): { sql: string; params: any[] } {
    const base = "c.merged_into_customer_id IS NULL";
    if (a.kind === "manager") {
      const ids = managerExperts(db).map(e => e.salespersonId); // v8: trainees included read-only (approved); user 29 excluded in managerExperts
      if (!ids.length) return { sql: "0", params: [] };
      return { sql: `${base} AND c.salesperson_id IN (${ids.map(() => "?").join(",")}) AND COALESCE(c.status,'') NOT IN ('cancelled','completed')`, params: ids };
    }
    if (a.kind === "sales" && a.scope_rule === "manager") return { sql: "0", params: [] }; // un-normalized manager row: fail closed
    if (a.kind === "sales") {
      if (!a.bound_salesperson_id || TRAINEE_SALESPERSON_IDS.includes(a.bound_salesperson_id)) return { sql: "0", params: [] };
      return { sql: `${base} AND c.salesperson_id=? AND COALESCE(c.status,'') NOT IN ('cancelled','completed')${a.scope_rule === "p1" ? " AND c.priority=1" : ""}`, params: [a.bound_salesperson_id] };
    }
    if (!hasTable("smart_filing_jobs") || !hasTable("smart_filing_panel_plans")) return { sql: "0", params: [] };
    return { sql: `${base} AND (EXISTS(SELECT 1 FROM smart_filing_jobs j JOIN smart_filing_panel_plans pp ON pp.plan_id=j.plan_id AND pp.panel_id=j.panel_id
        WHERE j.customer_id=c.id AND j.job_type='real')
      OR EXISTS(SELECT 1 FROM loan_applications a WHERE a.customer_id=c.id AND a.deleted_at IS NULL AND a.stage='funder_initial_approval'
        AND a.status='reviewing' AND ${SF_PLAN} IN (SELECT plan_id FROM smart_filing_panel_plans)))`, params: [] };
  }
  function inScope(a: any, customerId: number): boolean {
    if (!Number.isSafeInteger(customerId) || customerId < 1) return false;
    const s = scopeSql(a);
    return Boolean(row(`SELECT 1 FROM customers c WHERE c.id=? AND ${s.sql}`, customerId, ...s.params));
  }
  /** Humans who may chat with this assistant at all. */
  function userEligible(a: any, u: { id: number; role: string; salesperson_id: number | null; active?: number }): boolean {
    if (!u || EXCLUDED_USER_IDS.includes(u.id) || u.active === 0) return false;
    if (u.role === "salesperson" && (!u.salesperson_id || TRAINEE_SALESPERSON_IDS.includes(u.salesperson_id))) return false;
    if (a.kind === "manager") return u.role === "admin"; // v8: Ahmad talks to admins only (29 excluded above)
    if (a.scope_rule === "manager") return false; // un-normalized manager row: fail closed
    if (a.kind === "sales") return u.id === a.bound_user_id && u.role === "salesperson";
    return u.role === "registrar" || u.role === "admin"; // v6: Sarina is registrar/admin only
  }
  /** v6: Sarina may never address a sales expert (or anyone outside registrar/admin). */
  const filingRecipientBlocked = (a: any, u: any) => a.kind === "filing" && Boolean(u) && u.role !== "registrar" && u.role !== "admin";
  /** For Sarina: may this user see a message bound to this customer? (registrar/admin all in-scope; sales only own). */
  function userSeesCase(a: any, u: any, customerId: number | null): boolean {
    if (a.kind === "sales") return customerId == null || inScope(a, customerId);
    if (a.kind === "manager") return u?.role === "admin" && !EXCLUDED_USER_IDS.includes(Number(u?.id)) && (customerId == null || inScope(a, customerId));
    if (u?.role !== "registrar" && u?.role !== "admin") return false; // v6: Sarina lines only for registrar/admin
    if (customerId == null) return true; // user-authored, case-less lines in registrar/admin threads
    return inScope(a, customerId);
  }
  const userRow = (id: number) => row<any>("SELECT id,role,salesperson_id,active,full_name,username FROM users WHERE id=?", id);
  function threadFor(a: any, userId: number, create: boolean) {
    let t = row<any>("SELECT * FROM assistant_threads WHERE assistant_id=? AND user_id=?", a.id, userId);
    if (!t && create) { run("INSERT OR IGNORE INTO assistant_threads(assistant_id,user_id,created_at) VALUES(?,?,?)", a.id, userId, iso()); t = row<any>("SELECT * FROM assistant_threads WHERE assistant_id=? AND user_id=?", a.id, userId); }
    return t;
  }
  function prefsOf(userId: number) {
    const p = row<any>("SELECT * FROM assistant_user_prefs WHERE user_id=?", userId);
    const dnd = Boolean(p?.dnd_until && Date.parse(p.dnd_until) > now().getTime());
    return { sound: p ? Boolean(p.sound) : true, dndUntil: dnd ? p.dnd_until : null, dnd, quiet: inQuietHours(now()) };
  }
  function event(a: any, type: string, f: { threadId?: number | null; userId?: number | null; customerId?: number | null; messageId?: number | null; data?: unknown }) {
    run("INSERT INTO assistant_events(assistant_id,type,thread_id,user_id,customer_id,message_id,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      a.id, type, f.threadId ?? null, f.userId ?? null, f.customerId ?? null, f.messageId ?? null, f.data === undefined ? null : JSON.stringify(f.data), iso());
  }
  /** v3 bell: one row in the CRM's existing notification bell (site_notification_events), addressed to the thread's user only.
   *  Case-bound lines only: every Sarina case line; for sales assistants alerts, suggestions, reminder proposals, reports and any
   *  high-priority line (plain chat replies stay in the chat). Never digested lines; DND-held lines do land (the bell is silent).
   *  The actor_key is set so the request-local actor trigger leaves the row (and its recipient) untouched. */
  let bellReady = false;
  const BELL_KINDS: Record<string, string> = { alert: "هشدار", suggestion: "پیشنهاد", reminder_proposal: "پیشنهاد یادآور", brief: "گزارش", report: "گزارش" };
  function bell(a: any, m: any, u: any) {
    if (m.suppressed_reason === "digested" || m.customer_id == null) return;
    if (a.kind !== "filing" && !BELL_KINDS[m.kind] && m.priority !== "high") return; // sales chat replies stay in the chat
    if (filingRecipientBlocked(a, u)) return; // v6: never a Sarina bell row for a sales expert
    if (!userEligible(a, u) || !userSeesCase(a, u, m.customer_id)) return;
    if (!bellReady) bellReady = hasTable("site_notification_events") && rows<{ name: string }>("PRAGMA table_info(site_notification_events)").some(c => c.name === "recipient_user_id");
    if (!bellReady) return;
    const c = row<any>("SELECT name,salesperson_id FROM customers WHERE id=?", m.customer_id); if (!c) return;
    const kindFa = BELL_KINDS[m.kind] ?? "پیام";
    run(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(?,?,?,'assistant',?,'assistant-message',?,?,'assistant.recipient',?,?,?)`,
      m.customer_id, c.name || "مشتری", c.salesperson_id ?? null, m.id, `${label(a)} · ${kindFa}${m.priority === "high" ? " · فوری" : ""}`,
      String(m.body).slice(0, 160), iso(), `assistant:${a.slug}`, u.id);
  }
  /** Reading the chat marks the matching bell rows read for that user (and only those). */
  function bellRead(threadId: number, userId: number, upTo: number) {
    if (!bellReady) bellReady = hasTable("site_notification_events") && rows<{ name: string }>("PRAGMA table_info(site_notification_events)").some(c => c.name === "recipient_user_id");
    if (!bellReady || !hasTable("site_notification_reads")) return;
    run(`INSERT INTO site_notification_reads(user_id,event_id,read_at) SELECT ?,e.id,? FROM site_notification_events e
      WHERE e.recipient_user_id=? AND e.resource_type='assistant' AND e.resource_id IN (SELECT id FROM assistant_messages WHERE thread_id=? AND author<>'user' AND id<=?)
      ON CONFLICT(user_id,event_id) DO NOTHING`, userId, iso(), userId, threadId, upTo);
  }
  /** call_logged events for in-scope customers since the watermark (watermark starts at "now" — no backfill flood). */
  function syncCallEvents(a: any) {
    if (a.kind !== "sales") return;
    const max = Number(row<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM call_logs")?.m ?? 0);
    if (a.call_watermark == null) { run("UPDATE assistants SET call_watermark=? WHERE id=?", max, a.id); a.call_watermark = max; return; }
    if (max <= a.call_watermark) return;
    const s = scopeSql(a);
    for (const cl of rows<any>(`SELECT l.id,l.customer_id,l.subject,l.created_at FROM call_logs l JOIN customers c ON c.id=l.customer_id
        WHERE l.id>? AND l.id<=? AND ${s.sql} ORDER BY l.id LIMIT 200`, a.call_watermark, max, ...s.params))
      event(a, "call_logged", { customerId: cl.customer_id, data: { callId: cl.id, subject: maskText(cl.subject ?? "").slice(0, 200), at: cl.created_at } });
    run("UPDATE assistants SET call_watermark=? WHERE id=?", max, a.id); a.call_watermark = max;
  }

  function proposalView(p: any) {
    if (!p) return null;
    const status = p.status === "pending" && Date.parse(p.remind_at) <= now().getTime() ? "expired" : p.status;
    return { id: Number(p.id), customerId: p.customer_id, remindAt: p.remind_at, note: p.note ?? null, status, reminderId: p.reminder_id ?? null, decidedAt: p.decided_at ?? null };
  }
  function messageView(m: any, forRunner = false) {
    const t = m.thread_id ? row<any>("SELECT user_id FROM assistant_threads WHERE id=?", m.thread_id) : null;
    const c = m.customer_id ? row<any>("SELECT id,name,first_name,last_name FROM customers WHERE id=?", m.customer_id) : null;
    return {
      id: Number(m.id), threadId: Number(m.thread_id), author: m.author, authorLabel: m.author_label, kind: m.kind, priority: m.priority,
      body: forRunner ? maskText(m.body) : m.body, customerId: m.customer_id ?? null,
      customerName: c ? (c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : c.name) : null,
      actions: m.actions_json ? JSON.parse(m.actions_json) : [], clientId: m.client_id ?? null, createdAt: m.created_at,
      pickedAt: m.picked_at ?? null, deliveredAt: m.delivered_at ?? null, readAt: m.read_at ?? null, actedAt: m.acted_at ?? null,
      actionTaken: m.action_taken ?? null, suppressed: m.suppressed_reason ?? null, ...(forRunner ? { userId: t?.user_id ?? null } : {}),
      proposal: m.kind === "reminder_proposal" ? proposalView(row<any>("SELECT * FROM assistant_reminder_proposals WHERE message_id=?", m.id)) : undefined,
    };
  }

  /* ================= runner router ================= */
  const runner = Router();
  runner.use(express.json({ limit: "256kb" }));
  runner.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const failures = new Map<string, { n: number; at: number }>();
  runner.use((req, res, next) => {
    const key = ip(req); const f = failures.get(key);
    if (f && f.n >= 20 && Date.now() - f.at < 60_000) return fail(res, 429, "too_many_attempts");
    const m = /^Bearer\s+([A-Za-z0-9_\-.]{20,200})$/.exec(String(req.headers.authorization ?? ""));
    const h = m ? hashAssistantToken(m[1]) : "";
    const tok = m ? row<any>("SELECT id,assistant_id,token_hash FROM assistant_tokens WHERE token_hash=? AND revoked_at IS NULL", h) : undefined;
    if (!tok || !timingSafeEqual(Buffer.from(tok.token_hash), Buffer.from(h))) {
      failures.set(key, { n: (f && Date.now() - f.at < 60_000 ? f.n : 0) + 1, at: Date.now() });
      audit({ req, action: "auth", outcome: "bad_token", actorLabel: "runner" });
      return fail(res, 401, "unauthorized");
    }
    const a = normAssistant(row<any>("SELECT * FROM assistants WHERE id=?", tok.assistant_id));
    const t = iso();
    run("UPDATE assistant_tokens SET last_used_at=?, last_used_ip=? WHERE id=?", t, ip(req), tok.id);
    run("UPDATE assistants SET last_seen_at=?, last_seen_ip=? WHERE id=?", t, ip(req), a.id);
    res.locals.assistant = a; res.locals.assistantTokenId = tok.id;
    if (!a.enabled || !globalOn()) { audit({ req, a, tokenId: tok.id, action: `${req.method} ${req.path}`.slice(0, 80), outcome: "disabled" }); return fail(res, 423, "assistant_disabled", "این دستیار فعلاً خاموش است."); }
    next();
  });
  const A = (res: Response) => res.locals.assistant as any;
  const TK = (res: Response) => Number(res.locals.assistantTokenId);
  /** Revoked/disabled mid-request (checked on every long-poll tick). */
  const stillValid = (res: Response) => Boolean(row("SELECT 1 FROM assistant_tokens t JOIN assistants a ON a.id=t.assistant_id WHERE t.id=? AND t.revoked_at IS NULL AND a.enabled=1", TK(res))) && globalOn();
  const waiting = new Map<string, number>();
  async function longPoll<T>(req: Request, res: Response, key: string, maxS: number, check: () => T | null | undefined, valid: () => boolean = () => true): Promise<T | null | undefined | false> {
    const first = check(); const w = Number(req.query.wait ?? 0);
    const secs = Number.isFinite(w) ? Math.max(0, Math.min(maxS, Math.floor(w))) : 0;
    if (first || !secs) return first ?? null;
    const n = waiting.get(key) ?? 0;
    if (n >= MAX_WAITERS_PER_TOKEN) return null;
    waiting.set(key, n + 1);
    let gone = false; const onClose = () => { if (!res.writableEnded) gone = true; };
    res.on("close", onClose);
    try {
      const end = Date.now() + secs * 1000;
      while (!gone && Date.now() < end) {
        await new Promise(r => setTimeout(r, LONG_POLL_TICK_MS));
        if (gone) break;
        if (!valid()) return false;
        const v = check(); if (v) return v;
      }
      return gone ? undefined : null;
    } finally { res.off("close", onClose); const left = (waiting.get(key) ?? 1) - 1; if (left > 0) waiting.set(key, left); else waiting.delete(key); }
  }
  /** Any write the runner attempts outside its allowed set (priority/assignment/money/…) is denied by default. */
  const deny = (req: Request, res: Response) => { audit({ req, a: A(res), tokenId: TK(res), action: `${req.method} ${req.path}`.slice(0, 80), outcome: "forbidden" }); fail(res, 403, "forbidden", "این کار برای دستیار مجاز نیست."); };
  for (const p of ["/customers/:id/priority", "/customers/:id/assign", "/customers/:id/salesperson", "/customers/:id/status", "/customers/:id", "/customers/:id/transfer",
    "/payments", "/payment-orders", "/wallets", "/fees", "/contracts", "/loan-applications/:id", "/loan-applications/:id/stage", "/sms", "/customer-messages", "/reminders"])
    runner.all(p, (req, res, next) => (req.method === "GET" ? next() : deny(req, res)));

  const custName = (c: any) => (c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : c.name);
  /** v8 fix: smart-filing maskData matched internal ids by key name («salespersonId», «applicationId» contain "nid") and
   *  masked them. Runner output keeps numeric internal ids and staff display names; customer phones / national ids / text
   *  stay masked exactly as before (every other key and value still goes through maskData). */
  const KEEP_ID = (k: string) => (/^[a-z][A-Za-z]*Id$/.test(k) && !/national|melli|token|code/i.test(k)) || /^siteLeads[A-Z]/.test(k);
  const maskOut = (v: unknown, depth = 0): unknown => {
    if (depth > 8) return null;
    if (Array.isArray(v)) return v.slice(0, 200).map(x => maskOut(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
        if (KEEP_ID(k) && (x == null || typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x)))) out[k] = x;
        else if (x && typeof x === "object" && !/password|pass|otp|token|secret/i.test(k)) out[k] = maskOut(x, depth + 1);
        else out[k] = (maskData({ [k]: x }) as Record<string, unknown>)[k];
      }
      return out;
    }
    return maskData(v);
  };
  const STATUS_FA: Record<string, string> = { in_progress: "در حال پیگیری", cancelled: "انصرافی", completed: "تکمیل‌شده" };
  function customerCard(c: any, a?: any) {
    const last = row<any>("SELECT MAX(created_at) t FROM call_logs WHERE customer_id=?", c.id);
    const rem = hasTable("reminders") ? row<any>("SELECT MIN(remind_at) t FROM reminders WHERE customer_id=? AND done=0", c.id) : null;
    return { id: c.id, name: custName(c), status: c.status, statusLabel: STATUS_FA[c.status] ?? c.status, city: c.city ?? null,
      mobile: c.phone ? maskPhone(String(c.phone)) : null, createdAt: c.created_at, lastCallAt: last?.t ?? null, nextReminderAt: rem?.t ?? null,
      ...(a?.kind === "manager" ? { expert: { id: c.salesperson_id ?? null, name: spName(c.salesperson_id) } } : {}),
      ...(a?.kind === "sales" || a?.kind === "manager" ? { priority: c.priority == null ? null : Number(c.priority), priorityLabel: c.priority == null ? "بدون اولویت" : `اولویت ${c.priority}`, isUrgent: Number(c.is_urgent) === 1 } : {}) };
  }
  /* ---------- v7 sales-only reads (allowlisted; never contract/fee/commission/wallet fields) ---------- */
  const salesOnly = (req: Request, res: Response, next: NextFunction) => {
    const a = A(res);
    if (a.kind === "sales" || a.kind === "manager") return next();
    audit({ req, a, tokenId: TK(res), action: `${req.method} ${req.path.replace(/\/\d+(?=\/|$)/g, "/:id")}`.slice(0, 80), outcome: "sales_only" });
    fail(res, 403, "sales_only", "این بخش فقط برای دستیارهای فروش است.");
  };
  const latin = (v: unknown) => String(v ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).trim();
  const amount = (v: unknown): number | null => { const t = latin(v); return /^[1-9]\d{0,15}$/.test(t) ? Number(t) : null; };
  const json = (v: unknown): any => { if (typeof v !== "string") return v ?? null; try { return JSON.parse(latin(v)); } catch { return null; } };
  /** Same formulas as the customer-portal calculator (plan-display-values durationPercent + plan-calculator-values monthlyPmt). */
  function durationPercent(value: unknown, months: number): number | null {
    let v: any = typeof value === "string" ? (json(value) ?? latin(value)) : value;
    if (v && typeof v === "object" && !Array.isArray(v)) v = v[String(months)];
    if ((typeof v !== "string" && typeof v !== "number") || String(v).trim() === "") return null;
    const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }
  function monthlyPmt(principal: number, annualPercent: number, months: number): number | null {
    if (!Number.isSafeInteger(principal) || principal <= 0 || !Number.isFinite(annualPercent) || annualPercent < 0 || !Number.isInteger(months) || months <= 0 || months > 600) return null;
    const r = annualPercent / 1200;
    const p = r === 0 ? principal / months : principal * r / -Math.expm1(-months * Math.log1p(r));
    return Number.isFinite(p) && p > 0 ? Math.round(p) : null;
  }
  /** v9: every runner amount is TOMAN (loan_applications.*_amount, loan_plans.principal_amount, consultation_forms, site
   *  «حدود مبلغ» bands are million-toman and are converted). No runner field is rial; amountUnit sits next to every amount. */
  const AMOUNT_UNIT = "toman" as const;
  const BAND_RANGE: Record<string, [number | null, number | null, string]> = {
    "0-100": [0, 100, "تا ۱۰۰ میلیون تومان"], "100-200": [100, 200, "۱۰۰ تا ۲۰۰ میلیون تومان"], "200-300": [200, 300, "۲۰۰ تا ۳۰۰ میلیون تومان"],
    "300-500": [300, 500, "۳۰۰ تا ۵۰۰ میلیون تومان"], "500-1000": [500, 1000, "۵۰۰ میلیون تا ۱ میلیارد تومان"], "1000-up": [1000, null, "بیش از ۱ میلیارد تومان"],
    "upto100": [0, 100, "تا ۱۰۰ میلیون تومان"], "100-300": [100, 300, "۱۰۰ تا ۳۰۰ میلیون تومان"], "500plus": [500, null, "بیش از ۵۰۰ میلیون تومان"], "unsure": [null, null, "مطمئن نیست"] };
  const bandView = (band: unknown) => { const b = typeof band === "string" ? BAND_RANGE[band] : undefined; if (!b) return null;
    return { band, minAmount: b[0] == null ? null : b[0] * 1e6, maxAmount: b[1] == null ? null : b[1] * 1e6, amountUnit: AMOUNT_UNIT, label: b[2] }; };
  /** Loan case view for a sales assistant: amounts received, installment amount and count only. */
  function loanView(x: any) {
    const plan = json(x.plan_snapshot_json);
    const months = Number(x.duration_months ?? x.requested_duration_months);
    const count = Number.isInteger(months) && months > 0 ? months : null;
    const principal = amount(x.approved_amount) ?? amount(x.requested_amount);
    const rate = plan && count ? durationPercent(plan.annual_interest ?? plan.annualInterest, count) : null;
    const net = amount(x.net_amount);
    let received: number | null = net, receivedSource: string | null = net != null ? "net_after_deductions" : null;
    if (received == null) { try { const p = customerApplicationPayout(x); const v = amount(p.cashPayoutAmount); if (v != null) { received = v; receivedSource = "plan_terms"; } } catch { /* unknown */ } }
    const planName = (plan && typeof plan.name === "string" ? plan.name : null) ?? (x.plan_id ? row<any>("SELECT name FROM loan_plans WHERE id=?", x.plan_id)?.name ?? null : null);
    return { id: x.id, stage: x.stage, status: x.status, createdAt: x.created_at, planName, amountUnit: AMOUNT_UNIT,
      requestedAmount: amount(x.requested_amount), approvedAmount: amount(x.approved_amount),
      receivedAmount: received, receivedAmountSource: receivedSource,
      installmentAmount: principal != null && rate != null && count ? monthlyPmt(principal, rate, count) : null,
      installmentCount: count, requestedInstallmentCount: x.requested_duration_months == null ? null : Number(x.requested_duration_months) };
  }
  const CALL_RESULT_FA: Record<string, string> = { answered: "پاسخ داد", no_answer: "پاسخ نداد", callback: "تماس بعدی خواست", wrong_number: "شماره اشتباه",
    ANSWERED: "پاسخ داد", "NO ANSWER": "پاسخ نداد", BUSY: "مشغول", BARRED: "برقرار نشد", FAILED: "ناموفق", CANCEL: "لغو شد" };
  const spName = (id: unknown) => id == null ? null : row<any>("SELECT name FROM salespersons WHERE id=?", id)?.name ?? null;
  const userName = (id: unknown) => id == null ? null : (() => { const u = row<any>("SELECT full_name,username FROM users WHERE id=?", id); return u ? (u.full_name || u.username) : null; })();
  function callView(l: any) {
    const q = hasTable("team_sales_qualifications") ? row<any>("SELECT call_result,actor_user_id FROM team_sales_qualifications WHERE call_log_id=? ORDER BY id DESC LIMIT 1", l.id) : null;
    let v: any = null;
    if (hasTable("voip_after_call_events")) try { v = row<any>("SELECT status,direction,duration_seconds,started_at,ended_at,expert_name FROM voip_after_call_events WHERE call_log_id=? ORDER BY id DESC LIMIT 1", l.id); } catch { v = null; }
    let dur: number | null = v?.duration_seconds == null ? null : Number(v.duration_seconds);
    if (dur == null && v?.started_at && v?.ended_at) { const d = Math.round((Date.parse(v.ended_at) - Date.parse(v.started_at)) / 1000); dur = Number.isFinite(d) && d >= 0 ? d : null; }
    const code = q?.call_result ?? v?.status ?? null;
    return { id: l.id, subject: l.subject, customerRequest: l.customer_request, expertNotes: l.expert_notes, createdAt: l.created_at,
      loggedBy: { name: (q ? userName(q.actor_user_id) : null) ?? l.salesperson_name_snapshot ?? spName(l.salesperson_id), currentName: spName(l.salesperson_id), salespersonId: l.salesperson_id ?? null },
      result: code == null ? null : { key: String(code), label: CALL_RESULT_FA[String(code)] ?? String(code) },
      durationSeconds: dur, direction: v?.direction ?? null, source: v ? "phone_system" : q ? "first_call_form" : "manual" };
  }
  const notFound = (req: Request, res: Response, customerId: number) => {
    audit({ req, a: A(res), tokenId: TK(res), action: `${req.method} ${req.path.replace(/\/\d+(?=\/|$)/g, "/:id")}`.slice(0, 80), customerId: Number.isSafeInteger(customerId) ? customerId : null, outcome: "not_in_scope" });
    fail(res, 404, "not_found");
  };

  runner.get("/me", (_req, res) => {
    const a = A(res);
    const u = a.bound_user_id ? userRow(a.bound_user_id) : null;
    res.json({ assistant: { id: a.id, slug: a.slug, name: a.display_name, label: label(a), kind: a.kind, boundRole: a.bound_role ?? null,
      expert: u ? { userId: u.id, name: u.full_name || u.username } : null, maxMessagesPerHour: a.max_msgs_per_hour },
      tokenId: TK(res), serverTime: iso(), quietHours: inQuietHours(now()) });
  });
  /** v9: customers that left this expert's list today (Tehran day): ownership moved to another expert in
   *  customer_priority_history (e.g. Kazemi's qualifier-form hand-off, rule H7) and is still elsewhere. Read only. */
  const tehranClock = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const tehranText = (isoAt: string) => { const d = new Date(isoAt); if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(tehranClock.formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
  const maskName = (n: unknown) => { const w = String(n ?? "").trim().split(/\s+/).filter(Boolean); if (!w.length) return null;
    return maskText([w[0], ...w.slice(1).map(x => `${Array.from(x)[0]}…`)].join(" ")); };
  const SOURCE_FA: Record<string, string> = { qualifier_form: "فرم سنجش کاظمی — واگذاری (تقسیم عادلانه)", customer_update: "ویرایش دستی مشتری", nonp1_auto_transfer: "انتقال خودکار غیر اولویت ۱", promote: "ارتقای اولویت" };
  function leftScopeToday(sp: number, t: Date, excludeTest = false) {
    if (!hasTable("customer_priority_history")) return [];
    const from = new Date(tehranDayStartMs(t.getTime())).toISOString();
    const hist = rows<any>(`SELECT h.* FROM customer_priority_history h JOIN customers c ON c.id=h.customer_id
      WHERE h.old_salesperson_id=? AND h.new_salesperson_id IS NOT NULL AND h.new_salesperson_id<>? AND h.created_at>=? AND h.created_at<=?
        AND c.merged_into_customer_id IS NULL AND COALESCE(c.salesperson_id,-1)<>? ${excludeTest ? `AND NOT ${testCustomerSql("c")}` : ""} ORDER BY h.created_at, h.id`, sp, sp, from, t.toISOString(), sp);
    const last = new Map<number, any>(); for (const h of hist) last.set(Number(h.customer_id), h);
    return [...last.values()].slice(0, 50).map(h => {
      const c = row<any>("SELECT * FROM customers WHERE id=?", h.customer_id) ?? {};
      const rule = /\((H\d+)\)\s*$/.exec(String(h.reason ?? ""))?.[1] ?? null;
      const lead = hasTable("site_lead_requests") ? row<any>("SELECT answered_at FROM site_lead_requests WHERE customer_id=? AND answered_at>=? ORDER BY answered_at DESC LIMIT 1", h.customer_id, from) : null;
      return { customerId: Number(h.customer_id), maskedName: maskName(custName(c)), mobile: c.phone ? String(c.phone) : null,
        reason: { source: h.source ?? null, label: SOURCE_FA[String(h.source)] ?? h.source ?? null, rule, text: h.reason ? maskText(h.reason).slice(0, 200) : null,
          byUser: userName(h.actor_user_id) ?? null, newPriority: h.new_priority == null ? null : Number(h.new_priority) },
        toWhom: { salespersonId: Number(h.new_salesperson_id), name: spName(h.new_salesperson_id) },
        at: h.created_at, atTehran: tehranText(h.created_at),
        requestAnsweredAt: lead?.answered_at ?? null, requestAnsweredAtTehran: lead?.answered_at ? tehranText(lead.answered_at) : null };
    });
  }
  runner.get("/my-context", (_req, res) => {
    const a = A(res); const s = scopeSql(a);
    // v10: test customers (lib/test-customers.ts) are left out of every count / list here while the admin switch is ON (reporting only).
    const xt = excludeTestOn(db); const tIds = xt ? testCustomerIds(db) : new Set<number>();
    const n = row<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${s.sql}${xt ? ` AND NOT ${testCustomerSql("c")}` : ""}`, ...s.params)?.n ?? 0;
    const users = a.kind === "sales" ? [a.bound_user_id].filter(Boolean).map(id => userRow(id)).filter(Boolean)
      : rows<any>("SELECT id,role,salesperson_id,active,full_name,username FROM users WHERE active=1 ORDER BY id").filter(u => userEligible(a, u));
    const threads = users.map((u: any) => ({ userId: u.id, name: u.full_name || u.username, role: u.role, threadId: threadFor(a, u.id, false)?.id ?? null, ...prefsOf(u.id) }));
    // v7: sales assistants also get the box of 3 (same lib/sales-assist.ts logic, no impression is recorded) and today's counters.
    let sales: any = {};
    if (a.kind === "sales" && a.bound_salesperson_id && !TRAINEE_SALESPERSON_IDS.includes(a.bound_salesperson_id)) {
      const sp = Number(a.bound_salesperson_id); const t = now();
      let today: any = null, box: any[] = [], pool: number | null = null, unavailable = false;
      try { today = deps.sales?.today ? deps.sales.today(sp, t) : null; } catch { unavailable = true; }
      try {
        const r = deps.sales?.suggestions ? deps.sales.suggestions(sp, t) : null;
        if (r) { pool = r.pool; box = r.items.filter((x: any) => !tIds.has(Number(x.customerId)) && inScope(a, Number(x.customerId))).map((x: any) => ({
          customerId: x.customerId, name: x.displayName, priority: x.priority ?? null, rank: x.rank, tier: x.tier,
          reason: x.reason ? { kind: x.reason.kind, text: x.reason.text } : null, chips: (x.chips ?? []).map((c: any) => c.label),
          topOfList: x.topOfList ? { kind: x.topOfList.kind, dueAt: x.topOfList.dueAt, overdue: Boolean(x.topOfList.overdue), windowNow: Boolean(x.topOfList.windowNow) } : null,
          callForm: x.callForm, lastCallAt: x.lastCallAt ?? null })); }
      } catch { unavailable = true; }
      // v8 fix: «تماس‌های امروز» = the shared lib/expert-calls.ts definition (by the logging expert), not only calls started from the box.
      let calls: ReturnType<typeof expertCallsToday> | null = null; try { calls = expertCallsToday(db, sp, t, { excludeTest: xt }); } catch { unavailable = true; }
      let left: any[] | null = null; try { left = leftScopeToday(sp, t, xt); } catch { unavailable = true; }
      sales = { leftScopeToday: left, today: { calls: calls?.count ?? null, answered: calls?.answered ?? null, notAnswered: calls?.notAnswered ?? null, unknownResult: calls?.unknown ?? null,
          fromSuggestionBox: today ? Number(today.calls) : null, notNow: today ? Number(today.notNow) : null, definition: EXPERT_CALLS_DEFINITION }, nextCustomer: box[0] ?? null, suggestions: box,
        suggestionPool: pool, ...(unavailable ? { salesBoxUnavailable: true } : {}) };
    }
    if (a.kind === "manager") {
      const experts = managerExperts(db).map(e => ({ salespersonId: e.salespersonId, name: e.name, trainee: e.trainee }));
      return void res.json(maskAll({ customersInScope: Number(n), testCustomersExcluded: xt, people: threads, scope: "manager_all_experts_incl_trainees_readonly", experts,
        thresholds: readManagerSettings(k => row<{ value: string }>("SELECT value FROM assistant_settings WHERE key=?", k)?.value),
        ranges: MANAGER_RANGES, summarySlots: MANAGER_SLOTS,
        allowed: ["read every expert's customers, calls, notes, reminders and cases, trainees included (read only; user 29 never)", "manager report today/week (read)", "alerts + score (read)",
          "summary text for 09:00 / 18:00 / Thursday (read)", "chat messages to an admin", "notifications to an admin", "assistant notes", "typing"],
        blocked: ["changing priority", "assignment", "money/fees/wallets/commission", "contracts", "case stage", "SMS", "customer messages", "reminders or reminder proposals", "deleting anything",
          "messages to anyone but an admin", "any change to trainees"] }));
    }
    res.json(maskOut({ customersInScope: Number(n), testCustomersExcluded: xt, people: threads, scope: a.kind === "sales" ? (a.scope_rule === "p1" ? "own_p1_customers" : "own_customers") : "registrar_smart_filing_cases",
      ...sales,
      allowed: a.kind === "sales"
        ? ["read customers in scope", "priority (read)", "loan cases: received/installment amount/count (read)", "assignment history (read)", "notes/history (read)", "calls with who/result/duration (read)", "consultation + preferred call time (read)", "today + next customer (read)", "chat messages", "notifications", "assistant notes", "typing"]
        : ["read customers in scope", "chat messages", "notifications", "assistant notes", "typing"],
      blocked: ["changing priority", "assignment", "money/fees/wallets", "contracts", "case stage", "SMS", "customer messages"] }));
  });
  runner.get("/customers", (req, res) => {
    const a = A(res); const s = scopeSql(a);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
    const after = Math.max(0, Number(req.query.afterId ?? 0) || 0);
    const q = String(req.query.q ?? "").trim().slice(0, 60);
    const spF = a.kind === "manager" && req.query.salespersonId != null && req.query.salespersonId !== "" ? Number(req.query.salespersonId) : null; // v8: manager may filter by expert
    const list = rows<any>(`SELECT c.* FROM customers c WHERE ${s.sql} AND c.id>? ${spF != null ? "AND c.salesperson_id=?" : ""} ${q ? "AND (c.name LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)" : ""} ORDER BY c.id LIMIT ?`,
      ...s.params, after, ...(spF != null ? [spF] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), limit + 1);
    audit({ req, a, tokenId: TK(res), action: "GET /customers", outcome: "ok", detail: { n: Math.min(list.length, limit) } });
    res.json(maskOut({ items: list.slice(0, limit).map(c => customerCard(c, a)), nextAfterId: list.length > limit ? list[limit - 1].id : null }));
  });
  const scopedCustomer = (req: Request, res: Response) => {
    const id = Number(req.params.id); const a = A(res);
    if (!inScope(a, id)) { notFound(req, res, id); return null; }
    return row<any>("SELECT * FROM customers WHERE id=?", id);
  };
  runner.get("/customers/:id", (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return; const a = A(res);
    const apps = a.kind === "sales" || a.kind === "manager"
      ? rows<any>(`SELECT * FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 10`, c.id).map(loanView)
      : rows<any>(`SELECT id,stage,status,created_at FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 10`, c.id)
        .map(x => ({ id: x.id, stage: x.stage, status: x.status, createdAt: x.created_at }));
    const jobs = a.kind === "filing" && hasTable("smart_filing_jobs")
      ? rows<any>("SELECT id,application_id,status,step_label,progress,updated_at FROM smart_filing_jobs WHERE customer_id=? AND job_type='real' ORDER BY id DESC LIMIT 10", c.id)
        .map(j => ({ id: j.id, applicationId: j.application_id, status: j.status, step: j.step_label, progress: j.progress, updatedAt: j.updated_at })) : undefined;
    const notes = rows<any>("SELECT id,body,author_label,created_at FROM assistant_customer_notes WHERE customer_id=? AND assistant_id=? ORDER BY id DESC LIMIT 20", c.id, a.id)
      .map(n => ({ id: n.id, body: n.body, author: n.author_label, createdAt: n.created_at }));
    audit({ req, a, tokenId: TK(res), action: "GET /customers/:id", customerId: c.id, outcome: "ok" });
    res.json(maskOut({ customer: { ...customerCard(c, a), description: maskText(c.description ?? "").slice(0, 1000) }, applications: apps, ...(jobs ? { smartFilingJobs: jobs } : {}), assistantNotes: notes }));
  });
  runner.get("/customers/:id/calls", (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return;
    const sales = A(res).kind === "sales" || A(res).kind === "manager";
    const items = rows<any>("SELECT * FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 30", c.id)
      .map(l => sales ? callView(l) : ({ id: l.id, subject: l.subject, customerRequest: l.customer_request, expertNotes: l.expert_notes, createdAt: l.created_at }));
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /customers/:id/calls", customerId: c.id, outcome: "ok" });
    res.json(maskOut({ items }));
  });
  runner.get("/customers/:id/reminders", (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return;
    const items = rows<any>("SELECT id,subject,message,remind_at,done,created_at FROM reminders WHERE customer_id=? ORDER BY remind_at DESC LIMIT 30", c.id)
      .map(r => ({ id: r.id, subject: r.subject, message: r.message, remindAt: r.remind_at, done: Boolean(r.done), createdAt: r.created_at }));
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /customers/:id/reminders", customerId: c.id, outcome: "ok" });
    res.json(maskOut({ items }));
  });
  /** v7: «تاریخچه و یادداشت‌ها» — /notes and /timeline are aliases (runners called them before they existed → router 404). */
  const PH_SOURCE_FA: Record<string, string> = { customer_update: "ویرایش در CRM", promote: "ارتقا به اولویت ۱", qualifier_form: "فرم تماس اول",
    nonp1_auto_transfer: "انتقال خودکار غیر اولویت ۱", no_answer_archive: "بایگانی بی‌پاسخ", kazemi_return: "بازگشت به کاظمی" };
  runner.get(["/customers/:id/history", "/customers/:id/notes", "/customers/:id/timeline"], salesOnly, (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return; const a = A(res);
    const assignment = hasTable("customer_priority_history")
      ? rows<any>("SELECT * FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 100", c.id).map(h => ({
        id: h.id, at: h.created_at, oldPriority: h.old_priority ?? null, newPriority: h.new_priority ?? null,
        fromExpert: spName(h.old_salesperson_id), toExpert: spName(h.new_salesperson_id), transferred: h.old_salesperson_id !== h.new_salesperson_id,
        by: userName(h.actor_user_id), source: h.source, sourceLabel: PH_SOURCE_FA[h.source] ?? h.source, reason: maskText(h.reason ?? "").slice(0, 500) })) : [];
    const expertNotes = rows<any>("SELECT * FROM call_logs WHERE customer_id=? AND (COALESCE(TRIM(expert_notes),'')<>'' OR COALESCE(TRIM(customer_request),'')<>'') ORDER BY id DESC LIMIT 50", c.id)
      .map(l => ({ callId: l.id, at: l.created_at, by: l.salesperson_name_snapshot ?? spName(l.salesperson_id), subject: l.subject, customerRequest: l.customer_request, text: l.expert_notes }));
    const caseNotes = hasTable("loan_application_notes")
      ? rows<any>(`SELECT n.id,n.application_id,n.author_name,n.text,n.created_at FROM loan_application_notes n JOIN loan_applications la ON la.id=n.application_id
          WHERE la.customer_id=? AND la.deleted_at IS NULL AND n.object_path IS NULL AND COALESCE(TRIM(n.text),'')<>'' ORDER BY n.id DESC LIMIT 50`, c.id)
        .map(n => ({ id: n.id, applicationId: n.application_id, at: n.created_at, by: n.author_name, text: n.text })) : [];
    const caseStages = hasTable("loan_application_stage_history")
      ? rows<any>(`SELECT h.id,h.application_id,h.from_stage,h.to_stage,h.action,h.created_at FROM loan_application_stage_history h JOIN loan_applications la ON la.id=h.application_id
          WHERE la.customer_id=? AND la.deleted_at IS NULL ORDER BY h.id DESC LIMIT 50`, c.id)
        .map(h => ({ id: h.id, applicationId: h.application_id, at: h.created_at, fromStage: h.from_stage, toStage: h.to_stage, action: h.action })) : [];
    const assistantNotes = rows<any>("SELECT id,body,author_label,created_at FROM assistant_customer_notes WHERE customer_id=? AND assistant_id=? ORDER BY id DESC LIMIT 20", c.id, a.id)
      .map(n => ({ id: n.id, at: n.created_at, by: n.author_label, text: n.body }));
    const timeline = [
      ...assignment.map(h => ({ at: h.at, type: h.transferred ? "transfer" : "priority", text: `${h.sourceLabel}${h.transferred ? ` · ${h.fromExpert ?? "—"} ← ${h.toExpert ?? "—"}` : ""}${h.newPriority != null ? ` · اولویت ${h.newPriority}` : ""}` })),
      ...expertNotes.map(n => ({ at: n.at, type: "call_note", text: `${n.by ?? ""}: ${String(n.text ?? n.customerRequest ?? "").slice(0, 200)}` })),
      ...caseNotes.map(n => ({ at: n.at, type: "case_note", text: `${n.by ?? ""}: ${String(n.text).slice(0, 200)}` })),
      ...caseStages.map(h => ({ at: h.at, type: "case_stage", text: `${h.fromStage ?? "—"} → ${h.toStage ?? "—"}` })),
      ...assistantNotes.map(n => ({ at: n.at, type: "assistant_note", text: String(n.text).slice(0, 200) })),
    ].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 100);
    audit({ req, a, tokenId: TK(res), action: `GET /customers/:id/${req.path.split("/").pop()}`.slice(0, 80), customerId: c.id, outcome: "ok" });
    res.json(maskOut({ customerId: c.id, priority: c.priority == null ? null : Number(c.priority), assignmentHistory: assignment, expertNotes, caseNotes, caseStages, assistantNotes, timeline }));
  });
  /** v7: «فرم مشاوره» + «اطلاعات مشاوره» + preferred call time (site/callback requests). */
  const FORM_FIELDS = ["job_type", "credit_rank", "loan_purpose", "requested_amount", "requested_amount_toman", "need_days", "needs_fast_receive", "receive_mode", "loan_pref",
    "has_check", "check_type", "customer_check_status", "has_promissory", "has_guarantor", "has_guarantor_check", "has_guarantor_promissory", "guarantor_credit_rank", "guarantor_job_type",
    "guarantor_check_type", "guarantor_collateral_type", "collateral_type", "has_business_license", "has_account_turnover", "has_avg_balance", "has_customer_salary_deduct",
    "has_guarantor_salary_deduct", "is_retired", "military_status", "prefer_remote", "prefer_in_person", "extra_notes", "created_at", "updated_at"];
  const camel = (k: string) => k.replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase());
  const PROFILE_FIELDS = ["jobType", "guarantorAvailable", "guarantorCheque", "creditRank", "gRank", "gJobType", "military", "city", "selectedPlans", "noPlanFit", "noPlanNote", "urgency", "formDate", "submitterName"];
  const pick = (d: any) => { const o: any = {}; if (!d || typeof d !== "object") return null;
    for (const k of PROFILE_FIELDS) if (k in d) o[k] = k === "selectedPlans" ? (Array.isArray(d[k]) ? d[k].map((p: any) => ({ id: p?.id ?? null, name: p?.name ?? null, status: p?.status ?? null })) : []) : d[k];
    return o; };
  /** v9: the site form's «حدود مبلغ» (public_leads.amount_band, million toman) as a toman range. Read only. */
  const siteLeadBand = (siteLeadRequestId: number) => { try {
    if (!hasTable("public_leads") || !hasTable("site_lead_requests")) return null;
    const r = row<any>("SELECT p.amount_band b FROM site_lead_requests s JOIN public_leads p ON p.id=s.source_id WHERE s.id=? AND s.source='lead'", siteLeadRequestId);
    return r ? bandView(r.b) : null; } catch { return null; } };
  runner.get(["/customers/:id/consultation", "/customers/:id/consultation-form"], salesOnly, (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return; const a = A(res);
    let form: any = null;
    if (hasTable("consultation_forms")) {
      const f = row<any>("SELECT * FROM consultation_forms WHERE customer_id=? ORDER BY COALESCE(updated_at,created_at) DESC, id DESC LIMIT 1", c.id);
      if (f) { form = { id: f.id, author: userName(f.author_user_id) }; for (const k of FORM_FIELDS) if (k in f && !k.startsWith("requested_amount")) form[camel(k)] = f[k] ?? null;
        // v9: one normalized toman amount (numeric column first, else the same free-text rule as the consultation report:
        // «300» / «150 تا 200 میلیون» are million toman). The raw text is kept only when it was not a plain number.
        const col = amount(f.requested_amount_toman), raw = f.requested_amount == null ? "" : String(f.requested_amount).trim();
        const parsed = col ?? parseConsultAmountToman(raw || null);
        form.requestedAmount = parsed; form.amountUnit = AMOUNT_UNIT;
        form.requestedAmountSource = col != null ? "requested_amount_toman" : parsed == null ? null : amount(raw) === parsed ? "requested_amount" : "requested_amount_text_parsed";
        if (raw && amount(raw) !== parsed) form.requestedAmountText = maskText(raw).slice(0, 80); }
    }
    let profile: any = null, unavailable = false;
    try { const p = deps.sales?.consultProfile ? deps.sales.consultProfile(c.id) : null;
      if (p) profile = { latest: p.latest ? { at: p.latest.createdAt ?? p.latest.created_at ?? null, by: p.latest.actorName ?? null, source: p.latest.source ?? null, data: pick(p.latest.data) } : null,
        versions: (p.versions ?? []).slice(0, 10).map((v: any) => ({ id: v.id, at: v.createdAt ?? null, by: v.actorName ?? null, source: v.source ?? null, changedFields: v.changedFields ?? null })) };
    } catch { unavailable = true; }
    let requests: any[] = [];
    try { requests = (deps.sales?.siteLeadHistory ? deps.sales.siteLeadHistory(c.id) : []).slice(0, 10).map((r: any) => ({
      source: r.source, requestedAt: r.requestedAt, contactTime: r.contactTime, contactTimeLabel: r.contactTimeFa, isRepeat: Boolean(r.isRepeat), answeredAt: r.answeredAt ?? null,
      amountRange: r.source === "lead" ? siteLeadBand(Number(r.id)) : null })); }
    catch { unavailable = true; }
    const pref = requests[0] ? { contactTime: requests[0].contactTime, contactTimeLabel: requests[0].contactTimeLabel, requestedAt: requests[0].requestedAt, source: requests[0].source } : null;
    audit({ req, a, tokenId: TK(res), action: `GET /customers/:id/${req.path.split("/").pop()}`.slice(0, 80), customerId: c.id, outcome: "ok" });
    res.json(maskOut({ customerId: c.id, consultationForm: form, consultProfile: profile, preferredCallTime: pref, siteRequests: requests, ...(unavailable ? { partial: true } : {}) }));
  });
  runner.post("/customers/:id/assistant-notes", (req, res) => {
    const c = scopedCustomer(req, res); if (!c) return; const a = A(res);
    // v8: the manager reads trainees' customers but writes nothing on them (no change of any kind to trainees).
    if (a.kind === "manager" && TRAINEE_SALESPERSON_IDS.includes(Number(c.salesperson_id))) { audit({ req, a, tokenId: TK(res), action: "POST /customers/:id/assistant-notes", customerId: c.id, outcome: "trainee_read_only" }); return fail(res, 403, "trainee_read_only", "مشتری‌های کارآموز برای دستیار مدیر فقط خواندنی است."); }
    const body = String(req.body?.body ?? "").trim();
    if (!body || body.length > MAX_BODY) return fail(res, 422, "bad_body");
    if (hasBannedWord(body)) { audit({ req, a, tokenId: TK(res), action: "POST /customers/:id/assistant-notes", customerId: c.id, outcome: "banned_word", detail: { len: body.length } }); return fail(res, 422, "banned_word"); }
    const r = run("INSERT INTO assistant_customer_notes(assistant_id,customer_id,body,author_label,created_at) VALUES(?,?,?,?,?)", a.id, c.id, maskText(body), label(a), iso());
    audit({ req, a, tokenId: TK(res), action: "POST /customers/:id/assistant-notes", customerId: c.id, outcome: "ok", detail: { len: body.length } });
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  /* events: user messages, bubble actions, DND changes, calls logged on in-scope customers */
  function eventView(a: any, e: any) {
    const d = e.data_json ? JSON.parse(e.data_json) : {};
    const out: any = { id: Number(e.id), type: e.type, threadId: e.thread_id, userId: e.user_id, customerId: e.customer_id, messageId: e.message_id, createdAt: e.created_at, ...d };
    if (e.message_id) { const m = row<any>("SELECT * FROM assistant_messages WHERE id=?", e.message_id); if (m) out.message = messageView(m, true); }
    return out;
  }
  function pendingEvents(a: any, after: number) {
    syncCallEvents(a);
    const list = rows<any>("SELECT * FROM assistant_events WHERE assistant_id=? AND id>? ORDER BY id LIMIT 100", a.id, after);
    // Sarina: drop events whose case left her scope, and (v6) any event from/for a non-registrar/admin user (old sales threads).
    return list.filter(e => (e.customer_id == null || inScope(a, e.customer_id))
      && (a.kind !== "filing" || e.user_id == null || !filingRecipientBlocked(a, userRow(e.user_id) ?? { role: "" })));
  }
  runner.get("/events", async (req, res) => {
    const a = A(res);
    const after = req.query.after === undefined ? Number(a.acked_event_id) : Math.max(0, Number(req.query.after) || 0);
    const got = await longPoll(req, res, `t${TK(res)}`, MAX_WAIT_S, () => { const l = pendingEvents(a, after); return l.length ? l : null; }, () => stillValid(res));
    if (got === undefined) return;
    if (got === false) return fail(res, row("SELECT 1 FROM assistant_tokens WHERE id=? AND revoked_at IS NULL", TK(res)) ? 423 : 401, row("SELECT 1 FROM assistant_tokens WHERE id=? AND revoked_at IS NULL", TK(res)) ? "assistant_disabled" : "unauthorized");
    const list = got ?? [];
    const t = iso();
    for (const e of list) {
      run("UPDATE assistant_events SET picked_at=COALESCE(picked_at,?) WHERE id=?", t, e.id);
      if (e.message_id && e.type === "user_message") run("UPDATE assistant_messages SET picked_at=COALESCE(picked_at,?) WHERE id=?", t, e.message_id);
    }
    res.json(maskOut({ events: list.map(e => eventView(a, e)), cursor: list.length ? Number(list[list.length - 1].id) : after }));
  });
  runner.post("/events/ack", (req, res) => {
    const a = A(res); const upTo = Number(req.body?.upTo);
    const max = Number(row<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM assistant_events WHERE assistant_id=?", a.id)?.m ?? 0);
    if (!Number.isSafeInteger(upTo) || upTo < 0 || upTo > max) return fail(res, 422, "bad_cursor");
    run("UPDATE assistants SET acked_event_id=MAX(acked_event_id,?) WHERE id=?", upTo, a.id);
    res.json({ ok: true, acked: Math.max(Number(a.acked_event_id), upTo) });
  });

  /** Resolve the target thread of a runner write; enforces recipients and (Sarina) case binding. */
  function targetThread(req: Request, res: Response): { t: any; u: any; customerId: number | null } | null {
    const a = A(res); const b = req.body ?? {};
    let u: any; let t: any;
    if (b.threadId != null) {
      t = row<any>("SELECT * FROM assistant_threads WHERE id=? AND assistant_id=?", Number(b.threadId), a.id);
      if (!t) { fail(res, 404, "thread_not_found"); return null; }
      u = userRow(t.user_id);
    } else {
      if (b.userId == null && a.kind === "manager") { fail(res, 422, "recipient_required", "برای دستیار مدیر userId یا threadId یک مدیر (admin) لازم است."); return null; }
      const uid = b.userId != null ? Number(b.userId) : a.kind === "sales" ? a.bound_user_id : NaN;
      u = Number.isSafeInteger(uid) ? userRow(uid) : undefined;
    }
    if (filingRecipientBlocked(a, u)) { audit({ req, a, tokenId: TK(res), userId: u.id, action: `${req.method} ${req.path}`, outcome: "recipient_role_not_allowed", detail: { role: u.role } }); fail(res, 403, "recipient_role_not_allowed", "سارینا فقط با کارشناس ثبت (registrar) یا مدیر (admin) حرف می‌زند؛ کارشناس فروش سارینا ندارد."); return null; }
    if (!u || !userEligible(a, u)) { audit({ req, a, tokenId: TK(res), action: `${req.method} ${req.path}`, outcome: "not_in_scope", detail: { recipient: true } }); fail(res, 404, "recipient_not_found"); return null; }
    const customerId = b.customerId == null || b.customerId === "" ? null : Number(b.customerId);
    if (customerId != null && !inScope(a, customerId)) { notFound(req, res, customerId); return null; }
    if (a.kind === "filing" && customerId == null) { fail(res, 422, "case_required", "هر پیام سارینا باید به یک پرونده وصل باشد (customerId)."); return null; }
    if (!userSeesCase(a, u, customerId)) { notFound(req, res, customerId ?? NaN); return null; }
    return { t: t ?? threadFor(a, u.id, true), u, customerId };
  }
  function postMessage(req: Request, res: Response, forcedKind?: string, afterInsert?: (m: any, tt: { t: any; u: any; customerId: number | null }) => void) {
    const a = A(res); const b = req.body ?? {};
    const kind = forcedKind ?? String(b.kind ?? "text"); const priority = String(b.priority ?? "normal");
    const body = String(b.body ?? b.text ?? "").trim();
    const clientId = b.clientId == null ? null : String(b.clientId).slice(0, 80);
    if (!forcedKind && !(KINDS as readonly string[]).includes(kind)) return fail(res, 422, "bad_kind");
    if (!(PRIORITIES as readonly string[]).includes(priority)) return fail(res, 422, "bad_priority");
    if (!body || body.length > MAX_BODY) return fail(res, 422, "bad_body");
    const actions = Array.isArray(b.actions) ? b.actions.filter((x: any) => (ACTIONS as readonly string[]).includes(String(x))).slice(0, 4) : (kind === "suggestion" || kind === "alert" ? [...ACTIONS] : []);
    const tt = targetThread(req, res); if (!tt) return;
    if (hasBannedWord(body)) { audit({ req, a, tokenId: TK(res), action: "POST /messages", customerId: tt.customerId, outcome: "banned_word", detail: { len: body.length } }); return fail(res, 422, "banned_word", "این متن واژهٔ ممنوع دارد."); }
    if (clientId) { const dup = row<any>("SELECT * FROM assistant_messages WHERE thread_id=? AND author='assistant' AND client_id=?", tt.t.id, clientId); if (dup) return void res.json({ message: messageView(dup, true), delivered: "duplicate" }); }
    const hour = new Date(now().getTime() - 3600_000).toISOString();
    const sent = row<any>(`SELECT SUM(CASE WHEN m.priority<>'high' THEN 1 ELSE 0 END) normal, SUM(CASE WHEN m.priority='high' THEN 1 ELSE 0 END) high
      FROM assistant_messages m WHERE m.thread_id=? AND m.author='assistant' AND m.created_at>? AND COALESCE(m.suppressed_reason,'')<>'digested'`, tt.t.id, hour);
    let suppressed: string | null = null;
    if (priority === "high") { if (Number(sent?.high ?? 0) >= HIGH_PER_HOUR) { audit({ req, a, tokenId: TK(res), action: "POST /messages", customerId: tt.customerId, outcome: "rate_limited", detail: { len: body.length, priority } }); return fail(res, 429, "rate_limited", "سقف پیام فوری در این ساعت پر شده."); } }
    else if (Number(sent?.normal ?? 0) >= Number(a.max_msgs_per_hour)) suppressed = "digested";
    const p = prefsOf(tt.u.id);
    const held = !suppressed && p.dnd ? "dnd" : null;
    const r = run(`INSERT INTO assistant_messages(thread_id,author,author_label,kind,priority,body,customer_id,actions_json,client_id,origin,created_at,suppressed_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, tt.t.id, "assistant", label(a), kind, priority, maskText(body), tt.customerId, actions.length ? JSON.stringify(actions) : null, clientId, "runner", iso(), suppressed ?? held);
    let m = row<any>("SELECT * FROM assistant_messages WHERE id=?", Number(r.lastInsertRowid));
    if (afterInsert) { afterInsert(m, tt); m = row<any>("SELECT * FROM assistant_messages WHERE id=?", m.id); }
    try { bell(a, m, tt.u); } catch { /* the bell is best-effort; the chat message stands */ }
    run("DELETE FROM assistant_typing WHERE thread_id=?", tt.t.id);
    audit({ req, a, tokenId: TK(res), userId: tt.u.id, action: forcedKind === "alert" ? "POST /notifications" : forcedKind === "reminder_proposal" ? "POST /reminder-proposals" : "POST /messages", customerId: tt.customerId, outcome: "ok", detail: { len: body.length, kind, priority, delivered: suppressed ? "digest" : held ? "held_dnd" : "now" } });
    res.status(201).json({ message: messageView(m, true), delivered: suppressed ? "digest" : held ? "held_dnd" : "now" });
  }
  runner.post("/messages", (req, res) => postMessage(req, res));
  runner.post("/notifications", (req, res) => postMessage(req, res, "alert"));
  /** Reminder PROPOSAL only: the assistant never creates reminders. The expert accepts with one click in the CRM UI,
   *  which saves the reminder through the existing POST /api/reminders under the expert's own session. */
  runner.post("/reminder-proposals", (req, res) => {
    const a = A(res); const b = req.body ?? {};
    if (a.kind === "manager") { audit({ req, a, tokenId: TK(res), action: "POST /reminder-proposals", outcome: "manager_read_only" }); return fail(res, 403, "manager_read_only", "دستیار مدیر یادآور پیشنهاد نمی‌دهد؛ فقط گزارش می‌دهد."); }
    if (b.customerId == null || b.customerId === "") return fail(res, 422, "customer_required");
    const at = Date.parse(String(b.remindAt ?? ""));
    if (!Number.isFinite(at) || at <= now().getTime() + 60_000 || at > now().getTime() + REMINDER_PROPOSAL_MAX_DAYS * 86400_000) return fail(res, 422, "bad_remind_at", "زمان یادآور باید در آینده و حداکثر ۳۰ روز بعد باشد.");
    const note = String(b.note ?? "").trim().slice(0, 300); const reason = String(b.reason ?? "").trim().slice(0, 500);
    if (hasBannedWord(`${note} ${reason}`)) { audit({ req, a, tokenId: TK(res), action: "POST /reminder-proposals", customerId: Number(b.customerId) || null, outcome: "banned_word" }); return fail(res, 422, "banned_word", "این متن واژهٔ ممنوع دارد."); }
    req.body = { ...b, body: reason || (note ? `برات یادآور بذارم؟ «${note}»` : "برات یادآور بذارم؟"), priority: b.priority === "high" ? "high" : "normal", actions: [] };
    postMessage(req, res, "reminder_proposal", (m, tt) => {
      if (tt.customerId == null) return;
      run(`INSERT INTO assistant_reminder_proposals(assistant_id,user_id,customer_id,remind_at,note,reason,message_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        a.id, tt.u.id, tt.customerId, new Date(at).toISOString(), note ? maskText(note) : null, reason ? maskText(reason) : null, m.id, iso());
    });
  });
  runner.post("/typing", (req, res) => {
    const a = A(res); const t = row<any>("SELECT * FROM assistant_threads WHERE id=? AND assistant_id=?", Number(req.body?.threadId), a.id);
    if (!t) return fail(res, 404, "thread_not_found");
    const u = userRow(t.user_id); if (!u || !userEligible(a, u)) return fail(res, 404, "thread_not_found");
    const secs = Math.max(0, Math.min(15, Number(req.body?.seconds ?? 8) || 0));
    if (!secs) run("DELETE FROM assistant_typing WHERE thread_id=?", t.id);
    else run("INSERT INTO assistant_typing(thread_id,until) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET until=excluded.until", t.id, new Date(now().getTime() + secs * 1000).toISOString());
    res.json({ ok: true });
  });
  runner.get("/threads/:id/messages", (req, res) => {
    const a = A(res); const t = row<any>("SELECT * FROM assistant_threads WHERE id=? AND assistant_id=?", Number(req.params.id), a.id);
    if (!t) return fail(res, 404, "thread_not_found");
    const u = userRow(t.user_id); if (!u || !userEligible(a, u)) return fail(res, 404, "thread_not_found");
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const list = rows<any>("SELECT * FROM assistant_messages WHERE thread_id=? AND id>? ORDER BY id DESC LIMIT 100", t.id, after).reverse()
      .filter(m => m.customer_id == null || inScope(a, m.customer_id));
    res.json(maskOut({ threadId: t.id, userId: t.user_id, messages: list.map(m => messageView(m, true)) }));
  });
  /* ---------- v8 manager (Ahmad) reads: piece A — today / this week, alerts + score, ready summaries ---------- */
  const managerOnly = (req: Request, res: Response, next: NextFunction) => {
    const a = A(res);
    if (a.kind === "manager") return next();
    audit({ req, a, tokenId: TK(res), action: `${req.method} ${req.path}`.slice(0, 80), outcome: "manager_only" });
    fail(res, 403, "manager_only", "این بخش فقط برای دستیار مدیر فروش است.");
  };
  /** Deep masking without maskData's depth cap (report → experts → alerts → numbers is deeper); keeps Persian digits when nothing is masked. */
  const lat = (x: string) => x.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const maskAll = (v: any): any => Array.isArray(v) ? v.map(maskAll)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)]))
    : typeof v === "string" ? (() => { const m = maskText(v); return m === lat(v) ? v : m; })() : v;
  const mgrSettings = () => readManagerSettings(k => row<{ value: string }>("SELECT value FROM assistant_settings WHERE key=?", k)?.value);
  const mgrDeps = () => { const t = now(); return { db, now: t, settings: mgrSettings(), excludeTest: excludeTestOn(db), siteLeads: deps.sales?.activeSiteLeads ? () => deps.sales!.activeSiteLeads!(t) : undefined }; };
  const mgrRange = (req: Request, res: Response): ManagerRange | null => {
    const r = String(req.query.range ?? "today");
    if ((MANAGER_RANGES as readonly string[]).includes(r)) return r as ManagerRange;
    fail(res, 422, "range_not_supported", `بازه‌های فعلی: ${MANAGER_RANGES.join(", ")} (دیروز و ماه در فاز بعد).`); return null;
  };
  const mgrSp = (req: Request, res: Response): number | null | false => {
    if (req.query.salespersonId == null || req.query.salespersonId === "") return null;
    const id = Number(req.query.salespersonId);
    if (!managerExperts(db).some(e => e.salespersonId === id)) { audit({ req, a: A(res), tokenId: TK(res), action: `GET ${req.path}`, outcome: "not_in_scope", detail: { salespersonId: req.query.salespersonId } }); fail(res, 404, "not_found"); return false; }
    return id;
  };
  runner.get("/manager/experts", managerOnly, (req, res) => {
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/experts", outcome: "ok" });
    res.json({ experts: managerExperts(db).map(e => ({ salespersonId: e.salespersonId, name: e.name, trainee: e.trainee })) });
  });
  runner.get("/manager/settings", managerOnly, (_req, res) => { res.json({ thresholds: mgrSettings(), defaults: MANAGER_DEFAULTS, ranges: MANAGER_RANGES, summarySlots: MANAGER_SLOTS }); });
  runner.get("/manager/report", managerOnly, (req, res) => {
    const range = mgrRange(req, res); if (!range) return; const sp = mgrSp(req, res); if (sp === false) return;
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/report", outcome: "ok", detail: { range, salespersonId: sp } });
    res.json(maskAll(managerReport(mgrDeps(), range, sp)));
  });
  runner.get("/manager/alerts", managerOnly, (req, res) => {
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/alerts", outcome: "ok" });
    res.json(maskAll(managerAlerts(mgrDeps())));
  });
  runner.get("/manager/summary", managerOnly, (req, res) => {
    const slot = String(req.query.slot ?? "");
    if (!(MANAGER_SLOTS as readonly string[]).includes(slot)) return fail(res, 422, "bad_slot", `slot یکی از: ${MANAGER_SLOTS.join(", ")}`);
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/summary", outcome: "ok", detail: { slot } });
    res.json(maskAll(managerSummary(mgrDeps(), slot as ManagerSlot)));
  });
  // v10: page-usage report (read only; user 29 is never stored). range = day | week (from Saturday) | month (last 30 Tehran days).
  const puRange = (req: Request, res: Response): PageUsageRange | null => { const r = String(req.query.range ?? "day");
    if (!(PAGE_USAGE_RANGES as readonly string[]).includes(r)) { fail(res, 422, "bad_range", `range یکی از: ${PAGE_USAGE_RANGES.join(", ")}`); return null; } return r as PageUsageRange; };
  runner.get("/manager/page-usage", managerOnly, (req, res) => {
    const range = puRange(req, res); if (!range) return;
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/page-usage", outcome: "ok", detail: { range } });
    res.json(maskAll(pageUsageReport(db, range, now())));
  });
  // v11: open «فاکتور» work (goods_purchases) and registration cases (loan_applications) — read only, manager token only.
  const workDeps = () => ({ db, now: now(), excludeTest: excludeTestOn(db) });
  const regParams = (req: Request, res: Response): { range: RegistrationRange; stuckHours: number; src: "query" | "setting" | "default" } | null => {
    const r = String(req.query.range ?? "day");
    if (!(REGISTRATION_RANGES as readonly string[]).includes(r)) { fail(res, 422, "bad_range", `range یکی از: ${REGISTRATION_RANGES.join(", ")}`); return null; }
    const q = req.query.stuckHours;
    if (q != null && q !== "") { const n = Number(q);
      if (!Number.isInteger(n) || n < 1 || n > 720) { fail(res, 422, "bad_stuck_hours", "stuckHours باید عدد صحیح ۱ تا ۷۲۰ باشد."); return null; }
      return { range: r as RegistrationRange, stuckHours: n, src: "query" }; }
    const set = row<{ value: string }>("SELECT value FROM assistant_settings WHERE key=?", MANAGER_SETTING_KEYS.registrationStuckHours);
    return { range: r as RegistrationRange, stuckHours: mgrSettings().registrationStuckHours, src: set ? "setting" : "default" };
  };
  runner.get("/manager/invoices/open", managerOnly, (req, res) => {
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/invoices/open", outcome: "ok" });
    res.json(maskAll(openInvoices(workDeps())));
  });
  runner.get("/manager/registration", managerOnly, (req, res) => {
    const p = regParams(req, res); if (!p) return;
    audit({ req, a: A(res), tokenId: TK(res), action: "GET /manager/registration", outcome: "ok", detail: { range: p.range, stuckHours: p.stuckHours } });
    res.json(maskAll(registrationReport(workDeps(), p.range, p.stuckHours, p.src)));
  });
  // Bale 1b runner routes (/bale/send: sales assistants only — the manager is refused there by kind)
  deps.extendRunner?.(runner, { inScope });
  runner.use((req, res) => { if (req.method !== "GET") return deny(req, res); fail(res, 404, "not_found"); });
  runner.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.too.large") fail(res, 413, "body_too_large");
    else if (err?.type === "entity.parse.failed") fail(res, 400, "bad_json");
    else { console.error("assistant-runner error", err?.message); fail(res, 500, "internal_error"); }
  });

  /* ================= staff router (session; mounted under /api) ================= */
  const staff = Router();
  staff.use(["/assistant", "/admin/assistants", "/admin/assistant-tokens", "/admin/assistant-audit"], (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  /* v10: page-usage beacon (session). Only the route pattern, enter time, visible dwell, menu clicks and entry source are
   * stored (lib/page-usage.ts); user 29 and a switched-off tracker store nothing. Always answers 200 so a beacon never errors. */
  staff.get("/page-usage/config", (_req, res) => { const x = deps.actor(res); res.setHeader("Cache-Control", "no-store");
    res.json({ enabled: Boolean(x && !EXCLUDED_USER_IDS.includes(Number(x.id)) && pageUsageOn(db)) }); });
  staff.post("/page-usage", (req, res) => {
    let stored = 0; let enabled = false;
    try { const x = deps.actor(res); enabled = Boolean(x && !EXCLUDED_USER_IDS.includes(Number(x.id)) && pageUsageOn(db));
      if (enabled && x) stored = recordPageUsage(db, { id: Number(x.id), role: x.role ?? null, salespersonId: x.salespersonId ?? null }, req.body, now()); } catch { /* silent */ }
    res.setHeader("Cache-Control", "no-store"); res.json({ enabled, stored });
  });
  const me = (res: Response) => { const x = deps.actor(res); return x ? userRow(x.id) : undefined; };
  /** v8: user 29 never reaches the manager assistant (dock, chat, report preview, thresholds, its admin card) — other admin access unchanged. */
  const noMgr = (u: any) => EXCLUDED_USER_IDS.includes(Number(u?.id));
  /** Assistants this user can open (enabled + global on). */
  function mine(u: any) {
    if (!u || !globalOn()) return [];
    return rows<any>("SELECT * FROM assistants WHERE enabled=1 ORDER BY id").map(normAssistant).filter(a => userEligible(a, u));
  }
  function visibleMessages(a: any, u: any, t: any, after: number, limit = 80) {
    return rows<any>("SELECT * FROM assistant_messages WHERE thread_id=? AND id>? ORDER BY id DESC LIMIT ?", t.id, after, limit).reverse()
      .filter(m => m.author === "user" || userSeesCase(a, u, m.customer_id ?? null));
  }
  function threadAccess(req: Request, res: Response) {
    const u = me(res); if (!u) { fail(res, 401, "unauthorized"); return null; }
    if (noMgr(u)) { const ta = row<any>("SELECT a.* FROM assistant_threads t JOIN assistants a ON a.id=t.assistant_id WHERE t.id=?", Number(req.params.id));
      if (ta && normAssistant(ta)?.kind === "manager") { audit({ req, a: ta, userId: u.id, actorLabel: u.full_name || u.username, action: `${req.method} manager thread`, outcome: "forbidden" }); fail(res, 403, "forbidden"); return null; } }
    const t = row<any>("SELECT * FROM assistant_threads WHERE id=? AND user_id=?", Number(req.params.id), u.id);
    const a = t ? mine(u).find(x => x.id === t.assistant_id) : undefined;
    if (!t || !a) { fail(res, 404, "not_found"); return null; }
    return { u, t, a };
  }
  function threadState(a: any, t: any) {
    const ty = row<any>("SELECT until FROM assistant_typing WHERE thread_id=?", t.id);
    const fresh = row<any>("SELECT last_seen_at FROM assistants WHERE id=?", a.id);
    return { typing: Boolean(ty && Date.parse(ty.until) > now().getTime()), online: online(fresh) };
  }
  staff.get("/assistant/mine", (_req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const list = mine(u).map(a => {
      const t = threadFor(a, u.id, true);
      const unread = visibleMessages(a, u, t, 0, 200).filter(m => m.author !== "user" && !m.read_at).length;
      return { id: a.id, slug: a.slug, name: a.display_name, label: label(a), kind: a.kind, threadId: t.id, unread, ...threadState(a, t) };
    });
    res.json({ assistants: list, prefs: prefsOf(u.id) });
  });
  staff.get("/assistant/threads/:id/messages", async (req, res) => {
    const x = threadAccess(req, res); if (!x) return;
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const seenState = () => rows<any>("SELECT id,picked_at FROM assistant_messages WHERE thread_id=? AND author='user' AND picked_at IS NULL", x.t.id).length;
    const before = { pending: seenState(), ...threadState(x.a, x.t) };
    const got = await longPoll(req, res, `u${x.u.id}`, STAFF_MAX_WAIT_S, () => {
      const l = visibleMessages(x.a, x.u, x.t, after); const st = threadState(x.a, x.t);
      return l.length || seenState() !== before.pending || st.typing !== before.typing || st.online !== before.online ? l : null;
    });
    if (got === undefined) return;
    const list = got || [];
    const t = iso();
    for (const m of list) if (m.author !== "user" && !m.delivered_at) run("UPDATE assistant_messages SET delivered_at=? WHERE id=?", t, m.id);
    const recentUser = rows<any>("SELECT id,picked_at FROM assistant_messages WHERE thread_id=? AND author='user' ORDER BY id DESC LIMIT 30", x.t.id)
      .map(m => ({ id: Number(m.id), seen: Boolean(m.picked_at) }));
    res.json({ threadId: x.t.id, assistant: { id: x.a.id, name: x.a.display_name, label: label(x.a) }, messages: list.map(m => messageView(m)), userSeen: recentUser, ...threadState(x.a, x.t), prefs: prefsOf(x.u.id) });
  });
  staff.post("/assistant/threads/:id/messages", (req, res) => {
    const x = threadAccess(req, res); if (!x) return;
    const body = String(req.body?.body ?? "").trim(); const clientId = req.body?.clientId == null ? null : String(req.body.clientId).slice(0, 80);
    if (!body || body.length > MAX_BODY) return fail(res, 422, "bad_body");
    if (clientId) { const dup = row<any>("SELECT * FROM assistant_messages WHERE thread_id=? AND author='user' AND client_id=?", x.t.id, clientId); if (dup) return void res.json({ message: messageView(dup) }); }
    const customerId = req.body?.customerId == null ? null : Number(req.body.customerId);
    if (customerId != null && !userSeesCase(x.a, x.u, customerId)) return fail(res, 404, "not_found");
    const r = run(`INSERT INTO assistant_messages(thread_id,author,author_label,kind,priority,body,customer_id,client_id,origin,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, x.t.id, "user", x.u.full_name || x.u.username, "text", "normal", body, customerId, clientId, "user", iso());
    const id = Number(r.lastInsertRowid);
    event(x.a, "user_message", { threadId: x.t.id, userId: x.u.id, customerId, messageId: id });
    audit({ a: x.a, req, userId: x.u.id, actorLabel: x.u.full_name || x.u.username, action: "user.message", customerId, outcome: "ok", detail: { len: body.length } });
    res.status(201).json({ message: messageView(row<any>("SELECT * FROM assistant_messages WHERE id=?", id)) });
  });
  staff.post("/assistant/threads/:id/read", (req, res) => {
    const x = threadAccess(req, res); if (!x) return;
    const upTo = Number(req.body?.upTo);
    if (!Number.isSafeInteger(upTo) || upTo < 0) return fail(res, 422, "bad_cursor");
    run("UPDATE assistant_messages SET read_at=?, delivered_at=COALESCE(delivered_at,?) WHERE thread_id=? AND author<>'user' AND id<=? AND read_at IS NULL", iso(), iso(), x.t.id, upTo);
    try { bellRead(x.t.id, x.t.user_id, upTo); } catch { /* best-effort */ }
    res.json({ ok: true });
  });
  staff.post("/assistant/messages/:id/action", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const m = row<any>("SELECT m.*,t.user_id,t.assistant_id FROM assistant_messages m JOIN assistant_threads t ON t.id=m.thread_id WHERE m.id=?", Number(req.params.id));
    const a = m && m.user_id === u.id ? mine(u).find(x => x.id === m.assistant_id) : undefined;
    if (!m || !a || m.author === "user" || !userSeesCase(a, u, m.customer_id ?? null)) return fail(res, 404, "not_found");
    const action = String(req.body?.action ?? "");
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(res, 422, "bad_action");
    const t = iso();
    run("UPDATE assistant_messages SET acted_at=?, action_taken=?, read_at=COALESCE(read_at,?) WHERE id=?", t, action, t, m.id);
    event(a, "message_action", { threadId: m.thread_id, userId: u.id, customerId: m.customer_id, messageId: m.id, data: { action } });
    audit({ a, req, userId: u.id, actorLabel: u.full_name || u.username, action: `user.action.${action}`, customerId: m.customer_id, outcome: "ok" });
    res.json({ ok: true });
  });
  /** The expert's one-click «بله» saved the reminder via the existing POST /api/reminders (own session, own permission);
   *  here we only link it to the proposal after checking it is really that user's fresh reminder on that customer. */
  staff.post("/assistant/reminder-proposals/:id/decide", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const p = row<any>("SELECT * FROM assistant_reminder_proposals WHERE id=?", Number(req.params.id));
    const a = p && p.user_id === u.id ? mine(u).find(x => x.id === p.assistant_id) : undefined;
    if (!p || !a || !userSeesCase(a, u, p.customer_id)) return fail(res, 404, "not_found");
    if (p.status !== "pending") return fail(res, 409, "already_decided");
    const accept = req.body?.accept === true; const t = iso();
    if (accept) {
      const rid = Number(req.body?.reminderId);
      const r = Number.isSafeInteger(rid) ? row<any>("SELECT id,user_id,customer_id,created_at FROM reminders WHERE id=?", rid) : undefined;
      if (!r || r.user_id !== u.id || Number(r.customer_id) !== Number(p.customer_id) || now().getTime() - Date.parse(r.created_at) > 15 * 60_000) return fail(res, 422, "bad_reminder");
      if (row("SELECT 1 FROM assistant_reminder_proposals WHERE reminder_id=?", rid)) return fail(res, 409, "reminder_already_linked");
      run("UPDATE assistant_reminder_proposals SET status='accepted', decided_by_user_id=?, decided_at=?, reminder_id=? WHERE id=?", u.id, t, rid, p.id);
    } else run("UPDATE assistant_reminder_proposals SET status='rejected', decided_by_user_id=?, decided_at=? WHERE id=?", u.id, t, p.id);
    if (p.message_id) run("UPDATE assistant_messages SET acted_at=?, action_taken=?, read_at=COALESCE(read_at,?) WHERE id=?", t, accept ? "reminder" : "dismissed", t, p.message_id);
    event(a, "suggestion_action", { threadId: row<any>("SELECT thread_id FROM assistant_messages WHERE id=?", p.message_id)?.thread_id ?? null, userId: u.id, customerId: p.customer_id, messageId: p.message_id, data: { proposalId: p.id, accepted: accept } });
    audit({ a, req, userId: u.id, actorLabel: u.full_name || u.username, action: accept ? "user.proposal.accept" : "user.proposal.reject", customerId: p.customer_id, outcome: "ok", detail: { proposalId: p.id } });
    res.json({ proposal: proposalView(row<any>("SELECT * FROM assistant_reminder_proposals WHERE id=?", p.id)) });
  });
  staff.get("/assistant/settings", (_req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    res.json({ creditInquiryPermission: setting("credit_inquiry_permission", "manager") });
  });
  staff.put("/assistant/prefs", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const cur = prefsOf(u.id); const b = req.body ?? {};
    const sound = b.sound === undefined ? cur.sound : Boolean(b.sound);
    let dnd: string | null = cur.dndUntil;
    if (b.dndMinutes !== undefined) {
      const mins = Number(b.dndMinutes);
      if (!Number.isFinite(mins) || mins < 0 || mins > 24 * 60) return fail(res, 422, "bad_dnd");
      dnd = mins ? new Date(now().getTime() + mins * 60_000).toISOString() : null;
    }
    run(`INSERT INTO assistant_user_prefs(user_id,sound,dnd_until,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET sound=excluded.sound,dnd_until=excluded.dnd_until,updated_at=excluded.updated_at`, u.id, sound ? 1 : 0, dnd, iso());
    if (b.dndMinutes !== undefined) for (const a of mine(u)) event(a, "user_status", { userId: u.id, data: { dndUntil: dnd } });
    res.json({ prefs: prefsOf(u.id) });
  });

  /* ---------------- admin ---------------- */
  const admin = (req: Request, res: Response, next: NextFunction) => { const u = me(res); if (!u || u.role !== "admin") return fail(res, 403, "forbidden"); res.locals.assistantAdmin = u; next(); };
  const adminView = (raw: any) => {
    const a = normAssistant(raw);
    const bound = a.bound_user_id ? userRow(a.bound_user_id) : null;
    return { id: a.id, slug: a.slug, name: a.display_name, label: label(a), kind: a.kind, boundRole: a.bound_role, scopeRule: a.scope_rule,
      boundUser: bound ? { id: bound.id, name: bound.full_name || bound.username } : null, enabled: Boolean(a.enabled), maxMessagesPerHour: a.max_msgs_per_hour,
      online: online(a), lastSeenAt: a.last_seen_at,
      tokens: rows<any>("SELECT id,name,created_at,last_used_at,revoked_at FROM assistant_tokens WHERE assistant_id=? ORDER BY id DESC", a.id)
        .map(t => ({ id: t.id, name: t.name, createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at })) };
  };
  staff.put("/admin/assistants/settings", admin, (req, res) => {
    const v = String(req.body?.creditInquiryPermission ?? ""); const u = res.locals.assistantAdmin;
    if (v !== "manager" && v !== "expert") return fail(res, 422, "bad_value");
    run("INSERT INTO assistant_settings(key,value,updated_at,updated_by_user_id) VALUES('credit_inquiry_permission',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", v, iso(), u.id);
    audit({ req, userId: u.id, actorLabel: u.full_name || u.username, action: "admin.credit_inquiry_permission", outcome: "ok", detail: { value: v } });
    res.json({ creditInquiryPermission: v });
  });
  staff.get("/admin/assistants", admin, (_req, res) => { res.json({ globalEnabled: globalOn(), creditInquiryPermission: setting("credit_inquiry_permission", "manager"), managerAccess: !noMgr(res.locals.assistantAdmin),
    assistants: rows<any>("SELECT * FROM assistants ORDER BY id").filter(r => !(noMgr(res.locals.assistantAdmin) && normAssistant(r)?.kind === "manager")).map(adminView) }); });
  staff.put("/admin/assistants/global", admin, (req, res) => {
    const on = Boolean(req.body?.enabled); const u = res.locals.assistantAdmin;
    run("UPDATE assistant_settings SET value=?, updated_at=?, updated_by_user_id=? WHERE key='global_enabled'", on ? "1" : "0", iso(), u.id);
    audit({ req, userId: u.id, actorLabel: u.full_name || u.username, action: on ? "admin.global_on" : "admin.global_off", outcome: "ok" });
    res.json({ globalEnabled: globalOn() });
  });
  const adminA = (req: Request, res: Response) => { const a = normAssistant(row<any>("SELECT * FROM assistants WHERE id=?", Number(req.params.id))); if (!a) { fail(res, 404, "not_found"); return a; }
    if (a.kind === "manager" && noMgr(res.locals.assistantAdmin)) { mgrForbidden(req, res); return null; } return a; };
  const mgrForbidden = (req: Request, res: Response) => { const u = res.locals.assistantAdmin; audit({ req, userId: u?.id ?? null, actorLabel: u ? (u.full_name || u.username) : undefined, action: `${req.method} ${req.path.replace(/\/\d+(?=\/|$)/g, "/:id")}`.slice(0, 80), outcome: "forbidden" }); fail(res, 403, "forbidden"); };
  const mgrAdmin = (req: Request, res: Response, next: NextFunction) => noMgr(res.locals.assistantAdmin) ? mgrForbidden(req, res) : next();
  for (const [p, v] of [["enable", 1], ["disable", 0]] as const) staff.post(`/admin/assistants/:id/${p}`, admin, (req, res) => {
    const a = adminA(req, res); if (!a) return; const u = res.locals.assistantAdmin;
    run("UPDATE assistants SET enabled=?, updated_at=?, updated_by_user_id=? WHERE id=?", v, iso(), u.id, a.id);
    audit({ req, a, userId: u.id, actorLabel: u.full_name || u.username, action: `admin.${p}`, outcome: "ok" });
    res.json(adminView(row<any>("SELECT * FROM assistants WHERE id=?", a.id)));
  });
  /* v8 manager thresholds (assistant_settings manager_* keys only) + an admin preview of the manager report. */
  staff.get("/admin/assistants/manager-settings", admin, mgrAdmin, (_req, res) => { res.json({ thresholds: mgrSettings(), defaults: MANAGER_DEFAULTS }); });
  staff.put("/admin/assistants/manager-settings", admin, mgrAdmin, (req, res) => {
    const v = validateManagerSettings(req.body); const u = res.locals.assistantAdmin;
    if (!v.ok) return fail(res, 422, v.error, v.field ? `مقدار «${v.field}» معتبر نیست.` : undefined);
    for (const [k, val] of v.values) run("INSERT INTO assistant_settings(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", k, val, iso(), u.id);
    audit({ req, userId: u.id, actorLabel: u.full_name || u.username, action: "admin.manager_settings", outcome: "ok", detail: Object.fromEntries(v.values) });
    res.json({ thresholds: mgrSettings(), defaults: MANAGER_DEFAULTS });
  });
  // v10: reporting switches (admin only, user 29 refused): exclude test customers from reports (default ON), page-usage tracker (default ON).
  const reportingSettings = () => ({ excludeTestCustomers: excludeTestOn(db), pageUsageEnabled: pageUsageOn(db) });
  staff.get("/admin/assistants/reporting-settings", admin, mgrAdmin, (_req, res) => { res.json({ ...reportingSettings(), defaults: { excludeTestCustomers: true, pageUsageEnabled: true } }); });
  staff.put("/admin/assistants/reporting-settings", admin, mgrAdmin, (req, res) => {
    const b = req.body ?? {}; const u = res.locals.assistantAdmin; const changed: Record<string, boolean> = {};
    for (const [field, key] of [["excludeTestCustomers", EXCLUDE_TEST_CUSTOMERS_KEY], ["pageUsageEnabled", PAGE_USAGE_ENABLED_KEY]] as const) {
      if (b[field] === undefined) continue;
      if (typeof b[field] !== "boolean") return fail(res, 422, "bad_value", `${field} باید true یا false باشد`);
      run("INSERT INTO assistant_settings(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", key, b[field] ? "1" : "0", iso(), u.id); changed[field] = b[field];
    }
    if (!Object.keys(changed).length) return fail(res, 422, "nothing_to_change");
    audit({ req, userId: u.id, actorLabel: u.full_name || u.username, action: "admin.reporting_settings", outcome: "ok", detail: changed });
    res.json(reportingSettings());
  });
  staff.get("/admin/assistants/page-usage", admin, mgrAdmin, (req, res) => {
    const range = puRange(req, res); if (!range) return;
    res.json(pageUsageReport(db, range, now()));
  });
  staff.get("/admin/assistants/manager-report", admin, mgrAdmin, (req, res) => {
    const r = String(req.query.range ?? "today");
    if (!(MANAGER_RANGES as readonly string[]).includes(r)) return fail(res, 422, "range_not_supported");
    res.json(maskAll(managerReport(mgrDeps(), r as ManagerRange)));
  });
  // v11 admin previews (user 29 refused, like every manager admin route)
  staff.get("/admin/assistants/manager-invoices", admin, mgrAdmin, (_req, res) => { res.json(maskAll(openInvoices(workDeps()))); });
  staff.get("/admin/assistants/manager-registration", admin, mgrAdmin, (req, res) => {
    const p = regParams(req, res); if (!p) return; res.json(maskAll(registrationReport(workDeps(), p.range, p.stuckHours, p.src)));
  });
  staff.put("/admin/assistants/:id", admin, (req, res) => {
    const a = adminA(req, res); if (!a) return; const u = res.locals.assistantAdmin;
    const n = Number(req.body?.maxMessagesPerHour);
    if (!Number.isSafeInteger(n) || n < 1 || n > 30) return fail(res, 422, "bad_limit");
    run("UPDATE assistants SET max_msgs_per_hour=?, updated_at=?, updated_by_user_id=? WHERE id=?", n, iso(), u.id, a.id);
    audit({ req, a, userId: u.id, actorLabel: u.full_name || u.username, action: "admin.limit", outcome: "ok", detail: { n } });
    res.json(adminView(row<any>("SELECT * FROM assistants WHERE id=?", a.id)));
  });
  staff.post("/admin/assistants/:id/tokens", admin, (req, res) => {
    const a = adminA(req, res); if (!a) return; const u = res.locals.assistantAdmin;
    const name = String(req.body?.name ?? `${a.slug}-runner`).trim().slice(0, 60) || `${a.slug}-runner`;
    const token = `nva_${a.slug}_${randomBytes(32).toString("base64url")}`;
    const r = run("INSERT INTO assistant_tokens(assistant_id,name,token_hash,created_at,created_by_user_id) VALUES(?,?,?,?,?)", a.id, name, hashAssistantToken(token), iso(), u.id);
    audit({ req, a, userId: u.id, actorLabel: u.full_name || u.username, action: "admin.token_issue", outcome: "ok", detail: { tokenId: Number(r.lastInsertRowid) } });
    res.status(201).json({ id: Number(r.lastInsertRowid), name, token, note: "این توکن فقط همین یک بار نمایش داده می‌شود." });
  });
  staff.post("/admin/assistant-tokens/:id/revoke", admin, (req, res) => {
    const t = row<any>("SELECT * FROM assistant_tokens WHERE id=?", Number(req.params.id)); if (!t) return fail(res, 404, "not_found");
    if (noMgr(res.locals.assistantAdmin) && normAssistant(row<any>("SELECT * FROM assistants WHERE id=?", t.assistant_id))?.kind === "manager") return mgrForbidden(req, res);
    const u = res.locals.assistantAdmin;
    run("UPDATE assistant_tokens SET revoked_at=COALESCE(revoked_at,?), revoked_by_user_id=COALESCE(revoked_by_user_id,?) WHERE id=?", iso(), u.id, t.id);
    audit({ req, a: row<any>("SELECT * FROM assistants WHERE id=?", t.assistant_id), userId: u.id, actorLabel: u.full_name || u.username, action: "admin.token_revoke", outcome: "ok", detail: { tokenId: t.id } });
    res.json({ ok: true });
  });
  staff.get("/admin/assistant-audit", admin, (req, res) => {
    const aid = req.query.assistantId ? Number(req.query.assistantId) : null;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
    // user 29 (excluded) never sees the manager assistant's audit rows; the rest of the audit stays visible
    const hideMgr = noMgr(res.locals.assistantAdmin);
    const w = [aid ? "assistant_id=?" : "", hideMgr ? "(assistant_id IS NULL OR assistant_id NOT IN (SELECT id FROM assistants WHERE scope_rule='manager'))" : ""].filter(Boolean);
    const items = rows<any>(`SELECT * FROM assistant_audit ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...(aid ? [aid] : []), limit)
      .map(x => ({ id: x.id, at: x.at, assistantId: x.assistant_id, actor: x.actor_label, action: x.action, customerId: x.customer_id, outcome: x.outcome, detail: x.detail_json ? JSON.parse(x.detail_json) : null }));
    res.json({ items });
  });

  return { runner, staff, _internal: { scopeSql, inScope, userEligible, userSeesCase } };
}
