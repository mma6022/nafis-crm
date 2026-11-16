/**
 * Identity-SAPI egress switch (t687s2662, Mohammad: «احراز هویت موقتاً از پروکسی ایران به s.api.ir بره»).
 *
 * call_queue_settings key `identity_egress`:
 *   absent / anything else → 'tunnel'  (default, unchanged behaviour: SAPI_RELAY_URL HMAC relay as before)
 *   'proxy'                → the four identity checks (ShahkarLite, PersonInfo, PostalCodeInfo, Sana) go
 *                            DIRECTLY to https://s.api.ir (Bearer SAPI_API_TOKEN) through an HTTP CONNECT
 *                            tunnel on the existing SMS_PROXY_URL Iran proxy (same host/port, no auth, IP-allowlisted).
 * Read per request (no restart, no deploy); switched only by the ops script /root/assistantsid/id-egress.py.
 * Only lib/sapi.ts uses this module. Banking SAPI, SMS, ICS24 and every other egress are untouched.
 * The target host is fixed to s.api.ir (SAPI_API_BASE_URL is not honoured in proxy mode).
 * Retries only while establishing the tunnel; once request bytes are written nothing is retried.
 * Logs carry proxy host:port, path, attempt, status and timings only: never the token, body, national codes or numbers.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Socket } from "node:net";
import { queryRow } from "./crm-db";
import { smsProxy } from "./sms-proxy";
import { logger } from "./logger";

export const IDENTITY_EGRESS_KEY = "identity_egress";
export const SAPI_HOST = "s.api.ir";
export type IdentityEgress = "proxy" | "tunnel";
const CONNECT_TRIES = 3, CONNECT_TIMEOUT_MS = 8_000, BACKOFF_MS = [0, 800, 1_500];

export function identityEgress(): IdentityEgress {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [IDENTITY_EGRESS_KEY])?.value === "proxy" ? "proxy" : "tunnel"; }
  catch { return "tunnel"; }
}

/** Test-only override of the upstream TLS endpoint (masked-copy harness); never set in production code paths. */
let testTarget: { host: string; port: number; ca: string } | null = null;
export function __setIdentityTestTarget(t: typeof testTarget): void { testTarget = t; }

class TunnelError extends Error { constructor(public readonly code: string) { super(code); } }

function openTunnel(p: { host: string; port: number }, target: string, tport: number, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (code: string, s?: Socket) => { if (done) return; done = true; s?.destroy(); req.destroy(); reject(new TunnelError(code)); };
    const req = http.request({ host: p.host, port: p.port, method: "CONNECT", path: `${target}:${tport}`, headers: { Host: `${target}:${tport}` }, timeout: CONNECT_TIMEOUT_MS, signal });
    req.on("timeout", () => fail("proxy_connect_timeout"));
    req.on("error", (e: NodeJS.ErrnoException) => fail(e.name === "AbortError" ? "aborted" : `proxy_${e.code ?? "error"}`));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { fail(`proxy_connect_http_${res.statusCode}`, socket); return; }
      const t = tls.connect({ socket, servername: testTarget ? "localhost" : target, ALPNProtocols: ["http/1.1"], ...(testTarget ? { ca: testTarget.ca } : {}) });
      const to = setTimeout(() => { if (!done) { t.destroy(); fail("tls_timeout"); } }, CONNECT_TIMEOUT_MS);
      t.once("secureConnect", () => { clearTimeout(to); if (done) { t.destroy(); return; } done = true; resolve(t); });
      t.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(to); fail(`tls_${e.code ?? "error"}`, socket); });
    });
    req.end();
  });
}

/** One HTTPS POST to s.api.ir through the Iran proxy. Returns status + raw text. Throws on missing config / network failure. */
export async function sapiViaProxy(path: string, body: string, o: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: number; text: string; attempts: number }> {
  const env = o.env ?? process.env;
  let p: ReturnType<typeof smsProxy>;
  try { p = smsProxy(env); } catch { throw new Error("identity_proxy_invalid"); }
  if (!p) throw new Error("identity_proxy_not_configured");
  const token = (env.SAPI_API_TOKEN ?? "").trim();
  if (!token) throw new Error("SAPI provider is not configured");
  const host = testTarget?.host ?? SAPI_HOST, port = testTarget?.port ?? 443;
  const full = `/${path.replace(/^\//, "")}`;
  let sock: tls.TLSSocket | null = null, attempt = 0, lastCode = "";
  const t0 = Date.now();
  for (; attempt < CONNECT_TRIES && !sock; attempt++) {
    if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    if (o.signal?.aborted) throw new TunnelError("aborted");
    try { sock = await openTunnel(p, host, port, o.signal); }
    catch (e) {
      lastCode = e instanceof TunnelError ? e.code : "tunnel_error";
      logger.warn({ route: "identity_proxy", proxy: p.label, path: full, attempt: attempt + 1, code: lastCode }, "identity proxy tunnel failed");
      if (lastCode === "aborted") throw e;
    }
  }
  if (!sock) throw new TunnelError(`identity_proxy_${lastCode || "tunnel_failed"}`);
  const s = sock, label = p.label;
  return await new Promise((resolve, reject) => {
    const req = https.request({ host: SAPI_HOST, method: "POST", path: full, signal: o.signal, createConnection: () => s,
      headers: { Host: SAPI_HOST, Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        s.destroy();
        const status = res.statusCode ?? 0;
        logger.info({ route: "identity_proxy", proxy: label, path: full, attempts: attempt, status, ms: Date.now() - t0 }, "identity request via proxy");
        resolve({ status, text: Buffer.concat(chunks).toString("utf8"), attempts: attempt });
      });
      res.on("error", (e) => { s.destroy(); reject(e); });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      s.destroy();
      logger.warn({ route: "identity_proxy", proxy: label, path: full, code: e.code ?? e.name }, "identity request failed after tunnel (not retried)");
      reject(e);
    });
    req.write(body);
    req.end();
  });
}
