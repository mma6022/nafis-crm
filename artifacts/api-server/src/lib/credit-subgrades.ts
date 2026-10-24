/**
 * Credit grade («رتبه‌ی اعتبارسنجی») as 15 sub-grades A1 … E3 (A1 best, E3 weakest).
 *
 * Rules (PM decision, 2026-10-24):
 *  - Matching is exact by sub-grade.
 *  - An old bare letter ("B") on the customer/consultation side matches any of its sub-grades (B1, B2, B3).
 *  - A bare letter left in a plan rule or in a historical snapshot means "all three sub-grades", so plans that
 *    were not migrated yet (or snapshots, which are never rewritten) behave exactly as before.
 *  - "unknown" is not a grade; callers keep their own handling for it.
 */
export const GRADE_LETTERS = ["A", "B", "C", "D", "E"] as const;
export const CREDIT_SUBGRADES: readonly string[] = GRADE_LETTERS.flatMap(letter => [1, 2, 3].map(n => `${letter}${n}`));
export const LEGACY_GRADE_SUFFIX = " (قدیمی)";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Upper-case, Latin digits, no spaces: " b ۲" → "B2". */
export function normalizeGrade(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/\s+/g, "")
    .toUpperCase();
}
export const isSubgrade = (value: unknown): boolean => /^[A-E][1-3]$/.test(normalizeGrade(value));
export const isLegacyGradeLetter = (value: unknown): boolean => /^[A-E]$/.test(normalizeGrade(value));
export const gradeLetter = (value: unknown): string => { const v = normalizeGrade(value); return /^[A-E]/.test(v) ? v[0] : ""; };

/** Plan-rule list → sub-grades. Bare letters become their three sub-grades; order and other values are kept. */
export function expandRankList(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const push = (v: string) => { if (!out.includes(v)) out.push(v); };
  for (const raw of values) {
    const v = normalizeGrade(raw);
    if (!v) continue;
    if (/^[A-E]$/.test(v)) for (const n of [1, 2, 3]) push(`${v}${n}`);
    else push(v);
  }
  return out;
}

/** Display: a letter whose three sub-grades are all present is shown as the letter, so "A1/A2/A3/B1/B2/B3" reads "A/B". */
export function compactRankList(values: readonly unknown[]): string[] {
  const list = expandRankList(values);
  const out: string[] = [];
  for (const v of list) {
    const letter = /^[A-E][1-3]$/.test(v) ? v[0] : "";
    if (letter && [1, 2, 3].every(n => list.includes(`${letter}${n}`))) { if (!out.includes(letter)) out.push(letter); }
    else out.push(v);
  }
  return out;
}

/**
 * Does a grade value (customer verified sub-grade, consultation's declared grade, or team-sales answer) satisfy a
 * plan rule's list? Empty value never matches; callers decide what an empty rule list means.
 */
export function gradeMatches(value: unknown, permitted: readonly unknown[]): boolean {
  const v = normalizeGrade(value);
  if (!v) return false;
  const allowed = expandRankList(permitted);
  if (/^[A-E]$/.test(v)) return allowed.some(p => p === v || (p.length === 2 && p[0] === v && /^[1-3]$/.test(p[1])));
  return allowed.includes(v);
}

/** Parses a stored rank list (JSON array, or old comma text). */
export function parseStoredRanks(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  const text = String(raw).trim();
  if (!text) return [];
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean); } catch { /* comma text */ }
  return text.split(/[,،]/).map(s => s.replace(/[[\]"]/g, "").trim()).filter(Boolean);
}

/** For AI / text consumers that read the raw JSON column: compacted so a migrated plan reads the same as before. */
export function compactRankJson(raw: unknown): unknown {
  if (raw == null || raw === "") return raw;
  const list = parseStoredRanks(raw);
  if (!list.length) return raw;
  const compact = compactRankList(list);
  // Unchanged lists (not migrated yet) are returned byte-for-byte.
  if (compact.length === list.length && compact.every((v, i) => v === list[i])) return raw;
  return JSON.stringify(compact);
}

/**
 * Editing rule: an old value kept unchanged is accepted as-is (even a retired letter); any new or changed value
 * must be one of the 15 sub-grades (or an active dictionary option). Empty clears. Returns the value to store, or null when rejected.
 */
export function acceptedGradeEdit(
  next: unknown, previous: unknown, activeOptions: readonly string[] = [],
): { ok: true; value: string | null } | { ok: false } {
  if (next == null || String(next).trim() === "") return { ok: true, value: null };
  const raw = String(next).trim();
  if (previous != null && normalizeGrade(previous) === normalizeGrade(raw)) return { ok: true, value: String(previous) };
  // An active dictionary choice is always valid (A–E rows are deactivated by the migration, so they stop counting).
  if (activeOptions.includes(raw)) return { ok: true, value: raw };
  if (isSubgrade(raw)) return { ok: true, value: normalizeGrade(raw) };
  return { ok: false };
}
export const GRADE_EDIT_ERROR = "رتبه اعتبارسنجی را از زیررتبه‌های A1 تا E3 انتخاب کنید.";
