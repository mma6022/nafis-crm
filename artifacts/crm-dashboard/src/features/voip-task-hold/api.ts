/** VOIP-TASK-HOLD (flag.voip_task_hold_v1[.user.<id>], default OFF) — Armita «تماس ویپ و حفظ کار جاری» v1.0.
 *  Absent `me.vth` (or vth.on !== true) → today's VoIP UI is unchanged. */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useVcMe, vcApi, VC_ME_KEY, type VcMe, type VcCall } from '@/features/voip-call/api';

export type VthEntry = 'file' | 'carousel' | 'reminder' | 'lead' | 'search';
export type VthPhase = 'idle' | 'in_call' | 'pending_status' | 'status_error' | 'final' | 'saved';
export type VthForm = 'first_call' | 'reminder_result' | 'result' | null;
export type VthEligWhy = 'registered' | 'assigned' | 'callback';
export type VthManualEndLine = { callId: number; at: string; expertName: string | null };
export type VthMe = {
  on: true; phase: VthPhase; entry: VthEntry | null; queue: boolean; form: VthForm;
  reminderId: number | null; nextBlocked: boolean; saveLabel: 'ثبت نتیجه و کار بعدی' | 'ثبت نتیجه';
  canManualEnd: boolean; manualEnd: boolean; manualEndedAt: string | null; manualEndExpert: string | null;
};
export type VthContext = {
  on: true; canCall: boolean; phoneVisible: boolean; notesWritable: boolean;
  eligibility: { allowed: boolean; why: VthEligWhy | null; reason: string } | null;
  otherOwner: { name: string | null; extension: string | null } | null;
  expert: { name: string | null; extension: string | null } | null;
  own: boolean; support: boolean;
  manualEnds?: VthManualEndLine[];
};
export type VcMeVth = VcMe & { vth?: VthMe };

class VthError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new VthError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '');
  return data as T;
}

export function vthOf(me?: VcMe | VcMeVth | null): VthMe | null {
  const v = (me as VcMeVth | undefined)?.vth;
  return v && v.on === true ? v : null;
}
export function useVth(): { me: VcMeVth | undefined; vth: VthMe | null; call: VcCall | null; on: boolean } {
  const q = useVcMe();
  const me = q.data as VcMeVth | undefined;
  const vth = vthOf(me);
  return { me, vth, call: me?.on ? me.call ?? null : null, on: Boolean(vth) };
}
export function useVthContext(customerId: number | null | undefined, enabled: boolean) {
  return useQuery<VthContext | null>({
    queryKey: ['voip-task-hold', 'context', customerId],
    enabled: enabled && Boolean(customerId), retry: false, staleTime: 15_000,
    queryFn: () => req<VthContext>('GET', `/voip-task-hold/context?customerId=${customerId}`).catch((e) => { if (e instanceof VthError && (e.status === 404 || e.status === 403)) return null; throw e; }),
  });
}
export const vthApi = {
  retry: (id: number) => req<{ ok: true; phase: VthPhase; final: boolean }>('POST', `/voip-task-hold/${id}/status-retry`, {}),
  result: (id: number, b: { outcome: 'answered' | 'no_answer' | 'follow_up'; note: string }) =>
    req<{ ok: true; stay: boolean; phase: 'saved'; entry: VthEntry | null; reminderId: number | null; callId: number; savedAt: string }>('POST', `/voip-task-hold/${id}/result`, b),
  manualEnd: (id: number) => req<{ ok: true; phase: VthPhase; manualEnd: true; endedAt: string; final: boolean; form?: VthForm; replayed?: boolean }>('POST', `/voip-task-hold/${id}/manual-end`, {}),
  start: (b: { customerId: number; fileId?: number | null; entry?: VthEntry; reminderId?: number }) => vcApi.start(b as any),
};
export const vthRefresh = (qc: QueryClient) => { void qc.invalidateQueries({ queryKey: ['voip-call'] }); void qc.invalidateQueries({ queryKey: ['voip-task-hold'] }); void qc.invalidateQueries({ queryKey: ['files-carousel'] }); void qc.invalidateQueries({ queryKey: ['daily-plan'] }); };
export { VthError, VC_ME_KEY };
