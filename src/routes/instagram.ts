import { Router, type IRouter, type Response } from "express";
import { executeChanges, queryRow, queryRows, runImmediateTransaction } from "../lib/crm-db";
import {
  disconnectInstagram,
} from "../lib/instagram-oauth";
import {
  instagramThreadData,
  normalizeInstagramPhone,
  pauseInstagramThread,
} from "../lib/instagram";
import type { AuthUser } from "../lib/auth";
import { manychatConfig, saveManychatConnection, saveManychatFlowConnection, setManychatAutoreply, setManychatReplyMode, storedManychatConnection, verifyManychatToken } from "../lib/manychat";
import { insertCustomerRecord } from "../lib/customer-create";
import { notifyNewCustomer } from "../lib/customer-notifications";

const router: IRouter = Router();

function requireInstagramStaff(res: Response): boolean {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (user.role !== "admin" && user.role !== "registrar") {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function requireInstagramAdmin(res: Response): boolean {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Only administrators may manage Instagram connection" });
    return false;
  }
  return true;
}

router.get("/instagram/status", (_req, res): void => {
  if (!requireInstagramStaff(res)) return;
  const provider = manychatConfig();
  const hasStoredLeads = Boolean(queryRow<{ has_leads: number }>(
    "SELECT EXISTS(SELECT 1 FROM instagram_threads) AS has_leads",
  )?.has_leads);
  const providerLeads = provider.accountId && /^[A-Za-z0-9_-]{3,80}$/.test(provider.accountId)
    ? Boolean(queryRow<{ has_leads: number }>(
      `SELECT EXISTS(SELECT 1 FROM instagram_messages m
         JOIN instagram_threads t ON t.id=m.thread_id
         WHERE substr(t.sender_id,1,length(?))=? AND m.direction='inbound' AND m.sent_at>=?) AS has_leads`,
      [`mc:${provider.accountId}:`, `mc:${provider.accountId}:`, provider.configuredAt ?? ""],
    )?.has_leads)
    : false;
  const genericStatus = {
    configured: provider.configured,
    enabled: provider.enabled,
    connected: providerLeads,
    hasStoredLeads,
    replyMode: provider.replyMode,
  };
  if ((res.locals.authUser as AuthUser).role !== "admin") {
    res.json(genericStatus);
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...genericStatus, accountId: provider.accountId || null,
    source: provider.source, mode: provider.mode,
    verifiedAt: provider.verifiedAt, credentialsUnreadable: provider.credentialsUnreadable });
});

router.post("/instagram/manychat/reply-mode", (req, res): void => {
  if (!requireInstagramAdmin(res)) return;
  res.setHeader("Cache-Control", "no-store");
  const replyMode = req.body?.replyMode;
  if (replyMode !== "intake" && replyMode !== "ai") {
    res.status(400).json({ error: "invalid_reply_mode" });
    return;
  }
  const result = setManychatReplyMode(replyMode);
  if (result === "busy") {
    res.status(409).json({ error: "send_in_progress" });
    return;
  }
  res.json({ replyMode });
});

router.post("/instagram/manychat/flow-config", (req, res): void => {
  if (!requireInstagramAdmin(res)) return;
  res.setHeader("Cache-Control", "no-store");
  const { bridgeSecret } = req.body ?? {};
  if (typeof bridgeSecret !== "string" || bridgeSecret.length < 24 || bridgeSecret.length > 512) {
    res.status(400).json({ error: "invalid_credentials_format" }); return;
  }
  try {
    saveManychatFlowConnection(bridgeSecret);
    res.json({ saved: true, mode: "flow", inboundVerified: false, enabled: false });
  } catch (error) {
    res.status(error instanceof Error && error.message === "MANYCHAT_SEND_IN_PROGRESS" ? 409 : 503)
      .json({ error: error instanceof Error && error.message === "MANYCHAT_SEND_IN_PROGRESS"
        ? "send_in_progress" : "credential_storage_unavailable" });
  }
});

// Credentials are supplied only by an authenticated administrator over HTTPS.
// Provider errors and stored credentials are never included in API responses.
router.post("/instagram/manychat/config", async (req, res): Promise<void> => {
  if (!requireInstagramAdmin(res)) return;
  res.setHeader("Cache-Control", "no-store");
  const { apiToken, bridgeSecret } = req.body ?? {};
  if (typeof apiToken !== "string" || apiToken.trim().length < 16 || apiToken.length > 4096
    || typeof bridgeSecret !== "string" || bridgeSecret.length < 24 || bridgeSecret.length > 512) {
    res.status(400).json({ error: "invalid_credentials_format" });
    return;
  }
  const result = await verifyManychatToken(apiToken.trim());
  if (!result.ok || !result.pageId) {
    res.status(result.reason === "provider_unavailable" || result.reason === "rate_limited" ? 503 : 400)
      .json({ error: result.reason ?? "provider_rejected" });
    return;
  }
  try {
    saveManychatConnection(result.pageId, apiToken.trim(), bridgeSecret);
    res.json({ saved: true, tokenVerified: true, inboundVerified: false, enabled: false });
  } catch (error) {
    res.status(error instanceof Error && error.message === "MANYCHAT_SEND_IN_PROGRESS" ? 409 : 503)
      .json({ error: error instanceof Error && error.message === "MANYCHAT_SEND_IN_PROGRESS"
        ? "send_in_progress" : "credential_storage_unavailable" });
  }
});

router.post("/instagram/manychat/check", async (_req, res): Promise<void> => {
  if (!requireInstagramAdmin(res)) return;
  res.setHeader("Cache-Control", "no-store");
  const config = manychatConfig();
  if (!config.configured) { res.status(409).json({ error: "connection_not_configured" }); return; }
  if (config.mode === "flow") {
    res.json({ bridgeConfigured: true, inboundVerified: Boolean(queryRow<{ found: number }>(
      `SELECT EXISTS(SELECT 1 FROM instagram_messages m JOIN instagram_threads t ON t.id=m.thread_id
         WHERE t.sender_id LIKE ? AND m.direction='inbound' AND m.sent_at>=?) AS found`,
      [`mc:${config.accountId}:%`, config.configuredAt ?? ""],
    )?.found) });
    return;
  }
  const result = await verifyManychatToken(config.apiToken);
  if (!result.ok || !result.pageId) {
    res.status(result.reason === "provider_unavailable" || result.reason === "rate_limited" ? 503 : 400)
      .json({ error: result.reason ?? "provider_rejected" });
    return;
  }
  const stored = storedManychatConnection();
  if (stored && result.pageId !== stored.provider_page_id) {
    res.status(409).json({ error: "account_changed" });
    return;
  }
  if (stored) executeChanges("UPDATE manychat_connections SET verified_at=? WHERE id=1", [new Date().toISOString()]);
  res.json({ tokenVerified: true, inboundVerified: Boolean(queryRow<{ found: number }>(
    `SELECT EXISTS(SELECT 1 FROM instagram_messages m JOIN instagram_threads t ON t.id=m.thread_id
       WHERE t.sender_id LIKE ? AND m.direction='inbound' AND m.sent_at>=?) AS found`,
    [`mc:${config.accountId}:%`, config.configuredAt ?? ""],
  )?.found) });
});

router.post("/instagram/manychat/autoreply", async (req, res): Promise<void> => {
  if (!requireInstagramAdmin(res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (typeof req.body?.enabled !== "boolean") { res.status(400).json({ error: "invalid_enabled" }); return; }
  if (!req.body.enabled) {
    const changed = setManychatAutoreply(false);
    if (changed !== "updated") { res.status(409).json({ error: changed === "busy" ? "send_in_progress" : "connection_not_configured" }); return; }
    res.json({ enabled: false }); return;
  }
  const config = manychatConfig();
  const stored = storedManychatConnection();
  if (!config.configured || !stored) { res.status(409).json({ error: "connection_not_configured" }); return; }
  const inbound = queryRow<{ found: number }>(
    `SELECT EXISTS(SELECT 1 FROM instagram_messages m JOIN instagram_threads t ON t.id=m.thread_id
       WHERE t.sender_id LIKE ? AND m.direction='inbound' AND m.sent_at>=?) AS found`,
    [`mc:${config.accountId}:%`, stored.updated_at],
  )?.found;
  if (!inbound) { res.status(409).json({ error: "test_dm_required" }); return; }
  if (req.body.confirmedLiveDelivery !== true) {
    res.status(400).json({ error: "live_confirmation_required" }); return;
  }
  if (config.mode === "api") {
    const result = await verifyManychatToken(config.apiToken);
    if (!result.ok || result.pageId !== stored.provider_page_id) {
      res.status(result.reason === "provider_unavailable" || result.reason === "rate_limited" ? 503 : 409)
        .json({ error: result.reason ?? "account_changed" });
      return;
    }
  }
  const changed = setManychatAutoreply(true, stored.generation);
  if (changed !== "updated") {
    res.status(409).json({ error: changed === "busy" ? "send_in_progress" : "connection_changed" }); return;
  }
  res.json({ enabled: true });
});

router.post("/instagram/connect/start", (_req, res): void => {
  if (!requireInstagramAdmin(res)) return;
  res.status(410).json({ error: "Direct Meta app setup is disabled; connect Instagram via Manychat." });
});

router.get("/instagram/oauth/callback", (_req, res): void => {
  res.status(410).json({ error: "Direct Meta app setup is disabled." });
});

router.post("/instagram/connect/disconnect", (_req, res): void => {
  if (!requireInstagramAdmin(res)) return;
  disconnectInstagram();
  res.json({ connected: false });
});

router.get("/instagram/threads", (_req, res): void => {
  if (!requireInstagramStaff(res)) return;
  const threads = queryRows<Record<string, unknown>>(
    `SELECT t.*,
       (SELECT m.content FROM instagram_messages m WHERE m.thread_id=t.id
        ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_message
     FROM instagram_threads t
     ORDER BY t.last_message_at DESC, t.id DESC LIMIT 500`,
  );
  res.json(threads.map(instagramThreadData));
});

router.post("/instagram/threads/:id/convert", (req, res): void => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) {
    res.status(401).json({ code: "unauthorized", error: "Unauthorized" });
    return;
  }
  if (user.role !== "admin" && user.role !== "registrar") {
    res.status(403).json({ code: "forbidden", error: "Only administrators or registrars may convert leads" });
    return;
  }
  if (user.role !== "admin" && !user.permissions.includes("customers.create")) {
    res.status(403).json({ code: "forbidden", error: "Customer creation permission is required" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const threadId = Number(rawId);
  const body = req.body;
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    res.status(400).json({ code: "invalid_thread_id", error: "Invalid Instagram thread id" });
    return;
  }
  if (
    body?.reviewed !== true ||
    typeof body.name !== "string" ||
    typeof body.phone !== "string" ||
    typeof body.request !== "string"
  ) {
    res.status(400).json({ code: "review_confirmation_required", error: "Reviewed name, phone, request, and reviewed=true are required" });
    return;
  }
  const name = body.name.normalize("NFC").replace(/\s+/g, " ").trim();
  const nameWords = name.split(" ");
  if (
    name.length > 150 ||
    nameWords.length < 2 ||
    nameWords.length > 5 ||
    nameWords.some((word: string) => word.length < 2 || !/^[\p{L}‌-]+$/u.test(word))
  ) {
    res.status(400).json({ code: "invalid_review", error: "Enter a valid full name" });
    return;
  }
  if (/[^۰-۹٠-٩0-9+\s().-]/u.test(body.phone)) {
    res.status(400).json({ code: "invalid_review", error: "Enter only a mobile number" });
    return;
  }
  const phone = normalizeInstagramPhone(body.phone);
  if (!phone) {
    res.status(400).json({ code: "invalid_review", error: "Enter a valid Iranian mobile number" });
    return;
  }
  const request = body.request.normalize("NFC").replace(/\s+/g, " ").trim();
  const requestContent = request.replace(/^(?:(?:سلام(?:\s+و\s+وقت\s+بخیر)?|درود|وقت\s+بخیر|خسته\s+نباشید)[،،\s]*)+/iu, "").trim();
  const requestLetters = requestContent.replace(/[^\p{L}]/gu, "");
  if (
    request.length > 2000 ||
    requestLetters.length < 6 ||
    /^(?:ممنون|مرسی|باشه|اوکی|بله|خیر|نه|خوبم|خوب\s*هستم)$/iu.test(requestContent) ||
    /(?:\bOTP\b|رمز\s*(?:یکبار\s*مصرف|ورود|تایید)|کد\s*(?:تایید|ورود|اعتبارسنجی|پیگیری))/iu.test(requestContent)
  ) {
    res.status(400).json({ code: "invalid_review", error: "Enter a meaningful request" });
    return;
  }

  let result: { customerId: number; alreadyConverted?: true };
  try {
    result = runImmediateTransaction(() => {
      const thread = queryRow<{
        id: number;
        name: string | null;
        phone: string | null;
        request: string | null;
        customer_id: number | null;
        status: string;
      }>(
        "SELECT id,name,phone,request,customer_id,status FROM instagram_threads WHERE id=?",
        [threadId],
      );
      if (!thread) throw new Error("INSTAGRAM_THREAD_NOT_FOUND");
      if (thread.customer_id != null) {
        if (thread.status !== "converted") {
          executeChanges(
            "UPDATE instagram_threads SET status='converted',updated_at=? WHERE id=? AND customer_id IS NOT NULL",
            [new Date().toISOString(), threadId],
          );
        }
        return { customerId: Number(thread.customer_id), alreadyConverted: true as const };
      }
      if (thread.status === "converted") {
        throw new Error("INSTAGRAM_ALREADY_CONVERTED");
      }
      // Staff may correct extracted values, but a lead with any missing field
      // remains incomplete and must be completed through the DM conversation.
      if (!thread.name?.trim() || !thread.phone?.trim() || !thread.request?.trim()) {
        throw new Error("INSTAGRAM_INCOMPLETE_LEAD");
      }
      const duplicate = queryRow<{ id: number }>(
        "SELECT id FROM customers WHERE crm_customer_mobile_key(phone)=? ORDER BY id LIMIT 1",
        [phone],
      );
      if (duplicate) throw new Error("INSTAGRAM_DUPLICATE_MOBILE");
      const program = queryRow<{ id: number }>(
        "SELECT id FROM allocation_programs WHERE active=1 AND is_default=1 ORDER BY id LIMIT 1",
      );
      if (!program) throw new Error("ALLOCATION_PROGRAM_UNAVAILABLE");

      const customerId = insertCustomerRecord({
        name,
        phone,
        description: `درخواست ثبت‌شده از دایرکت اینستاگرام: ${request}`,
        allocationProgramId: Number(program.id),
        status: "in_progress",
        registeredByUserId: user.id,
        registrationSource: "instagram",
      });
      const updated = executeChanges(
        `UPDATE instagram_threads
            SET name=?,phone=?,request=?,customer_id=?,status='converted',
                reviewed_by_user_id=?,reviewed_at=?,updated_at=?,error=NULL
          WHERE id=? AND customer_id IS NULL AND status<>'converted'`,
        [name, phone, request, customerId, user.id, new Date().toISOString(), new Date().toISOString(), threadId],
      );
      if (updated !== 1) throw new Error("INSTAGRAM_ALREADY_CONVERTED");
      return { customerId };
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "INSTAGRAM_THREAD_NOT_FOUND") {
      res.status(404).json({ code: "thread_not_found", error: "Instagram thread not found" });
      return;
    }
    if (code === "INSTAGRAM_INCOMPLETE_LEAD") {
      res.status(409).json({ code: "incomplete_lead", error: "Complete all lead fields before conversion" });
      return;
    }
    if (code === "INSTAGRAM_DUPLICATE_MOBILE") {
      res.status(409).json({ code: "duplicate_mobile", error: "A CRM customer already uses this mobile number" });
      return;
    }
    if (code === "ALLOCATION_PROGRAM_UNAVAILABLE") {
      res.status(409).json({ code: "allocation_program_unavailable", error: "The default allocation program has no active salespersons" });
      return;
    }
    if (code === "INSTAGRAM_ALREADY_CONVERTED") {
      res.status(409).json({ code: "already_converted", error: "This Instagram lead is already converted" });
      return;
    }
    throw error;
  }

  if (result.alreadyConverted) {
    res.status(200).json({ customerId: result.customerId, alreadyConverted: true });
    return;
  }
  res.status(201).json({ customerId: result.customerId });
  void notifyNewCustomer(result.customerId);
});

router.get("/instagram/threads/:id/messages", (req, res): void => {
  if (!requireInstagramStaff(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid thread id" });
    return;
  }
  if (!queryRow("SELECT id FROM instagram_threads WHERE id=?", [id])) {
    res.status(404).json({ error: "Instagram thread not found" });
    return;
  }
  const messages = queryRows<Record<string, unknown>>(
    `SELECT id, direction, content AS message, sent_at AS sentAt
       FROM instagram_messages WHERE thread_id=? ORDER BY sent_at, id LIMIT 500`,
    [id],
  );
  res.json(messages);
});

router.post("/instagram/threads/:id/pause", (req, res): void => {
  if (!requireInstagramStaff(res)) return;
  if ((res.locals.authUser as AuthUser).role !== "admin") {
    res.status(403).json({ error: "Only administrators may change Instagram automation" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof req.body?.paused !== "boolean") {
    res.status(400).json({ error: "Expected a valid thread id and boolean paused value" });
    return;
  }
  if (!pauseInstagramThread(id, req.body.paused)) {
    res.status(404).json({ error: "Instagram thread not found" });
    return;
  }
  res.json({ id, paused: req.body.paused });
});

export default router;