/**
 * VNA (Mohammad t757u «اگه مشتری هر وضعیتی غیر پاسخ داده شد این پیام به صورت پترن تنظیم شده تو آی پی پنل براش ارسال بشه»):
 * after a «تماس از تلفن ویپ» (click-to-call) whose originate CDR says the customer's own leg was dialed and NOT answered
 * (R2 vcIngestOriginate decision notAnswered: one definite failure status, billsec 0, no recording), the customer gets IPPanel
 * pattern 0od60ofo2fkaozx: «سلام %name% عزیز، کارشناس ما (%agent_name% ) امروز ساعت %time% با شما تماس گرفت اما پاسخگو نبودید. …
 * به شماره %agent_mobile% پیامک دهید. نفیس وام».
 * - Own switch call_queue_settings flag.voip_noanswer_sms = '1' (absent / other = OFF, the shipped state). OFF → nothing is written.
 * - Never for past calls: only calls whose CDR end is at/after the flag's updated_at (the moment it was switched on).
 * - UNKNOWN / NOT_DIALED / ANSWERED → never (they are not notAnswered decisions).
 * - Once per customer per Tehran day (partial UNIQUE index), once per call (UNIQUE call_id). No retry of a failure.
 * - Only 08:00–21:00 Tehran at send time; outside → skipped 'outside_hours' (never queued to the morning). CDR older than 30 min → 'stale'.
 * - Expert: agent_name = salespersons.name (else users.full_name), agent_mobile = users.customer_contact_phone; empty → skipped + logged.
 * - Sent through the same path as the expert-intro SMS (HMAC relay / SMS_PROXY_URL → IPPanel Edge).
 * - 3 consecutive failed/uncertain sends → the flag is switched back to '0' (auto-off) and logged.
 * Logs carry ids and statuses only, never numbers or message text.
 */
import { crmDb, executeChanges, queryRow, queryRows } from "./crm-db";
import { logger } from "./logger";
import { customerParam, getExpertIntroSettings, inSendWindow, isTestOrStaffPhone, mobileKey, normalizeContactPhone, type SendArgs } from "./expert-intro-sms-core";

export const VNA_FLAG = "flag.voip_noanswer_sms";
export const VNA_PATTERN = "0od60ofo2fkaozx";
export const VNA_PARAMS = { name: "name", agent: "agent_name", time: "time", mobile: "agent_mobile" } as const;
const MAX_LAG_MS = 30 * 60_000, FAIL_LIMIT = 3, TEHRAN_MS = 210 * 60_000;
export type VnaDecision = { callId: number; custStatus: string; notAnswered: boolean; startedAt: string | null; endedAt: string | null };
export type VnaDeps = { send: (a: SendArgs) => Promise<string>; ippanelEnabled: () => boolean };

let ready = false;
export function ensureVnaSchema(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_noanswer_sms(
      id INTEGER PRIMARY KEY, call_id INTEGER NOT NULL UNIQUE, customer_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tehran_day TEXT NOT NULL,
      cust_status TEXT, status TEXT NOT NULL CHECK(status IN ('claimed','sent','failed','uncertain','skipped')), skipped_reason TEXT,
      provider_result TEXT, provider_id TEXT, call_started_at TEXT, call_ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_vna_cust_day ON voip_noanswer_sms(customer_id, tehran_day) WHERE status<>'skipped';`);
  ready = true;
}
export const hasTable = () => ready || !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_noanswer_sms'");
/** ON since (ISO, the flag row's updated_at) or null when OFF. */
export function vnaOnSince(): string | null {
  try { const r = queryRow<{ value: string; updated_at: string | null }>("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [VNA_FLAG]); return r?.value === "1" ? r.updated_at || null : null; }
  catch { return null; }
}
export const tehranDayOf = (d: Date) => new Date(d.getTime() + TEHRAN_MS).toISOString().slice(0, 10);
export const tehranHHMM = (d: Date) => new Date(d.getTime() + TEHRAN_MS).toISOString().slice(11, 16);
/** The chip «پیامک عدم پاسخ رفت». */
export function vnaSent(callId: number): boolean {
  try { return hasTable() && !!queryRow("SELECT 1 x FROM voip_noanswer_sms WHERE call_id=? AND status='sent'", [callId]); } catch { return false; }
}

type Click = { id: number; user_id: number; customer_id: number; phone: string; created_at: string };
export type Prepared = { row: { call_id: number; customer_id: number; user_id: number; tehran_day: string; cust_status: string; started: string; ended: string };
  reason: string | null; send?: SendArgs };
/** Pure decision for one notAnswered click call (no writes). */
export function vnaPrepare(d: VnaDecision, since: string, now: Date, ippanelOn: boolean): Prepared | null {
  const c = queryRow<Click>("SELECT id, user_id, customer_id, phone, created_at FROM voip_click_calls WHERE id=?", [d.callId]);
  if (!c) return null;
  const ended = d.endedAt ?? now.toISOString(), started = d.startedAt ?? c.created_at;
  const row = { call_id: c.id, customer_id: c.customer_id, user_id: c.user_id, tehran_day: tehranDayOf(now), cust_status: d.custStatus, started, ended };
  const skip = (reason: string): Prepared => ({ row, reason });
  if (Date.parse(ended) < Date.parse(since) || Date.parse(c.created_at) < Date.parse(since)) return skip("before_flag");
  if (now.getTime() - Date.parse(ended) > MAX_LAG_MS) return skip("stale");
  if (!inSendWindow(now)) return skip("outside_hours");
  const cust = queryRow<{ name: string | null; merged_into_customer_id: number | null }>("SELECT name, merged_into_customer_id FROM customers WHERE id=?", [c.customer_id]);
  if (!cust) return skip("no_customer");
  if (cust.merged_into_customer_id != null) return skip("merged");
  const recipient = mobileKey(c.phone);
  if (!recipient) return skip("bad_mobile");
  if (isTestOrStaffPhone(crmDb, recipient, getExpertIntroSettings(crmDb))) return skip("test_or_staff");
  const u = queryRow<{ full_name: string | null; customer_contact_phone: string | null; sp: string | null }>(
    "SELECT u.full_name, u.customer_contact_phone, s.name sp FROM users u LEFT JOIN salespersons s ON s.id=u.salesperson_id WHERE u.id=?", [c.user_id]);
  const agent = String(u?.sp ?? "").trim() || String(u?.full_name ?? "").trim();
  if (!agent) return skip("no_agent_name");
  const agentMobile = normalizeContactPhone(u?.customer_contact_phone ?? null);
  if (!agentMobile) return skip("no_agent_mobile");
  if (!ippanelOn) return skip("ippanel_off");
  if (hasTable() && queryRow("SELECT 1 x FROM voip_noanswer_sms WHERE customer_id=? AND tehran_day=? AND status<>'skipped'", [c.customer_id, row.tehran_day])) return skip("already_today");
  return { row, reason: null, send: { recipient, patternCode: VNA_PATTERN,
    params: { [VNA_PARAMS.name]: customerParam(cust.name), [VNA_PARAMS.agent]: agent.slice(0, 40), [VNA_PARAMS.time]: tehranHHMM(new Date(started)), [VNA_PARAMS.mobile]: agentMobile } } };
}

function insert(p: Prepared, status: "claimed" | "skipped", reason: string | null, now: Date): boolean {
  const r = p.row, t = now.toISOString();
  try {
    return executeChanges(`INSERT OR IGNORE INTO voip_noanswer_sms(call_id,customer_id,user_id,tehran_day,cust_status,status,skipped_reason,call_started_at,call_ended_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [r.call_id, r.customer_id, r.user_id, r.tehran_day, r.cust_status, status, reason, r.started, r.ended, t, t]) > 0;
  } catch { return false; }
}

let chain: Promise<unknown> = Promise.resolve();
/** Shared serial queue for the click path and the desk-phone path (VNA-DESK) so the per-customer-per-day claim never races. */
export function vnaEnqueue(job: () => Promise<void>): Promise<void> {
  const next = chain.then(job).catch((e) => logger.error({ err: e instanceof Error ? e.message.slice(0, 120) : "error" }, "voip_noanswer_sms_failed"));
  chain = next;
  return next as Promise<void>;
}
/** Poller hook (after vcIngestOriginate). Serialized; never throws. */
export function vnaAfterDecisions(decisions: VnaDecision[], deps: VnaDeps, now = new Date()): Promise<void> {
  return vnaEnqueue(() => run(decisions, deps, now));
}
async function run(decisions: VnaDecision[], deps: VnaDeps, now: Date): Promise<void> {
  const todo = decisions.filter((d) => d.notAnswered);
  if (!todo.length) return;
  const since = vnaOnSince();
  if (!since) return; // OFF: nothing written
  ensureVnaSchema();
  for (const d of todo) {
    if (!vnaOnSince()) return; // auto-off mid-batch
    const p = vnaPrepare(d, since, now, deps.ippanelEnabled());
    if (!p) continue;
    await vnaDeliver(p, deps, now);
  }
}
/** Claim (or record the skip) and send one prepared row. Same steps for click calls and desk-phone calls (VNA-DESK). */
export async function vnaDeliver(p: Prepared, deps: VnaDeps, now: Date): Promise<void> {
  const callId = p.row.call_id;
  if (p.reason || !p.send) {
    if (insert(p, "skipped", p.reason, now)) logger.info({ callId, customerId: p.row.customer_id, reason: p.reason }, "voip_noanswer_sms_skipped");
    return;
  }
  if (!insert(p, "claimed", null, now)) {
    // lost the per-day race (or the call already has a row)
    if (insert(p, "skipped", "already_today", now)) logger.info({ callId, customerId: p.row.customer_id, reason: "already_today" }, "voip_noanswer_sms_skipped");
    return;
  }
  let status: "sent" | "failed" | "uncertain", result: string, providerId: string | null = null;
  try { providerId = await deps.send(p.send); status = "sent"; result = "ok"; }
  catch (e) { const code = e instanceof Error ? e.message : "sms_failed"; status = code === "sms_delivery_unknown" ? "uncertain" : "failed"; result = code.slice(0, 80); }
  executeChanges("UPDATE voip_noanswer_sms SET status=?, provider_result=?, provider_id=?, updated_at=? WHERE call_id=? AND status='claimed'",
    [status, result, providerId, new Date().toISOString(), callId]);
  logger.info({ callId, customerId: p.row.customer_id, status, result }, "voip_noanswer_sms_attempt");
  if (status !== "sent") autoOff();
}
/** 3 consecutive real attempts failed/uncertain → flag '0'. */
function autoOff() {
  const last = queryRows<{ status: string }>("SELECT status FROM voip_noanswer_sms WHERE status IN ('sent','failed','uncertain') ORDER BY id DESC LIMIT ?", [FAIL_LIMIT]);
  if (last.length < FAIL_LIMIT || last.some((r) => r.status === "sent")) return;
  const n = executeChanges("UPDATE call_queue_settings SET value='0', updated_at=? WHERE key=? AND value='1'", [new Date().toISOString(), VNA_FLAG]);
  if (n) logger.warn({ flag: VNA_FLAG, failures: FAIL_LIMIT }, "voip_noanswer_sms_auto_off");
}
