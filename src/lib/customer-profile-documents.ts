/** Vault for customer-level plan documents (employment / residence proofs). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execute, executeChanges, queryRow } from "./crm-db";
import {
  documentStoreDir,
  fileExistsOnDisk,
  isAllowedStoredFile,
  migrateStoredFileToDataDir,
} from "./crm-data-dir";
import { isCustomerLevelDocumentKey } from "./sf816-documents";

export type ProfileDocumentRow = {
  id: number;
  customer_id: number;
  document_type: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  approved_at: string | null;
  version: number;
};

function copyIntoProfileStore(src: string, dataDir: string, customerId: number): string {
  const root = documentStoreDir(dataDir, "profile");
  const dir = path.join(root, String(customerId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = path.extname(src) || ".bin";
  const dest = path.join(dir, `${crypto.randomUUID()}${ext}`);
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* best-effort */ }
  return dest;
}

export function latestApprovedProfileDocument(
  customerId: number,
  documentType: string,
  dataDir: string,
): ProfileDocumentRow | null {
  if (!isCustomerLevelDocumentKey(documentType)) return null;
  const row = queryRow<ProfileDocumentRow>(
    `SELECT id,customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,approved_at,version
     FROM customer_profile_documents
     WHERE customer_id=? AND document_type=? AND is_latest=1 AND approved_at IS NOT NULL`,
    [customerId, documentType],
  );
  if (!row) return null;
  const migrated = migrateStoredFileToDataDir(row.storage_path, dataDir, "profile", customerId)
    || migrateStoredFileToDataDir(row.storage_path, dataDir, "loan", customerId);
  if (migrated && migrated !== row.storage_path) {
    executeChanges("UPDATE customer_profile_documents SET storage_path=? WHERE id=?", [migrated, row.id]);
    row.storage_path = migrated;
  }
  if (!fileExistsOnDisk(row.storage_path)) return null;
  return row;
}

export function rememberApprovedPlanDocument(opts: {
  customerId: number;
  documentType: string;
  storagePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  actorId: number;
  approvedAt: string;
  dataDir: string;
}): number | null {
  if (!isCustomerLevelDocumentKey(opts.documentType) || !fileExistsOnDisk(opts.storagePath)) return null;
  const dest = copyIntoProfileStore(opts.storagePath, opts.dataDir, opts.customerId);
  const digest = (() => {
    try { return crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex"); } catch { return null; }
  })();
  executeChanges(
    "UPDATE customer_profile_documents SET is_latest=0 WHERE customer_id=? AND document_type=? AND is_latest=1",
    [opts.customerId, opts.documentType],
  );
  const previous = queryRow<{ version: number }>(
    "SELECT COALESCE(MAX(version),0) AS version FROM customer_profile_documents WHERE customer_id=? AND document_type=?",
    [opts.customerId, opts.documentType],
  );
  return execute(
    `INSERT INTO customer_profile_documents(
      customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,
      created_by_user_id,created_at,version,is_latest,approved_at,approved_by_user_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [
      opts.customerId, opts.documentType, dest, opts.originalName, opts.mimeType, opts.sizeBytes, digest,
      opts.actorId, opts.approvedAt, Number(previous?.version ?? 0) + 1, opts.approvedAt, opts.actorId,
    ],
  );
}

export function seedPlanSlotFromVault(opts: {
  applicationId: number;
  customerId: number;
  documentType: string;
  label: string;
  createdAt: string;
  dataDir: string;
}): boolean {
  const vault = latestApprovedProfileDocument(opts.customerId, opts.documentType, opts.dataDir);
  if (!vault) return false;
  execute(
    `INSERT INTO loan_application_documents(
      application_id,requirement_key,label,source,status,storage_path,original_name,mime_type,size_bytes,
      created_at,reviewed_at,customer_profile_document_id
    ) VALUES(?,?,?,'plan','approved',?,?,?,?,?,?,?)`,
    [
      opts.applicationId, opts.documentType, opts.label, vault.storage_path, vault.original_name,
      vault.mime_type, vault.size_bytes, opts.createdAt, vault.approved_at, vault.id,
    ],
  );
  return true;
}

export function isReusableCustomerDocument(row: { customer_profile_document_id?: number | null; status?: string }): boolean {
  return Boolean(row.customer_profile_document_id) && row.status === "approved";
}

export function profileOrLoanFileAllowed(rawPath: unknown, dataDir: string): boolean {
  return isAllowedStoredFile(rawPath, dataDir, "loan") || isAllowedStoredFile(rawPath, dataDir, "profile");
}
