/* Form block: source chips (default = admin setting per registrar), credit rank chips, registrar note (≤ 500). Used by the new-customer form
 * and by the duplicate («درخواست دوباره») block. Server validates the same rules (lib/lead-intake.ts parseIntake). */
import { FALLBACK_SOURCES, faNum, type IntakeOptions } from './api';
import './lead-intake.css';

export type IntakeValue = { leadSource: string; leadSourceOther: string; intakeCreditRank: string; registrarNote: string };
export const emptyIntake = (o?: IntakeOptions): IntakeValue => ({ leadSource: o?.defaultLeadSource ?? 'none', leadSourceOther: '', intakeCreditRank: 'unknown', registrarNote: '' });
export function intakeError(v: IntakeValue, o?: IntakeOptions): string | null {
  if (v.leadSource === 'other' && !v.leadSourceOther.trim()) return 'بنویس منبع دیگر چه بوده؛ یا یکی از گزینه‌های بالا را بزن.';
  if ([...v.leadSourceOther.trim()].length > (o?.leadSourceOtherMax ?? 40)) return `منبع دیگر حداکثر ${faNum(o?.leadSourceOtherMax ?? 40)} حرف است.`;
  if ([...v.registrarNote].length > (o?.registrarNoteMax ?? 500)) return `یادداشت ثبت‌کننده حداکثر ${faNum(o?.registrarNoteMax ?? 500)} حرف است.`;
  return null;
}
export const intakePayload = (v: IntakeValue) => ({ leadSource: v.leadSource, leadSourceOther: v.leadSource === 'other' ? v.leadSourceOther.trim() : undefined,
  intakeCreditRank: v.intakeCreditRank, registrarNote: v.registrarNote.trim() || undefined });

export function IntakeFields({ value, onChange, options, idPrefix = 'li', showErrors = false }: { value: IntakeValue; onChange: (v: IntakeValue) => void; options?: IntakeOptions; idPrefix?: string; showErrors?: boolean }) {
  const sources = (options?.leadSources ?? FALLBACK_SOURCES);
  const ranks = options?.ranks ?? [];
  const max = options?.registrarNoteMax ?? 500; const n = [...value.registrarNote].length;
  const otherMissing = showErrors && value.leadSource === 'other' && !value.leadSourceOther.trim();
  return <div className="li-block" data-testid={`${idPrefix}-intake`}>
    <div className="li-block" role="radiogroup" aria-labelledby={`${idPrefix}-src-l`}>
      <span className="li-lbl" id={`${idPrefix}-src-l`}>منبع مشتری</span>
      <div className="li-chips">{sources.map((s) => <button type="button" key={s.key} role="radio" aria-checked={value.leadSource === s.key} className="csx-chip"
        onClick={() => onChange({ ...value, leadSource: s.key })} data-testid={`${idPrefix}-src-${s.key}`}>{s.label}{options?.defaultLeadSource === s.key ? ' (پیش‌فرض)' : ''}</button>)}</div>
      {value.leadSource === 'other' ? <div className="field"><label htmlFor={`${idPrefix}-src-other`}>منبع دیگر چه بوده؟</label>
        <input id={`${idPrefix}-src-other`} maxLength={options?.leadSourceOtherMax ?? 40} value={value.leadSourceOther} aria-invalid={otherMissing || undefined}
          onChange={(e) => onChange({ ...value, leadSourceOther: e.target.value })} data-testid={`${idPrefix}-src-other`} />
        {otherMissing ? <p className="li-err" role="alert">بنویس منبع دیگر چه بوده؛ یا یکی از گزینه‌های بالا را بزن.</p> : null}</div> : null}
    </div>
    {ranks.length ? <div className="li-block" role="radiogroup" aria-labelledby={`${idPrefix}-rank-l`}>
      <span className="li-lbl" id={`${idPrefix}-rank-l`}>رتبه‌ی اعتباری (اگر می‌دانی)</span>
      <div className="li-chips">{ranks.map((r) => <button type="button" key={r.key} role="radio" aria-checked={value.intakeCreditRank === r.key} className="csx-chip"
        onClick={() => onChange({ ...value, intakeCreditRank: r.key })} data-testid={`${idPrefix}-rank-${r.key}`}>{r.label}</button>)}</div>
    </div> : null}
    <div className="field"><label htmlFor={`${idPrefix}-note`}>یادداشت ثبت‌کننده برای کارشناس (اختیاری)</label>
      <textarea id={`${idPrefix}-note`} value={value.registrarNote} onChange={(e) => onChange({ ...value, registrarNote: e.target.value })}
        placeholder="مثلاً: ساعت ۶ به بعد جواب می‌دهد؛ دنبال وام ۲۰۰ میلیونی است." data-testid={`${idPrefix}-note`} />
      <span className={`li-count${n > max ? ' over' : ''}`} aria-live="polite">{faNum(n)} / {faNum(max)}</span></div>
  </div>;
}
