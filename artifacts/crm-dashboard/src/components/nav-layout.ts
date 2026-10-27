/**
 * Sidebar layout by role (SIDEBAR-FILTER-PROPOSAL.md + PM 2026-10-26 17:10 Tehran).
 * DISPLAY ONLY: applied after CrmShell's permission filter, so it can only re-order, re-label or move an item
 * under «بیشتر». It never grants an item the user cannot already see, and hiding an item never changes
 * access — every route stays reachable by link/URL with the same permission checks as before.
 * Roles without a layout here (funder, accounting, salesperson without salespersonId) keep the old grouped menu.
 */
export type MenuKind = 'expert' | 'trainee' | 'registrar' | 'admin';
export type MainEntry = { href: string; label?: string; fallback?: string } | { action: 'assistant'; label: string };
export type MoreGroup = { id: string; label?: string; hrefs: string[] };
export type RoleMenu = { main: MainEntry[]; more: MoreGroup[]; hide?: string[]; shortcuts: string[] };

/** Trainee salespeople (same list as smart filing / sales assist). */
export const TRAINEE_SALESPERSON_IDS = [5, 19, 20];

export const menuKindFor = (user?: { role?: string | null; salespersonId?: number | null } | null): MenuKind | null => {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  if (user.role === 'registrar') return 'registrar';
  if (user.role === 'salesperson' && user.salespersonId) return TRAINEE_SALESPERSON_IDS.includes(user.salespersonId) ? 'trainee' : 'expert';
  return null;
};

export const ROLE_MENUS: Record<MenuKind, RoleMenu> = {
  // PM: exactly these 8; everything else (incl. the proposal's «حذف از منو» items) goes under «بیشتر».
  expert: {
    main: [
      { href: '/', label: 'کارهای امروز من' }, // «کارهای امروز من» page does not exist yet → nearest existing page
      { href: '/today' }, // crm-daily-plan: only present when flag.daily_plan is ON (then «/my-queue» is filtered out)
      { href: '/my-queue' }, // crm-call-queue: only present when flag.queue is ON (otherwise filtered out before layout)
      { href: '/customers', label: 'مشتری‌های من' },
      { href: '/loan-applications', label: 'پرونده‌های وام من' },
      { href: '/payment-orders' },
      { href: '/messengers', label: 'گفتگو در پیام‌رسان‌ها' },
      { href: '/internal-chat' },
      { href: '/my-performance', label: 'عملکرد و پورسانت من', fallback: '/sales-commissions' },
      { action: 'assistant', label: 'چت دستیار' },
    ],
    more: [{ id: 'more', hrefs: ['/reminders', '/calls', '/callback-requests', '/consultations', '/loan-plans', '/smart-filing', '/goods-purchases', '/chat', '/phone', '/settings/bale', '/mobile-calls', '/my-wallet', '/sales-commissions', '/contracts', '/wallet-management', '/bank-accounts'] }],
    shortcuts: ['/', '/customers', '/messengers', '/internal-chat'],
  },
  // «کارهای امروز من» for trainees is UNDECIDED → «/» keeps its old label.
  trainee: {
    main: [{ href: '/' }, { href: '/customers', label: 'مشتری‌های من' }, { href: '/loan-applications', label: 'پرونده‌های وام من' }, { href: '/reminders' }, { href: '/loan-plans' }, { href: '/internal-chat' }],
    more: [{ id: 'more', hrefs: ['/calls', '/consultations', '/callback-requests', '/my-wallet', '/chat', '/phone'] }],
    hide: ['/mobile-calls', '/contracts', '/goods-purchases', '/sales-commissions', '/my-performance', '/payment-orders', '/wallet-management', '/bank-accounts', '/messengers'],
    shortcuts: ['/', '/customers', '/reminders', '/internal-chat'],
  },
  registrar: {
    main: [{ href: '/', label: 'کارتابل ثبت من' }, { href: '/loan-applications' }, { href: '/smart-filing' }, { href: '/goods-purchases' }, { href: '/internal-chat' }],
    more: [{ id: 'more', hrefs: ['/customers', '/contracts', '/loan-plans', '/payment-orders', '/reminders', '/chat', '/phone', '/instagram-inbox'] }],
    hide: ['/calls', '/consultations', '/callback-requests', '/sales-commissions', '/my-performance', '/wallet-management', '/bank-accounts', '/messengers', '/mobile-calls'],
    shortcuts: ['/', '/loan-applications', '/smart-filing', '/internal-chat'],
  },
  // Admin: nothing removed, only re-ordered; the other 24 items sit under a grouped «بیشتر».
  admin: {
    main: [{ href: '/', label: 'داشبورد مدیر فروش' }, { href: '/loan-applications' }, { href: '/customers' }, { href: '/calls' }, { href: '/goods-purchases' }, { href: '/payment-orders' }, { href: '/internal-chat' }, { href: '/sales-reports' }, { href: '/settings/assistants' }],
    more: [
      { id: 'sales', label: 'فروش', hrefs: ['/daily-plans', '/reminders', '/consultations', '/callback-requests', '/smart-filing', '/loan-plans', '/contracts'] },
      { id: 'finance', label: 'مالی', hrefs: ['/sales-commissions', '/my-performance', '/my-wallet', '/wallet-management', '/bank-accounts', '/accounting'] },
      { id: 'comms', label: 'پیام و تلفن', hrefs: ['/chat', '/messengers', '/settings/bale', '/instagram-inbox', '/mobile-calls', '/phone'] },
      { id: 'exceptions', label: 'استثناها', hrefs: ['/manual-verifications', '/credit-rank-overrides'] },
      { id: 'settings', label: 'تنظیمات', hrefs: ['/social-monitor-reports', '/voice-notes-usage', '/users', '/settings/notifications', '/settings/releases'] },
    ],
    shortcuts: ['/', '/loan-applications', '/customers', '/internal-chat'],
  },
};

export type LaidOut<T> = { main: Array<{ kind: 'link'; item: T } | { kind: 'assistant'; label: string }>; more: Array<{ id: string; label?: string; items: T[] }>; shortcuts: T[] };

/** `visible` = items that already passed the permission filter. Pure re-arrangement of that list. */
export function layoutFor<T extends { href: string; label: string }>(kind: MenuKind, visible: T[]): LaidOut<T> {
  const cfg = ROLE_MENUS[kind];
  const by = new Map(visible.map((i) => [i.href, i]));
  const used = new Set<string>();
  const main: LaidOut<T>['main'] = [];
  for (const e of cfg.main) {
    if ('action' in e) { main.push({ kind: 'assistant', label: e.label }); continue; }
    const href = by.has(e.href) ? e.href : e.fallback && by.has(e.fallback) ? e.fallback : null;
    if (!href || used.has(href)) continue;
    used.add(href); main.push({ kind: 'link', item: { ...by.get(href)!, label: e.label ?? by.get(href)!.label } });
  }
  const hidden = new Set(cfg.hide ?? []);
  const more = cfg.more.map((g) => ({ id: g.id, label: g.label, items: g.hrefs.filter((h) => by.has(h) && !used.has(h) && !hidden.has(h)).map((h) => (used.add(h), by.get(h)!)) }));
  // Safety net: a permitted item this layout does not mention (e.g. a future page) is never lost — it goes to «بیشتر».
  const rest = visible.filter((i) => !used.has(i.href) && !hidden.has(i.href));
  if (rest.length) more[more.length - 1].items.push(...rest);
  const mainItems = main.flatMap((m) => (m.kind === 'link' ? [m.item] : []));
  const shortcuts = cfg.shortcuts.map((h) => mainItems.find((i) => i.href === h) ?? null).filter((i): i is T => Boolean(i));
  return { main, more: more.filter((g) => g.items.length), shortcuts };
}
