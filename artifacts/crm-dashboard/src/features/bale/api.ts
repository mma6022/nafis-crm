/** «حساب شخصی بله» staff client (api-server lib/bale.ts + lib/bale-outbox.ts). The server is the real gate for every rule. */
export { asFetch as baleFetch, asWhen as baleWhen, faNum } from '@/features/assistant/api';

export type BaleMode = 'off' | 'approve_first' | 'auto';
export type BaleAccount = { id: number; status: 'connected' | 'disconnected' | 'banned' | 'error'; mode: BaleMode; phoneMasked: string | null; connectedAt: string | null; lastSeenAt: string | null; lastError: string | null; disconnectedAt: string | null; hasSession: boolean; unknownOpen?: number };
export type BaleMe = {
  eligible: boolean; masterEnabled: boolean; ready: boolean; account: BaleAccount | null;
  flow: { step: 'code' | 'password'; expiresAt: string; phoneMasked: string; codeType: string } | null;
  startsLeft: number; remoteSignOut?: 'ok' | 'failed' | 'no_session';
};
export type BaleAdmin = {
  masterEnabled: boolean; keyReady: boolean; sidecar: { configured: boolean; reachable: boolean };
  /** Decision (b): UNVERIFIED until the test-SIM check; account_stop is the safe default. */
  peerBlock?: { mode: BalePeerBlockMode; verified: boolean };
  limits: { gapMinS: number; gapMaxS: number; perHour: number; perDay: number; newChatsPerDay: number; quietStart: string; quietEnd: string };
  experts: { userId: number; name: string; account: (BaleAccount & { user: { id: number; name: string } }) | null }[];
};
export type BalePeerBlockMode = 'account_stop' | 'conversation_pause';
export type BaleUnknownChat = { id: number; firstAt: string; lastAt: string; messages: number; status: 'open' | 'linked' | 'dismissed' };
export type BaleOwnCustomer = { id: number; name: string; phoneMasked: string | null };
export type BaleAuditItem = { id: number; at: string; actor: string | null; accountId: number | null; customerId: number | null; action: string; outcome: string; detail: Record<string, unknown> | null };
export type BaleOutboxStatus = 'pending_approval' | 'queued' | 'sending' | 'sent' | 'blocked' | 'failed' | 'cancelled';
export type BaleOutboxItem = {
  id: number; customerId: number | null; status: BaleOutboxStatus; source: 'expert_command' | 'reminder' | 'assistant' | 'auto_reply'; sourceLabel: string;
  text: string | null; reason: string | null; blockReason: string | null; blockMessage: string | null; error: string | null; errorMessage: string | null;
  scheduledAt: string | null; sendNow: boolean; sentAt: string | null; createdAt: string; newChat: boolean; canAct: boolean; customerName?: string | null;
};
export type BaleSendState = {
  quietNow: boolean; quietEnd: string | null; hasPriorChat: boolean; sentLastHour: number; perHour: number; sentToday: number; perDay: number;
  reminders: { reminderId: number; text: string; remindAt: string }[];
};
export type BaleSendResult = { status: 'queued' | 'pending_approval'; outboxId: number; heldUntil: string | null; message: string | null; text: string };
export type BaleChat = {
  customerId: number; masterEnabled: boolean; readOnly: boolean; canSend: boolean; sendBlockedMessage: string | null;
  outbox: BaleOutboxItem[]; sendState: BaleSendState | null; conversationMode: 'assistant' | 'human' | null;
  paused: { reason: string; at: string; message: string; unverified: boolean } | null;
  expert: { name: string; connected: boolean; mode: BaleMode } | null;
  messages: { id: number; direction: 'in' | 'out'; text: string | null; hasFile: boolean; status: string | null; createdAt: string; expertName: string | null }[];
};

export const BALE_TRAINEES: readonly number[] = [5, 19, 20];
type U = { id?: number; role?: string | null; salespersonId?: number | null } | null | undefined;
/** May connect an own Bale account (mirrors server baleEligible). */
export const baleCanConnect = (u: U) => Boolean(u && u.id !== 29 && u.role === 'salesperson' && u.salespersonId && !BALE_TRAINEES.includes(u.salespersonId));
/** May open «اتصال بله» page (experts) or manage it (admin, never 29). */
export const baleNavVisible = (u: U) => Boolean(u && u.id !== 29 && (u.role === 'admin' || baleCanConnect(u)));
/** May see the read-only «گفتگوی بله» section on a customer (customer scope is checked on the server). */
export const baleChatVisible = baleNavVisible;

export const MODE_LABEL: Record<BaleMode, string> = { off: 'خاموش', approve_first: 'اول تأیید من', auto: 'خودکار' };
export const MODE_HINT: Record<BaleMode, string> = {
  off: 'هیچ پیامی از حساب شما فرستاده نمی‌شود.',
  approve_first: 'پیام‌های دستیار و یادآورها اول برای تأیید شما می‌آیند؛ پیامی که خودتان در پرونده می‌نویسید مستقیم در صف ارسال می‌رود.',
  auto: 'پیام‌هایی که خودتان دستور داده‌اید یا یادآورشان رسیده، با رعایت سقف‌ها و ساعت آرام خودکار فرستاده می‌شود.',
};
export const STATUS_LABEL: Record<BaleAccount['status'], string> = { connected: 'وصل', disconnected: 'قطع', banned: 'مسدود', error: 'خطا' };
export const toFaDigits = (s: string) => s.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
export const toEnDigits = (s: string) => s.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
/** Mirrors server BALE_MAX_TEXT (1000). */
export const BALE_MAX_TEXT = 1000;
export const OUTBOX_STATUS_LABEL: Record<BaleOutboxStatus, string> = {
  pending_approval: 'منتظر تأیید شما', queued: 'در صف ارسال', sending: 'در حال ارسال', sent: 'فرستاده شد', blocked: 'فرستاده نشد', failed: 'ناموفق', cancelled: 'لغو شد',
};
