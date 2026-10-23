/** Read-only projection from immutable case terms, never today's public plan. */
const digits = (value: string) => value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
function parsed(value: unknown): unknown {
  if(typeof value!=="string")return value;
  try{return JSON.parse(digits(value));}catch{return digits(value).trim();}
}
export function customerApplicationPayout(row: {
  plan_snapshot_json?: unknown; approved_amount?: unknown; requested_amount?: unknown;
  duration_months?: unknown; requested_duration_months?: unknown;
}): {cashPayoutAmount:string|null;cashPayoutEstimated:boolean} {
  const unknown={cashPayoutAmount:null,cashPayoutEstimated:true};
  const plan=parsed(row.plan_snapshot_json);
  if(!plan||typeof plan!=="object"||Array.isArray(plan))return unknown;
  const snapshot=plan as Record<string,unknown>;
  const months=Number(row.duration_months??row.requested_duration_months);
  if(!Number.isInteger(months)||months<=0)return unknown;
  const terms=parsed(snapshot.installment_terms??snapshot.installmentTerms);
  let rate:unknown;
  if(Array.isArray(terms)&&terms.length){
    const term=terms.find(t=>t&&typeof t==="object"&&Number(t.installments)===months);
    if(!term)return unknown;
    rate=parsed(term.depositPercent);
  }else rate=parsed(snapshot.deposit_percents??snapshot.depositPercents);
  if(rate&&typeof rate==="object"&&!Array.isArray(rate))rate=parsed((rate as Record<string,unknown>)[String(months)]);
  if(typeof rate!=="number"&&typeof rate!=="string")return unknown;
  const rateText=digits(String(rate)).trim();
  if(!/^\d+(?:\.\d{1,6})?$/.test(rateText)||Number(rateText)>100)return unknown;
  const principal=digits(String(row.approved_amount??row.requested_amount??"")).trim();
  if(!/^[1-9]\d{0,17}$/.test(principal))return unknown;
  const [whole,fraction=""]=rateText.split(".");
  const scale=10n**BigInt(fraction.length);
  const numerator=BigInt(principal)*(BigInt(whole)*scale+BigInt(fraction||"0"));
  const divisor=100n*scale;
  return {cashPayoutAmount:((numerator+divisor/2n)/divisor).toString(),cashPayoutEstimated:true};
}
