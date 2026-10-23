/** Blog «طرح‌های مرتبط» (mockup `.mini-plans`): compact cards for the post's relatedPlans, live data with snapshot fallback. */
import { useMemo } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { DAYS_LABEL, byId, combos, fa, millionsFa } from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';

export default function MiniPlans({ snapshot, ids, src }: { snapshot: LoanPlan[]; ids: number[]; src: string }) {
  const { plans } = useLoanPlans(snapshot);
  const list = useMemo(() => {
    const all = combos(plans);
    return ids.map((id) => byId(all, id)).filter((c) => !!c);
  }, [plans, ids]);
  return (
    <div className="mini-plans">
      {list.map((c) => (
        <div className="nf-card mini" key={c.id}>
          <h3>{c.name}</h3>
          <div className="row">
            <span>مبلغ قابل دریافت</span>
            <b>حدود {millionsFa(c.payout)} میلیون</b>
          </div>
          <div className="row">
            <span>قسط {fa(c.term)} ماهه</span>
            <b>حدود {millionsFa(c.inst)} میلیون</b>
          </div>
          <div className="row">
            <span>زمان بررسی</span>
            <b>{DAYS_LABEL[c.days] ?? '—'}</b>
          </div>
          <a className="nf-btn nf-btn--secondary nf-btn--block nf-btn--sm" style={{ marginTop: 6 }} href={`/request?plan=${c.id}&term=${c.term}&src=${encodeURIComponent(src)}`}>
            درخواست همین طرح
          </a>
        </div>
      ))}
    </div>
  );
}
