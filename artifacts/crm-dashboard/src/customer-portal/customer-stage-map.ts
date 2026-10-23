// Customer-facing copy for the tracking pages (handoff «crm-customer-portal», section 4).
// Every stage key from stages.ts maps to one of five customer phases, whose turn it is
// (you = نوبت شما, us = نوبت ما, done = تکمیل) and the text of the «مرحله‌ی بعدی» card.
// Change customer wording here only; the pages read everything from this file.
import { stages } from './stages';

export type Turn = 'you' | 'us' | 'done';
export type StageCta = 'sign' | 'docs' | 'call';
export type StageCopy = { phase: 0 | 1 | 2 | 3 | 4; turn: Turn; title: string; description: string; cta?: StageCta };

export const PHASES = ['قرارداد اولیه', 'مدارک و ضامن', 'بررسی و تصویب', 'ارسال اصل مدارک', 'واریز و پایان'] as const;
export const PHASE_HINTS = ['آماده‌سازی و امضای قرارداد', 'مدارک شما، ضامن و وثیقه', 'تصمیم تأمین‌کننده و تصویب مبلغ', 'ارسال و بررسی اصل مدارک', 'تأیید نهایی و واریز'] as const;

const NOTHING_TO_DO = 'فعلاً لازم نیست کاری انجام دهید.';

export const STAGE_MAP: Record<string, StageCopy> = {
  draft: { phase: 0, turn: 'us', title: 'کارشناس در حال آماده‌کردن قرارداد شماست', description: 'فعلاً لازم نیست کاری انجام دهید. وقتی قرارداد آماده‌ی امضا شد، همین‌جا نشان داده می‌شود.' },
  primary_contract_pending_signature: { phase: 0, turn: 'you', title: 'قرارداد اولیه را امضا کنید', description: 'در سامانه‌ی امضامی وارد شوید، گواهی امضا بگیرید و قرارداد را امضا کنید. بعد از امضا، این صفحه خودش به‌روز می‌شود.', cta: 'sign' },
  customer_documents_upload: { phase: 1, turn: 'you', title: 'مدارک خواسته‌شده را بفرستید', description: 'فهرست مدارک پایین همین صفحه است. مدارک را در گفتگو برای کارشناس بفرستید.', cta: 'docs' },
  customer_documents_review: { phase: 1, turn: 'us', title: 'مدارک شما در حال بررسی است', description: 'کارشناس مدارک را بررسی می‌کند. اگر موردی نیاز به اصلاح داشت، همین‌جا با دلیلش نشان داده می‌شود.' },
  guarantor_registration: { phase: 1, turn: 'you', title: 'اطلاعات ضامن را به کارشناس بدهید', description: 'برای ثبت ضامن با کارشناس پرونده تماس بگیرید یا در گفتگو پیام بدهید.', cta: 'call' },
  guarantor_documents_upload: { phase: 1, turn: 'you', title: 'مدارک ضامن را بفرستید', description: 'مدارک ضامن را در گفتگو برای کارشناس بفرستید.', cta: 'docs' },
  guarantor_documents_review: { phase: 1, turn: 'us', title: 'مدارک ضامن در حال بررسی است', description: NOTHING_TO_DO },
  collateral_upload: { phase: 1, turn: 'you', title: 'مدارک وثیقه را بفرستید', description: 'مدارک وثیقه را در گفتگو برای کارشناس بفرستید.', cta: 'docs' },
  collateral_review: { phase: 1, turn: 'us', title: 'وثیقه در حال بررسی است', description: NOTHING_TO_DO },
  expert_approval: { phase: 2, turn: 'us', title: 'پرونده نزد تأمین‌کننده است', description: 'تأمین‌کننده پرونده را بررسی می‌کند. نتیجه همین‌جا نشان داده می‌شود.' },
  funder_initial_approval: { phase: 2, turn: 'us', title: 'مبلغ وام در حال تصویب است', description: NOTHING_TO_DO },
  approved_contract_pending_signature: { phase: 2, turn: 'you', title: 'قرارداد جدید را امضا کنید', description: 'شرایط قرارداد تغییر کرده است؛ قرارداد جدید برای امضای شما در امضامی آماده است.', cta: 'sign' },
  // Awaiting Mohammad's approval (handoff section 9): turn and text of this card.
  physical_documents_submission: { phase: 3, turn: 'us', title: 'کارشناس با شما تماس می‌گیرد', description: NOTHING_TO_DO },
  physical_documents_correction: { phase: 3, turn: 'you', title: 'نقص اصل مدارک را برطرف کنید', description: 'برای جزئیات نقص با کارشناس تماس بگیرید.', cta: 'call' },
  physical_documents_review: { phase: 3, turn: 'us', title: 'اصل مدارک در حال بررسی است', description: NOTHING_TO_DO },
  funder_documents_correction: { phase: 3, turn: 'you', title: 'تأمین‌کننده اصلاح مدرک خواسته است', description: 'برای جزئیات با کارشناس تماس بگیرید.', cta: 'call' },
  funder_result_review: { phase: 3, turn: 'us', title: 'نتیجه‌ی تأمین‌کننده در حال بررسی است', description: NOTHING_TO_DO },
  // Awaiting Mohammad's approval (handoff section 9): turn and text of this card.
  wallet_charge_pending: { phase: 4, turn: 'us', title: 'کارشناس با شما تماس می‌گیرد', description: NOTHING_TO_DO },
  admin_approval: { phase: 4, turn: 'us', title: 'پرونده در مرحله‌ی تأیید نهایی است', description: NOTHING_TO_DO },
  final_invoice_pending_signature: { phase: 4, turn: 'you', title: 'صورت‌حساب نهایی را امضا کنید', description: 'صورت‌حساب نهایی در امضامی برای امضای شما آماده است.', cta: 'sign' },
  completed: { phase: 4, turn: 'done', title: 'پرونده‌ی شما تکمیل شد', description: 'همه‌ی مراحل انجام شد. اگر سؤالی دارید، کارشناس پرونده در دسترس است.' },
};

/** Unknown stage keys fall back to «نوبت ما» in the first phase, so a new backend stage never breaks the page. */
export const FALLBACK_STAGE: StageCopy = { phase: 0, turn: 'us', title: 'پرونده‌ی شما در جریان است', description: NOTHING_TO_DO };

export const TERMINAL_STATUS: Record<string, { label: string; tone: 'bad' | 'off' }> = {
  rejected: { label: 'رد شده', tone: 'bad' },
  cancelled: { label: 'لغو شده', tone: 'off' },
  canceled: { label: 'لغو شده', tone: 'off' },
  closed: { label: 'بسته شده', tone: 'off' },
};

export type DocTone = 'ok' | 'wait' | 'bad' | 'warn' | 'none';
export const DOC_STATUS: Record<'approved' | 'pending' | 'rejected' | 'incomplete' | 'missing', { label: string; tone: DocTone }> = {
  approved: { label: 'تأیید شد', tone: 'ok' },
  pending: { label: 'در حال بررسی', tone: 'wait' },
  rejected: { label: 'نیاز به اصلاح', tone: 'bad' },
  incomplete: { label: 'ناقص', tone: 'warn' },
  missing: { label: 'ارسال نشده', tone: 'none' },
};

export const UNKNOWN_AMOUNT = 'بعداً اعلام می‌شود';
export const EMZAME_URL = 'https://web.emzame.ir/';
export const CHAT_HREF = '/customer/advice/chat';
// No office landline in the portal (not operational, Mohammad 2026-10-23): contact goes through ExpertPicker / sales-experts.ts.

export const stageLabel = (stage?: string | null) => (stage && stages[stage]) || 'در جریان';
export const stageCopy = (stage?: string | null): StageCopy => (stage && STAGE_MAP[stage]) || FALLBACK_STAGE;
export const terminalOf = (status?: string | null) => (status ? TERMINAL_STATUS[status] : undefined);
export const isCompleted = (app: { status?: string | null; stage?: string | null }) => app.status === 'completed' || app.stage === 'completed';
export const isFinished = (app: { status?: string | null; stage?: string | null }) => !!terminalOf(app.status) || isCompleted(app);
