import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as { error?: string; message?: string };
    const fallback = res.status === 404 ? 'این سرویس هنوز روی سرور در دسترس نیست.' : res.status === 403 ? 'دسترسی لازم برای این عملیات را ندارید.' : res.status === 503 ? 'سرویس خارجی در دسترس نیست.' : 'درخواست با خطا روبه‌رو شد.';
    throw new ApiError(translateError(obj.error || obj.message) || fallback, res.status, obj.error || '');
  }
  return data as T;
}

const ERRORS: Record<string, string> = {
  gl_posting_failed: 'ثبت سند دفتر کل ناموفق بود؛ هیچ تغییری ذخیره نشد. دوباره تلاش کنید یا به مدیر سیستم خبر دهید.',
  pre_opening_pay_forbidden: 'این دستور پیش از شروع دفتر کل پرداخت شده و در ماندهٔ افتتاحیه لحاظ شده؛ علامت پرداخت دوباره ندارد.',
  pre_opening_unpay_forbidden: 'این دستور پیش از شروع دفتر کل پرداخت شده و در ماندهٔ افتتاحیه لحاظ شده؛ «لغو پرداخت‌شده» برای آن نیست. اصلاح فقط از راه بازبینی موجودی اولیه.',
  gl_reports_off: 'دفتر کل هنوز فعال نیست.',
  gl_report_failed: 'ساخت گزارش دفتر کل با خطا روبه‌رو شد.',
  gl_bad_range: 'بازهٔ تاریخ درست نیست («از» نباید بعد از «تا» باشد).',
  gl_unknown_account: 'این حساب در سرفصل‌ها نیست.',
  invalid_fee_discount: 'تخفیف کارمزد باید مبلغ صحیح به تومان باشد.',
  invalid_customer_payout: 'مبلغ نهایی واریزی مشتری باید بیشتر از صفر و در محدودهٔ مجاز باشد.',
  settlement_discount_locked: 'تخفیف کارمزد پس از ثبت تسویه قابل تغییر نیست.',
  bank_verification_unavailable: 'سرویس استعلام بانکی در دسترس نیست یا پیکربندی نشده است. کمی بعد دوباره تلاش کنید.',
  customer_birth_date_required: 'تاریخ تولد شمسی مشتری ثبت نشده یا معتبر نیست. ابتدا تاریخ تولد را در ویرایش پروفایل مشتری اصلاح و ذخیره کنید، سپس دوباره استعلام بگیرید.',
  bank_ownership_mismatch: 'این حساب متعلق به کد ملی مشتری نیست؛ تأیید نشد.',
  signed_invoice_required: 'فاکتور امضاشده نسخه جاری لازم است.',
  signed_acknowledgement_required: 'اقرارنامه امضاشده لازم است.',
  plan_finance_configuration_required: 'تنظیمات مالی خرید کالا برای این طرح (درصد پرداخت و قالب اقرارنامه) ثبت نشده است.',
  salesperson_commission_configuration_required: 'کارشناس فروش این مشتری تعریف نشده یا پله‌های پورسانت او تنظیم نشده است.',
  no_available_credit: 'این کیف پول اعتبار قابل استفاده ندارد.',
  wallet_reserved: 'این کیف پول یک رزرو فعال دیگر دارد.',
  credit_attribution_requires_reconciliation: 'منشأ بخشی از اعتبار مشخص نیست و نیاز به تطبیق مالی دارد.',
  invalid_purchase_stage: 'این عملیات در مرحله فعلی خرید مجاز نیست.',
  purchase_not_found: 'خرید پیدا نشد.',
  Forbidden: 'دسترسی لازم برای این عملیات را ندارید.',
  positive_customer_payout_required: 'درصد پرداخت به مشتری باید بیشتر از صفر باشد.',
  template_not_found: 'قالب انتخاب‌شده پیدا نشد.',
  targets_must_increase: 'اهداف فروش باید مثبت و صعودی باشند.',
  template_values_invalid: 'مقادیر دستی قالب نامعتبر است.',
  invoice_financing_company_required: 'نام شرکت تأمین‌کنندهٔ مالی در بخش «نام شرکت پلتفرم» طرح ثبت نشده است. ابتدا آن را تکمیل کنید.',
  invoice_monthly_sequence_exhausted: 'شماره‌های ۰۰۱ تا ۹۹۹ این ماه تمام شده‌اند؛ صدور فاکتور جدید با این قالب شماره‌گذاری ممکن نیست.',
  provider_configuration: 'اتصال امضامی پیکربندی نشده است.',
  document_operation_failed: 'عملیات سند ناموفق بود.',
  invalid_bank_account: 'اطلاعات حساب بانکی کامل یا معتبر نیست.',
  bank_account_inactive: 'حساب بانکی طبق پاسخ استعلام غیرفعال است و امکان ثبت آن وجود ندارد.',
  wrong_payment_stage: 'این عملیات در مرحله فعلی دستور پرداخت مجاز نیست.',
  payment_already_recorded: 'پرداخت دیگری با اطلاعات متفاوت قبلاً ثبت شده است.',
  assigned_salesperson_required: 'فقط کارشناس فروش مسئول این مشتری مجاز به این عملیات است.',
  invalid_verification_request: 'شماره شبا/کارت یا کد ملی مشتری نامعتبر است.',
  invalid_bank_verification_response: 'پاسخ سرویس استعلام حساب معتبر نبود.',
  customer_changed_during_verification: 'اطلاعات مشتری هنگام استعلام تغییر کرد؛ دوباره تلاش کنید.',
  customer_not_found: 'مشتری پیدا نشد.',
  payment_order_not_found: 'دستور پرداخت پیدا نشد.',
  paid_at_in_future: 'تاریخ و ساعت واریز نمی‌تواند در آینده باشد.',
  invalid_payment_evidence: 'حساب مبدأ، کد پیگیری، تاریخ واریز یا رسید معتبر نیست.',
  payment_reference_already_used: 'این کد پیگیری قبلاً برای همین حساب مبدأ در دستور دیگری ثبت شده است.',
  payment_fund_opening_balance_required: 'برای این حساب مبدأ هنوز «موجودی اولیه» در بخش حسابداری ثبت نشده است. اول مدیر باید در «حسابداری» موجودی اولیهٔ همین صندوق را ثبت کند؛ بعد «پرداخت‌شده» را دوباره بزنید.',
  payment_recording_conflict: 'ثبت پرداخت با تغییر هم‌زمان برخورد کرد؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  customer_identity_changed: 'کد ملی مشتری بعد از تأیید فروش تغییر کرده است؛ تأیید فروش باید دوباره انجام شود.',
  invalid_receipt_upload: 'بارگذاری رسید ناموفق بود (حداکثر ۱۰ مگابایت، تصویر یا PDF).',
  admin_required: 'این کار فقط با مدیر سیستم ممکن است.',
  unpay_reason_required: 'دلیل را بنویس (حداقل ۵ حرف).',
  payment_revert_conflict: 'برگرداندن «پرداخت‌شده» با تغییر هم‌زمان برخورد کرد؛ صفحه را تازه کنید.',
  payout_exceeds_principal: 'درصد واریزی باید بین ۰ و ۱۰۰ باشد (مبلغ واریزی بیشتر از اصل تسهیلات نمی‌شود).',
  verified_customer_bank_account_required: 'یک حساب تأییدشدهٔ مشتری انتخاب کنید.',
};
export function translateError(code?: string) {
  if (!code) return '';
  if (code.startsWith('template_value_required:')) return `مقدار «${code.split(':')[1]}» برای قالب الزامی است.`;
  if (ERRORS[code]) return ERRORS[code];
  if (code.startsWith('provider_')) return `خطای سرویس امضامی (${code}).`;
  if (code.startsWith('invoice_')) return `خطای فاکتور (${code}).`;
  return code;
}
export const rawCode = (e: unknown) => (e instanceof ApiError ? e.code : '');

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T,>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b: unknown) => request<T>('PATCH', p, b),
  upload: <T,>(p: string, f: FormData) => request<T>('POST', p, f),
};

export function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) return (data as { items: T[] }).items;
  return [];
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'خطای نامشخص');

export async function openAuthedFile(path: string, print = false) {
  const res = await fetch(`/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    let msg = 'دریافت فایل ناموفق بود.';
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch { /* non-json */ }
    throw new ApiError(msg, res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const win = window.open(url, '_blank');
  if (print && win) win.addEventListener('load', () => win.print());
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Money: decimal integer toman strings
export const digitsOnly = (v: string) => v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9]/g, '');
export const toBig = (v?: string | number | null) => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };
export const toman = (v?: string | number | null) => `${toBig(v).toLocaleString('fa-IR')} تومان`;
export const faNum = (v?: string | number | null) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('fa-IR', { maximumFractionDigits: 2 }));

export type Me = { id: number; role: string; permissions: string[]; salespersonId?: number | null; fullName?: string | null };
export function useMe() {
  const q = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const u = q.data?.user as (Me & Record<string, unknown>) | undefined;
  const can = (p: string) => Boolean(u && (u.role === 'admin' || u.permissions?.includes(p)));
  return { user: u, can, isAdmin: u?.role === 'admin', loading: q.isLoading };
}

// ---------- types ----------
export type EligibleWallet = { customerId: number; customerName: string; customerSalespersonName?: string | null; planId: number; planName: string; balanceToman: string };
export type PurchaseItem = { id?: number; title: string; quantity: number | string; unitPriceToman: string; totalToman?: string };
export type PurchaseEvent = { action: string; actorUserId?: number | null; detail?: string | null; createdAt: string };
export type CommissionRow = { id: number; kind: string; amountToman: string; month?: string | null; createdAt: string; neutralized: boolean; salespersonId?: number; salespersonName?: string | null };
export type OrderCommission = {
  scope: 'all' | 'own' | 'status'; model: 'team' | 'legacy';
  status: 'legacy' | 'not_posted' | 'awaiting_payment' | 'posted' | 'failed' | 'before_start' | 'reversed';
  month?: string | null; revision: number; reversalMonth?: string | null; lastError?: string | null; rows: CommissionRow[];
  canRetry: boolean; canReturnCase: boolean; returnCaseMonth?: string | null;
};
export type GoodsDocument = { id: number; kind: string; version: number; status: string; providerStatus?: string | null; signed: boolean; pdfUrl?: string | null; error?: string | null; createdAt: string };
export type Purchase = {
  id: number; customerId: number; customerName: string; customerSalespersonName?: string | null; salespersonId?: number | null; planId: number; planName: string; stage: string;
  creditAmountToman: string; principalAmountToman?: string | null; payoutAmountToman?: string | null; developmentDiscountToman?: string | null; companyCreditToman?: string | null;
  basePayoutAmountToman?: string | null; feeDiscountToman?: string | null;
  invoiceTotalToman?: string | null; createdAt: string; completedAt?: string | null; dischargedAt?: string | null; items?: PurchaseItem[]; events?: PurchaseEvent[];
  acknowledgement_template_id?: number | null; invoice_version?: number | null; invoiceDocument?: GoodsDocument | null; acknowledgementDocument?: GoodsDocument | null;
};
export type BankAccount = { id: number; bankName?: string | null; ownerName?: string | null; fundName?: string | null; iban?: string | null; ownerType?: string | null; verifiedAt?: string | null; customerId?: number | null; accountingReady?: boolean };
export type PaymentOrderEvent = { action: string; actorId?: number | null; actorName?: string | null; createdAt: string; detail?: Record<string, unknown> | null };
export type PaymentOrder = {
  id: number; purchaseId: number; customerId: number; customerName?: string | null; customerSalespersonName?: string | null; salespersonId?: number | null; amountToman: string; stage: string;
  customerBankAccountId?: number | null; destinationIban?: string | null; destinationOwnerName?: string | null; sourceBankAccountId?: number | null;
  trackingNumber?: string | null; paidAt?: string | null; createdAt: string; updatedAt?: string | null; receiptUrl?: string | null; events?: PaymentOrderEvent[];
  basePayoutAmountToman?: string | null; feeDiscountToman?: string | null;
  principalAmountToman?: string | null; planPayoutBps?: number | null; planName?: string | null;
  commission?: OrderCommission; canUnpay?: boolean; paidReversals?: number;
  /** G5: paid before the GL start and included in the 2101 opening balance (list: boolean; detail: the prior-payment record). */
  preOpening?: boolean | PreOpening | null;
};
export type PreOpening = { paidDate: string; trackingNo: string | null; receiptFilename: string | null };
export type PlanFinanceSettings = { customerPayoutPercent: number | string | null; developmentDiscountPercent: number | string | null; acknowledgementTemplateId: number | null };
export type SalespersonSettings = { target1Toman: string; target2Toman: string; target3Toman: string; rate0Percent: number | string; rate1Percent: number | string; rate2Percent: number | string; rate3Percent: number | string };
export type CommissionTx = { id?: number; purchaseId?: number | null; amountToman: string; kind?: string; createdAt: string; month?: string | null; customerName?: string | null; customerId?: number | null; meta?: Record<string, unknown> | null; settingsVersionId?: number | null };
export type SalespersonSummary = {
  balanceToman: string; totalSalesToman: string; monthlySalesToman: string; month: string; transactions: CommissionTx[];
  kind?: string | null; breakdown?: Array<{ kind: string; count: number; totalToman: string }>; monthTotalToman?: string;
  stats?: { p1FirstCall: number; p1Upgrade: number; accuracyReviewed: number; accuracyCorrect: number; p1Received: number; reversedCases: number };
};

export const STAGES: { key: string; label: string; hint: string }[] = [
  { key: 'discharge_pending', label: 'تخلیه اعتبار', hint: 'تأیید تخلیه در پلتفرم بیرونی' },
  { key: 'invoice_draft', label: 'پیش‌فاکتور', hint: 'ثبت اقلام کالا به میزان کامل اعتبار' },
  { key: 'invoice_signature', label: 'امضای فاکتور', hint: 'ارسال و پیگیری در امضامی' },
  { key: 'settlement_pending', label: 'تسویه با شرکت', hint: 'مصرف اعتبار و ثبت تخفیف توسعه' },
  { key: 'acknowledgement_signature', label: 'رسید و اقرارنامه', hint: 'امضای اقرارنامه مشتری' },
  { key: 'registrar_confirmation', label: 'تأیید ثبت‌کننده', hint: 'بررسی نهایی و ثبت پورسانت' },
  { key: 'completed', label: 'تکمیل', hint: 'آماده صدور دستور پرداخت' },
];
export const stageLabel = (s?: string) => STAGES.find((x) => x.key === s)?.label ?? s ?? '—';
export const stageIndex = (s?: string) => Math.max(0, STAGES.findIndex((x) => x.key === s));

/** `label` = status chip / tab, `step` = stepper caption. */
export const PO_STAGES = [
  { key: 'sales_approval', label: 'منتظر تأیید فروش', step: 'تأیید فروش' },
  { key: 'admin_approval', label: 'منتظر تأیید مدیر', step: 'تأیید مدیریت' },
  { key: 'awaiting_payment', label: 'در انتظار علامت پرداخت', step: 'واریز' },
  { key: 'paid', label: 'پرداخت‌شده', step: 'پرداخت‌شده' },
];
export const poStageLabel = (s?: string) => PO_STAGES.find((x) => x.key === s)?.label ?? s ?? '—';

export const docStatusLabel = (s?: string | null) => ({ generated: 'تولیدشده', generating: 'در حال تولید', sending: 'در حال ارسال', sent: 'ارسال‌شده، در انتظار امضا', signed: 'امضاشده', rejected: 'ردشده', delivery_unknown: 'وضعیت ارسال نامشخص', failed: 'خطا', superseded: 'جایگزین‌شده' } as Record<string, string>)[s ?? ''] ?? (s || 'تولیدنشده');
export const ownerTypeLabel = (s?: string) => ({ company: 'شرکت', person: 'شخص', customer: 'مشتری' } as Record<string, string>)[s ?? ''] ?? s ?? '—';

const EVENT_LABELS: Record<string, string> = {
  created: 'رزرو کامل اعتبار کیف پول', external_discharge_confirmed: 'تأیید تخلیه در پلتفرم بیرونی', invoice_saved: 'ذخیره اقلام فاکتور',
  invoice_generated: 'تولید فاکتور', acknowledgement_generated: 'تولید رسید و اقرارنامه', settled: 'تسویه با شرکت', completed: 'تأیید ثبت‌کننده و تکمیل',
  sales_approved: 'تأیید فروش', admin_approved: 'تأیید مدیریت', paid: 'ثبت پرداخت', created_order: 'ایجاد دستور پرداخت',
  team_commission_posted: 'پورسانت ثبت شد', team_commission_reversed: 'برگشت پرونده · کسر پورسانت در ماه بعد', team_commission_unposted: '«پرداخت‌شده» برگشت · پورسانت خنثی شد',
  payment_recorded: '«پرداخت‌شده» ثبت شد', payment_reverted: '«پرداخت‌شده» برگشت (ثبت اشتباه)',
};
/** Payment-order history has its own vocabulary (its «created» is not the goods «reserve» event). */
const PO_EVENT_LABELS: Record<string, string> = {
  created: 'دستور پرداخت ساخته شد', sales_approved: 'تأیید فروش · حساب مقصد انتخاب شد', admin_approved: 'تأیید مدیریت',
  payment_recorded: '«پرداخت‌شده» ثبت شد', payment_reverted: '«پرداخت‌شده» برگشت (ثبت اشتباه)',
};
export const poEventLabel = (a?: string) => (a && PO_EVENT_LABELS[a]) || eventLabel(a);
export const eventLabel = (a?: string) => {
  if (!a) return '—';
  if (EVENT_LABELS[a]) return EVENT_LABELS[a];
  const m = a.match(/^(invoice|acknowledgement)_(pending|signed|rejected)$/);
  if (m) return `${m[1] === 'invoice' ? 'فاکتور' : 'اقرارنامه'}: ${({ pending: 'ارسال برای امضا', signed: 'امضا شد', rejected: 'رد شد' } as Record<string, string>)[m[2]]}`;
  return a;
};

// ---------- shared helpers for the goods / payment-order redesign ----------
export const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
/** Jalali 'YYYY/MM/DD' for a Tehran calendar day `daysAgo` days back. */
export function tehranJalaliValue(daysAgo = 0): string {
  const d = new Date(Date.now() + TEHRAN_OFFSET_MS - daysAgo * 86_400_000);
  const f = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  const v = Object.fromEntries(f.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return `${v.year}/${String(v.month).padStart(2, '0')}/${String(v.day).padStart(2, '0')}`;
}
export const tehranTimeNow = () => new Date(Date.now() + TEHRAN_OFFSET_MS).toISOString().slice(11, 16);
const PERSIAN_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
/** '1405-08' → 'آبان ۱۴۰۵' */
export const monthLabel = (m?: string | null) => {
  const x = /^(\d{4})-(\d{2})$/.exec(m ?? '');
  return x ? `${PERSIAN_MONTHS[Number(x[2]) - 1]} ${Number(x[1]).toLocaleString('fa-IR', { useGrouping: false })}` : '—';
};
/** Short Tehran date like '۲ آبان' (+ time). */
export function shortFaDate(iso?: string | null, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const o: Intl.DateTimeFormatOptions = { calendar: 'persian', day: 'numeric', month: 'long', timeZone: 'Asia/Tehran', ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) };
  return new Intl.DateTimeFormat('fa-IR', o).format(d);
}
/** Integer percent string (≤2 decimals) of a/b, e.g. 78 or 78.5. */
export function percentOf(a?: string | null, b?: string | null): number | null {
  const x = toBig(a), y = toBig(b);
  if (y <= 0n) return null;
  return Number((x * 10000n) / y) / 100;
}
export const faPercent = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('fa-IR', { maximumFractionDigits: 2 })}٪`);
