/** Simotel parts 1–2 (design simotel v1.0.2 scenes 01–17): «تماس از تلفن ویپ». Server returns 404 voip_call_off unless
 *  flag.voip_call (or flag.voip_call.user.<id>) is on AND the user has a VoIP extension; then everything here stays hidden.
 *  The customer's number never travels through these endpoints: the server reads it from the DB and originates itself. */
import { useQuery, type QueryClient } from '@tanstack/react-query';

export class VcError extends Error { constructor(message: string, public status: number, public code: string, public details: any) { super(message); } }
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new VcError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '', data?.details ?? null);
  return data as T;
}

export type VcState = 'requesting' | 'ring_me' | 'dial_cust' | 'in_call' | 'ended' | 'me_timeout' | 'error';
export type VcOutcome = 'answered' | 'no_answer' | 'busy' | null;
export type VcCall = { id: number; state: VcState; outcome: VcOutcome; customerId: number; fileId: number | null; extension: string; customerName: string | null;
  createdAt: string; secondsLeft: number | null; meAnsweredAt: string | null; custAnsweredAt: string | null; endedAt: string | null; durationSeconds: number | null;
  cdr: boolean; recording: 'processing' | 'ready' | 'none'; eventId: number | null; active: boolean; needsResult: boolean; resultSaved: boolean;
  resultOutcome: string | null; prefill: 'answered' | 'no_answer' | null; oneTap: boolean; errorCode: string | null };
export type VcMe = { on: boolean; extension?: string | null; call?: VcCall | null; timeoutSeconds?: number };
export type VcHistItem = { kind: 'voip' | 'simotel' | 'manual'; id: string; at: string; status: 'answered' | 'no_answer' | 'busy' | null; direction?: string;
  durationSeconds: number | null; expert: string | null; fileId: number | null; recording: 'processing' | 'ready' | 'none'; playable: boolean; eventId: number | null;
  result: { label: string | null; note: string } | null; pending: boolean };

export const VC_ME_KEY = ['voip-call', 'me'] as const;
const OFF: VcMe = { on: false };
/** One request per session for users without the flag (404 → off, never polled again). While a call is live: every 1.5 s; else every 15 s. */
export const useVcMe = (enabled = true) => useQuery<VcMe>({
  queryKey: VC_ME_KEY, enabled, retry: false, staleTime: 1_000,
  queryFn: () => req<VcMe>('GET', '/voip-call/me').catch((e) => { if (e instanceof VcError && (e.status === 404 || e.status === 403 || e.status === 401)) return OFF; throw e; }),
  refetchInterval: (q) => { const d = q.state.data as VcMe | undefined; if (!d?.on) return false; return d.call?.active ? 1_500 : 15_000; },
  refetchIntervalInBackground: false,
});
export const vcApi = {
  start: (b: { customerId: number; fileId?: number | null }) => req<{ ok: true; call: VcCall }>('POST', '/voip-call/start', b),
  dismiss: (id: number) => req<{ ok: true }>('POST', `/voip-call/${id}/dismiss`, {}),
};
export const useVcHistory = (customerId: number | null | undefined, enabled: boolean) => useQuery<{ items: VcHistItem[] }>({
  queryKey: ['voip-call', 'history', customerId], enabled: enabled && Boolean(customerId), retry: false, staleTime: 10_000,
  queryFn: () => req('GET', `/voip-call/customers/${customerId}/history`) });
export const vcRefresh = (qc: QueryClient) => { void qc.invalidateQueries({ queryKey: ['voip-call'] }); };
export const vcAudioSrc = (eventId: number) => `/api/voip-call/calls/${eventId}/audio`;
