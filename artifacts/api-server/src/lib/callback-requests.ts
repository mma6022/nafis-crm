import { execute, queryRow, queryRows, runImmediateTransaction, type SqlValue } from "./crm-db";
import { answerCallbackSiteLead, ensureSiteLeadSchema, recordSiteLeadRequest } from "./site-leads";
import { customerSearchSql, toLatinDigits } from "./customer-id-search";
import { CALLBACK_CONFIG } from "./callback-config";
import { insertCustomerRecord } from "./customer-create";
import { notifyWebsiteCallback, type CallbackAlertOutcome } from "./customer-notifications";
import {
  CALLBACK_STATUSES, CANCEL_REASONS, WEBSITE_LEAD_TAG, canonicalCustomerByMobile, defaultAllocationProgramId, ensurePublicLeadSchema,
} from "./public-leads";

/** Staff side of «درخواست تماس کارشناس». Pure rules first (unit-tested), then data access. */
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];
export type CancelReason = (typeof CANCEL_REASONS)[number];
export type ContactTime = "now" | "morning" | "evening";
export type CallbackNeed = "cash" | "goods" | "help";
export type CallbackActor = {
  id: number;
  role: string;
  permissions: readonly string[];
  customerScope: "all" | "assigned";
};
type CallbackPermission = "callbacks.view" | "callbacks.manage" | "callbacks.assign" | "customers.create" | "customers.view";

export const CALLBACK_STATUS_FA: Record<CallbackStatus, string> = {
  new: "جدید",
  in_progress: "در حال پیگیری",
  called: "تماس گرفته شد",
  no_answer: "پاسخ نداد",
  cancelled: "لغو",
};
export const CANCEL_REASON_FA: Record<CancelReason, string> = {
  duplicate: "درخواست تکراری",
  wrong_number: "شماره اشتباه",
  changed_mind: "منصرف شد",
  other: "سایر",
};
export const CONTACT_TIME_FA: Record<ContactTime, string> = {
  now: "همین الان (ساعت کاری)",
  morning: "صبح (۹ تا ۱۳)",
  evening: "عصر (۱۳ تا ۱۸)",
};
export const NEED_FA: Record<CallbackNeed, string> = { cash: "وام نقدی", goods: "خرید کالا", help: "نمی‌داند" };
export const OPEN_STATUSES: readonly CallbackStatus[] = ["new", "in_progress", "no_answer"];

/**
 * Allowed moves. Nothing returns to «جدید»; «پاسخ نداد» may repeat (each one is another attempt, capped and
 * spaced by CALLBACK_CONFIG); a closed request («تماس گرفته شد» / «لغو») can only be reopened as «در حال پیگیری».
 */
export const CALLBACK_TRANSITIONS: Record<CallbackStatus, readonly CallbackStatus[]> = {
  new: ["in_progress", "called", "no_answer", "cancelled"],
  in_progress: ["called", "no_answer", "cancelled"],
  no_answer: ["in_progress", "called", "no_answer", "cancelled"],
  called: ["in_progress"],
  cancelled: ["in_progress"],
};

export function isCallbackStatus(value: unknown): value is CallbackStatus {
  return typeof value === "string" && (CALLBACK_STATUSES as readonly string[]).includes(value);
}
export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "string" && (CANCEL_REASONS as readonly string[]).includes(value);
}

export function canTransition(from: CallbackStatus, to: CallbackStatus): boolean {
  return CALLBACK_TRANSITIONS[from].includes(to);
}

export function can(actor: CallbackActor, permission: CallbackPermission): boolean {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

/** Same rule as the rest of the CRM: whoever may see customers (and their phones) sees the full number. */
export function canSeePhone(actor: CallbackActor): boolean {
  return can(actor, "customers.view");
}

export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 4)} ••• ${phone.slice(7)}` : "•••";
}

/** «پاسخ نداد» rules: cap, then a cancel suggestion (never automatic); minimum gap between attempts. */
export function attemptState(
  item: { status: CallbackStatus; attempts: number; lastAttemptAt: string | null },
  now: Date,
  config: { maxAttempts: number; minAttemptGapMinutes: number } = CALLBACK_CONFIG,
): { canRetry: boolean; nextAttemptAt: string | null; suggestCancel: boolean } {
  const open = OPEN_STATUSES.includes(item.status);
  const capped = item.attempts >= config.maxAttempts;
  const next = item.lastAttemptAt && item.attempts > 0
    ? new Date(new Date(item.lastAttemptAt).getTime() + config.minAttemptGapMinutes * 60_000)
    : null;
  const waiting = next !== null && next.getTime() > now.getTime();
  return {
    canRetry: open && !capped && !waiting,
    nextAttemptAt: open && !capped && waiting ? next!.toISOString() : null,
    suggestCancel: open && capped,
  };
}

/** Internal SLA: a «همین الان» request still «جدید» after slaMinutes is late. Never shown to customers. */
export function isLate(item: { status: CallbackStatus; contactTime: ContactTime; createdAt: string }, now: Date, slaMinutes = CALLBACK_CONFIG.slaMinutes): boolean {
  return item.status === "new" && item.contactTime === "now" && now.getTime() - new Date(item.createdAt).getTime() > slaMinutes * 60_000;
}

/** Queue order: «همین الان» + جدید first, then other جدید (both oldest first), then the rest by last activity. */
export function compareCallbacks(
  a: { status: CallbackStatus; contactTime: ContactTime; createdAt: string; lastActivityAt: string; id: number },
  b: { status: CallbackStatus; contactTime: ContactTime; createdAt: string; lastActivityAt: string; id: number },
): number {
  const rank = (x: typeof a) => (x.status === "new" ? (x.contactTime === "now" ? 0 : 1) : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra < 2) return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id - a.id;
}

export type CallbackItem = {
  id: number;
  trackingCode: string | null;
  name: string;
  /** Full number only for staff who may see customer phones; otherwise null (use phoneMasked). */
  phone: string | null;
  phoneMasked: string;
  contactTime: ContactTime;
  need: CallbackNeed | null;
  planId: number | null;
  planName: string | null;
  src: string | null;
  status: CallbackStatus;
  cancelReason: CancelReason | null;
  attempts: number;
  lastAttemptAt: string | null;
  canRetry: boolean;
  nextAttemptAt: string | null;
  suggestCancel: boolean;
  late: boolean;
  assignedUserId: number | null;
  assignedUserName: string | null;
  notesCount: number;
  customerId: number | null;
  customerName: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

type Row = {
  id: number; tracking_code: string | null; name: string; phone: string; contact_time: ContactTime; need: CallbackNeed | null;
  plan_id: number | null; plan_name: string | null; src: string | null; status: CallbackStatus; cancel_reason: CancelReason | null;
  attempts: number; last_attempt_at: string | null; assigned_user_id: number | null; assigned_user_name: string | null;
  notes_count: number; customer_id: number | null; customer_name: string | null; converted_at: string | null;
  created_at: string; updated_at: string; last_activity_at: string;
};

/** loan_plans exists in every real CRM; fixture databases may not have it. */
function planJoin(): string {
  const exists = queryRow("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='loan_plans'");
  return exists ? "LEFT JOIN loan_plans lp ON lp.id = c.plan_id" : "";
}

function selectSql(): string {
  const join = planJoin();
  return `SELECT c.id, c.tracking_code, c.name, c.phone, c.contact_time, c.need, c.plan_id, ${join ? "lp.name" : "NULL"} AS plan_name,
    c.src, c.status, c.cancel_reason, c.attempts, c.last_attempt_at, c.assigned_user_id,
    COALESCE(u.full_name, u.username) AS assigned_user_name,
    (SELECT COUNT(*) FROM callback_request_events e WHERE e.callback_id = c.id AND e.action = 'note') AS notes_count,
    c.customer_id, cu.name AS customer_name, c.converted_at, c.created_at, c.updated_at, c.last_activity_at
  FROM callback_requests c
  LEFT JOIN users u ON u.id = c.assigned_user_id
  LEFT JOIN customers cu ON cu.id = c.customer_id
  ${join}`;
}

function toItem(r: Row, actor: CallbackActor, now: Date): CallbackItem {
  const base = {
    status: r.status, attempts: Number(r.attempts), lastAttemptAt: r.last_attempt_at, contactTime: r.contact_time, createdAt: r.created_at,
  };
  return {
    id: Number(r.id), trackingCode: r.tracking_code, name: r.name,
    phone: canSeePhone(actor) ? r.phone : null, phoneMasked: maskPhone(r.phone),
    contactTime: r.contact_time, need: r.need, planId: r.plan_id == null ? null : Number(r.plan_id), planName: r.plan_name,
    src: r.src, status: r.status, cancelReason: r.cancel_reason, attempts: base.attempts, lastAttemptAt: r.last_attempt_at,
    ...attemptState(base, now), late: isLate(base, now),
    assignedUserId: r.assigned_user_id == null ? null : Number(r.assigned_user_id), assignedUserName: r.assigned_user_name,
    notesCount: Number(r.notes_count ?? 0),
    customerId: r.customer_id == null ? null : Number(r.customer_id), customerName: r.customer_name,
    convertedAt: r.converted_at, createdAt: r.created_at, updatedAt: r.updated_at, lastActivityAt: r.last_activity_at,
  };
}

/** Assigned-scope roles see requests assigned to them plus unassigned ones (so «به من تخصیص بده» / assign-to-self works). */
function scopeSql(actor: CallbackActor): { sql: string; params: SqlValue[] } {
  return actor.role !== "admin" && actor.customerScope === "assigned"
    ? { sql: " AND (c.assigned_user_id = ? OR c.assigned_user_id IS NULL)", params: [actor.id] }
    : { sql: "", params: [] };
}

const ORDER = `ORDER BY CASE WHEN c.status='new' AND c.contact_time='now' THEN 0 WHEN c.status='new' THEN 1 ELSE 2 END,
  CASE WHEN c.status='new' THEN c.created_at END ASC, c.last_activity_at DESC, c.id DESC`;

export type CallbackFilter = { status: CallbackStatus | "all"; who: "all" | "me" | "none"; q?: string };
export type CallbackCounts = Record<CallbackStatus | "all", number>;

export function listCallbacks(actor: CallbackActor, filter: CallbackFilter, now = new Date()): CallbackItem[] {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filter.status !== "all") { where.push("c.status = ?"); params.push(filter.status); }
  if (filter.who === "me") { where.push("c.assigned_user_id = ?"); params.push(actor.id); }
  if (filter.who === "none") where.push("c.assigned_user_id IS NULL");
  const q = filter.q?.trim();
  const idSearch = q ? customerSearchSql(q) : null;
  if (q && idSearch?.idQuery?.explicit) {
    // «#1234»: requests linked to customer 1234.
    where.push("c.customer_id = ?"); params.push(idSearch.idQuery.id);
  } else if (q) {
    const digits = toLatinDigits(q).replace(/\D/g, "");
    const idOr = idSearch?.idQuery ? " OR c.customer_id = ?" : "";
    const idParam = idSearch?.idQuery ? [idSearch.idQuery.id] : [];
    if (digits.length >= 4 && canSeePhone(actor)) { where.push(`(c.name LIKE ? OR c.phone LIKE ?${idOr})`); params.push(`%${q}%`, `%${digits}%`, ...idParam); }
    else { where.push(`(c.name LIKE ?${idOr})`); params.push(`%${q}%`, ...idParam); }
  }
  const rank = idSearch?.idQuery ? { sql: "CASE WHEN c.customer_id = ? THEN 0 ELSE 1 END, ", params: [idSearch.idQuery.id] } : { sql: "", params: [] };
  return queryRows<Row>(
    `${selectSql()} WHERE 1=1${where.map((w) => ` AND ${w}`).join("")}${scope.sql} ${ORDER.replace("ORDER BY ", `ORDER BY ${rank.sql}`)} LIMIT 500`,
    [...params, ...scope.params, ...rank.params],
  ).map((r) => toItem(r, actor, now));
}

/** Per-status counts inside the actor's scope (the «مال من / بدون مسئول» filter does not change the tab counts). */
export function callbackCounts(actor: CallbackActor): CallbackCounts {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const rows = queryRows<{ status: CallbackStatus; n: number }>(
    `SELECT c.status, COUNT(*) AS n FROM callback_requests c WHERE 1=1${scope.sql} GROUP BY c.status`,
    scope.params,
  );
  const counts = Object.fromEntries([...CALLBACK_STATUSES, "all"].map((k) => [k, 0])) as CallbackCounts;
  for (const r of rows) { counts[r.status] = Number(r.n); counts.all += Number(r.n); }
  return counts;
}

export function getCallback(actor: CallbackActor, id: number, now = new Date()): CallbackItem | undefined {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const row = queryRow<Row>(`${selectSql()} WHERE c.id = ?${scope.sql}`, [id, ...scope.params]);
  return row ? toItem(row, actor, now) : undefined;
}

export type CallbackEvent = {
  id: number; action: string; fromValue: string | null; toValue: string | null; userId: number | null; userName: string | null; createdAt: string;
};
export function callbackEvents(id: number): CallbackEvent[] {
  return queryRows<{ id: number; action: string; from_value: string | null; to_value: string | null; user_id: number | null; user_name: string | null; created_at: string }>(
    `SELECT e.id, e.action, e.from_value, e.to_value, e.user_id, COALESCE(u.full_name, u.username) AS user_name, e.created_at
     FROM callback_request_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.callback_id = ? ORDER BY e.id DESC LIMIT 200`,
    [id],
  ).map((e) => ({
    id: Number(e.id), action: e.action, fromValue: e.from_value, toValue: e.to_value,
    userId: e.user_id == null ? null : Number(e.user_id), userName: e.user_name, createdAt: e.created_at,
  }));
}

/** Staff who may be given a callback: active users that can see the page. */
export function callbackAssignees(): { id: number; name: string }[] {
  return queryRows<{ id: number; name: string }>(
    `SELECT u.id, COALESCE(u.full_name, u.username) AS name FROM users u
     WHERE u.active = 1 AND (u.role = 'admin' OR EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_slug = u.role AND rp.permission = 'callbacks.view'))
     ORDER BY name`,
  ).map((u) => ({ id: Number(u.id), name: u.name }));
}

export type CallbackError =
  | "not_found" | "invalid_transition" | "forbidden" | "invalid_assignee" | "already_converted" | "cancelled"
  | "cancel_reason_required" | "max_attempts" | "too_soon" | "already_assigned";
export type CallbackResult =
  | { ok: true; item: CallbackItem; created?: boolean; phone?: string }
  | { ok: false; error: CallbackError; retryAt?: string };

function logEvent(id: number, userId: number | null, action: string, from: string | null, to: string | null, at: string): void {
  execute(
    "INSERT INTO callback_request_events(callback_id,user_id,action,from_value,to_value,created_at) VALUES (?,?,?,?,?,?)",
    [id, userId, action, from, to, at],
  );
}

function touch(id: number, actor: CallbackActor, at: string): void {
  execute("UPDATE callback_requests SET updated_at=?, updated_by_user_id=?, last_activity_at=? WHERE id=?", [at, actor.id, at, id]);
}

/**
 * Status change. «لغو» needs a reason; «پاسخ نداد» counts an attempt (cap + minimum gap, see attemptState).
 * Acting on an unassigned request makes the actor its owner (same as the card's outcome prompt).
 */
export function setCallbackStatus(
  actor: CallbackActor, id: number, to: CallbackStatus, opts: { cancelReason?: CancelReason | null } = {}, now = new Date(),
): CallbackResult {
  ensureSiteLeadSchema();
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id, now);
    if (!current) return { ok: false, error: "not_found" };
    if (!canTransition(current.status, to)) return { ok: false, error: "invalid_transition" };
    if (to === "cancelled" && !opts.cancelReason) return { ok: false, error: "cancel_reason_required" };
    if (to === "no_answer") {
      if (current.attempts >= CALLBACK_CONFIG.maxAttempts) return { ok: false, error: "max_attempts" };
      if (current.nextAttemptAt) return { ok: false, error: "too_soon", retryAt: current.nextAttemptAt };
    }
    const at = now.toISOString();
    const attempt = to === "no_answer";
    execute(
      `UPDATE callback_requests SET status=?, cancel_reason=?, attempts=attempts+?,
         last_attempt_at=CASE WHEN ? THEN ? ELSE last_attempt_at END WHERE id=?`,
      [to, to === "cancelled" ? opts.cancelReason! : null, attempt ? 1 : 0, attempt || to === "called" ? 1 : 0, at, id],
    );
    touch(id, actor, at);
    logEvent(id, actor.id, "status", current.status, to === "cancelled" ? `cancelled:${opts.cancelReason}` : to, at);
    if (to === "called") answerCallbackSiteLead(id, at);
    else if (to === "cancelled") answerCallbackSiteLead(id, at, "callback_cancelled");
    if (current.assignedUserId == null) {
      execute("UPDATE callback_requests SET assigned_user_id=? WHERE id=?", [actor.id, id]);
      logEvent(id, actor.id, "assign", null, String(actor.id), at);
    }
    return { ok: true, item: getCallback(actor, id, now)! };
  });
}

/**
 * «به من تخصیص بده» (assign to self, userId = self) is open to everyone with callbacks.manage while the request is unassigned.
 * Giving it to someone else, taking it from someone, or clearing the owner needs callbacks.assign (admin/manager).
 */
export function assignCallback(actor: CallbackActor, id: number, userId: number | null, now = new Date()): CallbackResult {
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id, now);
    if (!current) return { ok: false, error: "not_found" };
    const manager = can(actor, "callbacks.assign");
    if (!manager) {
      if (userId !== actor.id) return { ok: false, error: "forbidden" };
      if (current.assignedUserId === actor.id) return { ok: true, item: current };
      if (current.assignedUserId != null) return { ok: false, error: "already_assigned" };
    }
    if (userId !== null && !callbackAssignees().some((u) => u.id === userId)) return { ok: false, error: "invalid_assignee" };
    if (current.assignedUserId === userId) return { ok: true, item: current };
    const at = now.toISOString();
    execute("UPDATE callback_requests SET assigned_user_id=? WHERE id=?", [userId, id]);
    touch(id, actor, at);
    logEvent(id, actor.id, "assign", current.assignedUserId == null ? null : String(current.assignedUserId), userId == null ? null : String(userId), at);
    return { ok: true, item: getCallback(actor, id, now)! };
  });
}

export const MAX_NOTE = 2000;
export function addCallbackNote(actor: CallbackActor, id: number, text: string, now = new Date()): CallbackResult {
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id, now);
    if (!current) return { ok: false, error: "not_found" };
    const at = now.toISOString();
    logEvent(id, actor.id, "note", null, text.trim(), at);
    touch(id, actor, at);
    return { ok: true, item: getCallback(actor, id, now)! };
  });
}

/**
 * Reveal / call: logged in the request's history. Only staff who may see customer phones get the number;
 * a call does not change the status (the card then asks for the outcome).
 */
export function recordContact(actor: CallbackActor, id: number, action: "reveal" | "call", now = new Date()): CallbackResult {
  if (!canSeePhone(actor)) return { ok: false, error: "forbidden" };
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id, now);
    if (!current) return { ok: false, error: "not_found" };
    const at = now.toISOString();
    logEvent(id, actor.id, action, null, null, at);
    if (action === "call") execute("UPDATE callback_requests SET last_activity_at=? WHERE id=?", [at, id]);
    const phone = queryRow<{ phone: string }>("SELECT phone FROM callback_requests WHERE id=?", [id])!.phone;
    return { ok: true, item: getCallback(actor, id, now)!, phone };
  });
}

function noteTexts(id: number): string[] {
  return queryRows<{ to_value: string | null }>(
    "SELECT to_value FROM callback_request_events WHERE callback_id=? AND action='note' ORDER BY id", [id],
  ).map((r) => r.to_value ?? "").filter(Boolean);
}

export function callbackDescription(
  item: Pick<CallbackItem, "contactTime" | "need" | "planId" | "planName" | "src" | "trackingCode">, notes: string[] = [],
): string {
  const lines = ["درخواست تماس کارشناس از سایت nafisvam.com"];
  if (item.trackingCode) lines.push(`کد پیگیری: ${item.trackingCode}`);
  lines.push(`زمان مناسب تماس: ${CONTACT_TIME_FA[item.contactTime]}`);
  if (item.need) lines.push(`موضوع: ${NEED_FA[item.need]}`);
  if (item.planId) lines.push(`طرح: ${item.planName ?? `#${item.planId}`}`);
  if (item.src) lines.push(`منبع صفحه: ${item.src}`);
  for (const note of notes) lines.push(`یادداشت کارشناس: ${note}`);
  return lines.join("\n");
}

/**
 * Convert to a regular CRM lead: the existing customer (same mobile, merges resolved) is linked, otherwise
 * a customer is created exactly like a website lead (unverified, website_lead tag). Creating needs
 * customers.create as well, so callbacks.manage never widens who can add customers.
 * The new customer goes to the assignee's salesperson when they have one, else the default allocation program.
 */
export function convertCallback(actor: CallbackActor, id: number, now = new Date()): CallbackResult {
  ensureSiteLeadSchema();
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id, now);
    if (!current) return { ok: false, error: "not_found" };
    if (current.convertedAt) return { ok: false, error: "already_converted" };
    if (current.status === "cancelled") return { ok: false, error: "cancelled" };
    const phone = queryRow<{ phone: string }>("SELECT phone FROM callback_requests WHERE id=?", [id])!.phone;
    const at = now.toISOString();
    let customerId = canonicalCustomerByMobile(phone);
    let created = false;
    if (customerId === undefined) {
      if (!can(actor, "customers.create")) return { ok: false, error: "forbidden" };
      const assigneeSalesperson = current.assignedUserId == null ? null
        : queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM users WHERE id=?", [current.assignedUserId])?.salesperson_id ?? null;
      const base = { name: current.name, phone, description: callbackDescription(current, noteTexts(id)), priority: null };
      if (assigneeSalesperson != null) {
        customerId = insertCustomerRecord({ ...base, assignedSalespersonId: Number(assigneeSalesperson) });
      } else {
        try {
          customerId = insertCustomerRecord({ ...base, allocationProgramId: defaultAllocationProgramId() });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "ALLOCATION_PROGRAM_UNAVAILABLE") throw error;
          customerId = insertCustomerRecord(base);
        }
      }
      created = true;
    }
    execute("INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES (?,?,?)", [customerId, WEBSITE_LEAD_TAG, at]);
    execute("UPDATE callback_requests SET customer_id=?, converted_at=?, converted_by_user_id=? WHERE id=?", [customerId, at, actor.id, id]);
    // crm-site-leads: the callback becomes a site request on the customer (already linked ones were recorded at intake).
    recordSiteLeadRequest({ customerId: customerId!, source: "callback", sourceId: id, requestedAt: current.createdAt, contactTime: current.contactTime, isRepeat: !created });
    if (current.status === "called") answerCallbackSiteLead(id, at);
    touch(id, actor, at);
    logEvent(id, actor.id, "convert", null, String(customerId), at);
    return { ok: true, item: getCallback(actor, id, now)!, created };
  });
}

/**
 * Staff Telegram «درخواست تماس» for a just-recorded callback (no SMS, see notifyWebsiteCallback). The outcome
 * is kept on the request's own history as a system event. Never throws.
 */
export async function alertNewCallback(
  id: number, notify: typeof notifyWebsiteCallback = notifyWebsiteCallback,
): Promise<CallbackAlertOutcome | undefined> {
  const r = queryRow<{ name: string; phone: string; contact_time: ContactTime; need: CallbackNeed | null; plan_id: number | null; src: string | null; tracking_code: string | null; customer_id: number | null }>(
    "SELECT name, phone, contact_time, need, plan_id, src, tracking_code, customer_id FROM callback_requests WHERE id=?", [id],
  );
  if (!r) return undefined;
  const planName = r.plan_id && planJoin()
    ? queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [r.plan_id])?.name ?? null : null;
  const lines = [
    "☎️ درخواست تماس (فرم مشاوره سایت)",
    ...(r.need ? [`موضوع: ${NEED_FA[r.need]}`] : []),
    ...(r.plan_id ? [`طرح: ${planName ?? `#${r.plan_id}`}`] : []),
    ...(r.src ? [`صفحه: ${r.src}`] : []),
    ...(r.tracking_code ? [`کد پیگیری: ${r.tracking_code}`] : []),
  ];
  let outcome: CallbackAlertOutcome;
  try {
    outcome = await notify({ name: r.name, phone: r.phone, contactTimeFa: CONTACT_TIME_FA[r.contact_time], description: lines.join("\n"), existingCustomerId: r.customer_id });
  } catch {
    outcome = "failed";
  }
  try {
    logEvent(id, null, "notify", "telegram", outcome, new Date().toISOString());
  } catch { /* history is best-effort */ }
  return outcome;
}
