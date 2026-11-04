/**
 * «گفتگوی بله داخل پنل کارشناس»: bot-token encryption. Same scheme as bale-crypto.ts (AES-256-GCM, v1:<keyId>:<iv>:<tag>:<ct>)
 * but its OWN key file (BALE_BOT_KEY_FILE, optional BALE_BOT_KEY_FILE_PREVIOUS for rotation) and its own key-id label, so a
 * personal-account session key can never open a bot token and vice versa. AAD binds the ciphertext to the bale_bots row and
 * the expert's users.id: a token copied to another row/expert does not decrypt.
 * Key file: base64 of 32 bytes or 64 hex chars, chmod 600. The key is never logged; a missing key → BaleBotKeyMissing.
 */
import fs from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type BotKeyEnv = { BALE_BOT_KEY_FILE?: string; BALE_BOT_KEY_FILE_PREVIOUS?: string };
type Key = { id: string; bytes: Buffer };

function readKeyFile(file: string | undefined): Key | null {
  if (!file || !file.trim()) return null;
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8").trim(); } catch { return null; }
  let bytes: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) bytes = Buffer.from(raw, "hex");
  else { try { const b = Buffer.from(raw, "base64"); if (b.length === 32) bytes = b; } catch { bytes = null; } }
  if (!bytes || bytes.length !== 32) return null;
  return { id: createHash("sha256").update("bale-bot-token:").update(bytes).digest("hex").slice(0, 8), bytes };
}
const currentKey = (env: BotKeyEnv) => readKeyFile(env.BALE_BOT_KEY_FILE);
export const baleBotHasKey = (env: BotKeyEnv) => currentKey(env) !== null;
function keyById(env: BotKeyEnv, id: string): Key | null {
  for (const k of [readKeyFile(env.BALE_BOT_KEY_FILE), readKeyFile(env.BALE_BOT_KEY_FILE_PREVIOUS)]) if (k && k.id === id) return k;
  return null;
}
export class BaleBotKeyMissing extends Error { constructor() { super("bale_bot_key_missing"); } }
export const baleBotAad = (botId: number, userId: number) => `bale-bot-token:${botId}:${userId}`;

export function sealBotToken(env: BotKeyEnv, plaintext: string, aad: string): { value: string; keyId: string } {
  const key = currentKey(env); if (!key) throw new BaleBotKeyMissing();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key.bytes, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { value: ["v1", key.id, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":"), keyId: key.id };
}
/** Plaintext plus a re-sealed value when it was sealed with the previous key (lazy rotation). Errors never carry the token. */
export function openBotToken(env: BotKeyEnv, value: string, aad: string): { plaintext: string; rotated: { value: string; keyId: string } | null } {
  const [v, id, iv, tag, ct] = String(value).split(":");
  if (v !== "v1" || !id || !iv || !tag || ct === undefined) throw new Error("bale_bot_bad_ciphertext");
  const key = keyById(env, id); if (!key) throw new BaleBotKeyMissing();
  let plaintext: string;
  try {
    const d = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64")); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, "base64"));
    plaintext = Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch { throw new Error("bale_bot_decrypt_failed"); }
  const cur = currentKey(env);
  return { plaintext, rotated: cur && cur.id !== id ? sealBotToken(env, plaintext, aad) : null };
}
