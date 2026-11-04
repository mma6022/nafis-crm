/**
 * STT-RETRY: a service restart (release manager) kills the in-flight transcription / summary job. The next process used to
 * mark such a job 'failed' («پردازش قبلی قطع شده است…») once its lease expired, so the call never got its summary.
 * Now a job found 'processing' with an expired lease (= its worker died; genuine provider errors are caught in-process and
 * never reach this state) is re-queued up to RESTART_RETRY_MAX times with backoff, then failed with the old message.
 * Idempotent: re-running a completed transcript re-uses the same summary hash (queueCallSummary no-op) and the CT-FASTNOTE
 * append is guarded (ct_fastnote_appends + instr check). No SMS, no notifications.
 * Kill switch: call_queue_settings flag.stt_restart_retry = '0' → old behaviour (fail immediately). Default ON.
 */
import { crmDb, executeChanges, queryRow, queryRows } from "./crm-db";

export const RESTART_RETRY_MAX = 2;
export const RESTART_BACKOFF_SECONDS = [10, 60];
export const TRANSCRIPT_INTERRUPTED = "پردازش قبلی قطع شده است؛ برای تلاش دوباره دکمهٔ تبدیل را بزنید.";
export const SUMMARY_INTERRUPTED = "تهیهٔ خلاصهٔ قبلی قطع شد؛ دوباره تلاش کنید.";

export function restartRetryOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key='flag.stt_restart_retry'")?.value !== "0"; } catch { return true; }
}
const cols = (t: string) => new Set(queryRows<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name));
let ensured = false;
export function ensureRestartRetrySchema() {
  if (ensured) return;
  const t = cols("voip_recording_transcripts");
  if (t.size) {
    if (!t.has("attempts")) crmDb.exec("ALTER TABLE voip_recording_transcripts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!t.has("next_attempt_at")) crmDb.exec("ALTER TABLE voip_recording_transcripts ADD COLUMN next_attempt_at TEXT");
    if (!t.has("interrupt_retries")) crmDb.exec("ALTER TABLE voip_recording_transcripts ADD COLUMN interrupt_retries INTEGER NOT NULL DEFAULT 0");
  }
  const s = cols("voip_recording_summaries");
  if (s.size) {
    if (!s.has("interrupt_retries")) crmDb.exec("ALTER TABLE voip_recording_summaries ADD COLUMN interrupt_retries INTEGER NOT NULL DEFAULT 0");
    if (!s.has("retry_at")) crmDb.exec("ALTER TABLE voip_recording_summaries ADD COLUMN retry_at TEXT");
  }
  ensured = t.size > 0 && s.size > 0;
}
const backoff = (n: number, now: Date) => new Date(now.getTime() + RESTART_BACKOFF_SECONDS[Math.min(n, RESTART_BACKOFF_SECONDS.length - 1)] * 1000).toISOString();

/** Sweep for orphaned 'processing' transcript jobs. Returns {requeued, failed}. */
export function recoverInterruptedTranscripts(now = new Date()) {
  const iso = now.toISOString();
  if (!restartRetryOn()) {
    const failed = executeChanges(`UPDATE voip_recording_transcripts SET state='failed',phase=NULL,error=?,lease_until=NULL,updated_at=?
      WHERE state='processing' AND lease_until<?`, [TRANSCRIPT_INTERRUPTED, iso, iso]);
    return { requeued: 0, failed };
  }
  ensureRestartRetrySchema();
  let requeued = 0;
  for (const r of queryRows<{ external_id: string; interrupt_retries: number }>(
    "SELECT external_id, interrupt_retries FROM voip_recording_transcripts WHERE state='processing' AND lease_until<? AND interrupt_retries<?", [iso, RESTART_RETRY_MAX])) {
    requeued += executeChanges(`UPDATE voip_recording_transcripts SET state='queued',phase=NULL,error=NULL,lease_until=NULL,
      interrupt_retries=interrupt_retries+1,next_attempt_at=?,updated_at=? WHERE external_id=? AND state='processing' AND lease_until<?`,
      [backoff(Number(r.interrupt_retries), now), iso, r.external_id, iso]);
  }
  const failed = executeChanges(`UPDATE voip_recording_transcripts SET state='failed',phase=NULL,error=?,lease_until=NULL,updated_at=?
    WHERE state='processing' AND lease_until<?`, [TRANSCRIPT_INTERRUPTED, iso, iso]);
  return { requeued, failed };
}

/** Same for summary jobs. */
export function recoverInterruptedSummaries(now = new Date()) {
  const iso = now.toISOString();
  if (!restartRetryOn()) {
    const failed = executeChanges("UPDATE voip_recording_summaries SET state='failed',error=?,lease_until=NULL WHERE state='processing' AND lease_until<?", [SUMMARY_INTERRUPTED, iso]);
    return { requeued: 0, failed };
  }
  ensureRestartRetrySchema();
  let requeued = 0;
  for (const r of queryRows<{ external_id: string; interrupt_retries: number }>(
    "SELECT external_id, interrupt_retries FROM voip_recording_summaries WHERE state='processing' AND lease_until<? AND interrupt_retries<?", [iso, RESTART_RETRY_MAX])) {
    requeued += executeChanges(`UPDATE voip_recording_summaries SET state='queued',error=NULL,lease_until=NULL,interrupt_retries=interrupt_retries+1,
      retry_at=?,updated_at=? WHERE external_id=? AND state='processing' AND lease_until<?`, [backoff(Number(r.interrupt_retries), now), iso, r.external_id, iso]);
  }
  const failed = executeChanges("UPDATE voip_recording_summaries SET state='failed',error=?,lease_until=NULL WHERE state='processing' AND lease_until<?", [SUMMARY_INTERRUPTED, iso]);
  return { requeued, failed };
}
