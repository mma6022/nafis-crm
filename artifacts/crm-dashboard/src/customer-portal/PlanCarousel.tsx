import { useEffect, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Landmark } from 'lucide-react';
import { getPublicLoanPlan, type PublicLoanPlanSummary } from '@workspace/api-client-react';
import { cashCalculatorBounds, maximumCustomerPayout, parseCalculatorAmount, principalCeiling } from './plan-calculator-values';
import type { LoanOption } from './api';
import { planDurations } from './plan-display-values';

const fa = (v: number) => v.toLocaleString('fa-IR');

export function PlanCarousel({ plans, activeId, onSelect, eligiblePlans }: { plans: PublicLoanPlanSummary[]; activeId: number | null; onSelect: (id: number) => void; eligiblePlans?: LoanOption[] }) {
  const details = useQueries({ queries: plans.map(p => ({ queryKey: ['customer', 'plan-details', p.id], queryFn: () => getPublicLoanPlan(p.id), staleTime: 60_000 })) });
  const track = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<number, HTMLElement>());
  const timer = useRef<number | undefined>(undefined);
  const programmaticUntil = useRef(0);
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const idx = plans.findIndex(p => p.id === activeId);

  const reveal = (id: number) => {
    window.clearTimeout(timer.current);
    programmaticUntil.current = performance.now() + 800;
    cards.current.get(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', inline: 'center', block: 'nearest' });
  };
  const choose = (id: number) => { if (id !== activeRef.current) onSelect(id); reveal(id); };
  const go = (i: number) => { const p = plans[i]; if (p) choose(p.id); };

  // Swiping: after scrolling settles, activate the card closest to the viewport centre.
  const onScroll = () => {
    window.clearTimeout(timer.current);
    if (performance.now() < programmaticUntil.current) return;
    timer.current = window.setTimeout(() => {
      const box = track.current?.getBoundingClientRect(); if (!box) return;
      const mid = box.left + box.width / 2; let best: number | null = null; let dist = Infinity;
      cards.current.forEach((el, id) => { const r = el.getBoundingClientRect(); const d = Math.abs(r.left + r.width / 2 - mid); if (d < dist) { dist = d; best = id; } });
      if (best != null && best !== activeRef.current) selectRef.current(best);
    }, 140);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return <div className="cp-carousel">
    <div className="cp-carousel-bar"><span className="cp-hint">برای دیدن طرح‌های بیشتر ورق بزنید</span>
      <div className="cp-actions">
        <button type="button" className="cp-btn cp-btn-outline cp-btn-small" aria-label="طرح قبلی" disabled={idx <= 0} onClick={() => go(idx - 1)} data-testid="button-plan-prev"><ChevronRight size={16} /></button>
        <button type="button" className="cp-btn cp-btn-outline cp-btn-small" aria-label="طرح بعدی" disabled={!plans.length || idx >= plans.length - 1} onClick={() => go(idx + 1)} data-testid="button-plan-next"><ChevronLeft size={16} /></button>
      </div></div>
    <div className="cp-carousel-track" ref={track} onScroll={onScroll} onPointerDown={() => { programmaticUntil.current = 0; }} onWheel={() => { programmaticUntil.current = 0; }} role="list" aria-label="طرح‌های تسهیلات">
      {plans.map((p, i) => {
        const q = details[i]; const d = q.data; const on = p.id === activeId;
        const eligible = eligiblePlans?.find(option => option.planId === p.id);
        const payout = d ? maximumCustomerPayout(d, eligible) : null;
        const ceiling = eligible ? parseCalculatorAmount(eligible.maximumAmount) : d ? principalCeiling(d) : null;
        const months = eligible && d ? cashCalculatorBounds(d, 0, eligible).durations
          : d?.installmentTerms?.length ? d.installmentTerms.map(t => Number(t.installments)).filter(m => m > 0) : planDurations(p.installments);
        const val = (v: number | null) => q.isLoading ? 'در حال محاسبه…' : q.isError ? 'نامشخص' : v == null ? 'اعلام نشده' : `${fa(v)} تومان`;
        return <article key={p.id} role="listitem" tabIndex={0} aria-current={on ? 'true' : undefined} ref={el => { if (el) cards.current.set(p.id, el); else cards.current.delete(p.id); }}
          className={`cp-plan-card cp-plan-visual cp-slide${on ? ' on' : ''}`} onClick={() => choose(p.id)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(p.id); } }} data-testid={`card-plan-${p.id}`}>
          <span className="cp-bank" data-testid={`text-bank-${p.id}`}><Landmark size={14} /> {p.bankName || 'بانک اعلام نشده'}</span>
          <strong>{p.name}</strong>{p.platformName && <p>{p.platformName}</p>}
          <div className="cp-big"><small>سقف مبلغ واریز به مشتری</small><b data-testid={`text-max-payout-${p.id}`}>{val(payout)}</b></div>
          <dl><div><dt>سقف تسهیلات</dt><dd data-testid={`text-ceiling-${p.id}`}>{val(ceiling)}</dd></div>
            <div><dt>مدت</dt><dd>{months.length ? (months.length === 1 ? `${fa(months[0])} ماه` : `${fa(Math.min(...months))} تا ${fa(Math.max(...months))} ماه`) : 'طبق شرایط طرح'}</dd></div></dl>
        </article>;
      })}
    </div></div>;
}
