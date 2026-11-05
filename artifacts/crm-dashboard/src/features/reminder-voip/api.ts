/** REMINDER-VOIP (flag.reminder_voip[.user.<id>], default OFF) — Armita «تماس ویپ در یادآورها» v1.1.
 *  GET /reminder-voip/meta answers 404 while the flag is off → { on:false } and the pages render exactly as before. */
import { useQuery, type QueryClient } from '@tanstack/react-query';

export class RvError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new RvError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '');
  return data as T;
}

export type RvKind = 'own' | 'other' | 'internal' | 'support_own' | 'support_other';
export type RvOutcome = 'answered' | 'no_answer' | 'follow_up';
export type RvResult = { outcome: RvOutcome; note: string; savedAt: string; source: string | null };
export type RvItem = { id: number; kind: RvKind; customerId: number | null; hasPhone: boolean; phone: string | null; ownerName: string | null; ownerExt: string | null;
  firstCall: boolean; callId: number | null; callFirst: boolean; result: RvResult | null };
export type RvMeta = { on: boolean; voip?: boolean; registrar?: boolean; items?: Record<string, RvItem> };
const OFF: RvMeta = { on: false };

export const RV_KEY = ['reminder-voip'] as const;
export const useRvMeta = (ids: number[], enabled = true) => {
  const key = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b).slice(0, 300).join(',');
  return useQuery<RvMeta>({
    queryKey: [...RV_KEY, 'meta', key], enabled, retry: false, staleTime: 2_000, placeholderData: (p) => p,
    queryFn: () => req<RvMeta>('GET', `/reminder-voip/meta?ids=${key}`).catch((e) => { if (e instanceof RvError && [401, 403, 404].includes(e.status)) return OFF; throw e; }),
    refetchInterval: (q) => ((q.state.data as RvMeta | undefined)?.on ? 10_000 : false),
    refetchIntervalInBackground: false,
  });
};
export const rvApi = {
  start: (id: number) => req<{ ok: true; call: any; firstCall?: boolean }>('POST', `/reminder-voip/${id}/start`, {}),
  result: (id: number, b: { outcome: RvOutcome; note: string; callId?: number; callLogId?: number }) =>
    req<{ ok: true; result: RvResult }>('POST', `/reminder-voip/${id}/result`, b),
  /** manual «تماس گرفتم، ثبت نتیجه» (no VoIP call): the same POST /calls body as the reminder-must form */
  saveCall: (b: Record<string, unknown>) => req<{ id: number }>('POST', '/calls', b),
};
export const rvRefresh = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: RV_KEY });
  void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && String(q.queryKey[0]).includes('/reminders') });
};
