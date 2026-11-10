/** Multi-word bank names that must never be split on the " - " list joiner
 *  used in some loan_plans.bank_name values. */
const SINGLE_BANK_NAMES = ["اقتصاد نوین", "های بانک", "بانک ملی", "بانک ملت", "بانک سامان"];

/** Customer-facing bank field: keep a single bank intact, and only turn true
 *  multi-bank " - " lists into Persian commas. */
export function publicBankNames(bankName: string | null | undefined): string {
  let s = String(bankName ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  for (const name of SINGLE_BANK_NAMES) {
    const hyphenated = name.split(" ").join(" - ");
    if (hyphenated !== name) s = s.split(hyphenated).join(name);
  }
  return s.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean).join("، ");
}

/** Public plan label: only «لندتک / {نام بانک}». Never chops a single bank name. */
export function planLabelForCustomer(bankName: string | null | undefined): string {
  const bank = publicBankNames(bankName);
  return bank ? `لندتک / ${bank}` : "لندتک";
}
