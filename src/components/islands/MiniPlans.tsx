/** Blog «طرح‌های مرتبط» (mockup `.mini-plans`): compact cards for the post's relatedPlans (same 3 figures as PlanCard, PM 2026-10-23), live data with snapshot fallback. */
import { useMemo } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { byId, combos, fa, millionsFa } from '../../lib/plans';
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
          {c.retirees && <span className="nf-badge nf-badge--brand plan-tag">ویژه‌ی بازنشستگان</span>}
          <div className="row">
            <span>مبلغ دریافتی</span>
            <b>حدود {millionsFa(c.payout)} میلیون</b>
          </div>
          <div className="row">
            <span>مبلغ هر قسط</span>
            <b>حدود {millionsFa(c.inst)} میلیون</b>
          </div>
          <div className="row">
            <span>تعداد اقساط</span>
            <b>{fa(c.term)}</b>
          </div>
          <a className="nf-btn nf-btn--secondary nf-btn--block nf-btn--sm" style={{ marginTop: 6 }} href={`/request?plan=${c.id}&term=${c.term}&src=${encodeURIComponent(src)}`}>
            درخواست این طرح
          </a>
        </div>
      ))}
    </div>
  );
}
