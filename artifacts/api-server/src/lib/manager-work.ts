/**
 * v11 «احمد» read-only work queues (no writes anywhere in this file).
 *
 * 1) /manager/invoices/open — «فاکتور» is the goods-purchase invoice: the CRM page «فاکتور فروش کالا» (goods purchase detail;
 *    stages «پیش‌فاکتور» / «امضای فاکتور»). Table goods_purchases (one row per purchase; its invoice lines are goods_invoice_items,
 *    its signed PDFs goods_purchase_documents kind='invoice'). Open = stage <> 'completed'. Amount = credit_amount_toman (the
 *    invoice total must equal it, lib/goods-finance.ts), unit toman. Time in stage comes from goods_purchase_events.
 * 2) /manager/registration — «پرونده‌ی ثبت» is a loan application («درخواست تسهیلات», page /loan-applications), worked by the
 *    «کارشناس ثبت» (role registrar). Table loan_applications (stage, status); moves are in loan_application_stage_history.
 *    Open = deleted_at IS NULL AND status <> 'rejected' AND stage <> 'completed'.
 *
 * Scope (both): customers of the manager's experts (managerExperts: trainees read-only, user 29 never), not merged.
 * Customer lead status is not filtered here: a case stays open work even when the lead row is closed.
 * Test customers (lib/test-customers.ts) are left out when the admin switch is ON (default ON).
 * Commission columns are never read. Phones are masked (maskPhone) and the route masks the whole payload again.
 */
import type { DatabaseSync } from "node:sqlite";
import { managerExperts } from "./assistant-manager";
import { testCustomerSql } from "./test-customers";
import { maskPhone } from "./smart-filing";

export const AMOUNT_UNIT = "toman" as const;
const HOUR = 3_600_000; const DAY = 86_400_000; const OFFSET = 210 * 60_000;
const custName = (c: any) => (c?.first_name && c?.last_name ? `${c.first_name} ${c.last_name}` : c?.name ?? "مشتری");
const userName = (u: any) => (u ? (u.full_name || u.username || null) : null);
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const hours = (ms: number) => Math.max(0, Math.round((ms / HOUR) * 10) / 10);
const ms = (s: unknown) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : NaN; };

export type WorkDeps = { db: DatabaseSync; now: Date; excludeTest: boolean };
function scope(d: WorkDeps): { sql: string; params: number[] } {
  const ids = managerExperts(d.db).map(e => e.salespersonId);
  if (!ids.length) return { sql: "0", params: [] };
  return { sql: `c.merged_into_customer_id IS NULL AND c.salesperson_id IN (${ids.map(() => "?").join(",")})${d.excludeTest ? ` AND NOT ${testCustomerSql("c")}` : ""}`, params: ids };
}
function users(db: DatabaseSync) { return new Map((db.prepare("SELECT id, role, full_name, username FROM users").all() as any[]).map(u => [Number(u.id), u])); }
function salespersons(db: DatabaseSync) { return new Map((db.prepare("SELECT id, name FROM salespersons").all() as any[]).map(s => [Number(s.id), s.name as string])); }

/* ======================= 1) open invoices (goods purchases) ======================= */
export const GOODS_STAGE_LABELS: Record<string, string> = {
  discharge_pending: "تخلیه اعتبار", invoice_draft: "پیش‌فاکتور", invoice_signature: "امضای فاکتور", settlement_pending: "تسویه با شرکت",
  acknowledgement_signature: "رسید و اقرارنامه", registrar_confirmation: "تأیید ثبت‌کننده", completed: "تکمیل",
};
/** Who the next step waits on (from the goods routes: every staff step needs the registrar/admin; signatures are the customer's). */
const GOODS_WAITING_ON: Record<string, "registrar" | "customer"> = {
  discharge_pending: "registrar", invoice_draft: "registrar", invoice_signature: "customer", settlement_pending: "registrar",
  acknowledgement_signature: "customer", registrar_confirmation: "registrar",
};
/** goods_purchase_events.action → the stage it puts the purchase in (null = no stage change). */
function goodsEventStage(action: string): string | null {
  switch (action) {
    case "created": return "discharge_pending";
    case "external_discharge_confirmed": case "invoice_saved": case "invoice_rejected": return "invoice_draft";
    case "invoice_pending": return "invoice_signature";
    case "invoice_signed": return "settlement_pending";
    case "settled": case "acknowledgement_pending": case "acknowledgement_rejected": return "acknowledgement_signature";
    case "acknowledgement_signed": return "registrar_confirmation";
    case "completed": return "completed";
    default: return null;
  }
}
/** Start of the last unbroken run of events that put the purchase in `stage` (repeated «pending» sends do not reset the clock). */
export function goodsStageEnteredAt(events: { action: string; created_at: string }[], stage: string): string | null {
  let cur: string | null = null; let at: string | null = null;
  for (const e of events) { const s = goodsEventStage(e.action); if (s && s !== cur) { cur = s; at = e.created_at; } }
  return cur === stage ? at : null;
}
export function openInvoices(d: WorkDeps) {
  const now = d.now.getTime(); const s = scope(d); const U = users(d.db); const SP = salespersons(d.db);
  const base = { concept: "goods_purchase_invoice", table: "goods_purchases", uiLabel: "فاکتور فروش کالا", amountUnit: AMOUNT_UNIT,
    generatedAt: d.now.toISOString(), testCustomersExcluded: d.excludeTest };
  if (!has(d.db, "goods_purchases")) return { ...base, count: 0, totalAmount: 0, byStage: [], items: [] };
  const rows = d.db.prepare(`SELECT g.id, g.customer_id, g.salesperson_id, g.stage, g.credit_amount_toman, g.created_by, g.created_at,
      c.name, c.first_name, c.last_name, c.phone, c.salesperson_id c_sp
    FROM goods_purchases g JOIN customers c ON c.id=g.customer_id
    WHERE COALESCE(g.stage,'')<>'completed' AND ${s.sql} ORDER BY g.id`).all(...s.params) as any[];
  const evQ = has(d.db, "goods_purchase_events") ? d.db.prepare("SELECT action, actor_user_id, created_at FROM goods_purchase_events WHERE purchase_id=? ORDER BY created_at, id") : null;
  const items = rows.map(r => {
    const ev = (evQ?.all(r.id) ?? []) as any[];
    const entered = goodsStageEnteredAt(ev, r.stage) ?? r.created_at;
    const staffEv = [...ev].reverse().find(e => { const u = U.get(Number(e.actor_user_id)); return u && (u.role === "registrar" || u.role === "admin") && Number(u.id) !== 29; });
    const respId = staffEv ? Number(staffEv.actor_user_id) : r.created_by != null && Number(r.created_by) !== 29 ? Number(r.created_by) : null;
    const resp = respId != null ? U.get(respId) : undefined;
    const last = ev[ev.length - 1];
    const amt = /^\d+$/.test(String(r.credit_amount_toman ?? "")) ? Number(r.credit_amount_toman) : null;
    const spId = r.salesperson_id ?? r.c_sp;
    return {
      purchaseId: Number(r.id), customerId: Number(r.customer_id), customerName: custName(r), phoneMasked: r.phone ? maskPhone(String(r.phone)) : null,
      stage: r.stage, stageLabel: GOODS_STAGE_LABELS[r.stage] ?? r.stage, waitingOn: GOODS_WAITING_ON[r.stage] ?? "registrar",
      responsible: resp ? { userId: Number(resp.id), name: userName(resp), role: resp.role, basis: staffEv ? "last_staff_action" : "created_by" } : null,
      salesperson: spId != null ? { salespersonId: Number(spId), name: SP.get(Number(spId)) ?? null } : null,
      amount: amt, amountUnit: AMOUNT_UNIT, amountBasis: "credit_amount_toman (= invoice total)",
      stageEnteredAt: entered, hoursInStage: hours(now - ms(entered)), daysInStage: Math.floor(Math.max(0, now - ms(entered)) / DAY),
      lastActivityAt: last?.created_at ?? r.created_at, lastAction: last?.action ?? null, createdAt: r.created_at,
    };
  }).sort((a, b) => b.hoursInStage - a.hoursInStage || a.purchaseId - b.purchaseId);
  const by = new Map<string, { stage: string; label: string; count: number; amount: number }>();
  for (const i of items) { const x = by.get(i.stage) ?? { stage: i.stage, label: i.stageLabel, count: 0, amount: 0 }; x.count++; x.amount += i.amount ?? 0; by.set(i.stage, x); }
  const order = Object.keys(GOODS_STAGE_LABELS);
  return { ...base, count: items.length, totalAmount: items.reduce((t, i) => t + (i.amount ?? 0), 0),
    byStage: [...by.values()].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage)), items };
}

/* ======================= 2) registration cases (loan applications) ======================= */
export const REGISTRATION_RANGES = ["day", "week"] as const;
export type RegistrationRange = (typeof REGISTRATION_RANGES)[number];
export const LOAN_STAGE_LABELS: Record<string, string> = { // order and wording as the loan-applications UI
  draft: "پیش‌نویس", primary_contract_pending_signature: "در انتظار امضای قرارداد توسط مشتری", approved_contract_pending_signature: "امضای قرارداد جایگزین توسط مشتری",
  customer_documents_upload: "بارگذاری مدارک مشتری", customer_documents_review: "بررسی مدارک مشتری", guarantor_registration: "ثبت ضامن",
  funder_initial_approval: "تصویب مبلغ وام", guarantor_documents_upload: "بارگذاری مدارک ضامن", guarantor_documents_review: "بررسی مدارک ضامن",
  collateral_upload: "بارگذاری وثیقه", collateral_review: "بررسی وثیقه", physical_documents_correction: "رفع نقص مدارک فیزیکی",
  physical_documents_submission: "ارسال مدارک فیزیکی", physical_documents_review: "بررسی مدارک فیزیکی", expert_approval: "ثبت تصمیم تأمین‌کننده مالی",
  funder_documents_correction: "اصلاح مدارک مردود تأمین‌کننده", funder_result_review: "بررسی نتیجه تأمین‌کننده",
  funder_amendment_pending_signature: "در انتظار امضای الحاقیه", funder_amendment_review: "بررسی الحاقیه",
  admin_approval: "تأیید نهایی مدیر و شارژ اعتبار", wallet_charge_pending: "در انتظار تأیید شارژ توسط کارشناس ثبت",
  final_invoice_pending_signature: "امضای صورت‌حساب نهایی", completed: "تکمیل شده",
};
/** Same-stage history rows that close a case (status → rejected). */
const CLOSE_ACTIONS = ["cancel-case", "funder-initial-reject"];
export function registrationBounds(range: RegistrationRange, now: Date) {
  const t = now.getTime(); const today = Math.floor((t + OFFSET) / DAY) * DAY - OFFSET;
  const wd = new Date(t + OFFSET).getUTCDay(); // 6 = Saturday
  const start = range === "day" ? today : today - ((wd + 1) % 7) * DAY;
  return { range, from: new Date(start).toISOString(), to: now.toISOString(), label: range === "day" ? "امروز (روز تهران)" : "این هفته (از شنبه، تهران)" };
}
export function registrationReport(d: WorkDeps, range: RegistrationRange, stuckHours: number, stuckSource: "query" | "setting" | "default") {
  const now = d.now.getTime(); const b = registrationBounds(range, d.now); const s = scope(d); const U = users(d.db); const SP = salespersons(d.db);
  const base = { concept: "loan_application", table: "loan_applications", historyTable: "loan_application_stage_history", uiLabel: "درخواست‌های تسهیلات (پرونده)",
    range: b.range, label: b.label, from: b.from, to: b.to, timezone: "Asia/Tehran (UTC+03:30)", weekStarts: "saturday",
    stuckHours, stuckHoursSource: stuckSource, generatedAt: d.now.toISOString(), testCustomersExcluded: d.excludeTest };
  if (!has(d.db, "loan_applications") || !has(d.db, "loan_application_stage_history"))
    return { ...base, openCount: 0, byStage: [], flow: { newCases: 0, completed: 0, closed: 0, inflow: 0, outflow: 0 }, stuck: { count: 0, items: [] }, registrars: [] };
  const open = d.db.prepare(`SELECT a.id, a.customer_id, a.stage, a.status, a.created_at, c.name, c.first_name, c.last_name, c.phone, c.salesperson_id
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.status,'')<>'rejected' AND COALESCE(a.stage,'')<>'completed' AND ${s.sql} ORDER BY a.id`).all(...s.params) as any[];
  const hq = d.db.prepare("SELECT from_stage, to_stage, action, actor_id, created_at FROM loan_application_stage_history WHERE application_id=? ORDER BY created_at, id");
  const cases = open.map(r => {
    const h = hq.all(r.id) as any[];
    const entry = [...h].reverse().find(x => x.to_stage === r.stage && (x.from_stage == null || x.from_stage !== x.to_stage));
    const entered = entry?.created_at ?? r.created_at;
    const reg = [...h].reverse().find(x => U.get(Number(x.actor_id))?.role === "registrar");
    const ru = reg ? U.get(Number(reg.actor_id)) : undefined;
    const dwell = Math.max(0, now - ms(entered));
    return { applicationId: Number(r.id), customerId: Number(r.customer_id), customerName: custName(r), phoneMasked: r.phone ? maskPhone(String(r.phone)) : null,
      stage: r.stage, stageLabel: LOAN_STAGE_LABELS[r.stage] ?? r.stage, status: r.status,
      registrar: ru ? { userId: Number(ru.id), name: userName(ru), basis: "last_registrar_action" } : null,
      salesperson: r.salesperson_id != null ? { salespersonId: Number(r.salesperson_id), name: SP.get(Number(r.salesperson_id)) ?? null } : null,
      stageEnteredAt: entered, hoursInStage: hours(dwell), daysInStage: Math.floor(dwell / DAY) };
  });
  // flow in [from, to): stage changes (from_stage <> to_stage) and same-stage closures; only for cases in scope (any status)
  const flowRows = d.db.prepare(`SELECT h.from_stage, h.to_stage, h.action FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND h.created_at>=? AND h.created_at<? AND ${s.sql}`).all(b.from, new Date(now + 1).toISOString(), ...s.params) as any[];
  const st = new Map<string, { stage: string; label: string; open: number; stuck: number; inflow: number; outflow: number; closed: number }>();
  const S = (k: string) => { let x = st.get(k); if (!x) { x = { stage: k, label: LOAN_STAGE_LABELS[k] ?? k, open: 0, stuck: 0, inflow: 0, outflow: 0, closed: 0 }; st.set(k, x); } return x; };
  const flow = { newCases: 0, completed: 0, closed: 0, inflow: 0, outflow: 0 };
  for (const f of flowRows) {
    const moved = f.from_stage == null || f.from_stage !== f.to_stage;
    if (f.action === "created") flow.newCases++;
    if (moved) { S(f.to_stage).inflow++; flow.inflow++; if (f.from_stage != null) { S(f.from_stage).outflow++; flow.outflow++; } if (f.to_stage === "completed") flow.completed++; }
    else if (CLOSE_ACTIONS.includes(f.action)) { const x = S(f.to_stage); x.closed++; x.outflow++; flow.closed++; flow.outflow++; }
  }
  const stuck = cases.filter(c => c.hoursInStage > stuckHours).sort((a, b) => b.hoursInStage - a.hoursInStage || a.applicationId - b.applicationId);
  for (const c of cases) { const x = S(c.stage); x.open++; if (c.hoursInStage > stuckHours) x.stuck++; }
  const order = Object.keys(LOAN_STAGE_LABELS);
  const regs = new Map<string, { userId: number | null; name: string | null; open: number; stuck: number }>();
  for (const c of cases) { const k = String(c.registrar?.userId ?? "none"); const x = regs.get(k) ?? { userId: c.registrar?.userId ?? null, name: c.registrar?.name ?? null, open: 0, stuck: 0 };
    x.open++; if (c.hoursInStage > stuckHours) x.stuck++; regs.set(k, x); }
  return { ...base, openCount: cases.length,
    byStage: [...st.values()].sort((a, b) => (order.indexOf(a.stage) + 1 || 99) - (order.indexOf(b.stage) + 1 || 99) || a.stage.localeCompare(b.stage)),
    flow, stuck: { count: stuck.length, items: stuck }, registrars: [...regs.values()].sort((a, b) => b.open - a.open) };
}
