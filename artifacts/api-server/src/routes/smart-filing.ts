/** «ثبت هوشمند» routes (see lib/smart-filing.ts). Admin/expert router sits behind the CRM session; the runner router is
 * mounted in app.ts before the global 100 KB JSON parser with its own 2 MB limit and Bearer token. */
import path from "node:path";
import type { Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb, databasePath } from "../lib/crm-db";
import { createSmartFiling, ensureSmartFilingSchema } from "../lib/smart-filing";

ensureSmartFilingSchema(crmDb as any);
const dataDir = path.dirname(databasePath);
const sf = createSmartFiling({
  db: crmDb as any,
  env: () => process.env,
  filesRoot: path.join(dataDir, "smart-filing-files"),
  docRoots: [path.join(dataDir, "loan-application-files"), path.join(dataDir, "customer-identity-documents")],
  actor: (res: Response) => {
    const u = res.locals.authUser as AuthUser | undefined;
    return u ? { id: u.id, role: u.role, salespersonId: u.salespersonId ?? null, name: (u as any).fullName ?? u.username } : null;
  },
});
export const smartFilingRunnerRouter = sf.runner;
export default sf.admin;
