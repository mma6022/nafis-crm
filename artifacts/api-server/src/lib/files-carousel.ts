/**
 * FILES-61 «پرونده‌های من» تک‌کارتی (Mohammad 2026-10-28 10:23 Tehran, t113u). Behind flag.files_carousel (call_queue_settings, seeded '0').
 * «پرونده» = an open loan_applications row of the expert's own (current, post-merge) customer: not deleted, not a pre-registration draft,
 * status<>'rejected', stage<>'completed'. Only users 8 (sp 6), 2 (sp 3), 3 (sp 4).
 * The deck: today's order = the assistant's order (PUT /files/priority/{today}) or the default (stage group, then oldest last follow-up, then id).
 * The current card is pinned (fc_days.current_file_id) and never moved by an assistant order. A follow-up result (fc_followups) closes it.
 * Nothing here changes a stage, contract, template, amount, wallet or customer, sends SMS/Bale/customer messages or rings any staff bell.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { cqRaw, isWorkDay, tParts, tYmd, fromTehran, CQ_OUTCOMES } from "./call-queue";
import { EL_USERS } from "./expert-lockdown";
import { maskCustomerName } from "./cross-owner-search";
import { faDigits, fcCategories, fcInGroupCompare, fcOldDays, FC_GROUP_LABELS83, FC_OLD_DAYS_KEY, FC_OLD_DAYS_DEFAULT, type FcCategory } from "./files-category";

export const FC_FLAG_KEY = "flag.files_carousel";
/** REL-83: category order (برگشتی → امضا → وثیقه/ضامن → قدیمی → بقیه) + list fallback + late-return bar. Seeded '0' (deploy = no-op). */
export const FC_CAT_FLAG_KEY = "flag.fc_categories";
export const FC_EVENTS = { prioritySet: "files_priority_set", followup: "files_followup_logged", rejected: "daily_plan_rejected" } as const;
export const FC_TEXT_MAX = 80, FC_NOTE_MAX = 80, FC_ROWS_MAX = 200, FC_CLOSE_MIN = 18 * 60;
export const FC_OUTCOME_LABELS: Record<string, string> = { answered: "جواب داد", no_answer: "جواب نداد", follow_up: "پیگیری بعدی", cancelled: "لغو شده" };
/** FILES-CANCEL (Armita crm-files-cards v1.3, scenes 10–13): a 4th result «لغو شده» with a required reason (≤120). */
export const FC_CANCEL = "cancelled", FC_CANCEL_REASON_MAX = 120;
export const FC_OUTCOMES: readonly string[] = [...CQ_OUTCOMES, FC_CANCEL];
export const FC_STAGE_LABELS: Record<string, string> = {
  funder_initial_approval: "تصویب مبلغ وام", draft: "پیش‌نویس",
  primary_contract_pending_signature: "در انتظار امضای قرارداد توسط مشتری", approved_contract_pending_signature: "امضای قرارداد جایگزین توسط مشتری",
  customer_documents_upload: "بارگذاری مدارک مشتری", customer_documents_review: "بررسی مدارک مشتری", guarantor_registration: "ثبت ضامن",
  guarantor_documents_upload: "بارگذاری مدارک ضامن", guarantor_documents_review: "بررسی مدارک ضامن", collateral_upload: "بارگذاری وثیقه",
  collateral_review: "بررسی وثیقه", physical_documents_correction: "رفع نقص مدارک فیزیکی", physical_documents_submission: "ارسال مدارک فیزیکی",
  physical_documents_review: "بررسی مدارک فیزیکی", expert_approval: "ثبت تصمیم تأمین‌کننده مالی", funder_documents_correction: "اصلاح مدارک مردود تأمین‌کننده",
  funder_result_review: "بررسی نتیجه تامین‌کننده", funder_amendment_pending_signature: "در انتظار امضای الحاقیه قرارداد", funder_amendment_review: "بررسی الحاقیه قرارداد",
  admin_approval: "تأیید نهایی مدیر و شارژ اعتبار", wallet_charge_pending: "در انتظار تأیید شارژ توسط کارشناس ثبت",
  final_invoice_pending_signature: "امضای صورت‌حساب نهایی", completed: "تکمیل شده",
};
const STAGE_BS: Record<string, string> = {
  funder_initial_approval: "waiting_registration", draft: "waiting_sales", primary_contract_pending_signature: "waiting_customer_signature",
  approved_contract_pending_signature: "waiting_customer_signature", customer_documents_upload: "waiting_sales", customer_documents_review: "waiting_registration",
  guarantor_registration: "waiting_sales", guarantor_documents_upload: "waiting_sales", guarantor_documents_review: "waiting_registration", collateral_upload: "waiting_sales",
  collateral_review: "waiting_registration", expert_approval: "waiting_registration", funder_amendment_pending_signature: "waiting_sales",
  funder_amendment_review: "waiting_registration", funder_result_review: "waiting_registration", funder_documents_correction: "waiting_sales",
  physical_documents_submission: "waiting_sales", physical_documents_review: "waiting_registration", physical_documents_correction: "waiting_sales",
  wallet_charge_pending: "waiting_wallet_charge", admin_approval: "waiting_wallet_charge", final_invoice_pending_signature: "wallet_charged", completed: "completed",
};
export const FC_BS_LABELS: Record<string, string> = {
  waiting_sales: "در انتظار اقدام کارشناس فروش", waiting_customer_signature: "در انتظار امضای قرارداد توسط مشتری", waiting_registration: "در انتظار اقدام کارشناس ثبت",
  waiting_funder_approval: "در انتظار تایید تامین‌کننده مالی", waiting_wallet_charge: "در انتظار تأیید شارژ توسط کارشناس ثبت", wallet_charged: "در انتظار تأیید نهایی مدیر",
};
/** Default order groups = the deck (Armita v1.1 chips; PM 10:31/10:35). Registrar/funder review and admin/wallet waits are NOT in the deck nor in M,
 *  except the pinned current card. Draft (incl. pre-registration) is the fourth group. */
export const FC_STAGE_GROUPS: string[][] = [
  ["primary_contract_pending_signature", "approved_contract_pending_signature", "funder_amendment_pending_signature", "final_invoice_pending_signature"],
  ["collateral_upload", "guarantor_registration", "guarantor_documents_upload"],
  ["customer_documents_upload", "physical_documents_submission", "physical_documents_correction", "funder_documents_correction"],
  ["draft"],
];
export const FC_GROUP_CODES = ["signature", "collateral", "documents", "draft"] as const;
export const FC_GROUP_LABELS: Record<string, string> = { signature: "امضا", collateral: "وثیقه", documents: "مدارک", draft: "پیش‌نویس", other: "سایر" };
export const fcExpertStep = (stage: string) => FC_STAGE_GROUPS.some(g => g.includes(stage));
const groupOf = (stage: string) => { const i = FC_STAGE_GROUPS.findIndex(g => g.includes(stage)); return i < 0 ? FC_STAGE_GROUPS.length : i; };

export type FcErr = { status: number; error: string; message: string; details?: any };
const err = (status: number, error: string, message: string, details?: any): FcErr => ({ status, error, message, ...(details !== undefined ? { details } : {}) });
export const fcIsErr = (x: any): x is FcErr => Boolean(x && typeof x === "object" && typeof x.status === "number" && typeof x.error === "string");

/* ---------------- flag / users / time ---------------- */
export const fcOn = (): boolean => { try { return cqRaw(FC_FLAG_KEY) === "1"; } catch { return false; } };
type U = { id: number; role: string; salespersonId: number | null };
export const fcTarget = (u: U | null | undefined): boolean =>
  Boolean(u && u.role === "salesperson" && EL_USERS[Number(u.id)] != null && Number(u.salespersonId) === EL_USERS[Number(u.id)]);
export const fcEnabledFor = (u: U | null | undefined) => fcTarget(u) && fcOn();
export const fcCatOn = (): boolean => { try { return cqRaw(FC_CAT_FLAG_KEY) === "1"; } catch { return false; } };
export const fcOldDaysNow = (): number => fcOldDays(cqRaw);
export const fcSpAllowed = (sp: number) => Object.values(EL_USERS).includes(sp);
export const fcToday = (now = new Date()) => tYmd(tParts(now));
const minOf = (now: Date) => { const p = tParts(now); return p.h * 60 + p.mi; };
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const noonOf = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return fromTehran(y, m, d, 12); };
const tehranText = (iso: string | null) => { if (!iso) return null; const p = tParts(new Date(iso));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`; };
const DIGITS = /[0-9\u06F0-\u06F9\u0660-\u0669]/;
const maskDigits = (s: string | null) => (s == null ? null : s.replace(/[0-9\u06F0-\u06F9\u0660-\u0669]/g, "•"));

/* ---------------- schema ---------------- */
let ready = false;
export function ensureFcSchema(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS fc_orders(id INTEGER PRIMARY KEY AUTOINCREMENT, salesperson_id INTEGER NOT NULL, day TEXT NOT NULL,
      version INTEGER NOT NULL, items_json TEXT NOT NULL, assistant_id INTEGER, set_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_fc_orders_sp_day ON fc_orders(salesperson_id, day, version);
    CREATE TABLE IF NOT EXISTS fc_days(salesperson_id INTEGER NOT NULL, day TEXT NOT NULL, started_at TEXT, current_file_id INTEGER, updated_at TEXT,
      PRIMARY KEY(salesperson_id, day));
    CREATE TABLE IF NOT EXISTS fc_followups(id INTEGER PRIMARY KEY AUTOINCREMENT, salesperson_id INTEGER NOT NULL, user_id INTEGER NOT NULL, day TEXT NOT NULL,
      file_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(salesperson_id, day, file_id));
    CREATE INDEX IF NOT EXISTS idx_fc_followups_file ON fc_followups(file_id, created_at);
    CREATE TABLE IF NOT EXISTS fc_presence(salesperson_id INTEGER NOT NULL, day TEXT NOT NULL, file_id INTEGER NOT NULL, present INTEGER NOT NULL,
      returned_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(salesperson_id, day, file_id));
    CREATE TABLE IF NOT EXISTS fc_cancels(id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, salesperson_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, reason TEXT NOT NULL, prev_status TEXT NOT NULL, prev_stage TEXT NOT NULL, created_at TEXT NOT NULL,
      uncancelled_at TEXT, uncancelled_by INTEGER, uncancel_note TEXT);
    CREATE INDEX IF NOT EXISTS idx_fc_cancels_file ON fc_cancels(file_id, id);`);
  execute("INSERT OR IGNORE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?, '0', NULL, ?)", [FC_FLAG_KEY, new Date().toISOString()]);
  // REL-83: additive only — new flag (off), the stale threshold, and the moment the expert's list opened today.
  execute("INSERT OR IGNORE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?, '0', NULL, ?)", [FC_CAT_FLAG_KEY, new Date().toISOString()]);
  execute("INSERT OR IGNORE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?, ?, NULL, ?)", [FC_OLD_DAYS_KEY, String(FC_OLD_DAYS_DEFAULT), new Date().toISOString()]);
  if (!queryRows<{ name: string }>("PRAGMA table_info(fc_days)").some(c => c.name === "list_opened_at")) crmDb.exec("ALTER TABLE fc_days ADD COLUMN list_opened_at TEXT");
  // REL-83 «پرونده برگشت خورد» (PM 6): a file returned while the expert's list was open keeps the badge until the expert opens that file.
  crmDb.exec(`CREATE TABLE IF NOT EXISTS fc_returns(salesperson_id INTEGER NOT NULL, file_id INTEGER NOT NULL, returned_at TEXT NOT NULL, reason_code TEXT,
      created_at TEXT NOT NULL, opened_at TEXT, PRIMARY KEY(salesperson_id, file_id, returned_at));`);
  ready = true;
}

/* ---------------- files ---------------- */
type FileRow = { id: number; customer_id: number; cur_customer_id: number; name: string | null; stage: string; status: string; plan_name: string | null;
  created_at: string; last_fc: string | null; last_fc_outcome: string | null; last_call: string | null; last_call_outcome: string | null };
const FILE_SELECT = `SELECT a.id, a.customer_id, cc.id cur_customer_id, cc.name, a.stage, a.status, p.name plan_name, a.created_at,
    (SELECT f.created_at FROM fc_followups f WHERE f.file_id=a.id ORDER BY f.created_at DESC, f.id DESC LIMIT 1) last_fc,
    (SELECT f.outcome FROM fc_followups f WHERE f.file_id=a.id ORDER BY f.created_at DESC, f.id DESC LIMIT 1) last_fc_outcome,
    (SELECT l.created_at FROM call_logs l WHERE l.customer_id=cc.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1) last_call,
    (SELECT l.outcome FROM call_logs l WHERE l.customer_id=cc.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1) last_call_outcome
  FROM loan_applications a JOIN customers c ON c.id=a.customer_id
  LEFT JOIN customer_merge_audit ma ON ma.source_customer_id=c.id AND ma.survivor_customer_id=c.merged_into_customer_id
  JOIN customers cc ON cc.id=CASE WHEN c.merged_into_customer_id IS NULL THEN c.id ELSE ma.survivor_customer_id END AND cc.merged_into_customer_id IS NULL
  LEFT JOIN loan_plans p ON p.id=COALESCE(a.plan_id, CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END)`;
/** PM 10:35 (Armita v1.1): drafts — incl. pre-registration drafts — stay in the deck with a «پیش‌نویس» chip. */
const OPEN_WHERE = `a.deleted_at IS NULL AND a.status<>'rejected' AND a.stage<>'completed'`;
function openFiles(sp: number): FileRow[] { ensureFcSchema(); return queryRows<FileRow>(`${FILE_SELECT} WHERE ${OPEN_WHERE} AND cc.salesperson_id=?`, [sp]); }
function fileById(id: number): (FileRow & { owner: number | null; open: number }) | null {
  ensureFcSchema();
  return queryRow<any>(`${FILE_SELECT.replace("SELECT a.id,", "SELECT cc.salesperson_id owner, CASE WHEN " + OPEN_WHERE + " THEN 1 ELSE 0 END open, a.id,")} WHERE a.id=?`, [id]) ?? null;
}
const lastFollowUp = (f: FileRow) => {
  const a = f.last_fc, b = f.last_call; if (!a && !b) return null;
  const useFc = Boolean(a && (!b || a >= b));
  const at = useFc ? a! : b!; const outcome = useFc ? f.last_fc_outcome : f.last_call_outcome;
  return { at, atTehran: tehranText(at), source: useFc ? "files_followup" : "call_log", outcome: outcome || null, outcomeLabel: outcome ? FC_OUTCOME_LABELS[outcome] ?? null : null };
};
const lastAt = (f: FileRow) => lastFollowUp(f)?.at ?? "";
export const fcDefaultCompare = (x: FileRow, y: FileRow) => groupOf(x.stage) - groupOf(y.stage) || lastAt(x).localeCompare(lastAt(y)) || x.id - y.id;

type OrderRow = { fileId: number; reason: string; ask: string };
function latestOrder(sp: number, day: string): { version: number; items: OrderRow[]; set_at: string; assistant_id: number | null } | null {
  const r = queryRow<{ version: number; items_json: string; set_at: string; assistant_id: number | null }>(
    "SELECT version,items_json,set_at,assistant_id FROM fc_orders WHERE salesperson_id=? AND day=? ORDER BY version DESC LIMIT 1", [sp, day]);
  return r ? { version: Number(r.version), items: JSON.parse(r.items_json), set_at: r.set_at, assistant_id: r.assistant_id } : null;
}
type FcDay = { started_at: string | null; current_file_id: number | null; list_opened_at: string | null };
const dayRow = (sp: number, day: string): FcDay | null => queryRow<FcDay>("SELECT started_at,current_file_id,list_opened_at FROM fc_days WHERE salesperson_id=? AND day=?", [sp, day]) ?? null;
type Fu = { file_id: number; customer_id: number; outcome: string; note: string; created_at: string; user_id: number };
const followupsOf = (sp: number, day: string) => queryRows<Fu>("SELECT file_id,customer_id,outcome,note,created_at,user_id FROM fc_followups WHERE salesperson_id=? AND day=? ORDER BY created_at, id", [sp, day]);

/** The deck for (sp, day), rebuilt fresh each day:
 *  done today (follow-up order) → current (pinned; never leaves) → files that came back to the expert today (in return order)
 *  → the assistant's order → the default order. Only expert-step files are pending. */
export function fcDeck(sp: number, day: string, now = new Date()) {
  ensureFcSchema();
  const all = openFiles(sp); const fus = followupsOf(sp, day); const doneIds = new Set(fus.map(f => f.file_id));
  const byId = new Map<number, FileRow>(all.map(f => [f.id, f]));
  for (const fu of fus) if (!byId.has(fu.file_id)) { const f = fileById(fu.file_id); if (f) byId.set(f.id, f); }
  const catMode = fcCatOn();
  const cats: Map<number, FcCategory> = catMode ? fcCategories([...byId.keys()], now, fcOldDaysNow()) : new Map();
  const d = dayRow(sp, day); const at = now.toISOString();
  // REL-83: once the list has opened today, nothing new becomes a card (no lock); late returns go to the bar instead.
  const listOpenedAt = catMode ? d?.list_opened_at ?? null : null;
  const step = all.filter(f => catMode ? Boolean(cats.get(f.id)?.card) : fcExpertStep(f.stage));
  const returned = new Map<number, string>();
  if (d?.started_at) {
    const pres = new Map(queryRows<{ file_id: number; present: number; returned_at: string | null }>(
      "SELECT file_id,present,returned_at FROM fc_presence WHERE salesperson_id=? AND day=?", [sp, day]).map(r => [Number(r.file_id), r]));
    const initial = pres.size === 0; const stepIds = new Set(step.map(f => f.id));
    for (const f of step) {
      const r = pres.get(f.id);
      if (!r) execute("INSERT OR IGNORE INTO fc_presence(salesperson_id,day,file_id,present,returned_at,updated_at) VALUES(?,?,?,1,?,?)", [sp, day, f.id, initial ? null : at, at]);
      else if (!Number(r.present)) execute("UPDATE fc_presence SET present=1, returned_at=?, updated_at=? WHERE salesperson_id=? AND day=? AND file_id=?", [at, at, sp, day, f.id]);
      const ra = !r ? (initial ? null : at) : (!Number(r.present) ? at : r.returned_at);
      if (ra) returned.set(f.id, ra);
    }
    for (const [fid, r] of pres) if (Number(r.present) && !stepIds.has(fid))
      execute("UPDATE fc_presence SET present=0, updated_at=? WHERE salesperson_id=? AND day=? AND file_id=?", [at, sp, day, fid]);
  }
  const ord = latestOrder(sp, day); const pos = new Map<number, number>(); const meta = new Map<number, OrderRow>();
  ord?.items.forEach((r, i) => { pos.set(r.fileId, i); meta.set(r.fileId, r); });
  const rank = (x: FileRow, y: FileRow) => {
    if (catMode) { const cx = cats.get(x.id)!, cy = cats.get(y.id)!; const g = cx.priority_group - cy.priority_group || cx.sub_rank - cy.sub_rank; if (g) return g; }
    const rx = returned.get(x.id), ry = returned.get(y.id);
    if (rx && ry) return rx.localeCompare(ry) || x.id - y.id; if (rx) return -1; if (ry) return 1;
    const px = pos.get(x.id), py = pos.get(y.id);
    if (px != null && py != null) return px - py; if (px != null) return -1; if (py != null) return 1;
    return catMode ? fcInGroupCompare({ id: x.id, c: cats.get(x.id)! }, { id: y.id, c: cats.get(y.id)! }) : fcDefaultCompare(x, y); };
  let current: number | null = null;
  if (d?.started_at) {
    // PM 10:31: the current card never leaves the deck (even if its step moves away or the file closes mid-card).
    let pinnedOk = d.current_file_id != null && !doneIds.has(d.current_file_id);
    if (pinnedOk && !byId.has(d.current_file_id!)) { const f = fileById(d.current_file_id!); if (f && Number(f.owner) === sp) byId.set(f.id, f); else pinnedOk = false; }
    if (pinnedOk) current = d.current_file_id;
    else if (listOpenedAt) current = null;
    else {
      current = step.filter(f => !doneIds.has(f.id)).sort(rank)[0]?.id ?? null;
    }
    if (current !== d.current_file_id) execute("UPDATE fc_days SET current_file_id=?, updated_at=? WHERE salesperson_id=? AND day=?", [current, at, sp, day]);
  } else {
    current = null;
  }
  const pending = listOpenedAt ? [] : step.filter(f => !doneIds.has(f.id) && f.id !== current).sort(rank);
  // REL-83: the deck ran out (or was empty) after the day started → the list opens for the rest of the day.
  let listOpen = Boolean(listOpenedAt);
  if (catMode && d?.started_at && !listOpenedAt && current == null && pending.length === 0) {
    executeChanges("UPDATE fc_days SET list_opened_at=?, updated_at=? WHERE salesperson_id=? AND day=? AND list_opened_at IS NULL", [at, at, sp, day]);
    listOpen = true;
  }
  // REL-83 (ج): a file the registrar returns after the list opened → recorded once in fc_returns (bar + «پرونده برگشت خورد» until opened).
  if (catMode && listOpen) {
    const since = listOpenedAt ?? at;
    for (const f of all) { const c = cats.get(f.id);
      if (c?.priority_category === "returned" && c.returned_at && c.returned_at > since && !doneIds.has(f.id))
        execute("INSERT OR IGNORE INTO fc_returns(salesperson_id,file_id,returned_at,reason_code,created_at) VALUES(?,?,?,?,?)", [sp, f.id, c.returned_at, c.return_type, at]); }
  }
  const lateReturns = !catMode || !listOpen ? [] : fcUnseenReturns(sp).map(r => byId.get(Number(r.file_id))).filter((f): f is FileRow => Boolean(f) && cats.get(f!.id)?.priority_category === "returned");
  const seq: { f: FileRow; state: "done" | "current" | "pending" }[] = [
    ...fus.map(fu => ({ f: byId.get(fu.file_id)!, state: "done" as const })).filter(x => x.f),
    ...(current != null ? [{ f: byId.get(current)!, state: "current" as const }] : []),
    ...pending.map(f => ({ f, state: "pending" as const })),
  ];
  const fuBy = new Map(fus.map(f => [f.file_id, f]));
  return { ord, current, returned, catMode, cats, listOpen, lateReturns, pos,
    cards: seq.map((x, i) => ({ ...x, position: i + 1, returnedToday: returned.has(x.f.id), meta: meta.get(x.f.id) ?? null, fu: fuBy.get(x.f.id) ?? null, cat: cats.get(x.f.id) ?? null })), doneCount: fus.length };
}
const fileCore = (f: FileRow) => {
  const bs = STAGE_BS[f.stage] ?? f.stage;
  const g = FC_GROUP_CODES[groupOf(f.stage)] ?? "other";
  return { fileId: f.id, customerId: Number(f.cur_customer_id), type: "loan_application", typeLabel: "درخواست تسهیلات", group: g, groupLabel: FC_GROUP_LABELS[g], stage: f.stage, stageLabel: FC_STAGE_LABELS[f.stage] ?? f.stage,
    status: f.status, isDraft: f.stage === "draft", businessStatus: bs, businessStatusLabel: FC_BS_LABELS[bs] ?? null, planName: f.plan_name ?? null, createdAt: f.created_at, lastFollowUp: lastFollowUp(f) };
};

/** REL-83 category fields, HANDOFF v1.0.1 (null while flag.fc_categories is off). return_note = the registrar's own comment, one line, digits masked. */
export const catCore = (c: FcCategory | null | undefined) => c ? { priority_group: c.priority_group, priority_category: c.priority_category, sub_rank: c.sub_rank,
  label_main: c.label_main, label_detail: c.label_detail, label: c.label, return_type: c.return_type, return_note: c.return_note,
  returned_at: c.returned_at, returned_by: c.returned_by, return_source: c.return_source, signature_type: c.signature_type, signature_status: c.signature_status, signature_sent_at: c.signature_sent_at,
  signature_reject_reason: c.signature_reject_reason, pending_signature_count: c.pending_signature_count, pending_item: c.pending_item,
  last_activity_at: c.last_activity_at, idle_days: c.idle_days } : null;
type URow = { file_id: number; returned_at: string; reason_code: string | null };
export const fcUnseenReturns = (sp: number): URow[] => { ensureFcSchema();
  return queryRows<URow>("SELECT file_id, MAX(returned_at) returned_at, MAX(reason_code) reason_code FROM fc_returns WHERE salesperson_id=? AND opened_at IS NULL GROUP BY file_id ORDER BY MAX(returned_at), file_id", [sp]); };

/** Expert payload: no stageLabel / businessStatusLabel / planName on the card (Armita v1.1: they can contain «قرارداد» or rates). */
const expertCore = (f: FileRow) => { const { stageLabel: _s, businessStatusLabel: _b, planName: _p, ...rest } = fileCore(f); return rest; };

/* ---------------- events ---------------- */
function event(assistantId: number | null, type: string, userId: number | null, data: any, at: string) {
  if (assistantId == null || !queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='assistant_events'")) return;
  execute("INSERT INTO assistant_events(assistant_id,type,thread_id,user_id,customer_id,message_id,data_json,created_at) VALUES(?,?,NULL,?,NULL,NULL,?,?)",
    [assistantId, type, userId, JSON.stringify(data), at]);
}
const assistantOfSp = (sp: number): number | null => queryRow<{ id: number }>(
  "SELECT id FROM assistants WHERE kind='sales' AND COALESCE(scope_rule,'')<>'manager' AND bound_salesperson_id=? ORDER BY id LIMIT 1", [sp])?.id ?? null;

/* ---------------- assistant runner ---------------- */
type Asst = { id: number; display_name?: string | null; bound_user_id: number | null; bound_salesperson_id: number | null };
function expertSp(a: Asst): number | FcErr {
  const sp = Number(a.bound_salesperson_id);
  if (!a.bound_salesperson_id || !fcSpAllowed(sp)) return err(422, "expert_not_eligible", "این دستیار به کارشناسی با «پرونده‌های من» تک‌کارتی بسته نیست.");
  return sp;
}
export function fcAssistantOpen(a: Asst, now = new Date()) {
  const sp = expertSp(a); if (fcIsErr(sp)) return sp;
  const day = fcToday(now); const deck = fcDeck(sp, day, now);
  const name = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [sp])?.name ?? null;
  return { date: day, expert: { salespersonId: sp, name }, orderSource: deck.ord ? "assistant" : "default", orderSetAt: deck.ord?.set_at ?? null, orderVersion: deck.ord?.version ?? 0,
    total: deck.cards.length, done: deck.doneCount, currentFileId: deck.current,
    mode: deck.listOpen ? "list" : "cards", lateReturns: deck.lateReturns.map(f => ({ fileId: f.id, maskedName: maskCustomerName(f.name), fc: catCore(deck.cats.get(f.id)) })),
    items: deck.cards.map(c => ({ ...fileCore(c.f), maskedName: maskCustomerName(c.f.name), position: c.position, state: c.state, returnedToday: c.returnedToday, fc: catCore(c.cat),
      reason: c.meta?.reason ?? null, ask: c.meta?.ask ?? null,
      todayFollowUp: c.fu ? { at: c.fu.created_at, atTehran: tehranText(c.fu.created_at), outcome: c.fu.outcome, outcomeLabel: FC_OUTCOME_LABELS[c.fu.outcome] ?? null } : null })) };
}
const lineErr = (v: unknown, f: string): any => {
  if (typeof v !== "string") return { code: v == null ? "field_required" : "bad_type", field: f };
  const t = v.trim(); if (!t) return { code: "field_required", field: f };
  if (/[\r\n]/.test(t)) return { code: "multi_line", field: f };
  if ([...t].length > FC_TEXT_MAX) return { code: "field_too_long", field: f, max: FC_TEXT_MAX };
  if (DIGITS.test(t)) return { code: "note_has_digits", field: f };
  return null;
};
export function fcAssistantPriority(a: Asst, dayIn: unknown, body: any, now = new Date()) {
  const sp = expertSp(a); if (fcIsErr(sp)) return sp;
  const today = fcToday(now);
  if (!isYmd(dayIn) || dayIn !== today) return err(422, "date_not_allowed", "فقط امروز.", { today });
  if (!isWorkDay(tParts(noonOf(today)))) return err(409, "holiday", "امروز تعطیل است.");
  if (minOf(now) >= FC_CLOSE_MIN) return err(409, "after_close", "بعد از ساعت ۱۸ ترتیب امروز بسته است.");
  const raw = body?.items;
  if (!Array.isArray(raw) || raw.length === 0) return err(422, "bad_type", "items باید آرایه‌ی غیرخالی باشد.", { field: "items" });
  if (raw.length > FC_ROWS_MAX) return err(422, "too_many_rows", "حداکثر ۲۰۰ ردیف.", { max: FC_ROWS_MAX });
  const open = new Map(openFiles(sp).map(f => [f.id, f]));
  // REL-83: with categories on, any card-eligible file (cat 1–4, or cat 5 at an expert step) can be ordered; the order applies inside its category only.
  const cardOk = fcCatOn() ? new Set([...fcCategories([...open.keys()], now, fcOldDaysNow())].filter(([, c]) => c.card).map(([id]) => id)) : null;
  const errors: any[] = []; const rows: OrderRow[] = []; const seen = new Set<number>();
  raw.forEach((r: any, i: number) => {
    const fid = Number(r?.fileId);
    if (!r || typeof r !== "object" || !Number.isSafeInteger(fid) || fid <= 0) { errors.push({ row: i, code: "bad_type", field: "fileId" }); return; }
    if (seen.has(fid)) { errors.push({ row: i, code: "duplicate_file", fileId: fid }); return; }
    seen.add(fid);
    if (!open.has(fid)) {
      const f = fileById(fid);
      if (!f) errors.push({ row: i, code: "unknown_file", fileId: fid });
      else if (Number(f.owner) !== sp) errors.push({ row: i, code: "file_not_owned", fileId: fid });
      else errors.push({ row: i, code: "file_not_open", fileId: fid });
      return;
    }
    if (!(cardOk ? cardOk.has(fid) : fcExpertStep(open.get(fid)!.stage))) { errors.push({ row: i, code: "file_not_with_expert", fileId: fid }); return; }
    const e1 = lineErr(r.reason, "reason"); if (e1) { errors.push({ row: i, fileId: fid, ...e1 }); return; }
    const e2 = lineErr(r.ask, "ask"); if (e2) { errors.push({ row: i, fileId: fid, ...e2 }); return; }
    rows.push({ fileId: fid, reason: String(r.reason).trim(), ask: String(r.ask).trim() });
  });
  if (errors.length) return err(422, "invalid_rows", "بعضی ردیف‌ها پذیرفته نشد؛ هیچ ردیفی ذخیره نشد.", { rows: errors });
  const at = now.toISOString(); const version = (latestOrder(sp, today)?.version ?? 0) + 1;
  const before = fcDeck(sp, today, now);
  execute("INSERT INTO fc_orders(salesperson_id,day,version,items_json,assistant_id,set_at) VALUES(?,?,?,?,?,?)", [sp, today, version, JSON.stringify(rows), a.id, at]);
  const deck = fcDeck(sp, today, now);
  const listed = new Set(rows.map(r => r.fileId));
  const appended = deck.cards.filter(c => c.state === "pending" && !listed.has(c.f.id)).map(c => c.f.id);
  const doneListed = rows.filter(r => deck.cards.some(c => c.f.id === r.fileId && c.state === "done")).map(r => r.fileId);
  const summary = { salespersonId: sp, date: today, version, count: rows.length, currentUntouched: before.current, appended: appended.length };
  event(a.id, FC_EVENTS.prioritySet, a.bound_user_id, summary, at);
  try { if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='assistant_audit'"))
    execute("INSERT INTO assistant_audit(at,assistant_id,token_id,user_id,ip,actor_label,action,customer_id,outcome,detail_json) VALUES(?,?,NULL,?,NULL,?,?,NULL,?,?)",
    [at, a.id, a.bound_user_id, `دستیار ${a.display_name ?? a.id}`, "PUT /files/priority", "ok", JSON.stringify(summary)]); } catch { /* audit must never break the write */ }
  return { ok: true, date: today, version, currentUntouched: before.current, doneToday: doneListed, appendedByDefault: appended,
    order: deck.cards.map(c => ({ fileId: c.f.id, state: c.state })) };
}
export function fcAssistantFollowups(a: Asst, dayIn: unknown, now = new Date()) {
  const sp = expertSp(a); if (fcIsErr(sp)) return sp;
  ensureFcSchema();
  const day = dayIn == null || dayIn === "" ? fcToday(now) : dayIn;
  if (!isYmd(day)) return err(422, "date_not_allowed", "تاریخ معتبر نیست.");
  const rows = queryRows<Fu & { name: string | null }>(`SELECT f.file_id,f.customer_id,f.outcome,f.note,f.created_at,f.user_id,c.name FROM fc_followups f
    LEFT JOIN customers c ON c.id=f.customer_id WHERE f.salesperson_id=? AND f.day=? ORDER BY f.created_at, f.id`, [sp, day]);
  return { date: day, items: rows.map(r => ({ fileId: Number(r.file_id), customerId: Number(r.customer_id), maskedName: maskCustomerName(r.name), outcome: r.outcome,
    outcomeLabel: FC_OUTCOME_LABELS[r.outcome] ?? null, note: maskDigits(r.note), at: r.created_at, atTehran: tehranText(r.created_at) })) };
}

/* ---------------- expert ---------------- */
/** f_empty «منتظر دیگران» (PM 10:57): open files of the expert NOT in the deck, counted per waiting group. Counts only — no names/stage labels/amounts. */
export const FC_WAIT_GROUPS: Array<{ code: string; label: string; stages: string[] }> = [
  { code: "registrar", label: "ثبت‌کننده", stages: ["customer_documents_review", "guarantor_documents_review", "collateral_review", "physical_documents_review"] },
  { code: "funder", label: "تأمین‌کننده", stages: ["funder_initial_approval", "expert_approval", "funder_result_review", "funder_amendment_review"] },
  { code: "admin", label: "ادمین", stages: ["admin_approval"] },
  { code: "wallet", label: "کیف پول", stages: ["wallet_charge_pending"] },
];
function fcWaiting(sp: number, deckIds: Set<number>) {
  const cnt = new Map<string, number>();
  for (const f of openFiles(sp)) {
    if (deckIds.has(f.id) || fcExpertStep(f.stage)) continue;
    const g = FC_WAIT_GROUPS.find(w => w.stages.includes(f.stage))?.code ?? "other";
    cnt.set(g, (cnt.get(g) ?? 0) + 1);
  }
  const groups = [...FC_WAIT_GROUPS.map(w => ({ code: w.code, label: w.label })), { code: "other", label: "سایر" }]
    .map(w => ({ ...w, count: cnt.get(w.code) ?? 0 })).filter(w => w.count > 0);
  return { total: groups.reduce((a, w) => a + w.count, 0), groups };
}
export function fcExpertView(u: U, now = new Date()) {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const day = fcToday(now); const at = now.toISOString();
  execute("INSERT OR IGNORE INTO fc_days(salesperson_id,day,started_at,current_file_id,updated_at) VALUES(?,?,?,NULL,?)", [sp, day, at, at]);
  const deck = fcDeck(sp, day, now);
  const curCust = deck.current == null ? null : deck.cards.find(c => c.f.id === deck.current)!.f.cur_customer_id;
  const phone = curCust == null ? null : queryRow<{ phone: string | null }>("SELECT phone FROM customers WHERE id=? AND salesperson_id=?", [curCust, sp])?.phone ?? null;
  const idx = deck.current == null ? null : deck.cards.findIndex(c => c.f.id === deck.current) + 1;
  return { enabled: true, date: day, total: deck.cards.length, done: deck.doneCount, index: idx, currentFileId: deck.current,
    // REL-83 (flag.fc_categories): mode «list» = cards ran out / none → the UI opens the full list (GET /files-carousel/list); lateReturns = the bar (no lock).
    categories: deck.catMode, mode: deck.catMode && deck.listOpen ? "list" : "cards",
    lateReturns: deck.lateReturns.map(f => { const c = deck.cats.get(f.id)!; return { type: "file_returned", file_id: f.id, customer_name: f.name ?? "", return_type: c.return_type, return_note: c.return_note, returned_at: c.returned_at, return_source: c.return_source }; }),
    orderSource: deck.ord ? "assistant" : "default", waiting: fcWaiting(sp, new Set(deck.cards.map(c => c.f.id))), outcomes: FC_OUTCOMES.map(o => ({ code: o, label: FC_OUTCOME_LABELS[o] })), noteMax: FC_NOTE_MAX, cancelReasonMax: FC_CANCEL_REASON_MAX,
    cards: deck.cards.map(c => ({ ...expertCore(c.f), customerName: c.f.name ?? "", phone: c.state === "current" ? phone : null, returnedToday: c.returnedToday, position: c.position, state: c.state, reason: c.meta?.reason ?? null, ask: c.meta?.ask ?? null, fc: catCore(c.cat),
      todayFollowUp: c.fu ? { at: c.fu.created_at, outcome: c.fu.outcome, outcomeLabel: FC_OUTCOME_LABELS[c.fu.outcome] ?? null, note: c.fu.note } : null })) };
}
export function fcExpertFollowup(u: U, body: any, now = new Date()) {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const day = fcToday(now);
  const fid = Number(body?.fileId); const outcome = String(body?.outcome ?? ""); const cx = outcome === FC_CANCEL;
  const note = cx ? (typeof body?.cancelReason === "string" ? body.cancelReason.replace(/\s+/g, " ").trim() : "") : (typeof body?.note === "string" ? body.note.trim() : "");
  if (!Number.isSafeInteger(fid) || fid <= 0) return err(400, "bad_type", "fileId", { field: "fileId" });
  if (!FC_OUTCOMES.includes(outcome)) return err(422, "bad_outcome", "نتیجه را انتخاب کن.", { allowed: FC_OUTCOMES });
  if (cx) {
    if (!note) return err(422, "reason_required", "دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود.", { field: "cancelReason" });
    if ([...note].length > FC_CANCEL_REASON_MAX) return err(422, "field_too_long", "دلیل لغو حداکثر ۱۲۰ نویسه است.", { field: "cancelReason", max: FC_CANCEL_REASON_MAX });
  } else {
    if (!note) return err(422, "note_required", "یادداشت یک‌خطی لازم است.", { field: "note" });
    if (/[\r\n]/.test(note)) return err(422, "multi_line", "یادداشت باید یک خط باشد.", { field: "note" });
    if ([...note].length > FC_NOTE_MAX) return err(422, "field_too_long", "یادداشت حداکثر ۸۰ نویسه است.", { field: "note", max: FC_NOTE_MAX });
  }
  if (cx) { const f = fileById(fid); if (f && Number(f.owner) !== sp) return err(403, "not_own_file", "فقط پرونده‌ی مشتری خودت را می‌توانی لغو کنی."); }
  if (queryRow("SELECT 1 x FROM fc_followups WHERE salesperson_id=? AND day=? AND file_id=?", [sp, day, fid])) return err(409, "already_done", "نتیجه‌ی این پرونده امروز ثبت شده است.");
  execute("INSERT OR IGNORE INTO fc_days(salesperson_id,day,started_at,current_file_id,updated_at) VALUES(?,?,?,NULL,?)", [sp, day, now.toISOString(), now.toISOString()]);
  const deck = fcDeck(sp, day, now);
  let card: { f: FileRow; state: "done" | "current" | "pending" } | undefined = deck.cards.find(c => c.f.id === fid);
  // REL-83 (ب): once the list is open, «پیگیری» works on any OWN file of the list (no lock; one result per file per day).
  // v1.0.1 PM 5: completed / cancelled rows keep today's access — a result + note is fine, «لغو» of an already closed file is not.
  if (!card && deck.catMode && deck.listOpen) { const f = fileById(fid);
    if (f && Number(f.owner) === sp) { if (cx && !f.open) return err(409, "case_already_closed", "این پرونده بسته است.", { fileId: fid }); card = { f, state: "current" }; } }
  // REL-83: «لغو» of an own file that is already closed is always 409 under the categories flag (list open or not).
  if (!card && cx && deck.catMode) { const f = fileById(fid); if (f && Number(f.owner) === sp && !f.open) return err(409, "case_already_closed", "این پرونده بسته است.", { fileId: fid }); }
  if (!card) return err(404, "file_not_found", "این پرونده در کارهای امروزت نیست.");

  // HOTFIX-77h (Mohammad 17:11 Tehran «کارشناس فروشم بذار لغو کنه پرونده رو»): «لغو شده» works on any OWN open card of today's deck
  // (current or pending); the other outcomes still need the current card.
  if (card.state === "done" || (!cx && card.state !== "current")) return err(409, "not_current", "اول نتیجه‌ی پرونده‌ی جاری را ثبت کن.", { currentFileId: deck.current });
  const at = now.toISOString();
  const isCur = deck.current === fid;
  if (cx) {
    // Own current file only; the existing «لغو پرونده» status (loan_applications.status='rejected' + stage history 'cancel-case' with the reason).
    // Contracts, stage, amounts, wallet and customer stay untouched; no SMS/Bale; the trigger-made case-change bells are removed in the same transaction.
    const r = runImmediateTransaction(() => {
      const a = queryRow<{ status: string; stage: string; owner: number | null }>(
        "SELECT a.status, a.stage, cc.salesperson_id owner FROM loan_applications a JOIN customers cc ON cc.id=? WHERE a.id=? AND a.deleted_at IS NULL", [Number(card.f.cur_customer_id), fid]);
      if (!a || Number(a.owner) !== sp) return err(403, "not_own_file", "فقط پرونده‌ی مشتری خودت را می‌توانی لغو کنی.");
      if (queryRow("SELECT 1 x FROM fc_followups WHERE salesperson_id=? AND day=? AND file_id=?", [sp, day, fid])) return err(409, "already_done", "نتیجه‌ی این پرونده امروز ثبت شده است.");
      if (a.status === "rejected") {
        // HOTFIX-77h: the file was already closed elsewhere (e.g. admin «لغو پرونده» on the file page) while it stayed pinned as the
        // expert's current card (PM 10:31). Before: 409 case_already_closed and the card stuck. Now: the expert's «لغو شده» is recorded
        // as today's result (reason kept in fc_followups), the card leaves and the next one opens; status/history/contracts untouched.
        execute("INSERT INTO fc_followups(salesperson_id,user_id,day,file_id,customer_id,outcome,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
          [sp, Number(u.id), day, fid, Number(card.f.cur_customer_id), outcome, note, at]);
        if (isCur) executeChanges("UPDATE fc_days SET current_file_id=NULL, updated_at=? WHERE salesperson_id=? AND day=?", [at, sp, day]);
        return null;
      }
      const preMax = Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0);
      if (executeChanges("UPDATE loan_applications SET status='rejected', updated_at=? WHERE id=? AND status<>'rejected' AND deleted_at IS NULL", [at, fid]) !== 1)
        return err(409, "case_already_closed", "این پرونده قبلاً بسته شده است.");
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [fid, a.stage, a.stage, "cancel-case", note, Number(u.id), at]);
      execute("INSERT INTO fc_cancels(file_id,customer_id,salesperson_id,user_id,reason,prev_status,prev_stage,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [fid, Number(card.f.cur_customer_id), sp, Number(u.id), note, a.status, a.stage, at]);
      execute("INSERT INTO fc_followups(salesperson_id,user_id,day,file_id,customer_id,outcome,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [sp, Number(u.id), day, fid, Number(card.f.cur_customer_id), outcome, note, at]);
      if (isCur) executeChanges("UPDATE fc_days SET current_file_id=NULL, updated_at=? WHERE salesperson_id=? AND day=?", [at, sp, day]);
      executeChanges("DELETE FROM site_notification_events WHERE id>? AND resource_type='loan' AND resource_id=?", [preMax, fid]);
      return null;
    });
    if (r) return r;
  } else {
  execute("INSERT INTO fc_followups(salesperson_id,user_id,day,file_id,customer_id,outcome,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [sp, Number(u.id), day, fid, Number(card.f.cur_customer_id), outcome, note, at]);
  executeChanges("UPDATE fc_days SET current_file_id=NULL, updated_at=? WHERE salesperson_id=? AND day=?", [at, sp, day]);
  }
  event(assistantOfSp(sp), FC_EVENTS.followup, Number(u.id), { salespersonId: sp, date: day, fileId: fid, outcome }, at);
  return { ok: true, fileId: fid, view: fcExpertView(u, now) };
}
/** FILES-CANCEL: admin-only «برگرداندن لغو» (no expert UI). Restores the status the file had before a «لغو شده» from «پرونده‌های من»;
 *  only when the file is still closed by that same cancellation (no later close). History entry 'uncancel-case'. No bell, SMS or Bale. */
export function fcAdminUncancel(u: U, fileIdIn: unknown, body: any, now = new Date()) {
  ensureFcSchema();
  if (!u || u.role !== "admin") return err(403, "admin_only", "برگرداندن لغو فقط با ادمین است.");
  const fid = Number(fileIdIn); if (!Number.isSafeInteger(fid) || fid <= 0) return err(404, "file_not_found", "پرونده پیدا نشد.");
  const note = typeof body?.reason === "string" ? body.reason.replace(/\s+/g, " ").trim() : "";
  if ([...note].length > 200) return err(422, "field_too_long", "توضیح حداکثر ۲۰۰ نویسه است.", { field: "reason", max: 200 });
  const at = now.toISOString();
  return runImmediateTransaction(() => {
    const a = queryRow<{ status: string; stage: string }>("SELECT status, stage FROM loan_applications WHERE id=? AND deleted_at IS NULL", [fid]);
    if (!a) return err(404, "file_not_found", "پرونده پیدا نشد.");
    const c = queryRow<{ id: number; prev_status: string; created_at: string; uncancelled_at: string | null }>("SELECT id, prev_status, created_at, uncancelled_at FROM fc_cancels WHERE file_id=? ORDER BY id DESC LIMIT 1", [fid]);
    if (!c || c.uncancelled_at || a.status !== "rejected") return err(409, "not_cancelled", "این پرونده از «پرونده‌های من» لغو نشده است.");
    const later = queryRow("SELECT 1 x FROM loan_application_stage_history WHERE application_id=? AND created_at>? AND action<>'case-note-added'", [fid, c.created_at]);
    if (later) return err(409, "changed_after_cancel", "بعد از لغو، پرونده تغییر کرده است؛ از صفحه‌ی مدیریت پرونده اقدام کن.");
    const preMax = Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0);
    executeChanges("UPDATE loan_applications SET status=?, updated_at=? WHERE id=? AND status='rejected'", [c.prev_status, at, fid]);
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
      [fid, a.stage, a.stage, "uncancel-case", JSON.stringify({ reason: note || null, restoredStatus: c.prev_status, cancelId: Number(c.id) }), Number(u.id), at]);
    executeChanges("UPDATE fc_cancels SET uncancelled_at=?, uncancelled_by=?, uncancel_note=? WHERE id=?", [at, Number(u.id), note || null, c.id]);
    executeChanges("DELETE FROM site_notification_events WHERE id>? AND resource_type='loan' AND resource_id=?", [preMax, fid]);
    return { ok: true as const, fileId: fid, status: c.prev_status, stage: a.stage };
  });
}
/** While ON: writes on a file still waiting in the deck (pending: not current, not done today) → 423 (reads stay open). */
export function fcWriteLocked(u: U, fileId: number, now = new Date()): boolean {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const day = fcToday(now);
  const f = fileById(fileId); if (!f || !f.open || Number(f.owner) !== sp) return false;
  if (queryRow("SELECT 1 x FROM fc_followups WHERE salesperson_id=? AND day=? AND file_id=?", [sp, day, fileId])) return false;
  const d = dayRow(sp, day); if (!d?.started_at) return false;
  const deck = fcDeck(sp, day, now);
  // only files waiting in the deck are locked; files whose step is elsewhere (review/admin/wallet) are not the carousel's business.
  return deck.cards.some(c => c.f.id === fileId && c.state === "pending");
}

/** Express guard (after expertLockdownGuard): users 8/2/3 while ON — a write on another open file of theirs (not current, not done today) → 423 files_locked. */
export function filesCarouselGuard(req: any, res: any, next: any): void {
  const u = res.locals.authUser as U | undefined;
  if (fcTarget(u) && req.method === "GET") {
    const o = /^\/loan-applications\/(\d+)$/.exec(req.path);
    if (o) try { if (fcOn() && fcCatOn()) { const f = fileById(Number(o[1])); if (f && Number(f.owner) === Number(u!.salespersonId)) fcMarkOpened(Number(u!.salespersonId), f.id); } } catch { /* never block */ }
  }
  if (!fcTarget(u) || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }
  const m = /^\/loan-applications\/(\d+)(\/|$)/.exec(req.path);
  if (!m || !fcOn()) { next(); return; }
  try {
    if (fcWriteLocked(u!, Number(m[1]))) {
      res.status(423).json({ error: "files_locked", message: "اول نتیجه‌ی پیگیری پرونده‌ی جاری را ثبت کن؛ این پرونده هنوز نوبتش نشده.", details: { fileId: Number(m[1]) } }); return;
    }
  } catch { /* never block on a guard error */ }
  next();
}

/** REL-83 full list order (HANDOFF sort): priority_group → sub_rank → (groups 1–5: returned today → today's assistant order) → sort_at → file_id.
 *  Inside groups 1–5 the assistant's order still applies (Mohammad: the assistant's order only inside a category), so cards and list agree. Read-only. */
export function fcListOrder(sp: number, ids: number[], now = new Date()): { order: number[]; cats: Map<number, FcCategory> } {
  ensureFcSchema();
  const day = fcToday(now); const cats = fcCategories(ids, now, fcOldDaysNow());
  const ord = latestOrder(sp, day); const pos = new Map<number, number>(); ord?.items.forEach((r, i) => pos.set(r.fileId, i));
  const ret = new Map(queryRows<{ file_id: number; returned_at: string | null }>("SELECT file_id,returned_at FROM fc_presence WHERE salesperson_id=? AND day=? AND present=1 AND returned_at IS NOT NULL", [sp, day]).map(r => [Number(r.file_id), r.returned_at!]));
  const order = [...ids].filter(id => cats.has(id)).sort((x, y) => {
    const cx = cats.get(x)!, cy = cats.get(y)!;
    const g = cx.priority_group - cy.priority_group || cx.sub_rank - cy.sub_rank; if (g) return g;
    if (cx.priority_group <= 5) {
      const rx = ret.get(x), ry = ret.get(y); if (rx && ry) return rx.localeCompare(ry) || x - y; if (rx) return -1; if (ry) return 1;
      const px = pos.get(x), py = pos.get(y); if (px != null && py != null) return px - py; if (px != null) return -1; if (py != null) return 1;
    }
    return fcInGroupCompare({ id: x, c: cx }, { id: y, c: cy });
  });
  return { order, cats };
}

/* ---------------- REL-83 full list (HANDOFF phase 2) ---------------- */
export const FC_PAGE_SIZES = [10, 20, 50] as const;
const toAscii = (s: string) => s.replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
const normFa = (s: string) => toAscii(s).replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
/** ۰۹۱۲***۰۰۱۲: the expert never receives a full number in the list (the call goes through GET /files-carousel/tel/:fileId). */
export const fcMaskPhone = (p: string | null | undefined): string | null => {
  if (!p) return null; let d = toAscii(String(p)).replace(/\D/g, ""); if (d.startsWith("98") && d.length === 12) d = "0" + d.slice(2);
  if (d.length < 8) return null; return faDigits(d.slice(0, 4)) + "***" + faDigits(d.slice(-4));
};
type ListRow = FileRow & { phone: string | null };
/** GET /files-carousel/list?q=&page=&page_size= : the expert's OWN files (customers.salesperson_id = theirs, not merged; the same scope as
 *  expert_lockdown «پرونده‌های خودت»), open + completed + cancelled, in the shared order. Search (name / customer id / file id / last ≥4 mobile
 *  digits) runs here, so no full number reaches the browser. Read-only. */
export function fcExpertList(u: U, query: any, now = new Date()) {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const day = fcToday(now);
  const qRaw = typeof query?.q === "string" ? query.q.slice(0, 60) : "";
  const q = normFa(qRaw).replace(/^#/, "");
  const ps = Number(query?.page_size); const pageSize = (FC_PAGE_SIZES as readonly number[]).includes(ps) ? ps : 10;
  const rows = queryRows<ListRow>(`${FILE_SELECT.replace("SELECT a.id,", "SELECT cc.phone, a.id,")} WHERE a.deleted_at IS NULL AND cc.salesperson_id=?`, [sp]);
  const { order, cats } = fcListOrder(sp, rows.map(r => r.id), now);
  const byId = new Map(rows.map(r => [r.id, r]));
  const digits = /^\d+$/.test(q) ? q : null;
  const match = (r: ListRow) => {
    if (!q) return true;
    if (digits) {
      if (String(r.id) === digits || String(r.cur_customer_id) === digits) return true;
      const ph = toAscii(r.phone ?? "").replace(/\D/g, "");
      return digits.length >= 4 && ph.length >= 8 && ph.endsWith(digits);
    }
    return normFa(r.name ?? "").includes(q);
  };
  const hits = order.map(id => byId.get(id)!).filter(r => r && match(r));
  const total = hits.length; const pages = Math.max(1, Math.ceil(total / pageSize));
  const pg = Math.min(pages, Math.max(1, Math.floor(Number(query?.page) || 1)));
  const done = new Set(queryRows<{ file_id: number }>("SELECT file_id FROM fc_followups WHERE salesperson_id=? AND day=?", [sp, day]).map(r => Number(r.file_id)));
  const unopened = new Set(fcUnseenReturns(sp).map(r => Number(r.file_id)));
  const groupCounts: Record<string, number> = {}; for (const r of hits) { const g = String(cats.get(r.id)!.priority_group); groupCounts[g] = (groupCounts[g] ?? 0) + 1; }
  const items = hits.slice((pg - 1) * pageSize, pg * pageSize).map(r => {
    const c = cats.get(r.id)!; const open = c.priority_group <= 5;
    return { file_id: r.id, customer_id: Number(r.cur_customer_id), customer_name: r.name ?? "", phone_masked: fcMaskPhone(r.phone), ...catCore(c)!,
      // v1.0.1: «پرونده برگشت خورد» stays until the file is opened (not when the bar closes); closed rows keep today's access (the server decides edits).
      followed_up_today: done.has(r.id), returned_unopened: unopened.has(r.id), is_closed: !open, closed_at: open ? null : c.closed_at, can_follow_up: !done.has(r.id), can_cancel: open, can_edit: true };
  });
  return { q: qRaw, page: pg, page_size: pageSize, pages, total, group_counts: groupCounts, group_labels: FC_GROUP_LABELS83, items };
}
/** POST /files-carousel/opened {fileId}: the expert opened the file, so its «پرونده برگشت خورد» badge goes (PM 6). Own file only; no other effect. */
export function fcExpertOpened(u: U, body: any, now = new Date()) {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const fid = Number(body?.fileId);
  if (!Number.isSafeInteger(fid) || fid <= 0) return err(400, "bad_type", "fileId", { field: "fileId" });
  const f = fileById(fid); if (!f || Number(f.owner) !== sp) return err(404, "file_not_found", "پرونده پیدا نشد.");
  return { ok: true as const, fileId: fid, cleared: fcMarkOpened(sp, fid, now) };
}
export const fcMarkOpened = (sp: number, fid: number, now = new Date()) => { ensureFcSchema();
  return executeChanges("UPDATE fc_returns SET opened_at=? WHERE salesperson_id=? AND file_id=? AND opened_at IS NULL", [now.toISOString(), sp, fid]); };
/** GET /files-carousel/tel/:fileId : the number for the «تماس» tel: link of one OWN open file (list «پیگیری» sheet only). */
export function fcExpertTel(u: U, fileIdIn: unknown) {
  ensureFcSchema();
  const sp = Number(u.salespersonId); const fid = Number(fileIdIn);
  if (!Number.isSafeInteger(fid) || fid <= 0) return err(404, "file_not_found", "پرونده پیدا نشد.");
  const f = fileById(fid); if (!f || !f.open || Number(f.owner) !== sp) return err(404, "file_not_found", "پرونده پیدا نشد.");
  const phone = queryRow<{ phone: string | null }>("SELECT phone FROM customers WHERE id=? AND salesperson_id=?", [Number(f.cur_customer_id), sp])?.phone ?? null;
  return { fileId: fid, tel: phone };
}
