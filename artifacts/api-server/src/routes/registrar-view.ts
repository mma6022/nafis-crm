/**
 * registrar_view routes (assistants53) — see lib/registrar-view.ts. READ ONLY, server-side:
 *  - GET /registrar-view/me            → { enabled, count } (count = live customers registered by me, any owner);
 *  - GET /registrar-view/customers/:id → the read-only registration card, only when registered_by = me (404 otherwise).
 * No national code, address, documents, call content, loans, wallet or finance. Phone always masked. Every case view is audited
 * (lead_annotator_audit, action 'registrar_view'). The list itself is GET /customers?scope=registered (routes/crm.ts).
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb, execute, queryRow } from "../lib/crm-db";
import { ensureLeadAnnotatorSchema } from "../lib/lead-annotator";
import { maskCustomerPhone } from "../lib/cross-owner-search";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const SOURCE_LABEL: Record<string, string> = { instagram: "اینستاگرام", manual: "ثبت دستی", site: "سایت", portal: "پرتال مشتری", phone: "تماس تلفنی" };
const STATUS_LABEL: Record<string, string> = { in_progress: "در حال انجام", completed: "اتمام", cancelled: "لغو شده" };

router.get("/registrar-view/me", (_req, res): void => {
  const u = me(res);
  if (!u?.registrarView) { res.json({ enabled: false, count: 0 }); return; }
  const n = queryRow<{ n: number }>("SELECT count(*) n FROM customers WHERE registered_by=? AND merged_into_customer_id IS NULL", [u.id])?.n ?? 0;
  res.json({ enabled: true, count: Number(n) });
});

type Row = { id: number; name: string | null; phone: string | null; status: string | null; priority: number | null; is_urgent: number;
  salesperson_id: number | null; owner_name: string | null; created_at: string; registered_at: string | null; source: string | null;
  registration_source: string | null; lead_source: string | null; lead_source_other: string | null; registrar_note: string | null;
  city: string | null; intake_credit_rank: string | null; call_count: number; last_call_at: string | null };

router.get("/registrar-view/customers/:id", (req, res): void => {
  const u = me(res);
  if (!u?.registrarView) { res.status(403).json({ error: "registrar_view_only" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "bad_id" }); return; }
  const r = queryRow<Row>(`SELECT c.id, c.name, c.phone, c.status, c.priority, c.is_urgent, c.salesperson_id, s.name owner_name, c.created_at,
      c.registered_at, c.source, c.registration_source, c.lead_source, c.lead_source_other, c.registrar_note, c.city, c.intake_credit_rank,
      (SELECT count(*) FROM call_logs l WHERE l.customer_id=c.id) call_count, (SELECT max(l.created_at) FROM call_logs l WHERE l.customer_id=c.id) last_call_at
    FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
    WHERE c.id=? AND c.registered_by=? AND c.merged_into_customer_id IS NULL`, [id, u.id]);
  if (!r) { res.status(404).json({ error: "Customer not found" }); return; }
  ensureLeadAnnotatorSchema(crmDb);
  execute("INSERT INTO lead_annotator_audit(user_id,action,customer_id,result_count,created_at) VALUES(?,?,?,?,?)", [u.id, "registrar_view", id, null, new Date().toISOString()]);
  const src = r.lead_source || r.registration_source || r.source;
  const ownedByMe = u.salespersonId != null && Number(r.salesperson_id) === Number(u.salespersonId);
  res.json({
    id: Number(r.id), name: r.name || `مشتری #${r.id}`, phoneMasked: maskCustomerPhone(r.phone), isUrgent: Number(r.is_urgent) === 1,
    status: r.status || "in_progress", statusLabel: STATUS_LABEL[r.status || "in_progress"] ?? r.status, priority: r.priority == null ? null : Number(r.priority),
    ownerName: r.owner_name, ownedByMe, readOnly: !ownedByMe,
    registeredAt: r.registered_at || r.created_at, source: src, sourceLabel: src ? (SOURCE_LABEL[src] ?? r.lead_source_other ?? src) : null,
    registrarNote: r.registrar_note, city: r.city, intakeCreditRank: r.intake_credit_rank,
    callCount: Number(r.call_count), lastCallAt: r.last_call_at,
  });
});

export default router;
