/**
 * crm-site-leads: «سرنخ سایت» / «درخواست چندباره» per website request, top-of-list ordering and the call deadline.
 *
 * - Every website form (request wizard → public_leads, «درخواست تماس» → callback_requests once it is linked to a
 *   customer) becomes one row in site_lead_requests. The row is ACTIVE until a call is logged for that customer
 *   after it (call_logs AFTER INSERT trigger fills answered_at / answered_by_call_id), or until the callback itself is
 *   marked «تماس گرفته شد». Answered rows stay as history.
 * - «درخواست چندباره» = the request came from someone who was already a customer (any priority, P1 included).
 * - Deadline = the existing team-sales rule: closerFirstCallWorkingHours (3) WORKING hours (addWorkingHours), counted
 *   from the site request — or from the start of the window the customer asked for («صبح» 9–13, «عصر» 13–18) when the
 *   request came in before that window — and, for «از کاظمی», from Kazemi's hand-off.
 * - Display/order/alert only: never ownership, transfer, priority, case stage, SMS or notification_settings.
 */
import type { DatabaseSync } from "node:sqlite";
import { crmDb, execute, queryRow, queryRows, type SqlValue } from "./crm-db";
import { ensureSchemaObject } from "./schema-objects";
import { getTeamSalesConfig } from "./team-sales";
import { addWorkingHours, shiftIntoWorkingHours, type TeamSalesConfig } from "./team-sales-rules";
import { kazemiSources } from "./kazemi-source";
import { CALLBACK_CONFIG } from "./callback-config";

export type SiteLeadSource = "lead" | "callback";
export type SiteLeadContactTime = "morning" | "evening" | "any" | "now";
export const SITE_LEAD_CONTACT_FA: Record<string, string> = {
  morning: "صبح", evening: "عصر", any: "فرقی نمی‌کند", now: "همین الان",
};
export const SITE_LEAD_WINDOW_KIND = "site-lead-window";

/** Timeline rows that are not a call with the customer (P1 hand-off note, manager accuracy review). */
export function realCallSql(subjectColumn: string): string {
  return `(COALESCE(${subjectColumn},'') NOT LIKE 'ارتقا به اولویت ۱ توسط%' AND COALESCE(${subjectColumn},'') NOT IN ('اطلاعات تماس اول درست بود','اطلاعات تماس اول درست نبود'))`;
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS site_lead_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lead','callback')),
  source_id INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  contact_time TEXT NOT NULL DEFAULT 'any',
  is_repeat INTEGER NOT NULL DEFAULT 0 CHECK(is_repeat IN (0,1)),
  owner_salesperson_id INTEGER,
  answered_at TEXT,
  answered_by_call_id INTEGER,
  answer_source TEXT,
  window_alerted_at TEXT,
  window_alert_telegram TEXT,
  backfilled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_id))`;
const INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_site_lead_requests_open ON site_lead_requests(customer_id) WHERE answered_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_site_lead_requests_customer ON site_lead_requests(customer_id, requested_at)",
];
const TRIGGER_NAME = "site_lead_requests_answer";
const TRIGGER_SQL = `CREATE TRIGGER ${TRIGGER_NAME} AFTER INSERT ON call_logs
  WHEN NEW.customer_id IS NOT NULL AND ${realCallSql("NEW.subject")}
  BEGIN
    UPDATE site_lead_requests SET answered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), answered_by_call_id=NEW.id, answer_source='call_log'
    WHERE customer_id=NEW.customer_id AND answered_at IS NULL;
  END`;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function canonicalId(db: DatabaseSync, id: number | null): number | null {
  let cur = id;
  for (let i = 0; cur != null && i < 50; i++) {
    const row = db.prepare("SELECT merged_into_customer_id m FROM customers WHERE id=?").get(cur) as { m: number | null } | undefined;
    if (!row) return null;
    if (row.m == null) return cur;
    cur = Number(row.m);
  }
  return cur;
}

export type BackfillRow = { source: SiteLeadSource; sourceId: number; customerId: number; requestedAt: string; contactTime: string;
  isRepeat: boolean; answeredAt: string | null; answeredByCallId: number | null; ownerSalespersonId: number | null };

/** Every past site request linked to a customer, with whether a real call was logged after it. Read-only. */
export function computeSiteLeadBackfill(db: DatabaseSync): BackfillRow[] {
  const out: BackfillRow[] = [];
  const firstCall = db.prepare(`SELECT id, created_at FROM call_logs WHERE customer_id=? AND created_at>? AND ${realCallSql("subject")}
    ORDER BY created_at, id LIMIT 1`);
  const owner = db.prepare("SELECT salesperson_id s, created_at c FROM customers WHERE id=?");
  const push = (source: SiteLeadSource, sourceId: number, rawCustomer: number | null, at: string, ct: string, repeat: (created: string | null) => boolean) => {
    const customerId = canonicalId(db, rawCustomer);
    if (customerId == null) return;
    const o = owner.get(customerId) as { s: number | null; c: string | null } | undefined;
    const call = firstCall.get(customerId, at) as { id: number; created_at: string } | undefined;
    out.push({ source, sourceId, customerId, requestedAt: at, contactTime: ct || "any", isRepeat: repeat(o?.c ?? null),
      answeredAt: call?.created_at ?? null, answeredByCallId: call ? Number(call.id) : null, ownerSalespersonId: o?.s == null ? null : Number(o.s) });
  };
  if (tableExists(db, "public_leads")) {
    for (const r of db.prepare("SELECT id, customer_id, outcome, contact_time, created_at FROM public_leads WHERE customer_id IS NOT NULL ORDER BY id").all() as
      { id: number; customer_id: number; outcome: string; contact_time: string; created_at: string }[])
      push("lead", Number(r.id), Number(r.customer_id), r.created_at, r.contact_time, () => r.outcome === "existing_customer");
  }
  if (tableExists(db, "callback_requests")) {
    for (const r of db.prepare("SELECT id, customer_id, contact_time, created_at FROM callback_requests WHERE customer_id IS NOT NULL ORDER BY id").all() as
      { id: number; customer_id: number; contact_time: string; created_at: string }[])
      push("callback", Number(r.id), Number(r.customer_id), r.created_at, r.contact_time, (created) => created != null && created < r.created_at);
  }
  return out;
}

let ready = false;
/**
 * Additive migration. The table is created (and back-filled in the same transaction) only when it is missing, so
 * PRAGMA schema_version moves exactly once; indexes use IF NOT EXISTS and the trigger goes through ensureSchemaObject.
 * Must run outside a transaction (startup / before the intake transaction).
 */
export function ensureSiteLeadSchema(db: DatabaseSync = crmDb, now = new Date()): { created: boolean; backfilled: number } {
  if (ready && db === crmDb) return { created: false, backfilled: 0 };
  let created = false, backfilled = 0;
  if (!tableExists(db, "site_lead_requests")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(TABLE_SQL);
      for (const sql of INDEX_SQL) db.exec(sql);
      const at = now.toISOString();
      const ins = db.prepare(`INSERT OR IGNORE INTO site_lead_requests(customer_id,source,source_id,requested_at,contact_time,is_repeat,owner_salesperson_id,
        answered_at,answered_by_call_id,answer_source,window_alerted_at,backfilled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`);
      for (const r of computeSiteLeadBackfill(db)) {
        // Back-filled requests never fire a retroactive «زمان تماس» alert (window_alerted_at = migration time).
        ins.run(r.customerId, r.source, r.sourceId, r.requestedAt, r.contactTime, r.isRepeat ? 1 : 0, r.ownerSalespersonId,
          r.answeredAt, r.answeredByCallId, r.answeredAt ? "backfill" : null, at, at);
        backfilled++;
      }
      if (tableExists(db, "call_logs")) ensureSchemaObject(db, "trigger", TRIGGER_NAME, TRIGGER_SQL);
      db.exec("COMMIT");
      created = true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  for (const sql of INDEX_SQL) db.exec(sql);
  if (tableExists(db, "call_logs")) ensureSchemaObject(db, "trigger", TRIGGER_NAME, TRIGGER_SQL);
  if (db === crmDb) ready = true;
  return { created, backfilled };
}

/** Called inside the intake transaction (schema already ensured). Idempotent per (source, source_id). */
export function recordSiteLeadRequest(r: { customerId: number; source: SiteLeadSource; sourceId: number; requestedAt: string;
  contactTime: string | null | undefined; isRepeat: boolean }): void {
  const owner = queryRow<{ s: number | null }>("SELECT salesperson_id s FROM customers WHERE id=?", [r.customerId])?.s ?? null;
  execute(`INSERT OR IGNORE INTO site_lead_requests(customer_id,source,source_id,requested_at,contact_time,is_repeat,owner_salesperson_id,created_at)
    VALUES (?,?,?,?,?,?,?,?)`, [r.customerId, r.source, r.sourceId, r.requestedAt, r.contactTime || "any", r.isRepeat ? 1 : 0, owner, new Date().toISOString()]);
}

/** «درخواست تماس» marked «تماس گرفته شد» (or cancelled as duplicate / wrong number / …) on the callbacks page closes that request. */
export function answerCallbackSiteLead(callbackId: number, at: string, how: "callback_called" | "callback_cancelled" = "callback_called"): void {
  if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='site_lead_requests'")) return;
  execute("UPDATE site_lead_requests SET answered_at=?, answer_source=? WHERE source='callback' AND source_id=? AND answered_at IS NULL",
    [at, how, callbackId]);
}

/* ---------------- time helpers (Tehran fixed +03:30, same as team-sales-rules) ---------------- */
const OFF = 3.5 * 3600_000;
const wallHour = (d: Date) => { const w = new Date(d.getTime() + OFF); return w.getUTCHours() + w.getUTCMinutes() / 60 + w.getUTCSeconds() / 3600; };
const atWallHour = (d: Date, hour: number, addDays = 0) => {
  const w = new Date(d.getTime() + OFF); w.setUTCDate(w.getUTCDate() + addDays); w.setUTCHours(hour, 0, 0, 0); return new Date(w.getTime() - OFF);
};
export function contactWindow(ct: string | null | undefined): { start: number; end: number } | null {
  return ct === "morning" ? CALLBACK_CONFIG.morning : ct === "evening" ? CALLBACK_CONFIG.evening : null;
}
/** When the 3-working-hour clock starts: the request time, moved into working hours and into the asked window. */
export function deadlineStart(requestedAt: Date, ct: string | null | undefined, cfg: TeamSalesConfig): Date {
  let s = shiftIntoWorkingHours(requestedAt, cfg);
  const win = contactWindow(ct);
  if (!win) return s;
  for (let i = 0; i < 14; i++) {
    const h = wallHour(s);
    if (h < win.start) return atWallHour(s, win.start);
    if (h < win.end) return s;
    s = shiftIntoWorkingHours(atWallHour(s, 0, 1), cfg);
  }
  return s;
}
export function siteLeadDue(requestedAt: Date, ct: string | null | undefined, cfg: TeamSalesConfig): Date {
  return addWorkingHours(deadlineStart(requestedAt, ct, cfg), cfg.closerFirstCallWorkingHours, cfg);
}
export function inWorkingHours(now: Date, cfg: TeamSalesConfig): boolean {
  return shiftIntoWorkingHours(now, cfg).getTime() === now.getTime();
}
/** The customer's asked window is now (any / now = any working time). */
export function windowIsNow(ct: string | null | undefined, now: Date, cfg: TeamSalesConfig): boolean {
  if (!inWorkingHours(now, cfg)) return false;
  const win = contactWindow(ct);
  if (!win) return true;
  const h = wallHour(now);
  return h >= win.start && h < win.end;
}

/* ---------------- read side ---------------- */
export type SiteLeadState = {
  active: true;
  /** Oldest unanswered request (drives the deadline). */
  requestedAt: string;
  latestRequestedAt: string;
  dueAt: string;
  /** Preferred time of the latest unanswered request. */
  contactTime: string;
  contactTimeFa: string;
  isRepeat: boolean;
  windowNow: boolean;
  openRequests: number;
};
type OpenRow = { id: number; customer_id: number; requested_at: string; contact_time: string; is_repeat: number };

function siteLeadsReady(): boolean {
  try { ensureSiteLeadSchema(); return true; } catch { return false; }
}

export function siteLeadsTableReady(): boolean { return siteLeadsReady(); }

export type QueueItem = TopEntry & { name: string; priority: number | null; salespersonId: number | null; salespersonName: string | null; siteLead: SiteLeadState | null };
/** The «اول لیست» rows with names / owners for the call pages, scoped like the customer list. */
export function siteLeadQueue(scopeSalespersonId: number | null, now = new Date()): { items: QueueItem[]; counts: { salespersonId: number | null; salespersonName: string | null; siteLeads: number; repeats: number; fromKazemi: number; overdue: number }[] } {
  const cfg = getTeamSalesConfig();
  const top = topOfList(now, cfg);
  if (!top.length) return { items: [], counts: [] };
  const ids = top.map((t) => t.customerId);
  const info = new Map<number, { name: string; priority: number | null; salesperson_id: number | null; sp: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of queryRows<{ id: number; name: string; priority: number | null; salesperson_id: number | null; sp: string | null }>(
      `SELECT c.id, c.name, c.priority, c.salesperson_id, s.name sp FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
       WHERE c.id IN (${chunk.map(() => "?").join(",")})`, chunk)) info.set(Number(r.id), r);
  }
  const leads = activeSiteLeads(ids, now, cfg);
  const all: QueueItem[] = top.flatMap((t) => {
    const r = info.get(t.customerId);
    if (!r) return [];
    return [{ ...t, name: r.name, priority: r.priority == null ? null : Number(r.priority), salespersonId: r.salesperson_id == null ? null : Number(r.salesperson_id),
      salespersonName: r.sp, siteLead: leads.get(t.customerId) ?? null }];
  });
  const items = scopeSalespersonId == null ? all : all.filter((x) => x.salespersonId === scopeSalespersonId);
  const counts = new Map<string, { salespersonId: number | null; salespersonName: string | null; siteLeads: number; repeats: number; fromKazemi: number; overdue: number }>();
  for (const x of items) {
    const key = String(x.salespersonId);
    const c = counts.get(key) ?? { salespersonId: x.salespersonId, salespersonName: x.salespersonName, siteLeads: 0, repeats: 0, fromKazemi: 0, overdue: 0 };
    if (x.kind === "site_lead") { c.siteLeads++; if (x.siteLead?.isRepeat) c.repeats++; } else c.fromKazemi++;
    if (new Date(x.dueAt).getTime() <= now.getTime()) c.overdue++;
    counts.set(key, c);
  }
  return { items, counts: [...counts.values()] };
}

export function activeSiteLeads(customerIds?: number[], now = new Date(), cfg: TeamSalesConfig = getTeamSalesConfig()): Map<number, SiteLeadState> {
  const out = new Map<number, SiteLeadState>();
  if (!siteLeadsReady()) return out;
  const ids = customerIds ? [...new Set(customerIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : null;
  if (ids && !ids.length) return out;
  const rows: OpenRow[] = [];
  const base = `SELECT r.id, r.customer_id, r.requested_at, r.contact_time, r.is_repeat FROM site_lead_requests r
    JOIN customers c ON c.id=r.customer_id AND c.merged_into_customer_id IS NULL WHERE r.answered_at IS NULL`;
  if (ids) for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...queryRows<OpenRow>(`${base} AND r.customer_id IN (${chunk.map(() => "?").join(",")}) ORDER BY r.requested_at, r.id`, chunk));
  } else rows.push(...queryRows<OpenRow>(`${base} ORDER BY r.requested_at, r.id`));
  const by = new Map<number, OpenRow[]>();
  for (const r of rows) { const l = by.get(Number(r.customer_id)) ?? []; l.push(r); by.set(Number(r.customer_id), l); }
  for (const [cid, list] of by) {
    const first = list[0], last = list[list.length - 1];
    out.set(cid, {
      active: true, requestedAt: first.requested_at, latestRequestedAt: last.requested_at,
      dueAt: siteLeadDue(new Date(first.requested_at), first.contact_time, cfg).toISOString(),
      contactTime: last.contact_time, contactTimeFa: SITE_LEAD_CONTACT_FA[last.contact_time] ?? last.contact_time,
      isRepeat: list.some((r) => Number(r.is_repeat) === 1), windowNow: windowIsNow(last.contact_time, now, cfg), openRequests: list.length,
    });
  }
  return out;
}

export type SiteLeadHistoryItem = { id: number; source: SiteLeadSource; requestedAt: string; contactTime: string; contactTimeFa: string;
  isRepeat: boolean; answeredAt: string | null; answeredByCallId: number | null; answerSource: string | null; backfilled: boolean };
export function siteLeadHistory(customerId: number): SiteLeadHistoryItem[] {
  if (!siteLeadsReady()) return [];
  return queryRows<{ id: number; source: SiteLeadSource; requested_at: string; contact_time: string; is_repeat: number; answered_at: string | null;
    answered_by_call_id: number | null; answer_source: string | null; backfilled: number }>(
    `SELECT id, source, requested_at, contact_time, is_repeat, answered_at, answered_by_call_id, answer_source, backfilled
     FROM site_lead_requests WHERE customer_id=? ORDER BY requested_at DESC, id DESC LIMIT 50`, [customerId]).map((r) => ({
    id: Number(r.id), source: r.source, requestedAt: r.requested_at, contactTime: r.contact_time,
    contactTimeFa: SITE_LEAD_CONTACT_FA[r.contact_time] ?? r.contact_time, isRepeat: Number(r.is_repeat) === 1,
    answeredAt: r.answered_at, answeredByCallId: r.answered_by_call_id == null ? null : Number(r.answered_by_call_id),
    answerSource: r.answer_source, backfilled: Number(r.backfilled) === 1,
  }));
}

export type TopKind = "site_lead" | "from_kazemi";
export type TopEntry = { customerId: number; kind: TopKind; startedAt: string; dueAt: string; windowNow: boolean };

/**
 * The «اول لیست» rows, in order: (1) active site leads (repeat requests included) — those whose asked window is now
 * first, then the oldest unanswered request; (2) «از کاظمی» customers not called by anyone but Kazemi since the hand-off and
 * still inside the 3-working-hour deadline. Everything else keeps the existing order.
 */
export function topOfList(now = new Date(), cfg: TeamSalesConfig = getTeamSalesConfig()): TopEntry[] {
  const leads = activeSiteLeads(undefined, now, cfg);
  const site: TopEntry[] = [...leads].map(([customerId, s]) => ({ customerId, kind: "site_lead" as const, startedAt: s.requestedAt, dueAt: s.dueAt, windowNow: s.windowNow }));
  site.sort((a, b) => Number(b.windowNow) - Number(a.windowNow) || a.startedAt.localeCompare(b.startedAt) || a.dueAt.localeCompare(b.dueAt) || a.customerId - b.customerId);
  const k = Number(cfg.qualifierSalespersonId);
  const kz: TopEntry[] = [];
  if (Number.isInteger(k) && k > 0 && queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='customer_priority_history'")) {
    const since = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const cand = queryRows<{ customer_id: number }>(
      `SELECT DISTINCT h.customer_id FROM customer_priority_history h JOIN customers c ON c.id=h.customer_id
       WHERE h.old_salesperson_id=? AND h.new_salesperson_id IS NOT NULL AND h.new_salesperson_id<>? AND h.created_at>?
         AND c.merged_into_customer_id IS NULL AND c.salesperson_id IS NOT NULL AND c.salesperson_id<>?`, [k, k, since, k]).map((r) => Number(r.customer_id))
      .filter((id) => !leads.has(id));
    const sources = kazemiSources(cand);
    const called = `SELECT 1 x FROM call_logs WHERE customer_id=? AND created_at>? AND COALESCE(salesperson_id,-1)<>? AND ${realCallSql("subject")} LIMIT 1`;
    for (const id of cand) {
      const s = sources.get(id);
      if (!s || s.kind !== "from_kazemi" || !s.handoffAt) continue;
      const due = addWorkingHours(new Date(s.handoffAt), cfg.closerFirstCallWorkingHours, cfg);
      if (now.getTime() >= due.getTime()) continue;
      if (queryRow(called, [id, s.handoffAt, k])) continue;
      kz.push({ customerId: id, kind: "from_kazemi", startedAt: s.handoffAt, dueAt: due.toISOString(), windowNow: true });
    }
    kz.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.customerId - b.customerId);
  }
  return [...site, ...kz].slice(0, 400);
}

/** ORDER BY prefix for GET /customers: top rows by position, everyone else after (existing order). */
export function topOrderSql(top: TopEntry[], column = "c.id"): { sql: string; params: SqlValue[] } {
  if (!top.length) return { sql: "", params: [] };
  return { sql: `CASE ${column} ${top.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END ASC, `,
    params: [...top.flatMap((t, i) => [t.customerId, i]), top.length] };
}

/** «در حال پیگیری» also shows a cancelled / completed customer while a website request of theirs is unanswered. */
export const ACTIVE_SITE_LEAD_EXISTS_SQL = "EXISTS (SELECT 1 FROM site_lead_requests open_slr WHERE open_slr.customer_id=c.id AND open_slr.answered_at IS NULL)";

/* ---------------- preferred-time window alerts ---------------- */
export type WindowAlert = { customerId: number; customerName: string; ownerId: number; contactTime: "morning" | "evening"; requestIds: number[] };
export type WindowDeps = { telegram?: (alerts: WindowAlert[], ownerName: string | null) => Promise<string> };

/**
 * At the start of the asked window («صبح» 9:00 / «عصر» 13:00 on working days) — or the first tick inside it — every
 * still-unanswered request with that preference, received before the window began and owned by the qualifier (Kazemi),
 * gets one in-CRM notification (bell + sticky toast with sound, kind site-lead-window) and, if the existing staff
 * Telegram channel is on, one grouped message. Each request alerts at most once.
 */
export async function siteLeadWindowTick(now = new Date(), deps: WindowDeps = {}, cfg: TeamSalesConfig = getTeamSalesConfig()): Promise<WindowAlert[]> {
  if (!siteLeadsReady() || !inWorkingHours(now, cfg)) return [];
  const h = wallHour(now);
  const window = h >= CALLBACK_CONFIG.morning.start && h < CALLBACK_CONFIG.morning.end ? "morning"
    : h >= CALLBACK_CONFIG.evening.start && h < CALLBACK_CONFIG.evening.end ? "evening" : null;
  if (!window) return [];
  const k = Number(cfg.qualifierSalespersonId);
  const start = atWallHour(now, contactWindow(window)!.start).toISOString();
  const rows = queryRows<{ id: number; customer_id: number; name: string; salesperson_id: number }>(
    `SELECT r.id, r.customer_id, c.name, c.salesperson_id FROM site_lead_requests r JOIN customers c ON c.id=r.customer_id AND c.merged_into_customer_id IS NULL
     WHERE r.answered_at IS NULL AND r.window_alerted_at IS NULL AND r.contact_time=? AND r.requested_at<? AND c.salesperson_id=?
     ORDER BY r.requested_at, r.id`, [window, start, k]);
  if (!rows.length) return [];
  const by = new Map<number, WindowAlert>();
  for (const r of rows) {
    const a = by.get(Number(r.customer_id)) ?? { customerId: Number(r.customer_id), customerName: r.name, ownerId: Number(r.salesperson_id), contactTime: window, requestIds: [] };
    a.requestIds.push(Number(r.id)); by.set(a.customerId, a);
  }
  const alerts = [...by.values()];
  const at = now.toISOString();
  const fa = SITE_LEAD_CONTACT_FA[window];
  const hours = window === "morning" ? "۹ تا ۱۳" : "۱۳ تا ۱۸";
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    for (const a of alerts) {
      execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [a.customerId, a.customerName || "مشتری", a.ownerId, "customer", a.customerId, SITE_LEAD_WINDOW_KIND,
        `مشتری خواسته ${fa} تماس بگیرید`, `زمان تماس درخواستی (${hours}) رسید و هنوز تماسی ثبت نشده است — سرنخ سایت.`, "customers.view", at]);
      execute(`UPDATE site_lead_requests SET window_alerted_at=? WHERE id IN (${a.requestIds.map(() => "?").join(",")})`, [at, ...a.requestIds]);
    }
    crmDb.exec("COMMIT");
  } catch (error) { crmDb.exec("ROLLBACK"); throw error; }
  if (deps.telegram) {
    let outcome = "failed";
    try { outcome = await deps.telegram(alerts, queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [k])?.name ?? null); } catch { outcome = "failed"; }
    const ids = alerts.flatMap((a) => a.requestIds);
    execute(`UPDATE site_lead_requests SET window_alert_telegram=? WHERE id IN (${ids.map(() => "?").join(",")})`, [outcome, ...ids]);
  }
  return alerts;
}

let workerStarted = false;
export function startSiteLeadWorker(log: { info: (m: string) => void; error: (m: string) => void }, telegram: NonNullable<WindowDeps["telegram"]>): void {
  if (workerStarted) return;
  workerStarted = true;
  try { const r = ensureSiteLeadSchema(); if (r.created) log.info(`site_lead_requests created, ${r.backfilled} requests back-filled`); }
  catch { log.error("site_lead_requests schema failed"); return; }
  // Staff alerts only from the production service; tests / dev / offline start-tests never notify anyone.
  if (process.env.NODE_ENV !== "production" || process.env.SITE_LEAD_ALERTS === "off") { log.info("Site-lead window alerts are disabled"); return; }
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    siteLeadWindowTick(new Date(), { telegram }).catch(() => log.error("Site-lead window alert tick failed")).finally(() => { busy = false; });
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60_000).unref();
  log.info("Site-lead window alerts started");
}
