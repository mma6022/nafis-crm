/**
 * Persian text for the structured plan reasons returned by POST /customers/:id/team-sales/qualify/plans.
 * Same wording as planReasonText in api-server/src/lib/team-sales-rules.ts (HANDOFF crm-call-form-plans §4).
 */
export type PlanReason = {
  code: string; kind: 'met' | 'unknown' | 'violated' | 'warning';
  have?: string; min?: string; allowed?: string[]; two?: boolean;
  cheque?: boolean; salary?: boolean; promissory?: boolean; gMin?: string; gAllowed?: string[];
  jobs?: string[]; excludedJobs?: string[]; max?: number; want?: number;
};
export type PlanStatus = 'fit' | 'depends' | 'no';
export type PlanEvaluation = {
  planId: number; planName: string; bankName: string; loanType: string; installments: number[];
  conditionId: number | string; max: number; status: PlanStatus; amountFits: boolean; reasons: PlanReason[];
};

const FA = '۰۱۲۳۴۵۶۷۸۹';
const faNum = (n: number) => n.toLocaleString('en-US').replace(/,/g, '٬').replace(/[0-9]/g, (d) => FA[Number(d)]);
export const millionText = (rial: number | null | undefined) => `${faNum(Math.round((Number(rial) || 0) / 1e6))} میلیون`;
/** consult_options job_type / guarantor_job_type labels (same list as the plan editor and api plan-profile-match.ts). */
export const JOB_LABELS: Record<string, string> = {
  business: 'آزاد با جواز کسب', employee_with_insurance: 'کارمند با لیست بیمه', employee_no_insurance: 'کارمند بدون لیست بیمه',
  retired: 'بازنشسته', no_doc: 'آزاد بدون مدرک شغلی', unemployed: 'بدون شغل',
};
export const JOB_ORDER = ['employee_with_insurance', 'employee_no_insurance', 'business', 'no_doc', 'retired', 'unemployed'] as const;
export const MILITARY_LABELS: Record<string, string> = { has_card: 'دارای پایان خدمت', no_card: 'بدون پایان خدمت', female: 'مشتری خانم است', unknown: 'نمی‌دونه' };
const NOT_ASKED = '(در تماس اول پرسیده نمی‌شود)';
const joinFa = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join('، ')} و ${xs[xs.length - 1]}`);
const rankWord = (r: { min?: string; allowed?: string[] }) => (r.min ? `${r.min} یا بهتر` : (r.allowed ?? []).join(' یا '));
const jobs = (xs?: string[]) => (xs ?? []).map((j) => JOB_LABELS[j] ?? j).join(' یا ');
const jobOf = (j?: string) => JOB_LABELS[j ?? ''] ?? j ?? '';

export function planReasonText(r: PlanReason): string {
  switch (r.code) {
    case 'rank_ok': return r.min ? `رتبه ${r.have} (حداقل ${r.min})` : `رتبه ${r.have}`;
    case 'rank_below': return `رتبه ${r.have} کمتر از ${r.min} است`;
    case 'rank_not_allowed': return `رتبه ${r.have} جزو رتبه‌های مجاز این طرح نیست`;
    case 'rank_unknown': return `اگر رتبه‌ی متقاضی ${rankWord(r)} باشد`;
    case 'applicant_cheque_ok': return 'چک متقاضی';
    case 'applicant_cheque': return 'چک متقاضی لازم است';
    case 'applicant_promissory_ok': return 'سفته‌ی متقاضی';
    case 'applicant_promissory': return 'سفته‌ی متقاضی لازم است';
    case 'applicant_salary': return r.kind === 'met' ? 'کسر از حقوق' : r.kind === 'violated' ? 'کسر از حقوق لازم است' : `اگر کسر از حقوق داشته باشد ${NOT_ASKED}`;
    case 'guarantor_ok': return 'ضامن';
    case 'guarantor_required': return r.two ? 'دو ضامن لازم است' : 'ضامن لازم است';
    case 'guarantor_unknown': {
      const parts = [r.two ? 'دو ضامن معرفی کند' : 'ضامن معرفی کند'];
      if (r.cheque) parts.push('ضامن چک بدهد');
      if (r.gMin || r.gAllowed?.length) parts.push(`رتبه‌ی ضامن ${rankWord({ min: r.gMin, allowed: r.gAllowed })} باشد`);
      if (r.salary) parts.push('ضامن کسر از حقوق داشته باشد');
      if (r.promissory) parts.push('ضامن سفته بدهد');
      return `اگر ${joinFa(parts)}`;
    }
    case 'two_guarantors': return 'اگر دو ضامن معرفی کند';
    case 'guarantor_cheque_ok': return 'ضامن با چک';
    case 'guarantor_cheque': return 'چک ضامن لازم است';
    case 'guarantor_cheque_unknown': return 'اگر ضامن چک بدهد';
    case 'guarantor_salary': return `اگر ضامن کسر از حقوق داشته باشد ${NOT_ASKED}`;
    case 'guarantor_promissory': return `اگر ضامن سفته بدهد ${NOT_ASKED}`;
    case 'guarantor_rank_ok': return `رتبه‌ی ضامن ${r.have}`;
    case 'guarantor_rank_below': return `رتبه‌ی ضامن ${r.have} کمتر از ${r.min} است`;
    case 'guarantor_rank_not_allowed': return `رتبه‌ی ضامن ${r.have} جزو رتبه‌های مجاز این طرح نیست`;
    case 'guarantor_rank_unknown': return `اگر رتبه‌ی ضامن ${rankWord(r)} باشد`;
    // crm-no-plan-option: same wording as profileReasonText in api-server/src/lib/plan-profile-match.ts
    case 'job_ok': return `شغل متقاضی: ${jobOf(r.have)}`;
    case 'job_not_allowed': return `شغل متقاضی (${jobOf(r.have)}) مجاز نیست؛ فقط ${jobs(r.jobs)}`;
    case 'job_unknown': {
      const ex = r.excludedJobs ?? [];
      return ex.length && ex.length <= 2 ? `اگر شغل متقاضی ${jobs(ex)} نباشد` : `اگر شغل متقاضی ${jobs(r.jobs)} باشد`;
    }
    case 'guarantor_job_ok': return `شغل ضامن: ${jobOf(r.have)}`;
    case 'guarantor_job_not_allowed': return `شغل ضامن (${jobOf(r.have)}) مجاز نیست؛ فقط ${jobs(r.jobs)}`;
    case 'guarantor_job_unknown': {
      const ex = r.excludedJobs ?? [];
      return ex.length && ex.length <= 2 ? `اگر شغل ضامن ${jobs(ex)} نباشد` : `اگر شغل ضامن ${jobs(r.jobs)} باشد`;
    }
    case 'military_ok': return r.have === 'female' ? 'پایان خدمت لازم نیست (خانم)' : 'پایان خدمت دارد';
    case 'military_required': return 'نیاز به پایان خدمت';
    case 'military_unknown': return 'اگر پایان خدمت داشته باشد';
    case 'amount_over_cap': return `سقف ${millionText(r.max)}؛ کمتر از ${millionText(r.want)} درخواستی`;
    default: return '';
  }
}

/** «بانک ملت · تا ۳۰۰ میلیون · ۱۲، ۱۸ یا ۲۴ ماهه» */
export function planMeta(p: { bankName?: string; bank?: string; max: number; installments?: number[] }): string {
  const bank = String(p.bankName ?? p.bank ?? '').trim();
  const parts: string[] = [];
  if (bank) parts.push(/^بانک/.test(bank) ? bank : `بانک ${bank}`);
  if (p.max) parts.push(`تا ${millionText(p.max)}`);
  const inst = p.installments ?? [];
  if (inst.length) parts.push(`${joinOr(inst.map((n) => faNum(n)))} ماهه`);
  return parts.join(' · ');
}
const joinOr = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join('، ')} یا ${xs[xs.length - 1]}`);
