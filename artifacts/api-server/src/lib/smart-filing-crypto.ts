/**
 * «ثبت هوشمند» secrets: AES-256-GCM with a 32-byte key read from a separate key FILE (never crm.env), so the
 * regular env/DB backups never carry it. Path: env SMART_FILING_KEY_FILE (optional SMART_FILING_KEY_FILE_PREVIOUS
 * for rotation). File content: base64 (32 bytes) or 64 hex chars. Ciphertext format: v1:<keyId>:<iv>:<tag>:<ct>.
 * The key is never logged, returned or printed. Losing the key only means re-entering panel passwords.
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
    const key = bytes ? { id: createHash("sha256").update(bytes).digest("hex").slice(0, 8), bytes } : null;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key });
    return key;
  } catch { return null; }
}

export function currentKey(env: KeyEnv): Key | null { return readKeyFile(env.SMART_FILING_KEY_FILE); }
export function hasKey(env: KeyEnv): boolean { return currentKey(env) !== null; }
function keyById(env: KeyEnv, id: string): Key | null {
  for (const k of [readKeyFile(env.SMART_FILING_KEY_FILE), readKeyFile(env.SMART_FILING_KEY_FILE_PREVIOUS)]) if (k && k.id === id) return k;
  return null;
}

export class SmartFilingKeyMissing extends Error { constructor() { super("smart_filing_key_missing"); } }

export function encryptSecret(env: KeyEnv, plaintext: string, aad: string): { value: string; keyId: string } {
  const key = currentKey(env); if (!key) throw new SmartFilingKeyMissing();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key.bytes, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { value: ["v1", key.id, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":"), keyId: key.id };
}

/** Returns the plaintext and, when it was sealed with the previous key, a re-encrypted value with the current key (lazy rotation). */
export function decryptSecret(env: KeyEnv, value: string, aad: string): { plaintext: string; rotated: { value: string; keyId: string } | null } {
  const [v, id, iv, tag, ct] = String(value).split(":");
  if (v !== "v1" || !id || !iv || !tag || ct === undefined) throw new Error("smart_filing_bad_ciphertext");
  const key = keyById(env, id); if (!key) throw new SmartFilingKeyMissing();
  const d = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64")); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  const cur = currentKey(env);
  return { plaintext, rotated: cur && cur.id !== id ? encryptSecret(env, plaintext, aad) : null };
}

/** HMAC key for the optional runner webhook, derived from the encryption key (never the key itself). */
export function webhookKey(env: KeyEnv): Buffer | null {
  const key = currentKey(env); return key ? createHash("sha256").update(Buffer.concat([Buffer.from("smart-filing-webhook:"), key.bytes])).digest() : null;
}
