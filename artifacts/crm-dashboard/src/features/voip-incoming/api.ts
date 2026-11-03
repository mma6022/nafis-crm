/** SIMOTEL-456 client (design simotel v1.2 parts 4–6). Every endpoint answers 404 while its flag is off (or for the admin role, popup/missed):
 *  then nothing here renders and nothing is polled again. Phones come only from the server's own rules (another expert's customer → none). */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { useTabState } from '@/lib/tab-coordinator';

export class ViError extends Error { constructor(message: string, public status: number, public code: string, public details: any) { super(message); } }
export async function viReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ViError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? data?.result ?? '', data?.details ?? data);
  return data as T;
}
const offOn404 = <T,>(off: T) => (e: unknown) => { if (e instanceof ViError && [401, 403, 404].includes(e.status)) return off; throw e; };

export type ViTransfer = { extension: string | null; available: boolean; reason: string | null; ownerName: string };
export type ViCall = { eventId: number; state: 'ringing' | 'talking' | 'ended'; outcome: 'answered' | 'missed' | null; startedAt: string; endedAt: string | null;
  durationSeconds: number | null; recording: 'ready' | 'processing' | 'none'; kind: 'own' | 'unknown' | 'hidden' | 'other' | 'support'; support: boolean; extension: string | null;
  customer: { id: number; name: string } | null; file: { id: number; label: string } | null; phone: string | null; ownerName: string | null;
  lastCall: { at: string; text: string } | null; transfer: ViTransfer | null; canLog: boolean };
export type ViMe = { on: boolean; extension?: string; support?: boolean; calls?: ViCall[] };
export type ViMissedItem = { eventId: number; kind: 'own' | 'unowned' | 'unknown'; customer: { id: number; name: string } | null; phone: string; count: number; firstAt: string; lastAt: string;
  type: 'mine' | 'queue'; typeLabel: string; action: 'task' | 'callback' | 'redial' | 'none'; taskPos: number | null; callbackId: number | null; canRedial: boolean; redialReason: string | null; canNew: boolean };
export type ViMissed = { on: boolean; date?: string; count?: number; lock?: { code: string; reason: string } | null; voip?: boolean; items?: ViMissedItem[] };
export type ViLive = { userId: number; name: string; extension: string; support: boolean; roleLabel: string; state: 'idle' | 'ringing' | 'inuse' | 'pause' | 'unavailable' | 'unknown'; since: string | null };
export type ViRow = { userId: number; name: string; extension: string; calls: number; incoming: number; outgoing: number; answered: number; answerRate: number | null;
  talkSeconds: number; avgSeconds: number | null; missedIncoming: number };
export type ViReport = { from: string; to: string; rows: ViRow[]; live: ViLive[] };

export const VI_ME_KEY = ['voip-incoming', 'me'] as const;
export const VI_MISSED_KEY = ['voip-incoming', 'missed'] as const;
function useSessionUser() {
  const { data } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  return data?.user as { id?: number; role?: string; permissions?: string[] } | undefined;
}
/** Popup state. Never fetched for the admin role (the server 404s it too). With the change stream open: a 15 s safety poll; else 3 s. */
export function useViMe() {
  const u = useSessionUser(); const qc = useQueryClient(); const { visible } = useTabState();
  const enabled = Boolean(u?.id && u.role !== 'admin');
  const [stream, setStream] = useState(false);
  const q = useQuery<ViMe>({ queryKey: [...VI_ME_KEY, u?.id ?? 0], enabled, retry: false, staleTime: 1_000,
    queryFn: () => viReq<ViMe>('GET', '/voip-incoming/me').catch(offOn404<ViMe>({ on: false })),
    refetchInterval: (s) => { const d = s.state.data as ViMe | undefined; if (!d?.on) return false; return d.calls?.some((c) => c.state !== 'ended') ? 2_000 : stream ? 15_000 : 3_000; },
    refetchIntervalInBackground: false });
  const on = Boolean(q.data?.on);
  const liveN = q.data?.calls?.filter((c) => c.state !== 'ended').length ?? 0;
  useEffect(() => { if (on) void qc.invalidateQueries({ queryKey: ['voip-call', 'me'] }); }, [liveN, on, qc]); // the call button's «incoming» lock follows at once
  useEffect(() => {
    if (!on || !visible || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${import.meta.env.BASE_URL}api/voip/after-call/stream`, { withCredentials: true });
    es.onopen = () => setStream(true); es.onerror = () => setStream(false);
    es.onmessage = () => { setStream(true); void qc.invalidateQueries({ queryKey: VI_ME_KEY }); void qc.invalidateQueries({ queryKey: ['voip-call', 'me'] }); };
    return () => { es.close(); setStream(false); };
  }, [on, visible, qc]);
  return q;
}
export function useViMissed(enabled = true) {
  const u = useSessionUser();
  return useQuery<ViMissed>({ queryKey: [...VI_MISSED_KEY, u?.id ?? 0], enabled: enabled && Boolean(u?.id && u.role !== 'admin'), retry: false, staleTime: 5_000,
    queryFn: () => viReq<ViMissed>('GET', '/voip-incoming/missed').catch(offOn404<ViMissed>({ on: false })),
    refetchInterval: (s) => ((s.state.data as ViMissed | undefined)?.on ? 30_000 : false), refetchIntervalInBackground: false });
}
/** /call-center: report tab only while flag.voip_report is on and the server lets this user in (one probe; 404/403 → no tabs, page unchanged). */
export function useViReportOn() {
  return useQuery<boolean>({ queryKey: ['voip-incoming', 'report-on'], retry: false, staleTime: 60_000,
    queryFn: () => viReq<{ live: ViLive[] }>('GET', '/voip-incoming/live').then(() => true).catch(offOn404(false)) });
}
export const viRefresh = (qc: QueryClient) => { void qc.invalidateQueries({ queryKey: ['voip-incoming'] }); void qc.invalidateQueries({ queryKey: ['voip-call', 'me'] }); };
export const viApi = {
  act: (eventId: number, a: 'close' | 'later' | 'log') => viReq<{ ok: true }>('POST', `/voip-incoming/${eventId}/${a}`, {}),
  transfer: (eventId: number) => viReq<{ ok: true; extension: string; ownerName: string; howTo: string }>('POST', `/voip-incoming/${eventId}/transfer`, {}),
  newCustomer: (source: 'incoming' | 'missed', eventId: number, name: string) =>
    viReq<{ result: string; customer?: { id: number; name: string }; ownerName?: string; mine?: boolean; message?: string }>('POST', '/voip-incoming/new-customer', { source, eventId, name }),
  redial: (eventId: number) => viReq<{ ok: true }>('POST', `/voip-incoming/missed/${eventId}/call`, {}),
  report: (from: string, to: string) => viReq<ViReport>('GET', `/voip-incoming/report?from=${from}&to=${to}`),
};
const FA = new Intl.NumberFormat('fa-IR', { useGrouping: false });
export const fa = (n: number | string) => String(n).replace(/\d/g, (d) => FA.format(Number(d)));
export const hm = (iso: string | null | undefined) => iso ? new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '';
export const dayAt = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
export function dur(s: number | null | undefined): string { if (s == null) return '—'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h ? `${fa(h)} ساعت` : '', m ? `${fa(m)} دقیقه` : '', !h && r ? `${fa(r)} ثانیه` : ''].filter(Boolean).join(' و ') || '۰ ثانیه'; }
