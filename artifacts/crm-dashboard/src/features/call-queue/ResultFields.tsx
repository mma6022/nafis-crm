import { useMemo, useState } from 'react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliToIso, parseJalaliValue } from '@/lib/jalali';
import { addTehranDays, faNum, faWhen, tehranParts, type CqOutcome, type PreCall } from './api';
import './call-queue.css';

/** Release 81 «نتیجه‌ی تماس اجباری» (Armita crm-call-result v1.0): stored as call_logs.call_result; sent as `call_result`. */
export type ManualOutcome = 'answered' | 'no_answer' | 'off_or_busy';
export const MANUAL_OUTCOME_OPTIONS: { key: ManualOutcome; label: string; cls: 'ok' | 'na' | 'off' }[] = [
  { key: 'answered', label: 'جواب داد', cls: 'ok' }, { key: 'no_answer', label: 'جواب نداد', cls: 'na' }, { key: 'off_or_busy', label: 'خاموش یا اشغال', cls: 'off' }];
export const MANUAL_OUTCOME_MISSING = 'نتیجه‌ی تماس را انتخاب کن: «جواب داد»، «جواب نداد» یا «خاموش یا اشغال».';
/** The call-queue outcome derived from the result (+ the separate, optional «پیگیری بعدی» step — v1.0.1: not a result option).
 *  off_or_busy counts exactly like no_answer (PM 3). A no-answer attempt stays «no_answer» even with a follow-up: the attempt is counted
 *  and the expert's follow_up_at replaces the automatic 4h/24h retry (PM, 81). Answered / non-phone + follow-up = the legacy «follow_up» outcome. */
export const cqOutcomeFor = (manual: ManualOutcome | '', followUp: boolean): CqOutcome | '' =>
  manual === 'no_answer' || manual === 'off_or_busy' ? 'no_answer' : followUp ? 'follow_up' : manual === 'answered' ? 'answered' : '';
/** followUpAt to send: only when the «پیگیری بعدی» switch is on. */
export const cqFollowUpAt = (v: CqResultValue): string | undefined => (v.fu ? v.followUpAt || undefined : undefined);
/** Submit buttons stay focusable with aria-disabled (spec §1); pressing one turns the hint red and focuses the group. */
export const focusCallResult = (idPrefix: string) => {
  const g = document.getElementById(`${idPrefix}-cr-group`);
  (g?.querySelector('[tabindex="0"]') as HTMLElement | null)?.focus();
};

/** «پنج‌شنبه ۷ آبان» in Tehran time (design chip subline). */
export const faDayLabel = (iso: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)).replace('،', '');

const Svg = ({ d }: { d: string[] }) => <svg viewBox="0 0 24 24" aria-hidden="true">{d.map((x) => <path key={x} d={x} />)}</svg>;
const PHONE = 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z';
const ICONS: Record<ManualOutcome, string[]> = { answered: [PHONE, 'm14.5 6 2 2 4-4'], no_answer: [PHONE, 'm15 3 6 6M21 3l-6 6'], off_or_busy: ['M12 3v8', 'M7.5 6.2a7 7 0 1 0 9 0'] };

/** «نتیجه‌ی تماس *» — radiogroup with roving tabindex: ←/↓ next, →/↑ previous (RTL), Home/End, Space/Enter. Null until chosen. */
export function ManualOutcomeField({ value, onChange, showError, idPrefix = 'mo', label = 'نتیجه‌ی تماس', submitLabel = 'ثبت' }: { value: ManualOutcome | ''; onChange: (v: ManualOutcome) => void; showError?: boolean; idPrefix?: string; label?: string; submitLabel?: string }) {
  const opts = MANUAL_OUTCOME_OPTIONS; const bad = !!showError && !value;
  const move = (n: number) => { const o = opts[(n + opts.length) % opts.length]; onChange(o.key); (document.getElementById(`${idPrefix}-cr-${o.key}`) as HTMLButtonElement | null)?.focus(); };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowDown') { e.preventDefault(); move(i + 1); }
    else if (k === 'ArrowRight' || k === 'ArrowUp') { e.preventDefault(); move(i - 1); }
    else if (k === 'Home') { e.preventDefault(); move(0); }
    else if (k === 'End') { e.preventDefault(); move(opts.length - 1); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); onChange(opts[i].key); }
  };
  const picked = opts.find((o) => o.key === value);
  return <div className="crf" data-cr={value || ''} data-testid="manual-outcome">
    <div className="crl"><span id={`${idPrefix}-cr-label`}>{label} <span className="req" aria-hidden="true">*</span></span><small>اجباری · یکی را انتخاب کن</small></div>
    <div className="crp" id={`${idPrefix}-cr-group`} role="radiogroup" aria-labelledby={`${idPrefix}-cr-label`} aria-describedby={`${idPrefix}-cr-hint`} aria-required="true" aria-invalid={bad || undefined}>
      {opts.map((o, i) => <button key={o.key} id={`${idPrefix}-cr-${o.key}`} type="button" role="radio" aria-checked={value === o.key} data-v={o.key}
        tabIndex={value ? (value === o.key ? 0 : -1) : (i === 0 ? 0 : -1)} onKeyDown={(e) => onKey(e, i)}
        className={`cro ${o.cls}`} onClick={() => onChange(o.key)} data-testid={`manual-outcome-${o.key}`}>
        <span className="cri"><Svg d={ICONS[o.key]} /></span><b>{o.label}</b><span className="crk" aria-hidden="true"><Svg d={['m5 12 5 5 9-10']} /></span></button>)}
    </div>
    <p className={`crh${bad ? ' bad' : ''}`} id={`${idPrefix}-cr-hint`} role={bad ? 'alert' : undefined} data-testid={bad ? 'manual-outcome-error' : 'manual-outcome-hint'}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
      {picked ? `«${picked.label}» انتخاب شد` : bad ? MANUAL_OUTCOME_MISSING : `تا نتیجه‌ی تماس را انتخاب نکنی، «${submitLabel}» غیرفعال است.`}</p>
  </div>;
}

export type CqResultValue = { manual: ManualOutcome | ''; outcome: CqOutcome | ''; fu: boolean; oneLine: string; followUpAt: string; chip: 'evening' | 'tomorrow' | 'in3' | 'pick' | '' ; pickDate: string; pickHour: string; pickMinute: string };
export const emptyCqResult = (): CqResultValue => ({ manual: '', outcome: '', fu: false, oneLine: '', followUpAt: '', chip: '', pickDate: '', pickHour: '10', pickMinute: '00' });
export const CQ_ONE_LINE_MAX = 80;

/** null = OK; otherwise the Persian error summary (spec §2 `fu_err`, `fu_next_err`, `fu_pick_bad`). */
export function cqResultError(v: CqResultValue, needResult = true): string | null {
  const missing = [needResult && !v.manual ? 'نتیجه‌ی تماس' : null, !v.oneLine.trim() ? 'یادداشت یک‌خطی' : null].filter(Boolean);
  if (missing.length) return `${missing.join('، ')} هنوز خالی است.`;
  if ([...v.oneLine.trim()].length > CQ_ONE_LINE_MAX) return 'یادداشت یک‌خطی حداکثر ۸۰ نویسه است.';
  if (v.fu) {
    if (!v.followUpAt) return v.chip === 'pick' ? pickError(v) ?? 'تاریخ و ساعت را انتخاب کن.' : 'برای «پیگیری بعدی» زمان یادآور را انتخاب کن.';
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

/** PM (81, Q4): «نتیجه‌ی تماس» only for the phone channel — a حضوری / بله log hides it, never sends it, and its outcome is «answered» unless «پیگیری بعدی». */
export const cqSaveOutcome = (v: CqResultValue, nonPhone: boolean): { outcome: CqOutcome | ''; call_result?: ManualOutcome } =>
  nonPhone ? { outcome: v.fu ? 'follow_up' : 'answered' } : { outcome: cqOutcomeFor(v.manual, v.fu), call_result: v.manual || undefined };

export function CqResultFields({ value, onChange, showErrors, pre, idPrefix = 'cq', onlyTime = false, noResult = false, submitLabel }: { value: CqResultValue; onChange: (v: CqResultValue) => void; showErrors: boolean; pre?: PreCall | null; idPrefix?: string; onlyTime?: boolean; noResult?: boolean; submitLabel?: string }) {
  const set = (patch: Partial<CqResultValue>) => onChange({ ...value, ...patch });
  const now = new Date(); const tp = tehranParts(now);
  const eveningLate = tp.h * 60 + tp.mi >= 16 * 60 || tp.wd === 5;
  const tomorrow = addTehranDays(now, 1, 10); const tomorrowFriday = tehranParts(tomorrow).wd === 5;
  /* release 69 (81 alignment, Armita crm-call-result v1.0.1 §2.5): chips are «title» + small «weekday day month · hh:mm», ≥52px, role=radio. */
  const chips = useMemo(() => [
    { key: 'evening' as const, label: 'عصر امروز', at: addTehranDays(now, 0, 16).toISOString(), disabled: eveningLate },
    { key: 'tomorrow' as const, label: 'فردا صبح', at: tomorrow.toISOString(), disabled: false },
    { key: 'in3' as const, label: '۳ روز بعد', at: addTehranDays(now, 3, 10).toISOString(), disabled: false },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [tp.y, tp.m, tp.d, eveningLate]);
  const len = [...value.oneLine].length; const atMax = len >= CQ_ONE_LINE_MAX;
  const err = showErrors ? cqResultError(value, !noResult) : null;
  const na = pre?.naAttemptIfNoAnswer ?? 1;
  const fuMissing = showErrors && value.fu && !value.followUpAt;
  const pickChip = (k: CqResultValue['chip'], at: string) => set({ chip: k, followUpAt: at });
  const timeStep = value.fu ? <div className="field cq-fu-time" data-testid="cq-followup">
      <span className="cq-label" id={`${idPrefix}-fu-label`}>زمان یادآور <span className="req" aria-hidden="true">*</span></span>
      <div className="cq-chips cq-fu-chips" role="radiogroup" aria-labelledby={`${idPrefix}-fu-label`} aria-required="true" aria-invalid={fuMissing || undefined}>
        {chips.map((c) => <button key={c.key} type="button" role="radio" className={`cq-chip cq-fch${value.chip === c.key ? ' on' : ''}`} aria-checked={value.chip === c.key} disabled={c.disabled}
          onClick={() => pickChip(c.key, c.at)} data-testid={`cq-chip-${c.key}`}>
          <b>{c.label}</b><small>{c.disabled ? 'ساعت کاری امروز تمام شده' : c.key === 'evening' ? <><span>امروز</span><span>۱۶:۰۰</span></> : <><span>{faDayLabel(c.at)}</span><span>۱۰:۰۰</span></>}</small></button>)}
        <button type="button" role="radio" className={`cq-chip cq-fch${value.chip === 'pick' ? ' on' : ''}`} aria-checked={value.chip === 'pick'} onClick={() => pickChip('pick', pickIso(value))} data-testid="cq-chip-pick">
          <b>انتخاب روز و ساعت</b><small><span>تقویم</span><span>۹ تا ۱۸</span></small></button>
      </div>
      {value.chip === 'tomorrow' && tomorrowFriday ? <small className="cq-hint" data-testid="cq-fu-next">فردا جمعه است؛ یادآور به اولین روز کاری بعد (ساعت ۱۰) می‌رود.</small> : null}
      {value.chip === 'pick' ? <div className="cq-pick">
        <PersianDatePicker value={value.pickDate} onChange={(d) => { const nv = { ...value, pickDate: d }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} testId="cq-pick-date" />
        <select aria-label="ساعت" value={value.pickHour} onChange={(e) => { const nv = { ...value, pickHour: e.target.value }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} data-testid="cq-pick-hour">
          {Array.from({ length: 9 }, (_, i) => String(i + 9)).map((h) => <option key={h} value={h}>{faNum(h.padStart(2, '0'))}</option>)}</select>
        <select aria-label="دقیقه" value={value.pickMinute} onChange={(e) => { const nv = { ...value, pickMinute: e.target.value }; onChange({ ...nv, followUpAt: pickIso(nv) }); }} data-testid="cq-pick-minute">
          {['00', '15', '30', '45'].map((m) => <option key={m} value={m}>{faNum(m)}</option>)}</select>
      </div> : null}
      {value.followUpAt ? <p className="picked" data-testid="cq-fu-when"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" /></svg>
        <span>یادآور: {faWhen(value.followUpAt)}</span><small>جمعه، تعطیل رسمی یا بیرون از ۹ تا ۱۸ به اولین زمان کاری بعد می‌رود</small></p> : null}
    </div> : null;
  return <div className={`cq-result${err ? ' has-err' : ''}`} data-testid="cq-result">
    {onlyTime ? null : <>{pre?.due?.length ? <div className="cq-pre-due" role="note" data-testid="cq-pre-due">
      {pre.due.length === 1 ? <>یادآور سررسیده‌ی {pre.due[0].label}{pre.due[0].subject ? ` («${pre.due[0].subject}»)` : ''} با ثبت این تماس خودکار بسته می‌شود.</>
        : <>{faNum(pre.due.length)} یادآور سررسیده ({pre.due.map((d) => d.label).join('، ')}) با ثبت این تماس خودکار بسته می‌شوند.</>}
    </div> : null}
    {noResult ? null : <ManualOutcomeField value={value.manual} idPrefix={idPrefix} showError={showErrors} submitLabel={submitLabel}
      onChange={(m) => set({ manual: m, outcome: cqOutcomeFor(m, value.fu) })} />}</>}
    {!onlyTime && !noResult && value.outcome === 'no_answer' ? <div className="cq-na" data-testid="cq-na-box" data-attempt={na}>
      <div className="cq-dots" aria-hidden="true">{[1, 2, 3].map((i) => <span key={i} className={i <= na ? 'on' : ''} />)}</div>
      <div><b>این تماس، تلاش بی‌پاسخ {faNum(na)} از ۳ است.</b>
        {value.manual === 'off_or_busy' ? <p data-testid="cq-na-off">«خاموش یا اشغال» هم مثل «جواب نداد» یک تلاش بی‌پاسخ حساب می‌شود.</p> : null}
        {value.fu ? <p data-testid="cq-na-fu">«پیگیری بعدی» تو جای تلاش خودکار بعدی را می‌گیرد؛ یادآور تکراری ساخته نمی‌شود.</p>
          : na < 3 ? <p>تاریخ نمی‌خواهد؛ تلاش بعدی خودکار ساخته می‌شود ({na === 1 ? '۴ ساعت بعد' : '۲۴ ساعت بعد'}، فقط ساعت کاری).</p>
          : pre?.p1 ? <p data-testid="cq-na3-p1">تلاش بعدی ساخته نمی‌شود · اعلان به مدیر می‌رود. مشتری در فهرست تو می‌ماند.</p>
          : <p data-testid="cq-na3-cold">بعد از ۳ تلاش بی‌پاسخ، بایگانی سرد پیشنهاد می‌شود. اگر هنوز می‌خواهی پیگیری کنی «یادآور پیگیری بعدی» را بزن.</p>}</div>
    </div> : null}
    {onlyTime ? null : <>
    <div className="field">
      <label htmlFor={`${idPrefix}-one`}>یادداشت یک‌خطی <span className="req" aria-hidden="true">*</span></label>
      <input id={`${idPrefix}-one`} value={value.oneLine} maxLength={CQ_ONE_LINE_MAX} onChange={(e) => set({ oneLine: e.target.value.replace(/\n/g, ' ') })}
        className={showErrors && !value.oneLine.trim() ? 'bad' : ''} aria-invalid={showErrors && !value.oneLine.trim()} aria-describedby={`${idPrefix}-one-meta`} aria-required="true"
        placeholder="مثلاً: مدارک را تا فردا می‌فرستد" data-testid="cq-one-line" />
      <div id={`${idPrefix}-one-meta`} className={`cq-counter${atMax ? ' max' : ''}`} data-testid="cq-one-line-counter">
        {atMax ? 'به سقف رسیدی؛ بقیه را در «یادداشت کارشناس» بنویس · ' : ''}{faNum(len)} / {faNum(CQ_ONE_LINE_MAX)}</div>
    </div>
    {/* PM (81, Q2) + v1.0.1 §2.5: «پیگیری بعدی» is a separate optional step AFTER the result and the note; channel stays phone (no type picker). */}
    <fieldset className={`cq-fu crfu${value.fu ? ' on' : ''}`} data-testid="cq-fu-step"><legend>پیگیری بعدی <small>اختیاری</small></legend>
      <div className="cq-fu-toggle">
        <button type="button" role="switch" aria-checked={value.fu} className={`cq-chip cfu${value.fu ? ' on' : ''}`}
          onClick={() => set({ fu: !value.fu, outcome: cqOutcomeFor(value.manual, !value.fu) })} data-testid="cq-outcome-follow_up">
          <span className="cq-sw" aria-hidden="true"><i /></span>یادآور پیگیری بعدی بگذار</button>
        {value.fu ? null : <small className="cq-hint">اگر باید دوباره زنگ بزنی، روشنش کن و زمانش را انتخاب کن.</small>}
      </div>
      {timeStep}
    </fieldset></>}
    {onlyTime ? timeStep : null}
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
