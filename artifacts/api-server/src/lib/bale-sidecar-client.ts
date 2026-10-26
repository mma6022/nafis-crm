/**
 * API → Bale sidecar contract (localhost only; see artifacts/bale-sidecar/CONTRACT.md).
 * The sidecar is a "pipe": it holds the Bale transaction_hash in memory (TTL ~5 min) and speaks to Bale; every decision
 * (who may connect, scope, switches, rate limits) is made by the API. Every request carries the internal token in
 * `x-bale-internal-token` (read from BALE_SIDECAR_TOKEN_FILE). Codes, 2FA passwords and session tokens travel only in
 * request/response BODIES (never URLs, never logs) and this client never logs a body.
 */
import { baleSidecarToken, type KeyEnv } from "./bale-crypto";

export type BaleSidecarErrorCode =
  | "sidecar_not_configured" | "sidecar_unavailable" | "sidecar_bad_response" | "phone_invalid" | "rate_limited" | "number_banned"
  | "wrong_code" | "code_expired" | "sign_up_needed" | "wrong_password" | "flow_expired" | "unauthorized" | "unknown";
export class BaleSidecarError extends Error { constructor(public code: BaleSidecarErrorCode) { super(code); } }

export type StartAuthIn = { accountRef: string; phone: string; deviceHash: string; deviceTitle: string };
export type StartAuthOut = { flowId: string; codeType: "app" | "sms" | "unknown"; expiresInS: number };
export type Connected = { status: "connected"; token: string; baleUserId: string | null };
export type CodeOut = Connected | { status: "password_needed" };
export interface BaleSidecar {
  configured(): boolean;
  health(): Promise<{ ok: boolean; version?: string; sessions?: number }>;
  startAuth(p: StartAuthIn): Promise<StartAuthOut>;
  submitCode(p: { flowId: string; code: string }): Promise<CodeOut>;
  submitPassword(p: { flowId: string; password: string }): Promise<Connected>;
  cancel(p: { flowId: string }): Promise<void>;
  signOut(p: { accountRef: string; token: string; deviceHash: string }): Promise<void>;
}

const KNOWN = new Set<string>(["phone_invalid", "rate_limited", "number_banned", "wrong_code", "code_expired", "sign_up_needed", "wrong_password", "flow_expired", "unauthorized", "unknown"]);
/** Only loopback HTTP is accepted: the sidecar must never be reachable from outside the server. */
export function isLoopbackUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(x.hostname); } catch { return false; }
}

export function createHttpBaleSidecar(env: () => KeyEnv, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): BaleSidecar {
  const url = () => (env().BALE_SIDECAR_URL || "").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const configured = () => isLoopbackUrl(url()) && baleSidecarToken(env()) !== null;
  async function call<T>(path: string, body?: unknown, timeoutMs = opts.timeoutMs ?? 20_000): Promise<T> {
    if (!configured()) throw new BaleSidecarError("sidecar_not_configured");
    let r: Response;
    try {
      r = await f(url() + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "x-bale-internal-token": baleSidecarToken(env())! },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new BaleSidecarError("sidecar_unavailable"); }
    let j: any; try { j = await r.json(); } catch { throw new BaleSidecarError("sidecar_bad_response"); }
    if (!r.ok) throw new BaleSidecarError(KNOWN.has(j?.error) ? j.error : r.status === 401 ? "unauthorized" : "unknown");
    return j as T;
  }
  return {
    configured,
    async health() { try { const j = await call<any>("/v1/health", undefined, 3000); return { ok: j?.ok === true, version: String(j?.version ?? ""), sessions: Number(j?.sessions ?? 0) }; } catch { return { ok: false }; } },
    async startAuth(p) {
      const j = await call<any>("/v1/auth/start", p);
      if (typeof j?.flowId !== "string" || j.flowId.length < 16) throw new BaleSidecarError("sidecar_bad_response");
      return { flowId: j.flowId, codeType: j.codeType === "sms" || j.codeType === "app" ? j.codeType : "unknown", expiresInS: Math.min(600, Math.max(30, Number(j.expiresInS) || 300)) };
    },
    async submitCode(p) {
      const j = await call<any>("/v1/auth/code", p);
      if (j?.status === "password_needed") return { status: "password_needed" };
      if (j?.status === "connected" && typeof j.token === "string" && j.token) return { status: "connected", token: j.token, baleUserId: j.baleUserId == null ? null : String(j.baleUserId) };
      throw new BaleSidecarError("sidecar_bad_response");
    },
    async submitPassword(p) {
      const j = await call<any>("/v1/auth/password", p);
      if (j?.status === "connected" && typeof j.token === "string" && j.token) return { status: "connected", token: j.token, baleUserId: j.baleUserId == null ? null : String(j.baleUserId) };
      throw new BaleSidecarError("sidecar_bad_response");
    },
    async cancel(p) { try { await call("/v1/auth/cancel", p, 5000); } catch { /* best effort */ } },
    async signOut(p) { await call("/v1/session/signout", p); },
  };
}
