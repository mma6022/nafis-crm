/** A failed certificate preflight never uploaded a file or created a contract.
 * This exception is for issuance/send retries only, never signature evidence.
 */
export function isCertificatePreflightRetry(generation: {
  status?: unknown; error_message?: unknown; provider_file_id?: unknown; provider_contract_id?: unknown;
}): boolean {
  return generation.status === "failed" &&
    ["certificate_inactive", "provider_certificate_check_failed"].includes(String(generation.error_message)) &&
    !generation.provider_file_id && !generation.provider_contract_id;
}

/** Delivery recovery is issuance-only, never evidence of sending or signing.
 * A partly uploaded delivery may only resume its existing file and identity.
 * The caller must still verify scope, terms, immutable PDF and concurrency.
 */
export function isInterruptedDeliveryRetry(generation: {
  status?: unknown; error_message?: unknown;
  provider_file_id?: unknown; provider_contract_id?: unknown;
  provider_idempotency_key?: unknown; send_claim_id?: unknown;
}): boolean {
  return generation.status === "failed" &&
    ["stale_send", "provider_timeout", "provider_unavailable", "provider_delivery_failed",
      "provider_contract_send_failed", "provider_auth_failed", "provider_configuration",
      "certificate_inactive", "provider_certificate_check_failed"].includes(String(generation.error_message)) &&
    typeof generation.provider_file_id === "string" && Boolean(generation.provider_file_id.trim()) &&
    typeof generation.provider_idempotency_key === "string" && Boolean(generation.provider_idempotency_key.trim()) &&
    !generation.provider_contract_id && !generation.send_claim_id;
}
