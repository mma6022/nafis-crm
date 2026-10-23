import { BarChart3, Bell, BellRing, ChevronDown, ClipboardList, CreditCard, LayoutDashboard, LifeBuoy, MoreHorizontal, Shield, ShieldCheck, PhoneCall, Phone, UsersRound, LogOut, Pencil, Save, Settings, FileSignature, Landmark, Server, ShoppingBag, Wallet, Building2, Coins, Instagram, Calculator, MessagesSquare, MessageCircle } from 'lucide-react';
import { UserAvatar, AvatarPicker } from '@/components/UserAvatar';
import { useHealthCheck, getHealthCheckQueryKey, useGetAuthSession, useLogout, useUpdateAuthProfile, useListReminders, useAcknowledgeReminder, getListRemindersQueryKey, getGetAuthSessionQueryKey, type CrmUser, type Reminder } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { usePresence } from '@/chat/Presence';
import { fetchStaffUnread, staffChatPresence } from '@/chat/StaffChatPage';
import { useTeamInbox } from '@/internal-chat/hooks';
import { FloatingChat } from '@/chat/FloatingChat';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { NotificationBell, NotificationProvider, NavNotificationBadge } from '@/site-notifications/NotificationBell';
import { DiagnosticsProvider, DiagnosticsButton } from '@/diagnostics/DiagnosticsProvider';
import { DiagnosticPageBoundary } from '@/diagnostics/DiagnosticPageBoundary';
import { Modal } from './DataTools';
import { CreateReminderForm } from './Forms';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem } from './ui/dropdown-menu';

const nafissLogoUrl = `${import.meta.env.BASE_URL}nafiss-financial-logo.png`;

const allNavItems = [
  { href: '/', label: 'نمای کلی', icon: LayoutDashboard, permission: 'dashboard.view' },
  { href: '/customers', label: 'مشتریان', icon: UsersRound, permission: 'customers.view' },
  { href: '/chat', label: 'گفتگو با مشتریان', icon: MessagesSquare, permission: 'customers.view' },
  { href: '/internal-chat', label: 'گفتگوی داخلی', icon: MessageCircle, permission: 'internal_chat.use' },
  { href: '/wallet-management', label: 'مدیریت کیف پول', icon: CreditCard, permission: 'wallets.view' },
  { href: '/reminders', label: 'یادآورها', icon: Bell, permission: 'reminders.view' },
  { href: '/calls', label: 'تماس‌ها', icon: PhoneCall, permission: 'calls.view' },
  { href: '/mobile-calls', label: 'تماس‌های موبایل', icon: PhoneCall, permission: 'calls.view' },
  { href: '/instagram-inbox', label: 'سرنخ‌های دایرکت اینستاگرام', icon: Instagram, staffOnly: true },
  { href: '/phone', label: 'تلفن شرکت', icon: Phone, permission: 'calls.view' },
  { href: '/consultations', label: 'مشاوره‌ها', icon: ClipboardList, permission: 'consultations.view' },
  { href: '/loan-applications', label: 'درخواست‌های تسهیلات', icon: Landmark, permission: 'loan_applications.view' },
  { href: '/loan-plans', label: 'طرح‌های تسهیلاتی', icon: CreditCard, permission: 'loan_plans.view' },
  { href: '/goods-purchases', label: 'خرید کالا', icon: ShoppingBag, permission: 'goods_purchases.view' },
  { href: '/payment-orders', label: 'دستورهای پرداخت', icon: Wallet, permission: 'payment_orders.view' },
  { href: '/bank-accounts', label: 'حساب‌های بانکی', icon: Building2, permission: ['bank_accounts.view', 'bank_accounts.manage'] },
  { href: '/accounting', label: 'حسابداری', icon: Calculator, permission: 'accounting.view' },
  { href: '/sales-reports', label: 'گزارش فروش', icon: BarChart3, permission: 'reports.view' },
  { href: '/sales-commissions', label: 'پورسانت فروش', icon: Coins, permission: 'goods_finance.view' },
  { href: '/contracts', label: 'قراردادها', icon: FileSignature, permission: 'contracts.view' },
  { href: '/users', label: 'کاربران CRM', icon: Shield, permission: 'users.view' },
  { href: '/manual-verifications', label: 'بررسی دستی هویت', icon: ShieldCheck, adminOnly: true },
  { href: '/social-monitor-reports', label: 'گزارش پیام‌رسان‌ها', icon: MessagesSquare, adminOnly: true },
  { href: '/settings/notifications', label: 'تنظیمات', icon: Settings, permission: 'notifications.view' },
  { href: '/settings/releases', label: 'نسخه‌های سایت', icon: Server, adminOnly: true },
];

const primaryNavHrefs = ['/', '/customers'];
const mobilePrimaryNavHrefs = ['/', '/customers', '/chat', '/internal-chat'];
const navGroups = [
  { id: 'conversations', label: 'گفتگوها', icon: MessagesSquare, hrefs: ['/chat', '/internal-chat', '/instagram-inbox'] },
  { id: 'daily-work', label: 'کارهای روزانه', icon: PhoneCall, hrefs: ['/calls', '/mobile-calls', '/phone', '/reminders'] },
  { id: 'cases', label: 'پرونده‌ها', icon: Landmark, hrefs: ['/consultations', '/loan-applications', '/loan-plans', '/contracts'] },
  { id: 'finance', label: 'امور مالی', icon: Wallet, hrefs: ['/wallet-management', '/goods-purchases', '/payment-orders', '/bank-accounts', '/accounting', '/sales-commissions'] },
  { id: 'reports-admin', label: 'گزارش و مدیریت', icon: Shield, hrefs: ['/sales-reports', '/users', '/manual-verifications', '/social-monitor-reports', '/settings/notifications', '/settings/releases'] },
];

export function CrmShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  const [reminderFormOpen, setReminderFormOpen] = useState(false);
  const [dueReminder, setDueReminder] = useState<Reminder | null>(null);
  const [openNavGroup, setOpenNavGroup] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  const pageTitle = location.startsWith('/internal-chat') ? 'گفتگوی داخلی' : location.startsWith('/chat') ? 'گفتگو با مشتریان' : location.startsWith('/social-monitor-reports') ? 'گزارش پیام‌رسان‌ها' : location.startsWith('/manual-verifications') ? 'بررسی دستی هویت' : location.startsWith('/instagram-inbox') ? 'سرنخ‌های دایرکت اینستاگرام' : location.startsWith('/customers') ? 'مشتریان' : location.startsWith('/reminders') ? 'یادآورها' : location.startsWith('/phone') ? 'تلفن شرکت' : location.startsWith('/calls') ? 'تماس‌ها' : location.startsWith('/consultations') ? 'مشاوره‌ها' : location.startsWith('/loan-applications') ? 'درخواست‌های تسهیلات' : location.startsWith('/loan-plans') ? 'طرح‌های تسهیلاتی' : location.startsWith('/goods-purchases') ? 'خرید کالا' : location.startsWith('/payment-orders') ? 'دستورهای پرداخت' : location.startsWith('/bank-accounts') ? 'حساب‌های بانکی' : location.startsWith('/accounting') ? 'حسابداری' : location.startsWith('/sales-reports') ? 'گزارش فروش' : location.startsWith('/sales-commissions') ? 'پورسانت فروش' : location.startsWith('/contracts') ? 'قراردادها' : location.startsWith('/users') ? 'کاربران CRM' : location.startsWith('/settings/releases') ? 'نسخه‌های سایت' : location.startsWith('/settings') ? 'تنظیمات' : 'نمای کلی';
  
  const navItems = allNavItems.filter(item => {
    if ('staffOnly' in item && item.staffOnly) return user?.role === 'admin' || user?.role === 'registrar';
    if ('adminOnly' in item && item.adminOnly) return user?.role === 'admin';
    const needed = ([] as string[]).concat((item as { permission?: string | string[] }).permission ?? []);
    return user?.role === 'admin' || needed.some((p) => user?.permissions?.includes(p));
  });
  const quickNavItems = navItems.filter(item => primaryNavHrefs.includes(item.href));
  const mobileQuickNavItems = navItems.filter(item => mobilePrimaryNavHrefs.includes(item.href));
  const visibleNavGroups = navGroups
    .map(group => ({ ...group, items: navItems.filter(item => group.hrefs.includes(item.href)) }))
    .filter(group => group.items.length > 0);
  const isNavItemActive = (href: string) =>
    location === href || (href !== '/' && location.startsWith(href) && !(href === '/chat' && location.startsWith('/internal-chat')));

  useEffect(() => {
    const activeGroup = visibleNavGroups.find(group => group.items.some(item => isNavItemActive(item.href)));
    if (activeGroup) setOpenNavGroup(activeGroup.id);
    setMobileMenuOpen(false);
    const main = document.querySelector<HTMLElement>('.app-main');
    if (main) main.scrollTop = 0;
  }, [location]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  const renderNavLink = (item: (typeof navItems)[number], mobile = false, compact = false) => {
    const { href, label, icon: Icon } = item;
    return (
      <Link
        key={href}
        href={href}
        className={`side-link ${isNavItemActive(href) ? 'active' : ''}`}
        onClick={mobile ? () => setMobileMenuOpen(false) : undefined}
        data-testid={`${mobile ? (compact ? 'link-mobile-shortcut' : 'link-mobile-nav') : 'link-nav'}-${label}`}
        aria-label={label}
        title={label}
      >
        <Icon />
        <span>{compact ? (href === '/' ? 'خانه' : href === '/chat' ? 'گفتگو' : href === '/internal-chat' ? 'داخلی' : label) : label}</span>
        {href === '/chat' && (unread.data?.count ?? 0) > 0 ? <b className="side-badge" aria-label={`${unread.data!.count} پیام خوانده‌نشده`} data-testid={`${mobile ? (compact ? 'badge-mobile-shortcut-chat-unread' : 'badge-mobile-chat-unread') : 'badge-chat-unread'}`} style={{ marginInlineStart: 'auto', outline: '1px dashed #fff', background: '#bc9252', color: '#fff', borderRadius: 10, padding: '0 7px', fontSize: 11 }}>{unread.data!.count.toLocaleString('fa-IR')}</b> : null}
        {href === '/internal-chat' && (team.data?.unreadCount ?? 0) > 0 ? <b className="side-badge" aria-label={`${team.data!.unreadCount} پیام خوانده‌نشده`} data-testid={`${mobile ? (compact ? 'badge-mobile-shortcut-internal-unread' : 'badge-mobile-internal-unread') : 'badge-internal-unread'}`} style={{ marginInlineStart: 'auto', background: '#bc9252', color: '#fff', borderRadius: 10, padding: '0 7px', fontSize: 11 }}>{team.data!.unreadCount.toLocaleString('fa-IR')}</b> : null}
        <NavNotificationBadge href={href} />
      </Link>
    );
  };
  
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
        <div className="side-label">فضای کاری</div>
        <nav className="side-nav" aria-label="ناوبری اصلی">
          <div className="side-nav-primary">{quickNavItems.map(item => renderNavLink(item))}</div>
          <div className="side-nav-groups">
            {visibleNavGroups.map(({ id, label, icon: Icon, items }) => {
              const expanded = openNavGroup === id;
              return (
                <section className="side-nav-group" key={id}>
                  <button
                    className="side-group-toggle"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`side-group-${id}`}
                    title={label}
                    onClick={() => setOpenNavGroup(current => current === id ? '' : id)}
                    data-testid={`button-nav-group-${id}`}
                  >
                    <Icon />
                    <span>{label}</span>
                    <ChevronDown className="side-group-chevron" />
                  </button>
                  {expanded && <div id={`side-group-${id}`} className="side-group-items">{items.map(item => renderNavLink(item))}</div>}
                </section>
              );
            })}
          </div>
          <div className="mobile-nav-items">
            {mobileQuickNavItems.map(item => renderNavLink(item, true, true))}
            <button type="button" className="side-link mobile-nav-more" onClick={() => setMobileMenuOpen(true)} aria-label="بازکردن همهٔ بخش‌ها" data-testid="button-mobile-more">
              <MoreHorizontal /><span>بیشتر</span>
            </button>
          </div>
        </nav>
        <div className="side-foot">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%' }}>
            <div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}><LifeBuoy size={15} /> پشتیبانی تیم</div>
              <div style={{ paddingRight: 22, color: health?.status === 'ok' ? '#8bc9b6' : '#9fb0c7' }}>{health?.status === 'ok' ? 'سامانه در دسترس است' : 'در حال بررسی سامانه'}</div>
            </div>
          </div>
        </div>
      </aside>
      {mobileMenuOpen && (
        <div className="mobile-nav-overlay">
          <button type="button" className="mobile-nav-backdrop" aria-label="بستن منو" onClick={() => setMobileMenuOpen(false)} />
          <section className="mobile-nav-drawer" aria-label="همهٔ بخش‌های پنل">
            <header><strong>همهٔ بخش‌ها</strong><button type="button" className="mobile-nav-close" onClick={() => setMobileMenuOpen(false)} aria-label="بستن منو">×</button></header>
            <nav className="mobile-nav-groups" aria-label="گروه‌بندی منو">
              {visibleNavGroups.map(({ id, label, icon: Icon, items }) => {
                const expanded = openNavGroup === id;
                return (
                  <section className="side-nav-group" key={id}>
                    <button className="side-group-toggle" type="button" aria-expanded={expanded} aria-controls={`mobile-side-group-${id}`} onClick={() => setOpenNavGroup(current => current === id ? '' : id)}>
                      <Icon /><span>{label}</span><ChevronDown className="side-group-chevron" />
                    </button>
                    {expanded && <div id={`mobile-side-group-${id}`} className="side-group-items">{items.map(item => renderNavLink(item, true))}</div>}
                  </section>
                );
              })}
            </nav>
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
            {user?.role === 'admin' || user?.permissions?.includes('reminders.manage') ? <button type="button" className="icon-button" aria-label="ثبت یادآور" title="ثبت یادآور" onClick={() => setReminderFormOpen(true)} data-testid="button-header-reminder"><Bell size={17} /></button> : null}
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
      {user && (canChat || canTeam) ? <FloatingChat actor={`staff:${user.id}`} items={[...(canChat ? [{ href: '/chat', label: 'گفتگو با مشتریان', count: unread.data?.count ?? 0 }] : []), ...(canTeam ? [{ href: '/internal-chat', label: 'گفتگوی داخلی', count: team.data?.unreadCount ?? 0 }] : [])]} /> : null}
      {profileOpen && user ? <ProfileModal user={user} onClose={() => setProfileOpen(false)} /> : null}
      {reminderFormOpen ? <CreateReminderForm onClose={() => setReminderFormOpen(false)} /> : null}
      {dueReminder ? (
        <Modal title={dueReminder.subject} eyebrow="زمان یادآور رسیده است" onClose={() => setDueReminder(null)} testId="due-reminder">
          <div className="due-reminder">
            <div className="due-reminder-icon"><BellRing size={22} /></div>
            {dueReminder.customerName ? <><div className="due-reminder-customer">مشتری: {dueReminder.customerName}</div><div className="due-reminder-customer">کارشناس پرونده: {dueReminder.customerSalespersonName || 'بدون تخصیص'}</div></> : null}
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