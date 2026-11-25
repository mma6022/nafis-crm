import { useQuery } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
export type ShMe = { enabled: boolean; manager?: boolean; phoneAttach?: boolean; botName?: string; docMaxBytes?: number; legacyOffDays?: number; extraPhonesMax?: number; sendDelivery?: string; connectEnabled?: boolean; redirectEnabled?: boolean; legacyFinish?: boolean; baleFileMaxBytes?: number };
export type ShMessage = { id: number; kind: 'free' | 'plan'; planId: number | null; title: string; body: string; showToday: boolean; autoSend: boolean; isInitial?: boolean; sort: number };
export type ShPlan = { id: number; name: string; publicLabel: string; choiceLabel: string };
export type ShDoc = { id: number; title: string; description: string | null; fileType: 'pdf' | 'video' | 'image'; originalName: string; sizeBytes: number; planId: number | null; planName: string | null; createdAt: string; tooBig?: boolean };
export type ShPickRow = { id: number; name: string; phone: string; ownerName: string | null; mine: boolean; extras: string[] };
export type ShIdentity = { nationalCode: string | null; birthDate: string | null; registered: boolean; source: string | null; docs: { id: number; type: string; label: string; createdAt: string }[] };
export type ShSendRow = { id: number; status: string; at: string; title: string; planName: string | null; mine: boolean; failReason?: string | null; retryable?: boolean; source?: string; messageId?: number | null };
export type ShSendBlock = { error: string; message: string; expertName?: string | null };
export type ShToday = { customerId: number; customerName: string; expertName: string; identity: ShIdentity; reachable: boolean; botName: string; botLink: string | null; currentPlanId: number | null; plans: (ShPlan & { current: boolean; messages: ShMessage[]; docs: ShDoc[] })[]; free: ShMessage[]; sends: ShSendRow[]; sendBlock?: ShSendBlock | null; recentMessageIds?: number[]; baleFileMaxBytes?: number };
export type ShConnectView = { tokenSaved: boolean; tested?: boolean; hasKey: boolean; status: string; username: string | null; name: string | null; connectedAt: string | null; lastOkAt?: string | null };
export type ShRedirectPreview = { ready: boolean; disabledReason: string | null; tokenSaved: boolean; flagOn: boolean; alreadyDone: boolean; doneAt: string | null; recipientCount: number; recipients: { customerId: number; customerName: string; expertUserId: number; expertName: string; botId: number; chatRow: number }[]; perBot: { expertUserId: number; expertName: string; botId: number; count: number }[]; skipped: { reason: string; label: string; count: number }[]; etaMinutes: number; perMinute: number; text: string; button: string };
export type ShRedirectStatus = { campaign: { id: number; status: string; startedAt: string; finishedAt: string | null; recipientCount: number } | null; counts: { sent: number; queued: number; failed: number; cancelled: number }; failures: { customerId: number; customerName: string; reason: string }[] };

export const SH_ME = ['social-hub', 'me'] as const;
export const SH_MAX_BYTES = 200 * 1024 * 1024;
export const shApi = <T,>(path: string, method = 'GET', body?: unknown) => bbFetch<T>(`/social-hub${path}`, { method, ...(body !== undefined ? { body } : {}) });
export const shUpload = <T,>(file: File, meta: Record<string, unknown>) => bbFetch<T>('/social-hub/docs', { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Sh-Meta': encodeURIComponent(JSON.stringify(meta)) } });
export function useShMe(enabled = true) { return useQuery<ShMe>({ queryKey: SH_ME, queryFn: () => shApi('/me'), retry: false, staleTime: 60_000, enabled }); }
export const fa = (n: string | number | null | undefined) => String(n ?? '').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
export const faAmount = (n: number) => fa(n.toLocaleString('en-US').replace(/,/g, '٬'));
export const faDate = (d: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(d)); } catch { return ''; } };
export const faDateTime = (d: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)); } catch { return faDate(d); } };
export const fileSize = (n: number) => n >= 1024 * 1024 ? `${faAmount(Math.round(n / (1024 * 1024) * 10) / 10)} مگابایت` : `${faAmount(Math.ceil(n / 1024))} کیلوبایت`;
export const messageError = (e: unknown) => e instanceof Error ? e.message : 'انجام نشد؛ دوباره امتحان کنید.';
