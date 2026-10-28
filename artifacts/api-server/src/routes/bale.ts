/** «حساب شخصی بله» routes (see lib/bale.ts): staff router behind the CRM session under /api; the internal inbound router
 * (sidecar → API, loopback + internal token) is mounted in app.ts outside /api; the runner hook is mounted by routes/assistants.ts. */
import path from "node:path";
import type { Request, Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb, databasePath } from "../lib/crm-db";
import { createBale, ensureBaleSchema } from "../lib/bale";
import { createHttpBaleSidecar } from "../lib/bale-sidecar-client";

ensureBaleSchema(crmDb);
const env = () => process.env;
const bale = createBale({
  db: crmDb, env,
  sidecar: createHttpBaleSidecar(() => ({ ...process.env, BALE_SIDECAR_URL: process.env.BALE_SIDECAR_URL || "http://127.0.0.1:18470" })),
  actor: (res: Response) => { const u = res.locals.authUser as AuthUser | undefined; return u ? { id: u.id } : null; },
  // «فایل طرح برای بله»: next to the DB, never inside the web root.
  planFilesDir: process.env.BALE_PLAN_FILES_DIR || path.join(path.dirname(path.resolve(databasePath)), "bale-plan-files"),
});
// Sender / reminder / re-attach worker. BALE_WORKER=0 turns it off (tests, maintenance).
if (process.env.BALE_WORKER !== "0" && process.env.NODE_ENV !== "test") bale.worker.start();
export const baleInternalRouter = bale.internal;
export const baleRunnerSend = (req: Request, res: Response, h: { inScope: (a: any, customerId: number) => boolean }) => bale.runnerSend(req, res, h);
export default bale.staff;
export const baleRunnerPlanFiles = (req: Request, res: Response) => bale.runnerPlanFiles(req, res);
type Scope = { inScope: (a: any, customerId: number) => boolean };
/** «پاسخ خودکار» runner routes (pair-locked; see lib/bale.ts). */
export function mountBaleAutoreplyRunner(runner: import("express").Router, h: Scope) {
  runner.post("/bale/auto-reply", (req, res) => bale.runnerAutoReply(req, res, h));
  runner.get("/bale/auto-reply/state", (req, res) => bale.runnerAutoReplyState(req, res));
  runner.post("/bale/ask-expert", (req, res) => bale.runnerAskExpert(req, res, h));   // AR30
  runner.get("/bale/learned", (req, res) => bale.runnerLearned(req, res));            // AR30
  runner.get("/bale/conversations/:customerId/messages", (req, res) => bale.runnerConversation(req, res, h));
  runner.get("/bale/status", (req, res) => bale.runnerStatus(req, res));          // BALE-STATUS-64 (read-only)
  runner.get("/bale/ar-chats", (req, res) => bale.runnerArChats(req, res));
  runner.get("/bale/ar-chats/:id/messages", (req, res) => bale.runnerArChats(req, res));
  runner.get("/customers/:id/documents", (req, res) => bale.runnerDocuments(req, res, h));
}
