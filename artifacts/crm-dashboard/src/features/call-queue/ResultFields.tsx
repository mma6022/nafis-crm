import { useMemo, useState } from 'react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliToIso, parseJalaliValue } from '@/lib/jalali';
import { addTehranDays, faNum, faWhen, tehranParts, type CqOutcome, type PreCall } from './api';
import './call-queue.css';

export type CqResultValue = { outcome: CqOutcome | ''; oneLine: string; followUpAt: string; chip: 'evening' | 'tomorrow' | 'in3' | 'pick' | '' ; pickDate: string; pickHour: string; pickMinute: string };
export const emptyCqResult = (): CqResultValue => ({ outcome: '', oneLine: '', followUpAt: '', chip: '', pickDate: '', pickHour: '10', pickMinute: '00' });
export const CQ_ONE_LINE_MAX = 80;

/** null = OK; otherwise the Persian error summary (spec §2 `fu_err`, `fu_next_err`, `fu_pick_bad`). */
export function cqResultError(v: CqResultValue): string | null {
  const missing = [!v.outcome ? 'نتیجه‌ی تماس' : null, !v.oneLine.trim() ? 'یادداشت یک‌خطی' : null].filter(Boolean);
  if (missing.length) return `${missing.join('، ')} هنوز خالی است.`;
  if ([...v.oneLine.trim()].length > CQ_ONE_LINE_MAX) return 'یادداشت یک‌خطی حداکثر ۸۰ نویسه است.';
  if (v.outcome === 'follow_up') {
    if (!v.followUpAt) return v.chip === 'pick' ? pickError(v) ?? 'تاریخ و ساعت را انتخاب کن.' : 'زمان یادآور پیگیری بعدی را انتخاب کن.';
    if (Date.parse(v.followUpAt) <= Date.now()) return 'زمان یادآور باید در آینده باشد.';
  }
  return null;
}
function pickError(v: CqResultValue): string | null {
  const h = Number(v.pickHour), m = Number(v.pickMinute);
  if (h < 9 || h > 18 || (h === 18 && m > 0)) return `${faNum(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)} بیرون از ساعت کاری است (۹ تا ۱۸).`;
  return null;
}
function pickIso(v: CqResultValue): string {
  const p = parseJalaliValue(v.pickDate); if (!p || pickError(v)) return '';
  return jalaliToIso(p.year, p.month, p.day, Number(v.pickHour), Number(v.pickMinute)) ?? '';
}

export function CqResultFields({ value, onChange, showErrors, pre, idPrefix = 'cq', onlyTime = false }: { value: CqResultValue; onChange: (v: CqResultValue) => void; showErrors: boolean; pre?: PreCall | null; idPrefix?: string; onlyTime?: boolean }) {
  const set = (patch: Partial<CqResultValue>) => onChange({ ...value, ...patch });
  const now = new Date(); const tp = tehranParts(now);
  const eveningLate = tp.h * 60 + tp.mi >= 16 * 60 || tp.wd === 5;
  const tomorrow = addTehranDays(now, 1, 10); const tomorrowFriday = tehranParts(tomorrow).wd === 5;
  const chips = useMemo(() => [
    { key: 'evening' as const, label: 'امروز عصر (۱۶:۰۰)', at: addTehranDays(now, 0, 16).toISOString(), disabled: eveningLate },
    { key: 'tomorrow' as const, label: 'فردا صبح (۱۰:۰۰)', at: tomorrow.toISOString(), disabled: false },
    { key: 'in3' as const, label: '۳ روز دیگه', at: addTehranDays(now, 3, 10).toISOString(), disabled: false },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [tp.y, tp.m, tp.d, eveningLate]);
  const len = [...value.oneLine].length; const atMax = len >= CQ_ONE_LINE_MAX;
  const err = showErrors ? cqResultError(value) : null;
  const outcomes: { key: CqOutcome; label: string }[] = [{ key: 'answered', label: 'پاسخ داد' }, { key: 'no_answer', label: 'پاسخ نداد' }, { key: 'follow_up', label: 'پیگیری بعدی' }];
  const [focusIdx, setFocusIdx] = useState(0);
  const onRadioKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0; // RTL
    if (!dir) return; e.preventDefault(); const n = (i + dir + 3) % 3; setFocusIdx(n); set({ outcome: outcomes[n].key });
    (document.getElementById(`${idPrefix}-out-${outcomes[n].key}`) as HTMLButtonElement | null)?.focus();
  };
  const na = pre?.naAttemptIfNoAnswer ?? 1;
  return <div className={`cq-result${err ? ' has-err' : ''}`} data-testid="cq-result">
    {onlyTime ? null : <>{pre?.due?.length ? <div className="cq-pre-due" role="note" data-testid="cq-pre-due">
      {pre.due.length === 1 ? <>یادآور سررسیده‌ی {pre.due[0].label}{pre.due[0].subject ? ` («${pre.due[0].subject}»)` : ''} با ثبت این تماس خودکار بسته می‌شود.</>
        : <>{faNum(pre.due.length)} یادآور سررسیده ({pre.due.map((d) => d.label).join('، ')}) با ثبت این تماس خودکار بسته می‌شوند.</>}
    </div> : null}
    <div className="field">
      <label id={`${idPrefix}-out-label`}>نتیجه‌ی تماس <span className="req" aria-hidden="true">*</span></label>
      <div className={`cq-outcomes${showErrors && !value.outcome ? ' bad' : ''}`} role="radiogroup" aria-labelledby={`${idPrefix}-out-label`} aria-required="true" aria-invalid={showErrors && !value.outcome}>
        {outcomes.map((o, i) => <button key={o.key} id={`${idPrefix}-out-${o.key}`} type="button" role="radio" aria-checked={value.outcome === o.key}
          tabIndex={value.outcome ? (value.outcome === o.key ? 0 : -1) : (i === focusIdx ? 0 : -1)} onKeyDown={(e) => onRadioKey(e, i)}
          className={`cq-out ${value.outcome === o.key ? 'on' : ''} k-${o.key}`} onClick={() => set({ outcome: o.key })} data-testid={`cq-outcome-${o.key}`}>{o.label}</button>)}
      </div>
    </div>
    <div className="field">
      <label htmlFor={`${idPrefix}-one`}>یادداشت یک‌خطی <span className="req" aria-hidden="true">*</span></label>
      <input id={`${idPrefix}-one`} value={value.oneLine} maxLength={CQ_ONE_LINE_MAX} onChange={(e) => set({ oneLine: e.target.value.replace(/\n/g, ' ') })}
        className={showErrors && !value.oneLine.trim() ? 'bad' : ''} aria-invalid={showErrors && !value.oneLine.trim()} aria-describedby={`${idPrefix}-one-meta`} aria-required="true"
        placeholder="مثلاً: مدارک را تا فردا می‌فرستد" data-testid="cq-one-line" />
      <div id={`${idPrefix}-one-meta`} className={`cq-counter${atMax ? ' max' : ''}`} data-testid="cq-one-line-counter">
        {atMax ? 'به سقف رسیدی؛ بقیه را در «یادداشت کارشناس» بنویس · ' : ''}{faNum(len)} / {faNum(CQ_ONE_LINE_MAX)}</div>
    </div></>}
    {value.outcome === 'follow_up' ? <div className="field" data-testid="cq-followup">
      <label id={`${idPrefix}-fu-label`}>زمان یادآور <span className="req" aria-hidden="true">*</span></label>
      <div className="cq-chips" role="group" aria-labelledby={`${idPrefix}-fu-label`}>
        {chips.map((c) => <button key={c.key} type="button" className={`cq-chip${value.chip === c.key ? ' on' : ''}`} aria-pressed={value.chip === c.key} disabled={c.disabled}
          onClick={() => set({ chip: c.key, followUpAt: c.at })} data-testid={`cq-chip-${c.key}`}>{c.label}</button>)}
        <button type="button" className={`cq-chip${value.chip === 'pick' ? ' on' : ''}`} aria-pressed={value.chip === 'pick'} onClick={() => set({ chip: 'pick', followUpAt: pickIso(value) })} data-testid="cq-chip-pick">انتخاب تاریخ</button>
      </div>
      {eveningLate ? <small className="cq-hint" data-testid="cq-fu-late">«امروز عصر» بعد از ساعت ۱۶ یا در روز تعطیل در دسترس نیست.</small> : null}
      {value.chip === 'tomorrow' && tomorrowFriday ? <small className="cq-hint" data-testid="cq-fu-next">فردا جمعه است؛ یادآور به اولین روز کاری بعد (ساعت ۱۰) می‌رود.</small> : null}
      {value.chip === 'pick' ? <div className="cq-pick">
        <PersianDatePicker value={value.pickDate} onChange={(d) => { const nv = { ...value, pickDate: d }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} testId="cq-pick-date" />
        <select aria-label="ساعت" value={value.pickHour} onChange={(e) => { const nv = { ...value, pickHour: e.target.value }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} data-testid="cq-pick-hour">
          {Array.from({ length: 9 }, (_, i) => String(i + 9)).map((h) => <option key={h} value={h}>{faNum(h.padStart(2, '0'))}</option>)}</select>
        <select aria-label="دقیقه" value={value.pickMinute} onChange={(e) => { const nv = { ...value, pickMinute: e.target.value }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} data-testid="cq-pick-minute">
          {['00', '15', '30', '45'].map((m) => <option key={m} value={m}>{faNum(m)}</option>)}</select>
      </div> : null}
      {value.followUpAt ? <small className="cq-hint" data-testid="cq-fu-when">یادآور: {faWhen(value.followUpAt)} (جمعه، تعطیل رسمی یا بیرون از ۹ تا ۱۸ به اولین زمان کاری بعد می‌رود)</small> : null}
    </div> : null}
    {!onlyTime && value.outcome === 'no_answer' ? <div className="cq-na" data-testid="cq-na-box" data-attempt={na}>
      <div className="cq-dots" aria-hidden="true">{[1, 2, 3].map((i) => <span key={i} className={i <= na ? 'on' : ''} />)}</div>
      <div><b>این تماس، تلاش بی‌پاسخ {faNum(na)} از ۳ است.</b>
        {na < 3 ? <p>تاریخ نمی‌خواهد؛ تلاش بعدی خودکار ساخته می‌شود ({na === 1 ? '۴ ساعت بعد' : '۲۴ ساعت بعد'}، فقط ساعت کاری).</p>
          : pre?.p1 ? <p data-testid="cq-na3-p1">تلاش بعدی ساخته نمی‌شود · اعلان به مدیر می‌رود. مشتری در فهرست تو می‌ماند.</p>
          : <p data-testid="cq-na3-cold">بعد از ۳ تلاش بی‌پاسخ، بایگانی سرد پیشنهاد می‌شود. اگر هنوز می‌خواهی پیگیری کنی «پیگیری بعدی» را بزن.</p>}</div>
    </div> : null}
    {err ? <div className="cq-err" role="alert" data-testid="cq-result-error">{err}</div> : null}
  </div>;
}

/** Pre-notice alone (flag.autoclose on, flag.result off). */
CqResultFields.PreOnly = function PreOnly({ pre }: { pre: PreCall }) {
  if (!pre.due.length) return null;
  return <div className="cq-pre-due" role="note" data-testid="cq-pre-due">
    {pre.due.length === 1 ? <>یادآور سررسیده‌ی {pre.due[0].label} با ثبت این تماس خودکار بسته می‌شود.</> : <>{faNum(pre.due.length)} یادآور سررسیده با ثبت این تماس خودکار بسته می‌شوند.</>}
  </div>;
};

/** R2 «قفل تماس»: a call that did not start from the CRM button must say what it was (spec: حضوری / بله). */
export function CqManualType({ value, onChange, showError, idPrefix = 'cq-mt' }: { value: string; onChange: (v: 'in_person' | 'bale') => void; showError?: boolean; idPrefix?: string }) {
  const opts: { key: 'in_person' | 'bale'; label: string }[] = [{ key: 'in_person', label: 'حضوری' }, { key: 'bale', label: 'بله' }];
  return <div className="cq-field" data-testid="cq-manual-type">
    <span className="cq-label" id={`${idPrefix}-l`}>این گفت‌وگو از دکمه‌ی تماس CRM نبود؛ نوعش چه بود؟</span>
    <div className="cq-chips" role="radiogroup" aria-labelledby={`${idPrefix}-l`} aria-invalid={showError && !value || undefined}>
      {opts.map((o) => <button key={o.key} type="button" role="radio" aria-checked={value === o.key} className={`cq-chip${value === o.key ? ' on' : ''}`} onClick={() => onChange(o.key)} data-testid={`cq-manual-${o.key}`}>{o.label}</button>)}
    </div>
    {showError && !value ? <p className="cq-err" role="alert" data-testid="cq-manual-err">نوع گفت‌وگو را انتخاب کن (حضوری یا بله).</p> : null}
    <small className="cq-hint">تماس تلفنی فقط از دکمه‌ی تماس CRM ثبت می‌شود.</small>
  </div>;
}
