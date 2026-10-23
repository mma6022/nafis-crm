/** Desktop hero sample card (designer: card(byId(10))): plan 10 at its best payout, live data with snapshot fallback. */
import { useMemo } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { byId, combos } from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';
import { PlanCard } from './PlanCard';

export const SAMPLE_PLAN_ID = 10;

export default function HeroSample({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  const c = useMemo(() => {
    const all = combos(plans);
    return byId(all, SAMPLE_PLAN_ID) ?? [...all].sort((a, b) => b.payout - a.payout)[0];
  }, [plans]);
  return c ? <PlanCard c={c} src="home-hero-sample" /> : null;
}
