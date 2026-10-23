import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPublicLoanPlan } from '@workspace/api-client-react';
import type { LoanOption } from './api';
import { cashCalculatorBounds, customerPayout, millionCashSliderRange, monthlyPmt, parseCalculatorAmount, planAnnualInterest, planPayoutPercent, principalFromCustomerPayout } from './plan-calculator-values';

const fa = (v: number) => Math.round(v).toLocaleString('fa-IR');

export type CalculatorSummary = { cash: number | null; installment: number | null; months: number };

export function PlanCalculator({ planId, amount, duration, onAmount, onDuration, eligiblePlan, feeToman, onSummary }: {
  planId: number; amount: string; duration: string;
  onAmount: (v: string) => void; onDuration: (v: string) => void; eligiblePlan?: LoanOption;
  /** When given (apply flow), the summary also shows the file fee — amount only (handoff §6.1). */
  feeToman?: string | number | null;
  onSummary?: (summary: CalculatorSummary) => void;
}) {
  const q = useQuery({ queryKey: ['customer', 'plan-details', planId], queryFn: () => getPublicLoanPlan(planId), staleTime: 60_000 });
  const p = q.data;
  const [cash, setCash] = useState<number | null>(null);
  const amountRef = useRef(onAmount); amountRef.current = onAmount;
  const durRef = useRef(onDuration); durRef.current = onDuration;

  const first = p ? cashCalculatorBounds(p, Number(duration) || 0, eligiblePlan) : null;
  const durations = first?.durations ?? [];
  const typed = Number(duration);
  const months = durations.includes(typed) ? typed : (durations[0] ?? 0);
  const bounds = p && months > 0 ? cashCalculatorBounds(p, months, eligiblePlan) : null;
  const percent = p && months > 0 ? planPayoutPercent(p, months) : null;
  const rate = p && months > 0 ? planAnnualInterest(p, months) : null;
  const minP = bounds?.minimumPrincipal ?? 1;
  const maxP = bounds?.maximumPrincipal ?? null;
  const zero = percent === 0;
  const cashCeiling = p && maxP != null && percent != null && !zero ? customerPayout(p, maxP, months) : null;
  const minCashRaw = p && percent != null && !zero ? customerPayout(p, minP, months) : null;
  const { minimum: minCash, maximum: maxCash } = millionCashSliderRange(minCashRaw, cashCeiling);
  const rangeOk = maxCash != null && minCash != null && maxCash >= minCash;
  const savedPrincipal = parseCalculatorAmount(amount);
  const savedCash = p && savedPrincipal != null ? customerPayout(p, savedPrincipal, months) : null;
  const cashNow = rangeOk ? Math.min(maxCash!, Math.max(minCash!, cash ?? savedCash ?? maxCash!)) : null;
  const principal = p && cashNow != null && maxP != null ? principalFromCustomerPayout(p, cashNow, months, maxP, minP) : null;

  useEffect(() => {
    if (durations.length && !durations.includes(typed)) durRef.current(String(durations[0]));
  }, [durations.join(','), typed]);
  useEffect(() => {
    if (rangeOk && cashNow != null && cash !== cashNow) setCash(cashNow);
  }, [rangeOk, cashNow, cash]);
  const summaryRef = useRef(onSummary); summaryRef.current = onSummary;
  const livePmt = principal != null && rate != null && months > 0 ? monthlyPmt(principal, rate, months) : null;
  useEffect(() => { summaryRef.current?.({ cash: cashNow, installment: livePmt, months }); }, [cashNow, livePmt, months]);
  useEffect(() => {
    if (q.isLoading || !p) return;
    const next = principal == null ? '' : String(principal);
    if (next !== amount && (principal != null || parseCalculatorAmount(amount) != null)) amountRef.current(next);
  }, [principal, amount, q.isLoading, p]);

  if (q.isLoading) return <section className="nfp-sk-card" role="status" aria-label="در حال دریافت"><div className="nfp-sk" style={{ height: 20, width: '40%' }} /><div className="nfp-sk" style={{ height: 32 }} /><div className="nfp-sk" style={{ height: 52 }} /></section>;
  if (q.isError || !p) return <div className="nfp-alert" role="alert"><span>ماشین‌حساب در دسترس نیست.</span> <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={() => void q.refetch()}>تلاش دوباره</button></div>;

  // Problems are kept for diagnostics only; the customer sees «بعداً اعلام می‌شود» (handoff §6.1).
  let problem = '';
  if (!durations.length) problem = 'durations';
  else if (percent == null) problem = 'payout-percent';
  else if (zero) problem = 'zero-payout';
  else if (maxP == null) problem = 'ceiling';
  else if (!rangeOk) problem = 'range';
  else if (rate == null) problem = 'rate';
  else if (principal == null) problem = 'principal';
  const pmt = !problem && principal != null && rate != null ? monthlyPmt(principal, rate, months) : null;
  if (!problem && pmt == null) problem = 'pmt';
  const fee = feeToman != null && /^\d+$/.test(String(feeToman)) ? Number(feeToman) : null;
  const unknown = <span className="nfp-none">بعداً اعلام می‌شود</span>;

  return <div className="nfp-stack" data-testid="section-plan-calculator">
    <section className="nfp-card nfp-ap-calc" aria-labelledby={`calc-${planId}`}>
      <h2 id={`calc-${planId}`}>مبلغ دریافتی</h2>
      <div className="nfp-ap-val" data-testid="text-calc-cash" aria-live="polite">{cashNow == null ? unknown : <>{fa(cashNow)} <small>تومان</small></>}</div>
      <input id={`cash-${planId}`} className="nfp-ap-range" type="range" dir="ltr" step={1_000_000} aria-label="مبلغ دریافتی"
        aria-valuetext={cashNow == null ? undefined : `${fa(cashNow)} تومان`}
        min={rangeOk ? minCash! : 0} max={rangeOk ? maxCash! : 0} value={cashNow ?? 0} disabled={!rangeOk}
        onChange={e => setCash(Number(e.target.value))} data-testid="slider-customer-payout" />
      {rangeOk && <div className="nfp-ap-caps"><span>{fa(minCash!)}</span><span>{fa(maxCash!)}</span></div>}
      <h3 id={`months-${planId}`} style={{ marginTop: 16 }}>تعداد اقساط</h3>
      {durations.length ? <div className="nfp-ap-chips" role="radiogroup" aria-labelledby={`months-${planId}`} data-testid="select-calc-duration">
        {durations.map(m => <button type="button" role="radio" aria-checked={m === months} className="nfp-ap-chip" key={m}
          onClick={() => onDuration(String(m))} data-testid={`chip-calc-duration-${m}`}>{fa(m)} قسط</button>)}
      </div> : <p className="nfp-muted">{unknown}</p>}
    </section>
    <section className="nfp-card" aria-labelledby={`sum-${planId}`} role="status" data-testid={problem ? 'status-calc-blocked' : 'status-calc-result'} data-reason={problem || undefined}>
      <h2 id={`sum-${planId}`}>خلاصه‌ی درخواست</h2>
      <div className="nfp-facts" style={{ marginTop: 10 }}>
        <div className="nfp-fact nfp-big"><span>مبلغ دریافتی</span>{cashNow == null ? unknown : <b>{fa(cashNow)} <small>تومان</small></b>}</div>
        <div className="nfp-fact"><span>مبلغ قسط</span><b data-testid="text-calc-installment">{pmt == null ? unknown : <>{fa(pmt)} <small>تومان</small></>}</b></div>
        <div className="nfp-fact"><span>تعداد اقساط</span>{months > 0 ? <b>{fa(months)} <small>قسط ماهانه</small></b> : unknown}</div>
        {feeToman !== undefined && <div className="nfp-fact" data-testid="text-calc-fee"><span>هزینه تشکیل پرونده</span>{fee == null ? unknown : <b>{fa(fee)} <small>تومان</small></b>}</div>}
      </div>
    </section>
  </div>;
}
