/** SALES-FIXES 480000 (t810u) client. Server: artifacts/api-server/src/lib/sales-fixes-480000.ts (shipped in api-480000.patch).
 *  Kill switches are server rows flag.sf480_* = '0'; a failed /me read keeps the old behaviour for the lists and no popups. */
import { useQuery } from '@tanstack/react-query';

export type Sf480Me = { openLists: boolean; noPopups: boolean; ownerPriority: boolean; ownerStatus: boolean; ready?: boolean };
export type Sf480Case = { id: number; stage: string; status: string; life: string | null; planName: string | null; amount: string | null; createdAt: string | null };
export type Sf480Hit = { id: number; name: string; phoneLast4: string; priority: number | null; status: string; cases: Sf480Case[] };
export type Sf480Row = { id: number; name: string; phoneLast4: string; priority: number | null; status: string; lastCallAt: string | null; cases: number };

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include', signal });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((d && typeof d.message === 'string' && d.message) || 'انجام نشد. دوباره تلاش کن.'), { status: r.status });
  return d as T;
}
export const sfApi = {
  me: () => get<Sf480Me>('/sales-fixes/me'),
  cases: () => sfCases(),
  search: (q: string, signal?: AbortSignal) => get<{ q: string; items: Sf480Hit[] }>(`/sales-fixes/search?q=${encodeURIComponent(q)}`, signal),
  myCustomers: (q: string, offset: number) => get<{ total: number; offset: number; items: Sf480Row[] }>(`/sales-fixes/my-customers?q=${encodeURIComponent(q)}&offset=${offset}`),
};
const OFF: Sf480Me = { openLists: false, noPopups: false, ownerPriority: false, ownerStatus: false };
/** Only for sales experts (role salesperson); admins / managers keep every popup and list as before. */
export function useSf480(role: string | undefined | null): Sf480Me {
  const on = role === 'salesperson';
  const q = useQuery({ queryKey: ['sf480-me'], queryFn: sfApi.me, enabled: on, staleTime: 5 * 60_000, retry: 1 });
  if (!on) return { ...OFF, ready: true };
  // while loading: popups stay away (the flag defaults ON on the server), lists wait for the answer
  return q.data ? { ...q.data, ready: true } : { ...OFF, noPopups: true, ready: !q.isLoading };
}
export const SF_SEARCH_EV = 'sf480:search-open';
export const openSfSearch = () => window.dispatchEvent(new CustomEvent(SF_SEARCH_EV));
export const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
export type Sf480KCase = { id: number; customerId: number; customerName: string; priority: number | null; stage: string; status: string; life: string; planName: string | null; amount: string | null; createdAt: string | null; lastActivityAt: string | null };
export const sfCases = () => get<{ total: number; cases: Sf480KCase[] }>('/sales-fixes/cases');
const JD = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', month: 'long', day: 'numeric' });
export const faDay = (iso?: string | null) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : JD.format(d); };
export const PRIO_FA: Record<number, string> = { 1: 'اولویت ۱', 2: 'اولویت ۲', 3: 'اولویت ۳' };
