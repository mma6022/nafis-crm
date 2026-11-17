/**
 * Persistent CRM file roots. The live process has cwd under /opt/nafisvam/current
 * (a symlink into releases/<build>) and the default DB path is
 * attached_assets/customers_*.db, which itself is a symlink to
 * /var/lib/nafisvam/customers.db. Using dirname(databasePath) without realpath
 * therefore writes identity and loan documents into the release tree. After the
 * next deploy the new identityRootReal no longer prefixes those paths (preview
 * 404) and, once the old release is pruned, fileExists is false so approval is
 * blocked. Resolve the real data directory — the same pattern smart-filing uses.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const IDENTITY_STORE = "customer-identity-documents";
export const LOAN_FILE_STORE = "loan-application-files";
export const PROFILE_STORE = "customer-profile-documents";

export type DocumentStoreKind = "identity" | "loan" | "profile";

const STORE_NAME: Record<DocumentStoreKind, string> = {
  identity: IDENTITY_STORE,
  loan: LOAN_FILE_STORE,
  profile: PROFILE_STORE,
};

export function resolveCrmDataDir(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  try { return path.dirname(fs.realpathSync(resolved)); } catch { return path.dirname(resolved); }
}

export function documentStoreDir(dataDir: string, kind: DocumentStoreKind): string {
  const root = path.join(dataDir, STORE_NAME[kind]);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch { /* best-effort private mode */ }
  return root;
}

export function realDocumentStoreDir(dataDir: string, kind: DocumentStoreKind): string {
  const root = documentStoreDir(dataDir, kind);
  try { return fs.realpathSync(root); } catch { return root; }
}

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** True when a stored path is a regular file under the persistent data dir or a legacy release store. */
export function isAllowedStoredFile(rawPath: unknown, dataDir: string, kind: DocumentStoreKind): boolean {
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;
  const real = realpathOrNull(rawPath);
  if (!real) return false;
  try { if (!fs.statSync(real).isFile()) return false; } catch { return false; }
  const stable = realDocumentStoreDir(dataDir, kind);
  if (real.startsWith(stable + path.sep)) return true;
  const store = STORE_NAME[kind];
  const attached = `${path.sep}attached_assets${path.sep}${store}${path.sep}`;
  if (real.includes(attached) && real.includes(`${path.sep}releases${path.sep}`)) return true;
  const unresolved = path.join(dataDir, store);
  const unresolvedReal = realpathOrNull(unresolved);
  if (unresolvedReal && real.startsWith(unresolvedReal + path.sep)) return true;
  return false;
}

export function fileExistsOnDisk(rawPath: unknown): boolean {
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;
  try { return fs.statSync(fs.realpathSync(rawPath)).isFile(); } catch { return false; }
}

/**
 * If the file still exists but lives in a legacy release folder, copy it into
 * the persistent store and return the new path. The caller updates the DB.
 * Never deletes the original. Returns the existing path when already stable
 * or when the source is missing / not allowed.
 */
export function migrateStoredFileToDataDir(
  rawPath: unknown,
  dataDir: string,
  kind: DocumentStoreKind,
  ownerId: number,
): string | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  if (!fileExistsOnDisk(rawPath)) return null;
  const real = realpathOrNull(rawPath);
  if (!real) return null;
  // Only move files we would already serve (stable or legacy release store).
  if (!isAllowedStoredFile(rawPath, dataDir, kind)) return real.startsWith(realDocumentStoreDir(dataDir, kind) + path.sep) ? real : null;
  const stable = realDocumentStoreDir(dataDir, kind);
  if (real.startsWith(stable + path.sep)) return real;
  const ext = path.extname(real) || "";
  const dir = path.join(stable, String(ownerId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${crypto.randomUUID()}${ext || ".bin"}`);
  fs.copyFileSync(real, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* best-effort */ }
  return dest;
}
