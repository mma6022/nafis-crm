import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Route, Switch, useLocation, useParams, useSearch } from 'wouter';
import {
  AlertCircle, ArrowLeft, ArrowRight, ArrowUp, Ban, ChevronDown, ChevronLeft, Compass, FileText, Hourglass, Home, Info,
  LifeBuoy, List, LogOut, MessageSquare, RefreshCw, Search, UserRound, Wallet,
} from 'lucide-react';
import { portalApi, PortalApiError, type Application, type ConsultationMessage, type Profile } from './api';
import { IdentityPage } from './Identity';
import { IdentityDocumentUploads } from './IdentityDocumentUploads';
import { WalletPanel } from './WalletPanel';
import { ProfilePage } from './ProfilePage';
import { LoanPlanCards } from './LoanPlanCards';
import { ActiveRequestList } from './ActiveRequests';
import { PlanRequirements } from './PlanRequirements';
import { PlanCalculator, type CalculatorSummary } from './PlanCalculator';
import { eligibleConditionId } from './plan-calculator-values';
import { readPaymentDraft, savePaymentDraft } from './payment-return';
import { AdviceHub, PlanFinder } from './PlanFinder';
import { CustomerChat } from '@/chat/CustomerChat';
import { usePresence } from '@/chat/Presence';
import { CHAT_HREF, isFinished, stageCopy } from './customer-stage-map';
import {
  ActionBar, DocsBlock, EmptyBox, ErrorBox, ExpertBlock, Icon, MoneyBlock, NextCard, NotFoundBox, PhaseBlock, Pill,
  SignatureBlock, SkeletonCards, Sep, day, fa, initials,
} from './PortalUi';
import logoUrl from './assets/nafis-logo-full.svg';
import './portal.css';
import './nfp.css';
import { CustomerLogin } from './CustomerLogin';

const number = (value: string | number | null | undefined) => value == null || value === '' ? '—' : Number(value).toLocaleString('fa-IR');
const date = (value?: string) => value ? new Date(value).toLocaleDateString('fa-IR') : '—';
const digits = (value: string) => value.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
const message = (error: unknown) => error instanceof Error ? error.message : 'درخواست انجام نشد. دوباره تلاش کنید.';
const verified = (profile: Profile) => profile.verificationStatus === 'verified';
const firstName = (profile: Profile) => (profile.name || '').trim().split(/\s+/)[0] || 'همراه نفیس';
const APPLY_STEPS = ['اعتبارسنجی', 'سازگاری با طرح', 'مبلغ و هزینه', 'استعلام', 'مدارک هویتی', 'ارجاع به کارشناس'];
const isDetail = (l: string) => /^\/customer\/applications\/[^/]+$/.test(l);
const isApply = (l: string) => l === '/customer/apply';

const tabs = [
  { key: 'home', href: '/customer', label: 'خانه', icon: Home, nav: 'link-customer-overview', match: (l: string) => l === '/customer' || l === '/customer/plans' },
  { key: 'requests', href: '/customer/applications', label: 'درخواست‌ها', icon: List, nav: 'link-customer-requests', match: (l: string) => l.startsWith('/customer/applications') || isApply(l) },
  { key: 'advice', href: CHAT_HREF, label: 'گفتگو', icon: MessageSquare, nav: 'link-customer-advice', match: (l: string) => l.startsWith('/customer/advice') },
  { key: 'wallet', href: '/customer/wallet', label: 'کیف پول', icon: Wallet, nav: 'link-customer-wallet', match: (l: string) => l === '/customer/wallet' },
  { key: 'profile', href: '/customer/profile', label: 'پروفایل', icon: UserRound, nav: 'link-customer-profile', match: (l: string) => l === '/customer/profile' },
];
const useUnread = () => useQuery({ queryKey: ['customer', 'chat-thread'], queryFn: portalApi.chatThread, refetchInterval: 8000, refetchOnWindowFocus: true, retry: false }).data?.unreadCount ?? 0;

/** Mobile bottom tab bar (handoff §2). Hidden ≥1024px by CSS. */
export function Tabbar() {
  const [location] = useLocation(); const unread = useUnread();
  return <nav className="nfp-tabbar" aria-label="بخش‌ها">{tabs.map(t => <Link key={t.key} href={t.href} aria-current={t.match(location) ? 'page' : undefined} data-testid={`tab-${t.key}`}>
    <t.icon className="nfp-i" aria-hidden="true" />{t.label}{t.key === 'advice' && unread > 0 && <span className="nfp-n" aria-label={`${fa(unread)} پیام تازه`}>{fa(unread)}</span>}</Link>)}</nav>;
}

function ApplyFrame({ children }: { children: ReactNode }) {
  return <div className="nfp-stack nfp-apply" style={{ marginInline: 'auto' }}>{children}</div>;
}

function ApplyGate({ profile }: { profile: Profile }) {
  const raw = new URLSearchParams(window.location.search).get('planId');
  const planId = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  if (planId == null) return <Redirect to="/customer/plans" />;
  return <Apply key={planId} profile={profile} planId={planId} />;
}

function SubHeader({ location }: { location: string }) {
  if (isDetail(location)) return <div className="nfp-sub-hd"><Link className="nfp-back" href="/customer/applications" data-testid="link-subhd-back"><Icon icon={ArrowRight} />درخواست‌ها</Link></div>;
  if (isApply(location)) {
    const planId = new URLSearchParams(window.location.search).get('planId');
    return <div className="nfp-sub-hd"><Link className="nfp-back" href={planId ? `/customer/plans?planId=${encodeURIComponent(planId)}` : '/customer/plans'} data-testid="link-subhd-back"><Icon icon={ArrowRight} />قبلی</Link><span className="nfp-ttl">ثبت درخواست</span></div>;
  }
  return null;
}

function CustomerShell({ profile, children }: { profile: Profile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = { '/customer': 'خانه', '/customer/plans': 'طرح‌ها', '/customer/applications': 'درخواست‌ها', '/customer/apply': 'ثبت درخواست',
      '/customer/wallet': 'کیف پول', '/customer/profile': 'پروفایل', '/customer/advice': 'مشاوره', '/customer/advice/ai': 'مشاوره هوشمند', '/customer/advice/finder': 'پیدا کردن طرح', '/customer/advice/chat': 'گفتگو با کارشناس' };
    document.title = `${titles[location] || 'پیگیری درخواست'} | پرتال مشتریان نفیس`;
  }, [location]);
  usePresence(portalApi.presence, true);
  const unread = useUnread();
  const [logoutError, setLogoutError] = useState('');
  const logout = useMutation({ mutationFn: portalApi.logout, onSuccess: () => { queryClient.removeQueries({ queryKey: ['customer'] }); navigate('/customer/login'); }, onError: e => setLogoutError(message(e)) });
  const detail = isDetail(location), apply = isApply(location), sub = detail || apply;
  return <div className="cp nfp">
    <header className="nfp-hd"><div className="nfp-hd-in">
      <Link href="/customer" className="nfp-logo" aria-label="نفیس وام — خانه" data-testid="link-customer-home"><img src={logoUrl} alt="نفیس وام" /></Link>
      <nav className="nfp-nav" aria-label="بخش‌ها">{tabs.map(t => <Link key={t.key} href={t.href} aria-current={t.match(location) ? 'page' : undefined} data-testid={t.nav}>
        <t.icon className="nfp-i nfp-s" aria-hidden="true" />{t.label}{t.key === 'advice' && unread > 0 && <span className="nfp-n" aria-label={`${fa(unread)} پیام تازه`}>{fa(unread)}</span>}</Link>)}</nav>
      <span className="nfp-sp" />
      {profile.name && <span className="nfp-who"><span className="nfp-av" aria-hidden="true">{initials(profile.name)}</span>{profile.name}</span>}
      <Link className="nfp-icon-btn nfp-m-only" href={CHAT_HREF} aria-label={unread ? `گفتگو با کارشناس — ${fa(unread)} پیام تازه` : 'گفتگو با کارشناس'} data-testid="link-header-chat"><Icon icon={MessageSquare} />{unread > 0 && <span className="nfp-dot" />}</Link>
      <button type="button" className="nfp-icon-btn nfp-logout" aria-label="خروج از حساب" title="خروج" onClick={() => logout.mutate()} disabled={logout.isPending} data-testid="button-customer-logout"><Icon icon={LogOut} /></button>
    </div></header>
    <SubHeader location={location} />
    <main className={`nfp-wrap${sub ? ' nfp-wrap--sub' : ''}${detail ? ' nfp-has-actbar' : ''}`}>
      {logoutError && <div className="nfp-alert" role="alert" style={{ marginBottom: 12 }}><Icon icon={AlertCircle} small /><span>{logoutError}</span></div>}
      {children}
    </main>
    {!sub && <Tabbar />}
  </div>;
}

function HelpAside() {
  return <aside className="nfp-stack nfp-aside">
    <div className="nfp-card"><h3>کمک لازم دارید؟</h3><p className="nfp-muted" style={{ marginBottom: 12 }}>کارشناس پرونده‌تان در گفتگو پاسخ می‌دهد.</p>
      <Link className="nf-btn nf-btn--secondary nf-btn--block" href={CHAT_HREF} data-testid="link-advice-aside"><Icon icon={MessageSquare} small />گفتگو با کارشناس</Link></div>
    <div className="nfp-card"><h3>درخواست تازه</h3><p className="nfp-muted" style={{ marginBottom: 12 }}>طرح‌ها را ببینید و درخواست تازه ثبت کنید.</p>
      <Link className="nf-btn nf-btn--text" style={{ padding: 0 }} href="/customer/plans" data-testid="link-start-advice">دیدن طرح‌ها<Icon icon={ChevronLeft} small /></Link></div>
  </aside>;
}

function NoRequests() {
  return <EmptyBox icon={List} title="هنوز درخواستی ندارید" text="یک طرح انتخاب کنید و درخواست بدهید. بعد از ثبت، وضعیتش همین‌جا نشان داده می‌شود.">
    <Link className="nf-btn nf-btn--primary" href="/customer/plans" data-testid="link-empty-plans">دیدن طرح‌ها و ثبت درخواست</Link>
    <Link className="nf-btn nf-btn--text" href="/customer/advice/finder" data-testid="link-empty-finder">نمی‌دانم کدام طرح؛ کمکم کنید</Link>
  </EmptyBox>;
}

function Overview({ profile }: { profile: Profile }) {
  const search = useSearch();
  const applications = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications, staleTime: 0, refetchInterval: 15000 });
  const planId = new URLSearchParams(search).get('planId');
  if (planId) return <Redirect to={`/customer/plans?planId=${encodeURIComponent(planId)}`} />;
  const items = applications.data ?? [];
  const yours = items.filter(a => stageCopy(a.stage).turn === 'you');
  const first = yours[0];
  const lede = applications.isLoading || applications.isError ? 'وضعیت درخواست‌های شما' : !items.length ? 'به پنل نفیس وام خوش آمدید.'
    : yours.length ? `${fa(yours.length)} درخواست منتظر اقدام شماست.` : 'فعلاً کاری لازم نیست انجام دهید.';
  return <div className="nfp-home-grid"><div className="nfp-stack">
    <div><h1 className="nfp-h1">سلام، {firstName(profile)}</h1><p className="nfp-lede">{lede}</p></div>
    {first && <NextCard app={first} context={<Link href={`/customer/applications/${first.id}`} className="nfp-muted" style={{ marginBottom: -6 }} data-testid="link-next-context">{first.planName || 'درخواست'}<Sep />پرونده {fa(first.id)}</Link>} />}
    <div className="nfp-sec-t"><h2>درخواست‌های در جریان</h2>{items.length > 0 && <Link href="/customer/applications" data-testid="link-all-requests">همه ({fa(items.length)})</Link>}</div>
    {applications.isLoading ? <SkeletonCards n={2} /> : applications.isError ? <ErrorBox retry={() => void applications.refetch()} />
      : items.length ? <ActiveRequestList items={items} limit={3} /> : <NoRequests />}
  </div><HelpAside /></div>;
}

function PlansPage() {
  return <div className="nfp-stack">
    <div className="nfp-plans-head"><div><h1 className="nfp-h1">طرح‌های وام</h1><p className="nfp-lede">طرح‌ها و بانک تأمین‌کننده‌ی هر کدام. روی هر طرح بزنید تا مبلغ و اقساط را ببینید.</p></div>
      <Link className="nf-btn nf-btn--secondary" href="/customer/advice/finder" data-testid="link-plans-finder"><Icon icon={Compass} small />کمک در انتخاب طرح</Link></div>
    <LoanPlanCards />
  </div>;
}

function RequestsPage() {
  const search = useSearch(); const [, navigate] = useLocation();
  const tab = new URLSearchParams(search).get('tab') === 'done' ? 'done' : 'active';
  const active = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications, staleTime: 0, refetchInterval: 15000 });
  const all = useQuery({ queryKey: ['customer', 'applications'], queryFn: portalApi.applications, staleTime: 0, refetchInterval: 30000 });
  const done = (all.data ?? []).filter(isFinished);
  const q = tab === 'active' ? active : all;
  const rows: Application[] = tab === 'active' ? active.data ?? [] : done;
  const none = active.isSuccess && all.isSuccess && !(active.data?.length) && !done.length;
  return <div className="nfp-stack">
    <div><h1 className="nfp-h1">درخواست‌های من</h1><p className="nfp-lede">روی هر درخواست بزنید تا مرحله‌ی بعدی را ببینید.</p></div>
    <div className="nfp-tabs" role="tablist" aria-label="دسته‌ی درخواست‌ها">
      <button type="button" className="nfp-tab" role="tab" aria-selected={tab === 'active'} onClick={() => navigate('/customer/applications')} data-testid="tab-requests-active">در جریان<span className="nfp-n">{fa(active.data?.length ?? 0)}</span></button>
      <button type="button" className="nfp-tab" role="tab" aria-selected={tab === 'done'} onClick={() => navigate('/customer/applications?tab=done')} data-testid="tab-requests-done">پایان‌یافته<span className="nfp-n">{fa(done.length)}</span></button>
    </div>
    <div role="tabpanel">{q.isLoading ? <SkeletonCards n={3} /> : q.isError ? <ErrorBox retry={() => void q.refetch()} />
      : none ? <NoRequests />
      : rows.length ? <ActiveRequestList items={rows} grid />
      : tab === 'active' ? <EmptyBox icon={List} title="درخواست فعالی ندارید" text="پرونده‌های قبلی در «پایان‌یافته» هستند.">
          <Link className="nf-btn nf-btn--primary" href="/customer/plans" data-testid="link-requests-home">دیدن طرح‌ها</Link>
          <Link className="nf-btn nf-btn--text" href="/customer/advice/finder" data-testid="link-requests-advice">دریافت مشاوره</Link></EmptyBox>
      : <EmptyBox icon={FileText} title="پرونده‌ی پایان‌یافته‌ای ندارید" text="پرونده‌های تکمیل‌شده یا بسته‌شده اینجا نشان داده می‌شوند." />}</div>
    {q.isSuccess && rows.length > 0 && <p className="nfp-muted nfp-autoref"><Icon icon={RefreshCw} small />وضعیت‌ها خودکار به‌روز می‌شوند.</p>}
  </div>;
}

const clock = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const appId = Number(id);
  const valid = /^\d+$/.test(id ?? '') && Number.isSafeInteger(appId) && appId > 0;
  const app = useQuery({ queryKey: ['customer', 'application', appId], queryFn: () => portalApi.application(appId), enabled: valid, staleTime: 0, refetchInterval: 15000, retry: (n, e) => !(e instanceof PortalApiError && e.status === 404) && n < 2 });
  const record = app.data;
  if (!valid || (app.error instanceof PortalApiError && app.error.status === 404)) return <><NotFoundBox /><Tabbar /></>;
  if (app.isLoading) return <><div className="nfp-stack"><SkeletonCards n={1} /><div className="nfp-sk-card" aria-hidden="true"><div className="nfp-sk" style={{ height: 18, width: '40%' }} /><div className="nfp-sk" style={{ height: 6 }} /><div className="nfp-sk" style={{ height: 120 }} /></div></div><Tabbar /></>;
  if (app.isError || !record) return <><ErrorBox title="اطلاعات پرونده بارگیری نشد" retry={() => void app.refetch()} /><Tabbar /></>;
  const term = !!(record.status && ['rejected', 'cancelled', 'canceled', 'closed'].includes(record.status));
  return <div className="nfp-stack">
    <nav className="nfp-crumb" aria-label="مسیر"><Link href="/customer/applications" data-testid="link-back-overview">درخواست‌های من</Link><Icon icon={ChevronLeft} small /><span aria-current="page">پرونده {fa(record.id)}</span></nav>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div><h1 className="nfp-h1">{record.planName || `درخواست ${fa(record.id)}`}</h1><p className="nfp-lede">پرونده {fa(record.id)}<Sep />ثبت {day(record.createdAt)}</p></div><Pill app={record} /></div>
    <div className="nfp-det-grid"><div className="nfp-stack"><NextCard app={record} /><PhaseBlock app={record} />{!term && <MoneyBlock app={record} />}<DocsBlock app={record} /></div>
      <aside className="nfp-stack nfp-aside"><ExpertBlock app={record} />{!term && <SignatureBlock app={record} />}
        <p className="nfp-muted nfp-autoref"><Icon icon={RefreshCw} small />خودکار به‌روز می‌شود<Sep />آخرین به‌روزرسانی: {clock.format(new Date(app.dataUpdatedAt || Date.now()))}
          <button type="button" className="nf-btn nf-btn--text nf-btn--sm" onClick={() => void app.refetch()} disabled={app.isFetching} data-testid="button-refresh-application">{app.isFetching ? 'در حال به‌روزرسانی…' : 'به‌روزرسانی'}</button></p></aside></div>
    <ActionBar app={record} />
  </div>;
}

// Small adapters used by the advice chat screen (kept on its existing layout; not part of the tracking redesign).
const Load = ({ rows = 2 }: { rows?: number }) => <div role="status" aria-label="در حال دریافت اطلاعات" className="nfp-stack">{Array.from({ length: rows }, (_, i) => <div className="nfp-sk" style={{ height: 56 }} key={i} />)}</div>;
const Failure = ({ error, retry }: { error: unknown; retry: () => void }) => <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{message(error)}</span>
  <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={retry} data-testid="button-retry">تلاش دوباره</button></div>;
const Empty = ({ title, text }: { title: string; text: string }) => <div className="cp-empty"><strong>{title}</strong><p>{text}</p></div>;

function AiAdvice() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState('');
  const consultations = useQuery({ queryKey: ['customer', 'consultations'], queryFn: portalApi.consultations });
  const consultationId = consultations.data?.[0]?.id;
  const history = useQuery({ queryKey: ['customer', 'messages', consultationId], queryFn: () => portalApi.messages(consultationId!), enabled: !!consultationId });
  const options = useQuery({ queryKey: ['customer', 'options'], queryFn: portalApi.options });
  const send = useMutation({ mutationFn: async (content: string) => {
    let id = consultationId;
    if (!id) {
      const created = await portalApi.createConsultation();
      if (!created?.id) throw new Error('گفتگو در سرور ایجاد نشد.');
      id = created.id;
      await queryClient.invalidateQueries({ queryKey: ['customer', 'consultations'] });
    }
    return portalApi.sendMessage(id, content);
  }, onSuccess: () => { setText(''); void queryClient.invalidateQueries({ queryKey: ['customer', 'messages'] }); } });
  const submit = (e: FormEvent) => { e.preventDefault(); const content = text.trim(); if (!content) return; setSendError(''); send.mutate(content, { onError: err => setSendError(message(err)) }); };
  const renderMessage = (item: ConsultationMessage) => <div key={item.id} className={`cp-bubble ${item.role === 'user' ? 'mine' : ''}`}><div>{item.content}</div>{item.recommendations?.map((rec, index) => {
    // Recommendations open the plans page; only its plan selection begins a request.
    const plan = options.data?.find(p => p.planId === rec.planId);
    return plan ? <div key={`${rec.planId}-${index}`} style={{ marginTop: 13 }}><Link href={`/customer/plans?planId=${encodeURIComponent(plan.planId)}`} className="cp-btn cp-btn-gold cp-btn-small" data-testid={`link-recommended-plan-${rec.planId}`}>{rec.label || plan.name} <ArrowLeft size={13} /></Link></div> : null;
  })}<small>{date(item.createdAt)}</small></div>;
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">راهنمای انتخاب</p><h1 className="cp-title">گفتگو برای یک تصمیم بهتر.</h1><p className="cp-lede">سؤال‌تان را بپرسید؛ شرایط نهایی هر طرح در مرحله درخواست توسط سامانه بررسی می‌شود.</p></div></div>
    <div className="cp-grid"><section className="cp-card cp-chat"><div className="cp-messages" aria-live="polite">
      {consultations.isLoading || (consultationId && history.isLoading) ? <Load rows={3} /> : consultations.isError ? <Failure error={consultations.error} retry={() => void consultations.refetch()} /> : history.isError ? <Failure error={history.error} retry={() => void history.refetch()} /> : history.data?.length ? history.data.map(renderMessage) : <Empty title="گفتگو را شروع کنیم" text="درباره مبلغ، مدت بازپرداخت یا شرایط تسهیلات از من بپرسید." />}
      {send.isPending && <div className="cp-skeleton" style={{ width: '60%', height: 65 }} />}
    </div>{options.isError && <div className="cp-alert cp-alert-info" role="status">طرح‌ها دریافت نشدند؛ لینک پیشنهاد تا زمان بررسی معتبر بودن طرح نمایش داده نمی‌شود. <button type="button" onClick={() => void options.refetch()} data-testid="button-retry-advice-options">تلاش دوباره</button></div>}
    {sendError && <div className="cp-alert" role="alert">{sendError}</div>}
    <form className="cp-chat-compose" onSubmit={submit}><label className="cp-field"><span className="sr-only">پیام شما</span><textarea value={text} onChange={e => setText(e.target.value)} placeholder="مثلاً برای بازپرداخت ۲۴ ماهه چه طرحی مناسب است؟" data-testid="input-advice-message" /></label><button className="cp-btn cp-btn-primary" disabled={send.isPending || !text.trim()} data-testid="button-send-advice">ارسال <ArrowUp size={16} /></button></form>
    </section><aside className="cp-card"><p className="cp-eyebrow">نکته مهم</p><h3>پیشنهاد، نه تصمیم نهایی</h3><p>مشاور به شما در شناخت طرح‌ها کمک می‌کند. اعتبارسنجی، شرایط طرح و امکان ثبت درخواست فقط توسط سرور تعیین می‌شود.</p><div className="cp-rule" /><Link href="/customer/plans" className="cp-link" data-testid="link-advice-options">دیدن همه طرح‌ها ←</Link></aside></div></>;
}

function Apply({ profile, planId }: { profile: Profile; planId: number }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const options = useQuery({ queryKey: ['customer', 'options'], queryFn: portalApi.options });
  const intake = useQuery({ queryKey: ['customer', 'intake', planId], queryFn: () => portalApi.intakeStatus(planId) });
  const checks = useQuery({ queryKey: ['customer', 'credit'], queryFn: portalApi.creditChecks, refetchInterval: query =>
    query.state.data?.some(c => c.status === 'processing') ? 6000 : false });
  const docs = useQuery({ queryKey: ['customer', 'identity-docs'], queryFn: portalApi.identityDocuments });
  const wallet = useQuery({ queryKey: ['customer', 'wallet'], queryFn: portalApi.wallet });
  const [amount, setAmount] = useState(() => readPaymentDraft(profile.id ?? 0, planId).amount);
  const [duration, setDuration] = useState(() => readPaymentDraft(profile.id ?? 0, planId).duration);
  useEffect(() => {
    savePaymentDraft(profile.id ?? 0, planId, amount, duration);
  }, [profile.id, planId, amount, duration]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [topUpAmount, setTopUpAmount] = useState('');
  const [creditOtp, setCreditOtp] = useState('');
  const [postal, setPostal] = useState('');
  const [postalTouched, setPostalTouched] = useState(false);
  const [pendingFeeKey, setPendingFeeKey] = useState('');
  const [summary, setSummary] = useState<CalculatorSummary | null>(null);
  const plan = options.data?.find(p => p.planId === planId);
  const status = intake.data;
  const chosenCondition = eligibleConditionId(plan, amount, Number(duration));
  const conditionDetails = plan?.conditions?.find(item => item.id === chosenCondition);
  const minimumAmount = conditionDetails?.minimumAmount ?? plan?.minimumAmount;
  const maximumAmount = conditionDetails?.maximumAmount ?? plan?.maximumAmount;
  const durations = conditionDetails?.allowedDurations ?? plan?.allowedDurations ?? [];
  const feeKey = `customer-fee:${profile.id}:${planId}`;
  useEffect(() => { try { setPendingFeeKey(sessionStorage.getItem(feeKey) || ''); } catch { setPendingFeeKey(''); } }, [feeKey]);
  useEffect(() => { if (status && !postalTouched) setPostal(status.verification.postalCode || profile.postalCode || ''); }, [status, postalTouched, profile.postalCode]);
  const refreshAll = () => Promise.all(['intake', 'options', 'credit', 'wallet', 'me', 'identity-docs'].map(k => queryClient.invalidateQueries({ queryKey: ['customer', k] })));
  const credit = checks.data?.find(c => c.status === 'report_generated' && !!c.expiresAt && new Date(c.expiresAt).getTime() > Date.now());
  const pendingCredit = checks.data?.find(c => c.status === 'awaiting_otp');
  const processingCredit = checks.data?.find(c => c.status === 'processing');
  const failedCredit = checks.data?.find(c => c.status === 'failed');
  const creditSeen = useRef(false);
  useEffect(() => { if (credit && !creditSeen.current) { creditSeen.current = true; void queryClient.invalidateQueries({ queryKey: ['customer', 'intake'] }); void queryClient.invalidateQueries({ queryKey: ['customer', 'options'] }); } }, [credit, queryClient]);
  const requiredIdentity = Object.keys(identityLabels);
  const missingDocs = intake.data?.requiredDocumentTypes ?? (docs.data ? requiredIdentity.filter(type => !docs.data?.some(d => d.documentType === type && d.status !== 'rejected')) : requiredIdentity);
  const afterCredit = () => { void queryClient.invalidateQueries({ queryKey: ['customer', 'credit'] }); void queryClient.invalidateQueries({ queryKey: ['customer', 'intake'] }); };
  const checkMutation = useMutation({ mutationFn: portalApi.startCreditCheck, onSuccess: afterCredit });
  const validateCredit = useMutation({ mutationFn: () => portalApi.validateCreditOtp(pendingCredit!.id, digits(creditOtp).trim()), onSuccess: () => { setCreditOtp(''); afterCredit(); } });
  const renewCredit = useMutation({ mutationFn: () => portalApi.renewCreditOtp(pendingCredit!.id), onSuccess: afterCredit });
  const topUp = useMutation({ mutationFn: (a: string) => portalApi.topUpAndPay(a), retry: false });
  const charge = useMutation({ mutationFn: (v: { key: string; body: { planId: number; conditionId: number; requestedAmount: string; durationMonths: number } }) => portalApi.filingFee(v.body, v.key), retry: false });
  const verify = useMutation({ mutationFn: (code: string) => portalApi.intakeVerify(planId, code), retry: false, onSettled: () => { void refreshAll(); } });
  const create = useMutation({ mutationFn: portalApi.createApplication, retry: false });
  const automaticSubmission = useRef<number | null>(null);
  useEffect(() => {
    if (!status?.canSubmit || !verified(profile) || !status.feeChargeId || !plan ||
        !(status.documentsComplete || status.documentsPreviouslyApproved)) return;
    const requestedAmount = digits(amount).replace(/[,\s٬]/g, '');
    const conditionId = eligibleConditionId(plan, amount, Number(duration));
    if (!conditionId || !/^[1-9]\d{0,17}$/.test(requestedAmount) ||
        !Number.isSafeInteger(Number(duration)) || Number(duration) < 1 ||
        automaticSubmission.current === status.feeChargeId) return;
    // The server consumes a fee only once, including reloads and other tabs.
    automaticSubmission.current = status.feeChargeId;
    setError('');
    void create.mutateAsync({ planId, conditionId, requestedAmount, durationMonths: Number(duration),
      feeChargeId: status.feeChargeId }).then(async app => {
      if (!app?.id) throw new Error('شناسه پرونده دریافت نشد؛ فهرست درخواست‌ها را بررسی کنید.');
      await Promise.all(['applications', 'active-applications', 'intake'].map(key =>
        queryClient.invalidateQueries({ queryKey: ['customer', key] })));
      navigate(`/customer/applications/${app.id}`);
    }).catch(failure => setError(message(failure)));
  }, [status, profile, plan, planId, amount, duration, create.mutateAsync, queryClient, navigate]);

  const back = `/customer/plans?planId=${planId}`;
  const head = (title: string, lede?: ReactNode) => <div><h1 className="nfp-h1">{title}</h1>{lede && <p className="nfp-lede" data-testid="card-selected-plan">{lede}</p>}</div>;
  if (options.isLoading || intake.isLoading) return <ApplyFrame>{head('ثبت درخواست')}<SkeletonCards n={2} /></ApplyFrame>;
  if (options.isError) return <ApplyFrame>{head('ثبت درخواست')}<ErrorBox title="طرح‌ها بارگیری نشد" text={message(options.error)} retry={() => void options.refetch()} /></ApplyFrame>;
  if (intake.isError || !status) return <ApplyFrame>{head('ثبت درخواست')}<ErrorBox title="وضعیت درخواست بارگیری نشد" text={message(intake.error)} retry={() => void intake.refetch()} /></ApplyFrame>;
  const home = <Link href="/customer/plans" className="nf-btn nf-btn--primary" data-testid="link-apply-home">بازگشت و انتخاب طرح دیگر</Link>;
  if (status.creditValid && !status.planEligible) return <ApplyFrame>{head('سازگاری با طرح', plan ? <>{plan.name}{plan.bankName && <><Sep />{plan.bankName}</>}</> : undefined)}
    <section className="nfp-card" role="alert" data-testid="panel-incompatible-rank"><div className="nfp-empty nfp-err"><span className="nfp-big"><Icon icon={Ban} /></span><h2>رتبه‌ی اعتباری شما با این طرح سازگار نیست</h2>
      <p>رتبه‌ی اعتباری ثبت‌شده‌ی شما: <b data-testid="text-credit-rank">{status.creditRank || 'نامشخص'}</b>. این طرح برای این رتبه قابل ثبت نیست و هزینه‌ای از شما دریافت نشده است.</p>{home}</div></section></ApplyFrame>;
  if (!plan) return <ApplyFrame>{head('ثبت درخواست')}<EmptyBox icon={Ban} title="این طرح برای شما قابل ثبت نیست" text="طرح انتخاب‌شده وجود ندارد یا شرایط ثبت آن برای شما فعال نیست.">{home}</EmptyBox></ApplyFrame>;

  const v = status.verification;
  const feeDone = status.feeChargeId != null;
  const verifyDone = v.postalOk && v.sanaOk;
  const verifyFinal = v.postalAnswered && v.sanaAnswered;
  const docsDone = status.documentsComplete || status.documentsPreviouslyApproved;
  const flags = [status.creditValid, status.creditValid && status.planEligible, feeDone, verifyDone, docsDone, false];
  const activeIdx = flags.findIndex(d => !d);
  const feeAmount = String(status.filingFeeToman ?? '');
  const knownFee = /^\d+$/.test(feeAmount);
  const canAffordFee = knownFee && wallet.data?.cashBalanceToman != null && /^\d+$/.test(String(wallet.data.cashBalanceToman)) && BigInt(String(wallet.data.cashBalanceToman)) >= BigInt(feeAmount);
  const requestedAmount = digits(amount).replace(/[,\s٬]/g, '');
  const amountOk = /^\d+$/.test(requestedAmount) && BigInt(requestedAmount) > 0n && (maximumAmount == null || BigInt(requestedAmount) <= BigInt(maximumAmount)) && (minimumAmount == null || BigInt(requestedAmount) >= BigInt(minimumAmount));
  const selectionOk = !!chosenCondition && amountOk && durations.includes(Number(duration));
  const payFee = async () => {
    if (!selectionOk || !chosenCondition || !knownFee || charge.isPending) return;
    setError('');
    let key = pendingFeeKey; if (!key) { key = crypto.randomUUID(); try { sessionStorage.setItem(feeKey, key); } catch { /* guarded server-side */ } setPendingFeeKey(key); }
    try { const r = await charge.mutateAsync({ key, body: { planId, conditionId: chosenCondition, requestedAmount, durationMonths: Number(duration) } }); if (typeof r.chargeId !== 'number') throw new Error('رسید پرداخت از سرور دریافت نشد. وضعیت را به‌روزرسانی کنید.'); await refreshAll(); }
    catch (e) { setError(message(e)); void refreshAll(); }
  };
  const submitVerify = (e: FormEvent) => {
    e.preventDefault(); setError('');
    const code = digits(postal).trim();
    if (!/^\d{10}$/.test(code)) { setError('کد پستی باید ۱۰ رقم باشد.'); return; }
    verify.mutate(code, { onError: err => setError(message(err)) });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!status.canSubmit || !verified(profile) || status.feeChargeId == null) { setError('برای ثبت درخواست، مراحل هویتی و مدارک را تکمیل کنید.'); return; }
    if (!chosenCondition || !amountOk || !durations.includes(Number(duration))) { setError('مبلغ و مدت با بازه مجاز شرط انتخاب‌شده سازگار نیست.'); return; }
    try { const app = await create.mutateAsync({ planId, conditionId: chosenCondition, requestedAmount, durationMonths: Number(duration), feeChargeId: status.feeChargeId, notes: notes.trim() || undefined });
      if (!app?.id) throw new Error('شناسه پرونده از سرور دریافت نشد. فهرست درخواست‌ها را بررسی کنید.');
      await queryClient.invalidateQueries({ queryKey: ['customer', 'applications'] }); await queryClient.invalidateQueries({ queryKey: ['customer', 'active-applications'] }); navigate(`/customer/applications/${app.id}`); }
    catch (e) { setError(message(e)); }
  };
  const selectionHint = !selectionOk && <div className="nfp-alert nfp-info" role="status" data-testid="status-select-amount"><Icon icon={Info} small /><span>ابتدا مبلغ دریافتی و تعداد اقساط را انتخاب کنید.</span></div>;
  const errorAlert = error && <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{error}</span></div>;
  const alertOf = (e: unknown) => <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{message(e)}</span></div>;
  const loadingRow = <div className="nfp-sk" style={{ height: 48 }} role="status" aria-label="در حال دریافت" />;
  const retryRow = (e: unknown, retry: () => void) => <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{message(e)}</span>
    <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={retry} data-testid="button-retry">تلاش دوباره</button></div>;
  const step = activeIdx < 0 ? 5 : activeIdx;
  const titles = ['اعتبارسنجی', 'سازگاری با طرح', 'مبلغ و تعداد اقساط', 'استعلام ثنا و کد پستی', 'مدارک هویتی', 'ارجاع به کارشناس'];
  const ledes = [
    'برای بررسی طرح، یک بار اعتبارسنجی بانکی لازم است. کد تأیید به شماره همراه شما پیامک می‌شود.',
    'سازگاری رتبه‌ی اعتباری شما با این طرح بررسی می‌شود.',
    '',
    'کد پستی محل سکونت را وارد کنید. نتیجه‌ی هر استعلام قطعی است و خودکار تکرار نمی‌شود.',
    'تصویر مدارک هویتی را بارگذاری کنید. بعد از تکمیل، درخواست خودکار ثبت و به کارشناس فروش ارجاع می‌شود.',
    'درخواست شما ثبت و به کارشناس فروش ارجاع می‌شود. تکمیل اطلاعات و ارسال قرارداد را کارشناس انجام می‌دهد.',
  ];
  const content: ReactNode[] = [
    <>
      {!profile.identityReady && <div className="nfp-alert nfp-info" role="status"><Icon icon={Info} small /><span>ابتدا اطلاعات پایه‌ی هویتی شما باید ثبت شود.</span>
        <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={() => navigate('/customer/profile')} data-testid="button-go-profile">تکمیل پروفایل</button></div>}
      {checks.isLoading && loadingRow}
      {checks.isError && retryRow(checks.error, () => void checks.refetch())}
      {checks.isSuccess && (pendingCredit ? <>
        <div className="nf-field"><label className="nf-label" htmlFor="credit-otp">کد تأیید اعتبارسنجی</label>
          <input id="credit-otp" className="nf-input nf-input--ltr" inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={creditOtp} onChange={e => setCreditOtp(e.target.value)} data-testid="input-credit-otp" />
          <span className="nf-hint">کد پیامک‌شده برای اعتبارسنجی را بنویسید.</span></div>
        <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={validateCredit.isPending || !/^\d{4,8}$/.test(digits(creditOtp))} onClick={() => validateCredit.mutate()} data-testid="button-validate-credit-otp">{validateCredit.isPending ? <><Icon icon={RefreshCw} small />در حال بررسی…</> : 'تأیید کد'}</button>
        <button type="button" className="nf-btn nf-btn--text" disabled={renewCredit.isPending} onClick={() => renewCredit.mutate()} data-testid="button-renew-credit-otp">ارسال دوباره‌ی کد</button></>
        : processingCredit ? <div className="nfp-alert nfp-info" role="status"><Icon icon={Hourglass} small /><span>اعتبارسنجی در حال انجام است. نتیجه خودکار نشان داده می‌شود.</span></div>
        : <>{failedCredit && <div className="nfp-alert" role="alert"><Icon icon={AlertCircle} small /><span>{failedCredit.message || 'اعتبارسنجی ناموفق بود. می‌توانید دوباره تلاش کنید.'}</span></div>}
          <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={!profile.identityReady || checkMutation.isPending} onClick={() => checkMutation.mutate()} data-testid="button-start-credit-check">{checkMutation.isPending ? <><Icon icon={RefreshCw} small />در حال استعلام…</> : failedCredit ? 'تلاش دوباره برای اعتبارسنجی' : 'شروع اعتبارسنجی'}</button></>)}
      {(checkMutation.isError || validateCredit.isError || renewCredit.isError) && alertOf(checkMutation.error || validateCredit.error || renewCredit.error)}
    </>,
    <p className="nfp-muted">در حال بررسی سازگاری…</p>,
    <>
      {wallet.isLoading ? loadingRow : wallet.isError ? retryRow(wallet.error, () => void wallet.refetch())
        : <div className="nfp-fee-line"><span>موجودی کیف پول</span><b>{number(wallet.data?.cashBalanceToman)} <small>تومان</small></b></div>}
      {selectionHint}
      {wallet.isSuccess && knownFee && !canAffordFee && <>
        <div className="nfp-alert nfp-warn" role="status"><Icon icon={Wallet} small /><span>موجودی برای پرداخت کافی نیست. کیف پول را شارژ کنید و بعد وضعیت را به‌روز کنید.</span></div>
        <div className="nf-field"><label className="nf-label" htmlFor="topup">مبلغ شارژ (تومان)</label>
          <input id="topup" className="nf-input nf-input--ltr" inputMode="numeric" dir="ltr" value={topUpAmount} onChange={e => setTopUpAmount(e.target.value)} data-testid="input-wallet-topup" /></div>
        <button type="button" className="nf-btn nf-btn--secondary nf-btn--block" disabled={topUp.isPending || !/^\d+$/.test(digits(topUpAmount)) || Number(digits(topUpAmount)) <= 0} onClick={() => { setError(''); topUp.mutate(digits(topUpAmount), { onSuccess: r => { try { const u = new URL(r.paymentUrl); if (u.protocol !== 'https:') throw new Error(); window.location.assign(u.href); } catch { setError('لینک پرداخت امن دریافت نشد.'); } }, onError: e => setError(message(e)) }); }} data-testid="button-topup-fee">{topUp.isPending ? 'در حال اتصال…' : 'شارژ از درگاه'}</button></>}
      {errorAlert}
      <div className="nfp-ap-cta nfp-stack">
        <button type="button" className="nf-btn nf-btn--primary nf-btn--block" disabled={!selectionOk || !knownFee || !canAffordFee || charge.isPending} onClick={() => void payFee()} data-testid="button-pay-fee">{charge.isPending ? <><Icon icon={RefreshCw} small />در حال پرداخت…</> : charge.isError ? 'بررسی و پرداخت دوباره' : 'پرداخت هزینه تشکیل پرونده از کیف پول'}</button>
        <button type="button" className="nf-btn nf-btn--text" onClick={() => { void queryClient.invalidateQueries({ queryKey: ['customer', 'wallet'] }); void intake.refetch(); }} data-testid="button-refresh-fee"><Icon icon={RefreshCw} small />به‌روزرسانی وضعیت</button>
      </div>
    </>,
    (verifyFinal && !verifyDone) || v.inquiryAttempted
      ? <div className="nfp-alert" role="status" data-testid="status-verify-negative"><Icon icon={AlertCircle} small /><span>{verifyFinal ? 'نتیجه‌ی استعلام ثنا یا کد پستی تأیید نشد.' : 'استعلام ثبت شده و نتیجه‌ی آن نیاز به پیگیری کارشناس دارد؛ استعلام دیگری ارسال نمی‌شود.'} لطفاً با کارشناس فروش صحبت کنید. <Link href={CHAT_HREF} data-testid="link-contact-expert">گفتگو با کارشناس</Link></span></div>
      : <form className="nfp-stack" onSubmit={submitVerify} noValidate>
        {(v.postalAnswered || v.sanaAnswered) && <div className="nfp-alert nfp-info" role="status"><Icon icon={Info} small /><span>{v.postalAnswered ? (v.postalOk ? 'کد پستی تأیید شد. ' : 'کد پستی تأیید نشد. ') : ''}{v.sanaAnswered ? (v.sanaOk ? 'ثنا تأیید شد.' : 'ثنا تأیید نشد.') : 'ثنا هنوز پاسخ قطعی ندارد.'}</span></div>}
        <div className="nf-field"><label className="nf-label" htmlFor="intake-postal">کد پستی</label>
          <input id="intake-postal" className="nf-input nf-input--ltr" required inputMode="numeric" maxLength={10} dir="ltr" value={postal} onChange={e => { setPostal(e.target.value); setPostalTouched(true); }} data-testid="input-intake-postal" />
          <span className="nf-hint">۱۰ رقم، بدون خط تیره</span></div>
        {errorAlert}
        <button className="nf-btn nf-btn--primary nf-btn--block" disabled={verify.isPending} data-testid="button-intake-verify">{verify.isPending ? <><Icon icon={RefreshCw} small />در حال استعلام…</> : 'استعلام ثنا و کد پستی'}</button>
        {verify.isSuccess && verify.data?.status === 'pending' && <div className="nfp-alert nfp-info" role="status"><Icon icon={Hourglass} small /><span>استعلام در انتظار نتیجه است.</span>
          <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={() => void intake.refetch()} data-testid="button-refresh-verify">به‌روزرسانی</button></div>}
      </form>,
    <>
      {docs.isLoading && loadingRow}
      {docs.isError && retryRow(docs.error, () => void docs.refetch())}
      {docs.isSuccess && <p className="nfp-muted">{missingDocs.length ? `${number(missingDocs.length)} مدرک باید بارگذاری شود.` : 'همه‌ی مدارک هویتی رسیده است.'}</p>}
      {docs.isSuccess && <IdentityDocumentUploads missing={missingDocs} onUploaded={() => void queryClient.invalidateQueries({ queryKey: ['customer', 'intake'] })} />}
      {errorAlert}
    </>,
    <form className="nfp-stack" onSubmit={submit}>
      {selectionHint}
      <div className="nf-field"><label className="nf-label" htmlFor="apply-notes">توضیحات (اختیاری)</label>
        <textarea id="apply-notes" className="nf-input" rows={3} value={notes} onChange={e => setNotes(e.target.value)} data-testid="input-apply-notes" /></div>
      {!verified(profile) && <div className="nfp-alert nfp-info" role="status"><Icon icon={Info} small /><span>تأیید کامل هویت هنوز در پروفایل شما ثبت نشده است؛ بعد از به‌روزرسانی می‌توانید ثبت کنید.</span>
        <button type="button" className="nf-btn nf-btn--secondary nf-btn--sm" onClick={() => void refreshAll()} data-testid="button-refresh-identity">به‌روزرسانی</button></div>}
      {errorAlert}
      <div className="nfp-ap-cta"><button className="nf-btn nf-btn--primary nf-btn--block" disabled={!status.canSubmit || !verified(profile) || !selectionOk || create.isPending} data-testid="button-create-application">{create.isPending ? <><Icon icon={RefreshCw} small />در حال ثبت و ارجاع…</> : <>ثبت و ارسال به کارشناس<Icon icon={ArrowLeft} small /></>}</button></div>
    </form>,
  ];
  const calculator = <PlanCalculator key={`c${plan.planId}`} planId={plan.planId} eligiblePlan={plan} amount={amount} duration={duration} onAmount={setAmount} onDuration={setDuration}
    feeToman={feeAmount} onSummary={setSummary} />;
  const summaryLine = summary && summary.cash != null
    ? <>مبلغ دریافتی {number(summary.cash)} تومان<Sep />{summary.installment == null ? 'قسط بعداً اعلام می‌شود' : `قسط ${number(summary.installment)} تومان`}<Sep />{number(summary.months)} قسط</>
    : 'مبلغ دریافتی و تعداد اقساط را انتخاب کنید';
  return <ApplyFrame>
    <div className="nfp-wz-meta"><span>مرحله <b>{fa(step + 1)}</b> از {fa(APPLY_STEPS.length)}<Sep />{APPLY_STEPS[step]}</span></div>
    <div className="nf-progress" style={{ ['--steps' as string]: APPLY_STEPS.length }} role="progressbar" aria-valuemin={1} aria-valuemax={APPLY_STEPS.length} aria-valuenow={step + 1} aria-label="پیشرفت ثبت درخواست">
      {APPLY_STEPS.map((_, i) => <span key={i} className={i < step ? 'is-done' : i === step ? 'is-current' : ''} />)}</div>
    {head(titles[step], <>{plan.name}{plan.bankName && <><Sep />{plan.bankName}</>}</>)}
    {step === 2 ? <div className="nfp-stack" data-testid="section-calc-collapse">{calculator}</div>
      : <details className="nfp-card nfp-collapse" data-testid="section-calc-collapse"><summary><span><b>خلاصه‌ی درخواست</b><small>{summaryLine}</small></span><Icon icon={ChevronDown} small /></summary>
        <div className="nfp-collapse-body">{calculator}</div></details>}
    {step !== 2 && ledes[step] && <p className="nfp-muted">{ledes[step]}</p>}
    <section className="nfp-card nfp-stack" aria-label={APPLY_STEPS[step]}>{content[step]}</section>
    <details className="nfp-card nfp-collapse"><summary><span><b>مدارک لازم این طرح</b><small>فهرست مدارکی که کارشناس بعداً می‌خواهد</small></span><Icon icon={ChevronDown} small /></summary>
      <div className="nfp-collapse-body"><PlanRequirements key={`r${plan.planId}`} planId={plan.planId} /></div></details>
    <p className="nfp-muted" style={{ textAlign: 'center' }}><Link href={back} data-testid="link-apply-back">بازگشت به طرح</Link></p>
  </ApplyFrame>;
}

const identityLabels: Record<string, string> = { national_card_front: 'روی کارت ملی', national_card_back: 'پشت کارت ملی', birth_certificate_first_page: 'صفحه اول شناسنامه', birth_certificate_second_page: 'صفحه دوم شناسنامه', birth_certificate_last_page: 'صفحه آخر شناسنامه' };

function Gate() {
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const profile = useQuery({ queryKey: ['customer', 'me'], queryFn: portalApi.me, retry: false });
  useEffect(() => {
    const handler = () => { void queryClient.invalidateQueries({ queryKey: ['customer', 'me'] }); };
    window.addEventListener('cp-identity-required', handler);
    return () => window.removeEventListener('cp-identity-required', handler);
  }, [queryClient]);
  useEffect(() => {
    const expired = () => {
      queryClient.removeQueries({ queryKey: ['customer'] });
      navigate('/customer/login?expired=1');
    };
    window.addEventListener('cp-session-expired', expired);
    return () => window.removeEventListener('cp-session-expired', expired);
  }, [navigate, queryClient]);
  if (profile.isLoading) return <div className="cp nfp"><main className="nfp-wrap"><SkeletonCards n={3} /></main></div>;
  if (profile.error instanceof PortalApiError && profile.error.status === 401) return <Redirect to="/customer/login" />;
  if (profile.isError || !profile.data) return <div className="cp nfp"><main className="nfp-wrap"><div className="nfp-stack" style={{ maxWidth: 560, marginInline: 'auto' }}>
    <ErrorBox title="اطلاعات حساب بارگیری نشد" text={message(profile.error)} retry={() => void profile.refetch()} />
    <Link href="/customer/login" className="nf-btn nf-btn--text" data-testid="link-customer-login-error">رفتن به صفحه‌ی ورود</Link></div></main></div>;
  if (!profile.data.identityReady) return location === '/customer/identity' ? <IdentityPage /> : <Redirect to="/customer/identity" />;
  if (location === '/customer/identity') return <Redirect to="/customer" />;
  return <CustomerShell profile={profile.data}><Switch>
    <Route path="/customer"><Overview profile={profile.data} /></Route>
    <Route path="/customer/plans" component={PlansPage} />
    <Route path="/customer/advice" component={AdviceHub} />
    <Route path="/customer/advice/ai" component={AiAdvice} />
    <Route path="/customer/advice/finder" component={PlanFinder} />
    <Route path="/customer/advice/chat" component={CustomerChat} />
    <Route path="/customer/apply"><ApplyGate profile={profile.data} /></Route>
    <Route path="/customer/wallet"><WalletPanel /></Route>
    <Route path="/customer/profile"><ProfilePage profile={profile.data} /></Route>
    <Route path="/customer/applications" component={RequestsPage} />
    <Route path="/customer/applications/:id" component={ApplicationDetail} />
    <Route><EmptyBox icon={Search} title="این صفحه پیدا نشد" text="به خانه‌ی پرتال برگردید."><Link href="/customer" className="nf-btn nf-btn--primary" data-testid="link-customer-not-found">بازگشت به خانه</Link></EmptyBox></Route>
  </Switch></CustomerShell>;
}

export default function CustomerPortal() {
  return <Switch><Route path="/customer/login" component={CustomerLogin} /><Route component={Gate} /></Switch>;
}

