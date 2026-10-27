/**
 * /calculator island (UX-SPEC §7, designer ANSWERS-1 §9): received-amount band (option cards) → term (chips),
 * then 1–3 PlanCards (lib/plans `calcPicks`). No 18-plan <select>; amounts read «حدود ۳۱۵ میلیون تومان».
 * Amounts are the public مبلغ واریزی and installment of each term. No plan-type selector (legal 2026-10-24): every eligible plan counts.
 */
import { useMemo, useState } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { FINDER_Q, calcPicks, combos, fa, type FinderBand } from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';
import { PlanCard } from './PlanCard';
import { I, type SpriteIcon } from '../ui/I';

export default function LoanCalculator({ snapshot, src = 'calculator' }: { snapshot: LoanPlan[]; src?: string }) {
  const { plans } = useLoanPlans(snapshot);
  const all = useMemo(() => combos(plans), [plans]);
  const [band, setBand] = useState<FinderBand>(2);
  const terms = useMemo(() => [...new Set(all.map((c) => c.term))].sort((a, b) => a - b), [all]);
  const [term, setTerm] = useState(24);
  /** «بازنشسته هستم»: retiree-only plans are offered only then */
  const [retired, setRetired] = useState(false);
  const t = terms.includes(term) ? term : (terms.reduce((b, x) => (Math.abs(x - term) < Math.abs(b - term) ? x : b), terms[0] ?? term));
  const picks = useMemo(() => calcPicks(all, band, t, 3, retired), [all, band, t, retired]);

  if (!all.length) return <p className="note">در حال حاضر طرح فعالی برای محاسبه وجود ندارد. برای مشاوره با ما تماس بگیرید.</p>;

  return (
    <div className="lc">
      <div className="lc-in">
        <div className="grp">
          <span id="lc-b">مبلغ موردنیاز (واریزی)</span>
          <div className="opts" role="group" aria-labelledby="lc-b">
            {FINDER_Q.band.opts.map((o) => (
              <button type="button" className="nf-option" key={o.v} aria-pressed={band === o.v} onClick={() => setBand(o.v)}>
                <span className="ic">
                  <I name={o.icon as SpriteIcon} />
                </span>
                <span className="tx">
                  <b>{o.title}</b>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="grp">
          <span id="lc-m">مدت بازپرداخت</span>
          <div className="seg" role="group" aria-labelledby="lc-m">
            {terms.map((x) => (
              <button type="button" key={x} aria-pressed={t === x} onClick={() => setTerm(x)}>
                {fa(x)} ماه
              </button>
            ))}
          </div>
        </div>
        <div className="grp">
          <label className="retired-toggle">
            <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.currentTarget.checked)} />
            <span>بازنشسته هستم</span>
          </label>
        </div>
      </div>
      <div className="lc-out" aria-live="polite">
        <h2 className="lc-h">{picks.length === 1 ? 'طرح نزدیک به انتخاب شما' : `${fa(picks.length)} طرح نزدیک به انتخاب شما`}</h2>
        <div className={`cards plancards n${picks.length}`}>
          {picks.map((c, i) => (
            <PlanCard key={c.id} c={c} featured={i === 0} src={src} variant="result" />
          ))}
        </div>
      </div>
    </div>
  );
}
