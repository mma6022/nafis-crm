/* The fixed «فوری» reasons (server: lib/customer-urgent.ts URGENT_REASONS). «سایر» needs a free text (3–280). */
import { DEFAULT_URGENT_REASONS, type UrgentReasonOpt, type UrgentReasonValue } from './api';

export function urgentReasonReady(v: UrgentReasonValue | null): boolean {
  if (!v?.reasonCode) return false;
  return v.reasonCode !== 'other' || (v.reasonText ?? '').trim().length >= 3;
}

export function UrgentReasonPicker({ value, onChange, options, idPrefix = 'urg', disabled }: {
  value: UrgentReasonValue | null; onChange: (v: UrgentReasonValue) => void; options?: UrgentReasonOpt[]; idPrefix?: string; disabled?: boolean;
}) {
  const opts = options?.length ? options : DEFAULT_URGENT_REASONS;
  return (
    <fieldset className="la-reasons" disabled={disabled} data-testid={`${idPrefix}-reasons`}>
      <legend>دلیل «مشتری فوری» (الزامی)</legend>
      {opts.map((o) => (
        <label key={o.code} className="la-reason">
          <input type="radio" name={`${idPrefix}-reason`} value={o.code} checked={value?.reasonCode === o.code}
            onChange={() => onChange({ reasonCode: o.code, reasonText: o.code === 'other' ? (value?.reasonText ?? '') : undefined })}
            data-testid={`${idPrefix}-reason-${o.code}`} />
          <span>{o.label}</span>
        </label>
      ))}
      {value?.reasonCode === 'other' ? <>
        <label htmlFor={`${idPrefix}-other`} className="la-sr">توضیح «سایر»</label>
        <input id={`${idPrefix}-other`} type="text" maxLength={280} placeholder="توضیح «سایر» (الزامی)" value={value.reasonText ?? ''}
          onChange={(e) => onChange({ reasonCode: 'other', reasonText: e.target.value })} data-testid={`${idPrefix}-other-text`} />
      </> : null}
    </fieldset>
  );
}
