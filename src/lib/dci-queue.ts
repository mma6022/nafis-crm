/**
 * DCI-QUEUE v2.1–v2.3.1 (Armita «کارهای امروز من» queue; Mohammad approved in Armita's chat: «بفرست بگو بیاره بالا»).
 * Behind flag.dci_queue_v21 (global '1') or flag.dci_queue_v21.user.<id> = '1'. Absent / anything else = OFF:
 *   GET /daily-customer-inline/queue → 404 dq_off, the page keeps the v2.0 timeline, nothing here writes, no table is created.
 * ON: one read-only queue built from what already exists (today's daily plan, the expert's own file tasks of «پرونده‌های من»,
 * reminders of today incl. not-yet-due ones, today's VoIP incoming/outgoing events, payment orders waiting for the sales
 * expert, returned / correction files). Additive writes only, and only on an explicit expert action:
 *   - dci_queue_marks   (done_at / done_early of a task the expert finished; the plan item / reminder rows are not touched here)
 *   - dci_queue_manual  (a manual outgoing call to an own customer who is not in today's queue)
 *   - «بدون نام» number → named customer (same insertCustomerRecord path as SIMOTEL-132 B), only when the expert saves the name.
 * Never sends SMS / Bale, never places a call.
 */
import type { AuthUser } from "./auth";
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { sf480IncomingNow } from "./sales-fixes-480000";
import { dpBaleHandoffTags, dpToday } from "./daily-plan";
import { FC_STAGE_LABELS, fcExpertStep } from "./files-carousel";
import { paymentCustomer } from "./payment-orders";
import { customerMatcher, experts, normalizePhone, resolveEvent } from "./voip-after-call";
import { insertCustomerRecord } from "./customer-create";
import { dciIsManager, dciOwnsCustomer, tehranClock } from "./daily-customer-inline";

export const DQ_FLAG = "flag.dci_queue_v21";
export const DQ_BLOCKS_KEY = "dci_queue.blocks";
export const DQ_OFF = "dq_off";
export const DQ_NONAME = "بدون نام";
/** 450000 (Armita REVIEW-v21-build §7): an incoming call is «فوری» only this long after it rang, then a normal task in its own slot. */
export const DQ_URGENT_IN_MIN_KEY = "dci_queue.incoming_urgent_min";
export const DQ_GROUP_OVER_KEY = "dci_queue.incoming_group_over";
export const DQ_URGENT_IN_MIN = 30;
export const DQ_GROUP_OVER = 2;
/** 450000 (Q20): early-opened «جواب نداد» / «خاموش یا اشغال» = attempt only (call_logs row kept, task stays open). Additive table. */
export const DQ_ATTEMPTS = "dci_queue_attempts";

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; }
};
export function dqFlagOn(userId: number | null | undefined): boolean {
  if (setting(DQ_FLAG) === "1") return true;
  if (!userId) return false;
  return setting(`${DQ_FLAG}.user.${Number(userId)}`) === "1";
}
const tableExists = (name: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [name]);
const colExists = (t: string, c: string) => { try { return queryRows<{ name: string }>(`PRAGMA table_info(${t})`).some((r) => r.name === c); } catch { return false; } };

const settingInt = (key: string, def: number, min: number, max: number): number => {
  const n = Number(setting(key)); return Number.isInteger(n) && n >= min && n <= max ? n : def;
};
export const dqUrgentInMin = () => settingInt(DQ_URGENT_IN_MIN_KEY, DQ_URGENT_IN_MIN, 1, 600);
export const dqGroupOver = () => settingInt(DQ_GROUP_OVER_KEY, DQ_GROUP_OVER, 1, 50);
/** Call logs that were only an early attempt (never close a task). Empty when the table does not exist. */
function attemptLogIds(): Set<number> {
  if (!tableExists(DQ_ATTEMPTS)) return new Set();
  return new Set(queryRows<{ id: number }>(`SELECT call_log_id id FROM ${DQ_ATTEMPTS} WHERE julianday(created_at) >= julianday('now','-2 days')`).map((r) => Number(r.id)));
}
/** B7: same rule as the rest of the CRM (callback-requests canSeePhone): admin or customers.view sees the full number. */
export function dqCanSeePhone(user: AuthUser): boolean {
  return user.role === "admin" || (user.permissions ?? []).includes("customers.view");
}
export function dqMaskPhone(p: string | null | undefined): string | null {
  const s = String(p ?? "").trim(); if (!s) return null;
  return s.length >= 8 ? `${s.slice(0, 4)}•••${s.slice(-4)}` : "•••";
}

let ready = false;
/** Additive schema, created only while the flag is ON for the caller (first write). */
export function ensureDqSchema(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS dci_queue_marks(
      user_id INTEGER NOT NULL, day TEXT NOT NULL, task_id TEXT NOT NULL, customer_id INTEGER, kind TEXT NOT NULL,
      due_at TEXT, done_at TEXT NOT NULL, done_early INTEGER NOT NULL DEFAULT 0, outcome TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, day, task_id));
    CREATE TABLE IF NOT EXISTS dci_queue_manual(
      user_id INTEGER NOT NULL, day TEXT NOT NULL, customer_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, day, customer_id));`);
  ready = true;
}

/* ---------------- blocks (server setting, default = Armita §0.11) ---------------- */
export type DqBlock = { k: "actual" | "potential"; from: number; to: number }; // minutes after Tehran midnight
export const DQ_DEFAULT_BLOCKS: DqBlock[] = [
  { k: "actual", from: 9 * 60, to: 11 * 60 }, { k: "potential", from: 11 * 60, to: 13 * 60 },
  { k: "actual", from: 13 * 60, to: 16 * 60 }, { k: "potential", from: 16 * 60, to: 18 * 60 },
];
const hm = (v: unknown): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim()); if (!m) return null;
  const n = Number(m[1]) * 60 + Number(m[2]); return n >= 0 && n <= 24 * 60 ? n : null;
};
export function dqBlocks(): DqBlock[] {
  const raw = setting(DQ_BLOCKS_KEY);
  if (!raw) return DQ_DEFAULT_BLOCKS;
  try {
    const arr = JSON.parse(raw);
    const out: DqBlock[] = [];
    for (const b of Array.isArray(arr) ? arr : []) {
      const k = b?.k === "actual" || b?.k === "potential" ? b.k : null; const from = hm(b?.from), to = hm(b?.to);
      if (!k || from == null || to == null || to <= from) return DQ_DEFAULT_BLOCKS;
      if (out.length && from < out[out.length - 1].to) return DQ_DEFAULT_BLOCKS;
      out.push({ k, from, to });
    }
    return out.length ? out : DQ_DEFAULT_BLOCKS;
  } catch { return DQ_DEFAULT_BLOCKS; }
}
const TEHRAN_OFF = 210; // minutes; Iran has no DST since 2022
export const tehranMin = (d: Date) => (((Math.floor(d.getTime() / 60000) + TEHRAN_OFF) % 1440) + 1440) % 1440;
const dayStartIso = (day: string) => new Date(`${day}T00:00:00+03:30`).toISOString();
const dayEndIso = (day: string) => new Date(`${day}T23:59:59.999+03:30`).toISOString();
const minIso = (day: string, min: number) => new Date(Date.parse(dayStartIso(day)) + min * 60000).toISOString();
const isoMin = (iso: string | null | undefined, day: string): number | null => {
  if (!iso) return null; const t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.parse(dayStartIso(day))) / 60000);
};
/** Block index for a minute of the day: inside → that block; gap → next block; before → 0; after → last. */
function blockAt(blocks: DqBlock[], min: number): number {
  for (let i = 0; i < blocks.length; i++) if (min < blocks[i].to) return i;
  return blocks.length - 1;
}

/* ---------------- queue ---------------- */
export type DqKind = "incoming_call" | "outgoing_call" | "new_lead" | "follow_up" | "reminder" | "file_action" | "payment_order";
export const DQ_KINDS: DqKind[] = ["incoming_call", "outgoing_call", "new_lead", "follow_up", "reminder", "file_action", "payment_order"];
const URGENT: DqKind[] = ["incoming_call", "payment_order", "file_action"];
/** Q5 colour strength: interrupts, then outgoing, reminder, new lead, follow-up. */
const STRENGTH: DqKind[] = ["incoming_call", "payment_order", "file_action", "outgoing_call", "reminder", "new_lead", "follow_up"];
type Part = {
  key: string; kind: DqKind; done: boolean; doneAt: string | null; dueAt: string | null; timed: boolean; arrivedAt: string | null;
  urgent: boolean; order: number; dpItemId?: number; dpStatus?: string; reminderId?: number; remText?: string; eventId?: number; live?: boolean;
  direction?: "in" | "out"; paymentOrderId?: number; pay?: any; loanFileId?: number; fileAct?: any; fileTask?: { fileId: number; stage: string; stageLabel: string };
};
export type DqItem = {
  id: string; kind: DqKind; kinds: DqKind[]; block: "actual" | "potential"; blockIdx: number; urgent: boolean; done: boolean; due: boolean;
  due_at: string | null; timed: boolean; done_at: string | null; done_early: boolean; customer_id: number | null; name: string; tm: string;
  overdue: boolean; current: boolean; next: boolean; turn: number; due_ref: string | null;
  itemId: number | null; dpStatus: string | null; reminderId: number | null; remText: string | null; call_id: number | null; live: boolean;
  direction: "in" | "out" | null; detected: "customer" | "lead" | "unknown" | null; payment_order_id: number | null; loan_file_id: number | null;
  pay: any | null; fileAct: any | null; fileTask: { fileId: number; stage: string; stageLabel: string } | null; phone: string | null;
  /** 450000 B7: full number only when the viewer may see phones (dqCanSeePhone); phone_masked always. */
  phone_masked: string | null; phone_full: boolean;
  /** 450000 Q20: early attempts recorded today (task stayed open). */
  attempts: number;
  /** «فضای کار بله» (flag.bale_workspace_v1): «بی‌پاسخ در بله» on the customer's row (new or already listed) after a no-reply hand-off today. */
  tag?: string; tagAt?: string; tagReason?: string;
};

function custRow(id: number): { id: number; name: string; salesperson_id: number | null; phone: string | null } | null {
  return queryRow<any>("SELECT id, name, salesperson_id, phone FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]) ?? null;
}
const OPEN_FILE = "a.deleted_at IS NULL AND a.status<>'rejected' AND a.stage<>'completed'";
function hasOpenFile(customerId: number): boolean {
  if (!tableExists("loan_applications")) return false;
  return !!queryRow(`SELECT 1 x FROM loan_applications a WHERE a.customer_id=? AND ${OPEN_FILE} LIMIT 1`, [customerId]);
}
function detectOf(customerId: number | null, name: string | null, day: string): "customer" | "lead" | "unknown" {
  if (customerId == null) return "unknown";
  const n = String(name ?? "").trim();
  if (!n || n === DQ_NONAME) return "unknown";
  if (tableExists("loan_applications") && queryRow("SELECT 1 x FROM loan_applications a WHERE a.customer_id=? AND a.deleted_at IS NULL LIMIT 1", [customerId])) return "customer";
  if (queryRow("SELECT 1 x FROM call_logs WHERE customer_id=? AND julianday(created_at) < julianday(?) LIMIT 1", [customerId, dayStartIso(day)])) return "customer";
  return "lead";
}

export function dqQueue(user: AuthUser, now = new Date()) {
  const day = dpToday(now);
  const blocks = dqBlocks();
  const nowMin = tehranMin(now);
  const nowIdx = blocks.findIndex((b) => nowMin >= b.from && nowMin < b.to);
  const ref = nowIdx >= 0 ? nowIdx : (nowMin < blocks[0].from ? 0 : blocks.length - 1);
  const sp = user.salespersonId == null ? null : Number(user.salespersonId);
  const startIso = dayStartIso(day), endIso = dayEndIso(day), nowIso = now.toISOString();
  const urgentMs = dqUrgentInMin() * 60000;
  const attempts = attemptLogIds();
  const notAttempt = attempts.size ? ` AND l.id NOT IN (SELECT call_log_id FROM ${DQ_ATTEMPTS})` : "";
  const marks = tableExists("dci_queue_marks")
    ? new Map(queryRows<any>("SELECT task_id, done_at, done_early FROM dci_queue_marks WHERE user_id=? AND day=?", [user.id, day]).map((m) => [String(m.task_id), m]))
    : new Map<string, any>();
  const byCust = new Map<number, Part[]>();
  const bwsTags = dpBaleHandoffTags(sp, day);
  const byUnknown = new Map<string, { eventId: number; phone: string; parts: Part[] }>();
  let order = 0;
  const add = (cid: number, p: Part) => { const a = byCust.get(cid) ?? []; a.push(p); byCust.set(cid, a); };

  // 1) today's daily plan (the existing «بالقوه» list; type first/lead → new lead, reminder → reminder, else follow-up)
  if (sp != null && tableExists("dp_plans") && tableExists("dp_items")) {
    const plan = queryRow<{ id: number }>("SELECT id FROM dp_plans WHERE salesperson_id=? AND day=?", [sp, day]);
    if (plan) {
      const rows = queryRows<any>(
        `SELECT i.id, i.customer_id, i.type, i.source, i.status, i.done_at, i.created_at, i.moved_to, i.label
         FROM dp_items i JOIN customers c ON c.id=i.customer_id AND c.merged_into_customer_id IS NULL
         WHERE i.plan_id=? AND i.status NOT IN ('skipped','transferred','reserve')
           AND (i.status <> 'covered' OR i.label = 'پرونده‌ی وام باز دارد')
         ORDER BY CASE i.status WHEN 'current' THEN 0 WHEN 'pending' THEN 1 WHEN 'moved' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, i.position, i.id`, [plan.id]);
      for (const r of rows) {
        const t = String(r.type || "").toLowerCase(), s = String(r.source || "").toLowerCase();
        const kind: DqKind = t === "first" || t.includes("lead") || s.includes("lead") ? "new_lead" : (t.includes("remind") || s.includes("remind")) ? "reminder" : "follow_up";
        const done = r.status === "done" || r.status === "covered";
        add(Number(r.customer_id), { key: `p-${r.id}`, kind, done, doneAt: done ? (r.done_at ?? null) : null, dueAt: r.moved_to ?? null, timed: Boolean(r.moved_to),
          arrivedAt: r.created_at ?? null, urgent: false, order: order++, dpItemId: Number(r.id), dpStatus: String(r.status) });
      }
    }
  }
  // 2) «بالفعل»: the expert's own open files on an expert step (read-only; the «پرونده‌های من» deck itself is not touched)
  if (sp != null && tableExists("loan_applications")) {
    const hasFu = tableExists("fc_followups");
    const rows = queryRows<any>(
      `SELECT a.id, a.customer_id, a.stage, a.created_at ${hasFu ? ", (SELECT f.created_at FROM fc_followups f WHERE f.file_id=a.id AND f.salesperson_id=? AND f.day=? LIMIT 1) fu_at" : ", NULL fu_at"}
       FROM loan_applications a JOIN customers c ON c.id=a.customer_id AND c.merged_into_customer_id IS NULL
       WHERE ${OPEN_FILE} AND c.salesperson_id=? ORDER BY a.id`, hasFu ? [sp, day, sp] : [sp]);
    for (const r of rows) {
      if (!fcExpertStep(String(r.stage)) && !r.fu_at) continue;
      const key = `f-${r.id}`; const m = marks.get(key);
      // 450000 (Armita REVIEW-v21-build §2 / patch 5): a call result saved today by this expert closes the open «بالفعل» file task for today.
      const called = r.fu_at || m ? null : queryRow<{ created_at: string }>(
        `SELECT l.created_at FROM call_logs l WHERE l.customer_id=? AND julianday(l.created_at) >= julianday(?) AND (l.salesperson_id=? OR l.created_by_user_id=?)
           AND trim(COALESCE(l.outcome,''))<>''${notAttempt}
         ORDER BY l.created_at DESC LIMIT 1`, [r.customer_id, startIso, sp, user.id]);
      const done = Boolean(r.fu_at || m || called);
      add(Number(r.customer_id), { key, kind: "follow_up", done, doneAt: done ? (m?.done_at ?? r.fu_at ?? called?.created_at ?? null) : null, dueAt: null, timed: false, arrivedAt: r.created_at,
        urgent: false, order: order++, loanFileId: Number(r.id), fileTask: { fileId: Number(r.id), stage: String(r.stage), stageLabel: FC_STAGE_LABELS[r.stage] ?? String(r.stage) } });
    }
  }
  // 3) reminders of today (due and not yet due) + older open ones (overdue). Own customer only.
  if (tableExists("reminders") && sp != null) {
    const rows = queryRows<any>(
      `SELECT r.id, r.customer_id, r.message, r.subject, r.remind_at, r.done, r.closed_at
       FROM reminders r JOIN customers c ON c.id=r.customer_id AND c.merged_into_customer_id IS NULL AND c.salesperson_id=?
       WHERE r.user_id=? AND r.customer_id IS NOT NULL AND r.voided_at IS NULL
         AND ((r.done=0 AND julianday(r.remind_at) <= julianday(?)) OR (julianday(r.remind_at) >= julianday(?) AND julianday(r.remind_at) <= julianday(?)))
       ORDER BY r.remind_at, r.id`, [sp, user.id, endIso, startIso, endIso]);
    for (const r of rows) {
      const done = Number(r.done) === 1; const m = marks.get(`r-${r.id}`);
      add(Number(r.customer_id), { key: `r-${r.id}`, kind: "reminder", done, doneAt: done ? (m?.done_at ?? r.closed_at ?? null) : null, dueAt: r.remind_at, timed: true,
        arrivedAt: r.remind_at, urgent: false, order: order++, reminderId: Number(r.id), remText: String(r.message || r.subject || "").trim() });
    }
  }
  // 4) today's VoIP calls: incoming (own customer or rang this expert) and outgoing by this expert
  if (tableExists("voip_after_call_events")) {
    const excl = tableExists("voip_call_display_exclusions") ? "AND NOT EXISTS (SELECT 1 FROM voip_call_display_exclusions h WHERE h.phone=e.phone)" : "";
    const rows = queryRows<any>(
      `SELECT e.id, e.phone, lower(e.direction) dir, e.status, e.started_at, e.customer_id, e.call_log_id, e.completed_at, e.completed_by_user_id, e.is_live, e.expert_user_id,
              c.salesperson_id csp, c.name cname
       FROM voip_after_call_events e LEFT JOIN customers c ON c.id=e.customer_id AND c.merged_into_customer_id IS NULL
       WHERE julianday(e.started_at) >= julianday(?) AND julianday(e.started_at) <= julianday(?) AND e.mobile_device_id IS NULL ${excl}
         AND ((lower(e.direction) IN ('incoming','inbound') AND (e.expert_user_id=? OR (c.id IS NOT NULL AND c.salesperson_id=?)))
           OR (lower(e.direction) IN ('outgoing','outbound') AND e.expert_user_id=?))
       ORDER BY e.started_at, e.id`, [startIso, endIso, user.id, sp ?? -1, user.id]);
    // 450000 §7: a callback (this expert's outgoing call to the same number after the ring) closes the incoming task.
    const outs = rows.filter((x) => x.dir === "outgoing" || x.dir === "outbound").map((x) => ({ ph: normalizePhone(String(x.phone || "")) ?? String(x.phone || ""), at: String(x.started_at) }));
    const lookup = customerMatcher(); // t848u: resolve an unlinked event by phone at read time (no write)
    for (const e of rows) {
      const inn = e.dir === "incoming" || e.dir === "inbound";
      if (e.customer_id == null && inn) {
        const hit = lookup(String(e.phone || ""));
        if (hit) {
          const c = custRow(hit.id);
          if (c) { e.customer_id = c.id; e.csp = c.salesperson_id; e.cname = c.name; }
        }
      }
      // another expert's customer: skip unless this event rang the current expert (they still need to see the name)
      if (e.customer_id != null && e.csp != null && sp != null && Number(e.csp) !== sp && Number(e.expert_user_id) !== user.id) continue;
      const key = `${inn ? "in" : "out"}-${e.id}`; const m = marks.get(key);
      const later = e.customer_id != null && !!queryRow(
        `SELECT 1 x FROM call_logs l WHERE l.customer_id=? AND l.id<>COALESCE(?,0) AND julianday(l.created_at) > julianday(?) ${sp != null ? "AND (l.salesperson_id=? OR l.created_by_user_id=?)" : ""}${notAttempt} LIMIT 1`,
        sp != null ? [e.customer_id, e.call_log_id, e.started_at, sp, user.id] : [e.customer_id, e.call_log_id, e.started_at]);
      const eph = normalizePhone(String(e.phone || "")) ?? "";
      const back = inn && !!eph && outs.find((o) => o.ph === eph && o.at > String(e.started_at));
      const done = Boolean(m || (e.completed_at && e.completed_by_user_id != null) || later || back);
      const fresh = now.getTime() - Date.parse(String(e.started_at)) < urgentMs;
      const p: Part = { key, kind: inn ? "incoming_call" : "outgoing_call", done, doneAt: done ? (m?.done_at ?? e.completed_at ?? (back ? back.at : null)) : null, dueAt: e.started_at, timed: true,
        arrivedAt: e.started_at, urgent: inn && !done && (fresh || (Number(e.is_live) === 1 && sf480IncomingNow())), order: order++, /* SALES-FIXES 480000: a live incoming call stays in «اکنون» */ eventId: Number(e.id), live: Number(e.is_live) === 1, direction: inn ? "in" : "out" };
      if (e.customer_id != null) add(Number(e.customer_id), p);
      else if (Number(e.expert_user_id) === user.id) {
        // t861: never show a non-phone string (e.g. a CDR «failed») as the number; such calls stay separate, with no number.
        const ph = normalizePhone(String(e.phone || "")) ?? "";
        const gk = ph || `ev-${e.id}`;
        const g = byUnknown.get(gk) ?? { eventId: Number(e.id), phone: ph, parts: [] };
        g.parts.push(p); byUnknown.set(gk, g);
      }
    }
  }
  // 5) manual outgoing (no VoIP) to an own customer not in the queue
  if (tableExists("dci_queue_manual")) {
    for (const r of queryRows<any>("SELECT customer_id, created_at FROM dci_queue_manual WHERE user_id=? AND day=? ORDER BY created_at", [user.id, day])) {
      const c = custRow(Number(r.customer_id)); if (!c || (sp != null && Number(c.salesperson_id) !== sp)) continue;
      const key = `om-${r.customer_id}`; const m = marks.get(key);
      const later = !!queryRow(`SELECT 1 x FROM call_logs l WHERE l.customer_id=? AND julianday(l.created_at) >= julianday(?)${notAttempt} LIMIT 1`, [r.customer_id, r.created_at]);
      const done = Boolean(m || later);
      add(Number(r.customer_id), { key, kind: "outgoing_call", done, doneAt: done ? (m?.done_at ?? null) : null, dueAt: r.created_at, timed: true, arrivedAt: r.created_at,
        urgent: false, order: order++, direction: "out" });
    }
  }
  // 6) payment orders waiting for THIS sales expert (same scope rule as POST /payment-orders/:id/sales-approve)
  const canApprove = user.role === "admin" || (user.permissions ?? []).includes("payment_orders.sales_approve");
  if (canApprove && sp != null && tableExists("customer_payment_orders")) {
    const rows = queryRows<any>(
      `SELECT o.id, o.customer_id, o.amount_toman, o.stage, o.created_at, o.updated_at, o.sales_approved_by, plan.name plan_name, p.plan_id
       FROM customer_payment_orders o JOIN customers c ON c.id=o.customer_id AND c.merged_into_customer_id IS NULL AND c.salesperson_id=?
       LEFT JOIN goods_purchases p ON p.id=o.purchase_id LEFT JOIN loan_plans plan ON plan.id=p.plan_id
       WHERE o.stage='sales_approval' OR (o.sales_approved_by=? AND julianday(o.updated_at) >= julianday(?))
       ORDER BY o.created_at, o.id`, [sp, user.id, startIso]);
    for (const o of rows) {
      const pc = paymentCustomer(Number(o.customer_id), user);
      if (!pc || pc.payment_scope_salesperson_id !== user.salespersonId) continue;
      const done = o.stage !== "sales_approval";
      add(Number(o.customer_id), { key: `po-${o.id}`, kind: "payment_order", done, doneAt: done ? o.updated_at : null, dueAt: o.created_at, timed: true,
        arrivedAt: o.created_at, urgent: !done, order: order++, paymentOrderId: Number(o.id),
        pay: { id: Number(o.id), amountToman: String(o.amount_toman ?? ""), planName: o.plan_name ?? null, createdAt: o.created_at, stage: o.stage } });
    }
  }
  // 7) «اقدام پرونده»: a file that came back to the expert (unseen fc_returns) or sits in a correction stage
  if (sp != null && tableExists("loan_applications")) {
    const ret = tableExists("fc_returns")
      ? new Map(queryRows<any>("SELECT file_id, MAX(returned_at) returned_at, MAX(reason_code) reason_code FROM fc_returns WHERE salesperson_id=? AND opened_at IS NULL GROUP BY file_id", [sp]).map((r) => [Number(r.file_id), r]))
      : new Map<number, any>();
    const CORR = ["funder_documents_correction", "physical_documents_correction"];
    const rows = queryRows<any>(
      `SELECT a.id, a.customer_id, a.stage, a.updated_at, a.created_at, plan.name plan_name FROM loan_applications a
       JOIN customers c ON c.id=a.customer_id AND c.merged_into_customer_id IS NULL AND c.salesperson_id=?
       LEFT JOIN loan_plans plan ON plan.id=a.plan_id
       WHERE ${OPEN_FILE} ORDER BY a.id`, [sp]);
    const docs = tableExists("loan_application_documents");
    for (const a of rows) {
      const r = ret.get(Number(a.id));
      if (!r && !CORR.includes(String(a.stage))) continue;
      const key = `fa-${a.id}`; const m = marks.get(key);
      const bad = docs ? queryRows<any>("SELECT label, incomplete_reason FROM loan_application_documents WHERE application_id=? AND status IN ('rejected','incomplete') ORDER BY id LIMIT 3", [a.id]) : [];
      const need = bad.length ? bad.map((d) => `بارگذاری دوباره‌ی ${d.label}${d.incomplete_reason ? `؛ دلیل: ${String(d.incomplete_reason).slice(0, 120)}` : ""}`).join(" — ")
        : (FC_STAGE_LABELS[a.stage] ?? String(a.stage));
      const at = r?.returned_at ?? a.updated_at ?? a.created_at;
      add(Number(a.customer_id), { key, kind: "file_action", done: Boolean(m), doneAt: m?.done_at ?? null, dueAt: at, timed: true, arrivedAt: at, urgent: !m, order: order++,
        loanFileId: Number(a.id), fileAct: { fileId: Number(a.id), stage: String(a.stage), stageLabel: FC_STAGE_LABELS[a.stage] ?? String(a.stage), planName: a.plan_name ?? null, need } });
    }
  }

  /* -------- merge: one customer = one queue item (Q5, t317u) -------- */
  const items: DqItem[] = [];
  const seePhone = dqCanSeePhone(user);
  const attemptsByCust = new Map<number, number>();
  if (attempts.size) for (const r of queryRows<{ customer_id: number; n: number }>(
    `SELECT customer_id, COUNT(*) n FROM ${DQ_ATTEMPTS} WHERE user_id=? AND day=? GROUP BY customer_id`, [user.id, day])) attemptsByCust.set(Number(r.customer_id), Number(r.n));
  const build = (id: string, cid: number | null, name: string, phone: string | null, parts: Part[]): DqItem => {
    const itemMark = marks.get(id);
    for (const p of parts) if (!p.done && itemMark && p.kind !== "reminder" && p.kind !== "payment_order" && (!p.arrivedAt || p.arrivedAt <= itemMark.done_at)) {
      // a mark on the whole item closes parts that only the queue knows about (file task / calls); plan items, reminders and payment
      // orders keep their own state (closed by their own live paths).
      if (p.dpItemId == null) { p.done = true; p.doneAt = itemMark.done_at; }
    }
    const open = parts.filter((p) => !p.done);
    const pick = (ps: Part[]) => [...ps].sort((a, b) => STRENGTH.indexOf(a.kind) - STRENGTH.indexOf(b.kind) || a.order - b.order)[0];
    const main = pick(open.length ? open : parts);
    const kinds = [...new Set([...parts].sort((a, b) => STRENGTH.indexOf(a.kind) - STRENGTH.indexOf(b.kind)).map((p) => p.kind))];
    const done = open.length === 0;
    const urgent = open.some((p) => p.urgent);
    const timedOpen = open.filter((p) => p.timed && p.dueAt).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
    const dueAt = done ? (main.dueAt ?? null) : (timedOpen[0]?.dueAt ?? null);
    const doneAt = done ? (itemMark?.done_at ?? parts.map((p) => p.doneAt).filter(Boolean).sort().pop() ?? null) : null;
    const dp = open.find((p) => p.dpItemId != null) ?? parts.find((p) => p.dpItemId != null);
    const rem = open.find((p) => p.reminderId != null) ?? (done ? parts.find((p) => p.reminderId != null) : undefined);
    const ev = open.find((p) => p.eventId != null) ?? parts.filter((p) => p.eventId != null).pop();
    const pay = open.find((p) => p.pay) ?? null;
    const fa = open.find((p) => p.fileAct) ?? null;
    const ft = open.find((p) => p.fileTask) ?? parts.find((p) => p.fileTask) ?? null;
    const hasFile = cid != null && (Boolean(parts.some((p) => p.fileTask || p.fileAct || p.pay)) || hasOpenFile(cid));
    const overdue = !done && Boolean(rem && rem.dueAt && Date.parse(rem.dueAt) < now.getTime() - 60000);
    const remDue = rem && rem.dueAt ? Date.parse(rem.dueAt) <= now.getTime() : true;
    const isCall = (p: Part) => p.kind === "incoming_call" || p.kind === "outgoing_call";
    const callPart = open.find(isCall) ?? null;
    const anyCall = callPart ?? [...parts].reverse().find(isCall) ?? null; // a handled call keeps its direction / detect chip
    return {
      id, kind: main.kind, kinds, block: hasFile ? "actual" : "potential", blockIdx: 0, urgent, done, due: main.kind === "reminder" && !done ? remDue : true,
      due_at: dueAt, timed: Boolean(dueAt), done_at: doneAt, done_early: Boolean(itemMark && Number(itemMark.done_early) === 1),
      customer_id: cid, name, tm: tehranClock(dueAt ?? (done ? doneAt : null)) || "", overdue, current: false, next: false, turn: 0, due_ref: null,
      itemId: dp?.dpItemId ?? null, dpStatus: dp?.dpStatus ?? null, reminderId: rem?.reminderId ?? null, remText: rem?.remText ?? null,
      call_id: ev?.eventId ?? null, live: Boolean(callPart?.live), direction: anyCall?.direction ?? (ev?.direction ?? null),
      detected: anyCall || cid == null ? detectOf(cid, name, day) : null,
      payment_order_id: pay?.paymentOrderId ?? null, loan_file_id: fa?.loanFileId ?? ft?.loanFileId ?? null,
      pay: pay?.pay ?? null, fileAct: fa?.fileAct ?? null, fileTask: ft?.fileTask ?? null,
      phone: cid == null && phone ? (seePhone ? phone : null) : null, phone_masked: cid == null ? dqMaskPhone(phone) : null, phone_full: cid == null && !!phone && seePhone,
      attempts: cid != null ? (attemptsByCust.get(cid) ?? 0) : 0,
      ...(cid != null && bwsTags.has(cid) ? { tag: bwsTags.get(cid)!.tag, tagAt: bwsTags.get(cid)!.at, tagReason: bwsTags.get(cid)!.reason } : {}),
    };
  };
  for (const [cid, parts] of byCust) {
    const c = custRow(cid); if (!c) continue;
    if (sp != null && c.salesperson_id != null && Number(c.salesperson_id) !== sp && !dciIsManager(user)) continue; // moved to another expert (t317u)
    items.push(build(`c-${cid}`, cid, String(c.name ?? ""), null, parts));
  }
  for (const g of byUnknown.values()) items.push(build(`e-${g.eventId}`, null, DQ_NONAME, g.phone, g.parts));

  /* -------- placement in the four blocks -------- */
  const nearest = (k: "actual" | "potential") => {
    for (let i = ref; i < blocks.length; i++) if (blocks[i].k === k) return i;
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].k === k) return i;
    return ref;
  };
  for (const it of items) {
    if (it.done) { const m = isoMin(it.done_at, day); it.blockIdx = m == null ? ref : blockAt(blocks, Math.max(0, m)); continue; }
    if (it.urgent || it.kind === "outgoing_call") { it.blockIdx = ref; continue; }
    // 450000 §7: after its urgent window an incoming call is a normal task in the slot where it rang.
    if (it.kind === "incoming_call" && it.due_at) { const m = isoMin(it.due_at, day); it.blockIdx = m == null ? ref : blockAt(blocks, Math.max(0, m)); continue; }
    if (it.kind === "reminder" && it.due_at) {
      const m = isoMin(it.due_at, day);
      it.blockIdx = m == null || Date.parse(it.due_at) <= now.getTime() ? ref : blockAt(blocks, m); continue;
    }
    if (it.dpStatus === "current") { it.blockIdx = ref; continue; }
    it.blockIdx = nearest(it.block);
  }
  // current: the plan's current item, else the first open non-urgent item of the reference block, else the first open item
  const UORD = (k: DqKind) => URGENT.indexOf(k) < 0 ? 9 : URGENT.indexOf(k);
  const seqKey = (it: DqItem) => it.timed && it.due_at ? (isoMin(it.due_at, day) ?? 0) : blocks[it.blockIdx].from;
  const sorted: DqItem[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const inB = items.filter((x) => x.blockIdx === b);
    const done = inB.filter((x) => x.done).sort((x, y) => String(x.done_at ?? "").localeCompare(String(y.done_at ?? "")));
    const open = inB.filter((x) => !x.done);
    const urg = open.filter((x) => x.urgent).sort((x, y) => UORD(x.kind) - UORD(y.kind) || String(x.due_at ?? "").localeCompare(String(y.due_at ?? "")));
    const rest = open.filter((x) => !x.urgent).sort((x, y) => (x.dpStatus === "current" ? -1 : 0) - (y.dpStatus === "current" ? -1 : 0) || seqKey(x) - seqKey(y));
    if (b === ref && rest.length) sorted.push(...done, rest[0], ...urg, ...rest.slice(1));
    else sorted.push(...done, ...urg, ...rest);
  }
  const curIdx = (() => {
    const inRef = sorted.findIndex((x) => x.blockIdx === ref && !x.done && !x.urgent);
    if (inRef >= 0) return inRef;
    return sorted.findIndex((x) => !x.done);
  })();
  sorted.forEach((x, i) => { x.turn = i + 1; x.current = i === curIdx; x.due_ref = x.timed && x.due_at ? x.due_at : minIso(day, blocks[x.blockIdx].from); });
  if (curIdx >= 0) { const nx = sorted.slice(curIdx + 1).find((x) => !x.done); if (nx) nx.next = true; }
  const counts: Record<string, number> = Object.fromEntries(DQ_KINDS.map((k) => [k, 0]));
  for (const x of sorted) if (!x.done) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    date: day, now: nowIso, nowBlock: nowIdx, refBlock: ref, inHours: nowIdx >= 0,
    blocks: blocks.map((b) => ({ k: b.k, from: fmt(b.from), to: fmt(b.to), fromIso: minIso(day, b.from) })),
    items: sorted, counts, openCount: sorted.filter((x) => !x.done).length, currentId: curIdx >= 0 ? sorted[curIdx].id : null,
    urgentInMin: dqUrgentInMin(), groupOver: dqGroupOver(),
    /** 450000 §7: more than groupOver urgent incoming calls → one «تماس‌های ورودی (n)» node (newest opens). */
    incomingGroup: (() => {
      const u = sorted.filter((x) => !x.done && x.urgent && x.kind === "incoming_call");
      if (u.length <= dqGroupOver()) return null;
      const newest = [...u].sort((a, b) => String(b.due_at ?? "").localeCompare(String(a.due_at ?? "")))[0];
      return { count: u.length, ids: u.map((x) => x.id), newestId: newest.id };
    })(),
  };
}

/* ---------------- writes (explicit expert actions only) ---------------- */
type R = { status: number; body: any };
/** POST /daily-customer-inline/queue/done — after a saved result / approval: done_at + done_early. Plan item / reminder rows are not touched. */
export function dqMarkDone(user: AuthUser, body: any, now = new Date()): R {
  const taskId = String(body?.taskId ?? "").trim();
  if (!/^(c|e)-\d+$/.test(taskId)) return { status: 400, body: { error: "bad_task", message: "کار پیدا نشد." } };
  const q = dqQueue(user, now);
  const it = q.items.find((x) => x.id === taskId);
  if (!it) return { status: 404, body: { error: "task_not_found", message: "این کار در کارهای امروز شما نیست." } };
  ensureDqSchema();
  // The task is already closed by its own live path when this runs (result saved first), so its slot is taken from the client's
  // copy of the queue it opened (due_ref = its time, or the start of its block), clamped to today; else from the queue now.
  const dayStart = Date.parse(dayStartIso(q.date)), dayEnd = Date.parse(dayEndIso(q.date));
  const ref = Date.parse(String(body?.dueRef ?? ""));
  const blockStart = q.blocks[it.blockIdx]?.fromIso ?? null;
  const due = Number.isFinite(ref) && ref >= dayStart && ref <= dayEnd ? new Date(ref).toISOString() : (it.timed && it.due_at ? it.due_at : blockStart);
  const early = Boolean(due && now.getTime() < Date.parse(due));
  const outcome = typeof body?.outcome === "string" ? body.outcome.slice(0, 32) : null;
  execute(`INSERT INTO dci_queue_marks(user_id,day,task_id,customer_id,kind,due_at,done_at,done_early,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,day,task_id) DO UPDATE SET done_at=excluded.done_at, done_early=excluded.done_early, outcome=excluded.outcome`,
    [user.id, q.date, taskId, it.customer_id, it.kind, due, now.toISOString(), early ? 1 : 0, outcome, now.toISOString()]);
  return { status: 200, body: { ok: true, taskId, done_at: now.toISOString(), done_early: early } };
}
/** POST /daily-customer-inline/queue/outgoing — manual call (no VoIP) to an own customer who is not in today's queue (Q14: in queue → no new task). */
export function dqManualOutgoing(user: AuthUser, body: any, now = new Date()): R {
  const cid = Number(body?.customerId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return { status: 400, body: { error: "bad_customer" } };
  if (!dciOwnsCustomer(user, cid)) return { status: 403, body: { error: "not_owner", message: "مشتری شما نیست" } };
  const q = dqQueue(user, now);
  const hit = q.items.find((x) => x.customer_id === cid && !x.done);
  if (hit) return { status: 200, body: { ok: true, taskId: hit.id, created: false } };
  ensureDqSchema();
  execute("INSERT OR IGNORE INTO dci_queue_manual(user_id,day,customer_id,created_at) VALUES(?,?,?,?)", [user.id, q.date, cid, now.toISOString()]);
  return { status: 200, body: { ok: true, taskId: `c-${cid}`, created: true } };
}
const nameBad = (s: string) => [...s].length < 2 || [...s].length > 30 || /[\d۰-۹٠-٩]/.test(s);
/** POST /daily-customer-inline/queue/unknown/:eventId/name — the «بدون نام» number of MY call → a named customer of mine (name first). */
export function dqNameUnknown(user: AuthUser, eventId: number, body: any): R {
  if (user.salespersonId == null || user.role === "registrar") return { status: 403, body: { error: "not_allowed", message: "ساختن مشتری از این تماس برای شما نیست." } };
  const e = queryRow<any>("SELECT * FROM voip_after_call_events WHERE id=? AND expert_user_id=? AND mobile_device_id IS NULL", [eventId, user.id]);
  if (!e) return { status: 404, body: { error: "not_found", message: "این تماس پیدا نشد." } };
  const first = String(body?.firstName ?? "").replace(/\s+/g, " ").trim(), last = String(body?.lastName ?? "").replace(/\s+/g, " ").trim();
  const err: Record<string, string> = {};
  if (nameBad(first)) err.firstName = "نام را درست بنویسید (بدون عدد).";
  if (nameBad(last)) err.lastName = "نام خانوادگی را درست بنویسید (بدون عدد).";
  if (Object.keys(err).length) return { status: 422, body: { error: "invalid_name", message: "نام و نام خانوادگی مشتری را کامل بنویسید.", fields: err } };
  const name = `${first} ${last}`;
  let cid: number | null = e.customer_id != null ? Number(e.customer_id) : (customerMatcher()(String(e.phone))?.id ?? null);
  if (cid != null) {
    const c = custRow(cid);
    if (!c || Number(c.salesperson_id) !== Number(user.salespersonId)) return { status: 409, body: { error: "other_owner", message: "این شماره مشتری کارشناس دیگری است؛ برای شما مشتری ساخته نمی‌شود." } };
    if (String(c.name ?? "").trim() && String(c.name).trim() !== DQ_NONAME) return { status: 409, body: { error: "exists", message: "این شماره در CRM هست.", customerId: cid } };
    executeChanges("UPDATE customers SET name=? WHERE id=?", [name, cid]);
  } else {
    const p = normalizePhone(String(e.phone || ""));
    if (!p || !/^09\d{9}$/.test(p)) return { status: 422, body: { error: "invalid_phone", message: "این شماره موبایل نیست؛ مشتری ساخته نشد." } };
    try {
      cid = insertCustomerRecord({ name, phone: p, registeredByUserId: Number(user.id), registrationSource: "staff_form", assignedSalespersonId: Number(user.salespersonId),
        priority: 1, intake: { leadSource: "other", leadSourceOther: e.direction === "incoming" ? "تماس ورودی (کارهای امروز من)" : "تماس خروجی بیرون از صف (کارهای امروز من)" }, skipDefaultOwnerRule: true } as any);
    } catch (x) { if (x instanceof Error && /CONFLICT|UNIQUE/i.test(x.message)) return { status: 409, body: { error: "exists", message: "این شماره در CRM هست." } }; throw x; }
  }
  if (colExists("customers", "first_name") && colExists("customers", "last_name")) executeChanges("UPDATE customers SET first_name=?, last_name=? WHERE id=?", [first, last, cid]);
  // link today's calls from this number to the customer (same as SIMOTEL-132 B linkCustomer: the call log follows from resolveEvent)
  const phone = normalizePhone(String(e.phone || ""));
  const evs = queryRows<any>("SELECT id, phone, completed_at FROM voip_after_call_events WHERE customer_id IS NULL AND expert_user_id=? AND julianday(started_at) >= julianday(?)",
    [user.id, dayStartIso(dpToday(new Date(e.started_at)))]).filter((x) => x.id === e.id || (phone && normalizePhone(String(x.phone || "")) === phone));
  const ex = experts(), match = customerMatcher();
  for (const x of evs) {
    executeChanges("UPDATE voip_after_call_events SET customer_id=? WHERE id=? AND customer_id IS NULL", [cid, x.id]);
    if (!x.completed_at) { try { resolveEvent(Number(x.id), ex, match); } catch { /* the call log follows on the next ingest */ } }
  }
  return { status: 200, body: { ok: true, customerId: cid, taskId: `c-${cid}`, name } };
}
