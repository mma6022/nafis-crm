import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export function redactDiagnosticText(value: unknown, max = 1000): string {
  return String(value ?? "").slice(0, max * 2)
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END[^-]+-----|$)/g, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/((?:password|secret|token|api[_-]?key|authorization|cookie|رمز)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\b\d{8,}\b/g, "[number]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[credential]")
    .replace(/https?:\/\/[^\s?#]+[?#][^\s]*/g, url => url.split(/[?#]/)[0])
    .slice(0, max);
}

export function diagnosticPath(value: unknown): string {
  const text = String(value ?? "").split(/[?#]/)[0];
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || /[\u0000-\u001f]/.test(text))
    return "/";
  // A public payer URL contains a bearer capability in its path, not its query.
  return text.replace(/(\/(?:share-links|reset-password|verify-token)\/)[^/]+/gi, "$1[redacted]").slice(0, 500);
}
type RequestEvent = {
  requestId: string; at: string; method: string; path: string; status: number;
  durationMs: number; errorCode?: string;
};
const recent: (RequestEvent & { userId: number })[] = [];
export function recentDiagnosticRequests(userId: number, now = Date.now()): RequestEvent[] {
  return recent.filter(event => event.userId === userId && Date.parse(event.at) >= now - 10 * 60_000)
    .slice(-40).map(({ userId: _owner, ...event }) => event);
}

// Records metadata only: never bodies, cookies, authorization, or response data.
export const captureDiagnosticRequests: RequestHandler = (req, res, next) => {
  const path = diagnosticPath(req.path);
  if (/^\/(?:auth|customer-portal|diagnostics|wallet\/share-links)(?:\/|$)/.test(path)) {
    next(); return;
  }
  const requestId = randomUUID(), started = Date.now();
  res.setHeader("X-CRM-Request-ID", requestId);
  let errorCode: string | undefined;
  const json = res.json;
  res.json = function(body) {
    const code = body?.error ?? body?.code;
    if (typeof code === "string" && /^[a-z][a-z0-9_-]{0,99}$/.test(code)) errorCode = code;
    return json.call(this, body);
  };
  res.once("finish", () => {
    const userId = Number(res.locals.authUser?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) return;
    recent.push({ userId, requestId, at: new Date().toISOString(), method: req.method,
      path, status: res.statusCode, durationMs: Math.max(0, Date.now() - started), ...(errorCode ? { errorCode } : {}) });
    while (recent.length > 2000 || (recent.length && Date.parse(recent[0].at) < Date.now() - 15 * 60_000))
      recent.shift();
  });
  next();
};
