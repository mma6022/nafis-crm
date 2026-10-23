/** Build-time snapshot used for prerendered HTML and as the runtime fallback. */
import raw from '../data/loan-plans.snapshot.json';
import { parseLoanPlans } from './loan-plans';

export const LOAN_PLANS_SNAPSHOT = parseLoanPlans(raw);
