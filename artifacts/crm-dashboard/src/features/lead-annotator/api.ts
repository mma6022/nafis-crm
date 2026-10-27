/** lead_annotator client (PM 2026-10-27 22:37). Server: artifacts/api-server/src/routes/lead-annotator.ts — every response is phone-masked server-side. */
import { useQuery } from '@tanstack/react-query';

export type LaCard = { id: number; name: string; phoneMasked: string; isUrgent: boolean };
export type LaNote = { id: number; body: string; label: string; actorLabel: string; createdAt: string };
export type LaUrgent = { isUrgent: boolean; actorLabel: string | null; reason: string | null; createdAt: string };
export type LaDetail = LaCard & { annotations: LaNote[]; urgentHistory: LaUrgent[] };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const MSG: Record<string, string> = {
  query_too_short: 'دست‌کم دو حرف از نام، شماره‌ی کامل موبایل یا شماره‌ی پرونده را بنویسید.',
  rate_limited: 'جست‌وجوی زیاد؛ چند دقیقه بعد دوباره امتحان کنید.',
  reason_required: 'دلیل «مشتری فوری» را انتخاب کنید.',
  other_text_required: 'برای «سایر» توضیح بنویسید (دست‌کم ۳ حرف).',
  bad_reason_code: 'دلیل انتخاب‌شده معتبر نیست.',
  bad_note: 'متن یادداشت خالی یا بیش از حد بلند است.',
  lead_annotator_only: 'این بخش برای شما فعال نیست.',
};
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (body as { error?: string }).error; throw new Error((e && MSG[e]) || (r.status === 404 ? 'پرونده پیدا نشد.' : `خطا (${r.status})`)); }
  return body as T;
}
export type UrgentReasonOpt = { code: string; label: string };
export const DEFAULT_URGENT_REASONS: UrgentReasonOpt[] = [
  { code: 'no_callback', label: 'شاکیه کسی زنگ نزده' }, { code: 'urgent_call', label: 'درخواست تماس فوری' }, { code: 'other', label: 'سایر' }];
export type UrgentReasonValue = { reasonCode?: string; reasonText?: string; reason?: string };
export type LaCase = { id: number; name: string; isUrgent: boolean; annotations: LaNote[]; urgentHistory: LaUrgent[]; urgentReasons: UrgentReasonOpt[]; noteLabel: string };
export const laCase = (id: number) => req<LaCase>(`/lead-annotator/customers/${id}/case`);
export const LA_ME_KEY = ['lead-annotator', 'me'];
export function useLeadAnnotatorMe(enabled = true) {
  return useQuery({ queryKey: LA_ME_KEY, enabled, staleTime: 60_000, retry: false,
    queryFn: () => req<{ enabled: boolean; noteLabel: string; urgentReasons?: UrgentReasonOpt[] }>('/lead-annotator/me').catch(() => ({ enabled: false, noteLabel: 'اینستاگرام', urgentReasons: undefined as UrgentReasonOpt[] | undefined })) });
}
export const laSearch = (q: string) => req<{ items: LaCard[] }>(`/lead-annotator/customers?q=${encodeURIComponent(q)}`);
export const laDetail = (id: number) => req<LaDetail>(`/lead-annotator/customers/${id}`);
export const laNote = (id: number, body: string) => req<LaNote>(`/lead-annotator/customers/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
export const laUrgent = (id: number, isUrgent: boolean, reason: UrgentReasonValue) =>
  req<{ id: number; isUrgent: boolean; changed: boolean }>(`/lead-annotator/customers/${id}/urgent`, { method: 'POST', body: JSON.stringify({ isUrgent, ...reason }) });
export const customerAnnotations = (id: number) => req<{ items: LaNote[] }>(`/customers/${id}/annotations`);
export const faDate = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
