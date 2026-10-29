/**
 * SMS-panel-only outbound proxy (t423s1302). Off unless SMS_PROXY_URL is set.
 *
 * Unset  → smsFetch() is plain fetch() to the configured local HMAC relay (unchanged behaviour).
 * Set    → the relay POST (/send, pattern body) is sent directly to IPPanel Edge
 *          (https://edge.ippanel.com/v1/api/send, Authorization = IPPANEL_API_KEY) through an
 *          HTTP CONNECT tunnel on SMS_PROXY_URL (e.g. http://host:port, tinyproxy, no auth).
 *          The IPPanel answer is wrapped in the relay contract `{ ok, data, error? }` so every
 *          caller keeps its exact success/rejection checks.
 * Only this module uses the proxy; no global agent / env proxy is touched.
 * Retries happen only while establishing the tunnel (proxy TCP connect, CONNECT answer, TLS
 * handshake); once the request bytes are written nothing is retried (no duplicate SMS).
 * Logs carry proxy host:port, path, attempt, status and timings only: never the key, body or numbers.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Socket } from "node:net";
import { logger } from "./logger";

export const IPPANEL_EDGE = { host: "edge.ippanel.com", base: "/v1/api" } as const;
const CONNECT_TRIES = 3, CONNECT_TIMEOUT_MS = 10_000, BACKOFF_MS = [0, 1_000, 2_500];

export function smsProxy(env: NodeJS.ProcessEnv = process.env): { host: string; port: number; label: string } | null {
  const raw = (env.SMS_PROXY_URL ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("sms_proxy_invalid"); }
  if (u.protocol !== "http:" || u.username || u.password || !u.hostname) throw new Error("sms_proxy_invalid");
  const port = Number(u.port || 80);
  return { host: u.hostname, port, label: `${u.hostname}:${port}` };
}

/** Test-only override of the upstream TLS endpoint (masked-copy harness); never set in production code paths. */
let testTarget: { host: string; port: number; ca: string } | null = null;
export function __setSmsPanelTestTarget(t: typeof testTarget): void { testTarget = t; }

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
      const t = tls.connect({ socket, servername: target, ALPNProtocols: ["http/1.1"], ...(testTarget ? { ca: testTarget.ca } : {}) });
      const to = setTimeout(() => { if (!done) { t.destroy(); fail("tls_timeout"); } }, CONNECT_TIMEOUT_MS);
      t.once("secureConnect", () => { clearTimeout(to); if (done) { t.destroy(); return; } done = true; resolve(t); });
      t.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(to); fail(`tls_${e.code ?? "error"}`, socket); });
    });
    req.end();
  });
}

/** One HTTPS request to IPPanel Edge through the proxy. Tunnel setup is retried; the request itself is not. */
export async function ippanelViaProxy(method: "GET" | "POST", path: string, body: string | null,
  o: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: number; text: string; attempts: number; proxy: string }> {
  const env = o.env ?? process.env;
  const p = smsProxy(env);
  if (!p) throw new Error("sms_proxy_off");
  const key = (env.IPPANEL_API_KEY ?? "").trim();
  if (!key) throw new Error("sms_panel_key_missing");
  let sock: tls.TLSSocket | null = null, attempt = 0, lastCode = "";
  const t0 = Date.now();
  for (; attempt < CONNECT_TRIES && !sock; attempt++) {
    if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    if (o.signal?.aborted) throw new TunnelError("aborted");
    try { sock = await openTunnel(p, testTarget?.host ?? IPPANEL_EDGE.host, testTarget?.port ?? 443, o.signal); }
    catch (e) {
      lastCode = e instanceof TunnelError ? e.code : "tunnel_error";
      logger.warn({ route: "sms_proxy", proxy: p.label, attempt: attempt + 1, code: lastCode }, "sms proxy tunnel failed");
      if (lastCode === "aborted") throw e;
    }
  }
  if (!sock) throw new TunnelError(lastCode || "tunnel_failed");
  const s = sock;
  const full = `${IPPANEL_EDGE.base}${path}`;
  return await new Promise((resolve, reject) => {
    const req = https.request({ host: testTarget?.host ?? IPPANEL_EDGE.host, method, path: full, signal: o.signal,
      createConnection: () => s,
      headers: { Authorization: key, Accept: "application/json", ...(body !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        s.destroy();
        const status = res.statusCode ?? 0;
        logger.info({ route: "sms_proxy", proxy: p.label, path: full, attempts: attempt, status, ms: Date.now() - t0 }, "sms panel request via proxy");
        resolve({ status, text: Buffer.concat(chunks).toString("utf8"), attempts: attempt, proxy: p.label });
      });
      res.on("error", (e) => { s.destroy(); reject(e); });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      s.destroy();
      logger.warn({ route: "sms_proxy", proxy: p.label, path: full, code: e.code ?? e.name }, "sms panel request failed after tunnel (not retried)");
      reject(e);
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

/** fetch-compatible transport for the SMS relay call sites. */
export async function smsFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let p: ReturnType<typeof smsProxy>;
  try { p = smsProxy(); } catch { return json(503, { ok: false, error: "sms_proxy_invalid" }); }
  if (!p) return fetch(input, init);
  const url = new URL(String(input));
  if ((init.method ?? "GET").toUpperCase() !== "POST" || !url.pathname.endsWith("/send") || typeof init.body !== "string") {
    return json(400, { ok: false, error: "invalid_payload" });
  }
  let r: Awaited<ReturnType<typeof ippanelViaProxy>>;
  try { r = await ippanelViaProxy("POST", "/send", init.body, { signal: init.signal ?? undefined }); }
  catch (e) {
    const code = (e as Error).message;
    if (code === "sms_panel_key_missing") return json(503, { ok: false, error: "relay_not_configured" });
    throw e; // network failure: callers map it to their "delivery unknown/failed" state
  }
  let data: unknown;
  try { data = JSON.parse(r.text); } catch { return json(502, { ok: false, error: "provider_invalid_response" }); }
  const meta = (data as { meta?: { status?: boolean } } | null)?.meta;
  const ok = r.status >= 200 && r.status < 300 && meta?.status === true;
  return json(ok ? 200 : r.status >= 400 ? r.status : 502, { ok, data, ...(ok ? {} : { error: meta?.status === false ? "provider_rejected" : "provider_error" }) });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
