/**
 * HOTFIX-73 «ارتقا به اولویت یک» for the locked experts, own customers only:
 *  - the qualifier (Kazemi, user 8) → unchanged hand-off (promoteToPriorityOne);
 *  - a closer (Hasani u2 / Ghasemi u3) → was 403/404; now keeps the customer and the priority becomes 1
 *    («expert_upgrade» row in customer_priority_history + a «ارتقا به اولویت ۱ توسط …» timeline row, kept out of call counters by realCallSql).
 *    No hand-off, no bell, no reminder, no SMS/Bale. Another expert's customer → 404 (and the lockdown middleware → 403 before that).
 * No switches. Nothing here sends anything.
 */
import { execute, executeChanges, queryRow, runImmediateTransaction } from "./crm-db";
import { EL_USERS } from "./expert-lockdown";
import { TeamSalesError, getTeamSalesConfig, logPriorityChange, ensureTeamSalesSchema, promoteToPriorityOne, shortName, type Actor } from "./team-sales";

export const UP73_REASON_MAX = 80;
export const UP73_SOURCE = "expert_upgrade" as const;
const isAdmin = (a: { role: string }) => a.role === "admin";
const elExpert = (a: Actor): boolean =>
  Boolean(a && a.role === "salesperson" && EL_USERS[Number(a.id)] != null && Number(a.salespersonId) === EL_USERS[Number(a.id)]);
export function up73Closer(a: Actor): boolean {
  const cfg = getTeamSalesConfig();
  return elExpert(a) && a.salespersonId != null && cfg.closerSalespersonIds.includes(Number(a.salespersonId)) && Number(a.salespersonId) !== cfg.qualifierSalespersonId;
}
/** Optional short reason (one line, cut to 80) + optional note. */
export function up73Text(body: any): { reason: string | null; note: string | null } {
  const clean = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return { reason: clean(body?.reason).slice(0, UP73_REASON_MAX) || null, note: (typeof body?.note === "string" ? body.note.trim() : "").slice(0, 2000) || null };
}

type Cust = { id: number; name: string; salesperson_id: number | null; priority: number | null; status: string; merged_into_customer_id: number | null };
const loadC = (id: number) => queryRow<Cust>("SELECT id,name,salesperson_id,priority,status,merged_into_customer_id FROM customers WHERE id=?", [id]);

export function closerSelfUpgrade(customerId: number, actor: Actor, reason: string | null, note: string | null, now = new Date()) {
  ensureTeamSalesSchema();
  return runImmediateTransaction(() => {
    const c = loadC(customerId);
    if (!c || c.merged_into_customer_id != null || Number(c.salesperson_id) !== Number(actor.salespersonId)) throw new TeamSalesError(404, "Customer not found");
    if (c.status !== "in_progress") throw new TeamSalesError(409, "فقط پرونده‌های در جریان قابل ارتقا هستند.");
    if (c.priority === 1) throw new TeamSalesError(409, "این مشتری از قبل اولویت ۱ است.");
    const nowIso = now.toISOString();
    const preMax = Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0);
    const changed = executeChanges("UPDATE customers SET priority=1 WHERE id=? AND salesperson_id=? AND status='in_progress' AND COALESCE(priority,0)<>1",
      [c.id, actor.salespersonId]);
    if (changed !== 1) throw new TeamSalesError(409, "پرونده همزمان تغییر کرد؛ دوباره امتحان کنید.");
    const actorName = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId])?.name ?? actor.fullName ?? "کارشناس";
    const prev = c.priority == null ? "بدون اولویت" : `اولویت ${String(c.priority).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}`;
    const callLogId = execute(
      `INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, actor.salespersonId, `ارتقا به اولویت ۱ توسط ${shortName(actorName)}`, null,
        [`ارتقای مستقیم توسط کارشناس — قبلاً ${prev} — پرونده نزد همین کارشناس می‌ماند`, reason ? `دلیل: ${reason}` : null, note ? `یادداشت: ${note}` : null].filter(Boolean).join("\n"),
        nowIso, actorName]);
    // Generic triggers write bells for the customers UPDATE / call_logs INSERT: none for this action (nobody is notified).
    execute("DELETE FROM site_notification_events WHERE id>? AND customer_id=?", [preMax, c.id]);
    logPriorityChange({ customerId: c.id, oldPriority: c.priority, newPriority: 1, oldSalespersonId: c.salesperson_id,
      newSalespersonId: c.salesperson_id, actorUserId: actor.id, source: UP73_SOURCE, reason: [reason, note].filter(Boolean).join(" — ") || null, at: nowIso, always: true });
    return { customerId: c.id, closerSalespersonId: Number(c.salesperson_id), closerName: actorName, dueAt: null, dueLabel: null,
      reminderId: null, callLogId, notificationId: null, message: "ارتقا یافت · اولویت ۱ (نزد خودت می‌ماند)",
      assignment: "self" as const, assignmentLabel: "نزد خودت می‌ماند", priority: 1, kept: true };
  });
}

/** POST /customers/:id/upgrade-priority (and /team-sales/promote). */
export function expertUpgrade(customerId: number, actor: Actor, reason: string | null, note: string | null) {
  if (!isAdmin(actor) && up73Closer(actor)) {
    if (!getTeamSalesConfig().enabled) throw new TeamSalesError(404, "Team sales is not enabled");
    return closerSelfUpgrade(customerId, actor, reason, note);
  }
  const merged = [reason ? `دلیل: ${reason}` : null, note].filter(Boolean).join(" — ") || null;
  return promoteToPriorityOne(customerId, actor, merged);
}

/** next-closer for a closer: «yourself». Null when the actor is not one of the locked closers. */
export function selfNextCloser(actor: Actor, customerId: number | null) {
  if (isAdmin(actor) || !up73Closer(actor)) return null;
  if (customerId) {
    const c = loadC(customerId);
    if (!c || c.merged_into_customer_id != null || Number(c.salesperson_id) !== Number(actor.salespersonId)) return { notFound: true } as const;
  }
  const name = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [actor.salespersonId])?.name ?? actor.fullName ?? "";
  return { salespersonId: Number(actor.salespersonId), name, assignment: "self" as const, assignmentLabel: "نزد خودت می‌ماند", self: true };
}
