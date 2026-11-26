const latinDigits = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));

export function formatPhoneForDisplay(value: string) {
  let digits = latinDigits(value).replace(/\D/g, '');
  if (digits.startsWith('0098') && digits.length === 14) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('98') && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith('9') && digits.length === 10) digits = `0${digits}`;
  return digits.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

/** «۰۹۱۲ ۵۵۵ ۰۰۱۷» — same 4-3-4 groups as the Bale chat header (phoneFa). */
export function formatMobileGrouped(value: string) {
  let digits = latinDigits(value).replace(/\D/g, '');
  if (digits.startsWith('0098') && digits.length === 14) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('98') && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.startsWith('9') && digits.length === 10) digits = `0${digits}`;
  const fa = digits.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
  return fa.length === 11 ? `${fa.slice(0, 4)} ${fa.slice(4, 7)} ${fa.slice(7)}` : fa;
}
