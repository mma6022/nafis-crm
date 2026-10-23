import { api } from '@/lib/goods-api';

export type CallbackStatus = 'new' | 'in_progress' | 'called' | 'no_answer' | 'cancelled';
export type CallbackItem = {
  id: number; trackingCode: string | null; name: string; phone: string;
  preferredTime: 'now' | 'morning' | 'evening'; topic: 'cash' | 'goods' | 'unsure' | null; src: string | null;
  status: CallbackStatus; attempts: number; lastAttemptAt: string | null;
  assignedUserId: number | null; assignedUserName: string | null; notes: string | null;
  customerId: number | null; customerName: string | null; convertedAt: string | null; createdAt: string; updatedAt: string;
};
export type CallbackEvent = { id: number; action: string; fromValue: string | null; toValue: string | null; userName: string | null; createdAt: string };
export type CallbackCounts = { new: number; open: number; closed: number };

export const CALLBACK_STATUS_FA: Record<CallbackStatus, string> = {
  new: 'جدید', in_progress: 'در حال پیگیری', called: 'تماس گرفته شد', no_answer: 'پاسخ نداد', cancelled: 'لغو',
};
export const PREFERRED_TIME_FA = { now: 'همین الان', morning: 'صبح', evening: 'عصر' } as const;
export const TOPIC_FA = { cash: 'وام نقدی', goods: 'خرید کالا', unsure: 'نمی‌داند' } as const;
/** Mirrors the server (lib/callback-requests.ts CALLBACK_TRANSITIONS). */
export const CALLBACK_TRANSITIONS: Record<CallbackStatus, CallbackStatus[]> = {
  new: ['in_progress', 'called', 'no_answer', 'cancelled'],
  in_progress: ['called', 'no_answer', 'cancelled'],
  no_answer: ['in_progress', 'called', 'no_answer', 'cancelled'],
  called: ['in_progress'],
  cancelled: ['in_progress'],
};

export const callbacksApi = {
  list: (view: 'open' | 'closed') => api.get<{ items: CallbackItem[]; counts: CallbackCounts }>(`/callback-requests?view=${view}`),
  badge: () => api.get<{ new: number }>('/callback-requests/badge'),
  assignees: () => api.get<{ items: { id: number; name: string }[] }>('/callback-requests/assignees'),
  detail: (id: number) => api.get<{ item: CallbackItem; events: CallbackEvent[] }>(`/callback-requests/${id}`),
  status: (id: number, status: CallbackStatus) => api.patch<{ item: CallbackItem }>(`/callback-requests/${id}/status`, { status }),
  assign: (id: number, userId: number | null) => api.patch<{ item: CallbackItem }>(`/callback-requests/${id}/assign`, { userId }),
  notes: (id: number, notes: string) => api.patch<{ item: CallbackItem }>(`/callback-requests/${id}/notes`, { notes }),
  convert: (id: number) => api.post<{ item: CallbackItem; created: boolean }>(`/callback-requests/${id}/convert`),
};
