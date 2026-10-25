/** «دستیار هوشمند» routes (see lib/assistants.ts). The staff router sits behind the CRM session under /api; the runner
 * router is mounted in app.ts before the global JSON parser with its own 256 KB limit and Bearer token. */
import type { Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { createAssistants, ensureAssistantSchema } from "../lib/assistants";

ensureAssistantSchema(crmDb);
const assistants = createAssistants({
  db: crmDb,
  actor: (res: Response) => {
    const u = res.locals.authUser as AuthUser | undefined;
    return u ? { id: u.id, role: u.role, salespersonId: u.salespersonId ?? null, name: (u as any).fullName ?? u.username } : null;
  },
});
export const assistantRunnerRouter = assistants.runner;
export default assistants.staff;
