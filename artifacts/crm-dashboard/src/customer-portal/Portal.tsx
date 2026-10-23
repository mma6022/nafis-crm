import { FloatingChat } from '@/chat/FloatingChat';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Route, Switch, useLocation, useParams } from 'wouter';
import { Home, UserRound, FilePlus2, ArrowLeft, ArrowUp, FileText, LockKeyhole, LogOut, MessageSquareText, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { portalApi, PortalApiError, type ConsultationMessage, type LoanOption, type Profile } from './api';
import { parseJalaliValue } from '@/lib/jalali';
import { IdentityPage } from './Identity';
import { IdentityDocumentUploads } from './IdentityDocumentUploads';
import { WalletPanel } from './WalletPanel';
import { ProfilePage } from './ProfilePage';
import { LoanPlanCards } from './LoanPlanCards';
import { RegistrationTimeline, type TimelineStep } from './RegistrationTimeline';
import { ActiveRequestList } from './ActiveRequests';
import { ExpertHandoff } from './ExpertHandoff';
import { stages } from './stages';
import { PlanRequirements } from './PlanRequirements';
import { PlanCalculator } from './PlanCalculator';
import { eligibleConditionId } from './plan-calculator-values';
import { readPaymentDraft, savePaymentDraft } from './payment-return';
import { AdviceHub, PlanFinder } from './PlanFinder';
import { CustomerChat } from '@/chat/CustomerChat';
import { usePresence } from '@/chat/Presence';
import './portal.css';
import { CustomerLogin } from './CustomerLogin';

const number = (value: string | number | null | undefined) => value == null ? '—' : Number(value).toLocaleString('fa-IR');
const date = (value?: string) => value ? new Date(value).toLocaleDateString('fa-IR') : '—';
const digits = (value: string) => value.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
const message = (error: unknown) => error instanceof Error ? error.message : 'درخواست انجام نشد. دوباره تلاش کنید.';
const verified = (profile: Profile) => profile.verificationStatus === 'verified';
function manualFieldError(fields: LoanOption['manualFields'], values: Record<string, string>) {
  for (const field of fields || []) {
    const value = values[field.variable]?.trim() || '';
    if (field.required && !value) return `تکمیل «${field.label}» برای قرارداد الزامی است.`;
    if (field.maxLength != null && value.length > field.maxLength) return `«${field.label}» نباید بیشتر از ${number(field.maxLength)} نویسه باشد.`;
  }
  return '';
}
function ManualFields({ fields, values, onChange, prefix }: {
  fields: LoanOption['manualFields'];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  prefix: string;
}) {
  if (!fields?.length) return null;
  return <div className="cp-form"><div><h3>اطلاعات اختصاصی قرارداد</h3><p className="cp-hint">این اطلاعات در متن قرارداد همین طرح ثبت می‌شوند.</p></div>
    <div className="cp-form-grid">{fields.map(field => <label className="cp-field" key={field.variable}>{field.label}{field.required ? ' *' : ' (اختیاری)'}
      <input required={field.required} maxLength={field.maxLength ?? undefined} value={values[field.variable] || ''}
        onChange={e => onChange({ ...values, [field.variable]: e.target.value })} data-testid={`input-${prefix}-manual-${field.variable}`} />
      {field.maxLength != null && <small className="cp-hint">حداکثر {number(field.maxLength)} نویسه</small>}
    </label>)}</div>
  </div>;
}

function Brand() {
  return <Link href="/customer" className="cp-brand" data-testid="link-customer-home">
    <img src={`${import.meta.env.BASE_URL}nafiss-financial-logo.png`} alt="نشان گروه مالی نفیس" />
    <span><strong>نفیس</strong><small>همراه شما در مسیر تأمین مالی</small></span>
  </Link>;
}

function Load({ rows = 2 }: { rows?: number }) { return <div aria-label="در حال دریافت اطلاعات" role="status">{Array.from({ length: rows }, (_, i) => <div className="cp-skeleton" key={i} />)}</div>; }
function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="cp-alert" role="alert">{message(error)} <button className="cp-btn cp-btn-outline cp-btn-small" onClick={retry} type="button" data-testid="button-retry">تلاش دوباره <RefreshCw size={13} /></button></div>;
}
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="cp-empty"><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function IdentityModal({ profile, onComplete }: { profile: Profile; onComplete: () => void }) {
  const [form, setForm] = useState({
    name: profile.name || '', nationalCode: profile.nationalCode || '',
    birthDateJalali: profile.birthDateJalali || '', postalCode: profile.postalCode || '', fatherName: profile.fatherName || '',
  });
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setOutcome('');
    const nationalCode = digits(form.nationalCode).trim(), postalCode = digits(form.postalCode).trim();
    const birthDateJalali = digits(form.birthDateJalali).trim();
    if (!/^\d{10}$/.test(nationalCode) || !/^\d{10}$/.test(postalCode) || !parseJalaliValue(birthDateJalali)) {
      setError('کد ملی و کد پستی باید ۱۰ رقم و تاریخ تولد باید به صورت ۱۳۷۰/۰۱/۰۱ باشد.'); return;
    }
    setPending(true);
    try {
      await portalApi.updateProfile({ ...form, nationalCode, postalCode, birthDateJalali });
      const result = await portalApi.verifyIdentity();
      setOutcome(result.status === 'verified' ? 'هویت شما تأیید شد.' : result.status === 'pending' ? 'درخواست احراز هویت ثبت شد و در انتظار نتیجه است.' : result.error || 'استعلام هویت ناموفق بود. اطلاعات را بررسی و دوباره تلاش کنید.');
      await onComplete();
    } catch (e) { setError(message(e)); }
    finally { setPending(false); }
  };
  const field = (key: keyof typeof form, label: string, extra?: Record<string, string>) =>
    <label className="cp-field" key={key}>{label}<input required value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} {...extra} data-testid={`input-identity-${key}`} /></label>;
  return <div className="cp-modal-backdrop"><section className="cp-modal" role="dialog" aria-modal="true" aria-labelledby="identity-title">
    <span className="cp-kicker"><ShieldCheck size={15} /> حفاظت از هویت شما</span>
    <h2 id="identity-title">ابتدا همدیگر را بشناسیم.</h2>
    <p>برای ثبت درخواست تسهیلات، اطلاعات هویتی شما باید با سرویس‌های رسمی راستی‌آزمایی شود. تا پیش از تأیید، امکان ثبت درخواست وجود ندارد.</p>
    <form className="cp-form" onSubmit={submit}>
      <div className="cp-form-grid">
        {field('name', 'نام و نام خانوادگی', { autoComplete: 'name' })}
        {field('fatherName', 'نام پدر')}
        {field('nationalCode', 'کد ملی', { inputMode: 'numeric', maxLength: '10', dir: 'ltr' })}
        {field('birthDateJalali', 'تاریخ تولد شمسی', { placeholder: '۱۳۷۰/۰۱/۰۱', dir: 'ltr' })}
        {field('postalCode', 'کد پستی', { inputMode: 'numeric', maxLength: '10', dir: 'ltr' })}
      </div>
      {profile.verificationStatus === 'pending' && <div className="cp-alert cp-alert-info" role="status">بررسی هویت شما در جریان است. نتیجه را پس از به‌روزرسانی این صفحه مشاهده کنید.</div>}
      {profile.verificationStatus === 'failed' && <div className="cp-alert" role="alert">{profile.verificationMessage || 'احراز هویت قبلی ناموفق بود. اطلاعات را بررسی و دوباره ارسال کنید.'}</div>}
      {error && <div className="cp-alert" role="alert">{error}</div>}
      {outcome && <div className="cp-alert cp-alert-info" role="status">{outcome}</div>}
      <button className="cp-btn cp-btn-primary" disabled={pending} data-testid="button-verify-identity">{pending ? 'در حال بررسی هویت…' : 'ثبت و استعلام هویت'} <ArrowLeft size={16} /></button>
    </form>
  </section></div>;
}

const tabs = [
  { key: 'home', href: '/customer', label: 'خانه', icon: Home, match: (l: string) => l === '/customer' },
  { key: 'advice', href: '/customer/advice', label: 'مشاوره و گفتگو', icon: MessageSquareText, match: (l: string) => l === '/customer/advice' || l.startsWith('/customer/advice/') },
  { key: 'requests', href: '/customer/applications', label: 'درخواست‌ها', icon: FilePlus2, match: (l: string) => l.startsWith('/customer/applications') },
  { key: 'wallet', href: '/customer/wallet', label: 'کیف پول', icon: Wallet, match: (l: string) => l === '/customer/wallet' },
  { key: 'profile', href: '/customer/profile', label: 'پروفایل', icon: UserRound, match: (l: string) => l === '/customer/profile' },
];
function ApplyGate({ profile }: { profile: Profile }) {
  const raw = new URLSearchParams(window.location.search).get('planId');
  const planId = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  if (planId == null) return <Redirect to="/customer" />;
  return <Apply key={planId} profile={profile} planId={planId} />;
}
function CustomerShell({ profile, children }: { profile: Profile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [location] = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = { '/customer': 'خانه', '/customer/applications': 'درخواست‌ها', '/customer/apply': 'ثبت درخواست',
      '/customer/wallet': 'کیف پول', '/customer/profile': 'پروفایل', '/customer/advice': 'مشاوره', '/customer/advice/ai': 'مشاوره هوشمند', '/customer/advice/finder': 'پیدا کردن طرح', '/customer/advice/chat': 'گفتگو با کارشناس' };
    document.title = `${titles[location] || 'پیگیری درخواست'} | پرتال مشتریان نفیس`;
  }, [location]);
  usePresence(portalApi.presence, true);
  const thread = useQuery({ queryKey: ['customer', 'chat-thread'], queryFn: portalApi.chatThread, refetchInterval: 8000, refetchOnWindowFocus: true, retry: false });
  const [logoutError, setLogoutError] = useState('');
  const logout = useMutation({ mutationFn: portalApi.logout, onSuccess: () => { queryClient.removeQueries({ queryKey: ['customer'] }); navigate('/customer/login'); }, onError: e => setLogoutError(message(e)) });
  return <div className="cp">
    <header className="cp-header"><div className="cp-header-inner"><Brand /><nav className="cp-nav" aria-label="ناوبری مشتریان">
      <Link href="/customer" aria-current={location === '/customer' ? 'page' : undefined} data-testid="link-customer-overview">خانه</Link>
      <Link href="/customer/advice" aria-current={location.startsWith('/customer/advice') ? 'page' : undefined} data-testid="link-customer-advice">مشاوره و گفتگو</Link>
      <Link href="/customer/applications" aria-current={location.startsWith('/customer/applications') ? 'page' : undefined} data-testid="link-customer-requests">درخواست‌ها</Link>
      <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending} data-testid="button-customer-logout"><LogOut size={13} style={{ verticalAlign: 'middle' }} /> خروج</button>
    </nav></div></header>
    {logoutError && <div className="cp-alert" role="alert">{logoutError}</div>}
    <main className="cp-container">{children}</main>
    <nav className="cp-tabs" aria-label="بخش‌های اصلی">{tabs.map(t => <Link key={t.href} href={t.href} aria-current={t.match(location) ? 'page' : undefined} data-testid={`tab-${t.key}`}><t.icon size={20} /><span>{t.label}</span></Link>)}</nav>
    <FloatingChat actor={`customer:${profile.id ?? 'pending'}`} bottomOffset={84} items={[{ href: '/customer/advice/chat', label: 'گفتگو با کارشناس', count: thread.data?.unreadCount ?? 0 }]} />
  </div>;
}

function Overview({ profile }: { profile: Profile }) {
  const applications = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications, staleTime: 0, refetchInterval: 15000 });
  return <>
    <div className="cp-pagehead"><div><p className="cp-eyebrow">حساب شخصی / نمای کلی</p><h1 className="cp-title">سلام، {profile.name || 'همراه نفیس'}</h1><p className="cp-lede">مسیر درخواست‌های شما، از همین‌جا آغاز می‌شود.</p></div><span className="cp-kicker"><ShieldCheck size={14} /> {verified(profile) ? 'احراز هویت کامل' : 'هویت و شماره همراه تأیید شده'}</span></div>
    <WalletPanel embedded />
    <div className="cp-grid"><div className="cp-stack">
      <section><div className="cp-pagehead" style={{ marginBottom: 8 }}><div><h2>طرح‌های تسهیلات</h2><p>طرح‌ها و بانک تأمین‌کننده هر کدام</p></div><Link href="/customer/advice" className="cp-link" data-testid="link-start-advice">مشاور هوشمند ←</Link></div><LoanPlanCards /></section>
      <section className="cp-card"><div className="cp-pagehead" style={{ marginBottom: 5 }}><div><h2>درخواست‌های فعال</h2><p>خلاصه‌ای از پرونده‌های در جریان</p></div><Link href="/customer/applications" className="cp-link" data-testid="link-all-requests">همه ←</Link></div>
        {applications.isLoading ? <Load /> : applications.isError ? <Failure error={applications.error} retry={() => void applications.refetch()} /> : applications.data?.length ? <ActiveRequestList items={applications.data} limit={3} /> : <Empty title="درخواست فعالی ندارید" text="با انتخاب یکی از طرح‌های بالا می‌توانید درخواست جدید را آغاز کنید." />}
      </section>
    </div><aside className="cp-stack"><section className="cp-card"><p className="cp-eyebrow">مسیر پیش رو</p><h3>در سه قدم تا درخواست</h3><ol className="cp-steps"><li><span className="cp-step-index">۱</span><span><strong>احراز هویت</strong><small>اطلاعات هویتی خود را تکمیل کنید.</small></span></li><li><span className="cp-step-index">۲</span><span><strong>انتخاب طرح</strong><small>شرایط بازپرداخت را مقایسه کنید.</small></span></li><li><span className="cp-step-index">۳</span><span><strong>ثبت و پیگیری</strong><small>هر تغییر پرونده را همین‌جا ببینید.</small></span></li></ol></section><section className="cp-card"><MessageSquareText size={23} color="#bc9252" /><h3 style={{ marginTop: 12 }}>در انتخاب مردد هستید؟</h3><p>با مشاور هوشمند گفتگو کنید. پیشنهاد طرح تنها پس از بررسی شرایط سرور قابل انتخاب است.</p><Link href="/customer/advice" className="cp-link" data-testid="link-advice-aside">شروع گفتگو ←</Link></section></aside></div>
  </>;
}

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
    // Recommendations return to home; only its plan selection begins a request.
    const plan = options.data?.find(p => p.planId === rec.planId);
    return plan ? <div key={`${rec.planId}-${index}`} style={{ marginTop: 13 }}><Link href={`/customer?planId=${encodeURIComponent(plan.planId)}`} className="cp-btn cp-btn-gold cp-btn-small" data-testid={`link-recommended-plan-${rec.planId}`}>{rec.label || plan.name} <ArrowLeft size={13} /></Link></div> : null;
  })}<small>{date(item.createdAt)}</small></div>;
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">راهنمای انتخاب</p><h1 className="cp-title">گفتگو برای یک تصمیم بهتر.</h1><p className="cp-lede">سؤال‌تان را بپرسید؛ شرایط نهایی هر طرح در مرحله درخواست توسط سامانه بررسی می‌شود.</p></div></div>
    <div className="cp-grid"><section className="cp-card cp-chat"><div className="cp-messages" aria-live="polite">
      {consultations.isLoading || (consultationId && history.isLoading) ? <Load rows={3} /> : consultations.isError ? <Failure error={consultations.error} retry={() => void consultations.refetch()} /> : history.isError ? <Failure error={history.error} retry={() => void history.refetch()} /> : history.data?.length ? history.data.map(renderMessage) : <Empty title="گفتگو را شروع کنیم" text="درباره مبلغ، مدت بازپرداخت یا شرایط تسهیلات از من بپرسید." />}
      {send.isPending && <div className="cp-skeleton" style={{ width: '60%', height: 65 }} />}
    </div>{options.isError && <div className="cp-alert cp-alert-info" role="status">طرح‌ها دریافت نشدند؛ لینک پیشنهاد تا زمان بررسی معتبر بودن طرح نمایش داده نمی‌شود. <button type="button" onClick={() => void options.refetch()} data-testid="button-retry-advice-options">تلاش دوباره</button></div>}
    {sendError && <div className="cp-alert" role="alert">{sendError}</div>}
    <form className="cp-chat-compose" onSubmit={submit}><label className="cp-field"><span className="sr-only">پیام شما</span><textarea value={text} onChange={e => setText(e.target.value)} placeholder="مثلاً برای بازپرداخت ۲۴ ماهه چه طرحی مناسب است؟" data-testid="input-advice-message" /></label><button className="cp-btn cp-btn-primary" disabled={send.isPending || !text.trim()} data-testid="button-send-advice">ارسال <ArrowUp size={16} /></button></form>
    </section><aside className="cp-card"><p className="cp-eyebrow">نکته مهم</p><h3>پیشنهاد، نه تصمیم نهایی</h3><p>مشاور به شما در شناخت طرح‌ها کمک می‌کند. اعتبارسنجی، شرایط طرح و امکان ثبت درخواست فقط توسط سرور تعیین می‌شود.</p><div className="cp-rule" /><Link href="/customer" className="cp-link" data-testid="link-advice-options">دیدن همه طرح‌ها ←</Link></aside></div></>;
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

  const head = <div className="cp-pagehead"><div><p className="cp-eyebrow"><Link href="/customer" className="cp-link" data-testid="link-apply-back">خانه</Link> / ثبت درخواست</p><h1 className="cp-title">ثبت درخواست تسهیلات</h1></div></div>;
  if (options.isLoading || intake.isLoading) return <>{head}<Load rows={3} /></>;
  if (options.isError) return <>{head}<Failure error={options.error} retry={() => void options.refetch()} /></>;
  if (intake.isError || !status) return <>{head}<Failure error={intake.error} retry={() => void intake.refetch()} /></>;
  const home = <Link href="/customer" className="cp-btn cp-btn-primary" data-testid="link-apply-home">بازگشت به خانه و انتخاب طرح دیگر</Link>;
  if (status.creditValid && !status.planEligible) return <>{head}<section className="cp-card" role="alert" data-testid="panel-incompatible-rank"><h2>رتبه اعتباری شما با این طرح سازگار نیست</h2>
    <p>رتبه اعتباری ثبت‌شده شما: <strong data-testid="text-credit-rank">{status.creditRank || 'نامشخص'}</strong>. این طرح برای این رتبه قابل ثبت نیست و هزینه‌ای از شما دریافت نشده است.</p>{home}</section></>;
  if (!plan) return <>{head}<Empty title="این طرح برای شما قابل ثبت نیست" text="طرح انتخاب‌شده وجود ندارد یا شرایط ثبت آن برای شما فعال نیست." action={home} /></>;

  const v = status.verification;
  const feeDone = status.feeChargeId != null;
  const verifyDone = v.postalOk && v.sanaOk;
  const verifyFinal = v.postalAnswered && v.sanaAnswered;
  const docsDone = status.documentsComplete || status.documentsPreviouslyApproved;
  const flags = [status.creditValid, status.creditValid && status.planEligible, feeDone, verifyDone, docsDone, false];
  const activeIdx = flags.findIndex(d => !d);
  const stt = (i: number): TimelineStep['status'] => flags[i] ? 'done' : i === activeIdx ? 'active' : 'future';
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
  const selectionHint = !selectionOk && <div className="cp-alert cp-alert-info" role="status" data-testid="status-select-amount">ابتدا در بخش «محاسبه و خلاصه درخواست» مبلغ و مدت بازپرداخت را انتخاب کنید؛ شرط طرح هنگام پرداخت به همین انتخاب متصل می‌شود.</div>;
  const steps: TimelineStep[] = [
    { key: 'credit', title: 'اعتبارسنجی جدید', status: stt(0), summary: status.creditValid ? 'گزارش معتبر صادر شده است.' : 'ابتدا لازم است.', content: <>
      {!profile.identityReady && <div className="cp-alert cp-alert-info" role="status">ابتدا اطلاعات پایه هویتی شما باید ثبت شود. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => navigate('/customer/profile')} data-testid="button-go-profile">تکمیل پروفایل</button></div>}
      {checks.isLoading && <Load rows={1} />}
      {checks.isError && <Failure error={checks.error} retry={() => void checks.refetch()} />}
      {checks.isSuccess && (pendingCredit ? <><label className="cp-field">کد تأیید اعتبارسنجی<input inputMode="numeric" dir="ltr" value={creditOtp} onChange={e => setCreditOtp(e.target.value)} data-testid="input-credit-otp" /></label><div className="cp-actions"><button type="button" className="cp-btn cp-btn-primary cp-btn-small" disabled={validateCredit.isPending || !/^\d{4,8}$/.test(digits(creditOtp))} onClick={() => validateCredit.mutate()} data-testid="button-validate-credit-otp">تأیید کد</button><button type="button" className="cp-btn cp-btn-outline cp-btn-small" disabled={renewCredit.isPending} onClick={() => renewCredit.mutate()} data-testid="button-renew-credit-otp">ارسال دوباره کد</button></div></>
        : processingCredit ? <div className="cp-alert cp-alert-info" role="status">اعتبارسنجی در حال پردازش است. نتیجه خودکار به‌روزرسانی می‌شود.</div>
        : <><button type="button" className="cp-btn cp-btn-outline cp-btn-small" disabled={!profile.identityReady || checkMutation.isPending} onClick={() => checkMutation.mutate()} data-testid="button-start-credit-check">{checkMutation.isPending ? 'در حال استعلام…' : failedCredit ? 'تلاش دوباره برای اعتبارسنجی' : 'شروع اعتبارسنجی'}</button>{failedCredit && <div className="cp-alert" role="alert">{failedCredit.message || 'اعتبارسنجی ناموفق بود. می‌توانید دوباره تلاش کنید.'}</div>}</>)}
      {(checkMutation.isError || validateCredit.isError || renewCredit.isError) && <div className="cp-alert" role="alert">{message(checkMutation.error || validateCredit.error || renewCredit.error)}</div>}</> },
    { key: 'rank', title: 'سازگاری با طرح', status: stt(1), summary: status.creditValid ? `رتبه ${status.creditRank || '—'} با طرح سازگار است.` : 'پس از اعتبارسنجی بررسی می‌شود.', content: <p>در حال بررسی سازگاری…</p> },
    { key: 'fee', title: 'هزینه تشکیل پرونده', status: stt(2), summary: feeDone ? 'پرداخت ثبت شد.' : `${number(feeAmount)} تومان`, content: <>
      <p>هزینه ثابت تشکیل پرونده این طرح: <strong>{number(feeAmount)} تومان</strong></p>
      {wallet.isLoading ? <Load rows={1} /> : wallet.isError ? <Failure error={wallet.error} retry={() => void wallet.refetch()} /> : <p>موجودی نقدی: <strong>{number(wallet.data?.cashBalanceToman)} تومان</strong></p>}
      {selectionHint}
      {wallet.isSuccess && knownFee && !canAffordFee && <><div className="cp-alert cp-alert-info" role="status">موجودی برای پرداخت کافی نیست. ابتدا کیف پول را شارژ کنید و سپس وضعیت را به‌روزرسانی کنید.</div>
        <label className="cp-field">مبلغ شارژ (تومان)<input inputMode="numeric" dir="ltr" value={topUpAmount} onChange={e => setTopUpAmount(e.target.value)} data-testid="input-wallet-topup" /></label>
        <button type="button" className="cp-btn cp-btn-outline" disabled={topUp.isPending || !/^\d+$/.test(digits(topUpAmount)) || Number(digits(topUpAmount)) <= 0} onClick={() => { setError(''); topUp.mutate(digits(topUpAmount), { onSuccess: r => { try { const u = new URL(r.paymentUrl); if (u.protocol !== 'https:') throw new Error(); window.location.assign(u.href); } catch { setError('لینک پرداخت امن دریافت نشد.'); } }, onError: e => setError(message(e)) }); }} data-testid="button-topup-fee">{topUp.isPending ? 'در حال اتصال…' : 'شارژ از درگاه'}</button></>}
      <div className="cp-actions"><button type="button" className="cp-btn cp-btn-primary" disabled={!selectionOk || !knownFee || !canAffordFee || charge.isPending} onClick={() => void payFee()} data-testid="button-pay-fee">{charge.isPending ? 'در حال پرداخت…' : charge.isError ? 'بررسی و پرداخت دوباره' : 'پرداخت از کیف پول'}</button>
        <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => { void queryClient.invalidateQueries({ queryKey: ['customer', 'wallet'] }); void intake.refetch(); }} data-testid="button-refresh-fee">به‌روزرسانی وضعیت</button></div></> },
    { key: 'verify', title: 'استعلام ثنا و کد پستی', status: stt(3), summary: verifyDone ? 'تأیید شد.' : 'پس از پرداخت هزینه انجام می‌شود.', content: <>
      {(verifyFinal && !verifyDone) || v.inquiryAttempted ? <div className="cp-alert" role="status" data-testid="status-verify-negative">{verifyFinal ? 'نتیجه استعلام ثنا یا کد پستی تأیید نشد.' : 'استعلام ثبت شده و نتیجهٔ آن نیاز به پیگیری کارشناس دارد؛ استعلام دیگری ارسال نمی‌شود.'} لطفاً با کارشناس فروش تماس بگیرید. <Link href="/customer/advice/chat" className="cp-link" data-testid="link-contact-expert">گفتگو با کارشناس</Link></div>
      : <form className="cp-form" onSubmit={submitVerify}>
        <p className="cp-hint">نتیجه هر استعلام قطعی است و به‌صورت خودکار تکرار نمی‌شود.</p>
        {(v.postalAnswered || v.sanaAnswered) && <div className="cp-alert cp-alert-info" role="status">{v.postalAnswered ? (v.postalOk ? 'کد پستی تأیید شد. ' : 'کد پستی تأیید نشد. ') : ''}{v.sanaAnswered ? (v.sanaOk ? 'ثنا تأیید شد.' : 'ثنا تأیید نشد.') : 'ثنا هنوز پاسخ قطعی ندارد.'}</div>}
        <label className="cp-field">کد پستی<input required inputMode="numeric" maxLength={10} dir="ltr" value={postal} onChange={e => { setPostal(e.target.value); setPostalTouched(true); }} data-testid="input-intake-postal" /></label>
        <button className="cp-btn cp-btn-primary" disabled={verify.isPending} data-testid="button-intake-verify">{verify.isPending ? 'در حال استعلام…' : 'استعلام ثنا و کد پستی'}</button>
        {verify.isSuccess && verify.data?.status === 'pending' && <div className="cp-alert cp-alert-info" role="status">استعلام در انتظار نتیجه است؛ پس از به‌روزرسانی وضعیت را ببینید. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void intake.refetch()} data-testid="button-refresh-verify">به‌روزرسانی</button></div>}
      </form>}</> },
    { key: 'docs', title: 'مدارک هویتی', status: stt(4), summary: 'پس از تکمیل مدارک هویتی، درخواست به‌صورت خودکار ثبت و برای تکمیل اطلاعات و ارسال قرارداد به کارشناس فروش شما ارجاع می‌شود.', content: <>
      {docs.isLoading && <Load rows={1} />}
      {docs.isError && <Failure error={docs.error} retry={() => void docs.refetch()} />}
      {docs.isSuccess && <p>{number(missingDocs.length)} مدرک نیاز به بارگذاری دارد. مدارک تازه پس از ثبت، در بررسی نهایی کارشناس ارزیابی می‌شوند.</p>}</> },
    { key: 'submit', title: 'ارجاع به کارشناس', status: stt(5), summary: 'پس از تکمیل مدارک هویتی، درخواست شما ثبت و به کارشناس فروش ارجاع می‌شود. تکمیل اطلاعات و ارسال قرارداد را کارشناس انجام می‌دهد.', content: activeIdx === 5 ? <>
      <form className="cp-form" onSubmit={submit}>
        {selectionHint}
        <label className="cp-field">توضیحات (اختیاری)<textarea value={notes} onChange={e => setNotes(e.target.value)} data-testid="input-apply-notes" /></label>
        {!verified(profile) && <div className="cp-alert cp-alert-info" role="status">تأیید کامل هویت هنوز در پروفایل شما ثبت نشده است؛ پس از به‌روزرسانی وضعیت می‌توانید ثبت کنید. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void refreshAll()} data-testid="button-refresh-identity">به‌روزرسانی</button></div>}
        {error && <div className="cp-alert" role="alert">{error}</div>}
        <button className="cp-btn cp-btn-primary" disabled={!status.canSubmit || !verified(profile) || !selectionOk || create.isPending} data-testid="button-create-application">{create.isPending ? 'در حال ثبت و ارجاع…' : 'ثبت و ارسال به کارشناس'} <ArrowLeft size={16} /></button></form></> : null },
  ];
  return <>{head}
    <div className="cp-stack">
      <section className="cp-visual cp-plan-summary" data-testid="card-selected-plan"><span className="cp-visual-bank">{plan.bankName || 'تأمین‌کننده'}</span><h2>{plan.name}</h2><p>هزینه تشکیل پرونده: {number(feeAmount)} تومان</p></section>
      <details className="cp-collapse" data-testid="section-calc-collapse" open={activeIdx === 2 || undefined}><summary>محاسبه و خلاصه درخواست <small>{amount ? `اصل تسهیلات: ${number(amount)} تومان · ${number(duration)} ماه` : 'مبلغ و مدت را تنظیم کنید'}</small></summary>
        <div className="cp-collapse-body"><PlanRequirements key={`r${plan.planId}`} planId={plan.planId} /><PlanCalculator key={`c${plan.planId}`} planId={plan.planId} eligiblePlan={plan} amount={amount} duration={duration} onAmount={setAmount} onDuration={setDuration} /></div></details>
      <section className="cp-card"><h2>مراحل ثبت</h2><RegistrationTimeline steps={steps} />
        {activeIdx >= 4 && docs.isSuccess && <IdentityDocumentUploads missing={missingDocs} onUploaded={() => void queryClient.invalidateQueries({ queryKey: ['customer', 'intake'] })} />}
        {error && activeIdx !== 5 && <div className="cp-alert" role="alert">{error}</div>}</section>
    </div>
  </>;
}

const identityLabels: Record<string, string> = { national_card_front: 'روی کارت ملی', national_card_back: 'پشت کارت ملی', birth_certificate_first_page: 'صفحه اول شناسنامه', birth_certificate_second_page: 'صفحه دوم شناسنامه', birth_certificate_last_page: 'صفحه آخر شناسنامه' };

function ActiveRequestsPage() {
  const active = useQuery({ queryKey: ['customer', 'active-applications'], queryFn: portalApi.activeApplications, staleTime: 0, refetchInterval: 15000 });
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow">پیگیری</p><h1 className="cp-title">درخواست‌های فعال</h1><p className="cp-lede">مرحله فعلی هر پرونده در جریان.</p></div></div>
    <section className="cp-card">{active.isLoading ? <Load rows={3} /> : active.isError ? <Failure error={active.error} retry={() => void active.refetch()} /> : active.data?.length ? <ActiveRequestList items={active.data} /> : <Empty title="درخواست فعالی ندارید" text="درخواست جدید را از طرح‌های صفحه خانه آغاز کنید." action={<Link href="/customer" className="cp-btn cp-btn-primary" data-testid="link-requests-home">مشاهده طرح‌ها</Link>} />}</section></>;
}

function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const appId = Number(id);
  const queryClient = useQueryClient();
  const app = useQuery({ queryKey: ['customer', 'application', appId], queryFn: () => portalApi.application(appId), enabled: Number.isSafeInteger(appId) && appId > 0, staleTime: 0, refetchInterval: 15000 });
  const docs = useQuery({ queryKey: ['customer', 'identity-docs'], queryFn: portalApi.identityDocuments });
  const options = useQuery({ queryKey: ['customer', 'options'], queryFn: portalApi.options });
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busyDoc, setBusyDoc] = useState('');
  const update = useMutation({ mutationFn: (data: { requestedAmount: string; durationMonths: number; manualValues: Record<string, string>; notes?: string }) => portalApi.editApplication(appId, data), onSuccess: () => { setEditing(false); void queryClient.invalidateQueries({ queryKey: ['customer', 'application', appId] }); } });
  const record = app.data;
  const plan = options.data?.find(item => item.planId === record?.planId);
  const conditionDetails = plan?.conditions?.find(item => item.id === record?.conditionId);
  const minimumAmount = conditionDetails?.minimumAmount ?? plan?.minimumAmount;
  const maximumAmount = conditionDetails?.maximumAmount ?? plan?.maximumAmount;
  const durations = conditionDetails?.allowedDurations ?? plan?.allowedDurations ?? [];
  const canEdit = false as boolean;
  const initialContractRetained = record?.initialContractRetained === true;
  const beginEdit = () => { if (!record) return; setAmount(String(record.requestedAmount || '')); setDuration(String(record.requestedDurationMonths || record.durationMonths || '')); setNotes(record.notes || ''); setManualValues(record.manualValues || {}); setEditing(true); setError(''); };
  const submitEdit = (e: FormEvent) => {
    e.preventDefault(); setError('');
    const requestedAmount = digits(amount).replace(/[,\s٬]/g, '');
    if (!plan || (plan.conditions?.length && !conditionDetails)) { setError('شرایط طرح از سرور دریافت نشد؛ ویرایش فعلاً ممکن نیست.'); return; }
    if (!/^\d+$/.test(requestedAmount) || BigInt(requestedAmount) <= 0n || (minimumAmount != null && BigInt(requestedAmount) < BigInt(minimumAmount)) || (maximumAmount != null && BigInt(requestedAmount) > BigInt(maximumAmount))) { setError('مبلغ با بازه مجاز شرط این درخواست سازگار نیست.'); return; }
    if (!durations.includes(Number(digits(duration)))) { setError('مدت بازپرداخت با شرط این درخواست سازگار نیست.'); return; }
    const fieldError = manualFieldError(plan.manualFields, manualValues);
    if (fieldError) { setError(fieldError); return; }
    const allowedManualValues = Object.fromEntries((plan.manualFields || []).map(field => [field.variable, manualValues[field.variable]?.trim() || '']));
    update.mutate({ requestedAmount, durationMonths: Number(digits(duration)), manualValues: allowedManualValues, notes: notes.trim() || undefined }, { onError: e => setError(message(e)) });
  };
  const upload = async (key: string, file?: File) => {
    if (!file) return; setError(''); setBusyDoc(key);
    try { await portalApi.uploadApplicationDocument(appId, key, file); await queryClient.invalidateQueries({ queryKey: ['customer', 'application', appId] }); }
    catch (e) { setError(message(e)); } finally { setBusyDoc(''); }
  };
  if (!Number.isSafeInteger(appId) || appId <= 0) return <div className="cp-alert" role="alert">شماره درخواست معتبر نیست.</div>;
  if (app.isLoading) return <Load rows={3} />;
  if (app.isError || !record) return <Failure error={app.error} retry={() => void app.refetch()} />;
  return <><div className="cp-pagehead"><div><p className="cp-eyebrow"><Link href="/customer" className="cp-link" data-testid="link-back-overview">خانه</Link> / پرونده شماره {number(record.id)}</p><h1 className="cp-title">{record.planName || `درخواست شماره ${number(record.id)}`}</h1><p className="cp-lede">ثبت‌شده در {date(record.createdAt)} · آخرین وضعیت پرونده را در این صفحه دنبال کنید.</p></div><span className="cp-kicker">{stages[record.stage || ''] || record.status}</span></div>
    <div className="cp-grid"><div className="cp-stack"><section className="cp-hero"><p className="cp-eyebrow">وضعیت فعلی</p><h2>{stages[record.stage || ''] || record.status}</h2><p>{record.stage === 'approved_contract_pending_signature'
      ? 'مبلغ مصوب با قرارداد اولیه تفاوت دارد؛ قرارداد جایگزین برای امضای شما آماده است. لطفاً امضای قرارداد جدید را تکمیل کنید.'
      : initialContractRetained
        ? 'مبلغ مصوب با قرارداد اولیه برابر است؛ قرارداد اولیه امضاشده حفظ شده و نیازی به امضای مجدد ندارید.'
        : record.stage === 'customer_documents_upload' || record.stage === 'customer_documents_review'
          ? 'ابتدا مدارک موردنیاز خود را بارگذاری و بررسی آن‌ها را پیگیری کنید؛ پس از آن ثبت ضامن انجام می‌شود.'
          : record.stage === 'guarantor_registration'
            ? 'مدارک مشتری بررسی شده‌اند؛ گام بعدی ثبت اطلاعات ضامن است.'
            : 'درخواست شما ثبت شده است. تکمیل اطلاعات و ارسال قرارداد توسط کارشناس فروش انجام می‌شود؛ برای ادامه مراحل با کارشناس خود در ارتباط باشید.'}</p></section>
      <ExpertHandoff expert={record.salesExpert} />
      <section className="cp-card"><div className="cp-pagehead" style={{ marginBottom: 7 }}><div><h2>جزئیات درخواست</h2><p>اطلاعات ثبت‌شده در پرونده شما</p></div>{canEdit && !editing && <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={beginEdit} data-testid="button-edit-application">ویرایش درخواست</button>}</div>
      {editing && canEdit ? <form className="cp-form" onSubmit={submitEdit}>
        {options.isLoading ? <Load rows={1} /> : options.isError ? <Failure error={options.error} retry={() => void options.refetch()} /> : !plan || (plan.conditions?.length && !conditionDetails) ? <div className="cp-alert" role="alert">شرایط این طرح دیگر در دسترس نیست؛ تا دریافت اطلاعات معتبر، ویرایش ممکن نیست.</div> : <>
        <div className="cp-alert cp-alert-info" role="status" data-testid="status-edit-condition-limits">شرط: {conditionDetails?.name || plan.conditionName || 'شرایط طرح'} · مبلغ مجاز: {number(minimumAmount)} تا {number(maximumAmount)} تومان · مدت‌های مجاز: {durations.length ? durations.map(months => `${number(months)} ماه`).join('، ') : 'اعلام نشده'}</div>
        <div className="cp-form-grid"><label className="cp-field">مبلغ درخواستی (تومان)<input required inputMode="numeric" dir="ltr" value={amount} onChange={e => setAmount(e.target.value)} data-testid="input-edit-amount" /></label><label className="cp-field">مدت بازپرداخت (ماه)<select required value={duration} onChange={e => setDuration(e.target.value)} data-testid="select-edit-duration"><option value="">انتخاب مدت</option>{durations.map(months => <option value={months} key={months}>{number(months)} ماه</option>)}</select></label></div>
        <ManualFields fields={plan.manualFields} values={manualValues} onChange={setManualValues} prefix="edit" />
        <label className="cp-field">توضیحات<textarea value={notes} onChange={e => setNotes(e.target.value)} data-testid="input-edit-notes" /></label>
        </>}
        {error && <div role="alert" className="cp-alert">{error}</div>}
        <div className="cp-actions"><button className="cp-btn cp-btn-primary" disabled={update.isPending || !plan || (plan.conditions?.length ? !conditionDetails : false)} data-testid="button-save-application">{update.isPending ? 'در حال ذخیره…' : 'ذخیره تغییرات'}</button><button type="button" className="cp-btn cp-btn-outline" onClick={() => setEditing(false)} data-testid="button-cancel-edit">انصراف</button></div>
      </form>
        : <div className="cp-list"><div className="cp-list-item"><span>مبلغ درخواستی</span><strong>{number(record.requestedAmount)} تومان</strong></div>{record.approvedAmount != null && <div className="cp-list-item"><span>مبلغ مصوب</span><strong>{number(record.approvedAmount)} تومان</strong></div>}<div className="cp-list-item"><span>مدت بازپرداخت</span><strong>{number(record.requestedDurationMonths || record.durationMonths)} ماه</strong></div><div className="cp-list-item"><span>وضعیت</span><strong>{stages[record.stage || ''] || record.status}</strong></div>{record.notes && <div className="cp-list-item"><span>توضیحات</span><strong>{record.notes}</strong></div>}</div>}
      {!canEdit && <p className="cp-hint" style={{ marginTop: 14 }}>درخواست شما برای بررسی کارشناسان ثبت نهایی شده است و این صفحه فقط وضعیت و روند پرونده را نشان می‌دهد.</p>}</section>
      <section className="cp-card"><h2>مدارک موردنیاز پرونده</h2><p>فقط مدارکی که برای این پرونده درخواست شده‌اند در این قسمت نمایش داده می‌شوند.</p>
        {record.requiredDocuments?.length ? <div className="cp-list">{record.requiredDocuments.map(slot => { const uploaded = record.documents?.find(d => d.requirementKey === slot.key); return <div className="cp-list-item" key={slot.key}><span><strong>{slot.label}</strong><small>{uploaded?.status === 'approved' ? 'تأیید شده' : uploaded?.status === 'rejected' || uploaded?.status === 'incomplete' ? `نیاز به اصلاح: ${uploaded.reviewReason || 'مدرک را دوباره ارسال کنید.'}` : uploaded ? 'ارسال شده، در انتظار بررسی' : 'هنوز ارسال نشده'}</small></span></div>; })}</div> : <Empty title="مدرک پرونده‌ای درخواست نشده است" text="در صورت نیاز به مدرک، فهرست آن از سوی سامانه در همین بخش نمایش داده می‌شود." />}
        {busyDoc && <p role="status">در حال بارگذاری مدرک…</p>}{error && !editing && <div role="alert" className="cp-alert">{error}</div>}
      </section>
    </div><aside className="cp-stack"><section className="cp-card"><FileText size={23} color="#bc9252" /><h3 style={{ marginTop: 12 }}>مدارک هویتی</h3><p>مدارک هویتی شما برای بررسی پرونده در حساب‌تان نگهداری می‌شوند.</p>
      {docs.isLoading ? <Load rows={1} /> : docs.isError ? <Failure error={docs.error} retry={() => void docs.refetch()} /> : <><div className="cp-list">{Object.entries(identityLabels).map(([key, label]) => { const item = docs.data?.find(d => d.documentType === key); return <div className="cp-list-item" key={key}><span><strong>{label}</strong><small>{item?.status === 'approved' ? 'تأیید شده' : item?.status === 'rejected' ? 'نیاز به اصلاح' : item ? 'ارسال شده' : 'ارسال نشده'}</small></span></div>; })}</div></>}
    </section><section className="cp-card"><h3>پیگیری پرونده</h3><p>برای دیدن آخرین وضعیت بررسی یا مدارک، اطلاعات پرونده را به‌روزرسانی کنید.</p><button className="cp-btn cp-btn-outline" onClick={() => { void app.refetch(); void docs.refetch(); }} type="button" data-testid="button-refresh-application">به‌روزرسانی <RefreshCw size={14} /></button></section></aside></div></>;
}

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
      navigate('/customer/login');
    };
    window.addEventListener('cp-session-expired', expired);
    return () => window.removeEventListener('cp-session-expired', expired);
  }, [navigate, queryClient]);
  if (profile.isLoading) return <div className="cp"><div className="cp-container"><Load rows={3} /></div></div>;
  if (profile.error instanceof PortalApiError && profile.error.status === 401) return <Redirect to="/customer/login" />;
  if (profile.isError || !profile.data) return <div className="cp"><main className="cp-container"><Failure error={profile.error} retry={() => void profile.refetch()} /><Link href="/customer/login" className="cp-link" data-testid="link-customer-login-error">رفتن به صفحه ورود</Link></main></div>;
  if (!profile.data.identityReady) return location === '/customer/identity' ? <IdentityPage /> : <Redirect to="/customer/identity" />;
  if (location === '/customer/identity') return <Redirect to="/customer" />;
  return <CustomerShell profile={profile.data}><Switch>
    <Route path="/customer"><Overview profile={profile.data} /></Route>
    <Route path="/customer/advice" component={AdviceHub} />
    <Route path="/customer/advice/ai" component={AiAdvice} />
    <Route path="/customer/advice/finder" component={PlanFinder} />
    <Route path="/customer/advice/chat" component={CustomerChat} />
    <Route path="/customer/apply"><ApplyGate profile={profile.data} /></Route>
    <Route path="/customer/wallet"><WalletPanel /></Route>
    <Route path="/customer/profile"><ProfilePage profile={profile.data} /></Route>
    <Route path="/customer/applications" component={ActiveRequestsPage} />
    <Route path="/customer/applications/:id" component={ApplicationDetail} />
    <Route><Empty title="این صفحه پیدا نشد" text="به خانه پرتال برگردید." action={<Link href="/customer" className="cp-btn cp-btn-primary" data-testid="link-customer-not-found">بازگشت به خانه</Link>} /></Route>
  </Switch></CustomerShell>;
}

export default function CustomerPortal() {
  return <Switch><Route path="/customer/login" component={CustomerLogin} /><Route component={Gate} /></Switch>;
}
