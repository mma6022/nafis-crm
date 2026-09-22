/**
 * Credit ranks are an application-owned interpretation of the numeric score.
 * Provider labels are deliberately not accepted here: they are display data
 * from an external system and are not authoritative.
 */
export const CREDIT_RANK_RANGES = [
  ["A1", 680, 900],
  ["A2", 660, 679],
  ["A3", 640, 659],
  ["B1", 620, 639],
  ["B2", 600, 619],
  ["B3", 580, 599],
  ["C1", 560, 579],
  ["C2", 540, 559],
  ["C3", 520, 539],
  ["D1", 500, 519],
  ["D2", 480, 499],
  ["D3", 460, 479],
  ["E1", 440, 459],
  ["E2", 420, 439],
  ["E3", 0, 419],
] as const;

export type CreditRankResult =
  | { ok: true; rank: string }
  | { ok: false; reason: "missing" | "non_finite" | "out_of_range" };
type InvalidCreditScoreReason = "missing" | "non_finite" | "out_of_range";

export function deriveCreditRank(score: unknown): CreditRankResult {
  if (score === null || score === undefined || (typeof score === "string" && score.trim() === "")) {
    return { ok: false, reason: "missing" };
  }
  const numeric = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(numeric)) return { ok: false, reason: "non_finite" };
  if (numeric < 0 || numeric > 900) return { ok: false, reason: "out_of_range" };
  // Scores are normally integers, but interval boundaries remain continuous
  // so an unexpected fractional score can never fall between two ranks.
  const range = CREDIT_RANK_RANGES.find(([, minimum]) => numeric >= minimum);
  return range ? { ok: true, rank: range[0] } : { ok: false, reason: "out_of_range" };
}

export function creditRankForScore(score: unknown): string | null {
  const result = deriveCreditRank(score);
  return result.ok ? result.rank : null;
}

export function invalidCreditScoreMessage(reason: InvalidCreditScoreReason): string {
  if (reason === "missing") return "گزارش اعتبارسنجی امتیاز عددی ندارد.";
  if (reason === "non_finite") return "امتیاز گزارش اعتبارسنجی عددی معتبر نیست.";
  return "امتیاز گزارش اعتبارسنجی خارج از بازه معتبر ۰ تا ۹۰۰ است.";
}