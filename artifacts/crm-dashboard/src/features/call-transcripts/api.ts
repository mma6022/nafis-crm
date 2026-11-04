/** Call transcripts (Simotel part 3, design v1.1). Server returns 404 call_transcripts_off while flag.call_transcripts.ui is OFF. */
import { useQuery } from '@tanstack/react-query';

export class CtError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
export async function ctReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new CtError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '');
  return data as T;
}

export type TextState = 'no_recording' | 'waiting' | 'queued' | 'processing' | 'completed' | 'failed';
export type CtSummary = { state: string; subject: string | null; request: string | null; edited: boolean; revision: number; sourceHash: string | null; error: string | null };
export type CtRow = { eventId: number; callLogId: number | null; customerId: number | null; customerName: string | null; phone: string | null; direction: 'incoming' | 'outgoing' | string;
  status: string; startedAt: string; endedAt: string | null; durationSeconds: number | null; expertUserId: number | null; expertName: string | null; hasRecording: boolean;
  textState: TextState; textPhase: string | null; textError: string | null; attempts: number; nextAttemptAt: string | null; summary: CtSummary | null; flagged: boolean };
export type CtSegment = { speakerId: string; role: 'expert' | 'customer' | null; label: string; start: number; end: number; text: string };
export type CtTranscript = { audioSeparation: 'stereo_channels' | 'diarization' | null; roleSource: 'channel' | 'text' | 'manual' | 'none' | string; roleByName?: string | null; roleAt?: string | null; durationSeconds: number | null; speakers: { id: string; role: string | null; label: string }[]; segments: CtSegment[] };
export type CtCall = CtRow & { isManager: boolean; isViewer?: boolean; canEdit: boolean; canRetranscribe: boolean; recording: { externalId: string; from: string; to: string } | null;
  transcript: CtTranscript | null;
  /* CT-CHAT (flag.call_transcripts.chat): only present when the chat flag is ON for this user */
  chat?: boolean; canAssignRoles?: boolean; fullText?: string | null; transcriptAt?: string | null; simCall?: boolean; review: { flagged: boolean; note: string; updatedAt: string | null; updatedByName: string | null } | null };
export type CtReport = { from: string; to: string; total: number; page: number; pageSize: number; manager?: boolean; experts: { id: number; name: string }[]; rows: CtRow[] };
export type CtConfig = { enabled: boolean; manager?: boolean; viewer?: boolean; chat?: boolean };

export const useCtConfig = (enabled = true) => useQuery<CtConfig>({ queryKey: ['call-transcripts', 'config'], enabled, staleTime: 60_000, retry: false,
  queryFn: () => ctReq<CtConfig>('GET', '/call-transcripts/config').catch(() => ({ enabled: false })) });
export const useCustomerCtCalls = (customerId: number | null | undefined, enabled: boolean) => useQuery<{ calls: { eventId: number; callLogId: number | null; textState: TextState; hasRecording: boolean }[] }>({
  queryKey: ['call-transcripts', 'customer', customerId], enabled: enabled && Boolean(customerId), staleTime: 30_000, retry: false,
  queryFn: () => ctReq('GET', `/call-transcripts/customer/${customerId}/calls`) });

const FA = new Intl.NumberFormat('fa-IR', { useGrouping: false });
export const fa = (n: number | string) => String(n).replace(/\d/g, (d) => FA.format(Number(d)));
export const mmss = (s: number) => { const t = Math.max(0, Math.floor(s)); return fa(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`); };
export const durText = (s: number | null) => { if (!s || s <= 0) return null; const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? (r ? `${fa(m)} دقیقه و ${fa(r)} ثانیه` : `${fa(m)} دقیقه`) : `${fa(r)} ثانیه`; };
export const atText = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const dirText = (d: string) => (d === 'incoming' ? 'ورودی' : 'خروجی');
export const STATUS: Record<string, [string, string]> = { ANSWERED: ['پاسخ داد', 's'], 'NO ANSWER': ['پاسخ نداد', 'q'], BUSY: ['اشغال', 'g'] };
export const statusOf = (s: string): [string, string] => STATUS[s] ?? ['برقرار نشد', 'q'];
export const TXS: Record<TextState, [string, string]> = { completed: ['متن و خلاصه آماده', 's'], queued: ['در حال تبدیل به متن', 'b'], waiting: ['در حال تبدیل به متن', 'b'],
  processing: ['در حال تبدیل به متن', 'b'], failed: ['تبدیل به متن ناموفق', 'r'], no_recording: ['بدون ضبط', 'n'] };
export const PHASES = [['downloading', 'دریافت فایل'], ['cleaning', 'نویزگیری و بررسی کانال‌ها'], ['transcribing', 'تفکیک گویندگان و تبدیل گفتار']] as const;
export const phaseIndex = (p: string | null) => Math.max(0, PHASES.findIndex(([k]) => k === p));
export const txSub = (r: Pick<CtRow, 'textState' | 'textPhase'>) => r.textState === 'queued' || r.textState === 'waiting' ? 'در صف'
  : r.textState === 'processing' ? `گام ${fa(phaseIndex(r.textPhase) + 1)} از ۳` : '';
