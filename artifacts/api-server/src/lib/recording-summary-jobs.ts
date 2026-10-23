import { createHash } from "node:crypto";
import { crmDb, queryRow, executeChanges } from "./crm-db";
import { getAuthUserById } from "./auth";
import { authorizedVoipRecording } from "../routes/simotel-recordings";
import { CallSummaryError, summarizeCall } from "./recording-call-summary";
import { SimotelError } from "./simotel";
import { latestSummaryEdit } from "./recording-summary-edits";

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
  const text = row?.result_json ? JSON.parse(row.result_json).text : null;
  return row && row.state === "completed" && typeof text === "string" && text.trim()
    ? { ...row, text, hash: digest(row.source_file, text) } : null;
}
export function callSummaryDTO(id: string, file: string, text: string | null) {
  const job = text ? getJob(id) : undefined;
  const hash = text ? digest(file, text) : null, edit = latestSummaryEdit(id);
  const edited = !!edit && edit.source_hash === hash;
  const current = !!job && job.source_hash === hash;
  return { summaryState: edited ? "completed" as const : current ? job!.state : "not_started" as const,
    summaryError: edited ? null : current ? job!.error : null, callSubject: null, customerRequestSummary: null,
    ...(current && job!.state === "completed" && job!.result_json ? JSON.parse(job!.result_json) : {}),
    ...(edited ? { callSubject: edit!.subject, customerRequestSummary: edit!.customer_request } : {}),
    summaryRevision: edit?.revision ?? 0, summarySourceHash: hash, summaryEdited: edited,
    summaryEditStale: !!edit && !edited };
}
export function storedCallSummary(id: string) {
  if (!queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='voip_recording_transcripts'")) return null;
  const source = transcript(id);
  return source ? callSummaryDTO(id, source.source_file, source.text) : null;
}
export function queueCallSummary(id: string, userId: number, from: string, to: string, retry = false) {
  const source = transcript(id);
  if (!source) return;
  if (latestSummaryEdit(id)?.source_hash === source.hash) return;
  const previous = getJob(id);
  if (previous?.source_hash === source.hash && (previous.state !== "failed" || !retry)) return;
  const full = (queryRow<{ n: number }>("SELECT COUNT(*) n FROM voip_recording_summaries WHERE state IN ('queued','processing')")?.n ?? 0) >= 20;
  const now = new Date().toISOString();
  executeChanges(`INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET source_hash=excluded.source_hash,
    requested_by=excluded.requested_by,range_from=excluded.range_from,range_to=excluded.range_to,state=excluded.state,
    error=excluded.error,result_json=NULL,lease_until=NULL,updated_at=excluded.updated_at`,
    [id, source.hash, userId, from, to, full ? "failed" : "queued", full ? "صف تهیهٔ خلاصه پر است؛ کمی بعد دوباره تلاش کنید." : null, now, now]);
}
let busy = false;
export async function processCallSummaryQueue() {
  if (busy) return;
  executeChanges("UPDATE voip_recording_summaries SET state='failed',error=?,lease_until=NULL WHERE state='processing' AND lease_until<?",
    ["تهیهٔ خلاصهٔ قبلی قطع شد؛ دوباره تلاش کنید.", new Date().toISOString()]);
  const job = queryRow<SummaryJob>("SELECT * FROM voip_recording_summaries WHERE state='queued' ORDER BY created_at LIMIT 1");
  if (!job) return;
  busy = true;
  try {
    if (!executeChanges("UPDATE voip_recording_summaries SET state='processing',lease_until=?,updated_at=? WHERE external_id=? AND source_hash=? AND state='queued'",
      [new Date(Date.now() + 180000).toISOString(), new Date().toISOString(), job.external_id, job.source_hash])) return;
    const actor = getAuthUserById(job.requested_by);
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
  } catch (error) {
    executeChanges("UPDATE voip_recording_summaries SET state='failed',error=?,lease_until=NULL,updated_at=? WHERE external_id=? AND source_hash=? AND state='processing'",
      [error instanceof CallSummaryError || error instanceof SimotelError ? error.message : "تهیهٔ خلاصه ناموفق بود؛ دوباره تلاش کنید.",
        new Date().toISOString(), job.external_id, job.source_hash]);
  } finally { busy = false; }
}