import { useQuery } from '@tanstack/react-query';

/** Team-sales (qualifier -> closer) client. Server computes priority; the client never decides it. */
export type TeamSalesConfig = {
  enabled: boolean; qualifierSalespersonId: number; closerSalespersonIds: number[]; noteMinLength: number;
  closerFirstCallWorkingHours: number;
};
export type NextCloser = { salespersonId: number; name: string; dueAt: string; dueLabel: string; workingHours: number };
export type PromoteResult = {
  customerId: number; closerSalespersonId: number; closerName: string; dueAt: string; dueLabel: string;
  callLogId: number; message: string;
};
export type CallResult = 'answered' | 'no_answer' | 'callback' | 'wrong_number';
export type SimpleAnswers = {
  mode: 'simple'; callResult: CallResult; callbackAt?: string | null;
  amountMillion?: number | null; urgency?: 'now' | 'month' | 'later' | 'curious' | null;
  docsReady?: 'all' | 'partial' | 'none' | null; creditRank?: string | null;
  checkStatus?: 'any' | 'none' | null; canPromissory?: 'yes' | 'no' | null; bouncedCheque?: 'yes' | 'no' | null;
};
export type QualifyResult = {
  callLogId: number;
  result: { priority: 1 | 2 | 3; outcome: string; nextActionAt: string | null; score: number | null; reasons: string[]; attempts: number };
  matches: Array<{ planId: number; planName: string; assumptions: string[]; amountFits: boolean }>;
  handoff: PromoteResult | null;
};

export class TeamSalesApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const hasPersian = (s: unknown): s is string => typeof s === 'string' && /[\u0600-\u06ff]/.test(s);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}/api${path}`, {
      credentials: 'include', ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch { throw new TeamSalesApiError('', 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new TeamSalesApiError(hasPersian(body?.error) ? body.error : hasPersian(body?.message) ? body.message : '', response.status);
  return body as T;
}

export const teamSalesConfigKey = ['team-sales-config'] as const;
export function useTeamSalesConfig(enabled: boolean) {
  return useQuery<TeamSalesConfig>({
    queryKey: teamSalesConfigKey, enabled, staleTime: 60_000, retry: false,
    queryFn: () => request<TeamSalesConfig>('/team-sales/config'),
  });
}
/**
 * Should «ثبت تماس» open the simple 3-step form instead of the legacy CallForm?
 * True for the qualifier (Kazemi) on his own in-progress customers with no priority, P2 or P3.
 */
export function usesSimpleForm(
  cfg: TeamSalesConfig | undefined,
  user: { salespersonId?: number | null } | undefined,
  customer: { salespersonId?: number | null; status?: string | null; priority?: number | null } | null | undefined,
): boolean {
  if (!cfg?.enabled || !user || user.salespersonId == null || !customer) return false;
  if (user.salespersonId !== cfg.qualifierSalespersonId) return false;
  return customer.salespersonId === cfg.qualifierSalespersonId && customer.status === 'in_progress' && customer.priority !== 1;
}
export const fetchNextCloser = () => request<NextCloser>('/sales/next-closer');
export const upgradePriority = (customerId: number, note: string) =>
  request<PromoteResult>(`/customers/${customerId}/upgrade-priority`, { method: 'POST', body: JSON.stringify({ note: note.trim() || null }) });
export const submitSimpleForm = (customerId: number, answers: SimpleAnswers, note: string) =>
  request<QualifyResult>(`/customers/${customerId}/team-sales/qualify`, { method: 'POST', body: JSON.stringify({ answers, note }) });

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]);
export const shortName = (name: string) => name.replace(/^(آقای|خانم)\s+/, '').trim();
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(d);
};
