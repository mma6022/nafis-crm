/**
 * General ledger — package G2 (2026-10-26): POSTING LIBRARY ONLY.
 *
 * Pure library: no route, hook, timer or page calls it yet (G3/G4 wire it behind gl.shadow_* flags, all OFF).
 * Rules (ACCOUNTING-DEV-REVIEW §1-2, §4; spec v1.3 §0-1.3):
 *  - postVoucher never opens a transaction; it runs inside the caller's and throws gl_no_transaction otherwise.
 *  - amounts are INTEGER RIAL (number, safe-integer checked); every line is debit XOR credit; debits = credits (code + seal trigger).
 *  - idempotent on source_key: the same key with the same lines returns the existing voucher; different lines -> gl_source_conflict.
 *  - temp_no = MAX+1 per fiscal year inside the same transaction; ref_no is permanent. Final numbers only at month close (later).
 *  - the period lock / fiscal year / immutability triggers from G1 stay the last word.
 *  - opening voucher: only from an approved opening set (approver != enterer), only after the step-4 «قبلاً پرداخت شده»
 *    confirmation, only when the 2101 line matches the open payment orders net of pre-start payments, only with the base
 *    date read from settings and equal to gl.ledger_start_date - 1 day. Sub-ledger accounts are never in the opening.
 */
import type { DatabaseSync } from "node:sqlite";
import { financeSettingAsOf } from "./ledger";

export class GlPostingError extends Error {
  constructor(public readonly code: string, message?: string) { super(message ? `${code}: ${message}` : code); this.name = "GlPostingError"; }
}
const fail = (code: string, message?: string): never => { throw new GlPostingError(code, message); };

export type GlLineInput = { account: string; tafsiliId?: number | null; tafsili2Id?: number | null; debitRial?: number; creditRial?: number; description?: string };
export type GlVoucherInput = {
  eventDate: string; kind: "auto" | "manual" | "opening" | "backfill";
  description: string; sourceType?: string | null; sourceId?: string | number | null; sourceKey: string;
  lines: GlLineInput[]; createdByUserId?: number | null; approvedByUserId?: number | null; nowIso?: string;
};
export type GlPostResult = { voucherId: number; created: boolean; tempNo: number; refNo: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}
export function addDays(date: string, days: number): string {
  if (!isIsoDate(date)) fail("gl_bad_date");
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
/** Tehran calendar date of an ISO instant (event_date of a voucher). */
export function tehranDateOf(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) fail("gl_bad_date");
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  return ["year", "month", "day"].map((k) => p.find((x) => x.type === k)!.value).join("-");
}
/** Toman (TEXT / bigint / number from the old ledgers) -> integer rial. */
export function tomanToRial(v: string | number | bigint): number {
  const s = typeof v === "bigint" ? v.toString() : String(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) fail("gl_bad_amount", "toman must be an integer");
  const r = Number(BigInt(s) * 10n); if (!Number.isSafeInteger(r)) fail("gl_bad_amount"); return r;
}
function rial(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("gl_bad_amount", "rial must be a non-negative safe integer");
  return v as number;
}

export function assertInTransaction(db: DatabaseSync): void {
  if (!(db as unknown as { isTransaction?: boolean }).isTransaction) fail("gl_no_transaction");
}

type One<T> = T | undefined;
const one = <T>(db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as One<T>;

export function fiscalYearFor(db: DatabaseSync, eventDate: string): { id: number; status: string; locked_until: string | null } {
  if (!isIsoDate(eventDate)) fail("gl_bad_date");
  const fy = one<{ id: number; status: string; locked_until: string | null }>(db, "SELECT id,status,locked_until FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date", eventDate);
  if (!fy) fail("gl_no_fiscal_year", eventDate);
  return fy!;
}
export function isPeriodOpen(db: DatabaseSync, eventDate: string): boolean {
  const fy = one<{ status: string; locked_until: string | null }>(db, "SELECT status,locked_until FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date", eventDate);
  return !!fy && fy.status !== "closed" && !(fy.locked_until && eventDate <= fy.locked_until);
}

const TAFSILI_TYPES = new Set(["CU", "SP", "BK", "CB", "GW", "FD", "PL", "VN", "OW"]);
/** Idempotent: one tafsili per (type, ref_id). Title is set at creation only (identity never changes). */
export function ensureTafsili(db: DatabaseSync, type: string, refId: number, title: string, nowIso = new Date().toISOString()): number {
  if (!TAFSILI_TYPES.has(type)) fail("gl_tafsili_type");
  if (!Number.isSafeInteger(refId) || refId <= 0) fail("gl_tafsili_ref");
  const found = one<{ id: number }>(db, "SELECT id FROM gl_tafsili WHERE type=? AND ref_id=?", type, refId);
  if (found) return found.id;
  const safeTitle = String(title ?? "").trim() || `${type}-${refId}`;
  db.prepare("INSERT INTO gl_tafsili(type,ref_id,code,title,active,created_at) VALUES(?,?,?,?,1,?)").run(type, refId, `${type}-${refId}`, safeTitle, nowIso);
  return one<{ id: number }>(db, "SELECT id FROM gl_tafsili WHERE type=? AND ref_id=?", type, refId)!.id;
}

type ResolvedLine = { account_id: number; code: string; tafsili_id: number | null; tafsili2_id: number | null; debit_rial: number; credit_rial: number; description: string };
function resolveLines(db: DatabaseSync, lines: GlLineInput[]): ResolvedLine[] {
  if (!Array.isArray(lines) || lines.length < 2) fail("gl_voucher_too_few_lines");
  return lines.map((l) => {
    const acc = one<{ id: number; postable: number; active: number; tafsili_types: string }>(db, "SELECT id,postable,active,tafsili_types FROM gl_accounts WHERE code=?", l.account);
    if (!acc) fail("gl_account_unknown", l.account);
    if (!acc!.postable || !acc!.active) fail("gl_account_not_postable", l.account);
    const d = rial(l.debitRial), c = rial(l.creditRial);
    if ((d > 0 ? 1 : 0) + (c > 0 ? 1 : 0) !== 1) fail("gl_line_side", "each line is debit XOR credit, > 0");
    const tf = l.tafsiliId ?? null;
    if (tf !== null) {
      const t = one<{ type: string }>(db, "SELECT type FROM gl_tafsili WHERE id=?", tf);
      if (!t) fail("gl_tafsili_unknown");
      const allowed = acc!.tafsili_types.split(",").filter(Boolean);
      if (allowed.length && !allowed.includes(t!.type)) fail("gl_tafsili_type_mismatch", `${l.account}:${t!.type}`);
    }
    return { account_id: acc!.id, code: l.account, tafsili_id: tf, tafsili2_id: l.tafsili2Id ?? null, debit_rial: d, credit_rial: c, description: String(l.description ?? "") };
  });
}
const fingerprint = (lines: Array<Pick<ResolvedLine, "account_id" | "tafsili_id" | "tafsili2_id" | "debit_rial" | "credit_rial">>) =>
  JSON.stringify(lines.map((l) => [l.account_id, l.tafsili_id ?? null, l.tafsili2_id ?? null, l.debit_rial, l.credit_rial]));

function existingBySourceKey(db: DatabaseSync, sourceKey: string, eventDate: string, lines: ResolvedLine[]): GlPostResult | null {
  const v = one<{ id: number; temp_no: number; ref_no: string; event_date: string }>(db, "SELECT id,temp_no,ref_no,event_date FROM gl_vouchers WHERE source_key=?", sourceKey);
  if (!v) return null;
  const have = db.prepare("SELECT account_id,tafsili_id,tafsili2_id,debit_rial,credit_rial FROM gl_voucher_lines WHERE voucher_id=? ORDER BY line_no").all(v.id) as never[];
  if (v.event_date !== eventDate || fingerprint(have) !== fingerprint(lines)) fail("gl_source_conflict", sourceKey);
  return { voucherId: v.id, created: false, tempNo: v.temp_no, refNo: v.ref_no };
}

/**
 * Posts one balanced voucher inside the caller's transaction. Idempotent on sourceKey.
 * Throws GlPostingError (or the G1 trigger message: gl_period_locked, gl_fiscal_year_closed, gl_beneficiary_required, ...).
 */
export function postVoucher(db: DatabaseSync, input: GlVoucherInput & { reversesVoucherId?: number | null; kindOverride?: "reversal" }): GlPostResult {
  assertInTransaction(db);
  if (!input || typeof input.sourceKey !== "string" || !/^gl:[a-z0-9_:.-]{3,120}$/i.test(input.sourceKey)) fail("gl_source_key");
  if (!isIsoDate(input.eventDate)) fail("gl_bad_date");
  const kind = input.kindOverride ?? input.kind;
  if (!["auto", "manual", "opening", "backfill", "reversal"].includes(kind)) fail("gl_kind");
  const lines = resolveLines(db, input.lines);
  const dr = lines.reduce((s, l) => s + l.debit_rial, 0), cr = lines.reduce((s, l) => s + l.credit_rial, 0);
  if (!Number.isSafeInteger(dr) || dr !== cr) fail("gl_voucher_unbalanced", `${dr}<>${cr}`);
  const prior = existingBySourceKey(db, input.sourceKey, input.eventDate, lines);
  if (prior) return prior;
  const fy = fiscalYearFor(db, input.eventDate);
  if (fy.status === "closed") fail("gl_fiscal_year_closed");
  if (fy.locked_until && input.eventDate <= fy.locked_until) fail("gl_period_locked", input.eventDate);
  const now = input.nowIso ?? new Date().toISOString();
  db.exec("SAVEPOINT gl_post_voucher");
  try {
    const tempNo = (one<{ n: number }>(db, "SELECT COALESCE(MAX(temp_no),0)+1 n FROM gl_vouchers WHERE fiscal_year_id=?", fy.id)!.n);
    const refNo = `GL-${fy.id}-${String(tempNo).padStart(6, "0")}`;
    const res = db.prepare(`INSERT INTO gl_vouchers(fiscal_year_id,ref_no,temp_no,event_date,kind,description,source_type,source_id,source_key,reverses_voucher_id,total_rial,line_count,created_by_user_id,approved_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(fy.id, refNo, tempNo, input.eventDate, kind, String(input.description ?? ""),
      input.sourceType ?? null, input.sourceId === undefined || input.sourceId === null ? null : String(input.sourceId), input.sourceKey,
      input.reversesVoucherId ?? null, dr, lines.length, input.createdByUserId ?? null, input.approvedByUserId ?? null, now);
    const voucherId = Number(res.lastInsertRowid);
    const ins = db.prepare("INSERT INTO gl_voucher_lines(voucher_id,line_no,account_id,tafsili_id,tafsili2_id,debit_rial,credit_rial,description) VALUES(?,?,?,?,?,?,?,?)");
    lines.forEach((l, i) => ins.run(voucherId, i + 1, l.account_id, l.tafsili_id, l.tafsili2_id, l.debit_rial, l.credit_rial, l.description));
    db.prepare("INSERT INTO gl_voucher_seals(voucher_id,sealed_at) VALUES(?,?)").run(voucherId, now);
    db.exec("RELEASE gl_post_voucher");
    return { voucherId, created: true, tempNo, refNo };
  } catch (e) {
    db.exec("ROLLBACK TO gl_post_voucher"); db.exec("RELEASE gl_post_voucher"); throw e;
  }
}

/** A reversal voucher (swapped sides) in an open period. One reversal per voucher; reversals are not reversed again. */
export function reverseVoucher(db: DatabaseSync, voucherId: number, opts: { eventDate?: string; reason: string; byUserId?: number | null; sourceKey?: string; nowIso?: string }): GlPostResult {
  assertInTransaction(db);
  const v = one<{ id: number; kind: string; event_date: string; ref_no: string }>(db, "SELECT id,kind,event_date,ref_no FROM gl_vouchers WHERE id=?", voucherId);
  if (!v) fail("gl_voucher_unknown");
  if (!one(db, "SELECT 1 x FROM gl_voucher_seals WHERE voucher_id=?", voucherId)) fail("gl_voucher_unsealed");
  if (v!.kind === "reversal") fail("gl_reverse_reversal");
  if (!opts || String(opts.reason ?? "").trim().length < 5) fail("gl_reason_required");
  const sourceKey = opts.sourceKey ?? `gl:reversal:${voucherId}`;
  const done = one<{ id: number; source_key: string }>(db, "SELECT id,source_key FROM gl_vouchers WHERE reverses_voucher_id=?", voucherId);
  const eventDate = opts.eventDate ?? (isPeriodOpen(db, v!.event_date) ? v!.event_date : fail("gl_period_locked", "reversal date required"));
  const lines = (db.prepare(`SELECT a.code account,l.tafsili_id,l.tafsili2_id,l.debit_rial,l.credit_rial,l.description FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.voucher_id=? ORDER BY l.line_no`).all(voucherId) as Array<{ account: string; tafsili_id: number | null; tafsili2_id: number | null; debit_rial: number; credit_rial: number; description: string }>)
    .map((l) => ({ account: l.account, tafsiliId: l.tafsili_id, tafsili2Id: l.tafsili2_id, debitRial: l.credit_rial, creditRial: l.debit_rial, description: l.description }));
  if (done && done.source_key !== sourceKey) fail("gl_already_reversed");
  return postVoucher(db, { eventDate: eventDate as string, kind: "auto", kindOverride: "reversal", reversesVoucherId: voucherId,
    description: `برگشت سند ${v!.ref_no}: ${String(opts.reason).trim()}`, sourceType: "gl_voucher", sourceId: voucherId, sourceKey, lines,
    createdByUserId: opts.byUserId ?? null, nowIso: opts.nowIso });
}

/* ------------------------------------------------------------------ opening voucher (W2 / setup step 3-4) */

/** Accounts fed by event replay; they never take an opening balance (double counting). 2101 is IN the opening (v1.3 N7). */
export const OPENING_LOCKED_ACCOUNTS = ["2201", "8101", "8102", "2102", "1201", "4101", "4102", "4103", "4104"] as const;

export type OpeningBaseDate = { ok: true; baseDate: string; ledgerStartDate: string } | { ok: false; code: string; baseDate: string | null; ledgerStartDate: string | null };
/** Base date and ledger start read from settings (as of `asOf`); base must be exactly the day before the start. */
export function openingBaseDate(db: DatabaseSync, asOf: string): OpeningBaseDate {
  const start = financeSettingAsOf(db, "gl.ledger_start_date", asOf), base = financeSettingAsOf(db, "gl.opening_base_date", asOf);
  if (!start) return { ok: false, code: "finance_setting_missing:gl.ledger_start_date", baseDate: base, ledgerStartDate: null };
  if (!base) return { ok: false, code: "finance_setting_missing:gl.opening_base_date", baseDate: null, ledgerStartDate: start };
  if (addDays(start, -1) !== base) return { ok: false, code: "gl_opening_base_not_day_before_start", baseDate: base, ledgerStartDate: start };
  return { ok: true, baseDate: base, ledgerStartDate: start };
}

export type Opening2101Check = { status: "step4_pending" | "match" | "mismatch" | "no_draft"; expectedRial: number; draftRial: number | null; openOrders: number; prePaidOrders: number };
/**
 * Step 3 «جمع دستورهای باز پس از کسر پرداخت‌شده‌ها»: payment orders owed at the end of the base date, minus those with a
 * live «قبلاً پرداخت شده» record dated <= base (pre_start). Read-only. Drives warnings stp3_warn / stp4_warn / gl_set_warn.
 */
export function opening2101Check(db: DatabaseSync, setId: number | null, baseDate: string): Opening2101Check {
  if (!isIsoDate(baseDate)) fail("gl_bad_date");
  // end of base date in Tehran (UTC+03:30, no DST since 2022) as a UTC instant
  const cutoff = new Date(Date.parse(`${addDays(baseDate, 1)}T00:00:00+03:30`)).toISOString();
  const rows = db.prepare(`SELECT o.id, o.amount_toman,
      EXISTS (SELECT 1 FROM payment_order_prior_payments p WHERE p.payment_order_id=o.id AND p.pre_start=1
        AND NOT EXISTS (SELECT 1 FROM payment_order_prior_payment_voids v WHERE v.prior_payment_id=p.id)) pre_paid
    FROM customer_payment_orders o
    WHERE o.created_at < ? AND NOT (o.stage='paid' AND o.paid_at IS NOT NULL AND o.paid_at < ?)`).all(cutoff, cutoff) as Array<{ id: number; amount_toman: string; pre_paid: number }>;
  let expected = 0, pre = 0;
  for (const r of rows) { if (r.pre_paid) pre++; else expected += tomanToRial(r.amount_toman); }
  let draft: number | null = null, confirmed = false;
  if (setId !== null) {
    const s = one<{ prior_payments_confirmed_at: string | null }>(db, "SELECT prior_payments_confirmed_at FROM gl_opening_balance_sets WHERE id=?", setId);
    if (!s) fail("gl_opening_set_unknown");
    confirmed = !!s!.prior_payments_confirmed_at;
    const d = one<{ c: number | null; d: number | null; n: number }>(db, `SELECT SUM(l.credit_rial) c, SUM(l.debit_rial) d, COUNT(*) n FROM gl_opening_balance_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.set_id=? AND a.code='2101'`, setId)!;
    draft = d.n ? (d.c ?? 0) - (d.d ?? 0) : null;
  }
  const status = setId === null || draft === null ? "no_draft" : !confirmed ? "step4_pending" : draft === expected ? "match" : "mismatch";
  return { status, expectedRial: expected, draftRial: draft, openOrders: rows.length, prePaidOrders: pre };
}

export type OpeningReadiness = { ok: boolean; reasons: string[]; check2101: Opening2101Check | null; base: OpeningBaseDate };
/** Why «تأیید سند افتتاحیه» is locked (empty reasons = may be approved by a second person). Read-only. */
export function openingApprovalReadiness(db: DatabaseSync, setId: number, approverUserId: number | null, today: string): OpeningReadiness {
  const reasons: string[] = [];
  const s = one<{ id: number; as_of_date: string; entered_by_user_id: number; approved_by_user_id: number | null; prior_payments_confirmed_at: string | null; supersedes_set_id: number | null }>(db,
    "SELECT id,as_of_date,entered_by_user_id,approved_by_user_id,prior_payments_confirmed_at,supersedes_set_id FROM gl_opening_balance_sets WHERE id=?", setId);
  if (!s) fail("gl_opening_set_unknown");
  const base = openingBaseDate(db, today);
  if (!base.ok) reasons.push(base.code);
  else if (s!.as_of_date !== base.baseDate) reasons.push("gl_opening_as_of_not_base_date");
  if (s!.approved_by_user_id !== null) reasons.push("gl_opening_set_approved");
  if (one(db, "SELECT 1 x FROM gl_opening_balance_sets WHERE supersedes_set_id=?", setId)) reasons.push("gl_opening_set_superseded");
  if (one(db, "SELECT 1 x FROM gl_vouchers WHERE kind='opening'")) reasons.push("gl_opening_exists");
  if (!s!.prior_payments_confirmed_at) reasons.push("gl_opening_prior_payments_unconfirmed");
  if (approverUserId !== null && approverUserId === s!.entered_by_user_id) reasons.push("gl_opening_second_person_required");
  const locked = db.prepare(`SELECT DISTINCT a.code FROM gl_opening_balance_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.set_id=? AND a.code IN (${OPENING_LOCKED_ACCOUNTS.map(() => "?").join(",")})`).all(setId, ...OPENING_LOCKED_ACCOUNTS) as Array<{ code: string }>;
  if (locked.length) reasons.push(`gl_opening_locked_account:${locked.map((r) => r.code).join(",")}`);
  const t = one<{ n: number; d: number; c: number }>(db, "SELECT COUNT(*) n, COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM gl_opening_balance_lines WHERE set_id=?", setId)!;
  if (t.n < 2 || t.d !== t.c || t.d <= 0) reasons.push("gl_opening_unbalanced");
  const check2101 = base.ok ? opening2101Check(db, setId, base.baseDate) : null;
  if (check2101 && check2101.status !== "match") reasons.push(check2101.status === "step4_pending" ? "gl_opening_step4_pending" : check2101.status === "no_draft" ? "gl_opening_2101_missing" : "gl_opening_2101_mismatch");
  return { ok: reasons.length === 0, reasons, check2101, base };
}

/**
 * Second person approves the opening set and the opening voucher is posted in the same transaction (event_date = base date).
 * Every check in openingApprovalReadiness must pass; the G1/v1c triggers re-check maker != checker, balance and step-4 confirmation.
 */
export function approveOpeningSet(db: DatabaseSync, setId: number, approverUserId: number, today: string, nowIso = new Date().toISOString()): GlPostResult {
  assertInTransaction(db);
  if (!Number.isSafeInteger(approverUserId) || approverUserId <= 0) fail("gl_approver_required");
  const r = openingApprovalReadiness(db, setId, approverUserId, today);
  if (!r.ok) fail(r.reasons[0], r.reasons.join(" "));
  const base = r.base as Extract<OpeningBaseDate, { ok: true }>;
  const s = one<{ entered_by_user_id: number }>(db, "SELECT entered_by_user_id FROM gl_opening_balance_sets WHERE id=?", setId)!;
  const lines = (db.prepare(`SELECT a.code account, l.tafsili_id, l.debit_rial, l.credit_rial, COALESCE(l.note,'') note FROM gl_opening_balance_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.set_id=? ORDER BY a.code, l.id`).all(setId) as Array<{ account: string; tafsili_id: number | null; debit_rial: number; credit_rial: number; note: string }>)
    .map((l) => ({ account: l.account, tafsiliId: l.tafsili_id, debitRial: l.debit_rial, creditRial: l.credit_rial, description: l.note }));
  db.exec("SAVEPOINT gl_opening");
  try {
    db.prepare("UPDATE gl_opening_balance_sets SET approved_by_user_id=?, approved_at=? WHERE id=?").run(approverUserId, nowIso, setId);
    const out = postVoucher(db, { eventDate: base.baseDate, kind: "opening", description: "سند افتتاحیه", sourceType: "gl_opening_balance_set", sourceId: setId,
      sourceKey: `gl:opening:${setId}`, lines, createdByUserId: s.entered_by_user_id, approvedByUserId: approverUserId, nowIso });
    db.prepare("UPDATE gl_opening_balance_sets SET voucher_id=? WHERE id=?").run(out.voucherId, setId);
    db.exec("RELEASE gl_opening");
    return out;
  } catch (e) { db.exec("ROLLBACK TO gl_opening"); db.exec("RELEASE gl_opening"); throw e; }
}

/** Shared by G3/G4: a non-blocking post. Failure -> ROLLBACK TO the savepoint, then a failed queue row in the SAME outer transaction. */
export function postOrQueue(db: DatabaseSync, input: GlVoucherInput & { eventType: string }): { status: "posted" | "failed"; voucherId?: number; error?: string } {
  assertInTransaction(db);
  const now = input.nowIso ?? new Date().toISOString();
  db.exec("SAVEPOINT gl_post");
  try {
    const r = postVoucher(db, input);
    db.exec("RELEASE gl_post");
    return { status: "posted", voucherId: r.voucherId };
  } catch (e) {
    db.exec("ROLLBACK TO gl_post"); db.exec("RELEASE gl_post");
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    queueFailed(db, input, input.eventType, msg, now);
    return { status: "failed", error: msg };
  }
}
export function queueFailed(db: DatabaseSync, input: Pick<GlVoucherInput, "sourceKey" | "sourceType" | "sourceId" | "eventDate" | "kind" | "description" | "lines">, eventType: string, error: string, nowIso: string): void {
  const payload = JSON.stringify({ eventDate: input.eventDate, kind: input.kind, description: input.description, lines: input.lines });
  db.prepare(`INSERT INTO gl_posting_queue(source_key,event_type,source_type,source_id,payload_json,status,attempts,next_attempt_at,last_error,created_at,updated_at)
    VALUES(?,?,?,?,?,'failed',1,NULL,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET attempts=attempts+1, last_error=excluded.last_error, payload_json=excluded.payload_json, updated_at=excluded.updated_at WHERE status<>'posted'`)
    .run(input.sourceKey, eventType, input.sourceType ?? null, input.sourceId === undefined || input.sourceId === null ? null : String(input.sourceId), payload, error, nowIso, nowIso);
}
/** Records why an event got no voucher (e.g. a finance setting is empty on the event date). Idempotent. */
export function recordGlException(db: DatabaseSync, sourceType: string, sourceId: string | number, code: string, note: string, nowIso = new Date().toISOString()): void {
  db.prepare("INSERT OR IGNORE INTO gl_exceptions(source_type,source_id,code,note,created_at) VALUES(?,?,?,?,?)").run(sourceType, String(sourceId), code.slice(0, 120), note.slice(0, 500), nowIso);
}
