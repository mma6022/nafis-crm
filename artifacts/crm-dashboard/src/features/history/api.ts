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
export const HX_REASON_MAX = 80;

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
