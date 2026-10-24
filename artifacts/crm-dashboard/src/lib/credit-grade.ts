/* Credit sub-grades (A1 … E3) shared by every dashboard and portal screen.
   Design: nafis-design/screens/crm-credit-grade/HANDOFF.md. A1 is the best grade, E3 the worst.
   A bare letter (A … E) is a legacy value saved before sub-grades existed: it is shown as «قدیمی»,
   kept when unchanged, and may never be chosen as a new value. */

export const GRADE_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type GradeLetter = (typeof GRADE_LETTERS)[number];
export const SUB_LEVELS = ['1', '2', '3'] as const;
export const CREDIT_SUBGRADES: string[] = GRADE_LETTERS.flatMap((l) => SUB_LEVELS.map((n) => `${l}${n}`));
export const LEGACY_LABEL = 'قدیمی';

/** Arrow keys stop at the end of a row (HANDOFF open question: no wrap). Flip here only, once design confirms. */
export const ARROW_WRAP = false;

export type GradeColor = { main: string; text: string; bg1: string; bg2: string; bg3: string };
export const GRADE_COLORS: Record<GradeLetter, GradeColor> = {
  A: { main: '#15803D', text: '#14532D', bg1: '#BBF7D0', bg2: '#DCFCE7', bg3: '#F0FDF4' },
  B: { main: '#4D7C0F', text: '#365314', bg1: '#D9F99D', bg2: '#ECFCCB', bg3: '#F7FEE7' },
  C: { main: '#A16207', text: '#713F12', bg1: '#FDE68A', bg2: '#FEF3C7', bg3: '#FFFBEB' },
  D: { main: '#C2410C', text: '#7C2D12', bg1: '#FED7AA', bg2: '#FFEDD5', bg3: '#FFF7ED' },
  E: { main: '#B91C1C', text: '#7F1D1D', bg1: '#FECACA', bg2: '#FEE2E2', bg3: '#FEF2F2' },
};
export const GRADE_FOCUS = '#29369B';
export const GRADE_RING = '#00006D';

export const normalizeGrade = (value: string | null | undefined): string => (value ?? '').trim().toUpperCase();
export const isSubgrade = (value: string | null | undefined): boolean => /^[A-E][1-3]$/.test(normalizeGrade(value));
/** A stored bare letter: legacy, shown with «قدیمی». */
export const isLegacy = (value: string | null | undefined): boolean => /^[A-E]$/.test(normalizeGrade(value));
export const isGradeValue = (value: string | null | undefined): boolean => isSubgrade(value) || isLegacy(value);
export const gradeLetter = (value: string | null | undefined): GradeLetter | null => {
  const v = normalizeGrade(value);
  return /^[A-E]/.test(v) && v.length <= 2 && isGradeValue(v) ? (v[0] as GradeLetter) : null;
};
export const gradeLevel = (value: string | null | undefined): 1 | 2 | 3 | null => isSubgrade(value) ? (Number(normalizeGrade(value)[1]) as 1 | 2 | 3) : null;
/** 1 (A1) … 15 (E3); a legacy letter sorts after its sub-grades, unknown values last. */
export const gradeSortKey = (value: string | null | undefined): number => {
  const l = gradeLetter(value);
  if (!l) return 99;
  const base = GRADE_LETTERS.indexOf(l) * 3;
  return base + (gradeLevel(value) ?? 3.5);
};
/** For a letter filter: B matches B, B1, B2, B3. */
export const matchesLetter = (value: string | null | undefined, letter: GradeLetter): boolean => gradeLetter(value) === letter;
export const gradeColor = (value: string | null | undefined): GradeColor | null => {
  const l = gradeLetter(value);
  return l ? GRADE_COLORS[l] : null;
};
/** Background of a sub-grade (1 → bg1 … 3 → bg3); a letter uses bg2. */
export const gradeBg = (value: string | null | undefined): string => {
  const c = gradeColor(value);
  if (!c) return '#F3F4F6';
  const lv = gradeLevel(value);
  return lv === 1 ? c.bg1 : lv === 3 ? c.bg3 : c.bg2;
};
export const subgradesOf = (letter: GradeLetter): string[] => SUB_LEVELS.map((n) => `${letter}${n}`);

/** Plan conditions: legacy letters expand to their three sub-grades, order kept, no duplicates. */
export function expandGradeList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = normalizeGrade(raw);
    for (const x of isLegacy(v) ? subgradesOf(v as GradeLetter) : [isSubgrade(v) ? v : raw.trim()]) if (x && !out.includes(x)) out.push(x);
  }
  return out;
}
/** Sub-grades in A1 … E3 order (non-grade values kept at the end). */
export const sortGrades = (values: readonly string[]): string[] => [...values].sort((a, b) => gradeSortKey(a) - gradeSortKey(b));
/** Bare letters in a list, unique and in A…E order. */
export const legacyLettersIn = (values: readonly string[]): GradeLetter[] => GRADE_LETTERS.filter((l) => values.some((v) => normalizeGrade(v) === l));

/** Editing rule (PM decision 4): an unchanged stored value is kept; any new value must be a sub-grade. */
export function gradeEditAccepted(value: string | null | undefined, original: string | null | undefined): boolean {
  const v = normalizeGrade(value);
  if (!v) return true;
  if (isSubgrade(v)) return true;
  return v === normalizeGrade(original) && isLegacy(v);
}

/** Display text: sub-grade as is, legacy «B (قدیمی)», else the dictionary label or the raw value. */
export function gradeText(value: string | null | undefined, fallback = 'ثبت نشده'): string {
  const v = normalizeGrade(value);
  if (!v) return fallback;
  if (isSubgrade(v)) return v;
  if (isLegacy(v)) return `${v} (${LEGACY_LABEL})`;
  return (value ?? '').trim();
}

/* Typed shortcuts: Latin a–e, the same keys on a Persian keyboard (ش ذ ز ی ث), digits 1–3 in Latin or Persian. */
const TYPED_LETTERS: Record<string, GradeLetter> = { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', 'ش': 'A', 'ذ': 'B', 'ز': 'C', 'ی': 'D', 'ي': 'D', 'ث': 'E' };
export const typedLetter = (key: string): GradeLetter | null => TYPED_LETTERS[key.toLowerCase()] ?? null;
export const typedLevel = (key: string): 1 | 2 | 3 | null => {
  const i = ['1', '2', '3'].indexOf(key) >= 0 ? ['1', '2', '3'].indexOf(key) : ['۱', '۲', '۳'].indexOf(key) >= 0 ? ['۱', '۲', '۳'].indexOf(key) : ['١', '٢', '٣'].indexOf(key);
  return i >= 0 ? ((i + 1) as 1 | 2 | 3) : null;
};
/** Arrow movement inside a row of `count` buttons, honouring ARROW_WRAP. */
export function stepIndex(index: number, delta: number, count: number, wrap = ARROW_WRAP): number {
  const next = index + delta;
  if (next < 0) return wrap ? count - 1 : 0;
  if (next >= count) return wrap ? 0 : count - 1;
  return next;
}
export const faDigits = (s: string | number) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
