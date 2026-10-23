/** /request wizard flow rules (designer ANSWERS-1 §3, §6). Pure, unit-tested; used by RequestWizard.tsx. */
import type { Combo } from './plans';
import type { Need } from './lead';

/** Combos that match a wizard need (cash → loanType score, goods → goods, help/null → all). */
export const combosForNeed = (all: Combo[], need: Need | null) =>
  need === 'cash' ? all.filter((c) => c.type === 'score') : need === 'goods' ? all.filter((c) => c.type === 'goods') : all;

/** Step order: with a chosen plan → plan, contact; «نمی‌دانم» (or a need with no band) → need, contact; else 3 steps. */
export function stepOrder(hasPlan: boolean, need: Need | null, bandCount: number): string[] {
  if (hasPlan) return ['plan', 'contact'];
  if (need === 'help' || (need && bandCount === 0)) return ['need', 'contact'];
  return ['need', 'amount', 'contact'];
}

