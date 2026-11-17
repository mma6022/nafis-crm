/** plan-advisor v1 display helpers. No new calculator math — amounts come from the server quote. */
export const faNum = (n: number) => n.toLocaleString("fa-IR");
export const faToman = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${faNum(n)} تومان`);

export function paTotalPayable(installment: number, count: number, downPayment: number, filingFee: number): number {
  return (installment * count) + (downPayment || 0) + (filingFee || 0);
}

export const PA_STATUS: Record<string, string> = { fit: "مناسب", depends: "بستگی دارد", no: "نامناسب" };
export const PA_STEPS = ["شرایط", "طرح‌های پیشنهادی", "ماشین‌حساب"] as const;
export type PaStep = 0 | 1 | 2 | 3; // 0 = pick customer, 1–3 = wizard

export function paStepLabel(step: PaStep): string {
  if (step <= 0) return "انتخاب مشتری";
  return `مرحلهٔ ${faNum(step)} از ۳ — ${PA_STEPS[step - 1]}`;
}

export function formatPrincipalInput(raw: string): string {
  const d = raw.replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c))).replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c))).replace(/[^\d]/g, "");
  if (!d) return "";
  return Number(d).toLocaleString("fa-IR");
}
export function parsePrincipalInput(raw: string): number | null {
  const d = raw.replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c))).replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c))).replace(/[^\d]/g, "");
  if (!d) return null;
  const n = Number(d);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function faMonths(ns: number[]): string {
  if (!ns.length) return "";
  if (ns.length === 1) return ` · ${faNum(ns[0])} ماه`;
  const head = ns.slice(0, -1).map(faNum).join("، ");
  return ` · ${head} و ${faNum(ns[ns.length - 1])} ماه`;
}
