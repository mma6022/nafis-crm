import { useQuery } from '@tanstack/react-query';

/** «ثبت هوشمند» client (api-server lib/smart-filing.ts). */
export type SfStatus = 'queued' | 'running' | 'waiting_human' | 'ready_for_approval' | 'submitted' | 'approved' | 'rejected' | 'error' | 'cancelled';
export type SfJob = {
  id: number; jobType: 'training' | 'real'; applicationId: number; customerId: number; customerName: string | null; salespersonName: string | null;
  panelName: string | null; planId: number | null; planName: string | null; amountToman: string | null; durationMonths: number | null;
  status: SfStatus; statusLabel: string; stepLabel: string | null; progress: number; attempt: number; submitApprovedAt: string | null;
  finalSubmitAllowed: boolean; panelReference: string | null; createdAt: string; updatedAt: string; lastMessageAt: string | null;
  checklist: { items: { key: string; label: string; ok: boolean; blocking: boolean }[]; blocked: boolean; documents: number } | null;
  /** Whether Sarina's runner called the CRM API in the last 90 s (all traffic goes through the CRM server). */
  runner?: { online: boolean; lastSeenAt: string | null };
  permission?: { approver: 'manager' | 'expert'; status: string } | null;
};
export type SfPermStatus = 'needs_request' | 'needs_expert' | 'later' | 'pending' | 'approved' | 'rejected' | 'cancelled';
/** «اجازه‌ی استعلام» request (shots 33/33b/33c/40). can* flags are computed on the server for the signed-in user. */
export type SfPermission = {
  id: number; kind: 'credit_inquiry'; approver: 'manager' | 'expert'; status: SfPermStatus; stepLabel: string | null; costText: string | null;
  requestedAt: string; sentAt: string | null; remindedAt: string | null; decidedAt: string | null; decidedByName: string | null;
  remindAt: string | null; secondsToRemind: number | null;
  canSend: boolean; canRemind: boolean; canCancel: boolean; canLater: boolean; canDecide: boolean; canReturn: boolean;
} | null;
export type SfMessage = { id: number; author: 'runner' | 'user' | 'system'; userName: string | null; kind: string; body: string | null; data: unknown; stepLabel: string | null; createdAt: string; screenshotUrl: string | null };
export type SfCodeRequest = { id: number; target: 'ours' | 'customer'; prompt: string | null; requestedAt: string; expiresAt: string; secondsLeft?: number } | null;
export type SfPanel = { id: number; slug: string; name: string; baseUrl: string | null; username: string | null; hasPassword: boolean; passwordUpdatedAt: string | null; autoSubmit: boolean; active: boolean; plans: { id: number; name: string | null }[] };

export const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export class SfError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function sfFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`${base()}/api/smart-filing${path}`, {
    method: init?.method ?? 'GET', credentials: 'include',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new SfError((data as any).message || ERR[(data as any).error] || 'درخواست انجام نشد. دوباره تلاش کنید.', r.status, (data as any).error);
  return data as T;
}
const ERR: Record<string, string> = {
  forbidden: 'دسترسی ندارید.', job_not_found: 'کار پیدا نشد.', plan_not_linked: 'طرح این پرونده به پنل ازکی‌وام وصل نیست.',
  checklist_blocked: 'نام، کد ملی یا موبایل مشتری کامل نیست.', no_open_code_request: 'درخواست کد فعالی نیست.', permission_state: 'این درخواست دیگر باز نیست.', line_not_confirmed: 'اول تأیید کنید خط موبایل به نام خود مشتری است.',
};
export const fa = (n: number | string) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
export const money = (v: string | null) => { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return n ? `${n.toLocaleString('fa-IR')} تومان` : '—'; };
export const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tehran' }) : '—';
export const TONE: Record<SfStatus, string> = { queued: 'muted', running: 'info', waiting_human: 'warn', ready_for_approval: 'warn', submitted: 'info', approved: 'ok', rejected: 'bad', error: 'bad', cancelled: 'muted' };

export function useSfJobs() {
  return useQuery({ queryKey: ['smart-filing-jobs'], refetchInterval: 15_000, queryFn: () => sfFetch<{ jobs: SfJob[] }>('/jobs') });
}
export function useSfJob(id: number) {
  return useQuery({ queryKey: ['smart-filing-job', id], refetchInterval: 4_000, queryFn: () => sfFetch<{ job: SfJob; messages: SfMessage[]; codeRequest: SfCodeRequest; isAdmin: boolean; permission?: SfPermission }>(`/jobs/${id}`) });
}
export function useSfPanels(enabled: boolean) {
  return useQuery({ queryKey: ['smart-filing-panels'], enabled, queryFn: () => sfFetch<{ panels: SfPanel[]; keyConfigured: boolean }>('/panels') });
}
export function useSfEligibility(appId: number) {
  return useQuery({ queryKey: ['smart-filing-eligibility', appId], retry: false, queryFn: () => sfFetch<{ eligible: boolean; canCreate: boolean; panel: { id: number; name: string } | null; reason: string | null; latestJob: { id: number; status: SfStatus; statusLabel: string } | null; checklist: SfJob['checklist'] }>(`/eligibility/${appId}`) });
}
