/**
 * VOIP-CALL (Simotel parts 1–2, Armita simotel v1.0.2 scenes 01–17; Mohammad t729s2849 «بسازه»).
 * «تماس از تلفن ویپ»: the expert's own Simotel extension rings first (30 s), after it is answered Simotel dials the customer.
 *  - Only for a user with flag.voip_call.user.<id>='1' (or the global flag.voip_call='1') AND an extension in voip_extensions. OFF by default;
 *    flag off → every /voip-call endpoint is 404 and nothing here runs (no table is created, the event hook returns at once).
 *  - One call at a time per expert: a partial UNIQUE index on voip_click_calls(user_id) WHERE active=1. The lock is released when the call
 *    ends (NewState idle), when the expert does not answer within 30 s (me_timeout), on an originate error, or by a stale-call safety sweep.
 *  - NewState dedup per cuid: voip_click_signals PK(cuid, extension, state, dialer, party) — a repeated webhook changes nothing.
 *  - The customer number is always read from the DB on the server; the browser never sends a destination and never receives the number here.
 *  - Result: answered → prefill «جواب داد»; no_answer / busy → «جواب نداد», one-tap save (note optional) through /files-carousel/followup
 *    with voipCallId. The CDR (via the existing after-call event) is the final word on status, recording and duration.
 */
import type { AuthUser } from "./auth";
import { crmDb, executeChanges, queryRow, queryRows } from "./crm-db";
import { normalizePhone } from "./voip-after-call";
import { simotelOriginate, SimotelError } from "./simotel";

export const VC_ME_TIMEOUT_S = 30;
const REQUEST_STALE_S = 45, DIAL_STALE_S = 180, TALK_STALE_S = 4 * 3600, NOTICE_KEEP_S = 15 * 60;
type U = Pick<AuthUser, "id" | "role"> & { salespersonId?: number | null; customerScope?: string | null; name?: string | null };
export type VcState = "requesting" | "ring_me" | "dial_cust" | "in_call" | "ended" | "me_timeout" | "error";
export type VcOutcome = "answered" | "no_answer" | "busy" | null;
export type VcRow = {
  id: number; user_id: number; extension: string; customer_id: number; file_id: number | null; phone: string; state: VcState; outcome: VcOutcome;
  originate_id: string | null; cuid: string | null; leg_cuid: string | null; event_id: number | null; error_code: string | null; active: number;
  created_at: string; ring_deadline: string | null; me_answered_at: string | null; cust_answered_at: string | null; ended_at: string | null;
  updated_at: string; cdr_at: string | null; result_saved_at: string | null; result_outcome: string | null; dismissed_at: string | null;
};

const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
export function vcFlagOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting("flag.voip_call") === "1" || setting(`flag.voip_call.user.${Number(userId)}`) === "1";
}
/** True when any user may have the feature (used by the webhook hook so flag off costs one indexed read). */
export function vcAnyOn(): boolean {
  try { return setting("flag.voip_call") === "1" || !!queryRow("SELECT 1 x FROM call_queue_settings WHERE key LIKE 'flag.voip_call.user.%' AND value='1' LIMIT 1"); } catch { return false; }
}
export function vcExtension(userId: number): string | null {
  const e = queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [userId])?.extension ?? null;
  return e && /^[0-9]{2,6}$/.test(e) ? e : null;
}
/** Feature on for this user = own flag AND own extension. */
export function vcOn(u: { id: number } | null | undefined): boolean { return !!u && vcFlagOn(u.id) && vcExtension(u.id) != null; }

let ensured = false;
export function vcTableExists(): boolean {
  if (ensured) return true;
  return !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_click_calls'");
}
export function ensureVcSchema() {
  if (ensured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_click_calls(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, extension TEXT NOT NULL, customer_id INTEGER NOT NULL, file_id INTEGER, phone TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT, originate_id TEXT, cuid TEXT, leg_cuid TEXT, event_id INTEGER, error_code TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, ring_deadline TEXT, me_answered_at TEXT, cust_answered_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL, cdr_at TEXT,
      result_saved_at TEXT, result_outcome TEXT, dismissed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_voip_click_active ON voip_click_calls(user_id) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_voip_click_ext ON voip_click_calls(extension, active, id);
    CREATE INDEX IF NOT EXISTS idx_voip_click_cust ON voip_click_calls(customer_id, id);
    CREATE TABLE IF NOT EXISTS voip_click_signals(cuid TEXT NOT NULL, extension TEXT NOT NULL, state TEXT NOT NULL, dialer TEXT NOT NULL, party TEXT NOT NULL,
      call_id INTEGER, received_at TEXT NOT NULL, PRIMARY KEY(cuid, extension, state, dialer, party));`);
  ensured = true;
}

const iso = (d: Date) => d.toISOString();
const ms = (s: string | null) => (s ? Date.parse(s) : NaN);
function end(id: number, state: VcState, outcome: VcOutcome, now: Date, extra: Record<string, string | null> = {}) {
  const sets = Object.keys(extra).map((k) => `,${k}=?`).join("");
  executeChanges(`UPDATE voip_click_calls SET state=?, outcome=?, active=0, ended_at=COALESCE(ended_at,?), updated_at=?${sets} WHERE id=? AND active=1`,
    [state, outcome, iso(now), iso(now), ...Object.values(extra), id]);
}
/** Lazy timeouts (run on every read + from the event hook): 30 s ring, stale request / dial / talk safety. */
export function vcSweep(now = new Date()) {
  if (!vcTableExists()) return;
  for (const c of queryRows<VcRow>("SELECT * FROM voip_click_calls WHERE active=1")) {
    const age = (now.getTime() - ms(c.updated_at)) / 1000;
    if (c.state === "ring_me" && c.ring_deadline && now.getTime() >= ms(c.ring_deadline)) end(c.id, "me_timeout", null, now);
    else if (c.state === "requesting" && (now.getTime() - ms(c.created_at)) / 1000 > REQUEST_STALE_S) end(c.id, "error", null, now, { error_code: "request_stale" });
    else if (c.state === "dial_cust" && age > DIAL_STALE_S) end(c.id, "ended", "no_answer", now);
    else if (c.state === "in_call" && age > TALK_STALE_S) end(c.id, "ended", "answered", now);
  }
}

/** The CDR (through the existing after-call pipeline) refines the outcome, adds the recording and the event id. Idempotent. */
/** CDR-final = the provider row (ingestAfterCalls replaced the live-… id or set the provider id); an idle-closed live row is NOT a CDR. */
const FINAL = "(is_live=0 AND (external_id NOT LIKE 'live-%' OR recording_provider_id IS NOT NULL))";
const CDR_OUT = (status: string): VcOutcome => { const s = status.toUpperCase(); return s === "ANSWERED" ? "answered" : s === "BUSY" ? "busy" : "no_answer"; };
function vcLink(c: VcRow, now = new Date()): VcRow {
  if (c.state === "requesting" || c.state === "error") return c;
  if (c.event_id == null) {
    const cand = queryRows<{ id: number; phone: string; live_cuid: string | null; fin: number }>(
      `SELECT id, phone, live_cuid, ${FINAL} fin FROM voip_after_call_events WHERE extension=? AND direction='outgoing' AND mobile_device_id IS NULL
        AND julianday(started_at)>=julianday(?)-10.0/86400 AND julianday(started_at)<=julianday(?)+15.0/1440
        AND id NOT IN (SELECT event_id FROM voip_click_calls WHERE event_id IS NOT NULL) ORDER BY id`,
      [c.extension, c.created_at, c.created_at]).filter((e) => normalizePhone(e.phone) === c.phone);
    const mine = (x: { live_cuid: string | null }) => !!x.live_cuid && (x.live_cuid === c.cuid || x.live_cuid === c.leg_cuid);
    const e = cand.find((x) => mine(x) && x.fin) ?? cand.find(mine) ?? cand.find((x) => x.fin);
    if (e) { executeChanges("UPDATE voip_click_calls SET event_id=? WHERE id=? AND event_id IS NULL", [e.id, c.id]); c = { ...c, event_id: e.id }; }
  }
  if (c.event_id != null && !c.cdr_at) {
    const e = queryRow<{ status: string; fin: number }>(`SELECT status, ${FINAL} fin FROM voip_after_call_events WHERE id=?`, [c.event_id]);
    if (e && e.fin && e.status) {
      const out = CDR_OUT(e.status);
      // A CDR means the expert answered (Simotel sends none when the first leg is not answered): it also corrects a missed-NewState timeout.
      executeChanges(`UPDATE voip_click_calls SET cdr_at=?, outcome=?, state=CASE WHEN state IN ('me_timeout','ended') OR active=0 THEN 'ended' ELSE state END,
        updated_at=? WHERE id=?`, [iso(now), out, iso(now), c.id]);
      if (c.active) end(c.id, "ended", out, now); // a CDR means the call is over even if the idle NewState was missed
      if (c.result_saved_at) vcCompleteEvent(c.event_id, c.user_id, now);
      c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=?", [c.id])!;
    }
  }
  return c;
}
/** The click call's own result also completes the after-call queue entry, so the expert is not asked twice for the same call. */
function vcCompleteEvent(eventId: number, userId: number, now: Date) {
  const r = queryRow<{ result_outcome: string | null; note: string | null }>(
    "SELECT result_outcome, (SELECT note FROM fc_followups f WHERE f.user_id=k.user_id AND f.customer_id=k.customer_id ORDER BY f.id DESC LIMIT 1) note FROM voip_click_calls k WHERE event_id=?", [eventId]);
  const notes = r?.note ?? "";
  executeChanges(`UPDATE voip_after_call_events SET expert_notes=?, completed_at=?, completed_by_user_id=?, completed_payload=? WHERE id=? AND completed_at IS NULL`,
    [notes, iso(now), userId, JSON.stringify({ expertNotes: notes, source: "voip_call", outcome: r?.result_outcome ?? null }), eventId]);
  const log = queryRow<{ call_log_id: number | null }>("SELECT call_log_id FROM voip_after_call_events WHERE id=?", [eventId])?.call_log_id;
  if (log != null && notes) executeChanges("UPDATE call_logs SET expert_notes=CASE WHEN COALESCE(expert_notes,'')='' THEN ? ELSE expert_notes END WHERE id=?", [notes, log]);
}

export type VcView = {
  id: number; state: VcState; outcome: VcOutcome; customerId: number; customerName: string | null; fileId: number | null; extension: string;
  createdAt: string; secondsLeft: number | null; meAnsweredAt: string | null; custAnsweredAt: string | null; endedAt: string | null;
  durationSeconds: number | null; cdr: boolean; recording: "processing" | "ready" | "none"; eventId: number | null; active: boolean;
  needsResult: boolean; resultSaved: boolean; resultOutcome: string | null; prefill: "answered" | "no_answer" | null; oneTap: boolean; errorCode: string | null;
};
export function vcView(c: VcRow, now = new Date()): VcView {
  const e0 = c.event_id != null ? queryRow<{ has_recording: number; recording_file: string | null; fin: number; started_at: string; ended_at: string }>(
    `SELECT has_recording, recording_file, ${FINAL} fin, started_at, ended_at FROM voip_after_call_events WHERE id=?`, [c.event_id]) : null;
  const e = e0 ? { ...e0, is_live: e0.fin ? 0 : 1 } : null;
  const ended = !c.active;
  const talk = c.cust_answered_at && c.ended_at ? Math.max(0, Math.round((ms(c.ended_at) - ms(c.cust_answered_at)) / 1000))
    : c.outcome === "answered" && e && !e.is_live ? Math.max(0, Math.round((ms(e.ended_at) - ms(e.started_at)) / 1000)) : null;
  const talking = c.state === "in_call" && c.cust_answered_at ? Math.max(0, Math.round((now.getTime() - ms(c.cust_answered_at)) / 1000)) : null;
  const rec: VcView["recording"] = c.outcome !== "answered" ? "none" : e && !e.is_live ? (e.has_recording && e.recording_file ? "ready" : "none") : "processing";
  const counts = ended && (c.state === "ended") && c.outcome != null;
  return {
    id: c.id, state: c.state, outcome: c.outcome, customerId: c.customer_id, fileId: c.file_id, extension: c.extension,
    customerName: queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [c.customer_id])?.name ?? null,
    createdAt: c.created_at, secondsLeft: c.state === "ring_me" && c.ring_deadline ? Math.max(0, Math.ceil((ms(c.ring_deadline) - now.getTime()) / 1000)) : null,
    meAnsweredAt: c.me_answered_at, custAnsweredAt: c.cust_answered_at, endedAt: c.ended_at, durationSeconds: talking ?? talk, cdr: !!c.cdr_at,
    recording: rec, eventId: c.event_id, active: !!c.active, needsResult: counts && c.file_id != null && !c.result_saved_at, resultSaved: !!c.result_saved_at,
    resultOutcome: c.result_outcome, prefill: !counts ? null : c.outcome === "answered" ? "answered" : "no_answer",
    oneTap: counts && (c.outcome === "no_answer" || c.outcome === "busy"), errorCode: c.error_code,
  };
}
const err = (status: number, error: string, message: string, details?: object) => ({ status, body: { error, message, ...(details ? { details } : {}) } });

/** The expert's panel state: the live call, else the latest ended call still waiting for a result, else a recent timeout / error notice. */
export function vcMe(u: U, now = new Date()) {
  const ext = vcExtension(u.id);
  if (!vcTableExists()) return { on: true, extension: ext, call: null, timeoutSeconds: VC_ME_TIMEOUT_S };
  vcSweep(now);
  let c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE user_id=? AND active=1", [u.id])
    ?? queryRow<VcRow>(`SELECT * FROM voip_click_calls WHERE user_id=? AND dismissed_at IS NULL AND result_saved_at IS NULL
        AND (state='ended' OR julianday(updated_at)>=julianday(?)-?/86400.0) ORDER BY id DESC LIMIT 1`, [u.id, iso(now), NOTICE_KEEP_S]);
  if (c) c = vcLink(c, now);
  return { on: true, extension: ext, call: c ? vcView(c, now) : null, timeoutSeconds: VC_ME_TIMEOUT_S };
}
export function vcCustomerAllowed(u: U, customerId: number): boolean {
  const c = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c) return false;
  return u.role === "admin" || u.customerScope === "all" || (u.salespersonId != null && Number(u.salespersonId) === Number(c.salesperson_id));
}
let originateImpl = simotelOriginate;
/** Test seam only (unit tests); production always uses simotelOriginate. */
export function __setOriginateForTests(f: typeof simotelOriginate) { originateImpl = f; }

export async function vcStart(u: U, body: any, now = new Date()) {
  ensureVcSchema(); vcSweep(now);
  const ext = vcExtension(u.id);
  if (!ext) return err(422, "no_extension", "برای تو داخلی ویپ (سیموتل) تعریف نشده؛ شماره را کپی کن و با گوشی خودت بگیر.");
  const cid = Number(body?.customerId), fid = body?.fileId == null ? null : Number(body.fileId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return err(400, "bad_customer", "مشتری معتبر نیست.");
  if (fid != null && (!Number.isSafeInteger(fid) || fid <= 0)) return err(400, "bad_file", "پرونده معتبر نیست.");
  if (!vcCustomerAllowed(u, cid)) return err(403, "not_own_customer", "فقط با مشتری خودت می‌توانی تماس بگیری.");
  if (fid != null && !queryRow("SELECT 1 x FROM loan_applications WHERE id=? AND customer_id=? AND deleted_at IS NULL", [fid, cid])) return err(400, "bad_file", "این پرونده مال همین مشتری نیست.");
  const raw = queryRow<{ phone: string | null }>("SELECT phone FROM customers WHERE id=?", [cid])?.phone ?? "";
  const phone = normalizePhone(raw);
  if (!phone) return err(422, "no_phone", "شماره‌ی این مشتری معتبر نیست.");
  let excluded = false; try { excluded = !!queryRow("SELECT 1 x FROM voip_call_display_exclusions WHERE phone=?", [phone]); } catch { /* table absent */ }
  if (excluded) return err(422, "excluded_phone", "تماس با این شماره از سامانه بسته است.");
  const busy = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE user_id=? AND active=1", [u.id]);
  if (busy) return err(409, "one_call", "یک تماس در جریان است؛ هر بار فقط یک تماس.", { call: vcView(busy, now) });
  // Design (HANDOFF §برای آدیتیا): answered / no answer / busy keep the task lock until the result is saved. A redial of the same file is
  // allowed («دوباره زنگ بزن») and supersedes the unsaved call; any other customer waits for that result.
  const open = queryRow<VcRow>(`SELECT * FROM voip_click_calls WHERE user_id=? AND state='ended' AND outcome IS NOT NULL AND file_id IS NOT NULL
    AND result_saved_at IS NULL AND dismissed_at IS NULL ORDER BY id DESC LIMIT 1`, [u.id]);
  if (open && open.file_id !== fid) return err(409, "needs_result", "اول نتیجه‌ی تماس قبلی را ثبت کن؛ تسک بعدی تا ثبت نتیجه قفل است.", { call: vcView(open, now) });
  if (open) executeChanges("UPDATE voip_click_calls SET dismissed_at=? WHERE id=?", [iso(now), open.id]);
  let id: number;
  try {
    const r = crmDb.prepare(`INSERT INTO voip_click_calls(user_id,extension,customer_id,file_id,phone,state,active,created_at,updated_at) VALUES(?,?,?,?,?,'requesting',1,?,?)`)
      .run(u.id, ext, cid, fid, phone, iso(now), iso(now));
    id = Number(r.lastInsertRowid);
  } catch { return err(409, "one_call", "یک تماس در جریان است؛ هر بار فقط یک تماس."); }
  try {
    const ctx = setting("voip_call.context") || "main_routing";
    const callerId = setting("voip_call.caller_id") || ext;
    const trunk = setting("voip_call.trunk_name") || undefined;
    const o = await originateImpl({ caller: ext, callee: phone, context: ctx, callerId, trunkName: trunk, timeout: VC_ME_TIMEOUT_S });
    const t = new Date();
    executeChanges(`UPDATE voip_click_calls SET state=CASE WHEN state='requesting' THEN 'ring_me' ELSE state END, originate_id=?,
      ring_deadline=?, updated_at=? WHERE id=? AND active=1`, [o.originateId, iso(new Date(t.getTime() + VC_ME_TIMEOUT_S * 1000)), iso(t), id]);
  } catch (e) {
    end(id, "error", null, new Date(), { error_code: e instanceof SimotelError ? e.code : "unavailable" });
  }
  const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=?", [id])!;
  return { status: 200, body: { ok: true, call: vcView(c) } };
}
export function vcDismiss(u: U, id: number, now = new Date()) {
  if (!vcTableExists()) return err(404, "not_found", "این تماس پیدا نشد.");
  const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=? AND user_id=?", [id, u.id]);
  if (!c) return err(404, "not_found", "این تماس پیدا نشد.");
  if (c.active) return err(409, "still_active", "تماس هنوز در جریان است.");
  if (c.state === "ended" && c.file_id != null && !c.result_saved_at) return err(409, "needs_result", "نتیجه‌ی این تماس هنوز ثبت نشده است.");
  executeChanges("UPDATE voip_click_calls SET dismissed_at=? WHERE id=?", [iso(now), id]);
  return { status: 200, body: { ok: true } };
}

/** NewState hook (called from receiveSimotelCallEvent inside its transaction). Returns true when a click call changed. */
export function vcOnNewState(body: Record<string, unknown>, now = new Date()): boolean {
  if (!vcTableExists() || !vcAnyOn()) return false;
  const t = (v: unknown, n = 128) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
  const cuid = t(body.unique_id ?? body.cuid).replace(/\s+/g, ""), ext = t(body.exten, 6);
  const state = t(body.state).toLowerCase().replace(/\s/g, ""), dialer = t(body.dialer).toLowerCase() === "yes" ? "yes" : "no";
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(cuid) || !/^[0-9]{2,6}$/.test(ext)) return false;
  vcSweep(now);
  const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE extension=? AND active=1 ORDER BY id DESC LIMIT 1", [ext]);
  if (!c) return false;
  const pp = normalizePhone(t(body.participant)); const party = pp === c.phone ? "c" : pp ? "o" : "-";
  if (c.cuid && c.cuid !== cuid && c.leg_cuid !== cuid) {
    if (party !== "c" || c.leg_cuid) return false; // another call on the same extension (e.g. an incoming call) is not this click call
    executeChanges("UPDATE voip_click_calls SET leg_cuid=? WHERE id=?", [cuid, c.id]);
  } else if (!c.cuid) {
    if (!["ringing", "inuse"].includes(state) || now.getTime() < ms(c.created_at) - 2000) return false;
    executeChanges("UPDATE voip_click_calls SET cuid=? WHERE id=? AND cuid IS NULL", [cuid, c.id]);
  }
  // Dedup per cuid: the same (cuid, extension, state, dialer, party) never applies twice.
  if (executeChanges("INSERT OR IGNORE INTO voip_click_signals(cuid,extension,state,dialer,party,call_id,received_at) VALUES(?,?,?,?,?,?,?)",
    [cuid, ext, state, dialer, party, c.id, iso(now)]) === 0) return false;
  executeChanges("DELETE FROM voip_click_signals WHERE julianday(received_at)<julianday(?)-2", [iso(now)]);
  const at = iso(now); const rm = c.state === "ring_me" || c.state === "requesting";
  if (state === "ringing") {
    return false; // ring_me already (set by the originate); the 30 s deadline stays
  }
  if (state === "inuse") {
    if (dialer === "yes" || rm) {
      if (rm || c.state === "dial_cust") {
        const next = dialer === "yes" || party !== "c" ? "dial_cust" : "in_call";
        executeChanges(`UPDATE voip_click_calls SET state=?, me_answered_at=COALESCE(me_answered_at,?), cust_answered_at=CASE WHEN ?='in_call' THEN COALESCE(cust_answered_at,?) ELSE cust_answered_at END,
          updated_at=? WHERE id=? AND active=1`, [next, at, next, at, at, c.id]);
        return true;
      }
      return false;
    }
    if (c.state === "dial_cust") {
      executeChanges("UPDATE voip_click_calls SET state='in_call', cust_answered_at=COALESCE(cust_answered_at,?), updated_at=? WHERE id=? AND active=1", [at, at, c.id]);
      return true;
    }
    return false;
  }
  if (["idle", "unavailable", "pause", "notinuse"].includes(state)) {
    if (rm) end(c.id, "me_timeout", null, now);
    else end(c.id, "ended", c.state === "in_call" ? "answered" : "no_answer", now); // the CDR may still correct no_answer → busy / answered
    return true;
  }
  return false;
}
/** Trunk OutgoingCall for the customer number: Simotel started dialing the customer (the expert answered). */
export function vcOnOutgoing(cuid: string, phone: string, now = new Date()): boolean {
  if (!vcTableExists() || !vcAnyOn()) return false;
  const p = normalizePhone(phone); if (!p) return false;
  const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE phone=? AND active=1 AND state='ring_me' AND (cuid IS NULL OR cuid=? OR leg_cuid IS NULL) ORDER BY id DESC LIMIT 1", [p, cuid]);
  if (!c) return false;
  const at = iso(now);
  executeChanges(`UPDATE voip_click_calls SET state='dial_cust', me_answered_at=COALESCE(me_answered_at,?), cuid=COALESCE(cuid,?),
    leg_cuid=CASE WHEN cuid IS NOT NULL AND cuid<>? THEN COALESCE(leg_cuid,?) ELSE leg_cuid END, updated_at=? WHERE id=? AND active=1`, [at, cuid, cuid, cuid, at, c.id]);
  return true;
}

/** Files-carousel followup with voipCallId: validates the call, returns whether the note may be empty (one-tap no_answer / busy). */
export function vcFollowupCheck(u: U, body: any, customerId: number | null, outcome: string, now = new Date()):
  { ok: true; call: VcRow | null; noteOptional: boolean } | { ok: false; status: number; body: object } {
  if (!vcOn(u) || !vcTableExists()) return { ok: true, call: null, noteOptional: false }; // flag off → ignored, old rules
  if (body?.voipCallId == null) {
    // Saved from the plain «تماس گرفتم، ثبت نتیجه» button: still close an ended click call of this file so it never blocks the next task.
    const fid = Number(body?.fileId);
    const o = Number.isSafeInteger(fid) ? queryRow<VcRow>(`SELECT * FROM voip_click_calls WHERE user_id=? AND file_id=? AND state='ended' AND outcome IS NOT NULL
      AND result_saved_at IS NULL AND dismissed_at IS NULL ORDER BY id DESC LIMIT 1`, [u.id, fid]) : null;
    return { ok: true, call: o ? vcLink(o, now) : null, noteOptional: false };
  }
  const id = Number(body.voipCallId);
  let c = Number.isSafeInteger(id) ? queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=? AND user_id=?", [id, u.id]) : null;
  if (!c) { const e = err(404, "voip_call_not_found", "این تماس پیدا نشد."); return { ok: false, ...e }; }
  if (customerId != null && c.customer_id !== customerId) { const e = err(409, "voip_call_other_customer", "این تماس مال مشتری دیگری است."); return { ok: false, ...e }; }
  c = vcLink(c, now);
  const one = !c.active && c.state === "ended" && (c.outcome === "no_answer" || c.outcome === "busy") && outcome === "no_answer";
  return { ok: true, call: c, noteOptional: one };
}
export function vcFollowupSaved(call: VcRow | null, outcome: string, now = new Date()) {
  if (!call) return;
  executeChanges("UPDATE voip_click_calls SET result_saved_at=COALESCE(result_saved_at,?), result_outcome=? WHERE id=?", [iso(now), outcome, call.id]);
  const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=?", [call.id]);
  if (c?.event_id != null) vcCompleteEvent(c.event_id, c.user_id, now);
}

/** «سابقه‌ی تماس‌ها» of one customer: VoIP click calls (all experts), other Simotel calls of the customer, and old manual call logs. */
export function vcHistory(u: U, customerId: number, now = new Date()) {
  if (vcTableExists()) for (const c of queryRows<VcRow>("SELECT * FROM voip_click_calls WHERE customer_id=? AND event_id IS NULL AND state='ended' ORDER BY id DESC LIMIT 20", [customerId])) vcLink(c, now);
  const clicks = vcTableExists() ? queryRows<VcRow & { expert: string | null }>(
    "SELECT k.*, us.full_name expert FROM voip_click_calls k LEFT JOIN users us ON us.id=k.user_id WHERE k.customer_id=? AND k.state='ended' ORDER BY k.id DESC LIMIT 30", [customerId]) : [];
  const linked = new Set(clicks.map((c) => c.event_id).filter((x) => x != null));
  const outLabel: Record<string, string> = { answered: "جواب داد", no_answer: "جواب نداد", follow_up: "پیگیری بعدی", cancelled: "لغو شده" };
  const noteOf = (c: VcRow) => c.result_saved_at ? queryRow<{ note: string }>("SELECT note FROM fc_followups WHERE user_id=? AND customer_id=? AND julianday(created_at)>=julianday(?) ORDER BY id LIMIT 1", [c.user_id, c.customer_id, c.created_at])?.note ?? "" : "";
  const items: any[] = clicks.map((c) => { const v = vcView(c, now); return {
    kind: "voip", id: `k${c.id}`, at: c.created_at, status: c.outcome, durationSeconds: v.durationSeconds, expert: c.expert ?? null,
    fileId: c.file_id, recording: v.recording, playable: v.recording === "ready" && (u.role === "admin" || c.user_id === u.id), eventId: c.event_id,
    result: c.result_outcome ? { label: outLabel[c.result_outcome] ?? c.result_outcome, note: noteOf(c) } : null, pending: !c.result_saved_at };
  });
  // Other Simotel calls of this customer (incoming or from the panel), CDR-final only.
  for (const e of queryRows<{ id: number; started_at: string; ended_at: string; status: string; direction: string; has_recording: number; recording_file: string | null; expert_name: string | null; expert_user_id: number | null; expert_notes: string }>(
    `SELECT e.id, e.started_at, e.ended_at, e.status, e.direction, e.has_recording, e.recording_file, e.expert_name, e.expert_user_id, e.expert_notes
       FROM voip_after_call_events e LEFT JOIN call_logs l ON l.id=e.call_log_id WHERE COALESCE(l.customer_id,e.customer_id)=? AND e.is_live=0 AND e.mobile_device_id IS NULL
       ORDER BY e.id DESC LIMIT 20`, [customerId])) {
    if (linked.has(e.id)) continue;
    const st = CDR_OUT(e.status);
    items.push({ kind: "simotel", id: `e${e.id}`, at: e.started_at, status: st, direction: e.direction,
      durationSeconds: st === "answered" ? Math.max(0, Math.round((ms(e.ended_at) - ms(e.started_at)) / 1000)) : null, expert: e.expert_name, fileId: null,
      recording: st === "answered" && e.has_recording && e.recording_file ? "ready" : "none",
      playable: !!(st === "answered" && e.has_recording && e.recording_file) && (u.role === "admin" || e.expert_user_id === u.id), eventId: e.id,
      result: e.expert_notes ? { label: null, note: e.expert_notes } : null, pending: false });
  }
  // Old manual call logs (not made by the automatic VoIP pipeline).
  for (const l of queryRows<{ id: number; created_at: string; outcome: string | null; expert_notes: string | null; subject: string | null; by: string | null }>(
    `SELECT l.id, l.created_at, COALESCE(l.call_result,l.outcome) outcome, COALESCE(NULLIF(l.one_line_note,''),l.expert_notes) expert_notes, l.subject,
        COALESCE(us.full_name,l.salesperson_name_snapshot) by FROM call_logs l LEFT JOIN users us ON us.id=l.created_by_user_id
      WHERE l.customer_id=? AND NOT EXISTS (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=l.id) ORDER BY l.id DESC LIMIT 10`, [customerId])) {
    items.push({ kind: "manual", id: `m${l.id}`, at: l.created_at, status: l.outcome === "off_or_busy" ? "busy" : l.outcome === "no_answer" ? "no_answer" : l.outcome ? "answered" : null,
      durationSeconds: null, expert: l.by, fileId: null, recording: "none", playable: false, eventId: null,
      result: l.expert_notes || l.subject ? { label: l.subject ?? null, note: l.expert_notes ?? "" } : null, pending: false });
  }
  items.sort((a, b) => ms(b.at) - ms(a.at));
  return { items: items.slice(0, 40) };
}
/** Own call (or admin) → the provider recording file name of a CDR-final event. */
export function vcRecordingFile(u: U, eventId: number): string | null {
  const e = queryRow<{ recording_file: string | null; expert_user_id: number | null; is_live: number; extension: string | null }>(
    "SELECT recording_file, expert_user_id, is_live, extension FROM voip_after_call_events WHERE id=?", [eventId]);
  if (!e || e.is_live || !e.recording_file) return null;
  const own = e.expert_user_id === u.id || (vcTableExists() && !!queryRow("SELECT 1 x FROM voip_click_calls WHERE event_id=? AND user_id=?", [eventId, u.id]));
  return u.role === "admin" || own ? e.recording_file : null;
}
/** Event ids linked to a click call, hidden from the generic after-call queue while the flag is on (the click call asks for the result once). */
export function vcClickEventFilterSql(): string {
  return vcTableExists() && vcAnyOn() ? " AND NOT EXISTS (SELECT 1 FROM voip_click_calls kk WHERE kk.event_id=e.id OR (kk.cuid IS NOT NULL AND (kk.cuid=e.live_cuid OR kk.leg_cuid=e.live_cuid)))" : "";
}
