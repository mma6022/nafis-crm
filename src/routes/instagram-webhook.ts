import { Router, type IRouter } from "express";
import {
  acceptInstagramMessage,
  instagramConfig,
  verifyInstagramSignature,
} from "../lib/instagram";

const router: IRouter = Router();

router.get("/", (req, res): void => {
  const config = instagramConfig();
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    config.verifyToken &&
    token === config.verifyToken &&
    typeof challenge === "string"
  ) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.sendStatus(403);
});

router.post("/", (req, res): void => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyInstagramSignature(body, req.header("x-hub-signature-256"))) {
    res.sendStatus(401);
    return;
  }
  let payload: {
    object?: string;
    entry?: Array<{
      id?: string;
      messaging?: Array<{
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number;
        message?: { mid?: string; text?: string; is_echo?: boolean };
      }>;
    }>;
  };
  try {
    payload = JSON.parse(body.toString("utf8")) as typeof payload;
  } catch {
    res.sendStatus(400);
    return;
  }
  if (payload.object !== "instagram" || !Array.isArray(payload.entry)) {
    res.sendStatus(200);
    return;
  }
  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.messaging)) continue;
    for (const event of entry.messaging) {
      if (!event || typeof event !== "object") continue;
      const message = event.message;
      if (!message || message.is_echo || !message.mid || typeof message.text !== "string") continue;
      try {
        acceptInstagramMessage({
          senderId: event.sender?.id ?? "",
          recipientId: event.recipient?.id ?? entry.id ?? "",
          mid: message.mid,
          text: message.text,
          timestamp: event.timestamp,
        });
      } catch {
        // A signed event whose persistence fails must be retried by Meta.
        res.sendStatus(500);
        return;
      }
    }
  }
  res.sendStatus(200);
});

export default router;