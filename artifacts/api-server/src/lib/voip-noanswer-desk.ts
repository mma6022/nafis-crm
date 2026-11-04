/**
 * VNA-DESK (Mohammad, PM card t841s3414: «آره، پیامک بی‌پاسخ برای تماس مستقیم از تلفن ویپ هم با همون قوانین بره»):
 * the no-answer SMS (IPPanel pattern 0od60ofo2fkaozx, lib/voip-noanswer-sms.ts) also for a call the expert dials DIRECTLY from the
 * VoIP desk phone (an "outgoing" CDR ingested by ingestAfterCalls), with exactly the click-call rules:
 * - Own switch call_queue_settings flag.voip_noanswer_sms.deskphone = '1' AND the main flag.voip_noanswer_sms = '1' (absent / other = OFF,
 *   the shipped state; OFF → one settings read, nothing written). Never for calls that ended before the later of the two switch-on times.
 * - Final CDR only (provider row with an end time ≤ now, event is_live=0), outgoing, not part of a click-to-call originate.
 * - Not answered = the customer's leg in the CDR details carries one definite failure status with billsec 0 and no recording (the click
 *   rule, vcCustomerLeg); a CDR without a customer details entry → the row itself must be NO ANSWER/BUSY/… with billsec 0 and no recording.
 * - Only an expert who has the click-to-call feature (flag.voip_call[.user.<id>] + own extension, i.e. 2/3/7/8 today) and a customer the
 *   pipeline matched (one unique phone match, not merged). Never a call that belongs to a click call (event linked, or a click call of the same
 *   expert to the same customer/number from 15 min before the start to 1 min after the end) → no double SMS.
 * - Same checks as the click path: 08:00–21:00 Tehran, 30-min stale guard, test/staff/excluded numbers, agent name + agent mobile,
 *   IPPanel on, once per customer per Tehran day (shared with click calls), 3 consecutive failures → auto-off of the main flag.
 * - voip_noanswer_sms.call_id = −event id for desk rows (click rows are the positive voip_click_calls id); the table is unchanged.
 * Logs carry ids and statuses only, never numbers or message text.
 */
import { queryRow, queryRows, crmDb } from "./crm-db";
import { callStartedAt, type SimotelCall } from "./simotel";
import { normalizePhone } from "./voip-after-call";
import { vcCustomerLeg, vcFlagOn, vcExtension } from "./voip-call";
import { customerParam, getExpertIntroSettings, inSendWindow, isTestOrStaffPhone, mobileKey, normalizeContactPhone } from "./expert-intro-sms-core";
import { ensureVnaSchema, hasTable, tehranDayOf, tehranHHMM, vnaDeliver, vnaEnqueue, vnaOnSince, VNA_PARAMS, VNA_PATTERN, type Prepared, type VnaDeps } from "./voip-noanswer-sms";

export const VNA_DESK_FLAG = "flag.voip_noanswer_sms.deskphone";
const MAX_LAG_MS = 30 * 60_000;
const NOT_ANSWERED = new Set(["NO ANSWER", "BUSY", "FAILED", "CONGESTION", "CHANUNAVAIL", "CANCEL"]);

/** ON since (ISO) = the later switch-on time of the desk flag and the main flag; null when either is OFF. */
export function vnaDeskOnSince(): string | null {
  const main = vnaOnSince(); if (!main) return null;
  try {
    const r = queryRow<{ value: string; updated_at: string | null }>("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [VNA_DESK_FLAG]);
    if (r?.value !== "1" || !r.updated_at) return null;
    return Date.parse(r.updated_at) > Date.parse(main) ? r.updated_at : main;
  } catch { return null; }
}

export type VnaDeskCdr = { externalId: string; custStatus: string; startedAt: string; endedAt: string; phone: string };
/** Pure: the final outgoing desk-phone CDR rows whose customer leg was definitely not answered. */
export function vnaDeskCandidates(rows: SimotelCall[], now = new Date()): VnaDeskCdr[] {
  const out: VnaDeskCdr[] = [];
  for (const r of rows) {
    if (r.type !== "outgoing") continue;
    if (typeof r.originated_call_id === "string" && r.originated_call_id.trim()) continue;
    const ended = Number(r.endtime?.$date?.$numberLong);
    if (!Number.isFinite(ended) || ended <= 0 || ended > now.getTime()) continue;
    const phone = normalizePhone(String(r.dst ?? ""));
    if (!phone) continue;
    if (r.record) continue;
    const leg = vcCustomerLeg([r], phone);
    let st: string | null = null;
    if (leg.notAnswered) st = leg.custStatus;
    else if (leg.custStatus === "NOT_DIALED") {
      const d = String(r.disposition ?? "").trim().toUpperCase();
      if (NOT_ANSWERED.has(d) && Number(r.billsec) === 0 && (r.details ?? []).every((x) => !Number(x.billsec))) st = d;
    }
    if (!st) continue;
    let startedAt: string;
    try { startedAt = callStartedAt(r); } catch { continue; }
    out.push({ externalId: String(r._id), custStatus: st, startedAt, endedAt: new Date(ended).toISOString(), phone });
  }
  return out;
}

type Ev = { id: number; phone: string; direction: string; is_live: number; expert_user_id: number | null; customer_id: number | null; started_at: string; ended_at: string; extension: string | null; mobile_device_id: number | null };
/** Decision for one candidate (no writes). null = not a desk-phone no-answer call for this feature (nothing recorded). */
export function vnaDeskPrepare(d: VnaDeskCdr, since: string, now: Date, ippanelOn: boolean): Prepared | null {
  if (Date.parse(d.endedAt) < Date.parse(since) || Date.parse(d.startedAt) < Date.parse(since)) return null; // before the switch: never
  const evs = queryRows<Ev>(`SELECT id, phone, direction, is_live, expert_user_id, customer_id, started_at, ended_at, extension, mobile_device_id
    FROM voip_after_call_events WHERE external_id=? OR recording_provider_id=?`, [d.externalId, d.externalId]);
  if (evs.length !== 1) return null; // not ingested yet, or a shared transfer recording → never guess
  const e = evs[0];
  if (e.direction !== "outgoing" || e.is_live || e.mobile_device_id != null || e.expert_user_id == null || e.customer_id == null) return null;
  if (normalizePhone(e.phone) !== d.phone) return null;
  if (!vcFlagOn(e.expert_user_id) || vcExtension(e.expert_user_id) == null || vcExtension(e.expert_user_id) !== e.extension) return null;
  const click = queryRow(`SELECT 1 x FROM voip_click_calls WHERE event_id=? OR (user_id=? AND (customer_id=? OR phone=?)
      AND julianday(created_at)>=julianday(?)-15.0/1440 AND julianday(created_at)<=julianday(?)+1.0/1440) LIMIT 1`,
    [e.id, e.expert_user_id, e.customer_id, d.phone, d.startedAt, d.endedAt]);
  if (click) return null; // the click path owns it
  const row = { call_id: -e.id, customer_id: e.customer_id, user_id: e.expert_user_id, tehran_day: tehranDayOf(now), cust_status: d.custStatus, started: d.startedAt, ended: d.endedAt };
  const skip = (reason: string): Prepared => ({ row, reason });
  if (now.getTime() - Date.parse(d.endedAt) > MAX_LAG_MS) return skip("stale");
  if (!inSendWindow(now)) return skip("outside_hours");
  const cust = queryRow<{ name: string | null; merged_into_customer_id: number | null }>("SELECT name, merged_into_customer_id FROM customers WHERE id=?", [e.customer_id]);
  if (!cust) return skip("no_customer");
  if (cust.merged_into_customer_id != null) return skip("merged");
  const recipient = mobileKey(d.phone);
  if (!recipient) return skip("bad_mobile");
  if (isTestOrStaffPhone(crmDb, recipient, getExpertIntroSettings(crmDb))) return skip("test_or_staff");
  const u = queryRow<{ full_name: string | null; customer_contact_phone: string | null; sp: string | null }>(
    "SELECT u.full_name, u.customer_contact_phone, s.name sp FROM users u LEFT JOIN salespersons s ON s.id=u.salesperson_id WHERE u.id=?", [e.expert_user_id]);
  const agent = String(u?.sp ?? "").trim() || String(u?.full_name ?? "").trim();
  if (!agent) return skip("no_agent_name");
  const agentMobile = normalizeContactPhone(u?.customer_contact_phone ?? null);
  if (!agentMobile) return skip("no_agent_mobile");
  if (!ippanelOn) return skip("ippanel_off");
  if (hasTable() && queryRow("SELECT 1 x FROM voip_noanswer_sms WHERE customer_id=? AND tehran_day=? AND status<>'skipped'", [e.customer_id, row.tehran_day])) return skip("already_today");
  return { row, reason: null, send: { recipient, patternCode: VNA_PATTERN,
    params: { [VNA_PARAMS.name]: customerParam(cust.name), [VNA_PARAMS.agent]: agent.slice(0, 40), [VNA_PARAMS.time]: tehranHHMM(new Date(d.startedAt)), [VNA_PARAMS.mobile]: agentMobile } } };
}

/** Poller hook (after ingestAfterCalls + the click path). OFF → one settings read. Serialized with the click path; never throws. */
export function vnaDeskAfterIngest(rows: SimotelCall[], deps: VnaDeps, now = new Date()): Promise<void> {
  try { if (!vnaDeskOnSince()) return Promise.resolve(); } catch { return Promise.resolve(); }
  const cands = vnaDeskCandidates(rows, now);
  if (!cands.length) return Promise.resolve();
  return vnaEnqueue(async () => {
    const since = vnaDeskOnSince(); if (!since) return;
    ensureVnaSchema();
    for (const d of cands) {
      if (!vnaDeskOnSince()) return; // auto-off mid-batch
      if (hasTable() && queryRow("SELECT 1 x FROM voip_noanswer_sms WHERE call_id IN (SELECT -id FROM voip_after_call_events WHERE external_id=? OR recording_provider_id=?)", [d.externalId, d.externalId])) continue;
      const p = vnaDeskPrepare(d, since, now, deps.ippanelEnabled());
      if (p) await vnaDeliver(p, deps, now);
    }
  });
}
