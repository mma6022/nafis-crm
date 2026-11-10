/* bale v1.1 «گفتگوی بله داخل پنل کارشناس» — client for /api/bale-bot (api-server routes/bale-bot.ts).
   While flag.bale_bot (or the user's own flag) is OFF the server answers 404/403 → everything here stays hidden and nothing polls.
   No token ever comes back from the server; the wizard's token field is only sent once, to /admin/test and /admin/bots. */
import { useQuery } from '@tanstack/react-query';

export type BbLimits = { textMax: number; textWarn?: number; inBytes?: number; photoBytes: number; fileBytes: number; voiceBytes: number; deleteHours: number };
export type BbBot = { id: number; username: string | null; name: string | null; status: 'on' | 'off' | 'err'; connectedAt: string | null; lastOkAt: string | null; lastError: string | null; hasToken: boolean } | null;
export type BbCustomerBotFlags = { tracking: boolean; ai: boolean; filing: boolean; any: boolean; admin?: boolean };
export type BbCustomerBot = {
  restricted?: boolean; flags?: BbCustomerBotFlags;
  filing?: { id: number; step: number; stepTitle: string; stepLine: string; waitKind: string | null; waitTitle: string | null; planLabel: string | null; applicationId: number | null; contractStatus: string | null } | null;
  handoff?: { id: number; question: string; answer: string; reason: string; claimedBy: number | null; at: string } | null;
  tasks?: { id: number; kind: string; status: string; detail: string | null; created_at: string; application_id: number | null }[];
} | null;
export type BbMe = { enabled: boolean; view: 'own' | 'all'; canManage: boolean; name: string; bot: BbBot; unread: number; limits: BbLimits; contactFeature?: boolean; customerBot?: BbCustomerBotFlags };
export type BbCustomer = { id: number; name: string; phone: string | null; status: string | null; salespersonId: number | null; expert: string | null; restricted: boolean; canOpen: boolean } | null;
export type BbNotice = { id: number; kind: string; at: string; actor: string | null };
export type BbChat = {
  id: number; name: string; firstName: string | null; lastName: string | null; username: string | null; bio: string | null; unread: number; lastAt: string | null; lastPreview: string | null; lastOut: boolean;
  customer: BbCustomer; linkMethod: string | null; otherExpert: boolean; notices: BbNotice[]; lastByManager: boolean; verifiedPhone: string | null; phoneVerified: boolean | null;
  contactAskedAt: string | null; matchNote: string | null; expert: { id: number; name: string | null }; bot: { username: string | null; status: string; shared?: boolean; displayName?: string | null }; canWrite: boolean; sendBlocked: 'no_send' | 'bot_off' | null; mine: boolean;
  contactFeature?: boolean; pendingTypedPhone?: string | null; pendingTypedAt?: string | null; linkSource?: string | null; sourceLine?: string | null; linkActor?: string | null;
  leadFromBale?: boolean; canApproveTyped?: boolean; canRejectTyped?: boolean; canManualEnter?: boolean; canResendAsk?: boolean;
  typedMatch?: { id: number; name: string; status: string | null; expert: string | null; own?: boolean } | null; waitingNumber?: boolean;
  customerBot?: BbCustomerBot;
  sharedCustomerBot?: boolean; sourceChip?: string | null; waitingAssignment?: boolean; assignedExpertName?: string | null;
  routedExisting?: boolean; listTag?: string | null;
};

export type BbMessage = {
  id: number; dir: 'in' | 'out' | 'sys'; kind: string; text: string | null; at: string; editedAt: string | null; deleted: boolean;
  file: { name: string | null; mime: string | null; size: number | null; duration: number | null; state: string; url: string | null } | null;
  contact: { phone: string | null; name: string | null; own: boolean; hidden?: boolean } | null; location: { lat: number; lng: number } | null; replyTo: number | null; askContact: boolean;
  status: 'sending' | 'sent' | 'failed' | 'wait' | null; errorCode: string | null; author: string | null; canEdit: boolean; canDelete: boolean; deleteExpired: boolean;
};
export type BbChats = { counts: { all: number; unread: number; unlinked: number; pending?: number; typedPending?: number }; chats: BbChat[]; experts: { id: number; name: string }[] };
export type BbAdminExpert = { id: number; name: string; salespersonId: number | null; flagOn: boolean; bot: BbBot; noSend: boolean };

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const bbUrl = (p: string) => `${base()}/api${p}`;
export class BbError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export const BB_ERR: Record<string, string> = {
  not_found: 'پیدا نشد.', forbidden: 'دسترسی ندارید.', not_enabled: 'این بخش برای شما روشن نیست.', bad_text: 'متن پیام خالی یا بلندتر از ۴۰۹۶ نویسه است.',
  no_send: 'ارسال از این ربات فعلاً بسته است.', bot_off: 'ربات قطع است؛ تا وصل شدن دوباره پیامی فرستاده نمی‌شود.', photo_too_big: 'عکس بیشتر از ۱۰ مگابایت است.', file_too_big: 'فایل بیشتر از ۵۰ مگابایت است؛ فایل کوچک‌تری انتخاب کنید.',
  bad_file: 'فایل خالی است.', not_editable: 'این پیام قابل تغییر نیست.', delete_expired: 'حذف فقط تا ۴۸ ساعت بعد از ارسال ممکن است.', network: 'به بله وصل نشد؛ کمی بعد دوباره امتحان کنید.', bale_error: 'بله این کار را انجام نداد.',
  already_linked: 'این گفتگو قبلاً به پرونده وصل شده است.', no_phone: 'شماره‌ی موبایل لازم است؛ ۱۱ رقم که با ۰۹ شروع شود.', bad_phone: 'شماره‌ی موبایل لازم است؛ ۱۱ رقم که با ۰۹ شروع شود.', bad_name: 'نام را بنویسید.',
  phone_other: 'این شماره قبلاً برای مشتری یک کارشناس دیگر ثبت شده است؛ سرنخ تکراری ساخته نمی‌شود.',
  flag_off: 'این قابلیت فعلاً خاموش است.', no_pending: 'شماره‌ی تایپی در انتظار تأیید نیست.', rate_limited: 'لطفاً کمی صبر کنید و دوباره درخواست شماره را بفرستید.', batch_disabled: 'ارسال یک‌باره به مشتریان فعلی خاموش است.', bad_token: 'بله این توکن را نشناخت.', key_missing: 'کلید رمزنگاری روی سرور نیست؛ با مدیر فنی هماهنگ کنید.',
  has_bot: 'این کارشناس ربات وصل دارد؛ از فهرست «تعویض توکن» را بزنید.', bot_in_use: 'این ربات برای کارشناس دیگری وصل است.', not_expert: 'این کاربر کارشناس فروش نیست.', unknown: 'درخواست انجام نشد. دوباره تلاش کنید.',
};
export async function bbFetch<T>(path: string, init?: { method?: string; body?: unknown; raw?: Blob | File; headers?: Record<string, string> }): Promise<T> {
  const r = await fetch(bbUrl(path), {
    method: init?.method ?? (init?.body !== undefined || init?.raw ? 'POST' : 'GET'), credentials: 'include',
    headers: init?.raw ? init.headers : init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const code = (data as any).error as string | undefined; const serverMsg = typeof (data as any).message === 'string' ? (data as any).message.trim() : ''; throw new BbError(serverMsg || (BB_ERR[code ?? ''] ?? BB_ERR.unknown), r.status, code); }
  return data as T;
}
/** null while OFF (404) or not enabled for this user. Never retries, so an OFF flag costs one request per minute at most. */
export function useBaleBotMe(enabled = true) {
  return useQuery<BbMe | null>({
    queryKey: ['bale-bot-me'], enabled, retry: false, staleTime: 30_000, refetchInterval: (q) => (q.state.data ? 30_000 : false),
    queryFn: async () => { const r = await fetch(bbUrl('/bale-bot/me'), { credentials: 'include' }); if (!r.ok) return null; const d = (await r.json()) as BbMe; return d?.enabled ? d : null; },
  });
}

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
export const fa = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '٬').replace(/[0-9]/g, (d) => FD[Number(d)]);
const TZ = 'Asia/Tehran';
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });
export const bbTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fa-IR', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
export function bbListTime(iso: string | null) {
  if (!iso) return ''; const d = new Date(iso), now = new Date();
  if (dayKey(d) === dayKey(now)) return bbTime(iso);
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return 'دیروز';
  return d.toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: TZ });
}
export function bbDay(iso: string) {
  const d = new Date(iso), now = new Date(); const full = d.toLocaleDateString('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  if (dayKey(d) === dayKey(now)) return `امروز، ${full}`;
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return 'دیروز';
  return full;
}
export const bbDayKey = (iso: string) => dayKey(new Date(iso));
export function bbSize(b: number | null | undefined) {
  if (!b) return ''; if (b < 1024 * 1024) return `${fa(Math.max(1, Math.round(b / 1024)))} کیلوبایت`;
  return `${(b / 1048576).toFixed(1).replace('.', '٫').replace(/[0-9]/g, (d) => FD[Number(d)])} مگابایت`;
}
export const bbDur = (s: number | null | undefined) => (s == null ? '' : fd(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`));
/** Persian/Arabic digits → ASCII; the server normalises again (normPhone). */
export const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FD.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
export const PHONE_OK = (s: string) => /^09\d{9}$/.test(toLatin(s).replace(/[\s-]/g, ''));
