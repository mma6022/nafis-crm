/** Read-only projection from immutable case terms, never today's public plan. */
const digits = (value: string) => value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
function parsed(value: unknown): unknown {
  if(typeof value!=="string")return value;
  try{return JSON.parse(digits(value));}catch{return digits(value).trim();}
}
type PayoutRow = {
  plan_snapshot_json?: unknown; approved_amount?: unknown; requested_amount?: unknown;
  duration_months?: unknown; requested_duration_months?: unknown;
};

/** Snapshot payout percent for one term (the case's stored plan, never today's public plan). */
function snapshotPercent(row: PayoutRow, months: number): string | null {
  const plan=parsed(row.plan_snapshot_json);
  if(!plan||typeof plan!=="object"||Array.isArray(plan))return null;
  const snapshot=plan as Record<string,unknown>;
  if(!Number.isInteger(months)||months<=0)return null;
  const terms=parsed(snapshot.installment_terms??snapshot.installmentTerms);
  let rate:unknown;
  if(Array.isArray(terms)&&terms.length){
    const term=terms.find(t=>t&&typeof t==="object"&&Number(t.installments)===months);
    if(!term)return null;
    rate=parsed(term.depositPercent);
  }else rate=parsed(snapshot.deposit_percents??snapshot.depositPercents);
  if(rate&&typeof rate==="object"&&!Array.isArray(rate))rate=parsed((rate as Record<string,unknown>)[String(months)]);
  if(typeof rate!=="number"&&typeof rate!=="string")return null;
  const rateText=digits(String(rate)).trim();
  if(!/^\d+(?:\.\d{1,6})?$/.test(rateText)||Number(rateText)>100)return null;
  return rateText;
}

/** A customer's own «مبلغ واریزی» for one stored principal and term: exactly round(principal × payout% / 100).
 *  ROUND-47: never rounded to a million — that rule belongs to plan maximums and the calculator only. */
export function customerPayoutForPrincipal(row: PayoutRow, principalValue: unknown, months: number): string | null {
  const rateText=snapshotPercent(row, months);
  if(rateText==null)return null;
  const principal=digits(String(principalValue??"")).trim();
  if(!/^[1-9]\d{0,17}$/.test(principal))return null;
  const [whole,fraction=""]=rateText.split(".");
  const scale=10n**BigInt(fraction.length);
  const numerator=BigInt(principal)*(BigInt(whole)*scale+BigInt(fraction||"0"));
  const divisor=100n*scale;
  return ((numerator+divisor/2n)/divisor).toString();
}

export function customerApplicationPayout(row: PayoutRow): {cashPayoutAmount:string|null;cashPayoutEstimated:boolean} {
  const months=Number(row.duration_months??row.requested_duration_months);
  return {cashPayoutAmount:customerPayoutForPrincipal(row,row.approved_amount??row.requested_amount,months),cashPayoutEstimated:true};
}

/** LEAKS-46 (PM item A): customer view of a case — payout equivalents only, never the stored principal. */
export function customerApplicationPayouts(row: PayoutRow) {
  const months=Number(row.duration_months??row.requested_duration_months);
  const requestedMonths=Number(row.requested_duration_months??row.duration_months);
  return {
    requestedPayoutAmount: customerPayoutForPrincipal(row,row.requested_amount,requestedMonths),
    ...customerApplicationPayout(row),
    approvedPayoutAmount: row.approved_amount==null?null:customerPayoutForPrincipal(row,row.approved_amount,months),
  };
}
