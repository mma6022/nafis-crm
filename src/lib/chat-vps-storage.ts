import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const VPS_CHAT_PREFIX = "vps-private:customer-chat/";
const reference = /^vps-private:customer-chat\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

// Provision this private directory outside releases before enabling the adapter.
// Never create it or fall back to a release-local directory automatically.
function root() {
  const configured = process.env.CHAT_PRIVATE_STORAGE_DIR;
  if (!configured || !path.isAbsolute(configured) || path.resolve(configured) === "/") {
    throw new Error("chat_private_storage_not_configured");
  }
  const resolved = path.resolve(configured), stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resolved) !== resolved ||
      (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("chat_private_storage_insecure");
  }
  return resolved;
}
function filename(objectPath: string) {
  const match = reference.exec(objectPath);
  if (!match) throw new Error("invalid_private_object");
  return path.join(root(), match[1]);
}
export async function saveVpsChatObject(bytes: Buffer) {
  const objectPath = `${VPS_CHAT_PREFIX}${randomUUID()}`, target = filename(objectPath);
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await unlink(target);
    throw error;
  } finally {
    await file.close();
  }
  return objectPath;
}
export function readVpsChatObject(objectPath: string) {
  // Errors are delivered on the stream, including configuration/path errors.
  return Readable.from((async function* () {
    const file = await open(filename(objectPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new Error("chat_private_object_insecure");
      }
      for await (const chunk of file.createReadStream({ autoClose: false })) yield chunk;
    } finally {
      await file.close();
    }
  })());
}
export async function deleteVpsChatObject(objectPath: string) {
  try { await unlink(filename(objectPath)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
