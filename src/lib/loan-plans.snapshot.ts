/** Build-time snapshot used for prerendered HTML and as the runtime fallback. */
import raw from '../data/loan-plans.snapshot.json';
import { parseComingSoonPlans, parseLoanPlans } from './loan-plans';

export const LOAN_PLANS_SNAPSHOT = parseLoanPlans(raw);
/** Active plans the CRM cannot calculate yet: listed on /plans with «به‌زودی» (no figures). */
export const COMING_SOON_SNAPSHOT = parseComingSoonPlans(raw);
