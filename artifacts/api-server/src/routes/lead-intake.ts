/**
 * crm-instagram-leads + urgent v1.1 staff API (lib/lead-intake.ts). All under /lead-intake/* (no clash with /customers/:id).
 * GET   /lead-intake/options                       form chips, my default source (SETTING), owner line, urgent / clear reasons
 * GET   /lead-intake/customers/:id                 registrar card + rank events + urgent flag / last clear (viewer of the case)
 * PATCH /lead-intake/customers/:id/rank            {rank} owner or admin; logged in customer_intake_events
 * POST  /lead-intake/customers/:id/urgent          {reasonCode, reasonText} viewer of the case or lead_annotator; attempt if already urgent
 * POST  /lead-intake/customers/:id/urgent/clear    {clearReasonCode, clearNote} admin only; no bell
 * GET   /lead-intake/queue-badges?ids=1,2          source / rank / registrar / «جدید» / urgent flagger for queue cards (≤ 200 ids)
 * GET   /lead-intake/urgent-waiting                count of open urgent customers in my scope (due-modal line §0-23)
 * GET/PUT /lead-intake/admin/settings              default source per seller (admin only, logged)
 * No SMS / Bale / customer message anywhere; bells only from the urgent set (lib/customer-urgent.ts).
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { crmDb, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { URGENT_CLEAR_REASONS, URGENT_REASONS, URGENT_STAFF_OTHER_MAX, URGENT_CLEAR_NOTE_MAX } from "../lib/customer-urgent";
import { defaultOwnerDecision } from "../lib/default-owner-rule";
import {
  applyStaffUrgent, crmCallStartedSql, defaultLeadSourceForUser, defaultSourceBySeller, ensureLeadIntakeSchema, INTAKE_RANKS, intakeStartedAt,
  LEAD_SOURCE_OTHER_MAX, LEAD_SOURCES, lastUrgentClear, openUrgentFlag, openUrgentFlags, RANK_LABEL, REGISTRAR_NOTE_MAX, saveIntakeSetting,
  setIntakeRank, validateDefaultSourceBySeller, type IntakeRank,
} from "../lib/lead-intake";

ensureLeadIntakeSchema(crmDb);
const router: IRouter = Router();
const guard = requirePermission("customers.view");
const me = (res: Response) => res.locals.authUser as AuthUser;
const isAdmin = (u: AuthUser) => u.role === "admin" && Number(u.id) !== 29;
const label = (u: AuthUser) => u.fullName || u.username;
type C = { id: number; salesperson_id: number | null; status: string | null };
const cust = (id: number) => Number.isSafeInteger(id) && id > 0
  ? queryRow<C>("SELECT id, salesperson_id, status FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]) : undefined;
/** Same scope as the customer page: admin, an all-scope user, or the case owner. */
const canView = (u: AuthUser, c: C | undefined) => Boolean(c) && (isAdmin(u) || u.customerScope !== "assigned"
  || (u.salespersonId != null && Number(c!.salesperson_id) === Number(u.salespersonId)));
const isOwner = (u: AuthUser, c: C) => u.salespersonId != null && Number(c.salesperson_id) === Number(u.salespersonId);
const spName = (id: number | null | undefined) => id == null ? null : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [id])?.name ?? null;

router.get("/lead-intake/options", guard, (_req, res) => {
  const u = me(res); ensureLeadIntakeSchema(crmDb);
  const rule = defaultOwnerDecision("staff_form", u.id);
  const ownerId = rule.apply ? rule.ownerSalespersonId : u.customerScope === "assigned" ? u.salespersonId : null;
  res.json({
    leadSources: Object.entries(LEAD_SOURCES).map(([key, l]) => ({ key, label: l })), defaultLeadSource: defaultLeadSourceForUser(crmDb, u.id),
    ranks: INTAKE_RANKS.map((r) => ({ key: r, label: RANK_LABEL(r) })), leadSourceOtherMax: LEAD_SOURCE_OTHER_MAX, registrarNoteMax: REGISTRAR_NOTE_MAX,
    owner: { salespersonId: ownerId ?? null, name: spName(ownerId ?? null), byRule: rule.apply },
    urgentReasons: URGENT_REASONS, urgentOtherMax: URGENT_STAFF_OTHER_MAX, clearReasons: URGENT_CLEAR_REASONS, clearNoteMax: URGENT_CLEAR_NOTE_MAX,
    canClearUrgent: isAdmin(u), intakeStartedAt: intakeStartedAt(crmDb),
  });
});

router.get("/lead-intake/customers/:id", guard, (req, res) => {
  const u = me(res); const c = cust(Number(req.params.id));
  if (!canView(u, c)) { res.status(404).json({ error: "Customer not found" }); return; }
  const id = Number(c!.id);
  const r = queryRow<any>(`SELECT c.registered_by, c.registered_at, c.lead_source, c.lead_source_other, c.intake_credit_rank, c.registrar_note, c.is_urgent,
      c.registration_source, u.full_name, u.username, ${crmCallStartedSql(crmDb, "c")} called
    FROM customers c LEFT JOIN users u ON u.id=c.registered_by WHERE c.id=?`, [id]);
  // §0-9: the card exists only for customers registered by a person after the intake start (old customers: no card).
  const card = r && r.registered_at && r.registered_by != null ? {
    registrar: { userId: Number(r.registered_by), name: r.full_name || r.username || `کاربر ${r.registered_by}` }, registeredAt: r.registered_at,
    leadSource: r.lead_source ?? "none", leadSourceLabel: (LEAD_SOURCES as Record<string, string>)[r.lead_source ?? "none"] ?? LEAD_SOURCES.none,
    leadSourceOther: r.lead_source_other ?? null, rank: r.intake_credit_rank ?? "unknown", rankLabel: RANK_LABEL(r.intake_credit_rank),
    note: r.registrar_note ?? null, isNew: !Number(r.called), canEditRank: isAdmin(u) || isOwner(u, c!),
  } : null;
  const events = queryRows<any>("SELECT id, kind, old_value, new_value, actor_label, created_at FROM customer_intake_events WHERE customer_id=? ORDER BY id DESC LIMIT 20", [id])
    .map((e) => ({ id: Number(e.id), kind: e.kind, oldValue: e.old_value, newValue: e.new_value, oldLabel: RANK_LABEL(e.old_value), newLabel: RANK_LABEL(e.new_value), actorLabel: e.actor_label, createdAt: e.created_at }));
  res.json({ customerId: id, card, events, urgent: { isUrgent: Number(r?.is_urgent) === 1, flag: openUrgentFlag(crmDb, id), lastClear: lastUrgentClear(crmDb, id) },
    canFlagUrgent: true, canClearUrgent: isAdmin(u) });
});

router.patch("/lead-intake/customers/:id/rank", guard, (req, res) => {
  const u = me(res); const c = cust(Number(req.params.id));
  if (!canView(u, c)) { res.status(404).json({ error: "Customer not found" }); return; }
  if (!(isAdmin(u) || isOwner(u, c!))) { res.status(403).json({ error: "rank_owner_or_admin_only", message: "رتبه را فقط مالک پرونده یا مدیر عوض می‌کند." }); return; }
  const rank = req.body?.rank;
  if (!(INTAKE_RANKS as readonly string[]).includes(rank)) { res.status(422).json({ error: "bad_rank", message: "رتبه‌ی اعتباری نامعتبر است." }); return; }
  const r = runTransaction(() => setIntakeRank(crmDb, Number(c!.id), rank as IntakeRank, { id: u.id, label: label(u) }));
  res.json({ customerId: Number(c!.id), rank, rankLabel: RANK_LABEL(rank), changed: r.changed });
});

router.post("/lead-intake/customers/:id/urgent", guard, (req, res) => {
  const u = me(res); const c = cust(Number(req.params.id));
  if (!c || !(canView(u, c) || u.leadAnnotator)) { res.status(404).json({ error: "Customer not found" }); return; }
  const r = runTransaction(() => applyStaffUrgent(crmDb, Number(c.id), true, { kind: "user", userId: u.id, label: label(u) }, isAdmin(u), req.body,
    u.leadAnnotator && !canView(u, c) ? "lead_annotator" : "urgent_flag"));
  res.status(r.status).json(r.body);
});

router.post("/lead-intake/customers/:id/urgent/clear", guard, (req, res) => {
  const u = me(res); const c = cust(Number(req.params.id));
  if (!c || !(canView(u, c) || u.leadAnnotator)) { res.status(404).json({ error: "Customer not found" }); return; }
  const r = runTransaction(() => applyStaffUrgent(crmDb, Number(c.id), false, { kind: "user", userId: u.id, label: label(u) }, isAdmin(u), req.body, "urgent_clear"));
  res.status(r.status).json(r.body);
});

router.get("/lead-intake/queue-badges", guard, (req, res) => {
  const u = me(res);
  const ids = [...new Set(String(req.query.ids ?? "").split(",").map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) { res.json({ items: [] }); return; }
  const rows = queryRows<any>(`SELECT c.id, c.salesperson_id, c.status, c.registered_by, c.registered_at, c.lead_source, c.intake_credit_rank, c.registrar_note, c.is_urgent,
      u.full_name, u.username, ${crmCallStartedSql(crmDb, "c")} called
    FROM customers c LEFT JOIN users u ON u.id=c.registered_by WHERE c.merged_into_customer_id IS NULL AND c.id IN (${ids.map(() => "?").join(",")})`, ids)
    .filter((r) => canView(u, r));
  const flags = openUrgentFlags(crmDb, rows.filter((r) => Number(r.is_urgent) === 1).map((r) => Number(r.id)));
  res.json({ items: rows.map((r) => {
    const intake = r.registered_at && r.registered_by != null;
    return { id: Number(r.id),
      intake: intake ? { leadSource: r.lead_source ?? "none", leadSourceLabel: (LEAD_SOURCES as Record<string, string>)[r.lead_source ?? "none"] ?? LEAD_SOURCES.none,
        rank: r.intake_credit_rank ?? "unknown", rankLabel: RANK_LABEL(r.intake_credit_rank), registrarName: r.full_name || r.username || null, registeredAt: r.registered_at,
        noteFirstLine: r.registrar_note ? String(r.registrar_note).split(/\r?\n/)[0].slice(0, 140) : null, isNew: !Number(r.called) } : null,
      urgent: Number(r.is_urgent) === 1 ? flags.get(Number(r.id)) ?? { at: null, by: null, reason: null } : null };
  }) });
});

router.get("/lead-intake/urgent-waiting", guard, (_req, res) => {
  const u = me(res);
  const scoped = !isAdmin(u) && u.customerScope === "assigned";
  if (scoped && u.salespersonId == null) { res.json({ count: 0 }); return; }
  const n = queryRow<{ n: number }>(`SELECT COUNT(*) n FROM customers WHERE is_urgent=1 AND merged_into_customer_id IS NULL
      AND COALESCE(status,'in_progress') NOT IN ('cancelled','completed') ${scoped ? "AND salesperson_id=?" : ""}`, scoped ? [u.salespersonId!] : [])?.n ?? 0;
  res.json({ count: Number(n) });
});

const settingsView = () => ({
  defaultSourceBySeller: defaultSourceBySeller(crmDb), intakeStartedAt: intakeStartedAt(crmDb),
  leadSources: Object.entries(LEAD_SOURCES).filter(([k]) => k !== "other").map(([key, l]) => ({ key, label: l })),
  sellers: queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons WHERE active=1 AND id NOT IN (5,19,20) ORDER BY id").map((s) => ({ id: Number(s.id), name: s.name })),
  log: queryRows<any>("SELECT id, key, old_value oldValue, new_value newValue, actor_user_id actorUserId, via, created_at createdAt FROM lead_intake_settings_log ORDER BY id DESC LIMIT 20"),
});
router.get("/lead-intake/admin/settings", guard, (_req, res) => {
  if (!isAdmin(me(res))) { res.status(403).json({ error: "forbidden" }); return; }
  res.json(settingsView());
});
router.put("/lead-intake/admin/settings", guard, (req, res) => {
  const u = me(res);
  if (!isAdmin(u)) { res.status(403).json({ error: "forbidden" }); return; }
  const v = validateDefaultSourceBySeller(crmDb, req.body?.defaultSourceBySeller);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  saveIntakeSetting(crmDb, "default_source_by_seller", JSON.stringify(v.value), Number(u.id));
  res.json(settingsView());
});

export default router;
