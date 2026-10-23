import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRow } from "../lib/crm-db";
import { assertGoodsPurchaseScope } from "../lib/goods-finance";
import { openContractUpdateNotices, sendUpdatedLoanContract } from "../lib/contract-template-updates";

const router = Router();
router.use(requireAuth);
const actorOf = (res: Response) => res.locals.authUser as AuthUser;

function loanScope(applicationId: number, actor: AuthUser): boolean {
  const app = queryRow<any>(`SELECT a.id,c.salesperson_id FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    WHERE a.id=? AND a.deleted_at IS NULL`, [applicationId]);
  if (!app) return false;
  if (actor.role === "admin") return true;
  if (actor.role !== "salesperson") return false;
  return actor.customerScope !== "assigned" || Number(app.salesperson_id) === Number(actor.salespersonId);
}

router.get("/contract-updates/:kind/:id", (req: Request, res: Response): void => {
  const actor = actorOf(res); const id = Number(req.params.id); const kind = String(req.params.kind);
  if (!Number.isSafeInteger(id) || id < 1 || !["loan", "goods"].includes(kind)) { res.status(400).json({ error: "invalid_request" }); return; }
  try {
    if (kind === "loan") { if (!loanScope(id, actor) && actor.role !== "registrar") throw new Error("denied"); }
    else assertGoodsPurchaseScope(id, actor);
  } catch { res.status(404).json({ error: "not_found" }); return; }
  res.json({ notices: openContractUpdateNotices(kind as "loan" | "goods", id) });
});

router.post("/contract-updates/loan/:id/send-updated", requirePermission("contracts.send"), async (req: Request, res: Response): Promise<void> => {
  const actor = actorOf(res); const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !loanScope(id, actor)) { res.status(404).json({ error: "not_found" }); return; }
  try { res.json(await sendUpdatedLoanContract(id, actor, req.log)); }
  catch (e) {
    const code = e instanceof Error ? e.message : "update_failed";
    res.status(/^provider_/.test(code) ? 502 : 409).json({ error: /^[a-z_]+$/.test(code) ? code : "update_failed" });
  }
});
export default router;
