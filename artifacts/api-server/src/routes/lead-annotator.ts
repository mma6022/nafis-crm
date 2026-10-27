/**
 * lead_annotator routes (PM 2026-10-27 22:37) — see lib/lead-annotator.ts. Enforced here, server-side:
 *  - every route requires the capability (403 otherwise; user 29 never has it);
 *  - the customer view is id, name, masked phone, urgent tick, annotations, urgent history — no stage, owner, amounts, documents,
 *    calls, national code, address or credit;
 *  - writes: one note («اینستاگرام» label, actor name) or the urgent tick with a REQUIRED reason. Nothing else.
 *  - search is exact id, exact mobile or a name fragment (≥2 letters), 20 rows, rate limited; every call is audited.
 * Phones are masked here AND by the leadAnnotatorMask middleware on every /api response for this user.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { crmDb, execute, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { setCustomerUrgent, urgentHistory, URGENT_REASON_MAX } from "../lib/customer-urgent";
import { ensureLeadAnnotatorSchema, LEAD_ANNOTATOR_NOTE_LABEL, maskPhonesDeep, NOTE_MAX } from "../lib/lead-annotator";
import { maskCustomerPhone } from "../lib/cross-owner-search";
import { normalizeCustomerMobile, normalizePersianSearchText } from "../lib/customer-integrity";
import { parseCustomerIdQuery, toLatinDigits } from "../lib/customer-id-search";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const gate = (_req: Request, res: Response, next: NextFunction): void => {
  if (!me(res)?.leadAnnotator) { res.status(403).json({ error: "lead_annotator_only" }); return; }
  ensureLeadAnnotatorSchema(crmDb); next();
};
const audit = (userId: number, action: string, customerId: number | null, n: number | null = null) =>
  execute("INSERT INTO lead_annotator_audit(user_id,action,customer_id,result_count,created_at) VALUES(?,?,?,?,?)", [userId, action, customerId, n, new Date().toISOString()]);
const buckets = new Map<number, number[]>();
const SEARCH_LIMIT = 60, SEARCH_WINDOW = 10 * 60_000;
function allow(userId: number): boolean {
  const now = Date.now(); const b = (buckets.get(userId) ?? []).filter((t) => now - t < SEARCH_WINDOW);
  if (b.length >= SEARCH_LIMIT) { buckets.set(userId, b); return false; }
  b.push(now); buckets.set(userId, b); return true;
}
export function resetLeadAnnotatorLimiter(): void { buckets.clear(); }

type Row = { id: number; name: string | null; phone: string | null; is_urgent: number };
const card = (r: Row) => ({ id: Number(r.id), name: r.name || `مشتری #${r.id}`, phoneMasked: maskCustomerPhone(r.phone), isUrgent: Number(r.is_urgent) === 1 });
const customer = (id: number) => queryRow<Row>("SELECT id, name, phone, is_urgent FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]);
const actorLabel = (u: AuthUser) => (u.fullName || u.username || `کاربر ${u.id}`).trim();

router.get("/lead-annotator/me", (_req, res): void => { res.json({ enabled: Boolean(me(res)?.leadAnnotator), noteLabel: LEAD_ANNOTATOR_NOTE_LABEL }); });

router.get("/lead-annotator/customers", gate, (req, res): void => {
  const u = me(res); const raw = toLatinDigits(String(req.query.q ?? "")).trim();
  if (!raw) { res.json({ items: [] }); return; }
  if (!allow(u.id)) { res.status(429).json({ error: "rate_limited" }); return; }
  let rows: Row[] = [];
  const idq = parseCustomerIdQuery(raw); const mobile = normalizeCustomerMobile(raw);
  if (/^09\d{9}$/.test(mobile)) rows = queryRows<Row>("SELECT id, name, phone, is_urgent FROM customers WHERE phone=? AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 20", [mobile]);
  else if (idq) rows = queryRows<Row>("SELECT id, name, phone, is_urgent FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [idq.id]);
  else {
    const name = normalizePersianSearchText(raw);
    if (name.replace(/\s/g, "").length < 2 || /\d/.test(name)) { res.status(400).json({ error: "query_too_short" }); return; }
    rows = queryRows<Row>("SELECT id, name, phone, is_urgent FROM customers WHERE merged_into_customer_id IS NULL AND name LIKE ? ORDER BY id DESC LIMIT 20", [`%${name}%`]);
  }
  audit(u.id, "search", null, rows.length);
  res.json({ items: rows.map(card) });
});

router.get("/lead-annotator/customers/:id", gate, (req, res): void => {
  const id = Number(req.params.id); const c = Number.isSafeInteger(id) && id > 0 ? customer(id) : undefined;
  if (!c) { res.status(404).json({ error: "Customer not found" }); return; }
  const annotations = queryRows<{ id: number; body: string; label: string; actor_label: string; created_at: string }>(
    "SELECT id, body, label, actor_label, created_at FROM customer_annotations WHERE customer_id=? ORDER BY id DESC LIMIT 50", [id])
    .map((a) => ({ id: Number(a.id), body: a.body, label: a.label, actorLabel: a.actor_label, createdAt: a.created_at }));
  const history = (urgentHistory(crmDb, id, 20) as { newValue: number; actorLabel: string | null; actorKind: string; reason: string | null; createdAt: string }[])
    .map((h) => ({ isUrgent: Number(h.newValue) === 1, actorLabel: h.actorKind === "system" ? "سیستم" : h.actorLabel, reason: h.reason, createdAt: h.createdAt }));
  audit(me(res).id, "view", id);
  res.json(maskPhonesDeep({ ...card(c), annotations, urgentHistory: history }));
});

router.post("/lead-annotator/customers/:id/notes", gate, (req, res): void => {
  const u = me(res); const id = Number(req.params.id);
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > NOTE_MAX) { res.status(422).json({ error: "bad_note" }); return; }
  if (!(Number.isSafeInteger(id) && id > 0 && customer(id))) { res.status(404).json({ error: "Customer not found" }); return; }
  const at = new Date().toISOString();
  const r = runTransaction(() => {
    const ins = crmDb.prepare("INSERT INTO customer_annotations(customer_id,body,label,actor_kind,actor_user_id,actor_label,created_at) VALUES(?,?,?,'user',?,?,?)")
      .run(id, body, LEAD_ANNOTATOR_NOTE_LABEL, u.id, actorLabel(u), at);
    audit(u.id, "note", id); return Number(ins.lastInsertRowid);
  });
  res.status(201).json(maskPhonesDeep({ id: r, customerId: id, body, label: LEAD_ANNOTATOR_NOTE_LABEL, actorLabel: actorLabel(u), createdAt: at }));
});

router.post("/lead-annotator/customers/:id/urgent", gate, (req, res): void => {
  const u = me(res); const id = Number(req.params.id);
  if (typeof req.body?.isUrgent !== "boolean") { res.status(422).json({ error: "isUrgent_required" }); return; }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 3 || reason.length > URGENT_REASON_MAX) { res.status(422).json({ error: "reason_required" }); return; }
  if (!(Number.isSafeInteger(id) && id > 0 && customer(id))) { res.status(404).json({ error: "Customer not found" }); return; }
  const r = runTransaction(() => {
    const out = setCustomerUrgent(crmDb, id, req.body.isUrgent, { kind: "user", userId: u.id, label: actorLabel(u) }, "lead_annotator", reason);
    audit(u.id, out.changed ? "urgent" : "urgent_noop", id); return out;
  });
  res.json({ id, isUrgent: r.isUrgent, changed: r.changed });
});

/** Owners / admins read the annotations on a customer they can already open (same scope rule as the customer page). */
router.get("/customers/:id/annotations", requirePermission("customers.view"), (req, res): void => {
  const u = me(res); const id = Number(req.params.id);
  const c = Number.isSafeInteger(id) && id > 0 ? queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]) : undefined;
  const can = c && (u.role === "admin" || u.customerScope !== "assigned" || (u.salespersonId != null && Number(c.salesperson_id) === Number(u.salespersonId)));
  if (!can) { res.status(404).json({ error: "Customer not found" }); return; }
  ensureLeadAnnotatorSchema(crmDb);
  res.json({ items: queryRows<{ id: number; body: string; label: string; actor_label: string; created_at: string }>(
    "SELECT id, body, label, actor_label, created_at FROM customer_annotations WHERE customer_id=? ORDER BY id DESC LIMIT 50", [id])
    .map((a) => ({ id: Number(a.id), body: a.body, label: a.label, actorLabel: a.actor_label, createdAt: a.created_at })) });
});

export default router;
