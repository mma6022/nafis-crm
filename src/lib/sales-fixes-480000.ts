/**
 * SALES-FIXES 480000 (Mohammad t810u, 2026-11-16). Code-level switches, ON by default — no DB row is written to turn them on.
 * Each one can be turned back to the old rule with ONE call_queue_settings row set to '0' (rollback without a redeploy):
 *   flag.sf480_owner_priority = '0' → P1 set by «ارتقا» can again be lowered only by an admin (HISTORY-A, old rule).
 *   flag.sf480_owner_status   = '0' → a cancelled customer leaves «لغوشده» again only through POST /customers/:id/reactivate (old rule).
 *   flag.sf480_open_lists     = '0' → «مشتریان من» / «پرونده‌های من» go back to the lockdown rule (CustLocked card, files lock, board turn).
 *   flag.sf480_incoming_now   = '0' → a still-live incoming call is urgent only inside the urgent window (old rule).
 *   flag.sf480_no_popups      = '0' → the mandatory reminder popup (REMINDER-B) feed comes back for 8/2/3 (the client host stays removed).
 *   flag.sf480_reactivate_keep_owner = '0' → reactivating a cancelled/completed P2/P3 closer customer auto-moves them to Kazemi again (old 20261025132100 rule).
 * Nothing here sends SMS / Bale / a bell, or touches user 29, contracts, templates, loan_plans, team_sales_config or notification_settings.
 */
import { queryRow, queryRows } from "./crm-db";
import { cpkOn, cpkNextReminderAt } from "./customers-priority-kanban";

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; }
  catch { return null; }
};
const onByDefault = (key: string) => setting(key) !== "0";
export const sf480OwnerPriority = () => onByDefault("flag.sf480_owner_priority");
export const sf480OwnerStatus = () => onByDefault("flag.sf480_owner_status");
export const sf480OpenLists = () => onByDefault("flag.sf480_open_lists");
export const sf480NoPopups = () => onByDefault("flag.sf480_no_popups");
/** flag.sf480_incoming_now = '0' → a live incoming call leaves «اکنون» after the urgent window again (old rule). */
export const sf480IncomingNow = () => onByDefault("flag.sf480_incoming_now");
/** flag.sf480_reactivate_keep_owner = '0' → reactivation of a closer's non-P1 customer auto-transfers to Kazemi again (old rule). Default: stay with the current expert. */
export const sf480ReactivateKeepOwner = () => onByDefault("flag.sf480_reactivate_keep_owner");

type U = { id: number; role: string; salespersonId: number | null; customerScope?: string };
const FD = "۰۱۲۳۴۵۶۷۸۹";
const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FD.indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const normName = (s: string) => s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ").replace(/\s+/g, " ").trim();

/** Own scope for a sales expert = customers whose salesperson is theirs. Admin / manager (never user 29) = everyone. Anyone else = nothing. */
function scopeSql(u: U): { sql: string; args: any[] } | null {
  if (Number(u.id) === 29) return null;
  if (u.role === "admin" || u.role === "manager") return { sql: "1=1", args: [] };
  if (u.salespersonId == null) return null;
  return { sql: "c.salesperson_id=?", args: [Number(u.salespersonId)] };
}

const LIFE = (status: string | null, stage: string | null) => status === "rejected" ? "cancelled" : stage === "completed" ? "completed" : "in_progress";

/** GET /sales-fixes/search?q= — the centred search: matching OWN customers and their existing cases (پرونده‌های تسهیلات). */
export function sf480Search(u: U, rawQ: unknown): { status: number; body: any } {
  const sc = scopeSql(u);
  if (!sc) return { status: 403, body: { error: "forbidden", message: "جست‌وجو برای این حساب باز نیست." } };
  const q = normName(toLatin(String(rawQ ?? "")));
  if (q.length < 2) return { status: 200, body: { q, items: [] } };
  const digits = q.replace(/\D/g, "");
  const byId = /^#?\d{1,7}$/.test(q) ? Number(q.replace("#", "")) : null;
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = queryRows<any>(
    `SELECT c.id, c.name, c.phone, c.priority, c.status FROM customers c
     WHERE c.merged_into_customer_id IS NULL AND ${sc.sql}
       AND (replace(replace(replace(c.name,'ي','ی'),'ك','ک'),char(8204),' ') LIKE ?
            ${digits.length >= 4 ? "OR c.phone LIKE ?" : ""} ${byId ? "OR c.id=?" : ""})
     ORDER BY CASE WHEN c.name LIKE ? THEN 0 ELSE 1 END, c.id DESC LIMIT 20`,
    [...sc.args, like, ...(digits.length >= 4 ? [`%${digits}%`] : []), ...(byId ? [byId] : []), `${q}%`]);
  const ids = rows.map((r) => Number(r.id));
  const cases = ids.length ? queryRows<any>(
    `SELECT la.id, la.customer_id, la.stage, la.status, la.requested_amount, la.created_at, p.name plan_name
     FROM loan_applications la LEFT JOIN loan_plans p ON p.id=la.plan_id
     WHERE la.deleted_at IS NULL AND la.customer_id IN (${ids.map(() => "?").join(",")}) ORDER BY la.id DESC`, ids) : [];
  const items = rows.map((r) => ({
    id: Number(r.id), name: String(r.name ?? ""), phoneLast4: String(r.phone ?? "").slice(-4), priority: r.priority == null ? null : Number(r.priority),
    status: String(r.status ?? "in_progress"),
    cases: cases.filter((x) => Number(x.customer_id) === Number(r.id)).map((x) => ({
      id: Number(x.id), stage: String(x.stage ?? ""), status: String(x.status ?? ""), life: LIFE(x.status, x.stage),
      planName: x.plan_name ? String(x.plan_name) : null, amount: x.requested_amount == null ? null : String(x.requested_amount), createdAt: x.created_at ?? null,
    })),
  }));
  // customers that have a case first (the search is mainly for «پرونده‌های تسهیلات»)
  items.sort((a, b) => Number(b.cases.length > 0) - Number(a.cases.length > 0));
  return { status: 200, body: { q, items } };
}

/** GET /sales-fixes/my-customers?q=&offset= — «مشتریان من» for a sales expert: own customers only, newest activity first. */
export function sf480MyCustomers(u: U, rawQ: unknown, rawOffset: unknown, rawExtra?: Record<string, unknown>): { status: number; body: any } {
  const sc = scopeSql(u);
  if (!sc) return { status: 403, body: { error: "forbidden", message: "این فهرست برای این حساب باز نیست." } };
  const q = normName(toLatin(String(rawQ ?? "")));
  const offset = Math.max(0, Math.min(100000, Number(rawOffset) || 0));
  const digits = q.replace(/\D/g, "");
  const where = [`c.merged_into_customer_id IS NULL`, sc.sql];
  const args: any[] = [...sc.args];
  if (q) {
    where.push(`(replace(replace(replace(c.name,'ي','ی'),'ك','ک'),char(8204),' ') LIKE ? ${digits.length >= 4 ? "OR c.phone LIKE ?" : ""})`);
    args.push(`%${q.replace(/[%_]/g, "")}%`); if (digits.length >= 4) args.push(`%${digits}%`);
  }
  const kanban = cpkOn();
  const countWhere = where.join(" AND ");
  const countArgs = [...args];
  if (kanban && rawExtra) {
    const st = String(rawExtra.status ?? "");
    if (st === "in_progress" || st === "completed" || st === "cancelled") { where.push("c.status=?"); args.push(st); }
    if (String(rawExtra.hasPriority ?? "") === "false") where.push("c.priority IS NULL");
    else {
      const p = Number(rawExtra.priority);
      if (p === 1 || p === 2 || p === 3) { where.push("c.priority=?"); args.push(p); }
    }
  }
  const limit = kanban && rawExtra?.limit != null ? Math.max(1, Math.min(30, Number(rawExtra.limit) || 15)) : 30;
  const total = Number(queryRow<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${where.join(" AND ")}`, args)?.n ?? 0);
  const rows = queryRows<any>(
    `SELECT c.id, c.name, c.phone, c.priority, c.status,
       (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id) last_call,
       (SELECT COUNT(*) FROM loan_applications la WHERE la.customer_id=c.id AND la.deleted_at IS NULL) cases
     FROM customers c WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(last_call, c.created_at) DESC, c.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const items = rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), phoneLast4: String(r.phone ?? "").slice(-4),
    priority: r.priority == null ? null : Number(r.priority), status: String(r.status ?? "in_progress"), lastCallAt: r.last_call ?? null, cases: Number(r.cases) })) as Array<any>;
  if (kanban && items.length) {
    const rems = cpkNextReminderAt(items.map((i) => i.id), Number(u.id));
    for (const it of items) it.nextReminderAt = rems.get(it.id) ?? null;
  }
  const body: any = { total, offset, items };
  if (kanban && (String(rawExtra?.counts ?? "") === "1")) {
    const counts = queryRows<{ status: string; n: number }>(`SELECT c.status AS status, COUNT(*) AS n FROM customers c WHERE ${countWhere} GROUP BY c.status`, countArgs);
    body.totalCustomers = Number(queryRow<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${countWhere}`, countArgs)?.n ?? 0);
    body.statusCounts = counts.map((r) => ({ status: String(r.status ?? "in_progress"), count: Number(r.n) }));
  }
  return { status: 200, body };
}

/** GET /sales-fixes/cases — «پرونده‌های من» kanban: the expert's own cases (customers they own), every open case plus cases closed in the last 30 days.
 *  The client puts each card in its status column (FB_COLUMNS). Read-only; no turn / lock state. */
export function sf480Cases(u: U, now = new Date()): { status: number; body: any } {
  const sc = scopeSql(u);
  if (!sc) return { status: 403, body: { error: "forbidden", message: "این فهرست برای این حساب باز نیست." } };
  if (u.role === "admin" || u.role === "manager") return { status: 200, body: { total: 0, cases: [], note: "admin_uses_full_list" } };
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const rows = queryRows<any>(
    `SELECT la.id, la.customer_id, la.stage, la.status, la.requested_amount, la.created_at, COALESCE(la.updated_at, la.created_at) act, p.name plan_name,
            c.name cname, c.priority
     FROM loan_applications la JOIN customers c ON c.id=la.customer_id LEFT JOIN loan_plans p ON p.id=la.plan_id
     WHERE la.deleted_at IS NULL AND ${sc.sql}
       AND (NOT (la.status='rejected' OR la.stage='completed') OR COALESCE(la.updated_at, la.created_at) >= ?)
     ORDER BY CASE WHEN c.priority IS NULL THEN 9 ELSE c.priority END, act DESC LIMIT 500`, [...sc.args, since]);
  return { status: 200, body: { total: rows.length, cases: rows.map((x) => ({ id: Number(x.id), customerId: Number(x.customer_id), customerName: String(x.cname ?? ""),
    priority: x.priority == null ? null : Number(x.priority), stage: String(x.stage ?? ""), status: String(x.status ?? ""), life: LIFE(x.status, x.stage),
    planName: x.plan_name ? String(x.plan_name) : null, amount: x.requested_amount == null ? null : String(x.requested_amount), createdAt: x.created_at ?? null, lastActivityAt: x.act ?? null })) } };
}
