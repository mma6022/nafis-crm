import type { Request, RequestHandler } from "express";
import { trustedClientIp } from "./client-ip";

/** Fixed-window in-memory limiter (single-process CRM service). */
export function createQuoteRateLimit(limit: number, windowMs: number, key: (req: Request) => string): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next): void => {
    const now = Date.now();
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) { entry = { count: 0, resetAt: now + windowMs }; hits.set(k, entry); }
    entry.count += 1;
    if (entry.count > limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      res.status(429).json({ error: "rate_limited", message: "تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید." });
      return;
    }
    next();
  };
}

export const publicQuoteRateLimit = createQuoteRateLimit(60, 60_000, req => `ip:${trustedClientIp(req)}`);

const MAX_CASH = 10_000_000_000_000;
/** Strict body: only the allowed keys, each a safe positive integer (months 1..600, money 1..1e13), or null/absent. */
export function parseQuoteBody(body: unknown, allowed: string[]): Record<string, number | null> | null {
  if (body == null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!allowed.includes(k)) return null;
    if (v === null) { out[k] = null; continue; }
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,14}$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) return null;
    if (k === "months" || k === "planId" ? n > (k === "months" ? 600 : Number.MAX_SAFE_INTEGER) : n > MAX_CASH) return null;
    out[k] = n;
  }
  return out;
}
