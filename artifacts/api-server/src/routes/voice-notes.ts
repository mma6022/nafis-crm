/** crm-voice-notes routes (see lib/voice-notes-core.ts). STT_ENABLED defaults OFF → transcribe 404, config {enabled:false}. */
import type { Response } from "express";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { createVoiceNotesRouter, type FetchLike } from "../lib/voice-notes-core";

const router = createVoiceNotesRouter({
  db: crmDb,
  env: () => process.env,
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  actor: (res: Response) => {
    const u = res.locals.authUser as AuthUser | undefined;
    return u ? { id: u.id, role: u.role, fullName: u.fullName ?? u.username } : null;
  },
});
export default router;
