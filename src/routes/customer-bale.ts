/** CRM + admin routes for the customer Bale bot. Never returns API keys in full. */
import type { IRouter, Request, Response } from "express";
import {
  CB_DEFAULT_DEEPSEEK_MODEL, CB_DEFAULT_OPENAI_MODEL, CB_FLAGS,
  CB_KB_CATEGORIES, CB_KB_SCOPES, CB_SHARED_BOT_NAME, cbAdminFlagOn, cbAnyFlagOn, cbCheckSign, cbClaimHandoff, cbFlagOn,
  cbDeleteSecret, cbHandoffOwnerId, cbIsFromBale, cbKbDelete, cbKbList, cbKbSetActive, cbKbUpsert, cbPreviewKb,
  cbOpenaiModel, cbDeepseekModel, cbOpenHandoff, cbOpenTasksForOwner, cbOpenUnassignedTasks,
  cbSecretMeta, cbSetSetting, cbSharedBot, cbStoreSecret, cbTestSecret, cbFilingView, ensureCustomerBaleSchema,
  cbClearSharedBotToken, cbSharedBotPublic, ensureSharedCustomerBot, getCbSignPath, lockDownOn, planLabelForCustomer,
} from "../lib/customer-bale";
import { AI_NO_KEY_CODE, AI_NO_KEY_MSG, AiMasterError, aiMasterStatus, aiSetEnabled, ensureAiMasterSchema } from "../lib/ai-master";
import { baleBotAad, baleBotHasKey, sealBotToken } from "../lib/bale-bot-crypto";
import { botById, botToken, isSharedCustomerBot } from "../lib/bale-bot";
import { bbCanManage, bbUser } from "../lib/bale-bot";
import { executeChanges, queryRow, queryRows } from "../lib/crm-db";

function me(res: Response) { return res.locals.bbUser as { id: number; role: string; salesperson_id?: number | null }; }
function fail(res: Response, code: number, err: string) { res.status(code).json({ error: err }); }

export function customerBotFlagsPayload() {
  return {
    tracking: cbFlagOn("tracking"),
    ai: cbFlagOn("ai"),
    filing: cbFlagOn("filing"),
    any: cbAnyFlagOn(),
    admin: cbAdminFlagOn(),
  };
}

export function attachCustomerBotToChat(chatId: number, ownerId: number, viewer: { id: number; role: string }) {
  if (!cbAnyFlagOn()) return null;
  ensureCustomerBaleSchema();
  const chat = queryRow<{ customer_id: number | null }>("SELECT customer_id FROM bale_bot_chats WHERE id=?", [chatId]);
  const assigned = cbHandoffOwnerId(chat?.customer_id ?? null, ownerId);
  const locked = lockDownOn() && viewer.id !== ownerId && viewer.id !== assigned && viewer.role !== "admin" && viewer.role !== "sales_manager";
  if (locked) return { restricted: true, flags: customerBotFlagsPayload() };
  const filing = cbFilingView(chatId);
  const handoff = cbOpenHandoff(chatId);
  const tasks = queryRows<any>(
    "SELECT id,kind,status,detail,created_at,application_id FROM customer_bale_tasks WHERE chat_row=? AND status='open' ORDER BY id DESC",
    [chatId],
  );
  return {
    restricted: false,
    flags: customerBotFlagsPayload(),
    filing,
    handoff: handoff ? {
      id: handoff.id,
      question: handoff.question,
      answer: handoff.answer,
      reason: handoff.reason,
      claimedBy: handoff.claimed_by,
      at: handoff.created_at,
    } : null,
    tasks,
  };
}

export function registerCustomerBaleRoutes(r: IRouter, opts: { kick: () => void }) {
  r.get("/bale-bot/customer-bot/me", (_req, res) => {
    ensureCustomerBaleSchema();
    res.json({ flags: customerBotFlagsPayload(), openaiModel: cbOpenaiModel(), deepseekModel: cbDeepseekModel() });
  });

  const requireAdminFeature = (res: Response) => {
    const u = me(res);
    if (!bbCanManage(u as any)) { fail(res, 403, "forbidden"); return null; }
    if (!cbAdminFlagOn()) { fail(res, 403, "admin_flag_off"); return null; }
    ensureCustomerBaleSchema();
    ensureSharedCustomerBot();
    return u;
  };

  r.get("/bale-bot/customer-bot/admin", (_req, res) => {
    if (!requireAdminFeature(res)) return;
    const shared = cbSharedBot();
    res.json({
      flags: customerBotFlagsPayload(),
      openai: { ...cbSecretMeta("openai"), model: cbOpenaiModel(), defaultModel: CB_DEFAULT_OPENAI_MODEL },
      deepseek: { ...cbSecretMeta("deepseek"), model: cbDeepseekModel(), defaultModel: CB_DEFAULT_DEEPSEEK_MODEL },
      kb: cbKbList(),
      scopes: CB_KB_SCOPES,
      categories: CB_KB_CATEGORIES,
      defaultScope: CB_KB_SCOPES[0],
      sharedBot: cbSharedBotPublic(shared),
      ai: aiMasterStatus(),
    });
  });

  r.get("/bale-bot/customer-bot/admin/ai", (_req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    ensureAiMasterSchema();
    res.json(aiMasterStatus());
  });

  r.patch("/bale-bot/customer-bot/admin/ai", (req: Request, res: Response) => {
    const u = requireAdminFeature(res);
    if (!u) return;
    const raw = req.body?.ai_enabled;
    const on = raw === true || raw === 1 || raw === "1" || raw === "true";
    const off = raw === false || raw === 0 || raw === "0" || raw === "false";
    if (!on && !off) return fail(res, 400, "invalid");
    try {
      res.json(aiSetEnabled(on, u.id));
    } catch (e) {
      if (e instanceof AiMasterError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      const message = e instanceof Error && e.message && !/\d{5,}/.test(e.message) ? e.message : "الان نمی‌شود هوش مصنوعی را عوض کرد.";
      res.status(500).json({ error: "save_failed", message });
    }
  });

  /* Shared «نفیس وام» bot token: sealed like expert bot tokens; never returned. No live Bale call here when a test hook is set. */
  r.post("/bale-bot/customer-bot/admin/shared-bot/token", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (token.length < 8) return fail(res, 400, "invalid");
    if (!baleBotHasKey(process.env)) return fail(res, 503, "key_missing");
    const id = ensureSharedCustomerBot();
    const sealed = sealBotToken(process.env, token, baleBotAad(id, 0));
    const at = new Date().toISOString();
    executeChanges(
      "UPDATE bale_bots SET token_ct=?, token_key_id=?, status='on', connected_at=?, last_error=NULL, updated_at=? WHERE id=?",
      [sealed.value, sealed.keyId, at, at, id],
    );
    res.json({ ok: true, sharedBot: cbSharedBotPublic() });
  });

  r.post("/bale-bot/customer-bot/admin/shared-bot/token/delete", (_req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    cbClearSharedBotToken();
    res.json({ ok: true, sharedBot: cbSharedBotPublic() });
  });

  r.post("/bale-bot/customer-bot/admin/secret", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const u = me(res);
    ensureCustomerBaleSchema();
    const kind = req.body?.kind === "deepseek" ? "deepseek" : req.body?.kind === "openai" ? "openai" : null;
    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    if (!kind || value.length < 8) return fail(res, 400, "invalid");
    cbStoreSecret(kind, value);
    if (typeof req.body?.model === "string" && req.body.model.trim()) {
      cbSetSetting(kind === "openai" ? "customer_bale.openai_model" : "customer_bale.deepseek_model", req.body.model.trim());
    }
    res.json({ ok: true, [kind]: cbSecretMeta(kind) });
  });

  r.post("/bale-bot/customer-bot/admin/secret/delete", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const kind = req.body?.kind === "deepseek" ? "deepseek" : req.body?.kind === "openai" ? "openai" : null;
    if (!kind) return fail(res, 400, "invalid");
    cbDeleteSecret(kind, me(res).id);
    res.json({ ok: true, [kind]: cbSecretMeta(kind), ai: aiMasterStatus() });
  });

  r.post("/bale-bot/customer-bot/admin/secret/test", async (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const kind = req.body?.kind === "deepseek" ? "deepseek" : req.body?.kind === "openai" ? "openai" : null;
    if (!kind) return fail(res, 400, "invalid");
    const out = await cbTestSecret(kind);
    res.json({ ok: out.ok, title: out.title, message: out.message, kind });
  });

  r.post("/bale-bot/customer-bot/admin/kb", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const u = me(res);
    const title = String(req.body?.title ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!title || !body) return fail(res, 400, "invalid");
    const id = cbKbUpsert(
      req.body?.id ? Number(req.body.id) : null,
      title,
      body,
      req.body?.active !== false,
      u.id,
      undefined,
      { category: req.body?.category ?? null, scope: req.body?.scope ?? null },
    );
    res.json({ ok: true, id, kb: cbKbList() });
  });

  r.post("/bale-bot/customer-bot/admin/kb/delete", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const id = Number(req.body?.id);
    if (!id) return fail(res, 400, "invalid");
    cbKbDelete(id);
    res.json({ ok: true, kb: cbKbList() });
  });

  r.post("/bale-bot/customer-bot/admin/kb/active", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const u = me(res);
    const id = Number(req.body?.id);
    if (!id) return fail(res, 400, "invalid");
    cbKbSetActive(id, req.body?.active !== false, u.id);
    res.json({ ok: true, kb: cbKbList() });
  });

  r.post("/bale-bot/customer-bot/admin/kb/preview", (req: Request, res: Response) => {
    if (!requireAdminFeature(res)) return;
    const question = String(req.body?.question ?? "").trim();
    if (!question) return fail(res, 400, "invalid");
    const botKind = req.body?.bot === "shared" ? { user_id: 0 } : req.body?.bot === "expert" ? { user_id: 2 } : null;
    const out = cbPreviewKb(question, botKind);
    res.json({ ok: out.ok, text: out.text });
  });

  r.post("/bale-bot/chats/:id/customer-bot/claim-handoff", (req, res) => {
    const u = me(res);
    ensureCustomerBaleSchema();
    const hid = Number(req.body?.id ?? req.params.id);
    const row = queryRow<any>("SELECT * FROM customer_bale_handoffs WHERE id=?", [hid]);
    if (!row) return fail(res, 404, "not_found");
    if (lockDownOn() && row.owner_id && row.owner_id !== u.id && u.role !== "admin") return fail(res, 403, "expert_lockdown");
    cbClaimHandoff(row.id, u.id);
    res.json({ ok: true });
  });

  r.get("/bale-bot/customer-bot/tasks", (_req, res) => {
    const u = me(res);
    ensureCustomerBaleSchema();
    const tasks = cbOpenTasksForOwner(u.id);
    if (u.role === "admin" || u.role === "sales_manager") {
      res.json({ tasks, unassigned: cbOpenUnassignedTasks() });
    } else res.json({ tasks });
  });

  /* Sign follow-up: calls the existing Emzami check-status (and reminder) path; never invents contract text. */
  r.post("/bale-bot/chats/:id/customer-bot/check-sign", async (req, res) => {
    const u = me(res);
    ensureCustomerBaleSchema();
    const chatId = Number(req.params.id);
    const f = cbFilingView(chatId);
    if (!f?.applicationId) return fail(res, 404, "no_contract");
    if (lockDownOn()) {
      const chat = queryRow<{ bot_id: number; customer_id: number | null }>("SELECT c.bot_id, c.customer_id FROM bale_bot_chats c WHERE c.id=?", [chatId]);
      const bot = chat ? queryRow<{ user_id: number }>("SELECT user_id FROM bale_bots WHERE id=?", [chat.bot_id]) : null;
      const assigned = cbHandoffOwnerId(chat?.customer_id ?? null, bot?.user_id ?? null);
      if (bot && bot.user_id !== u.id && assigned !== u.id && u.role !== "admin") return fail(res, 403, "expert_lockdown");
    }
    try {
      const out = await cbCheckSign(chatId, getCbSignPath());
      res.json({ ok: true, status: out.status, applicationId: out.applicationId, generationId: out.generationId, path: out.path, reminded: out.reminded });
    } catch (e: any) {
      const code = String(e?.message ?? "error");
      if (code === "no_contract") return fail(res, 404, "no_contract");
      if (code === "no_sign_path") return fail(res, 503, "sign_path_unavailable");
      return fail(res, 502, "provider_status_failed");
    }
  });

  void opts;
}

export function fromBaleFlag(applicationId: number): boolean {
  try {
    const has = queryRow<{ n: number }>("SELECT 1 n FROM sqlite_master WHERE type='table' AND name='customer_bale_apps'");
    if (!has) return false;
    return cbIsFromBale(applicationId);
  } catch { return false; }
}

export function publicPlanLabel(bankName: string | null | undefined) {
  return planLabelForCustomer(bankName);
}
