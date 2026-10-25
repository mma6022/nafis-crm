export type SiteNotification = { id: number; kind: string; title: string; body: string; customerId: number; customerName: string; target: string; page?: string; createdAt: string; readAt: string | null;
  /** Manager «اجازه‌ی استعلام» row (kind credit-permission): inline decide while the request is still open. */
  action?: { type: 'credit-permission'; jobId: number; status: string | null; open: boolean };
  /** «دستیار هوشمند» row (kind assistant-message): addressed to this user only; opens the assistant's chat. */
  assistant?: { slug: string; threadId: number; name: string } | null };
export type SiteNotificationPage = { items: SiteNotification[]; unreadCount: number; latestId: number; scopeVersion: string; nextCursor: string | null; pageCounts?: Record<string, number> };
export type NotificationUser = { id: number; role: string; permissions?: string[] } | null | undefined;

export class NotificationApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const base = () => import.meta.env.BASE_URL.replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}/api/site-notifications${path}`, {
      credentials: 'include',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch { throw new NotificationApiError('ارتباط با سامانه برقرار نشد.', 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message) ? body.message
      : response.status === 401 ? 'نشست شما پایان یافته است.'
      : 'دریافت اعلان‌ها ناموفق بود.';
    throw new NotificationApiError(message, response.status);
  }
  return body as T;
}

export const fetchNotifications = (opts: { beforeId?: string | null; limit?: number; unreadOnly?: boolean; page?: string | null } = {}) => {
  const p = new URLSearchParams({ limit: String(opts.limit ?? 30), unreadOnly: String(!!opts.unreadOnly) });
  if (opts.beforeId) p.set('beforeId', opts.beforeId);
  if (opts.page) p.set('page', opts.page);
  return request<SiteNotificationPage>(`?${p.toString()}`);
};
export const markNotificationRead = (id: number) => request<{ ok: true; target: string }>(`/${id}/read`, { method: 'POST', body: '{}' });
export const markAllNotificationsRead = (throughId: number, page?: string | null) => request<{ ok: true }>('/read-all', { method: 'POST', body: JSON.stringify(page ? { throughId, page } : { throughId }) });

/** Accept only same-origin app-relative paths. */
export function safeTarget(target: string | null | undefined): string | null {
  if (!target || typeof target !== 'string') return null;
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u001f]/.test(target)) return null;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  return target;
}

/** «اجازه می‌دهم» / «رد» from the bell — the same server endpoint as the job page (admin only for manager-mode requests). */
export async function decideCreditPermission(jobId: number, approve: boolean): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${base()}/api/smart-filing/jobs/${jobId}/permission/decide`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve }),
    });
  } catch { throw new NotificationApiError('ارتباط با سامانه برقرار نشد.', 0); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new NotificationApiError(typeof body?.message === 'string' ? body.message : 'ثبت تصمیم انجام نشد.', response.status);
  }
}
