/** عملکرد من v1.2 API client (flag.my_performance_v12). */
import { useQuery } from '@tanstack/react-query';
import { useMyWorkMe, useMyWorkReport, type MpReport } from '../my-performance-v11/api';

export { useMyWorkMe, useMyWorkReport, type MpReport };

const base = () => (typeof window !== 'undefined' && (window as { __API_BASE__?: string }).__API_BASE__) || '/api';

export type MpKpiItem = {
  key: string;
  group: 'sales' | 'discipline' | 'growth' | 'team';
  label: string;
  formula: string;
  value: number | null;
  display: string;
  unit: 'count' | 'percent' | 'amount' | 'pp' | 'hours';
  incomplete: boolean;
  teamAvg: number | null;
  teamAvgDisplay: string | null;
  rank: number | null;
  of: number;
};

export type MpKpiReport = {
  period: string;
  periodKey: string;
  label: string;
  previousLabel: string;
  from: string;
  to: string;
  workingDays: number;
  incomplete: boolean;
  score: {
    value: number | null;
    teamAvg: number | null;
    rank: number | null;
    of: number;
    role: 'first_call' | 'p1' | null;
    roleLabel: string | null;
    formula: string;
  };
  groups: { sales: MpKpiItem[]; discipline: MpKpiItem[]; growth: MpKpiItem[] };
};

export type MpCallRow = {
  id: string;
  at: number;
  atLabel: string;
  customerId: number | null;
  customerName: string | null;
  phone: string;
  direction: 'incoming' | 'outgoing' | null;
  result: 'missed' | 'ok' | 'later' | 'unknown';
  resultLabel: string;
  durationSec: number | null;
  waitingCallback: boolean;
  recordingReady: boolean;
  transcriptReady: boolean;
  hasVoip: boolean;
};

export type MpCallTotals = {
  calls: number; answered: number; noAnswer: number; durationSec: number;
  unique: number; avgDuration: number | null; outbound: number; inbound: number;
};

export type MpCallReport = {
  period: string;
  label: string;
  from: string;
  to: string;
  totals: MpCallTotals;
  teamAvg: MpCallTotals;
  waitingCount: number;
  page: number;
  pageSize: number;
  totalRows: number;
  hasVoip: boolean;
  rows: MpCallRow[];
};

export type RangeQ = { period?: string; from?: string; to?: string };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base()}${path}`, { credentials: 'include' });
  if (r.status === 404) {
    const err = new Error('این گزارش فعلاً فعال نیست.') as Error & { status: number };
    err.status = 404;
    throw err;
  }
  if (r.status === 403) throw new Error('مشاهده این گزارش مجاز نیست.');
  if (!r.ok) throw new Error('خواندن گزارش ممکن نشد.');
  return r.json() as Promise<T>;
}

function qs(q: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v != null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useMyWorkKpis(enabled: boolean, q: RangeQ) {
  return useQuery({
    queryKey: ['my-work-kpis', q],
    enabled,
    queryFn: () => getJson<MpKpiReport>(`/my-work/kpis${qs(q)}`),
  });
}

export function useMyWorkCalls(enabled: boolean, q: RangeQ & { direction?: string; result?: string; waiting?: string; page?: number; q?: string }) {
  return useQuery({
    queryKey: ['my-work-calls', q],
    enabled,
    queryFn: () => getJson<MpCallReport>(`/my-work/calls${qs(q)}`),
  });
}
