/**
 * SIMOTEL-456 — design simotel v1.2 parts 4–6 (scenes 27–37, spec §7; Mohammad t735s2898). Flags in ./voip-incoming-flags (all OFF by default).
 *  4. «تماس ورودی» popup: live incoming rows (markLive) on the user's own extension. Number rules are server-side:
 *     own customer → full number · unknown → number · another expert's customer → name, #id, expert only (+ transfer info) ·
 *     support (Tajik) → «پشتیبانی», expert «فقط برای اطلاع», number only if she registered the customer. Never for the admin role.
 *  5. «تماس‌های بی‌پاسخ امروز»: derived from stored voip_after_call_events (incoming, today Tehran), one row per number, cleared by the first
 *     connected call with that number. «تماس دوباره» = vcStart (same one-call / needs_result locks), never a task or a turn change.
 *  6. «گزارش کارشناسان»: per-expert numbers from final call events + live state (voip_extension_state, fed by NewState while flag.voip_report = 1).
 * Simotel API v4 has no call-transfer endpoint (only call/originate/act): «انتقال تماس به کارشناسش» records the request and tells the expert
 * which extension to transfer to on the VoIP phone; it is closed with a reason while the owner is ringing / in a call / paused / unavailable.
 */
import type { AuthUser } from "./auth";
import { executeChanges, queryRow, queryRows } from "./crm-db";
import { customerMatcher, normalizePhone } from "./voip-after-call";
import { vcOn, vcStart, vcStartUnknown, vcTableExists } from "./voip-call";
import { elCustomerAccess, elLocked, elNewCreate, elOwnCustomer } from "./expert-lockdown";
import { dayRow, fcDeck, fcEnabledFor, fcToday, FC_STAGE_LABELS } from "./files-carousel";
import { isCtManager, MANAGER_EXCLUDED } from "./call-transcripts";
import { notifyCallReport } from "./voip-call-notifications";
import { ensureViExtState, ensureViMarks, viExtension, viFlag, viIncomingFor, viIsSupport, viReportOn, viSince } from "./voip-incoming-flags";

type U = AuthUser;
type R = { status: number; body: any };
const err = (status: number, error: string, message: string, details?: object): R => ({ status, body: { error, message, ...(details ? { details } : {}) } });
const ok = (body: any): R => ({ status: 200, body });
const iso = (d: Date) => d.toISOString();
const TEHRAN_MS = 3.5 * 3600_000;
/** Tehran midnight (UTC ISO) of `now`'s Tehran day. Iran has no DST. */
export function tehranDayStart(now = new Date()): string {
  const t = new Date(now.getTime() + TEHRAN_MS); t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - TEHRAN_MS).toISOString();
}
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/* ---------------- shared lookups ---------------- */
let matcherCache: { at: number; fn: (p: string) => { id: number } | null } | null = null;
function matchCustomer(phone: string): number | null {
  const now = Date.now();
  if (!matcherCache || now - matcherCache.at > 20_000) matcherCache = { at: now, fn: customerMatcher() };
  return matcherCache.fn(phone)?.id ?? null;
}
export const viResetCache = () => { matcherCache = null; };
type Cust = { id: number; name: string | null; phone: string | null; salesperson_id: number | null; registered_by: number | null };
const custById = (id: number) => queryRow<Cust>("SELECT id,name,phone,salesperson_id,registered_by FROM customers WHERE id=?", [id]) ?? null;
type Owner = { userId: number | null; name: string };
function ownerOf(c: Cust): Owner | null {
  if (c.salesperson_id == null) return null;
  const u = queryRow<{ id: number; name: string }>(`SELECT id, COALESCE(NULLIF(TRIM(full_name),''),username) name FROM users WHERE salesperson_id=? AND active=1 ORDER BY role='salesperson' DESC, id LIMIT 1`, [c.salesperson_id]);
  if (u) return { userId: Number(u.id), name: u.name };
  const s = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [c.salesperson_id]);
  return { userId: null, name: s?.name ?? "کارشناس" };
}
const isOwn = (u: U, c: Cust) => u.role !== "registrar" && u.salespersonId != null && Number(u.salespersonId) === Number(c.salesperson_id);
function fileOf(customerId: number): { id: number; label: string } | null {
  const f = queryRow<{ id: number; stage: string }>(`SELECT id,stage FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL AND status<>'rejected' AND stage<>'completed' ORDER BY id DESC LIMIT 1`, [customerId]);
  return f ? { id: Number(f.id), label: FC_STAGE_LABELS[f.stage] ?? f.stage } : null;
}
function lastCallOf(customerId: number, exceptEventId: number): { at: string; text: string } | null {
  const l = queryRow<{ created_at: string; subject: string | null; outcome: string | null }>(
    "SELECT created_at,subject,outcome FROM call_logs WHERE customer_id=? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1", [customerId]);
  const e = queryRow<{ started_at: string; status: string; direction: string }>(
    "SELECT started_at,status,direction FROM voip_after_call_events WHERE customer_id=? AND id<>? AND is_live=0 ORDER BY julianday(started_at) DESC, id DESC LIMIT 1", [customerId, exceptEventId]);
  const le = l ? ms(l.created_at) : -Infinity, ee = e ? ms(e.started_at) : -Infinity;
  if (!l && !e) return null;
  if (l && le >= ee) return { at: l.created_at, text: (l.subject ?? "").trim() || (l.outcome === "answered" ? "پاسخ داد" : l.outcome === "no_answer" ? "پاسخ نداد" : "تماس ثبت شد") };
  return { at: e!.started_at, text: `${e!.direction === "incoming" ? "ورودی" : "خروجی"}، ${e!.status === "ANSWERED" ? "پاسخ داد" : "پاسخ نداد"}` };
}
const userName = (id: number) => queryRow<{ n: string }>("SELECT COALESCE(NULLIF(TRIM(full_name),''),username) n FROM users WHERE id=?", [id])?.n ?? "";

/* ---------------- live state (part 6, also used for transfer gating) ---------------- */
export type ExtState = "idle" | "ringing" | "inuse" | "pause" | "unavailable" | "unknown";
function extState(ext: string): { state: ExtState; since: string | null } {
  const live = queryRow<{ status: string; started_at: string }>("SELECT status,started_at FROM voip_after_call_events WHERE extension=? AND is_live=1 ORDER BY id DESC LIMIT 1", [ext]);
  let row: { state: string; since: string } | null = null;
  try { if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_extension_state'")) row = queryRow<{ state: string; since: string }>("SELECT state,since FROM voip_extension_state WHERE extension=?", [ext]) ?? null; } catch { row = null; }
  if (row && ["ringing", "inuse", "pause", "unavailable"].includes(row.state)) return { state: row.state as ExtState, since: row.since };
  if (live) return { state: live.status === "ACTIVE" ? "inuse" : "ringing", since: live.started_at };
  if (row) return { state: row.state as ExtState, since: row.since };
  return { state: "unknown", since: null };
}
const BUSY_REASON: Record<string, string> = { inuse: "کارشناسش الان در مکالمه است.", ringing: "تلفن کارشناسش الان زنگ می‌خورد.", pause: "کارشناسش در سیموتل «مکث» زده است.", unavailable: "تلفن ویپ کارشناسش در دسترس نیست." };
function transferInfo(owner: Owner | null): { extension: string | null; available: boolean; reason: string | null; ownerName: string } | null {
  if (!owner) return null;
  const ext = owner.userId != null ? viExtension(owner.userId) : null;
  if (!ext) return { extension: null, available: false, reason: "کارشناسش داخلی ویپ ندارد.", ownerName: owner.name };
  const st = extState(ext).state;
  return { extension: ext, available: !BUSY_REASON[st], reason: BUSY_REASON[st] ?? null, ownerName: owner.name };
}

/* ---------------- part 4: incoming popup ---------------- */
type Ev = { id: number; phone: string; direction: string; status: string; started_at: string; ended_at: string; is_live: number; live_cuid: string | null;
  external_id: string; extension: string | null; extensions_json: string | null; duration_seconds: number | null; has_recording: number; recording_file: string | null;
  recording_provider_id: string | null; expert_user_id: number | null; mobile_device_id: number | null };
const EV_COLS = "id,phone,direction,status,started_at,ended_at,is_live,live_cuid,external_id,extension,extensions_json,duration_seconds,has_recording,recording_file,recording_provider_id,expert_user_id,mobile_device_id";
const keyOf = (e: Pick<Ev, "live_cuid" | "external_id">) => e.live_cuid || e.external_id;
const marks = (eventId: number, userId: number) => { ensureViMarks(); return new Set(queryRows<{ action: string }>("SELECT action FROM voip_incoming_marks WHERE event_id=? AND user_id=?", [eventId, userId]).map(r => r.action)); };
const mark = (eventId: number, userId: number, action: string, now: Date) => { ensureViMarks();
  executeChanges("INSERT OR IGNORE INTO voip_incoming_marks(event_id,user_id,action,at) VALUES(?,?,?,?)", [eventId, userId, action, iso(now)]); };
export const VI_END_KEEP_S = 15 * 60;

export type ViKind = "own" | "unknown" | "hidden" | "other" | "support";
function popupView(u: U, e: Ev) {
  const support = viIsSupport(u);
  const phone = normalizePhone(e.phone);
  const cid = phone ? matchCustomer(phone) : null; const c = cid ? custById(cid) : null;
  const owner = c ? ownerOf(c) : null;
  let kind: ViKind; let showPhone = false;
  if (!phone) kind = "hidden";
  else if (support) { kind = c ? "support" : "unknown"; showPhone = !c || Number(c.registered_by) === Number(u.id); }
  else if (!c) { kind = "unknown"; showPhone = true; }
  else if (isOwn(u, c)) { kind = "own"; showPhone = true; }
  else { kind = "other"; }
  const ended = !e.is_live;
  const answered = e.status === "ANSWERED" || e.status === "ACTIVE";
  const dur = ended && answered ? (e.duration_seconds ?? Math.max(0, Math.round((ms(e.ended_at) - ms(e.started_at)) / 1000))) : null;
  return {
    eventId: e.id, state: ended ? "ended" : e.status === "ACTIVE" ? "talking" : "ringing", outcome: ended ? (answered ? "answered" : "missed") : null,
    startedAt: e.started_at, endedAt: ended ? e.ended_at : null, durationSeconds: dur,
    recording: e.has_recording || e.recording_file || e.recording_provider_id ? "ready" : ended && answered ? "processing" : "none",
    kind, support, extension: e.extension,
    customer: c && kind !== "hidden" ? { id: c.id, name: c.name ?? "" } : null,
    file: c && (kind === "own" || kind === "support") ? fileOf(c.id) : null,
    phone: showPhone ? phone : null,
    ownerName: kind === "other" || kind === "support" ? owner?.name ?? "بدون کارشناس" : null,
    lastCall: c && (kind === "own" || (kind === "support" && showPhone)) ? lastCallOf(c.id, e.id) : null,
    transfer: kind === "other" && !ended ? transferInfo(owner) : null,
    // own / unknown after an answered call: «ثبت تماس ورودی» or «بعداً» (§6 default 5: optional, no lock).
    canLog: ended && answered && (kind === "own" || kind === "unknown") && !!e.expert_user_id && Number(e.expert_user_id) === Number(u.id),
  };
}
export type ViPopup = ReturnType<typeof popupView>;
/** My incoming calls on my extension: live ones, plus answered own/unknown ones that ended in the last 15 minutes and were not closed. */
export function viMe(u: U, now = new Date()) {
  const ext = viExtension(u.id)!; const since = viSince(u.id) ?? iso(now); // calls from before the flag stay in the old queue
  const rows = queryRows<Ev>(`SELECT ${EV_COLS} FROM voip_after_call_events WHERE extension=? AND direction='incoming' AND mobile_device_id IS NULL
      AND julianday(started_at)>=julianday(?)-3.0/24 AND julianday(started_at)>=julianday(?) AND (is_live=1 OR julianday(ended_at)>=julianday(?)-?/86400.0) ORDER BY is_live DESC, id DESC LIMIT 10`,
    [ext, iso(now), since, iso(now), VI_END_KEEP_S]);
  const seen = new Set<string>(); const calls: ViPopup[] = [];
  for (const e of rows) {
    const k = keyOf(e); if (seen.has(k)) continue; seen.add(k);
    const m = marks(e.id, u.id);
    if (m.has("closed") || m.has("later") || m.has("log")) continue;
    const v = popupView(u, e);
    if (v.state === "ended" && !v.canLog) continue; // missed → part 5 list; other / support close on hang-up
    calls.push(v);
  }
  return { on: true, extension: ext, support: viIsSupport(u), calls: calls.slice(0, 3) };
}
/** True while a live incoming call rings or is connected on my extension (the task card's call button stays closed: «هر بار یک تماس»). */
export function viBusy(u: { id: number; role?: string | null }): boolean {
  if (!viIncomingFor(u)) return false;
  const ext = viExtension(u.id)!;
  return !!queryRow("SELECT 1 x FROM voip_after_call_events WHERE extension=? AND direction='incoming' AND is_live=1 AND julianday(started_at)>=julianday('now')-3.0/24 LIMIT 1", [ext]);
}
function myEvent(u: U, eventId: number): Ev | null {
  const ext = viExtension(u.id); if (!ext) return null;
  return queryRow<Ev>(`SELECT ${EV_COLS} FROM voip_after_call_events WHERE id=? AND extension=? AND direction='incoming'`, [eventId, ext]) ?? null;
}
export function viAct(u: U, eventId: number, action: "closed" | "later" | "log", now = new Date()): R {
  const e = myEvent(u, eventId); if (!e) return err(404, "not_found", "این تماس پیدا نشد.");
  if (action === "log") {
    const v = popupView(u, e);
    if (!v.canLog) return err(409, "cannot_log", "این تماس را از این‌جا نمی‌شود ثبت کرد.");
    mark(e.id, u.id, "log", now); notifyCallReport(u.id); // the after-call editor (AfterCallPopup) picks it up as «نتیجه تماس»
    return ok({ ok: true, eventId: e.id });
  }
  mark(e.id, u.id, action, now);
  return ok({ ok: true });
}
export function viTransfer(u: U, eventId: number, now = new Date()): R {
  const e = myEvent(u, eventId); if (!e) return err(404, "not_found", "این تماس پیدا نشد.");
  if (!e.is_live) return err(409, "ended", "این تماس تمام شده است.");
  const v = popupView(u, e);
  if (v.kind !== "other" || !v.transfer) return err(409, "not_other", "انتقال فقط برای مشتری کارشناس دیگر است.");
  if (!v.transfer.available || !v.transfer.extension) return err(409, "owner_busy", v.transfer.reason ?? "الان نمی‌شود منتقل کرد.", { transfer: v.transfer });
  mark(e.id, u.id, "transfer", now);
  return ok({ ok: true, mode: "phone", extension: v.transfer.extension, ownerName: v.transfer.ownerName,
    howTo: `روی تلفن ویپ دکمه‌ی «Transfer» (انتقال) را بزن، داخلی ${v.transfer.extension} را بگیر و انتقال را تأیید کن.` });
}

/* ---------------- part 5: missed calls ---------------- */
type Missed = { key: string; phone: string; firstAt: string; exts: string[]; firstExt: string | null; eventId: number };
/** Incoming calls in [fromIso, toIso) where nobody answered (all rows final, none ANSWERED/ACTIVE). */
function missedCalls(fromIso: string, toIso: string): Missed[] {
  const rows = queryRows<Ev>(`SELECT ${EV_COLS} FROM voip_after_call_events WHERE direction='incoming' AND mobile_device_id IS NULL
      AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?) ORDER BY julianday(started_at), id`, [fromIso, toIso]);
  const groups = new Map<string, Ev[]>();
  for (const e of rows) { const k = keyOf(e); (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
  let excluded = (_p: string) => false;
  try { const s = new Set(queryRows<{ phone: string }>("SELECT phone FROM voip_call_display_exclusions").map(r => r.phone)); excluded = (p) => s.has(p); } catch { /* table absent */ }
  const out: Missed[] = [];
  for (const [key, g] of groups) {
    if (g.some(e => e.is_live || e.status === "ANSWERED" || e.status === "ACTIVE")) continue;
    const phone = normalizePhone(g[0].phone); if (!phone || excluded(phone)) continue;
    const exts: string[] = [];
    for (const e of g) { for (const x of [e.extension, ...(() => { try { return JSON.parse(e.extensions_json ?? "[]") as string[]; } catch { return []; } })()]) if (x && !exts.includes(String(x))) exts.push(String(x)); }
    out.push({ key, phone, firstAt: g[0].started_at, exts, firstExt: g[0].extension ?? exts[0] ?? null, eventId: g[0].id });
  }
  return out;
}
const extUsers = () => new Map(queryRows<{ user_id: number; extension: string }>(
  "SELECT e.user_id,e.extension FROM voip_extensions e JOIN users u ON u.id=e.user_id WHERE e.extension IS NOT NULL AND u.active=1").map(r => [String(r.extension), Number(r.user_id)]));
/** Who a missed call belongs to: a customer's own expert (only they ever see that number); else the first extension that rang (§6 default 4). */
function assign(m: Missed, ext2user: Map<string, number>): { userId: number | null; customer: Cust | null; type: "mine" | "queue" } {
  const cid = matchCustomer(m.phone); const c = cid ? custById(cid) : null;
  const owner = c ? ownerOf(c) : null;
  const userId = owner?.userId ?? (m.firstExt ? ext2user.get(m.firstExt) ?? null : null);
  const myExt = userId != null ? [...ext2user].find(([, id]) => id === userId)?.[0] ?? null : null;
  return { userId, customer: c, type: m.exts.length === 1 && myExt != null && m.exts[0] === myExt ? "mine" : "queue" };
}
/** A missed number is cleared by the first connected call with it after the last miss (either direction, anyone, VoIP or click call). */
function clearedAfter(phone: string, afterIso: string): boolean {
  if (queryRow("SELECT 1 x FROM voip_after_call_events WHERE phone=? AND status IN ('ANSWERED','ACTIVE') AND julianday(started_at)>julianday(?) LIMIT 1", [phone, afterIso])) return true;
  try { if (vcTableExists() && queryRow("SELECT 1 x FROM voip_click_calls WHERE phone=? AND cust_answered_at IS NOT NULL AND julianday(created_at)>julianday(?) LIMIT 1", [phone, afterIso])) return true; } catch { /* absent */ }
  return false;
}
type MissedRow = { eventId: number; phone: string; count: number; firstAt: string; lastAt: string; type: "mine" | "queue"; customer: Cust | null };
function myMissedRows(u: U, now: Date): MissedRow[] {
  const ext2user = extUsers(); const by = new Map<string, MissedRow>();
  for (const m of missedCalls(tehranDayStart(now), iso(new Date(now.getTime() + 60_000)))) {
    const a = assign(m, ext2user); if (a.userId !== Number(u.id)) continue;
    const r = by.get(m.phone);
    if (!r) by.set(m.phone, { eventId: m.eventId, phone: m.phone, count: 1, firstAt: m.firstAt, lastAt: m.firstAt, type: a.type, customer: a.customer });
    else { r.count++; if (ms(m.firstAt) >= ms(r.lastAt)) { r.lastAt = m.firstAt; r.type = a.type; r.eventId = m.eventId; } }
  }
  return [...by.values()].filter(r => !clearedAfter(r.phone, r.lastAt)).sort((x, y) => ms(y.lastAt) - ms(x.lastAt));
}
function missedLock(u: U): { code: "needs_result" | "one_call" | "no_voip"; reason: string } | null {
  if (!vcOn(u)) return { code: "no_voip", reason: "«تماس از تلفن ویپ» برای تو فعال نیست؛ شماره را کپی کن." };
  if (viBusy(u)) return { code: "one_call", reason: "یک تماس ورودی روی تلفن ویپ تو در جریان است؛ هر بار یک تماس." };
  if (!vcTableExists()) return null;
  if (queryRow("SELECT 1 x FROM voip_click_calls WHERE user_id=? AND active=1", [u.id])) return { code: "one_call", reason: "یک تماس در جریان است؛ هر بار یک تماس." };
  if (queryRow(`SELECT 1 x FROM voip_click_calls WHERE user_id=? AND state='ended' AND outcome IS NOT NULL AND file_id IS NOT NULL AND result_saved_at IS NULL AND dismissed_at IS NULL LIMIT 1`, [u.id]))
    return { code: "needs_result", reason: "اول نتیجه‌ی تماس تسک جاری را ثبت کن؛ بعد «تماس دوباره» باز می‌شود." };
  return null;
}
function deckPositions(u: U, now: Date): Map<number, number> {
  const out = new Map<number, number>();
  try {
    if (!fcEnabledFor(u)) return out;
    const sp = Number(u.salespersonId), day = fcToday(now);
    if (!dayRow(sp, day)) return out; // the carousel has not started today → nothing is «در نوبت»; never start it from here
    const deck = fcDeck(sp, day, now);
    deck.cards.forEach((c: any, i: number) => { if (c.state !== "done" && !out.has(Number(c.f.cur_customer_id))) out.set(Number(c.f.cur_customer_id), i + 1); });
  } catch { /* carousel absent */ }
  return out;
}
function openCallbacks(): { id: number; phone: string | null; customer_id: number | null }[] {
  try { return queryRows("SELECT id,phone,customer_id FROM callback_requests WHERE status IN ('new','in_progress','no_answer') ORDER BY id DESC LIMIT 500"); } catch { return []; }
}
export function viMissed(u: U, now = new Date()) {
  const rows = myMissedRows(u, now); const lock = missedLock(u); const turn = deckPositions(u, now); const cbs = openCallbacks();
  const items = rows.map(r => {
    const c = r.customer; const own = c ? isOwn(u, c) : false;
    const cb = cbs.find(x => (c && Number(x.customer_id) === c.id) || (x.phone && normalizePhone(x.phone) === r.phone));
    const pos = c && own ? turn.get(c.id) ?? null : null;
    const action = pos != null ? "task" : cb ? "callback" : c && !own ? "none" : "redial";
    return { eventId: r.eventId, kind: c ? (own ? "own" : "unowned") : "unknown", customer: c ? { id: c.id, name: c.name ?? "" } : null,
      phone: r.phone, count: r.count, firstAt: r.firstAt, lastAt: r.lastAt, type: r.type,
      typeLabel: r.type === "mine" ? "روی تلفن ویپ تو جواب داده نشد" : "در صف، کسی جواب نداد",
      action, taskPos: pos, callbackId: cb ? Number(cb.id) : null,
      canRedial: action === "redial" && !lock, redialReason: action === "redial" && lock ? lock.reason : null,
      canNew: !c };
  });
  return { on: true, date: fcToday(now), count: items.length, lock: lock && lock.code !== "no_voip" ? lock : null, voip: vcOn(u), items };
}
export async function viRedial(u: U, eventId: number, now = new Date()): Promise<R> {
  const row = viMissed(u, now).items.find(i => i.eventId === eventId);
  if (!row) return err(404, "not_found", "این ردیف در «تماس‌های بی‌پاسخ امروز» تو نیست.");
  if (row.action === "task") return err(409, "in_turn", `این مشتری در نوبت بالفعل است؛ از «کارت تسک ${row.taskPos}» تماس بگیر.`);
  if (row.action === "callback") return err(409, "callback_open", "برای این شماره «درخواست تماس» باز است؛ از همان‌جا پیگیری کن.");
  if (row.action !== "redial") return err(403, "not_own_customer", "فقط با مشتری خودت می‌توانی تماس بگیری.");
  const lock = missedLock(u);
  if (lock) return err(lock.code === "no_voip" ? 404 : 409, lock.code, lock.reason);
  if (row.customer) {
    if (elLocked(u) && !elCustomerAccess(u, row.customer.id) && !elOwnCustomer(u, row.customer.id))
      return err(403, "expert_lockdown_customer", "این مشتری فعلاً برای شما باز نیست.");
    return await vcStart(u as any, { customerId: row.customer.id }, now) as R; // no fileId → outside the list: no turn, no new lock
  }
  return await vcStartUnknown(u as any, row.phone, now) as R;
}
/** «ثبت مشتری جدید» with the number taken server-side from my incoming call or my missed row (same path as «الان مشتری جدید دارم»: duplicate check first). */
export function viNewCustomer(u: U, body: any, now = new Date()): R {
  const id = Number(body?.eventId); const src = body?.source === "missed" ? "missed" : "incoming";
  if (!Number.isSafeInteger(id) || id <= 0) return err(400, "bad_event", "تماس معتبر نیست.");
  if (u.salespersonId == null) return err(422, "no_salesperson", "برای ساختن مشتری باید کارشناس فروش باشی.");
  let phone: string | null = null;
  if (src === "missed") { const r = viMissed(u, now).items.find(i => i.eventId === id); if (r && r.kind === "unknown") phone = r.phone; }
  else { const e = myEvent(u, id); if (e) { const v = popupView(u, e); if (v.kind === "unknown" && v.phone) phone = v.phone; } }
  if (!phone) return err(404, "not_found", "این شماره برای ثبت مشتری جدید پیدا نشد.");
  const r = elNewCreate(u as any, { phone, name: body?.name }, now);
  viResetCache();
  const status = r.result === "rate_limited" ? 429 : r.result === "invalid" ? 400 : r.result === "duplicate" ? 409 : 201;
  return { status, body: r };
}

/* ---------------- part 6: experts report ---------------- */
export const viReportAccess = (u: U) => isCtManager(u) || u.role === "sales_manager"; // TODO(rebase): follow /call-center's guard once sales_manager lands
type Person = { id: number; name: string; extension: string; role: string; roleName: string | null; support: boolean };
function people(): Person[] {
  return queryRows<{ id: number; name: string; extension: string; role: string; roleName: string | null }>(`SELECT u.id, COALESCE(NULLIF(TRIM(u.full_name),''),u.username) name, e.extension, u.role,
      (SELECT r.name FROM app_roles r WHERE r.slug=u.role) roleName FROM voip_extensions e JOIN users u ON u.id=e.user_id WHERE e.extension IS NOT NULL AND u.active=1`)
    // experts + support only: managers (admin / sales_manager) and user 29 are not on the board (design 36: three experts + خانم تاجیک)
    .filter(p => /^[0-9]{2,6}$/.test(String(p.extension)) && p.role !== "admin" && p.role !== "sales_manager" && !MANAGER_EXCLUDED.includes(Number(p.id)))
    .map(p => ({ ...p, id: Number(p.id), extension: String(p.extension), support: viIsSupport({ id: Number(p.id), role: p.role }) }))
    .sort((a, b) => a.name.localeCompare(b.name, "fa"));
}
export function viLive() {
  ensureViExtState();
  return people().map(p => { const s = extState(p.extension); return { userId: p.id, name: p.name, extension: p.extension, support: p.support,
    roleLabel: p.support ? "ثبت‌نام و پشتیبانی" : p.roleName ?? "", state: s.state, since: s.since }; });
}
export function viReport(fromIso: string, toIso: string) {
  const ps = people().filter(p => !p.support);
  const evs = queryRows<Ev>(`SELECT ${EV_COLS} FROM voip_after_call_events WHERE is_live=0 AND mobile_device_id IS NULL AND expert_user_id IS NOT NULL
      AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?)`, [fromIso, toIso]);
  const ext2user = extUsers(); const missedBy = new Map<number, number>();
  for (const m of missedCalls(fromIso, toIso)) { const a = assign(m, ext2user); if (a.userId != null) missedBy.set(a.userId, (missedBy.get(a.userId) ?? 0) + 1); }
  return ps.map(p => {
    const mine = new Map<string, Ev>(); // one call = one key per expert (a CDR row and its live row are the same call)
    for (const e of evs) if (Number(e.expert_user_id) === p.id) { const k = keyOf(e); const o = mine.get(k); if (!o || (e.status === "ANSWERED" && o.status !== "ANSWERED")) mine.set(k, e); }
    const list = [...mine.values()]; const ans = list.filter(e => e.status === "ANSWERED");
    const talk = ans.reduce((s, e) => s + (e.duration_seconds ?? Math.max(0, Math.round((ms(e.ended_at) - ms(e.started_at)) / 1000))), 0);
    return { userId: p.id, name: p.name, extension: p.extension, calls: list.length, incoming: list.filter(e => e.direction === "incoming").length,
      outgoing: list.filter(e => e.direction !== "incoming").length, answered: ans.length, answerRate: list.length ? Math.round((ans.length / list.length) * 100) : null,
      talkSeconds: talk, avgSeconds: ans.length ? Math.round(talk / ans.length) : null, missedIncoming: missedBy.get(p.id) ?? 0 };
  });
}
export { viFlag, viIncomingFor, viReportOn, userName };
