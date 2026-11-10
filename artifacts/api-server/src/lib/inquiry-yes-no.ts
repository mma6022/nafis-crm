/**
 * Today inquiry-column labels: raw English yes/no become Persian.
 * Official credit ranks (A1, A2, …) and already-Persian text stay unchanged.
 */
export function inquiryYesNoFa(value: unknown): string {
  const s = String(value ?? "").trim();
  const k = s.toLowerCase();
  if (k === "yes" || k === "true") return "دارد";
  if (k === "no" || k === "false") return "ندارد";
  return s;
}

/** Condition chips under «ضامن دارد» in the Today file / inquiry column. */
export function inquiryGuarantorCondBits(
  a: Record<string, unknown>,
  jobLabels: Record<string, string> = {},
): string[] {
  const bits: string[] = [];
  if (a.guarantorCheque) bits.push(`چک ضامن: ${inquiryYesNoFa(a.guarantorCheque)}`);
  if (a.gRank) bits.push(`رتبهٔ ضامن ${a.gRank}`);
  if (a.gJobType) bits.push(`شغل ضامن: ${jobLabels[String(a.gJobType)] ?? a.gJobType}`);
  if (typeof a.guarantorCondition === "string" && a.guarantorCondition.trim()) bits.push(a.guarantorCondition.trim());
  // Map any leftover standalone yes/no token in other bits (not ranks like A1/A2).
  return bits.map((b) => b.replace(/(^|:\s*)(yes|true)$/i, "$1دارد").replace(/(^|:\s*)(no|false)$/i, "$1ندارد"));
}
