/** «حساب شخصی بله» routes (see lib/bale.ts): staff router behind the CRM session under /api; the internal inbound router
 * (sidecar → API, loopback + internal token) is mounted in app.ts outside /api; the runner hook is mounted by routes/assistants.ts. */
import type { Request, Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { createBale, ensureBaleSchema } from "../lib/bale";
import { createHttpBaleSidecar } from "../lib/bale-sidecar-client";

ensureBaleSchema(crmDb);
const env = () => process.env;
const bale = createBale({
  db: crmDb, env,
  sidecar: createHttpBaleSidecar(() => ({ ...process.env, BALE_SIDECAR_URL: process.env.BALE_SIDECAR_URL || "http://127.0.0.1:18470" })),
  actor: (res: Response) => { const u = res.locals.authUser as AuthUser | undefined; return u ? { id: u.id } : null; },
});
// Sender / reminder / re-attach worker. BALE_WORKER=0 turns it off (tests, maintenance).
if (process.env.BALE_WORKER !== "0" && process.env.NODE_ENV !== "test") bale.worker.start();
export const baleInternalRouter = bale.internal;
export const baleRunnerSend = (req: Request, res: Response, h: { inScope: (a: any, customerId: number) => boolean }) => bale.runnerSend(req, res, h);
export default bale.staff;
