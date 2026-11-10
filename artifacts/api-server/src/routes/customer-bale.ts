/** CRM + admin routes for the customer Bale bot. Never returns API keys in full. */
import type { IRouter, Request, Response } from "express";
import {
  CB_DEFAULT_DEEPSEEK_MODEL, CB_DEFAULT_OPENAI_MODEL, CB_FLAGS,
  cbAnyFlagOn, cbClaimHandoff, cbFlagOn, cbIsFromBale, cbKbList, cbKbUpsert,
  cbOpenaiModel, cbDeepseekModel, cbOpenHandoff, cbOpenTasksForOwner,
  cbSecretMeta, cbSetSetting, cbStoreSecret, cbFilingView, ensureCustomerBaleSchema,
  lockDownOn, planLabelForCustomer,
} from "../lib/customer-bale";
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
  };
}

export function attachCustomerBotToChat(chatId: number, ownerId: number, viewer: { id: number; role: string }) {
  if (!cbAnyFlagOn()) return null;
  ensureCustomerBaleSchema();
  const locked = lockDownOn() && viewer.id !== ownerId && viewer.role !== "admin" && viewer.role !== "sales_manager";
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

  r.get("/bale-bot/customer-bot/admin", (_req, res) => {
    const u = me(res);
    if (!bbCanManage(u as any)) return fail(res, 403, "forbidden");
    ensureCustomerBaleSchema();
    res.json({
      flags: customerBotFlagsPayload(),
      openai: { ...cbSecretMeta("openai"), model: cbOpenaiModel(), defaultModel: CB_DEFAULT_OPENAI_MODEL },
      deepseek: { ...cbSecretMeta("deepseek"), model: cbDeepseekModel(), defaultModel: CB_DEFAULT_DEEPSEEK_MODEL },
      kb: cbKbList(),
    });
  });

  r.post("/bale-bot/customer-bot/admin/secret", (req: Request, res: Response) => {
    const u = me(res);
    if (!bbCanManage(u as any)) return fail(res, 403, "forbidden");
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

  r.post("/bale-bot/customer-bot/admin/kb", (req: Request, res: Response) => {
    const u = me(res);
    if (!bbCanManage(u as any)) return fail(res, 403, "forbidden");
    ensureCustomerBaleSchema();
    const title = String(req.body?.title ?? "").trim();
    const body = String(req.body?.body ?? "").trim();
    if (!title || !body) return fail(res, 400, "invalid");
    const id = cbKbUpsert(req.body?.id ? Number(req.body.id) : null, title, body, req.body?.active !== false, u.id);
    res.json({ ok: true, id, kb: cbKbList() });
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
    res.json({ tasks: cbOpenTasksForOwner(u.id) });
  });

  /* Sign follow-up: only polls the existing check-status hook; never invents contract text. */
  r.post("/bale-bot/chats/:id/customer-bot/check-sign", (req, res) => {
    const u = me(res);
    ensureCustomerBaleSchema();
    const chatId = Number(req.params.id);
    const f = cbFilingView(chatId);
    if (!f?.applicationId) return fail(res, 404, "no_contract");
    if (lockDownOn()) {
      const chat = queryRow<{ bot_id: number }>("SELECT c.bot_id FROM bale_bot_chats c WHERE c.id=?", [chatId]);
      const bot = chat ? queryRow<{ user_id: number }>("SELECT user_id FROM bale_bots WHERE id=?", [chat.bot_id]) : null;
      if (bot && bot.user_id !== u.id && u.role !== "admin") return fail(res, 403, "expert_lockdown");
    }
    res.json({ ok: true, status: f.contractStatus ?? "pending", applicationId: f.applicationId, path: "check-status" });
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
