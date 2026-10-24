import { parseJalaliValue } from '@/lib/jalali';

export function normalizeDigits(value: string) {
  return value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

export function validateIranianNationalCode(value: string) {
  const code = normalizeDigits(value).trim();
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const sum = code.slice(0, 9).split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  const checkDigit = Number(code[9]);
  return remainder < 2 ? checkDigit === remainder : checkDigit === 11 - remainder;
}

export const NATIONAL_CODE_OPTIONAL_ERROR = 'کد ملی ۱۰ رقمی معتبر وارد کنید؛ اگر ندارید خالی بگذارید.';
export const NATIONAL_CODE_CLEAR_HINT = 'با ذخیره، کد ملی ثبت‌شده پاک می‌شود.';

/**
 * crm-nid-optional (PM 16:03): «کد ملی» is optional for every customer edit.
 * - filled → must be 10 digits with a correct check digit; sent only when it differs from the stored code;
 * - empty and untouched (or nothing stored) → omitted, so the stored code is never wiped;
 * - stored code that the user touched and emptied → explicit `clearNationalCode: true`.
 */
export function nationalCodePatch(input: string, stored: string | null | undefined, touched: boolean):
  { error?: string; patch: { nationalCode?: string; clearNationalCode?: true }; clearing: boolean } {
  const raw = normalizeDigits(input ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  const storedDigits = normalizeDigits(stored ?? '').replace(/\D/g, '');
  // crm-nid-quick (PM 16:37): an untouched field is never validated or sent, so a legacy/odd stored code
  // can't block a name-only edit; only what the user typed is checked.
  if (!touched) return { patch: {}, clearing: false };
  if (raw) {
    if (!validateIranianNationalCode(digits)) return { error: NATIONAL_CODE_OPTIONAL_ERROR, patch: {}, clearing: false };
    return { patch: digits === storedDigits ? {} : { nationalCode: digits }, clearing: false };
  }
  if (touched && storedDigits) return { patch: { clearNationalCode: true }, clearing: true };
  return { patch: {}, clearing: false };
}

export function validateIranianMobile(value: string) {
  return /^09\d{9}$/.test(normalizeDigits(value).trim());
}

export function validateIranianPostalCode(value: string) {
  const code = normalizeDigits(value).trim();
  return !code || /^\d{10}$/.test(code);
}

export function validateJalaliBirthDate(value: string) {
  const parts = parseJalaliValue(value);
  if (!parts) return false;
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC',
  }).formatToParts(now).reduce<Record<string, number>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts.year < today.year
    || (parts.year === today.year && (parts.month < today.month || (parts.month === today.month && parts.day <= today.day)));
}

export function validateOtp(value: string) {
  return /^\d{4,8}$/.test(normalizeDigits(value).trim());
}

export type FieldErrors = Record<string, string>;

export function serverFieldErrors(error: unknown): FieldErrors {
  const typed = error as {
    data?: Record<string, unknown>;
    response?: { data?: Record<string, unknown> };
    message?: unknown;
  } | null;
  const payload = typed?.data ?? typed?.response?.data;
  if (!payload) return {};
  const result: FieldErrors = {};
  const source = payload.fieldErrors ?? payload.errors ?? payload.details;
  if (Array.isArray(source)) {
    for (const issue of source) {
      if (!issue || typeof issue !== 'object') continue;
      const detail = issue as Record<string, unknown>;
      const field = mapServerField(String(detail.field ?? detail.path ?? detail.property ?? ''));
      const rawMessage = detail.message ?? detail.error;
      const message = typeof rawMessage === 'string' ? rawMessage : '';
      if (field && message) result[field] = /[\u0600-\u06FF]/.test(message) ? message : serverFieldMessage(field);
    }
  } else if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const field = mapServerField(key);
      const candidate = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).message
        : value;
      const message = typeof candidate === 'string'
        ? candidate
        : Array.isArray(candidate) && typeof candidate[0] === 'string'
          ? candidate[0]
          : '';
      if (field && message) result[field] = /[\u0600-\u06FF]/.test(message) ? message : serverFieldMessage(field);
    }
  }
  const code = typeof payload.error === 'string' ? payload.error.toLowerCase() : '';
  const detail = `${code} ${typeof payload.message === 'string' ? payload.message : ''}`.toLowerCase();
  const field = mapServerField(detail);
  if (field && !result[field]) result[field] = serverFieldMessage(field);
  return result;
}

function mapServerField(value: string): string | null {
  const key = value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
  if (key === 'name' || key === 'fullname' || key === 'نام') return 'name';
  if (/nationalcode|national_code|کدملی/.test(key)) return 'nationalCode';
  if (/phone|mobile|موبایل|شمارههمراه/.test(key)) return 'phone';
  if (/birthdate|birth_date|jalali|تولد|تاریختولد/.test(key)) return 'birthDateJalali';
  if (/postalcode|postal_code|کدپستی/.test(key)) return 'postalCode';
  if (/otp|one.?time|رمز|کداعتبارسنجی/.test(key)) return 'otp';
  if (/amount|requestedamount|مبلغ/.test(key)) return 'amount';
  if (/duration|months|مدت/.test(key)) return 'duration';
  return null;
}

function serverFieldMessage(field: string) {
  const messages: Record<string, string> = {
    nationalCode: 'کد ملی واردشده معتبر نیست.',
    name: 'نام مشتری را وارد کنید.',
    phone: 'شماره همراه واردشده معتبر نیست.',
    birthDateJalali: 'تاریخ تولد شمسی معتبر نیست.',
    postalCode: 'کد پستی باید ۱۰ رقم باشد.',
    otp: 'کد یک‌بارمصرف معتبر نیست.',
    amount: 'مبلغ درخواستی برای این طرح معتبر نیست.',
    duration: 'مدت بازپرداخت برای این طرح معتبر نیست.',
  };
  return messages[field] ?? 'مقدار این فیلد معتبر نیست.';
}