/** t859: plans list display only — «both» → «هردو», percentages in Persian digits with «٪». Never changes loan_plans rows. */
const FA = '۰۱۲۳۴۵۶۷۸۹';
const faNum = (s: string) => s.replace(/\d/g, (d) => FA[Number(d)]).replace(/\./g, '٫');

/** Fallback labels when the consult dictionary has no row for the value (the dictionary label wins when present). */
export const PROCESS_MODE_FA: Record<string, string> = { in_person: 'حضوری', remote: 'غیرحضوری', both: 'هردو' };

export function processModeLabel(value: string | null | undefined, dictLabel?: string | null): string {
  const v = String(value ?? '').trim();
  if (!v) return '—';
  return (dictLabel && dictLabel.trim()) || PROCESS_MODE_FA[v] || v;
}

/** 40 → «۴۰٪», 5.5 → «۵٫۵٪», "23" → «۲۳٪», "23%" → «۲۳٪»; null / '' → «—». Text that is not a number keeps its words, digits in Persian. */
export function faPercent(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const s = String(value).trim().replace(/[%٪]\s*$/, '').trim();
  if (!s) return '—';
  return /^-?\d+(\.\d+)?$/.test(s) ? `${faNum(s)}٪` : faNum(String(value).trim()).replace(/%/g, '٪');
}
