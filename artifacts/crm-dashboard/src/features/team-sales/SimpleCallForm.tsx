import { AlertCircle, Check, ChevronLeft, ChevronRight, Phone, Timer, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fa, fmtDateTime, shortName, submitSimpleForm, TeamSalesApiError, type CallResult, type QualifyResult, type SimpleAnswers } from './api';
import './team-sales.css';

type Draft = {
  step: number; callResult: CallResult | null; callbackAt: string; amount: string;
  urgency: SimpleAnswers['urgency']; docsReady: SimpleAnswers['docsReady']; creditRank: string | null;
  cheque: 'check' | 'promissory' | 'none' | null; bounced: 'yes' | 'no' | null; note: string;
};
const EMPTY: Draft = { step: 1, callResult: null, callbackAt: '', amount: '', urgency: null, docsReady: null, creditRank: null, cheque: null, bounced: null, note: '' };
const draftKey = (userId: number | undefined, customerId: number) => `nafis-ts-simple-draft:${userId ?? 0}:${customerId}`;

const CALL_RESULTS: Array<[CallResult, string]> = [
  ['answered', 'جواب داد و صحبت کردیم'], ['no_answer', 'جواب نداد / خاموش'], ['callback', 'گفت بعداً زنگ بزنید'], ['wrong_number', 'شماره اشتباه'],
];
const URGENCY: Array<[NonNullable<SimpleAnswers['urgency']>, string]> = [['now', 'همین الان / این هفته'], ['month', 'تا یک ماه'], ['later', 'بعداً'], ['curious', 'فقط کنجکاوه']];
const DOCS: Array<[NonNullable<SimpleAnswers['docsReady']>, string]> = [['all', 'همه آماده‌ست'], ['partial', 'بخشی'], ['none', 'آماده نیست']];
const RANKS: Array<[string, string]> = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['unknown', 'نمی‌دونه']];
const CHEQUE: Array<[NonNullable<Draft['cheque']>, string]> = [['check', 'چک دارد'], ['promissory', 'فقط سفته'], ['none', 'هیچ‌کدام']];
const BOUNCED: Array<['no' | 'yes', string]> = [['no', 'خیر'], ['yes', 'بله']];
const label = <T extends string>(list: Array<[T, string]>, v: T | null | undefined) => list.find(([k]) => k === v)?.[1] ?? '';
const toDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function Chips<T extends string>({ name, list, value, onChange, cols }: { name: string; list: Array<[T, string]>; value: T | null | undefined; onChange: (v: T) => void; cols?: boolean }) {
  return <div className={`ts-chips${cols ? ' col' : ''}`} role="radiogroup" aria-label={name}>
    {list.map(([k, text]) => <button key={k} type="button" role="radio" aria-checked={value === k} className="ts-opt" onClick={() => onChange(k)} data-testid={`ts-opt-${name}-${k}`}>{text}</button>)}
  </div>;
}

export function SimpleCallForm({ customer, userId, noteMin = 30, onClose, onDone, onNext }: {
  customer: { id: number; name: string; phone: string; priority?: number | null };
  userId: number | undefined; noteMin?: number;
  onClose: () => void; onDone: (r: QualifyResult) => void; onNext: () => void;
}) {
  const key = draftKey(userId, customer.id);
  const [d, setD] = useState<Draft>(() => { try { const raw = localStorage.getItem(key); return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY; } catch { return EMPTY; } });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState('');
  const [result, setResult] = useState<QualifyResult | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!result) try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* quota */ } }, [d, key, result]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [d.step, result]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  const set = (patch: Partial<Draft>) => { setD((c) => ({ ...c, ...patch })); setErrors({}); setServerError(''); };

  const answered = d.callResult === 'answered';
  const curious = d.urgency === 'curious';
  const steps = answered ? [1, 2, 3] : [1, 3];
  const total = steps.length;
  const idx = Math.max(0, steps.indexOf(d.step)) + 1;
  const titles: Record<number, string> = { 1: 'نتیجه‌ی تماس', 2: 'سؤال‌های اصلی', 3: 'یادداشت' };

  const validate = (step: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!d.callResult) e.callResult = 'نتیجه‌ی تماس را انتخاب کن.';
      if (d.callResult === 'callback') {
        const t = d.callbackAt ? Date.parse(d.callbackAt) : NaN;
        if (Number.isNaN(t)) e.callbackAt = 'زمان تماس بعدی را مشخص کن.';
        else if (t <= Date.now()) e.callbackAt = 'زمان تماس بعدی باید در آینده باشد.';
      }
    }
    if (step === 2) {
      if (!d.urgency) e.urgency = 'فوریت را انتخاب کن.';
      if (!curious) {
        const amount = Number(toDigits(d.amount));
        if (!d.amount.trim() || !Number.isFinite(amount) || amount < 10 || amount > 5000) e.amount = 'مبلغ را بین ۱۰ تا ۵۰۰۰ میلیون تومان بنویس.';
        if (!d.docsReady) e.docsReady = 'وضعیت مدارک را انتخاب کن.';
        if (!d.creditRank) e.creditRank = 'رتبه‌ی اعتباری را انتخاب کن (یا «نمی‌دونه»).';
        if (!d.cheque) e.cheque = 'یکی از گزینه‌ها را انتخاب کن.';
        if (!d.bounced) e.bounced = 'چک برگشتی را مشخص کن.';
      }
    }
    if (step === 3) {
      const n = d.note.trim().length;
      if (n === 0) e.note = 'empty';
      else if (n < noteMin) e.note = 'short';
    }
    return e;
  };
  const next = () => {
    const e = validate(d.step);
    if (Object.keys(e).length) { setErrors(e); return; }
    const i = steps.indexOf(d.step);
    set({ step: steps[Math.min(i + 1, steps.length - 1)] });
  };
  const back = () => { const i = steps.indexOf(d.step); if (i > 0) set({ step: steps[i - 1] }); };

  const answers = useMemo<SimpleAnswers>(() => {
    const a: SimpleAnswers = { mode: 'simple', callResult: d.callResult ?? 'no_answer' };
    if (d.callResult === 'callback' && d.callbackAt) {
      // datetime-local is '' until picked; never call toISOString on an invalid date (it throws and crashes the page)
      const t = new Date(d.callbackAt);
      if (!Number.isNaN(t.getTime())) a.callbackAt = t.toISOString();
    }
    if (d.callResult === 'answered') {
      a.urgency = d.urgency;
      if (!curious) {
        a.amountMillion = Number(toDigits(d.amount));
        a.docsReady = d.docsReady; a.creditRank = d.creditRank; a.bouncedCheque = d.bounced;
        a.checkStatus = d.cheque === 'check' ? 'any' : 'none';
        a.canPromissory = d.cheque === 'none' ? 'no' : 'yes';
      }
    }
    return a;
  }, [d, curious]);

  const submit = async () => {
    for (const s of steps) { const e = validate(s); if (Object.keys(e).length) { setErrors(e); set({ step: s }); setErrors(e); return; } }
    setPending(true); setServerError('');
    try {
      const r = await submitSimpleForm(customer.id, answers, d.note.trim());
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      setResult(r); onDone(r);
    } catch (err) {
      const msg = err instanceof TeamSalesApiError && err.message ? err.message : 'اتصال به سرور برقرار نشد. چیزی ثبت نشد؛ دوباره امتحان کن.';
      setServerError(`ثبت انجام نشد: ${msg}`);
    } finally { setPending(false); }
  };

  const summary = [label(CALL_RESULTS.map(([k, v]) => [k, k === 'answered' ? 'جواب داد' : v] as [CallResult, string]), d.callResult),
    answered && !curious && d.amount ? `${fa(toDigits(d.amount))} میلیون` : '', answered ? label(URGENCY, d.urgency) : '',
    answered && !curious ? label(DOCS, d.docsReady) === 'همه آماده‌ست' ? 'مدارک کامل' : d.docsReady ? `مدارک: ${label(DOCS, d.docsReady)}` : '' : '',
    answered && !curious && d.creditRank ? (d.creditRank === 'unknown' ? 'رتبه نامعلوم' : `رتبه ${d.creditRank}`) : '',
    answered && !curious ? label(CHEQUE, d.cheque) : '', answered && !curious && d.bounced === 'yes' ? 'چک برگشتی' : '',
    d.callResult === 'callback' && d.callbackAt && !Number.isNaN(new Date(d.callbackAt).getTime()) ? `تماس بعدی: ${fmtDateTime(new Date(d.callbackAt).toISOString())}` : ''].filter(Boolean);

  const prio = customer.priority ? `اولویت ${fa(customer.priority)}` : 'بدون اولویت';
  const err = (k: string) => errors[k] && errors[k] !== 'empty' && errors[k] !== 'short' ? <p className="ts-err" role="alert" id={`ts-err-${k}`}><AlertCircle size={16} /> {errors[k]}</p> : null;
  const noteLen = d.note.trim().length;

  let body: ReactNode;
  if (result) {
    const r = result.result; const h = result.handoff;
    const none = r.priority == null; const max = r.maxAttempts ?? 3;
    const reasonsTitle = none ? 'چرا بدون اولویت؟' : `چرا اولویت ${fa(r.priority ?? 0)}؟`;
    body = <div className="ts-result" data-testid="ts-result" data-priority={none ? 'none' : r.priority} data-outcome={r.outcome} data-attempts={r.attempts}>
      <p className="ts-muted center">{none ? 'اولویتی تعیین نشد — فقط تماس بی‌پاسخ شمرده شد' : 'سیستم اولویت را تعیین کرد'}</p>
      {none
        ? <div className="ts-bignum p0" aria-label={`بی‌پاسخ ${r.attempts} از ${max}`} data-testid="ts-noanswer-count">{fa(r.attempts)}<small>از {fa(max)}</small></div>
        : <div className={`ts-bignum p${r.priority}`} aria-label={`اولویت ${r.priority}`}>{fa(r.priority ?? 0)}</div>}
      <h3 className="center">{none ? `بدون اولویت — جواب نداد (بی‌پاسخ ${fa(r.attempts)} از ${fa(max)})` : r.priority === 1 ? 'اولویت ۱ — مشتری آماده‌ی پیگیری است' : r.priority === 2 ? 'اولویت ۲ — در صف تماس دوباره‌ی شما' : r.outcome === 'invalid' ? 'اولویت ۳ — شماره نامعتبر' : r.outcome === 'cold_archive' ? 'اولویت ۳ — بایگانی سرد' : 'اولویت ۳'}</h3>
      {none ? <p className="ts-muted center" data-testid="ts-noanswer-hint">اولویت فقط وقتی تعیین می‌شود که با مشتری صحبت کنید. دفعه‌ی بعد هم همین فرم باز می‌شود؛ بعد از {fa(max)} تلاش بی‌پاسخ، بایگانی سرد.</p> : null}
      {r.outcome === 'cold_archive' ? <p className="ts-muted center" data-testid="ts-archived-hint">مشتری به «بایگانی سرد» رفت. اگه خودش دوباره پیام داد یا زنگ زد، دوباره در صف شما میاد.</p> : null}
      {h ? <>
        <div className="ts-ok-card" data-testid="ts-handoff">
          <span className="ts-av" aria-hidden="true">{shortName(h.closerName).slice(0, 1)}</span>
          <div><b>{h.message}</b><p>نوبت چرخشی — به {h.closerName} اعلان و یادآور رسید</p></div>
        </div>
        <p className="center"><span className="ts-pill ok"><Timer size={15} /> مهلت تماس {h.closerName}: ۳ ساعت کاری</span></p>
        <p className="ts-muted center">یعنی تا {h.dueLabel}</p>
      </> : null}
      {!h && r.nextActionAt && r.outcome !== 'cold_archive' ? <p className="center"><span className="ts-pill">{r.outcome === 'no_answer' ? `تلاش ${fa(r.attempts)} از ${fa(r.maxAttempts ?? 3)} — تماس دوباره:` : 'تماس دوباره:'} {fmtDateTime(r.nextActionAt)}</span></p> : null}
      {r.reasons.length ? <div className="ts-why"><b>{reasonsTitle}</b><ul>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
    </div>;
  } else if (d.step === 1) {
    body = <>
      <div className="ts-script"><b>بگو:</b><p>«سلام، وقتتون بخیر. از نفیس وام تماس می‌گیرم، شماره‌تون رو برای مشاوره‌ی وام گذاشته بودید.»</p></div>
      <fieldset className="ts-q"><legend>نتیجه‌ی تماس <span className="req">*</span></legend>
        <Chips name="callResult" list={CALL_RESULTS} value={d.callResult} onChange={(v) => set({ callResult: v })} cols />{err('callResult')}</fieldset>
      {d.callResult === 'callback' ? <div className="ts-q"><label htmlFor="ts-callback">زمان تماس بعدی <span className="req">*</span></label>
        <input id="ts-callback" className="ts-inp ltr" type="datetime-local" value={d.callbackAt} onChange={(e) => set({ callbackAt: e.target.value })} aria-invalid={Boolean(errors.callbackAt)} data-testid="ts-callback-at" />{err('callbackAt')}</div> : null}
    </>;
  } else if (d.step === 2) {
    body = <>
      <div className="ts-script"><b>بپرس:</b><p>«چه مبلغی لازم دارید و چقدر فوریه؟ مدارکتون آماده‌ست؟ رتبه‌تون چنده؟»</p></div>
      <div className="ts-q"><label htmlFor="ts-amount">مبلغ وام موردنیاز {curious ? null : <span className="req">*</span>}</label>
        <div className="ts-suffix"><input id="ts-amount" className="ts-inp" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d۰-۹٠-٩]/g, '').slice(0, 5) })} aria-invalid={Boolean(errors.amount)} data-testid="ts-amount" /><span>میلیون تومان</span></div>{err('amount')}</div>
      <fieldset className="ts-q"><legend>فوریت <span className="req">*</span></legend><Chips name="urgency" list={URGENCY} value={d.urgency} onChange={(v) => set({ urgency: v })} />{err('urgency')}</fieldset>
      {curious ? <p className="ts-muted">برای «فقط کنجکاوه» بقیه‌ی سؤال‌ها لازم نیست.</p> : <>
        <fieldset className="ts-q"><legend>مدارک <span className="req">*</span></legend><Chips name="docs" list={DOCS} value={d.docsReady} onChange={(v) => set({ docsReady: v })} />{err('docsReady')}</fieldset>
        <fieldset className="ts-q"><legend>رتبه‌ی اعتباری <span className="req">*</span></legend><Chips name="rank" list={RANKS} value={d.creditRank} onChange={(v) => set({ creditRank: v })} />{err('creditRank')}</fieldset>
        <fieldset className="ts-q"><legend>چک صیادی یا سفته دارد؟ <span className="req">*</span></legend><Chips name="cheque" list={CHEQUE} value={d.cheque} onChange={(v) => set({ cheque: v })} />{err('cheque')}</fieldset>
        <fieldset className="ts-q"><legend>چک برگشتی رفع‌نشده؟ <span className="req">*</span></legend><Chips name="bounced" list={BOUNCED} value={d.bounced} onChange={(v) => set({ bounced: v })} />{err('bounced')}</fieldset>
      </>}
    </>;
  } else {
    body = <>
      <div className="ts-script"><b>قبل از قطع تماس:</b><p>«ممنون از وقتتون. همکارم به‌زودی با‌هاتون تماس می‌گیره.» یادداشت کامل بنویس تا مشتری مجبور نشه همه‌چیز رو دوباره تعریف کنه.</p></div>
      {errors.note === 'empty' ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> بدون یادداشت نمی‌شه ثبت کرد. چند خط از صحبت با مشتری بنویس.</div> : null}
      <div className="ts-q"><label htmlFor="ts-note">یادداشت تماس <span className="req">*</span></label>
        <textarea id="ts-note" className={`ts-inp ts-note${errors.note ? ' bad' : ''}`} rows={5} value={d.note} onChange={(e) => set({ note: e.target.value.slice(0, 4000) })} placeholder="مثلاً: شغل، مبلغ، ضامن، بهترین ساعت تماس…" aria-invalid={Boolean(errors.note)} aria-describedby="ts-note-meta" data-testid="ts-note" />
        <div className="ts-note-meta" id="ts-note-meta"><span className={errors.note ? 'bad' : ''}>{errors.note === 'empty' ? 'یادداشت الزامی است' : errors.note === 'short' ? `یادداشت باید حداقل ${fa(noteMin)} حرف باشد` : ''}</span><span className={noteLen < noteMin ? (errors.note ? 'bad' : '') : 'okc'} data-testid="ts-note-count">{fa(noteLen)} / حداقل {fa(noteMin)}</span></div></div>
      {summary.length ? <div className="ts-summary"><span className="ts-muted">خلاصه:</span>{summary.map((s, i) => <span key={i} className="ts-pill">{s}</span>)}</div> : null}
      {serverError ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> {serverError}</div> : null}
    </>;
  }

  const lastStep = d.step === steps[steps.length - 1];
  return <div className="ts-layer" dir="rtl">
    <div className="ts-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={dialogRef} className="ts-wz" role="dialog" aria-modal="true" aria-labelledby="ts-wz-title" tabIndex={-1} data-testid="ts-simple-form">
      <div className="ts-wz-head">
        <div className="ts-wz-who">
          <h2 id="ts-wz-title">فرم تماس — {customer.name}</h2>
          <div className="sub"><span className="ltr">{fa(customer.phone)}</span> — <span>{prio}</span> <span className="ts-badge">نسخه‌ی ساده</span></div>
        </div>
        <a className="ts-ib call" href={`tel:${customer.phone}`} aria-label="تماس با مشتری"><Phone size={20} /></a>
        <button type="button" className="ts-ib" onClick={onClose} aria-label="بستن" data-testid="ts-close"><X size={22} /></button>
      </div>
      <div className="ts-progress">
        <div className="row"><b>{result ? 'نتیجه' : titles[d.step]}</b><span className="ts-muted">{result ? 'ثبت شد' : `مرحله ${fa(idx)} از ${fa(total)}`}</span></div>
        <div className="bars" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} className={result || i < idx ? 'on' : ''} />)}</div>
      </div>
      <div className="ts-wz-body" ref={bodyRef}>{body}</div>
      <div className="ts-wz-foot">
        {result ? <div className="ts-two">
          <button type="button" className="ts-ghost" onClick={onClose} data-testid="ts-open-file">پرونده مشتری</button>
          <button type="button" className="ts-primary" onClick={onNext} data-testid="ts-next-customer">مشتری بعدی صف</button>
        </div> : <div className="ts-two grow">
          {idx > 1 ? <button type="button" className="ts-ghost narrow" onClick={back}><ChevronRight size={18} /> قبلی</button> : <button type="button" className="ts-ghost narrow" onClick={onClose}>بستن</button>}
          {lastStep ? <button type="button" className="ts-primary" onClick={submit} disabled={pending} data-testid="ts-submit"><Check size={18} /> {pending ? 'در حال ثبت…' : d.callResult === 'no_answer' ? 'ثبت تماس بی‌پاسخ' : 'ثبت و تعیین اولویت'}</button>
            : <button type="button" className="ts-primary" onClick={next} data-testid="ts-next">بعدی <ChevronLeft size={18} /></button>}
        </div>}
        {!result ? <p className="ts-muted center small">پیش‌نویس روی همین دستگاه نگه داشته می‌شود</p> : null}
      </div>
    </div>
  </div>;
}
