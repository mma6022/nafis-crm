// Pure (no DB): the mandatory reason for «نادیده گرفتن رتبه». Shared by the routes, the log and the fixtures.
export const CREDIT_RANK_OVERRIDE_REASON_MIN = 10;
export const CREDIT_RANK_OVERRIDE_REASON_MAX = 500;
/** Trimmed, whitespace-collapsed reason, or an error code. Length counts characters after normalising. */
export function normalizeOverrideReason(raw: unknown): { reason: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { error: "credit_rank_override_reason_required" };
  if (typeof raw !== "string") return { error: "invalid_credit_rank_override_reason" };
  const reason = raw.replace(/[\u200c\u200f\u200e]/g, " ").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "credit_rank_override_reason_required" };
  if ([...reason].length < CREDIT_RANK_OVERRIDE_REASON_MIN) return { error: "credit_rank_override_reason_too_short" };
  if ([...reason].length > CREDIT_RANK_OVERRIDE_REASON_MAX) return { error: "credit_rank_override_reason_too_long" };
  return { reason };
}

