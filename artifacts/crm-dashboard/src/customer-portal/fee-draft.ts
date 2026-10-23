// Finds the newest loan-request draft (amount + installments chosen in «ثبت درخواست»); see payment-return.ts.
export type FeeDraft = { planId: number; amount: string; duration: string; at: number };
export function findFeeDraft(customerId: number): FeeDraft | null {
  let best: FeeDraft | null = null;
  try {
    const prefix = `customer-payment-draft:${customerId}:`;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const planId = Number(key.slice(prefix.length));
      if (!Number.isSafeInteger(planId) || planId <= 0) continue;
      const v = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (!v || typeof v.amount !== 'string' || typeof v.duration !== 'string' || !v.amount.trim() || !v.duration.trim()) continue;
      if (!Number.isFinite(v.at) || Date.now() - v.at > 24 * 60 * 60 * 1000) continue;
      if (!best || v.at > best.at) best = { planId, amount: v.amount, duration: v.duration, at: v.at };
    }
  } catch { /* storage disabled: no card */ }
  return best;
}
