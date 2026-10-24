/** «کیف پول من» / «وضعیت تراکنش‌ها» read models (server: lib/staff-wallet.ts). Read-only endpoints. */
import { api } from '@/lib/goods-api';

export type WalletRole = 'closer' | 'qualifier' | 'other';
export type WalletLedgerRow = {
  id: number; purchaseId: number | null; customerId: number | null; customerName: string | null; kind: string;
  amountToman: string; month: string | null; createdAt: string; date: string; model: 'team' | 'legacy';
  neutralized: boolean; completedAt: string | null; paymentOrderId: number | null; paymentOrderStage: string | null; paidByRole: string | null;
  settingsVersionId: number | null;
  meta: { tier: number | null; rateBps: number | null; basisAmountToman: string | null; p1Kind: string | null; reversedLedgerId: number | null; reversedKind: string | null; reason: string | null } | null;
};
export type WalletPending = {
  purchaseId: number; customerId: number; customerName: string | null; kind: 'salesperson_commission' | 'p1_referral_share';
  closerName: string | null; paymentOrderId: number | null; paymentOrderStage: string | null; state: string; since: string | null;
};
export type WalletTier = {
  salesToman: string; tier: number; rateBps: number; nextTier: number | null; nextTargetToman: string | null; remainingToman: string | null;
  tiers: { tier: number; fromToman: string; rateBps: number }[];
};
export type StaffWalletPayload = {
  viewer: 'admin' | 'self';
  salesperson: { id: number; name: string; role: WalletRole };
  pickers?: { id: number; name: string; role: WalletRole }[];
  currentMonth: string; month: string; balanceToman: string; monthPostedToman: string; monthRowCount: number;
  breakdown: { kind: string; count: number; totalToman: string }[];
  stats: { p1FirstCall: number; p1Upgrade: number; accuracyReviewed: number; accuracyCorrect: number; p1Received: number; reversedCases: number };
  tier: WalletTier | null; p1Month: { totalToman: string; count: number };
  teamBonusEnabled: boolean; modelEnabled: boolean; modelStartDate: string | null;
  pending: WalletPending[]; ledger: WalletLedgerRow[];
};

export const staffWalletApi = {
  wallet: (q: { salespersonId?: number | null; month?: string | null }) => {
    const p = new URLSearchParams();
    if (q.salespersonId) p.set('salespersonId', String(q.salespersonId));
    if (q.month) p.set('month', q.month);
    return api.get<StaffWalletPayload>(`/goods-finance/staff-wallet${p.toString() ? `?${p}` : ''}`);
  },
};

/** Ledger kind → [long label, chip label, icon class]. */
export const WALLET_KINDS: Record<string, [string, string, string]> = {
  salesperson_commission: ['پورسانت فروش (پلکانی)', 'پورسانت فروش', ''],
  p1_referral_share: ['سهم معرفی P1', 'سهم P1', 'p1'],
  data_accuracy_bonus: ['پاداش درستی داده', 'درستی داده', 'acc'],
  returned_case_deduction: ['کسر بابت پرونده‌ی برگشتی', 'کسر برگشتی', 'neg'],
  team_bonus: ['پاداش تیمی ماهانه', 'پاداش تیمی', 'team'],
  paid_mark_reversal: ['برگشت «پرداخت‌شده»', 'برگشت پرداخت', 'neg'],
};
export const kindLabel = (k: string) => WALLET_KINDS[k]?.[0] ?? k;
export const kindChip = (k: string) => WALLET_KINDS[k]?.[1] ?? k;
export const kindClass = (k: string) => WALLET_KINDS[k]?.[2] ?? 'mute';

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/\d/g, (d) => FA[Number(d)]).replace(/\./g, '٫');
const big = (v?: string | number | null) => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };
const abs = (b: bigint) => (b < 0n ? -b : b);
/** 1250000 → «۱٬۲۵۰٬۰۰۰» */
export const sep = (v?: string | number | null) => abs(big(v)).toLocaleString('fa-IR');
export const isNeg = (v?: string | number | null) => big(v) < 0n;
export const isZero = (v?: string | number | null) => big(v) === 0n;
/** Rate in basis points → «۱٫۲ درصد» */
export const pct = (bps?: number | null) => (bps == null ? '—' : `${fa(Number((bps / 100).toFixed(2)))} درصد`);
export const pctShort = (bps?: number | null) => (bps == null ? '—' : `${fa(Number((bps / 100).toFixed(2)))}٪`);
/** Short money: 300000000 → «۳۰۰م», 1000000000 → «۱ میلیارد» */
export function shortMoney(v?: string | null) {
  const n = Number(v ?? 0);
  if (n >= 1e9) return `${fa(Number((n / 1e9).toFixed(1)))} میلیارد`;
  if (n >= 1e6) return `${fa(Math.round(n / 1e6))} میلیون`;
  return sep(v);
}
export function shortMoneyM(v?: string | null) {
  const n = Number(v ?? 0);
  if (n >= 1e9) return `${fa(Number((n / 1e9).toFixed(1)))} میلیارد`;
  if (n >= 1e6) return `${fa(Math.round(n / 1e6))}م`;
  return sep(v);
}

const fmt = (iso: string | null | undefined, o: Intl.DateTimeFormatOptions) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('fa-IR', { calendar: 'persian', timeZone: 'Asia/Tehran', ...o }).format(d) : '—';
};
/** «۴ آبان» */
export const dayMonth = (iso?: string | null) => fmt(iso, { day: 'numeric', month: 'long' });
/** «۱۰:۲۰» */
export const hm = (iso?: string | null) => fmt(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** «۴ آبان ۱۴۰۵» */
export const fullDay = (iso?: string | null) => fmt(iso, { day: 'numeric', month: 'long', year: 'numeric' });
/** «۳ روز» since a timestamp. */
export function since(iso?: string | null) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${fa(days)} روز`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${fa(hours)} ساعت` : 'کمتر از ۱ ساعت';
}
export const ROLE_LABEL: Record<WalletRole, string> = { closer: 'کارشناس پیگیری', qualifier: 'کارشناس تماس اول', other: 'کارشناس فروش' };
