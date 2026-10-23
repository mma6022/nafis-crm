import express, { type Express, type NextFunction, type Request, type Response, Router } from "express";
import { trustedClientIp } from "../lib/client-ip";
import { logger } from "../lib/logger";
import { notifyNewCustomer } from "../lib/customer-notifications";
import { hashLeadIp, leadCounts, recordPublicLead, validatePublicLead, ensurePublicLeadSchema } from "../lib/public-leads";

export const PUBLIC_LEADS_PATH = "/api/public/leads";
export const PUBLIC_LEAD_ORIGINS = new Set(["https://nafisvam.com", "https://www.nafisvam.com"]);

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 8;
const MAX_LEADS_PER_IP_DAY = 10;
const MAX_LEADS_PER_PHONE_DAY = 3;
const MAX_TRACKED_IPS = 10_000;

/** In-memory attempt limiter (counts every POST, valid or not). Bounded and self-evicting. */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs = WINDOW_MS, private readonly max = MAX_ATTEMPTS_PER_WINDOW) {}

  /** Returns seconds to wait, or 0 if the attempt is allowed (and recorded). */
  take(key: string, now = Date.now()): number {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_TRACKED_IPS) this.evict(since);
    return 0;
  }

  private evict(since: number): void {
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= since) this.hits.delete(key);
    }
    // Still full: drop the least recently used keys (Map keeps insertion order).
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_TRACKED_IPS) break;
      this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, error, ...extra });
}

/** CORS for the public site only: no credentials, no reflection of other origins. */
function publicLeadCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  const origin = req.get("Origin");
  if (!origin || !PUBLIC_LEAD_ORIGINS.has(origin)) {
    fail(res, 403, "origin_not_allowed");
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
}

export function createPublicLeadsRouter(limiter = new AttemptLimiter()): Router {
  const router = Router();
  router.use(publicLeadCors);
  router.post(
    "/",
    (req, res, next): void => {
      const wait = limiter.take(trustedClientIp(req));
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        fail(res, 429, "rate_limited");
        return;
      }
      if (!req.is("application/json")) {
        fail(res, 415, "unsupported_media_type");
        return;
      }
      next();
    },
    express.json({ limit: "4kb", strict: true }),
    (req, res): void => {
      const validation = validatePublicLead(req.body);
      if (!validation.ok) {
        fail(res, validation.status, validation.error, validation.fields ? { fields: validation.fields } : {});
        return;
      }
      const { lead } = validation;
      const ipHash = hashLeadIp(trustedClientIp(req));
      ensurePublicLeadSchema();
      const counts = leadCounts(ipHash, lead.phone);
      if (counts.phoneRecent > 0) {
        // Same person resubmitting within minutes: already recorded, do not duplicate. No tracking code here:
        // the earlier one is never re-issued to whoever knows the phone number.
        res.status(200).json({ ok: true });
        return;
      }
      if (counts.ipDay >= MAX_LEADS_PER_IP_DAY || counts.phoneDay >= MAX_LEADS_PER_PHONE_DAY) {
        res.setHeader("Retry-After", "3600");
        fail(res, 429, "rate_limited");
        return;
      }
      const result = recordPublicLead(lead, ipHash);
      logger.info({ customerId: result.customerId, created: result.created, src: lead.src }, "Website lead recorded");
      // Only the fresh, random reference: nothing from the request is echoed back.
      res.status(201).json({ ok: true, trackingCode: result.trackingCode });
      if (result.created) void notifyNewCustomer(result.customerId);
    },
  );
  router.all("/", (_req, res): void => {
    res.setHeader("Allow", "POST, OPTIONS");
    fail(res, 405, "method_not_allowed");
  });
  // Body-parser and unexpected errors: generic codes, never the input or stack.
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.too.large") return fail(res, 413, "payload_too_large");
    if (type === "entity.parse.failed") return fail(res, 400, "invalid", { fields: ["body"] });
    logger.error({ err: error instanceof Error ? error.message : "unknown" }, "Website lead failed");
    fail(res, 500, "server_error");
  });
  return router;
}

/**
 * Must be mounted before the app-wide `cors({ origin: true, credentials: true })`
 * and the same-host Origin check, both of which would otherwise reflect any
 * origin or reject the public site's cross-origin POST.
 */
export function mountPublicLeads(app: Express): void {
  app.use(PUBLIC_LEADS_PATH, createPublicLeadsRouter());
}
