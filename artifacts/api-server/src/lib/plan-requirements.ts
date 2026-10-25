/**
 * crm-plans-consult (phase 1): how a plan route stores «چک / سفته / کسر از حقوق» for the applicant and the guarantor.
 *
 * Storage rule (one canonical form, so every existing matcher keeps working unchanged):
 *  - collateral_type / guarantor_collateral_type keep the PRIMARY requirement, exactly as before
 *    (none, promissory, digital_check, physical_check, salary_deduction). Picked in this order:
 *    a specific cheque type → promissory → salary deduction → none.
 *  - the needs_* flags hold only the requirements the single collateral_type cannot express (a second / third one,
 *    or a cheque of «فرقی نمی‌کند» type). A flag that repeats collateral_type is redundant and is cleared on write
 *    (normalizeRouteFlags), so no route ever counts the same requirement twice.
 *
 * A route of today (one collateral_type, every flag 0) is already canonical, so the migration
 * (scripts/plans-needs-flags-migrate.mjs) changes no existing row unless a redundant flag is found.
 */
export const CHECK_COLLATERALS = ["physical_check", "digital_check"] as const;
export type CheckKind = "any" | "physical" | "digital";
export type SideRequirements = { check: boolean; checkKind: CheckKind; promissory: boolean; salary: boolean };

export const isCheckCollateral = (v: unknown) => v === "physical_check" || v === "digital_check";
const coll = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "none");

/** What one side really needs, from collateral_type + flags (redundant flags change nothing). */
export function sideRequirements(collateralType: unknown, flags: { check?: unknown; promissory?: unknown; salary?: unknown }): SideRequirements {
  const c = coll(collateralType);
  const check = isCheckCollateral(c) || Boolean(Number(flags.check ?? 0));
  return {
    check,
    checkKind: c === "physical_check" ? "physical" : c === "digital_check" ? "digital" : "any",
    promissory: c === "promissory" || Boolean(Number(flags.promissory ?? 0)),
    salary: c === "salary_deduction" || Boolean(Number(flags.salary ?? 0)),
  };
}

/** Canonical storage of one side: primary collateral_type + the extra flags. */
export function encodeSide(r: SideRequirements): { collateralType: string; check: boolean; promissory: boolean; salary: boolean } {
  const specific = r.check && r.checkKind !== "any";
  const primary = specific ? (r.checkKind === "physical" ? "physical_check" : "digital_check")
    : r.promissory ? "promissory" : r.salary ? "salary_deduction" : "none";
  return {
    collateralType: primary,
    check: r.check && !specific,
    promissory: r.promissory && primary !== "promissory",
    salary: r.salary && primary !== "salary_deduction",
  };
}

/**
 * Clears flags that repeat the side's collateral_type. collateral_type itself is never changed here
 * (an unknown legacy value is kept as is), so matching on collateral_type is untouched.
 */
export function normalizeSideFlags(collateralType: unknown, flags: { check: boolean; promissory: boolean; salary: boolean }) {
  const c = coll(collateralType);
  return {
    check: flags.check && !isCheckCollateral(c),
    promissory: flags.promissory && c !== "promissory",
    salary: flags.salary && c !== "salary_deduction",
  };
}
