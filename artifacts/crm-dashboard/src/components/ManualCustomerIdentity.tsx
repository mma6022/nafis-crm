import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useManuallyVerifyCustomer, type Customer, type ManualVerificationApprovalCorrectedValues } from '@workspace/api-client-react';
import { Modal } from './DataTools';

type Field = keyof ManualVerificationApprovalCorrectedValues;
const fields: { key: Field; label: string; numeric?: boolean; required?: boolean; max: number }[] = [
  { key: 'name', label: 'نام کامل', required: true, max: 200 },
  { key: 'firstName', label: 'نام', max: 200 },
  { key: 'lastName', label: 'نام خانوادگی', max: 200 },
  { key: 'fatherName', label: 'نام پدر', max: 200 },
  { key: 'mobile', label: 'شماره همراه', numeric: true, required: true, max: 16 },
  { key: 'nationalCode', label: 'کد ملی', numeric: true, required: true, max: 10 },
  { key: 'birthDateJalali', label: 'تاریخ تولد شمسی (۱۳۷۰/۰۱/۰۱)', numeric: true, required: true, max: 10 },
  { key: 'postalCode', label: 'کد پستی', numeric: true, required: true, max: 10 },
  { key: 'address', label: 'نشانی کامل', required: true, max: 2000 },
];
const digits = (value: string) => value.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

export function ManualCustomerIdentity({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<Field, string>>({
    name: customer.name, mobile: customer.phone, nationalCode: customer.nationalCode ?? '',
    birthDateJalali: customer.birthDateJalali ?? '', postalCode: customer.postalCode ?? customer.officialPostalCode ?? '',
    firstName: customer.firstName ?? customer.officialFirstName ?? '',
    lastName: customer.lastName ?? customer.officialLastName ?? '',
    fatherName: customer.fatherName ?? customer.officialFatherName ?? '',
    address: customer.address ?? customer.officialAddress ?? '',
  });
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const verify = useManuallyVerifyCustomer();
  return <Modal title="احراز دستی و ویرایش مشخصات مشتری" onClose={() => { if (!verify.isPending) onClose(); }} testId="manual-customer-identity">
    <form onSubmit={event => {
      event.preventDefault();
      setError('');
      if (!confirmed || !reason.trim()) { setError('دلیل احراز را بنویسید و صحت اطلاعات را تأیید کنید.'); return; }
      const correctedValues = Object.fromEntries(fields.map(({ key, numeric }) => [
        key, numeric ? digits(form[key].trim()).replace(/[-.]/g, key === 'birthDateJalali' ? '/' : '') : form[key].trim(),
      ])) as ManualVerificationApprovalCorrectedValues;
      const decision = { method: 'manual' as const, reason: reason.trim() };
      verify.mutate({ id: customer.id, data: { correctedValues, checks: {
        shahkarLite: decision, personInfo: decision, postalCodeInfo: decision, sana: decision,
      } } }, {
        onSuccess: async () => { await queryClient.invalidateQueries(); onClose(); },
        onError: (failure) => {
          const e = failure as { status?: number; data?: { error?: string } };
          const raw = e.data?.error ?? '';
          setError(/active customer already/i.test(raw) ? 'این شماره همراه یا کد ملی متعلق به مشتری فعال دیگری است.'
            : e.status === 403 ? 'این اقدام فقط برای مدیر سامانه مجاز است.'
            : /stale/i.test(raw) ? 'اطلاعات مشتری تغییر کرده است؛ پنجره را ببندید و با اطلاعات تازه دوباره باز کنید.'
            : /[آ-ی]/.test(raw) ? raw : 'احراز دستی ذخیره نشد؛ اطلاعات را بررسی و دوباره تلاش کنید.');
        },
      });
    }}>
      <p style={{ fontSize: 13, color: '#475569' }}>این اقدام تأیید دستی مالکیت همراه، هویت، نشانی و ثنا است و با نام مدیر و دلیل ثبت می‌شود؛ رتبه اعتباری و استعلام مالی را تغییر نمی‌دهد.</p>
      <p style={{ fontSize: 12, color: '#92400e' }}>تغییر مشخصات هویتی ممکن است اعتبار استعلام‌ها و مدارک قبلی را برای درخواست جدید از بین ببرد. قراردادهای صادرشده بازنویسی نمی‌شوند.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {fields.map(({ key, label, numeric, required, max }) => <label key={key} style={{ display: 'grid', gap: 6, gridColumn: key === 'address' ? '1 / -1' : undefined }}>
          {label}{required ? ' *' : ''}
          {key === 'address'
            ? <textarea required value={form[key]} maxLength={max} disabled={verify.isPending} data-testid={`manual-identity-${key}`} onChange={e => setForm(current => ({ ...current, [key]: e.target.value }))} rows={3} />
            : <input required={required} value={form[key]} maxLength={max} dir={numeric ? 'ltr' : undefined} disabled={verify.isPending} data-testid={`manual-identity-${key}`} onChange={e => setForm(current => ({ ...current, [key]: e.target.value }))} />}
        </label>)}
      </div>
      <label style={{ display: 'grid', gap: 6, marginTop: 14 }}>دلیل و مستندات احراز دستی *
        <textarea required maxLength={2000} rows={3} value={reason} disabled={verify.isPending} onChange={e => setReason(e.target.value)} data-testid="manual-identity-reason" />
      </label>
      <label style={{ display: 'flex', gap: 8, marginTop: 14, fontSize: 13 }}>
        <input type="checkbox" required checked={confirmed} disabled={verify.isPending} onChange={e => setConfirmed(e.target.checked)} data-testid="manual-identity-confirm" />
        صحت اطلاعات و هر چهار بررسی هویت را پس از بررسی مستندات تأیید می‌کنم.
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer">
        <button type="submit" className="btn btn-primary" disabled={verify.isPending} data-testid="manual-identity-save">{verify.isPending ? 'در حال ذخیره…' : 'ذخیره مشخصات و احراز دستی'}</button>
        <button type="button" className="btn btn-ghost" disabled={verify.isPending} onClick={onClose}>انصراف</button>
      </div>
    </form>
  </Modal>;
}