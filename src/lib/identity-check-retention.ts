import type { SapiVerificationInput, SapiVerificationResult } from "./sapi";

// Retention is scoped to each check's actual identity inputs, never just a
// customer id. Identity/profile edits invalidate the stored flags elsewhere.
export function retainedIdentityChecks(customer: {
  national_code: string | null; phone: string; birth_date_jalali: string | null;
  postal_code: string | null; shahkar_ok?: number | null; person_info_ok?: number | null;
  postal_code_info_ok?: number | null; sana_ok?: number | null;
  shahkar_status?: string | null; person_info_status?: string | null;
  postal_code_info_status?: string | null; sana_status?: string | null;
}, input: SapiVerificationInput, includeDefinitiveFailures = false): Partial<SapiVerificationResult["checks"]> {
  const nationalMatches = customer.national_code === input.nationalCode;
  const candidates = {
    shahkarLite: [nationalMatches && customer.phone === input.mobile, customer.shahkar_ok, customer.shahkar_status],
    personInfo: [nationalMatches && customer.birth_date_jalali === input.birthDateJalali, customer.person_info_ok, customer.person_info_status],
    postalCodeInfo: [customer.postal_code === input.postalCode, customer.postal_code_info_ok, customer.postal_code_info_status],
    sana: [nationalMatches, customer.sana_ok, customer.sana_status],
  } as const;
  const result: Partial<SapiVerificationResult["checks"]> = {};
  for (const key of Object.keys(candidates) as Array<keyof typeof candidates>) {
    const [matches, ok, status] = candidates[key];
    if (matches && (ok === 1 || status === "manual_rejected" ||
        (includeDefinitiveFailures && ok === 0 && status === "failed"))) {
      result[key] = { ok: ok === 1, providerStatus: status ?? "verified" };
    }
  }
  return result;
}