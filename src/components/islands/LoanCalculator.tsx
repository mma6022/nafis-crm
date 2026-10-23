/** Installment calculator island. Same math as the live site (amortised, annual rate / 12). */
import { useMemo, useState } from 'react';
import { useLoanPlans } from './useLoanPlans';
import { planQuote, label, LOAN_TYPE_LABEL, type LoanPlan } from '../../lib/loan-plans';
import { formatToman, formatTomanShort, toFaDigits, formatPercentFa } from '../../lib/format';
import { labelClass, inputClass, buttonClass, cardClass } from '../ui/styles';

export default function LoanCalculator({
  snapshot,
  defaultPlanId = 10,
}: {
  snapshot: LoanPlan[];
  defaultPlanId?: number;
}) {
  const { plans } = useLoanPlans(snapshot);
  const [planId, setPlanId] = useState<number>(
    () => (snapshot.find((p) => p.id === defaultPlanId) ?? snapshot[0])?.id ?? 0,
  );
  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const [months, setMonths] = useState<number>(plan?.installmentTerms[0]?.installments ?? 12);
  const q = useMemo(() => (plan ? planQuote(plan, months) : null), [plan, months]);

  if (!plan || !q)
    return (
      <p className="text-ink-muted">در حال حاضر طرح فعالی برای محاسبه وجود ندارد. برای مشاوره با ما تماس بگیرید.</p>
    );

  return (
    <div className={`${cardClass} grid gap-6 p-5 sm:p-8 md:grid-cols-2`}>
      <div className="space-y-5">
        <div>
          <label htmlFor="calc-plan" className={labelClass}>
            طرح تسهیلاتی
          </label>
          <select
            id="calc-plan"
            className={`${inputClass} appearance-none`}
            value={plan.id}
            onChange={(e) => {
              const p = plans.find((x) => x.id === +e.target.value);
              if (p) {
                setPlanId(p.id);
                setMonths(p.installmentTerms[0]!.installments);
              }
            }}
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatTomanShort(p.principalAmount)} — بانک {p.bankName}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className={labelClass}>مدت بازپرداخت</legend>
          <div className="flex flex-wrap gap-2">
            {plan.installmentTerms.map((t) => (
              <button
                key={t.installments}
                type="button"
                aria-pressed={t.installments === q.months}
                onClick={() => setMonths(t.installments)}
                className={`min-h-12 min-w-20 rounded-control border px-4 font-bold transition-colors ${t.installments === q.months ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-ink hover:border-brand-200 bg-white'}`}
              >
                {toFaDigits(t.installments)} ماه
              </button>
            ))}
          </div>
        </fieldset>
        <p className="text-ink-muted text-sm">
          {label(LOAN_TYPE_LABEL, plan.loanType)} · سود سالانه {formatPercentFa(plan.annualInterest)} · پلتفرم{' '}
          {plan.platformName}
        </p>
      </div>

      <div className="bg-brand-50 flex flex-col justify-between gap-4 rounded-[var(--radius-lg)] p-5">
        <div aria-live="polite" className="space-y-4">
          <div>
            <p className="text-ink-muted text-sm">مبلغ واریزی به مشتری</p>
            <p className="text-ink text-2xl font-extrabold">{formatToman(q.deposit)}</p>
          </div>
          <div>
            <p className="text-ink-muted text-sm">قسط ماهانه (برآورد)</p>
            <p className="text-brand-600 text-3xl font-extrabold">{formatToman(q.monthly)}</p>
          </div>
          {q.prepayment > 0 && (
            <div>
              <p className="text-ink-muted text-sm">پیش‌پرداخت</p>
              <p className="text-lg font-bold">{formatToman(q.prepayment)}</p>
            </div>
          )}
        </div>
        <a href={`/request?plan=${plan.id}`} className={buttonClass('primary', 'lg', 'w-full')}>
          درخواست همین طرح
        </a>
        <p className="text-ink-muted text-xs leading-6">
          مبالغ برآوردی هستند؛ مبلغ قطعی پس از اعتبارسنجی و بررسی قرارداد اعلام می‌شود.
        </p>
      </div>
    </div>
  );
}
