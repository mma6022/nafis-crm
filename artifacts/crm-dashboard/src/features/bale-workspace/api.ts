/* «فضای کار بله» v1.0 — client for /api/bale-workspace (api-server routes/bale-workspace.ts). Design: nafis-design/mockups/bale-workspace.
   flag.bale_workspace_v1 OFF → /me answers 404 → useBwsMe() = null → nothing here renders and nothing else polls. */
import { useQuery } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
import { formatMobileGrouped } from '@/lib/phone';

export type BwsMe = { on: true; userId: number; canManage: boolean; inbox: 'all' | 'own' | null; isExpert: boolean; noBaleText: string };
export type BwsInvite = { id: number; at: string; bale: 'queued' | 'sent' | 'no_bale' | 'not_connected' | 'blocked' | 'failed'; sms: 'sent' | 'failed' | 'not_configured' | 'disabled'; by: string | null; error: string | null; line: string | null };
export type BwsTraining = { id: number; title: string; kind: 'file' | 'video' | 'link'; url: string; fileName: string | null; size: number | null; audience: 'customer' | 'expert'; planScope: 'all' | 'selected'; planIds: number[]; plansLabel: string; active: boolean; at: string };
export type BwsContext = {
  restricted: false;
  customer: { id: number; name: string; phone: string | null; nationalCode: string | null; expert: string | null };
  stars: number;
  dossier: { job: string | null; purpose: string | null; amountToman: number | null; guarantor: string | null; bounced: boolean | null; fromSite: boolean } | null;
  credit: { grade: string | null; panel: boolean; lastAt?: string | null; valid?: boolean; colour?: string | null; colourCode?: number | string | null; bounced?: number | null; debtRial?: number | null };
  cases: { id: number; plan: string | null; status: string | null; stage: string | null; amount: number | null; at: string }[];
  calls: { id: number; at: string; result: string | null; note: string | null; by: string | null }[];
  explained: { planId: number; name: string; at: string; by: string | null; messageId: number | null }[];
  invites: BwsInvite[];
} | { restricted: true; customer: { id: number; name: string; expert: string | null } };
export type BwsAssets = { quick: { id: string; title: string }[]; plans: { id: number; name: string }[]; training: BwsTraining[]; customerTraining: BwsTraining[]; canManage: boolean };
export type BwsChatCtx = { chatId: number; canSend: boolean; context: BwsContext | null; assets: BwsAssets };
export type Audience = { who: 'messaged' | 'linked' | 'all'; stars: number[] | null; experts: number[] | null };
export type Scenario = { id: number; name: string; kind: 'auto' | 'noreply' | 'bulk'; audience: Audience; cond: { hours?: number } | null; body: string; trainingFileId: number | null;
  status: 'draft' | 'active' | 'paused' | 'done'; recipients: number | null; confirmedAt: string | null; sent: number; createdBy: string | null };
export type AdminState = { inviteText: string; inviteDefault: string; smsPattern: string; autoOn: boolean; plans: { id: number; name: string; terms: string }[];
  scenarios: Scenario[]; training: BwsTraining[]; experts: { id: number; name: string }[]; sendHours: null; smsPatternText: string; smsPatternVars: { token: string; ippanel: string; source: string }[] };

export function useBwsMe(enabled = true) {
  return useQuery<BwsMe | null>({
    queryKey: ['bws-me'], enabled, retry: false, staleTime: 60_000, refetchOnWindowFocus: false,
    queryFn: async () => { try { const d = await bbFetch<BwsMe>('/bale-workspace/me'); return d?.on ? d : null; } catch { return null; } },
  });
}
export function useChatCtx(chatId: number | null, on: boolean) {
  return useQuery<BwsChatCtx>({ queryKey: ['bws-ctx', chatId], enabled: on && chatId != null, retry: false, staleTime: 10_000, refetchInterval: 30_000,
    queryFn: () => bbFetch<BwsChatCtx>(`/bale-workspace/chats/${chatId}/context`) });
}
export const KIND_FA: Record<Scenario['kind'], string> = { auto: 'خودکار', noreply: 'بی‌پاسخ', bulk: 'انبوه' };
export const WHO_FA: Record<Audience['who'], string> = { messaged: 'کسانی که به ما پیام داده‌اند', linked: 'گفتگوهای وصل به پرونده', all: 'همهٔ گفتگوها' };
export const STATUS_FA: Record<Scenario['status'], string> = { draft: 'پیش‌نویس', active: 'فعال', paused: 'متوقف', done: 'تمام‌شده' };
const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
export const faNum = (n: number) => fd(String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
export const toman = (rial: number | null | undefined) => (rial == null ? '—' : `${faNum(rial / 10)} تومان`);
export function jDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' });
  return withTime ? `${day}، ${d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' })}` : day;
}
/** «۰۹۱۲ ۸۰۶ ۴۱۵۰» — full number, grouped, always LTR. */
export const phoneFa = (p: string | null | undefined) => formatMobileGrouped(String(p ?? ''));
const ERR: Record<string, string> = {
  not_linked: 'این گفتگو هنوز به پرونده وصل نیست.', no_plans: 'طرحی با شرایط ثبت‌شده انتخاب نشده است.', no_send: 'ارسال از این ربات بسته است.',
  rate_limited: 'دعوت همین الان فرستاده شد؛ یک دقیقه بعد دوباره امتحان کنید.', no_phone: 'شماره‌ی موبایل مشتری ثبت نشده است.',
  not_customer_file: 'این فایل فقط برای کارشناس است.', count_changed: 'تعداد گیرنده‌ها عوض شد؛ دوباره بررسی و تأیید کنید.', not_draft: 'این سناریو قبلاً تأیید شده است.',
  bad_hours: 'ساعت انتظار باید بین ۱ تا ۷۲۰ باشد.', bad_kind: 'نوع سناریو را انتخاب کنید.', bad_name: 'نام را بنویسید.', bad_file: 'فایل انتخاب‌شده معتبر نیست.',
  bad_type: 'فقط PDF، عکس (JPG/PNG) یا ویدیو MP4.', bad_url: 'لینک باید با https شروع شود.', file_too_big: 'فایل بیشتر از ۵۰ مگابایت است.', bad_text: 'متن خالی یا خیلی بلند است.',
  forbidden: 'دسترسی ندارید.', not_found: 'پیدا نشد.',
};
export const bwsErr = (e: unknown) => { const c = (e as { code?: string })?.code; return (c && ERR[c]) || (e instanceof Error ? e.message : 'درخواست انجام نشد. دوباره تلاش کنید.'); };
