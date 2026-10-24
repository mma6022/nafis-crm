import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Me } from '@/lib/goods-api';

/** One row of the «در انتظار ایجاد» queue (server: lib/registration-suggestions.ts). */
export type PendingRow = {
  customerId: number; customerName: string; phone: string | null;
  applicationId?: number; purchaseId?: number; planId?: number; planName: string;
  customerSalespersonName: string | null; completedAt: string | null; readySince: string | null;
  waitingDays: number; balanceToman?: string; amountToman?: string | null;
  canCreate: boolean; blocked: boolean; unavailableReason: string | null;
};
export type PendingResult = { items: PendingRow[]; total: number; canCreate: boolean; actionable: number; blocked: number; old: number; viewOnly: boolean; page: number; limit: number };
export type PendingKind = 'goods' | 'payments';

export const PENDING_PATH: Record<PendingKind, string> = { goods: '/goods-purchases/suggestions', payments: '/payment-orders/suggestions' };
export const OLD_WAIT_DAYS = 7;

/** Mirrors the server's access rule so the tab can be the default without a flash; the server stays the authority (403 hides the tab). */
export function pendingAccess(kind: PendingKind, user: Me | undefined, can: (p: string) => boolean): 'create' | 'view' | null {
  if (!user) return null;
  const create = kind === 'goods'
    ? user.role === 'admin' || (can('goods_purchases.manage') && !['salesperson', 'accounting', 'funder'].includes(user.role))
    : can('payment_orders.create');
  if (create) return 'create';
  if (user.role === 'salesperson' && can(kind === 'goods' ? 'goods_purchases.view' : 'payment_orders.view')) return 'view';
  return null;
}

export function usePendingQueue(kind: PendingKind, q: string, page: number, enabled: boolean) {
  return useQuery({
    queryKey: ['registration-suggestions', kind, q.trim(), page],
    queryFn: () => api.get<PendingResult>(`${PENDING_PATH[kind]}?page=${page}&q=${encodeURIComponent(q.trim())}`),
    enabled, refetchInterval: 30_000, retry: (n, e) => !(e instanceof ApiError && e.status === 403) && n < 2,
  });
}

/** Tab count: actionable rows for creators (locked rows are listed, never counted); everything for view-only. */
export function pendingTabCount(r?: PendingResult) { return r ? (r.canCreate ? r.actionable : r.total) : null; }

export const PENDING_INTRO: Record<PendingKind, { create: string; view: string }> = {
  goods: { create: 'پرونده‌های تکمیل‌شده‌ای که هنوز خرید کالا ندارند. قدیمی‌ترها بالا هستند.', view: 'مشتری‌های تو که پرونده‌شان تکمیل شده و منتظر خرید کالا هستند. ساختن با ثبت‌نام‌کننده است؛ اینجا فقط وضعیت را می‌بینی.' },
  payments: { create: 'خریدهای کالای تکمیل‌شده‌ای که هنوز دستور پرداخت ندارند. قدیمی‌ترها بالا هستند.', view: 'مشتری‌های تو که خرید کالایشان تکمیل شده و منتظر دستور پرداخت هستند. ساختن با ثبت‌نام‌کننده است؛ اینجا فقط وضعیت را می‌بینی.' },
};
export const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

/** Sidebar badge: create-capable users only; null = no badge source. */
export function usePendingCounts(enabled: boolean) {
  return useQuery({
    queryKey: ['pending-create-counts'],
    queryFn: () => api.get<{ goods: number | null; payments: number | null }>('/pending-create/counts'),
    enabled, refetchInterval: 60_000, staleTime: 20_000,
  });
}

export type WaitTone = 'grey' | 'gold' | 'red';
export const waitTone = (days: number): WaitTone => days >= OLD_WAIT_DAYS ? 'red' : days >= 3 ? 'gold' : 'grey';
export const waitText = (days: number) => days <= 0 ? 'از امروز' : `${days.toLocaleString('fa-IR')} روز منتظر`;
