/** Parts of each internal wizard step. A click may advance only the step it was rendered for. */
export const WIZARD_STEP_PARTS: Record<number, number> = { 1: 1, 2: 3, 3: 2, 4: 1, 5: 1, 6: 2 };

export function filingFeeIsZero(value: unknown): boolean {
  if (value == null || value === "") return false;
  try { return BigInt(value as string | number | bigint) === 0n; } catch { return false; }
}

/** A resumed draft with no charge is a zero-fee plan only when that plan's fee is 0. */
export function zeroFeeOnHydrate(feeChargeId: number | null | undefined, filingFeeToman: unknown): boolean {
  if (feeChargeId != null && Number(feeChargeId) > 0) return false;
  return filingFeeIsZero(filingFeeToman);
}

/**
 * One click, one move. `fromStep` is the step the button was rendered for.
 * A second click while that step is leaving sees a newer current step and stays put,
 * so the fee step cannot be skipped.
 */
export function advanceWizard(state: { step: number; sub: number }, fromStep: number): { step: number; sub: number } {
  if (fromStep !== state.step) return state;
  const parts = WIZARD_STEP_PARTS[state.step] ?? 1;
  if (state.sub + 1 < parts) return { step: state.step, sub: state.sub + 1 };
  return { step: Math.min(state.step + 1, 6), sub: 0 };
}
