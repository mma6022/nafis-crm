import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { execute, executeChanges, queryRow, runTransaction } from "./crm-db";

type StoredConnection = {
  account_id: string;
  provider_page_id: string;
  token_sealed: string;
  bridge_sealed: string;
  enabled: number;
  generation: number;
  mode: "api" | "flow";
  verified_at: string;
  updated_at: string;
};

export type ManychatReplyMode = "intake" | "ai";

export function manychatReplyMode(): ManychatReplyMode {
  const row = queryRow<{ reply_mode: string }>("SELECT reply_mode FROM manychat_settings WHERE id=1");
  return row?.reply_mode === "ai" ? "ai" : "intake";
}

function encryptionKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  // Separate the credential key from the session HMAC key. The production
  // SESSION_SECRET must remain stable across releases to read stored credentials.
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("crm-manychat-v1"),
    Buffer.from("stored-provider-credentials"), 32));
}

function seal(value: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("MANYCHAT_ENCRYPTION_UNAVAILABLE");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

function unseal(value: string): string | null {
  const key = encryptionKey();
  if (!key) return null;
  try {
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [nonce, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64"));
    if (nonce.length !== 12 || tag.length !== 16 || !encrypted.length) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function storedManychatConnection(): StoredConnection | undefined {
  return queryRow<StoredConnection>("SELECT * FROM manychat_connections WHERE id=1");
}

// Prefer administrator-managed credentials. An existing environment-based bridge
// keeps working until an administrator explicitly replaces it in the CRM.
export function manychatConfig() {
  const stored = storedManychatConnection();
  const accountId = stored?.account_id ?? process.env.MANYCHAT_ACCOUNT_ID?.trim() ?? "";
  const bridgeSecret = stored ? unseal(stored.bridge_sealed) ?? "" : process.env.MANYCHAT_BRIDGE_SECRET ?? "";
  const mode = stored?.mode ?? "api";
  const apiToken = stored ? mode === "flow" ? "" : unseal(stored.token_sealed) ?? "" : process.env.MANYCHAT_API_TOKEN ?? "";
  const configured = Boolean(
    /^[A-Za-z0-9_-]{3,80}$/.test(accountId) && bridgeSecret.length >= 24 && (mode === "flow" || apiToken),
  );
  return {
    accountId, bridgeSecret, apiToken, mode, recipientId: `mc:${accountId}`, configured,
    enabled: configured && (stored ? stored.enabled === 1 : process.env.MANYCHAT_AUTOREPLY_ENABLED === "1"),
    replyMode: manychatReplyMode(),
    source: stored ? "database" as const : configured ? "environment" as const : "none" as const,
    credentialsUnreadable: Boolean(stored) && !configured,
    verifiedAt: mode === "api" ? stored?.verified_at ?? null : null,
    configuredAt: stored?.updated_at ?? null,
  };
}

export function setManychatReplyMode(replyMode: ManychatReplyMode): "updated" | "busy" {
  return runTransaction(() => {
    if (activeSendInProgress()) return "busy";
    const now = new Date().toISOString();
    executeChanges(
      "UPDATE manychat_settings SET reply_mode=?, updated_at=? WHERE id=1",
      [replyMode, now],
    );
    // Results prepared under the previous policy are permanently invalidated.
    executeChanges(
      "UPDATE instagram_send_queue SET state='failed', revision=revision+1, requested_field=NULL, error='reply_mode_changed', updated_at=? WHERE state IN ('pending','sending')",
      [now],
    );
    executeChanges(
      "UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, requested_field=NULL, lease_expires_at=NULL, error='reply_mode_changed', updated_at=? WHERE state IN ('pending','processing','ready')",
      [now],
    );
    return "updated";
  });
}

export function saveManychatConnection(pageId: string, apiToken: string, bridgeSecret: string): void {
  const accountId = `manychat-${createHash("sha256").update(pageId).digest("hex").slice(0, 24)}`;
  const now = new Date().toISOString();
  const tokenSealed = seal(normalizeManychatApiToken(apiToken));
  const bridgeSealed = seal(bridgeSecret);
  runTransaction(() => {
    if (activeSendInProgress()) throw new Error("MANYCHAT_SEND_IN_PROGRESS");
    // Disable queued sends across credential/account changes; never claim an
    // in-flight send completed if the provider outcome is unknown.
    executeChanges("UPDATE instagram_send_queue SET state='failed', revision=revision+1, requested_field=NULL, error='provider_credentials_changed', updated_at=? WHERE state IN ('pending','sending')", [now]);
    executeChanges("UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, requested_field=NULL, error='provider_credentials_changed', updated_at=? WHERE state IN ('pending','processing','ready')", [now]);
    execute(
      `INSERT INTO manychat_connections (id, account_id, provider_page_id, token_sealed, bridge_sealed, enabled, generation, mode, verified_at, updated_at)
       VALUES (1, ?, ?, ?, ?, 0, 1, 'api', ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, provider_page_id=excluded.provider_page_id,
          token_sealed=excluded.token_sealed, bridge_sealed=excluded.bridge_sealed, enabled=0, generation=generation+1, mode='api',
         verified_at=excluded.verified_at, updated_at=excluded.updated_at`,
      [accountId, pageId, tokenSealed, bridgeSealed, now, now],
    );
  });
}

export function saveManychatFlowConnection(bridgeSecret: string): void {
  const accountId = `manychat-flow-${createHash("sha256").update(bridgeSecret).digest("hex").slice(0, 24)}`;
  const now = new Date().toISOString();
  const bridgeSealed = seal(bridgeSecret);
  runTransaction(() => {
    if (activeSendInProgress()) throw new Error("MANYCHAT_SEND_IN_PROGRESS");
    executeChanges("UPDATE instagram_send_queue SET state='failed', revision=revision+1, requested_field=NULL, error='provider_credentials_changed', updated_at=? WHERE state IN ('pending','sending')", [now]);
    executeChanges("UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, requested_field=NULL, error='provider_credentials_changed', updated_at=? WHERE state IN ('pending','processing','ready')", [now]);
    execute(
      `INSERT INTO manychat_connections (id, account_id, provider_page_id, token_sealed, bridge_sealed, enabled, generation, mode, verified_at, updated_at)
       VALUES (1, ?, '', '', ?, 0, 1, 'flow', ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, provider_page_id='', token_sealed='',
         bridge_sealed=excluded.bridge_sealed, enabled=0, generation=generation+1, mode='flow',
         verified_at=excluded.verified_at, updated_at=excluded.updated_at`,
      [accountId, bridgeSealed, now, now],
    );
  });
}

function activeSendInProgress(): boolean {
  return Boolean(queryRow<{ active: number }>(
    `SELECT EXISTS(SELECT 1 FROM instagram_send_state
       WHERE id=1 AND lease_stage='sending' AND lease_token IS NOT NULL AND lease_expires_at>?) AS active`,
    [new Date().toISOString()],
  )?.active);
}

export function setManychatAutoreply(enabled: boolean, expectedGeneration?: number): "updated" | "changed" | "busy" {
  return runTransaction(() => {
    // A disable always takes effect for new sends immediately. A request already
    // on the wire cannot be recalled; the UI must say it may still complete.
    if (enabled && activeSendInProgress()) return "busy";
    const changed = executeChanges(
      `UPDATE manychat_connections SET enabled=?, generation=generation+1 WHERE id=1${expectedGeneration === undefined ? "" : " AND generation=?"}`,
      expectedGeneration === undefined ? [enabled ? 1 : 0] : [enabled ? 1 : 0, expectedGeneration],
    );
    if (changed && !enabled) {
      const now = new Date().toISOString();
      executeChanges(
        "UPDATE instagram_send_queue SET state='failed', revision=revision+1, requested_field=NULL, error='automation_disabled', updated_at=? WHERE state IN ('pending','sending')",
        [now],
      );
      executeChanges(
        "UPDATE instagram_flow_replies SET state='failed', revision=revision+1, reply_text=NULL, requested_field=NULL, lease_expires_at=NULL, error='automation_disabled', updated_at=? WHERE state IN ('pending','processing','ready')",
        [now],
      );
    }
    return changed ? "updated" : "changed";
  });
}

export function normalizeManychatApiToken(apiToken: string): string {
  return apiToken.trim().replace(/^Bearer\s+/i, "").trim();
}

export async function verifyManychatToken(apiToken: string): Promise<{ ok: boolean; pageId?: string; reason?: string }> {
  const token = normalizeManychatApiToken(apiToken);
  try {
    const response = await fetch("https://api.manychat.com/fb/page/getInfo", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid_token" };
    if (!response.ok) return { ok: false, reason: response.status === 429 ? "rate_limited" : "provider_unavailable" };
    const result = await response.json() as { status?: string; data?: { id?: string | number | null } };
    if (result?.status !== "success" || !result.data || !token)
      return { ok: false, reason: "provider_rejected" };
    // A successfully authenticated Instagram-only account can have no Facebook
    // page ID. Never bind it by a display name or use "null" as a shared identity.
    // Without a provider ID, token rotation deliberately establishes a new
    // isolated binding rather than assuming another token belongs to this page.
    const pageId = result.data.id === null
      ? `token-binding-${createHash("sha256").update(token).digest("hex").slice(0, 48)}`
      : typeof result.data.id === "string" || typeof result.data.id === "number"
        ? String(result.data.id) : "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(pageId))
      return { ok: false, reason: "provider_rejected" };
    return { ok: true, pageId };
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
}

export function validManychatSecret(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export function manychatSenderId(accountId: string, subscriberId: string): string {
  return `mc:${accountId}:${subscriberId}`;
}

export async function sendManychatReply(subscriberId: string, text: string, apiToken: string): Promise<Response> {
  return fetch("https://api.manychat.com/fb/sending/sendContent", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriber_id: Number(subscriberId),
      data: { version: "v2", content: { type: "instagram", messages: [{ type: "text", text }] } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
}