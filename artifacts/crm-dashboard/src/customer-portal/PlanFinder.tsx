import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, ArrowRight, Bot, ChevronLeft, Clock, List, Lock, MessageCircle, MessageSquare, RefreshCw, Search, Sparkles } from 'lucide-react';
import { PortalApiError, portalApi, type PlanFinderMatch } from './api';
import { buildPlanFinderRequest, planFinderYes as yes } from './plan-finder-answers';
import { ErrorBox, Icon, fa } from './PortalUi';
import { GradePicker } from '@/components/grade/GradePicker';
import { gradeText, isGradeValue, isSubgrade } from '@/lib/credit-grade';
import { Crumb, ExpertButton, ExpertLink, HelpCard, Toman } from './Portal2Ui';

/* «کمک در انتخاب طرح» (HANDOFF part 2 §1): a short wizard, one topic per step, options always come from
   /plan-finder/options. Step 5 (guarantor details) only exists when the customer has a guarantor. */
type Q = { key: string; field: string; label: string; cols: 'rank' | 'yn' | 'list'; hint?: 'rank' | 'guarantor' };
type Step = { title: string; sub?: string; qs: Q[] };
const STEPS: Step[] = [
  { title: 'رتبه اعتباری', qs: [{ key: 'creditRank', field: 'credit_rank', label: 'رتبه اعتباری شما چیست؟', cols: 'rank', hint: 'rank' }] },
  { title: 'شغل و حقوق', sub: 'دو پرسش کوتاه', qs: [{ key: 'jobType', field: 'job_type', label: 'شغل شما چیست؟', cols: 'list' }, { key: 'hasCustomerSalaryDeduct', field: 'has_customer_salary_deduct', label: 'قسط از حقوق‌تان کسر شود؟', cols: 'yn' }] },
  { title: 'چک', qs: [{ key: 'customerCheckStatus', field: 'customer_check_status', label: 'برای ضمانت چه چکی دارید؟', cols: 'list' }] },
  { title: 'ضامن', qs: [{ key: 'hasGuarantor', field: 'has_guarantor', label: 'ضامن دارید؟', cols: 'yn', hint: 'guarantor' }] },
  { title: 'مشخصات ضامن', sub: 'سه پرسش کوتاه درباره‌ی ضامن', qs: [{ key: 'guarantorCreditRank', field: 'guarantor_credit_rank', label: 'رتبه اعتباری ضامن', cols: 'rank' }, { key: 'guarantorCheckType', field: 'guarantor_check_type', label: 'ضامن چه چکی دارد؟', cols: 'list' }, { key: 'hasGuarantorSalaryDeduct', field: 'has_guarantor_salary_deduct', label: 'قسط از حقوق ضامن کسر شود؟', cols: 'yn' }] },
];
const ASIDE: Array<[string, string, number]> = [['رتبه اعتباری', 'creditRank', 0], ['شغل', 'jobType', 1], ['کسر از حقوق', 'hasCustomerSalaryDeduct', 1], ['چک', 'customerCheckStatus', 2], ['ضامن', 'hasGuarantor', 3],
  ['رتبه ضامن', 'guarantorCreditRank', 4], ['چک ضامن', 'guarantorCheckType', 4], ['کسر از حقوق ضامن', 'hasGuarantorSalaryDeduct', 4]];
const GUARANTOR_KEYS = ['guarantorCreditRank', 'guarantorCheckType', 'hasGuarantorSalaryDeduct'];
type Opt = { fieldKey: string; value: string; label: string };

function Frame({ children }: { children: ReactNode }) {
  return <div className="nfp-stack" data-testid="page-plan-finder"><Crumb items={[['خانه', '/customer'], ['مشاوره', '/customer/advice'], ['کمک در انتخاب طرح']]} />{children}</div>;
}

export function PlanFinder() {
  const opts = useQuery({ queryKey: ['customer', 'plan-finder-options'], queryFn: portalApi.planFinderOptions });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [missing, setMissing] = useState<string | null>(null);
  const [view, setView] = useState<'wizard' | 'search'>('wizard');
  const run = useMutation({ mutationFn: (a: Record<string, string>) => portalApi.planFinder(buildPlanFinderRequest(a)), retry: false });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const guarantor = yes(answers.hasGuarantor || '');
  const total = guarantor ? 5 : 4;
  useEffect(() => { titleRef.current?.focus(); }, [step, view]);
  const byField = useMemo(() => {
    const map = new Map<string, Opt[]>();
    for (const o of opts.data?.options ?? []) map.set(o.fieldKey, [...(map.get(o.fieldKey) ?? []), o]);
    return map;
  }, [opts.data]);
  const labelOf = (key: string) => {
    const q = STEPS.flatMap(s => s.qs).find(x => x.key === key);
    if (q?.cols === 'rank' && isGradeValue(answers[key] || '')) return gradeText(answers[key]);
    return q ? byField.get(q.field)?.find(o => o.value === answers[key])?.label ?? answers[key] : answers[key];
  };
  const head = (title: string) => <div className="nfp-wz-meta">{step > 0 ? <button type="button" className="nfp-wz-back" onClick={() => { setMissing(null); setStep(step - 1); }} data-testid="button-finder-back"><Icon icon={ArrowRight} small />قبلی</button> : <span />}
    <span>قدم <b>{fa(step + 1)}</b> از {fa(total)}<span className="nfp-sep" aria-hidden="true" />{title}</span></div>;
  const progress = <div className="nf-progress" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step + 1} aria-label="پیشرفت پرسش‌ها" style={{ ['--steps' as string]: total }}>
    {Array.from({ length: total }, (_, i) => <span key={i} className={i < step ? 'is-done' : i === step ? 'is-current' : ''} />)}</div>;

  if (opts.isLoading) return <Frame><div className="nfp-wz"><div className="nfp-sk" style={{ height: 20, width: '40%' }} /><div className="nfp-sk" style={{ height: 6 }} /><div className="nfp-sk-card" aria-hidden="true"><div className="nfp-sk" style={{ height: 20, width: '55%' }} /><div className="nfp-sk" style={{ height: 56 }} /><div className="nfp-sk" style={{ height: 56 }} /></div><p className="nfp-sr" role="status">در حال آماده کردن پرسش‌ها…</p></div></Frame>;
  if (opts.isError) return <Frame><div className="nfp-wz"><ErrorBox title="پرسش‌ها بارگیری نشد" retry={() => void opts.refetch()} /></div></Frame>;

  if (view === 'search') {
    if (run.isPending || run.isIdle) return <Frame><div className="nfp-wz"><div className="nfp-card"><div className="nfp-empty" role="status" aria-live="polite"><span className="nfp-big"><RefreshCw className="nfp-i nfp-spin" aria-hidden="true" /></span><h2 ref={titleRef} tabIndex={-1}>در حال پیدا کردن طرح‌های مناسب…</h2><p>چند ثانیه صبر کنید.</p></div></div>
      {[0, 1].map(i => <div key={i} className="nfp-sk-card" aria-hidden="true"><div className="nfp-sk" style={{ height: 20, width: '55%' }} /><div className="nfp-sk" style={{ height: 14, width: '35%' }} /><div className="nfp-sk" style={{ height: 64 }} /><div className="nfp-sk" style={{ height: 52 }} /></div>)}</div></Frame>;
    if (run.isError) {
      const e = run.error;
      if (e instanceof PortalApiError && e.status === 429) return <Frame><div className="nfp-wz"><div className="nfp-card"><div className="nfp-empty" role="alert"><span className="nfp-big"><Icon icon={Clock} /></span><h2 ref={titleRef} tabIndex={-1}>کمی بعد دوباره امتحان کنید</h2>
        <p>در یک ساعت گذشته چند بار جست‌وجو کرده‌اید. تا یک ساعت دیگر دوباره می‌توانید. تا آن موقع کارشناس فروش کمک‌تان می‌کند.</p><ExpertButton testId="button-finder-rate-expert" /></div></div>
        <div className="nfp-ch-row" style={{ justifyContent: 'center' }}><button type="button" className="nf-btn nf-btn--text" onClick={() => setView('wizard')}>تغییر پاسخ‌ها</button></div></div></Frame>;
      return <Frame><div className="nfp-wz"><ErrorBox title="جست‌وجوی طرح انجام نشد" text="پاسخ‌های شما ذخیره است. دوباره تلاش کنید." retry={() => run.mutate(answers)} /></div></Frame>;
    }
    return <Frame><Results matches={run.data.matches} onEdit={() => { setStep(0); setView('wizard'); }} titleRef={titleRef} /></Frame>;
  }

  const st = STEPS[step];
  const single = st.qs.length === 1;
  const noOpts = st.qs.some(q => !(byField.get(q.field)?.length));
  const last = step === total - 1;
  const choose = (q: Q, value: string) => {
    const next = { ...answers, [q.key]: value };
    if (q.key === 'hasGuarantor' && !yes(value)) for (const k of GUARANTOR_KEYS) delete next[k];
    setAnswers(next); if (missing === q.key) setMissing(null);
  };
  const nextStep = () => {
    const gap = st.qs.find(q => !answers[q.key]);
    if (gap) { setMissing(gap.key); document.getElementById(`q-${gap.key}`)?.scrollIntoView({ block: 'center' }); return; }
    setMissing(null);
    if (last) { setView('search'); run.mutate(answers); } else setStep(step + 1);
  };
  const blank = st.qs.some(q => !answers[q.key]);
  const nextTitle = step + 1 < total ? STEPS[step + 1].title : '';
  const rows = ASIDE.filter(([, , s]) => s < 4 || guarantor);
  return <Frame><div className="nfp-wz-layout"><div className="nfp-wz">
    {head(st.title)}{progress}
    <div className="nfp-wz-card">
      <div className="nfp-wz-ttl"><h1 ref={titleRef} tabIndex={-1}>{single ? st.qs[0].label : st.title}</h1>{!single && st.sub && <p>{st.sub}</p>}</div>
      {noOpts ? <div className="nfp-empty" role="status"><span className="nfp-big"><Icon icon={List} /></span><h2>گزینه‌ای برای این پرسش ثبت نشده</h2><p>کارشناس فروش در انتخاب طرح کمک‌تان می‌کند.</p><ExpertButton testId="button-finder-noopts-expert" /></div>
        : st.qs.map(q => {
          const list = byField.get(q.field) ?? [];
          const bad = missing === q.key;
          const cols = q.cols === 'rank' ? Math.min(list.length, 5) : q.cols === 'yn' ? 2 : 1;
          return <fieldset key={q.key} id={`q-${q.key}`} className={`nfp-wz-q${bad ? ' nfp-bad' : ''}`} aria-describedby={bad ? `er-${q.key}` : undefined}>
            <legend className={single ? 'nfp-sr' : undefined}>{q.label}</legend>
            {q.hint === 'rank' && <p className="nf-hint">رتبه‌تان را نمی‌دانید؟ <ExpertLink>از کارشناس بپرسید</ExpertLink></p>}
            {q.hint === 'guarantor' && <p className="nf-hint">ضامن کسی است که اگر قسطی پرداخت نشود، پرداختش را تعهد می‌کند.</p>}
            {/* HANDOFF §6: once the dictionary holds the 15 sub-grades, the same two rows (letter, then sub-grade) as the CRM. */}
            {q.cols === 'rank' && list.some(o => isSubgrade(o.value)) ? <><GradePicker label={q.label} hideLabel value={isSubgrade(answers[q.key] || '') ? answers[q.key] : ''}
                onChange={(v) => choose(q, v)} required showError={bad} emptyError="به این پرسش پاسخ دهید." testId={`grade-${q.key}`} />
              {list.some(o => !isSubgrade(o.value)) && <div className="nfp-opts" role="radiogroup" aria-label={q.label} style={{ ['--c' as string]: 1, marginTop: 12 }}>
                {list.filter(o => !isSubgrade(o.value)).map(o => <button type="button" key={o.value} className="nfp-opt" role="radio" aria-checked={answers[q.key] === o.value} onClick={() => choose(q, o.value)} data-testid={`choice-${q.key}-${o.value}`}>
                  <span className="nfp-rd" aria-hidden="true" /><span>{o.label}</span></button>)}</div>}</>
            : <div className={`nfp-opts${q.cols === 'rank' ? ' nfp-c5' : ''}`} role="radiogroup" aria-label={q.label} style={{ ['--c' as string]: cols }}>
              {list.map(o => <button type="button" key={o.value} className="nfp-opt" role="radio" aria-checked={answers[q.key] === o.value} onClick={() => choose(q, o.value)} data-testid={`choice-${q.key}-${o.value}`}>
                {q.cols !== 'rank' && <span className="nfp-rd" aria-hidden="true" />}<span className={q.cols === 'rank' ? 'nfp-ltr' : undefined}>{o.label}</span></button>)}</div>}
            {bad && !(q.cols === 'rank' && list.some(o => isSubgrade(o.value))) && <p className="nf-error" id={`er-${q.key}`} role="alert"><Icon icon={AlertCircle} small />به این پرسش پاسخ دهید.</p>}
          </fieldset>;
        })}
      <div className="nfp-wz-foot">
        <button type="button" className="nf-btn nf-btn--primary nf-btn--block" aria-disabled={blank || noOpts || undefined} disabled={noOpts} onClick={nextStep} data-testid="button-finder-next">
          {last ? <><Icon icon={Search} small />دیدن طرح‌های مناسب</> : 'ادامه'}</button>
        {!last && <div className="nfp-next-hint"><Icon icon={ChevronLeft} /><span>قدم بعد: <b>{nextTitle}</b></span></div>}
      </div>
    </div>
    <p className="nfp-trust"><Icon icon={Lock} />پاسخ‌ها فقط برای پیدا کردن طرح مناسب شما به کار می‌رود.</p>
  </div>
  <aside className="nfp-wz-side"><section className="nfp-card" aria-labelledby="nfp-ya"><h2 id="nfp-ya">پاسخ‌های شما</h2><ul className="nfp-ans">
    {rows.map(([l, k, s]) => s < step && answers[k] ? <li key={k}><span>{l}</span><b>{labelOf(k)}</b><button type="button" onClick={() => { setMissing(null); setStep(s); }} aria-label={`ویرایش ${l}`}>ویرایش</button></li>
      : <li key={k} className="nfp-todo"><span>{l}</span><b>—</b></li>)}</ul></section><HelpCard /></aside>
  </div></Frame>;
}

/* ---------- results ---------- */
/** Card values come pre-computed from the server (POST /plan-finder → match.quote); no plan rates in the browser. */
type Calc = { durations: number[]; payout: (months: number) => number | null; installment: (months: number) => number | null; best: number | null };
function planMath(m: PlanFinderMatch): Calc | null {
  const q = m.quote; if (!q) return null;
  const at = (n: number) => q.terms.find(t => t.installments === n);
  return { durations: q.terms.map(t => t.installments), payout: n => at(n)?.payout ?? null, installment: n => at(n)?.installment ?? null, best: q.best };
}

function Results({ matches, onEdit, titleRef }: { matches: PlanFinderMatch[]; onEdit: () => void; titleRef: RefObject<HTMLHeadingElement | null> }) {
  const shown = matches.filter(m => m.status !== 'not_eligible').sort((a, b) => (a.status === 'eligible' ? 0 : 1) - (b.status === 'eligible' ? 0 : 1));
  const calcs = shown.map(m => planMath(m));
  // «مناسب‌ترین»: the eligible plan with the highest payout at its default duration; needs_review never wins.
  let bestIdx = -1; let bestPay = -1;
  shown.forEach((m, i) => { const c = calcs[i]; const v = c?.best != null ? c.payout(c.best) ?? -1 : -1; if (m.status === 'eligible' && v > bestPay) { bestPay = v; bestIdx = i; } });
  if (bestIdx < 0 && shown[0]?.status === 'eligible') bestIdx = 0;
  const order = shown.map((_, i) => i).sort((a, b) => (a === bestIdx ? -1 : b === bestIdx ? 1 : 0));
  if (!shown.length) return <div className="nfp-card"><div className="nfp-empty" role="status"><span className="nfp-big"><Icon icon={Search} /></span><h2 ref={titleRef} tabIndex={-1}>با این پاسخ‌ها طرح مناسبی پیدا نشد</h2><p>کارشناس فروش می‌تواند راه‌های دیگر را با شما بررسی کند.</p>
    <ExpertButton label="تماس با کارشناس فروش" className="nf-btn nf-btn--primary" testId="button-finder-empty-expert" />
    <Link className="nf-btn nf-btn--text" href="/customer/advice/chat"><Icon icon={MessageSquare} small />پیام در گفتگو</Link>
    <button type="button" className="nf-btn nf-btn--text" onClick={onEdit} data-testid="button-finder-restart">تغییر پاسخ‌ها</button></div></div>;
  return <>
    <div className="nfp-page-hd"><div><h1 className="nfp-h1" ref={titleRef} tabIndex={-1}>{fa(shown.length)} طرح برای شما پیدا شد</h1><p className="nfp-lede">مبلغ و قسط هر طرح را ببینید و یکی را انتخاب کنید.</p></div></div>
    <div className="nfp-res-grid">{order.map(i => <PlanCard key={shown[i].plan.id} m={shown[i]} calc={calcs[i]} loading={false} best={i === bestIdx} />)}</div>
    <div className="nfp-ch-row" style={{ justifyContent: 'center' }}><button type="button" className="nf-btn nf-btn--text" onClick={onEdit} data-testid="button-finder-restart"><Icon icon={RefreshCw} small />تغییر پاسخ‌ها</button></div>
  </>;
}

function PlanCard({ m, calc, loading, best }: { m: PlanFinderMatch; calc: Calc | null; loading: boolean; best: boolean }) {
  const [months, setMonths] = useState<number | null>(null);
  const n = months ?? calc?.best ?? null;
  const review = m.status === 'needs_review';
  const pay = n != null && calc ? calc.payout(n) : null;
  const inst = !review && n != null && calc ? calc.installment(n) : null;
  const id = `nfp-pl${m.plan.id}`;
  const unknown = loading ? <span className="nfp-sk" style={{ display: 'inline-block', height: 20, width: 90 }} aria-label="در حال محاسبه" /> : <span className="nfp-later">بعداً اعلام می‌شود</span>;
  const href = `/customer/apply?planId=${m.plan.id}${n != null ? `&months=${n}` : ''}`;
  return <article className={`nfp-card nfp-pl${best ? ' nfp-best' : ''}`} aria-labelledby={id} data-testid={`card-finder-${m.plan.id}`}>
    <div className="nfp-pl-top"><div>{best && <span className="nfp-badge-best"><Icon icon={Sparkles} small />مناسب‌ترین برای شما</span>}<b id={id} style={{ display: 'block' }}>{m.plan.name}</b></div>
      {review ? <span className="nfp-st nfp-you">نیازمند بررسی کارشناس</span> : best ? null : <span className="nfp-st nfp-ok">مناسب شما</span>}</div>
    <div className="nfp-facts"><div className="nfp-fact nfp-big"><span>مبلغ واریزی</span><b data-testid={`text-finder-payout-${m.plan.id}`}>{pay != null ? <Toman value={pay} /> : unknown}</b></div>
      <div className="nfp-fact"><span>مبلغ قسط</span><b data-testid={`text-finder-installment-${m.plan.id}`}>{inst != null ? <Toman value={inst} /> : review ? <span className="nfp-later">بعداً اعلام می‌شود</span> : unknown}</b></div>
      <div className="nfp-fact"><span>تعداد اقساط</span><b>{n != null ? <>{fa(n)} <small>ماه</small></> : unknown}</b></div></div>
    {calc && calc.durations.length > 1 && <div className="nfp-dur"><span id={`${id}-d`}>تعداد اقساط را انتخاب کنید</span>
      <div className="nfp-ap-chips" role="radiogroup" aria-labelledby={`${id}-d`} style={{ ['--n' as string]: Math.min(calc.durations.length, 4) }}>
        {calc.durations.map(d => <button type="button" key={d} className="nfp-ap-chip" role="radio" aria-checked={d === n} onClick={() => setMonths(d)} data-testid={`chip-finder-${m.plan.id}-${d}`}>{fa(d)} ماه</button>)}</div></div>}
    <Link className={`nf-btn nf-btn--${best ? 'primary' : 'secondary'} nf-btn--block`} href={href} data-testid={`link-finder-plan-${m.plan.id}`}>درخواست این طرح</Link>
  </article>;
}

// kept for the /customer/advice hub (unchanged)
export function AdviceHub() {
  const items = [
    { href: '/customer/advice/ai', icon: Bot, title: 'مشاوره با هوش مصنوعی', text: 'سؤال‌هایتان را بپرسید و پیشنهاد اولیه بگیرید.', id: 'ai' },
    { href: '/customer/advice/finder', icon: Search, title: 'پیدا کردن طرح مناسب', text: 'با چند پرسش کوتاه، طرح‌های سازگار با شرایطتان را ببینید.', id: 'finder' },
    { href: '/customer/advice/chat', icon: MessageCircle, title: 'مشاوره با کارشناس فروش انسانی', text: 'مستقیم با کارشناس پرونده‌تان گفتگو کنید.', id: 'human' },
  ];
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">مشاوره</p><h1 className="cp-title">چطور کمکتان کنیم؟</h1></div></div>
    <div className="cp-hub">{items.map(i => <Link key={i.id} href={i.href} data-testid={`link-advice-${i.id}`}><i.icon size={26} color="#bc9252" /><h3>{i.title}</h3><p>{i.text}</p></Link>)}</div></>;
}

