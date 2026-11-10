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
  resultOutcome: string | null; prefill: 'answered' | 'no_answer' | null; oneTap: boolean; errorCode: string | null; noanswerSmsSent?: boolean;
  custStatus?: string | null; billsec?: number | null; s132?: S132Call | null };
/** SIMOTEL-132 (flag.simotel132[.user.<id>]): present only while the flag is on for this user; absent → today's UI unchanged. */
export type S132Status = 'answered' | 'no_answer' | 'busy' | 'failed';
export type S132Call = { firstCall: boolean; phase: 'live' | 'waiting' | 'late' | 'first_form' | 'auto' | 'manual'; waitSeconds: number | null; waitTotalSeconds?: number; fast?: boolean;
  simStatus: S132Status | null; expertStatus: S132Status | null };
export type S132Bar = { callId: number; customerId: number; customerName: string | null; fileId: number | null; status: S132Status | null; simStatus: S132Status | null;
  expertStatus: S132Status | null; fixedStatus: S132Status | null; source: 'simotel' | 'expert' | null; at: string | null; durationSeconds: number | null; smsSent: boolean;
  /** SIMOTEL-132 c: time the «عدم پاسخ» SMS actually went; the summary's next step (answered only). */
  smsAt?: string | null; nextStep?: string | null; boardNext?: { kind: 'reminder' | 'file' | 'none'; at: string | null } | null;
  noteState: 'pending' | 'ready' | 'none' | null; note: string; noteEdited: boolean; canFix: boolean };
export type VcMe = { on: boolean; extension?: string | null; call?: VcCall | null; timeoutSeconds?: number; s132?: { last: S132Bar | null };
  /** SIMOTEL-132 B (flag.simotel132b[.user.<id>]): present only while B is on for this user. */
  s132b?: { busy: boolean; missed: number; noName: { id: number; createdAt: string }[] };
  /** VOIP-ANYWHERE (flag.voip_call_anywhere[.user.<id>]): present (true) only while on for this user (needs voip_call + extension + SIMOTEL-132 + a salesperson). */
  anywhere?: true;
  /** VOIP-ANYWHERE registrar scope (flag.voip_call.registrar_scope): true for a registrar — her rows come only from /voip-call/anywhere/own. */
  anywhereRegistrar?: true;
  /** VOIP-ANYWHERE single-button rule (same flag; VoIP on for this user): only the VoIP «تماس», «تماس سیستمی» hidden. */
  oneCallButton?: true;
  /** VOIP-TASK-HOLD (flag.voip_task_hold_v1[.user.<id>]): present only while on for this user. */
  vth?: { on: true; phase: 'idle' | 'in_call' | 'pending_status' | 'status_error' | 'final' | 'saved'; entry: 'file' | 'carousel' | 'reminder' | 'lead' | 'search' | null;
    queue: boolean; form: 'first_call' | 'reminder_result' | 'result' | null; reminderId: number | null; nextBlocked: boolean; saveLabel: 'ثبت نتیجه و کار بعدی' | 'ثبت نتیجه' } };
export type VcHistItem = { kind: 'voip' | 'simotel' | 'manual'; id: string; at: string; status: 'answered' | 'no_answer' | 'busy' | null; direction?: string;
  durationSeconds: number | null; expert: string | null; fileId: number | null; recording: 'processing' | 'ready' | 'none'; playable: boolean; eventId: number | null;
  result: { label: string | null; note: string } | null; pending: boolean; noanswerSms?: boolean;
  s132?: { sim: S132Status | null; expert: S132Status | null; fixed: S132Status | null; fixedAt: string | null; auto: boolean; note: string | null } };

export const VC_ME_KEY = ['voip-call', 'me'] as const;
const OFF: VcMe = { on: false };
/** One request per session for users without the flag (404 → off, never polled again). While a call is live: every 1.5 s; else every 15 s. */
export const useVcMe = (enabled = true) => useQuery<VcMe>({
  queryKey: VC_ME_KEY, enabled, retry: false, staleTime: 1_000,
  queryFn: () => req<VcMe>('GET', '/voip-call/me').catch((e) => { if (e instanceof VcError && (e.status === 404 || e.status === 403 || e.status === 401)) return OFF; throw e; }),
  refetchInterval: (q) => { const d = q.state.data as VcMe | undefined; if (!d?.on) return false;
    return d.call?.active || d.vth?.phase === 'pending_status' || d.vth?.phase === 'status_error' ? 1_500 : d.call?.s132?.phase === 'waiting' || d.s132?.last?.noteState === 'pending' || d.s132b?.busy || d.vth?.phase === 'final' ? 3_000 : 15_000; },
  refetchIntervalInBackground: false,
});
export const vcApi = {
  start: (b: { customerId: number; fileId?: number | null; entry?: 'file' | 'carousel' | 'reminder' | 'lead' | 'search'; reminderId?: number }) => req<{ ok: true; call: VcCall }>('POST', '/voip-call/start', b),
  dismiss: (id: number) => req<{ ok: true }>('POST', `/voip-call/${id}/dismiss`, {}),
  // SIMOTEL-132 (404 while the flag is off)
  status: (id: number, status: S132Status) => req<{ ok: true; phase: S132Call['phase']; bar: S132Bar | null; call: VcCall }>('POST', `/voip-call/${id}/status`, { status }),
  fix: (id: number, status: S132Status) => req<{ ok: true; bar: S132Bar | null }>('POST', `/voip-call/${id}/fix`, { status }),
  note: (id: number, note: string) => req<{ ok: true; bar: S132Bar | null }>('POST', `/voip-call/${id}/note`, { note }),
  closeBar: (id: number) => req<{ ok: true }>('POST', `/voip-call/${id}/close-bar`, {}),
};
export const useVcHistory = (customerId: number | null | undefined, enabled: boolean) => useQuery<{ items: VcHistItem[] }>({
  queryKey: ['voip-call', 'history', customerId], enabled: enabled && Boolean(customerId), retry: false, staleTime: 10_000,
  queryFn: () => req('GET', `/voip-call/customers/${customerId}/history`) });
/** SIMOTEL-132: is the next call with this customer their first call (only asked while me.s132 is present). */
export const useS132First = (customerId: number, enabled: boolean) => useQuery<{ firstCall: boolean }>({
  queryKey: ['voip-call', 's132-first', customerId], enabled: enabled && customerId > 0, retry: false, staleTime: 30_000,
  queryFn: () => req('GET', `/voip-call/customers/${customerId}/s132`) });
/** VOIP-ANYWHERE: which of these customers are the expert's own (rows that do not carry the owner). Only asked while me.anywhere. */
export const useVcOwnIds = (ids: number[], enabled: boolean) => {
  const key = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b).slice(0, 200);
  return useQuery<Set<number>>({
    queryKey: ['voip-call', 'anywhere-own', key.join(',')], enabled: enabled && key.length > 0, retry: false, staleTime: 60_000,
    queryFn: () => req<{ own: number[] }>('GET', `/voip-call/anywhere/own?ids=${key.join(',')}`).then((r) => new Set(r.own ?? [])).catch(() => new Set<number>()) });
};
export const vcRefresh = (qc: QueryClient) => { void qc.invalidateQueries({ queryKey: ['voip-call'] }); };
export const vcAudioSrc = (eventId: number) => `/api/voip-call/calls/${eventId}/audio`;

/* ---------------- SIMOTEL-132 B (flag.simotel132b only; every endpoint answers 404 while it is off) ---------------- */
export type S132bCls = 'own' | 'other' | 'support' | 'new' | 'unknown' | 'hidden';
export type S132bCard = { id: number; direction: 'incoming' | 'outgoing' | string; live: boolean; status: string; startedAt: string; endedAt: string | null;
  durationSeconds: number | null; extension: string | null; cls: S132bCls;
  customer: { id: number; name: string; priority: number | null; ownerName: string | null; lastCallAt: string | null } | null;
  phone: string | null; createdCustomer: number | null; saved: boolean; note: { state: string | null; text: string | null; edited: boolean } | null; firstForm: boolean };
export type S132bMissedRow = { key: string; kind: 'mine' | 'queue'; times: number; lastAt: string; cls: S132bCls;
  customer: { id: number; name: string; ownerName: string | null } | null; phone: string | null; task: number | null; redial: boolean };
export const S132B_LIVE_KEY = ['voip-call', 'b', 'live'] as const;
export const S132B_MISSED_KEY = ['voip-call', 'b', 'missed'] as const;
export const useS132bLive = (enabled: boolean, visible: boolean) => useQuery<{ cards: S132bCard[]; busy: boolean }>({
  queryKey: S132B_LIVE_KEY, enabled, retry: false, staleTime: 1_000,
  queryFn: () => req('GET', '/voip-call/b/live'),
  refetchInterval: visible ? 3_000 : false, refetchIntervalInBackground: false });
export const useS132bMissed = (enabled: boolean) => useQuery<{ rows: S132bMissedRow[]; count: number }>({
  queryKey: S132B_MISSED_KEY, enabled, retry: false, staleTime: 10_000, refetchInterval: 30_000, refetchIntervalInBackground: false,
  queryFn: () => req('GET', '/voip-call/b/missed') });
export const s132bApi = {
  close: (id: number) => req<{ ok: true }>('POST', `/voip-call/b/${id}/close`, {}),
  formOpened: (id: number) => req<{ ok: true }>('POST', `/voip-call/b/${id}/form-opened`, {}),
  name: (id: number, name: string) => req<{ ok: true; customer: { id: number; name: string; priority: number } }>('POST', `/voip-call/b/${id}/name`, { name }),
  note: (id: number, note: string) => req<{ ok: true; note: string }>('POST', `/voip-call/b/${id}/note`, { note }),
  completeName: (customerId: number, name: string) => req<{ ok: true }>('POST', `/voip-call/b/customers/${customerId}/name`, { name }),
};
