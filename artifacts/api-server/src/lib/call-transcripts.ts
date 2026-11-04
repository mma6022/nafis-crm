/**
 * Call transcripts v1.1 (Simotel part 3): auto-transcription hardening, speaker roles, call view / call-center report,
 * manager review, Ahmad read-only feed. Everything is behind flags in call_queue_settings, all OFF by default:
 *   flag.call_transcripts.auto  : delayed start after hangup + retry/backoff on missing recording + system requester
 *   flag.call_transcripts.ui    : call page + «گزارش مرکز تماس» + review card
 *   flag.call_transcripts.ahmad : GET /api/assistant-runner/manager/call-transcripts
 *   call_transcripts.stereo_expert_channel : left | right | by_direction (unset → role from text heuristic)
 *   flag.call_transcripts.chat (+ .user.<id>) : chat-style call view (Armita «متن تماس به شکل چت» v1.0) + manager speaker-role swap.
 *     OFF → payloads are byte-identical to before (no chat/canAssignRoles/fullText keys) and the old view renders.
 * Schema additions are additive and only applied once a flag is ON (ensureCallTranscriptSchema).
 */
import type { AuthUser } from "./auth";
import { crmDb, queryRow, queryRows, executeChanges, runImmediateTransaction } from "./crm-db";
import { SimotelError } from "./simotel";
import { callReportDay } from "./call-reports";
import { CALL_LIST_START } from "./call-list-cutoff";
import { isExcludedCallPhone } from "./call-display-exclusions";
import { ctfExpertOf, ctfOn, ctfRetry } from "./ct-fastnote";

export const SYSTEM_REQUESTER = 0;
/** Simotel publishes the CDR row + recording a little after hangup; queue no earlier than this. */
export const CT_START_DELAY_SECONDS = 150;
/** Backoff before attempt n+1 (minutes). 6 attempts in total (~62 min), then failed. */
export const CT_BACKOFF_MINUTES = [2, 4, 8, 16, 32];
export const CT_MAX_ATTEMPTS = CT_BACKOFF_MINUTES.length + 1;
export const CT_MISSING_FINAL = "فایل ضبط پس از چند بار تلاش در مرکز تماس پیدا نشد.";
const RETRYABLE = new Set(["recording_missing", "unavailable", "provider_failure", "report_changed", "incomplete_report", "report_failure"]);
export const MANAGER_EXCLUDED = [29];

export type CtFlag = "auto" | "ui" | "ahmad";
const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
export const ctFlag = (name: CtFlag) => setting(`flag.call_transcripts.${name}`) === "1";
export const stereoExpertChannel = () => { const v = setting("call_transcripts.stereo_expert_channel"); return v === "left" || v === "right" || v === "by_direction" ? v : null; };

let ensured = false;
export function ensureCallTranscriptSchema() {
  if (ensured) return;
  const cols = new Set(queryRows<{ name: string }>("PRAGMA table_info(voip_recording_transcripts)").map(c => c.name));
  if (!cols.size) return; // transcript worker creates the table at startup
  if (!cols.has("attempts")) crmDb.exec("ALTER TABLE voip_recording_transcripts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("next_attempt_at")) crmDb.exec("ALTER TABLE voip_recording_transcripts ADD COLUMN next_attempt_at TEXT");
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_call_reviews(event_id INTEGER PRIMARY KEY, flagged INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '', updated_by INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
  ensured = true;
}
export const ctSchemaReady = () => { if (!ensured && (ctFlag("auto") || ctFlag("ui") || ctFlag("ahmad"))) ensureCallTranscriptSchema(); return ensured; };

/** Synthetic requester for automatic / backfill jobs. Only valid for recordings that belong to a stored after-call event. */
export function systemActor(externalId: string): AuthUser | null {
  if (!queryRow("SELECT 1 FROM voip_after_call_events WHERE COALESCE(recording_provider_id,external_id)=? AND has_recording=1", [externalId])) return null;
  return { id: SYSTEM_REQUESTER, username: "system", fullName: "سامانه", mobile: null, telegramId: null, priorityColors: {}, role: "admin",
    roleName: "system", permissions: ["calls.view", "calls.create"], customerScope: "all", salespersonId: null, salespersonName: null,
    active: true, createdAt: "1970-01-01T00:00:00.000Z" };
}
/** Retry decision for a failed transcript job (auto flag ON). null → fail now. */
export function retryPlan(error: unknown, attempts: number, externalId?: string): { retry: true; nextAt: string } | { retry: false; message: string } | null {
  if (!(error instanceof SimotelError) || !RETRYABLE.has(error.code)) return null;
  if (externalId && ctfOn(ctfExpertOf(externalId))) return ctfRetry(attempts, CT_MISSING_FINAL); // CT-FASTNOTE: 5 s, 15 s, 30 s, 2 min, then failed
  const done = attempts + 1;
  if (done >= CT_MAX_ATTEMPTS) return { retry: false, message: CT_MISSING_FINAL };
  return { retry: true, nextAt: new Date(Date.now() + CT_BACKOFF_MINUTES[done - 1] * 60000).toISOString() };
}

/* ---------------- speaker roles ---------------- */
type Seg = { speakerId: string; startSeconds: number; endSeconds: number; text: string };
type Result = { audioSeparation?: string; speakers?: { id: string; label: string }[]; segments?: Seg[]; speakerChannels?: Record<string, number>; text?: string };
export type Role = "expert" | "customer";
const EXPERT_CUES = [/نفیس/, /کارشناس/, /در\s*خدمت/, /از\s*(طرف|شرکت|مجموعه)/, /تماس\s*می[‌\s]?گیرم/, /پرونده[‌\s]?(تون|ی\s*شما|شما)/, /مدارک(تون|\s*شما)/, /قسط(ها)?ی?\s*(تون|شما)/];
export function speakerRoles(result: Result, direction: string): { roles: Record<string, Role>; source: "channel" | "text" | null } {
  const speakers = (result.speakers ?? []).map(s => s.id);
  const ch = stereoExpertChannel();
  if (result.audioSeparation === "stereo_channels" && result.speakerChannels && ch) {
    const expertChannel = ch === "left" ? 0 : ch === "right" ? 1 : direction === "incoming" ? 1 : 0;
    const roles: Record<string, Role> = {};
    for (const id of speakers) { const c = result.speakerChannels[id]; if (c === 0 || c === 1) roles[id] = c === expertChannel ? "expert" : "customer"; }
    if (Object.keys(roles).length) return { roles, source: "channel" };
  }
  if (speakers.length === 2) {
    const score = (id: string) => (result.segments ?? []).filter(s => s.speakerId === id).reduce((n, s) => n + EXPERT_CUES.filter(r => r.test(s.text)).length, 0);
    const [a, b] = speakers, sa = score(a), sb = score(b);
    const pick = sa > 0 && sb === 0 ? a : sb > 0 && sa === 0 ? b : sa >= 3 * Math.max(sb, 1) ? a : sb >= 3 * Math.max(sa, 1) ? b : null;
    if (pick) return { roles: { [a]: pick === a ? "expert" : "customer", [b]: pick === b ? "expert" : "customer" }, source: "text" };
  }
  return { roles: {}, source: null };
}

/* ---------------- access ---------------- */
/** Manager features (call-center report, review «بررسی مدیر فروش (احمد)», retranscribe): «مدیر فروش» only since 2026-11-03.
 *  Plain admins keep reading every call (ctAdminViewer) but no longer get the sales-manager views. */
export const isCtManager = (u: AuthUser) => u.active && u.role === "admin" && u.salesManager === true && !MANAGER_EXCLUDED.includes(u.id);
/** Report viewer: every active admin (plain admin and «مدیر فروش»), not user 29. Mohammad t742s2933: «گزارش‌ها و متن تماس‌ها برای ادمین هم بمونه».
 *  Plain admin reads the /call-center report and every transcript, but gets no review («بررسی مدیر فروش (احمد)»), no flags and no retranscribe. */
export const ctAdminViewer = (u: AuthUser) => u.active && u.role === "admin" && !MANAGER_EXCLUDED.includes(u.id);
type Ev = { id: number; external_id: string; provider_id: string; phone: string; direction: string; status: string; started_at: string; ended_at: string;
  extension: string | null; expert_user_id: number | null; expert_name: string | null; customer_id: number | null; call_log_id: number | null;
  has_recording: number; recording_file: string | null; mobile_device_id: number | null; duration_seconds: number | null; customer_name: string | null;
  t_state: string | null; t_phase: string | null; t_error: string | null; t_result: string | null; t_file: string | null; t_completed: string | null;
  t_attempts: number | null; t_next: string | null; r_flagged: number | null; r_note: string | null; r_at: string | null; r_by: string | null };
const EV = `SELECT e.id,e.external_id,COALESCE(e.recording_provider_id,e.external_id) provider_id,e.phone,e.direction,e.status,e.started_at,e.ended_at,
  e.extension,e.expert_user_id,COALESCE(eu.full_name,e.expert_name) expert_name,COALESCE(l.customer_id,e.customer_id) customer_id,e.call_log_id,e.has_recording,
  e.recording_file,e.mobile_device_id,e.duration_seconds,c.name customer_name,
  t.state t_state,t.phase t_phase,t.error t_error,t.result_json t_result,t.source_file t_file,t.completed_at t_completed,t.attempts t_attempts,t.next_attempt_at t_next,
  r.flagged r_flagged,r.note r_note,r.updated_at r_at,ru.full_name r_by
  FROM voip_after_call_events e LEFT JOIN call_logs l ON l.id=e.call_log_id
  LEFT JOIN customers c ON c.id=COALESCE(l.customer_id,e.customer_id)
  LEFT JOIN users eu ON eu.id=e.expert_user_id
  LEFT JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)
  LEFT JOIN voip_call_reviews r ON r.event_id=e.id LEFT JOIN users ru ON ru.id=r.updated_by`;
const ownExtension = (u: AuthUser) => queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [u.id])?.extension ?? null;
function canSee(e: Ev, u: AuthUser) {
  if (Date.parse(e.started_at) < Date.parse(CALL_LIST_START)) return false;
  if (ctAdminViewer(u)) return true;
  if (!u.active || e.expert_user_id !== u.id) return false;
  return e.mobile_device_id != null || ownExtension(u) === e.extension;
}
export const ctEvent = (id: number) => queryRow<Ev>(`${EV} WHERE e.id=? AND e.is_live=0`, [id]);
export function visibleEvent(id: number, u: AuthUser) { const e = ctEvent(id); return e && canSee(e, u) ? e : null; }

/* ---------------- DTOs ---------------- */
export type TextState = "no_recording" | "waiting" | "queued" | "processing" | "completed" | "failed";
function textState(e: Ev): TextState {
  if (!e.has_recording || !e.recording_file) return "no_recording";
  if (!e.t_state || (e.t_file && e.t_file !== e.recording_file)) return e.t_state ? "failed" : "waiting";
  return e.t_state as TextState;
}
const durationOf = (e: Ev) => e.status !== "ANSWERED" ? null : e.duration_seconds ?? Math.max(0, Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000));
function summaryOf(e: Ev, summary: (id: string) => any) {
  if (textState(e) !== "completed") return null;
  const s = summary(e.provider_id);
  return s ? { state: s.summaryState as string, subject: s.callSubject as string | null, request: s.customerRequestSummary as string | null,
    edited: !!s.summaryEdited, revision: Number(s.summaryRevision ?? 0), sourceHash: s.summarySourceHash as string | null, error: s.summaryError as string | null } : null;
}
/* ---------------- CT-CHAT: manual speaker roles (flag.call_transcripts.chat) ---------------- */
/** Chat view on for this user: global flag or per-user flag. The ui flag (off() guard) still gates every route. */
export const ctChatOn = (u: AuthUser | null | undefined) => !!u && (setting("flag.call_transcripts.chat") === "1" || setting(`flag.call_transcripts.chat.user.${Number(u.id)}`) === "1");
/** Additive tables, created on the first manager write only (never at boot, never while the flag is off).
 *  voip_call_speaker_roles: one row per event, valid only for the transcript it was set on (transcript_at = t.completed_at),
 *  so a re-transcription silently falls back to the automatic guess. voip_call_speaker_role_log: append-only audit. */
let chatEnsured = false;
export function ensureCtChatSchema() {
  if (chatEnsured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_call_speaker_roles(event_id INTEGER PRIMARY KEY, transcript_at TEXT, roles_json TEXT NOT NULL,
    updated_by INTEGER NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS voip_call_speaker_role_log(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, transcript_at TEXT,
    before_json TEXT, before_source TEXT, after_json TEXT NOT NULL, actor_id INTEGER NOT NULL, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_voip_call_speaker_role_log_event ON voip_call_speaker_role_log(event_id, id);`);
  chatEnsured = true;
}
let chatTable = false;
const hasChatTable = () => chatTable || (chatTable = !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_call_speaker_roles'"));
type Manual = { roles: Record<string, Role>; by: string | null; at: string };
function manualRoles(e: Ev, speakerIds: string[]): Manual | null {
  if (!hasChatTable()) return null;
  const m = queryRow<{ transcript_at: string | null; roles_json: string; updated_at: string; by_name: string | null }>(
    "SELECT m.transcript_at,m.roles_json,m.updated_at,u.full_name by_name FROM voip_call_speaker_roles m LEFT JOIN users u ON u.id=m.updated_by WHERE m.event_id=?", [e.id]);
  if (!m || (m.transcript_at ?? null) !== (e.t_completed ?? null)) return null;
  try {
    const roles = JSON.parse(m.roles_json) as Record<string, Role>;
    const ok = speakerIds.length === 2 && speakerIds.every(id => roles[id] === "expert" || roles[id] === "customer") && new Set(speakerIds.map(id => roles[id])).size === 2;
    return ok ? { roles, by: m.by_name, at: m.updated_at } : null;
  } catch { return null; }
}
/** Effective roles for an event: a valid manual override wins ("for everyone": call page, Ahmad feed), else the automatic guess. */
function effectiveRoles(e: Ev, r: Result): { roles: Record<string, Role>; source: "channel" | "text" | "manual" | null; manual: Manual | null } {
  const manual = manualRoles(e, (r.speakers ?? []).map(s => s.id));
  if (manual) return { roles: manual.roles, source: "manual", manual };
  return { ...speakerRoles(r, e.direction), manual: null };
}
export type RoleSaveError = "not_completed" | "not_two_speakers" | "bad_speaker" | "stale_transcript";
/** Manager-only (checked by the route). Sets which of exactly two speakers is the expert; the other becomes the customer. Audited. */
export function saveSpeakerRoles(eventId: number, actor: AuthUser, expertSpeakerId: string, transcriptAt?: string | null): RoleSaveError | null {
  const e = ctEvent(eventId);
  if (!e || textState(e) !== "completed" || !e.t_result) return "not_completed";
  if (transcriptAt !== undefined && transcriptAt !== null && transcriptAt !== e.t_completed) return "stale_transcript";
  const r = JSON.parse(e.t_result) as Result;
  const ids = (r.speakers ?? []).map(s => s.id);
  if (ids.length !== 2) return "not_two_speakers";
  if (!ids.includes(expertSpeakerId)) return "bad_speaker";
  ensureCtChatSchema();
  const before = effectiveRoles(e, r);
  const roles: Record<string, Role> = Object.fromEntries(ids.map(id => [id, id === expertSpeakerId ? "expert" : "customer"]));
  const now = new Date().toISOString();
  runImmediateTransaction(() => {
    executeChanges(`INSERT INTO voip_call_speaker_roles(event_id,transcript_at,roles_json,updated_by,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET transcript_at=excluded.transcript_at,roles_json=excluded.roles_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      [e.id, e.t_completed, JSON.stringify(roles), actor.id, now]);
    executeChanges("INSERT INTO voip_call_speaker_role_log(event_id,transcript_at,before_json,before_source,after_json,actor_id,at) VALUES(?,?,?,?,?,?,?)",
      [e.id, e.t_completed, JSON.stringify(before.roles), before.source, JSON.stringify(roles), actor.id, now]);
  });
  chatTable = true;
  return null;
}

/** CT-CHAT summary input: when a valid manual role override exists for this recording (same transcript), the summary is made
 *  from the role-labelled dialogue («کارشناس: …» / «مشتری: …», no names), so a manager swap yields a different source hash and
 *  the existing summary pipeline regenerates it. Applies whether or not the chat flag is on (saved roles keep applying). */
export function manualSummaryText(providerId: string): string | null {
  try {
    if (!hasChatTable()) return null;
    const m = queryRow<{ transcript_at: string | null; roles_json: string; t_completed: string | null; t_result: string | null }>(
      `SELECT m.transcript_at,m.roles_json,t.completed_at t_completed,t.result_json t_result FROM voip_call_speaker_roles m
       CROSS JOIN voip_after_call_events e ON e.id=m.event_id JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)
       WHERE COALESCE(e.recording_provider_id,e.external_id)=? AND e.is_live=0 AND t.state='completed' ORDER BY m.updated_at DESC LIMIT 1`, [providerId]);
    if (!m || !m.t_result || (m.transcript_at ?? null) !== (m.t_completed ?? null)) return null;
    const r = JSON.parse(m.t_result) as Result, roles = JSON.parse(m.roles_json) as Record<string, Role>;
    const ids = (r.speakers ?? []).map(x => x.id);
    if (ids.length !== 2 || !ids.every(id => roles[id] === "expert" || roles[id] === "customer") || new Set(ids.map(id => roles[id])).size !== 2) return null;
    const lines = (r.segments ?? []).filter(x => typeof x.text === "string" && x.text.trim() && roles[x.speakerId])
      .map(x => `${roles[x.speakerId] === "expert" ? "کارشناس" : "مشتری"}: ${x.text.trim()}`);
    return lines.length ? lines.join("\n") : null;
  } catch { return null; }
}

export function transcriptView(e: Ev, opts: { maskNames?: boolean } = {}) {
  const st = textState(e);
  if (st !== "completed" || !e.t_result) return null;
  const r = JSON.parse(e.t_result) as Result & { notice?: string; durationSeconds?: number };
  const { roles, source, manual } = effectiveRoles(e, r);
  const label = (id: string, i: number) => roles[id] === "expert" ? (opts.maskNames || !e.expert_name ? "کارشناس" : `${e.expert_name} (کارشناس)`)
    : roles[id] === "customer" ? (opts.maskNames || !e.customer_name ? "مشتری" : `${e.customer_name} (مشتری)`) : `گوینده ${(i + 1).toLocaleString("fa-IR")}`;
  const ids = (r.speakers ?? []).map(s => s.id);
  return { audioSeparation: r.audioSeparation ?? null, roleSource: source, ...(manual ? { roleByName: opts.maskNames ? null : manual.by, roleAt: manual.at } : {}), durationSeconds: r.durationSeconds ?? null,
    speakers: ids.map((id, i) => ({ id, role: roles[id] ?? null, label: label(id, i) })),
    segments: (r.segments ?? []).map(s => ({ speakerId: s.speakerId, role: roles[s.speakerId] ?? null, label: label(s.speakerId, ids.indexOf(s.speakerId)), start: s.startSeconds, end: s.endSeconds, text: s.text })) };
}
export function rowView(e: Ev, summary: (id: string) => any) {
  const st = textState(e), s = summaryOf(e, summary);
  return { eventId: e.id, callLogId: e.call_log_id, customerId: e.customer_id, customerName: e.customer_name, phone: e.phone,
    direction: e.direction, status: e.status, startedAt: e.started_at, endedAt: e.ended_at, durationSeconds: durationOf(e),
    expertUserId: e.expert_user_id, expertName: e.expert_name, hasRecording: !!(e.has_recording && e.recording_file),
    textState: st, textPhase: st === "processing" ? e.t_phase : null, textError: st === "failed" ? (e.t_error ?? "تبدیل ناموفق بود.") : null,
    attempts: e.t_attempts ?? 0, nextAttemptAt: st === "queued" ? e.t_next : null,
    summary: s, flagged: !!e.r_flagged };
}
export function callView(e: Ev, u: AuthUser, summary: (id: string) => any) {
  const manager = isCtManager(u), own = e.expert_user_id === u.id;
  const st = textState(e);
  return { ...rowView(e, summary), ...(manager || own ? {} : { flagged: false }), isManager: manager, isViewer: ctAdminViewer(u), canEdit: own && st === "completed", canRetranscribe: manager && (st === "failed" || st === "completed") && !!e.recording_file,
    recording: e.has_recording && e.recording_file ? { externalId: e.provider_id, from: callReportDay(e.started_at), to: callReportDay(e.ended_at) } : null,
    transcript: transcriptView(e),
    review: manager || own ? { flagged: !!e.r_flagged, note: e.r_note ?? "", updatedAt: e.r_at, updatedByName: e.r_by } : null,
    ...(ctChatOn(u) ? chatExtras(e, manager, st) : {}) };
}
/** CT-CHAT additions to the call payload (only when the chat flag is on for the viewer). */
function chatExtras(e: Ev, manager: boolean, st: TextState) {
  let fullText: string | null = null, speakers = 0;
  if (st === "completed" && e.t_result) { try { const r = JSON.parse(e.t_result) as Result; fullText = typeof r.text === "string" ? r.text : null; speakers = (r.speakers ?? []).length; } catch { /* ignore */ } }
  return { chat: true, canAssignRoles: manager && st === "completed" && speakers === 2, fullText, transcriptAt: st === "completed" ? e.t_completed : null, simCall: e.mobile_device_id != null };
}

/* ---------------- report ---------------- */
const TEHRAN = "+03:30";
const tehranDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00${TEHRAN}`)) ? d : null;
export function tehranRange(fromQ: unknown, toQ: unknown, maxDays: number): { from: string; to: string; fromIso: string; toIso: string } | null {
  const today = callReportDay(new Date().toISOString());
  const from = fromQ == null || fromQ === "" ? today : tehranDay(String(fromQ)), to = toQ == null || toQ === "" ? (from ?? today) : tehranDay(String(toQ));
  if (!from || !to || from > to) return null;
  const fromMs = Date.parse(`${from}T00:00:00${TEHRAN}`), toMs = Date.parse(`${to}T00:00:00${TEHRAN}`) + 86400000;
  if ((toMs - fromMs) / 86400000 > maxDays) return null;
  return { from, to, fromIso: new Date(Math.max(fromMs, Date.parse(CALL_LIST_START))).toISOString(), toIso: new Date(toMs).toISOString() };
}
export type ReportFilter = { from: string; to: string; fromIso: string; toIso: string; expertUserIds?: number[] | null; callStatus?: string; textStatus?: string; flagged?: boolean; page?: number; pageSize?: number; excludeCustomerIds?: Set<number> };
export function reportRows(f: ReportFilter) {
  const where = ["e.is_live=0", "julianday(e.started_at)>=julianday(?)", "julianday(e.started_at)<julianday(?)"]; const p: any[] = [f.fromIso, f.toIso];
  if (f.expertUserIds) { if (!f.expertUserIds.length) where.push("0"); else { where.push(`e.expert_user_id IN (${f.expertUserIds.map(() => "?").join(",")})`); p.push(...f.expertUserIds); } }
  if (f.callStatus === "answered") where.push("e.status='ANSWERED'"); else if (f.callStatus === "missed") where.push("e.status<>'ANSWERED'");
  if (f.flagged) where.push("r.flagged=1");
  let rows = queryRows<Ev>(`${EV} WHERE ${where.join(" AND ")} ORDER BY e.started_at DESC, e.id DESC LIMIT 2000`, p)
    .filter(e => !isExcludedCallPhone(e.phone) && !(e.customer_id != null && f.excludeCustomerIds?.has(e.customer_id)));
  const ts = f.textStatus;
  if (ts && ts !== "all") rows = rows.filter(e => { const s = textState(e);
    return ts === "pending" ? s === "waiting" || s === "queued" || s === "processing" : ts === "pending_or_failed" ? ["waiting", "queued", "processing", "failed"].includes(s) : s === ts; });
  const size = Math.min(100, Math.max(1, f.pageSize ?? 30)), page = Math.max(1, f.page ?? 1);
  return { total: rows.length, page, pageSize: size, rows: rows.slice((page - 1) * size, page * size) };
}
export function saveReview(eventId: number, actor: AuthUser, flagged: boolean, note: string) {
  const now = new Date().toISOString();
  executeChanges(`INSERT INTO voip_call_reviews(event_id,flagged,note,updated_by,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET flagged=excluded.flagged,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [eventId, flagged ? 1 : 0, note, actor.id, now]);
}
/** Masks a phone for outside readers: last 4 digits only. */
export const lastFour = (p: string | null) => { const d = String(p ?? "").replace(/\D/g, ""); return d.length >= 4 ? `•••••••${d.slice(-4)}` : "••••"; };
