/**
 * /request lead wizard (designer mockup request.html, UX-SPEC §5).
 * amount → contact (2 steps). Legal 2026-10-24: the customer is never asked a request type (cash / goods); the old
 * «need» step is gone, old `?need=` links load normally and the parameter is ignored, and every lead is sent with
 * need='help' (lib/lead LEAD_NEED). With ?plan=&term= the plan step counts as done: 2 steps, opening on contact with
 * the plan summary on top («تغییر» returns to the amount step). «هنوز مطمئن نیستم» on the amount step sends
 * amountBand='unsure'. Amount bands = received amount over EVERY active plan; empty bands hide (ANSWERS-1 §3).
 * Options enter neutral: no preselection and no hover look until the pointer moves (§4 of the mismatch list); focus
 * rings only via :focus-visible; no autofocus on fields. State survives reloads (sessionStorage) and the browser back
 * button moves between steps (history.pushState). Success is shown ONLY after the CRM answers 2xx; the tracking code
 * line only when the CRM returned one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I, type SpriteIcon } from '../ui/I';
import { useLoanPlans } from './useLoanPlans';
import { LONG_NAME, QA } from './PlanCard';
import type { LoanPlan } from '../../lib/loan-plans';
import { combos, fa, millionsFa, reqBands, type AmountBand, type Combo } from '../../lib/plans';
import { isValidMobile } from '../../lib/format';
import { LeadError, readUtm, submitLead, type ContactTime } from '../../lib/lead';
import { SITE } from '../../lib/site';
import { stepOrder } from '../../lib/request-flow';
import { CONSENT_TEXT } from '../../lib/callback';

type Step = 'amount' | 'contact' | 'done';
const KEY = 'nf-request';
const BAND_ICON: SpriteIcon[] = ['s', 'm', 'm', 'l', 'l', 'l'];

interface State {
  band: AmountBand | 'unsure' | null;
  planId: number | null;
  term: number | null;
  name: string;
  phone: string;
  time: ContactTime;
  startedAt: number;
  src: string | null;
}
const fresh = (): State => ({ band: null, planId: null, term: null, name: '', phone: '', time: 'any', startedAt: Date.now(), src: null });

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
  const bands = useMemo(() => reqBands(all), [all]);
  const [fresh_, setFresh] = useState(true);
  const [step, setStep] = useState<Step>('amount');
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

  // init: sessionStorage + query (?plan, ?term, ?src; a legacy ?need is ignored)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    let st = fresh();
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null;
      if (saved && Date.now() - saved.startedAt < 20 * 3600e3) {
        const { need: _legacyNeed, ...rest } = saved as State & { need?: unknown }; // pre-legal saved state
        st = { ...st, ...rest };
      }
    } catch {
      /* ignore */
    }
    const plan = Number(q.get('plan')) || null;
    if (plan) {
      const c = all.find((x) => x.id === plan);
      if (c) st = { ...st, planId: plan, term: Number(q.get('term')) || c.term };
    }
    if (q.get('src')) st.src = q.get('src');
    if (QA && q.get('longname')) setLongName(q.get('longname') === '1' ? LONG_NAME : q.get('longname'));
    const skipAmount = reqBands(all).length === 0;
    if (skipAmount) st.band = 'unsure';
    setS(st);
    const first: Step = st.planId || skipAmount ? 'contact' : 'amount';
    let savedStep = (history.state as { step?: string } | null)?.step as Step | 'need' | undefined;
    if (savedStep === 'need') savedStep = 'amount'; // history entry from the pre-legal wizard
    let start: Step = savedStep && savedStep !== 'done' ? savedStep : first;
    if (st.planId && start !== 'contact') start = 'contact';
    if (skipAmount && start === 'amount') start = 'contact';
    history.replaceState({ step: start }, '');
    setStep(start);
    setReady(true);
    const onPop = (e: PopStateEvent) => {
      const to = (e.state as { step?: string } | null)?.step;
      if (to === 'need') setStep('amount');
      else if (to === 'amount' || to === 'contact') setStep(to);
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
  const ORDER = stepOrder(!!chosen, bands.length);
  const idx = ORDER.indexOf(step);

  const pick = <K extends keyof State>(k: K, v: State[K], next: Step) => {
    setS((p) => ({ ...p, [k]: v }));
    setTimeout(() => go(next), 180);
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
            <Opt
              data-band="unsure"
              icon="chat"
              t="هنوز مطمئن نیستم"
              h="کارشناس مبلغ و شرایط را با شما مرور می‌کند"
              pressed={s.band === 'unsure'}
              onClick={() => pick('band', 'unsure', 'contact')}
            />
          </div>
        </section>

        <section className="rq-step" data-step="contact" hidden={step !== 'contact'}>
          {chosen && (
            <div className="chosen">
              <span className="ic">
                <I name="check" />
              </span>
              <span className="tx">
                <small>طرح انتخابی شما</small>
                <b>{longName ?? chosen.name}</b>
                <small>
                  واریزی حدود {millionsFa(chosen.payout)} م · قسط {fa(chosen.term)} ماهه حدود {millionsFa(chosen.inst)} م
                </small>
              </span>
              <button
                type="button"
                onClick={() => {
                  setS((p) => ({ ...p, planId: null, term: null, band: null }));
                  const to: Step = bands.length ? 'amount' : 'contact';
                  history.replaceState({ step: to }, '', location.pathname + (s.src ? `?src=${encodeURIComponent(s.src)}` : ''));
                  setStep(to);
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
              ثبت نشد. لطفاً دوباره تلاش کنید.
              {/* HANDOFF §0 v1.2 #10: resends exactly the data already entered (state is kept on failure) */}
              <button type="button" className="nf-btn nf-btn--secondary alert-retry" disabled={busy} onClick={() => void onSubmit({ preventDefault() {} })}>
                دوباره تلاش کنید
              </button>
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
          <p>کارشناس در ساعت کاری با شما تماس می‌گیرد.</p>
          {code && (
            <div className="code-wrap">
              <div className="code">
                کد پیگیری: <b dir="ltr">{code}</b>
              </div>
            </div>
          )}
          <div className="row">
            <a className="nf-btn nf-btn--primary nf-btn--block" href={SITE.portal}>
              <I name="login" /> پیگیری در پنل مشتریان
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
