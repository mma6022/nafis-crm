/**
 * Plan finder (UX-SPEC §4 + designer mockup hero-finder-mobile).
 * 3 one-tap questions → 1–3 cards. Never "no plan found": recommend() always relaxes.
 * Starts from the build-time snapshot (SSR shows real numbers), then swaps to live /data/loan-plans.json.
 * Deep link (also used for screenshots/QA): ?finder=cash.1.fast → result, ?finder=2 → step 2.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import {
  DAYS_LABEL,
  FINDER_LABEL,
  FINDER_PRIOS,
  FINDER_TYPES,
  MODE_LABEL,
  combos,
  fa,
  millionsFa,
  planFacts,
  recommend,
  type FinderAnswers,
  type FinderBand,
  type FinderPreset,
  type FinderPrio,
  type FinderType,
  type Pick,
} from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';
import { Icon, type IconName } from '../ui/icons';
import { OptionTile, Stepbar } from '../ui/Stepbar';
import { buttonClass } from '../ui/styles';

const TEL = 'tel:02191090380';
const WA = 'https://wa.me/'; // [جای‌خالی: لینک واتساپ از محمد]
const STEP_LABELS = ['هدف', 'مبلغ', 'اولویت'];
const STEP_NAMES = ['هدف وام', 'مبلغ', 'اولویت'];

type Partial3 = { type?: FinderType; band?: FinderBand; prio?: FinderPrio };

const TYPE_OPTS: Record<FinderType, { icon: IconName; title: string; hint: (f: ReturnType<typeof planFacts>) => string }> = {
  cash: { icon: 'cash', title: 'پول نقد لازم دارم', hint: (f) => `${fa(f.cashCount)} طرح وام نقدی` },
  goods: { icon: 'cart', title: 'می‌خواهم کالا بخرم', hint: (f) => `${fa(f.goodsCount)} طرح خرید اقساطی` },
  any: { icon: 'both', title: 'فرقی نمی‌کند', hint: () => 'همه طرح‌ها را بررسی می‌کنیم' },
};
const BAND_OPTS: { icon: IconName; title: string; hint: string }[] = [
  { icon: 's', title: 'کمتر از ۱۰۰ میلیون تومان', hint: 'مبلغ قابل دریافت' },
  { icon: 'm', title: '۱۰۰ تا ۲۰۰ میلیون تومان', hint: 'مبلغ قابل دریافت' },
  { icon: 'l', title: 'بیش از ۲۰۰ میلیون تومان', hint: 'مبلغ قابل دریافت' },
];
const PRIO_OPTS: Record<FinderPrio, { icon: IconName; title: string; hint: string }> = {
  fast: { icon: 'clock', title: 'زودتر به دستم برسد', hint: 'طرح‌های با بررسی کوتاه‌تر' },
  cheap: { icon: 'coins', title: 'قسط ماهانه کمتر باشد', hint: 'سبک‌ترین قسط در بازه شما' },
  online: { icon: 'online', title: 'حضوری مراجعه نکنم', hint: 'طرح‌های با امکان انجام آنلاین' },
};

function readDeepLink(): { step: number; a: Partial3 } | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('finder');
  if (!v) return null;
  if (/^[123]$/.test(v)) {
    const step = +v - 1;
    return { step, a: { ...(step > 0 ? { type: 'cash' as const } : {}), ...(step > 1 ? { band: 1 as const } : {}) } };
  }
  const [t, b, p] = v.split('.');
  if (FINDER_TYPES.includes(t as FinderType) && /^[012]$/.test(b ?? '') && FINDER_PRIOS.includes(p as FinderPrio))
    return { step: 3, a: { type: t as FinderType, band: +b! as FinderBand, prio: p as FinderPrio } };
  return null;
}

export default function PlanFinder({
  snapshot,
  preset,
  src = 'finder',
  title = 'طرح مناسب‌تان را در ۳ قدم پیدا کنید',
  id = 'plan-finder',
}: {
  snapshot: LoanPlan[];
  preset?: FinderPreset;
  src?: string;
  title?: string;
  id?: string;
}) {
  const { plans } = useLoanPlans(snapshot);
  const facts = useMemo(() => planFacts(plans), [plans]);
  const all = useMemo(() => combos(plans), [plans]);
  const skipType = !!preset?.type;
  const firstStep = skipType ? 1 : 0;
  const [step, setStep] = useState(firstStep);
  const [a, setA] = useState<Partial3>(preset?.type ? { type: preset.type } : {});
  const panel = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    const d = readDeepLink();
    if (d) {
      setA({ ...d.a, ...(preset?.type ? { type: preset.type } : {}) });
      setStep(Math.max(d.step, firstStep));
    }
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!moved.current) return;
    const h = panel.current?.querySelector<HTMLElement>('[data-focus]');
    h?.focus({ preventScroll: true });
    const top = panel.current?.getBoundingClientRect().top ?? 0;
    if (top < 64 || top > innerHeight * 0.6) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [step]);

  const go = (s: number) => {
    moved.current = true;
    setStep(s);
  };
  const choose = <K extends keyof Partial3>(k: K, v: Partial3[K], nextStep: number) => {
    setA((x) => ({ ...x, [k]: v }));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => go(nextStep), 180);
  };

  const result = useMemo(
    () => (step === 3 && a.type && a.band !== undefined && a.prio ? recommend(all, a as FinderAnswers, preset) : null),
    [step, a, all, preset],
  );

  const steps = skipType ? STEP_LABELS.slice(1) : STEP_LABELS;
  const visIndex = step - firstStep;

  return (
    <section id={id} className="scroll-mt-20" aria-labelledby={`${id}-title`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-h2 lg:text-h2-lg">
          {title}
        </h2>
        <span className="nf-badge nf-badge--brand">{fa(facts.planCount)} طرح فعال</span>
      </div>
      {preset?.guarantee && (
        <p className="text-ink-muted -mt-2 mb-3 text-small">
          فیلتر این صفحه: <b className="text-ink">{preset.guarantee.label}</b>
        </p>
      )}

      <div ref={panel} className="shadow-card rounded-card border border-line bg-white p-3 sm:p-5" aria-live="polite">
        {step < 3 ? (
          <>
            <Stepbar
              index={visIndex}
              labels={steps}
              current={STEP_NAMES[step]!}
              onBack={visIndex > 0 ? () => go(step - 1) : undefined}
            />
            {step === 0 && (
              <Question title="وام را برای چه می‌خواهید؟">
                {FINDER_TYPES.map((t) => (
                  <OptionTile
                    key={t}
                    icon={TYPE_OPTS[t].icon}
                    title={TYPE_OPTS[t].title}
                    hint={TYPE_OPTS[t].hint(facts)}
                    pressed={a.type === t}
                    onSelect={() => choose('type', t, 1)}
                  />
                ))}
              </Question>
            )}
            {step === 1 && (
              <Question
                title="حدوداً چقدر لازم دارید؟"
                hint="منظور مبلغی است که به دست شما می‌رسد، نه مبلغ اسمی وام."
              >
                {BAND_OPTS.map((o, k) => (
                  <OptionTile
                    key={o.title}
                    icon={o.icon}
                    title={o.title}
                    hint={o.hint}
                    pressed={a.band === k}
                    onSelect={() => choose('band', k as FinderBand, 2)}
                  />
                ))}
              </Question>
            )}
            {step === 2 && (
              <Question title="کدام برایتان مهم‌تر است؟">
                {FINDER_PRIOS.map((p) => (
                  <OptionTile
                    key={p}
                    icon={PRIO_OPTS[p].icon}
                    title={PRIO_OPTS[p].title}
                    hint={PRIO_OPTS[p].hint}
                    pressed={a.prio === p}
                    onSelect={() => choose('prio', p, 3)}
                  />
                ))}
              </Question>
            )}
          </>
        ) : (
          result && (
            <Result
              a={a as FinderAnswers}
              exact={result.exact}
              cards={result.cards}
              presetUnknown={result.presetUnknown}
              presetLabel={preset?.guarantee?.label}
              src={src}
              onChange={() => {
                setA(preset?.type ? { type: preset.type } : {});
                go(firstStep);
              }}
            />
          )
        )}
      </div>
    </section>
  );
}

function Question({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="px-1">
      <legend tabIndex={-1} data-focus className="text-ink text-h3 lg:text-h3-lg mb-1 font-extrabold outline-none">
        {title}
      </legend>
      {hint && <p className="text-ink-muted mb-3 text-caption">{hint}</p>}
      <div className={`grid gap-2.5 ${hint ? '' : 'mt-3'}`}>{children}</div>
    </fieldset>
  );
}

function Result({
  a,
  exact,
  cards,
  presetUnknown,
  presetLabel,
  src,
  onChange,
}: {
  a: FinderAnswers;
  exact: boolean;
  cards: Pick[];
  presetUnknown: boolean;
  presetLabel?: string;
  src: string;
  onChange: () => void;
}) {
  return (
    <div>
      <Stepbar index={3} labels={STEP_LABELS} current="نتیجه" />
      <div className="mb-4 flex flex-wrap items-center gap-2 px-1">
        {[FINDER_LABEL.type[a.type], FINDER_LABEL.band[a.band]!, FINDER_LABEL.prio[a.prio]].map((c) => (
          <span key={c} className="bg-surface text-ink-soft inline-flex min-h-8 items-center rounded-full px-3 text-caption font-semibold">
            {c}
          </span>
        ))}
        <button type="button" onClick={onChange} className="text-brand-600 ms-auto min-h-11 px-2 text-small font-extrabold underline underline-offset-4">
          تغییر پاسخ‌ها
        </button>
      </div>
      <h3 tabIndex={-1} data-focus className="text-h3 lg:text-h3-lg mb-3 px-1 outline-none">
        {exact ? 'طرح پیشنهادی شما' : 'نزدیک‌ترین گزینه‌ها برای شما'}
      </h3>
      {!exact && (
        <p className="text-ink-muted -mt-2 mb-3 px-1 text-caption">طرحی دقیقاً با همه پاسخ‌ها نبود؛ این‌ها نزدیک‌ترین‌ها هستند.</p>
      )}
      {presetUnknown && presetLabel && (
        <p className="bg-gold-50 text-gold-700 mb-3 rounded-xl px-3 py-2 text-caption font-semibold">
          شرط «{presetLabel}» را کارشناس هنگام تماس برای هر طرح تأیید می‌کند. [تأیید محمد]
        </p>
      )}
      <ul className="grid gap-3 lg:grid-cols-3">
        {cards.map((c, i) => (
          <li key={`${c.id}-${c.term}`}>
            <PlanCard c={c} featured={i === 0} src={src} presetMiss={!!presetLabel && !presetUnknown && !c.presetOk} label={presetLabel} />
          </li>
        ))}
      </ul>
      <p className="text-ink-muted mt-3 px-1 text-caption">مبالغ برآوردی است و مبلغ قطعی پس از اعتبارسنجی اعلام می‌شود.</p>

      <div className="bg-surface mt-4 rounded-2xl p-4">
        <p className="text-ink font-extrabold">مطمئن نیستید؟ با یک کارشناس صحبت کنید</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a href={TEL} className={buttonClass('secondary', 'sm', 'w-full')}>
            <Icon name="phone" size={18} /> تماس
          </a>
          <a href={WA} data-todo="whatsapp" className={buttonClass('secondary', 'sm', 'w-full')}>
            <Icon name="wa" size={18} className="text-success" /> واتساپ
          </a>
        </div>
      </div>
      <p className="mt-3 text-center">
        <a href="/plans" className="text-brand-600 inline-flex min-h-11 items-center gap-1 text-small font-extrabold">
          دیدن همه طرح‌ها <Icon name="arrow" size={18} />
        </a>
      </p>
    </div>
  );
}

export function PlanCard({
  c,
  featured,
  src,
  presetMiss,
  label,
}: {
  c: Pick | import('../../lib/plans').Combo;
  featured: boolean;
  src: string;
  presetMiss?: boolean;
  label?: string;
}) {
  const fast = c.days === 'under_7';
  const via = [c.bank, c.platform].filter(Boolean).join(' / ');
  return (
    <article className={`nf-card flex h-full flex-col p-4 ${featured ? 'nf-card--featured' : ''}`}>
      {featured && <span className="nf-badge nf-badge--gold mb-3 self-start">★ پیشنهاد ما برای شما</span>}
      <h4 className="text-h3 text-ink leading-snug">{c.name}</h4>
      {presetMiss && label && <p className="text-gold-700 mt-1 text-caption font-semibold">شرط «{label}» را ندارد؛ نزدیک‌ترین گزینه است.</p>}

      <div className="bg-brand-50 mt-3 grid grid-cols-2 gap-x-3 rounded-2xl p-3">
        <div className="col-span-2 border-b border-brand-100 pb-2">
          <span className="text-ink-muted text-caption">مبلغ قابل دریافت</span>
          <p className="text-brand-700 text-num font-extrabold">
            حدود {millionsFa(c.payout)} <small className="text-small font-semibold">میلیون تومان</small>
          </p>
        </div>
        <div className="pt-2">
          <span className="text-ink-muted text-caption">قسط {fa(c.term)} ماهه</span>
          <p className="text-ink font-extrabold">
            {millionsFa(c.inst)} <small className="text-caption font-semibold">میلیون</small>
          </p>
        </div>
        <div className="pt-2">
          <span className="text-ink-muted text-caption">مبلغ اسمی وام</span>
          <p className="text-ink font-extrabold">
            {millionsFa(c.principal)} <small className="text-caption font-semibold">میلیون</small>
          </p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-caption">
        <div>
          <dt className="text-ink-muted">زمان بررسی</dt>
          <dd className="mt-0.5">
            {fast ? <span className="nf-badge nf-badge--success !min-h-7">{DAYS_LABEL[c.days]}</span> : <b className="text-ink">{DAYS_LABEL[c.days] ?? c.days}</b>}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">روش</dt>
          <dd className="text-ink mt-0.5 font-bold">{MODE_LABEL[c.mode] ?? c.mode}</dd>
        </div>
      </dl>

      <details className="group mt-3 border-t border-line-soft pt-1">
        <summary className="text-brand-600 flex min-h-11 cursor-pointer list-none items-center gap-1 text-caption font-extrabold [&::-webkit-details-marker]:hidden">
          جزئیات بیشتر <Icon name="down" size={16} className="transition-transform group-open:rotate-180" />
        </summary>
        <dl className="text-ink-soft grid gap-1 pb-2 text-caption">
          {via && (
            <div className="flex justify-between gap-2">
              <dt>بانک / پلتفرم</dt>
              <dd className="text-ink font-semibold">{via}</dd>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <dt>پیش‌پرداخت</dt>
            <dd className="text-ink font-semibold">{c.prepay ? `${fa(c.prepay)}٪` : 'ندارد'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>سود سالانه</dt>
            <dd className="text-ink font-semibold">{fa(c.rate)}٪</dd>
          </div>
        </dl>
      </details>

      <div className="mt-auto pt-3">
        <a
          href={`/request?plan=${c.id}&term=${c.term}&src=${encodeURIComponent(src)}`}
          className={buttonClass(featured ? 'primary' : 'secondary', 'md', 'w-full')}
        >
          درخواست همین طرح
        </a>
      </div>
    </article>
  );
}
