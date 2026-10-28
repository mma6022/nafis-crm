/** incoming2-59: the regular «ثبت تماس جدید» dialog shows the server's own Persian message (or one mapped from the error code)
 *  instead of the generic text. Pure function; the dialog's behaviour is otherwise unchanged. */
export const CALL_ERROR_GENERIC = 'ثبت تماس با خطا مواجه شد. لطفاً دوباره تلاش کنید.';
const FA = /[\u0600-\u06FF]/;
const BY_CODE: Record<string, string> = {
  plan_item_required: 'برای این مشتری یک کار باز در «کارهای امروز» هست؛ تماس را از همان کارت ثبت کن.',
  not_current_item: 'این کار، کار فعلی «کارهای امروز» نیست؛ اول کار فعلی را تمام کن.',
  outcome_required: 'نتیجه‌ی تماس را انتخاب کن.',
  note_required: 'یادداشت یک‌خطی را بنویس.',
  call_pending: 'اول گزارش تماس باز قبلی را ثبت کن.',
  expert_lockdown: 'این بخش فعلاً برای شما بسته است.',
  expert_lockdown_customer: 'این مشتری فعلاً برای شما باز نیست.',
  forbidden: 'اجازه‌ی ثبت تماس برای این مشتری را نداری.',
  customer_not_owned: 'این مشتری در پرونده‌های شما نیست.',
  not_found: 'مشتری پیدا نشد.',
  unauthorized: 'نشست شما تمام شده؛ دوباره وارد شو.',
  rate_limited: 'درخواست‌ها زیاد شد؛ کمی بعد دوباره امتحان کن.',
};
const BY_STATUS: Record<number, string> = { 401: BY_CODE.unauthorized, 403: BY_CODE.forbidden, 404: BY_CODE.not_found, 429: BY_CODE.rate_limited };
export function callErrorMessage(e: unknown): string {
  if (!e || typeof e !== 'object') return CALL_ERROR_GENERIC;
  const any = e as { data?: unknown; status?: unknown };
  const d = (any.data && typeof any.data === 'object' ? any.data : null) as { message?: unknown; error?: unknown } | null;
  if (d && typeof d.message === 'string' && FA.test(d.message)) return d.message.trim();
  if (d && typeof d.error === 'string') {
    if (FA.test(d.error)) return d.error.trim();
    if (BY_CODE[d.error]) return BY_CODE[d.error];
  }
  if (typeof any.status === 'number' && BY_STATUS[any.status]) return BY_STATUS[any.status];
  return CALL_ERROR_GENERIC;
}
