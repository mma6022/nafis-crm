/** «وضعیت تراکنش‌ها» data: commission status (lib/staff-wallet.ts) + customer wallet transactions (routes/wallet-management.ts). */
import { api } from '@/lib/goods-api';

export type CommGroup = 'wait' | 'paid' | 'back' | 'err';
export type CommItem = {
  purchaseId: number; customerId: number; customerName: string | null; salespersonId: number; salespersonName: string | null;
  group: CommGroup; paymentOrderId: number | null; paymentOrderStage: string | null;
  enteredAt: string | null; paidAt: string | null; postedAt: string | null; reversedAt: string | null; changedAt: string | null;
  commissionMonth: string | null; reversalMonth: string | null; commissionState: 'posted' | 'reversed' | 'manager' | 'none';
  // admin only
  rawStatus?: string; lastError?: string | null; reversalReason?: string | null; basisAmountToman?: string | null; closerRateBps?: number | null;
  closerCommissionToman?: string | null; p1Kind?: string | null; p1ShareToman?: string | null; qualifierName?: string | null; netToman?: string | null; ledgerId?: number | null;
};
export type CommList = { items: CommItem[]; total: number; page: number; limit: number; counts: Record<string, number>; salespersons: { id: number; name: string }[]; viewer: 'admin' | 'accounting' };
export type CommTimeline = { at: string; action: string; actorName?: string | null; actorRole?: string | null; detail?: Record<string, unknown> | null };
export type CommDetail = CommItem & {
  timeline: CommTimeline[]; ledger: { id: number; kind: string; amountToman: string; salespersonName: string | null; month: string | null; createdAt: string; neutralized: boolean }[];
  viewer: 'admin' | 'accounting'; canRetry: boolean; canReverse: boolean; canUnpay: boolean; canOpenOrder: boolean; reverseMonth: string | null;
};
export type WalletTx = {
  kind: string; walletType: 'cash' | 'credit'; recordId: number; customerId: number; customerName: string | null; customerSalespersonName: string | null;
  otherCustomerId: number | null; otherCustomerName: string | null; amountToman: string | number; status: string; actorId: number | null; actorName: string | null;
  errorCode: string | null; reason: string | null; createdAt: string; purchaseId?: number | null;
};
export type WalletTxList = { items: WalletTx[]; total: number; page: number; limit: number; statusCounts?: Record<string, number> };

const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
};
export const txApi = {
  comm: (o: Record<string, string | number | null | undefined>) => api.get<CommList>(`/goods-finance/commission-status?${qs(o)}`),
  commDetail: (id: number) => api.get<CommDetail>(`/goods-finance/commission-status/${id}`),
  wallet: (o: Record<string, string | number | null | undefined>) => api.get<WalletTxList>(`/wallet-management/transactions?${qs({ ...o, view: 'status', withCounts: 1 })}`),
  unpay: (orderId: number, reason: string) => api.post(`/payment-orders/${orderId}/unpay`, { reason }),
  retry: (purchaseId: number) => api.post(`/goods-finance/team-commission/purchases/${purchaseId}/post`, {}),
  reverse: (purchaseId: number, reason: string) => api.post(`/goods-finance/team-commission/purchases/${purchaseId}/reverse`, { reason }),
};

/** Wallet-segment groups → raw statuses (decision: four groups in the list, raw status as the sub-line). */
export const WALLET_GROUPS: Record<'wait' | 'chk' | 'done' | 'fail', string[]> = {
  wait: ['requested', 'gateway_ready', 'verification_pending'],
  chk: ['requires_reconciliation'],
  done: ['credited', 'completed'],
  fail: ['failed', 'cancelled'],
};
export const walletGroupOf = (status: string) => (Object.keys(WALLET_GROUPS) as (keyof typeof WALLET_GROUPS)[]).find((g) => WALLET_GROUPS[g].includes(status)) ?? 'wait';
export const RAW_STATUS: Record<string, string> = {
  requested: 'درخواست‌شده', gateway_ready: 'آماده‌ی درگاه', verification_pending: 'در انتظار تأیید درگاه', requires_reconciliation: 'نیاز به تطبیق با درگاه',
  credited: 'واریزشده', completed: 'انجام‌شده', failed: 'ناموفق', cancelled: 'لغوشده',
};
export const TX_KIND: Record<string, string> = {
  payment: 'شارژ کیف پول', loan_credit: 'اعتبار تسهیلات', filing_fee: 'کسر هزینه تشکیل پرونده', goods_purchase: 'کسر بابت خرید کالا', transfer: 'انتقال', legacy: 'سابقه',
};
export const WALLET_TYPE: Record<string, string> = { cash: 'نقدی', credit: 'اعتباری' };
/** Ledger amounts are stored positive; the sign comes from the kind. 0 = no sign (transfer, legacy). */
export const txSign = (kind: string) => (kind === 'goods_purchase' || kind === 'filing_fee' ? -1 : kind === 'payment' || kind === 'loan_credit' ? 1 : 0);

const ERR: Record<string, string> = {
  gateway_unavailable: 'ارتباط با درگاه برقرار نشد. پولی کم نشده است.',
  gateway_http_error: 'درگاه پاسخ نامعتبر داد. پولی کم نشده است.',
  gateway_invalid_response: 'پاسخ درگاه قابل خواندن نبود.',
  gateway_rejected: 'درگاه درخواست را نپذیرفت. پولی کم نشده است.',
  configuration_unavailable: 'تنظیمات درگاه در دسترس نبود.',
  amount_too_large: 'مبلغ از سقف مجاز درگاه بیشتر بود.',
  verification_unavailable: 'بررسی پرداخت در آن لحظه در دسترس نبود.',
  verification_http_error: 'پاسخ بررسی درگاه نامعتبر بود.',
  verification_invalid_response: 'نتیجه‌ی بررسی درگاه قابل خواندن نبود.',
  verification_rejected: 'تأیید پرداخت از درگاه ناموفق بود. پولی کم نشده است.',
  provider_already_verified: 'درگاه پرداخت را تأیید کرده، ولی شارژ نیاز به تطبیق دارد.',
  insufficient_balance: 'موجودی کافی نبود.',
  transfer_failed: 'ثبت انتقال با خطا روبه‌رو شد.',
};
/** One plain Persian sentence for why a wallet transaction is not done (no raw codes on screen). */
export function txWhy(t: WalletTx): string | null {
  if (t.status === 'requires_reconciliation') return 'پول از حساب مشتری کم شده ولی تأیید درگاه نرسیده.';
  if (t.status === 'cancelled') return 'مشتری پرداخت را در درگاه لغو کرد.';
  if (t.status !== 'failed') return null;
  const code = t.errorCode ?? '';
  if (ERR[code]) return ERR[code];
  if (/^provider_-?\d+$/.test(code)) return 'تأیید پرداخت از درگاه ناموفق بود. پولی کم نشده است.';
  return /[\u0600-\u06ff]/.test(code) ? code : 'تراکنش ناموفق بود. پولی کم نشده است.';
}
export const txActor = (t: WalletTx) => t.actorName || (t.kind === 'payment' ? 'خود مشتری (درگاه)' : 'سیستم');
