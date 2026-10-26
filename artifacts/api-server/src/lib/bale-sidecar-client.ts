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
  | "wrong_code" | "code_expired" | "sign_up_needed" | "wrong_password" | "flow_expired" | "unauthorized" | "unknown"
  // 1b (send / session):
  | "not_attached" | "peer_not_found" | "session_invalid" | "account_banned" | "bad_request"
  // UNVERIFIED (PM decision b): one customer blocked the expert. Default policy still stops the whole account.
  | "peer_blocked";
export class BaleSidecarError extends Error { constructor(public code: BaleSidecarErrorCode) { super(code); } }

export type StartAuthIn = { accountRef: string; phone: string; deviceHash: string; deviceTitle: string };
export type StartAuthOut = { flowId: string; codeType: "app" | "sms" | "unknown"; expiresInS: number };
export type Connected = { status: "connected"; token: string; baleUserId: string | null };
export type CodeOut = Connected | { status: "password_needed" };
export interface BaleSidecar {
  configured(): boolean;
  /** bootId changes on every sidecar start; attached = accountRefs with a live client (1b). */
  health(): Promise<{ ok: boolean; version?: string; sessions?: number; bootId?: string; attached?: string[] }>;
  startAuth(p: StartAuthIn): Promise<StartAuthOut>;
  submitCode(p: { flowId: string; code: string }): Promise<CodeOut>;
  submitPassword(p: { flowId: string; password: string }): Promise<Connected>;
  cancel(p: { flowId: string }): Promise<void>;
  signOut(p: { accountRef: string; token: string; deviceHash: string }): Promise<void>;
  /** 1b: open a long-lived client for a connected account (send + inbound listener). Idempotent per accountRef. */
  attach(p: { accountRef: string; token: string; deviceHash: string }): Promise<{ baleUserId: string | null }>;
  detach(p: { accountRef: string }): Promise<void>;
  /** 1b: one private text message. typingMs = how long "typing…" is shown first (sidecar caps it). */
  send(p: { accountRef: string; phone: string; peerId: string | null; text: string; typingMs: number }): Promise<{ messageId: string; peerId: string }>;
}

const KNOWN = new Set<string>(["phone_invalid", "rate_limited", "number_banned", "wrong_code", "code_expired", "sign_up_needed", "wrong_password", "flow_expired", "unauthorized", "unknown",
  "not_attached", "peer_not_found", "session_invalid", "account_banned", "bad_request", "peer_blocked",
  /* sidecar 1b-0.2: local library failure (never a Bale verdict on the session) and connect/get_me timeout */ "client_error", "timeout"]);
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
    async health() {
      try {
        const j = await call<any>("/v1/health", undefined, 3000);
        return { ok: j?.ok === true, version: String(j?.version ?? ""), sessions: Number(j?.sessions ?? 0),
          bootId: typeof j?.bootId === "string" ? j.bootId : undefined, attached: Array.isArray(j?.attached) ? j.attached.map(String) : undefined };
      } catch { return { ok: false }; }
    },
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
    async attach(p) { const j = await call<any>("/v1/session/attach", p); return { baleUserId: j?.baleUserId == null ? null : String(j.baleUserId) }; },
    async detach(p) { try { await call("/v1/session/detach", p, 5000); } catch { /* best effort */ } },
    async send(p) {
      const j = await call<any>("/v1/send", p, 30_000);
      if (j?.messageId == null || j?.peerId == null) throw new BaleSidecarError("sidecar_bad_response");
      return { messageId: String(j.messageId), peerId: String(j.peerId) };
    },
  };
}
