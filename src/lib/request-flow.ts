/**
 * Finder deep-link + legacy flow rules (designer ANSWERS-1 §3, §6). Pure, unit-tested; parseDeepLink is used by
 * PlanFinder.tsx (the old RequestWizard that used stepOrder was removed in site-credit-noinst v1.1).
 * Legal 2026-10-24: the customer is never asked a request type (cash / goods); the old «need» step is gone and
 * old `?need=` links are ignored. Amount bands count EVERY active plan.
 */
import { FINDER_PRIOS, type FinderBand, type FinderPrio } from './plans';

/** Step order: with a chosen plan → plan, contact; no amount band in the data → contact; else amount, contact. */
export function stepOrder(hasPlan: boolean, bandCount: number): string[] {
  if (hasPlan) return ['plan', 'contact'];
  if (bandCount === 0) return ['contact'];
  return ['amount', 'contact'];
}

export type FinderDeepLink = { band?: FinderBand; prio?: FinderPrio };

/** Finder deep link `?a=2,fast` → answers; invalid parts are dropped. A legacy `?a=cash,2,fast` drops its type part. */
export function parseDeepLink(a: string | null): FinderDeepLink {
  const out: FinderDeepLink = {};
  if (!a) return out;
  const parts = a.split(',');
  if (['cash', 'goods', 'any'].includes(parts[0]!)) parts.shift(); // legacy type part: ignored
  const [b, p] = parts;
  if (b === '0' || b === '1' || b === '2') out.band = Number(b) as FinderBand;
  if (FINDER_PRIOS.includes(p as FinderPrio)) out.prio = p as FinderPrio;
  return out;
}
