import { ArrowUpLeft, CalendarClock, CheckCircle2, CircleDotDashed, ClipboardCheck, PhoneCall, UsersRound } from 'lucide-react';
import { Link } from 'wouter';
import type { ReactNode } from 'react';
import { getGetAuthSessionQueryKey, getGetCrmSummaryQueryKey, getGetLoanApplicationDashboardStatsQueryKey, useGetAuthSession, useGetCrmSummary, useGetLoanApplicationDashboardStats } from '@workspace/api-client-react';
import { ErrorState, formatDateTime } from '@/components/CrmShell';
import { WalletDashboardCard } from '@/features/staff-wallet/WalletDashboardCard';

export default function Dashboard() {
  const sessionQuery = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canViewLoans = sessionQuery.data?.user.role === 'admin' || sessionQuery.data?.user.permissions?.includes('loan_applications.view');
  const me = sessionQuery.data?.user as ({ salespersonId?: number | null; role: string; permissions?: string[] } | undefined);
  const ownSalesperson = me?.salespersonId && (me.role === 'admin' || me.permissions?.includes('goods_finance.view')) ? me.salespersonId : null;
  const query = useGetCrmSummary({ query: { queryKey: getGetCrmSummaryQueryKey(), staleTime: 30_000 } });
  const loanStatsQuery = useGetLoanApplicationDashboardStats({
    query: { queryKey: getGetLoanApplicationDashboardStatsQueryKey(), staleTime: 30_000, enabled: Boolean(canViewLoans) },
  });
  const summary = query.data;
  const loanStats = loanStatsQuery.data;
  const priorityCounts = summary?.priorityCounts ?? [];
  const maxCount = Math.max(...priorityCounts.map((item) => item.count), 1);
  return <section>
    <div className="page-intro">
      <div><div className="eyebrow">اتاق عملیات مشتری</div><h2>تصویر امروز شما</h2><p>اعداد را به اقدام بعدی تبدیل کنید؛ بدون گم شدن در جزئیات.</p></div>
      <Link href="/customers" className="btn btn-gold" data-testid="link-dashboard-customers"><UsersRound size={16} /> مشاهده مشتریان</Link>
    </div>
    {query.isLoading || sessionQuery.isLoading || (canViewLoans && loanStatsQuery.isLoading) ? <div className="metric-grid"><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /><div className="metric-card skeleton" style={{ height: 121 }} /></div> : query.isError || sessionQuery.isError || (canViewLoans && loanStatsQuery.isError) ? <ErrorState onRetry={() => { query.refetch(); sessionQuery.refetch(); if (canViewLoans) loanStatsQuery.refetch(); }} /> : <>
      <div className="metric-grid">
        <Metric icon={<UsersRound />} label="کل مشتریان" value={summary?.totalCustomers ?? 0} note="پرونده در پایگاه" />
        <Metric icon={<ArrowUpLeft />} label="مشتریان فعال" value={summary?.activeCustomers ?? 0} note="نیازمند توجه مستمر" tone="teal" />
        <Metric icon={<CalendarClock />} label="یادآورهای باز" value={summary?.openReminders ?? 0} note="اقدام‌های نزدیک" tone="gold" />
        <Metric icon={<PhoneCall />} label="کل تماس‌ها" value={summary?.totalCalls ?? 0} note="ثبت شده در سیستم" />
      </div>
      {canViewLoans && <div className="metric-grid">
        <MetricLink href="/loan-applications?actionable=true" icon={<ClipboardCheck />} label="در انتظار اقدام من" value={loanStats?.awaitingAction ?? 0} note="پرونده‌های کارتابل فعلی" tone="gold" />
        <MetricLink href="/loan-applications?caseScope=in-progress" icon={<CircleDotDashed />} label="پرونده‌های در جریان" value={loanStats?.inProgress ?? 0} note="بدون پرونده‌های تکمیل یا ردشده" tone="teal" />
        <MetricLink href="/loan-applications?stage=completed" icon={<CheckCircle2 />} label="پرونده‌های تکمیل‌شده" value={loanStats?.completed ?? 0} note="در محدوده مشتریان قابل دسترس" />
      </div>}
      {ownSalesperson ? <WalletDashboardCard salespersonId={ownSalesperson} /> : null}
      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-head"><div><h3>توزیع اولویت پیگیری</h3><p>تعداد مشتریان در حال انجام در هر سطح اولویت</p></div><Link href="/customers" className="text-link" data-testid="link-priority-customers">مشاهده فهرست</Link></div>
          {priorityCounts.length ? <div className="bar-chart">{priorityCounts.slice().sort((a, b) => a.priority - b.priority).map((item) => <div className="bar-wrap" key={item.priority}><span className="bar-num">{item.count}</span><div className="bar" style={{ height: `${Math.max(10, (item.count / maxCount) * 100)}%` }} /><span className="bar-label">{item.priority === 0 ? 'بدون اولویت' : `سطح ${item.priority}`}</span></div>)}</div> : <div className="empty-state"><CalendarClock /><strong>مشتری در حال انجامی وجود ندارد</strong><p>مشتریان دارای وضعیت «در حال انجام» در این نمودار نمایش داده می‌شوند.</p></div>}
          <div style={{ marginTop: 16, fontSize: 11, color: '#657187' }}>مجموع مشتریان در حال انجام: <strong>{priorityCounts.reduce((total, item) => total + item.count, 0).toLocaleString('fa-IR')}</strong></div>
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

function MetricLink({ href, ...metric }: { href: string; icon: ReactNode; label: string; value: number; note: string; tone?: string }) {
  return <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }} data-testid={`link-metric-${metric.label}`}><Metric {...metric} /></Link>;
}
