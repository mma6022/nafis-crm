/**
 * crm-site-leads storage: table, back-fill, recording and answering requests. Kept free of team-sales imports so the
 * intake paths (public leads, callbacks) stay light; ordering / deadlines / alerts live in ./site-leads.
 */
import type { DatabaseSync } from "node:sqlite";
import { crmDb, execute, queryRow } from "./crm-db";
import { ensureSchemaObject } from "./schema-objects";

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
  const firstCall = !tableExists(db, "call_logs") ? null : db.prepare(`SELECT id, created_at FROM call_logs WHERE customer_id=? AND created_at>? AND ${realCallSql("subject")}
    ORDER BY created_at, id LIMIT 1`);
  const owner = db.prepare("SELECT salesperson_id s, created_at c FROM customers WHERE id=?");
  const push = (source: SiteLeadSource, sourceId: number, rawCustomer: number | null, at: string, ct: string, repeat: (created: string | null) => boolean) => {
    const customerId = canonicalId(db, rawCustomer);
    if (customerId == null) return;
    const o = owner.get(customerId) as { s: number | null; c: string | null } | undefined;
    const call = firstCall?.get(customerId, at) as { id: number; created_at: string } | undefined;
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
