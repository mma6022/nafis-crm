import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListSalespersonIdentityAmbiguitiesQueryKey,
  getListSalespersonsQueryKey,
  getListUsersQueryKey,
  useListSalespersonIdentityAmbiguities,
  useResolveSalespersonIdentityLink,
  type SalespersonIdentityIssue,
  type SalespersonIdentityDetail,
} from '@workspace/api-client-react';
import { ErrorState } from '@/components/CrmShell';

export default function SalespersonIdentityReview() {
  const client = useQueryClient();
  const report = useListSalespersonIdentityAmbiguities({
    query: { queryKey: getListSalespersonIdentityAmbiguitiesQueryKey(), staleTime: 0, refetchOnWindowFocus: true },
  });
  const resolve = useResolveSalespersonIdentityLink();
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const submit = (issue: SalespersonIdentityIssue) => {
    const selection = choices[issue.userId];
    if (!selection) return;
    const identity = report.data?.identities.find((item) => item.id === Number(selection));
    if (selection !== 'new' && !identity) return;
    const label = selection === 'new' ? 'ساخت هویت فروش جدید' : `اتصال به «${identity?.name}» (#${identity?.id})`;
    if (!window.confirm(`${label} برای حساب ${issue.username}؟\nمشتریان و سوابق مالی جابه‌جا نمی‌شوند. پیش از تأیید سوابق هویت را بررسی کنید.`)) return;
    setError('');
    resolve.mutate({
      id: issue.userId,
      data: {
        expectedSalespersonId: issue.currentSalespersonId,
        choice: selection === 'new' ? 'new' : Number(selection),
      },
    }, {
      onSuccess: () => {
        setChoices((previous) => ({ ...previous, [issue.userId]: '' }));
        client.invalidateQueries({ queryKey: getListSalespersonIdentityAmbiguitiesQueryKey() });
        client.invalidateQueries({ queryKey: getListUsersQueryKey() });
        client.invalidateQueries({ queryKey: getListSalespersonsQueryKey() });
      },
      onError: () => {
        setError('اتصال ذخیره نشد. ممکن است هویت قبلاً به حساب دیگری متصل شده باشد. گزارش را تازه کنید و دوباره بررسی کنید.');
        report.refetch();
      },
    });
  };

  return (
    <section className="data-table-wrap" style={{ marginTop: 20, padding: 18 }} data-testid="salesperson-identity-review">
      <h3 style={{ marginTop: 0 }}>بررسی ارتباط حساب‌های فروش قدیمی</h3>
      <p className="secondary-cell">تنها اتصال حساب تغییر می‌کند. مالکیت مشتری، خریدها، پورسانت‌ها و ماندهٔ مالی با شناسهٔ قبلی باقی می‌مانند.</p>
      {report.isLoading ? <p>در حال بررسی ارتباط‌ها...</p> : report.isError ? <ErrorState onRetry={() => report.refetch()} /> : null}
      {error ? <p className="profile-form-error" role="alert">{error}</p> : null}
      {report.data && !report.data.issues.length ? <p>مورد مبهمی باقی نمانده است.</p> : null}
      {report.data?.issues.map((issue) => {
        const identities = report.data!.identities;
        const relevant = identities.filter((item) => issue.candidateIds.includes(item.id));
        const available = identities.filter((item) => item.linkedUsers.every((user) => user.id === issue.userId));
        return (
          <div key={issue.userId} style={{ borderTop: '1px solid #e5e7eb', padding: '16px 0' }} data-testid={`identity-issue-${issue.userId}`}>
            <strong>{issue.fullName || issue.username}</strong> <span className="secondary-cell" dir="ltr">{issue.username} · {issue.mobile || 'بدون موبایل'}</span>
            <p>علت بررسی: {issue.reason === 'shared' ? 'چند حساب به یک هویت متصل‌اند' : issue.reason === 'missing' ? 'هویت فعلی یافت نشد' : issue.reason === 'claimed' ? 'هویت مشابه در اختیار حساب دیگری است' : issue.reason === 'conflicting_mobile' ? 'نام یکسان است اما شماره‌های موبایل متفاوت‌اند' : 'چند هویت با نام یا موبایل مطابقت دارند'}. هویت فعلی: {issue.currentSalespersonId ?? 'بدون اتصال'}</p>
            <p><strong>هویت‌های مرتبط با نام، موبایل یا اتصال فعلی:</strong></p>
            {relevant.length ? relevant.map((item) => <IdentityRecords key={item.id} identity={item} />) : <p className="secondary-cell">هویت پیشنهادی موجود نیست؛ در صورت نیاز هویت جدید بسازید یا از فهرست همهٔ هویت‌های آزاد انتخاب کنید.</p>}
            <div className="field" style={{ maxWidth: 440 }}>
              <label htmlFor={`identity-choice-${issue.userId}`}>انتخاب آگاهانهٔ هویت</label>
              <select id={`identity-choice-${issue.userId}`} value={choices[issue.userId] || ''} onChange={(event) => setChoices({ ...choices, [issue.userId]: event.target.value })} data-testid={`select-identity-${issue.userId}`}>
                <option value="">هویت را انتخاب کنید</option>
                {available.map((item) => <option key={item.id} value={item.id}>#{item.id} — {item.name} ({item.customers.length} مشتری، {item.purchases.length} خرید)</option>)}
                <option value="new">هویت فروش جدید (بدون مشتری و سابقه)</option>
              </select>
            </div>
            {choices[issue.userId] && choices[issue.userId] !== 'new' && !relevant.some((item) => item.id === Number(choices[issue.userId]))
              ? <IdentityRecords identity={identities.find((item) => item.id === Number(choices[issue.userId]))!} /> : null}
            <button className="btn btn-primary" disabled={!choices[issue.userId] || resolve.isPending} onClick={() => submit(issue)} data-testid={`button-resolve-identity-${issue.userId}`}>
              {resolve.isPending ? 'در حال ثبت...' : 'تأیید اتصال حساب'}
            </button>
          </div>
        );
      })}
    </section>
  );
}

function IdentityRecords({ identity }: { identity: SalespersonIdentityDetail }) {
  return (
    <details style={{ margin: '8px 0', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
      <summary>#{identity.id} — {identity.name} · {identity.mobile || 'بدون موبایل'} · {identity.customers.length} مشتری · {identity.purchases.length} خرید · {identity.financialEntries.length} سند مالی</summary>
      <p>حساب‌های متصل: {identity.linkedUsers.map((user) => user.username).join('، ') || 'هیچ‌کدام'}</p>
       <p>مشتریان و کارشناس فعلی پرونده: {identity.customers.map((customer) => `${customer.name} (#${customer.id}) · ${identity.name}`).join('، ') || 'هیچ‌کدام'}</p>
      <p>خریدها و پورسانت (تومان): {identity.purchases.map((purchase) => `#${purchase.id} / مشتری #${purchase.customerId} / ${purchase.stage} / ${purchase.commissionToman ?? 'ثبت نشده'}`).join('، ') || 'هیچ‌کدام'}</p>
      <p>سوابق مالی (تومان): {identity.financialEntries.map((entry) => `#${entry.id} / ${entry.kind} / ${entry.amountToman}`).join('، ') || 'هیچ‌کدام'}</p>
      <p>ماندهٔ کیف پول پورسانت (تومان): {identity.walletBalanceToman ?? 'ثبت نشده'}</p>
    </details>
  );
}