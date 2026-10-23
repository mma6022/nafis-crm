export type PlanFinderRequest = {
  questionnaireVersion: 2;
  creditRank: string;
  customerCheckStatus: string;
  hasCustomerSalaryDeduct: boolean;
  jobType: string;
  hasGuarantor: boolean;
  guarantorCreditRank?: string;
  guarantorCheckType?: string;
  hasGuarantorSalaryDeduct?: boolean;
  requestedAmount?: string;
};

export const planFinderYes = (value: string = '') =>
  ['1', 'true', 'yes'].includes(value.trim().toLowerCase());

/** Send only answers; ownership and collateral flags are derived by the server. */
export function buildPlanFinderRequest(answers: Record<string, string>): PlanFinderRequest {
  const hasGuarantor = planFinderYes(answers.hasGuarantor);
  return {
    questionnaireVersion: 2,
    creditRank: answers.creditRank,
    customerCheckStatus: answers.customerCheckStatus,
    hasCustomerSalaryDeduct: planFinderYes(answers.hasCustomerSalaryDeduct),
    jobType: answers.jobType,
    hasGuarantor,
    ...(hasGuarantor ? {
      guarantorCreditRank: answers.guarantorCreditRank,
      guarantorCheckType: answers.guarantorCheckType,
      hasGuarantorSalaryDeduct: planFinderYes(answers.hasGuarantorSalaryDeduct),
    } : {}),
  };
}
