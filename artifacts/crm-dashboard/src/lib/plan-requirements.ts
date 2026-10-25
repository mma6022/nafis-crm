/**
 * crm-plans-consult: «چک / سفته / کسر از حقوق» of one plan route side. Mirrors
 * artifacts/api-server/src/lib/plan-requirements.ts — keep both in sync.
 * Storage: collateral_type = the primary requirement (specific cheque → promissory → salary → none);
 * needs_* flags = the extra ones (a cheque of «فرقی نمی‌کند» type is the check flag).
 */
export type CheckKind = 'any' | 'physical' | 'digital';
export type SideRequirements = { check: boolean; checkKind: CheckKind; promissory: boolean; salary: boolean };
export const NO_REQUIREMENTS: SideRequirements = { check: false, checkKind: 'any', promissory: false, salary: false };

const isCheck = (v: string) => v === 'physical_check' || v === 'digital_check';

export function sideRequirements(collateralType: string | null | undefined, flags: { check?: boolean | null; promissory?: boolean | null; salary?: boolean | null }): SideRequirements {
  const c = collateralType?.trim() || 'none';
  return {
    check: isCheck(c) || Boolean(flags.check),
    checkKind: c === 'physical_check' ? 'physical' : c === 'digital_check' ? 'digital' : 'any',
    promissory: c === 'promissory' || Boolean(flags.promissory),
    salary: c === 'salary_deduction' || Boolean(flags.salary),
  };
}

export function encodeSide(r: SideRequirements) {
  const specific = r.check && r.checkKind !== 'any';
  const collateralType = specific ? (r.checkKind === 'physical' ? 'physical_check' : 'digital_check')
    : r.promissory ? 'promissory' : r.salary ? 'salary_deduction' : 'none';
  return { collateralType, check: r.check && !specific, promissory: r.promissory && collateralType !== 'promissory', salary: r.salary && collateralType !== 'salary_deduction' };
}

export const CHECK_KIND_LABEL: Record<CheckKind, string> = { any: 'فرقی نمی‌کند', physical: 'فیزیکی', digital: 'دیجیتال (صیادی)' };

/** «چک فیزیکی + سفته» style summary; «بدون تضمین» when nothing is needed. */
export function requirementsText(r: SideRequirements) {
  const parts = [r.check ? (r.checkKind === 'any' ? 'چک' : `چک ${r.checkKind === 'physical' ? 'فیزیکی' : 'دیجیتال'}`) : null,
    r.promissory ? 'سفته' : null, r.salary ? 'کسر از حقوق' : null].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'بدون تضمین';
}
