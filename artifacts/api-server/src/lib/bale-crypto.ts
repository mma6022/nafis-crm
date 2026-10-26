/**
 * «حساب شخصی بله» session sealing: AES-256-GCM with a 32-byte key read from a separate key FILE (never crm.env, never
 * the DB), so DB/env backups never carry a usable Bale session. Path: env BALE_SESSION_KEY_FILE (optional
 * BALE_SESSION_KEY_FILE_PREVIOUS for rotation). File content: base64 (32 bytes) or 64 hex chars.
 * Ciphertext format (same as smart-filing-crypto.ts): v1:<keyId>:<iv>:<tag>:<ct>. AAD binds a ciphertext to one
 * bale_accounts row, so a sealed session cannot be copied onto another expert's row.
 * The key and the plaintext session are never logged, returned or printed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

export type KeyEnv = Record<string, string | undefined>;
type Key = { id: string; bytes: Buffer };
const cache = new Map<string, { mtimeMs: number; size: number; key: Key | null }>();

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return b.length === 32 ? b : null;
  }
  return null;
}

function readKeyFile(file: string | undefined): Key | null {
  if (!file || !file.trim()) return null;
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.key;
    const bytes = parseKey(fs.readFileSync(file, "utf8"));
    const key = bytes ? { id: createHash("sha256").update(Buffer.concat([Buffer.from("bale-session:"), bytes])).digest("hex").slice(0, 8), bytes } : null;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key });
    return key;
  } catch { return null; }
}

export function baleCurrentKey(env: KeyEnv): Key | null { return readKeyFile(env.BALE_SESSION_KEY_FILE); }
export function baleHasKey(env: KeyEnv): boolean { return baleCurrentKey(env) !== null; }
function keyById(env: KeyEnv, id: string): Key | null {
  for (const k of [readKeyFile(env.BALE_SESSION_KEY_FILE), readKeyFile(env.BALE_SESSION_KEY_FILE_PREVIOUS)]) if (k && k.id === id) return k;
  return null;
}

export class BaleKeyMissing extends Error { constructor() { super("bale_session_key_missing"); } }
export const baleSessionAad = (accountId: number, userId: number) => `bale-session:${accountId}:${userId}`;

export function sealBaleSession(env: KeyEnv, plaintext: string, aad: string): { value: string; keyId: string } {
  const key = baleCurrentKey(env); if (!key) throw new BaleKeyMissing();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key.bytes, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { value: ["v1", key.id, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":"), keyId: key.id };
}

/** Plaintext plus, when sealed with the previous key, a re-sealed value under the current key (lazy rotation). */
export function openBaleSession(env: KeyEnv, value: string, aad: string): { plaintext: string; rotated: { value: string; keyId: string } | null } {
  const [v, id, iv, tag, ct] = String(value).split(":");
  if (v !== "v1" || !id || !iv || !tag || ct === undefined) throw new Error("bale_bad_ciphertext");
  const key = keyById(env, id); if (!key) throw new BaleKeyMissing();
  const d = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64")); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  const cur = baleCurrentKey(env);
  return { plaintext, rotated: cur && cur.id !== id ? sealBaleSession(env, plaintext, aad) : null };
}

/** Internal API↔sidecar token: read from BALE_SIDECAR_TOKEN_FILE (never an env value, never logged). */
export function baleSidecarToken(env: KeyEnv): string | null {
  const f = env.BALE_SIDECAR_TOKEN_FILE; if (!f || !f.trim()) return null;
  try { const t = fs.readFileSync(f, "utf8").trim(); return t.length >= 32 ? t : null; } catch { return null; }
}
