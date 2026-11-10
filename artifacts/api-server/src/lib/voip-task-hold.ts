/**
 * VOIP-TASK-HOLD (flag.voip_task_hold_v1, default OFF). Armita «تماس ویپ و حفظ کار جاری» v1.0.
 *
 * Global flag.voip_task_hold_v1='1' or per-user flag.voip_task_hold_v1.user.<id>='1'. Absent / anything else = OFF
 * → every hold hook is a no-op, /voip-call/me stays unchanged (no `vth` field), and today's VoIP / s132 / carousel
 * behaviour is untouched.
 *
 * While ON (on top of the existing Simotel click-to-call; no hang-up API):
 *  - Hold the current customer / task across file, carousel, reminder, lead and search until hang-up + a valid
 *    final CDR status + a successful explicit result save. That save completes the task the same way the current
 *    UI does (rvResult / fcExpertFollowup / dpAfterFirstCallForm). End of call alone never advances a queue.
 *  - In-call status is neutral: the expert's own phone answering is not the customer's answer; no "answered"
 *    or customer talk time without a valid customer-leg CDR.
 *  - After a real hang-up with an unknown status: pending_status (retry is a CDR re-query, never a manual end).
 *  - Exactly one form after a valid final status (first-call wizard first, else reminder result, else result form).
 *  - Cancel / close never completes a reminder or advances the queue.
 *  - Next-customer PII is not disclosed while the gate is closed (including other tabs).
 *  - Tajik eligibility is the already-published registrar-scope rule (registered / open_filing / incoming_grant);
 *    this module only exposes it for the UI. Call permission is not edit permission.
 * No SMS, no contract/template, csfields, ReminderMust, team_sales_config or notification_settings writes.
 */
import { crmDb, executeChanges, queryRow, queryRows } from "./crm-db";
import { vcIsScopedRegistrar, vcRegistrarWhy, type VcRegistrarWhy } from "./voip-registrar-scope";
import { vthCallLogId, vthCompleteExisting } from "./voip-task-hold-complete";

export const VTH_FLAG = "flag.voip_task_hold_v1";
export const VTH_ENTRIES = ["file", "carousel", "reminder", "lead", "search"] as const;
export type VthEntry = (typeof VTH_ENTRIES)[number];
export type VthPhase = "idle" | "in_call" | "pending_status" | "status_error" | "final" | "saved";
export type VthForm = "first_call" | "reminder_result" | "result" | null;
export type VthEligWhy = "registered" | "assigned" | "callback";

const LIVE = new Set(["requesting", "ring_me", "dial_cust", "in_call"]);
const FINAL_OK = new Set(["ANSWERED"]);
const FINAL_NA = new Set(["NO ANSWER", "BUSY", "FAILED", "CONGESTION", "CHANUNAVAIL", "CANCEL"]);
const WHY_UI: Record<VcRegistrarWhy, VthEligWhy> = { registered: "registered", open_filing: "assigned", incoming_grant: "callback" };

type U = { id: number; role?: string | null; salespersonId?: number | null; customerScope?: string | null; name?: string | null };
type CallLite = {
  id: number; user_id: number; customer_id: number; file_id: number | null; state: string; outcome: string | null;
  active: number; result_saved_at: string | null; dismissed_at: string | null; ended_at: string | null; cdr_at: string | null;
  cust_status?: string | null; billsec?: number | null; error_code?: string | null; event_id?: number | null;
};

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; }
};
const iso = (d: Date) => d.toISOString();

export function vthFlagOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting(VTH_FLAG) === "1" || setting(`${VTH_FLAG}.user.${Number(userId)}`) === "1";
}
export function vthAnyOn(): boolean {
  try {
    return setting(VTH_FLAG) === "1" || !!queryRow("SELECT 1 x FROM call_queue_settings WHERE key LIKE 'flag.voip_task_hold_v1.user.%' AND value='1' LIMIT 1");
  } catch { return false; }
}

let ensured = false;
export function ensureVthSchema() {
  if (ensured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_task_holds(
      call_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, file_id INTEGER, reminder_id INTEGER,
      entry TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT, last_retry_at TEXT, last_retry_ok INTEGER);
    CREATE INDEX IF NOT EXISTS idx_vth_user ON voip_task_holds(user_id, released_at, call_id);`);
  ensured = true;
}
function tableOk(): boolean {
  if (ensured) return true;
  try { return !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_task_holds'"); } catch { return false; }
}

export function vthParseEntry(raw: unknown, fallback: VthEntry = "file"): VthEntry {
  const s = typeof raw === "string" ? raw.trim() : "";
  return (VTH_ENTRIES as readonly string[]).includes(s) ? (s as VthEntry) : fallback;
}

export function vthAttach(u: U, callId: number, body: any, now = new Date()) {
  if (!vthFlagOn(u.id) || !Number.isSafeInteger(callId) || callId <= 0) return;
  ensureVthSchema();
  const cid = Number(body?.customerId);
  const fid = body?.fileId == null ? null : Number(body.fileId);
  const rid = body?.reminderId == null ? null : Number(body.reminderId);
  let entry = vthParseEntry(body?.entry, rid != null ? "reminder" : fid != null ? "file" : "search");
  if (rid != null) entry = "reminder";
  executeChanges(`INSERT OR IGNORE INTO voip_task_holds(call_id,user_id,customer_id,file_id,reminder_id,entry,created_at) VALUES(?,?,?,?,?,?,?)`,
    [callId, u.id, Number.isSafeInteger(cid) ? cid : 0, Number.isSafeInteger(fid) ? fid : null, rid != null && Number.isSafeInteger(rid) && rid > 0 ? rid : null, entry, iso(now)]);
}

export function vthRelease(callId: number, now = new Date()) {
  if (!tableOk()) return;
  executeChanges("UPDATE voip_task_holds SET released_at=COALESCE(released_at,?) WHERE call_id=?", [iso(now), callId]);
}

type HoldRow = { call_id: number; user_id: number; customer_id: number; file_id: number | null; reminder_id: number | null; entry: VthEntry;
  created_at: string; released_at: string | null; last_retry_at: string | null; last_retry_ok: number | null };

function holdOf(callId: number): HoldRow | null {
  if (!tableOk()) return null;
  return queryRow<HoldRow>("SELECT * FROM voip_task_holds WHERE call_id=?", [callId]) ?? null;
}

/** A valid, authoritative customer-leg CDR (not UNKNOWN / NOT_DIALED, not a hang-up guess). */
export function vthFinalStatus(c: { cdr_at?: string | null; cust_status?: string | null; billsec?: number | null; outcome?: string | null }): boolean {
  if (!c.cdr_at) return false;
  const st = String(c.cust_status ?? "").trim().toUpperCase();
  if (FINAL_OK.has(st) && (c.billsec == null || Number(c.billsec) > 0)) return true;
  if (FINAL_NA.has(st)) return true;
  return false;
}

function loadCall(userId: number, now = new Date()): CallLite | null {
  try {
    return queryRow<CallLite>("SELECT * FROM voip_click_calls WHERE user_id=? AND active=1", [userId])
      ?? queryRow<CallLite>(`SELECT * FROM voip_click_calls WHERE user_id=? AND dismissed_at IS NULL AND result_saved_at IS NULL
          AND state IN ('ended','error','me_timeout') ORDER BY id DESC LIMIT 1`, [userId])
      ?? null;
  } catch { return null; }
}

export function vthPhaseOf(c: CallLite | null, hold: HoldRow | null): VthPhase {
  if (!c) return "idle";
  if (LIVE.has(c.state) && c.active) return "in_call";
  if (c.result_saved_at) return "saved";
  if (c.state === "me_timeout" || (c.state === "error" && !c.ended_at && !c.cdr_at)) return "idle";
  if (c.state === "ended" || (c.state === "error" && c.ended_at)) {
    if (vthFinalStatus(c)) return "final";
    if (hold?.last_retry_at && hold.last_retry_ok === 0) return "status_error";
    return "pending_status";
  }
  return "idle";
}

export function vthFormOf(c: CallLite | null, hold: HoldRow | null, phase: VthPhase): VthForm {
  if (phase !== "final" && phase !== "saved") return null;
  try {
    const first = c ? queryRow<{ first_call: number }>("SELECT first_call FROM s132_calls WHERE call_id=?", [c.id])?.first_call : 0;
    if (first) return "first_call";
  } catch { /* s132 table may be absent */ }
  if (hold?.entry === "reminder" || hold?.reminder_id != null) return "reminder_result";
  return "result";
}

export function vthQueue(entry: VthEntry | null | undefined): boolean {
  return entry === "carousel" || entry === "reminder" || entry === "lead";
}

/** True while the next-work gate must stay closed (live, unknown status, or unsaved result). */
export function vthBlockNext(u: U, now = new Date()): boolean {
  if (!vthFlagOn(u.id)) return false;
  const c = loadCall(u.id, now);
  if (!c) return false;
  const phase = vthPhaseOf(c, holdOf(c.id));
  return phase === "in_call" || phase === "pending_status" || phase === "status_error" || phase === "final";
}

/** Open ended/pending click call that must keep the lock (any entry, not only file tasks). */
export function vthOpenCall(u: U): CallLite | null {
  if (!vthFlagOn(u.id)) return null;
  const c = loadCall(u.id);
  if (!c) return null;
  const phase = vthPhaseOf(c, holdOf(c.id));
  if (phase === "in_call" || phase === "pending_status" || phase === "status_error" || phase === "final") return c;
  return null;
}

export function vthSameTarget(open: CallLite, customerId: number, fileId: number | null): boolean {
  if (Number(open.customer_id) !== Number(customerId)) return false;
  if (open.file_id != null && fileId != null) return Number(open.file_id) === Number(fileId);
  return true;
}

export type VthMe = {
  on: true;
  phase: VthPhase;
  entry: VthEntry | null;
  queue: boolean;
  form: VthForm;
  reminderId: number | null;
  nextBlocked: boolean;
  saveLabel: "ثبت نتیجه و کار بعدی" | "ثبت نتیجه";
};

export function vthMePayload(u: U, call: CallLite | null, now = new Date()): VthMe | undefined {
  if (!vthFlagOn(u.id)) return undefined;
  const hold = call ? holdOf(call.id) : null;
  const phase = vthPhaseOf(call, hold);
  const entry = hold?.entry ?? null;
  const form = vthFormOf(call, hold, phase);
  const blocked = phase === "in_call" || phase === "pending_status" || phase === "status_error" || phase === "final";
  return {
    on: true, phase, entry, queue: vthQueue(entry), form, reminderId: hold?.reminder_id ?? null, nextBlocked: blocked,
    saveLabel: vthQueue(entry) ? "ثبت نتیجه و کار بعدی" : "ثبت نتیجه",
  };
}

export function vthEligWhy(u: U, customerId: number, now = new Date()): { allowed: boolean; why: VthEligWhy | null; reason: string } | null {
  if (!vcIsScopedRegistrar(u)) return null;
  const raw = vcRegistrarWhy(u, customerId, now);
  if (!raw) return { allowed: false, why: null, reason: "مشتری شما نیست؛ دسترسی نامعتبر یا مهلت پاسخ تمام شده" };
  const why = WHY_UI[raw];
  const reason = why === "registered" ? "ثبت‌نام با خودت"
    : why === "assigned" ? "پرونده‌ی ثبت‌نام اکنون با شماست"
    : "تماس ورودی به شما؛ مهلت پاسخ معتبر است";
  return { allowed: true, why, reason };
}

export function vthOwnerExt(customerId: number): { name: string | null; extension: string | null } {
  const row = queryRow<{ name: string | null; extension: string | null }>(
    `SELECT COALESCE(us.full_name, sp.name) name, ve.extension
       FROM customers c
       LEFT JOIN salespersons sp ON sp.id=c.salesperson_id
       LEFT JOIN users us ON us.salesperson_id=c.salesperson_id
       LEFT JOIN voip_extensions ve ON ve.user_id=us.id
      WHERE c.id=? LIMIT 1`, [customerId]);
  const ext = row?.extension && /^[0-9]{2,6}$/.test(row.extension) ? row.extension : null;
  return { name: row?.name ?? null, extension: ext };
}

export type VthContext = {
  on: true;
  canCall: boolean;
  phoneVisible: boolean;
  notesWritable: boolean; // support notes stay read-only; this is not a new write grant
  eligibility: { allowed: boolean; why: VthEligWhy | null; reason: string } | null;
  otherOwner: { name: string | null; extension: string | null } | null;
  own: boolean;
  support: boolean;
};

export function vthContext(u: U, customerId: number, now = new Date()): VthContext {
  const support = vcIsScopedRegistrar(u);
  const elig = vthEligWhy(u, customerId, now);
  const owner = vthOwnerExt(customerId);
  const sp = u.salespersonId != null && Number(u.salespersonId) > 0 ? Number(u.salespersonId) : null;
  const cust = queryRow<{ salesperson_id: number | null; registered_by: number | null }>(
    "SELECT salesperson_id, registered_by FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  const own = !!cust && ((u.role === "admin") || (sp != null && Number(cust.salesperson_id) === sp) || u.customerScope === "all");
  // A scoped registrar uses the published A/B/C rule, not customerScope 'all'.
  const allowed = support && elig ? elig.allowed : (u.role === "admin" || own);
  const other = allowed ? null : { name: owner.name, extension: owner.extension };
  return {
    on: true,
    canCall: allowed,
    // Follow-up: the general customer GET is unchanged and may still include the number; the UI hides it when this is false.
    phoneVisible: allowed,
    notesWritable: !support, // design: support notes stay conservatively read-only
    eligibility: elig,
    otherOwner: other,
    own: allowed && !support,
    support,
  };
}

/** Redact next-customer identity on a files-carousel (or similar) payload while the hold gate is closed. */
export function vthRedactCarousel(u: U, view: any, now = new Date()): any {
  if (!view || !vthBlockNext(u, now)) return view;
  const open = vthOpenCall(u);
  const keepId = open?.file_id ?? view.currentFileId ?? null;
  const redactCard = (c: any) => {
    if (!c || c.id === keepId || c.state === "current") return c;
    return { ...c, customerName: "", phone: null, customerId: c.customerId, _vthHeld: true };
  };
  return {
    ...view,
    vthHold: true,
    lateReturns: Array.isArray(view.lateReturns)
      ? view.lateReturns.map((r: any) => (r && r.file_id !== keepId ? { ...r, customer_name: "" } : r))
      : view.lateReturns,
    cards: Array.isArray(view.cards) ? view.cards.map(redactCard) : view.cards,
  };
}

/** CDR re-query only. Never sets an outcome, never completes a reminder, never advances a queue. */
export async function vthStatusRetry(u: U, callId: number, now = new Date()): Promise<{ status: number; body: any }> {
  if (!vthFlagOn(u.id)) return { status: 404, body: { error: "voip_task_hold_off", message: "این امکان برای شما فعال نیست.", enabled: false } };
  ensureVthSchema();
  const c = queryRow<CallLite>("SELECT * FROM voip_click_calls WHERE id=? AND user_id=?", [callId, u.id]);
  if (!c) return { status: 404, body: { error: "not_found", message: "این تماس پیدا نشد." } };
  if (c.active) return { status: 409, body: { error: "still_active", message: "تماس هنوز در جریان است." } };
  let ok = 0;
  try {
    const { vcScheduleFastSync, FAST_SETTLE_MS } = await import("./voip-call");
    vcScheduleFastSync(c.id, now.getTime());
    const { syncAfterCalls } = await import("./voip-after-call");
    await syncAfterCalls();
    const { vcMe } = await import("./voip-call");
    vcMe(u as any, now); // runs vcLink / sweep
    const after = queryRow<CallLite>("SELECT * FROM voip_click_calls WHERE id=?", [c.id]);
    ok = after && vthFinalStatus(after) ? 1 : 0;
    void FAST_SETTLE_MS;
  } catch { ok = 0; }
  executeChanges("UPDATE voip_task_holds SET last_retry_at=?, last_retry_ok=? WHERE call_id=?", [iso(now), ok, callId]);
  const after = queryRow<CallLite>("SELECT * FROM voip_click_calls WHERE id=?", [c.id]);
  const phase = vthPhaseOf(after ?? null, holdOf(callId));
  return { status: 200, body: { ok: true, phase, final: phase === "final", retried: true } };
}

/** Skip s132 automatic follow-up / daily-plan close (queue must not move until an explicit save). */
export function vthSuppressAutoSave(userId: number): boolean {
  return vthFlagOn(userId);
}


const VTH_OUTCOMES = ["answered", "no_answer", "follow_up"] as const;
const NOTE_MAX = 80;

/** Explicit result save. Never called by hang-up or cancel.
 *  After validation, a successful save completes the current task through the existing UI path:
 *  reminder → rvResult, carousel → fcExpertFollowup, lead → dpAfterFirstCallForm (only when a call log exists).
 *  File / search only save the VoIP result and release the hold. Those existing functions are called first so a
 *  409/422 does not leave a half-saved hold. */
export function vthSaveResult(u: U, callId: number, body: any, now = new Date()): { status: number; body: any } {
  if (!vthFlagOn(u.id)) return { status: 404, body: { error: "voip_task_hold_off", message: "این امکان برای شما فعال نیست.", enabled: false } };
  const outcome = String(body?.outcome ?? "");
  if (!(VTH_OUTCOMES as readonly string[]).includes(outcome)) return { status: 422, body: { error: "outcome_required", message: "نتیجه‌ی تماس را انتخاب کن.", allowed: VTH_OUTCOMES } };
  const note = typeof body?.note === "string" ? body.note.replace(/\s+/g, " ").trim() : "";
  if (!note) return { status: 422, body: { error: "note_required", message: "یادداشت یک‌خطی را بنویس." } };
  if ([...note].length > NOTE_MAX) return { status: 422, body: { error: "note_too_long", message: `یادداشت حداکثر ${NOTE_MAX.toLocaleString("fa-IR")} نویسه باشد.` } };
  const c = queryRow<CallLite>("SELECT * FROM voip_click_calls WHERE id=? AND user_id=?", [callId, u.id]);
  if (!c) return { status: 404, body: { error: "not_found", message: "این تماس پیدا نشد." } };
  if (c.active) return { status: 409, body: { error: "still_active", message: "تماس هنوز در جریان است." } };
  if (c.result_saved_at) return { status: 200, body: { ok: true, replayed: true, stay: !vthQueue(holdOf(c.id)?.entry), phase: "saved" } };
  if (!vthFinalStatus(c)) return { status: 409, body: { error: "pending_status", message: "وضعیت نهایی تماس هنوز نرسیده است." } };
  const hold = holdOf(c.id);
  const done = vthCompleteExisting(u, hold, c, outcome, note, now);
  if (done && done.status >= 400) return done;
  const at = iso(now);
  if (!queryRow<{ result_saved_at: string | null }>("SELECT result_saved_at FROM voip_click_calls WHERE id=?", [c.id])?.result_saved_at) {
    executeChanges("UPDATE voip_click_calls SET result_saved_at=COALESCE(result_saved_at,?), result_outcome=? WHERE id=?", [at, outcome, c.id]);
    vthRelease(c.id, now);
  }
  try {
    const logId = vthCallLogId(c);
    if (logId != null) executeChanges("UPDATE call_logs SET expert_notes=CASE WHEN COALESCE(expert_notes,'')='' THEN ? ELSE expert_notes END, one_line_note=COALESCE(NULLIF(one_line_note,''),?) WHERE id=?", [note, note, logId]);
  } catch { /* call log is best-effort */ }
  return { status: 200, body: { ok: true, stay: !vthQueue(hold?.entry), phase: "saved", entry: hold?.entry ?? null, reminderId: hold?.reminder_id ?? null } };
}
