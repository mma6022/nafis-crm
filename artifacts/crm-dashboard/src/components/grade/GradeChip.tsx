import type { CSSProperties } from 'react';
import { CREDIT_SUBGRADES, GRADE_COLORS, LEGACY_LABEL, faDigits, gradeBg, gradeColor, gradeLetter, isLegacy, isSubgrade, normalizeGrade } from '@/lib/credit-grade';
import './grade.css';

const vars = (value: string): CSSProperties => {
  const c = gradeColor(value)!;
  return { ['--gm' as string]: c.main, ['--gt' as string]: c.text, ['--gb' as string]: gradeBg(value), ['--gm-a' as string]: `${c.main}55` };
};

/** Small (24px) or large (44px + 15-cell position bar) grade chip. Legacy letters get a dashed border and «قدیمی». */
export function GradeChip({ value, size = 'sm', emptyText, otherLabel, testId }: { value?: string | null; size?: 'sm' | 'lg'; emptyText?: string; otherLabel?: string; testId?: string }) {
  const v = normalizeGrade(value);
  const sub = isSubgrade(v), legacy = isLegacy(v);
  let chip;
  if (!v) chip = <span className="gc is-empty" data-testid={testId}>{emptyText ?? (size === 'lg' ? '—' : 'ثبت نشده')}</span>;
  else if (!sub && !legacy) chip = <span className="gc is-other" data-testid={testId}>{otherLabel ?? (value ?? '').trim()}</span>;
  else chip = <span className={`gc${legacy ? ' is-legacy' : ''}`} style={vars(v)} data-testid={testId} aria-label={legacy ? `${v} (${LEGACY_LABEL})` : v}>
    <span className="gc-dot" aria-hidden="true" /><span className="cgp-ltr">{v}</span>{legacy ? <span className="gc-tag" aria-hidden="true">{LEGACY_LABEL}</span> : null}
  </span>;
  if (size === 'sm') return chip;
  const letter = gradeLetter(v);
  const pos = sub ? CREDIT_SUBGRADES.indexOf(v) + 1 : 0;
  const caption = !v ? 'هنوز ثبت نشده' : sub ? `${faDigits(pos)} از ${faDigits(15)}` : legacy ? 'زیررتبه ثبت نشده' : '';
  return <div className="gc-lg" style={letter ? vars(v) : undefined}>
    <div className="gc-lg-head">{chip}{caption ? <span className="gc-lg-cap">{caption}</span> : null}</div>
    {sub || legacy || !v ? <div className="gc-bar" aria-hidden="true">{CREDIT_SUBGRADES.map((g) => {
      const on = sub ? g === v : legacy ? g[0] === letter : false;
      return <span key={g} className={on ? 'is-on' : undefined} style={{ ['--cell' as string]: GRADE_COLORS[g[0] as keyof typeof GRADE_COLORS].bg2, ...(on ? { ['--gm' as string]: GRADE_COLORS[g[0] as keyof typeof GRADE_COLORS].main } : {}) }} />;
    })}</div> : null}
  </div>;
}

/** Plan conditions: chips for each permitted grade, A1 … E3 order. */
export function GradeChipList({ values, testId }: { values: readonly string[]; testId?: string }) {
  return <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, verticalAlign: 'middle' }} data-testid={testId}>{values.map((v) => <GradeChip key={v} value={v} />)}</span>;
}
