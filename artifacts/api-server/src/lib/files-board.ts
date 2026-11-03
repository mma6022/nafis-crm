/**
 * FILES-BOARD (stage 3 of Armita today-split-files-board v1.0.4 §3/§5): «پرونده‌های من» as a 7-column status board with ONE turn for the whole board.
 * Behind the PER-USER flag call_queue_settings key `flag.files_board.user.<userId>` = '1' (absent / anything else = OFF; shipped OFF, never seeded).
 * Only users 8 / 2 / 3 and only while that user's flag.files_lock (and so flag.today_split) is on. Flag off → nothing here runs (stage-2 behaviour).
 * PM defaults: (1) only the single turn file in whole-board order is actionable, also after the list unlocks (t673 wins);
 * (2) closed files (completed / cancelled) are fully read-only; (5) reads are never blocked, only writes (423);
 * (6) «followed up today» = a result in fc_followups OR a logged call with that customer today (call_logs); without a final result
 * (cancel or a stage move) the file leaves the order until the next Tehran day («پیگیری شد، فردا»). Spec §5: a file returned mid-day
 * takes the turn at its rank at once (recomputed on every request; nothing is stored). Nothing here writes except the existing deck refresh (fcDeck), the same one /today and the stage-2 guard run.
 */
import { queryRow, queryRows } from "./crm-db";
import { tParts, fromTehran } from "./call-queue";
import { flOn } from "./files-lock";
import { catCore, dayRow, ensureFcSchema, fcDeck, fcListOrder, fcToday, fcFullPhone, FILE_SELECT, fileById, lastFollowUp, type FileRow } from "./files-carousel";

export const FB_FLAG_PREFIX = "flag.files_board.user.";
export const FB_CLOSED_DAYS = 30;
export function fbOn(userId: number | null | undefined): boolean {
  if (!userId || !flOn(Number(userId))) return false;
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [`${FB_FLAG_PREFIX}${Number(userId)}`])?.value === "1"; }
  catch { return false; }
}
type U = { id: number; role: string; salespersonId: number | null };
type Row = FileRow & { phone: string | null };
export type FbFollow = { at: string; source: "result" | "call" };
const dayStartIso = (now: Date) => { const p = tParts(now); return fromTehran(p.y, p.m, p.d, 0, 0).toISOString(); };

/** The whole board state for one expert (own files: open + closed in the last 30 days), in the shared REL-83 order. */
export function fbState(sp: number, now = new Date()) {
  ensureFcSchema(); const day = fcToday(now); const since = dayStartIso(now);
  // Same order source as the «امروز» deck: once today's deck exists, refresh it first (it appends after-unlock tasks / returns), like fcFilesLocked.
  if (dayRow(sp, day)?.started_at) fcDeck(sp, day, now);
  const rows = queryRows<Row>(`${FILE_SELECT.replace("SELECT a.id,", "SELECT cc.phone, a.id,")} WHERE a.deleted_at IS NULL AND cc.salesperson_id=?`, [sp]);
  const { order, cats } = fcListOrder(sp, rows.map(r => r.id), now);
  const byId = new Map(rows.map(r => [r.id, r]));
  // (6) today's follow-ups: an fc_followups result or a call_logs row with the same (current) customer.
  const fu = new Map<number, FbFollow>();
  for (const r of queryRows<{ file_id: number; created_at: string }>("SELECT file_id, MAX(created_at) created_at FROM fc_followups WHERE salesperson_id=? AND day=? GROUP BY file_id", [sp, day]))
    fu.set(Number(r.file_id), { at: r.created_at, source: "result" });
  const custFiles = new Map<number, number[]>();
  for (const r of rows) { const k = Number(r.cur_customer_id); if (!custFiles.has(k)) custFiles.set(k, []); custFiles.get(k)!.push(r.id); }
  const custIds = [...custFiles.keys()];
  if (custIds.length) {
    const ph = custIds.map(() => "?").join(",");
    for (const r of queryRows<{ customer_id: number; at: string }>(`SELECT customer_id, MAX(created_at) at FROM call_logs WHERE customer_id IN (${ph}) AND created_at>=? GROUP BY customer_id`, [...custIds, since]))
      for (const fid of custFiles.get(Number(r.customer_id)) ?? []) { const prev = fu.get(fid); if (!prev || r.at > prev.at) fu.set(fid, { at: r.at, source: "call" }); }
  }
  // Spec §5: a final result (a stage move after the follow-up) or a return after it puts the file back in today's order at its rank.
  const moved = new Map<number, string>();
  const fuIds = [...fu.keys()];
  if (fuIds.length) {
    const ph = fuIds.map(() => "?").join(",");
    for (const r of queryRows<{ application_id: number; at: string }>(`SELECT application_id, MAX(created_at) at FROM loan_application_stage_history WHERE application_id IN (${ph}) AND created_at>=? AND COALESCE(from_stage,'')<>to_stage GROUP BY application_id`, [...fuIds, since]))
      moved.set(Number(r.application_id), r.at);
  }
  const followed = (id: number): FbFollow | null => {
    const f = fu.get(id); if (!f) return null;
    const c = cats.get(id); const m = moved.get(id);
    if (m && m > f.at) return null;
    if (c?.priority_category === "returned" && c.returned_at && c.returned_at > f.at) return null;
    return f;
  };
  const cutoff = new Date(now.getTime() - FB_CLOSED_DAYS * 86_400_000).toISOString();
  const isClosed = (id: number) => (cats.get(id)?.priority_group ?? 0) > 5;
  const onBoard = order.filter(id => !isClosed(id) || (cats.get(id)?.closed_at ?? "") >= cutoff);
  const queue = order.filter(id => !isClosed(id) && !followed(id));
  const turn = queue[0] ?? null;
  return { day, order, onBoard, queue, turn, cats, byId, followed, isClosed };
}
export type FbState = ReturnType<typeof fbState>;

/** GET /files-carousel/board (fbOn only). No full number on cards in the UI; `phone` is for the card sheet (own files, UNMASK-EXPERT t674u). */
export function fbBoard(u: U, now = new Date()) {
  const sp = Number(u.salespersonId); const s = fbState(sp, now);
  const rank = new Map(s.queue.map((id, i) => [id, i + 1]));
  const t = s.turn != null ? s.byId.get(s.turn) ?? null : null;
  const cards = s.onBoard.map(id => {
    const r = s.byId.get(id)!; const c = s.cats.get(id)!; const closed = s.isClosed(id); const fu = s.followed(id);
    return { fileId: id, customerId: Number(r.cur_customer_id), customerName: r.name ?? "", phone: fcFullPhone(r.phone), stage: r.stage, status: r.status,
      createdAt: r.created_at, state: closed ? "closed" : id === s.turn ? "turn" : fu ? "later" : "locked", rank: rank.get(id) ?? null,
      followedToday: fu, lastFollowUp: lastFollowUp(r), closedAt: closed ? c.closed_at : null, fc: catCore(c) };
  });
  return { on: true as const, date: s.day, closedDays: FB_CLOSED_DAYS, turn: t ? { fileId: t.id, customerId: Number(t.cur_customer_id), customerName: t.name ?? "", stage: t.stage, status: t.status } : null,
    total: cards.length, cards };
}

/** Write guard decision with the flag on: own closed file → board_closed; own open file that is not the turn → board_turn.
 *  A file created today stays writable (the always-open «ثبت پرونده جدید» wizard, same as stage 2). null = allowed. */
export function fbWriteBlock(u: U, fileId: number, now = new Date()): { error: "board_closed" | "board_turn"; message: string; details: any } | null {
  if (!fbOn(Number(u.id))) return null;
  const sp = Number(u.salespersonId);
  const f = fileById(fileId); if (!f || Number(f.owner) !== sp) return null;
  if (!f.open) return { error: "board_closed", message: "پرونده‌ی بسته فقط‌خواندنی است؛ ویرایش یا اقدامی ندارد.", details: { fileId } };
  if (f.created_at && fcToday(new Date(f.created_at)) === fcToday(now)) return null;
  const s = fbState(sp, now);
  if (s.turn === fileId) return null;
  const t = s.turn != null ? s.byId.get(s.turn) : null;
  return { error: "board_turn", message: t ? `به ترتیب باز می‌شود؛ اول پرونده‌ی ${t.name ?? ""} را باز کن.` : "امروز همه‌ی پرونده‌ها پیگیری شده‌اند؛ فردا به ترتیب باز می‌شوند.",
    details: { fileId, turnFileId: s.turn } };
}
