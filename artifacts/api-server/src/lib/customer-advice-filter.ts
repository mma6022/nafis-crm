/** LEAKS-46 (PM item C): the portal «مشاوره» answer reaches customers, so it must never mention the principal, a rate,
 *  a percent, interest or a fee. The prompt no longer carries those figures; this is the output-side safety net. */
const PLAN_TOKEN = /\[PLAN_ID:\s*\d+\s*\]/gi;
const NOT_LETTER = "(?<![\\p{L}\\p{M}])";
const RULES: Array<[reason: string, pattern: RegExp]> = [
  ["percent", /[%٪]|percent/iu],
  ["percent", new RegExp(`${NOT_LETTER}درصد(?!د)`, "u")],
  ["interest", new RegExp(`${NOT_LETTER}سود(?![\\u200c ]?(?:مند|آور))`, "u")],
  ["interest", new RegExp(`${NOT_LETTER}بهره(?![\\u200c ]?(?:مند|بردار|برداری|گیری|وری))`, "u")],
  ["interest", /\binterest\b|\bAPR\b/iu],
  ["rate", new RegExp(`${NOT_LETTER}نرخ`, "u")],
  ["rate", /\brates?\b/iu],
  ["principal", new RegExp(`${NOT_LETTER}اصل[\\u200c ]*(?:وام|تسهیلات|مبلغ|بدهی)`, "u")],
  ["principal", /\bprincipal\b/iu],
  ["fee", new RegExp(`${NOT_LETTER}(?:کارمزد|کمیسیون)`, "u")],
  ["fee", /\b(?:fees?|commission)\b/iu],
];

export const CUSTOMER_ADVICE_FALLBACK =
  "برای این پرسش، مبلغ واریزی و قسط ماهانهٔ هر طرح را در ماشین‌حساب صفحهٔ طرح‌ها ببینید؛ جزئیات بیشتر را کارشناس شما توضیح می‌دهد.";

/** Reason codes only (never the text) — empty when the text is safe for a customer. Plan tokens are ignored. */
export function customerAdviceLeakReasons(text: string): string[] {
  const body = String(text ?? "").replace(PLAN_TOKEN, " ");
  return [...new Set(RULES.filter(([, pattern]) => pattern.test(body)).map(([reason]) => reason))];
}

/** Safe text for a customer: the original when clean, otherwise the fallback plus the answer's own plan tokens
 *  (so the plan suggestion buttons survive). */
export function customerSafeAdvice(text: string): { content: string; blocked: boolean; reasons: string[] } {
  const reasons = customerAdviceLeakReasons(text);
  if (!reasons.length) return { content: text, blocked: false, reasons };
  const tokens = [...new Set(String(text ?? "").match(PLAN_TOKEN) ?? [])].map((token) => token.replace(/\s+/g, ""));
  return { content: [CUSTOMER_ADVICE_FALLBACK, ...tokens].join(" "), blocked: true, reasons };
}
