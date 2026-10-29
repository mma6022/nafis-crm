import { ArrowUp, AlertCircle, ArrowRight, Check, ChevronLeft, Copy, FileText, Flag, Gauge, History, Layers, Lock, MessageSquarePlus, Pencil, Phone, PhoneCall, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, Wallet, X } from 'lucide-react';
import { SiteAnswersBlock } from '@/features/site-answers/SiteAnswersBlock';
import { announceCallSaved, cqTelClick } from '@/features/call-queue/api';
import { CustomerIntroLog } from '@/features/expert-intro-sms/CustomerIntroLog';
import { CustomerAnnotations } from '@/features/lead-annotator/CustomerAnnotations';
import { RestrictedCase } from '@/features/lead-annotator/RestrictedCase';
import { elApi, useLockdownMe } from '@/features/expert-lockdown/api';
import { LockdownNotice } from '@/features/expert-lockdown/LockdownNotice';
import { useLeadAnnotatorMe } from '@/features/lead-annotator/api';
import { RegistrarCard } from '@/features/registrar-view/RegistrarCard';
import { useRegistrarMe } from '@/features/registrar-view/api';
import { LeadIntakePanel } from '@/features/lead-intake/LeadIntakePanel';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, getGetCustomerWalletPaymentQueryKey, getListCustomerActivityQueryKey, getListCustomerTagsQueryKey, getListCustomersQueryKey, getListConsultationsQueryKey, getListSalespersonsQueryKey, getListCustomerCreditChecksQueryKey, getListLoanApplicationsQueryKey, getListCallsQueryKey, getListRemindersQueryKey, useDeleteCustomer, useGetAuthSession, useGetCustomer, useGetCustomerWalletPayment, useListCustomerActivity, useListCustomerTags, useListSalespersons, useListCustomerCreditChecks, useInitiateCustomerCreditCheck, useValidateCustomerCreditCheck, useRenewCustomerCreditCheckOtp, useRefreshCustomerCreditCheckStatus, useUpdateCustomer, useCreateConsultation, useCreateCall, useListLoanApplications, type CallInput, type CustomerUpdate, type CustomerUpdateStatus, type ConsultationInput, type LoanApplication } from '@workspace/api-client-react';
import { ErrorState, formatDateTime } from '@/components/CrmShell';
import { formatPhoneForDisplay } from '@/lib/phone';
import { CallForm, CreateConsultationForm } from '@/components/Forms';
import { CustomerConsultationStatus } from '@/components/CustomerConsultationStatus';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { WalletPaymentResult } from '@/components/WalletPaymentResult';
import { PaymentReconciliation } from '@/components/PaymentReconciliation';
import { useVoip } from '@/components/voip/VoipProvider';
import { useVoipHistory } from '@/components/voip/voip-api';
import { removeCompletedAfterCallFromQueue } from '@/components/voip/after-call-cache';
import { WalletShareHistory } from '@/components/WalletShareHistory';
import { CustomerPlanWallets } from '@/components/PlanWallets';
import { requestWalletShare } from '@/lib/wallet-share';
import { getListCustomerWalletShareLinksQueryKey } from '@workspace/api-client-react';
import { NATIONAL_CODE_CLEAR_HINT, nationalCodePatch, normalizeDigits, serverFieldErrors, validateIranianMobile, validateIranianNationalCode, validateIranianPostalCode, validateJalaliBirthDate, validateOtp } from '@/lib/customer-field-validation';
import { CustomerTagEditor } from '@/components/CustomerTagEditor';
import { RepeatRequestReview, RepeatRequestTag } from '@/components/RepeatRequestReview';
import { clearLoanDraft, loanWizardHref, readLoanDraft, type LoanDraft } from '@/lib/loan-draft';
import { DRAFTS_KEY, canUseDrafts, draftHref, draftWait, draftsApi, fa as faDraft, tehranTime } from '@/lib/request-drafts';
import { BUSINESS_STATUS_LABELS, WIZARD_DISPLAY_STEPS, WIZARD_TOTAL_STEPS, loanBusinessStatus, loanStageLabel } from '@/lib/loan-labels';
import { ConfirmDialog, initialsOf, jalaliDate, PriorityLabel, relativeTime, Sheet, STATUS_LABEL, StatusPill } from './customers-ui';
import './customers.css';
import { useCallLauncher, CallLaunchStatus } from '@/features/team-sales/useCallLauncher';
import { KazemiSourceChip, kazemiSourceOf } from '@/features/kazemi-source/KazemiSourceChip';
import { DeadlineCountdown, PreferredTimeNote, SiteLeadChips, SiteLeadHistory, hideTagForSiteLead } from '@/features/site-leads/SiteLead';
import { consultProfileKey, firstCallEditInfoKey, firstCallOf, isCloserOwn, showsUpgradeButton, useFirstCallEditInfo, usesSimpleForm, type FirstCallEditResult, type PromoteResult, type QualifyResult } from '@/features/team-sales/api';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { CallNumber, CALLED_LABEL, calledThenForm } from '@/features/call-number/CallNumber';
import { FirstCallSummaryCard, NoPlanBox, SuggestedPlansBox } from '@/features/team-sales/FirstCallCard';
import { ConsultProfileCard } from "@/features/team-sales/ConsultProfileCard";
import { TsToast, UpgradeCard, UpgradeDialog, UpgradedCard } from '@/features/team-sales/UpgradeToP1';
import { DataAccuracyCard } from '@/features/team-commission/DataAccuracyCard';
import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { VoiceNoteButton } from '@/features/voice-notes/VoiceNoteButton';
import { BaleChatSection } from '@/features/bale/BaleChatSection';
import { BaleLinkBadge } from '@/features/bale/BaleLinkBadge';
import { baleChatVisible } from '@/features/bale/api';

const faNum = (n: number) => n.toLocaleString('fa-IR');
const faId = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false });
const faDigits = (value: string) => value.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const toman = (value: string | null | undefined) => { try { return BigInt(value || '0').toLocaleString('fa-IR'); } catch { return value || '—'; } };
const LOAN_STATUS: Record<string, [string, string]> = {
  requested: ['ثبت شده', 'open'], reviewing: ['در حال بررسی', 'open'], approved: ['تأیید شده', 'approved'], rejected: ['رد شده', 'rejected'],
};
const VERIFY_ITEMS: Array<[ 'shahkarLite' | 'personInfo' | 'postalCodeInfo' | 'sana', string ]> = [
  ['shahkarLite', 'تطبیق مالکیت موبایل (شاهکار)'], ['personInfo', 'اطلاعات هویتی ثبت احوال'], ['postalCodeInfo', 'نشانی و کد پستی'], ['sana', 'عضویت سامانه ثنا'],
];
function inquiryErrorMessage(error: unknown, fallback: string) {
  const typed = error as { data?: { error?: unknown; message?: unknown }; response?: { data?: { error?: unknown; message?: unknown } }; message?: unknown } | null;
  const payload = typed?.data ?? typed?.response?.data;
  if (typeof payload?.message === 'string' && /[\u0600-\u06FF]/.test(payload.message)) return payload.message;
  const code = typeof payload?.error === 'string' ? payload.error : '';
  const messages: Record<string, string> = {
    provider_unavailable: 'سرویس اعتبارسنجی در دسترس نیست. کمی بعد دوباره تلاش کنید.',
    provider_timeout: 'سرویس اعتبارسنجی در زمان مقرر پاسخ نداد.',
    provider_auth_failed: 'اتصال به سرویس اعتبارسنجی ناموفق بود.',
    invalid_otp: 'کد یک‌بارمصرف معتبر نیست.',
    otp_invalid: 'کد یک‌بارمصرف معتبر نیست.',
    national_code_invalid: 'کد ملی واردشده معتبر نیست.',
  };
  if (code) return messages[code] ?? fallback;
  if (typeof typed?.message === 'string' && /[\u0600-\u06FF]/.test(typed.message)) return typed.message;
  return fallback;
}

/* lead_annotator (bug 2026-10-27 23:44): a customer outside the user's scope → GET /customers/:id is 404 (and used to retry ~15 s on
   «در حال بارگذاری پرونده…»). For a lead_annotator we probe once without retry and fall back to the restricted case page, which uses
   only /api/lead-annotator/customers/:id/case + notes + urgent. Everyone else gets the full page exactly as before. */
export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const la = useLeadAnnotatorMe();
  const laOn = la.data?.enabled === true;
  // registrar_view (assistants53): a customer I registered but no longer own opens read-only (server 403s every write).
  const rv = useRegistrarMe();
  const rvOn = rv.data?.enabled === true;
  // expert_lockdown (assistants54): cached /expert-lockdown/me from the shell (never fetched here); a closed customer → 403 → a plain notice, no retries.
  const elOn = useLockdownMe(false).data?.locked === true;
  const probe = useGetCustomer(id, { query: { queryKey: getGetCustomerQueryKey(id), enabled: Number.isFinite(id) && (laOn || rvOn || elOn), retry: false } });
  const loading = <div className="csx" dir="rtl" aria-busy="true" data-testid="customer-detail-loading"><span className="csx-sr" role="status">در حال بارگذاری پرونده مشتری…</span></div>;
  if (la.isLoading || rv.isLoading) return loading;
  if (elOn) {
    if (probe.isLoading) return loading;
    if (probe.isError || !probe.data) return <LockdownNotice customer />;
    return <CustomerDetailFull />;
  }
  if (laOn || rvOn) {
    if (probe.isLoading) return loading;
    if (probe.isError || !probe.data) return laOn ? <RestrictedCase id={id} registrar={rvOn} /> : <RegistrarOnlyCase id={id} />;
  }
  return <CustomerDetailFull />;
}

function RegistrarOnlyCase({ id }: { id: number }) {
  return <section className="la" dir="rtl" data-testid="rv-case"><div className="csx-crumb"><Link href="/customers">→ مشتریان</Link></div>
    <RegistrarCard id={id} enabled /></section>;
}

function CustomerDetailFull() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const id = Number(params.id);
  const customerQuery = useGetCustomer(id, { query: { queryKey: getGetCustomerQueryKey(id), enabled: Number.isFinite(id) } });
  const activityQuery = useListCustomerActivity(id, { query: { queryKey: getListCustomerActivityQueryKey(id), enabled: Number.isFinite(id) } });
  const salespersons = useListSalespersons({ query: { queryKey: getListSalespersonsQueryKey(), staleTime: 60_000 } });
  const update = useUpdateCustomer();
  const remove = useDeleteCustomer();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canCreditCheck = session.data?.user.role === 'admin' || session.data?.user.permissions?.includes('customers.credit_check') === true;
  const creditChecks = useListCustomerCreditChecks(id, { query: { queryKey: getListCustomerCreditChecksQueryKey(id), enabled: Number.isFinite(id) && canCreditCheck === true } });
  const initiateCredit = useInitiateCustomerCreditCheck();
  const validateCredit = useValidateCustomerCreditCheck();
  const renewCredit = useRenewCustomerCreditCheckOtp();
  const refreshCredit = useRefreshCustomerCreditCheckStatus();
  const customer = customerQuery.data;
  const tagCatalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey() } });
  const [reviewingRepeat, setReviewingRepeat] = useState(false);
  const walletQuery = useQuery<{ cash: { balanceToman: string; ledger: Array<{ amountToman: string; kind: string; createdAt: string }> }; credit: { balanceToman: string; ledger: Array<{ amountToman: string; kind: string; createdAt: string }> } }>({
    queryKey: ['customer-wallet', id],
    enabled: Number.isSafeInteger(id) && ['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || ''),
    queryFn: async () => {
      const response = await fetch(`/api/customers/${id}/wallet`, { credentials: 'include' });
      if (!response.ok) throw new Error('دریافت کیف پول انجام نشد');
      return response.json();
    },
    staleTime: 15_000,
  });
  const [returnedPaymentId, setReturnedPaymentId] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('paymentIntent');
    if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  });
  const returnedPayment = useGetCustomerWalletPayment(id, returnedPaymentId ?? 0, {
    query: {
      queryKey: getGetCustomerWalletPaymentQueryKey(id, returnedPaymentId ?? 0),
      enabled: returnedPaymentId !== null && Number.isSafeInteger(id) && ['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || ''),
      retry: false,
      staleTime: 0,
      refetchOnWindowFocus: true,
    },
  });
  useEffect(() => {
    if (returnedPayment.data?.status === 'credited') {
      queryClient.invalidateQueries({ queryKey: ['customer-wallet', id] });
    }
  }, [returnedPayment.data?.status, id, queryClient]);
  const closePaymentResult = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('paymentIntent');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    setReturnedPaymentId(null);
  };
  const [cashAmount, setCashAmount] = useState('');
  const [walletError, setWalletError] = useState('');
  const [paymentPending, setPaymentPending] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [shareAmount, setShareAmount] = useState('');
  const [sharePending, setSharePending] = useState(false);
  const [shareSmsSent, setShareSmsSent] = useState(false);
  useEffect(() => {
    setShareLink(''); setShareAmount(''); setShareSmsSent(false); setCashAmount(''); setWalletError('');
  }, [id]);
  const startCashPayment = async () => {
    setWalletError('');
    if (!/^[1-9]\d*$/.test(cashAmount)) { setWalletError('مبلغ معتبر به تومان وارد کنید.'); return; }
    setPaymentPending(true);
    try {
      const response = await fetch(`/api/customers/${id}/wallet/cash-payment`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountToman: cashAmount }),
      });
      const data = await response.json();
      if (!response.ok || !data.paymentUrl) throw new Error(data.error || 'درخواست پرداخت ثبت نشد');
      window.location.assign(data.paymentUrl);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : 'خطا در شروع پرداخت');
      setPaymentPending(false);
    }
  };
  const createWalletShareLink = async () => {
    setWalletError('');
    if (!/^[1-9]\d*$/.test(cashAmount)) { setWalletError('مبلغ معتبر به تومان وارد کنید.'); return; }
    setSharePending(true);
    try {
      const body = await requestWalletShare(id, { amountToman: cashAmount });
      if (!body) return;
      setShareSmsSent(false);
      setShareLink(body.url);
      setShareAmount(String(body.amountToman || cashAmount));
      let token = '';
      try {
        const url = new URL(body.url, window.location.origin);
        token = url.searchParams.get('token') || '';
      } catch {
        throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      }
      if (!token) throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      const smsResponse = await fetch(`/api/customers/${id}/wallet/share-links/${encodeURIComponent(token)}/send-sms`, {
        method: 'POST',
        credentials: 'include',
      });
      const smsBody = await smsResponse.json().catch(() => ({}));
      if ((!smsResponse.ok && smsBody.error !== 'already_sent') || (smsResponse.ok && smsBody.status !== 'sent' && smsBody.status !== 'already_sent')) {
        throw new Error('لینک شارژ ساخته شد، اما پیامک ارسال نشد یا وضعیت ارسال نامشخص است؛ لینک را کپی و ارسال کنید.');
      }
      setShareSmsSent(true);
    } catch (e) { setWalletError(e instanceof Error ? e.message : 'ساخت لینک شارژ انجام نشد'); }
    finally {
      setSharePending(false);
      void queryClient.invalidateQueries({ queryKey: getListCustomerWalletShareLinksQueryKey(id) });
    }
  };
  const [editing, setEditing] = useState(false);
  const [consultationFormOpen, setConsultationFormOpen] = useState(false);
  const createConsult = useCreateConsultation();
  const [form, setForm] = useState<{ name: string; phone: string; nationalCode: string; postalCode: string; birthDateJalali: string; description: string; priority: string; status: CustomerUpdateStatus }>({ name: '', phone: '', nationalCode: '', postalCode: '', birthDateJalali: '', description: '', priority: '', status: 'in_progress' });
  const [salespersonSelection, setSalespersonSelection] = useState('');
  const [salespersonError, setSalespersonError] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [otp, setOtp] = useState('');
  const [creditError, setCreditError] = useState('');
  const [otpError, setOtpError] = useState('');
  const [nationalCodeError, setNationalCodeError] = useState('');
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [ncTouched, setNcTouched] = useState(false);
  useEffect(() => {
    if (customer) {
      setForm({ name: customer.name, phone: customer.phone, nationalCode: customer.nationalCode ?? '', postalCode: customer.postalCode ?? '', birthDateJalali: customer.birthDateJalali ?? '', description: customer.description ?? '', priority: customer.priority ? String(customer.priority) : '', status: customer.status });
      setSalespersonSelection(customer.salespersonId ? String(customer.salespersonId) : '');
      setNcTouched(false);
      setNationalCode(current => current || customer.nationalCode || '');
    }
  }, [customer]);
  const latestCredit = creditChecks.data?.[0];
  const refreshBoth = () => {
    creditChecks.refetch();
    customerQuery.refetch();
  };

  const { dial, canCall, connection, call } = useVoip();
  const hasCallsView = session.data?.user.role === 'admin' || session.data?.user.permissions?.includes('calls.view') === true;
  const [historyPage, setHistoryPage] = useState(1);
  const historyQuery = useVoipHistory(historyPage, id, hasCallsView);
  const canDialSystem = connection === 'registered' && canCall && !call;

  useEffect(() => {
    if (!latestCredit || (latestCredit.status !== 'processing' && latestCredit.status !== 'awaiting_otp')) return;
    const checkStatus = () => refreshCredit.mutate({ id, checkId: latestCredit.id }, {
      onSuccess: refreshBoth,
      onError: (error) => setCreditError(inquiryErrorMessage(error, 'به‌روزرسانی وضعیت استعلام اعتبارسنجی انجام نشد.')),
    });
    if (latestCredit.status === 'awaiting_otp') checkStatus();
    const timer = window.setInterval(checkStatus, latestCredit.status === 'processing' ? 10000 : 30000);
    return () => window.clearInterval(timer);
  }, [latestCredit?.id, latestCredit?.status]);

  // ---- redesign-only UI state (no data logic) ----
  const role = session.data?.user.role ?? '';
  const perms = session.data?.user.permissions ?? [];
  const isAdmin = role === 'admin';
  const can = (permission: string) => isAdmin || perms.includes(permission);
  const canUpdate = can('customers.update');
  const canCallsCreate = can('calls.create');
  const canConsult = can('consultations.create');
  const canLoansView = can('loan_applications.view');
  const canNewLoan = can('loan_applications.create');
  const walletRole = ['admin', 'salesperson', 'registrar'].includes(role);
  const userId = session.data?.user.id;
  const baleOn = baleChatVisible(session.data?.user as { id?: number; role?: string; salespersonId?: number | null } | undefined);
  const loansQuery = useListLoanApplications({ customerId: id, limit: 20 }, { query: { queryKey: getListLoanApplicationsQueryKey({ customerId: id, limit: 20 }), enabled: Number.isSafeInteger(id) && canLoansView } });
  const loans: LoanApplication[] = loansQuery.data && 'items' in loansQuery.data ? loansQuery.data.items : [];
  const loansTotal = loansQuery.data && 'total' in loansQuery.data ? loansQuery.data.total : loans.length;
  // Server-side «در انتظار ثبت» draft for this customer (falls back to the local browser draft below).
  const draftsOn = canUseDrafts(session.data?.user) && Number.isSafeInteger(id);
  const srvDraftQuery = useQuery({ queryKey: [...DRAFTS_KEY, 'by-customer', id], queryFn: () => draftsApi.byCustomer(id), enabled: draftsOn, staleTime: 15_000, retry: false });
  const [draft, setDraft] = useState<LoanDraft | null>(null);
  useEffect(() => {
    const sync = () => setDraft(readLoanDraft(userId, id));
    sync();
    window.addEventListener('nafis-loan-draft', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('nafis-loan-draft', sync); window.removeEventListener('storage', sync); };
  }, [userId, id]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 2600); return () => window.clearTimeout(t); }, [toast]);
  const [quickError, setQuickError] = useState('');
  const [callFormOpen, setCallFormOpen] = useState(false);
  const createCall = useCreateCall();
  const [activeSec, setActiveSec] = useState('info');
  // ---- team sales (qualifier Kazemi): simple call form + upgrade to P1. Priority is decided by the server. ----
  const [simpleFormOpen, setSimpleFormOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [handoff, setHandoff] = useState<PromoteResult | null>(null);
  // «ثبت تماس» waits for the team-sales settings instead of falling back to the legacy form (see useCallLauncher).
  const callLauncher = useCallLauncher(session.data?.user, Boolean(session.data?.user),
    (_c, kind) => (kind === 'simple' && !handoff ? setSimpleFormOpen(true) : setCallFormOpen(true)));
  const tsConfig = { data: callLauncher.config };
  // crm-first-call-edit: «ویرایش» on «خلاصه‌ی تماس اول» / «اطلاعات مشاوره» (the server decides who may edit / send).
  const [fcEditOpen, setFcEditOpen] = useState(false);
  const fcEditInfo = useFirstCallEditInfo(id, tsConfig.data?.enabled === true);
  const [tsToast, setTsToast] = useState('');
  // REMINDER-68: «تاریخچه و یادداشت‌ها» links (today card / file card / incoming wizard) open /customers/:id#sec-calls → scroll there once loaded.
  const callsReady = customerQuery.isSuccess && !activityQuery.isLoading;
  useEffect(() => { if (callsReady && window.location.hash === '#sec-calls') window.setTimeout(() => document.getElementById('sec-calls')?.scrollIntoView({ block: 'start' }), 50); }, [callsReady, id]);
  useEffect(() => { setHandoff(null); setSimpleFormOpen(false); setUpgradeOpen(false); }, [id]);
  // crm-call-queue: «ثبت تماس» on a «صف تماس من» card links here with ?cq=call → open the same call form once.
  const cqCallDone = useRef(false);
  useEffect(() => {
    if (cqCallDone.current || !customer || !canCallsCreate) return;
    if (new URLSearchParams(window.location.search).get('cq') !== 'call') return;
    cqCallDone.current = true;
    window.history.replaceState(window.history.state, '', window.location.pathname);
    callLauncher.launch(customer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id, canCallsCreate]);
  // incoming2-59 PM rule: the qualifier's customer whose first-call form is incomplete → opening the file reopens the form
  // (closing only via «بستن بدون ثبت تماس؟», temporary: next open reopens it). Server decides (read-only, inferred from first-call data).
  const [fcReopen, setFcReopen] = useState(false);
  const fcReopenDone = useRef<number | null>(null);
  useEffect(() => {
    if (!customer || !canCallsCreate || fcReopenDone.current === customer.id || callLauncher.choose(customer) !== 'simple') return;
    fcReopenDone.current = customer.id;
    void elApi.firstCallIncomplete(customer.id).then((r) => { if (r.incomplete) { setFcReopen(true); setSimpleFormOpen(true); } }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id, canCallsCreate, callLauncher.cfgState]);
  useEffect(() => {
    if (!customer) return;
    const ids = ['info', 'loans', 'calls', 'bale', 'wallet'];
    const nodes = ids.map((key) => document.getElementById(`sec-${key}`)).filter(Boolean) as HTMLElement[];
    if (!nodes.length || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveSec(visible.target.id.replace('sec-', ''));
    }, { rootMargin: '-80px 0px -55% 0px' });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [customer?.id, canLoansView, walletRole, baleOn]);
  if (customerQuery.isLoading) return <div className="csx" dir="rtl" aria-busy="true" data-testid="customer-detail-loading">
    <span className="csx-sr" role="status">در حال بارگذاری پرونده مشتری…</span>
    <div className="csx-crumb"><Link href="/customers" data-testid="link-back-customers"><ArrowRight size={16} /> مشتریان</Link></div>
    {[0, 1, 2].map((key) => <div key={key} className="csx-sec" aria-hidden="true"><span className="csx-sk" style={{ width: '50%', height: 28 }} /><span className="csx-sk" style={{ width: '80%', height: 18 }} /><span className="csx-sk" style={{ width: '100%', height: 52 }} /></div>)}
  </div>;
  if (customerQuery.isError || !customer) return <div className="csx" dir="rtl">
    <div className="csx-crumb"><Link href="/customers" data-testid="link-back-customers"><ArrowRight size={16} /> مشتریان</Link></div>
    <div className="csx-empty err" role="alert" data-testid="customer-detail-error">
      <span className="big"><AlertCircle size={30} /></span>
      <h2>پرونده مشتری باز نشد</h2>
      <p>ممکن است این مشتری حذف یا با پرونده دیگری ادغام شده باشد، یا اتصال قطع باشد.</p>
      <button type="button" className="csx-primary" onClick={() => customerQuery.refetch()} data-testid="button-retry-customer"><RefreshCw size={18} /> تلاش دوباره</button>
      <Link href="/customers" className="csx-link">بازگشت به مشتریان</Link>
    </div>
  </div>;
  const save = (event: FormEvent) => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'نام مشتری را وارد کنید.';
    if (!validateIranianMobile(form.phone)) errors.phone = 'شماره همراه باید با ۰۹ شروع شود و ۱۱ رقم باشد.';
    // crm-nid-optional (PM 16:03): کد ملی اختیاری است؛ خالیِ دست‌نخورده کد ثبت‌شده را پاک نمی‌کند.
    const nc = nationalCodePatch(form.nationalCode, customer?.nationalCode, ncTouched);
    if (nc.error) errors.nationalCode = nc.error;
    if (form.postalCode.trim() && !validateIranianPostalCode(form.postalCode)) errors.postalCode = 'کد پستی باید ۱۰ رقم باشد.';
    if (form.birthDateJalali.trim() && !validateJalaliBirthDate(form.birthDateJalali)) errors.birthDateJalali = 'تاریخ تولد شمسی معتبر و در گذشته وارد کنید.';
    setProfileErrors(errors);
    if (Object.keys(errors).length) {
      const first = ['name', 'phone', 'nationalCode', 'postalCode', 'birthDateJalali'].find((key) => errors[key]);
      const testIds: Record<string, string> = { name: 'input-detail-name', phone: 'input-detail-phone', nationalCode: 'input-detail-national-code', postalCode: 'input-detail-postal-code', birthDateJalali: 'input-detail-birth-date' };
      if (first) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="${testIds[first]}"]`)?.focus());
      return;
    }
    const data: CustomerUpdate & { clearNationalCode?: true } = { name: form.name.trim(), phone: normalizeDigits(form.phone.trim()), ...nc.patch, postalCode: form.postalCode.trim() ? normalizeDigits(form.postalCode.trim()) : null, birthDateJalali: form.birthDateJalali.trim() || null, description: form.description, priority: form.priority ? Number(form.priority) : null, status: form.status };
    update.mutate({ id, data }, {
      onSuccess: () => { setEditing(false); setNcTouched(false); setProfileErrors({}); customerQuery.refetch(); setToast('تغییرات پرونده ذخیره شد.'); },
      onError: (error) => {
        const mapped = serverFieldErrors(error);
        setProfileErrors(current => ({ ...current, ...(Object.keys(mapped).length ? mapped : { _form: inquiryErrorMessage(error, 'ذخیره اطلاعات انجام نشد. دوباره تلاش کنید.') }) }));
      },
    });
  };
  const reassignSalesperson = (event: FormEvent) => {
    event.preventDefault();
    setSalespersonError('');
    if (salespersonSelection === '') {
      update.mutate({ id, data: { salespersonId: null } }, { onSuccess: () => {
        void customerQuery.refetch();
        void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      }, onError: () => setSalespersonError('تغییر کارشناس فروش انجام نشد. دوباره تلاش کنید.') });
      return;
    }
    const selectedId = Number(salespersonSelection);
    const selectedPerson = (salespersons.data ?? []).find((person) => person.id === selectedId);
    if (!Number.isSafeInteger(selectedId) || selectedId <= 0 || !selectedPerson) {
      setSalespersonError('یک کارشناس معتبر از فهرست انتخاب کنید.');
      return;
    }
    update.mutate({ id, data: { salespersonId: selectedId } }, { onSuccess: () => {
      void customerQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    }, onError: () => setSalespersonError('تغییر کارشناس فروش انجام نشد. دوباره تلاش کنید.') });
  };

  const deleteCustomer = () => {
    remove.mutate({ id }, { onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      setConfirmDelete(false);
      setLocation('/customers');
    } });
  };
  // urgent v1.1: «فوری» is set / cleared only through LeadIntakePanel (reason required, clear admin-only).
  const quickUpdate = (data: { status?: CustomerUpdateStatus; priority?: number | null }) => {
    setQuickError('');
    update.mutate({ id, data }, {
      onSuccess: () => { void customerQuery.refetch(); void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() }); setToast('وضعیت پرونده به‌روز شد.'); },
      onError: (error) => setQuickError(inquiryErrorMessage(error, 'تغییر وضعیت ذخیره نشد. دوباره تلاش کنید.')),
    });
  };
  const refreshAfterAccuracy = () => {
    void queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListCustomerActivityQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: ['team-data-accuracy', id] });
  };
  const handleSaveCall = async (data: CallInput) => {
    try {
      const saved = await createCall.mutateAsync({ data });
      setCallFormOpen(false);
      await removeCompletedAfterCallFromQueue(queryClient, { callLogId: saved.id });
      void queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListCustomerActivityQueryKey(id) });
      void customerQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ['call-queue'] });
      announceCallSaved(saved.id, id);
      // crm-call-queue: when the call-result flow is on, the shared after-save summary replaces this toast.
      if (!(saved as { callQueue?: { resultOn?: boolean } }).callQueue?.resultOn) setToast('تماس ثبت شد.');
    } catch {
      // Mutation error state is rendered inside the call form.
    }
  };
  /** «اعتبارسنجی سریع»: the call is saved first (nothing lost), then the existing inquiry step of the request wizard opens. */
  const handleSaveCallAndCredit = async (data: CallInput) => {
    const saved = await createCall.mutateAsync({ data });
    setCallFormOpen(false);
    await removeCompletedAfterCallFromQueue(queryClient, { callLogId: saved.id });
    void queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListCustomerActivityQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: ['call-queue'] });
    announceCallSaved(saved.id, id);
    setLocation(loanWizardHref(id));
  };
  const isQualifier = tsConfig.data?.enabled === true && session.data?.user.salespersonId != null && session.data.user.salespersonId === tsConfig.data.qualifierSalespersonId;
  const ownsCustomer = (isQualifier && customer.salespersonId === tsConfig.data?.qualifierSalespersonId) || isCloserOwn(tsConfig.data, session.data?.user, customer); // HOTFIX-73
  const showSimpleForm = !handoff && canCallsCreate && usesSimpleForm(tsConfig.data, session.data?.user, customer);
  const callChoice = handoff ? 'legacy' : callLauncher.choose(customer);
  const showUpgrade = ownsCustomer && !handoff && canUpdate && customer.status === 'in_progress' && customer.priority !== 1;
  const tsCard = handoff ? <UpgradedCard result={handoff} /> : showUpgrade ? <UpgradeCard onOpen={() => setUpgradeOpen(true)} /> : null;
  const afterHandoff = (result: PromoteResult, toast = true) => {
    // The customer leaves the qualifier's scope, so do not refetch this page (it would 404); keep showing local state.
    setHandoff(result);
    if (result.kept) void queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(id) }); // HOTFIX-73: closer keeps it
    if (toast) setTsToast(result.message);
    void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
  };
  const firstCall = firstCallOf(customer);
  const canEditFirstCall = Boolean(firstCall && fcEditInfo.data?.canEdit && !handoff);
  const openFcEdit = () => { void fcEditInfo.refetch(); setFcEditOpen(true); };
  const afterFirstCallEdit = (r: FirstCallEditResult) => {
    void queryClient.invalidateQueries({ queryKey: consultProfileKey(id) });
    void queryClient.invalidateQueries({ queryKey: firstCallEditInfoKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListCustomerActivityQueryKey(id) });
    if (r.handoff) { afterHandoff(r.handoff, false); return; }
    void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    void customerQuery.refetch();
  };
  const afterSimpleForm = (r: QualifyResult) => {
    if (r.handoff) { afterHandoff(r.handoff, false); return; }
    void queryClient.invalidateQueries({ queryKey: getListCustomerActivityQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    void customerQuery.refetch();
  };
  const baseActivity = activityQuery.data ?? customer.activity ?? [];
  const activity = handoff && !baseActivity.some((item) => item.id === handoff.callLogId)
    ? [{ ...(baseActivity[0] ?? {}), id: handoff.callLogId, salespersonName: session.data?.user.salespersonName ?? session.data?.user.fullName ?? null, createdAt: new Date().toISOString(), subject: `ارتقا به اولویت ۱ توسط ${(session.data?.user.salespersonName ?? '').replace(/^(آقای|خانم)\s+/, '') || 'کارشناس'}`, customerRequest: `واگذاری به ${handoff.closerName} (${handoff.assignmentLabel ?? (handoff.assignment === 'previous_expert' ? 'کارشناس قبلی مشتری' : 'تقسیم عادلانه')})`, expertNotes: `مهلت تماس تا ${handoff.dueLabel}` } as (typeof baseActivity)[number], ...baseActivity]
    : baseActivity;
  const tagLabel = (key: string) => tagCatalog.data?.find(item => item.key === key)?.label ?? key;
  const visibleTags = customer.tags.filter(key => key !== 'repeat_request').filter(hideTagForSiteLead(customer));
  const verified = customer.verificationStatus === 'verified';
  const readOnlyRole = !canUpdate && !canCallsCreate && !walletRole;
  const secs: Array<[string, string, number | null]> = [
    ['info', 'اطلاعات', null],
    ...(canLoansView ? [['loans', 'تسهیلات', loansQuery.data ? loansTotal : null] as [string, string, number | null]] : []),
    ['calls', 'تماس‌ها', activity.length],
    ...(baleOn ? [['bale', 'بله', null] as [string, string, number | null]] : []),
    ...(walletRole ? [['wallet', 'کیف پول', null] as [string, string, number | null]] : []),
  ];
  const fieldErr = (key: string, testId: string) => profileErrors[key] ? <p className="err" id={`${testId}-err`} role="alert"><AlertCircle size={16} /> {profileErrors[key]}</p> : null;

  const hero = <section className="csx-sec csx-hero" aria-labelledby="customer-hero-name" data-testid="customer-hero">
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div className="who">
        <span className="csx-av" aria-hidden="true">{initialsOf(customer.name)}</span>
        <div style={{ minWidth: 0 }}>
          <h2 id="customer-hero-name" className="kzs-wrap"><CustomerName id={customer.id} name={customer.name} nameTestId="text-customer-name" badgeTestId="text-customer-id" /><KazemiSourceChip source={kazemiSourceOf(customer)} testId="chip-kazemi-source" />{baleOn ? <BaleLinkBadge customerId={customer.id} /> : null}</h2>
          <div className="sub">کارشناس: {handoff ? handoff.closerName : customer.salespersonName || 'بدون تخصیص'}</div>
        </div>
      </div>
      <div className="csx-chips" style={{ gap: 6 }}>
        <StatusPill status={customer.status} />
        <PriorityLabel value={handoff ? 1 : customer.priority} />
        <SiteLeadChips customer={customer} testId="chip-site-lead" />
        <DeadlineCountdown customer={customer} testId="countdown-top-of-list" size="lg" />
        {customer.isUrgent ? <span className="csx-tag warn">فوری</span> : null}
        {verified ? <span className="csx-tag ok"><ShieldCheck size={14} /> احراز شده</span> : <span className="csx-tag bad">احراز نشده</span>}
        {visibleTags.map(key => <span className="csx-tag" key={key}>{tagLabel(key)}</span>)}
        <RepeatRequestTag customer={customer} onClick={() => setReviewingRepeat(true)} />
      </div>
      <PreferredTimeNote customer={customer} testId="preferred-time" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Phone size={18} aria-hidden="true" style={{ color: 'var(--nf-ink-muted)' }} />
        {/* CALL-COPY v1.0.4: full number + copy («کپی شد»); below 700px tapping it dials through the call-lock start (cqTelClick). */}
        <span data-testid="text-customer-phone"><CallNumber phone={customer.phone} customerId={customer.id} via="customer" onErr={setToast} size="md" testId="cust-ph" /></span>
      </div>
    </div>
    <div className="acts">
      {showSimpleForm ? <button type="button" className="csx-call" onClick={() => setSimpleFormOpen(true)} data-testid="button-ts-simple-form"><PhoneCall size={20} /> {CALLED_LABEL}</button>
        : canCallsCreate || isAdmin ? <button type="button" className="csx-call" onClick={() => void calledThenForm(customer.id, 'customer', () => callLauncher.launch(customer), setToast)} data-testid="link-call-customer"><PhoneCall size={20} /> {CALLED_LABEL}</button> : null}
      {showUpgrade && showsUpgradeButton(tsConfig.data, session.data?.user, customer) ? <button type="button" className="ts-up-btn hero" onClick={() => setUpgradeOpen(true)} data-testid="button-ts-upgrade-hero"><ArrowUp size={18} aria-hidden="true" /> ارتقا به اولویت ۱</button> : null}
      {canUpdate ? <button type="button" className="csx-ghost" onClick={() => setEditing(true)} data-testid="button-toggle-customer-edit" aria-haspopup="dialog"><Pencil size={18} /> ویرایش</button> : null}
      {canNewLoan ? <Link href={loanWizardHref(customer.id)} className="csx-primary wide" data-testid="button-new-loan-from-customer"><Plus size={20} /> درخواست تسهیلات جدید</Link> : null}
    </div>
    {canCall || canConsult ? <div className="acts2">
      {canCall ? <button type="button" className="csx-ghost sm" title={canDialSystem ? 'تماس با تلفن شرکت' : 'برای تماس سیستمی، ابتدا در بخش تلفن شرکت متصل شوید'} onClick={() => { if (canDialSystem) dial(customer.phone); else setLocation('/phone'); }} data-testid="button-sys-call-customer"><Phone size={18} color={canDialSystem ? undefined : '#94a3b8'} /> تماس سیستمی</button> : null}
      {canConsult ? <button type="button" className="csx-ghost sm" onClick={() => setConsultationFormOpen(true)} data-testid="button-create-consultation"><FileText size={18} /> ثبت مشاوره</button> : null}
    </div> : null}
    {firstCall?.noPlanFit ? <div className="csx-hero-plans"><NoPlanBox note={firstCall.noPlanNote} actorName={firstCall.actorName} /></div> : null}
    {firstCall?.selectedPlans.length ? <div className="csx-hero-plans"><SuggestedPlansBox plans={firstCall.selectedPlans} actorName={firstCall.actorName} /></div> : null}
  </section>;

  const infoSec = <section className="csx-sec" id="sec-info" aria-labelledby="h-info">
    <header><h2 id="h-info"><UserRound size={20} /> اطلاعات هویتی</h2>{verified ? <span className="csx-tag ok">احراز شده</span> : <span className="csx-tag bad">احراز نشده</span>}</header>
    <dl className="dl">
      <dt>کد ملی</dt><dd>{customer.nationalCode ? <span className="ltr">{faDigits(customer.nationalCode)}</span> : '—'}</dd>
      <dt>تاریخ تولد</dt><dd>{customer.birthDateJalali ? <span className="ltr">{faDigits(customer.birthDateJalali)}</span> : '—'}</dd>
      <dt>کد پستی</dt><dd>{customer.postalCode ? <span className="ltr">{faDigits(customer.postalCode)}</span> : '—'}</dd>
      <dt>نام پدر</dt><dd>{customer.officialFatherName || customer.fatherName || '—'}</dd>
      <dt>نشانی رسمی</dt><dd>{customer.officialAddress || customer.address || '—'}</dd>
      {customer.email ? <><dt>ایمیل</dt><dd><span className="ltr">{customer.email}</span></dd></> : null}
      <dt>ثبت</dt><dd>{jalaliDate(customer.createdAt)}</dd>
      <dt>توضیح</dt><dd style={{ fontWeight: 500 }}>{customer.description || '—'}</dd>
    </dl>
    {verified && customer.verificationChecks ? <div className="vchk">{VERIFY_ITEMS.map(([key, label]) => { const ok = customer.verificationChecks?.[key]?.ok; return <div key={key} className={ok ? 'ok' : 'no'}>{ok ? <Check size={18} /> : <X size={18} />}{label}</div>; })}</div>
      : !verified ? <div className="csx-note warn" data-testid="note-customer-unverified"><AlertCircle size={18} /><p>هویت این مشتری هنوز استعلام نشده است. استعلام در مرحله «احراز هویت» ثبت درخواست تسهیلات انجام می‌شود.</p></div> : null}
    {canUpdate ? <p className="hint">ویرایش کد ملی، تاریخ تولد، کد پستی یا موبایل، وضعیت احراز را به «احراز نشده» برمی‌گرداند.</p> : null}
    <details className="csx-sub"><summary>برچسب‌ها و سابقه مشاوره <ChevronLeft size={16} /></summary>
      <CustomerTagEditor customer={customer} />
      <CustomerConsultationStatus customerId={id} />
    </details>
  </section>;

  const statusSec = <section className="csx-sec" aria-labelledby="h-status" data-testid="section-customer-status">
    <header><h2 id="h-status"><Flag size={20} /> وضعیت پیگیری</h2></header>
    {canUpdate ? <>
      <div className="csx-chips" role="radiogroup" aria-label="وضعیت">{(['in_progress', 'completed', 'cancelled'] as CustomerUpdateStatus[]).map((key) => <button key={key} type="button" className="csx-chip" role="radio" aria-checked={customer.status === key} data-s={key} disabled={update.isPending} onClick={() => customer.status !== key && quickUpdate({ status: key })} data-testid={`chip-status-${key}`}>{STATUS_LABEL[key]}</button>)}</div>
      <div className="csx-chips" role="radiogroup" aria-label="اولویت">{[1, 2, 3, null].map((value) => <button key={String(value)} type="button" className="csx-chip" role="radio" aria-checked={(customer.priority ?? null) === value} data-p={value ?? undefined} disabled={update.isPending} onClick={() => (customer.priority ?? null) !== value && quickUpdate({ priority: value })} data-testid={`chip-priority-${value ?? 'none'}`}>{value ? `اولویت ${faNum(value)}` : 'بدون اولویت'}</button>)}</div>
      {quickError ? <div className="csx-note bad" role="alert"><AlertCircle size={18} /><p>{quickError}</p></div> : null}
    </> : <div className="csx-chips" style={{ gap: 6 }}><StatusPill status={customer.status} /><PriorityLabel value={customer.priority} />{customer.isUrgent ? <span className="csx-tag warn">فوری</span> : null}</div>}
    {isAdmin ? <form className="csx-fld" onSubmit={reassignSalesperson} data-testid="panel-customer-salesperson-assignment" style={{ display: 'grid', gap: 8 }}>
      <label className="lbl" htmlFor="customer-salesperson-reassignment">کارشناس فروش</label>
      <select id="customer-salesperson-reassignment" className="csx-inp" value={salespersonSelection} onChange={(event) => { setSalespersonSelection(event.target.value); setSalespersonError(''); }} disabled={salespersons.isLoading || salespersons.isError || update.isPending} data-testid="select-customer-salesperson-reassignment" aria-describedby="sp-hint">
        <option value="">بدون تخصیص</option>
        {customer.salespersonId && !(salespersons.data ?? []).some((person) => person.id === customer.salespersonId) ? <option value={customer.salespersonId} disabled>{customer.salespersonName || 'کارشناس فعلی'} (در فهرست موجود نیست)</option> : null}
        {(salespersons.data ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      <p className="hint" id="sp-hint">فقط مدیر می‌تواند کارشناس را تغییر دهد.</p>
      {salespersons.isLoading ? <p className="hint" role="status">در حال دریافت فهرست کارشناسان…</p> : null}
      {salespersons.isError ? <p className="err" role="alert">فهرست کارشناسان دریافت نشد. صفحه را تازه‌سازی کنید.</p> : null}
      {salespersonError ? <p className="err" role="alert" data-testid="error-customer-salesperson-reassignment">{salespersonError}</p> : null}
      <button className="csx-ghost sm" type="submit" disabled={salespersons.isLoading || salespersons.isError || update.isPending} data-testid="button-save-customer-salesperson">{update.isPending ? 'در حال ذخیره…' : 'ذخیره کارشناس'}</button>
    </form> : <div className="csx-fld"><span className="lbl">کارشناس فروش</span><div className="asg">{customer.salespersonName ? <><span className="csx-av" aria-hidden="true">{initialsOf(customer.salespersonName)}</span>{customer.salespersonName}</> : <span className="muted">بدون کارشناس فروش</span>}</div></div>}
  </section>;

  const activeCheck = creditChecks.data?.find(c => c.status === 'processing' || c.status === 'awaiting_otp');
  const lastReport = creditChecks.data?.find(c => c.status === 'report_generated');
  const creditSec = canCreditCheck ? <section className="csx-sec" aria-labelledby="h-credit" data-testid="panel-credit-check">
    <header><h2 id="h-credit"><Gauge size={20} /> اعتبارسنجی</h2></header>
    {customer.creditRank ? <div className="rank"><span className="big" data-testid="text-credit-rank">{customer.creditRank}</span><dl className="dl"><dt>امتیاز</dt><dd>{customer.creditScore != null ? faNum(customer.creditScore) : '—'}</dd><dt>آخرین استعلام</dt><dd>{jalaliDate(customer.creditCheckedAt)}</dd></dl></div>
      : <div className="rank"><span className="big none">—</span><p className="muted" style={{ margin: 0 }}>هنوز استعلام اعتباری انجام نشده است.</p></div>}
    {lastReport ? <a className="csx-ghost sm" href={`/api/customers/${id}/credit-checks/${lastReport.id}/report.pdf`} download><FileText size={18} /> دانلود گزارش PDF</a> : null}
    {creditError ? <div className="csx-note bad" role="alert"><AlertCircle size={18} /><p>{creditError}</p></div> : null}
    {creditChecks.isError ? <div role="alert" className="csx-note bad"><AlertCircle size={18} /><p>دریافت سابقه استعلام اعتبارسنجی انجام نشد. اتصال سامانه را بررسی و دوباره تلاش کنید.</p></div> : null}
    {activeCheck ? (activeCheck.status === 'awaiting_otp' ? (
      <form noValidate className="csx-fld" style={{ display: 'grid', gap: 8 }} onSubmit={(event) => {
        event.preventDefault();
        if (!validateOtp(otp)) { setOtpError('کد یک‌بارمصرف باید بین ۴ تا ۸ رقم باشد.'); return; }
        setOtpError(''); setCreditError('');
        validateCredit.mutate({ id, checkId: activeCheck.id, data: { otp: normalizeDigits(otp) } }, {
          onSuccess: () => { setOtp(''); refreshBoth(); },
          onError: (error) => { setCreditError(inquiryErrorMessage(error, 'تأیید کد یک‌بارمصرف انجام نشد.')); setOtpError(serverFieldErrors(error).otp ?? ''); },
        });
      }}>
        <div className="csx-note"><ShieldCheck size={18} /><p>رمز یک‌بارمصرف برای موبایل مشتری ارسال شد.</p></div>
        <label className="lbl" htmlFor="credit-otp">رمز یک‌بارمصرف</label>
        <input id="credit-otp" className="csx-inp ltr" dir="ltr" inputMode="numeric" value={otp} onChange={(event) => { setOtp(normalizeDigits(event.target.value).replace(/\D/g, '').slice(0, 8)); setOtpError(''); }} maxLength={8} aria-invalid={Boolean(otpError)} aria-describedby={otpError ? 'credit-otp-err' : undefined} data-testid="input-credit-otp" />
        {otpError && <p className="err" id="credit-otp-err" role="alert" data-testid="error-credit-otp">{otpError}</p>}
        <div className="csx-two">
          <button className="csx-primary" type="submit" disabled={validateCredit.isPending}>{validateCredit.isPending ? 'در حال بررسی…' : 'تأیید و دریافت گزارش'}</button>
          <button className="csx-ghost" type="button" onClick={() => renewCredit.mutate({ id, checkId: activeCheck.id }, { onSuccess: refreshBoth, onError: (error) => { setCreditError(inquiryErrorMessage(error, 'ارسال مجدد کد یک‌بارمصرف انجام نشد.')); refreshBoth(); } })} disabled={renewCredit.isPending}>ارسال مجدد</button>
        </div>
      </form>
    ) : <div className="csx-note" role="status"><RefreshCw size={18} className="spin" /><p><b>گزارش در حال آماده‌سازی است.</b> وضعیت به‌صورت خودکار به‌روزرسانی می‌شود.</p></div>) : (
      <details className="csx-sub"><summary>استعلام اعتبار جدید <ChevronLeft size={16} /></summary>
        <form noValidate className="csx-fld" style={{ display: 'grid', gap: 8 }} onSubmit={(event) => {
          event.preventDefault();
          if (!validateIranianNationalCode(nationalCode)) { setNationalCodeError('کد ملی ۱۰ رقمی معتبر وارد کنید.'); return; }
          setNationalCodeError('');
          setCreditError('برای شروع استعلام، ابتدا در ثبت درخواست تسهیلات هزینه ثابت تشکیل پرونده را از کیف پول نقدی پرداخت کنید.');
        }}>
          <label className="lbl" htmlFor="credit-national-code">کد ملی مشتری</label>
          <input id="credit-national-code" className="csx-inp ltr" dir="ltr" inputMode="numeric" value={nationalCode} onChange={(event) => { setNationalCode(event.target.value); setNationalCodeError(''); }} placeholder="۱۰ رقم" maxLength={10} aria-invalid={Boolean(nationalCodeError)} aria-describedby={nationalCodeError ? 'credit-nc-err' : undefined} data-testid="input-credit-national-code" />
          {nationalCodeError && <p className="err" id="credit-nc-err" role="alert" data-testid="error-credit-national-code">{nationalCodeError}</p>}
          <button className="csx-ghost sm" type="submit"><ShieldCheck size={18} /> راهنمای شروع استعلام</button>
        </form>
      </details>
    )}
    <p className="hint">استعلام جدید به پرداخت هزینه تشکیل پرونده در ثبت درخواست تسهیلات نیاز دارد.</p>
    {creditChecks.data && creditChecks.data.length > 0 ? <details className="csx-sub"><summary>سابقه استعلام‌ها ({faNum(creditChecks.data.length)}) <ChevronLeft size={16} /></summary>
      <ul className="csx-tl">{creditChecks.data.map(check => <li key={check.id}>
        <span className="ic" aria-hidden="true"><Gauge size={16} /></span>
        <div>
          <p className="tt">{check.scoreLabel || 'بدون امتیاز'}، <span className={`csx-tag ${check.status === 'report_generated' ? 'ok' : check.status === 'failed' ? 'bad' : 'info'}`}>{check.status === 'report_generated' ? 'موفق' : check.status === 'failed' ? 'خطا' : 'در حال انجام'}</span></p>
          {check.summary ? <p className="tx">{check.summary}</p> : null}
          <div className="who">{check.status === 'report_generated' ? 'دریافت گزارش' : check.status === 'failed' ? 'آخرین تلاش' : 'آخرین به‌روزرسانی'}: {formatDateTime(check.completedAt || check.updatedAt)}</div>
          {check.status === 'report_generated' ? <a className="csx-link" href={`/api/customers/${id}/credit-checks/${check.id}/report.pdf`} download><FileText size={16} /> دانلود PDF</a> : null}
          {check.status === 'failed' && check.errorMessage ? <p className="err">{inquiryErrorMessage({ data: { message: check.errorMessage } }, 'استعلام اعتبارسنجی ناموفق بود.')}</p> : null}
        </div>
      </li>)}</ul>
    </details> : null}
  </section> : null;

  const serverDraft = srvDraftQuery.data ?? null;
  const serverDraftNote = serverDraft ? (() => { const w = draftWait(serverDraft.waitingHours); return <div className={`csx-note ${serverDraft.paidOver24h ? 'bad' : 'warn'}`} data-testid="server-draft-note">
    <History size={18} />
    <div style={{ display: 'grid', gap: 6, flex: 1 }}>
      <p><b>درخواست در انتظار ثبت</b>، مرحله {faDraft(serverDraft.step)} از {faDraft(serverDraft.totalSteps)} ({serverDraft.stepLabel}){serverDraft.planName ? `، ${serverDraft.planName}` : ''}</p>
      <p className="hint">{serverDraft.paid ? `هزینه‌ی پرونده واریز شده (${faDraft(Number(serverDraft.feeAmountToman ?? 0))} تومان)؛ پرونده هنوز ساخته نشده.` : 'هزینه‌ی پرونده هنوز واریز نشده.'} منتظر {w.text} · آخرین ذخیره {tehranTime(serverDraft.updatedAt)}{serverDraft.salespersonName ? ` · کارشناس: ${serverDraft.salespersonName}` : ''}</p>
      {!serverDraft.paid && serverDraft.expiringSoon && serverDraft.daysUntilAutoDelete != null ? <p className="hint">اگر ادامه داده نشود، {faDraft(serverDraft.daysUntilAutoDelete)} روز دیگر خودکار پاک می‌شود.</p> : null}
      {serverDraft.canContinue ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link href={draftHref(serverDraft)} className="csx-ghost sm" data-testid="link-resume-server-draft">ادامه‌ی درخواست</Link></div> : <p className="hint">این درخواست مال کارشناس دیگری است.</p>}
    </div>
  </div>; })() : null;
  const draftNote = canNewLoan && draft && !serverDraft ? <div className="csx-note warn" data-testid="loan-draft-note">
    <History size={18} />
    <div style={{ display: 'grid', gap: 6, flex: 1 }}>
      <p><b>پیش‌نویس درخواست تسهیلات</b>، مرحله {faNum(draft.step)} از {faNum(WIZARD_TOTAL_STEPS)} ({WIZARD_DISPLAY_STEPS[draft.step - 1]?.label}){draft.planName ? `، ${draft.planName}` : ''}، {relativeTime(draft.updatedAt)}</p>
      <p className="hint">فقط روی همین مرورگر ذخیره شده است.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link href={loanWizardHref(customer.id, true)} className="csx-ghost sm" data-testid="link-resume-loan-draft">ادامه پیش‌نویس</Link>
        <button type="button" className="csx-link" onClick={() => { clearLoanDraft(userId, customer.id); setToast('پیش‌نویس حذف شد.'); }} data-testid="button-discard-loan-draft">حذف پیش‌نویس</button>
      </div>
    </div>
  </div> : null;

  const loansSec = canLoansView ? <section className="csx-sec" id="sec-loans" aria-labelledby="h-loans" data-testid="section-customer-loans">
    <header><h2 id="h-loans"><Layers size={20} /> درخواست‌های تسهیلات</h2>{loansQuery.data ? <span className="muted" data-testid="text-customer-loans-summary">{faNum(loansTotal)} پرونده{loans.length ? (() => { const done = loans.filter((l) => loanBusinessStatus(l) === 'completed').length; const cx = loans.filter((l) => loanBusinessStatus(l) === 'canceled').length; const act = loans.length - done - cx; return `، ${faNum(act)} فعال${done ? `، ${faNum(done)} تکمیل‌شده` : ''}${cx ? `، ${faNum(cx)} لغوشده` : ''}`; })() : ''}</span> : null}</header>
    {serverDraftNote}
    {draftNote}
    {loansQuery.isLoading ? <div className="stack" aria-busy="true"><span className="csx-sk" style={{ height: 72 }} /><span className="csx-sk" style={{ height: 72 }} /></div>
      : loansQuery.isError ? <div className="csx-note bad" role="alert"><AlertCircle size={18} /><p>فهرست تسهیلات دریافت نشد. <button type="button" className="csx-link" onClick={() => loansQuery.refetch()}>تلاش دوباره</button></p></div>
      : loans.length ? <div className="stack">{loans.map((loan) => { const [label, tone] = LOAN_STATUS[loan.status] ?? [loan.status, 'open']; const bs = loanBusinessStatus(loan); const stage = bs !== 'canceled' && bs !== 'completed' ? loanStageLabel(loan.stage) : ''; return <Link key={loan.id} href={`/loan-applications/${loan.id}`} className="csx-loan" data-ls={tone} data-testid={`link-customer-loan-${loan.id}`}>
        <div className="r1"><b>پرونده #{faId(loan.id)}</b>{bs && BUSINESS_STATUS_LABELS[bs] ? <span className="csx-st" data-bs={bs}>{BUSINESS_STATUS_LABELS[bs]}</span> : <span className="csx-st">{label}</span>}</div>
        {stage ? <div className="csx-loan-stage" data-testid={`text-customer-loan-stage-${loan.id}`}>مرحله: {stage}</div> : null}
        <div className="muted">{loan.planName || 'طرح تسهیلات'}، {toman(loan.approvedAmount || loan.requestedAmount)} تومان{(loan.durationMonths ?? loan.requestedDurationMonths) ? `، ${faNum(Number(loan.durationMonths ?? loan.requestedDurationMonths))} ماهه` : ''}</div>
        <div className="muted">ثبت {jalaliDate(loan.createdAt)}{loan.updatedAt ? <span data-testid={`text-customer-loan-updated-${loan.id}`}>{` · ${bs === 'completed' ? 'تکمیل' : bs === 'canceled' ? 'لغو' : 'آخرین تغییر'} ${jalaliDate(loan.updatedAt)}`}</span> : null}</div>
      </Link>; })}</div>
      : <p className="muted" style={{ margin: 0 }}>برای این مشتری هنوز درخواست تسهیلاتی ثبت نشده است.</p>}
    {canNewLoan ? <Link href={loanWizardHref(customer.id)} className="csx-ghost sm" data-testid="link-new-loan-for-customer"><Plus size={18} /> ثبت درخواست تسهیلات برای این مشتری</Link> : null}
  </section> : null;

  const callsSec = <section className="csx-sec" id="sec-calls" aria-labelledby="h-calls" data-testid="section-customer-calls">
    <header><h2 id="h-calls"><History size={20} /> خط زمانی ارتباط</h2><span className="muted">{faNum(activity.length)} مورد</span></header>
    {activityQuery.isLoading ? <div className="stack" aria-busy="true"><span className="csx-sk" style={{ height: 56 }} /><span className="csx-sk" style={{ height: 56 }} /></div>
      : activity.length ? <ol className="csx-tl">{activity.map((item) => <li key={item.id}>
        <span className="ic" aria-hidden="true"><PhoneCall size={16} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="who">{item.salespersonName || 'کارشناس تیم'}، {formatDateTime(item.createdAt)}</div>
          <p className="tx"><b>{item.subject || 'تماس با مشتری'}</b></p>
          <p className="tx q">{item.customerRequest || 'درخواست مشتری ثبت نشده است.'}{item.expertNotes ? ` — ${item.expertNotes}` : ''}</p>
        </div>
      </li>)}</ol>
      : <p className="muted" style={{ margin: 0 }}>هنوز تماس یا یادداشتی ثبت نشده است.</p>}
    {canCallsCreate ? <button type="button" className="csx-ghost sm" onClick={() => callLauncher.launch(customer)} data-testid="button-add-call-detail" data-form={callChoice} aria-busy={callLauncher.pending ? true : undefined}><MessageSquarePlus size={18} /> ثبت تماس / یادداشت</button> : null}
    <SiteLeadHistory customer={customer} />
    <CustomerIntroLog key={`eis-${id}`} customerId={id} />
    <CustomerAnnotations key={`ann-${id}`} customerId={id} />
    {hasCallsView ? <details className="csx-sub" data-testid="section-voip-history"><summary>تماس‌های تلفن شرکت{historyQuery.data ? ` (${faNum(historyQuery.data.total)})` : ''} <ChevronLeft size={16} /></summary>
      {historyQuery.isLoading ? <span className="csx-sk" style={{ height: 48 }} /> : historyQuery.isError ? <ErrorState onRetry={() => historyQuery.refetch()} /> : historyQuery.data?.items && historyQuery.data.items.length > 0 ? <>
        <ol className="csx-tl">{historyQuery.data.items.map(record => <li key={record.id}>
          <span className="ic" aria-hidden="true"><Phone size={16} /></span>
          <div><p className="tt">{record.direction === 'incoming' ? 'تماس ورودی' : 'تماس خروجی'} — {record.status === 'completed' ? 'پاسخ داده شده' : record.status === 'missed' ? 'از دست رفته' : record.status === 'rejected' ? 'رد شده' : record.status === 'failed' ? 'ناموفق' : record.status}</p>
            <div className="who">کارشناس: {record.actorName} (داخلی {record.extension})، {formatDateTime(record.startedAt)}</div></div>
        </li>)}</ol>
        {historyQuery.data.total > historyQuery.data.limit && <div className="csx-two">
          <button className="csx-ghost sm" disabled={historyPage === 1} onClick={() => setHistoryPage(p => p - 1)}>قبلی</button>
          <button className="csx-ghost sm" disabled={historyPage * historyQuery.data.limit >= historyQuery.data.total} onClick={() => setHistoryPage(p => p + 1)}>بعدی</button>
        </div>}
      </> : <p className="muted" style={{ margin: 0 }}>تا به حال تماس سیستمی با این مشتری ثبت نشده است.</p>}
    </details> : null}
  </section>;

  const walletSec = walletRole ? <section className="csx-sec" id="sec-wallet" aria-labelledby="h-wallet" data-testid="section-customer-wallet">
    <header><h2 id="h-wallet"><Wallet size={20} /> کیف پول مشتری</h2><button type="button" className="csx-link" onClick={() => walletQuery.refetch()}>به‌روزرسانی</button></header>
    {walletQuery.isLoading ? <div className="bal" aria-busy="true"><span className="csx-sk" style={{ height: 64 }} /><span className="csx-sk" style={{ height: 64 }} /></div>
      : walletQuery.isError ? <div className="csx-note bad" role="alert"><AlertCircle size={18} /><p>دریافت کیف پول ممکن نشد. دوباره تلاش کنید.</p></div>
      : walletQuery.data && <>
        <div className="bal"><div><span>موجودی نقدی</span><b>{toman(walletQuery.data.cash.balanceToman)}</b> <small>تومان</small></div><div><span>اعتبار تسهیلات</span><b>{toman(walletQuery.data.credit.balanceToman)}</b> <small>تومان</small></div></div>
        <div className="csx-fld" style={{ display: 'grid', gap: 8 }}>
          <label className="lbl" htmlFor="wallet-cash-amount">مبلغ شارژ نقدی (تومان)</label>
          <input id="wallet-cash-amount" className="csx-inp" type="number" min="1" inputMode="numeric" value={cashAmount} onChange={e => setCashAmount(e.target.value)} placeholder="مبلغ به تومان" data-testid="input-wallet-cash-amount" />
          <div className="csx-two">
            <button type="button" className="csx-ghost sm" disabled={sharePending} onClick={createWalletShareLink} data-testid="button-wallet-share-link">{sharePending ? 'در حال ارسال…' : shareLink ? 'ساخت لینک تازه' : 'ارسال لینک شارژ (پیامک)'}</button>
            <button type="button" className="csx-ghost sm" disabled={paymentPending} onClick={startCashPayment} data-testid="button-wallet-cash-payment">پرداخت و شارژ نقدی</button>
          </div>
        </div>
        {shareSmsSent && <div className="csx-note ok" role="status"><Check size={18} /><p>لینک شارژ با پیامک برای مشتری ارسال شد.</p></div>}
        {shareLink && <div className="wallet-share-link"><span>مبلغ لینک: <strong>{toman(shareAmount || '0')} تومان</strong></span><div><input readOnly dir="ltr" value={shareLink} /><button type="button" className="csx-ghost sm" onClick={() => void navigator.clipboard?.writeText(shareLink)}><Copy size={16} /> کپی</button></div></div>}
        {walletError && <div className="csx-note bad" role="alert"><AlertCircle size={18} /><p>{walletError}</p></div>}
        <details className="csx-sub"><summary>تراکنش‌های کیف پول <ChevronLeft size={16} /></summary>{(['cash', 'credit'] as const).map(type => <div key={type}><h3>{type === 'cash' ? 'نقدی' : 'اعتباری'}</h3>{walletQuery.data![type].ledger.length ? walletQuery.data![type].ledger.map((entry, i) => <p key={i} className="tx">{entry.kind === 'transfer_out' || entry.kind === 'credit_correction_debit' ? 'برداشت' : 'واریز'} {toman(entry.amountToman)} تومان، {entry.kind === 'transfer_out' || entry.kind === 'transfer_in' ? 'انتقال بین مشتریان' : entry.kind === 'cash_payment' ? 'شارژ نقدی از درگاه' : entry.kind.startsWith('loan_credit') ? 'شارژ اعتبار تسهیلات' : entry.kind === 'credit_correction_debit' ? 'اصلاح کسر اقساط تسهیلات' : 'سابقه کیف پول'}، {formatDateTime(entry.createdAt)}</p>) : <p className="muted">تراکنشی ثبت نشده است.</p>}</div>)}</details>
      </>}
    {perms.includes('customers.view') ? <details className="csx-sub"><summary>لینک‌های شارژ ارسال‌شده <ChevronLeft size={16} /></summary><WalletShareHistory key={id} customerId={id} /></details> : null}
    <details className="csx-sub"><summary>کیف پول طرح‌ها <ChevronLeft size={16} /></summary><CustomerPlanWallets key={`pw-${id}`} customerId={id} /></details>
    {isAdmin ? <details className="csx-sub" open={returnedPaymentId !== null}><summary>تطبیق پرداخت‌ها (مدیر) <ChevronLeft size={16} /></summary><PaymentReconciliation customerId={id} returnedPaymentId={returnedPaymentId} /></details> : null}
  </section> : <div className="csx-pw-solo"><CustomerPlanWallets key={`pw-${id}`} customerId={id} /></div>;

  const adminSec = isAdmin ? <section className="csx-sec danger-zone" aria-labelledby="h-admin" data-testid="section-admin-tools">
    <header><h2 id="h-admin"><Lock size={20} /> عملیات مدیر</h2></header>
    <button type="button" className="csx-ghost sm danger" onClick={() => setConfirmDelete(true)} disabled={remove.isPending} data-testid="button-delete-customer-detail"><Trash2 size={18} /> {remove.isPending ? 'در حال حذف…' : 'حذف مشتری'}</button>
    <p className="hint">حذف دائمی است و تماس‌ها و مشاوره‌های مشتری هم حذف می‌شوند.</p>
  </section> : null;

  return <div className="csx csx-detail" dir="rtl" data-testid="customer-detail">
    {reviewingRepeat && <RepeatRequestReview customer={customer} onClose={() => setReviewingRepeat(false)} />}
    {returnedPaymentId !== null && <WalletPaymentResult
      result={returnedPayment.data}
      loading={returnedPayment.isPending && !returnedPayment.isError}
      error={returnedPayment.isError}
      onRetry={() => returnedPayment.refetch()}
      onClose={closePaymentResult}
    />}
    <nav className="csx-crumb" aria-label="مسیر"><Link href="/customers" data-testid="link-back-customers"><ArrowRight size={16} /> مشتریان</Link><ChevronLeft size={14} aria-hidden="true" /><span aria-current="page">{customerNameText(customer.name, customer.id)}</span></nav>
    {hero}
    <LeadIntakePanel key={`li-${id}`} customerId={id} />
    {tsCard ? <div className="m-only">{tsCard}</div> : null}
    <div className="m-only"><DataAccuracyCard customerId={id} place="m" onSubmitted={refreshAfterAccuracy} /></div>
    {readOnlyRole ? <div className="csx-note warn" data-testid="note-readonly-role"><Lock size={18} /><p>فقط مشاهده — ویرایش، تماس و کیف پول برای نقش شما فعال نیست.</p></div> : null}
    <nav className="csx-secnav m-only" aria-label="بخش‌های پرونده">{secs.map(([key, label, n]) => <a key={key} href={`#sec-${key}`} aria-current={activeSec === key ? 'true' : undefined} onClick={(event) => { event.preventDefault(); setActiveSec(key); document.getElementById(`sec-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}{n != null ? <span className="n">{faNum(n)}</span> : null}</a>)}</nav>
    <div className="csx-dgrid">
      <div className="colA"><ConsultProfileCard customerId={customer.id} onEditFirstCall={canEditFirstCall ? openFcEdit : undefined} /><SiteAnswersBlock customerId={customer.id} />{firstCall ? <FirstCallSummaryCard fc={firstCall} editInfo={fcEditInfo.data} onEdit={canEditFirstCall ? openFcEdit : undefined} /> : null}{infoSec}{loansSec}{callsSec}{baleOn ? <BaleChatSection customerId={customer.id} /> : null}</div>
      <div className="colB">{tsCard ? <div className="d-only">{tsCard}</div> : null}<div className="d-only"><DataAccuracyCard customerId={id} place="d" onSubmitted={refreshAfterAccuracy} /></div>{statusSec}{creditSec}{walletSec}{adminSec}</div>
    </div>
    {editing ? <div className="csx-formhost"><Sheet title={`ویرایش پرونده ${customer.name}`} onClose={() => { setEditing(false); setProfileErrors({}); }} testId="customer-edit-sheet" initialFocus='[data-testid="input-detail-name"]' footer={<>
      <button className="csx-ghost" type="button" onClick={() => { setEditing(false); setProfileErrors({}); }}>انصراف</button>
      <button className="csx-primary" type="submit" form="customer-edit-form" disabled={update.isPending} data-testid="button-save-detail">{update.isPending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button>
    </>}>
      {profileErrors._form && <div role="alert" className="csx-note bad profile-form-error"><AlertCircle size={18} /><p>{profileErrors._form}</p></div>}
      <form id="customer-edit-form" noValidate onSubmit={save} className="csx-sheet-body" style={{ display: 'grid', gap: 14 }}>
        <div className="field"><label htmlFor="detail-name">نام و نام خانوادگی</label><input id="detail-name" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setProfileErrors(current => ({ ...current, name: '' })); }} aria-invalid={Boolean(profileErrors.name)} aria-describedby={profileErrors.name ? 'detail-name-err' : undefined} data-testid="input-detail-name" />{fieldErr('name', 'detail-name')}</div>
        <div className="field"><label htmlFor="detail-phone">شماره موبایل</label><input id="detail-phone" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => { setForm({ ...form, phone: e.target.value }); setProfileErrors(current => ({ ...current, phone: '' })); }} aria-invalid={Boolean(profileErrors.phone)} aria-describedby={profileErrors.phone ? 'detail-phone-err' : undefined} data-testid="input-detail-phone" />{fieldErr('phone', 'detail-phone')}</div>
        <div className="field"><label htmlFor="detail-nc">کد ملی (اختیاری)</label><input id="detail-nc" dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => { setForm({ ...form, nationalCode: e.target.value }); setNcTouched(true); setProfileErrors(current => ({ ...current, nationalCode: '' })); }} maxLength={10} aria-invalid={Boolean(profileErrors.nationalCode)} aria-describedby={profileErrors.nationalCode ? 'detail-nc-err' : undefined} data-testid="input-detail-national-code" />{!profileErrors.nationalCode && nationalCodePatch(form.nationalCode, customer?.nationalCode, ncTouched).clearing ? <small className="hint" data-testid="hint-detail-national-code-clear">{NATIONAL_CODE_CLEAR_HINT}</small> : null}{fieldErr('nationalCode', 'detail-nc')}</div>
        <div className="field"><label htmlFor="detail-pc">کد پستی (اختیاری)</label><input id="detail-pc" dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => { setForm({ ...form, postalCode: e.target.value }); setProfileErrors(current => ({ ...current, postalCode: '' })); }} maxLength={10} aria-invalid={Boolean(profileErrors.postalCode)} aria-describedby={profileErrors.postalCode ? 'detail-pc-err' : undefined} data-testid="input-detail-postal-code" />{fieldErr('postalCode', 'detail-pc')}</div>
        <div className="field"><label>تاریخ تولد (شمسی، اختیاری)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => { setForm({ ...form, birthDateJalali: v }); setProfileErrors(current => ({ ...current, birthDateJalali: '' })); }} testId="input-detail-birth-date" birthDate />{fieldErr('birthDateJalali', 'detail-bd')}</div>
        <div className="csx-two">
          <div className="field"><label htmlFor="detail-priority">اولویت</label><select id="detail-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} data-testid="select-detail-priority"><option value="">بدون اولویت</option>{[1, 2, 3].map((value) => <option key={value} value={value} disabled={showUpgrade && value === 1}>اولویت {faNum(value)}{showUpgrade && value === 1 ? ' (فقط با «ارتقا به اولویت ۱»)' : ''}</option>)}</select>{showUpgrade ? <small className="hint" data-testid="hint-detail-p1-upgrade-only">اولویت ۱ فقط با دکمهٔ «ارتقا به اولویت ۱»</small> : null}</div>
          <div className="field"><label htmlFor="detail-status">وضعیت</label><select id="detail-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CustomerUpdateStatus })} data-testid="select-detail-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div>
        </div>
        <div className="field"><label htmlFor="detail-desc">توضیح</label><VoiceNoteButton value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} field="customer_description" testId="detail-desc-voice"><textarea id="detail-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="textarea-detail-description" /></VoiceNoteButton></div>
        <p className="hint">ویرایش کد ملی، تاریخ تولد، کد پستی یا موبایل، وضعیت احراز را به «احراز نشده» برمی‌گرداند.</p>
      </form>
    </Sheet></div> : null}
    {confirmDelete ? <ConfirmDialog title={`حذف «${customer.name}»؟`} confirmLabel="حذف دائمی مشتری" pendingLabel="در حال حذف…" pending={remove.isPending} error={remove.isError ? 'حذف انجام نشد. دوباره تلاش کنید.' : undefined} onConfirm={deleteCustomer} onClose={() => setConfirmDelete(false)} testId="dialog-delete-customer">
      <p>این کار برگشت‌پذیر نیست.</p>
      <p className="hint">پرونده و تمام تماس‌ها و مشاوره‌های مرتبط برای همیشه حذف می‌شوند.</p>
    </ConfirmDialog> : null}
    {callFormOpen ? <CallForm customers={[customer]} salespersons={salespersons.data ?? []} pending={createCall.isPending} error={createCall.isError} errorDetail={createCall.error} initialCustomerId={customer.id} onClose={() => setCallFormOpen(false)} onSave={handleSaveCall}
      quickCredit={{ canAct: canNewLoan && (isAdmin || role === 'registrar' || (session.data?.user.salespersonId != null && session.data.user.salespersonId === customer.salespersonId)), onSaveAndCredit: handleSaveCallAndCredit }} /> : null}
    {consultationFormOpen && (
      <CreateConsultationForm
        customers={[customer]}
        initialCustomerId={customer.id}
        pending={createConsult.isPending}
        onClose={() => setConsultationFormOpen(false)}
        onSave={(data) => {
          createConsult.mutate({ data }, {
            onSuccess: (created) => {
              void queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() });
              try { sessionStorage.setItem('nafis-open-matches', String(created.id)); } catch { /* ignore */ }
              setConsultationFormOpen(false);
              setLocation('/consultations');
            }
          });
        }}
      />
    )}
    {toast ? <div className="csx-toast" role="status">{toast}</div> : null}
    {simpleFormOpen ? <SimpleCallForm customer={customer} userId={userId} noteMin={tsConfig.data?.noteMinLength ?? 10} strict={fcReopen} confirmClose={fcReopen} reopenNotice={fcReopen} onClose={() => { setSimpleFormOpen(false); setFcReopen(false); }} onDone={(r) => { if (fcReopen) void elApi.firstCallLogged(customer.id, r.callLogId).catch(() => undefined); afterSimpleForm(r); }} onNext={() => { setSimpleFormOpen(false); setLocation('/customers'); }} /> : null}
    {fcEditOpen && firstCall && fcEditInfo.data ? <SimpleCallForm customer={customer} userId={userId} noteMin={tsConfig.data?.noteMinLength ?? 10}
      edit={{ fc: firstCall, canSend: fcEditInfo.data.canSend, sendBlockedReason: fcEditInfo.data.sendBlockedReason, onSaved: afterFirstCallEdit }}
      onClose={() => setFcEditOpen(false)} onDone={() => {}} onNext={() => setFcEditOpen(false)} /> : null}
    <CallLaunchStatus status={callLauncher.status} onRetry={callLauncher.retry} onCancel={callLauncher.cancel} />
    {upgradeOpen ? <UpgradeDialog customer={customer} onClose={() => setUpgradeOpen(false)} onDone={(r) => { setUpgradeOpen(false); afterHandoff(r); }} /> : null}
    {tsToast ? <TsToast text={tsToast} onClose={() => setTsToast('')} onLink={() => document.getElementById('sec-calls')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} /> : null}
  </div>;
}
