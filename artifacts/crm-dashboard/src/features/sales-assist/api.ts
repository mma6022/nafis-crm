/** «پیشنهاد دستیار فروش» client. Server: artifacts/api-server/src/routes/sales-assist.ts */
export type SaChip = { key: 'site_lead' | 'urgent' | 'from_kazemi' | 'repeat' | 'p1_stale'; label: string; tone?: 'red' };
export type SaItem = {
  customerId: number; displayName: string; priority: number | null; chips: SaChip[]; tier: 1 | 2 | 3; points: number;
  reason: { kind: string; text: string }; signals: string[]; rank: number; callForm: 'simple' | 'legacy';
  topOfList: { kind: string; dueAt: string; overdue: boolean; windowNow: boolean } | null;
  p1Stale?: { daysSince: number; red: boolean; quotaRank: number } | null;
};
export type SaP1Quota = { quota: number; redDays: number; noCallDays: number; remaining: number; red: number };
export type SaP1Settings = { quota: number; redDays: number; noCallDays: number };
export type SaReason = { key: 'busy' | 'customer_later' | 'bad_time' | 'other'; label: string; needsText: boolean };
export type SaResponse = {
  eligible: boolean; preview?: boolean; salespersonId?: number; scope?: string; now?: string; snoozeHours?: number; snoozeLabel?: string;
  items: SaItem[]; pool?: number; snoozed?: { customerId: number; displayName: string; until: string; reason: string }[];
  today?: { calls: number; notNow: number }; p1Quota?: SaP1Quota; reasons: SaReason[]; previewable: { id: number; name: string; scope: string }[];
};
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
  return body as T;
}
export const fetchSuggestions = (sp?: number | null) => req<SaResponse>(`/sales-assist/suggestions${sp ? `?salespersonId=${sp}` : ''}`);
export const logCall = (it: SaItem) => req<{ ok: true }>(`/sales-assist/suggestions/${it.customerId}/call`, { method: 'POST', body: JSON.stringify({ rank: it.rank, tier: it.tier, score: it.points }) });
export const notNow = (it: SaItem, reason: string, text?: string) => req<{ ok: true; snoozedUntil: string }>(`/sales-assist/suggestions/${it.customerId}/not-now`, { method: 'POST', body: JSON.stringify({ reason, text: text || undefined, rank: it.rank, tier: it.tier, score: it.points }) });
export const restore = (customerId: number) => req<{ ok: true }>(`/sales-assist/suggestions/${customerId}/restore`, { method: 'POST', body: '{}' });
export type SaSignal = { key: string; label: string; help: string; default: number };
export type SaSettings = { levels: Record<string, number>; snoozeHours: number };
export type SaWeights = { settings: SaSettings; defaults: SaSettings; signals: SaSignal[]; snoozeOptions: number[]; meta: { updatedAt: string | null }; previewable: { id: number; name: string }[];
  p1?: SaP1Settings; p1Defaults?: { quota: number; redDays: number }; p1Limits?: { quota: [number, number]; redDays: [number, number] } };
export const fetchWeights = () => req<SaWeights>('/sales-assist/weights');
export const saveWeights = (s: SaSettings & { p1?: { quota: number; redDays: number } }) => req<{ settings: SaSettings; p1?: SaP1Settings }>('/sales-assist/weights', { method: 'PUT', body: JSON.stringify(s) });
export type SaPreviewItem = { rank: number; customerId: number; displayName: string; priority: number | null; tier: number; points: number; signals: string[]; was: number };
export const previewWeights = (salespersonId: number, levels: Record<string, number>) => req<{ items: SaPreviewItem[] }>('/sales-assist/weights/preview', { method: 'POST', body: JSON.stringify({ salespersonId, levels }) });

/** Customers page tells the box that a call was saved (any outcome, «جواب نداد» included). */
export const SA_CALL_SAVED = 'sales-assist:call-saved';
export function notifySalesAssistCallSaved(customerId: number | null | undefined) {
  if (customerId) window.dispatchEvent(new CustomEvent(SA_CALL_SAVED, { detail: { customerId: Number(customerId) } }));
}
export const faNum = (n: number | string) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
