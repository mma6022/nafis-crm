import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, Inbox, Phone, Star, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { decideCreditPermission, fetchNotifications, markAllNotificationsRead, markNotificationRead, safeTarget, NotificationApiError, type NotificationUser, type SiteNotification } from './api';
import './notifications.css';
import { AssistantAvatar } from '@/features/assistant/AssistantAvatar';
import '@/features/assistant/assistant.css';
import { claimOnce, tabLeader, tabVisible } from '@/lib/tab-coordinator';
/** Asks the assistant dock to open one chat (AssistantDock listens; ignored when that assistant is not this user's). */
export const openAssistantThread = (threadId: number) => window.dispatchEvent(new CustomEvent('nafis:assistant-open', { detail: { threadId } }));

// perf 2026-10-26: one tick, gated per tab — visible tabs every 10 s, the hidden leader tab every 30 s, other hidden tabs never.
const POLL_MS = 5000;
const VISIBLE_EVERY_MS = 10_000;
const HIDDEN_LEADER_EVERY_MS = 30_000;
const MAX_TOASTS = 3;
const TOAST_MS = 10000;
const PAGE_ENUMS = ['customers','chat','instagram-inbox','loan-applications','goods-purchases','contracts','payment-orders','calls','consultations','wallet-management','smart-filing','my-performance'];
const PAGE_LABELS: Record<string, string> = { 'smart-filing': 'ثبت هوشمند', customers: 'مشتریان', chat: 'گفتگو', 'instagram-inbox': 'دایرکت اینستاگرام', 'loan-applications': 'تسهیلات', 'goods-purchases': 'خرید کالا', contracts: 'قراردادها', 'payment-orders': 'دستورهای پرداخت', calls: 'تماس‌ها', consultations: 'مشاوره‌ها', 'wallet-management': 'کیف پول', 'my-performance': 'تحلیل عملکرد من' };

export function pageForPath(path: string): string | null {
  const seg = path.split('?')[0].split('/')[1] ?? '';
  return PAGE_ENUMS.includes(seg) ? seg : null;
}
const isLoan = (n: SiteNotification) => n.page === 'loan-applications' || n.target?.startsWith('/loan-applications');
/** New priority-1 customer for a closer (team sales). Sticky toast until acted on. */
export const isP1 = (n: SiteNotification) => n.kind === 'p1_assigned';
/** crm-site-leads: «مشتری خواسته صبح/عصر تماس بگیرید» at the start of the asked window (the lead's current owner: Kazemi / Hasani / Ghasemi). Sticky + chime. */
export const isSiteLeadWindow = (n: SiteNotification) => n.kind === 'site-lead-window';
const isSticky = (n: SiteNotification) => isP1(n) || isSiteLeadWindow(n);
/** Short two-tone chime (WebAudio, no asset). Silently skipped when the browser blocks audio. */
export function playSiteLeadChime() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const t0 = ctx.currentTime;
    [[880, 0], [660, 0.22], [880, 0.44]].forEach(([f, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.25, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.2);
      o.connect(g).connect(ctx.destination); o.start(t0 + d); o.stop(t0 + d + 0.21);
    });
    window.setTimeout(() => { void ctx.close().catch(() => {}); }, 1200);
  } catch { /* audio unavailable */ }
}
async function customerPhone(customerId: number): Promise<string | null> {
  try {
    const r = await fetch(`${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/api/customers/${customerId}`, { credentials: 'include' });
    if (!r.ok) return null;
    const body = await r.json();
    return typeof body?.phone === 'string' && /^\+?\d{6,15}$/.test(body.phone) ? body.phone : null;
  } catch { return null; }
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(d);
};

type Ctx = { unreadCount: number; pageCounts: Record<string, number>; tick: number; scopeVersion: string; applyReadAll: (page: string | null) => void; refresh: () => void; applyRead: (n: SiteNotification) => void; openItem: (n: SiteNotification) => Promise<void> };
const NotifCtx = createContext<Ctx>({ unreadCount: 0, pageCounts: {}, tick: 0, scopeVersion: '', applyReadAll: () => {}, refresh: () => {}, applyRead: () => {}, openItem: async () => {} });
export const useSiteNotifications = () => useContext(NotifCtx);

/** Badge for a nav tab; href like /loan-applications. */
export function NavNotificationBadge({ href }: { href: string }) {
  const { pageCounts } = useSiteNotifications();
  const c = pageCounts[href] ?? 0;
  if (c <= 0) return null;
  return <b className="sn-nav-badge" aria-label={`${c.toLocaleString('fa-IR')} اعلان خوانده‌نشده`} data-testid={`badge-nav-notification${href.replace(/\//g, '-')}`}>{c > 99 ? '+۹۹' : c.toLocaleString('fa-IR')}</b>;
}

export function NotificationProvider({ user, children }: { user: NotificationUser; children: ReactNode }) {
  return user ? <ProviderInner key={user.id}>{children}</ProviderInner> : <>{children}</>;
}

function ProviderInner({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const [scopeVersion, setScopeVersion] = useState('');
  const authEpoch = useRef(0);
  const [toastError, setToastError] = useState('');
  const countsRef = useRef({ unread: 0, pages: {} as Record<string, number> });
  const [toasts, setToasts] = useState<SiteNotification[]>([]);
  const alive = useRef(true);
  const lastSeen = useRef<number | null>(null);
  const scope = useRef<string | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const gen = useRef(0);
  const localRead = useRef(new Set<number>());

  const lastAt = useRef(0);
  const refresh = useCallback(async () => {
    if (inflight.current) { again.current = true; return; }
    inflight.current = true; lastAt.current = Date.now();
    const myGen = gen.current;
    try {
      const page = await fetchNotifications({ limit: 30 });
      if (!alive.current) return;
      if (myGen !== gen.current) { again.current = true; return; }
      const changed = scope.current !== null && scope.current !== page.scopeVersion;
      scope.current = page.scopeVersion;
      // A new priority-1 customer changes the closer's scope (she now owns the customer). Older events of newly
      // visible customers must not toast, but the p1_assigned event created after our last poll still should.
      const prevSeen = lastSeen.current;
      const freshP1 = changed && prevSeen !== null ? page.items.filter((n) => isP1(n) && n.id > prevSeen && !n.readAt) : [];
      if (changed) { localRead.current.clear(); setToasts(freshP1.sort((a, b) => a.id - b.id).slice(-MAX_TOASTS)); setToastError(''); lastSeen.current = null; }
      setScopeVersion(`${authEpoch.current}:${page.scopeVersion}`);
      countsRef.current = { unread: page.unreadCount, pages: page.pageCounts ?? {} };
      setUnreadCount(page.unreadCount);
      setPageCounts(page.pageCounts ?? {});
      if (lastSeen.current === null) lastSeen.current = page.latestId;
      else {
        const fresh = page.items.filter((n) => n.id > lastSeen.current! && !n.readAt && !localRead.current.has(n.id) && (isLoan(n) || isSticky(n))).sort((a, b) => a.id - b.id);
        lastSeen.current = Math.max(lastSeen.current, page.latestId);
        if (fresh.some(isSiteLeadWindow) && claimOnce('site-chime:' + Math.max(...fresh.map((n) => n.id)))) playSiteLeadChime();
        if (fresh.length) setToasts((t) => [...t, ...fresh.filter((n) => !t.some((x) => x.id === n.id))].slice(-MAX_TOASTS));
      }
      setTick((x) => x + 1);
    } catch (e) {
      if (alive.current && e instanceof NotificationApiError && (e.status === 401 || e.status === 403)) {
        authEpoch.current += 1; gen.current += 1; countsRef.current = { unread: 0, pages: {} };
        setScopeVersion(`${authEpoch.current}:auth-failed`); setToastError('');
        setToasts([]); setUnreadCount(0); setPageCounts({}); lastSeen.current = null; scope.current = null; localRead.current.clear();
      }
    } finally {
      inflight.current = false;
      if (alive.current && again.current) { again.current = false; void refresh(); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      const every = tabVisible() ? VISIBLE_EVERY_MS : tabLeader() ? HIDDEN_LEADER_EVERY_MS : 0;
      if (every && Date.now() - lastAt.current >= every - 500) void refresh();
    }, POLL_MS);
    const wake = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [refresh]);

  useEffect(() => {
    // Priority-1 toasts stay until the closer acts on or dismisses them; others auto-dismiss.
    const first = toasts.find((n) => !isSticky(n));
    if (!first) return;
    const timer = setTimeout(() => setToasts((t) => t.filter((x) => x.id !== first.id)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  const applyRead = useCallback((n: SiteNotification) => {
    gen.current += 1;
    if (!n.readAt && !localRead.current.has(n.id)) {
      localRead.current.add(n.id);
      const k = n.page ? '/' + n.page.replace(/^\//, '') : null;
      const cur = countsRef.current;
      countsRef.current = { unread: Math.max(0, cur.unread - 1), pages: k && cur.pages[k] ? { ...cur.pages, [k]: Math.max(0, cur.pages[k] - 1) } : cur.pages };
      setUnreadCount(countsRef.current.unread);
      setPageCounts(countsRef.current.pages);
    }
    setToasts((t) => t.filter((x) => x.id !== n.id));
    void refresh();
  }, [refresh]);

  const applyReadAll = useCallback((page: string | null) => {
    gen.current += 1;
    const cur = countsRef.current;
    if (page) {
      const k = '/' + page.replace(/^\//, '');
      const removed = cur.pages[k] ?? 0;
      countsRef.current = { unread: Math.max(0, cur.unread - removed), pages: { ...cur.pages, [k]: 0 } };
      setToasts((ts) => ts.filter((n) => n.page !== page));
    } else {
      countsRef.current = { unread: 0, pages: Object.fromEntries(Object.keys(cur.pages).map((k) => [k, 0])) };
      setToasts([]);
    }
    setUnreadCount(countsRef.current.unread);
    setPageCounts(countsRef.current.pages);
    void refresh();
  }, [refresh]);

  const openItem = useCallback(async (n: SiteNotification) => {
    const res = await markNotificationRead(n.id);
    if (!alive.current) return;
    applyRead(n);
    const target = safeTarget(res.target) ?? safeTarget(n.target);
    if (target) navigate(target);
  }, [applyRead, navigate]);

  const value = useMemo(() => ({ unreadCount, pageCounts, tick, scopeVersion, applyReadAll, refresh: () => void refresh(), applyRead, openItem }), [unreadCount, pageCounts, tick, scopeVersion, applyReadAll, refresh, applyRead, openItem]);

  return (
    <NotifCtx.Provider value={value}>
      {children}
      {toasts.some(isSticky) ? (
        <div className="sn-toasts sn-top" role="status" aria-live="assertive" data-testid="notification-toasts-p1">
          {toasts.filter(isSticky).map((n) => (
            <div className={`sn-toast p1${isSiteLeadWindow(n) ? ' slw' : ''}`} key={n.id} data-testid={`toast-notification-${n.id}`} data-kind={n.kind ?? 'p1_assigned'}>
              <div className="sn-p1-row">
                <span className="sn-p1-ic" aria-hidden="true">{isSiteLeadWindow(n) ? <AlarmClock size={20} /> : <Star size={20} />}</span>
                <div className="sn-p1-text"><strong>{n.title}</strong><span>{isSiteLeadWindow(n) && n.customerName ? `${customerNameText(n.customerName, n.customerId)}: ` : ''}{n.body}</span></div>
                <button type="button" className="sn-toast-x" aria-label="بستن اعلان" onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))} data-testid={`button-toast-dismiss-${n.id}`}><X size={15} /></button>
              </div>
              <div className="sn-p1-acts">
                <button type="button" className="sn-p1-call" onClick={() => { setToastError(''); void (async () => {
                  const phone = await customerPhone(n.customerId);
                  if (!phone) { openItem(n).catch(() => setToastError('باز کردن پرونده انجام نشد.')); return; }
                  markNotificationRead(n.id).then(() => applyRead(n), () => applyRead(n));
                  window.location.href = `tel:${phone}`;
                })(); }} data-testid={`button-toast-call-${n.id}`}><Phone size={16} /> تماس</button>
                <button type="button" className="sn-p1-open" onClick={() => { setToastError(''); openItem(n).catch((e) => setToastError(e instanceof Error ? e.message : 'باز کردن اعلان انجام نشد.')); }} data-testid={`button-toast-open-${n.id}`}>پرونده</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {toasts.some((n) => !isSticky(n)) ? (
        <div className="sn-toasts" role="status" aria-live="polite" data-testid="notification-toasts">
          {toasts.filter((n) => !isSticky(n)).map((n) => (
            <div className="sn-toast" key={n.id} data-testid={`toast-notification-${n.id}`}>
              <button type="button" className="sn-toast-main" onClick={() => { setToastError(''); openItem(n).catch((e) => setToastError(e instanceof Error ? e.message : 'باز کردن اعلان انجام نشد.')); }} data-testid={`button-toast-open-${n.id}`}>
                <strong>{n.title}</strong>
                <span>{n.customerName ? `${customerNameText(n.customerName, n.customerId)}: ` : ''}{n.body}</span>
              </button>
              <button type="button" className="sn-toast-x" aria-label="بستن اعلان" onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))} data-testid={`button-toast-dismiss-${n.id}`}><X size={15} /></button>
            </div>
          ))}
        </div>
      ) : null}
      {toastError ? <div className="sn-toasts" style={{ bottom: toasts.some((n) => !isSticky(n)) ? 16 + toasts.filter((n) => !isSticky(n)).length * 70 : 16 }} role="alert" data-testid="toast-notification-error"><div className="sn-toast"><span style={{ flex: 1, fontSize: 12 }}>{toastError}</span><button type="button" className="sn-toast-x" aria-label="بستن" onClick={() => setToastError('')}><X size={15} /></button></div></div> : null}
    </NotifCtx.Provider>
  );
}

export function NotificationBell({ user }: { user: NotificationUser }) {
  return user ? <BellInner key={user.id} /> : null;
}

function BellInner() {
  const [location] = useLocation();
  const { unreadCount, pageCounts, tick, scopeVersion, applyReadAll, refresh, applyRead, openItem } = useSiteNotifications();
  const currentPage = pageForPath(location);
  const [allFor, setAllFor] = useState<string | null | undefined>(undefined);
  const allScope = currentPage ? allFor === currentPage : true;
  const scopePage = allScope ? null : currentPage;
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<Map<number, SiteNotification>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const gen = useRef(0);
  const key = `${scopePage ?? '*'}|${unreadOnly}`;
  const cursorSet = useRef(false);
  const latestRef = useRef(0);

  const load = useCallback(async (reset: boolean) => {
    const g = gen.current;
    try {
      const page = await fetchNotifications({ limit: 30, unreadOnly, page: scopePage });
      if (gen.current !== g) return;
      latestRef.current = Math.max(latestRef.current, page.latestId);
      setItems((prev) => { const next = new Map(reset ? [] : prev); page.items.forEach((n) => next.set(n.id, n)); return next; });
      if (reset || !cursorSet.current) { cursorSet.current = true; setCursor(page.nextCursor); }
      setStatus('ready'); setError('');
    } catch (e) {
      if (gen.current !== g) return;
      setError(e instanceof Error ? e.message : 'دریافت اعلان‌ها ناموفق بود.');
      setStatus((s) => (s === 'loading' || !reset ? (s === 'loading' ? 'error' : s) : s));
    }
  }, [unreadOnly, scopePage]);

  // scope / route / filter change: reset list and cursor
  useEffect(() => {
    gen.current += 1;
    cursorSet.current = false; latestRef.current = 0; setCursor(null); setItems(new Map()); setStatus('loading'); setError(''); setLoadingOlder(false);
    if (open) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, scopeVersion]);
  // background poll tick: merge newest page
  useEffect(() => { if (open && status !== 'loading') void load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = btnRef.current?.getBoundingClientRect(); if (!anchor) return;
      const viewport = window.visualViewport;
      const start = viewport?.offsetLeft ?? 0, end = start + (viewport?.width ?? document.documentElement.clientWidth);
      const ceiling = viewport?.offsetTop ?? 0, bottom = ceiling + (viewport?.height ?? window.innerHeight);
      const site = wrapRef.current?.closest('.app-shell')?.getBoundingClientRect();
      const leftEdge = Math.max(start, site?.left ?? start) + 12, rightEdge = Math.min(end, site?.right ?? end) - 12;
      const width = Math.max(1, Math.min(380, rightEdge - leftEdge));
      const left = Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width));
      const below = bottom - 12 - anchor.bottom - 8, above = anchor.top - 8 - ceiling - 12;
      const flip = below < 160 && above > below;
      const maxHeight = Math.max(1, Math.min(520, Math.max(below, flip ? above : below), bottom - ceiling - 24));
      const top = Math.max(ceiling + 12, Math.min(flip ? anchor.top - 8 - maxHeight : anchor.bottom + 8, bottom - 12 - maxHeight));
      setPanelStyle({ left, top, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);

  const sorted = useMemo(() => [...items.values()].sort((a, b) => b.id - a.id), [items]);
  const visible = unreadOnly ? sorted.filter((n) => !n.readAt) : sorted;

  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    const g = gen.current;
    setLoadingOlder(true);
    try {
      const page = await fetchNotifications({ limit: 30, beforeId: cursor, unreadOnly, page: scopePage });
      if (gen.current !== g) return;
      setItems((prev) => { const next = new Map(prev); page.items.forEach((n) => { if (!next.has(n.id)) next.set(n.id, n); }); return next; });
      setCursor(page.nextCursor); setError('');
    } catch (e) { if (gen.current === g) setError(e instanceof Error ? e.message : 'دریافت ناموفق بود.'); }
    finally { if (gen.current === g) setLoadingOlder(false); }
  };

  const markItemLocal = (id: number) => setItems((prev) => { const n = prev.get(id); if (!n || n.readAt) return prev; return new Map(prev).set(id, { ...n, readAt: new Date().toISOString() }); });

  const markOne = async (n: SiteNotification) => {
    try {
      await markNotificationRead(n.id);
      gen.current += 1;
      markItemLocal(n.id); applyRead(n); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'ثبت وضعیت ناموفق بود.'); }
  };

  const activate = async (n: SiteNotification) => {
    try { await openItem(n); gen.current += 1; markItemLocal(n.id); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'باز کردن اعلان انجام نشد.'); }
  };

  const markAll = async () => {
    const through = latestRef.current;
    if (!through) return;
    try {
      await markAllNotificationsRead(through, scopePage);
      gen.current += 1;
      applyReadAll(scopePage);
      setItems((prev) => { const next = new Map(prev); next.forEach((n, id) => { if (id <= through && !n.readAt) next.set(id, { ...n, readAt: new Date().toISOString() }); }); return next; });
      void load(true); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'ثبت وضعیت ناموفق بود.'); }
  };

  const shown = scopePage ? (pageCounts['/' + scopePage] ?? 0) : unreadCount;
  const countLabel = unreadCount > 99 ? '+۹۹' : unreadCount.toLocaleString('fa-IR');
  const scopeLabel = scopePage ? PAGE_LABELS[scopePage] : 'همه صفحه‌ها';

  return (
    <div className="sn-wrap" ref={wrapRef} data-testid="notification-bell">
      <button ref={btnRef} type="button" className="icon-button" aria-label={unreadCount > 0 ? `اعلان‌ها، ${unreadCount.toLocaleString('fa-IR')} خوانده‌نشده` : 'اعلان‌ها'} title="اعلان‌ها" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="button-notifications">
        <Inbox size={18} />
        {unreadCount > 0 ? <span className="sn-badge" data-testid="badge-notification-unread" aria-hidden="true">{countLabel}</span> : null}
      </button>
      {open ? createPortal(
        <div ref={panelRef} dir="rtl" className="sn-panel" style={panelStyle ?? { visibility: 'hidden' }} role="dialog" aria-label="اعلان‌های سایت" data-testid="panel-notifications">
          <div className="sn-head">
            <strong>اعلان‌ها</strong>
            <button type="button" className="sn-link" onClick={() => void markAll()} disabled={shown === 0} data-testid="button-notifications-read-all">خواندن همه{scopePage ? ' این صفحه' : ''}</button>
          </div>
          {currentPage ? (
            <div className="sn-tabs" role="group" aria-label="دامنه اعلان‌ها">
              <button type="button" className="sn-tab" aria-pressed={!allScope} onClick={() => setAllFor(undefined)} data-testid="button-notifications-scope-page">این صفحه ({(pageCounts['/' + currentPage] ?? 0).toLocaleString('fa-IR')})</button>
              <button type="button" className="sn-tab" aria-pressed={allScope} onClick={() => setAllFor(currentPage)} data-testid="button-notifications-scope-all">همه صفحه‌ها ({unreadCount.toLocaleString('fa-IR')})</button>
            </div>
          ) : null}
          <div className="sn-tabs" role="group" aria-label="فیلتر اعلان‌ها">
            <button type="button" className="sn-tab" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)} data-testid="button-notifications-all">همه</button>
            <button type="button" className="sn-tab" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)} data-testid="button-notifications-unread">خوانده‌نشده</button>
          </div>
          {status === 'loading' ? (
            <div role="status" aria-label="در حال بارگذاری" data-testid="status-notifications-loading"><div className="sn-skel" /><div className="sn-skel" /><div className="sn-skel" /></div>
          ) : status === 'error' ? (
            <div className="sn-state" role="alert" data-testid="status-notifications-error"><span>{error || 'دریافت اعلان‌ها ناموفق بود.'}</span><button type="button" className="btn btn-ghost" onClick={() => { setStatus('loading'); void load(true); }} data-testid="button-notifications-retry">تلاش دوباره</button></div>
          ) : (
            <>
              {error ? <div className="sn-state" role="alert" style={{ padding: '8px 14px', color: '#9b2c2c' }} data-testid="status-notifications-warn">{error}</div> : null}
              {visible.length === 0 ? (
                <div className="sn-state" data-testid="status-notifications-empty">{unreadOnly ? `اعلان خوانده‌نشده‌ای در «${scopeLabel}» ندارید.` : `هنوز اعلانی در «${scopeLabel}» ثبت نشده است.`}</div>
              ) : (
                <ul className="sn-list" aria-label="فهرست اعلان‌ها" data-testid="list-notifications">
                  {visible.map((n) => (
                    <li key={n.id} className="sn-row">
                      <button type="button" className={`sn-item ${n.readAt ? '' : 'unread'}${isP1(n) ? ' p1' : ''}${n.assistant ? ' as' : ''}`} onClick={() => void activate(n)} data-testid={`item-notification-${n.id}`} data-kind={n.kind}>
                        {n.assistant ? <span className="sn-asav"><AssistantAvatar slug={n.assistant.slug} size={32} /></span> : null}
                        <span className="sn-title">{isP1(n) ? <Star size={14} className="sn-star" aria-label="اولویت ۱" /> : null}{n.title}</span>
                        <span className="sn-body">{n.body}</span>
                        <span className="sn-meta"><span>{n.customerName ? <CustomerName id={n.customerId} name={n.customerName} /> : null}{allScope && n.page && n.kind !== 'bale-unknown' && PAGE_LABELS[n.page] ? ` · ${PAGE_LABELS[n.page]}` : ''}</span><time dateTime={n.createdAt}>{fmtTime(n.createdAt)}</time></span>
                      </button>
                      {n.action?.type === 'credit-permission' ? <CreditActions n={n} onDone={(status) => { setItems((prev) => { const cur = prev.get(n.id); if (!cur || !cur.action) return prev; return new Map(prev).set(n.id, { ...cur, readAt: cur.readAt ?? new Date().toISOString(), action: { ...cur.action, open: false, status } }); }); if (!n.readAt) void markNotificationRead(n.id).catch(() => {}); }} onOpen={() => void activate(n)} /> : null}
                      {n.assistant ? <button type="button" className="sn-read sn-asopen" onClick={() => { const t = n.assistant!.threadId; if (!n.readAt) void markOne(n); setOpen(false); openAssistantThread(t); }} data-testid={`button-notification-assistant-open-${n.id}`}>باز کردن گفتگو</button> : null}
                      {n.readAt ? null : <button type="button" className="sn-read" onClick={() => void markOne(n)} data-testid={`button-notification-read-${n.id}`}>خوانده شد</button>}
                    </li>
                  ))}
                </ul>
              )}
              {cursor ? <button type="button" className="sn-more" onClick={() => void loadOlder()} disabled={loadingOlder} data-testid="button-notifications-older">{loadingOlder ? 'در حال دریافت…' : 'نمایش قدیمی‌تر'}</button> : null}
            </>
          )}
        </div>, document.body
      ) : null}
    </div>
  );
}

export default NotificationBell;

/** Shot 40: «اجازه می‌دهم» / «رد» + «دیدن پرونده‌ی ثبت» on a manager's credit-inquiry permission row. */
function CreditActions({ n, onDone, onOpen }: { n: SiteNotification; onDone: (status: string) => void; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const a = n.action!;
  const decide = async (approve: boolean) => {
    if (!approve && !window.confirm('اجازه‌ی استعلام رد شود؟')) return;
    setBusy(true); setErr('');
    try { await decideCreditPermission(a.jobId, approve); onDone(approve ? 'approved' : 'rejected'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'ثبت تصمیم انجام نشد.'); } finally { setBusy(false); }
  };
  const done = a.status === 'approved' ? 'اجازه داده شد' : a.status === 'rejected' ? 'رد شد' : a.status === 'cancelled' ? 'درخواست لغو شد' : null;
  return (
    <div className="sn-credit" data-testid={`notification-credit-${n.id}`}>
      {a.open ? (
        <div className="sn-credit-btns">
          <button type="button" className="sn-credit-yes" disabled={busy} onClick={() => void decide(true)} data-testid={`button-credit-approve-${n.id}`}>اجازه می‌دهم</button>
          <button type="button" className="sn-credit-no" disabled={busy} onClick={() => void decide(false)} data-testid={`button-credit-reject-${n.id}`}><X size={14} /> رد</button>
        </div>
      ) : done ? <span className="sn-credit-done">{done}</span> : null}
      <button type="button" className="sn-link" onClick={onOpen} data-testid={`button-credit-open-${n.id}`}>دیدن پرونده‌ی ثبت</button>
      {err ? <span className="sn-credit-err" role="alert">{err}</span> : null}
    </div>
  );
}
