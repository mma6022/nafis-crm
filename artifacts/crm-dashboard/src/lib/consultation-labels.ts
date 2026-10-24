import { gradeText, isGradeValue } from './credit-grade';
type DictionaryOption = { fieldKey: string; value: string; labelFa: string };
const defaults: Record<string, Record<string, string>> = {
  loan_type: { goods: 'خرید کالا', cash: 'نقدی', cash_and_goods: 'نقدی و خرید کالا', credit: 'اعتباری' },
  required_document: {
    national_card: 'کارت ملی پشت و رو',
    birth_certificate_all_pages: 'تمام صفحات شناسنامه',
    guarantee_check: 'چک ضمانت',
    promissory: 'سفته',
    salary_deduction: 'گواهی کسر از حقوق',
    bank_statement: 'گردش حساب',
    account_turnover: 'گردش حساب',
    average_balance: 'میانگین حساب',
    job_certificate: 'گواهی اشتغال',
    business_license: 'جواز کسب',
    salary_slip: 'فیش حقوقی',
  },
  collateral_type: { none: 'بدون وثیقه', promissory: 'سفته', physical_check: 'چک فیزیکی', digital_check: 'چک دیجیتال', salary_deduction: 'گواهی کسر از حقوق' },
};

/** Display dictionary labels, never machine codes, in consultation results. */
export function consultationLabel(field: string, value: string | null | undefined, options: DictionaryOption[] = []): string {
  if (!value?.trim()) return 'ثبت نشده';
  const text = value.trim();
  // Credit grades: sub-grades read as is (A1 … E3); a bare letter saved before sub-grades reads «B (قدیمی)».
  if ((field === 'credit_rank' || field === 'guarantor_credit_rank') && isGradeValue(text)) return gradeText(text);
  const dictionary = options.find(option => option.fieldKey === field && option.value === text)?.labelFa;
  if (dictionary && /[\u0600-\u06ff]/.test(dictionary)) return dictionary;
  const fallback = defaults[field]?.[text];
  if (fallback) return fallback;
  if (field === 'grant_days') {
    const range = /^(\d+)_to_(\d+)$/.exec(text);
    if (range) return `${Number(range[1]).toLocaleString('fa-IR')} تا ${Number(range[2]).toLocaleString('fa-IR')} روز`;
    if (/^\d+$/.test(text)) return `${Number(text).toLocaleString('fa-IR')} روز`;
  }
  // Existing custom Persian labels remain readable even if a dictionary was removed.
  if (/[\u0600-\u06ff]/.test(text) && !/[A-Za-z_]/.test(text)) return text;
  return 'عنوان فارسی تعریف نشده است';
}
