import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetCustomerWalletPaymentQueryKey, getListCustomerPaymentReconciliationQueryKey, useListCustomerPaymentReconciliation, useReconcileCustomerCashPayment } from '@workspace/api-client-react';
import { formatDateTime } from './CrmShell';

export function PaymentReconciliation({ customerId, returnedPaymentId }: { customerId: number; returnedPaymentId: number | null }) {
  const queryClient = useQueryClient();
  const history = useListCustomerPaymentReconciliation(customerId, { query: { queryKey: getListCustomerPaymentReconciliationQueryKey(customerId), staleTime: 0 } });
  const reconcile = useReconcileCustomerCashPayment();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const confirmPayment = (paymentId: number, amount: string) => {
    if (!window.confirm(`تأیید مجدد پرداخت شماره ${paymentId} به مبلغ ${BigInt(amount).toLocaleString('fa-IR')} تومان از زرین‌پال انجام شود؟ تنها پس از دریافت رسید معتبر کیف پول نقدی شارژ می‌شود.`)) return;
    setError('');
    setMessage('');
    reconcile.mutate({ customerId, paymentId }, {
      onSuccess: (result) => {
        setMessage(result.status === 'credited' ? `پرداخت شماره ${paymentId} با رسید ${result.providerRefId} ثبت و کیف پول شارژ شد.` : `پرداخت شماره ${paymentId} قبلاً شارژ شده است.`);
        queryClient.invalidateQueries({ queryKey: getListCustomerPaymentReconciliationQueryKey(customerId) });
        queryClient.invalidateQueries({ queryKey: ['customer-wallet', customerId] });
        if (returnedPaymentId === paymentId) queryClient.invalidateQueries({ queryKey: getGetCustomerWalletPaymentQueryKey(customerId, paymentId) });
      },
      onError: () => {
        setError('پرداخت از طرف درگاه اثبات نشد یا رسید قابل استفاده نبود. موجودی تغییر نکرده است؛ رسید و مبلغ را با سوابق زرین‌پال بررسی کنید.');
        history.refetch();
      },
    });
  };

  return <details className="panel" style={{ marginTop: 16 }} open={returnedPaymentId !== null ? true : undefined}>
    <summary>پیگیری و تطبیق پرداخت‌ها (ویژه مدیر)</summary>
    <p>وضعیت داخلی، شماره مرجع درگاه و مبلغ را بررسی کنید. دکمه تطبیق، مستقیماً درگاه را استعلام می‌کند؛ صرف اعلام موفقیت در صفحه بازگشت کافی نیست.</p>
    <button type="button" className="btn btn-ghost" onClick={() => history.refetch()}>به‌روزرسانی سوابق</button>
    {history.isLoading && <p>در حال دریافت سوابق…</p>}
    {history.isError && <p role="alert">دریافت سوابق انجام نشد. دوباره تلاش کنید.</p>}
    {error && <p role="alert" style={{ color: '#be123c' }}>{error}</p>}
    {message && <p role="status">{message}</p>}
    {history.data?.items.length === 0 && <p>پرداختی برای این مشتری ثبت نشده است.</p>}
    {history.data?.items.map(item => <div key={item.id} style={{ padding: '12px 0', borderTop: '1px solid #edf0f4' }}>
      <strong>#{item.id.toLocaleString('fa-IR')} · {BigInt(item.amountToman).toLocaleString('fa-IR')} تومان</strong>
      <p>وضعیت: {item.status === 'credited' ? 'شارژ شده' : item.status === 'provider_already_verified' ? 'تأیید شده درگاه؛ شارژ نشده' : item.status === 'created' ? 'در انتظار تطبیق' : item.status === 'cancelled' ? 'لغو شده' : 'ناموفق'} · تلاش: {item.attemptStatus ?? 'نامشخص'} · {formatDateTime(item.createdAt)}</p>
      <p>شناسه درخواست درگاه: <span dir="ltr">{item.authority}</span> · رسید ثبت‌شده: <span dir="ltr">{item.providerRefId ?? 'ثبت نشده'}</span></p>
      {item.status !== 'credited' && <button type="button" className="btn btn-ghost" disabled={reconcile.isPending} onClick={() => confirmPayment(item.id, item.amountToman)}>{reconcile.isPending ? 'در حال استعلام…' : 'استعلام درگاه و بازیابی شارژ'}</button>}
    </div>)}
  </details>;
}