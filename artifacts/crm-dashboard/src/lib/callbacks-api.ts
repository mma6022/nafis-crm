import { api } from '@/lib/goods-api';

export type CallbackStatus = 'new' | 'in_progress' | 'called' | 'no_answer' | 'cancelled';
export type CancelReason = 'duplicate' | 'wrong_number' | 'changed_mind' | 'other';
export type ContactTime = 'now' | 'morning' | 'evening';
export type CallbackNeed = 'cash' | 'goods' | 'help';
export type CallbackItem = {
  id: number; trackingCode: string | null; name: string;
  /** null when the viewer may not see customer phones (customers.view); use phoneMasked. */
  phone: string | null; phoneMasked: string;
  contactTime: ContactTime; need: CallbackNeed | null; planId: number | null; planName: string | null; src: string | null;
  status: CallbackStatus; cancelReason: CancelReason | null;
  attempts: number; lastAttemptAt: string | null; canRetry: boolean; nextAttemptAt: string | null; suggestCancel: boolean; late: boolean;
  assignedUserId: number | null; assignedUserName: string | null; notesCount: number;
  customerId: number | null; customerName: string | null; convertedAt: string | null;
  createdAt: string; updatedAt: string; lastActivityAt: string;
};
export type CallbackEvent = {
  id: number; action: 'status' | 'assign' | 'note' | 'reveal' | 'call' | 'convert' | 'notify';
  fromValue: string | null; toValue: string | null; userId: number | null; userName: string | null; createdAt: string;
};
export type CallbackCounts = Record<CallbackStatus | 'all', number>;
export type CallbackMeta = {
  slaMinutes: number; maxAttempts: number; minAttemptGapMinutes: number;
  canManage: boolean; canAssign: boolean; canSeePhone: boolean; canConvert: boolean; me: number;
};
export type CallbackTab = CallbackStatus | 'all';
export type CallbackWho = 'all' | 'me' | 'none';

export const CALLBACK_STATUS_FA: Record<CallbackStatus, string> = {
  new: 'جدید', in_progress: 'در حال پیگیری', called: 'تماس گرفته شد', no_answer: 'پاسخ نداد', cancelled: 'لغو',
};
export const STATUS_ORDER: CallbackStatus[] = ['new', 'in_progress', 'called', 'no_answer', 'cancelled'];
export const CONTACT_TIME_FA: Record<ContactTime, string> = { now: 'همین الان', morning: 'صبح', evening: 'عصر' };
export const NEED_FA: Record<CallbackNeed, string> = { cash: 'وام نقدی', goods: 'خرید کالا', help: 'نمی‌داند' };
export const CANCEL_REASON_FA: Record<CancelReason, string> = {
  duplicate: 'درخواست تکراری', wrong_number: 'شماره اشتباه', changed_mind: 'منصرف شد', other: 'سایر',
};
/** data-src values the site sends (CALLBACK-HANDOFF.md). Unknown values are shown as-is. */
export const SRC_FA: Record<string, string> = {
  'home-callback': 'صفحه اصلی · بخش درخواست تماس',
  'finder-result': 'صفحه اصلی · زیر نتیجه طرح‌یاب',
  'vam-fori-callback': 'وام فوری · پایین صفحه',
  'vam-fori-header': 'وام فوری · دکمه بالای صفحه',
  'contact-callback': 'تماس با ما',
  'kharid-aghsati-callback': 'خرید اقساطی · پایین صفحه',
};
export const srcLabel = (src: string | null) => (src ? SRC_FA[src] ?? src : 'نامشخص');
/** Mirrors the server (lib/callback-requests.ts CALLBACK_TRANSITIONS). */
export const CALLBACK_TRANSITIONS: Record<CallbackStatus, CallbackStatus[]> = {
  new: ['in_progress', 'called', 'no_answer', 'cancelled'],
  in_progress: ['called', 'no_answer', 'cancelled'],
  no_answer: ['in_progress', 'called', 'no_answer', 'cancelled'],
  called: ['in_progress'],
  cancelled: ['in_progress'],
};

type One = { item: CallbackItem; events: CallbackEvent[] };
export const callbacksApi = {
  list: (status: CallbackTab, who: CallbackWho, q = '') =>
    api.get<{ items: CallbackItem[]; counts: CallbackCounts; meta: CallbackMeta }>(
      `/callback-requests?status=${status}&who=${who}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`),
  badge: () => api.get<{ new: number }>('/callback-requests/badge'),
  assignees: () => api.get<{ items: { id: number; name: string }[] }>('/callback-requests/assignees'),
  detail: (id: number) => api.get<One>(`/callback-requests/${id}`),
  status: (id: number, status: CallbackStatus, cancelReason?: CancelReason) =>
    api.patch<One>(`/callback-requests/${id}/status`, { status, ...(cancelReason ? { cancelReason } : {}) }),
  assign: (id: number, userId: number | null) => api.patch<One>(`/callback-requests/${id}/assign`, { userId }),
  note: (id: number, text: string) => api.post<One>(`/callback-requests/${id}/notes`, { text }),
  reveal: (id: number) => api.post<One & { phone: string }>(`/callback-requests/${id}/reveal`),
  call: (id: number) => api.post<One & { phone: string }>(`/callback-requests/${id}/call`),
  convert: (id: number) => api.post<One & { created: boolean }>(`/callback-requests/${id}/convert`),
};
