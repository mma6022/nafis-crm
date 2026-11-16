import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  acceptInstagramMessage,
  claimManychatFlowReply,
  claimManychatFlowReplyItem,
  instagramFlowRequestId,
} from "../lib/instagram";
import { manychatConfig, manychatSenderId, validManychatSecret } from "../lib/manychat";

const router: IRouter = Router();

// Manychat's Default Reply / External Request action sends one request per text DM.
// This endpoint is public to the provider, but not to unauthenticated callers.
router.post("/inbound", (req, res): void => {
  const config = manychatConfig();
  if (!config.configured) {
    res.status(503).json({ error: "Manychat bridge is not configured" });
    return;
  }
  if (!validManychatSecret(req.header("x-crm-bridge-secret"), config.bridgeSecret)) {
    res.sendStatus(401);
    return;
  }
  const { subscriberId, text, messageId } = req.body ?? {};
  if (
    (typeof subscriberId !== "string" && typeof subscriberId !== "number") ||
    !/^[1-9]\d{0,15}$/.test(String(subscriberId)) ||
    !Number.isSafeInteger(Number(subscriberId)) ||
    typeof text !== "string" || !text.trim() || text.length > 10000 ||
    (messageId !== undefined && (typeof messageId !== "string" || messageId.length > 200))
  ) {
    res.status(400).json({ error: "Expected subscriberId, text and optional messageId" });
    return;
  }
  // Without a provider message ID, do not discard a legitimate repeated message:
  // an identical text sent twice is still two DMs. A stable ID, when available,
  // makes provider retries idempotent.
  const senderId = manychatSenderId(config.accountId, String(subscriberId));
  const mid = messageId
    ? `mc:${config.accountId}:${String(subscriberId)}:${messageId}`
    : `mc:${config.accountId}:${String(subscriberId)}:${randomUUID()}`;
  try {
    const outcome = acceptInstagramMessage({
      senderId,
      recipientId: config.recipientId,
      mid,
      text,
      source: "manychat",
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(config.mode === "flow"
      ? { status: outcome, requestId: instagramFlowRequestId(mid), ready: "no", reply: "" }
      : { status: outcome });
  } catch {
    res.status(500).json({ error: "Unable to store Instagram message" });
  }
});

// A second External Request runs after Manychat's one-minute Smart Delay.
// A reply is handed to the Flow once, never asserted as delivered to Instagram.
router.post("/reply", (req, res): void => {
  const config = manychatConfig();
  if (!config.configured || config.mode !== "flow") {
    res.status(503).json({ error: "Manychat Flow bridge is not configured" });
    return;
  }
  if (!validManychatSecret(req.header("x-crm-bridge-secret"), config.bridgeSecret)) {
    res.sendStatus(401);
    return;
  }
  const { subscriberId, requestId } = req.body ?? {};
  if ((typeof subscriberId !== "string" && typeof subscriberId !== "number") ||
    !/^[1-9]\d{0,15}$/.test(String(subscriberId)) ||
    !Number.isSafeInteger(Number(subscriberId)) ||
    typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId)) {
    res.status(400).json({ error: "Expected subscriberId and requestId" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(claimManychatFlowReply(config.accountId, String(subscriberId), requestId));
});

// Multi-message Flow replies are consumed one item at a time. The caller must
// pass the exact ordinal returned by the previous response; a repeated claim
// is rejected rather than replaying a message after an ambiguous Flow outcome.
router.post("/reply/next", (req, res): void => {
  const config = manychatConfig();
  if (!config.configured || config.mode !== "flow") {
    res.status(503).json({ error: "Manychat Flow bridge is not configured" });
    return;
  }
  if (!validManychatSecret(req.header("x-crm-bridge-secret"), config.bridgeSecret)) {
    res.sendStatus(401);
    return;
  }
  const { subscriberId, requestId, ordinal } = req.body ?? {};
  if ((typeof subscriberId !== "string" && typeof subscriberId !== "number") ||
    !/^[1-9]\d{0,15}$/.test(String(subscriberId)) ||
    !Number.isSafeInteger(Number(subscriberId)) ||
    typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId) ||
    !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 10) {
    res.status(400).json({ error: "Expected subscriberId, requestId and non-negative ordinal" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(claimManychatFlowReplyItem(config.accountId, String(subscriberId), requestId, ordinal));
});

export default router;