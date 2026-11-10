/**
 * daily-customer-inline v1.1 — flag.daily_customer_inline_v1 (call_queue_settings). Default OFF.
 *
 * OFF: do not create tables, do not change Today / پرونده مشتری / popups / csfields / ReminderMust / STT.
 * Status returns { enabled: false }. Data routes return 404 dci_off.
 *
 * ON (global flag.daily_customer_inline_v1=1 or flag.daily_customer_inline_v1.user.<id>=1):
 *  GET today timeline + GET customer board (incoming calls with transcript, optional note,
 *  call history with note, expert notes, cases, credit grade without inquiry code, guarantor,
 *  wallet for owner/managers). Experts: own customer 200, other 403 not_owner.
 *
 * Activate:
 *   INSERT INTO call_queue_settings(key, value, updated_at)
 *   VALUES ('flag.daily_customer_inline_v1', '1', datetime('now'))
 *   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
 * Off:
 *   UPDATE call_queue_settings SET value = '0', updated_at = datetime('now')
 *   WHERE key = 'flag.daily_customer_inline_v1' OR key LIKE 'flag.daily_customer_inline_v1.user.%';
 */
import type { AuthUser } from "./auth";
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { dpToday } from "./daily-plan";
import { callHistory, currentFileAnswers } from "./history-a";
import { listCustomerCases } from "./multi-case";
import { getWalletSummaryReadOnly } from "./wallets";

export const DCI_FLAG = "flag.daily_customer_inline_v1";
export const DCI_OFF = "dci_off";
export const DCI_OFF_MESSAGE = "این بخش هنوز فعال نشده است.";
export const DCI_NOT_OWNER = "not_owner";
export const DCI_NOT_OWNER_MESSAGE = "مشتری شما نیست";

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; }
  catch { return null; }
};

export function dciGlobalOn(): boolean { return setting(DCI_FLAG) === "1"; }

/** Global flag=1, or per-user flag=1. Anything else is OFF. */
export function dciFlagOn(userId: number | null | undefined): boolean {
  if (dciGlobalOn()) return true;
  if (!userId) return false;
  return setting(`${DCI_FLAG}.user.${Number(userId)}`) === "1";
}

const tableExists = (name: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [name]);
const columnExists = (table: string, column: string) => {
  if (!/^[a-z0-9_]+$/i.test(table)) return false;
  try { return queryRows<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column); }
  catch { return false; }
};

let ready = false;
/** Schema is created only while the flag is ON (never at import, never while OFF). */
export function ensureDciSchema(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS dci_expert_notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    author_user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dci_expert_notes_cust ON dci_expert_notes(customer_id, id DESC);
  CREATE TABLE IF NOT EXISTS dci_inbound_notes(
    event_id INTEGER PRIMARY KEY,
    author_user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  ready = true;
}

export function dciIsManager(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return user.role === "admin" || user.role === "sales_manager" || user.salesManager === true;
}

export function dciIsExpert(user: AuthUser | null | undefined): boolean {
  return Boolean(user && user.role === "salesperson" && user.salespersonId);
}

/** Owner = assigned salesperson. Managers/admins are not "owner" but may still view. */
export function dciOwnsCustomer(user: AuthUser, customerId: number): boolean {
  if (!tableExists("customers")) return false;
  const row = queryRow<{ salesperson_id: number | null; full_name?: string }>(
    "SELECT salesperson_id FROM customers WHERE id=? AND (merged_into_customer_id IS NULL OR merged_into_customer_id=0)",
    [customerId],
  );
  if (!row) return false;
  return user.salespersonId != null && Number(row.salesperson_id) === Number(user.salespersonId);
}

export type DciDenied = { error: typeof DCI_NOT_OWNER; message: string; customerId: number; name: string; expertName: string | null };

export function dciCustomerMeta(customerId: number): { id: number; name: string; expertName: string | null; salespersonId: number | null; phone: string | null; nationalCode: string | null; priority: number | null; status: string | null } | null {
  if (!tableExists("customers")) return null;
  const nid = columnExists("customers", "national_code") ? "c.national_code" : "NULL";
  const row = queryRow<any>(
    `SELECT c.id, c.name, c.phone, c.salesperson_id, c.priority, c.status, ${nid} AS national_code, s.full_name AS expert_name
     FROM customers c
     LEFT JOIN salespersons sp ON sp.id=c.salesperson_id
     LEFT JOIN users s ON s.salesperson_id=c.salesperson_id AND s.role='salesperson'
     WHERE c.id=? AND (c.merged_into_customer_id IS NULL OR c.merged_into_customer_id=0)`,
    [customerId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    expertName: row.expert_name ? String(row.expert_name) : null,
    salespersonId: row.salesperson_id == null ? null : Number(row.salesperson_id),
    phone: row.phone ?? null,
    nationalCode: row.national_code ?? null,
    priority: row.priority == null ? null : Number(row.priority),
    status: row.status ?? null,
  };
}

export function dciDeniedBody(customerId: number): DciDenied {
  const meta = dciCustomerMeta(customerId);
  return {
    error: DCI_NOT_OWNER,
    message: DCI_NOT_OWNER_MESSAGE,
    customerId,
    name: meta?.name || `#${customerId}`,
    expertName: meta?.expertName ?? null,
  };
}

/** Experts with assigned scope (or any salesperson): only own customers. Managers/admins: any. Missing customer: null. */
export function dciAccess(user: AuthUser, customerId: number): "own" | "manager" | "denied" | "missing" {
  const meta = dciCustomerMeta(customerId);
  if (!meta) return "missing";
  if (dciIsManager(user)) return "manager";
  if (dciOwnsCustomer(user, customerId)) return "own";
  return "denied";
}

const FA = "۰۱۲۳۴۵۶۷۸۹";
export const faDigits = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]);

/** HH:MM in Persian digits, always zero-padded (e.g. ۰۰:۴۸, ۰۹:۴۸). Never Latin digits. */
export function faHm(h: number | string, m: number | string): string {
  const hi = Math.min(23, Math.max(0, Number(String(h).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))) || 0));
  const mi = Math.min(59, Math.max(0, Number(String(m).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))) || 0));
  return faDigits(`${String(hi).padStart(2, "0")}:${String(mi).padStart(2, "0")}`);
}

/** Rewrite every H:MM / HH:MM clock in a label to zero-padded Persian digits. Leaves other text alone (do not use on phone numbers). */
export function faClockText(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[0-9۰-۹]{1,2}:[0-9۰-۹]{2}/g, (hm) => {
    const [h, m] = hm.split(":");
    return faHm(h, m);
  });
}

export function tehranClock(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return faClockText(String(iso));
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    let h = parts.find((p) => p.type === "hour")?.value ?? "00";
    let m = parts.find((p) => p.type === "minute")?.value ?? "00";
    if (h === "24") h = "00";
    return faHm(h, m);
  } catch { return ""; }
}

export function tehranDateLine(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" });
    if (dayFmt.format(d) === dayFmt.format(now)) return `امروز، ساعت ${tehranClock(iso)}`;
    const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-arabext", { timeZone: "Asia/Tehran", weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
    const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "";
    return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}، ساعت ${tehranClock(iso)}`.replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

export function tehranDayTitle(ymd?: string): string {
  const src = ymd ? new Date(`${ymd}T12:00:00+03:30`) : new Date();
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-arabext", { timeZone: "Asia/Tehran", weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(src);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "";
  return faDigits(`${g("weekday")} ${g("day")} ${g("month")} ${g("year")}`.replace(/\s+/g, " ").trim());
}

function typOf(type: string, source?: string | null): { typ: "لید تازه" | "یادآور" | "کار امروز" | "ورودی"; ic: "i-plus" | "i-bell" | "i-today" | "i-phone" } {
  const t = String(type || "").toLowerCase();
  const s = String(source || "").toLowerCase();
  if (t === "incoming" || t === "inbound" || t === "ورودی") return { typ: "ورودی", ic: "i-phone" };
  if (t === "first" || t === "lead" || t.includes("lead") || s.includes("lead")) return { typ: "لید تازه", ic: "i-plus" };
  if (t.includes("remind") || t === "due" || t === "followup" || s.includes("remind")) return { typ: "یادآور", ic: "i-bell" };
  return { typ: "کار امروز", ic: "i-today" };
}

export type DciTimelineItem = {
  id: string;
  kind: "plan" | "inbound";
  itemId: number | null;
  customerId: number;
  name: string;
  typ: string;
  ic: string;
  tm: string;
  at: string | null;
  status?: string | null;
};

export function dciHasExtension(userId: number): boolean {
  if (!tableExists("voip_extensions")) return false;
  const ext = queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [userId])?.extension;
  return Boolean(ext && String(ext).trim());
}

export function dciTodayTimeline(user: AuthUser, now = new Date()): { date: string; dateLabel: string; hasExtension: boolean; tasks: DciTimelineItem[] } {
  const day = dpToday(now);
  const tasks: DciTimelineItem[] = [];
  if (tableExists("dp_plans") && tableExists("dp_items") && user.salespersonId) {
    const plan = queryRow<{ id: number }>("SELECT id FROM dp_plans WHERE salesperson_id=? AND day=?", [user.salespersonId, day]);
    if (plan) {
      const rows = queryRows<any>(
        `SELECT i.id, i.customer_id, i.type, i.source, i.status, i.moved_to, i.became_current_at, i.created_at, i.done_at, c.name
         FROM dp_items i JOIN customers c ON c.id=i.customer_id
         WHERE i.plan_id=? AND i.status NOT IN ('skipped','transferred','reserve')
           AND (i.status <> 'covered' OR i.label = 'پرونده‌ی وام باز دارد')
         ORDER BY CASE i.status WHEN 'current' THEN 0 WHEN 'pending' THEN 1 WHEN 'moved' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, i.position, i.id`,
        [plan.id],
      );
      for (const r of rows) {
        const at = r.moved_to || r.became_current_at || r.created_at || r.done_at || null;
        const { typ, ic } = typOf(r.type, r.source);
        tasks.push({
          id: `p-${r.id}`,
          kind: "plan",
          itemId: Number(r.id),
          customerId: Number(r.customer_id),
          name: String(r.name ?? ""),
          typ, ic,
          tm: tehranClock(at) || faDigits("—"),
          at,
          status: r.status ?? null,
        });
      }
    }
  }
  // Today's incoming calls for this expert's own customers (read existing events; do not touch STT).
  if (tableExists("voip_after_call_events") && user.salespersonId) {
    const start = `${day}T00:00:00+03:30`;
    const end = `${day}T23:59:59+03:30`;
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    const rows = queryRows<any>(
      `SELECT e.id, e.started_at, e.customer_id, c.name
       FROM voip_after_call_events e
       JOIN customers c ON c.id=e.customer_id
       WHERE c.salesperson_id=? AND lower(e.direction) IN ('incoming','inbound')
         AND e.started_at >= ? AND e.started_at <= ?
         AND (c.merged_into_customer_id IS NULL OR c.merged_into_customer_id=0)
       ORDER BY e.started_at`,
      [user.salespersonId, startIso, endIso],
    );
    const seen = new Set(tasks.filter((t) => t.kind === "inbound").map((t) => t.customerId + ":" + t.at));
    for (const r of rows) {
      const key = `${r.customer_id}:${r.started_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({
        id: `in-${r.id}`,
        kind: "inbound",
        itemId: Number(r.id),
        customerId: Number(r.customer_id),
        name: String(r.name ?? ""),
        typ: "ورودی",
        ic: "i-phone",
        tm: tehranClock(r.started_at) || faDigits("—"),
        at: r.started_at,
        status: "inbound",
      });
    }
  }
  tasks.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return { date: day, dateLabel: tehranDayTitle(day), hasExtension: dciHasExtension(user.id), tasks };
}

const STAGE_STATUS: Record<string, string> = {
  draft: "پیش‌نویس",
  customer_documents_upload: "در انتظار مدارک مشتری",
  customer_documents_review: "بررسی مدارک مشتری",
  guarantor_registration: "ثبت ضامن",
  guarantor_documents_upload: "بارگذاری مدارک ضامن",
  completed: "تکمیل شده",
};
const STAGE_ACTION: Record<string, string> = {
  draft: "ادامهٔ ثبت",
  customer_documents_upload: "بارگذاری مدارک",
};

function planLabel(bankName: string | null | undefined, planName: string | null | undefined): string {
  const bank = String(bankName ?? "").trim();
  if (bank) return `لندتک / ${bank}`;
  const name = String(planName ?? "").trim();
  // Never invent a bank; if only a plan name exists, still prefix with لندتک when it is not already.
  if (!name) return "لندتک";
  if (name.startsWith("لندتک")) return name;
  return `لندتک / ${name}`;
}

function caseHref(id: number, stage: string | null, customerId: number): string {
  if (stage === "draft") return `/loan-applications?new=1&customerId=${customerId}&from=customer`;
  return `/loan-applications/${id}`;
}

export function dciCases(customerId: number) {
  if (!tableExists("loan_applications")) return [];
  try {
    return listCustomerCases(customerId).filter((c) => c.open !== false || c.stage === "draft" || c.status !== "rejected").map((c) => {
      const stage = c.stage ?? "";
      const status = STAGE_STATUS[stage] || (stage ? STAGE_STATUS[stage] : null) || (c.status === "rejected" ? "لغو شده" : STAGE_STATUS[stage]) || (stage === "customer_documents_upload" ? "در انتظار مدارک مشتری" : (STAGE_STATUS[stage] ?? (stage ? String(stage) : "پرونده")));
      const label = STAGE_STATUS[stage] ?? (stage === "customer_documents_upload" ? "در انتظار مدارک مشتری" : undefined);
      return {
        id: c.id,
        plan: planLabel(c.bankName, c.planName),
        amount: c.requestedAmount ?? null,
        months: c.durationMonths ?? null,
        stage,
        status: label ?? (STAGE_STATUS[stage] ?? (c.status === "rejected" ? "لغو شده" : (stage ? stage : "پرونده"))),
        act: STAGE_ACTION[stage] ?? "مشاهده‌ی پرونده",
        href: caseHref(c.id, c.stage, customerId),
        open: c.open,
      };
    });
  } catch {
    return [];
  }
}

function inboundMissed(status: string | null | undefined): boolean {
  const s = String(status || "").toUpperCase();
  if (!s) return false;
  if (s.includes("ANSWER") && !s.includes("NO") && s !== "NO ANSWER") return false;
  if (["ANSWERED", "ANSWER", "CONNECTED", "BUSY_TALK", "CONVERSATION"].includes(s)) return false;
  return true;
}

function transcriptText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const summary = typeof j?.summary === "string" ? j.summary.trim() : (typeof j?.result?.summary === "string" ? j.result.summary.trim() : "");
    const text = typeof j?.text === "string" ? j.text.trim() : (typeof j?.result?.text === "string" ? j.result.text.trim() : "");
    const out = summary || text;
    return out || null;
  } catch {
    const t = String(raw).trim();
    return t || null;
  }
}

export function dciInbounds(customerId: number) {
  if (!tableExists("voip_after_call_events")) return [];
  const hasT = tableExists("voip_recording_transcripts");
  const noteJoin = tableExists("dci_inbound_notes") ? "LEFT JOIN dci_inbound_notes n ON n.event_id=e.id" : "";
  const noteSel = tableExists("dci_inbound_notes") ? "n.body AS note" : "NULL AS note";
  const tJoin = hasT ? "LEFT JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)" : "";
  const tSel = hasT ? "t.result_json" : "NULL AS result_json";
  const recId = columnExists("voip_after_call_events", "recording_provider_id") ? "e.recording_provider_id" : "NULL";
  const rows = queryRows<any>(
    `SELECT e.id, e.started_at, e.status, e.has_recording, e.call_log_id, ${tSel}, ${noteSel}
     FROM voip_after_call_events e
     ${tJoin}
     ${noteJoin}
     WHERE e.customer_id=? AND lower(e.direction) IN ('incoming','inbound')
     ORDER BY e.started_at DESC, e.id DESC LIMIT 30`.replace("e.recording_provider_id", recId),
    [customerId],
  );
  return rows.map((r) => {
    const missed = inboundMissed(r.status);
    return {
      id: Number(r.id),
      callLogId: r.call_log_id == null ? null : Number(r.call_log_id),
      t: faClockText(tehranDateLine(r.started_at)),
      at: r.started_at,
      r: missed ? "بی‌پاسخ" : "جواب داد",
      rc: missed ? "no" : "ok",
      text: transcriptText(r.result_json),
      missed,
      note: r.note ? String(r.note) : "",
    };
  });
}

export function dciHistory(customerId: number) {
  try {
    const { items } = callHistory(customerId, 30);
    return items.map((h) => ({
      id: h.id,
      t: faClockText(tehranDateLine(h.at)),
      at: h.at,
      k: /ورودی/.test(h.result) ? "ورودی" : "خروجی",
      r: h.result,
      rc: h.tone === "ok" || /جواب داد|صحبت/.test(h.result) ? "ok" : (h.tone === "in" ? "in" : "no"),
      note: h.note ?? "",
    }));
  } catch {
    return [];
  }
}

export function dciNotes(customerId: number) {
  const out: { id: string; t: string; body: string; source: string }[] = [];
  if (tableExists("dci_expert_notes")) {
    for (const n of queryRows<any>("SELECT id, body, created_at FROM dci_expert_notes WHERE customer_id=? ORDER BY id DESC LIMIT 50", [customerId])) {
      out.push({ id: `dci-${n.id}`, t: tehranDateLine(n.created_at).replace(/، ساعت.*/, "") || tehranDateLine(n.created_at), body: String(n.body), source: "dci" });
    }
  }
  if (tableExists("customer_annotations")) {
    for (const n of queryRows<any>("SELECT id, body, created_at FROM customer_annotations WHERE customer_id=? ORDER BY id DESC LIMIT 20", [customerId])) {
      out.push({ id: `ann-${n.id}`, t: tehranDateLine(n.created_at).replace(/، ساعت.*/, ""), body: String(n.body ?? ""), source: "annotation" });
    }
  }
  // de-dup by body+day, keep first (newest dci first)
  const seen = new Set<string>();
  const uniq = [];
  for (const n of out) {
    const k = n.body.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(n);
  }
  return uniq.slice(0, 50);
}

export function dciAddNote(customerId: number, userId: number, body: string, now = new Date()) {
  ensureDciSchema();
  const text = body.trim();
  if (!text) throw Object.assign(new Error("empty"), { code: "empty_note" });
  execute("INSERT INTO dci_expert_notes(customer_id, author_user_id, body, created_at) VALUES(?,?,?,?)", [customerId, userId, text, now.toISOString()]);
  return dciNotes(customerId);
}

export function dciInboundCustomerId(eventId: number): number | null {
  const ev = queryRow<{ customer_id: number }>("SELECT customer_id FROM voip_after_call_events WHERE id=? AND lower(direction) IN ('incoming','inbound')", [eventId]);
  return ev ? Number(ev.customer_id) : null;
}

export function dciSaveInboundNote(eventId: number, userId: number, body: string, now = new Date()) {
  ensureDciSchema();
  const ev = queryRow<{ id: number; customer_id: number }>("SELECT id, customer_id FROM voip_after_call_events WHERE id=? AND lower(direction) IN ('incoming','inbound')", [eventId]);
  if (!ev) return null;
  const text = body.trim();
  if (!text) {
    execute("DELETE FROM dci_inbound_notes WHERE event_id=?", [eventId]);
  } else {
    execute(
      `INSERT INTO dci_inbound_notes(event_id, author_user_id, body, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET body=excluded.body, author_user_id=excluded.author_user_id, updated_at=excluded.updated_at`,
      [eventId, userId, text, now.toISOString()],
    );
  }
  return ev.customer_id;
}

function creditOf(customerId: number): { state: "ok" | "start" | "err" | "none"; grade: string | null; at: string | null } {
  // Prefer stored grade on the customer, then file-card answers. Never return an inquiry/OTP/request code.
  if (tableExists("customers") && (columnExists("customers", "credit_rank") || columnExists("customers", "credit_grade"))) {
    const row = queryRow<{ credit_rank?: string | null; credit_grade?: string | null; credit_checked_at?: string | null }>(
      `SELECT ${columnExists("customers", "credit_rank") ? "credit_rank" : "NULL AS credit_rank"},
              ${columnExists("customers", "credit_grade") ? "credit_grade" : "NULL AS credit_grade"},
              ${columnExists("customers", "credit_checked_at") ? "credit_checked_at" : "NULL AS credit_checked_at"}
       FROM customers WHERE id=?`, [customerId]);
    const g = String(row?.credit_rank || row?.credit_grade || "").trim();
    if (g && !/^\d{4,}$/.test(g) && !/otp|token|code/i.test(g)) return { state: "ok", grade: g, at: row?.credit_checked_at ?? null };
  }
  let file: ReturnType<typeof currentFileAnswers> = { answers: null, source: null, at: null, by: null, firstCall: null };
  try { file = currentFileAnswers(customerId); } catch { /* no file answers */ }
  const grade = file.answers && typeof (file.answers as any).creditRank === "string" ? String((file.answers as any).creditRank).trim() : "";
  if (grade && !/^\d{4,}$/.test(grade)) return { state: "ok", grade, at: file.at };
  if (tableExists("credit_checks") || tableExists("customer_credit_checks")) {
    const table = tableExists("credit_checks") ? "credit_checks" : "customer_credit_checks";
    const cols = queryRows<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    const rankCol = ["rank", "grade", "credit_rank", "result_rank"].find((c) => cols.includes(c));
    const statusCol = ["status", "state"].find((c) => cols.includes(c));
    const atCol = ["completed_at", "updated_at", "created_at"].find((c) => cols.includes(c));
    if (rankCol) {
      const row = queryRow<any>(`SELECT ${rankCol} AS grade, ${statusCol ?? "NULL"} AS status, ${atCol ?? "NULL"} AS at FROM ${table} WHERE customer_id=? ORDER BY id DESC LIMIT 1`, [customerId]);
      if (row) {
        const g = row.grade != null ? String(row.grade).trim() : "";
        const st = String(row.status ?? "").toLowerCase();
        if (st.includes("fail") || st.includes("error") || st.includes("err")) return { state: "err", grade: null, at: row.at ?? null };
        if (g && !/code|otp|token/i.test(g) && !/^\d{6,}$/.test(g)) return { state: "ok", grade: g, at: row.at ?? null };
      }
    }
  }
  return { state: "start", grade: null, at: null };
}

function guarantorOf(customerId: number): { v: "yes" | "no" | "unknown"; cond: string | null } {
  let file: ReturnType<typeof currentFileAnswers> = { answers: null, source: null, at: null, by: null, firstCall: null };
  try { file = currentFileAnswers(customerId); } catch { /* no file answers */ }
  const a = (file.answers ?? {}) as Record<string, unknown>;
  const avail = String(a.guarantorAvailable ?? a.guarantor ?? "").toLowerCase();
  if (avail === "no" || avail === "false" || avail === "ندارد") return { v: "no", cond: null };
  if (avail === "yes" || avail === "true" || avail === "دارد") {
    const bits: string[] = [];
    if (a.guarantorCheque) bits.push(`چک ضامن: ${a.guarantorCheque}`);
    if (a.gRank) bits.push(`رتبهٔ ضامن ${a.gRank}`);
    if (a.gJobType) bits.push(`شغل ضامن: ${a.gJobType}`);
    if (typeof a.guarantorCondition === "string" && a.guarantorCondition.trim()) bits.push(String(a.guarantorCondition).trim());
    const cond = bits.length ? `شرایط: ${bits.join("؛ ")}` : null;
    return { v: "yes", cond };
  }
  return { v: "unknown", cond: null };
}

const WALLET_KIND: Record<string, { ti: string; inn: boolean }> = {
  cash_payment: { ti: "واریز به کیف پول", inn: true },
  topup: { ti: "واریز به کیف پول", inn: true },
  deposit: { ti: "واریز به کیف پول", inn: true },
  credit: { ti: "واریز به کیف پول", inn: true },
  filing_fee: { ti: "هزینهٔ تشکیل پرونده", inn: false },
  loan_filing_fee: { ti: "هزینهٔ تشکیل پرونده", inn: false },
  fee: { ti: "هزینهٔ تشکیل پرونده", inn: false },
};

function walletOf(customerId: number) {
  try {
    const sum = getWalletSummaryReadOnly(customerId);
    const cash = sum.cash;
    const txs = (cash.ledger ?? []).slice(0, 8).map((r) => {
      const known = WALLET_KIND[r.kind] ?? (String(r.amountToman).startsWith("-") || Number(r.amountToman) < 0
        ? { ti: "برداشت", inn: false }
        : { ti: "واریز به کیف پول", inn: true });
      const amt = String(r.amountToman).replace(/^-/, "");
      return { t: tehranDateLine(r.createdAt).replace(/، ساعت.*/, ""), ti: known.ti, a: amt, in: known.inn };
    });
    return { balance: cash.balanceToman ?? "0", tx: txs };
  } catch {
    return { balance: null as string | null, tx: [] as { t: string; ti: string; a: string; in: boolean }[] };
  }
}

function tagsOf(customerId: number): string[] {
  if (!tableExists("customer_tags")) return [];
  return queryRows<{ tag: string }>("SELECT tag FROM customer_tags WHERE customer_id=? ORDER BY tag", [customerId]).map((r) => String(r.tag));
}

function lineFromEvent(ev: { direction?: string; status?: string } | null | undefined): string {
  if (!ev) return "تماس ثبت‌شده‌ای در جریان نیست";
  const dir = String(ev.direction ?? "").trim().toLowerCase();
  const inn = dir === "incoming" || dir === "inbound" || dir === "in";
  const missed = inboundMissed(ev.status);
  if (inn) return missed ? "تماس ورودی؛ بی‌پاسخ" : "تماس ورودی؛ جواب داد";
  return missed ? "تماس خروجی؛ جواب نداد" : "تماس خروجی؛ جواب داد";
}

/** Mid-column current-call line. An inbound timeline task uses that event; a today-plan task prefers the latest outgoing. */
function currentCallLine(customerId: number, task?: string | null): string {
  if (!tableExists("voip_after_call_events")) return "تماس ثبت‌شده‌ای در جریان نیست";
  if (task && /^in-\d+$/.test(task)) {
    const ev = queryRow<any>(
      "SELECT customer_id, direction, status, started_at FROM voip_after_call_events WHERE id=?",
      [Number(task.slice(3))],
    );
    if (ev && Number(ev.customer_id) === customerId) return lineFromEvent(ev);
  }
  const outgoing = queryRow<any>(
    `SELECT direction, status, started_at FROM voip_after_call_events
     WHERE customer_id=? AND lower(direction) IN ('outgoing','outbound')
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [customerId],
  );
  if (outgoing) return lineFromEvent(outgoing);
  const ev = queryRow<any>(
    `SELECT direction, status, started_at FROM voip_after_call_events WHERE customer_id=? ORDER BY started_at DESC, id DESC LIMIT 1`,
    [customerId],
  );
  return lineFromEvent(ev);
}

export function dciBoard(user: AuthUser, customerId: number, task?: string | null) {
  const access = dciAccess(user, customerId);
  if (access === "missing") return { access: "missing" as const };
  const meta = dciCustomerMeta(customerId)!;
  if (access === "denied") {
    return { access: "denied" as const, denied: dciDeniedBody(customerId) };
  }
  let file: ReturnType<typeof currentFileAnswers> = { answers: null, source: null, at: null, by: null, firstCall: null };
  try { file = currentFileAnswers(customerId); } catch { /* no file answers */ }
  const first = !file.answers || file.firstCall == null;
  const cases = dciCases(customerId);
  const showWallet = access === "own" || access === "manager";
  const canPromote = access === "own" || dciIsManager(user);
  const credit = creditOf(customerId);
  const guar = guarantorOf(customerId);
  return {
    access,
    hasExtension: dciHasExtension(user.id),
    canPromote,
    customer: {
      id: meta.id,
      name: meta.name,
      phone: meta.phone,
      nationalCode: meta.nationalCode,
      priority: meta.priority,
      tags: tagsOf(customerId),
    },
    call: currentCallLine(customerId, task),
    prio: meta.priority === 1,
    hist: dciHistory(customerId),
    notes: dciNotes(customerId),
    inbounds: dciInbounds(customerId),
    credit,
    guar,
    wallet: showWallet ? walletOf(customerId) : null,
    cases,
    first: first && cases.length === 0,
    newCaseHref: `/loan-applications?new=1&customerId=${customerId}&from=customer`,
  };
}
