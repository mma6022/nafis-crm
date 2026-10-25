import { CustomerName } from '@/components/customer/CustomerName';
import { AudioLines, BarChart3, Bot, Banknote, Bell, BellRing, ChevronDown, ClipboardList, Contact, FileSignature, HandCoins, Headset, Landmark, Layers, LayoutDashboard, LifeBuoy, LogOut, Menu, MessageCircle, MessagesSquare, Pencil, Phone, PhoneCall, PhoneIncoming, PieChart, Radar, Receipt, Rocket, Save, Send, Settings, ShieldAlert, ShieldCheck, ShoppingBag, SlidersHorizontal, Smartphone, Store, UserCog, UsersRound, Wallet, Building2, Coins, Instagram, Calculator, X, type LucideIcon } from 'lucide-react';
import { UserAvatar, AvatarPicker } from '@/components/UserAvatar';
import { useHealthCheck, getHealthCheckQueryKey, useGetAuthSession, useLogout, useUpdateAuthProfile, useListReminders, useAcknowledgeReminder, getListRemindersQueryKey, getGetAuthSessionQueryKey, type CrmUser, type Reminder } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { usePresence } from '@/chat/Presence';
import { fetchStaffUnread, staffChatPresence } from '@/chat/StaffChatPage';
import { useTeamInbox } from '@/internal-chat/hooks';
import { FloatingChat } from '@/chat/FloatingChat';
import { AssistantDock } from '@/features/assistant/AssistantDock';
import { useFloatingGuard } from './useFloatingGuard';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NotificationBell, NotificationProvider, NavNotificationBadge } from '@/site-notifications/NotificationBell';
import { DiagnosticsProvider, DiagnosticsButton } from '@/diagnostics/DiagnosticsProvider';
import { DiagnosticPageBoundary } from '@/diagnostics/DiagnosticPageBoundary';
import { Modal } from './DataTools';
import { callbacksApi } from '@/lib/callbacks-api';
import { usePaymentOrderCount } from '@/lib/payment-order-queries';
import { usePendingCounts } from '@/lib/pending-create';
import { canUseDrafts, useDraftCounts } from '@/lib/request-drafts';
import { CreateReminderForm } from './Forms';
import { sfScope } from '@/features/smart-filing/access';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem } from './ui/dropdown-menu';

const nafissLogoUrl = `${import.meta.env.BASE_URL}nafiss-financial-logo.png`;

type NavItem = { href: string; label: string; icon: LucideIcon; permission?: string | string[]; staffOnly?: boolean; adminOnly?: boolean; smartFiling?: boolean; walletOwner?: boolean; adminLabel?: string };

// Routes and permission rules are unchanged; only grouping, order, labels of groups and icons are new.
const allNavItems: NavItem[] = [
  { href: '/', label: 'نمای کلی', icon: LayoutDashboard, permission: 'dashboard.view' },
  { href: '/reminders', label: 'یادآورها', icon: Bell, permission: 'reminders.view' },
  { href: '/customers', label: 'مشتریان', icon: UsersRound, permission: 'customers.view' },
  { href: '/consultations', label: 'مشاوره‌ها', icon: ClipboardList, permission: 'consultations.view' },
  { href: '/callback-requests', label: 'درخواست‌های تماس', icon: PhoneIncoming, permission: 'callbacks.view' },
  { href: '/manual-verifications', label: 'بررسی دستی هویت', icon: ShieldCheck, adminOnly: true },
  { href: '/loan-applications', label: 'درخواست‌های تسهیلات', icon: Landmark, permission: 'loan_applications.view' },
  { href: '/loan-plans', label: 'طرح‌های تسهیلاتی', icon: Layers, permission: 'loan_plans.view' },
  { href: '/contracts', label: 'قراردادها', icon: FileSignature, permission: 'contracts.view' },
  { href: '/credit-rank-overrides', label: 'نادیده گرفتن رتبه', icon: ShieldAlert, adminOnly: true },
  { href: '/goods-purchases', label: 'خرید کالا', icon: ShoppingBag, permission: 'goods_purchases.view' },
  { href: '/sales-commissions', label: 'پورسانت فروش', icon: Coins, permission: 'goods_finance.view' },
  // «کیف پول من»: own wallet for salespeople with goods_finance.view; admin sees every salesperson («کیف پول کارشناس‌ها»).
  { href: '/my-wallet', label: 'کیف پول من', adminLabel: 'کیف پول کارشناس‌ها', icon: Wallet, permission: 'goods_finance.view', walletOwner: true },
  { href: '/payment-orders', label: 'دستورهای پرداخت', icon: Receipt, permission: 'payment_orders.view' },
  { href: '/wallet-management', label: 'مدیریت کیف پول', icon: Wallet, permission: ['wallets.view', 'payment_orders.pay'] },
  { href: '/bank-accounts', label: 'حساب‌های بانکی', icon: Building2, permission: ['bank_accounts.view', 'bank_accounts.manage'] },
  { href: '/accounting', label: 'حسابداری', icon: Calculator, permission: 'accounting.view' },
  { href: '/chat', label: 'گفتگو با مشتریان', icon: MessagesSquare, permission: 'customers.view' },
  { href: '/internal-chat', label: 'گفتگوی داخلی', icon: MessageCircle, permission: 'internal_chat.use' },
  { href: '/messengers', label: 'پیام‌رسان‌ها', icon: Send, permission: 'internal_chat.use' },
  { href: '/instagram-inbox', label: 'سرنخ‌های دایرکت اینستاگرام', icon: Instagram, staffOnly: true },
  { href: '/calls', label: 'تماس‌ها', icon: PhoneCall, permission: 'calls.view' },
  { href: '/mobile-calls', label: 'تماس‌های موبایل', icon: Smartphone, permission: 'calls.view' },
  { href: '/phone', label: 'تلفن شرکت', icon: Phone, permission: 'calls.view' },
  { href: '/sales-reports', label: 'گزارش فروش', icon: BarChart3, permission: 'reports.view' },
  { href: '/social-monitor-reports', label: 'گزارش پیام‌رسان‌ها', icon: Radar, adminOnly: true },
  { href: '/voice-notes-usage', label: 'مصرف تبدیل صدا به متن', icon: AudioLines, adminOnly: true },
  { href: '/smart-filing', label: 'ثبت هوشمند', icon: Bot, smartFiling: true },
  { href: '/settings/assistants', label: 'دستیارهای هوشمند', icon: Bot, adminOnly: true },
  { href: '/users', label: 'کاربران CRM', icon: UserCog, permission: 'users.view' },
  { href: '/settings/notifications', label: 'تنظیمات', icon: Settings, permission: 'notifications.view' },
  { href: '/settings/releases', label: 'نسخه‌های سایت', icon: Rocket, adminOnly: true },
];

const mobilePrimaryNavHrefs = ['/', '/customers', '/chat', '/internal-chat'];
type NavGroup = { id: string; label: string; icon: LucideIcon; hrefs: string[]; pinned?: boolean };
const navGroups: NavGroup[] = [
  { id: 'dashboard', label: 'داشبورد', icon: LayoutDashboard, hrefs: ['/', '/reminders'], pinned: true },
  { id: 'customers', label: 'مشتریان و مشاوره', icon: Contact, hrefs: ['/customers', '/calls', '/consultations', '/callback-requests', '/manual-verifications'] },
  { id: 'loans', label: 'وام و قرارداد', icon: HandCoins, hrefs: ['/loan-applications', '/smart-filing', '/loan-plans', '/contracts', '/credit-rank-overrides'] },
  { id: 'goods', label: 'خرید کالا', icon: Store, hrefs: ['/goods-purchases', '/sales-commissions', '/my-wallet'] },
  { id: 'finance', label: 'مالی و پرداخت', icon: Banknote, hrefs: ['/payment-orders', '/wallet-management', '/bank-accounts', '/accounting'] },
  { id: 'comms', label: 'پیام‌ها و تلفن', icon: Headset, hrefs: ['/chat', '/internal-chat', '/messengers', '/instagram-inbox', '/mobile-calls', '/phone'] },
  { id: 'reports', label: 'گزارش‌ها', icon: PieChart, hrefs: ['/sales-reports', '/social-monitor-reports', '/voice-notes-usage'] },
  { id: 'admin', label: 'مدیریت و تنظیمات', icon: SlidersHorizontal, hrefs: ['/users', '/settings/notifications', '/settings/assistants', '/settings/releases'] },
];

const OPEN_GROUPS_KEY = 'nafis.nav.openGroups';
const readOpenGroups = (): string[] | null => {
  try { const raw = window.localStorage.getItem(OPEN_GROUPS_KEY); const v = raw ? JSON.parse(raw) : null; return Array.isArray(v) ? v.filter(x => typeof x === 'string') : null; } catch { return null; }
};

/** Page title = label of the longest nav route matching the current path (fixes e.g. /mobile-calls showing «نمای کلی»). */
const titleFor = (location: string) => {
  const match = allNavItems
    .filter(item => item.href !== '/' && (location === item.href || location.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (match) return match.label;
  if (location.startsWith('/settings')) return 'تنظیمات';
  const loose = allNavItems.filter(item => item.href !== '/' && location.startsWith(item.href)).sort((a, b) => b.href.length - a.href.length)[0];
  return loose?.label ?? 'نمای کلی';
};

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export function CrmShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  // On the chat pages themselves the floating «گفتگو» bubble is redundant and sat on top of the composer's send button.
  const onChatPage = /^\/(chat|internal-chat)(\/|$)/.test(location);
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  const [reminderFormOpen, setReminderFormOpen] = useState(false);
  const [dueReminder, setDueReminder] = useState<Reminder | null>(null);
  const [openGroups, setOpenGroups] = useState<string[]>(() => readOpenGroups() ?? []);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useFloatingGuard();
  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const dueParams = { done: false, due: true };
  const dueReminders = useListReminders(dueParams, {
    query: {
      queryKey: getListRemindersQueryKey(dueParams),
      enabled: Boolean(user?.role === 'admin' || user?.permissions?.includes('reminders.manage')),
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
    },
  });
  const acknowledgeReminder = useAcknowledgeReminder();
  const canChat = Boolean(user && (user.role === 'admin' || user.permissions?.includes('customers.view')));
  const canTeam = Boolean(user && (user.role === 'admin' || user.permissions?.includes('internal_chat.use')));
  const team = useTeamInbox(canTeam);
  usePresence(staffChatPresence, canChat);
  const unread = useQuery({ queryKey: ['chat', 'unread'], queryFn: fetchStaffUnread, enabled: canChat, refetchInterval: 10_000, retry: false });
  const canCallbacks = Boolean(user && (user.role === 'admin' || user.permissions?.includes('callbacks.view')));
  const callbacksBadge = useQuery({ queryKey: ['callbacks', 'badge'], queryFn: callbacksApi.badge, enabled: canCallbacks, refetchInterval: 30_000, retry: false });
  const canMarkPaid = Boolean(user && (user.role === 'admin' || (user.permissions?.includes('payment_orders.pay') && user.permissions?.includes('payment_orders.view'))));
  const awaitingMark = usePaymentOrderCount({ stage: 'awaiting_payment' }, canMarkPaid);
  // «در انتظار ایجاد» badge: only for users who can create (server returns null otherwise); locked rows are not counted.
  const canCreateQueue = Boolean(user && (user.role === 'admin' || user.permissions?.includes('goods_purchases.manage') || user.permissions?.includes('payment_orders.create')));
  const pendingCounts = usePendingCounts(canCreateQueue);
  const pendingGoods = pendingCounts.data?.goods ?? 0, pendingPayments = pendingCounts.data?.payments ?? 0;
  // «در انتظار ثبت» badge on درخواست‌های تسهیلات: server-side request drafts visible to this user.
  const draftCounts = useDraftCounts(canUseDrafts(user));
  const pendingDrafts = draftCounts.data?.total ?? 0;

  useEffect(() => {
    const next = dueReminders.data?.[0];
    if (!next || dueReminder) return;
    setDueReminder(next);
    acknowledgeReminder.mutate(
      { id: next.id },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey(dueParams) }) },
    );
  }, [dueReminders.data, dueReminder, acknowledgeReminder, queryClient]);
  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.setQueryData(getGetAuthSessionQueryKey(), null);
        queryClient.clear();
        setLocation('/login');
      }
    }
  });

  const { data: health } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), staleTime: 60_000 },
  });

  const isAdminUser = user?.role === 'admin';
  const pageTitle = isAdminUser && (location === '/my-wallet' || location.startsWith('/my-wallet/')) ? 'کیف پول کارشناس‌ها' : titleFor(location);
  
  const navItems = allNavItems.filter(item => {
    if (item.walletOwner && !isAdminUser && !(user as { salespersonId?: number | null } | undefined)?.salespersonId) return false;
    if ('staffOnly' in item && item.staffOnly) return user?.role === 'admin' || user?.role === 'registrar';
    if ('adminOnly' in item && item.adminOnly) return user?.role === 'admin';
    if ('smartFiling' in item && item.smartFiling) return sfScope(user as { role?: string; salespersonId?: number | null } | undefined) !== null;
    const needed = ([] as string[]).concat((item as { permission?: string | string[] }).permission ?? []);
    return user?.role === 'admin' || needed.some((p) => user?.permissions?.includes(p));
  }).map(item => (isAdminUser && item.adminLabel ? { ...item, label: item.adminLabel } : item));
  const mobileQuickNavItems = navItems.filter(item => mobilePrimaryNavHrefs.includes(item.href));
  const visibleNavGroups = navGroups
    .map(group => ({ ...group, items: group.hrefs.map(href => navItems.find(item => item.href === href)).filter((item): item is NavItem => Boolean(item)) }))
    .filter(group => group.items.length > 0);
  const isNavItemActive = (href: string) =>
    location === href || (href !== '/' && location.startsWith(href) && !(href === '/chat' && location.startsWith('/internal-chat')));

  const phone = useMediaQuery('(max-width: 640px)');
  const moreButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const activeGroupId = visibleNavGroups.find(group => group.items.some(item => isNavItemActive(item.href)))?.id;

  const toggleGroup = useCallback((id: string) => setOpenGroups(current => {
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
    try { window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  }), []);

  useEffect(() => {
    // Open the active page's group without closing the others the user opened.
    if (activeGroupId) setOpenGroups(current => {
      if (current.includes(activeGroupId)) return current;
      const next = [...current, activeGroupId];
      try { window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setMobileMenuOpen(false);
    const main = document.querySelector<HTMLElement>('.app-main');
    if (main) main.scrollTop = 0;
  }, [location]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!phone) setMobileMenuOpen(false); }, [phone]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const opener = moreButton.current;
    document.body.classList.add('nf-drawer-open');
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileMenuOpen(false); return; }
      if (event.key !== 'Tab' || !drawer.current) return;
      const focusables = Array.from(drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('nf-drawer-open'); opener?.focus({ preventScroll: true }); };
  }, [mobileMenuOpen]);

  const renderNavLink = (item: NavItem, mobile = false, compact = false) => {
    const { href, label, icon: Icon } = item;
    return (
      <Link
        key={href}
        href={href}
        className={`side-link ${isNavItemActive(href) ? 'active' : ''}`}
        onClick={mobile ? () => setMobileMenuOpen(false) : undefined}
        data-testid={`${mobile ? (compact ? 'link-mobile-shortcut' : 'link-mobile-nav') : 'link-nav'}-${label}`}
        aria-label={label}
        aria-current={isNavItemActive(href) ? 'page' : undefined}
        title={label}
      >
        <Icon aria-hidden="true" />
        <span>{compact ? (href === '/' ? 'خانه' : href === '/chat' ? 'گفتگو' : href === '/internal-chat' ? 'داخلی' : label) : label}</span>
        {href === '/chat' && (unread.data?.count ?? 0) > 0 ? <b className="side-badge" aria-label={`${unread.data!.count} پیام خوانده‌نشده`} data-testid={`${mobile ? (compact ? 'badge-mobile-shortcut-chat-unread' : 'badge-mobile-chat-unread') : 'badge-chat-unread'}`}>{unread.data!.count.toLocaleString('fa-IR')}</b> : null}
        {href === '/internal-chat' && (team.data?.unreadCount ?? 0) > 0 ? <b className="side-badge" aria-label={`${team.data!.unreadCount} پیام خوانده‌نشده`} data-testid={`${mobile ? (compact ? 'badge-mobile-shortcut-internal-unread' : 'badge-mobile-internal-unread') : 'badge-internal-unread'}`}>{team.data!.unreadCount.toLocaleString('fa-IR')}</b> : null}
        {href === '/callback-requests' && (callbacksBadge.data?.new ?? 0) > 0 ? <b className="side-badge" aria-label={`${callbacksBadge.data!.new} درخواست تماس جدید`} data-testid={`${mobile ? 'badge-mobile-callbacks-new' : 'badge-callbacks-new'}`}>{callbacksBadge.data!.new.toLocaleString('fa-IR')}</b> : null}
        {href === '/loan-applications' && pendingDrafts > 0 ? <b className={`side-badge ${(draftCounts.data?.paidOver24h ?? 0) > 0 ? 'pending' : 'gold'}`} aria-label={`${pendingDrafts} درخواست در انتظار ثبت`} data-testid={`${mobile ? 'badge-mobile-pending-drafts' : 'badge-pending-drafts'}`}>{pendingDrafts.toLocaleString('fa-IR')}</b> : null}
        {href === '/goods-purchases' && pendingGoods > 0 ? <b className="side-badge pending" aria-label={`${pendingGoods} مشتری در انتظار ایجاد خرید کالا`} data-testid={`${mobile ? 'badge-mobile-pending-goods' : 'badge-pending-goods'}`}>{pendingGoods.toLocaleString('fa-IR')}</b> : null}
        {href === '/payment-orders' && pendingPayments > 0 ? <b className="side-badge pending" aria-label={`${pendingPayments} خرید در انتظار ایجاد دستور پرداخت`} data-testid={`${mobile ? 'badge-mobile-pending-payments' : 'badge-pending-payments'}`}>{pendingPayments.toLocaleString('fa-IR')}</b> : null}
        {href === '/payment-orders' && pendingPayments === 0 && (awaitingMark.data ?? 0) > 0 ? <b className="side-badge gold" aria-label={`${awaitingMark.data} دستور در انتظار علامت پرداخت`} data-testid={`${mobile ? 'badge-mobile-awaiting-mark' : 'badge-awaiting-mark'}`}>{awaitingMark.data!.toLocaleString('fa-IR')}</b> : null}
        <NavNotificationBadge href={href} />
      </Link>
    );
  };
  
  const renderGroups = (mobile: boolean) => visibleNavGroups.map(({ id, label, icon: Icon, items, pinned }) => {
    const expanded = pinned || openGroups.includes(id);
    const hasActive = id === activeGroupId;
    const listId = `${mobile ? 'mobile-' : ''}side-group-${id}`;
    return (
      <section className={`side-nav-group${pinned ? ' is-pinned' : ''}${hasActive ? ' has-active' : ''}`} key={id}>
        {pinned
          ? <div className="side-group-label" id={`${listId}-label`}>{label}</div>
          : <button
            className="side-group-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            title={label}
            onClick={() => toggleGroup(id)}
            data-testid={`button-${mobile ? 'mobile-' : ''}nav-group-${id}`}
          >
            <Icon className="side-group-icon" aria-hidden="true" />
            <span>{label}</span>
            {hasActive && !expanded ? <i className="side-group-dot" aria-label="صفحهٔ فعلی در این گروه است" /> : null}
            <ChevronDown className="side-group-chevron" aria-hidden="true" />
          </button>}
        {expanded && <div id={listId} className="side-group-items" role="list" aria-labelledby={pinned ? `${listId}-label` : undefined}>{items.map(item => renderNavLink(item, mobile))}</div>}
      </section>
    );
  });

  return (
    <DiagnosticsProvider actorId={user?.id ?? 'anon'} isAdmin={user?.role === 'admin'}>
    <NotificationProvider user={user}>
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <img src={nafissLogoUrl} alt="گروه مالی نفیس" />
          <div>
            <strong>گروه مالی نفیس</strong>
            <span>پنل مدیریت مشتریان</span>
          </div>
        </div>
        <nav className="side-nav" aria-label="ناوبری اصلی">
          <div className="side-nav-groups">{renderGroups(false)}</div>
          <div className="mobile-nav-items">
            {mobileQuickNavItems.map(item => renderNavLink(item, true, true))}
            <button ref={moreButton} type="button" className="side-link mobile-nav-more" onClick={() => setMobileMenuOpen(true)} aria-label="بازکردن منوی همهٔ بخش‌ها" aria-haspopup="dialog" aria-expanded={mobileMenuOpen} data-testid="button-mobile-more">
              <Menu aria-hidden="true" /><span>منو</span>
            </button>
          </div>
        </nav>
        <div className="side-foot">
          <LifeBuoy size={18} aria-hidden="true" />
          <div>
            <b>پشتیبانی تیم</b>
            <span className={health?.status === 'ok' ? 'is-ok' : ''}>{health?.status === 'ok' ? 'سامانه در دسترس است' : 'در حال بررسی سامانه'}</span>
          </div>
        </div>
      </aside>
      {mobileMenuOpen && (
        <div className="mobile-nav-overlay">
          <button type="button" className="mobile-nav-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => setMobileMenuOpen(false)} />
          <section ref={drawer} className="mobile-nav-drawer" role="dialog" aria-modal="true" aria-labelledby="mobile-nav-title" data-testid="mobile-nav-drawer">
            <header>
              <img src={nafissLogoUrl} alt="" aria-hidden="true" />
              <strong id="mobile-nav-title">همهٔ بخش‌ها</strong>
              <button ref={closeButton} type="button" className="mobile-nav-close" onClick={() => setMobileMenuOpen(false)} aria-label="بستن منو" data-testid="button-mobile-nav-close"><X size={22} aria-hidden="true" /></button>
            </header>
            <nav className="mobile-nav-groups" aria-label="همهٔ بخش‌های پنل">{renderGroups(true)}</nav>
          </section>
        </div>
      )}
      <main className="app-main">
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <p>امروز، تمرکز روی قدم بعدی مشتری است.</p>
          </div>
          <div className="top-actions">
            <DiagnosticsButton />
            <NotificationBell user={user} />
            {user?.role === 'admin' || user?.permissions?.includes('reminders.manage') ? <button type="button" className="icon-button" aria-label="ثبت یادآور" title="ثبت یادآور" onClick={() => setReminderFormOpen(true)} data-testid="button-header-reminder"><Bell size={20} /></button> : null}
            <DropdownMenu dir="rtl">
              <DropdownMenuTrigger asChild>
                <button type="button" className="avatar account-menu-trigger" aria-label="منوی حساب کاربری" title="حساب کاربری" data-testid="avatar-current-user">
                  <UserAvatar userId={user?.id} name={user?.fullName || user?.username || 'کاربر'} size={36} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8} className="account-menu-content" data-testid="account-menu">
                <DropdownMenuLabel>
                  <strong className="account-menu-name">{user?.fullName || user?.username || 'کاربر'}</strong>
                  <span className="account-menu-role">{user?.roleName || 'کاربر'}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setProfileOpen(true)} disabled={logoutMutation.isPending} data-testid="button-open-profile" className="account-menu-item">
                  <Pencil size={16} /> ویرایش کاربر
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(event) => { event.preventDefault(); logoutMutation.mutate(); }} disabled={logoutMutation.isPending} data-testid="button-logout" className="account-menu-item account-menu-logout">
                  <LogOut size={16} /> {logoutMutation.isPending ? 'در حال خروج…' : 'خروج'}
                </DropdownMenuItem>
                {logoutMutation.isError && <p className="account-menu-error" role="alert">خروج انجام نشد؛ دوباره تلاش کنید.</p>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <DiagnosticPageBoundary key={location}>{children}</DiagnosticPageBoundary>
      </main>
      {user && (canChat || canTeam) && !onChatPage ? <FloatingChat key={phone ? 'phone' : 'wide'} bottomOffset={phone ? 84 : 20} actor={`staff:${user.id}`} items={[...(canChat ? [{ href: '/chat', label: 'گفتگو با مشتریان', count: unread.data?.count ?? 0 }] : []), ...(canTeam ? [{ href: '/internal-chat', label: 'گفتگوی داخلی', count: team.data?.unreadCount ?? 0 }] : [])]} /> : null}
      {/* «دستیار هوشمند»: stacked above the staff-chat FAB (54px + 12px gap); renders nothing unless the server lists an assistant for this user. */}
      {user ? <AssistantDock user={user as { id: number; role?: string | null; salespersonId?: number | null }} phone={phone} bottomOffset={(phone ? 84 : 20) + 66} /> : null}
      {profileOpen && user ? <ProfileModal user={user} onClose={() => setProfileOpen(false)} /> : null}
      {reminderFormOpen ? <CreateReminderForm onClose={() => setReminderFormOpen(false)} /> : null}
      {dueReminder ? (
        <Modal title={dueReminder.subject} eyebrow="زمان یادآور رسیده است" onClose={() => setDueReminder(null)} testId="due-reminder">
          <div className="due-reminder">
            <div className="due-reminder-icon"><BellRing size={22} /></div>
            {dueReminder.customerName ? <><div className="due-reminder-customer">مشتری: <CustomerName id={dueReminder.customerId} name={dueReminder.customerName} /></div><div className="due-reminder-customer">کارشناس پرونده: {dueReminder.customerSalespersonName || 'بدون تخصیص'}</div></> : null}
            <p>{dueReminder.message}</p>
            <div className="form-footer">
              <button className="btn btn-primary" type="button" onClick={() => setDueReminder(null)} data-testid="button-close-due-reminder">متوجه شدم</button>
              <Link className="btn btn-ghost" href="/reminders" onClick={() => setDueReminder(null)}>مشاهده یادآورها</Link>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
    </NotificationProvider>
    </DiagnosticsProvider>
  );
}

function ProfileModal({ user, onClose }: { user: CrmUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    username: user.username,
    fullName: user.fullName ?? '',
    mobile: user.mobile ?? '',
    telegramId: user.telegramId ?? '',
    password: '',
    confirmPassword: '',
  });
  const [formError, setFormError] = useState('');
  const mutation = useUpdateAuthProfile({
    mutation: {
      onSuccess: (session) => {
        queryClient.setQueryData(getGetAuthSessionQueryKey(), session);
        onClose();
      },
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.password && form.password.length < 8) {
      setFormError('رمز عبور باید حداقل ۸ نویسه باشد.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setFormError('رمز عبور با تکرار آن مطابقت ندارد.');
      return;
    }
    setFormError('');
    mutation.mutate({
      data: {
        username: form.username.trim(),
        fullName: form.fullName.trim() || null,
        mobile: form.mobile.trim() || null,
        telegramId: form.telegramId.trim() || null,
        ...(form.password ? { password: form.password } : {}),
      },
    });
  };

  return (
    <Modal title="ویرایش پروفایل" eyebrow="حساب کاربری شما" onClose={onClose} testId="profile">
      <form onSubmit={submit}>
        {formError ? <div className="profile-form-error" data-testid="error-profile-validation">{formError}</div> : null}
        {mutation.isError ? <div className="profile-form-error" data-testid="error-profile">ذخیره اطلاعات با مشکل روبه‌رو شد. دوباره تلاش کنید.</div> : null}
        <div className="form-grid">
          <AvatarPicker userId={user.id} name={user.fullName || user.username} endpoint="profile/avatar" testId="profile-avatar" />
          <div className="field">
            <label htmlFor="profile-username">نام کاربری</label>
            <input id="profile-username" value={form.username} minLength={3} maxLength={100} pattern="[A-Za-z0-9._\-]+" dir="ltr" autoComplete="username" required onChange={(event) => setForm({ ...form, username: event.target.value })} data-testid="input-profile-username" />
          </div>
          <div className="field">
            <label htmlFor="profile-telegram">آیدی تلگرام</label>
            <input id="profile-telegram" value={form.telegramId} maxLength={100} dir="ltr" onChange={(event) => setForm({ ...form, telegramId: event.target.value })} placeholder="@username" data-testid="input-profile-telegram" />
          </div>
          <div className="field">
            <label htmlFor="profile-mobile">شماره موبایل</label>
            <input id="profile-mobile" value={form.mobile} maxLength={30} dir="ltr" onChange={(event) => setForm({ ...form, mobile: event.target.value })} placeholder="09xxxxxxxxx" data-testid="input-profile-mobile" />
          </div>
          <div className="field full">
            <label htmlFor="profile-full-name">نام نمایشی</label>
            <input id="profile-full-name" value={form.fullName} maxLength={120} onChange={(event) => setForm({ ...form, fullName: event.target.value })} placeholder="مثال: علی احمدی" data-testid="input-profile-full-name" />
          </div>
          <div className="field">
            <label htmlFor="profile-password">رمز عبور جدید</label>
            <input id="profile-password" type="password" value={form.password} minLength={form.password ? 8 : undefined} maxLength={200} dir="ltr" autoComplete="new-password" onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="در صورت نیاز وارد کنید" data-testid="input-profile-password" />
          </div>
          <div className="field">
            <label htmlFor="profile-confirm-password">تکرار رمز عبور جدید</label>
            <input id="profile-confirm-password" type="password" value={form.confirmPassword} maxLength={200} dir="ltr" autoComplete="new-password" onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} data-testid="input-profile-confirm-password" />
          </div>
        </div>
        <p className="profile-form-note">برای حفظ رمز فعلی، دو فیلد رمز عبور را خالی بگذارید. سطح دسترسی فقط توسط مدیر تغییر می‌کند.</p>
        <div className="form-footer">
          <button className="btn btn-primary" type="submit" disabled={mutation.isPending} data-testid="button-save-profile"><Save size={15} />{mutation.isPending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={mutation.isPending}>انصراف</button>
        </div>
      </form>
    </Modal>
  );
}

export function SkeletonPanel({ rows = 3 }: { rows?: number }) {
  return <div className="panel loading-stack" aria-label="در حال بارگذاری">{Array.from({ length: rows }).map((_, i) => <div className="skeleton loading-line" key={i} />)}</div>;
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="error-state" data-testid="status-error"><span>دریافت اطلاعات با مشکل روبه‌رو شد. دوباره تلاش کنید.</span><button className="btn btn-ghost" onClick={onRetry} data-testid="button-retry">تلاش دوباره</button></div>;
}

export const statusLabel = (status?: string) => {
  const labels: Record<string, string> = { in_progress: 'در حال انجام', cancelled: 'لغو شده', completed: 'اتمام' };
  return labels[status ?? ''] ?? status ?? 'نامشخص';
};

export const initials = (name?: string) => (name ?? 'مشتری').split(' ').slice(0, 2).map((part) => part[0]).join('');

export const formatDate = (date?: string | null) => {
  if (!date) return '—';
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Tehran' }).format(value);
};

export const formatDateTime = (date?: string | null) => {
  if (!date) return '—';
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(value);
};

export function Priority({ value }: { value?: number | null }) {
  if (value === null || value === undefined) return <div className="priority" aria-label="بدون اولویت" data-testid="priority-null"><span style={{fontSize: 10, color: '#94a3b8'}}>بدون اولویت</span></div>;
  return <div className="priority" aria-label={`اولویت ${value}`} data-testid={`priority-${value}`}>{[1, 2, 3].map((n) => <i key={n} className={n <= value ? 'on' : ''} />)}</div>;
}