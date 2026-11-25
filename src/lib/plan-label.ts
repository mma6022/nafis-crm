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

const LANDTECH_PROVIDER = "لندتک";

/** Bale plan-choice list/card label: the loan_plans.name, plus the bank when the
 *  name does not already contain it. Drops the «لندتک» provider prefix (every plan
 *  is Landtech). Does not invent a name when name is empty or itself «لندتک» —
 *  those fall back to the bank only. Not for contracts, sign reminders, or
 *  tracking cards (those still use planLabelForCustomer). */
export function planChoiceLabel(planName: string | null | undefined, bankName: string | null | undefined): string {
  const name = String(planName ?? "").trim();
  const rawBank = String(bankName ?? "").trim().replace(/\s+/g, " ");
  const bank = publicBankNames(bankName);
  const usable = name && name !== LANDTECH_PROVIDER ? name : "";
  if (usable) {
    const nameNorm = usable.replace(/\s+/g, " ");
    if (bank && !nameNorm.includes(bank) && !(rawBank && nameNorm.includes(rawBank))) {
      // Live name+bank pairs stay well under typical Bale button limits (~64).
      return `${usable} / ${bank}`;
    }
    return usable;
  }
  return bank;
}

/** Internal CRM label: loan_plans.name first. Fall back to the old bank-based «لندتک / {بانک}» only when the name is empty.
 *  Customer-facing Bale / portal copy still uses planLabelForCustomer. Never writes loan_plans. */
/** t856: «طرح X» without doubling — a plan name that already starts with «طرح» (then space/ZWNJ/end) is kept as-is.
 *  Same rule as the UI withPlanPrefix. Display only; never writes loan_plans. */
export function withPlanPrefix(label: string | null | undefined): string {
  const s = String(label ?? "").trim();
  if (!s) return "طرح";
  return /^طرح(?=[\s\u200c]|$)/.test(s) ? s : `طرح ${s}`;
}

export function internalPlanLabel(planName: string | null | undefined, bankName: string | null | undefined): string {
  const name = String(planName ?? "").trim();
  if (name) return name;
  return planLabelForCustomer(bankName);
}

