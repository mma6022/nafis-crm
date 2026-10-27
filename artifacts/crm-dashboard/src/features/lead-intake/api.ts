/** crm-instagram-leads + urgent v1.1 client. Server: artifacts/api-server/src/routes/lead-intake.ts (counts / labels only, no phones). */
import { useQuery } from '@tanstack/react-query';

export type Opt = { key: string; label: string };
export type ReasonOpt = { code: string; label: string };
export type IntakeOptions = {
  leadSources: Opt[]; defaultLeadSource: string; ranks: Opt[]; leadSourceOtherMax: number; registrarNoteMax: number;
  owner: { salespersonId: number | null; name: string | null; byRule: boolean };
  urgentReasons: ReasonOpt[]; urgentOtherMax: number; clearReasons: ReasonOpt[]; clearNoteMax: number; canClearUrgent: boolean; intakeStartedAt: string | null;
};
export type UrgentFlag = { flaggedAt: string; flaggedBy: string | null; reason: string | null; reasonCode: string | null; attempts: number } | null;
export type UrgentClear = { at: string; auto: boolean; clearReasonCode: string | null; note: string | null; by: string | null; callOutcome: string | null; waitedMin: number | null } | null;
export type IntakeCard = { registrar: { userId: number; name: string }; registeredAt: string; leadSource: string; leadSourceLabel: string; leadSourceOther: string | null;
  rank: string; rankLabel: string; note: string | null; isNew: boolean; canEditRank: boolean } | null;
export type IntakeDetail = { customerId: number; card: IntakeCard; events: { id: number; kind: string; oldLabel: string; newLabel: string; actorLabel: string | null; createdAt: string }[];
  urgent: { isUrgent: boolean; flag: UrgentFlag; lastClear: UrgentClear }; canFlagUrgent: boolean; canClearUrgent: boolean };
export type Badge = { id: number; intake: { leadSource: string; leadSourceLabel: string; rank: string; rankLabel: string; registrarName: string | null; registeredAt: string; noteFirstLine: string | null; isNew: boolean } | null;
  urgent: { at: string | null; by: string | null; reason: string | null } | null };

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export async function liReq<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const b = body as { message?: string; error?: string }; throw new Error(b.message || (r.status === 403 ? 'این کار برای شما مجاز نیست.' : r.status === 404 ? 'پرونده پیدا نشد.' : `خطا (${r.status})`)); }
  return body as T;
}
export const FALLBACK_SOURCES: Opt[] = [
  { key: 'instagram', label: 'اینستاگرام' }, { key: 'referral', label: 'معرفی' }, { key: 'inbound_call', label: 'تماس ورودی' },
  { key: 'site', label: 'سایت' }, { key: 'other', label: 'سایر' }, { key: 'none', label: 'منبع ثبت نشده' }];
export function useIntakeOptions(enabled = true) {
  return useQuery({ queryKey: ['lead-intake', 'options'], enabled, staleTime: 60_000, retry: false, queryFn: () => liReq<IntakeOptions>('/lead-intake/options') });
}
export const detailKey = (id: number) => ['lead-intake', 'customer', id];
export function useIntakeDetail(id: number) {
  return useQuery({ queryKey: detailKey(id), enabled: id > 0, retry: false, queryFn: () => liReq<IntakeDetail>(`/lead-intake/customers/${id}`) });
}
export function useQueueBadges(ids: number[]) {
  const key = [...ids].sort((a, b) => a - b).join(',');
  return useQuery({ queryKey: ['lead-intake', 'badges', key], enabled: ids.length > 0, staleTime: 30_000, retry: false,
    queryFn: () => liReq<{ items: Badge[] }>(`/lead-intake/queue-badges?ids=${key}`).then((r) => new Map(r.items.map((b) => [b.id, b]))) });
}
export function useUrgentWaiting(enabled = true) {
  return useQuery({ queryKey: ['lead-intake', 'urgent-waiting'], enabled, staleTime: 30_000, retry: false, queryFn: () => liReq<{ count: number }>('/lead-intake/urgent-waiting') });
}
export const flagUrgent = (id: number, reasonCode: string, reasonText?: string) =>
  liReq<{ changed?: boolean; alreadyUrgent?: boolean }>(`/lead-intake/customers/${id}/urgent`, { method: 'POST', body: JSON.stringify({ reasonCode, reasonText }) });
export const clearUrgent = (id: number, clearReasonCode: string, clearNote?: string) =>
  liReq<{ changed?: boolean }>(`/lead-intake/customers/${id}/urgent/clear`, { method: 'POST', body: JSON.stringify({ clearReasonCode, clearNote }) });
export const setRank = (id: number, rank: string) => liReq(`/lead-intake/customers/${id}/rank`, { method: 'PATCH', body: JSON.stringify({ rank }) });
export const faNum = (n: number) => n.toLocaleString('fa-IR');
export const faWhen = (iso: string | null | undefined) => { if (!iso) return ''; try { return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(toUtc(iso))); } catch { return iso; } };
/** SQLite "YYYY-MM-DD HH:MM:SS" (no zone) is UTC. */
export const toUtc = (iso: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
