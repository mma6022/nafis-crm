/* t979 v1.1 — «پیام‌های آماده» with three tabs (طرح‌ها / عمومی / آموزشی). Pure model shared by the four surfaces
   (Bale chat tray, customer file, today wizard, social-hub settings). No React, no aliases: unit-tested by scripts/t979-quick-replies-ui-fixture.mjs.
   One source (sh_messages); every message lives in exactly one tab. */

export type QrTab = 'plans' | 'general' | 'educational';
export const QR_TABS: { id: QrTab; label: string }[] = [
  { id: 'plans', label: 'طرح‌ها' },
  { id: 'general', label: 'عمومی' },
  { id: 'educational', label: 'آموزشی' },
];
export const QR_TAB_LABEL: Record<QrTab, string> = { plans: 'طرح‌ها', general: 'عمومی', educational: 'آموزشی' };
/** What each tab holds, shown under the type cards of the editor and the type editor in the preview. */
export const QR_TAB_HINT: Record<QrTab, string> = {
  plans: 'وابسته به یک طرح',
  general: 'پیام روزمره',
  educational: 'راهنمای مشتری',
};
/** Empty state per tab (design §2). */
export const QR_EMPTY: Record<QrTab, { h: string; p: string }> = {
  plans: { h: 'پیام طرحی نیست', p: 'برای طرح‌های فعال هنوز پیامی ساخته نشده است.' },
  general: { h: 'پیام عمومی‌ای نیست', p: 'مدیر فروش پیام‌های عمومی را در مدیریت شبکه‌های اجتماعی می‌سازد.' },
  educational: { h: 'هنوز پیام آموزشی‌ای نیست.', p: 'مدیر فروش این پیام‌ها را در مدیریت شبکه‌های اجتماعی می‌سازد.' },
};

export type QrItem = {
  id: number; kind: 'free' | 'plan'; planId: number | null; planTitle: string | null; title: string; body: string;
  tab?: QrTab; category?: 'general' | 'educational' | null; showToday?: boolean;
};

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fdig = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);

export type TabLike = Pick<QrItem, 'kind' | 'tab' | 'category'>;
export const tabOf = (it: TabLike): QrTab =>
  it.tab ?? (it.kind === 'plan' ? 'plans' : it.category === 'educational' ? 'educational' : 'general');

export const countByTab = (items: TabLike[]): Record<QrTab, number> => {
  const c: Record<QrTab, number> = { plans: 0, general: 0, educational: 0 };
  for (const it of items) c[tabOf(it)]++;
  return c;
};
export const inTab = <T extends TabLike>(items: T[], tab: QrTab): T[] => items.filter((it) => tabOf(it) === tab);

/** Same placeholder rule as the server's shRender: ‹نام مشتری› / ‹نام کارشناس› / ‹نام طرح›; unknown → empty. */
export function renderText(it: QrItem, vars: { customer?: string | null; expert?: string | null }): string {
  const map: Record<string, string> = { 'نام مشتری': vars.customer ?? '', 'نام کارشناس': vars.expert ?? '', 'نام طرح': it.kind === 'plan' ? (it.planTitle ?? '') : '' };
  return it.body.replace(/[‹«{]\s*(نام مشتری|نام کارشناس|نام طرح)\s*[›»}]/g, (_m, k: string) => map[k] || '').trim();
}

/** Search text: Arabic yeh/kaf → Persian, drop ZWNJ and diacritics, Persian/Arabic digits → latin, lowercase. */
export const normFa = (s: string) => s
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[\u064B-\u065F\u200c\u200d]/g, '')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .toLowerCase();
export const matchesQuery = (it: QrItem, q: string) => {
  const n = normFa(q).trim(); if (!n) return true;
  return normFa(`${it.title} ${it.body} ${it.planTitle ?? ''}`).includes(n);
};

export type PlanGroup = { planId: number; title: string; items: QrItem[]; explained: boolean; current: boolean; open: boolean };
/** Plans tab: items grouped by plan. Order: plans explained in this chat, then the customer's current plan, then the rest in the list's own order.
 *  A group is open when the plan was explained in this chat (or, when none was, it is the current plan); the expert's own toggles win;
 *  a search opens every group that still has a match. `only` limits to one plan (today wizard). */
export function planGroups(items: QrItem[], o: { explained?: number[]; currentPlanId?: number | null; query?: string; only?: number | null; toggled?: Record<number, boolean> } = {}): PlanGroup[] {
  const explained = o.explained ?? []; const q = (o.query ?? '').trim();
  const by = new Map<number, PlanGroup>();
  for (const it of items) {
    if (tabOf(it) !== 'plans' || it.planId == null) continue;
    if (o.only != null && it.planId !== o.only) continue;
    if (q && !matchesQuery(it, q)) continue;
    let g = by.get(it.planId);
    if (!g) { g = { planId: it.planId, title: it.planTitle ?? 'طرح', items: [], explained: explained.includes(it.planId), current: o.currentPlanId === it.planId, open: false }; by.set(it.planId, g); }
    g.items.push(it);
  }
  const all = [...by.values()];
  const anyExplained = all.some((g) => g.explained);
  for (const g of all) g.open = o.toggled && g.planId in o.toggled ? !!o.toggled[g.planId] : q ? true : anyExplained ? g.explained : g.current;
  const rank = (g: PlanGroup) => (g.explained ? 0 : g.current ? 1 : 2);
  return all.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
}

/** The tab to open with: the expert's last tab when valid; otherwise «طرح‌ها» if a plan was explained in this chat (and has messages), else «عمومی». */
export function defaultTab(items: TabLike[], explained: number[], saved: string | null): QrTab {
  if (saved === 'plans' || saved === 'general' || saved === 'educational') return saved;
  const c = countByTab(items);
  return explained.length && c.plans ? 'plans' : 'general';
}
const KEY = 'nf.qr.tab';
export function loadTab(st?: { getItem(k: string): string | null } | null): string | null {
  try { return (st ?? (typeof localStorage !== 'undefined' ? localStorage : null))?.getItem(KEY) ?? null; } catch { return null; }
}
export function saveTab(t: QrTab, st?: { setItem(k: string, v: string): void } | null) {
  try { (st ?? (typeof localStorage !== 'undefined' ? localStorage : null))?.setItem(KEY, t); } catch { /* private mode */ }
}

/** Error text for the three v1.1 endpoints (the server's codes → words an expert reads). */
export const QR_ERR: Record<string, string> = {
  already_sent: 'پیام همین الان رفت؛ دیگر برگردانده نمی‌شود.',
  plan_required: 'برای نوع «طرح‌ها» یک طرح فعال را انتخاب کنید.',
  tab_invalid: 'این نوع پیام شناخته نشد.',
  flag_off: 'این قابلیت فعلاً خاموش است.',
};
