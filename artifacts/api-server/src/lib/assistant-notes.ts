/**
 * assistant-notes (assistants38): loan-request-centred, read-only views for the assistant runner API.
 * - every loan request of a customer (old / inactive / closed / soft-deleted flagged; merged-source requests included)
 * - stage history per request, notes from every note store with source + author name + role, ISO + Jalali (Tehran) dates
 * - image-only notes → «یادداشت تصویری» + imageCount (never the image, its URL or its path)
 * - phones masked inside text (mobile + landline, Latin / Persian / Arabic digits)
 * - never a contract amount, contract file or link; requested amount only when the expert's own CRM card shows it
 * Pure reads: no INSERT/UPDATE/DELETE anywhere in this file.
 */
import type { DatabaseSync } from "node:sqlite";
import { maskText } from "./smart-filing";
import { maskPhonesInText } from "./lead-annotator";
import { LOAN_STAGE_LABELS } from "./manager-work";

/* ---------------- masking ---------------- */
const D = "[0-9۰-۹٠-٩]";
const SEP = "[\\s\\-\\u200c./]?";
const NZ = "(?:0|۰|٠)";
// Iranian landline: 0 + area (2 digits, first 1-8) + 8 digits, optional +98/0098 instead of 0, optional parentheses / separators
const LANDLINE_RE = new RegExp(`(?<![0-9۰-۹٠-٩])(?:\\(?(?:\\+?98|0098|\\+?۹۸|۰۰۹۸)${SEP}\\(?|\\(?${NZ})[1-8۱-۸١-٨]${D}\\)?${SEP}${D}{2}${SEP}?${D}{2}${SEP}?${D}{2}${SEP}?${D}{2}(?![0-9۰-۹٠-٩])`, "g");
const latin = (s: string) => s.replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
function maskLandline(m: string): string { const d = latin(m).replace(/\D/g, ""); const core = d.slice(-10); return `0${core.slice(0, 2)}******${core.slice(-2)}`; }
/** Phones anywhere in free text (mobile + landline, any digit script), then national IDs / bare numbers via maskText. */
export function maskNoteText(input: unknown, max = 2000): string {
  let s = String(input ?? "");
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+|\/(?:objects|uploads|files|contracts?|storage|private)\/\S+/gi, "[پیوند حذف شد]"); // never a file / contract link
  s = s.replace(/(پیوست(?:\s*یادداشت)?\s*[:：])[^\n]*/g, "$1 [فایل]"); // «پیوست یادداشت: <file name>» → no file name
  s = s.replace(/[^\s:،,]*\.(?:jpe?g|png|gif|webp|heic|bmp|tiff?|pdf|docx?|xlsx?|zip|rar|mp3|m4a|ogg|oga|wav|mp4|webm)\b/gi, "[فایل]");
  s = maskPhonesInText(s);
  s = s.replace(LANDLINE_RE, maskLandline);
  s = maskText(s);
  return s.slice(0, max);
}

/* ---------------- dates ---------------- */
const JF = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function toIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v); const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(s) && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") + "Z" : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function jalaliTehran(v: unknown): string | null {
  const iso = toIso(v); if (!iso) return null;
  const p: Record<string, string> = {}; for (const x of JF.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}
const when = (v: unknown) => ({ at: toIso(v), atJalali: jalaliTehran(v) });

/* ---------------- authors ---------------- */
export const ROLE_FA: Record<string, string> = { registrar: "کارشناس ثبت", salesperson: "کارشناس فروش", admin: "ادمین", manager: "مدیر",
  customer: "مشتری", assistant: "دستیار", system: "سیستم", unknown: "نامشخص" };
/** Users shown as «مدیر» (default: user 5); override with assistant_settings key notes_manager_user_ids = "5,…" (read only). */
function managerIds(db: DatabaseSync): number[] {
  try { const r = db.prepare("SELECT value FROM assistant_settings WHERE key='notes_manager_user_ids'").get() as any;
    if (r?.value != null) return String(r.value).split(/[,\s]+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0); } catch { /* table/key absent */ }
  return [5];
}
type Author = { name: string | null; role: string; roleLabel: string };
export function makeAuthors(db: DatabaseSync) {
  const cache = new Map<number, Author>(); const mgr = managerIds(db);
  const byUser = (id: unknown, fallbackName?: unknown, fallbackRole = "unknown"): Author => {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n < 1) return { name: fallbackName ? String(fallbackName) : null, role: fallbackRole, roleLabel: ROLE_FA[fallbackRole] };
    if (!cache.has(n)) {
      const u = db.prepare("SELECT id,full_name,username,role FROM users WHERE id=?").get(n) as any;
      const role = !u ? fallbackRole : mgr.includes(n) ? "manager" : u.role === "admin" || u.role === "registrar" || u.role === "salesperson" ? u.role : "unknown";
      cache.set(n, { name: u ? (u.full_name || u.username || null) : (fallbackName ? String(fallbackName) : null), role, roleLabel: ROLE_FA[role] });
    }
    return cache.get(n)!;
  };
  const bySalesperson = (spId: unknown, snapshot?: unknown): Author => {
    const n = Number(spId);
    const u = Number.isSafeInteger(n) && n > 0 ? db.prepare("SELECT id FROM users WHERE salesperson_id=? ORDER BY active DESC, id LIMIT 1").get(n) as any : null;
    if (u) return byUser(u.id, snapshot, "salesperson");
    const s = Number.isSafeInteger(n) && n > 0 ? db.prepare("SELECT name FROM salespersons WHERE id=?").get(n) as any : null;
    return { name: (snapshot as string) || s?.name || null, role: "salesperson", roleLabel: ROLE_FA.salesperson };
  };
  const customer = (): Author => ({ name: null, role: "customer", roleLabel: ROLE_FA.customer });
  const assistant = (label?: unknown): Author => ({ name: label ? String(label) : null, role: "assistant", roleLabel: ROLE_FA.assistant });
  const system = (): Author => ({ name: null, role: "system", roleLabel: ROLE_FA.system });
  return { byUser, bySalesperson, customer, assistant, system };
}

/* ---------------- helpers ---------------- */
const hasTable = (db: DatabaseSync, n: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));
const cols = (db: DatabaseSync, t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name));
/** The customer plus every customer merged into it (the CRM card shows their requests too). */
export function customerFamily(db: DatabaseSync, customerId: number): number[] {
  const ids = new Set<number>([customerId]);
  try { for (const r of db.prepare("SELECT id FROM customers WHERE merged_into_customer_id=?").all(customerId) as any[]) ids.add(Number(r.id)); } catch { /* */ }
  if (hasTable(db, "customer_merge_audit")) {
    const c = cols(db, "customer_merge_audit");
    const src = c.has("source_customer_id") ? "source_customer_id" : c.has("merged_customer_id") ? "merged_customer_id" : null;
    const dst = c.has("survivor_customer_id") ? "survivor_customer_id" : c.has("target_customer_id") ? "target_customer_id" : c.has("into_customer_id") ? "into_customer_id" : null;
    if (src && dst) for (const r of db.prepare(`SELECT ${src} s FROM customer_merge_audit WHERE ${dst}=?`).all(customerId) as any[]) if (Number(r.s) > 0) ids.add(Number(r.s));
  }
  return [...ids];
}
const IMG_LABEL = "یادداشت تصویری";
export const NOTE_SOURCE_FA: Record<string, string> = {
  call_note: "یادداشت تماس", call_customer_request: "درخواست مشتری (تماس)", call_one_line: "یادداشت یک‌خطی تماس",
  request_note: "یادداشت پرونده درخواست", request_description: "توضیح درخواست", request_decision: "دلیل تصمیم درخواست", stage_reason: "دلیل تغییر مرحله",
  follow_up: "پیگیری / یادآور", assignment_reason: "دلیل تخصیص / انتقال", assistant_note: "یادداشت دستیار", lead_annotation: "یادداشت سرنخ",
  urgent_reason: "دلیل فوری", consultation_note: "توضیحات فرم مشاوره", customer_description: "توضیحات مشتری",
};
type Note = { source: string; sourceLabel: string; id: string; at: string | null; atJalali: string | null; author: Author; text: string; isImage: boolean; imageCount: number; requestId: number | null };
const note = (source: string, id: unknown, at: unknown, author: Author, text: unknown, extra: Partial<Note> = {}): Note =>
  ({ source, sourceLabel: NOTE_SOURCE_FA[source] ?? source, id: `${source}:${id}`, ...when(at), author, text: maskNoteText(text), isImage: false, imageCount: 0, requestId: null, ...extra });
const nonEmpty = (v: unknown) => v != null && String(v).trim() !== "";
const reqStatusFa: Record<string, string> = { reviewing: "در جریان", approved: "تأیید شده", rejected: "رد شده", cancelled: "لغو شده", completed: "تکمیل شده", draft: "پیش‌نویس" };

/* ---------------- loan requests ---------------- */
export type RequestOpts = { showRequestedAmount: boolean; assistantId?: number };
export function loanRequests(db: DatabaseSync, customerId: number, opts: RequestOpts) {
  if (!hasTable(db, "loan_applications")) return [];
  const au = makeAuthors(db); const fam = customerFamily(db, customerId);
  const apps = db.prepare(`SELECT * FROM loan_applications WHERE customer_id IN (${fam.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 200`).all(...fam) as any[];
  const hasNotes = hasTable(db, "loan_application_notes"), hasHist = hasTable(db, "loan_application_stage_history");
  return apps.map(la => {
    const planId = la.plan_id ?? (() => { try { const v = JSON.parse(la.plan_ids); return Array.isArray(v) ? v[0] : v; } catch { return la.plan_ids; } })();
    const plan = planId ? db.prepare("SELECT id,name,bank_name,platform_name,loan_type FROM loan_plans WHERE id=?").get(Number(planId)) as any : null;
    const stageHistory = hasHist ? (db.prepare("SELECT * FROM loan_application_stage_history WHERE application_id=? ORDER BY id ASC").all(la.id) as any[]).map(h => ({
      id: h.id, ...when(h.created_at), fromStage: h.from_stage ?? null, fromStageLabel: h.from_stage ? (LOAN_STAGE_LABELS[h.from_stage] ?? h.from_stage) : null,
      toStage: h.to_stage ?? null, toStageLabel: h.to_stage ? (LOAN_STAGE_LABELS[h.to_stage] ?? h.to_stage) : null, action: h.action ?? null,
      reason: nonEmpty(h.reason) ? maskNoteText(h.reason, 500) : null,
      actor: h.actor_id ? au.byUser(h.actor_id) : h.actor_customer_id ? au.customer() : au.system() })) : [];
    const notes: Note[] = [];
    if (hasNotes) for (const n of db.prepare("SELECT id,author_id,author_name,text,object_path,mime_type,kind,created_at FROM loan_application_notes WHERE application_id=? ORDER BY id ASC").all(la.id) as any[]) {
      const img = Boolean(n.object_path) || n.kind === "image" || /^image\//.test(String(n.mime_type ?? ""));
      if (!img && !nonEmpty(n.text)) continue;
      notes.push(note("request_note", n.id, n.created_at, au.byUser(n.author_id, n.author_name), img ? (nonEmpty(n.text) ? `${IMG_LABEL} — ${n.text}` : IMG_LABEL) : n.text,
        { isImage: img, imageCount: img ? 1 : 0, requestId: la.id }));
    }
    if (nonEmpty(la.notes)) notes.push(note("request_description", la.id, la.created_at, la.requested_by_user_id ? au.byUser(la.requested_by_user_id) : au.system(), la.notes, { requestId: la.id }));
    for (const k of ["initial_approval_reason", "funder_reason"]) if (k in la && nonEmpty(la[k])) notes.push(note("request_decision", `${la.id}:${k}`, la.updated_at ?? la.created_at, au.system(), la[k], { requestId: la.id }));
    for (const h of stageHistory) if (h.reason) notes.push({ source: "stage_reason", sourceLabel: NOTE_SOURCE_FA.stage_reason, id: `stage_reason:${h.id}`, at: h.at, atJalali: h.atJalali, author: h.actor, text: h.reason, isImage: false, imageCount: 0, requestId: la.id });
    notes.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const latest = [...notes].reverse().find(Boolean) ?? null;
    const active = !la.deleted_at && !["rejected", "cancelled", "completed"].includes(String(la.status)) && la.stage !== "completed";
    const r: any = {
      id: la.id, customerId: la.customer_id, fromMergedCustomer: la.customer_id !== customerId,
      plan: plan ? { id: plan.id, name: plan.name, bank: plan.bank_name ?? null, platform: plan.platform_name ?? null, loanType: plan.loan_type ?? null } : null,
      stage: la.stage, stageLabel: LOAN_STAGE_LABELS[la.stage] ?? la.stage, status: la.status, statusLabel: reqStatusFa[la.status] ?? la.status,
      active, deleted: Boolean(la.deleted_at), preRegistration: Number(la.is_pre_registration) === 1,
      created: when(la.created_at), updated: when(la.updated_at), lastStageChange: stageHistory.length ? { at: stageHistory[stageHistory.length - 1].at, atJalali: stageHistory[stageHistory.length - 1].atJalali } : null,
      stageHistory, notes, noteCount: notes.length, imageNoteCount: notes.reduce((s, n) => s + n.imageCount, 0), latestNote: latest,
    };
    // the expert's own CRM card shows approved_amount || requested_amount: the requested amount is shown only when no approved (contract) amount exists
    if (opts.showRequestedAmount && la.approved_amount == null && la.requested_amount != null && !la.deleted_at) r.requestedAmount = Number(la.requested_amount);
    return r;
  });
}

/* ---------------- every note store, unified ---------------- */
export function allNotes(db: DatabaseSync, customerId: number, assistantId: number, requests?: any[]): Note[] {
  const au = makeAuthors(db); const out: Note[] = [];
  const reqs = requests ?? loanRequests(db, customerId, { showRequestedAmount: false });
  for (const r of reqs) out.push(...r.notes);
  for (const l of db.prepare("SELECT * FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 300").all(customerId) as any[]) {
    const a = l.created_by_user_id ? au.byUser(l.created_by_user_id, l.salesperson_name_snapshot, "salesperson") : au.bySalesperson(l.salesperson_id, l.salesperson_name_snapshot);
    if (nonEmpty(l.expert_notes)) out.push(note("call_note", l.id, l.created_at, a, l.expert_notes));
    if (nonEmpty(l.customer_request)) out.push(note("call_customer_request", l.id, l.created_at, a, l.customer_request));
    if ("one_line_note" in l && nonEmpty(l.one_line_note)) out.push(note("call_one_line", l.id, l.created_at, a, l.one_line_note));
  }
  if (hasTable(db, "reminders")) for (const r of db.prepare("SELECT * FROM reminders WHERE customer_id=? ORDER BY id DESC LIMIT 200").all(customerId) as any[]) {
    const t = [r.subject, r.message].filter(nonEmpty).join(" — "); if (!t) continue;
    out.push(note("follow_up", r.id, r.created_at, au.byUser(Number(r.created_by) > 0 ? r.created_by : r.user_id, null, "salesperson"), t));
  }
  if (hasTable(db, "customer_priority_history")) for (const h of db.prepare("SELECT * FROM customer_priority_history WHERE customer_id=? AND COALESCE(TRIM(reason),'')<>'' ORDER BY id DESC LIMIT 200").all(customerId) as any[])
    out.push(note("assignment_reason", h.id, h.created_at, h.actor_user_id ? au.byUser(h.actor_user_id) : au.system(), h.reason));
  if (hasTable(db, "assistant_customer_notes")) for (const n of db.prepare("SELECT * FROM assistant_customer_notes WHERE customer_id=? AND assistant_id=? ORDER BY id DESC LIMIT 100").all(customerId, assistantId) as any[])
    out.push(note("assistant_note", n.id, n.created_at, au.assistant(n.author_label), n.body));
  if (hasTable(db, "customer_annotations")) for (const n of db.prepare("SELECT * FROM customer_annotations WHERE customer_id=? ORDER BY id DESC LIMIT 100").all(customerId) as any[])
    out.push(note("lead_annotation", n.id, n.created_at, n.actor_user_id ? au.byUser(n.actor_user_id, n.actor_label) : au.assistant(n.actor_label), [n.label, n.body].filter(nonEmpty).join(" — ")));
  if (hasTable(db, "customer_urgent_history")) for (const n of db.prepare("SELECT * FROM customer_urgent_history WHERE customer_id=? AND COALESCE(TRIM(reason),'')<>'' ORDER BY id DESC LIMIT 100").all(customerId) as any[])
    out.push(note("urgent_reason", n.id, n.created_at, n.actor_user_id ? au.byUser(n.actor_user_id, n.actor_label) : au.assistant(n.actor_label), n.reason));
  if (hasTable(db, "consultation_forms")) for (const f of db.prepare("SELECT id,author_user_id,extra_notes,created_at,updated_at FROM consultation_forms WHERE customer_id=? AND COALESCE(TRIM(extra_notes),'')<>'' ORDER BY id DESC LIMIT 20").all(customerId) as any[])
    out.push(note("consultation_note", f.id, f.updated_at ?? f.created_at, au.byUser(f.author_user_id), f.extra_notes));
  const c = db.prepare("SELECT * FROM customers WHERE id=?").get(customerId) as any;
  if (c && nonEmpty(c.description)) out.push(note("customer_description", c.id, c.updated_at ?? c.created_at, au.system(), c.description));
  return out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
}
/** The single newest note across every store (for list / summary cards). Text trimmed to 200. */
export function latestNote(db: DatabaseSync, customerId: number, assistantId: number) {
  const n = allNotes(db, customerId, assistantId)[0];
  return n ? { ...n, text: n.text.slice(0, 200) } : null;
}
/** Store inventory for the release report (counts only). */
export const NOTE_STORES = ["call_logs.expert_notes", "call_logs.customer_request", "call_logs.one_line_note", "loan_application_notes (text + image)", "loan_applications.notes",
  "loan_applications.initial_approval_reason / funder_reason", "loan_application_stage_history.reason", "reminders.subject/message", "customer_priority_history.reason",
  "assistant_customer_notes", "customer_annotations", "customer_urgent_history.reason", "consultation_forms.extra_notes", "customers.description"];
