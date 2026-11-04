/** FILE-DETAIL v1.0: flag read + guarded resend of the existing signature link. */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { queryRow } from "../lib/crm-db";
import { fdLinkResendState, fdOn, fdResendSignatureLink, fdSeesApp } from "../lib/file-detail-v1";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser | undefined;
router.get("/file-detail-v1/me", (_req, res) => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ on: fdOn(Number(u.id)) });
});
router.get("/file-detail-v1/files/:id/link-resends", (req, res) => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!fdOn(Number(u.id))) { res.status(404).json({ error: "not_found" }); return; }
  const appId = Number(req.params.id); if (!Number.isInteger(appId) || appId <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
  const app = queryRow<{ customer_id: number }>("SELECT customer_id FROM loan_applications WHERE id=? AND deleted_at IS NULL", [appId]);
  if (!app || !fdSeesApp(u, Number(app.customer_id))) { res.status(404).json({ error: "not_found" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(fdLinkResendState(appId));
});
router.post("/loan-applications/:id/contract-generations/:genId/resend-link", async (req, res): Promise<void> => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const appId = Number(req.params.id); const genId = Number(req.params.genId);
  if (!Number.isInteger(appId) || !Number.isInteger(genId) || appId <= 0 || genId <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
  const r = await fdResendSignatureLink(u, appId, genId);
  if (r.ok) { req.log?.info({ applicationId: appId, generationId: genId, userId: u.id }, "file-detail-v1 signature link resent"); res.json({ sentAt: r.sentAt }); return; }
  if (r.retryAfterSeconds) res.setHeader("Retry-After", String(r.retryAfterSeconds));
  res.status(r.status).json({ error: r.error, message: r.message, retryAfterSeconds: r.retryAfterSeconds });
});
export default router;
