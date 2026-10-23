import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pagination, SearchField } from './DataTools';
import { ErrorState, SkeletonPanel, formatDateTime } from './CrmShell';
import { api, errText, toman, useMe, type PaymentOrder } from '@/lib/goods-api';

export type RegistrationSuggestion = {
  customerId: number; customerName: string; phone: string | null;
  applicationId?: number; purchaseId?: number; planId?: number; planName: string;
  customerSalespersonName: string | null; completedAt: string | null;
  balanceToman?: string; amountToman?: string;
  canCreate: boolean; unavailableReason: string | null;
};
type Result = { items: RegistrationSuggestion[]; total: number; page: number; limit: number };

export function RegistrationSuggestions({ kind, onSelect }: {
  kind: 'goods' | 'payments'; onSelect?: (row: RegistrationSuggestion) => void;
}) {
  const { can, user } = useMe();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const isGoods = kind === 'goods';
  const allowed = isGoods
    ? can('goods_purchases.view') && can('goods_purchases.manage') && !['salesperson', 'accounting', 'funder'].includes(user?.role ?? '')
    : can('payment_orders.view') && can('payment_orders.create');
  const endpoint = isGoods ? '/goods-purchases/suggestions' : '/payment-orders/suggestions';
  const q = useQuery({
    queryKey: ['registration-suggestions', kind, user?.id, search, page],
    queryFn: () => api.get<Result>(`${endpoint}?page=${page}&q=${encodeURIComponent(search.trim())}`),
    enabled: allowed, staleTime: 0, refetchInterval: 30_000,
  });
  const createOrder = useMutation({
    mutationFn: (purchaseId: number) => api.post<PaymentOrder>('/payment-orders', { purchaseId }),
    onSuccess: async order => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['registration-suggestions', 'payments'] }),
        qc.invalidateQueries({ queryKey: ['payment-orders'] }),
      ]);
      navigate(`/payment-orders/${order.id}`);
    },
  });
  useEffect(() => {
    if (!q.data) return;
    const last = Math.max(1, Math.ceil(q.data.total / q.data.limit));
    if (page > last) setPage(last);
  }, [q.data, page]);
  if (!allowed) return null;
  const data = q.data;
  const total = data?.total ?? 0;
  return <section className="panel" style={{ marginBottom: 20, padding: 18 }} data-testid={`suggestions-${kind}`}>
    <div className="panel-head"><div>
      <h3>{isGoods ? 'پیشنهاد ثبت خرید کالا' : 'پیشنهاد ایجاد دستور پرداخت'}
        {data && <span className="inline-badge gold" style={{ marginInlineStart: 8 }}>{total.toLocaleString('fa-IR')} مورد</span>}
      </h3>
      <p>{isGoods ? 'پرونده‌های تکمیل‌شده‌ای که هنوز برای اعتبارشان خرید کالا ثبت نشده است.'
        : 'خریدهای تکمیل‌شده‌ای که هنوز هیچ دستور پرداختی ندارند.'} قدیمی‌ترین موارد در ابتدا نمایش داده می‌شوند.</p>
    </div></div>
    <SearchField value={search} onChange={value => { setSearch(value); setPage(1); }}
      placeholder={isGoods ? 'نام، موبایل یا شماره پرونده' : 'نام، موبایل یا شماره خرید'}
      testId={`search-suggestions-${kind}`} />
    {q.isLoading ? <SkeletonPanel rows={2} />
      : q.isError ? <><div className="gp-alert" role="alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></>
        : !data?.items.length ? <p className="secondary-cell" role="status" style={{ marginTop: 14 }}>
          {search ? 'پیشنهادی با این جست‌وجو پیدا نشد.' : isGoods ? 'پروندهٔ تکمیل‌شدهٔ بدون خرید کالا باقی نمانده است.' : 'خرید تکمیل‌شدهٔ بدون دستور پرداخت باقی نمانده است.'}
        </p> : <div className="table-wrap"><table className="data-table"><thead><tr>
          <th>مشتری</th><th>{isGoods ? 'پرونده / طرح' : 'خرید / طرح'}</th>
          <th>{isGoods ? 'موجودی کیف پول طرح' : 'مبلغ پرداخت'}</th><th>{isGoods ? 'آخرین تغییر پرونده' : 'تکمیل خرید'}</th><th>اقدام</th>
        </tr></thead><tbody>{data.items.map(row => <tr key={row.applicationId ?? row.purchaseId}
          data-testid={`suggestion-${kind}-${row.applicationId ?? row.purchaseId}`}>
          <td><strong>{row.customerName}</strong><span className="secondary-cell" style={{ display: 'block' }}>
            کارشناس فروش: {row.customerSalespersonName || 'بدون تخصیص'}</span>
            {row.phone && <span className="secondary-cell" dir="ltr">{row.phone}</span>}</td>
          <td>{isGoods ? <span>پرونده #{row.applicationId?.toLocaleString('fa-IR')}</span>
            : <Link href={`/goods-purchases/${row.purchaseId}`} className="text-link">خرید #{row.purchaseId?.toLocaleString('fa-IR')}</Link>}
            <span className="secondary-cell" style={{ display: 'block' }}>{row.planName}</span></td>
          <td className="mono">{toman(isGoods ? row.balanceToman : row.amountToman)}</td>
          <td className="secondary-cell">{row.completedAt ? formatDateTime(row.completedAt) : '—'}</td>
          <td><button type="button" className="btn btn-primary"
            disabled={!row.canCreate || createOrder.isPending}
            onClick={() => isGoods ? onSelect?.(row) : row.purchaseId && createOrder.mutate(row.purchaseId)}
            data-testid={`button-suggestion-${kind}-${row.applicationId ?? row.purchaseId}`}>
            {isGoods ? 'شروع ثبت خرید کالا' : createOrder.isPending && createOrder.variables === row.purchaseId ? 'در حال ایجاد…' : 'ایجاد دستور پرداخت'}
          </button>{row.unavailableReason && <small className="secondary-cell" style={{ display: 'block', maxWidth: 260 }}>{row.unavailableReason}</small>}</td>
        </tr>)}</tbody></table></div>}
    {createOrder.isError && <div className="gp-alert" role="alert">{errText(createOrder.error)}</div>}
    {data && total > data.limit && <Pagination total={total} offset={(page - 1) * data.limit} limit={data.limit}
      onChange={offset => setPage(Math.floor(offset / data.limit) + 1)} testId={`pagination-suggestions-${kind}`} />}
  </section>;
}
