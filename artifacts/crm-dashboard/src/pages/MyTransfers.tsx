/* Task C «تاریخچه‌ی انتقال‌های من» — read-only: customers that left my ownership (customer_priority_history) and where they are now.
   No profile link, no edit: masked name / mobile, date, target expert, current expert and current stage only. */
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { Link } from 'wouter';
import { toPersianDigits } from '@/lib/customer-id';
import type { MyTransfer } from '@/lib/other-owner';
import './customers.css';
import '@/components/customer/other-owner.css';

const faDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric' }); };

export default function MyTransfers() {
  const q = useQuery({
    queryKey: ['my-transfers'],
    queryFn: async () => {
      const r = await fetch('/api/my-transfers', { credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { error?: string }).error || 'دریافت فهرست انجام نشد.');
      return body as { items: MyTransfer[] };
    },
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  return <section className="csx mt-page" dir="rtl" data-testid="page-my-transfers">
    <h1 className="mt-title"><ArrowRightLeft size={20} aria-hidden="true" /> تاریخچه‌ی انتقال‌های من</h1>
    <p className="csx-meta mt-sub">مشتریانی که از پنل شما به کارشناس دیگری منتقل شده‌اند. فقط برای مشاهده است و پرونده قابل باز کردن یا ویرایش نیست. <Link href="/customers">بازگشت به مشتری‌ها</Link></p>
    {q.isLoading ? <p className="csx-meta">در حال دریافت…</p> : null}
    {q.isError ? <div className="csx-note bad" role="alert"><p>{(q.error as Error).message}</p></div> : null}
    {!q.isLoading && !q.isError && !items.length ? <div className="csx-note" role="note"><p>هنوز انتقالی از پنل شما ثبت نشده است.</p></div> : null}
    {items.length ? <>
      <p className="csx-cnt">{toPersianDigits(items.length)} انتقال</p>
      <div className="mt-table-wrap">
        <table className="mt-table" data-testid="table-my-transfers">
          <thead><tr><th>مشتری</th><th>تاریخ انتقال</th><th>به کارشناس</th><th>مرحلهٔ فعلی</th></tr></thead>
          <tbody>{items.map((t) => <tr key={t.historyId} data-testid={`my-transfer-${t.historyId}`}>
            <td data-label="مشتری"><b>{t.customerName}</b> <span className="cust-id-badge oo-badge" dir="ltr">#{toPersianDigits(t.customerId)}</span>
              {t.maskedPhone && t.maskedPhone !== '***' ? <span className="oo-phone mt-phone" dir="ltr">{toPersianDigits(t.maskedPhone)}</span> : null}</td>
            <td data-label="تاریخ انتقال">{faDate(t.transferredAt)}<span className="mt-src">{t.sourceLabel}{t.byMe ? '' : ' · نه توسط شما'}</span></td>
            <td data-label="به کارشناس">{t.toSalespersonName}{t.currentSalespersonId != null && t.currentSalespersonId !== t.toSalespersonId ?
              <span className="mt-src">اکنون: {t.currentSalespersonName ?? '—'}</span> : null}</td>
            <td data-label="مرحلهٔ فعلی">{t.stageLabel}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </> : null}
  </section>;
}
