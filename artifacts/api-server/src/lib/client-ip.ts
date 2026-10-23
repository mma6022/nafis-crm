import { isIP } from "node:net";
import type { Request } from "express";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Real client address for rate limiting.
 *
 * The app does not set Express `trust proxy`, so `req.ip` is always the
 * loopback Nginx peer in production (audit: routes/auth.ts:41 keys every
 * login on 127.0.0.1). Rather than trusting forwarded headers globally, accept
 * the single `X-Real-IP` value only when the TCP peer itself is the loopback
 * proxy, which overwrites that header. On a directly connected socket the
 * client-supplied headers are ignored, so they cannot spoof or rotate
 * rate-limit keys. X-Forwarded-For is never parsed: its left-most entries are
 * client controlled.
 */
export function trustedClientIp(req: Pick<Request, "socket" | "get">): string {
  const peer = req.socket.remoteAddress || "unknown";
  if (!LOOPBACK_PEERS.has(peer)) return peer;
  const forwarded = req.get("X-Real-IP")?.trim();
  return forwarded && isIP(forwarded) ? forwarded : peer;
}
