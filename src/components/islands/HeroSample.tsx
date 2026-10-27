/** Desktop hero sample card: plan 19 at its best payout; plan 19 inactive → first active plan (lib/plans heroSample). Live data with snapshot fallback. */
import { useMemo } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { combos, heroSample, SAMPLE_PLAN_ID } from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';
import { PlanCard } from './PlanCard';

export { SAMPLE_PLAN_ID };

export default function HeroSample({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  const c = useMemo(() => heroSample(combos(plans)), [plans]);
  return c ? <PlanCard c={c} src="home-hero-sample" /> : null;
}
