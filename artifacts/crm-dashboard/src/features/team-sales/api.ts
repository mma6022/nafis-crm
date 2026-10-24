import { useQuery } from '@tanstack/react-query';
import type { PlanEvaluation } from './plan-reasons';

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
  /** 2 = first-call form with the guarantor step and plan selection (crm-call-form-plans). */
  formVersion?: 2;
  guarantorAvailable?: Tri | null; guarantorCheque?: Tri | null; gRank?: string | null;
};
export type Tri = 'yes' | 'no' | 'unknown';
/** Plan picked in the first-call form, snapshotted at submit time (list column, case box, result page). */
export type SuggestedPlan = {
  id: number; name: string; bank: string; max: number; status: 'fit' | 'depends'; conditionId?: number | string; reasons: string[];
};
export type FirstCallSummary = {
  id: number; createdAt: string; priority: number | null; note: string; actorName: string | null; selectedPlans: SuggestedPlan[];
  answers: {
    amountMillion: number | null; docsReady: string | null; urgency: string | null; creditRank: string | null;
    checkStatus: string | null; canPromissory: string | null; bouncedCheque: string | null;
    guarantorAvailable: Tri | null; guarantorCheque: Tri | null; gRank: string | null;
  };
};
export type QualifyResult = {
  callLogId: number;
  // priority null = «جواب نداد» before the last attempt: no priority, only the no-answer counter moved (form opens again).
  result: { priority: 1 | 2 | 3 | null; outcome: string; nextActionAt: string | null; score: number | null; reasons: string[]; attempts: number; maxAttempts?: number };
  matches: Array<{ planId: number; planName: string; assumptions: string[]; amountFits: boolean }>;
  handoff: PromoteResult | null;
  selectedPlans?: SuggestedPlan[];
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
  // Mohammad 2026-10-24 09:01: the form only exists to decide the priority, so it is for NO-priority customers only.
  // P1/P2/P3 (already prioritised) use the old call form; the «ارتقا به اولویت ۱» card is separate and unchanged.
  return customer.salespersonId === cfg.qualifierSalespersonId && customer.status === 'in_progress' && customer.priority == null;
}
/**
 * Qualifier's own in-progress customer that is not P1 yet: P1 is reached ONLY through «ارتقا به اولویت ۱»
 * (confirm dialog → POST /customers/:id/upgrade-priority, round-robin handoff), never by a plain priority edit.
 */
export function canUpgradeToP1(
  cfg: TeamSalesConfig | undefined,
  user: { salespersonId?: number | null } | undefined,
  customer: { salespersonId?: number | null; status?: string | null; priority?: number | null } | null | undefined,
): boolean {
  if (!cfg?.enabled || !user || user.salespersonId == null || !customer) return false;
  if (user.salespersonId !== cfg.qualifierSalespersonId) return false;
  return customer.salespersonId === cfg.qualifierSalespersonId && customer.status === 'in_progress' && customer.priority !== 1;
}
/** P2/P3 customers get a visible «ارتقا به اولویت ۱» button in the list and on the customer page. */
export const showsUpgradeButton = (...a: Parameters<typeof canUpgradeToP1>) => canUpgradeToP1(...a) && (a[2]?.priority === 2 || a[2]?.priority === 3);
export const fetchNextCloser = () => request<NextCloser>('/sales/next-closer');
export const upgradePriority = (customerId: number, note: string) =>
  request<PromoteResult>(`/customers/${customerId}/upgrade-priority`, { method: 'POST', body: JSON.stringify({ note: note.trim() || null }) });
export const submitSimpleForm = (customerId: number, answers: SimpleAnswers, note: string, selectedPlans?: number[]) =>
  request<QualifyResult>(`/customers/${customerId}/team-sales/qualify`, { method: 'POST',
    body: JSON.stringify(selectedPlans ? { answers, note, selectedPlans } : { answers, note }) });
/** Step 5: every active plan with fit / depends / no and the reasons (no writes). */
export const fetchPlanOptions = (customerId: number, answers: SimpleAnswers) =>
  request<{ plans: PlanEvaluation[] }>(`/customers/${customerId}/team-sales/qualify/plans`, { method: 'POST', body: JSON.stringify({ answers }) });
/** The list / detail APIs add these after their zod parse; read them through these helpers. */
export const suggestedPlansOf = (c: unknown): SuggestedPlan[] => {
  const v = (c as { suggestedPlans?: unknown } | null)?.suggestedPlans;
  return Array.isArray(v) ? (v as SuggestedPlan[]) : [];
};
export const firstCallOf = (c: unknown): FirstCallSummary | null => ((c as { firstCall?: FirstCallSummary | null } | null)?.firstCall ?? null);

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]);
export const shortName = (name: string) => name.replace(/^(آقای|خانم)\s+/, '').trim();
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(d);
};
