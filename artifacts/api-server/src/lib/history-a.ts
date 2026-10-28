/**
 * HISTORY-A (Armita crm-reminder-incoming v1.0 §2 + «فاز ۲ / نیاز سرور»), experts 8/2/3, own customers only:
 *  - historySummary(): the «.hx» box data (priority, file status, next step, last 3 real calls with note, consultations, «چی بپرسه»).
 *  - expertUpgrade(): «ارتقا به اولویت یک» by the expert directly, short reason MANDATORY (≤80).
 *      · the qualifier (Kazemi) → the existing hand-off (promoteToPriorityOne) with the reason as its note;
 *      · a closer (Hasani / Ghasemi) → keeps the customer, priority becomes 1 («expert_upgrade» row in customer_priority_history
 *        + the same «ارتقا به اولویت ۱ توسط …» timeline row the hand-off writes; realCallSql keeps it out of every call counter).
 *        No hand-off, no bell, no reminder, no SMS/Bale.
 *  - assertP1RevertAllowed(): a P1 set by «expert_upgrade» can be taken back only by an admin.
 * No switches: scoped in code (EL_USERS ∩ team-sales roles). Nothing here sends anything.
 */
import { execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { EL_ADMIN_USER_IDS, EL_USERS } from "./expert-lockdown";
import { TeamSalesError, firstCallEditAccess, getTeamSalesConfig, latestFirstCall, logPriorityChange, ensureTeamSalesSchema, promoteToPriorityOne, shortName, type Actor } from "./team-sales";
import { normalizeFirstCallAnswers, validateAnswers, type QualifierAnswers } from "./team-sales-rules";
import { FC_STAGE_GROUPS, FC_GROUP_CODES, FC_GROUP_LABELS, FC_WAIT_GROUPS } from "./files-carousel";
import { realCallSql } from "./real-call";

export const HX_REASON_MAX = 80;
export const HX_SOURCE = "expert_upgrade" as const;
export const HX_REVERT_MSG = "برگرداندن فقط با ادمین: فقط مدیر می‌تواند اولویت ۱ ارتقایافته را برگرداند یا کم کند.";
/** Armita v1.1 (scenes 03–07): the line shown in the confirm dialog and on the P1 label. */
export const HX_ADMIN_LINE = "برگرداندن فقط با ادمین";
/** P1 sources that count as «ارتقا به اولویت یک» (expert direct upgrade + the qualifier hand-off / resend). */
export const HX_UPGRADE_SOURCES = [HX_SOURCE, "promote"] as const;

const isAdmin = (a: { id: number; role: string }) => a.role === "admin";
/** One of the three locked experts (users 8/2/3 with their own salesperson). */
export const hxExpert = (a: { id: number; role: string; salespersonId: number | null } | null | undefined): boolean =>
  Boolean(a && a.role === "salesperson" && EL_USERS[Number(a.id)] != null && Number(a.salespersonId) === EL_USERS[Number(a.id)]);
/** A closer of the team-sales config (users 2/3 today) among the three experts. */
export function hxCloser(a: Actor): boolean {
  const cfg = getTeamSalesConfig();
  return hxExpert(a) && a.salespersonId != null && cfg.closerSalespersonIds.includes(Number(a.salespersonId)) && Number(a.salespersonId) !== cfg.qualifierSalespersonId;
}

/** Reason rule: an explicit `reason` is required for everybody but an admin; trimmed, one line, 1..80 chars (`note` never substitutes). */
export function upgradeReasonOf(body: any, actor: Actor): { reason: string | null; note: string | null } | { error: string } {
  const clean = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  const note = clean(body?.note).slice(0, 2000) || null;
  let reason = clean(body?.reason) || null;
  if (reason && reason.length > HX_REASON_MAX) return { error: `دلیل کوتاه حداکثر ${HX_REASON_MAX} حرف است.` };
  if (!reason && !isAdmin(actor)) return { error: "دلیل کوتاه ارتقا لازم است." };
  return { reason, note };
}

type Cust = { id: number; name: string; salesperson_id: number | null; priority: number | null; status: string; merged_into_customer_id: number | null };
const loadC = (id: number) => queryRow<Cust>("SELECT id,name,salesperson_id,priority,status,merged_into_customer_id FROM customers WHERE id=?", [id]);

/** Closer self-upgrade (no hand-off). Throws TeamSalesError. */
export function closerSelfUpgrade(customerId: number, actor: Actor, reason: string, note: string | null = null, now = new Date()) {
  ensureTeamSalesSchema();
  return runImmediateTransaction(() => {
    const c = loadC(customerId);
    if (!c || c.merged_into_customer_id != null || Number(c.salesperson_id) !== Number(actor.salespersonId)) throw new TeamSalesError(404, "Customer not found");
    if (c.status !== "in_progress") throw new TeamSalesError(409, "فقط پرونده‌های در جریان قابل ارتقا هستند.");
    if (c.priority === 1) throw new TeamSalesError(409, "این مشتری اولویت ۱ است.");
    const nowIso = now.toISOString();
    const preMax = Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0);
    const changed = executeChanges("UPDATE customers SET priority=1 WHERE id=? AND salesperson_id=? AND status='in_progress' AND COALESCE(priority,0)<>1",
      [c.id, actor.salespersonId]);
    if (changed !== 1) throw new TeamSalesError(409, "پرونده همزمان تغییر کرد؛ دوباره تلاش کنید.");
    const actorName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId])?.name ?? actor.fullName ?? "کارشناس";
    const prev = c.priority == null ? "بدون اولویت" : `اولویت ${String(c.priority).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}`;
    const callLogId = execute(
      `INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, actor.salespersonId, `ارتقا به اولویت ۱ توسط ${shortName(actorName)}`, null,
        [`ارتقای مستقیم توسط کارشناس — قبلاً ${prev} — پرونده نزد همین کارشناس می‌ماند`, `دلیل: ${reason}`, note ? `یادداشت: ${note}` : null].filter(Boolean).join("\n"),
        nowIso, actorName]);
    // Generic triggers write bells for the customers UPDATE / call_logs INSERT: none for this action (nobody is notified).
    execute("DELETE FROM site_notification_events WHERE id>? AND customer_id=?", [preMax, c.id]);
    logPriorityChange({ customerId: c.id, oldPriority: c.priority, newPriority: 1, oldSalespersonId: c.salesperson_id,
      newSalespersonId: c.salesperson_id, actorUserId: actor.id, source: HX_SOURCE, reason, at: nowIso, always: true });
    // PromoteResult-compatible (HOTFIX-73 UI): closer = self, no due time.
    return { customerId: c.id, priority: 1, kept: true, salespersonId: c.salesperson_id, salespersonName: actorName, callLogId,
      closerSalespersonId: Number(c.salesperson_id), closerName: actorName, dueAt: null, dueLabel: null, reminderId: null, notificationId: null,
      assignment: "self" as const, assignmentLabel: "نزد خودت می‌ماند", message: "ارتقا یافت · اولویت ۱ (نزد خودت می‌ماند)", adminLine: HX_ADMIN_LINE };
  });
}

/** The single entry point for POST /customers/:id/priority and /customers/:id/upgrade-priority. */
export function expertUpgrade(customerId: number, actor: Actor, reason: string | null, note: string | null) {
  const cfg = getTeamSalesConfig();
  if (!isAdmin(actor) && hxCloser(actor)) {
    if (!cfg.enabled) throw new TeamSalesError(404, "Team sales is not enabled");
    return closerSelfUpgrade(customerId, actor, reason!, note);
  }
  // Admin / qualifier: the existing hand-off, reason kept in its timeline note and history row.
  const merged = [reason ? `دلیل: ${reason}` : null, note].filter(Boolean).join(" — ") || null;
  const r = promoteToPriorityOne(customerId, actor, merged);
  return { ...r, priority: 1, kept: false, adminLine: HX_ADMIN_LINE };
}

/** next-closer for a closer: the answer is «yourself» (no hand-off). Null when the actor is not a closer of the three. */
export function selfNextCloser(actor: Actor, customerId: number | null) {
  if (isAdmin(actor) || !hxCloser(actor)) return null;
  if (customerId) {
    const c = loadC(customerId);
    if (!c || c.merged_into_customer_id != null || Number(c.salesperson_id) !== Number(actor.salespersonId)) return { notFound: true } as const;
  }
  const name = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId])?.name ?? actor.fullName ?? "";
  return { salespersonId: Number(actor.salespersonId), name, assignment: "self" as const, assignmentLabel: "نزد خودت می‌ماند", self: true };
}

/** The latest P1 entry of this customer came from «expert_upgrade»? (null when none) */
function lastP1Source(customerId: number): string | null {
  try {
    return queryRow<{ source: string }>("SELECT source FROM customer_priority_history WHERE customer_id=? AND new_priority=1 ORDER BY id DESC LIMIT 1", [customerId])?.source ?? null;
  } catch { return null; }
}
/** Throws TeamSalesError(403) when a non-admin takes back an expert-set P1. `newPriority` undefined = not changing priority. */
/** HISTORY-A scope: the history box is for experts 8/2/3 (EL_USERS) and admins only. */
export const hxCanSee = (a: { id: number; role: string; salespersonId: number | null } | null | undefined): boolean =>
  Boolean(a && (hxExpert(a) || isAdmin(a as any) || EL_ADMIN_USER_IDS.includes(Number(a.id))));

export function assertP1RevertAllowed(customerId: number, newPriority: number | null | undefined, actor: { id: number; role: string } | null | undefined) {
  if (newPriority === undefined || newPriority === 1) return;
  if (actor && (isAdmin(actor) || EL_ADMIN_USER_IDS.includes(Number(actor.id)))) return;
  const cur = queryRow<{ priority: number | null }>("SELECT priority FROM customers WHERE id=?", [customerId]);
  if (!cur || cur.priority !== 1) return;
  const src = lastP1Source(customerId);
  if (src && (HX_UPGRADE_SOURCES as readonly string[]).includes(src)) throw new TeamSalesError(403, HX_REVERT_MSG);
}

/* ---------------- history summary ---------------- */
const OUT: Record<string, [string, string]> = {
  answered: ["جواب داد", "ok"], connected: ["جواب داد", "ok"], no_answer: ["جواب نداد", "na"], follow_up: ["پیگیری بعدی", "fc"],
  callback: ["تماس بعدی", "fc"], not_interested: ["تمایل ندارد", "td"], wrong_number: ["شماره اشتباه", "td"], rejected: ["انصراف", "td"],
};
const STATUS_FA: Record<string, string> = { in_progress: "در حال پیگیری", cancelled: "انصرافی", completed: "تکمیل‌شده" };
const one = (s: string | null | undefined, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function callTag(outcome: string | null, subject: string | null): [string, string] {
  if (outcome && OUT[outcome]) return OUT[outcome];
  const s = String(subject ?? "").trim();
  if (s.startsWith("تماس اولیه")) return s.includes("بی‌پاسخ") || s.includes("بی\u200cپاسخ") ? ["جواب نداد", "na"] : ["تماس اول", "fc"];
  return [s ? one(s, 24) : "تماس", ""];
}

function fileStatus(c: Cust): { label: string; tone: string } {
  const la = queryRow<{ stage: string }>(`SELECT stage FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL AND status<>'rejected'
    AND stage<>'completed' ORDER BY id DESC LIMIT 1`, [c.id]);
  if (la) {
    const gi = FC_STAGE_GROUPS.findIndex((g) => g.includes(la.stage));
    if (gi >= 0) return { label: `درخواست تسهیلات · ${FC_GROUP_LABELS[FC_GROUP_CODES[gi]]}`, tone: "fs" };
    const w = FC_WAIT_GROUPS.find((g) => g.stages.includes(la.stage));
    return { label: w ? `درخواست تسهیلات · در انتظار ${w.label}` : "درخواست تسهیلات · در جریان", tone: "fs" };
  }
  return { label: STATUS_FA[c.status] ?? "پرونده", tone: "" };
}

export function historySummary(customerId: number, actor: Actor) {
  ensureTeamSalesSchema();
  const c = loadC(customerId);
  if (!c || c.merged_into_customer_id != null) return null;
  const real = realCallSql("l.subject");
  const callCount = Number(queryRow<{ n: number }>(`SELECT COUNT(*) n FROM call_logs l WHERE l.customer_id=? AND ${real} AND COALESCE(l.source,'')<>'daily_plan'`, [c.id])?.n ?? 0);
  const calls = queryRows<any>(`SELECT l.id, l.created_at, l.outcome, l.subject, l.one_line_note, l.expert_notes, l.customer_request, l.salesperson_name_snapshot
    FROM call_logs l WHERE l.customer_id=? AND ${real} AND COALESCE(l.source,'')<>'daily_plan' ORDER BY l.created_at DESC, l.id DESC LIMIT 3`, [c.id])
    .map((r) => { const [label, tone] = callTag(r.outcome, r.subject);
      return { id: r.id, at: r.created_at, result: label, tone, note: one(r.one_line_note || r.expert_notes || r.customer_request || "", 160) || null,
        by: r.salesperson_name_snapshot ? shortName(String(r.salesperson_name_snapshot)) : null }; });
  const rem = queryRow<{ subject: string | null; message: string | null; remind_at: string }>(`SELECT subject, message, remind_at FROM reminders
    WHERE customer_id=? AND COALESCE(done,0)=0 AND voided_at IS NULL AND closed_at IS NULL ORDER BY remind_at ASC, id ASC LIMIT 1`, [c.id]);
  const cons = queryRow<{ n: number; last: string | null }>("SELECT COUNT(*) n, MAX(COALESCE(updated_at, created_at)) last FROM consultation_forms WHERE customer_id=?", [c.id]);
  const consLast = cons?.n ? queryRow<{ extra_notes: string | null; loan_purpose: string | null }>(
    "SELECT extra_notes, loan_purpose FROM consultation_forms WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c.id]) : null;
  const fs = fileStatus(c);
  const last = calls[0];
  const ask: string[] = [];
  if (last?.tone === "na") ask.push("بار قبل جواب نداد؛ اول بپرس الان وقت صحبت دارد؟");
  if (rem?.subject || rem?.message) ask.push(`درباره‌ی «${one(rem.subject || rem.message, 50)}» چه شد؟`);
  if (fs.label.includes("مدارک")) ask.push("کدام مدرک هنوز مانده و کی می‌فرستد؟");
  else if (fs.label.includes("وثیقه")) ask.push("وثیقه یا ضامن آماده است؟");
  else if (fs.label.includes("امضا")) ask.push("قرارداد را امضا کرد؟ اگر نه، چه چیزی مانده؟");
  else if (fs.label.includes("پیش‌نویس")) ask.push("درخواست را کامل کنیم؟ چه چیزی کم است؟");
  if (last?.note && ask.length < 3) ask.push("از یادداشت تماس قبل پیگیری کن: هنوز همان را می‌خواهد؟");
  for (const d of ["مبلغ و زمان نیازش عوض نشده؟", "ضامن یا چک دارد؟"]) if (ask.length < 2) ask.push(d);
  const p1Src = c.priority === 1 ? lastP1Source(c.id) : null;
  const own = Number(c.salesperson_id) === Number(actor.salespersonId) || isAdmin(actor);
  return {
    customerId: c.id, priority: c.priority, status: c.status, callCount, firstCall: callCount === 0,
    fileStatus: fs.label, fileTone: fs.tone,
    nextStep: rem ? { text: one(rem.subject || rem.message, 80), at: rem.remind_at } : null,
    calls,
    consultations: cons?.n ? { count: Number(cons.n), lastAt: cons.last, note: one(consLast?.extra_notes || consLast?.loan_purpose || "", 120) || null } : null,
    ask: ask.slice(0, 3),
    isP1: c.priority === 1, upgradedByExpert: p1Src === HX_SOURCE,
    revertAdminOnly: c.priority === 1 && p1Src != null && (HX_UPGRADE_SOURCES as readonly string[]).includes(p1Src), adminLine: HX_ADMIN_LINE, reasonMax: HX_REASON_MAX,
    canUpgrade: own && c.status === "in_progress" && c.priority !== 1 && getTeamSalesConfig().enabled
      && (isAdmin(actor) || hxCloser(actor) || Number(actor.salespersonId) === getTeamSalesConfig().qualifierSalespersonId),
    handoff: c.priority !== 1 && !isAdmin(actor) && Number(actor.salespersonId) === getTeamSalesConfig().qualifierSalespersonId,
  };
}

/** Admin read-only list of expert upgrades (the manager's report of «ارتقا به اولویت یک»). */
export function expertUpgradesReport(limit = 200) {
  ensureTeamSalesSchema();
  return queryRows<any>(`SELECT h.id, h.customer_id customerId, c.name customerName, h.old_priority oldPriority, h.new_priority newPriority, h.reason, h.created_at at,
      u.full_name actorName, h.actor_user_id actorUserId, h.source
    FROM customer_priority_history h JOIN customers c ON c.id=h.customer_id LEFT JOIN users u ON u.id=h.actor_user_id
    WHERE h.source IN ('expert_upgrade','promote') ORDER BY h.id DESC LIMIT ?`, [Math.min(500, Math.max(1, limit))]);
}

/* ---------------- HISTORY-A v1.2 backend prep: file card + full call history (read-only) ---------------- */
const maskPhone = (p: string | null | undefined) => {
  const d = String(p ?? "").replace(/[^0-9]/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}***${d.slice(-4)}` : null;
};
/* HISTORY-A v1.2 §الف-۱ «پرونده‌ی مشتری · پاسخ‌های فرم تماس اول»: the first-call answers + what is still missing (no city). */
export const FILE_REQUIRED = ["amountMillion", "urgency", "docsReady", "creditRank", "cheque", "bouncedCheque", "military", "jobType", "ssoRetiree", "guarantorAvailable"] as const;
export const FILE_GUARANTOR_REQUIRED = ["guarantorCheque", "gRank", "gJobType"] as const;
const FILE_TABLE = "hx_file_answers";
let fileSchemaReady = false;
function ensureFileSchema() {
  if (fileSchemaReady) return;
  execute(`CREATE TABLE IF NOT EXISTS ${FILE_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, actor_user_id INTEGER NOT NULL, actor_name TEXT,
    answers_json TEXT NOT NULL, before_json TEXT, changed_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
  execute(`CREATE INDEX IF NOT EXISTS idx_hx_file_answers_customer ON ${FILE_TABLE}(customer_id, id DESC)`);
  fileSchemaReady = true;
}
const chequeOf = (a: Record<string, unknown>) =>
  a.checkStatus && a.checkStatus !== "none" ? "check" : a.canPromissory === "yes" ? "promissory" : a.checkStatus ? "none" : null;
/** Keys of required answers that are still empty. Guarantor sub-questions only when guarantorAvailable = yes; city never. */
export function fileMissing(a: Record<string, unknown> | null): string[] {
  const v = (k: string) => (k === "cheque" ? (a ? chequeOf(a) : null) : a?.[k]);
  const empty = (x: unknown) => x == null || x === "" || (typeof x === "number" && !(x > 0));
  const keys: string[] = [...FILE_REQUIRED];
  if (a?.guarantorAvailable === "yes") keys.push(...FILE_GUARANTOR_REQUIRED);
  return keys.filter((k) => empty(v(k)));
}
function latestFileOnly(customerId: number) {
  ensureFileSchema();
  const r = queryRow<{ id: number; answers_json: string; created_at: string; actor_name: string | null }>(
    `SELECT id, answers_json, created_at, actor_name FROM ${FILE_TABLE} WHERE customer_id=? ORDER BY id DESC LIMIT 1`, [customerId]);
  if (!r) return null;
  try { return { id: r.id, answers: JSON.parse(r.answers_json) as Record<string, unknown>, at: r.created_at, by: r.actor_name }; } catch { return null; }
}
/** Read-only Today-card file column. No national code / address / documents; phone masked. */
export function fileCard(customerId: number, actor: Actor) {
  const c = queryRow<any>(`SELECT id,name,phone,priority,status,city,salesperson_id,merged_into_customer_id FROM customers WHERE id=?`, [customerId]);
  if (!c || c.merged_into_customer_id != null) return null;
  const fc = latestFirstCall(c.id);
  const fo0 = latestFileOnly(c.id);
  // A «ذخیره‌ی پرونده» newer than the latest first-call record wins; a newer first-call record/edit wins over an older file save.
  const fo = fo0 && (!fc || Date.parse(fo0.at) > Date.parse(fc.createdAt)) ? fo0 : null;
  const answers: Record<string, unknown> | null = fo ? { ...fo.answers } : fc ? { ...fc.answers } : null;
  if (answers) answers.cheque = chequeOf(answers);
  const missing = fileMissing(answers);
  const total = FILE_REQUIRED.length + (answers?.guarantorAvailable === "yes" ? FILE_GUARANTOR_REQUIRED.length : 0);
  const p1Src = c.priority === 1 ? lastP1Source(c.id) : null;
  return {
    customerId: c.id, name: c.name, phoneMasked: maskPhone(c.phone), priority: c.priority, status: c.status,
    source: fo ? "file" : fc ? "first_call" : null, baseId: fc?.id ?? null, updatedAt: fo?.at ?? fc?.createdAt ?? null,
    changedFields: fo ? lastChanged(c.id, fo.id) : [],
    answers, city: (answers?.city as string | null | undefined) ?? c.city ?? null,
    note: fc?.note ?? null, selectedPlanIds: fc ? fc.selectedPlans.map((p: any) => Number(p.id)) : [], noPlanFit: fc?.noPlanFit ?? false, noPlanNote: fc?.noPlanNote ?? null,
    missing, missingCount: missing.length, total, complete: answers != null && missing.length === 0,
    canEdit: firstCallEditAccess(actor, c).canEdit,
    isP1: c.priority === 1, revertAdminOnly: c.priority === 1 && p1Src != null && (HX_UPGRADE_SOURCES as readonly string[]).includes(p1Src), adminLine: HX_ADMIN_LINE,
  };
}
function lastChanged(customerId: number, id: number): string[] {
  const r = queryRow<{ changed_json: string }>(`SELECT changed_json FROM ${FILE_TABLE} WHERE id=? AND customer_id=?`, [id, customerId]);
  try { return r ? (JSON.parse(r.changed_json) as { field: string }[]).map((x) => x.field) : []; } catch { return []; }
}
/**
 * «ذخیره‌ی پرونده» (Today card file column). Saves a file-layer record with before/changed; the first-call record itself
 * stays as it was recorded. This path NEVER changes priority, owner, status or the qualification report, records no call
 * and sends nothing (unlike «ویرایش خلاصه‌ی تماس اول», whose P3→P2 / transfer rules are untouched).
 */
export function saveFileOnly(customerId: number, actor: Actor, raw: unknown, now = new Date()) {
  ensureTeamSalesSchema(); ensureFileSchema();
  const c = queryRow<any>(`SELECT id,salesperson_id,priority,status,merged_into_customer_id FROM customers WHERE id=?`, [customerId]);
  if (!c || c.merged_into_customer_id != null) throw new TeamSalesError(404, "Customer not found");
  if (!firstCallEditAccess(actor, c).canEdit) throw new TeamSalesError(403, "تکمیل پرونده فقط برای مدیر، کارشناس تماس اول و کارشناس همین مشتری است.");
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const a = { ...src, mode: "simple", formVersion: 2, callResult: "answered" } as QualifierAnswers;
  const err = !a.ssoRetiree ? "بازنشستگی تأمین اجتماعی (متقاضی یا خانواده) را مشخص کنید." : validateAnswers(a, now);
  if (err) throw new TeamSalesError(400, err);
  const n = normalizeFirstCallAnswers(a) as Record<string, unknown>;
  const KEEP = ["amountMillion", "urgency", "docsReady", "creditRank", "checkStatus", "canPromissory", "bouncedCheque", "military", "jobType", "city",
    "ssoRetiree", "ssoRetireeRelation", "guarantorAvailable", "guarantorCheque", "gRank", "gJobType"];
  const stored: Record<string, unknown> = {}; for (const k of KEEP) stored[k] = n[k] ?? null;
  const cur = fileCard(c.id, actor);
  const prev = cur?.answers ? { answers: cur.answers } : null;
  const fields = [...KEEP.filter((k) => k !== "checkStatus" && k !== "canPromissory"), "cheque"];
  const val = (o: Record<string, unknown> | null | undefined, k: string) => (o ? (k === "cheque" ? chequeOf(o) : o[k] ?? null) : null);
  const changed = fields.filter((k) => JSON.stringify(val(prev?.answers, k)) !== JSON.stringify(val(stored, k)))
    .map((k) => ({ field: k, old: val(prev?.answers, k), new: val(stored, k) }));
  if (!changed.length) throw new TeamSalesError(400, "تغییری ثبت نشد.");
  const actorName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId ?? -1])?.name ?? actor.fullName ?? null;
  const id = execute(`INSERT INTO ${FILE_TABLE} (customer_id, actor_user_id, actor_name, answers_json, before_json, changed_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    [c.id, actor.id, actorName, JSON.stringify(stored), prev ? JSON.stringify(prev.answers) : null, JSON.stringify(changed), now.toISOString()]);
  return { id, changed, priorityBefore: c.priority, priorityAfter: c.priority };
}
/** Real calls of one customer, newest first, keyset-paged by id (`before`). daily_plan mirrors and upgrade rows are excluded (realCallSql). */
export function callHistory(customerId: number, limit = 20, before: number | null = null) {
  const real = realCallSql("l.subject");
  const lim = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  const rows = queryRows<any>(`SELECT l.id, l.created_at, l.outcome, l.subject, l.one_line_note, l.expert_notes, l.customer_request, l.salesperson_name_snapshot
    FROM call_logs l WHERE l.customer_id=? AND ${real} AND COALESCE(l.source,'')<>'daily_plan' ${before ? "AND l.id<?" : ""}
    ORDER BY l.id DESC LIMIT ?`, before ? [customerId, before, lim + 1] : [customerId, lim + 1]);
  const items = rows.slice(0, lim).map((r) => { const [label, tone] = callTag(r.outcome, r.subject);
    return { id: r.id, at: r.created_at, result: label, tone, note: one(r.one_line_note || r.expert_notes || r.customer_request || "", 400) || null,
      by: r.salesperson_name_snapshot ? shortName(String(r.salesperson_name_snapshot)) : null }; });
  return { customerId, items, nextBefore: rows.length > lim ? items[items.length - 1].id : null };
}
