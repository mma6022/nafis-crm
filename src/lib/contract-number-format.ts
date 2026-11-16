const normalizeContractNumber = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
  .replace(/[٬،,]/g, "")
  .replace(/٫/g, ".");

export function groupContractNumber(value: string): string {
  const normalized = normalizeContractNumber(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return value;
  const [integer, fraction] = normalized.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const grouped = integer.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

type NumberMapping = {
  variable: string;
  label?: string;
  sourceType?: string;
  customerField?: string | null;
  loanPlanField?: string | null;
  formula?: { tokens: Array<
    { type: "field"; field: string } |
    { type: "literal"; value: string | number } |
    { type: "operator"; value: "+" | "-" | "*" | "/" }
  > } | null;
};

function moneyField(field: string, plan?: Record<string, unknown>): boolean {
  return field === "loanPlan.principalAmount" ||
    (field === "loanPlan.penaltyValue" && plan?.penalty_mode !== "percent");
}

function moneyLabel(mapping: NumberMapping): boolean {
  const description = `${mapping.variable} ${mapping.label ?? ""}`;
  if (/(?:percent|percentage|rate|number|code|duration|count|installments|درصد|نرخ|شماره|شناسه|کد|تعداد|مدت)/i.test(description)) return false;
  return /(?:amount|price|balance|total|payable|payment|credit|principal|مبلغ|تومان|ریال)/i.test(description);
}

export function isContractMoneyMapping(mapping: NumberMapping, plan?: Record<string, unknown>): boolean {
  const sourceType = mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
  if (sourceType === "loanPlan") return moneyField(mapping.loanPlanField ?? "", plan);
  if (sourceType === "manual" || sourceType === "constant") return moneyLabel(mapping);
  if (sourceType !== "formula") return false;
  const tokens = mapping.formula?.tokens;
  if (!tokens?.length) return false;
  // Track monetary dimension, not the mere presence of money in a formula:
  // principal * percent / 100 is money; principal / principal * 100 is not.
  const dimensions: number[] = [];
  const operators: Array<"+" | "-" | "*" | "/"> = [];
  const precedence = (op: string) => op === "*" || op === "/" ? 2 : 1;
  const apply = () => {
    const op = operators.pop()!;
    const right = dimensions.pop()!, left = dimensions.pop()!;
    dimensions.push(op === "*" ? left + right : op === "/" ? left - right : Math.max(left, right));
  };
  for (const token of tokens) {
    if (token.type === "operator") {
      while (operators.length && precedence(operators.at(-1)!) >= precedence(token.value)) apply();
      operators.push(token.value);
    } else {
      dimensions.push(token.type === "field" && moneyField(token.field, plan) ? 1 : 0);
    }
  }
  while (operators.length) apply();
  return dimensions.length === 1 && (dimensions[0] === 1 ||
    (!tokens.some(token => token.type === "field") && moneyLabel(mapping)));
}

export function ungroupContractNumber(value: string): string {
  const asciiDigits = value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).trim();
  // Remove only numeric thousands grouping, never punctuation in free text or dates.
  return /^[+-]?\d{1,3}(?:[,٬،]\d{3})+(?:[.٫]\d+)?$/.test(asciiDigits)
    ? value.replace(/[,٬،]/g, "") : value;
}