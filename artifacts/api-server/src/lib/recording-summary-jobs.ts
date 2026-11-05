import { csAnyOn } from "./call-summary-fields-core";
import { csAfterSummary } from "./call-summary-fields";
import { createHash } from "node:crypto";
import { crmDb, queryRow, executeChanges } from "./crm-db";
import { getAuthUserById } from "./auth";
import { authorizedVoipRecording } from "../routes/simotel-recordings";
import { CallSummaryError, summarizeCall } from "./recording-call-summary";
import { SimotelError } from "./simotel";
import { latestSummaryEdit } from "./recording-summary-edits";
import { ctFlag, manualSummaryText, roleLabelledVariants, systemActor, SYSTEM_REQUESTER } from "./call-transcripts";
import { ensureRestartRetrySchema, recoverInterruptedSummaries, restartRetryOn } from "./stt-restart-retry";

type SummaryJob = { external_id: string; source_hash: string; requested_by: number; range_from: string; range_to: string;
  state: "queued" | "processing" | "completed" | "failed"; error: string | null; result_json: string | null };
type Transcript = { source_file: string; state: string; result_json: string | null };
crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_recording_summaries(
  external_id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, requested_by INTEGER NOT NULL,
  range_from TEXT NOT NULL, range_to TEXT NOT NULL, state TEXT NOT NULL, error TEXT, result_json TEXT,
  lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`);
const digest = (file: string, text: string) => createHash("sha256").update(JSON.stringify([file, text])).digest("hex");
const getJob = (id: string) => queryRow<SummaryJob>("SELECT * FROM voip_recording_summaries WHERE external_id=?", [id]);
function transcript(id: string) {
  const row = queryRow<Transcript>("SELECT source_file,state,result_json FROM voip_recording_transcripts WHERE external_id=?", [id]);
  const plain = row?.result_json ? JSON.parse(row.result_json).text : null;
  const text = typeof plain === "string" && plain.trim() ? summaryText(id, plain) : plain;
  return row && row.state === "completed" && typeof text === "string" && text.trim()
    ? { ...row, text, plain: plain as string, hash: digest(row.source_file, text) } : null;
}
/** CT-KEEP (Mohammad t859u «ویرایش دستی حفظ بشه و خلاصه دوباره ساخته نشه»): «hand-edited» = the call has a row in
 *  voip_recording_summary_edits (every manual save appends one, with edited_by/edited_at; rows exist since summary editing shipped,
 *  so older edits count too — no new column). Such an edit survives a manager role swap: it stays valid when its source_hash is the
 *  hash of the same transcript under any speaker roles (plain text or either role-labelled dialogue). Only a new transcript text
 *  (re-transcription that changed the words) still marks it stale, exactly as before. */
function sameTranscriptHashes(id: string, file: string, plain: string | null): Set<string> {
  const out = new Set<string>();
  if (plain && plain.trim()) out.add(digest(file, plain));
  for (const v of roleLabelledVariants(id)) out.add(digest(file, v));
  return out;
}
const editKept = (edit: { source_hash: string } | undefined, hash: string | null, id: string, file: string, plain: string | null) =>
  !!edit && !!hash && (edit.source_hash === hash || sameTranscriptHashes(id, file, plain).has(edit.source_hash));
/** CT-CHAT: role-labelled dialogue when a manager set the roles (see manualSummaryText), else the plain transcript text. */
const summaryText = (id: string, plain: string) => manualSummaryText(id) ?? plain;
export function callSummaryDTO(id: string, file: string, plainText: string | null) {
  const text = plainText && plainText.trim() ? summaryText(id, plainText) : plainText;
  const job = text ? getJob(id) : undefined;
  const hash = text ? digest(file, text) : null, edit = latestSummaryEdit(id);
  const edited = editKept(edit, hash, id, file, plainText);
  const keptOnSwap = edited && edit!.source_hash !== hash; // made under other speaker roles, kept untouched (CT-KEEP)
  const current = !!job && job.source_hash === hash;
  return { summaryState: edited ? "completed" as const : current ? job!.state : "not_started" as const,
    summaryError: edited ? null : current ? job!.error : null, callSubject: null, customerRequestSummary: null,
    ...(current && job!.state === "completed" && job!.result_json ? JSON.parse(job!.result_json) : {}),
    ...(edited ? { callSubject: edit!.subject, customerRequestSummary: edit!.customer_request } : {}),
    summaryRevision: edit?.revision ?? 0, summarySourceHash: hash, summaryEdited: edited,
    summaryEditStale: !!edit && !edited, ...(keptOnSwap ? { summaryKeptOnSwap: true } : {}) };
}
export function storedCallSummary(id: string) {
  if (!queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='voip_recording_transcripts'")) return null;
  const source = transcript(id);
  return source ? callSummaryDTO(id, source.source_file, source.plain) : null; // plain: the DTO applies the role labelling itself (same text/hash)
}
export function queueCallSummary(id: string, userId: number, from: string, to: string, retry = false) {
  const source = transcript(id);
  if (!source) return;
  if (editKept(latestSummaryEdit(id), source.hash, id, source.source_file, source.plain)) return; // hand-edited → never regenerated (CT-KEEP)
  const previous = getJob(id);
  if (previous?.source_hash === source.hash && (previous.state !== "failed" || !retry)) return;
  const full = (queryRow<{ n: number }>("SELECT COUNT(*) n FROM voip_recording_summaries WHERE state IN ('queued','processing')")?.n ?? 0) >= 20;
  const now = new Date().toISOString();
  executeChanges(`INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET source_hash=excluded.source_hash,
    requested_by=excluded.requested_by,range_from=excluded.range_from,range_to=excluded.range_to,state=excluded.state,
    error=excluded.error,result_json=NULL,lease_until=NULL,updated_at=excluded.updated_at`,
    [id, source.hash, userId, from, to, full ? "failed" : "queued", full ? "صف تهیهٔ خلاصه پر است؛ کمی بعد دوباره تلاش کنید." : null, now, now]);
  if (restartRetryOn()) { ensureRestartRetrySchema(); executeChanges("UPDATE voip_recording_summaries SET interrupt_retries=0,retry_at=NULL WHERE external_id=?", [id]); }
}
let busy = false;
export async function processCallSummaryQueue() {
  if (busy) return;
  recoverInterruptedSummaries(); // STT-RETRY: orphaned by a restart → re-queued (max 2, backoff), else failed as before
  const job = restartRetryOn()
    ? queryRow<SummaryJob>("SELECT * FROM voip_recording_summaries WHERE state='queued' AND (retry_at IS NULL OR retry_at<=?) ORDER BY created_at LIMIT 1", [new Date().toISOString()])
    : queryRow<SummaryJob>("SELECT * FROM voip_recording_summaries WHERE state='queued' ORDER BY created_at LIMIT 1");
  if (!job) return;
  busy = true;
  try {
    if (!executeChanges("UPDATE voip_recording_summaries SET state='processing',lease_until=?,updated_at=? WHERE external_id=? AND source_hash=? AND state='queued'",
      [new Date(Date.now() + 180000).toISOString(), new Date().toISOString(), job.external_id, job.source_hash])) return;
    const actor = job.requested_by === SYSTEM_REQUESTER && ctFlag("auto") ? systemActor(job.external_id) : getAuthUserById(job.requested_by);
    if (!actor?.active || (actor.role !== "admin" && (!actor.permissions.includes("calls.view") || !actor.permissions.includes("calls.create")))) {
      throw new CallSummaryError("دسترسی درخواست‌کنندهٔ خلاصه تغییر کرده است.");
    }
    const { row } = await authorizedVoipRecording(job.external_id, { from: job.range_from, to: job.range_to }, actor);
    const source = transcript(job.external_id);
    if (!source || source.hash !== job.source_hash || source.source_file !== row.record) throw new CallSummaryError("متن مکالمه تغییر کرده است؛ خلاصهٔ تازه‌ای درخواست کنید.");
    const result = await summarizeCall(source.text);
    if (transcript(job.external_id)?.hash !== job.source_hash) throw new CallSummaryError("متن مکالمه در حین تهیهٔ خلاصه تغییر کرد؛ خلاصهٔ تازه‌ای درخواست کنید.");
    executeChanges("UPDATE voip_recording_summaries SET state='completed',error=NULL,result_json=?,lease_until=NULL,updated_at=? WHERE external_id=? AND source_hash=? AND state='processing'",
      [JSON.stringify(result), new Date().toISOString(), job.external_id, job.source_hash]);
    // «موارد اجباری» v1.2: extract the 7 items from the same transcript (flag OFF → no call, no table). Never fails the summary.
    if (csAnyOn()) { try { await csAfterSummary(job.external_id, job.source_hash); } catch { /* summary stays completed; csAfterSummary logs */ } }
  } catch (error) {
    executeChanges("UPDATE voip_recording_summaries SET state='failed',error=?,lease_until=NULL,updated_at=? WHERE external_id=? AND source_hash=? AND state='processing'",
      [error instanceof CallSummaryError || error instanceof SimotelError ? error.message : "تهیهٔ خلاصه ناموفق بود؛ دوباره تلاش کنید.",
        new Date().toISOString(), job.external_id, job.source_hash]);
  } finally { busy = false; }
}/** CT-CHAT: after a «مدیر فروش» role swap, regenerate the summary through the normal queue (one row per call → never a duplicate job;
 *  a summary already being made for the old roles is superseded: its result is dropped by the source_hash guard). Never notifies anyone.
 *  Uses the range the transcript was made with. Returns false (and the role save stays saved) when nothing could be queued. */
export function queueSummaryAfterRoleSwap(providerId: string, actorId: number): boolean | "kept_edit" {
  try {
    const t = queryRow<{ range_from: string; range_to: string }>("SELECT range_from,range_to FROM voip_recording_transcripts WHERE external_id=? AND state='completed'", [providerId]);
    if (!t) return false;
    // CT-KEEP (Mohammad t859u): a hand-edited summary is kept untouched — nothing is queued (roles stay saved, transcript re-renders).
    const source = transcript(providerId);
    if (source && editKept(latestSummaryEdit(providerId), source.hash, providerId, source.source_file, source.plain)) return "kept_edit";
    queueCallSummary(providerId, actorId, t.range_from, t.range_to, true);
    return true;
  } catch { return false; }
}
