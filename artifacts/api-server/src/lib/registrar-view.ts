/**
 * registrar_view (assistants53, Mohammad «اکی» 2026-10-28 09:11 Tehran on Ahmad's proposal): a user holding this capability
 * may READ — never write — every customer whose registrar (customers.registered_by) is that user, including customers now owned
 * by someone else (e.g. transferred to Kazemi). Purpose: check his own registrations and catch duplicates.
 *  - list: GET /customers?scope=registered (registered_by = me; replaces the assigned-owner filter for that request only);
 *  - case: GET /registrar-view/customers/:id — id, name, masked phone, status, priority, urgent, owner name, registration info,
 *    call count / last call. No national code, address, documents, call content, loans, wallet or other finance.
 *  - writes: registrarWriteGuard (app.ts) returns 403 registrar_read_only for ANY non-GET request that targets such a customer
 *    (path /customers/:id… or body customerId / customer_id / customerIds) unless the customer is also in the user's normal
 *    scope. The lead_annotator note / urgent routes are left exactly as they were.
 *  - REGTAG-55 (PM via Ahmad 2026-10-28): the registrar may still TAG a customer he registered (customers.registered_by = me) even
 *    though the default-owner rule hands it to Kazemi at create — PATCH /customers/:id/tags only, ADD-only (existing tags are
 *    kept; nothing removed), never repeat_request without a pending request (the route's own checks). Any registrar except
 *    admins (who already pass), user 29 and the trainees (salespersons 5 / 19 / 20). Every other write stays 403 / 404.
 * Grant / revoke = an access_capabilities row (+ access_capability_log), written only by a release script. Never user 29;
 * never the trainees (salespersons 5 / 19 / 20); never an admin (they already see everything).
 * db-injected where possible (no side effects on import).
 */
import type { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";
import { ensureLeadAnnotatorSchema, LEAD_ANNOTATOR_BLOCKED_SALESPERSONS, LEAD_ANNOTATOR_BLOCKED_USERS } from "./lead-annotator";

export const REGISTRAR_VIEW = "registrar_view";

let ready = new WeakSet<object>();
export function hasRegistrarView(db: DatabaseSync, userId: number, role: string, salespersonId: number | null): boolean {
  if (LEAD_ANNOTATOR_BLOCKED_USERS.includes(Number(userId))) return false;
  if (salespersonId != null && LEAD_ANNOTATOR_BLOCKED_SALESPERSONS.includes(Number(salespersonId))) return false;
  if (role === "admin") return false;
  try {
    if (!ready.has(db)) { ensureLeadAnnotatorSchema(db); ready.add(db); }
    return Boolean(db.prepare("SELECT 1 x FROM access_capabilities WHERE subject_kind='user' AND subject_id=? AND capability=?").get(Number(userId), REGISTRAR_VIEW));
  } catch { return false; }
}
export function resetRegistrarViewCache(): void { ready = new WeakSet(); }

/** REGTAG-55: PATCH /customers/:id/tags by the customer's own registrar (add-only, enforced in the route). */
export const REGISTRAR_TAG_PATH = /^\/customers\/(\d+)\/tags\/?$/;
export function registrarCanTag(db: DatabaseSync, u: { id: number; role: string; salespersonId: number | null }, customerId: number): boolean {
  if (!u || u.role === "admin" || LEAD_ANNOTATOR_BLOCKED_USERS.includes(Number(u.id))) return false;
  if (u.salespersonId != null && LEAD_ANNOTATOR_BLOCKED_SALESPERSONS.includes(Number(u.salespersonId))) return false;
  const r = db.prepare("SELECT registered_by FROM customers WHERE id=? AND merged_into_customer_id IS NULL").get(customerId) as { registered_by: number | null } | undefined;
  return Boolean(r && r.registered_by != null && Number(r.registered_by) === Number(u.id));
}

type GuardUser = { id: number; registrarView?: boolean; customerScope: "all" | "assigned"; salespersonId: number | null };
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
// The user's existing lead_annotator actions (note «اینستاگرام» + urgent tick) stay exactly as they are.
const EXEMPT = [/^\/lead-annotator\//, /^\/lead-intake\/customers\/\d+\/urgent(?:\/clear)?\/?$/];
const idsOf = (req: Request): number[] => {
  const out: number[] = [];
  for (const m of req.path.matchAll(/(?:^|\/)customers\/(\d+)(?=\/|$)/g)) out.push(Number(m[1]));
  const b = req.body as Record<string, unknown> | undefined;
  if (b && typeof b === "object") {
    for (const k of ["customerId", "customer_id"]) { const n = Number(b[k]); if (Number.isSafeInteger(n) && n > 0) out.push(n); }
    if (Array.isArray(b.customerIds)) for (const v of b.customerIds) { const n = Number(v); if (Number.isSafeInteger(n) && n > 0) out.push(n); }
  }
  return [...new Set(out)];
};
/** True when the customer is visible to `u` ONLY through registrar_view (registered by u, outside u's normal scope). */
export function registrarOnly(db: DatabaseSync, u: GuardUser, customerId: number): boolean {
  const r = db.prepare("SELECT registered_by, salesperson_id FROM customers WHERE id=?").get(customerId) as { registered_by: number | null; salesperson_id: number | null } | undefined;
  if (!r || Number(r.registered_by) !== Number(u.id)) return false;
  if (u.customerScope === "all") return false;
  return u.salespersonId == null || Number(r.salesperson_id) !== Number(u.salespersonId);
}
export function makeRegistrarWriteGuard(getDb: () => DatabaseSync) {
  return function registrarWriteGuard(req: Request, res: Response, next: NextFunction): void {
    const u = res.locals.authUser as GuardUser | undefined;
    if (!u?.registrarView || SAFE.has(req.method) || EXEMPT.some((re) => re.test(req.path))) { next(); return; }
    const db = getDb();
    const tagM = req.method === "PATCH" ? REGISTRAR_TAG_PATH.exec(req.path) : null;
    if (tagM && registrarCanTag(db, res.locals.authUser as { id: number; role: string; salespersonId: number | null }, Number(tagM[1]))) { next(); return; }
    if (idsOf(req).some((id) => registrarOnly(db, u, id))) {
      res.status(403).json({ error: "registrar_read_only", message: "این پرونده را شما ثبت کرده‌اید ولی مالک آن کارشناس دیگری است؛ فقط مشاهده مجاز است." });
      return;
    }
    next();
  };
}
