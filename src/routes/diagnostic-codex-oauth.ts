import { Router } from "express";

const callback = /^\/diagnostics-worker\/codex\/callback(?:\/[A-Za-z0-9_-]{1,80})?$/;
const allowedParameters = new Set(["code", "state", "iss", "error", "error_description", "error_uri"]);

/**
 * Reverse proxy only: Codex owns OAuth discovery, PKCE, state, token exchange and
 * credential storage. Never accept/store tokens or implement a second OAuth server.
 * Disabled unless explicitly enabled for the development authorization session.
 */
export function createCodexOAuthCallback(
  listenerPort: () => number | undefined,
  forward: typeof fetch = fetch,
) {
  const router = Router();
  router.get(callback, async (req, res): Promise<void> => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    const port = listenerPort();
    if (!port || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      res.status(404).send("OAuth authorization is not active."); return;
    }
    if (req.method !== "GET") { res.status(405).end(); return; }
    const original = req.originalUrl;
    const url = new URL(original, "http://callback.invalid");
    if (url.search.length > 8192 || [...url.searchParams.keys()].some(key =>
      !allowedParameters.has(key) || url.searchParams.getAll(key).length !== 1) ||
      !url.searchParams.get("state") ||
      (!url.searchParams.get("code") && !url.searchParams.get("error"))) {
      res.status(400).send("Invalid OAuth callback."); return;
    }
    try {
      // Host, port and path are never taken from an external redirect parameter.
      // No cookies, authorization headers or other browser headers are forwarded.
      const response = await forward(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || !response.body) {
        res.status(502).send("Codex did not accept this authorization. Start sign-in again."); return;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 64 * 1024) {
            await reader.cancel(); res.status(502).send("Invalid authorization response."); return;
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      res.type("html").send(Buffer.concat(chunks));
    } catch {
      // In particular, never log callback URLs, authorization codes or states.
      res.status(503).send("Codex sign-in is not running. Start sign-in again.");
    }
  });
  return router;
}

export const codexOAuthCallback = createCodexOAuthCallback(() =>
  process.env.NODE_ENV === "production" ? undefined : Number(process.env.CRM_REPAIR_CODEX_OAUTH_PORT) || undefined);
