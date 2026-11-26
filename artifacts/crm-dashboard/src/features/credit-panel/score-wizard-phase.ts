/** t943: pure mapping used by ScoreWizard (kept dependency-free so a node fixture can import it). */
export type ScorePhase = "init" | "idle" | "starting" | "otp" | "verifying" | "processing" | "result" | "error" | "blocked";
export const SCORE_STEPS = ["مشخصات", "تأیید و ارسال کد", "کد پیامکی", "نتیجه"] as const;
/** InstantCreditCheck phase → wizard step; null = stay on the step the expert is already on (error / blocked keep it). */
export function phaseStep(p: ScorePhase): 2 | 3 | 4 | null {
  if (p === "init" || p === "idle" || p === "starting") return 2;
  if (p === "otp" || p === "verifying" || p === "processing") return 3;
  if (p === "result") return 4;
  return null;
}
