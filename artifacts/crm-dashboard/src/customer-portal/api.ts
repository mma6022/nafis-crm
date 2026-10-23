import type { CustomerPortalApplication } from '@workspace/api-client-react';
import type { PlanFinderRequest } from './plan-finder-answers';
import { rememberPaymentReturn } from './payment-return';

/**
 * Customer-only transport. All paths are scoped to /api/customer-portal and
 * deliberately do not reuse staff auth/session clients. Application fields
 * use the generated customer-portal contract.
 */
const BASE = '/api/customer-portal';

export class PortalApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}, base = BASE): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    credentials: 'include',
    headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    const message = typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message)
      ? body.message : response.status === 401 ? 'نشست شما پایان یافته است. دوباره وارد شوید.'
      : response.status === 403 ? 'اجازه انجام این عملیات را ندارید.'
      : response.status === 404 ? 'اطلاعات موردنظر پیدا نشد.'
      : 'ارتباط با سامانه برقرار نشد. دوباره تلاش کنید.';
    if (response.status === 403 && code === 'identity_required' && typeof window !== 'undefined') window.dispatchEvent(new Event('cp-identity-required'));
    if (response.status === 401 && path !== '/me' && path !== '/auth/otp/verify' && typeof window !== 'undefined') window.dispatchEvent(new Event('cp-session-expired'));
    throw new PortalApiError(message, response.status, code);
  }
  return body as T;
}

const json = (value: unknown) => JSON.stringify(value);
export type Profile = {
  id: number | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  mobile?: string | null;
  nationalCode?: string | null;
  birthDateJalali?: string | null;
  postalCode?: string | null;
  fatherName?: string | null;
  verificationStatus: string;
  verificationMessage?: string | null;
  identityReady: boolean;
};
export type LoanOption = {
  planId: number;
  name: string;
  bankName?: string | null;
  description?: string | null;
  maximumAmount?: string | number | null;
  minimumAmount?: string | number | null;
  allowedDurations?: number[];
  conditionId?: number | null;
  conditionName?: string | null;
  conditions?: Array<{
    id: number;
    name: string;
    description?: string | null;
    minimumAmount?: string | number | null;
    maximumAmount?: string | number | null;
    allowedDurations?: number[];
  }>;
  terms?: string | null;
  filingFeeToman?: string | number | null;
  contractTemplateId?: number | null;
  manualFields?: Array<{ variable: string; label: string; required: boolean; maxLength?: number | null }>;
};
export type PortalDocument = {
  id: number;
  mimeType?: string;
  documentType?: string;
  requirementKey?: string;
  label?: string;
  originalName?: string;
  status?: string;
  reviewReason?: string | null;
};
export type Application = CustomerPortalApplication & {
  manualValues?: Record<string, string> | null;
};
export type ConsultationMessage = {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  recommendations?: Array<{ planId: number; label?: string }>;
};
export type Consultation = { id: number; createdAt?: string };
function consultationMessage(value: unknown): ConsultationMessage {
  if (!value || typeof value !== 'object') throw new Error('پاسخ گفتگو نامعتبر است.');
  const message = value as Record<string, unknown>;
  if (typeof message.content !== 'string' || !['user', 'assistant'].includes(String(message.role))) {
    throw new Error('پاسخ گفتگو نامعتبر است.');
  }
  const plans = message.recommendedPlans;
  if (plans != null && !Array.isArray(plans)) throw new Error('پیشنهاد طرح نامعتبر است.');
  return {
    ...(message as ConsultationMessage),
    recommendations: (plans as Array<{ id: number; name: string }> | undefined)?.filter(
      plan => Number.isSafeInteger(plan.id) && plan.id > 0 && typeof plan.name === 'string',
    ).map(plan => ({ planId: plan.id, label: plan.name })) ?? [],
  };
}
export type CreditCheck = { id: number; status: string; createdAt?: string; expiresAt?: string; message?: string };
export type Wallet = { cashBalanceToman: string | number; creditBalanceToman: string | number };
export type WalletTransaction = {
  id: number; walletType: 'cash' | 'credit'; kind: string; amountToman: string;
  direction: 'in' | 'out'; createdAt: string; description: string;
};
export type WalletTransactionPage = { items: WalletTransaction[]; nextCursor: string | null };
export type TransferRecipient = { recipientToken: string; recipientName: string; amountToman: string; expiresAt: string };
export type CashTransferReceipt = { id: number; status: 'completed'; amountToman: string; cashBalanceToman: string; recipientName: string };
export type Fee = { chargeId: number; planId?: number; amountToman?: string | number; status?: string };

// Only normalize documented envelope variants here; missing data remains an error,
// never a fabricated empty collection or success.
function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    if (Array.isArray(data.items)) return data.items as T[];
    if (Array.isArray(data[key])) return data[key] as T[];
  }
  throw new Error('ساختار پاسخ سامانه با نسخه فعلی پرتال سازگار نیست.');
}
function loanOption(value: unknown): LoanOption {
  if (!value || typeof value !== 'object') throw new Error('اطلاعات طرح دریافتی معتبر نیست.');
  const plan = value as Record<string, unknown>;
  const validAmount = (amount: unknown) => amount == null || /^\d+$/.test(String(amount));
  if (!Number.isSafeInteger(plan.planId) || Number(plan.planId) <= 0 || typeof plan.name !== 'string'
    || !Array.isArray(plan.conditions) || !Array.isArray(plan.allowedDurations) || !Array.isArray(plan.manualFields)
    || !validAmount(plan.minimumAmount) || !validAmount(plan.maximumAmount) || !validAmount(plan.filingFeeToman)
    || !plan.allowedDurations.every(months => Number.isSafeInteger(months) && months > 0)
    || !plan.conditions.every(condition => {
      if (!condition || typeof condition !== 'object') return false;
      const item = condition as Record<string, unknown>;
      return Number.isSafeInteger(item.id) && typeof item.name === 'string'
        && validAmount(item.minimumAmount) && validAmount(item.maximumAmount)
        && Array.isArray(item.allowedDurations) && item.allowedDurations.every(months => Number.isSafeInteger(months) && months > 0);
    })
    || !plan.manualFields.every(field => {
      if (!field || typeof field !== 'object') return false;
      const item = field as Record<string, unknown>;
      return typeof item.variable === 'string' && !!item.variable && typeof item.label === 'string'
        && typeof item.required === 'boolean' && (item.maxLength == null || Number.isSafeInteger(item.maxLength));
    })) throw new Error('شرایط یا فیلدهای قرارداد طرح از سرور به‌درستی دریافت نشد.');
  return plan as LoanOption;
}

export type ChatThread = { customerId: number; expertName: string | null; expertOnline: boolean; unreadCount: number };
export type ChatMessage = { id: number; customerId: number; senderType: 'customer' | 'staff'; senderId?: number; senderName: string | null; text: string | null; kind: 'text' | 'image' | 'audio' | 'file'; fileName: string | null; mimeType: string | null; fileSize: number | null; fileUrl: string | null; createdAt: string; clientId: string | null };
export type ChatPage = { items: ChatMessage[]; nextCursor: number | string | null; lastReadId: number | null };
export type PlanFinderMatch = { plan: { id: number; name: string; bankName?: string | null; filingFeeToman: string; principalAmount?: string | null }; status: 'eligible' | 'needs_review' | 'not_eligible'; customerMaximumAmount?: string | null; failedRequirements: string[]; missingInformation: string[] };
export type PlanFinderMatches = PlanFinderMatch[];
export type IntakeStatus = { creditValid: boolean; creditRank: string | null; planEligible: boolean; feeChargeId: number | null; filingFeeToman: string;
  existingApplicationId?:number|null;requiredDocumentTypes?:string[];
  verification: { postalOk: boolean; sanaOk: boolean; postalAnswered: boolean; sanaAnswered: boolean; inquiryAttempted?:boolean; postalCode: string | null }; documentsComplete: boolean; documentsPreviouslyApproved: boolean; canSubmit: boolean };
export const portalApi = {
  requestOtp: (mobile: string) => request<unknown>('/auth/otp/request', { method: 'POST', body: json({ mobile }) }),
  verifyOtp: (mobile: string, code: string) => request<{ authenticated: boolean; mobile: string; customerId: number | null; profileComplete: boolean; identityReady?: boolean }>('/auth/otp/verify', { method: 'POST', body: json({ mobile, code }) }),
  logout: () => request<unknown>('/auth/logout', { method: 'POST' }),
  me: async () => {
    const result = await request<{ authenticated: boolean; mobile: string; mobileVerified: boolean; customer: (Omit<Profile, 'verificationStatus'> & { birthDate?: string | null }) | null; profileComplete: boolean; verificationStatus: string; identityReady?: boolean }>('/me');
    if (!result.authenticated) throw new PortalApiError('نشست شما پایان یافته است.', 401);
    const identityReady = result.identityReady === true;
    const c = result.customer;
    return {
      id: c?.id ?? null,
      mobile: result.mobile,
      verificationStatus: result.verificationStatus,
      verificationMessage: c?.verificationMessage ?? null,
      identityReady,
      ...(identityReady && c ? { name: c.name, firstName: c.firstName, lastName: c.lastName, nationalCode: c.nationalCode, postalCode: c.postalCode, fatherName: c.fatherName, birthDateJalali: c.birthDate ?? null } : {}),
    } as Profile;
  },
  updateProfile: (data: Pick<Profile, 'name' | 'nationalCode' | 'birthDateJalali' | 'postalCode' | 'fatherName'>) =>
    request<{ customer: Profile; profileComplete: boolean }>('/profile', { method: 'PATCH', body: json({
      name: data.name, nationalCode: data.nationalCode, birthDate: data.birthDateJalali,
      postalCode: data.postalCode, fatherName: data.fatherName,
    }) }),
  identity: (nationalCode: string, birthDate: string) => request<{ identityReady: boolean; customerId: number; checks: { shahkarLite: { ok: boolean }; personInfo: { ok: boolean } }; message?: string }>('/identity', { method: 'POST', body: json({ nationalCode, birthDate }) }),
  verifyIdentity: () => request<{ customerId: number; status: string; checks?: unknown; checkedAt?: string; error?: string }>('/verify', { method: 'POST' }),
  consultations: async () => list<Consultation>(await request<unknown>('/consultations'), 'consultations'),
  createConsultation: () => request<Consultation>('/consultations', { method: 'POST' }),
  messages: async (id: number) => list<unknown>(await request<unknown>(`/consultations/${id}/messages`), 'messages').map(consultationMessage),
  sendMessage: async (id: number, content: string) => {
    const result = await request<{ userMessage: unknown; assistantMessage: unknown }>(`/consultations/${id}/messages`, { method: 'POST', body: json({ content }) });
    return consultationMessage(result.assistantMessage);
  },
  options: async () => list<unknown>(await request<unknown>('/loan-options'), 'plans').map(loanOption),
  identityDocuments: async () => list<PortalDocument>(await request<unknown>('/identity-documents'), 'documents'),
  uploadIdentityDocument: (documentType: string, file: File) => {
    const data = new FormData(); data.append('documentType', documentType); data.append('file', file);
    return request<PortalDocument>('/identity-documents', { method: 'POST', body: data });
  },
  creditChecks: async () => list<CreditCheck>(await request<unknown>('/credit-checks'), 'checks'),
  startCreditCheck: () => request<CreditCheck>('/credit-checks', { method: 'POST' }),
  validateCreditOtp: (id: number, code: string) => request<CreditCheck>(`/credit-checks/${id}/validate`, { method: 'POST', body: json({ code }) }),
  renewCreditOtp: (id: number) => request<CreditCheck>(`/credit-checks/${id}/renew`, { method: 'POST' }),
  wallet: () => request<Wallet>('/wallet', { method: 'GET' }),
  walletTransactions: (cursor?: string) => request<WalletTransactionPage>(`/wallet/transactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  findTransferRecipient: (mobile: string, amountToman: string) => request<TransferRecipient>('/wallet/transfer-recipient', {
    method: 'POST', body: json({ mobile, amountToman }),
  }),
  transferCash: ({ idempotencyKey, ...data }: { recipientToken: string; amountToman: string; confirmed: true; idempotencyKey: string }) =>
    request<CashTransferReceipt>('/wallet/transfers', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: json(data) }),
  topUpAndPay: async (amountToman: string): Promise<{ paymentUrl: string }> => {
    const me = await portalApi.me();
    if (!me.id) throw new Error('حساب مشتری برای شارژ مشخص نیست.');
    rememberPaymentReturn(me.id);
    const cacheKey = `customer-wallet-checkout:${me.id}:${amountToman}`;
    let remembered: string | null = null;
    try { remembered = sessionStorage.getItem(cacheKey); } catch { /* storage may be disabled */ }
    const share = remembered ? { paymentUrl: remembered }
      : await request<{ paymentUrl: string }>('/wallet/top-up', { method: 'POST', body: json({ amountToman }) });
    const url = new URL(share.paymentUrl);
    const token = url.searchParams.get('token');
    const customerId = url.searchParams.get('customerId');
    if (url.protocol !== 'https:' || !token || customerId !== String(me.id) || url.searchParams.get('amountToman') !== amountToman)
      throw new Error('اطلاعات لینک شارژ معتبر نیست.');
    try { sessionStorage.setItem(cacheKey, share.paymentUrl); } catch { /* retry remains server-guarded */ }
    const query = new URLSearchParams({ customerId, amountToman });
    try {
      return await request<{ paymentUrl: string }>(`/wallet/share-links/${encodeURIComponent(token)}/start?${query}`, {
        method: 'POST', body: json({ confirmed: true }),
      }, '/api');
    } catch (error) {
      if (error instanceof PortalApiError && ['share_link_expired', 'share_link_not_found', 'payment_not_restartable'].includes(error.code ?? '')) {
        try { sessionStorage.removeItem(cacheKey); } catch { /* no storage */ }
      }
      throw error;
    }
  },
  topUp: (amountToman: string) => request<{ paymentUrl?: string }>('/wallet/top-up', { method: 'POST', body: json({ amountToman }) }),
  filingFee: (data: { planId: number; conditionId: number; requestedAmount: string; durationMonths: number }, idempotencyKey: string) => request<Fee>('/filing-fee', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: json(data),
  }),
  applications: async () => list<Application>(await request<unknown>('/applications'), 'applications'),
  activeApplications: async () => list<Application>(await request<unknown>('/applications?active=true'), 'applications'),
  application: (id: number) => request<Application>(`/applications/${id}`),
  createApplication: (data: { planId: number; conditionId: number; requestedAmount: string; durationMonths: number; feeChargeId: number; notes?: string }) =>
    request<Application>('/applications', { method: 'POST', body: json(data) }),
  editApplication: (id: number, data: { requestedAmount: string; durationMonths: number; manualValues: Record<string, string>; notes?: string }) =>
    request<Application>(`/applications/${id}`, { method: 'PATCH', body: json(data) }),
  uploadApplicationDocument: (id: number, requirementKey: string, file: File) => {
    const data = new FormData(); data.append('requirementKey', requirementKey); data.append('file', file);
    return request<PortalDocument>(`/applications/${id}/documents`, { method: 'POST', body: data });
  },
  chatThread: () => request<ChatThread>('/chat/thread'),
  chatMessages: (beforeId?: number) => request<ChatPage>(`/chat/messages${beforeId ? `?beforeId=${beforeId}` : ''}`),
  chatSend: (clientId: string, text: string, file?: File) => {
    if (file) { const d = new FormData(); d.append('clientId', clientId); d.append('text', text); d.append('file', file); return request<ChatMessage>('/chat/messages', { method: 'POST', body: d }); }
    return request<ChatMessage>('/chat/messages', { method: 'POST', body: json({ clientId, text }) });
  },
  chatRead: (lastMessageId: number) => request<unknown>('/chat/read', { method: 'POST', body: json({ lastMessageId }) }),
  presence: () => request<unknown>('/chat/presence', { method: 'POST', body: '{}' }),
  planFinderOptions: () => request<{ options: Array<{ fieldKey: string; value: string; label: string }> }>('/plan-finder/options'),
  planFinder: (body: PlanFinderRequest) => request<{ consultationId: number; matches: PlanFinderMatches }>('/plan-finder', { method: 'POST', body: json(body) }),
  intakeStatus: (planId: number) => request<IntakeStatus>(`/intake/status?planId=${planId}`),
  intakeVerify: (planId: number, postalCode: string) => request<{ customerId?: number; status: string; checks?: unknown; error?: string }>('/intake/verify', { method: 'POST', body: json({ planId, postalCode }) }),
};