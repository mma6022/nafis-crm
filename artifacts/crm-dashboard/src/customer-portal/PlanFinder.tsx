import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowRight, Bot, MessageCircle, Search } from 'lucide-react';
import { portalApi, type PlanFinderMatch } from './api';
import { buildPlanFinderRequest, planFinderYes as yes } from './plan-finder-answers';

type Q = { key: string; field: string; label: string; when?: (a: Record<string, string>) => boolean };
const questions: Q[] = [
  { key: 'creditRank', field: 'credit_rank', label: 'رتبه اعتباری متقاضی' },
  { key: 'customerCheckStatus', field: 'customer_check_status', label: 'وضعیت چک متقاضی' },
  { key: 'hasCustomerSalaryDeduct', field: 'has_customer_salary_deduct', label: 'وضعیت کسر از حقوق متقاضی' },
  { key: 'jobType', field: 'job_type', label: 'شغل متقاضی' },
  { key: 'hasGuarantor', field: 'has_guarantor', label: 'ضامن دارد یا نه' },
  { key: 'guarantorCreditRank', field: 'guarantor_credit_rank', label: 'رتبه اعتباری ضامن', when: a => yes(a.hasGuarantor || '') },
  { key: 'guarantorCheckType', field: 'guarantor_check_type', label: 'وضعیت چک ضامن', when: a => yes(a.hasGuarantor || '') },
  { key: 'hasGuarantorSalaryDeduct', field: 'has_guarantor_salary_deduct', label: 'ضامن کسر از حقوق دارد یا نه', when: a => yes(a.hasGuarantor || '') },
];
const statusLabel = { eligible: 'مناسب شما', needs_review: 'نیازمند بررسی کارشناس', not_eligible: 'مطابق نیست' } as const;
const money = (v?: string | null) => { try { return v ? BigInt(v).toLocaleString('fa-IR') : '—'; } catch { return '—'; } };

export function AdviceHub() {
  const items = [
    { href: '/customer/advice/ai', icon: Bot, title: 'مشاوره با هوش مصنوعی', text: 'سؤال‌هایتان را بپرسید و پیشنهاد اولیه بگیرید.', id: 'ai' },
    { href: '/customer/advice/finder', icon: Search, title: 'پیدا کردن طرح مناسب', text: 'با چند پرسش کوتاه، طرح‌های سازگار با شرایطتان را ببینید.', id: 'finder' },
    { href: '/customer/advice/chat', icon: MessageCircle, title: 'مشاوره با کارشناس فروش انسانی', text: 'مستقیم با کارشناس پرونده‌تان گفتگو کنید.', id: 'human' },
  ];
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">مشاوره</p><h1 className="cp-title">چطور کمکتان کنیم؟</h1></div></div>
    <div className="cp-hub">{items.map(i => <Link key={i.id} href={i.href} data-testid={`link-advice-${i.id}`}><i.icon size={26} color="#bc9252" /><h3>{i.title}</h3><p>{i.text}</p></Link>)}</div></>;
}

export function PlanFinder() {
  const opts = useQuery({ queryKey: ['customer', 'plan-finder-options'], queryFn: portalApi.planFinderOptions });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const run = useMutation({ mutationFn: (a: Record<string, string>) =>
    portalApi.planFinder(buildPlanFinderRequest(a)) });
  const active = useMemo(() => questions.filter(q => !q.when || q.when(answers)), [answers]);
  const q = active[index];
  const choices = q ? (opts.data?.options ?? []).filter(o => o.fieldKey === q.field) : [];
  const answer = (value: string) => {
    const next = { ...answers, [q.key]: value };
    if (q.key === 'hasGuarantor' && !yes(value)) { delete next.guarantorCreditRank; delete next.guarantorCheckType; delete next.hasGuarantorSalaryDeduct; }
    setAnswers(next);
    const list = questions.filter(x => !x.when || x.when(next));
    if (index + 1 < list.length) setIndex(index + 1); else run.mutate(next);
  };
  const restart = () => { setAnswers({}); setIndex(0); run.reset(); };
  const head = <div className="cp-pagehead"><div><p className="cp-eyebrow"><Link href="/customer/advice" className="cp-link">مشاوره</Link> / پیدا کردن طرح</p><h1 className="cp-title">طرح مناسب شما کدام است؟</h1></div></div>;
  if (opts.isLoading) return <>{head}<div className="cp-skeleton" role="status" aria-label="در حال دریافت" /></>;
  if (opts.isError) return <>{head}<div className="cp-alert" role="alert">گزینه‌های پرسشنامه دریافت نشد. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void opts.refetch()} data-testid="button-retry-finder">تلاش دوباره</button></div></>;
  if (run.isPending) return <>{head}<div className="cp-skeleton" role="status" aria-label="در حال بررسی طرح‌ها" style={{ height: 120 }} /></>;
  if (run.isError) return <>{head}<div className="cp-alert" role="alert">{run.error instanceof Error ? run.error.message : 'بررسی انجام نشد.'} <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => run.mutate(answers)} data-testid="button-retry-finder-run">تلاش دوباره</button></div></>;
  if (run.isSuccess) {
    const matches: PlanFinderMatch[] = [...run.data.matches].sort((a, b) => ['eligible', 'needs_review', 'not_eligible'].indexOf(a.status) - ['eligible', 'needs_review', 'not_eligible'].indexOf(b.status));
    return <>{head}{!matches.length ? <div className="cp-empty"><strong>طرحی پیدا نشد</strong><p>با کارشناس فروش گفتگو کنید.</p></div>
      : <div className="cp-results">{matches.map(m => <article key={m.plan.id} className={`cp-result ${m.status}`} data-testid={`card-finder-${m.plan.id}`}>
        <span className="cp-eyebrow">{statusLabel[m.status]}</span><h3>{m.plan.name}</h3><p className="cp-hint">{m.plan.bankName || ''}</p>
        {m.customerMaximumAmount && <p>سقف قابل دریافت: <strong>{money(m.customerMaximumAmount)} تومان</strong></p>}
        <p className="cp-hint">هزینه تشکیل پرونده: {money(m.plan.filingFeeToman)} تومان</p>
        {m.failedRequirements.length > 0 && <ul>{m.failedRequirements.map(r => <li key={r}>{r}</li>)}</ul>}
        {m.missingInformation.length > 0 && <ul>{m.missingInformation.map(r => <li key={r}>{r}</li>)}</ul>}
        {m.status !== 'not_eligible' && <Link href={`/customer?planId=${m.plan.id}`} className="cp-btn cp-btn-gold cp-btn-small" data-testid={`link-finder-plan-${m.plan.id}`}>مشاهده در خانه</Link>}</article>)}</div>}
      <p style={{ marginTop: 16 }}><button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={restart} data-testid="button-finder-restart">شروع دوباره</button></p></>;
  }
  if (!q) return null;
  return <>{head}<section className="cp-finder cp-card" aria-live="polite">
    <div className="cp-progress" role="progressbar" aria-valuemin={1} aria-valuemax={active.length} aria-valuenow={index + 1}><i style={{ width: `${((index + 1) / active.length) * 100}%` }} /></div>
    <small className="cp-hint">پرسش {(index + 1).toLocaleString('fa-IR')} از {active.length.toLocaleString('fa-IR')}</small>
    <h2>{q.label}</h2>
    {choices.length ? <div className="cp-choices">{choices.map(c => <button type="button" key={c.value} className="cp-choice" aria-pressed={answers[q.key] === c.value} onClick={() => answer(c.value)} data-testid={`choice-${q.key}-${c.value}`}>{c.label}</button>)}</div>
      : <div className="cp-alert" role="alert">برای این پرسش گزینه‌ای تعریف نشده است.</div>}
    {index > 0 && <button type="button" className="cp-btn cp-btn-outline cp-btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setIndex(index - 1)} data-testid="button-finder-back"><ArrowRight size={13} /> قبلی</button>}
  </section></>;
}
