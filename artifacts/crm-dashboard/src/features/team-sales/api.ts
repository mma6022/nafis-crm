import { useQuery } from '@tanstack/react-query';
import type { PlanEvaluation } from './plan-reasons';

/** Team-sales (qualifier -> closer) client. Server computes priority; the client never decides it. */
export type TeamSalesConfig = {
  enabled: boolean; qualifierSalespersonId: number; closerSalespersonIds: number[]; noteMinLength: number;
  closerFirstCallWorkingHours: number;
};
export type NextCloser = { salespersonId: number; name: string; dueAt: string | null; dueLabel: string | null; workingHours: number;
  /** crm-kz-return: present when asked for a specific customer. HISTORY-A: 'self' = a closer upgrading their own customer (stays with them). */
  assignment?: 'previous_expert' | 'fair_split' | 'self'; self?: boolean; assignmentLabel?: string; transferCheck?: TransferCheck };
export type PromoteResult = {
  customerId: number; closerSalespersonId: number; closerName: string; dueAt: string | null; dueLabel: string | null;
  /** HOTFIX-73: true when a closer upgraded their own customer (no hand-off). */
  kept?: boolean;
  callLogId: number; message: string;
  assignment?: 'previous_expert' | 'fair_split'; assignmentLabel?: string;
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
  /** crm-no-plan-option: applicant military service, applicant / guarantor job (job_type codes or «نمی‌دونه»), city. */
  military?: Military | null; jobType?: string | null; gJobType?: string | null; city?: string | null;
  ssoRetiree?: 'self' | 'family' | 'none' | null; ssoRetireeRelation?: string | null;
  /** «هیچ طرحی به این مشتری نمی‌خوره» — never an automatic P1 (enforced on the server). */
  noPlanFit?: boolean;
};
export type Military = 'has_card' | 'no_card' | 'female' | 'unknown';
export type Tri = 'yes' | 'no' | 'unknown';
/** Plan picked in the first-call form, snapshotted at submit time (list column, case box, result page). */
export type SuggestedPlan = {
  id: number; name: string; bank: string; max: number; status: 'fit' | 'depends'; conditionId?: number | string; reasons: string[];
};
export type FirstCallSummary = {
  id: number; createdAt: string; priority: number | null; note: string; actorName: string | null; selectedPlans: SuggestedPlan[];
  noPlanFit?: boolean; noPlanNote?: string | null;
  answers: {
    amountMillion: number | null; docsReady: string | null; urgency: string | null; creditRank: string | null;
    checkStatus: string | null; canPromissory: string | null; bouncedCheque: string | null;
    guarantorAvailable: Tri | null; guarantorCheque: Tri | null; gRank: string | null;
    military?: string | null; jobType?: string | null; gJobType?: string | null; city?: string | null;
    ssoRetiree?: string | null; ssoRetireeRelation?: string | null;
  };
};
export type QualifyResult = {
  callLogId: number;
  // priority null = «جواب نداد» before the last attempt: no priority, only the no-answer counter moved (form opens again).
  result: { priority: 1 | 2 | 3 | null; outcome: string; nextActionAt: string | null; score: number | null; reasons: string[]; attempts: number; maxAttempts?: number };
  matches: Array<{ planId: number; planName: string; assumptions: string[]; amountFits: boolean }>;
  handoff: PromoteResult | null;
  selectedPlans?: SuggestedPlan[];
  noPlanFit?: boolean; noPlanNote?: string | null; cityWritten?: boolean;
};

/** crm-call-queue R3 «بررسی سپردن»: the receiver's live numbers (only with flag.transfer_check on). */
export type TransferCheck = {
  salespersonId: number; userId: number | null; name: string; eligible: boolean; excluded: boolean; ok: boolean;
  onTimePct: number | null; overdue: number; crmCalls: number; reasons: string[]; wayBack: string;
  pctSource?: 'today' | '7d' | 'unknown'; pctUnknown?: boolean;
  settings: { newPct: number; newMaxOverdue: number; mode: 'warn' | 'block' };
  canOverride: boolean; needReason: boolean; reasonError?: string;
};
export class TeamSalesApiError extends Error {
  constructor(message: string, public status: number, public transferCheck: TransferCheck | null = null) { super(message); }
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
  if (!response.ok) throw new TeamSalesApiError(hasPersian(body?.error) ? body.error : hasPersian(body?.message) ? body.message : '', response.status, body?.transferCheck ?? null);
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
/** HOTFIX-73: the user is a closer of the team-sales config and owns this customer. */
export function isCloserOwn(
  cfg: TeamSalesConfig | undefined,
  user: { salespersonId?: number | null } | undefined,
  customer: { salespersonId?: number | null } | null | undefined,
): boolean {
  if (!cfg?.enabled || !user || user.salespersonId == null || !customer) return false;
  return user.salespersonId !== cfg.qualifierSalespersonId && cfg.closerSalespersonIds.includes(user.salespersonId) && customer.salespersonId === user.salespersonId;
}
export function canUpgradeToP1(
  cfg: TeamSalesConfig | undefined,
  user: { salespersonId?: number | null } | undefined,
  customer: { salespersonId?: number | null; status?: string | null; priority?: number | null } | null | undefined,
): boolean {
  if (!cfg?.enabled || !user || user.salespersonId == null || !customer) return false;
  // HOTFIX-73: a closer may upgrade their OWN in-progress customer (stays with them; the server limits it to the locked experts).
  if (user.salespersonId !== cfg.qualifierSalespersonId) return isCloserOwn(cfg, user, customer) && customer.status === 'in_progress' && customer.priority !== 1;
  return customer.salespersonId === cfg.qualifierSalespersonId && customer.status === 'in_progress' && customer.priority !== 1;
}
/** P2/P3 customers get a visible «ارتقا به اولویت ۱» button in the list and on the customer page. */
export const showsUpgradeButton = (...a: Parameters<typeof canUpgradeToP1>) => canUpgradeToP1(...a) && (a[2]?.priority === 2 || a[2]?.priority === 3);
export const fetchNextCloser = (customerId?: number) =>
  request<NextCloser>(customerId ? `/sales/next-closer?customerId=${encodeURIComponent(customerId)}` : '/sales/next-closer');
/** HISTORY-A: `reason` (≤80) is mandatory for experts; the server records it in the priority history. */
export const upgradePriority = (customerId: number, note: string, transferOverrideReason?: string, reason?: string) =>
  request<PromoteResult>(`/customers/${customerId}/upgrade-priority`, { method: 'POST',
    body: JSON.stringify({ note: note.trim() || null, ...(reason?.trim() ? { reason: reason.trim() } : {}), ...(transferOverrideReason ? { transferOverrideReason } : {}) }) });
export const submitSimpleForm = (customerId: number, answers: SimpleAnswers, note: string, selectedPlans?: number[], noPlanNote?: string, transferOverrideReason?: string,
  manualOutcome?: 'answered' | 'no_answer' | 'off_or_busy') =>
  request<QualifyResult>(`/customers/${customerId}/team-sales/qualify`, { method: 'POST',
    body: JSON.stringify({ answers, note, ...(manualOutcome ? { call_result: manualOutcome } : {}), ...(selectedPlans ? { selectedPlans } : {}), ...(noPlanNote ? { noPlanNote } : {}),
      ...(transferOverrideReason ? { transferOverrideReason } : {}) }) });
/** Step 5: every active plan with fit / depends / no and the reasons (no writes). noPlanDefault = nothing fits or depends. */
export const fetchPlanOptions = (customerId: number, answers: SimpleAnswers) =>
  request<{ plans: PlanEvaluation[]; noPlanDefault?: boolean }>(`/customers/${customerId}/team-sales/qualify/plans`, { method: 'POST', body: JSON.stringify({ answers }) });
/** City autocomplete (existing customer city values) + the customer's current city for the prefill. */
export const fetchCities = (customerId: number, q: string) =>
  request<{ items: string[]; customerCity: string | null }>(`/team-sales/cities?customerId=${customerId}&q=${encodeURIComponent(q)}`);
/** crm-no-plan-option (14:51): «اطلاعات مشاوره» — Kazemi's answers stored on the customer, with history. */
export type ConsultProfileData = {
  jobType: string | null; guarantorAvailable: Tri | null; guarantorCheque: Tri | null; creditRank: string | null; gRank: string | null;
  gJobType: string | null; military: Military | null; city: string | null;
  selectedPlans: { id: number; name: string; status?: string | null }[]; noPlanFit: boolean; noPlanNote: string | null;
  urgency: string | null; formDate: string | null; submitterName: string | null;
};
export type ConsultProfileVersion = {
  id: number; source: 'first_call' | 'edit' | 'backfill'; data: ConsultProfileData | null; changedFields: string[];
  actorName: string | null; createdAt: string;
};
export type ConsultProfile = {
  latest: ConsultProfileVersion | null; versions: ConsultProfileVersion[];
  official: { rank: string; checkedAt: string } | null; canEdit: boolean;
};
export type ConsultEditable = 'jobType' | 'guarantorAvailable' | 'guarantorCheque' | 'creditRank' | 'gRank' | 'gJobType' | 'military' | 'city' | 'urgency';
export const consultProfileKey = (id: number) => ['consult-profile', id] as const;
export function useConsultProfile(customerId: number, enabled = true) {
  return useQuery<ConsultProfile>({
    queryKey: consultProfileKey(customerId), enabled: enabled && Number.isFinite(customerId) && customerId > 0, retry: false,
    queryFn: () => request<ConsultProfile>(`/customers/${customerId}/consult-profile`),
  });
}
export const editConsultProfile = (customerId: number, changes: Partial<Record<ConsultEditable, string | null>>) =>
  request<ConsultProfile & { changed: string[] }>(`/customers/${customerId}/consult-profile`, { method: 'PATCH', body: JSON.stringify({ changes }) });
/** «اعتبارسنجی سریع»: saves the national code only (no inquiry). 409 + code "confirm_replace" when a different code exists. */
export async function saveQuickCreditNationalCode(customerId: number, nationalCode: string, confirmReplace: boolean) {
  let response: Response;
  try {
    response = await fetch(`${base()}/api/customers/${customerId}/quick-credit/national-code`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nationalCode, confirmReplace }),
    });
  } catch { throw new TeamSalesApiError('', 0); }
  const body = await response.json().catch(() => null);
  if (response.status === 409 && body?.code === 'confirm_replace') return { needsConfirm: true as const };
  if (!response.ok) throw new TeamSalesApiError(hasPersian(body?.error) ? body.error : response.status === 409 ? 'این کد ملی برای مشتری فعال دیگری ثبت شده است.' : '', response.status);
  return { needsConfirm: false as const, changed: Boolean(body?.changed), identityChanged: Boolean(body?.identityChanged) };
}

/** The list / detail APIs add these after their zod parse; read them through these helpers. */
export const suggestedPlansOf = (c: unknown): SuggestedPlan[] => {
  const v = (c as { suggestedPlans?: unknown } | null)?.suggestedPlans;
  return Array.isArray(v) ? (v as SuggestedPlan[]) : [];
};
export const noPlanFitOf = (c: unknown): boolean => (c as { noPlanFit?: unknown } | null)?.noPlanFit === true;
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

/* crm-first-call-edit: «ویرایش» on «خلاصه‌ی تماس اول» / «اطلاعات مشاوره». The server decides access and priority. */
export type FirstCallEditChange = { field: string; old: unknown; new: unknown };
export type FirstCallEditEntry = {
  id: number; actorName: string | null; changed: FirstCallEditChange[]; priorityBefore: number | null; suggestedPriority: number | null;
  priorityAfter: number | null; sentToCloser: boolean; createdAt: string;
};
export type FirstCallEditInfo = { canEdit: boolean; canSend: boolean; sendBlockedReason: string | null; ownerIsCloser: boolean; edits: FirstCallEditEntry[] };
export type FirstCallEditResult = {
  editId: number | null; changed: FirstCallEditChange[]; suggestedPriority: 1 | 2 | 3; reasons: string[];
  priorityBefore: number | null; priorityAfter: number | null; priorityRaised: boolean; handoff: PromoteResult | null;
  selectedPlans: SuggestedPlan[]; noPlanFit: boolean; noPlanNote: string | null; noSuitablePlan: boolean; cityWritten: boolean;
};
export const firstCallEditInfoKey = (customerId: number) => ['first-call-edit-info', customerId] as const;
export function useFirstCallEditInfo(customerId: number, enabled = true) {
  return useQuery<FirstCallEditInfo>({
    queryKey: firstCallEditInfoKey(customerId), enabled: enabled && Number.isFinite(customerId) && customerId > 0, retry: false,
    queryFn: () => request<FirstCallEditInfo>(`/customers/${customerId}/team-sales/first-call/edit-info`),
  });
}
export const submitFirstCallEdit = (customerId: number, body: {
  answers: SimpleAnswers; note: string; selectedPlans?: number[]; noPlanNote?: string; send: boolean; baseId: number; transferOverrideReason?: string;
}) => request<FirstCallEditResult>(`/customers/${customerId}/team-sales/first-call/edit`, { method: 'POST', body: JSON.stringify(body) });

/* instant-credit-check v1 (Armita sales-shell v1.0.3 §4د): the call form's «اعتبارسنجی فوری» on its own /instant-credit-check routes (per-user flag; OFF = hidden + 403).
   The OTP is passed straight to validate and never kept by the caller. */
export type CreditCheckLite = { id: number; status: 'awaiting_otp' | 'processing' | 'report_generated' | 'failed'; nationalCode?: string | null;
  score: number | null; scoreLabel: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null; reused?: boolean };
export const fetchCustomerIdentity = async (customerId: number): Promise<{ nationalCode: string | null; phone: string | null }> => {
  const c = await request<{ nationalCode?: string | null; phone?: string | null }>(`/customers/${customerId}`);
  return { nationalCode: c.nationalCode ?? null, phone: c.phone ?? null };
};
export const listCreditChecks = (customerId: number) => request<CreditCheckLite[]>(`/instant-credit-check/customers/${customerId}/checks`);
export const startCreditCheck = (customerId: number, nationalCode: string) =>
  request<CreditCheckLite>(`/instant-credit-check/customers/${customerId}/checks`, { method: 'POST', body: JSON.stringify({ nationalCode, source: 'call_form', consent: true }) });
export const validateCreditOtp = (customerId: number, checkId: number, otp: string) =>
  request<CreditCheckLite>(`/instant-credit-check/customers/${customerId}/checks/${checkId}/validate`, { method: 'POST', body: JSON.stringify({ otp, source: 'call_form' }) });
export const renewCreditOtp = (customerId: number, checkId: number) =>
  request<CreditCheckLite>(`/instant-credit-check/customers/${customerId}/checks/${checkId}/renew`, { method: 'POST', body: JSON.stringify({ source: 'call_form' }) });
export const refreshCreditCheckStatus = (customerId: number, checkId: number) =>
  request<CreditCheckLite>(`/instant-credit-check/customers/${customerId}/checks/${checkId}/status`, { method: 'POST' });
/** Per-user flag flag.instant_credit_check.user.<id>; any error = OFF (step hidden). */
export function useIccEnabled() {
  const q = useQuery<{ enabled: boolean }>({ queryKey: ['instant-credit-check', 'me'], retry: false, staleTime: 60_000,
    queryFn: () => request<{ enabled: boolean }>('/instant-credit-check/me') });
  return q.data?.enabled === true;
}
