import { Router, type RequestHandler } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import {
  DraftError, canViewDrafts, createDraft, deleteDraft, draftCounts, ensureLoanRequestDraftSchema, getDraft, listDrafts,
  autoDeleteEnabled, listLegacyPreRegistrations, listOrphanPaidFees, openDraftForCustomer, seesAllDrafts, startLoanRequestDraftScheduler, updateDraft,
} from "../lib/loan-request-drafts";
import { queryRow } from "../lib/crm-db";

ensureLoanRequestDraftSchema();
startLoanRequestDraftScheduler();
const router = Router();
// Responses: {draft} for one, {items,total,seesAll,orphanFees,legacyCases,autoDelete} for lists; errors {error, code, ...} (409 draft_exists / draft_version_conflict carry {draft}).
const user = (res: any) => res.locals.authUser as AuthUser;
const wrap = (fn: (req: any, res: any) => void): RequestHandler => (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!canViewDrafts(user(res))) { res.status(403).json({ error: "Forbidden" }); return; }
    fn(req, res);
  } catch (e) {
    if (e instanceof DraftError) { res.status(e.status).json({ error: e.code, code: e.code, ...e.extra }); return; }
    (req as any).log?.error?.({ err: e }, "loan request draft failed");
    res.status(500).json({ error: "loan_request_draft_failed" });
  }
};
const intId = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new DraftError(400, "invalid_id"); return n; };

router.use("/loan-request-drafts", requireAuth);
router.get("/loan-request-drafts", wrap((req, res) => {
  const u = user(res);
  const scope = req.query.scope === "mine" ? "mine" : "all";
  const search = typeof req.query.search === "string" ? req.query.search.slice(0, 80) : undefined;
  const paidOnly = req.query.paid === "1" || req.query.paid === "true";
  const items = listDrafts(u, { scope, paidOnly, search });
  // Read-only extras, computed at read time: orphan paid fees (admin only, enforced in the lib) and hidden old pre-registration cases.
  const orphanFees = listOrphanPaidFees(u, { scope, search });
  const legacyCases = paidOnly ? [] : listLegacyPreRegistrations(u, { scope, search });
  res.json({ items, total: items.length, seesAll: seesAllDrafts(u), orphanFees, legacyCases, autoDelete: autoDeleteEnabled() });
}));
router.get("/loan-request-drafts/counts", wrap((_req, res) => { res.json(draftCounts(user(res))); }));
router.get("/loan-request-drafts/by-customer/:customerId", wrap((req, res) => {
  const u = user(res), customerId = intId(req.params.customerId);
  const c = queryRow<any>("SELECT salesperson_id FROM customers WHERE id=?", [customerId]);
  if (!c || (!seesAllDrafts(u) && c.salesperson_id !== u.salespersonId)) throw new DraftError(404, "customer_not_found");
  res.json({ draft: openDraftForCustomer(customerId, u) });
}));
router.get("/loan-request-drafts/:id", wrap((req, res) => { res.json({ draft: getDraft(intId(req.params.id), user(res)) }); }));
router.post("/loan-request-drafts", wrap((req, res) => { res.status(201).json({ draft: createDraft(user(res), req.body) }); }));
router.put("/loan-request-drafts/:id", wrap((req, res) => {
  const d = updateDraft(intId(req.params.id), user(res), req.body, req.header("If-Match"));
  res.setHeader("ETag", `"${d.version}"`);
  res.json({ draft: d });
}));
router.delete("/loan-request-drafts/:id", wrap((req, res) => { res.json(deleteDraft(intId(req.params.id), user(res), req.body)); }));

export default router;
