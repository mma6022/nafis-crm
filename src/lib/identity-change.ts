// Rule for customers.identity_changed_at (which invalidates earlier credit checks
// and identity documents): it moves only when an identity value that already
// existed is replaced by a different one. Filling an empty field is completion,
// not a change. Values equal after whitespace, ZWNJ, Persian/Arabic digit and
// Arabic yeh/kaf normalisation are treated as unchanged.
// Verification resets (verification_status etc.) are NOT governed by this rule;
// callers keep their own "any difference" checks for those.

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

export function normIdentityValue(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - PERSIAN_ZERO))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - ARABIC_ZERO))
    .replace(/\u064a/g, "\u06cc")
    .replace(/\u0649/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(/[\u200c\u200d\u200e\u200f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True only when a non-empty previous value is replaced by a different (or emptied) value. */
export function identityValueChanged(previous: unknown, next: unknown): boolean {
  const before = normIdentityValue(previous);
  if (!before) return false;
  return before !== normIdentityValue(next);
}

/** True when any pair [previous, next] is an identity change under the rule above. */
export function identityValuesChanged(pairs: Array<[unknown, unknown]>): boolean {
  return pairs.some(([previous, next]) => identityValueChanged(previous, next));
}
