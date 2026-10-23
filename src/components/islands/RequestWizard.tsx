/**
 * /request — 3-step lead wizard (UX-SPEC §5, designer mockup request.html).
 * need → amount → contact. ?plan=&term= skips step 1. State survives reloads (sessionStorage) and the browser
 * back button moves between steps (history.pushState). Success is shown ONLY after the CRM answers 2xx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stepbar, OptionTile } from '../ui/Stepbar';
import { Icon } from '../ui/icons';
import { useLoanPlans } from './useLoanPlans';
import type { LoanPlan } from '../../lib/loan-plans';
import { AMOUNT_BANDS, availableAmountBands, combos, fa, millionsFa, type AmountBand } from '../../lib/plans';
import { normalizeIranMobile } from '../../lib/format';
import { LeadError, readUtm, submitLead, type ContactTime, type Need } from '../../lib/lead';
import { MESSENGERS, SITE } from '../../lib/site';

type Step = 'need' | 'amount' | 'contact' | 'done';
const ORDER: Step[] = ['need', 'amount', 'contact'];
const LABELS = ['نیاز شما', 'حدود مبلغ', 'اطلاعات تماس'];
const KEY = 'nf-request';

interface State {
  need: Need | null;
  band: AmountBand | 'unsure' | null;
  planId: number | null;
  term: number | null;
  name: string;
  phone: string;
  time: ContactTime;
  consent: boolean;
  startedAt: number;
  src: string | null;
}
const fresh = (): State => ({
  need: null,
  band: null,
  planId: null,
  term: null,
  name: '',
  phone: '',
  time: 'any',
  consent: false,
  startedAt: Date.now(),
  src: null,
});

const NEEDS: { v: Need; icon: 'cash' | 'cart' | 'help'; t: string; h: string }[] = [
  { v: 'cash', icon: 'cash', t: 'پول نقد (وام)', h: 'وام نقدی بر پایه اعتبارسنجی' },
  { v: 'goods', icon: 'cart', t: 'خرید کالا به‌صورت قسطی', h: 'کالا را می‌گیرید و قسطی پرداخت می‌کنید' },
  { v: 'help', icon: 'help', t: 'نمی‌دانم، راهنمایی می‌خواهم', h: 'کارشناس با شما تماس می‌گیرد' },
];
const TIMES: { v: ContactTime; t: string }[] = [
  { v: 'morning', t: 'صبح' },
  { v: 'evening', t: 'عصر' },
  { v: 'any', t: 'فرقی نمی‌کند' },
];

export default function RequestWizard({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  const all = useMemo(() => combos(plans), [plans]);
  const [s, setS] = useState<State>(fresh);
  const [step, setStep] = useState<Step>('need');
  const [ready, setReady] = useState(false);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const honeypot = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const failRef = useRef<HTMLDivElement>(null);

  // init: sessionStorage + query (?plan, ?term, ?need, ?src)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    let st = fresh();
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as (State & { step?: Step }) | null;
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
    setS(st);
    const first: Step = st.planId || st.need ? 'amount' : 'need';
    const savedStep = (history.state as { step?: Step } | null)?.step;
    const start = savedStep && savedStep !== 'done' ? savedStep : first;
    history.replaceState({ step: start }, '');
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

  // focus heading on step change (not on first paint)
  const painted = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!painted.current) {
      painted.current = true;
      return;
    }
    scrollTo(0, 0);
    root.current?.querySelector<HTMLElement>('[data-focus]')?.focus({ preventScroll: true });
  }, [step, ready]);

  const chosen = s.planId ? (all.find((c) => c.id === s.planId && c.term === s.term) ?? all.find((c) => c.id === s.planId)) : null;
  const type = s.need === 'cash' ? 'score' : s.need === 'goods' ? 'goods' : undefined;
  const bands = useMemo(() => {
    const b = availableAmountBands(all, type);
    return b.length ? b : AMOUNT_BANDS;
  }, [all, type]);

  const pick = <K extends keyof State>(k: K, v: State[K], next?: Step) => {
    setS((p) => ({ ...p, [k]: v }));
    if (next) setTimeout(() => go(next), 180);
  };

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    const bad = { name: !s.name.trim(), phone: !normalizeIranMobile(s.phone), consent: !s.consent };
    setErrors(bad);
    const first = (['name', 'phone', 'consent'] as const).find((k) => bad[k]);
    if (first) {
      document.getElementById(`f-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setFail(false);
    try {
      await submitLead({
        name: s.name,
        phone: s.phone,
        need: s.need ?? 'help',
        amountBand: s.band ?? 'unsure',
        planId: s.planId,
        term: s.term,
        contactTime: s.time,
        src: s.src,
        consent: s.consent,
        website: honeypot.current?.value ?? '',
        startedAt: s.startedAt,
        utm: readUtm(),
      });
      go('done');
    } catch (err) {
      console.warn('lead submit failed:', err instanceof LeadError ? `${err.code} ${err.status}` : err);
      setFail(true);
      requestAnimationFrame(() => failRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const idx = ORDER.indexOf(step);
  const canBack = idx > 0 && !(idx === 1 && s.planId);
  const h1 = 'text-h2 lg:text-[28px] font-extrabold text-ink outline-none';
  const sub = 'text-ink-muted mt-1 mb-5 text-small lg:text-body';

  return (
    <div ref={root}>
      {step !== 'done' && <Stepbar index={idx} labels={LABELS} current={LABELS[idx]!} onBack={canBack ? () => history.back() : undefined} />}

      {step === 'need' && (
        <section>
          <h1 className={h1} tabIndex={-1} data-focus>
            چه چیزی لازم دارید؟
          </h1>
          <p className={sub}>یکی را انتخاب کنید. اگر مطمئن نیستید، گزینه آخر را بزنید.</p>
          <div className="grid gap-3" role="group" aria-label="نوع نیاز">
            {NEEDS.map((n) => (
              <OptionTile key={n.v} icon={n.icon} title={n.t} hint={n.h} pressed={s.need === n.v} onSelect={() => pick('need', n.v, 'amount')} />
            ))}
          </div>
        </section>
      )}

      {step === 'amount' && (
        <section>
          {chosen && (
            <div className="bg-brand-50 mb-5 flex items-center gap-3 rounded-2xl p-3">
              <span className="text-brand-600 grid size-11 shrink-0 place-items-center rounded-xl bg-white">
                <Icon name={chosen.type === 'goods' ? 'cart' : 'cash'} />
              </span>
              <span className="grid flex-1 leading-relaxed">
                <small className="text-ink-muted text-caption">طرح انتخابی شما</small>
                <b className="text-ink">{chosen.name}</b>
                <small className="text-ink-soft text-caption">
                  دریافتی حدود {millionsFa(chosen.payout)} م · قسط {fa(chosen.term)} ماهه حدود {millionsFa(chosen.inst)} م
                </small>
              </span>
              <button
                type="button"
                className="text-brand-700 min-h-11 rounded-[10px] px-3 text-small font-extrabold hover:bg-white"
                onClick={() => {
                  setS((p) => ({ ...p, planId: null, term: null }));
                  history.replaceState({ step: 'need' }, '', location.pathname + (s.src ? `?src=${encodeURIComponent(s.src)}` : ''));
                  setStep('need');
                }}
              >
                تغییر
              </button>
            </div>
          )}
          <h1 className={h1} tabIndex={-1} data-focus>
            حدوداً چه مبلغی لازم دارید؟
          </h1>
          <p className={sub}>مبلغی که به دست شما می‌رسد. دقیقش را کارشناس با شما مرور می‌کند.</p>
          <div className="grid gap-3" role="group" aria-label="حدود مبلغ">
            {bands.map((b) => (
              <OptionTile key={b.value} icon={b.icon} title={b.label} pressed={s.band === b.value} onSelect={() => pick('band', b.value, 'contact')} />
            ))}
            <OptionTile icon="help" title="هنوز نمی‌دانم" hint="کارشناس کمکتان می‌کند" pressed={s.band === 'unsure'} onSelect={() => pick('band', 'unsure', 'contact')} />
          </div>
        </section>
      )}

      {step === 'contact' && (
        <section>
          <h1 className={h1} tabIndex={-1} data-focus>
            چطور با شما تماس بگیریم؟
          </h1>
          <p className={sub}>فقط برای تماس کارشناس؛ شماره‌تان جای دیگری استفاده نمی‌شود.</p>
          {fail && (
            <div
              ref={failRef}
              tabIndex={-1}
              role="alert"
              className="border-danger/30 bg-danger-50 text-danger mb-4 flex gap-2 rounded-2xl border p-3 text-small font-semibold outline-none"
            >
              <Icon name="alert" size={20} className="shrink-0" />
              <span>
                ثبت نشد. لطفاً دوباره تلاش کنید یا با{' '}
                <a href={SITE.tel} className="underline">
                  <span className="ltr">{SITE.phoneFa}</span>
                </a>{' '}
                تماس بگیرید.
              </span>
            </div>
          )}
          <form className="grid gap-4" noValidate onSubmit={onSubmit}>
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
                aria-invalid={errors.name || undefined}
                aria-describedby={errors.name ? 'e-name' : undefined}
                onChange={(e) => setS((p) => ({ ...p, name: e.target.value }))}
              />
              {errors.name && (
                <span className="nf-error" id="e-name">
                  <Icon name="alert" size={16} />
                  لطفاً نام خود را بنویسید.
                </span>
              )}
            </div>
            <div className="nf-field">
              <label className="nf-label" htmlFor="f-phone">
                شماره موبایل
              </label>
              <input
                className="nf-input nf-input--ltr"
                id="f-phone"
                name="mobile"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                dir="ltr"
                placeholder="۰۹۱۲ ۳۴۵ ۶۷۸۹"
                maxLength={16}
                value={s.phone}
                aria-invalid={errors.phone || undefined}
                aria-describedby={errors.phone ? 'e-phone' : undefined}
                onChange={(e) => setS((p) => ({ ...p, phone: e.target.value }))}
              />
              {errors.phone && (
                <span className="nf-error" id="e-phone">
                  <Icon name="alert" size={16} />
                  شماره موبایل باید ۱۱ رقم باشد و با ۰۹ شروع شود.
                </span>
              )}
            </div>
            <div className="nf-field">
              <span className="nf-label" id="l-time">
                چه زمانی تماس بگیریم؟
              </span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="l-time">
                {TIMES.map((t) => (
                  <button
                    key={t.v}
                    type="button"
                    role="radio"
                    aria-checked={s.time === t.v}
                    onClick={() => setS((p) => ({ ...p, time: t.v }))}
                    className={`min-h-11 rounded-full border px-4 text-small font-semibold transition-colors ${
                      s.time === t.v ? 'border-brand-600 bg-brand-600 text-white' : 'text-ink-soft hover:border-brand-300 border-line bg-white'
                    }`}
                  >
                    {t.t}
                  </button>
                ))}
              </div>
            </div>
            {/* honeypot: real people never see or fill this */}
            <div aria-hidden="true" className="absolute -start-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="f-website">وب‌سایت</label>
              <input ref={honeypot} id="f-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>
            <div>
              <label className="text-ink-soft flex min-h-11 cursor-pointer items-start gap-3 text-small leading-relaxed">
                <input
                  id="f-consent"
                  type="checkbox"
                  className="accent-brand-600 mt-1 size-5 shrink-0"
                  checked={s.consent}
                  aria-invalid={errors.consent || undefined}
                  aria-describedby={errors.consent ? 'e-consent' : undefined}
                  onChange={(e) => setS((p) => ({ ...p, consent: e.target.checked }))}
                />
                <span>
                  با{' '}
                  <a href="/privacy" className="text-brand-700 underline">
                    قوانین حریم خصوصی
                  </a>{' '}
                  موافقم و اجازه می‌دهم کارشناس نفیس وام با من تماس بگیرد.
                </span>
              </label>
              {errors.consent && (
                <span className="nf-error" id="e-consent">
                  <Icon name="alert" size={16} />
                  برای ثبت درخواست، این گزینه را تأیید کنید.
                </span>
              )}
            </div>
            <button type="submit" className="nf-btn nf-btn--primary nf-btn--block" disabled={busy} aria-busy={busy}>
              {busy ? 'در حال ثبت…' : 'ثبت درخواست'}
            </button>
          </form>
          <p className="text-ink-muted mt-3 text-center text-caption">ثبت درخواست هیچ تعهدی برای شما ایجاد نمی‌کند.</p>
        </section>
      )}

      {step === 'done' && (
        <section className="py-4 text-center">
          <div className="bg-success-50 text-success mx-auto mb-4 grid size-18 place-items-center rounded-full">
            <Icon name="check" size={36} />
          </div>
          <h1 className={h1} tabIndex={-1} data-focus>
            درخواست شما ثبت شد
          </h1>
          <p className="text-ink-soft mt-2 mb-6">
            کارشناس ما معمولاً در ساعات کاری با شما تماس می‌گیرد. <span className="nf-ph">[تأیید محمد: متن و بازه زمانی تماس]</span>
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <a className="nf-btn nf-btn--secondary nf-btn--block" href={SITE.portal}>
              <Icon name="user" size={20} /> پیگیری در پنل مشتریان
            </a>
            <a className="nf-btn nf-btn--secondary nf-btn--block" href={MESSENGERS.whatsapp.href} data-todo="whatsapp">
              <Icon name="wa" size={20} /> پیام در واتساپ
            </a>
          </div>
          <p className="mt-4">
            <a className="nf-btn nf-btn--text" href="/">
              بازگشت به صفحه اصلی
            </a>
          </p>
        </section>
      )}
    </div>
  );
}
