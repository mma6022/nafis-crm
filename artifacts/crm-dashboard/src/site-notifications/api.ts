export type SiteNotification = { id: number; kind: string; title: string; body: string; customerId: number; customerName: string; target: string; page?: string; createdAt: string; readAt: string | null };
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
