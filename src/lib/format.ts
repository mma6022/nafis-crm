/** Persian digit + money formatting helpers (pure, safe for SSR and islands). */
const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';

/** 1234 → "۱۲۳۴" (any string/number; only ASCII digits are converted). */
export const toFaDigits = (v: string | number): string => String(v).replace(/[0-9]/g, (d) => FA[+d]!);

/** "۱۲۳۴" / "١٢٣٤" → "1234". Use before parsing user input. */
export const toEnDigits = (v: string): string =>
  v.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

/** Parse a user-typed number with Persian/Arabic digits and separators (٬ , space). NaN if invalid. */
export const parseNumber = (v: string): number => {
  const clean = toEnDigits(v).replace(/[,\s٬_]/g, '');
  return clean === '' ? NaN : Number(clean);
};

/** 250000000 → "۲۵۰٬۰۰۰٬۰۰۰" */
export const formatNumberFa = (n: number, opts: Intl.NumberFormatOptions = {}): string =>
  new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0, ...opts }).format(n);

/** 250000000 → "۲۵۰٬۰۰۰٬۰۰۰ تومان" */
export const formatToman = (n: number): string => `${formatNumberFa(Math.round(n))} تومان`;

/** 250000000 → "۲۵۰ میلیون تومان", 1500000000 → "۱٫۵ میلیارد تومان" */
export const formatTomanShort = (n: number): string => {
  if (n >= 1e9) return `${formatNumberFa(n / 1e9, { maximumFractionDigits: 1 })} میلیارد تومان`;
  if (n >= 1e6) return `${formatNumberFa(n / 1e6, { maximumFractionDigits: 1 })} میلیون تومان`;
  return formatToman(n);
};


/** Iranian mobile: accepts ۰۹۱۲…, 0912…, +98912…, 98912… → "09121234567" or null. */
export const normalizeIranMobile = (v: string): string | null => {
  const d = toEnDigits(v).replace(/[^\d]/g, '');
  const m = d.match(/^(?:0098|98|0)?(9\d{9})$/);
  return m ? `0${m[1]}` : null;
};

/** Wizard mobile field (designer site.js `toEn`): Persian/Arabic digits → ASCII, every non-digit dropped. */
export const mobileDigits = (v: string): string => toEnDigits(v).replace(/\D/g, '');
/** Accepted mobile: exactly 11 digits starting with 09 (after `mobileDigits`). */
export const MOBILE_RE = /^09\d{9}$/;
export const isValidMobile = (v: string): boolean => MOBILE_RE.test(mobileDigits(v));

/** Jalali date for display, e.g. "۲ آبان ۱۴۰۵". */
export const formatDateFa = (d: Date): string =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
