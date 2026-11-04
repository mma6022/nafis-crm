/**
 * CT-FASTNOTE (Mohammad, options A+B): faster automatic transcription + summary appended to the call note.
 * Behind flag.ct_fastnote (global) or flag.ct_fastnote.user.<id> = '1'. OFF by default; OFF → every hook here is a no-op
 * and every payload stays as before. Needs flag.call_transcripts.auto (the automatic pipeline) to be ON as well.
 *  - A: queue the transcript 12 s after hang-up (instead of CT_START_DELAY_SECONDS); a missing recording is retried after
 *       5 s, 15 s, 30 s and 2 min, then the job fails with CT_MISSING_FINAL (no further retries).
 *  - B: non-first calls → the summary is appended to the call's note (filled when empty, else added below, once);
 *       first call → the first-call form is unchanged; after it is saved the summary is appended below the expert's note, once.
 *  - summaryStatus: 'pending' | 'ready' | 'failed' per call for the «خلاصه در حال آماده شدن / آماده شد» indicator.
 * No SMS, no notifications, no click-to-call / dialer changes.
 */
import { crmDb, executeChanges, queryRow, queryRows } from "./crm-db";

export const CTF_START_DELAY_SECONDS = 12;
export const CTF_BACKOFF_SECONDS = [5, 15, 30, 120];
export const CTF_NOTE_PREFIX = "خلاصه‌ی تماس: ";
const CTF_GIVE_UP_MIN = 45;
const NO_RECORDING_FAIL_MIN = 10;

const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
export function ctfOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting("flag.ct_fastnote") === "1" || setting(`flag.ct_fastnote.user.${Number(userId)}`) === "1";
}
export function ctfAny(): boolean {
  try { return setting("flag.ct_fastnote") === "1" || !!queryRow("SELECT 1 x FROM call_queue_settings WHERE key LIKE 'flag.ct_fastnote.user.%' AND value='1' LIMIT 1"); } catch { return false; }
}
export function ctfUserIds(): number[] {
  try {
    if (setting("flag.ct_fastnote") === "1") return queryRows<{ id: number }>("SELECT id FROM users WHERE active=1").map((r) => Number(r.id));
    return queryRows<{ key: string }>("SELECT key FROM call_queue_settings WHERE key LIKE 'flag.ct_fastnote.user.%' AND value='1'")
      .map((r) => Number(r.key.slice("flag.ct_fastnote.user.".length))).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}
/** Expert of the recording (after-call event keyed by provider id or external id). */
export function ctfExpertOf(externalId: string): number | null {
  try { return queryRow<{ u: number | null }>("SELECT expert_user_id u FROM voip_after_call_events WHERE COALESCE(recording_provider_id,external_id)=? ORDER BY id LIMIT 1", [externalId])?.u ?? null; } catch { return null; }
}
/** Fast retry schedule (attempts = attempts already failed before this one). */
export function ctfRetry(attempts: number, finalMessage: string): { retry: true; nextAt: string } | { retry: false; message: string } {
  const done = attempts + 1;
  if (done > CTF_BACKOFF_SECONDS.length) return { retry: false, message: finalMessage };
  return { retry: true, nextAt: new Date(Date.now() + CTF_BACKOFF_SECONDS[done - 1] * 1000).toISOString() };
}

/** Append `note` to table.col of row id: fill when empty, else add below; never twice (exact text already present → no-op). */
export function ctfAppend(table: "call_logs" | "fc_followups" | "voip_after_call_events", col: "expert_notes" | "note", id: number, note: string): number {
  const add = `${CTF_NOTE_PREFIX}${note}`;
  return executeChanges(`UPDATE ${table} SET ${col}=CASE WHEN TRIM(COALESCE(${col},''))='' THEN ? ELSE ${col}||char(10)||char(10)||? END
    WHERE id=? AND instr(COALESCE(${col},''),?)=0`, [add, add, id, add]);
}

let ensured = false;
export function ensureCtfSchema() {
  if (ensured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS ct_fastnote_appends(call_id INTEGER PRIMARY KEY, call_log_id INTEGER, state TEXT NOT NULL, created_at TEXT NOT NULL)`);
  ensured = true;
}

type Sum = { summaryState: string; callSubject?: unknown; customerRequestSummary?: unknown } | null;
export function ctfNoteText(sum: Sum, max = 500): string | null {
  if (!sum || sum.summaryState !== "completed" || typeof sum.customerRequestSummary !== "string" || !sum.customerRequestSummary.trim()) return null;
  const subj = typeof sum.callSubject === "string" ? sum.callSubject.trim() : "";
  return (subj ? `${subj}: ${sum.customerRequestSummary}` : sum.customerRequestSummary).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Per-call summary status for the UI indicator (null → not applicable: not answered / no event). */
export function ctfSummaryStatus(eventId: number | null | undefined, storedCallSummary: (id: string) => Sum, now = new Date()): "pending" | "ready" | "failed" | null {
  if (eventId == null) return null;
  try {
    const e = queryRow<{ pid: string; status: string | null; has_recording: number; ended_at: string | null; started_at: string; is_live: number }>(
      "SELECT COALESCE(recording_provider_id,external_id) pid, status, has_recording, ended_at, started_at, is_live FROM voip_after_call_events WHERE id=?", [eventId]);
    if (!e) return null;
    if (e.is_live) return "pending";
    if (String(e.status ?? "").toUpperCase() !== "ANSWERED") return null;
    const t = queryRow<{ state: string }>("SELECT state FROM voip_recording_transcripts WHERE external_id=?", [e.pid]);
    if (t?.state === "failed") return "failed";
    if (t?.state === "completed") {
      const s = storedCallSummary(e.pid)?.summaryState;
      return s === "completed" ? "ready" : s === "failed" ? "failed" : "pending";
    }
    if (t) return "pending";
    const age = now.getTime() - Date.parse(e.ended_at || e.started_at);
    return !e.has_recording && age > NO_RECORDING_FAIL_MIN * 60000 ? "failed" : age > 24 * 3600000 ? "failed" : "pending";
  } catch { return null; }
}

/** First call (s132, CRM button): once the first-call form is saved, append the summary below the expert's note (once). */
export function ctfFirstCallTick(now: Date, storedCallSummary: (id: string) => Sum, userId: number | null = null) {
  if (!ctfAny()) return;
  try { if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='s132_calls'")) return; } catch { return; }
  ensureCtfSchema();
  const rows = queryRows<{ call_id: number; user_id: number; customer_id: number; auto_at: string; event_id: number | null }>(
    `SELECT s.call_id, s.user_id, s.customer_id, s.auto_at, k.event_id FROM s132_calls s JOIN voip_click_calls k ON k.id=s.call_id
     WHERE s.first_call=1 AND s.auto_kind='first_done' AND julianday(s.created_at)>=julianday(?)-1${userId == null ? "" : " AND s.user_id=?"}
       AND NOT EXISTS (SELECT 1 FROM ct_fastnote_appends a WHERE a.call_id=s.call_id) ORDER BY s.call_id LIMIT 50`,
    userId == null ? [now.toISOString()] : [now.toISOString(), userId]);
  for (const r of rows) {
    if (!ctfOn(r.user_id)) continue;
    try {
      const pid = r.event_id != null ? queryRow<{ pid: string }>("SELECT COALESCE(recording_provider_id,external_id) pid FROM voip_after_call_events WHERE id=?", [r.event_id])?.pid : null;
      const sum = pid ? storedCallSummary(pid) : null;
      const note = ctfNoteText(sum);
      const st = ctfSummaryStatus(r.event_id, storedCallSummary, now);
      const old = now.getTime() - Date.parse(r.auto_at) > CTF_GIVE_UP_MIN * 60000;
      if (note) {
        const log = queryRow<{ id: number }>(`SELECT id FROM call_logs WHERE customer_id=? AND call_result IS NOT NULL AND julianday(created_at)>=julianday(?) ORDER BY id LIMIT 1`, [r.customer_id, r.auto_at]);
        if (!log) continue;
        crmDb.exec("SAVEPOINT ctf");
        try {
          if (executeChanges("INSERT OR IGNORE INTO ct_fastnote_appends(call_id,call_log_id,state,created_at) VALUES(?,?,'appended',?)", [r.call_id, log.id, now.toISOString()]) === 1)
            ctfAppend("call_logs", "expert_notes", log.id, note);
          crmDb.exec("RELEASE ctf");
        } catch (e) { crmDb.exec("ROLLBACK TO ctf"); crmDb.exec("RELEASE ctf"); throw e; }
      } else if (st === "failed" || old) {
        executeChanges("INSERT OR IGNORE INTO ct_fastnote_appends(call_id,call_log_id,state,created_at) VALUES(?,NULL,'none',?)", [r.call_id, now.toISOString()]);
      }
    } catch { /* next tick */ }
  }
}
