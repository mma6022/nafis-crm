import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPublicLoanPlan } from '@workspace/api-client-react';
import type { LoanOption } from './api';
import { cashCalculatorBounds, customerPayout, millionCashSliderRange, monthlyPmt, parseCalculatorAmount, planAnnualInterest, planPayoutPercent, principalFromCustomerPayout } from './plan-calculator-values';

const fa = (v: number) => Math.round(v).toLocaleString('fa-IR');

export function PlanCalculator({ planId, amount, duration, onAmount, onDuration, eligiblePlan }: {
  planId: number; amount: string; duration: string;
  onAmount: (v: string) => void; onDuration: (v: string) => void; eligiblePlan?: LoanOption;
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
  useEffect(() => {
    if (q.isLoading || !p) return;
    const next = principal == null ? '' : String(principal);
    if (next !== amount && (principal != null || parseCalculatorAmount(amount) != null)) amountRef.current(next);
  }, [principal, amount, q.isLoading, p]);

  if (q.isLoading) return <section className="cp-card" role="status" aria-label="در حال دریافت"><div className="cp-skeleton" /></section>;
  if (q.isError || !p) return <div className="cp-alert" role="alert">ماشین‌حساب در دسترس نیست. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void q.refetch()}>تلاش دوباره</button></div>;

  let problem = '';
  if (!durations.length) problem = 'مدت اقساط این طرح اعلام نشده است.';
  else if (percent == null) problem = 'درصد واریز به مشتری برای این مدت اعلام نشده است.';
  else if (zero) problem = 'این طرح برای این مدت مبلغ واریزی نقدی ندارد.';
  else if (maxP == null) problem = 'سقف تسهیلات این طرح اعلام نشده است.';
  else if (!rangeOk) problem = 'بازه واریزی این مدت برای انتخاب با گام یک‌میلیون تومان کافی نیست.';
  else if (rate == null) problem = 'درصد سود سالانه برای این مدت اعلام نشده است.';
  else if (principal == null) problem = 'محاسبه با این مقدار ممکن نیست.';
  const pmt = !problem && principal != null && rate != null ? monthlyPmt(principal, rate, months) : null;
  if (!problem && pmt == null) problem = 'محاسبه با این مقادیر ممکن نیست.';

  return <section className="cp-card cp-calc" data-testid="section-plan-calculator"><h3>ماشین‌حساب قسط</h3>
    <div className="cp-cash">
      <label htmlFor={`cash-${planId}`}>مبلغ واریزی به مشتری</label>
      <div className="cp-cash-value" data-testid="text-calc-cash">{cashNow == null ? '—' : `${fa(cashNow)} تومان`}</div>
      <input id={`cash-${planId}`} className="cp-range" type="range" dir="ltr" step={1_000_000} aria-label="مبلغ واریزی به مشتری"
        min={rangeOk ? minCash! : 0} max={rangeOk ? maxCash! : 0} value={cashNow ?? 0} disabled={!rangeOk}
        onChange={e => setCash(Number(e.target.value))} data-testid="slider-customer-payout" />
      {rangeOk && <div className="cp-cash-caps"><span>حداکثر {fa(maxCash!)}</span><span>حداقل {fa(minCash!)}</span></div>}
    </div>
    <div className="cp-form-grid cp-calc-grid">
      <label className="cp-field">تعداد اقساط<select value={durations.includes(typed) ? duration : ''} onChange={e => onDuration(e.target.value)} data-testid="select-calc-duration"><option value="" disabled>انتخاب</option>{durations.map(m => <option key={m} value={m}>{fa(m)} ماه</option>)}</select></label>
      <label className="cp-field">سود سالانه طرح (٪)<input readOnly value={rate == null ? 'اعلام نشده' : rate.toLocaleString('fa-IR')} data-testid="input-calc-rate" /></label>
    </div>
    {problem ? <div className="cp-alert cp-alert-info" role="status" data-testid="status-calc-blocked">{problem}</div> : <div className="cp-calc-out" role="status" data-testid="status-calc-result">
      <div className="cp-calc-main"><small>قسط ماهانه</small><b data-testid="text-calc-installment">{fa(pmt!)} تومان</b></div>
      </div>}
    <p className="cp-hint">برآورد با اقساط ثابت پایان هر ماه محاسبه می‌شود و هزینه‌های جداگانه در آن نیست. مبلغ نهایی را سامانه تعیین می‌کند.</p>
  </section>;
}
