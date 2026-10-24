/**
 * List-query layer for «دستورهای پرداخت». Every list/count on the page and in the sidebar goes through
 * here, so a new section (e.g. the coming «در انتظار ایجاد») only adds a params shape or its own fetcher.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type PaymentOrder } from '@/lib/goods-api';

export type PoListParams = { stage?: 'sales_approval' | 'admin_approval' | 'awaiting_payment' | 'paid'; mine?: boolean };
export type PoListResult = { items: PaymentOrder[]; page: number; limit: number; total: number };

export const poListKey = (params: PoListParams, search = '', page = 1) => ['payment-orders', 'list', params.stage ?? '', Boolean(params.mine), search, page] as const;

export function fetchPaymentOrders(params: PoListParams, search = '', page = 1) {
  const qs = new URLSearchParams({ q: search.trim(), stage: params.stage ?? '', page: String(page) });
  if (params.mine) qs.set('mine', '1');
  return api.get<PoListResult>(`/payment-orders?${qs}`);
}

export function usePaymentOrderList(params: PoListParams, search: string, page: number, enabled = true) {
  return useQuery({ queryKey: poListKey(params, search, page), queryFn: () => fetchPaymentOrders(params, search, page), refetchInterval: 30_000, enabled });
}

/** Server total for a filter (one row page; uses `total`). */
export function usePaymentOrderCount(params: PoListParams, enabled = true) {
  return useQuery({
    queryKey: ['payment-orders', 'count', params.stage ?? '', Boolean(params.mine)] as const,
    queryFn: () => fetchPaymentOrders(params, '', 1).then((r) => Number(r.total) || 0),
    refetchInterval: 30_000, enabled, retry: false,
  });
}
