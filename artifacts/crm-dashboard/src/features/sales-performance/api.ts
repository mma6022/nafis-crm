import { useQuery } from '@tanstack/react-query';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include' });
  const body = await r.json().catch(() => null);
  if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404, body });
  if (r.status === 403) throw Object.assign(new Error('forbidden'), { status: 403, body });
  if (!r.ok) throw Object.assign(new Error((body as { error?: string } | null)?.error || `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
}

export type SpMe = {
  enabled: boolean;
  access: 'manager' | 'expert' | 'trainee' | 'none';
  canView: boolean;
  canViewAll: boolean;
  self: { salespersonId: number; name: string; trainee: boolean; role: string | null; roleLabel: string | null; teamName: string | null } | null;
};

export type SpDelta = { kind: 'up' | 'down' | 'flat' | 'none' | 'unit'; pct: number };
export type SpCell = { value: number; delta: SpDelta; incomplete: boolean };
export type SpBreakdown = { key: string; label: string; weight: number; value: number; points: number };
export type SpExpert = {
  salespersonId: number; name: string; teamId: number | null; teamName: string | null;
  role: 'first_call' | 'p1' | null; roleLabel: string | null; trainee: boolean;
  score: number | null; rank: number | null; roleN: number | null;
  metrics: Record<string, SpCell>; walletRial: number; breakdown: SpBreakdown[];
};
export type SpTeam = {
  teamId: number; name: string;
  members: { salespersonId: number; name: string; role: string | null; roleLabel: string | null }[];
  metrics: Record<string, SpCell>; walletRial: number;
};
export type SpReport = {
  access: SpMe['access'];
  period: 'day' | 'week' | 'month' | 'custom';
  range: { from: string; to: string; label: string; previousLabel: string; complete: boolean };
  incomplete: boolean;
  incompleteFrom: string;
  self: SpExpert | null;
  experts?: SpExpert[];
  teams?: SpTeam[];
};

export function useSalesPerformanceMe(enabled: boolean) {
  return useQuery({
    queryKey: ['sales-performance-me'],
    enabled,
    queryFn: () => get<SpMe>('/sales-performance/me'),
    retry: false,
    staleTime: 30_000,
  });
}

export function reportPath(q: { period?: string; from?: string; to?: string; expertId?: number | null; view?: string; metric?: string }) {
  const p = new URLSearchParams();
  if (q.period) p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.view) p.set('view', q.view);
  if (q.metric) p.set('metric', q.metric);
  if (q.expertId != null) p.set('expertId', String(q.expertId));
  const s = p.toString();
  return `/sales-performance${s ? `?${s}` : ''}`;
}

export function useSalesPerformanceReport(enabled: boolean, q: { period?: string; from?: string; to?: string; expertId?: number | null }) {
  const path = reportPath(q);
  return useQuery({
    queryKey: ['sales-performance', path],
    enabled,
    queryFn: () => get<SpReport>(path),
    retry: (n, e) => (e as { status?: number })?.status !== 403 && (e as { status?: number })?.status !== 404 && n < 2,
    staleTime: 30_000,
  });
}
