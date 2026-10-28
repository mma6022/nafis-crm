import { fa } from './api';
import { JOB_LABELS, MILITARY_LABELS } from './plan-reasons';
import { gradeText } from '@/lib/credit-grade';

/** crm-first-call-edit: Persian labels for the «ویرایش خلاصه‌ی تماس اول» history (old → new). */
export const FIRST_CALL_FIELD_LABELS: Record<string, string> = {
  amountMillion: 'مبلغ', docsReady: 'مدارک', creditRank: 'رتبه‌ی متقاضی', cheque: 'چک صیادی', bouncedCheque: 'چک برگشتی',
  military: 'نظام وظیفه', jobType: 'شغل متقاضی', city: 'شهر', guarantorAvailable: 'ضامن', guarantorCheque: 'چک ضامن',
  gRank: 'رتبه‌ی ضامن', gJobType: 'شغل ضامن', selectedPlans: 'طرح‌ها', noPlanFit: 'هیچ طرحی نمی‌خوره', noPlanNote: 'چرا (بدون طرح)',
  urgency: 'فوریت', note: 'یادداشت', ssoRetiree: 'بازنشسته‌ی تأمین اجتماعی', ssoRetireeRelation: 'نسبت (بازنشسته)',
};
const SSO: Record<string, string> = { self: 'خود متقاضی', family: 'یکی از خانواده', none: 'هیچ‌کدام' };
const DOCS: Record<string, string> = { all: 'همه آماده‌ست', partial: 'بخشی', none: 'آماده نیست' };
const URG: Record<string, string> = { now: 'همین الان / این هفته', month: 'تا یک ماه', later: 'بعداً', curious: 'فقط کنجکاوه' };
const TRI: Record<string, string> = { yes: 'بله', no: 'خیر', unknown: 'نمی‌دونه' };
const CHEQUE: Record<string, string> = { check: 'چک دارد', promissory: 'فقط سفته', none: 'هیچ‌کدام' };
const short = (s: string, n = 60) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);

export function firstCallValueText(field: string, v: unknown): string {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  const s = String(v);
  switch (field) {
    case 'amountMillion': return `${fa(Number(v))} میلیون`;
    case 'docsReady': return DOCS[s] ?? s;
    case 'urgency': return URG[s] ?? s;
    case 'cheque': return CHEQUE[s] ?? s;
    case 'creditRank': case 'gRank': return s === 'unknown' ? 'نمی‌دونه' : gradeText(s) || s;
    case 'bouncedCheque': case 'guarantorAvailable': case 'guarantorCheque': return TRI[s] ?? s;
    case 'military': return MILITARY_LABELS[s as keyof typeof MILITARY_LABELS] ?? s;
    case 'jobType': case 'gJobType': return s === 'unknown' ? 'نمی‌دونه' : JOB_LABELS[s] ?? s;
    case 'selectedPlans': return Array.isArray(v) ? v.join('، ') : s;
    case 'ssoRetiree': return SSO[s] ?? s;
    case 'noPlanFit': return v === true ? 'بله' : 'خیر';
    case 'note': case 'noPlanNote': return `«${short(s)}»`;
    default: return s;
  }
}
