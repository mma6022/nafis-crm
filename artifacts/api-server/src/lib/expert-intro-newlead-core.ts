/**
 * EINS (expert-intro SMS on a NEW lead, Mohammad t644u/t645u 2026-10-29): approved IPPanel pattern wuk6lgtho227bxc
 * (name, sale_name, sale_mobile) to a customer created from Instagram (registration instagram / instagram_auto, or any
 * create with lead_source instagram) or from the site request form /request (apply wizard + legacy lead, any src),
 * once the customer has an expert (any active salesperson except trainees 5/19/20; Kazemi counts).
 * - Own flag: call_queue_settings key flag.expert_intro_new_lead = '1' (absent / anything else = OFF, the shipped state).
 *   OFF → onNewLead writes nothing; queued rows are dropped with a «غیرفعال» log on the next tick. Does NOT read or
 *   write notification_settings.expert_intro_sms_enabled (the separate hand-off intro stays independent).
 * - One row per (customer, source) — PRIMARY KEY(customer_id, source) — so a repeat registration never re-sends.
 * - Only customers created while the flag is ON are enqueued (no backfill).
 * - Queue: waiting_expert until customers.salesperson_id is an eligible expert (not a trainee 5/19/20); then sent in
 *   08:00–21:00 Tehran. Waits at most 3 days, then «کارشناس تعیین نشد».
 * - Any empty variable (name, sale_name, sale_mobile) → status blocked + log; never sent (no «مشتری» fallback here).
 * - Skips: test/staff number, bad mobile, merged, already got an expert-intro SMS (either feature), IPPanel off.
 * DB handle, clock and sender are injected (no crm-db import) so the fixture runs it on a copy with a mocked provider.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EXPERT_INTRO_PARAM_CUSTOMER, EXPERT_INTRO_PARAM_NAME, EXPERT_INTRO_PARAM_PHONE, EXPERT_INTRO_TRAINEE_SALESPERSON_IDS,
  ensureExpertIntroSchema, expertInfo, failureText, getExpertIntroSettings, inSendWindow, isTestOrStaffPhone, logIntro, mobileKey,
  type Sender,
} from "./expert-intro-sms-core";

export const EINS_FLAG_KEY = "flag.expert_intro_new_lead";
export const EINS_DEFAULT_PATTERN = "wuk6lgtho227bxc";
export const EINS_SOURCES = ["instagram", "site_request"] as const;
export type EinsSource = (typeof EINS_SOURCES)[number];
export const EINS_MAX_WAIT_MS = 3 * 24 * 3600_000;
/** Lets an instant allocation / hand-off settle before the expert is read. */
export const EINS_SETTLE_MS = 120_000;
const P = "معرفی ثبت جدید: ";
export const EINS_REASONS = {
  disabled: P + "غیرفعال",
  waiting: P + "در انتظار تعیین کارشناس",
  noExpert: P + "کارشناس تعیین نشد (۳ روز)",
  emptyName: P + "نام مشتری خالی است",
  emptySaleName: P + "نام کارشناس خالی است",
  emptySaleMobile: P + "شماره‌ی کارشناس خالی است",
  badCustomerPhone: P + "شماره‌ی موبایل مشتری معتبر نیست",
  testNumber: P + "شماره‌ی آزمایشی یا داخلی",
  merged: P + "پرونده ادغام شده",
  noCustomer: P + "مشتری پیدا نشد",
  alreadyIntroduced: P + "قبلاً پیامک معرفی کارشناس گرفته",
  ippanelOff: P + "پیامک IPPanel خاموش است",
  queued: P + "در صف",
} as const;

type Db = DatabaseSync;
const row = <T>(db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
const rows = <T>(db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as T[];
const run = (db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));
const hasTable = (db: Db, n: string) => !!row(db, "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", n);

const ready = new WeakSet<object>();
export function ensureEinsSchema(db: Db): void {
  if (ready.has(db)) return;
  ensureExpertIntroSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS expert_intro_newlead (
      customer_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('instagram','site_request')),
      status TEXT NOT NULL CHECK(status IN ('waiting_expert','sending','sent','failed','uncertain','blocked','skipped')),
      salesperson_id INTEGER,
      reason TEXT,
      claim_token TEXT,
      attempted_at TEXT,
      provider_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (customer_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_expert_intro_newlead_status ON expert_intro_newlead(status, created_at);
  `);
  ready.add(db);
}

export function einsEnabled(db: Db): boolean {
  try { return row<{ value: string }>(db, "SELECT value FROM call_queue_settings WHERE key=?", EINS_FLAG_KEY)?.value === "1"; }
  catch { return false; }
}

/** Which EINS source a freshly created customer belongs to (null = not a trigger). */
export function einsSourceFor(registrationSource: string, leadSource: string | null | undefined, siteRequest: boolean): EinsSource | null {
  if (siteRequest && registrationSource === "site_lead") return "site_request";
  if (registrationSource === "instagram" || registrationSource === "instagram_auto" || leadSource === "instagram") return "instagram";
  return null;
}

/** Called right after the customer INSERT (inside the caller's transaction). Flag OFF → one SELECT, nothing written. */
export function onNewLead(db: Db, customerId: number, source: EinsSource | null, now = new Date()): "none" | "queued" | "duplicate" {
  if (!source || !einsEnabled(db)) return "none";
  ensureEinsSchema(db);
  const iso = now.toISOString();
  const ch = run(db, `INSERT OR IGNORE INTO expert_intro_newlead (customer_id, source, status, created_at, updated_at) VALUES (?,?,'waiting_expert',?,?)`,
    customerId, source, iso, iso).changes;
  if (!ch) return "duplicate";
  logIntro(db, { customerId, salespersonId: null, expertName: null, status: "queued", reason: EINS_REASONS.waiting + ` (${source})` }, now);
  return "queued";
}

type Cust = { id: number; name: string | null; phone: string | null; salesperson_id: number | null; merged_into_customer_id: number | null };
export type EinsTick = { sent: number; failed: number; uncertain: number; blocked: number; skipped: number; waiting: number };

export async function einsTick(db: Db, deps: { send: Sender; now?: () => Date; ippanelEnabled: () => boolean; batch?: number }): Promise<EinsTick> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const out: EinsTick = { sent: 0, failed: 0, uncertain: 0, blocked: 0, skipped: 0, waiting: 0 };
  if (!hasTable(db, "expert_intro_newlead")) return out;
  ensureEinsSchema(db);
  const iso = now.toISOString();
  const stale = new Date(now.getTime() - 120_000).toISOString();
  for (const r of rows<{ customer_id: number; source: string; salesperson_id: number | null }>(db,
    "SELECT customer_id, source, salesperson_id FROM expert_intro_newlead WHERE status='sending' AND attempted_at<?", stale)) {
    run(db, "UPDATE expert_intro_newlead SET status='uncertain', error_code='stale_claim', updated_at=? WHERE customer_id=? AND source=? AND status='sending'", iso, r.customer_id, r.source);
    logIntro(db, { customerId: r.customer_id, salespersonId: r.salesperson_id, expertName: null, status: "uncertain", reason: P + "نتیجه‌ی ارسال نامشخص" }, now);
    out.uncertain++;
  }
  const waiting = rows<{ customer_id: number; source: string; created_at: string }>(db,
    "SELECT customer_id, source, created_at FROM expert_intro_newlead WHERE status='waiting_expert' ORDER BY created_at LIMIT 200");
  const finish = (r: { customer_id: number; source: string }, status: "blocked" | "skipped", reason: string, spId: number | null, name: string | null) => {
    run(db, "UPDATE expert_intro_newlead SET status=?, reason=?, salesperson_id=?, updated_at=? WHERE customer_id=? AND source=? AND status='waiting_expert'",
      status, reason, spId, iso, r.customer_id, r.source);
    logIntro(db, { customerId: r.customer_id, salespersonId: spId, expertName: name, status: "skipped", reason }, now);
    if (status === "blocked") out.blocked++; else out.skipped++;
  };
  if (!einsEnabled(db)) { for (const r of waiting) finish(r, "skipped", EINS_REASONS.disabled, null, null); return out; }
  const s = getExpertIntroSettings(db);
  const pattern = s.patternCode || EINS_DEFAULT_PATTERN;
  let budget = deps.batch ?? 5;
  for (const r of waiting) {
    const c = row<Cust>(db, "SELECT id, name, phone, salesperson_id, merged_into_customer_id FROM customers WHERE id=?", r.customer_id);
    if (!c) { finish(r, "skipped", EINS_REASONS.noCustomer, null, null); continue; }
    if (c.merged_into_customer_id != null) { finish(r, "skipped", EINS_REASONS.merged, null, null); continue; }
    const sp = c.salesperson_id == null ? null : Number(c.salesperson_id);
    const age = now.getTime() - Date.parse(r.created_at);
    const isExpert = sp != null && !(EXPERT_INTRO_TRAINEE_SALESPERSON_IDS as readonly number[]).includes(sp) &&
      !!row(db, "SELECT 1 AS x FROM salespersons WHERE id=? AND active=1", sp);
    if (!isExpert) {
      if (age > EINS_MAX_WAIT_MS) finish(r, "skipped", EINS_REASONS.noExpert, sp, null); else out.waiting++;
      continue;
    }
    if (age < EINS_SETTLE_MS || !inSendWindow(now)) { out.waiting++; continue; }
    if (age > EINS_MAX_WAIT_MS) { finish(r, "skipped", EINS_REASONS.noExpert, sp, null); continue; }
    const expert = expertInfo(db, sp!) ?? { salespersonId: sp!, name: "", userId: null, phone: null };
    const name = (c.name ?? "").trim().slice(0, 40);
    const saleName = expert.name.trim().slice(0, 40);
    const saleMobile = (expert.phone ?? "").trim();
    if (!c.phone || !mobileKey(c.phone)) { finish(r, "skipped", EINS_REASONS.badCustomerPhone, sp, saleName || null); continue; }
    if (isTestOrStaffPhone(db, c.phone, s)) { finish(r, "skipped", EINS_REASONS.testNumber, sp, saleName || null); continue; }
    if (row(db, "SELECT 1 AS x FROM expert_intro_sms WHERE customer_id=? AND status IN ('sent','sending','uncertain')", c.id) ||
      row(db, "SELECT 1 AS x FROM expert_intro_newlead WHERE customer_id=? AND source<>? AND status IN ('sent','sending','uncertain')", c.id, r.source)) {
      finish(r, "skipped", EINS_REASONS.alreadyIntroduced, sp, saleName || null); continue;
    }
    if (!name) { finish(r, "blocked", EINS_REASONS.emptyName, sp, saleName || null); continue; }
    if (!saleName) { finish(r, "blocked", EINS_REASONS.emptySaleName, sp, null); continue; }
    if (!saleMobile) { finish(r, "blocked", EINS_REASONS.emptySaleMobile, sp, saleName); continue; }
    if (!deps.ippanelEnabled()) { finish(r, "skipped", EINS_REASONS.ippanelOff, sp, saleName); continue; }
    if (budget-- <= 0) { out.waiting++; continue; }
    const token = randomUUID();
    if (!run(db, "UPDATE expert_intro_newlead SET status='sending', salesperson_id=?, claim_token=?, attempted_at=?, updated_at=? WHERE customer_id=? AND source=? AND status='waiting_expert'",
      sp, token, iso, iso, r.customer_id, r.source).changes) continue;
    try {
      const id = await deps.send({ recipient: mobileKey(c.phone)!, patternCode: pattern,
        params: { [EXPERT_INTRO_PARAM_CUSTOMER]: name, [EXPERT_INTRO_PARAM_NAME]: saleName, [EXPERT_INTRO_PARAM_PHONE]: saleMobile } });
      const t = nowFn();
      run(db, "UPDATE expert_intro_newlead SET status='sent', provider_id=?, error_code=NULL, updated_at=? WHERE customer_id=? AND source=? AND claim_token=?", id, t.toISOString(), r.customer_id, r.source, token);
      logIntro(db, { customerId: r.customer_id, salespersonId: sp, expertName: saleName, status: "sent", reason: P + r.source }, t);
      out.sent++;
    } catch (error) {
      const code = error instanceof Error ? error.message : "sms_failed";
      const unknown = code === "sms_delivery_unknown";
      const t = nowFn();
      run(db, "UPDATE expert_intro_newlead SET status=?, error_code=?, updated_at=? WHERE customer_id=? AND source=? AND claim_token=?",
        unknown ? "uncertain" : "failed", code.slice(0, 80), t.toISOString(), r.customer_id, r.source, token);
      logIntro(db, { customerId: r.customer_id, salespersonId: sp, expertName: saleName, status: unknown ? "uncertain" : "failed", reason: P + failureText(code) }, t);
      if (unknown) out.uncertain++; else out.failed++;
    }
  }
  return out;
}

export function einsStats(db: Db): Record<string, number> {
  if (!hasTable(db, "expert_intro_newlead")) return {};
  return Object.fromEntries(rows<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM expert_intro_newlead GROUP BY status").map((r) => [r.status, Number(r.n)]));
}
