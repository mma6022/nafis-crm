/**
 * t816u customer-level document reuse (Mohammad, 2026-11-17).
 * flag.sf816_customer_doc_reuse is ON by default (no row). A '0' row restores
 * the old per-case upload + re-approval behaviour, without a redeploy.
 *
 * Identity types are already stored on the customer (customer_identity_documents).
 * This module covers other stable KYC / legal proofs. Time-bound bank evidence
 * and per-loan collateral stay case-level.
 */
import { queryRow } from "./crm-db";

export const SF816_FLAG = "flag.sf816_customer_doc_reuse";

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; }
  catch { return null; }
};

/** ON by absence; a '0' row restores per-case asking and re-approval. */
export const sf816CustomerDocReuse = () => setting(SF816_FLAG) !== "0";

/** Stable KYC / legal proofs reused across loans once approved. */
export const CUSTOMER_LEVEL_DOCUMENT_KEYS = [
  "employment_proof",
  "residence_proof",
] as const;

/**
 * Per-loan or time-bound evidence. juale_contract is treated as case-level
 * because it is typically the contract for that facility, not a standing
 * customer file — confirm with Mohammad if it should move to the customer vault.
 */
export const CASE_LEVEL_DOCUMENT_KEYS = [
  "account_turnover_3_months",
  "account_turnover_6_months",
  "average_balance_3_months",
  "average_balance_6_months",
  "juale_contract",
  "guarantee_check",
  "guarantee_promissory",
] as const;

/** Already stored and approved on the customer (not plan rows). */
export const CUSTOMER_IDENTITY_DOCUMENT_KEYS = [
  "national_card",
  "national_card_front",
  "national_card_back",
  "birth_certificate_all_pages",
  "birth_cert_p1",
  "birth_cert_p2",
  "birth_cert_p3",
] as const;

const customerLevel = new Set<string>(CUSTOMER_LEVEL_DOCUMENT_KEYS);

export function isCustomerLevelDocumentKey(key: unknown): boolean {
  return customerLevel.has(String(key ?? ""));
}

export function documentScope(key: unknown): "customer" | "case" | "identity" {
  const k = String(key ?? "");
  if ((CUSTOMER_IDENTITY_DOCUMENT_KEYS as readonly string[]).includes(k)) return "identity";
  if (customerLevel.has(k)) return "customer";
  return "case";
}
