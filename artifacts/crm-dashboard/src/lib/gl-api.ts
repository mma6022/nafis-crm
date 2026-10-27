/** G5 (2026-10-27): read-only general-ledger report client. Every amount from the server is in RIAL (integer). */
import { api } from './goods-api';

export type GlTotals = { openDr: number; openCr: number; dr: number; cr: number; balDr: number; balCr: number };
export type GlTbRow = GlTotals & { key: string; code: string; title: string; kol: string; tafsiliId: number | null; tafsiliCode: string | null; tafsiliTitle: string | null; memo: boolean };
export type GlTrialBalance = { level: GlLevel; from: string; to: string; rows: GlTbRow[]; memoRows: GlTbRow[]; totals: GlTotals; memoTotals: GlTotals; balanced: boolean };
export type GlLevel = 'kol' | 'moein' | 'tafsili';
export type GlVoucherLine = { lineNo: number; code: string; title: string; tafsiliCode: string | null; tafsiliTitle: string | null; debitRial: number; creditRial: number; description: string | null };
export type GlVoucher = { id: number; refNo: string; tempNo: number; finalNo: { period: string; seq: number } | null; eventDate: string; kind: string; description: string | null;
  sourceType: string | null; sourceId: number | null; reversesVoucherId: number | null; reversedByVoucherId: number | null; totalRial: number; lines: GlVoucherLine[] };
export type GlAccount = { code: string; title: string; level: string; nature: string; tafsiliTypes: string | null; postable: boolean; active: boolean };
export type GlTafsili = { id: number; type: string; code: string; title: string; account: string };
export type GlLedgerRow = { voucherId: number; refNo: string; tempNo: number; eventDate: string; kind: string; description: string | null; code: string; tafsiliCode: string | null; tafsiliTitle: string | null; debitRial: number; creditRial: number; runningRial: number };
export type GlLedger = { account: { code: string; title: string; level: string; nature: string }; tafsili: { id: number; code: string; title: string } | null; from: string; to: string;
  openingRial: number; debitRial: number; creditRial: number; closingRial: number; total: number; page: number; limit: number; items: GlLedgerRow[] };
export type GlQueueItem = { id: number; sourceKey: string; eventType: string; sourceType: string; sourceId: number; status: string; attempts: number; nextAttemptAt: string | null; lastError: string | null; createdAt: string; updatedAt: string };
export type GlQueue = { counts: { pending: number; failed: number; posted: number; skipped: number }; items: GlQueueItem[]; skipped: { code: string; n: number }[]; exceptions: { code: string; n: number }[] };
export type GlRecRow = { ref: string; refId: number | null; label: string; glRial: number; systemRial: number; diffRial: number };
export type GlRecSection = { key: string; title: string; description: string; status: 'ok' | 'mismatch' | 'deferred'; deferred?: string; mismatchCount: number; checked: number; glTotalRial: number; systemTotalRial: number; rows: GlRecRow[]; notes: string[] };
export type GlRun = { runDate: string; status: string; mismatchCount: number; startedAt?: string; finishedAt: string | null };
export type GlReconciliation = { live: { state: 'not_started'; reason: string } | { state: 'ready'; asOf: string; ledgerStartDate: string; mismatchCount: number; sections: GlRecSection[]; queueOpen: number }; lastRun: GlRun | null; nightlyEnabled: boolean };
export type Gl2101 = { status: 'no_draft' | 'step4_pending' | 'match' | 'mismatch'; expectedRial: number; draftRial: number | null; openOrders: number; prePaidOrders: number };
export type GlStatus = { enabled: false } | {
  enabled: true; today: string; flags: Record<string, boolean>; ledgerStartDate: string | null; baseDate: string | null; baseOk: boolean; baseError: string | null;
  fiscalYears: { id: number; title: string; startDate: string; endDate: string; status: string; lockedUntil: string | null }[];
  opening: { state: 'none' | 'draft' | 'posted'; setId?: number; asOfDate?: string; step4Done?: boolean; approvalLocked?: boolean; lockReasons?: string[]; check2101?: Gl2101 | null };
  vouchers: number; queuePending: number; queueFailed: number; lastRun: GlRun | null;
  financeRoles?: GlFinanceRoles;
};
/** G6c: counts only (no names). solo = no two different people for drafter + approver of a manual voucher. */
export type GlFinanceRoles = { assigned: { accountants: number; approvers: number }; creators: number; approvers: number; financeUsers: number; twoPersonOk: boolean; solo: boolean; noAssigned: boolean };
export type GlCommissionRow = { salespersonId: number; name: string; cases: number; registeredRial: number; paidRial: number | null; payableRial: number; glExpenseRial: number; glPayableRial: number };
export type GlCommissionTotals = { asOf: string; rows: GlCommissionRow[]; totals: { cases: number; registeredRial: number; payableRial: number; glExpenseRial: number; glPayableRial: number }; paidTracked: boolean };

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString(); return s ? `?${s}` : '';
};
export const glApi = {
  status: () => api.get<GlStatus>('/gl/reports/status'),
  trialBalance: (q: { from?: string; to?: string; level: GlLevel }) => api.get<GlTrialBalance>(`/gl/reports/trial-balance${qs(q)}`),
  journal: (q: { from?: string; to?: string; page: number }) => api.get<{ total: number; page: number; limit: number; items: GlVoucher[] }>(`/gl/reports/journal${qs(q)}`),
  accounts: () => api.get<{ accounts: GlAccount[]; tafsili: GlTafsili[] }>('/gl/reports/accounts'),
  ledger: (q: { code: string; tafsiliId?: number | null; from?: string; to?: string; page: number }) => api.get<GlLedger>(`/gl/reports/ledger${qs(q)}`),
  queue: () => api.get<GlQueue>('/gl/reports/queue'),
  reconciliation: () => api.get<GlReconciliation>('/gl/reports/reconciliation'),
  commissionTotals: () => api.get<GlCommissionTotals>('/gl/reports/commission-totals'),
};

/** Rial -> toman text (fa digits). A rial remainder is shown as a decimal toman. */
export const rialToman = (r: number | null | undefined) => {
  const v = Number(r ?? 0);
  if (!v) return '۰';
  return (v / 10).toLocaleString('fa-IR', { maximumFractionDigits: 1 });
};
export const faGDate = (g?: string | null) => {
  if (!g) return '—';
  const d = new Date(`${g.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? g : new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
};

const REASONS: Record<string, string> = {
  'finance_setting_missing:gl.ledger_start_date': 'تاریخ شروع دفتر کل در تنظیمات مالی ثبت نشده.',
  'finance_setting_missing:gl.opening_base_date': 'تاریخ مبنای موجودی اولیه (مرز دستورهای پرداخت‌شده) ثبت نشده.',
  gl_opening_base_not_day_before_start: 'تاریخ مبنا باید دقیقاً روز پیش از شروع دفتر کل باشد.',
  gl_opening_as_of_not_base_date: 'تاریخ موجودی اولیه با تاریخ مبنا یکی نیست.',
  gl_opening_set_approved: 'این موجودی اولیه قبلاً تأیید شده.',
  gl_opening_set_superseded: 'این موجودی اولیه با بازبینی تازه‌تری جایگزین شده.',
  gl_opening_exists: 'سند افتتاحیه قبلاً ثبت شده.',
  gl_opening_prior_payments_unconfirmed: 'گام ۴ (دستورهای پرداخت‌شده تا تاریخ مبنا) هنوز تأیید نشده.',
  gl_opening_step4_pending: 'تا گام ۴ تأیید نشود، ماندهٔ ۲۱۰۱ قابل سنجش نیست.',
  gl_opening_2101_missing: 'ماندهٔ ۲۱۰۱ در موجودی اولیه نیامده.',
  gl_opening_2101_mismatch: 'ماندهٔ ۲۱۰۱ با جمع دستورهای پرداخت‌نشده نمی‌خواند.',
  gl_opening_unbalanced: 'جمع بدهکار و بستانکار موجودی اولیه برابر نیست.',
  gl_opening_second_person_required: 'تأیید باید با نفر دوم (غیر از ثبت‌کننده) باشد.',
  gl_no_fiscal_year: 'سال مالی برای امروز تعریف نشده.',
};
export const glReason = (code: string) => {
  if (code.startsWith('gl_opening_locked_account:')) return `حساب‌های قفل در موجودی اولیه آمده‌اند: ${code.split(':')[1]}`;
  return REASONS[code] ?? code;
};
