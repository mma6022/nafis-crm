/** expert_lockdown: what a locked expert sees on a closed page or a customer that is not open for them. */
import { Link } from 'wouter';
import { Lock } from 'lucide-react';
import './lockdown.css';

export function LockdownNotice({ customer }: { customer?: boolean }) {
  return <div className="el-page" dir="rtl" data-testid={customer ? 'el-customer-closed' : 'el-page-closed'}>
    <div className="el-box" role="alert">
      <Lock size={18} aria-hidden="true" />
      <div>
        <b>{customer ? 'این پرونده فعلاً برای تو باز نیست' : 'این بخش فعلاً بسته است'}</b>
        <p>{customer
          ? 'فقط مشتری‌های «کارهای امروز»، مشتری‌هایی که پرونده‌ی خودت را دارند و مشتری خودت که با «تماس ورودی» پیدا کرده‌ای باز می‌شوند.'
          : 'فعلاً فقط «کارهای امروز من»، «پرونده‌های من»، «دستور پرداخت»، «خرید کالا» و پیام‌رسان‌ها باز است.'}</p>
      </div>
    </div>
    <Link className="btn btn-primary" href="/today">رفتن به کارهای امروز</Link>
  </div>;
}
