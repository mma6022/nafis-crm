/**
 * bottom-nav-v2 dock / tab slots (flag.bottom_nav_v2, default OFF).
 * Pure rearrangement of already-permission-filtered hrefs. Never adds a route
 * the caller did not already pass in `visible`, except the bale-bot fallback
 * in §6.1 (own conversation) which still hits the existing /bale-bot page.
 */
export type Bnv2Kind = 'expert' | 'admin';

export type Bnv2Input = {
  flagOn: boolean;
  /** `admin` gets the management dock (reports, no primary). Everyone else, including sales_manager, keeps the expert dock with the two item swaps. */
  role?: string | null;
  /** Hrefs that already passed CrmShell's permission filter. */
  visible: string[];
  /** §6.1: role has a personal Bale inbox even if /bale-bot is not in `visible`. */
  hasOwnBaleInbox?: boolean;
};

export type Bnv2Slots = {
  kind: Bnv2Kind;
  before: string[];
  after: string[];
  tabs: string[];
  daily: string[];
  listsFirst: string[];
  used: string[];
  midSep: boolean;
  primary: boolean;
  baleHref: string | null;
  /** relabel map applied only while the flag is on */
  labels: Record<string, { label: string; full: string; testId: string; key: string }>;
};

const TODAY_CANDIDATES = ['/today', '/'] as const;

export const BNV2_LABELS: Record<string, { label: string; full: string; testId: string; key: string }> = {
  '/today': { key: 'today', label: 'امروز', full: 'امروز', testId: 'today' },
  '/': { key: 'today', label: 'امروز', full: 'امروز', testId: 'today' },
  '/payment-orders': { key: 'pay', label: 'دستور پرداخت', full: 'دستور پرداخت', testId: 'pay' },
  '/loan-applications': { key: 'files', label: 'پرونده‌ها', full: 'پرونده‌ها', testId: 'files' },
  '/reminders': { key: 'rem', label: 'یادآورها', full: 'یادآورها', testId: 'rem' },
  '/bale-bot': { key: 'bale', label: 'ربات بله', full: 'ربات بله', testId: 'bale' },
  '/internal-chat': { key: 'team', label: 'داخلی', full: 'گفتگوی داخلی', testId: 'team' },
  '/sales-reports': { key: 'rep', label: 'گزارش‌ها', full: 'گزارش‌ها', testId: 'rep' },
  '/customers': { key: 'cust', label: 'مشتری‌های من', full: 'مشتری‌های من', testId: 'cust' },
};

export const SS_ACCOUNT = ['/my-wallet', '/my-performance'] as const;

const OLD_LABELS: Record<string, { label: string; full: string; testId: string; key: string }> = {
  '/today': { key: 'today', label: 'امروز', full: 'کارهای امروز من', testId: 'today' },
  '/': { key: 'today', label: 'امروز', full: 'کارهای امروز من', testId: 'today' },
  '/customers': { key: 'cust', label: 'مشتریان', full: 'مشتری‌های من', testId: 'cust' },
  '/loan-applications': { key: 'files', label: 'پرونده‌ها', full: 'پرونده‌های وام من', testId: 'files' },
  '/reminders': { key: 'rem', label: 'یادآورها', full: 'یادآورهای من', testId: 'rem' },
  '/messengers': { key: 'msg', label: 'پیام‌رسان‌ها', full: 'گفتگو در پیام‌رسان‌ها', testId: 'msg' },
  '/internal-chat': { key: 'team', label: 'داخلی', full: 'گفتگوی داخلی', testId: 'team' },
};

export function bnv2Kind(role?: string | null): Bnv2Kind {
  return role === 'admin' ? 'admin' : 'expert';
}

export function todayHrefOf(visible: string[]): string | null {
  const set = new Set(visible);
  if (set.has('/today')) return '/today';
  if (set.has('/')) return '/';
  return null;
}

/** §6.1: bale-bot page if permitted; otherwise own inbox still opens /bale-bot; otherwise hidden. */
export function baleHrefOf(visible: string[], hasOwnBaleInbox?: boolean): string | null {
  if (visible.includes('/bale-bot') || hasOwnBaleInbox) return '/bale-bot';
  return null;
}

function pick(visible: Set<string>, hrefs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const h of hrefs) {
    if (h && visible.has(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export function bnv2Slots(input: Bnv2Input): Bnv2Slots {
  const visible = [...input.visible];
  const set = new Set(visible);
  const today = todayHrefOf(visible);
  const kind = bnv2Kind(input.role);

  if (!input.flagOn) {
    const before = pick(set, [today, '/customers', '/loan-applications', '/reminders']);
    const after = pick(set, ['/messengers', '/internal-chat']);
    const tabs = pick(set, [today, '/customers', '/loan-applications']);
    const daily = pick(set, ['/reminders', '/messengers', '/internal-chat']);
    const used = ['/today', '/', '/customers', '/loan-applications', '/reminders', '/messengers', '/internal-chat', ...SS_ACCOUNT];
    return {
      kind: 'expert',
      before, after, tabs, daily,
      listsFirst: [],
      used,
      midSep: false,
      primary: today === '/today',
      baleHref: null,
      labels: OLD_LABELS,
    };
  }

  const bale = baleHrefOf(visible, input.hasOwnBaleInbox);
  const vis = new Set(visible);
  if (bale) vis.add(bale);

  if (kind === 'admin') {
    const before = pick(vis, [today, '/payment-orders', '/loan-applications', '/sales-reports']);
    const after = pick(vis, [bale, '/internal-chat']);
    const tabs = pick(vis, [today, '/payment-orders', '/loan-applications', bale]);
    const daily = pick(vis, ['/internal-chat']);
    const used = ['/today', '/', '/payment-orders', '/loan-applications', '/sales-reports', '/bale-bot', '/internal-chat', ...SS_ACCOUNT];
    const listsFirst = pick(set, ['/customers', '/goods-purchases']);
    return {
      kind, before, after, tabs, daily, listsFirst, used,
      midSep: true,
      primary: false,
      baleHref: bale,
      labels: BNV2_LABELS,
    };
  }

  const before = pick(vis, [today, '/payment-orders', '/loan-applications', '/reminders']);
  const after = pick(vis, [bale, '/internal-chat']);
  const tabs = pick(vis, [today, '/payment-orders', '/loan-applications']);
  const daily = pick(vis, ['/reminders', bale, '/internal-chat']);
  const used = ['/today', '/', '/payment-orders', '/loan-applications', '/reminders', '/bale-bot', '/internal-chat', ...SS_ACCOUNT];
  const listsFirst = pick(set, ['/customers', '/goods-purchases']);
  return {
    kind, before, after, tabs, daily, listsFirst, used,
    midSep: today !== '/today',
    primary: today === '/today',
    baleHref: bale,
    labels: BNV2_LABELS,
  };
}

/** Remaining «بیشتر» hrefs: everything visible that is not already on the dock / daily / account. */
export function bnv2Rest(visible: string[], used: string[], listsFirst: string[]): string[] {
  const skip = new Set([...used, ...listsFirst]);
  return visible.filter((h) => !skip.has(h));
}
