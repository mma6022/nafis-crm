/**
 * /request «ثبت درخواست» — the site's ONE form, 8 steps (site-credit-noinst v1.0 + v1.1, Armita; was the release-82
 * 7-step wizard of site-apply-wizard v1.0.1).
 * 1 name+mobile · 2 amount (+ optional purpose) · 3 job · 4 credit rank (A–E + «نمی‌دونم», new) · 5 documents (multi,
 * «هیچ‌کدام» exclusive) · 6 military card + retiree referral · 7 bounced cheque / overdue · 8 timing → one thank-you page
 * for everyone (masked mobile; no priority, no expert name, no SMS code). Rules + payload: lib/apply.ts.
 * - v1.1: only name + mobile are required. Steps 2–8 have «رد کردن» (moves on without an answer); step 1 has
 *   «فعلاً فقط تماس بگیرید», which submits name + mobile only. No contact-time step.
 * - Deep links: ?plan=&term= (chosen plan on step 1), ?amount= (calculator → amount_range prefill), ?src= (a consult
 *   entry shows «منبع: مشاوره‌ی رایگان»; no src → 'request'), utm_* (BaseLayout). guarantee= is context only.
 * - Honeypot `website` filled → the same thank-you page, NO POST. A submit with answers waits until 8 s of fill time
 *   passed (CRM rule); a name + mobile only submit waits only for the CRM's general 3 s (§6 #12). Success only after a
 *   2xx; any failure keeps the answers + retry.
 * - State survives a reload (sessionStorage) and the browser back button moves between steps (history.pushState).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { I, type SpriteIcon } from '../ui/I';
import { useLoanPlans } from './useLoanPlans';
import type { LoanPlan } from '../../lib/loan-plans';
import { combos, fa } from '../../lib/plans';
import { CONTACT, contactTelHref } from '../../lib/site';
import { LeadError, readUtm } from '../../lib/lead';
import {
  AMOUNT_RANGES, APPLY_CONSENT_TEXT, APPLY_STEPS, CREDIT_RANKS, DOCUMENTS, JOB_STATUSES, LOAN_PURPOSES, MILITARY,
  NEED_TIMINGS, YES_NO, emptyAnswers, isConsultSrc, maskMobile, minFillFor, readAmountParam, shouldPost, stepErrors,
  submitApply, toggleDoc, type ApplyAnswers, type CreditRank, type StepErrors,
} from '../../lib/apply';

const KEY = 'nf-apply';
interface Saved { a: ApplyAnswers; step: number; startedAt: number; planId: number | null; term: number | null; src: string | null }
type Opt = readonly [string, string, ...string[]];

const TITLES: { t: string; sub?: string }[] = [
  { t: 'برای تماس کارشناس، اسم و شماره‌تان را بنویسید', sub: 'کد پیامکی لازم نیست. شماره فقط برای تماس کارشناس نفیس وام است.' },
  { t: 'حدوداً چه مبلغی لازم دارید؟', sub: 'یک بازه را انتخاب کنید؛ کارشناس جزئیات را با شما بررسی می‌کند.' },
  { t: 'وضعیت شغلی‌تان کدام است؟' },
  { t: 'رتبه‌ی اعتباری‌تان کدام است؟' },
  { t: 'کدام‌یک از این‌ها را دارید؟', sub: 'هرچند تا که دارید را انتخاب کنید.' },
  { t: 'دو سؤال کوتاه' },
  { t: 'چک برگشتی یا بدهی معوق بانکی دارید؟', sub: 'جواب «بله» درخواست را رد نمی‌کند؛ کارشناس راه مناسب را بررسی می‌کند.' },
  { t: 'وام را کی لازم دارید؟' },
];

const Err = ({ id, children }: { id: string; children: string }) => (
  <p className="nf-error" id={id} role="alert">
    <I name="alert" size={18} />
    {children}
  </p>
);

export default function ApplyWizard({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  const all = useMemo(() => combos(plans), [plans]);
  const [a, setA] = useState<ApplyAnswers>(emptyAnswers);
  const [step, setStep] = useState(0); // 0..7, 8 = thank-you
  const [err, setErr] = useState<StepErrors>({});
  const [meta, setMeta] = useState({ startedAt: Date.now(), planId: null as number | null, term: null as number | null, src: null as string | null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const [masked, setMasked] = useState('');
  const sending = useRef(false);
  const t0 = useRef(0); // performance.now() when the wizard opened (monotonic fill timer)
  const honeypot = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const failRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    t0.current = performance.now();
    const q = new URLSearchParams(location.search);
    let s: Saved | null = null;
    try {
      s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Saved | null;
      if (!s || Date.now() - s.startedAt > 20 * 3600e3 || !s.a) s = null;
    } catch {
      s = null;
    }
    const m = { startedAt: s?.startedAt ?? Date.now(), planId: s?.planId ?? null, term: s?.term ?? null, src: s?.src ?? null };
    const plan = Number(q.get('plan')) || null;
    if (plan) {
      const c = all.find((x) => x.id === plan);
      if (c) Object.assign(m, { planId: plan, term: Number(q.get('term')) || c.term });
    }
    if (q.get('src')) m.src = q.get('src');
    setMeta(m);
    const amount = readAmountParam(q.get('amount')); // calculator: prefill only, the customer can change or skip it
    if (s) setA({ ...emptyAnswers(), ...s.a, ...(amount && !s.a.amount_range ? { amount_range: amount } : {}) });
    else if (amount) setA({ ...emptyAnswers(), amount_range: amount });
    const h = (history.state as { ap?: number } | null)?.ap;
    const start = typeof h === 'number' && h >= 0 && h < APPLY_STEPS ? h : (s?.step ?? 0);
    history.replaceState({ ap: start }, '');
    setStep(Math.min(Math.max(start, 0), APPLY_STEPS - 1));
    setReady(true);
    const onPop = (e: PopStateEvent) => {
      const to = (e.state as { ap?: number } | null)?.ap;
      if (typeof to === 'number' && to >= 0 && to < APPLY_STEPS) {
        setErr({});
        setStep((cur) => (cur >= APPLY_STEPS ? cur : to)); // no way back into the form after the thank-you page
      }
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      if (step >= APPLY_STEPS) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, JSON.stringify({ a, step, ...meta } satisfies Saved));
    } catch {
      /* storage blocked */
    }
  }, [a, step, meta, ready]);

  const painted = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!painted.current) {
      painted.current = true;
      return;
    }
    scrollTo(0, 0);
    root.current?.querySelector<HTMLElement>(step >= APPLY_STEPS ? '.wz-done' : '.rq-step h1')?.focus({ preventScroll: true });
  }, [step, ready]);

  const go = useCallback((to: number) => {
    if (to < APPLY_STEPS) history.pushState({ ap: to }, '');
    else history.replaceState({ ap: 'done' }, '');
    setStep(to);
  }, []);

  const set = <K extends keyof ApplyAnswers>(k: K, v: ApplyAnswers[K]) => {
    setA((p) => ({ ...p, [k]: v }));
    setErr((p) => {
      const n = { ...p };
      delete n[k];
      return n;
    });
  };

  const done = (mob: string) => {
    setMasked(maskMobile(mob));
    go(APPLY_STEPS);
  };

  const quickRef = useRef(false);
  async function send(quick = quickRef.current) {
    if (busy || sending.current) return;
    quickRef.current = quick;
    if (!shouldPost(honeypot.current?.value)) return done(a.mobile); // bot: same thank-you page, nothing sent
    sending.current = true;
    setBusy(true);
    setFail(false);
    try {
      const wait = minFillFor(a, quick) + 250 - (performance.now() - t0.current);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // client-side guard (8 s with answers, 3 s name + mobile only; the CRM enforces it too)
      await submitApply(a, { ...meta, utm: readUtm(), fillMs: performance.now() - t0.current }, undefined, undefined, { quick });
      done(a.mobile);
    } catch (e) {
      console.warn('apply submit failed:', e instanceof LeadError ? `${e.code} ${e.status}` : 'error');
      setFail(true);
      requestAnimationFrame(() => failRef.current?.focus());
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    const bad = stepErrors(step, a);
    setErr(bad);
    if (Object.keys(bad).length) {
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"], .wz-opts.bad .wz-o')?.focus());
      return;
    }
    if (step < APPLY_STEPS - 1) go(step + 1);
    else void send(false);
  }

  /** v1.1 «رد کردن» (steps 2–8): on without an answer for this step; on the last step it submits what was answered. */
  function skip() {
    setErr({});
    if (step < APPLY_STEPS - 1) go(step + 1);
    else void send(false);
  }

  /** v1.1 «فعلاً فقط تماس بگیرید» (step 1): name + mobile only, the optional answers stay empty. */
  function quickCall() {
    const bad = stepErrors(0, a);
    setErr(bad);
    if (Object.keys(bad).length) {
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    void send(true);
  }

  // arrow keys inside a radiogroup (RTL: right = previous)
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const L = [...(e.currentTarget.parentElement?.children ?? [])] as HTMLButtonElement[];
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : -1;
    const nx = L[(L.indexOf(e.currentTarget) + d + L.length) % L.length];
    e.preventDefault();
    nx?.click();
    nx?.focus();
  };

  const radios = <K extends keyof ApplyAnswers>(k: K, L: readonly Opt[], o: { cols?: string; req?: boolean; hint?: string; msg?: string; icons?: boolean } = {}) => {
    const cur = a[k] as string | undefined;
    const bad = !!err[k];
    const desc = [o.hint, bad ? `${k}-e` : ''].filter(Boolean).join(' ') || undefined;
    return (
      <>
        <div className={`wz-opts${o.cols ? ' ' + o.cols : ''}${bad ? ' bad' : ''}`} role="radiogroup" aria-labelledby={`${k}-l`} aria-required={o.req || undefined} aria-invalid={bad || undefined} aria-describedby={desc}>
          {L.map(([v, t, ic, sm], n) => {
            const on = cur === v;
            const tab = on || (!L.some((x) => x[0] === cur) && n === 0);
            return (
              <button
                key={v}
                type="button"
                className="nf-option wz-o"
                role="radio"
                aria-checked={on}
                tabIndex={tab ? 0 : -1}
                data-k={k}
                data-v={v}
                onKeyDown={onRadioKey}
                onClick={() => set(k, (on && k === 'loan_purpose' ? undefined : v) as ApplyAnswers[K])}
              >
                {o.icons && ic ? (
                  <span className="ic">
                    <I name={ic as SpriteIcon} size={22} />
                  </span>
                ) : (
                  <span className="rd" aria-hidden="true" />
                )}
                <span className="tx">
                  <b>{t}</b>
                  {sm && <small>{sm}</small>}
                </span>
              </button>
            );
          })}
        </div>
        {bad && <Err id={`${k}-e`}>{o.msg ?? 'یکی از گزینه‌ها را انتخاب کنید.'}</Err>}
      </>
    );
  };
  const q = (k: string, t: string, o: { opt?: boolean; vh?: boolean } = {}) => (
    <h2 className={`wz-q${o.vh ? ' vh' : ''}`} id={`${k}-l`}>
      {t}
      {o.opt && <span className="opt"> (اختیاری)</span>}
    </h2>
  );

  const consult = isConsultSrc(meta.src);
  const chosen = meta.planId ? (all.find((c) => c.id === meta.planId && c.term === meta.term) ?? all.find((c) => c.id === meta.planId)) : null;

  function body(i: number) {
    if (i === 0)
      return (
        <>
          {consult && (
            <p className="src-chip" role="note">
              منبع: مشاوره‌ی رایگان
            </p>
          )}
          {chosen && (
            <div className="chosen">
              <span className="ic">
                <I name="check" />
              </span>
              <span className="tx">
                <small>طرح انتخابی شما</small>
                <b>{chosen.name}</b>
                <small>مدت بازپرداخت {fa(chosen.term)} ماهه</small>
              </span>
              <button type="button" onClick={() => setMeta((m) => ({ ...m, planId: null, term: null }))}>
                تغییر
              </button>
            </div>
          )}
          <div className="nf-field">
            <label className="nf-label" htmlFor="full_name">
              نام و نام خانوادگی
            </label>
            <input
              className="nf-input"
              id="full_name"
              name="full_name"
              autoComplete="name"
              maxLength={80}
              placeholder="مثلاً مریم احمدی"
              value={a.full_name}
              aria-invalid={err.full_name || undefined}
              aria-describedby={err.full_name ? 'full_name-e' : undefined}
              onChange={(e) => set('full_name', e.target.value)}
            />
            {err.full_name && <Err id="full_name-e">نام‌تان را بنویسید تا کارشناس بداند با چه کسی صحبت می‌کند.</Err>}
          </div>
          <div className="nf-field">
            <label className="nf-label" htmlFor="mobile">
              شماره‌ی موبایل
            </label>
            <input
              className="nf-input nf-input--ltr"
              id="mobile"
              name="mobile"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              dir="ltr"
              maxLength={16}
              placeholder="۰۹xx xxx xxxx"
              value={a.mobile}
              aria-invalid={err.mobile || undefined}
              aria-describedby={`mobile-h${err.mobile ? ' mobile-e' : ''}`}
              onChange={(e) => set('mobile', e.target.value)}
            />
            <p className="wz-help" id="mobile-h">
              <I name="lock" size={16} />
              بدون کد پیامکی · فقط کارشناس نفیس وام با این شماره تماس می‌گیرد
            </p>
            {err.mobile && <Err id="mobile-e">شماره‌ی موبایل ۱۱ رقم است و با ۰۹ شروع می‌شود؛ مثلاً ۰۹xx xxx xxxx</Err>}
          </div>
        </>
      );
    if (i === 1)
      return (
        <>
          {q('amount_range', 'مبلغ موردنیاز')}
          {radios('amount_range', AMOUNT_RANGES, { cols: 'c2', req: true, msg: 'یک بازه را انتخاب کنید؛ اگر مطمئن نیستید «هنوز نمی‌دانم» را بزنید.' })}
          {q('loan_purpose', 'برای چه کاری؟', { opt: true })}
          <p className="wz-help" id="loan_purpose-h">
            اگر نخواستید، خالی بگذارید و «ادامه» را بزنید.
          </p>
          {radios('loan_purpose', LOAN_PURPOSES, { cols: 'c3', hint: 'loan_purpose-h' })}
        </>
      );
    if (i === 2)
      return (
        <>
          {q('job_status', 'وضعیت شغلی', { vh: true })}
          {radios('job_status', JOB_STATUSES, { cols: 'c2', req: true, icons: true })}
        </>
      );
    if (i === 3) {
      const cur = a.credit_rank;
      const bad = !!err.credit_rank;
      return (
        <>
          <p className="wz-help" id="credit_rank-h">
            <I name="help" size={16} />
            <span>رتبه‌تان را از سامانه‌ی اعتبارسنجی ایرانیان می‌توانید ببینید. اگر مطمئن نیستید، «نمی‌دونم» را بزنید.</span>
          </p>
          <div
            className={`cr-chips${bad ? ' bad' : ''}`}
            role="radiogroup"
            aria-labelledby="credit_rank-l"
            aria-describedby={`credit_rank-h${bad ? ' credit_rank-e' : ''}`}
            aria-invalid={bad || undefined}
          >
            <span className="sr" id="credit_rank-l">
              رتبه‌ی اعتباری
            </span>
            {CREDIT_RANKS.map(([v, t], n) => {
              const on = cur === v;
              const tab = on || (!cur && n === 0);
              return (
                <button
                  key={v}
                  type="button"
                  className={`wz-o ${v === 'unknown' ? 'cr-unk' : 'cr-letter'}`}
                  role="radio"
                  aria-checked={on}
                  tabIndex={tab ? 0 : -1}
                  dir={v === 'unknown' ? undefined : 'ltr'}
                  data-k="credit_rank"
                  data-v={v}
                  onKeyDown={onRadioKey}
                  onClick={() => set('credit_rank', v as CreditRank)}
                >
                  {t}
                </button>
              );
            })}
          </div>
          {bad && <Err id="credit_rank-e">یکی را انتخاب کنید؛ اگر رتبه‌تان را نمی‌دانید، «نمی‌دونم» را بزنید.</Err>}
        </>
      );
    }
    if (i === 4) {
      const none = a.documents.includes('none');
      return (
        <>
          {q('documents', 'مدارک و ضمانت', { vh: true })}
          <div className={`wz-opts c2${err.documents ? ' bad' : ''}`} role="group" aria-labelledby="documents-l" aria-describedby={err.documents ? 'documents-e' : undefined}>
            {DOCUMENTS.map(([d, t]) => {
              const on = a.documents.includes(d);
              return (
                <button key={d} type="button" className={`nf-option wz-o wz-c${d === 'none' ? ' nn' : ''}`} role="checkbox" aria-checked={on} data-k="documents" data-v={d} onClick={() => set('documents', toggleDoc(a.documents, d))}>
                  <span className="cb" aria-hidden="true">
                    {on && <I name="check" size={16} />}
                  </span>
                  <span className="tx">
                    <b>{t}</b>
                    {d === 'none' && <small>بقیه‌ی گزینه‌ها پاک می‌شوند</small>}
                  </span>
                </button>
              );
            })}
          </div>
          {none && (
            <p className="wz-note" role="status">
              <I name="check" size={18} />
              اشکالی ندارد؛ کارشناس طرح‌های بدون این مدارک را هم بررسی می‌کند.
            </p>
          )}
          {err.documents && <Err id="documents-e">دست‌کم یکی را انتخاب کنید؛ اگر هیچ‌کدام را ندارید، «هیچ‌کدام» را بزنید.</Err>}
        </>
      );
    }
    if (i === 5)
      return (
        <>
          {q('has_military_card', 'کارت پایان خدمت دارید؟')}
          {radios('has_military_card', MILITARY, { cols: 'c3s', req: true })}
          {q('can_refer_retiree', 'می‌توانید یک متقاضی بازنشسته معرفی کنید؟')}
          <p className="wz-help" id="can_refer_retiree-h">
            مثلاً پدر، مادر یا یکی از آشنایان که بازنشسته است.
          </p>
          {radios('can_refer_retiree', YES_NO, { cols: 'c2', req: true, hint: 'can_refer_retiree-h' })}
        </>
      );
    if (i === 6)
      return (
        <>
          {q('has_bounced_or_overdue', 'چک برگشتی یا بدهی معوق', { vh: true })}
          {radios('has_bounced_or_overdue', YES_NO, { cols: 'c2', req: true })}
        </>
      );
    return (
      <>
        {q('need_timing', 'زمان نیاز', { vh: true })}
        {radios('need_timing', NEED_TIMINGS, { req: true, icons: true })}
      </>
    );
  }

  if (step >= APPLY_STEPS)
    return (
      <div className="rq-wrap rq-card apw" ref={root}>
        <div className="wz-done" tabIndex={-1} data-step="done">
          <span className="ok">
            <I name="check" size={36} />
          </span>
          <h1>درخواست‌تان ثبت شد</h1>
          <p className="lead">
            یکی از کارشناس‌های نفیس وام با شماره‌ی <bdi dir="ltr">{masked}</bdi> تماس می‌گیرد و طرح‌های مناسب شما را بررسی می‌کند.
          </p>
          <p className="lead ct-done-contact">
            برای پیگیری، با <a href={contactTelHref()} dir="ltr">{CONTACT.phoneDisplay}</a>
            {' '}تماس بگیرید یا{' '}
            <a href={CONTACT.baleUrl} target="_blank" rel="noopener">پیام در بله</a>
            {' '}بگذارید.
          </p>
          <ul className="wz-next">
            <li>
              <I name="clock" size={18} />
              <span>تماس در ساعت کاری: شنبه تا پنج‌شنبه، ۹ تا ۱۸</span>
            </li>
            <li>
              <I name="shield" size={18} />
              <span>کارشناس‌های ما هیچ‌وقت کد یک‌بارمصرف یا رمز کارت نمی‌خواهند.</span>
            </li>
            <li>
              <I name="phone" size={18} />
              <span>اگر شماره را اشتباه نوشته‌اید، فرم را دوباره پر کنید.</span>
            </li>
          </ul>
          <div className="wz-dact">
            <a className="nf-btn nf-btn--primary" href="/plans">
              دیدن طرح‌ها
            </a>
            <a className="nf-btn nf-btn--secondary" href="/">
              صفحه‌ی اصلی
            </a>
          </div>
        </div>
      </div>
    );

  const last = step === APPLY_STEPS - 1;
  /** the consent line sits under every button that can submit: step 1 («فعلاً فقط تماس بگیرید») and the last step */
  const submits = last || step === 0;
  const T = TITLES[step]!;
  return (
    <div className="rq-wrap rq-card apw" ref={root} data-step={step + 1}>
      <div className="rq-head">
        <div className="top">
          <button type="button" className="back" hidden={step === 0} onClick={() => history.back()}>
            <I name="back" size={22} />
            قبلی
          </button>
          <span className="count" aria-live="polite">
            مرحله‌ی {fa(step + 1)} از {fa(APPLY_STEPS)}
          </span>
        </div>
        <div
          className="nf-progress"
          role="progressbar"
          aria-label="پیشرفت ثبت درخواست"
          aria-valuemin={1}
          aria-valuemax={APPLY_STEPS}
          aria-valuenow={step + 1}
          aria-valuetext={`مرحله‌ی ${fa(step + 1)} از ${fa(APPLY_STEPS)}`}
          style={{ ['--steps' as string]: APPLY_STEPS }}
        >
          {Array.from({ length: APPLY_STEPS }, (_, k) => (
            <span key={k} className={k < step ? 'is-done' : k === step ? 'is-current' : undefined} />
          ))}
        </div>
      </div>
      <form className="rq-step" noValidate onSubmit={onSubmit} id="apply-form">
        {/* honeypot: real people never see or fill this */}
        <div aria-hidden="true" className="hp">
          <label htmlFor="f-website">وب‌سایت</label>
          <input ref={honeypot} id="f-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        <h1 tabIndex={-1}>{T.t}</h1>
        {T.sub && <p className="sub">{T.sub}</p>}
        <div className="wz-body">{body(step)}</div>
        {submits && (
          <div className="alert" role="alert" tabIndex={-1} ref={failRef} hidden={!fail}>
            <I name="alert" />
            <span>
              ثبت نشد. لطفاً دوباره تلاش کنید.
              <button type="button" className="nf-btn nf-btn--secondary alert-retry" disabled={busy} onClick={() => void send()}>
                دوباره تلاش کنید
              </button>
            </span>
          </div>
        )}
        <div className="wz-foot">
          <button type="submit" className="nf-btn nf-btn--primary wz-go" id={last ? 'apply-submit' : undefined} disabled={busy} aria-busy={busy || undefined} aria-describedby={submits ? 'consent' : undefined}>
            {last ? (busy && !quickRef.current ? 'در حال ثبت…' : 'ثبت درخواست') : 'ادامه'}
            <I name={last ? 'check' : 'arrow'} size={20} />
          </button>
          {step === 0 ? (
            <button type="button" className="nf-btn nf-btn--text wz-skip" id="apply-quick" disabled={busy} aria-busy={(busy && quickRef.current) || undefined} aria-describedby="consent" onClick={quickCall}>
              {busy && quickRef.current ? 'در حال ثبت…' : 'فعلاً فقط تماس بگیرید'}
            </button>
          ) : (
            <button type="button" className="nf-btn nf-btn--text wz-skip" data-skip={step + 1} disabled={busy} aria-describedby={last ? 'consent' : undefined} onClick={skip}>
              رد کردن
            </button>
          )}
          {submits && (
            <p className="wz-help wz-consent" id="consent">
              {APPLY_CONSENT_TEXT}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
