import { crmDb, queryRow, executeChanges, runTransaction } from "./crm-db";

crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_recording_summary_edits(
  external_id TEXT NOT NULL, revision INTEGER NOT NULL, source_hash TEXT NOT NULL,
  subject TEXT NOT NULL, customer_request TEXT NOT NULL, edited_by INTEGER NOT NULL, edited_at TEXT NOT NULL,
  PRIMARY KEY(external_id,revision)
)`);
export type SummaryEdit = { revision: number; source_hash: string; subject: string; customer_request: string };
export const latestSummaryEdit = (id: string) => queryRow<SummaryEdit>(
  "SELECT * FROM voip_recording_summary_edits WHERE external_id=? ORDER BY revision DESC LIMIT 1", [id]);
export class SummaryEditConflict extends Error {}
export function appendSummaryEdit(id: string, hash: string, actorId: number, revision: number, subject: string, request: string) {
  runTransaction(() => {
    if ((latestSummaryEdit(id)?.revision ?? 0) !== revision) throw new SummaryEditConflict("موضوع یا خلاصه توسط کاربر دیگری تغییر کرده است؛ متن ویرایش شما حفظ شده، ابتدا نسخهٔ تازه را بررسی کنید.");
    executeChanges("INSERT INTO voip_recording_summary_edits(external_id,revision,source_hash,subject,customer_request,edited_by,edited_at) VALUES(?,?,?,?,?,?,?)",
      [id, revision + 1, hash, subject.trim(), request.trim(), actorId, new Date().toISOString()]);
  });
}