/** Active loan plans list island: snapshot in prerendered HTML, refreshed from /data/loan-plans.json at runtime. */
import { useMemo, useState } from 'react';
import { useLoanPlans } from './useLoanPlans';
import {
  planQuote,
  label,
  LOAN_TYPE_LABEL,
  GRANT_DAYS_LABEL,
  PROCESS_MODE_LABEL,
  type LoanPlan,
} from '../../lib/loan-plans';
import { formatToman, formatTomanShort, toFaDigits } from '../../lib/format';
import { buttonClass, cardClass } from '../ui/styles';

type Filter = 'all' | 'goods' | 'score';

export default function LoanPlansList({ snapshot, limit }: { snapshot: LoanPlan[]; limit?: number }) {
  const { plans } = useLoanPlans(snapshot);
  const [filter, setFilter] = useState<Filter>('all');
  const shown = useMemo(() => {
    const f = filter === 'all' ? plans : plans.filter((p) => p.loanType === filter);
    return limit ? f.slice(0, limit) : f;
  }, [plans, filter, limit]);

  return (
    <div>
      {!limit && (
        <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="فیلتر نوع وام">
          {(
            [
              ['all', 'همه طرح‌ها'],
              ['goods', 'وام کالایی'],
              ['score', 'وام امتیازی'],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filter === v}
              onClick={() => setFilter(v)}
              className={`min-h-12 rounded-full border px-5 font-bold ${filter === v ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-ink-soft hover:border-brand-200 bg-white'}`}
            >
              {l}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-ink-muted">طرحی با این فیلتر فعال نیست.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => {
            const longest = p.installmentTerms.reduce((a, b) => (b.installments > a.installments ? b : a));
            const q = planQuote(p, longest.installments);
            return (
              <li key={p.id} className={`${cardClass} flex flex-col p-5`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <h3 className="text-ink text-lg font-extrabold">{p.name}</h3>
                  <span className="bg-gold-50 text-gold-700 shrink-0 rounded-full px-3 py-1 text-xs font-bold">
                    {label(LOAN_TYPE_LABEL, p.loanType)}
                  </span>
                </div>
                <p className="text-brand-600 text-2xl font-extrabold">{formatTomanShort(p.principalAmount)}</p>
                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <dt className="text-ink-muted">بانک</dt>
                  <dd className="font-semibold">{p.bankName}</dd>
                  <dt className="text-ink-muted">اقساط</dt>
                  <dd className="font-semibold">
                    {p.installmentTerms.map((t) => toFaDigits(t.installments)).join('، ')} ماهه
                  </dd>
                  <dt className="text-ink-muted">قسط از</dt>
                  <dd className="font-semibold">{formatToman(q.monthly)}</dd>
                  <dt className="text-ink-muted">زمان پرداخت</dt>
                  <dd className="font-semibold">{label(GRANT_DAYS_LABEL, p.grantDays)}</dd>
                  <dt className="text-ink-muted">روش</dt>
                  <dd className="font-semibold">{label(PROCESS_MODE_LABEL, p.processMode)}</dd>
                </dl>
                <a href={`/request?plan=${p.id}`} className={buttonClass('primary', 'md', 'mt-5 w-full')}>
                  درخواست این طرح
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
