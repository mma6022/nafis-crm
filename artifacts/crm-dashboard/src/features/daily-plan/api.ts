/** crm-daily-plan «کارهای امروز» client (Armita v1.2). Everything is behind flag.daily_plan; while it is OFF the config says so and nothing else is called. */
import { useQuery } from '@tanstack/react-query';
import type { CqOutcome } from '@/features/call-queue/api';

export class DpError extends Error {
  status: number; code: string; details: any;
  constructor(message: string, status: number, code: string, details: any) { super(message); this.status = status; this.code = code; this.details = details; }
}
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && typeof data.message === 'string' && data.message) || (data && typeof data.error === 'string' && /[\u0600-\u06FF]/.test(data.error) ? data.error : '') || 'انجام نشد. دوباره تلاش کن.';
    throw new DpError(msg, res.status, data && typeof data.error === 'string' ? data.error : '', data?.details ?? null);
  }
  return data as T;
}
export type DpFlags = { daily_plan: boolean; assistant_full_scope: boolean; daily_plan_discipline: boolean };
export type DpSettings = { guardPct: number; waitMin: number; firstDayCapacity: number | null };
export type DpConfig = { flags: DpFlags; settings: DpSettings; ranges: Record<keyof DpSettings, [number, number]>; labels: Record<string, string>; typeLabels: Record<string, string>;
  moveReasons: Record<string, string>; limits: { moveMax: number; lastMove: string; start: string; close: string; moveTextMax: number; capReasonMax: number; capMax: number };
  eligible: boolean; manager: boolean; today: string; experts: { userId: number; salespersonId: number; name: string; assistantId: number; scope: string }[] };
export type DpItem = { id: number; customerId: number; name: string; phone?: string | null; priority: number | null; urgent: boolean; type: string; typeLabel: string; reason: string | null; keyNote: string | null;
  bucket: 'main' | 'extra' | 'outside'; source: string; label: string | null; status: 'pending' | 'current' | 'done' | 'moved' | 'undone' | 'transferred'; moveCount: number; movesLeft: number;
  movedTo: string | null; outcome: CqOutcome | null; doneAt: string | null };
export type DpState = 'not_started' | 'working' | 'finished' | 'waiting' | 'auto' | 'closed' | 'holiday' | 'empty' | string;
export type DpToday = { enabled: true; eligible: false } | { enabled: true; eligible: true; date: string; state: DpState; startsAt: string; closesAt: string; moveMax: number; lastMoveAt: string;
  moveReasons: { code: string; label: string }[]; mode?: 'assistant' | 'auto'; modeLabel?: string | null; assistantNote?: string | null;
  current: (DpItem & { callOpen: boolean; callId: number | null }) | null; upcoming: DpItem[]; moved: DpItem[]; done: DpItem[]; undone?: DpItem[]; transferred?: DpItem[];
  progress: { done: number; total: number; position: number; pct: number | null; extraDone?: number; outOfList?: number }; waitUntil: string | null;
  pendingCall?: { callId: number; customerId: number; customerName: string } | null };
export type DpStats = { main: number; mainDone: number; completionPct: number | null; extra: number; extraDone: number; outOfList: number; carried: number; autoFilled: number; moved: number; undone: number; transferred: number; backlog: boolean; capacity: number | null };
export type DpCap = { capacity: number | null; source: 'set' | 'first_day' | null; outOfGuard: boolean };
export type DpBoardExpert = { userId: number; salespersonId: number; name: string; assistant: { id: number; name: string; scope: string }; state: DpState; mode: string | null; modeLabel: string | null;
  capacity: DpCap; stats: DpStats | null; current: { name: string; typeLabel: string; label: string | null } | null; items: DpItem[] };
export type DpDayRow = { date: string; mode: string | null; label: string | null; final: boolean; capacity: number | null; main: number; mainDone: number; completionPct: number | null; extra: number; extraDone: number;
  outOfList: number; moved: number; undone: number; carried: number; autoFilled: number; transferred: number; backlog: boolean };
export type DpCapView = { salespersonId: number; nextDay: string; current: DpCap; settings: DpSettings; firstWrite: boolean;
  chart: { day: string; capacity: number | null; main: number | null; mainDone: number | null; completionPct: number | null; mode: string | null; label: string | null }[];
  history: { id: number; day: string; previous: number | null; requested: number; accepted: number | null; outcome: string; outOfGuard: boolean; label: string | null; reason: string; actorKind: string; actorName: string | null; createdAt: string }[] };
export type DpOverride = { ok: true; preview: boolean; date: string; previous: number | null; capacity: number; outOfGuard: boolean; label: string | null; guard: { maxAllowed: number | null; minAllowed: number | null; guardPct: number } };
export type DpCallSaved = { id: number; dailyPlan?: { kind: string; itemId: number; next: DpItem | null; state: DpState } };

export const dpApi = {
  config: () => req<DpConfig>('GET', '/daily-plans/config'),
  today: () => req<DpToday>('GET', '/daily-plans/today'),
  start: (itemId: number) => req<{ ok: true; callId: number; tel: string; reused: boolean }>('POST', `/daily-plans/items/${itemId}/start`, {}),
  returned: (callId: number) => req<{ ok: boolean }>('POST', `/daily-plans/calls/${callId}/returned`, {}),
  move: (itemId: number, b: { at: string; reason: string; text?: string }) => req<{ ok: true; movedTo: string; movesLeft: number }>('POST', `/daily-plans/items/${itemId}/move`, b),
  saveCall: (b: Record<string, unknown>) => req<DpCallSaved>('POST', '/calls', b),
  search: (q: string) => req<any>('GET', `/customers?search=${encodeURIComponent(q)}&purpose=incoming_call&limit=20`),
  board: (date?: string) => req<{ enabled: true; day: string; experts: DpBoardExpert[] }>('GET', `/daily-plans/board${date ? `?date=${date}` : ''}`),
  plan: (sp: number, date: string) => req<DpBoardExpert & { day: string }>('GET', `/daily-plans/${sp}/${date}`),
  report: (from?: string, to?: string) => req<{ enabled: true; from: string; to: string; note: string; experts: { userId: number; salespersonId: number; name: string; days: DpDayRow[]; average: number | null; averageDays: number; autoDays: number }[] }>(
    'GET', `/daily-plans/report?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  capacity: (sp: number) => req<DpCapView>('GET', `/capacity/${sp}`),
  override: (sp: number, date: string, b: { capacity: number; reason: string; confirm?: boolean }) => req<DpOverride>('POST', `/admin/capacity/${sp}/${date}/override`, b),
  settings: () => req<{ settings: DpSettings; flags: DpFlags }>('GET', '/admin/settings/daily-plan'),
  saveSettings: (b: Partial<DpSettings>) => req<{ ok: true; changed: number; settings: DpSettings }>('PUT', '/admin/settings/daily-plan', b),
};
export function useDpConfig(enabled = true) {
  return useQuery({ queryKey: ['daily-plan', 'config'], queryFn: dpApi.config, enabled, staleTime: 60_000, retry: false, refetchOnWindowFocus: true });
}
/** «کارهای امروز» replaces «صف تماس من» for this user (flag on + eligible expert). */
export const dpActive = (c: DpConfig | undefined) => Boolean(c?.flags.daily_plan && c.eligible);
export const dpManager = (c: DpConfig | undefined) => Boolean(c?.flags.daily_plan && c.manager);
export const STATE_FA: Record<string, string> = { not_started: 'هنوز شروع نشده', working: 'در حال کار', finished: 'لیست تمام شد', waiting: 'منتظر کار تکمیلی', auto: 'لیست خودکار', closed: 'روز بسته شد', holiday: 'تعطیل', empty: 'لیستی نیست' };
export function custList(d: any): { id: number; name: string; phone?: string | null; priority?: number | null; salespersonId?: number | null }[] {
  const arr = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.customers) ? d.customers : Array.isArray(d?.data) ? d.data : [];
  return arr.map((c: any) => ({ id: Number(c.id), name: String(c.name ?? c.fullName ?? `#${c.id}`), phone: c.phone ?? null, priority: c.priority ?? null, salespersonId: c.salespersonId ?? c.salesperson_id ?? null }));
}
