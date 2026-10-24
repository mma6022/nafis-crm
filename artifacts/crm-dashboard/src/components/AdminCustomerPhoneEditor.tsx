import { CustomerName } from '@/components/customer/CustomerName';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetCustomerQueryKey, useGetAuthSession, useUpdateCustomer, type Customer } from '@workspace/api-client-react';
import { Modal } from './DataTools';
import { formatPhoneForDisplay } from '@/lib/phone';
import { normalizeDigits, validateIranianMobile } from '@/lib/customer-field-validation';

export function AdminCustomerPhoneEditor({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const session = useGetAuthSession();
  const queryClient = useQueryClient();
  const update = useUpdateCustomer();
  const [phone, setPhone] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const normalizedPhone = normalizeDigits(phone).trim();
  const isAdmin = session.data?.user.role === 'admin';
  if (!isAdmin) return null;
  const close = () => { if (!update.isPending) onClose(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending || !isAdmin) return;
    setError('');
    if (!validateIranianMobile(normalizedPhone)) { setError('شماره موبایل باید ۱۱ رقم باشد و با ۰۹ شروع شود.'); return; }
    if (normalizedPhone === normalizeDigits(customer.phone).trim()) { setError('شماره جدید با شماره فعلی یکسان است.'); return; }
    if (!confirmed) { setError('تعلق شماره جدید به همین مشتری را تأیید کنید.'); return; }
    update.mutate({ id: customer.id, data: { phone: normalizedPhone } }, {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetCustomerQueryKey(saved.id), saved);
        void queryClient.invalidateQueries();
        onClose();
      },
      onError: (failure) => {
        const e = failure as { status?: number; data?: { error?: string } };
        setError(e.status === 409 ? 'این شماره موبایل متعلق به مشتری دیگری است؛ شماره را بررسی کنید.'
          : e.status === 403 ? 'اجازهٔ تغییر شماره موبایل این مشتری را ندارید.'
          : /[\u0600-\u06ff]/.test(e.data?.error ?? '') ? e.data!.error!
          : 'تغییر شماره ذخیره نشد. دوباره تلاش کنید.');
      },
    });
  };
  return <Modal title="تغییر شماره موبایل مشتری" onClose={close} testId="admin-customer-phone">
    <form onSubmit={submit}>
      <p><strong><CustomerName id={customer.id} name={customer.name} nameTestId="text-phone-edit-customer" /></strong></p>
      <p>موبایل فعلی: <bdi dir="ltr" data-testid="text-current-customer-phone">{formatPhoneForDisplay(customer.phone)}</bdi></p>
      <p id="customer-phone-change-warning" style={{ color: '#92400e', fontSize: 13, lineHeight: 1.9 }}>
        با تغییر موبایل، تأیید هویت قبلی معتبر نخواهد بود و اطلاعات وابسته به هویت برای درخواست جدید باید دوباره بررسی شوند.
        ورود با شمارهٔ قبلی معتبر نمی‌ماند. سوابق و قراردادهای قبلی حذف یا بازنویسی نمی‌شوند.
      </p>
      <div className="field">
        <label htmlFor="admin-new-customer-phone">موبایل جدید</label>
        <input id="admin-new-customer-phone" type="tel" inputMode="tel" autoComplete="off" dir="ltr"
          placeholder="09xxxxxxxxx" value={phone} disabled={update.isPending}
          onChange={event => { setPhone(event.target.value); setConfirmed(false); setError(''); }}
          aria-describedby="customer-phone-change-warning" aria-invalid={Boolean(error)}
          data-testid="input-admin-customer-phone" />
      </div>
      <label style={{ display: 'flex', alignItems: 'start', gap: 8, marginTop: 14, fontSize: 13 }}>
        <input type="checkbox" checked={confirmed} disabled={update.isPending}
          onChange={event => setConfirmed(event.target.checked)} data-testid="checkbox-confirm-customer-phone" />
        تأیید می‌کنم شمارهٔ جدید مربوط به همین مشتری است.
      </label>
      {error && <p className="form-error" role="alert" data-testid="error-admin-customer-phone">{error}</p>}
      <div className="form-footer">
        <button type="submit" className="btn btn-primary" disabled={update.isPending} data-testid="button-save-customer-phone">{update.isPending ? 'در حال ذخیره…' : 'ذخیره شماره جدید'}</button>
        <button type="button" className="btn btn-ghost" disabled={update.isPending} onClick={close}>انصراف</button>
      </div>
    </form>
  </Modal>;
}
