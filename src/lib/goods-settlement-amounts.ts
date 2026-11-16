export function goodsSettlementAmounts(base: string, discount: unknown = "0") {
  if (!/^\d{1,30}$/.test(base) || typeof discount !== "string"
    || !/^-?(0|[1-9]\d{0,29})$/.test(discount)) throw new Error("invalid_fee_discount");
  const delta = BigInt(discount);
  const final = BigInt(base) + delta;
  if (final <= 0n || final.toString().length > 30) throw new Error("invalid_customer_payout");
  return {
    basePayoutAmountToman: base,
    feeDiscountToman: delta.toString(),
    payoutAmountToman: final.toString(),
  };
}