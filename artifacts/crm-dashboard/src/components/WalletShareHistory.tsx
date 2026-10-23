import { getListCustomerWalletShareLinksQueryKey, useListCustomerWalletShareLinks } from '@workspace/api-client-react';
import { formatDateTime } from '@/components/CrmShell';

const paymentLabels: Record<string, string> = {
  pending: 'در انتظار پرداخت', processing: 'پرداخت در جریان',
  credited: 'موفق؛ کیف پول شارژ شد', cancelled: 'لغوشده', failed: 'ناموفق',
  verification_pending: 'در انتظار بررسی', requires_reconciliation: 'نیازمند تطبیق پرداخت',
  expired: 'منقضی‌شده',
};
const smsLabels: Record<string, string> = {
  not_sent: 'ارسال نشده', sending: 'در حال ارسال', sent: 'پذیرفته‌شده توسط سرویس پیامک',
  delivery_unknown: 'نتیجه ارسال نامشخص',
};

export function WalletShareHistory({ customerId }: { customerId: number }) {
  const history = useListCustomerWalletShareLinks(customerId, {
    query: {
      queryKey: getListCustomerWalletShareLinksQueryKey(customerId),
      staleTime: 0, refetchInterval: 15000, refetchOnWindowFocus: true, retry: false,
    },
  });
  return <section className="panel" data-testid="wallet-share-history">
    <div className="panel-head"><div><h3>درخواست‌های شارژ قبلی</h3><p>سوابق پرداخت و ارسال پیامک؛ لینک‌های محرمانه در سابقه ذخیره و نمایش داده نمی‌شوند.</p></div>
      <button className="btn btn-ghost" disabled={history.isFetching} onClick={() => void history.refetch()}>به‌روزرسانی</button>
    </div>
    {history.isLoading ? <p>در حال دریافت درخواست‌ها…</p> : history.isError ? <p role="alert">دریافت سابقه انجام نشد. دوباره تلاش کنید.</p> : <>
      {history.data?.items.some(item => item.isActive) && <p role="status">درخواست پرداخت فعال یا نیازمند بررسی وجود دارد. پیش از ساخت لینک جدید، وضعیت آن را بررسی کنید؛ لینک جدید درخواست قبلی را لغو نمی‌کند.</p>}
      {!history.data?.items.length ? <p>هنوز درخواست شارژی ثبت نشده است.</p> :
        <div style={{ overflowX: 'auto' }}><table className="data-table" style={{ width: '100%' }}>
          <thead><tr><th>درخواست</th><th>مبلغ (تومان)</th><th>طرح</th><th>زمان ساخت</th><th>انقضای لینک</th><th>پیامک</th><th>پرداخت</th></tr></thead>
          <tbody>{history.data.items.map(item => <tr key={item.id}>
            <td>#{item.id.toLocaleString('fa-IR')}</td>
            <td>{BigInt(item.amountToman).toLocaleString('fa-IR')}</td>
            <td>{item.planName ?? (item.planId ? `طرح ${item.planId}` : 'شارژ مستقیم')}</td>
            <td>{formatDateTime(item.createdAt)}</td><td>{formatDateTime(item.expiresAt)}</td>
            <td>{smsLabels[item.smsStatus] ?? 'نامشخص'}</td>
            <td>{paymentLabels[item.paymentStatus] ?? 'نامشخص'}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
  </section>;
}