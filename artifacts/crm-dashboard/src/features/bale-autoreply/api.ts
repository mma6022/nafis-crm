/** «پاسخ خودکار بله» (api-server lib/bale-autoreply.ts + the /bale/me/autoreply and /admin/bale/autoreply routes).
 *  Every switch defaults OFF; the server is the real gate (admin-only ON with typed «روشن», caps, hours, escalation, scope). */
import type { BaleChat } from '@/features/bale/api';

export type ArOwner = 'assistant' | 'expert';
export type ArState = 'asked' | 'needs_expert' | 'failed' | 'waiting' | 'unanswered' | 'expert' | 'assistant';
export type ArPair = {
  assistantId: number; slug: string; assistantName: string; label: string; expertUserId: number; expertName: string;
  enabled: boolean; active: boolean; readsEnabled: boolean; allowUnknown: boolean; allowPlanFile: boolean;
  perHour: number; perDay: number; replyWindowMin: number; stoppedReason: string | null; updatedAt: string | null; updatedBy: string | null;
  account: { status: string; session: string | null; mode: string } | null;
  sentLastHour: number; sentToday: number; handedToExpert: number; unknownChats: number;
  /** AR30: a non-masoud pair stays OFF until Mohammad approves it separately (server guard, 423 pair_needs_mohammad). */
  needsMohammad?: boolean; pendingQuestions?: number; learnedCount?: number;
};
export type ArHoliday = { id?: number; date: string; label: string | null };
export type ArSettings = { globalEnabled: boolean; dayStart: string; dayEnd: string; days: number[]; holdText: string; nightText: string; holidays: ArHoliday[];
  openNow: boolean; wakeConfigured: boolean; updatedAt: string | null; updatedBy: string | null; askTimeoutMin?: number; allowOtherPairs?: boolean };
export type ArItem = { kind: 'customer' | 'unknown'; id: number; customerId: number | null; name: string | null; label?: string; lastAt: string; lastText: string;
  lastDirection: 'in' | 'out'; lastBy: 'customer' | 'assistant' | 'expert'; lastKind: string | null; owner: ArOwner; ownerReason: string | null; failed: boolean; state: ArState; asked?: boolean };
export type ArMe = { paired: false } | { paired: true; pair: ArPair; settings: ArSettings; connected: boolean; list: ArItem[] };
export type ArAdmin = { settings: ArSettings; pairs: ArPair[] };
export type ArUnknownThread = { id: number; label: string; owner: ArOwner; ownerReason: string | null; ownerAt: string | null; firstAt: string; lastAt: string; readOnly?: boolean;
  messages: { id: number; direction: 'in' | 'out'; text: string | null; hasFile: boolean; status: string; kind: string | null; by: 'customer' | 'assistant' | 'expert'; byLabel: string; blockReason: string | null; createdAt: string; overlap?: boolean; source?: string | null }[] };
export type ArChat = Omit<BaleChat, "messages"> & {
  autoReply?: { label: string; on: boolean; owner: ArOwner; reason: string | null; at: string | null; by: string | null } | null;
  messages: (BaleChat['messages'][number] & { auto?: boolean; arKind?: string | null; overlap?: boolean; arSource?: string | null })[];
};

/** Tehran weekdays: 0 = شنبه … 6 = جمعه (server arParseDays). */
export const AR_DAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'] as const;
export const AR_TEXT_MAX = 600;
const ESC: Record<string, string> = { promise: 'قول یا تضمین', amount: 'مبلغ', date: 'تاریخ یا زمان', anger: 'ناراحتی یا شکایت', custom: 'واژه‌ی حساس' };
/** Why the conversation is with the expert (owner_reason codes from the server). */
export function arReasonFa(reason: string | null | undefined): string | null {
  const r = String(reason ?? '');
  if (r.startsWith('escalated:')) { const [, k, from] = r.split(':'); return `${from === 'draft' ? 'جواب پیشنهادی' : 'پیام مشتری'} دربارهٔ ${ESC[k] ?? 'موضوع حساس'} بود`; }
  return ({ expert_button: 'خودتان گفتگو را گرفتید', expert_app_reply: 'از اپ بله جواب دادید', expert_crm_reply: 'از CRM جواب دادید',
    stale_backlog: 'پیام قدیمی‌تر از ۲۴ ساعت بود', expert_giveback: 'به مسعود برگردانده شد', ask_timeout: 'سؤال مسعود بی‌جواب ماند' } as Record<string, string>)[r] ?? null;
}
export const AR_STOP_FA: Record<string, string> = { rate_limited: 'بله محدودیت ارسال گذاشت', account_banned: 'بله حساب را مسدود کرد', session_invalid: 'نشست بله از کار افتاد' };
export const arStopFa = (c: string | null) => c ? AR_STOP_FA[c] ?? 'خطای بله' : null;
export const AR_KIND_FA: Record<string, string> = { hold: 'پیام نگه‌دار · بدون تعهد', night: 'پیام شب · بدون تعهد', reply: '', plan_file: 'فایل طرح', plan: 'فایل طرح', answer: 'جواب کارشناس · از پنجره‌ی سؤال' };
export type ArFilter = 'all' | 'needs' | 'waiting' | 'expert';
export const AR_FILTERS: { key: ArFilter; label: (expert: string) => string; test: (s: ArState) => boolean }[] = [
  { key: 'all', label: () => 'همه', test: () => true },
  { key: 'needs', label: e => `نیاز به ${e}`, test: s => s === 'needs_expert' || s === 'failed' },
  { key: 'waiting', label: () => 'منتظر جواب', test: s => s === 'unanswered' || s === 'waiting' || s === 'asked' },
  { key: 'expert', label: e => `دست ${e}`, test: s => s === 'expert' },
];
/** Expert's short name for labels («کاظمی» from «پرهام کاظمی»). */
export const shortName = (n: string | null | undefined) => { const p = String(n ?? '').trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(' ') : p[0] || 'کارشناس'; };

/** AR30 source chips (bale_outbox.ar_source). */
export const AR_SOURCE_FA: Record<string, string> = { learned: 'جواب آموخته‌شده', expert_answer: 'جواب کارشناس' };
/** AR30 gold badge under a Masoud reply that went out before the expert's own Bale-app reply was seen. */
export const AR_OVERLAP_FA = 'مسعود پیش از دیده شدن جواب تو در اپ بله فرستاد · ثبت شد';
export const AR_LEARNED_MAX = 500;
export const AR_OTHER_PAIRS_CONFIRM = 'تأیید جدای محمد';
export type ArQuestion = { id: number; status: 'pending' | 'answered' | 'self' | 'expired' | 'cancelled'; customerId: number | null; chatId: number | null; customerName: string | null;
  question: string; summary: string | null; holdText: string; holdResult: string | null; assistantName: string | null; answer: string | null; saveLearned: boolean;
  learnedId: number | null; createdAt: string; answeredAt: string | null; escalatedAt: string | null; timeoutMin: number };
export type ArLearned = { id: number; expertUserId: number; assistantId: number; question: string; answer: string; active: boolean; useCount: number; lastUsedAt: string | null;
  sourceQuestionId: number | null; createdAt: string; updatedAt: string; updatedBy: string | null };
