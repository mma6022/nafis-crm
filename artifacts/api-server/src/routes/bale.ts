/** «حساب شخصی بله» routes, piece 1a (see lib/bale.ts). Behind the CRM session under /api. */
import type { Response } from "express";
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
export default bale.staff;
