/**
 * /request lead wizard (designer mockup request.html, UX-SPEC §5).
 * need → amount → contact (3 steps). With ?plan=&term= the plan step counts as done: 2 steps, opening on contact
 * with the plan summary on top («تغییر» returns to the 3-step flow). need=help («نمی‌دانم») skips the amount step:
 * need → contact (2 steps), amountBand='unsure' (designer ANSWERS-1 §6). Amount bands = received amount from the
 * plan data filtered by need (cash → loanType score, goods → goods), counted after filtering; empty bands hide
 * (ANSWERS-1 §3). Options enter neutral: no preselection and no hover look until the pointer moves (§4 of the
 * mismatch list); focus rings only via :focus-visible; no autofocus on fields. State survives reloads (sessionStorage) and the
 * browser back button moves between steps (history.pushState). Success is shown ONLY after the CRM answers 2xx;
 * the tracking code line only when the CRM returned one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I, type SpriteIcon } from '../ui/I';
import { useLoanPlans } from './useLoanPlans';
import { LONG_NAME, QA } from './PlanCard';
import type { LoanPlan } from '../../lib/loan-plans';
import { combos, fa, millionsFa, reqBands, type AmountBand, type Combo } from '../../lib/plans';
import { isValidMobile } from '../../lib/format';
import { LeadError, readUtm, submitLead, type ContactTime, type Need } from '../../lib/lead';
import { SITE } from '../../lib/site';
import { combosForNeed, stepOrder } from '../../lib/request-flow';
import { CONSENT_TEXT } from '../../lib/callback';

type Step = 'need' | 'amount' | 'contact' | 'done';
const KEY = 'nf-request';
const BAND_ICON: SpriteIcon[] = ['s', 'm', 'm', 'l', 'l', 'l'];

interface State {
  need: Need | null;
  band: AmountBand | 'unsure' | null;
  planId: number | null;
  term: number | null;
  name: string;
  phone: string;
  time: ContactTime;
  startedAt: number;
  src: string | null;
}
const fresh = (): State => ({ need: null, band: null, planId: null, term: null, name: '', phone: '', time: 'any', startedAt: Date.now(), src: null });

const NEEDS: { v: Need; icon: SpriteIcon; t: string; h: string }[] = [
  { v: 'cash', icon: 'cash', t: 'پول نقد (وام)', h: 'وام نقدی بر پایه اعتبارسنجی' },
  { v: 'goods', icon: 'cart', t: 'خرید کالا به‌صورت قسطی', h: 'کالا را می‌گیرید و قسطی پرداخت می‌کنید' },
  { v: 'help', icon: 'chat', t: 'نمی‌دانم، راهنمایی می‌خواهم', h: 'کارشناس با شما تماس می‌گیرد' },
];
const TIMES: { v: ContactTime; t: string }[] = [
  { v: 'morning', t: 'صبح' },
  { v: 'evening', t: 'عصر' },
  { v: 'any', t: 'فرقی نمی‌کند' },
];

/** Received-amount band key of a combo (for leads that come with a preselected plan). */
const bandKeyOf = (c: Combo, all: Combo[]): AmountBand | 'unsure' =>
  (reqBands(all).find((b) => c.payout > b.lo && c.payout <= b.hi)?.key as AmountBand | undefined) ?? 'unsure';
const Opt = ({ icon, t, h, pressed, onClick, ...rest }: { icon: SpriteIcon; t: string; h: string; pressed: boolean; onClick: () => void; [k: `data-${string}`]: string }) => (
  <button type="button" className="nf-option" aria-pressed={pressed} onClick={onClick} {...rest}>
    <span className="ic">
      <I name={icon} />
    </span>
    <span className="tx">
      <b>{t}</b>
      <small>{h}</small>
    </span>
    <I name="chev" className="chev" />
  </button>
);

export default function RequestWizard({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  const all = useMemo(() => combos(plans), [plans]);
  const [s, setS] = useState<State>(fresh);
  const bands = useMemo(() => reqBands(combosForNeed(all, s.need)), [all, s.need]);
  const [fresh_, setFresh] = useState(true);
  const [step, setStep] = useState<Step>('need');
  const [ready, setReady] = useState(false);
  const [errors, setErrors] = useState<{ name?: boolean; mob?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const sending = useRef(false); // synchronous lock: a 2nd tap in the same frame must not post twice
  const [fail, setFail] = useState(false);
  const [code, setCode] = useState<string | undefined>();
  const [longName, setLongName] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const failRef = useRef<HTMLDivElement>(null);

  // init: sessionStorage + query (?plan, ?term, ?need, ?src)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    let st = fresh();
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null;
      if (saved && Date.now() - saved.startedAt < 20 * 3600e3) st = { ...st, ...saved };
    } catch {
      /* ignore */
    }
    const plan = Number(q.get('plan')) || null;
    if (plan) {
      const c = all.find((x) => x.id === plan);
      if (c) st = { ...st, planId: plan, term: Number(q.get('term')) || c.term, need: c.type === 'goods' ? 'goods' : 'cash' };
    }
    const need = q.get('need');
    if (!plan && (need === 'cash' || need === 'goods' || need === 'help')) st.need = need;
    if (q.get('src')) st.src = q.get('src');
    if (QA && q.get('longname')) setLongName(q.get('longname') === '1' ? LONG_NAME : q.get('longname'));
    const skipAmount = st.need === 'help' || (!!st.need && reqBands(combosForNeed(all, st.need)).length === 0);
    if (skipAmount) st.band = 'unsure';
    setS(st);
    const first: Step = st.planId ? 'contact' : st.need ? (skipAmount ? 'contact' : 'amount') : 'need';
    const savedStep = (history.state as { step?: Step } | null)?.step;
    let start = savedStep && savedStep !== 'done' ? savedStep : first;
    if (st.planId && start !== 'contact') start = 'contact';
    if (skipAmount && start === 'amount') start = 'contact';
    if (!st.planId && start !== 'need' && !savedStep) {
      // deep link (?need=…): give «قبلی» / browser back a need step to return to
      history.replaceState({ step: 'need' }, '');
      history.pushState({ step: start }, '');
    } else history.replaceState({ step: start }, '');
    setStep(start);
    setReady(true);
    const onPop = (e: PopStateEvent) => {
      const to = (e.state as { step?: Step } | null)?.step;
      if (to && to !== 'done') setStep(to);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      if (step === 'done') sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage blocked */
    }
  }, [s, step, ready]);

  const go = useCallback((to: Step) => {
    if (to !== 'done') history.pushState({ step: to }, '');
    else history.replaceState({ step: 'done' }, '');
    setStep(to);
  }, []);

  // focus the step heading on step change (not on first paint)
  const painted = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!painted.current) {
      painted.current = true;
      return;
    }
    scrollTo(0, 0);
    setFresh(true);
    root.current?.querySelector<HTMLElement>('.rq-step:not([hidden]) h1')?.focus({ preventScroll: true });
  }, [step, ready]);

  const chosen = s.planId ? (all.find((c) => c.id === s.planId && c.term === s.term) ?? all.find((c) => c.id === s.planId)) : null;
  const ORDER = stepOrder(!!chosen, s.need, bands.length);
  const idx = ORDER.indexOf(step);

  const pick = <K extends keyof State>(k: K, v: State[K], next: Step) => {
    setS((p) => ({ ...p, [k]: v }));
    setTimeout(() => go(next), 180);
  };
  const pickNeed = (v: Need) => {
    const skip = v === 'help' || reqBands(combosForNeed(all, v)).length === 0;
    // a different need invalidates the chosen band (its counts were for the other need)
    setS((p) => ({ ...p, need: v, band: skip ? 'unsure' : p.need === v && p.band !== 'unsure' ? p.band : null }));
    setTimeout(() => go(skip ? 'contact' : 'amount'), 180);
  };

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (busy || sending.current) return; // sending: the button is disabled; Enter in a field must not post twice
    const bad = { name: !s.name.trim(), mob: !isValidMobile(s.phone) };
    setErrors(bad);
    const first = (['name', 'mob'] as const).find((k) => bad[k]);
    if (first) {
      document.getElementById(`f-${first}`)?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setFail(false);
    try {
      const res = await submitLead({
        name: s.name,
        phone: s.phone,
        need: s.need ?? 'help',
        amountBand: chosen ? bandKeyOf(chosen, all) : ORDER.includes('amount') ? (s.band ?? 'unsure') : 'unsure',
        planId: chosen ? s.planId : null,
        term: chosen ? s.term : null,
        contactTime: s.time,
        src: s.src,
        consent: true, // P3-C: consent = submitting under CONSENT_TEXT
        website: honeypot.current?.value ?? '',
        startedAt: s.startedAt,
        utm: readUtm(),
      });
      setCode(res.trackingCode);
      go('done');
    } catch (err) {
      console.warn('lead submit failed:', err instanceof LeadError ? `${err.code} ${err.status}` : err);
      setFail(true); // entered values stay in state
      requestAnimationFrame(() => failRef.current?.focus());
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const setField = <K extends keyof State>(k: K) => (v: State[K]) => setS((p) => ({ ...p, [k]: v }));

  return (
    <div className="rq-wrap" ref={root} data-fresh={fresh_ ? '' : undefined} onPointerMove={fresh_ ? () => setFresh(false) : undefined}>
      <div className="rq-card">
        <div className="rq-head" hidden={step === 'done'}>
          <div className="top">
            <button type="button" className="back" aria-label="مرحله قبل" hidden={idx <= 0 || !!chosen} onClick={() => history.back()}>
              <I name="back" size={20} />
              قبلی
            </button>
            <span className="count">
              مرحله {fa(idx + 1)} از {fa(ORDER.length)}
            </span>
          </div>
          <div
            className="nf-progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={ORDER.length}
            aria-valuenow={idx + 1}
            aria-label="پیشرفت درخواست"
            style={{ ['--steps' as string]: ORDER.length }}
          >
            {ORDER.map((k, i) => (
              <span key={k} className={i < idx ? 'is-done' : i === idx ? 'is-current' : undefined} />
            ))}
          </div>
        </div>

        <section className="rq-step" data-step="need" hidden={step !== 'need'}>
          <h1 tabIndex={-1}>چه چیزی لازم دارید؟</h1>
          <p className="sub">یکی را انتخاب کنید. اگر مطمئن نیستید، گزینه آخر را بزنید.</p>
          <div className="opts" role="group" aria-label="نوع نیاز">
            {NEEDS.map((n) => (
              <Opt key={n.v} data-need={n.v} icon={n.icon} t={n.t} h={n.h} pressed={s.need === n.v} onClick={() => pickNeed(n.v)} />
            ))}
          </div>
        </section>

        <section className="rq-step" data-step="amount" hidden={step !== 'amount'}>
          <h1 tabIndex={-1}>حدوداً چه مبلغی لازم دارید؟</h1>
          <p className="sub">مبلغی که به دست شما می‌رسد. دقیقش را کارشناس با شما مرور می‌کند.</p>
          <div className="opts" role="group" aria-label="حدود مبلغ">
            {bands.map((b, k) => (
              <Opt
                key={b.key}
                data-band={b.key}
                icon={BAND_ICON[k] ?? 'l'}
                t={b.label}
                h={`${fa(b.n)} طرح فعال`}
                pressed={s.band === b.key}
                onClick={() => pick('band', b.key as AmountBand, 'contact')}
              />
            ))}
          </div>
        </section>

        <section className="rq-step" data-step="contact" hidden={step !== 'contact'}>
          {chosen && (
            <div className="chosen">
              <span className="ic">
                <I name={chosen.type === 'goods' ? 'cart' : 'cash'} />
              </span>
              <span className="tx">
                <small>طرح انتخابی شما</small>
                <b>{longName ?? chosen.name}</b>
                <small>
                  دریافتی حدود {millionsFa(chosen.payout)} م · قسط {fa(chosen.term)} ماهه حدود {millionsFa(chosen.inst)} م
                </small>
              </span>
              <button
                type="button"
                onClick={() => {
                  setS((p) => ({ ...p, planId: null, term: null, need: null, band: null }));
                  history.replaceState({ step: 'need' }, '', location.pathname + (s.src ? `?src=${encodeURIComponent(s.src)}` : ''));
                  setStep('need');
                }}
              >
                تغییر
              </button>
            </div>
          )}
          <h1 tabIndex={-1}>چطور با شما تماس بگیریم؟</h1>
          <p className="sub">فقط برای تماس کارشناس؛ شماره‌تان جای دیگری استفاده نمی‌شود.</p>
          <div className="alert" id="rq-fail" role="alert" tabIndex={-1} ref={failRef} hidden={!fail}>
            <I name="alert" />
            <span>
              ثبت نشد. لطفاً دوباره تلاش کنید یا با <a href={SITE.tel}>{SITE.phoneFa}</a> تماس بگیرید.
            </span>
          </div>
          <form className="fields" id="rq-form" noValidate onSubmit={onSubmit}>
            <div className="nf-field">
              <label className="nf-label" htmlFor="f-name">
                نام و نام خانوادگی
              </label>
              <input
                className="nf-input"
                id="f-name"
                name="name"
                autoComplete="name"
                maxLength={80}
                value={s.name}
                aria-invalid={errors.name ?? false}
                aria-describedby="e-name"
                onChange={(e) => setField('name')(e.target.value)}
              />
              <span className="nf-error" id="e-name" hidden={!errors.name}>
                <I name="alert" />
                لطفاً نام خود را بنویسید.
              </span>
            </div>
            <div className="nf-field">
              <label className="nf-label" htmlFor="f-mob">
                شماره موبایل
              </label>
              <input
                className="nf-input nf-input--ltr"
                id="f-mob"
                name="mobile"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                dir="ltr"
                placeholder="۰۹۱۲ ۳۴۵ ۶۷۸۹"
                maxLength={16}
                value={s.phone}
                aria-invalid={errors.mob ?? false}
                aria-describedby="e-mob"
                onChange={(e) => setField('phone')(e.target.value)}
              />
              <span className="nf-error" id="e-mob" hidden={!errors.mob}>
                <I name="alert" />
                شماره موبایل باید ۱۱ رقم باشد و با ۰۹ شروع شود.
              </span>
            </div>
            <div className="nf-field">
              <span className="nf-label" id="l-time">
                چه زمانی تماس بگیریم؟
              </span>
              <div className="chips" role="radiogroup" aria-labelledby="l-time" id="f-time">
                {TIMES.map((t) => (
                  <button key={t.v} type="button" role="radio" aria-checked={s.time === t.v} onClick={() => setField('time')(t.v)}>
                    {t.t}
                  </button>
                ))}
              </div>
            </div>
            {/* honeypot: real people never see or fill this */}
            <div aria-hidden="true" style={{ position: 'absolute', insetInlineStart: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor="f-website">وب‌سایت</label>
              <input ref={honeypot} id="f-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>
            <button className="nf-btn nf-btn--primary nf-btn--block" type="submit" id="rq-submit" disabled={busy} aria-busy={busy}>
              {busy ? 'در حال ثبت…' : 'ثبت درخواست'}
            </button>
          </form>
          <p className="privacy-note consent-note" data-consent>
            <I name="lock" />
            {CONSENT_TEXT}
          </p>
          <p className="privacy-note">ثبت درخواست هیچ تعهدی برای شما ایجاد نمی‌کند.</p>
        </section>

        <section className="rq-step done" data-step="done" hidden={step !== 'done'}>
          <div className="big">
            <I name="check" />
          </div>
          <h1 tabIndex={-1}>درخواست شما ثبت شد</h1>
          <p>کارشناسان ما در اولین زمان کاری با شما تماس می‌گیرند.</p>
          {code && (
            <div className="code-wrap">
              <div className="code">
                کد پیگیری: <b dir="ltr">{code}</b>
              </div>
            </div>
          )}
          <div className="row">
            <a className="nf-btn nf-btn--secondary nf-btn--block" href={SITE.portal}>
              <I name="login" /> پیگیری در پنل مشتریان
            </a>
            <a className="nf-btn nf-btn--secondary nf-btn--block" href={SITE.tel}>
              <I name="phone" /> تماس: <span dir="ltr">{SITE.phoneFa}</span>
            </a>
          </div>
          <p style={{ marginTop: 16 }}>
            <a className="nf-btn nf-btn--text" href="/">
              بازگشت به صفحه اصلی
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
