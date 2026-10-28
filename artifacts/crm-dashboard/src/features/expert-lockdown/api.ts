/** expert_lockdown client (assistants54). Server: artifacts/api-server/src/lib/expert-lockdown.ts. Flag OFF / other users → { locked: false } and nothing changes. */
import { useQuery } from '@tanstack/react-query';

export type ElMe = { locked: false } | { locked: true; allowedPages: string[]; grantMinutes: number };
export type ElSearch =
  | { result: 'own'; customer: { id: number; name: string }; windowMinutes: number }
  | { result: 'other'; name: string; ownerName: string; notified: boolean; referable: boolean; referred: boolean; refToken: string | null }
  | { result: 'none' | 'ambiguous' | 'invalid' | 'rate_limited'; message: string };
/** SEARCH-C «ارجاع» (Armita v1.1: POST …/refer { refToken }). */
export type ElRefer = { result: 'referred'; name: string; ownerName: string; at: string; already: boolean } | { result: 'invalid' | 'not_referable' | 'rate_limited'; message: string };
export type ElNew =
  | { result: 'new' }
  | { result: 'duplicate'; ownerName: string; mine: boolean; notified?: boolean }
  | { result: 'created'; customer: { id: number; name: string } }
  | { result: 'invalid' | 'rate_limited'; message: string; field?: string };
export type ElSuggestItem = { id: number; name: string; phoneLast4: string; priority: number | null; match: 'exact' | 'phone' | 'name' };
export type ElSuggest = { result: 'ok'; kind: 'phone' | 'name'; items: ElSuggestItem[]; phone?: string } | { result: 'short' | 'rate_limited'; message: string };
export type ElDaily = { day: string; flag: boolean; experts: { userId: number; salespersonId: number; name: string; opens: number; searches: number; own: number; other: number; none: number; limited: number; bells: number; loggedOutOfList: number; chooseOwn?: number; chooseNew?: number; newChecks?: number; duplicates?: number; created?: number }[] };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok && !((r.status === 429 || r.status === 409 || r.status === 400) && data?.result)) throw Object.assign(new Error((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.'), { status: r.status, code: data?.error ?? '' });
  return data as T;
}
export const elApi = {
  me: () => req<ElMe>('GET', '/expert-lockdown/me').catch((): ElMe => ({ locked: false })),
  open: () => req<{ ok: true }>('POST', '/expert-lockdown/incoming/open', {}),
  search: (q: string, context?: 'new_file') => req<ElSearch>('POST', '/expert-lockdown/incoming/search', context ? { q, context } : { q }),
  suggest: (q: string, signal?: AbortSignal) => fetch('/api/expert-lockdown/incoming/suggest', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }), signal })
    .then(async (r) => { const d = await r.json().catch(() => null); if (!d?.result) throw new Error('جست‌وجو انجام نشد.'); return d as ElSuggest; }),
  pick: (id: number, context?: 'new_file') => req<ElSearch>('POST', '/expert-lockdown/incoming/pick', context ? { pick: id, context } : { pick: id }),
  refer: (refToken: string) => req<ElRefer>('POST', '/expert-lockdown/incoming/refer', { refToken }),
  choose: (option: 'own' | 'new') => req<{ ok: boolean }>('POST', '/expert-lockdown/incoming/choose', { option }),
  newCheck: (phone: string) => req<ElNew>('POST', '/expert-lockdown/incoming/new/check', { phone }),
  create: (body: { phone: string; name: string; description?: string }) => req<ElNew>('POST', '/expert-lockdown/incoming/new', body),
  firstCallIncomplete: (customerId: number) => req<{ customerId: number; incomplete: boolean }>('GET', `/team-sales/first-call-incomplete/${customerId}`),
  firstCallLogged: (customerId: number, callLogId: number) => req<{ ok: true; mirrored: boolean }>('POST', '/expert-lockdown/incoming/first-call-logged', { customerId, callLogId }),
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
