import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import './plans-consult.css';

export const faDigits = (value: number | string) => String(value).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
export const enDigits = (value: string) => value.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
/** 300000000 → «۳۰۰٬۰۰۰٬۰۰۰». */
export const formatToman = (value: number | null | undefined) => value == null ? '' : faDigits(Math.round(value).toLocaleString('en-US').replace(/,/g, '٬'));

/** «مرحله X از N» + title + one bar segment per step (always visible, phones included). */
export function WizardProgress({ title, index, total, testId = 'wizard-progress' }: { title: string; index: number; total: number; testId?: string }) {
  return <div className="pc-progress" data-testid={testId} role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-label={`مرحله ${faDigits(index + 1)} از ${faDigits(total)}: ${title}`}>
    <div className="pc-progress-head"><strong>{title}</strong><span>مرحله {faDigits(index + 1)} از {faDigits(total)}</span></div>
    <div className="pc-progress-bar">{Array.from({ length: total }, (_, i) => <span key={i} className={i <= index ? 'is-on' : ''} />)}</div>
  </div>;
}

/** Single choice as large pill buttons (radio semantics). */
export function Choice<T extends string>({ label, value, options, onChange, required = false, hint, testId, dashed }: {
  label: ReactNode; value: T | null | undefined; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void;
  required?: boolean; hint?: ReactNode; testId?: string; dashed?: T;
}) {
  return <div className="pc-field" role="radiogroup" data-testid={testId}>
    <div className="pc-label">{label}{required ? <b className="pc-req">*</b> : null}{hint ? <span className="pc-hint">{hint}</span> : null}</div>
    <div className="pc-choices">{options.map((o) => <button type="button" role="radio" aria-checked={value === o.value} key={o.value}
      className={`pc-choice${value === o.value ? ' is-on' : ''}${dashed === o.value ? ' is-dashed' : ''}`} onClick={() => onChange(o.value)}
      data-testid={testId ? `${testId}-${o.value}` : undefined}>{o.label}</button>)}</div>
  </div>;
}

export const YES_NO = [{ value: 'yes', label: 'بله' }, { value: 'no', label: 'خیر' }] as const;
export const yn = (v: boolean) => (v ? 'yes' : 'no') as 'yes' | 'no';

/** Toman amount with Persian digits and a thousands separator; the value is a plain integer (or null). */
export function TomanInput({ value, onChange, placeholder = 'مثلاً ۳۰۰٬۰۰۰٬۰۰۰', testId, id, required }: { value: number | null; onChange: (value: number | null) => void; placeholder?: string; testId?: string; id?: string; required?: boolean }) {
  return <div className="pc-money">
    <input id={id} inputMode="numeric" dir="ltr" value={formatToman(value)} placeholder={placeholder} required={required} data-testid={testId}
      onChange={(e) => { const digits = enDigits(e.target.value).replace(/\D/g, '').slice(0, 13); onChange(digits ? Number(digits) : null); }} />
    <span>تومان</span>
  </div>;
}

/** Staff-only value shown as a locked badge (never asked from the customer). */
export function LockBadge({ children, title = 'فقط برای کارکنان' }: { children: ReactNode; title?: string }) {
  return <span className="pc-lock" title={title}><Lock size={12} />{children}</span>;
}
