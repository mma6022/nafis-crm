/** customer-name-edit client (flag.customer_name_edit). Hidden and rejected while the flag is OFF. */

export type CneView = {
  flagOn: true;
  canEdit: boolean;
  identityVerified: boolean;
  identity_verified: boolean;
  showVerifiedBadge: boolean;
  firstName: string;
  lastName: string;
  name: string;
};

export type CneSave = {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  unchanged: boolean;
  identityVerified: boolean;
};

export const CNE_FA_RE = /^[\u0621-\u0628\u062A-\u063A\u0641\u0642\u0644-\u0648\u064A\u067E\u0686\u0698\u06A9\u06AF\u06CC\u200C ]+$/;
export const CNE_REQUIRED = 'این فیلد لازم است.';
export const CNE_INVALID_FA = 'فقط حروف فارسی وارد کنید.';
export const CNE_NOCHANGE = 'تغییری ایجاد نشده';
export const CNE_SAVED = 'نام مشتری ذخیره شد.';
export const CNE_SERVER = 'نام ذخیره نشد. دوباره امتحان کنید.';
export const CNE_VERIFIED_HINT = 'نام از احراز هویت آمده و قابل ویرایش نیست.';

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function cneNormalizePart(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.replace(/\u200C{2,}/g, '\u200C').replace(/[^\S\u200C]+/g, ' ').trim();
  if (!value) return { ok: false, message: CNE_REQUIRED };
  if (value.length < 2 || value.length > 30 || !CNE_FA_RE.test(value)) return { ok: false, message: CNE_INVALID_FA };
  return { ok: true, value };
}

export function cneHistorySentence(oldName: string, newName: string): string {
  return `نام از «${oldName}» به «${newName}» تغییر کرد`;
}

export function cneWhen(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(d).replace(/^0(\d)/, '$1').replace(/[0-9]/g, (n) => '۰۱۲۳۴۵۶۷۸۹'[Number(n)]!);
  return `${day}، ${hm}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string; message: string; field?: string }> {
  let response: Response;
  try {
    response = await fetch(`${base()}/api${path}`, { credentials: 'include', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) } });
  } catch {
    return { ok: false, status: 0, message: CNE_SERVER };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message) ? body.message
      : response.status === 404 ? (body?.error === 'customer_name_edit_off' ? '' : 'مشتری پیدا نشد.')
      : response.status === 403 ? 'اجازه ویرایش نام این مشتری را ندارید.'
      : response.status === 409 ? CNE_VERIFIED_HINT
      : CNE_SERVER;
    return { ok: false, status: response.status, error: typeof body?.error === 'string' ? body.error : undefined, message, field: typeof body?.field === 'string' ? body.field : undefined };
  }
  return { ok: true, data: body as T };
}

export const fetchCneView = (id: number) => req<CneView>(`/customers/${id}/name-edit`);
export const patchCneName = (id: number, firstName: string, lastName: string) =>
  req<CneSave>(`/customers/${id}/name`, { method: 'PATCH', body: JSON.stringify({ firstName, lastName }) });
