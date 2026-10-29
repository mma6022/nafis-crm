/* «علامت فوری» with a required reason (chips; «سایر» = one short sentence ≤ 80). Used on create and in the flag sheet. */
import { faNum, type ReasonOpt } from './api';
import './lead-intake.css';

export type UrgentPickValue = { on: boolean; reasonCode: string; reasonText: string };
// NOTES-NOMAX: no maximum on the «سایر» text; `_max` kept for call-site compatibility.
export const urgentPickReady = (v: UrgentPickValue, _max?: number | null) => !v.on || (Boolean(v.reasonCode) && (v.reasonCode !== 'other' || v.reasonText.trim().length > 0));
const FALLBACK: ReasonOpt[] = [{ code: 'no_callback', label: 'شاکیه کسی زنگ نزده' }, { code: 'urgent_call', label: 'درخواست تماس فوری' }, { code: 'other', label: 'سایر' }];

export function UrgentReasonChips({ value, onChange, reasons, max = 80, idPrefix = 'uf', showErrors = false }: {
  value: UrgentPickValue; onChange: (v: UrgentPickValue) => void; reasons?: ReasonOpt[]; max?: number; idPrefix?: string; showErrors?: boolean }) {
  const opts = reasons?.length ? reasons : FALLBACK;
  return <div className="li-block" role="radiogroup" aria-labelledby={`${idPrefix}-l`}>
    <span className="li-lbl" id={`${idPrefix}-l`}>چرا فوری است؟</span>
    <div className="li-chips">{opts.map((o) => <button type="button" key={o.code} role="radio" aria-checked={value.reasonCode === o.code} className="csx-chip"
      onClick={() => onChange({ ...value, reasonCode: o.code })} data-testid={`${idPrefix}-reason-${o.code}`}>{o.label}</button>)}</div>
    {value.reasonCode === 'other' ? <div className="field"><label htmlFor={`${idPrefix}-other`}>یک جمله‌ی کوتاه</label>
      <input id={`${idPrefix}-other`} value={value.reasonText} onChange={(e) => onChange({ ...value, reasonText: e.target.value })} data-testid={`${idPrefix}-other`} />
      <span className="li-count">{faNum([...value.reasonText].length)} نویسه</span>
      {showErrors && !value.reasonText.trim() ? <p className="li-err" role="alert">برای «سایر» یک جمله‌ی کوتاه بنویس که چرا فوری است.</p> : null}</div> : null}
  </div>;
}

export function UrgentPick({ value, onChange, reasons, max = 80, showErrors = false }: { value: UrgentPickValue; onChange: (v: UrgentPickValue) => void; reasons?: ReasonOpt[]; max?: number; showErrors?: boolean }) {
  return <div className="li-block" data-testid="li-urgent-pick">
    <label className="boolean-field"><input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} data-testid="checkbox-customer-is-urgent" /> <strong>علامت فوری بزن</strong></label>
    {value.on ? <UrgentReasonChips value={value} onChange={onChange} reasons={reasons} max={max} idPrefix="li-create-urg" showErrors={showErrors} /> : null}
    {value.on && !urgentPickReady(value, max) ? <div className="csx-note warn" role="status" data-testid="li-urgent-incomplete"><p>دلیل را کامل کن تا علامت ثبت شود.</p></div> : null}
  </div>;
}
