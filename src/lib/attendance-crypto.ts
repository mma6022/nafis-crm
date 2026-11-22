/**
 * Seals the optional device comm key (AES-256-GCM).
 * Key is derived from SESSION_SECRET (already required to boot). Plaintext is never logged.
 * If SESSION_SECRET is rotated, the comm key must be entered again.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "attendance-comm-key-v1:";

function keyBytes(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("attendance_key_missing");
  return createHash("sha256").update(PREFIX).update(secret).digest();
}

export function sealCommKey(plaintext: string): string {
  const key = keyBytes();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("attendance-comm-key"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function openCommKey(value: string): string {
  const [v, iv, tag, ct] = String(value).split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("attendance_bad_ciphertext");
  const d = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from("attendance-comm-key"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export function commKeyNumber(plaintext: string | null | undefined): number {
  const s = String(plaintext ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("bad_comm_key");
  return n;
}
