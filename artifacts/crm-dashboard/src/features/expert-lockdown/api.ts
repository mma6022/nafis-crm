/** expert_lockdown client (assistants54). Server: artifacts/api-server/src/lib/expert-lockdown.ts. Flag OFF / other users → { locked: false } and nothing changes. */
import { useQuery } from '@tanstack/react-query';

export type ElMe = { locked: false } | { locked: true; allowedPages: string[]; grantMinutes: number };
export type ElSearch =
  | { result: 'own'; customer: { id: number; name: string }; windowMinutes: number }
  | { result: 'other'; ownerName: string; notified: boolean }
  | { result: 'none' | 'ambiguous' | 'invalid' | 'rate_limited'; message: string };
export type ElDaily = { day: string; flag: boolean; experts: { userId: number; salespersonId: number; name: string; opens: number; searches: number; own: number; other: number; none: number; limited: number; bells: number; loggedOutOfList: number }[] };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok && !(r.status === 429 && data?.result)) throw Object.assign(new Error((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.'), { status: r.status, code: data?.error ?? '' });
  return data as T;
}
export const elApi = {
  me: () => req<ElMe>('GET', '/expert-lockdown/me').catch((): ElMe => ({ locked: false })),
  open: () => req<{ ok: true }>('POST', '/expert-lockdown/incoming/open', {}),
  search: (q: string) => req<ElSearch>('POST', '/expert-lockdown/incoming/search', { q }),
  daily: (day?: string) => req<ElDaily>('GET', `/expert-lockdown/admin/daily${day ? `?day=${day}` : ''}`),
};
/** Only these three accounts can ever be locked (server: EL_USERS); nobody else even asks. */
export const EL_UIDS = [2, 3, 8];
export const EL_ME_KEY = ['expert-lockdown', 'me'];
export function useLockdownMe(enabled = true) {
  return useQuery({ queryKey: EL_ME_KEY, queryFn: elApi.me, enabled, staleTime: 60_000, retry: false, refetchOnWindowFocus: true });
}
/** Pages a locked expert may open (customer pages are decided by the server, 403 expert_lockdown_customer). */
export function elPageAllowed(me: ElMe | undefined, loc: string): boolean {
  if (!me?.locked) return true;
  if (loc === '/profile' || /^\/customers\/\d+(\/|$)/.test(loc)) return true;
  return me.allowedPages.some((p) => loc === p || loc.startsWith(`${p}/`) || loc.startsWith(`${p}?`));
}
