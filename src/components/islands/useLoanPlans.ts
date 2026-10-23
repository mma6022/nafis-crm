import { useEffect, useState } from 'react';
import { fetchLoanPlans, type LoanPlan } from '../../lib/loan-plans';

/**
 * Starts with the build-time snapshot (so prerendered HTML has real plans), then swaps in the
 * live /data/loan-plans.json the CRM publishes. Any failure keeps the snapshot.
 */
export function useLoanPlans(snapshot: LoanPlan[]) {
  const [plans, setPlans] = useState(snapshot);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    fetchLoanPlans(snapshot, ac.signal).then((p) => {
      if (!ac.signal.aborted) {
        setPlans(p);
        setLive(p !== snapshot);
      }
    });
    return () => ac.abort();
  }, [snapshot]);
  return { plans, live };
}
