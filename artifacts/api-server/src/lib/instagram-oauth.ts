import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  executeChanges,
  queryRow,
  queryRows,
  runImmediateTransaction,
} from "./crm-db";

const REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
] as const;
const CALLBACK_PATH = "/api/instagram/oauth/callback";
const STATE_TTL_MS = 10 * 60 * 1000;

type OAuthSetup = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  tokenEncryptionKey: Buffer | null;
  previousTokenEncryptionKey: Buffer | null;
  missingSetup: string[];
};

type StoredConnection = {
  account_id: string;
  account_username: string;
  token_ciphertext: string;
  token_nonce: string;
  token_auth_tag: string;
  token_key_version: string;
  token_expires_at: string | null;
  connected_at: string;
};

function validatedRedirectUri(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.pathname !== CALLBACK_PATH ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !(url.protocol === "https:" || (process.env.NODE_ENV !== "production" && isLocal && url.protocol === "http:"))
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function oauthSetup(): OAuthSetup {
  const clientId = process.env.IG_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.IG_OAUTH_CLIENT_SECRET ?? "";
  const redirectUri = validatedRedirectUri(process.env.IG_OAUTH_REDIRECT_URI);
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  const tokenEncryptionKey = parseEncryptionKey(process.env.IG_TOKEN_ENCRYPTION_KEY);
  const previousTokenEncryptionKey = process.env.IG_TOKEN_ENCRYPTION_KEY_PREVIOUS
    ? parseEncryptionKey(process.env.IG_TOKEN_ENCRYPTION_KEY_PREVIOUS)
    : null;
  const missingSetup: string[] = [];
  if (!clientId) missingSetup.push("IG_OAUTH_CLIENT_ID (Instagram App ID)");
  if (!clientSecret) missingSetup.push("IG_OAUTH_CLIENT_SECRET (Instagram App Secret)");
  if (!redirectUri) missingSetup.push(`IG_OAUTH_REDIRECT_URI (HTTPS URL ending in ${CALLBACK_PATH})`);
  if (!sessionSecret) missingSetup.push("SESSION_SECRET (OAuth state/session security)");
  if (!tokenEncryptionKey) missingSetup.push("IG_TOKEN_ENCRYPTION_KEY (canonical base64 encoding of exactly 32 random bytes)");
  if (process.env.IG_TOKEN_ENCRYPTION_KEY_PREVIOUS && !previousTokenEncryptionKey) {
    missingSetup.push("IG_TOKEN_ENCRYPTION_KEY_PREVIOUS must be canonical base64 encoding of exactly 32 random bytes");
  }
  if (!process.env.IG_APP_SECRET) missingSetup.push("IG_APP_SECRET (webhook signature verification)");
  if (!process.env.IG_VERIFY_TOKEN) missingSetup.push("IG_VERIFY_TOKEN (webhook verification)");
  return {
    clientId,
    clientSecret,
    redirectUri: redirectUri ?? "",
    sessionSecret,
    tokenEncryptionKey,
    previousTokenEncryptionKey,
    missingSetup,
  };
}

export function instagramOAuthIsReady(): boolean {
  return oauthSetup().missingSetup.length === 0;
}

export function instagramOAuthStatus() {
  const setup = oauthSetup();
  const credentials = instagramStoredCredentials();
  const connection = queryRow<Pick<StoredConnection,
    "account_id" | "account_username" | "token_expires_at" | "connected_at"
  >>(
    `SELECT account_id, account_username, token_expires_at, connected_at
       FROM instagram_connections WHERE id=1`,
  );
  const missingSetup = [...setup.missingSetup];
  if (connection && credentials.decryptionFailed) {
    missingSetup.push(
      "Stored Instagram token cannot be decrypted; verify IG_TOKEN_ENCRYPTION_KEY and retain IG_TOKEN_ENCRYPTION_KEY_PREVIOUS during key rotation. Reconnect only after confirming the historically bound account.",
    );
  }
  return {
    oauthReady: setup.missingSetup.length === 0,
    connected: credentials.usable,
    accountUsername: connection?.account_username ?? null,
    accountId: connection?.account_id ?? null,
    tokenExpiry: connection?.token_expires_at ?? null,
    redirectUri: setup.redirectUri || null,
    missingSetup,
  };
}

export function instagramBoundAccountId(): string {
  const binding = queryRow<{ account_id: string | null }>(
    "SELECT account_id FROM instagram_account_binding WHERE id=1",
  );
  const legacyAccountId = (process.env.IG_ACCOUNT_ID ?? "").trim();
  if (binding && !binding.account_id && legacyAccountId) {
    executeChanges(
      "UPDATE instagram_account_binding SET account_id=?, updated_at=? WHERE id=1 AND account_id IS NULL",
      [legacyAccountId, new Date().toISOString()],
    );
    return queryRow<{ account_id: string | null }>(
      "SELECT account_id FROM instagram_account_binding WHERE id=1",
    )?.account_id ?? legacyAccountId;
  }
  return binding?.account_id ?? legacyAccountId;
}

function purposeHash(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

function parseEncryptionKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  try {
    const key = Buffer.from(value, "base64");
    return key.length === 32 && key.toString("base64") === value ? key : null;
  } catch {
    return null;
  }
}

function legacySessionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("instagram-oauth-v1"),
    Buffer.from("long-lived-token"),
    32,
  ));
}

function encryptToken(token: string, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptWithKey(row: StoredConnection, key: Buffer): string | null {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(row.token_nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(row.token_auth_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.token_ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function decryptToken(row: StoredConnection, setup: OAuthSetup): { token: string; keyVersion: "primary" } | null {
  const currentKey = setup.tokenEncryptionKey;
  if (!currentKey) return null;
  const candidates: Array<{ key: Buffer | null; version: string }> = row.token_key_version === "legacy-session"
    ? [{ key: setup.sessionSecret ? legacySessionKey(setup.sessionSecret) : null, version: "legacy-session" }]
    : row.token_key_version === "previous"
      ? [
        { key: setup.previousTokenEncryptionKey, version: "previous" },
        { key: currentKey, version: "primary" },
      ]
      : [
        { key: currentKey, version: "primary" },
        { key: setup.previousTokenEncryptionKey, version: "previous" },
      ];
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    const token = decryptWithKey(row, candidate.key);
    if (token === null) continue;
    if (candidate.version !== "primary") {
      const rewrapped = encryptToken(token, currentKey);
      executeChanges(
        `UPDATE instagram_connections
            SET token_ciphertext=?, token_nonce=?, token_auth_tag=?, token_key_version='primary', updated_at=?
          WHERE id=1 AND account_id=? AND token_ciphertext=? AND token_nonce=? AND token_auth_tag=?`,
        [
          rewrapped.ciphertext,
          rewrapped.nonce,
          rewrapped.authTag,
          new Date().toISOString(),
          row.account_id,
          row.token_ciphertext,
          row.token_nonce,
          row.token_auth_tag,
        ],
      );
    }
    return { token, keyVersion: "primary" };
  }
  return null;
}

export function instagramStoredCredentials() {
  const row = queryRow<StoredConnection>("SELECT * FROM instagram_connections WHERE id=1");
  const setup = oauthSetup();
  const decoded = row ? decryptToken(row, setup) : null;
  const accessToken = decoded?.token ?? null;
  const expires = row?.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
  const boundAccountId = instagramBoundAccountId();
  const identityMatches = Boolean(row?.account_id && row.account_id === boundAccountId);
  return {
    accountId: accessToken && identityMatches ? row!.account_id : "",
    accessToken: accessToken ?? "",
    accountUsername: accessToken && identityMatches ? row!.account_username : null,
    tokenExpiry: row?.token_expires_at ?? null,
    usable: Boolean(accessToken) && identityMatches && Number.isFinite(expires) && expires > Date.now(),
    connected: Boolean(accessToken) && identityMatches && Number.isFinite(expires) && expires > Date.now(),
    decryptionFailed: Boolean(row) && !accessToken,
  };
}

export function beginInstagramOAuth(sessionToken: string, adminUserId: number): string | null {
  const setup = oauthSetup();
  if (setup.missingSetup.length || !sessionToken) return null;
  const state = randomBytes(32).toString("base64url");
  const now = new Date();
  runImmediateTransaction(() => {
    const binding = queryRow<{ generation: number }>(
      "SELECT generation FROM instagram_account_binding WHERE id=1",
    );
    if (!binding) throw new Error("INSTAGRAM_ACCOUNT_BINDING_MISSING");
    executeChanges("DELETE FROM instagram_oauth_states WHERE expires_at<=?", [now.toISOString()]);
    executeChanges(
      `INSERT INTO instagram_oauth_states
         (state_hash, session_hash, admin_user_id, connection_generation, expires_at, created_at)
       VALUES(?,?,?,?,?,?)`,
      [
        purposeHash(setup.sessionSecret, "instagram-state", state),
        purposeHash(setup.sessionSecret, "instagram-session", sessionToken),
        adminUserId,
        binding.generation,
        new Date(now.getTime() + STATE_TTL_MS).toISOString(),
        now.toISOString(),
      ],
    );
  });
  const authorize = new URL("https://www.instagram.com/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: setup.clientId,
    redirect_uri: setup.redirectUri,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    state,
  }).toString();
  return authorize.toString();
}

function consumeState(state: string, sessionToken: string, adminUserId: number): number | null {
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret || !/^[A-Za-z0-9_-]{40,64}$/.test(state) || !sessionToken) return null;
  return runImmediateTransaction(() => {
    const hash = purposeHash(secret, "instagram-state", state);
    const row = queryRow<{
      session_hash: string;
      admin_user_id: number;
      connection_generation: number;
      expires_at: string;
    }>(
      "SELECT session_hash, admin_user_id, connection_generation, expires_at FROM instagram_oauth_states WHERE state_hash=?",
      [hash],
    );
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      executeChanges("DELETE FROM instagram_oauth_states WHERE state_hash=?", [hash]);
      return null;
    }
    const sessionHash = purposeHash(secret, "instagram-session", sessionToken);
    if (row.session_hash !== sessionHash || row.admin_user_id !== adminUserId) return null;
    return executeChanges("DELETE FROM instagram_oauth_states WHERE state_hash=?", [hash]) === 1
      ? row.connection_generation
      : null;
  });
}

function grantedScopes(payload: Record<string, unknown>): Set<string> {
  const raw = payload.permissions ?? payload.scope ?? payload.granted_scopes ?? payload.granted_permissions;
  const values = Array.isArray(raw)
    ? raw.flatMap((value) => {
      if (typeof value === "string") return [value];
      if (
        value &&
        typeof value === "object" &&
        "permission" in value &&
        typeof value.permission === "string" &&
        (!("status" in value) || value.status === "granted")
      ) return [value.permission];
      return [];
    })
    : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  return new Set(values);
}

function normalizedOAuthPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!("data" in payload)) return payload;
  if (!Array.isArray(payload.data) || payload.data.length !== 1) return null;
  const item: unknown = payload.data[0];
  return item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : null;
}

function hasHistoricalInstagramMessages(): boolean {
  return Boolean(queryRow<{ has_history: number }>(
    `SELECT EXISTS(SELECT 1 FROM instagram_threads) OR
            EXISTS(SELECT 1 FROM instagram_messages) AS has_history`,
  )?.has_history);
}

function accountBindingAllows(accountId: string, expectedGeneration: number): boolean {
  const binding = queryRow<{ account_id: string | null; generation: number }>(
    "SELECT account_id, generation FROM instagram_account_binding WHERE id=1",
  );
  if (!binding || binding.generation !== expectedGeneration) return false;
  const hasHistory = hasHistoricalInstagramMessages();
  const legacyAccountId = (process.env.IG_ACCOUNT_ID ?? "").trim();
  const previousAccountId = binding.account_id ?? (legacyAccountId || null);
  return !hasHistory || previousAccountId === accountId;
}

async function safeProviderJson(response: globalThis.Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null;
  const text = await response.text();
  if (text.length > 64_000) return null;
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function providerGet(url: URL, token: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return safeProviderJson(response);
}

export async function completeInstagramOAuth(input: {
  code: string;
  state: string;
  sessionToken: string;
  adminUserId: number;
}): Promise<boolean> {
  const setup = oauthSetup();
  const connectionGeneration = consumeState(input.state, input.sessionToken, input.adminUserId);
  if (connectionGeneration === null) return false;
  if (setup.missingSetup.length || !input.code || input.code.length > 4096) return false;
  try {
    const exchangeForm = new URLSearchParams({
      client_id: setup.clientId,
      client_secret: setup.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: setup.redirectUri,
      code: input.code,
    });
    const exchangeResponse = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: exchangeForm.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const exchangePayload = await safeProviderJson(exchangeResponse);
    const shortTokenResponse = exchangePayload ? normalizedOAuthPayload(exchangePayload) : null;
    if (!shortTokenResponse || typeof shortTokenResponse.access_token !== "string") return false;
    const permissions = grantedScopes(shortTokenResponse);
    if (!REQUIRED_SCOPES.every((scope) => permissions.has(scope))) return false;
    const shortToken = shortTokenResponse.access_token;

    const longTokenUrl = new URL("https://graph.instagram.com/access_token");
    longTokenUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: setup.clientSecret,
      access_token: shortToken,
    }).toString();
    const longTokenResponse = await providerGet(longTokenUrl, shortToken);
    if (!longTokenResponse || typeof longTokenResponse.access_token !== "string") return false;
    const expirySeconds = Number(longTokenResponse.expires_in);
    if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) return false;
    const longToken = longTokenResponse.access_token;

    const meUrl = new URL("https://graph.instagram.com/me");
    meUrl.searchParams.set("fields", "user_id,username");
    const me = await providerGet(meUrl, longToken);
    const accountId = typeof me?.user_id === "string" || typeof me?.user_id === "number"
      ? String(me.user_id)
      : "";
    const username = typeof me?.username === "string" ? me.username : "";
    if (!/^[0-9]{1,32}$/.test(accountId) || !/^[A-Za-z0-9._]{1,64}$/.test(username)) return false;
    if (!accountBindingAllows(accountId, connectionGeneration)) return false;

    const subscribeUrl = new URL(`https://graph.instagram.com/v26.0/${encodeURIComponent(accountId)}/subscribed_apps`);
    subscribeUrl.searchParams.set("subscribed_fields", "messages");
    const subscribedResponse = await fetch(subscribeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${longToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const subscribed = await safeProviderJson(subscribedResponse);
    if (subscribed?.success !== true) return false;

    if (!setup.tokenEncryptionKey) return false;
    const encrypted = encryptToken(longToken, setup.tokenEncryptionKey);
    const now = new Date();
    const expiry = new Date(now.getTime() + expirySeconds * 1000).toISOString();
    return runImmediateTransaction(() => {
      const binding = queryRow<{ account_id: string | null; generation: number }>(
        "SELECT account_id, generation FROM instagram_account_binding WHERE id=1",
      );
      if (!binding || binding.generation !== connectionGeneration) return false;
      const legacyAccountId = (process.env.IG_ACCOUNT_ID ?? "").trim();
      const previousAccountId = binding.account_id ?? (legacyAccountId || null);
      if (hasHistoricalInstagramMessages() && (!previousAccountId || previousAccountId !== accountId)) return false;

      const switching = Boolean(previousAccountId && previousAccountId !== accountId);
      if (switching) invalidateInstagramSendJobs(now.toISOString());
      const newGeneration = binding.generation + 1;
      if (executeChanges(
        `UPDATE instagram_account_binding SET account_id=?, generation=?, updated_at=?
         WHERE id=1 AND generation=?`,
        [accountId, newGeneration, now.toISOString(), binding.generation],
      ) !== 1) return false;
      executeChanges(
        `INSERT INTO instagram_connections
           (id, account_id, account_username, token_ciphertext, token_nonce, token_auth_tag,
            token_key_version, token_expires_at, connected_at, updated_at)
         VALUES(1,?,?,?,?,?,'primary',?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           account_id=excluded.account_id, account_username=excluded.account_username,
           token_ciphertext=excluded.token_ciphertext, token_nonce=excluded.token_nonce,
           token_auth_tag=excluded.token_auth_tag, token_key_version='primary',
           token_expires_at=excluded.token_expires_at,
           connected_at=excluded.connected_at, updated_at=excluded.updated_at`,
        [
          accountId,
          username,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          expiry,
          now.toISOString(),
          now.toISOString(),
        ],
      );
      return true;
    });
  } catch {
    // Provider bodies and credentials are intentionally never logged or returned.
    return false;
  }
}

function invalidateInstagramSendJobs(now: string, reason = "account_changed"): void {
  const lease = queryRow<{
    lease_token: string | null;
    lease_queue_id: number | null;
    lease_revision: number | null;
    lease_stage: "processing" | "sending" | null;
  }>("SELECT lease_token, lease_queue_id, lease_revision, lease_stage FROM instagram_send_state WHERE id=1");
  const sending = queryRows<{
    id: number;
    thread_id: number;
    revision: number;
  }>("SELECT id, thread_id, revision FROM instagram_send_queue WHERE state='sending' ORDER BY id");
  executeChanges(
    `UPDATE instagram_send_queue SET state='failed', error=?, updated_at=?
     WHERE state='pending'`,
    [reason, now],
  );
  for (const item of sending) {
    const isKnownPreFetch =
      Boolean(lease?.lease_token) &&
      lease?.lease_queue_id === item.id &&
      lease.lease_revision === item.revision &&
      lease.lease_stage === "processing";
    const failure = isKnownPreFetch ? reason : "send_outcome_uncertain";
    executeChanges(
      `UPDATE instagram_send_queue SET state='failed', error=?, updated_at=?
       WHERE id=? AND state='sending' AND revision=?`,
      [failure, now, item.id, item.revision],
    );
    if (!isKnownPreFetch) {
      executeChanges(
        "UPDATE instagram_threads SET error=?, status=CASE WHEN customer_id IS NOT NULL OR status='converted' THEN 'converted' ELSE 'needs_human' END, updated_at=? WHERE id=?",
        [failure, now, item.thread_id],
      );
    }
  }
  executeChanges(
    `UPDATE instagram_send_state
        SET lease_token=NULL, lease_expires_at=NULL, lease_queue_id=NULL,
            lease_revision=NULL, lease_stage=NULL
      WHERE id=1`,
  );
}

export function disconnectInstagram(): void {
  runImmediateTransaction(() => {
    const now = new Date().toISOString();
    const legacyAccountId = (process.env.IG_ACCOUNT_ID ?? "").trim();
    if (legacyAccountId) {
      executeChanges(
        "UPDATE instagram_account_binding SET account_id=? WHERE id=1 AND account_id IS NULL",
        [legacyAccountId],
      );
    }
    executeChanges("DELETE FROM instagram_connections WHERE id=1");
    executeChanges("DELETE FROM instagram_oauth_states");
    executeChanges(
      "UPDATE instagram_account_binding SET generation=generation+1, updated_at=? WHERE id=1",
      [now],
    );
    invalidateInstagramSendJobs(now, "connection_disconnected");
  });
}