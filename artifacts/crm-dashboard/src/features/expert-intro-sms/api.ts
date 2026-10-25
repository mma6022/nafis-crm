import { useQuery } from '@tanstack/react-query';

/** crm-expert-intro-sms client (admin endpoints; plain fetch, no codegen). */
export type ExpertKind = 'closer' | 'qualifier' | 'trainee' | 'other';
export type ExpertRow = { salespersonId: number; name: string; active: boolean; userId: number | null; username: string | null; phone: string | null; kind: ExpertKind };
export type ExpertIntroView = {
  enabled: boolean; patternCode: string; blockedPhones: string[]; template: string; paramNames: { customer: string; name: string; phone: string };
  provider: string; fromNumber: string; ippanelEnabled: boolean; relayConfigured: boolean; sendWindow: string;
  traineeSalespersonIds: number[]; qualifierSalespersonId: number | null; experts: ExpertRow[]; stats: Record<string, number>;
};
export type IntroLogRow = { id: number; salespersonId: number | null; expertName: string | null; status: string; reason: string | null; createdAt: string };

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const EXPERT_INTRO_KEY = ['expert-intro-sms-settings'] as const;

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(body?.error || 'درخواست انجام نشد.');
  return body as T;
}
const send = (method: string, url: string, body?: unknown) => fetch(`${base()}/api${url}`, {
  method, credentials: 'include', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

export function useExpertIntroSettings(enabled = true) {
  return useQuery({ queryKey: EXPERT_INTRO_KEY, enabled, retry: false, queryFn: async () => json<ExpertIntroView>(await send('GET', '/expert-intro-sms/settings')) });
}
export async function saveExpertIntroSettings(patch: { enabled?: boolean; patternCode?: string; blockedPhones?: string }) {
  return json<ExpertIntroView>(await send('PUT', '/expert-intro-sms/settings', patch));
}
export async function testSendExpertIntro(body: { phone: string; salespersonId?: number; expertName?: string; expertPhone?: string }) {
  return json<{ ok: true; providerId: string; text: string }>(await send('POST', '/expert-intro-sms/test-send', body));
}
export function useUserContactPhones(enabled: boolean) {
  return useQuery({ queryKey: ['expert-intro-user-phones'], enabled, retry: false, staleTime: 30_000,
    queryFn: async () => json<{ userId: number; phone: string | null }[]>(await send('GET', '/expert-intro-sms/user-phones')) });
}
export async function saveUserContactPhone(userId: number, phone: string) {
  return json<{ userId: number; phone: string | null }>(await send('PUT', `/users/${userId}/customer-contact-phone`, { phone }));
}
export function useCustomerIntroLog(customerId: number) {
  return useQuery({ queryKey: ['expert-intro-log', customerId], retry: false, staleTime: 30_000,
    queryFn: async () => { const r = await send('GET', `/customers/${customerId}/expert-intro-sms`); return r.ok ? ((await r.json()) as IntroLogRow[]) : []; } });
}
export const introStatusLabel = (s: string) => ({ queued: 'در صف', sent: 'ارسال شد', skipped: 'ارسال نشد', failed: 'ناموفق', uncertain: 'نامشخص', test_sent: 'آزمایشی', test_failed: 'آزمایشی ناموفق' } as Record<string, string>)[s] ?? s;
/** 0912***4567 — phones are masked everywhere in this feature's UI except the admin's own input. */
export const maskPhone = (p: string | null | undefined) => (p && p.length >= 8 ? `${p.slice(0, 4)}***${p.slice(-4)}` : p ?? '');
export const formatIntroDate = (v: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(v));
