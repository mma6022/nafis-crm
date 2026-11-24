import { useQuery } from '@tanstack/react-query';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include' });
  const body = await r.json().catch(() => null);
  if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404, body });
  if (r.status === 403) throw Object.assign(new Error('forbidden'), { status: 403, body });
  if (!r.ok) throw Object.assign(new Error((body as { error?: string } | null)?.error || `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
}

export type MpDelta = { kind: 'up' | 'down' | 'flat' | 'none' | 'unit'; pct: number };
export type MpMetric = { value: number; delta: MpDelta };
export type MpMe = {
  enabled: boolean;
  inquiry: boolean;
  access: 'manager' | 'expert' | 'trainee' | 'none';
  canView: boolean;
  self: { salespersonId: number; name: string; trainee: boolean; teamName: string | null } | null;
};
export type MpReport = {
  access: MpMe['access'];
  inquiry: boolean;
  period: 'day' | 'week' | 'month' | 'custom';
  range: { from: string; to: string; fromIso: string; toIso: string; label: string; previousLabel: string; complete: boolean };
  incomplete: boolean;
  self: {
    salespersonId: number; name: string; teamName: string | null; trainee: boolean;
    calls: MpMetric; outbound: MpMetric; inbound: MpMetric; answered: MpMetric; noAnswer: MpMetric;
    durationSec: MpMetric; newCustomers: MpMetric; filed: MpMetric; signed: MpMetric;
    baleChats: MpMetric; baleMessages: MpMetric; followups: { done: number; due: number };
  };
  team: {
    name: string | null; rank: number | null; of: number;
    averages: { calls: number; newCustomers: number; filed: number; signed: number; baleMessages: number };
  } | null;
  trend: { kind: 'hour' | 'day'; columns: { key: string; label: string; value: number; current: boolean }[] };
};

export function useMyWorkFlags(uid: number | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['sales-shell-me-mp', uid ?? 0],
    enabled: Boolean(uid) && enabled,
    queryFn: async () => {
      const r = await fetch('/api/sales-shell/me', { credentials: 'include' });
      if (!r.ok) return { on: false, inquiry: false };
      const b = (await r.json()) as { myPerformanceV1?: boolean; myPerformanceInquiry?: boolean };
      return { on: b.myPerformanceV1 === true, inquiry: b.myPerformanceInquiry === true };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

export function useMyWorkMe(enabled: boolean) {
  return useQuery({
    queryKey: ['my-work-me'],
    enabled,
    queryFn: () => get<MpMe>('/my-work/me'),
    retry: false,
    staleTime: 30_000,
  });
}

export function useMyWorkReport(enabled: boolean, q: { period?: string; from?: string; to?: string }) {
  const p = new URLSearchParams();
  if (q.period) p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  const path = `/my-work${p.toString() ? `?${p}` : ''}`;
  return useQuery({
    queryKey: ['my-work', path],
    enabled,
    queryFn: () => get<MpReport>(path),
    retry: (n, e) => (e as { status?: number })?.status !== 403 && (e as { status?: number })?.status !== 404 && n < 2,
    staleTime: 30_000,
  });
}
