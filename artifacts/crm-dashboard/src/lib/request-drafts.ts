// «در انتظار ثبت»: server-side drafts of the loan request wizard (api: routes/loan-request-drafts.ts).
// The server is the source of truth; lib/loan-draft.ts (localStorage) stays as the offline fallback.
import { useQuery } from '@tanstack/react-query';

export type DraftPayload = {
  planId?: number | null; planName?: string | null; conditionId?: number | null;
  amount?: string; duration?: string; ignoreCreditRank?: boolean; manualValues?: Record<string, string>;
};
export type RequestDraft = {
  id: number; customerId: number; customerName: string | null; customerPhone: string | null;
  status: string; source: 'crm' | 'portal'; step: number; stepLabel: string; totalSteps: number;
  payload: DraftPayload; planId: number | null; planName: string | null;
  feeChargeId: number | null; feeAmountToman: string | null; feePaidAt: string | null; feeByCustomer: boolean;
  paid: boolean; locked: boolean;
  salespersonId: number | null; salespersonName: string | null;
  createdByUserId: number | null; createdByName: string | null; updatedByName: string | null;
  createdAt: string; updatedAt: string; version: number;
  waitingHours: number; paidOver24h: boolean;
  autoDeleteAt: string | null; expiringSoon: boolean; daysUntilAutoDelete: number | null;
  creditFresh: boolean; creditCheckAt: string | null;
  applicationId: number | null; deletedAt: string | null; deleteReason: string | null;
  canContinue: boolean; canDelete: boolean;
};
/** Admin only (server-enforced): a paid filing fee with no case and no open draft. Read-only, computed at read time; never converted. */
export type OrphanFeeRow = {
  kind: 'orphan_fee'; chargeId: number; customerId: number; customerName: string | null; customerPhone: string | null;
  amountToman: string; paidAt: string; planId: number | null; planName: string | null; byCustomer: boolean; chargedByName: string | null;
  salespersonId: number | null; salespersonName: string | null; waitingHours: number; readOnly: true;
};
/** Old pre-registration case still at stage 'draft' (hidden from the case list). Display only. */
export type LegacyCaseRow = {
  kind: 'legacy_case'; applicationId: number; customerId: number; customerName: string | null; customerPhone: string | null;
  planId: number | null; planName: string | null; requestedAmount: string | null; durationMonths: number | null; status: string;
  createdAt: string; updatedAt: string; requestedByName: string | null; salespersonId: number | null; salespersonName: string | null;
  waitingHours: number; readOnly: true;
};
export type DraftList = { items: RequestDraft[]; total: number; seesAll: boolean; orphanFees?: OrphanFeeRow[]; legacyCases?: LegacyCaseRow[]; autoDelete?: boolean };
export type DraftCounts = { total: number; paid: number; paidOver24h: number; expiringSoon: number; mine: number; orphanFees?: number; legacyCases?: number; autoDelete?: boolean };

/** Keeps status and body (409 carries the server copy), unlike lib/goods-api. */
export class DraftHttpError extends Error {
  constructor(public status: number, public code: string, public data: any) { super(code || `HTTP ${status}`); }
  get offline() { return this.status === 0; }
}
async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'include', cache: 'no-store',
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new DraftHttpError(0, 'network', null); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new DraftHttpError(res.status, data?.code || data?.error || '', data);
  return data as T;
}

export const draftsApi = {
  list: (scope: 'mine' | 'all' = 'all', search = '') => call<DraftList>('GET', `/loan-request-drafts?scope=${scope}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`),
  counts: () => call<DraftCounts>('GET', '/loan-request-drafts/counts'),
  get: (id: number) => call<{ draft: RequestDraft }>('GET', `/loan-request-drafts/${id}`).then((r) => r.draft),
  byCustomer: (customerId: number) => call<{ draft: RequestDraft | null }>('GET', `/loan-request-drafts/by-customer/${customerId}`).then((r) => r.draft),
  create: (customerId: number, step: number, payload: DraftPayload) => call<{ draft: RequestDraft }>('POST', '/loan-request-drafts', { customerId, step, payload }).then((r) => r.draft),
  save: (id: number, version: number, step: number, payload: DraftPayload) =>
    call<{ draft: RequestDraft }>('PUT', `/loan-request-drafts/${id}`, { version, step, payload }, { 'If-Match': `"${version}"` }).then((r) => r.draft),
  remove: (id: number, reason: string) => call<{ ok: boolean }>('DELETE', `/loan-request-drafts/${id}`, { reason }),
};

/** A paid fee that already created a pre-registration case (stage «پیش‌نویس», hidden from the case list). */
export type OpenPreRegistration = { id: number; stage: string; status: string; planId: number | null; createdAt: string; feeChargeId: number | null; feePaid: boolean };
/** Resume guard: «ادامه» for such a customer opens that case (next step = primary contract), never the fee step again. */
export const openPreRegistrationFor = (customerId: number) =>
  call<{ application: OpenPreRegistration | null }>('GET', `/loan-applications/open-pre-registration?customerId=${customerId}`).then((r) => r.application);
/** Idempotency key of the filing-fee charge: one per server draft and plan (same on every tab/device), else one per tab. */
export const filingFeeIdempotencyKey = (draftId: number | null | undefined, customerId: number, planId: number) =>
  draftId ? `draft-${draftId}-plan-${planId}` : null;

export const DRAFTS_KEY = ['loan-request-drafts'] as const;
/** Mirrors the server: drafts belong to roles that can create requests (funder/accounting get 403). */
export const canUseDrafts = (user?: { role?: string; permissions?: string[] } | null) =>
  Boolean(user && (user.role === 'admin' || user.permissions?.includes('loan_applications.create')));

export function useDraftCounts(enabled: boolean) {
  return useQuery({ queryKey: [...DRAFTS_KEY, 'counts'], queryFn: draftsApi.counts, enabled, refetchInterval: 60_000, staleTime: 20_000, retry: (n, e) => !(e instanceof DraftHttpError && e.status === 403) && n < 2 });
}
export function useDraftList(enabled: boolean, scope: 'mine' | 'all', search: string) {
  return useQuery({ queryKey: [...DRAFTS_KEY, 'list', scope, search.trim()], queryFn: () => draftsApi.list(scope, search), enabled, refetchInterval: 30_000, placeholderData: (p) => p, retry: (n, e) => !(e instanceof DraftHttpError && e.status === 403) && n < 2 });
}

export const fa = (n: number) => n.toLocaleString('fa-IR');
export const faToman = (v?: string | null) => (v && /^\d+$/.test(v) ? `${BigInt(v).toLocaleString('fa-IR')} تومان` : '—');
/** HANDOFF §6: from the last save; <1 day in hours (grey), 0–2 days grey, 3–6 gold, ≥7 red. */
export function draftWait(hours: number): { text: string; tone: 'grey' | 'gold' | 'red' } {
  if (hours < 24) return { text: hours < 1 ? 'کمتر از ۱ ساعت' : `${fa(hours)} ساعت`, tone: 'grey' };
  const days = Math.floor(hours / 24);
  return { text: `${fa(days)} روز`, tone: days >= 7 ? 'red' : days >= 3 ? 'gold' : 'grey' };
}
export const tehranTime = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }) : '';
};
export const DELETE_REASONS = ['مشتری انصراف داد', 'درخواست تکراری', 'اشتباه در ثبت', 'مشتری واجد شرایط نیست'] as const;
export const draftHref = (d: Pick<RequestDraft, 'id' | 'customerId'>) => `/loan-applications?new=1&customerId=${d.customerId}&draftId=${d.id}`;
