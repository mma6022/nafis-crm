import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/goods-api';

export type CqFlag = 'result' | 'autoclose' | 'assistant_reminders' | 'queue' | 'modal' | 'hide_not_now' | 'p1_notify';
export type QueueGroup = 'due' | 'new' | 'p1' | 'assist';
export type CqOutcome = 'answered' | 'no_answer' | 'follow_up';
export type CqConfig = {
  flags: Record<CqFlag, boolean>; eligible: boolean; manager: boolean; userId: number; salespersonId: number | null;
  settings: { order: QueueGroup[]; newRedHours: number; p1StaleDays: number; naTemplate: string };
  limits: { oneLineMax: number; voidNoteMax: number; naTemplateMax: number };
  voidReasons: { key: string; label: string }[]; snoozeMinutes: number;
};
export type CqReminder = {
  id: number; customerId: number; customerName: string; phone: string | null; priority: number | null; subject: string; message: string; remindAt: string;
  source: string; snoozeUntil: string | null; snoozeUsed: boolean;
  sourceNote: { callId: number; text: string; at: string; author: string | null; span: { start: number; end: number; phrase: string } | null } | null;
};
export type QueueCard = { customerId: number; name: string; phone: string | null; priority: number | null; group: QueueGroup; also: QueueGroup[]; reason: string;
  at: string | null; late: boolean; reminder: CqReminder | null; lastCall: { at: string; text: string } | null };
export type QueueResp = { eligible: boolean; now: string; order: QueueGroup[]; counts: Record<QueueGroup, number>; total: number; cards: QueueCard[]; snoozed: CqReminder[]; settings?: { newRedHours: number; p1StaleDays: number } };
export type AfterSave = { found: false } | {
  found: true; callId: number; customerId: number; customerName: string; outcome: CqOutcome | null; naAttempt: number | null;
  closed: { id: number; remindAt: string; label: string }[]; created: { id: number; remindAt: string; label: string; kind: string }[];
  p1NoAnswer3: boolean; coldSuggest: boolean; naTemplate: string | null;
  suggestion: { phrase: string; start: number; end: number; remindAt: string; shifted: boolean; text: string } | null;
};
export type PreCall = { due: { id: number; remindAt: string; label: string; subject: string }[]; naAttemptIfNoAnswer: number; p1: boolean };
export type CqEvent = { id: number; kind: 'snooze' | 'void' | 'p1_no_answer_3'; at: string; salespersonName: string | null; customerId: number; customerName: string;
  reminderSubject: string | null; reminderAt: string | null; reason: string | null; note: string | null; sourceText: string | null; reopenAt: string | null; nextCallAt: string | null; seenAt: string | null };

export const cqApi = {
  config: () => api.get<CqConfig>('/call-queue/config'),
  queue: () => api.get<QueueResp>('/call-queue'),
  due: () => api.get<{ enabled: boolean; items: CqReminder[]; snoozed: CqReminder[]; total: number }>('/call-queue/due'),
  afterSave: (callId: number) => api.get<AfterSave>(`/call-queue/after-save?callId=${callId}`),
  preCall: (customerId: number) => api.get<PreCall>(`/call-queue/pre-call?customerId=${customerId}`),
  snooze: (id: number) => api.post<{ ok: true; until: string }>(`/call-queue/reminders/${id}/snooze`),
  void: (id: number, reason: string, note: string) => api.post<{ ok: true }>(`/call-queue/reminders/${id}/void`, { reason, note }),
  editDate: (id: number, remindAt: string) => api.patch<{ ok: true; remindAt: string; shifted: boolean }>(`/call-queue/reminders/${id}/date`, { remindAt }),
  accept: (callId: number, remindAt?: string) => api.post<{ ok: true; reminderId: number; remindAt: string }>(`/call-queue/suggestions/${callId}/accept`, remindAt ? { remindAt } : {}),
  reject: (callId: number) => api.post<{ ok: true }>(`/call-queue/suggestions/${callId}/reject`),
  settings: () => api.get<{ settings: CqConfig['settings']; defaults: CqConfig['settings']; flags: Record<CqFlag, boolean>; flagLabels: Record<CqFlag, string>; log: { id: number; key: string; oldValue: string | null; newValue: string; userId: number; at: string }[] }>('/call-queue/settings'),
  saveSettings: (b: Partial<CqConfig['settings']> | { reset: true }) => api.put<{ ok: true; changed: number }>('/call-queue/settings', b),
  events: (q: { kind?: string; salespersonId?: number; day?: string }) => api.get<{ day: string; items: CqEvent[]; counts: Record<string, number>; salespersons: { id: number; name: string }[] }>(
    `/call-queue/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString()}`),
  seen: (id: number) => api.post<{ ok: boolean }>(`/call-queue/events/${id}/seen`),
  createCall: (b: Record<string, unknown>) => api.post<{ id: number; callQueue?: unknown }>('/calls', b),
  baleSend: (customerId: number, text: string) => api.post<unknown>(`/bale/customers/${customerId}/send`, { text }),
};

/** One shared config query. While it is loading or failing everything behaves as if all flags were OFF. */
export function useCqConfig(enabled = true) {
  return useQuery({ queryKey: ['call-queue', 'config'], queryFn: cqApi.config, enabled, staleTime: 60_000, retry: false, refetchOnWindowFocus: true });
}
export const cqOn = (c: CqConfig | undefined, f: CqFlag) => Boolean(c?.eligible && c.flags[f]);
export const CQ_SAVED_EVENT = 'cq:call-saved';
export function announceCallSaved(callId: number | null | undefined, customerId: number) {
  if (!callId) return;
  window.dispatchEvent(new CustomEvent(CQ_SAVED_EVENT, { detail: { callId, customerId } }));
}

/* ---- Tehran helpers (fixed +03:30) ---- */
const OFF = 210 * 60_000;
export function tehranParts(d: Date) { const w = new Date(d.getTime() + OFF); return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), wd: w.getUTCDay() }; }
export const fromTehran = (y: number, m: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - OFF);
export function addTehranDays(base: Date, n: number, h: number, mi = 0) { const p = tehranParts(new Date(base.getTime() + n * 86_400_000)); return fromTehran(p.y, p.m, p.d, h, mi); }
export const faNum = (n: number | string) => String(n).replace(/\d/g, (x) => '۰۱۲۳۴۵۶۷۸۹'[Number(x)]);
export const faClock = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
export const faDay = (iso: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' }).format(new Date(iso));
export const faWhen = (iso: string) => `${faDay(iso)} ساعت ${faClock(iso)}`;
export const GROUP_FA: Record<QueueGroup, string> = { due: 'یادآور سررسیده', new: 'شماره‌ی جدید بی‌تماس', p1: 'اولویت ۱ بی‌تماس', assist: 'پیشنهاد دستیار فروش' };
