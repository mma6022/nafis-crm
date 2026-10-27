/** Team-sales commission model client (P1 share, data-accuracy bonus, reversal deduction, team bonus). Server computes every amount. */
export type Basis = 'deposit' | 'legacy_base';
export type PostingMoment = 'payment_paid' | 'final_approval';
export type TeamBonusBasis = 'total' | 'above_threshold';
export type TeamSettings = {
  enabled: boolean; basis: Basis; postingMoment: PostingMoment; modelStartDate: string;
  p1FirstCallPercent: string; p1UpgradePercent: string; dataAccuracyBonusToman: string;
  teamBonusEnabled: boolean; teamBonusPercent: string; teamBonusThresholdToman: string; teamBonusBasis: TeamBonusBasis;
  teamSplit: Array<{ salespersonId: number; percent: string }>;
};
export type TeamMember = {
  salespersonId: number; name: string; role: 'closer' | 'qualifier';
  tiers: { rate0Bps: number; rate1Bps: number; rate2Bps: number; rate3Bps: number; target1Toman: string; target2Toman: string; target3Toman: string } | null;
};
export type SettingsVersionRow = { versionId: number; effectiveAt: string | null; createdAt: string; createdByName: string | null; settings: TeamSettings };
export type TeamSettingsPayload = {
  versionId: number | null; effectiveAt: string | null; settings: TeamSettings; defaults: TeamSettings;
  members: TeamMember[]; versions: SettingsVersionRow[];
};
export type AccuracyReason = 'unreported_bounced_cheque' | 'unreported_document' | 'other';
export type AccuracyReview = {
  id: number; correct: boolean; reason: AccuracyReason | null; reasonLabel: string | null; note: string | null;
  bonusToman: string; revision: number; reviewedAt: string; reviewedByName: string | null; updatedAt: string | null;
};
export type DataAccuracyState = { visible: false } | {
  visible: true; customerId: number; customerName: string;
  p1: { historyId: number; kind: 'first_call' | 'upgrade'; at: string; qualifierName: string | null; closerName: string | null };
  closerSalespersonId: number | null; closerName: string | null; bonusToman: string;
  status: 'pending' | 'correct' | 'incorrect'; review: AccuracyReview | null;
  canReview: boolean; canOverride: boolean; viewer: 'admin' | 'closer' | 'qualifier' | 'other';
  reasons: Array<{ key: AccuracyReason; label: string }>;
};
export type BreakdownRow = { kind: string; count: number; totalToman: string };
export type CommissionStats = { p1FirstCall: number; p1Upgrade: number; accuracyReviewed: number; accuracyCorrect: number; p1Received: number; reversedCases: number };

export class TeamCommissionApiError extends Error {
  constructor(message: string, public status: number, public errors: Record<string, string> = {}) { super(message); }
}
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api${path}`, {
      method, credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new TeamCommissionApiError('اتصال به سرور برقرار نشد.', 0); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = typeof data?.error === 'string' && /[\u0600-\u06ff]/.test(data.error) ? data.error
      : res.status === 403 ? 'دسترسی لازم برای این کار را ندارید.' : 'درخواست با خطا روبه‌رو شد.';
    throw new TeamCommissionApiError(msg, res.status, data?.errors ?? {});
  }
  return data as T;
}
export const tcApi = {
  settings: () => request<TeamSettingsPayload>('GET', '/goods-finance/team-settings'),
  saveSettings: (s: Partial<TeamSettings>) => request<TeamSettingsPayload>('PUT', '/goods-finance/team-settings', s),
  accuracy: (customerId: number) => request<DataAccuracyState>('GET', `/customers/${customerId}/data-accuracy`),
  submitAccuracy: (customerId: number, body: { correct: boolean; reason?: AccuracyReason; note?: string }) =>
    request<unknown>('POST', `/customers/${customerId}/data-accuracy`, body),
};

export const KIND_LABELS: Record<string, string> = {
  salesperson_commission: 'پورسانت فروش (پلکانی)',
  p1_referral_share: 'سهم معرفی P1',
  data_accuracy_bonus: 'پاداش درستی داده',
  returned_case_deduction: 'کسر بابت پرونده‌ی برگشتی',
  team_bonus: 'پاداش تیمی ماهانه',
  paid_mark_reversal: 'خنثی‌سازی (برگشت «پرداخت‌شده»)',
};
export const KIND_CHIPS: Record<string, string> = {
  salesperson_commission: 'پورسانت فروش', p1_referral_share: 'سهم معرفی P1', data_accuracy_bonus: 'پاداش درستی داده',
  returned_case_deduction: 'کسر برگشتی', team_bonus: 'پاداش تیمی', paid_mark_reversal: 'خنثی‌سازی',
};
export const fa = (v: string | number) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]).replace(/\./g, '٫');
export const latin = (v: string) => v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');
export const tm = (v: string | number | bigint) => {
  let n: bigint; try { n = BigInt(String(v).split('.')[0] || '0'); } catch { n = 0n; }
  return `${fa((n < 0n ? -n : n).toLocaleString('en-US')).replace(/,/g, '٬')} تومان`;
};
export const pct = (bps: number) => `${fa((bps / 100).toString())}٪`;
/** «۱۴۰۵-۰۸-۰۲» -> «۲ آبان ۱۴۰۵» */
const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const jalaliLabel = (d: string) => { const [y, m, day] = d.split('-').map(Number); return day ? `${fa(day)} ${MONTHS[m - 1]} ${fa(y)}` : `${MONTHS[m - 1]} ${fa(y)}`; };
export const faDateTime = (iso: string) => new Date(iso).toLocaleString('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
