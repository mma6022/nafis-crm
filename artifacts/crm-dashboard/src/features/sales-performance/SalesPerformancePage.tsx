/** گزارش عملکرد فروش (flag.sales_performance_v1). Admin + sales_manager see everyone; experts see only themselves. */
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useParams } from 'wouter';
import NotFound from '@/pages/not-found';
import { useSalesPerformanceMe, useSalesPerformanceReport } from './api';
import { mountSalesPerformance, type SpUiState, type SpView } from './sales-performance-ui';
import './sales-performance.css';

function paramsFrom(search: string, pathExpert?: string): {
  period: NonNullable<SpUiState['period']>;
  from?: string;
  to?: string;
  view: SpView;
  rankMetric: NonNullable<SpUiState['rankMetric']>;
  expertId?: number;
} {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const rawPeriod = q.get('period');
  const period: NonNullable<SpUiState['period']> = rawPeriod === 'week' || rawPeriod === 'month' || rawPeriod === 'custom' ? rawPeriod : 'day';
  const viewParam = q.get('view');
  let view: SpView = 'overview';
  if (pathExpert) view = 'expert';
  else if (viewParam === 'ranks') view = 'ranks';
  else if (viewParam === 'score') view = 'score';
  else if (viewParam === 'team') view = 'team';
  else if (viewParam === 'compare') view = 'compare';
  else if (period === 'custom') view = 'range-custom';
  const metric = q.get('metric');
  const rankMetric: NonNullable<SpUiState['rankMetric']> =
    metric === 'avgDuration' || metric === 'duration' || metric === 'score' || metric === 'calls' ? metric : 'calls';
  return {
    period,
    from: q.get('from') || undefined,
    to: q.get('to') || undefined,
    view,
    rankMetric,
    expertId: pathExpert ? Number(pathExpert) : undefined,
  };
}

export default function SalesPerformancePage() {
  const [location, setLocation] = useLocation();
  const params = useParams() as { id?: string };
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const parsed = useMemo(() => paramsFrom(search, params.id), [search, params.id, location]);
  const me = useSalesPerformanceMe(true);
  const ready = Boolean(me.data?.canView);
  const report = useSalesPerformanceReport(ready, {
    period: parsed.period,
    from: parsed.period === 'custom' ? parsed.from : undefined,
    to: parsed.period === 'custom' ? parsed.to : undefined,
    expertId: parsed.expertId ?? null,
  });
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (me.failureReason && (me.failureReason as { status?: number }).status === 404) return;
    if (!me.data?.canView && me.isFetched && !me.isError) return;
    const el = root.current;
    if (!el) return;
    const access = me.data?.access;
    let view: SpView = parsed.view;
    if (access === 'expert') view = 'self';
    if (access === 'trainee') view = 'trainee';
    let scene: SpView = view;
    if (me.isLoading || (ready && report.isLoading && !report.data)) scene = 'loading';
    else if (report.isError || (me.isError && (me.failureReason as { status?: number }).status !== 404)) scene = 'error';
    const st: SpUiState = {
      view: scene,
      me: me.data ?? { enabled: false, access: 'none', canView: false, canViewAll: false, self: null },
      report: report.data ?? null,
      period: parsed.period,
      customFrom: parsed.from,
      customTo: parsed.to,
      rankMetric: parsed.rankMetric,
      expertId: parsed.expertId ?? null,
    };
    const handle = mountSalesPerformance(el, st, {
      applyRange(from, to) {
        const p = new URLSearchParams();
        p.set('period', 'custom'); p.set('from', from); p.set('to', to);
        setLocation(`/sales-performance?${p.toString()}`);
      },
      retry() { void report.refetch(); },
    });
    return () => handle.destroy();
  }, [me.data, me.isLoading, me.isError, me.isFetched, me.failureReason, report.data, report.isLoading, report.isError, parsed, ready, setLocation, report.refetch]);

  if (me.isFetched && (me.failureReason as { status?: number } | undefined)?.status === 404) return <NotFound />;
  if (me.isFetched && !me.isError && me.data && !me.data.canView) return <NotFound />;

  return <div ref={root} dir="rtl" lang="fa" data-testid="page-sales-performance" />;
}
