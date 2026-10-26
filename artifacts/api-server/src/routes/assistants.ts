/** «دستیار هوشمند» routes (see lib/assistants.ts). The staff router sits behind the CRM session under /api; the runner
 * router is mounted in app.ts before the global JSON parser with its own 256 KB limit and Bearer token. */
import type { Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { createAssistants, ensureAssistantSchema } from "../lib/assistants";
import { suggestionsFor, todayCounts } from "../lib/sales-assist";
import { consultProfile } from "../lib/consult-profile";
import { activeSiteLeads, siteLeadHistory } from "../lib/site-leads";
import { baleRunnerSend } from "./bale";
import { startPageUsagePrune } from "../lib/page-usage";

ensureAssistantSchema(crmDb);
startPageUsagePrune(crmDb); // v10: daily prune of page_usage_events older than 90 days (that table only)
const assistants = createAssistants({
  db: crmDb,
  // v7: the runner reuses the exact CRM read logic (box of 3, «امروز» counters, «اطلاعات مشاوره», site-lead contact time).
  // suggestionsFor is a pure read; recordImpressions is deliberately NOT called for the assistant.
  sales: { suggestions: (sp, now) => suggestionsFor(sp, now, 3), today: (sp, now) => todayCounts(sp, now), consultProfile, siteLeadHistory,
    activeSiteLeads: (now) => activeSiteLeads(undefined, now) },
  actor: (res: Response) => {
    const u = res.locals.authUser as AuthUser | undefined;
    return u ? { id: u.id, role: u.role, salespersonId: u.salespersonId ?? null, name: (u as any).fullName ?? u.username } : null;
  },
  // «حساب شخصی بله» 1b: the expert's own sales assistant may queue / draft a Bale message (all checks in lib/bale-outbox.ts).
  extendRunner: (runner, h) => { runner.post("/bale/send", (req, res) => baleRunnerSend(req, res, h)); },
});
export const assistantRunnerRouter = assistants.runner;
export default assistants.staff;
