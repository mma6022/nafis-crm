import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/goods-api';

export type CqFlag = 'result' | 'autoclose' | 'assistant_reminders' | 'queue' | 'modal' | 'hide_not_now' | 'p1_notify'
  | 'call_lock' | 'discipline' | 'restrict_panel' | 'alerts' | 'signals' | 'transfer_check';
export type QueueGroup = 'due' | 'new' | 'p1' | 'assist';
export type QueueCardGroup = QueueGroup | 'urgent';
export type CqOutcome = 'answered' | 'no_answer' | 'follow_up';
export type CqConfig = {
  flags: Record<CqFlag, boolean>; eligible: boolean; manager: boolean; userId: number; salespersonId: number | null;
  settings: { order: QueueGroup[]; newRedHours: number; p1StaleDays: number; naTemplate: string };
  limits: { oneLineMax: number; voidNoteMax: number; naTemplateMax: number };
  voidReasons: { key: string; label: string }[]; snoozeMinutes: number;
  lockOn?: boolean; manualTypes?: { key: 'in_person' | 'bale'; label: string }[];
  restriction?: { restricted: boolean; overdue: number; threshold: number; leftToUnlock: number; customerIds: number[] } | null;
  discipline?: { onTimeMin: number; onTimeCapMin: number; restrictOverdue: number };
};
export type CqPending = { callId: number; customerId: number; customerName: string; phone: string | null; priority: number | null; urgent: boolean;
  linkIssuedAt: string; returnedAt: string | null; onTimeUntil: string; late: boolean };
export type DayStat = { day: string; crmCalls: number; onTime: number; onTimePct: number | null; overdue: number; nocall: number; score: number; ok: boolean; reasons?: string[] };
export type MyDiscipline = { enabled: true; today: DayStat; history: DayStat[]; streak: number; alertDays: number; note: string;
  settings: { newPct: number; newMaxOverdue: number; restrictOverdue: number; onTimeMin: number; onTimeCapMin: number };
  restriction: { restricted: boolean; overdue: number; threshold: number; leftToUnlock: number } | null; receive?: CqReceive } | { enabled: false; receive?: CqReceive };
/** R3 ds_ok / ds_out (flag.transfer_check). */
export type CqReceive = { ok: boolean; text: string };
export type DsSettings = { onTimeMin: number; onTimeCapMin: number; newPct: number; newMaxOverdue: number; restrictOverdue: number; alertDays: number;
  wReport: number; wOverdue: number; wNocall: number; dropPct: number; transferMode: 'warn' | 'block'; excludedReceivers: number[] };
export type TeamDiscipline = { enabled: false; experts: [] } | { enabled: true; day: string; note: string; settings: DsSettings;
  experts: { userId: number; salespersonId: number | null; name: string; today: DayStat; streak: number; restricted: boolean }[] };
export type CqTransferRow = { id: number; customerId: number; customerName: string | null; fromName: string | null; toSalespersonId: number; toName: string | null;
  actorName: string | null; source: string; mode: 'warn' | 'block'; outcome: 'ok' | 'override' | 'blocked'; override: boolean; overrideReason: string | null;
  onTimePct: number | null; overdue: number | null; reasons: string[]; createdAt: string };
export type CqTransfers = { enabled: boolean; items: CqTransferRow[]; counts?: Record<string, number> };
export type Signals = { enabled: false; items: [] } | { enabled: true; date: string; workday: boolean; dropPct: number; note: string;
  items: { kind: 'signal_manual_no_crm' | 'signal_crm_drop'; userId: number; name: string; customerId?: number; customerName?: string; at?: string; text: string; count?: number; avg5?: number }[] };
export type CqReminder = {
  id: number; customerId: number; customerName: string; phone: string | null; priority: number | null; subject: string; message: string; remindAt: string;
  source: string; snoozeUntil: string | null; snoozeUsed: boolean;
  sourceNote: { callId: number; text: string; at: string; author: string | null; span: { start: number; end: number; phrase: string } | null } | null;
};
export type QueueCard = { customerId: number; name: string; phone: string | null; priority: number | null; urgent?: boolean; group: QueueCardGroup; also: QueueGroup[]; reason: string;
  at: string | null; late: boolean; reminder: CqReminder | null; lastCall: { at: string; text: string } | null };
export type QueueResp = { eligible: boolean; now: string; order: QueueGroup[]; counts: Record<QueueCardGroup, number>; restricted?: { overdue: number; threshold: number; leftToUnlock: number }; total: number; cards: QueueCard[]; snoozed: CqReminder[]; settings?: { newRedHours: number; p1StaleDays: number } };
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
  startCall: (customerId: number, via: string) => api.post<{ ok: true; callId: number; tel: string; reused: boolean }>('/call-queue/calls/start', { customerId, via }),
  returned: (id: number) => api.post<{ ok: boolean }>(`/call-queue/calls/${id}/returned`),
  pending: () => api.get<{ enabled: boolean; pending: CqPending | null }>('/call-queue/pending'),
  myDiscipline: () => api.get<MyDiscipline>('/call-queue/discipline/me'),
  teamDiscipline: () => api.get<TeamDiscipline>('/call-queue/discipline/team'),
  dsSettings: () => api.get<{ settings: DsSettings; defaults: DsSettings; ranges: Record<string, [number, number]>; log: { id: number; key: string; oldValue: string | null; newValue: string; userId: number; at: string }[] }>('/call-queue/discipline/settings'),
  saveDs: (b: Partial<DsSettings> | { reset: true }) => api.put<{ ok: true; changed: number }>('/call-queue/discipline/settings', b),
  transfers: (outcome?: string) => api.get<CqTransfers>(`/call-queue/transfers${outcome ? `?outcome=${outcome}` : ''}`),
  signals: (date?: string) => api.get<Signals>(`/reports/discipline-signals${date ? `?date=${date}` : ''}`),
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

/* ---- R2 «قفل تماس»: every CRM call button goes through here while the lock is ON ---- */
export const CQ_PENDING_EVENT = 'cq:pending';
let cfgCache: CqConfig | undefined;
export const cqSetConfigCache = (c: CqConfig | undefined) => { cfgCache = c; };
export const cqLockActive = (c: CqConfig | undefined = cfgCache) => Boolean(c?.eligible && c.lockOn);
let lastIssued: { id: number; at: number } | null = null;
/** Records the first CRM return after a tel: link (focus / visibility), once per call. */
function watchReturn(id: number) {
  lastIssued = { id, at: Date.now() };
  const back = () => {
    if (!lastIssued || lastIssued.id !== id || document.visibilityState !== 'visible' || Date.now() - lastIssued.at < 3000) return;
    lastIssued = null; window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back);
    void cqApi.returned(id).catch(() => {}).finally(() => window.dispatchEvent(new CustomEvent(CQ_PENDING_EVENT)));
  };
  window.addEventListener('focus', back); document.addEventListener('visibilitychange', back);
}
export type DialResult = { ok: true } | { ok: false; error: string };
/**
 * Lock ON: asks the server for the call (423 = previous report missing / restricted panel), then opens the tel: link it returns.
 * Lock OFF (or not eligible): returns null so the caller keeps its own tel: behaviour unchanged.
 */
export async function cqDial(customerId: number | null | undefined, via: string): Promise<DialResult | null> {
  if (!cqLockActive() || !customerId) return null;
  try {
    const r = await cqApi.startCall(customerId, via);
    watchReturn(r.callId);
    window.dispatchEvent(new CustomEvent(CQ_PENDING_EVENT));
    // same as following a tel: link (an anchor click keeps the page's own tel: handling and the test kit's interception)
    const a = document.createElement('a'); a.href = r.tel; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    return { ok: true };
  } catch (e) {
    window.dispatchEvent(new CustomEvent(CQ_PENDING_EVENT, { detail: { blocked: true } }));
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'تماس باز نشد.' };
  }
}
/** onClick for an existing <a href="tel:…">: lock OFF → untouched; ON → prevent the raw link and go through cqDial. */
export function cqTelClick(e: { preventDefault: () => void }, customerId: number | null | undefined, via: string, onError?: (msg: string) => void): boolean {
  if (!cqLockActive() || !customerId) return false;
  e.preventDefault();
  void cqDial(customerId, via).then((r) => { if (r && !r.ok) (onError ?? ((m: string) => window.alert(m)))(r.error); });
  return true;
}
