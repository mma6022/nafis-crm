import { useQuery } from '@tanstack/react-query';
import type { Me } from './sales-teams-ui';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include' });
  if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: await r.json().catch(() => null) });
  return (await r.json()) as T;
}

export function useSalesTeamsMe(enabled: boolean) {
  return useQuery({
    queryKey: ['sales-teams-me'],
    enabled,
    queryFn: () => get<Me>('/sales-teams/me'),
    retry: false,
    staleTime: 30_000,
  });
}

export const salesTeamsPath = '/sales-teams';
