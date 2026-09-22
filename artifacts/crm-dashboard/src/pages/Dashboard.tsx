import { ArrowUpLeft, CalendarClock, PhoneCall, UsersRound } from 'lucide-react';
import { Link } from 'wouter';
import type { ReactNode } from 'react';
import { getGetCrmSummaryQueryKey, useGetCrmSummary } from '@workspace/api-client-react';
import { ErrorState, formatDateTime, statusLabel } from '@/components/CrmShell';

export default function Dashboard() {
  const query = useGetCrmSummary({ query: { queryKey: getGetCrmSummaryQueryKey(), staleTime: 30_000 } });
  const summary = query.data;
  const statusCounts = summary?.statusCounts ?? [];
  const priorityCounts = summary?.priorityCounts ?? [];
  const maxCount = Math.max(...priorityCounts.map((item) => item.count), 1);
  return <section>
    <div className="page-intro">
      <div><div className="eyebrow">اتاق عملیات مشتری</div><h2>تصویر امروز شما</h2><p>اعداد را به اقدام بعدی تبدیل کنید؛ بدون گم شدن در جزئیات.</p></div>
      <Link href="/customers" className="btn btn-gold" data-testid="link-dashboard-customers"><UsersRound size={16} /> مشاهده مشتریان</Link>
    </div>
    {query.isLoading ? <div className="metric-grid"><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /></div> : query.isError ? <ErrorState onRetry={() => query.refetch()} /> : <>
      <div className="metric-grid">
        <Metric icon={<UsersRound />} label="کل مشتریان" value={summary?.totalCustomers ?? 0} note="پرونده در پایگاه" />
        <Metric icon={<ArrowUpLeft />} label="مشتریان فعال" value={summary?.activeCustomers ?? 0} note="نیازمند توجه مستمر" tone="teal" />
        <Metric icon={<CalendarClock />} label="یادآورهای باز" value={summary?.openReminders ?? 0} note="اقدام‌های نزدیک" tone="gold" />
        <Metric icon={<PhoneCall />} label="کل تماس‌ها" value={summary?.totalCalls ?? 0} note="ثبت شده در سیستم" />
      </div>
      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-head"><div><h3>توزیع اولویت پیگیری</h3><p>تعداد مشتری در هر سطح اولویت</p></div><Link href="/customers" className="text-link" data-testid="link-priority-customers">مشاهده فهرست</Link></div>
          {priorityCounts.length ? <div className="bar-chart">{priorityCounts.slice().sort((a, b) => a.priority - b.priority).map((item) => <div className="bar-wrap" key={item.priority}><span className="bar-num">{item.count}</span><div className="bar" style={{ height: `${Math.max(10, (item.count / maxCount) * 100)}%` }} /><span className="bar-label">{item.priority === 0 ? 'بدون اولویت' : `سطح ${item.priority}`}</span></div>)}</div> : <div className="empty-state"><CalendarClock /><strong>هنوز داده اولویتی ثبت نشده</strong><p>با اضافه شدن مشتری‌ها این نمودار کامل می‌شود.</p></div>}
          <div style={{ display: 'flex', gap: 15, marginTop: 16, flexWrap: 'wrap' }}>{statusCounts.map((item) => <div key={item.status} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#657187' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: item.status === 'completed' ? '#3f918a' : '#d9b96c' }} />{statusLabel(item.status)} <strong style={{ color: '#23375e' }}>{item.count}</strong></div>)}</div>
        </div>
        <div className="panel">
          <div className="panel-head"><div><h3>آخرین فعالیت‌ها</h3><p>آخرین تماس‌های ثبت شده</p></div><Link href="/customers" className="text-link" data-testid="link-recent-activity">همه مشتریان</Link></div>
          {summary?.recentActivity?.length ? <div className="activity-list">{summary.recentActivity.slice(0, 5).map((activity) => <div className="activity-item" key={activity.id}><div className="activity-dot"><PhoneCall /></div><div className="activity-content"><strong>{activity.subject || 'تماس با مشتری'}</strong><p title={activity.customerRequest || activity.expertNotes || undefined}>{activity.customerRequest || activity.expertNotes || 'جزئیات تماس ثبت نشده است.'}</p></div><span className="activity-time">{formatDateTime(activity.createdAt)}</span></div>)}</div> : <div className="empty-state"><PhoneCall /><strong>فعالیتی برای نمایش نیست</strong><p>تماس‌های جدید اینجا دیده می‌شوند.</p></div>}
        </div>
      </div>
    </>}
  </section>;
}

function Metric({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: number; note: string; tone?: string }) {
  return <div className="metric-card" data-testid={`metric-${label}`}><div className="metric-label"><span>{label}</span><span className={`metric-icon ${tone ?? ''}`}>{icon}</span></div><div className="metric-value">{value.toLocaleString('fa-IR')}</div><div className="metric-note">{note}</div></div>;
}
