/** «دستیار هوشمند» routes (see lib/assistants.ts). The staff router sits behind the CRM session under /api; the runner
 * router is mounted in app.ts before the global JSON parser with its own 256 KB limit and Bearer token. */
import type { Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { createAssistants, ensureAssistantSchema } from "../lib/assistants";
import { suggestionsFor, todayCounts } from "../lib/sales-assist";
import { consultProfile } from "../lib/consult-profile";
import { siteLeadHistory } from "../lib/site-leads";

ensureAssistantSchema(crmDb);
const assistants = createAssistants({
  db: crmDb,
  // v7: the runner reuses the exact CRM read logic (box of 3, «امروز» counters, «اطلاعات مشاوره», site-lead contact time).
  // suggestionsFor is a pure read; recordImpressions is deliberately NOT called for the assistant.
  sales: { suggestions: (sp, now) => suggestionsFor(sp, now, 3), today: (sp, now) => todayCounts(sp, now), consultProfile, siteLeadHistory },
  actor: (res: Response) => {
    const u = res.locals.authUser as AuthUser | undefined;
    return u ? { id: u.id, role: u.role, salespersonId: u.salespersonId ?? null, name: (u as any).fullName ?? u.username } : null;
  },
});
export const assistantRunnerRouter = assistants.runner;
export default assistants.staff;
