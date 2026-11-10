/** CRM routes for bale-sign-reminder v1.0. Flag OFF → 404, no schema side effects. */
import type { IRouter, Request, Response } from "express";
import {
  SR_TEXTS, ensureSignReminderSchema, srChatView, srFlagOn, srPreview, srSend,
} from "../lib/bale-sign-reminder";

function me(res: Response) {
  return res.locals.bbUser as { id: number; role: string; salesperson_id?: number | null };
}
function fail(res: Response, code: number, err: string, message?: string) {
  res.status(code).json({ error: err, ...(message ? { message } : {}) });
}

export function registerSignReminderRoutes(r: IRouter, hooks?: { kick?: () => void }) {
  const requireFlag = (res: Response) => {
    if (!srFlagOn()) { fail(res, 404, "flag_off"); return false; }
    ensureSignReminderSchema();
    return true;
  };

  r.get("/bale-bot/chats/:id/sign-reminder", async (req: Request, res: Response) => {
    if (!requireFlag(res)) return;
    const chatId = Number(req.params.id);
    if (!Number.isSafeInteger(chatId) || chatId < 1) return fail(res, 404, "not_found");
    const view = await srChatView(chatId, me(res));
    if (!view) return fail(res, 404, "flag_off");
    res.json({ ok: true, reminder: view });
  });

  r.post("/bale-bot/chats/:id/sign-reminder/preview", async (req: Request, res: Response) => {
    if (!requireFlag(res)) return;
    const chatId = Number(req.params.id);
    if (!Number.isSafeInteger(chatId) || chatId < 1) return fail(res, 404, "not_found");
    const out = await srPreview(chatId, me(res));
    if (!out.ok) return fail(res, out.status, out.error, out.message);
    res.json(out);
  });

  r.post("/bale-bot/chats/:id/sign-reminder", async (req: Request, res: Response) => {
    if (!requireFlag(res)) return;
    const chatId = Number(req.params.id);
    if (!Number.isSafeInteger(chatId) || chatId < 1) return fail(res, 404, "not_found");
    const out = await srSend(chatId, me(res));
    if (!out.ok) return fail(res, out.status, out.error, out.message);
    if (!out.idempotent) hooks?.kick?.();
    res.json({
      ok: true,
      state: out.state,
      lastSentAt: out.lastSentAt,
      lastSentFa: out.lastSentFa,
      lockUntil: out.lockUntil,
      lockUntilFa: out.lockUntilFa,
      messageId: out.messageId,
      idempotent: !!out.idempotent,
      banner: SR_TEXTS.sentBanner,
    });
  });
}
