import { useQuery } from '@tanstack/react-query';
import { portalApi } from './api';
import { parseCalculatorAmount } from './plan-calculator-values';

/** The condition for the chosen payout + months is picked on the server (principal + min/max stay there, PM item 2 / LEAKS-46). */
export function useLoanSelection(planId: number, amount: string, duration: string | number, enabled = true) {
  const payout = parseCalculatorAmount(amount);
  const months = Number(duration);
  const valid = enabled && Number.isSafeInteger(planId) && planId > 0 && payout != null && Number.isInteger(months) && months > 0;
  const q = useQuery({
    queryKey: ['customer', 'loan-selection', planId, payout, months],
    queryFn: () => portalApi.loanSelection({ planId, payout: String(payout), months }),
    enabled: valid, staleTime: 30_000, retry: 1,
  });
  return { conditionId: valid ? q.data?.conditionId ?? null : null, durations: valid ? q.data?.durations ?? null : null, pending: valid && q.isFetching };
}
