import { useQuery } from '@tanstack/react-query';
import { TeamSalesApiError } from '@/features/team-sales/api';

export type HxCall = { id: number; at: string; result: string; tone: string; note: string | null; by: string | null };
export type HistorySummary = {
  customerId: number; priority: number | null; status: string; callCount: number; firstCall: boolean;
  fileStatus: string; fileTone: string; nextStep: { text: string; at: string } | null; calls: HxCall[];
  consultations: { count: number; lastAt: string | null; note: string | null } | null; ask: string[];
  isP1: boolean; upgradedByExpert: boolean; canUpgrade: boolean; handoff: boolean;
};
export type UpgradeResult = { customerId: number; priority: 1; kept: boolean; message: string; closerName?: string; salespersonName?: string; dueLabel?: string };
/** NOTES-NOMAX: no maximum on the upgrade reason. */
export const HX_REASON_MAX: number | null = null;

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const fa = (s: unknown) => typeof s === 'string' && /[\u0600-\u06ff]/.test(s);
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(`${base()}/api${path}`, { credentials: 'include', ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined }); }
  catch { throw new TeamSalesApiError('', 0); }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new TeamSalesApiError(fa(body?.error) ? body.error : '', r.status, body?.transferCheck ?? null);
  return body as T;
}
export const historyKey = (id: number) => ['history-summary', id] as const;
export function useHistorySummary(customerId: number | null | undefined, enabled = true) {
  return useQuery<HistorySummary>({
    queryKey: historyKey(Number(customerId)), enabled: Boolean(customerId) && enabled, retry: false, staleTime: 15_000,
    queryFn: () => req<HistorySummary>(`/customers/${customerId}/history-summary`),
  });
}
/** Armita «فاز ۲»: POST …/priority { level:1, reason } — reason ≤80 mandatory. */
export const promoteToP1 = (customerId: number, reason: string) =>
  req<UpgradeResult>(`/customers/${customerId}/priority`, { method: 'POST', body: JSON.stringify({ level: 1, reason: reason.trim() }) });

/* HISTORY-A v1.2: Today card 3 columns. */
export type CallHistory = { items: HxCall[]; nextBefore: number | null };
export type FileCard = {
  customerId: number; name: string; phoneMasked: string; phone?: string | null; priority: number | null; status: string;
  source: 'first_call' | 'file' | null; baseId: number | null; updatedAt: string | null; changedFields: string[];
  answers: Record<string, any> | null; city: string | null; missing: string[]; missingCount: number; total: number; complete: boolean;
  canEdit: boolean; isP1: boolean; revertAdminOnly: boolean; adminLine: string;
};
export const callHistoryKey = (id: number) => ['call-history', id] as const;
export const fileCardKey = (id: number) => ['file-card', id] as const;
export function useCallHistory(customerId: number, enabled = true) {
  return useQuery<CallHistory>({ queryKey: callHistoryKey(customerId), enabled: Boolean(customerId) && enabled, retry: false, staleTime: 15_000,
    queryFn: () => req<CallHistory>(`/customers/${customerId}/call-history?limit=30`) });
}
export function useFileCard(customerId: number, enabled = true) {
  return useQuery<FileCard>({ queryKey: fileCardKey(customerId), enabled: Boolean(customerId) && enabled, retry: false, staleTime: 15_000,
    queryFn: () => req<FileCard>(`/customers/${customerId}/file-card`) });
}
export const saveFileCard = (customerId: number, answers: unknown) =>
  req<FileCard>(`/customers/${customerId}/file-card`, { method: 'POST', body: JSON.stringify({ answers }) });
