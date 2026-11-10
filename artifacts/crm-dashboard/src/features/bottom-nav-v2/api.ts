/** bottom-nav-v2 client flag (flag.bottom_nav_v2). Shares /sales-shell/me; absent = OFF. */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

async function getMe(): Promise<{ v2?: boolean; bottomNavV2?: boolean }> {
  const r = await fetch('/api/sales-shell/me', { credentials: 'include' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (await r.json()) as { v2?: boolean; bottomNavV2?: boolean };
}

/** True only while the global flag is on. Errors / unsigned-in → OFF (old nav). */
export function useBottomNavV2(uid: number | null | undefined, enabled: boolean): boolean {
  const q = useQuery({
    queryKey: ['bottom-nav-v2-me', uid ?? 0],
    enabled: Boolean(uid) && enabled,
    queryFn: async () => (await getMe()).bottomNavV2 === true,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const on = Boolean(uid) && enabled && q.data === true;
  useEffect(() => {
    if (!on) return;
    document.documentElement.classList.add('bnv2-on');
    return () => document.documentElement.classList.remove('bnv2-on');
  }, [on]);
  return on;
}
