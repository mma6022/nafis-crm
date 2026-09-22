import { Bell, BellRing, ClipboardList, CreditCard, LayoutDashboard, LifeBuoy, Shield, PhoneCall, UsersRound, LogOut, Pencil, Save, Settings, FileSignature, Landmark } from 'lucide-react';
import { useHealthCheck, getHealthCheckQueryKey, useGetAuthSession, useLogout, useUpdateAuthProfile, useListReminders, useAcknowledgeReminder, getListRemindersQueryKey, getGetAuthSessionQueryKey, type CrmUser, type Reminder } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from './DataTools';
import { CreateReminderForm } from './Forms';

const nafissLogoUrl = `${import.meta.env.BASE_URL}nafiss-financial-logo.png`;

const allNavItems = [
  { href: '/', label: 'نمای کلی', icon: LayoutDashboard, permission: 'dashboard.view' },
  { href: '/customers', label: 'مشتریان', icon: UsersRound, permission: 'customers.view' },
  { href: '/reminders', label: 'یادآورها', icon: Bell, permission: 'reminders.view' },
  { href: '/calls', label: 'تماس‌ها', icon: PhoneCall, permission: 'calls.view' },
  { href: '/consultations', label: 'مشاوره‌ها', icon: ClipboardList, permission: 'consultations.view' },
  { href: '/loan-applications', label: 'درخواست‌های تسهیلات', icon: Landmark, permission: 'loan_applications.view' },
  { href: '/loan-plans', label: 'طرح‌های تسهیلاتی', icon: CreditCard, permission: 'loan_plans.view' },
  { href: '/contracts', label: 'قراردادها', icon: FileSignature, permission: 'contracts.view' },
  { href: '/users', label: 'کاربران CRM', icon: Shield, permission: 'users.view' },
  { href: '/settings/notifications', label: 'تنظیمات', icon: Settings, permission: 'notifications.view' },
];

export function CrmShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  const [reminderFormOpen, setReminderFormOpen] = useState(false);
  const [dueReminder, setDueReminder] = useState<Reminder | null>(null);
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

  const pageTitle = location.startsWith('/customers') ? 'مشتریان' : location.startsWith('/reminders') ? 'یادآورها' : location.startsWith('/calls') ? 'تماس‌ها' : location.startsWith('/consultations') ? 'مشاوره‌ها' : location.startsWith('/loan-applications') ? 'درخواست‌های تسهیلات' : location.startsWith('/loan-plans') ? 'طرح‌های تسهیلاتی' : location.startsWith('/contracts') ? 'قراردادها' : location.startsWith('/users') ? 'کاربران CRM' : location.startsWith('/settings') ? 'تنظیمات' : 'نمای کلی';
  
  const navItems = allNavItems.filter(item => user?.role === 'admin' || user?.permissions?.includes(item.permission));
  
  return (
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
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`side-link ${location === href || (href !== '/' && location.startsWith(href)) ? 'active' : ''}`} data-testid={`link-nav-${label}`}>
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <button className="profile-trigger" type="button" onClick={() => setProfileOpen(true)} aria-label="ویرایش پروفایل" data-testid="button-open-profile">
                <div className="avatar shrink-0">{initials(user?.fullName || user?.username || 'کاربر')}</div>
                <div className="profile-trigger-copy">
                  <strong style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--ink-deep)' }}>
                    {user?.fullName || user?.username || 'کاربر'}
                  </strong>
                  <span style={{ display: 'block', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--ink-soft)' }}>
                    {user?.roleName || 'کاربر'}
                  </span>
                </div>
                <Pencil size={13} className="profile-trigger-icon" />
              </button>
              <button 
                onClick={() => logoutMutation.mutate()} 
                disabled={logoutMutation.isPending}
                style={{ color: '#64748b', background: 'transparent', border: 0, padding: '4px', cursor: 'pointer', flexShrink: 0, opacity: logoutMutation.isPending ? 0.5 : 1 }} 
                title="خروج"
                data-testid="button-logout"
              >
                <LogOut size={16} />
              </button>
            </div>
            <div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}><LifeBuoy size={15} /> پشتیبانی تیم</div>
              <div style={{ paddingRight: 22, color: health?.status === 'ok' ? '#8bc9b6' : '#9fb0c7' }}>{health?.status === 'ok' ? 'سامانه در دسترس است' : 'در حال بررسی سامانه'}</div>
            </div>
          </div>
        </div>
      </aside>
      <main className="app-main">
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <p>امروز، تمرکز روی قدم بعدی مشتری است.</p>
          </div>
          <div className="top-actions">
            {user?.role === 'admin' || user?.permissions?.includes('reminders.manage') ? <button type="button" className="icon-button" aria-label="ثبت یادآور" title="ثبت یادآور" onClick={() => setReminderFormOpen(true)} data-testid="button-header-reminder"><Bell size={17} /></button> : null}
            <div className="avatar" data-testid="avatar-current-user">{initials(user?.fullName || user?.username || 'کاربر')}</div>
          </div>
        </header>
        {children}
      </main>
      {profileOpen && user ? <ProfileModal user={user} onClose={() => setProfileOpen(false)} /> : null}
      {reminderFormOpen ? <CreateReminderForm onClose={() => setReminderFormOpen(false)} /> : null}
      {dueReminder ? (
        <Modal title={dueReminder.subject} eyebrow="زمان یادآور رسیده است" onClose={() => setDueReminder(null)} testId="due-reminder">
          <div className="due-reminder">
            <div className="due-reminder-icon"><BellRing size={22} /></div>
            {dueReminder.customerName ? <div className="due-reminder-customer">مشتری: {dueReminder.customerName}</div> : null}
            <p>{dueReminder.message}</p>
            <div className="form-footer">
              <button className="btn btn-primary" type="button" onClick={() => setDueReminder(null)} data-testid="button-close-due-reminder">متوجه شدم</button>
              <Link className="btn btn-ghost" href="/reminders" onClick={() => setDueReminder(null)}>مشاهده یادآورها</Link>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
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