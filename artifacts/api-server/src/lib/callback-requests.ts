import { execute, queryRow, queryRows, runImmediateTransaction, type SqlValue } from "./crm-db";
import { insertCustomerRecord } from "./customer-create";
import {
  CALLBACK_STATUSES, WEBSITE_LEAD_TAG, canonicalCustomerByMobile, defaultAllocationProgramId, ensurePublicLeadSchema,
} from "./public-leads";

/** Staff side of «درخواست تماس کارشناس». Pure rules first (unit-tested), then data access. */
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];
export type CallbackActor = {
  id: number;
  role: string;
  permissions: readonly string[];
  customerScope: "all" | "assigned";
};

export const CALLBACK_STATUS_FA: Record<CallbackStatus, string> = {
  new: "جدید",
  in_progress: "در حال پیگیری",
  called: "تماس گرفته شد",
  no_answer: "پاسخ نداد",
  cancelled: "لغو",
};
export const OPEN_STATUSES: readonly CallbackStatus[] = ["new", "in_progress", "no_answer"];

/**
 * Allowed moves. Nothing returns to «جدید»; «پاسخ نداد» may repeat (each one is another attempt);
 * a closed request («تماس گرفته شد» / «لغو») can only be reopened as «در حال پیگیری».
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

export function canTransition(from: CallbackStatus, to: CallbackStatus): boolean {
  return CALLBACK_TRANSITIONS[from].includes(to);
}

export function can(actor: CallbackActor, permission: "callbacks.view" | "callbacks.manage" | "customers.create"): boolean {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

/** Queue order: «همین الان» first, then oldest first (id breaks ties). */
export function compareCallbacks(
  a: { preferredTime: string; createdAt: string; id: number },
  b: { preferredTime: string; createdAt: string; id: number },
): number {
  const rank = (x: { preferredTime: string }) => (x.preferredTime === "now" ? 0 : 1);
  return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

const TIME_FA = { now: "همین الان در ساعت کاری", morning: "صبح", evening: "عصر" } as const;
const TOPIC_FA = { cash: "وام نقدی", goods: "خرید کالا به‌صورت قسطی", unsure: "نمی‌داند" } as const;

export type CallbackItem = {
  id: number;
  trackingCode: string | null;
  name: string;
  phone: string;
  preferredTime: "now" | "morning" | "evening";
  topic: "cash" | "goods" | "unsure" | null;
  src: string | null;
  status: CallbackStatus;
  attempts: number;
  lastAttemptAt: string | null;
  assignedUserId: number | null;
  assignedUserName: string | null;
  notes: string | null;
  customerId: number | null;
  customerName: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: number; tracking_code: string | null; name: string; phone: string; preferred_time: CallbackItem["preferredTime"];
  topic: CallbackItem["topic"]; src: string | null; status: CallbackStatus; attempts: number; last_attempt_at: string | null;
  assigned_user_id: number | null; assigned_user_name: string | null; notes: string | null; customer_id: number | null;
  customer_name: string | null; converted_at: string | null; created_at: string; updated_at: string;
};

const SELECT = `SELECT c.id, c.tracking_code, c.name, c.phone, c.preferred_time, c.topic, c.src, c.status, c.attempts,
    c.last_attempt_at, c.assigned_user_id, COALESCE(u.full_name, u.username) AS assigned_user_name, c.notes,
    c.customer_id, cu.name AS customer_name, c.converted_at, c.created_at, c.updated_at
  FROM callback_requests c
  LEFT JOIN users u ON u.id = c.assigned_user_id
  LEFT JOIN customers cu ON cu.id = c.customer_id`;

function toItem(r: Row): CallbackItem {
  return {
    id: Number(r.id), trackingCode: r.tracking_code, name: r.name, phone: r.phone, preferredTime: r.preferred_time,
    topic: r.topic, src: r.src, status: r.status, attempts: Number(r.attempts), lastAttemptAt: r.last_attempt_at,
    assignedUserId: r.assigned_user_id == null ? null : Number(r.assigned_user_id), assignedUserName: r.assigned_user_name,
    notes: r.notes, customerId: r.customer_id == null ? null : Number(r.customer_id), customerName: r.customer_name,
    convertedAt: r.converted_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Assigned-scope roles only see requests assigned to them (same idea as their customer list). */
function scopeSql(actor: CallbackActor): { sql: string; params: SqlValue[] } {
  return actor.role !== "admin" && actor.customerScope === "assigned"
    ? { sql: " AND c.assigned_user_id = ?", params: [actor.id] }
    : { sql: "", params: [] };
}

const ORDER = "ORDER BY CASE WHEN c.preferred_time='now' THEN 0 ELSE 1 END, c.created_at ASC, c.id ASC";

export function listCallbacks(actor: CallbackActor, view: "open" | "closed"): CallbackItem[] {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const statuses = view === "open" ? OPEN_STATUSES : (["called", "cancelled"] as const);
  const order = view === "open" ? ORDER : "ORDER BY c.updated_at DESC, c.id DESC";
  return queryRows<Row>(
    `${SELECT} WHERE c.status IN (${statuses.map(() => "?").join(",")})${scope.sql} ${order} LIMIT 500`,
    [...statuses, ...scope.params],
  ).map(toItem);
}

export function callbackCounts(actor: CallbackActor): { new: number; open: number; closed: number } {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const row = queryRow<{ n_new: number | null; n_open: number | null; n_closed: number | null }>(
    `SELECT SUM(CASE WHEN c.status='new' THEN 1 ELSE 0 END) AS n_new,
       SUM(CASE WHEN c.status IN ('new','in_progress','no_answer') THEN 1 ELSE 0 END) AS n_open,
       SUM(CASE WHEN c.status IN ('called','cancelled') THEN 1 ELSE 0 END) AS n_closed
     FROM callback_requests c WHERE 1=1${scope.sql}`,
    scope.params,
  );
  return { new: Number(row?.n_new ?? 0), open: Number(row?.n_open ?? 0), closed: Number(row?.n_closed ?? 0) };
}

export function getCallback(actor: CallbackActor, id: number): CallbackItem | undefined {
  ensurePublicLeadSchema();
  const scope = scopeSql(actor);
  const row = queryRow<Row>(`${SELECT} WHERE c.id = ?${scope.sql}`, [id, ...scope.params]);
  return row ? toItem(row) : undefined;
}

export type CallbackEvent = { id: number; action: string; fromValue: string | null; toValue: string | null; userName: string | null; createdAt: string };
export function callbackEvents(id: number): CallbackEvent[] {
  return queryRows<{ id: number; action: string; from_value: string | null; to_value: string | null; user_name: string | null; created_at: string }>(
    `SELECT e.id, e.action, e.from_value, e.to_value, COALESCE(u.full_name, u.username) AS user_name, e.created_at
     FROM callback_request_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.callback_id = ? ORDER BY e.id DESC LIMIT 50`,
    [id],
  ).map((e) => ({ id: Number(e.id), action: e.action, fromValue: e.from_value, toValue: e.to_value, userName: e.user_name, createdAt: e.created_at }));
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

export type CallbackError = "not_found" | "invalid_transition" | "forbidden" | "invalid_assignee" | "already_converted" | "cancelled";
export type CallbackResult = { ok: true; item: CallbackItem; created?: boolean } | { ok: false; error: CallbackError };

function logEvent(id: number, actor: CallbackActor, action: string, from: string | null, to: string | null, at: string): void {
  execute(
    "INSERT INTO callback_request_events(callback_id,user_id,action,from_value,to_value,created_at) VALUES (?,?,?,?,?,?)",
    [id, actor.id, action, from, to, at],
  );
}

export function setCallbackStatus(actor: CallbackActor, id: number, to: CallbackStatus, now = new Date()): CallbackResult {
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id);
    if (!current) return { ok: false, error: "not_found" };
    if (!canTransition(current.status, to)) return { ok: false, error: "invalid_transition" };
    const at = now.toISOString();
    const attempt = to === "no_answer";
    execute(
      `UPDATE callback_requests SET status=?, attempts=attempts+?, last_attempt_at=CASE WHEN ? THEN ? ELSE last_attempt_at END,
         updated_at=?, updated_by_user_id=? WHERE id=?`,
      [to, attempt ? 1 : 0, attempt || to === "called" ? 1 : 0, at, at, actor.id, id],
    );
    logEvent(id, actor, "status", current.status, to, at);
    return { ok: true, item: getCallback(actor, id)! };
  });
}

/** Only roles that see every request may (re)assign; assigned-scope staff would otherwise move work they can't see. */
export function assignCallback(actor: CallbackActor, id: number, userId: number | null, now = new Date()): CallbackResult {
  if (actor.role !== "admin" && actor.customerScope === "assigned") return { ok: false, error: "forbidden" };
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id);
    if (!current) return { ok: false, error: "not_found" };
    if (userId !== null && !callbackAssignees().some((u) => u.id === userId)) return { ok: false, error: "invalid_assignee" };
    const at = now.toISOString();
    execute("UPDATE callback_requests SET assigned_user_id=?, updated_at=?, updated_by_user_id=? WHERE id=?", [userId, at, actor.id, id]);
    logEvent(id, actor, "assign", current.assignedUserId == null ? null : String(current.assignedUserId), userId == null ? null : String(userId), at);
    return { ok: true, item: getCallback(actor, id)! };
  });
}

export const MAX_NOTES = 2000;
export function setCallbackNotes(actor: CallbackActor, id: number, notes: string, now = new Date()): CallbackResult {
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id);
    if (!current) return { ok: false, error: "not_found" };
    const at = now.toISOString();
    const value = notes.trim() || null;
    execute("UPDATE callback_requests SET notes=?, updated_at=?, updated_by_user_id=? WHERE id=?", [value, at, actor.id, id]);
    logEvent(id, actor, "notes", null, null, at);
    return { ok: true, item: getCallback(actor, id)! };
  });
}

export function callbackDescription(item: Pick<CallbackItem, "preferredTime" | "topic" | "src" | "notes" | "trackingCode">): string {
  const lines = ["درخواست تماس کارشناس از سایت nafisvam.com"];
  if (item.trackingCode) lines.push(`کد پیگیری: ${item.trackingCode}`);
  lines.push(`زمان مناسب تماس: ${TIME_FA[item.preferredTime]}`);
  if (item.topic) lines.push(`موضوع: ${TOPIC_FA[item.topic]}`);
  if (item.src) lines.push(`منبع صفحه: ${item.src}`);
  if (item.notes) lines.push(`یادداشت کارشناس: ${item.notes}`);
  return lines.join("\n");
}

/**
 * Convert to a regular CRM lead: the existing customer (same mobile, merges resolved) is linked, otherwise
 * a customer is created exactly like a website lead (unverified, website_lead tag). Creating needs
 * customers.create as well, so callbacks.manage never widens who can add customers.
 * The new customer goes to the assignee's salesperson when they have one, else the default allocation program.
 */
export function convertCallback(actor: CallbackActor, id: number, now = new Date()): CallbackResult {
  return runImmediateTransaction(() => {
    const current = getCallback(actor, id);
    if (!current) return { ok: false, error: "not_found" };
    if (current.convertedAt) return { ok: false, error: "already_converted" };
    if (current.status === "cancelled") return { ok: false, error: "cancelled" };
    const at = now.toISOString();
    let customerId = canonicalCustomerByMobile(current.phone);
    let created = false;
    if (customerId === undefined) {
      if (!can(actor, "customers.create")) return { ok: false, error: "forbidden" };
      const assigneeSalesperson = current.assignedUserId == null ? null
        : queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM users WHERE id=?", [current.assignedUserId])?.salesperson_id ?? null;
      const base = { name: current.name, phone: current.phone, description: callbackDescription(current), priority: null };
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
    execute(
      "UPDATE callback_requests SET customer_id=?, converted_at=?, converted_by_user_id=?, updated_at=?, updated_by_user_id=? WHERE id=?",
      [customerId, at, actor.id, at, actor.id, id],
    );
    logEvent(id, actor, "convert", null, String(customerId), at);
    return { ok: true, item: getCallback(actor, id)!, created };
  });
}
