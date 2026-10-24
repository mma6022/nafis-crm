import { matchesCustomerSearch, rankExactCustomerId } from '@/lib/customer-id';
import { CustomerIdBadge, CustomerName } from '@/components/customer/CustomerName';
import { createPortal } from "react-dom";
import { requestWalletShare } from '@/lib/wallet-share';
import { documentFileAccept, supportedDocumentFile } from '@/lib/document-upload-type';
import { getListCustomerWalletShareLinksQueryKey } from '@workspace/api-client-react';
import React, { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { clearLoanDraft, readLoanDraft, writeLoanDraft } from "@/lib/loan-draft";
import { DRAFTS_KEY, DraftHttpError, filingFeeIdempotencyKey, openPreRegistrationFor, type OpenPreRegistration, canUseDrafts, draftsApi, tehranTime, type DraftPayload, type RequestDraft } from "@/lib/request-drafts";
import { toast } from "@/hooks/use-toast";
import "./request-drafts.css";
import { WIZARD_DISPLAY_STEPS, WIZARD_PHASES, WIZARD_TOTAL_STEPS } from "@/lib/loan-labels";
import { ConfirmDialog, useMinWidth } from "@/pages/customers-ui";
import "@/pages/customers.css";
import "@/pages/loan-requests.css";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  useListCustomers,
  getGetCustomerQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  useGetCustomer,
  useUpdateCustomer,
  useVerifyCustomerIdentity,
  useListCustomerCreditChecks,
  useInitiateCustomerCreditCheck,
  useValidateCustomerCreditCheck,
  useRenewCustomerCreditCheckOtp,
  useRefreshCustomerCreditCheckStatus,
  useListCustomerEligiblePlans,
  listCustomerEligiblePlans,
  getListCustomerEligiblePlansQueryKey,
  useGetFilingFeePlans,
  getGetFilingFeePlansQueryKey,
  chargeFilingFee,
  logCustomerCreditRankOverride,
  useListCustomerIdentityDocuments,
  getListCustomerIdentityDocumentsQueryKey,
  getDownloadCustomerIdentityDocumentUrl,
  useCreateLoanApplication,
  useUploadCustomerIdentityDocument,
  type Customer,
  type CustomerEligiblePlan,
  type CustomerVerificationResult,
  type CustomerIdentityDocumentUploadDocumentType
} from "@workspace/api-client-react";
import {
  Search,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ShieldCheck,
  RefreshCw,
  UploadCloud,
  FileText,
  User,
  Check,
  ChevronRight,
  ChevronLeft,
  X,
  Info,
  Copy,
  FileClock,
  RotateCcw
} from "lucide-react";
import { PersianDatePicker } from "@/components/PersianDatePicker";
import { formatPhoneForDisplay } from "@/lib/phone";
import { Priority, formatDate, formatDateTime } from "@/components/CrmShell";
import { normalizeDigits, serverFieldErrors, validateIranianMobile, validateIranianNationalCode, validateIranianPostalCode, validateJalaliBirthDate, validateOtp } from "@/lib/customer-field-validation";

/** Same limits as the server (api-server/src/lib/credit-rank-override-reason.ts). */
export const CREDIT_RANK_OVERRIDE_REASON_MIN = 10;
export const CREDIT_RANK_OVERRIDE_REASON_MAX = 500;

function apiErrorMessage(error: unknown, fallback: string) {
  const typed = error as {
    data?: { error?: unknown; message?: unknown };
    response?: { data?: { error?: unknown; message?: unknown } };
    message?: unknown;
  } | null;
  const payload = typed?.data ?? typed?.response?.data;
  const messages: Record<string, string> = {
    invalid_national_code: "کد ملی واردشده معتبر نیست.",
    invalid_phone: "شماره همراه واردشده معتبر نیست.",
    invalid_birth_date: "تاریخ تولد شمسی معتبر نیست.",
    invalid_postal_code: "کد پستی باید ۱۰ رقم باشد.",
    invalid_otp: "کد یک‌بارمصرف معتبر نیست.",
    filing_fee_required: "هزینه تشکیل پرونده برای همین مشتری و طرح ثبت نشده است. مرحله هزینه تشکیل پرونده را بررسی کنید.",
    filing_fee_already_used: "این هزینه قبلاً به یک پرونده وصل شده است؛ پرونده موجود را ادامه دهید.",
    customer_identity_not_verified: "هویت مشتری تأیید نشده یا اطلاعات هویتی تغییر کرده است. مرحله پروفایل و اعتبار را بررسی کنید.",
    credit_check_stale: "اعتبارسنجی مشتری به‌روز نیست. در مرحله پروفایل و اعتبار، استعلام تازه بگیرید.",
    identity_documents_missing: "مدارک هویتی کامل یا متعلق به اطلاعات هویتی فعلی مشتری نیستند. مرحله مدارک هویتی را بررسی کنید.",
    loan_plan_condition_not_found: "شرایط طرح تغییر کرده است. شرط جدید همین طرح را انتخاب کنید؛ هزینه پرداخت‌شده حفظ می‌شود.",
    loan_plan_condition_not_matched: "مبلغ، مدت بازپرداخت یا رتبه اعتباری با شرایط فعلی طرح سازگار نیست.",
    loan_plan_guarantor_grade_not_matched: "رتبهٔ اعتباری ضامن اعلام‌شده با این شرط طرح نمی‌خواند. شرط دیگری انتخاب کنید یا رتبهٔ ضامن را در فرم تماس/مشاوره اصلاح کنید.",
    credit_rank_override_reason_required: "برای «نادیده گرفتن رتبه» نوشتن دلیل الزامی است.",
    credit_rank_override_reason_too_short: `دلیل «نادیده گرفتن رتبه» باید دست‌کم ${CREDIT_RANK_OVERRIDE_REASON_MIN.toLocaleString('fa-IR')} نویسه باشد.`,
    credit_rank_override_reason_too_long: "دلیل «نادیده گرفتن رتبه» بیش از حد طولانی است (حداکثر ۵۰۰ نویسه).",
    application_contract_template_missing: "قالب قرارداد این طرح حذف شده یا قابل استفاده نیست. مدیر باید قالب طرح را بررسی کند.",
    application_contract_template_invalid: "تنظیمات فیلدهای قالب قرارداد معتبر نیست. مدیر باید قالب طرح را بررسی کند.",
    invalid_manual_values: "فیلدهای دستی قرارداد با تنظیمات فعلی قالب سازگار نیستند. اطلاعات قرارداد را دوباره بررسی کنید.",
    manual_values_invalid: "اطلاعات فیلدهای دستی قرارداد معتبر نیست.",
    manual_values_too_long: "حجم متن فیلدهای دستی قرارداد بیش از حد مجاز است.",
    identity_provider_unavailable: "یکی از سرویس‌های استعلام هویت در دسترس نیست. کمی بعد دوباره تلاش کنید.",
    identity_provider_timeout: "یکی از سرویس‌های استعلام هویت در زمان مقرر پاسخ نداد.",
    identity_provider_error: "استعلام سرویس‌های هویتی انجام نشد.",
    verification_conflict: "اطلاعات هویتی با اطلاعات ثبت‌شده مشتری دیگری تعارض دارد.",
    invalid_contract_template: "قالب Word قابل پردازش نیست. علامت‌های متغیر یا ساختار فایل قرارداد را بررسی کنید.",
    primary_template_missing_principal_mapping: "قالب قرارداد این طرح، نگاشت اصل تسهیلات ندارد. برای ثبت درخواست، مدیر باید نگاشت مبلغ اصل تسهیلات را در قالب قرارداد تنظیم کند.",
    document_generation_failed: "ساخت فایل قرارداد در سرور انجام نشد.",
    pdf_conversion_failed: "فایل Word ساخته شد، اما تبدیل آن به PDF انجام نشد.",
    formula_value_invalid: "مقدار یکی از فیلدهای فرمولی طرح برای مدت انتخاب‌شده عددی یا قابل محاسبه نیست.",
    conversion_queue_full: "سامانه در حال تبدیل چند قرارداد است؛ کمی بعد دوباره تلاش کنید.",
    provider_configuration: "تنظیمات اتصال CRM به سرویس امضامی کامل نیست.",
    provider_auth_failed: "ورود CRM به سرویس امضامی ناموفق بود. نام کاربری یا رمز سرویس باید بررسی شود.",
    collaborator_required: "نام، شماره همراه و کد ملی مشتری باید در پرونده تکمیل شود.",
    collaborator_invalid: "فرمت شماره همراه یا کد ملی مشتری معتبر نیست. شماره همراه باید با ۰۹ و کد ملی شامل ۱۰ رقم باشد.",
    customer_profile_incomplete: "پیش از پرداخت، اطلاعات الزامی پروفایل مشتری را کامل کنید.",
    insufficient_cash_balance: "موجودی کیف پول نقدی مشتری برای هزینه تشکیل پرونده کافی نیست.",
    filing_fee_idempotency_conflict: "تلاش پرداخت قبلی به مشتری یا طرح دیگری تعلق دارد.",
    loan_plan_not_found: "طرح انتخاب‌شده دیگر برای ثبت درخواست فعال نیست.",
    artifact_integrity: "فایل PDF قرارداد معتبر نیست؛ قرارداد را دوباره تولید کنید.",
    certificate_inactive: "مشتری گواهی امضای دیجیتال فعال ندارد.",
    provider_certificate_check_failed: "امضامی نتوانست وضعیت گواهی مشتری را بررسی کند.",
    provider_file_upload_failed: "آپلود PDF قرارداد در امضامی ناموفق بود.",
    provider_contract_send_failed: "PDF آپلود شد، اما ثبت و ارسال قرارداد در امضامی ناموفق بود.",
    provider_state_persist_failed: "قرارداد در امضامی ثبت شد، اما ذخیره نتیجه در CRM انجام نشد. بدون ایجاد قرارداد جدید دوباره تلاش کنید.",
    contract_generation_not_linkable: "قرارداد ارسال‌شده هنوز در CRM نهایی نشده است. بدون ایجاد قرارداد جدید دوباره تلاش کنید.",
    provider_timeout: "سرویس امضامی در زمان مقرر پاسخ نداد.",
    provider_unavailable: "ارتباط شبکه با سرویس امضامی برقرار نشد.",
    provider_delivery_failed: "سرویس امضامی درخواست ارسال قرارداد را نپذیرفت.",
  };
  if (typeof payload?.message === "string" && /[\u0600-\u06FF]/.test(payload.message)) return payload.message;
  if (typeof payload?.error === "string") return messages[payload.error] ?? (/[\u0600-\u06FF]/.test(payload.error) ? payload.error : fallback);
  if (typeof payload?.message === "string") return fallback;
  if (typeof typed?.message === "string" && /[\u0600-\u06FF]/.test(typed.message)) return typed.message;
  return fallback;
}

// Display parts per internal step (see WIZARD_DISPLAY_STEPS): the six internal steps are
// shown as ten small screens; the internal step order and its guards are unchanged.
const STEP_PARTS: Record<number, number> = { 1: 1, 2: 3, 3: 2, 4: 1, 5: 1, 6: 2 };
const STEP_LEADS: Record<number, string> = {
  1: "مشتری را جستجو و انتخاب کنید.",
  2: "برای استعلام هویت لازم است. اگر قبلاً ثبت شده، فقط بررسی کنید.",
  3: "اطلاعات هویتی با شاهکار، ثبت احوال، نشانی و ثنا استعلام می‌شود.",
  4: "رتبه اعتباری با کد یک‌بارمصرف ارسال‌شده به موبایل مشتری استعلام می‌شود.",
  5: "یکی از طرح‌های واجد شرایط و یکی از شروط آن را انتخاب کنید.",
  6: "مبلغ درخواستی و مدت بازپرداخت را در حدود شرط انتخاب‌شده مشخص کنید.",
  7: "هزینه ثابت تشکیل پرونده از کیف پول نقدی مشتری کسر می‌شود.",
  8: "پنج مدرک هویتی مشتری برای پرونده لازم است.",
  9: "فیلدهای دستی قالب قرارداد این طرح را تکمیل کنید.",
  10: "اطلاعات را بازبینی و پرونده را ثبت کنید.",
};

export function CreateWizard({ onClose, initialCustomerId, resumeDraft, fromCustomer, serverDraftId }: { onClose: () => void; initialCustomerId?: number; resumeDraft?: boolean; fromCustomer?: boolean; serverDraftId?: number }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  // Display sub-part of the current internal step; reset whenever the internal step changes.
  const [sub, setSub] = useState(0);
  const [subFor, setSubFor] = useState<number>(1);
  const pendingSub = useRef<number | null>(null);
  if (subFor !== step) {
    setSubFor(step);
    setSub(Math.min(pendingSub.current ?? 0, (STEP_PARTS[step] ?? 1) - 1));
    pendingSub.current = null;
  }
  const displayStep = WIZARD_DISPLAY_STEPS.find((d) => d.s === step && d.p === sub)?.n ?? 1;
  const isDesktop = useMinWidth(1024);
  const [exitOpen, setExitOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    titleRef.current?.focus();
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => { mainRef.current?.scrollTo?.({ top: 0 }); }, [displayStep]);
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canIgnoreCreditRank = ["admin", "salesperson"].includes(session.data?.user?.role ?? "");
  const [ignoreCreditRank, setIgnoreCreditRank] = useState(false);
  // «نادیده گرفتن رتبه» needs a written reason; the server logs every use and rejects an override without one.
  const [overrideReason, setOverrideReason] = useState<string | null>(null);
  const [reasonDialogOpen, setReasonDialogOpen] = useState(false);
  const [reasonDraft, setReasonDraft] = useState('');
  const [reasonPending, setReasonPending] = useState(false);
  const [reasonError, setReasonError] = useState('');
  const previewAllPlans = canIgnoreCreditRank && ignoreCreditRank && Boolean(overrideReason);
  const overrideReasonParam = previewAllPlans ? overrideReason ?? undefined : undefined;

  // Global wizard state
  const [search, setSearch] = useState("");
  const { data: customersData, isLoading: loadingCustomers } = useListCustomers(
    { limit: 50, search: search || undefined },
    { query: { queryKey: ["wizard-customers", search] } }
  );
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [feeChargeId, setFeeChargeId] = useState<number | null>(null);
  // Resume guard: this customer's paid fee already made a case → continue there (no second charge).
  const [existingCase, setExistingCase] = useState<OpenPreRegistration | null>(null);
  const checkExistingCase = async (customerId: number): Promise<boolean> => {
    try {
      const app = await openPreRegistrationFor(customerId);
      if (app) { setExistingCase(app); return true; }
    } catch { /* offline / no permission: the server still refuses a second charge */ }
    return false;
  };
  const selectCustomer = (customer: Customer | null) => {
    if (customer?.id !== selectedCustomer?.id) {
      setIgnoreCreditRank(false); setOverrideReason(null); setReasonDialogOpen(false);
      setFeeChargeId(null); setSelectedPlanId(null); setSelectedPlan(null); setAmount(''); setDuration(''); setTermsAttempted(false);
    }
    setSelectedCustomer(customer);
  };
  const applyIgnoreCreditRank = (checked: boolean) => {
    setIgnoreCreditRank(checked);
    setSelectedPlan(null); setAmount(''); setDuration(''); setTermsAttempted(false);
    if (!feeChargeId && !hasPendingFeeAttempt) {
      setSelectedPlanId(null);
    }
  };
  const confirmOverrideReason = async () => {
    if (!selectedCustomer || reasonPending) return;
    const reason = reasonDraft.trim();
    if (reason.length < CREDIT_RANK_OVERRIDE_REASON_MIN) {
      setReasonError(`دلیل باید دست‌کم ${CREDIT_RANK_OVERRIDE_REASON_MIN.toLocaleString('fa-IR')} نویسه باشد.`);
      return;
    }
    setReasonPending(true); setReasonError('');
    try {
      await logCustomerCreditRankOverride(selectedCustomer.id, { reason });
      setOverrideReason(reason);
      setReasonDialogOpen(false);
      applyIgnoreCreditRank(true);
    } catch (e) {
      setReasonError(apiErrorMessage(e, 'ثبت دلیل انجام نشد. دوباره تلاش کنید.'));
    } finally { setReasonPending(false); }
  };

  // Financing terms
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<CustomerEligiblePlan | null>(null);
  const [amount, setAmount] = useState("");
  const [duration, setDuration] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitFieldErrors, setSubmitFieldErrors] = useState<Record<string, string>>({});
  const [termsAttempted, setTermsAttempted] = useState(false);
  const [checkingSubmission, setCheckingSubmission] = useState(false);
  const hasPendingFeeAttempt = Boolean(selectedCustomer && selectedPlanId
    && window.sessionStorage.getItem(`loan-fee:${selectedCustomer.id}:${selectedPlanId}`));
  const selectPlanGroup = (planId: number) => {
    if (feeChargeId || hasPendingFeeAttempt || selectedPlanId === planId) return;
    setSelectedPlanId(planId);
    setSelectedPlan(null);
    setAmount('');
    setDuration('');
    setTermsAttempted(false);
  };
  const selectPlan = (plan: CustomerEligiblePlan) => {
    if (((feeChargeId || hasPendingFeeAttempt) && plan.planId !== selectedPlanId)
      || (selectedPlan?.planId === plan.planId && selectedPlan.conditionId === plan.conditionId)) return;
    setSelectedPlan(plan);
    setSubmitError('');
    setDuration("");
    setTermsAttempted(false);
    const planMaximum = Number(plan.maximumAmount || 0);
    const planStep = planMaximum >= 100_000_000 ? 1_000_000 : planMaximum >= 10_000_000 ? 100_000 : 10_000;
    setAmount(String(Math.min(planStep, planMaximum || planStep)));
  };

  // ---- Server draft («در انتظار ثبت»): create on customer pick, debounced autosave, resume. ----
  const [srv, setSrvState] = useState<RequestDraft | null>(null);
  const srvRef = useRef<RequestDraft | null>(null);
  const setSrv = (d: RequestDraft | null) => { srvRef.current = d; setSrvState(d); };
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'closed'>('idle');
  const [hydrated, setHydrated] = useState(false);
  const [dupDraft, setDupDraft] = useState<RequestDraft | null>(null);
  const [resumeInfo, setResumeInfo] = useState<RequestDraft | null>(null);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const stepNow = useRef(step); stepNow.current = step;
  const [creditNudge, setCreditNudge] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const latest = useRef<{ step: number; payload: DraftPayload }>({ step: 2, payload: {} });
  const inflight = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // A saved plan that could not be re-offered yet (e.g. credit must be refreshed) keeps its saved terms instead of being blanked.
  const payloadNow = (): DraftPayload => {
    const kept = !selectedPlan && selectedPlanId && srvRef.current?.planId === selectedPlanId ? (srvRef.current.payload ?? {}) : null;
    return {
      planId: selectedPlanId, planName: selectedPlan?.name ?? (kept ? srvRef.current!.planName : null),
      conditionId: selectedPlan?.conditionId ?? kept?.conditionId ?? null,
      amount: selectedPlan ? amount : kept?.amount ?? '', duration: selectedPlan ? duration : kept?.duration ?? '',
      ignoreCreditRank: previewAllPlans,
    };
  };
  // The server keeps the furthest step reached, so stepping back (or a forced credit refresh) never loses the resume point.
  const furthestSaved = srvRef.current && srvRef.current.customerId === selectedCustomer?.id ? srvRef.current.step : 0;
  latest.current = { step: Math.max(2, displayStep, furthestSaved), payload: payloadNow() };
  const draftsAllowedNow = canUseDrafts(session.data?.user as { role?: string; permissions?: string[] } | undefined);

  const flush = async (): Promise<boolean> => {
    const d = srvRef.current;
    if (!d) return false;
    if (inflight.current) { again.current = true; return false; }
    inflight.current = true; setSaveState('saving');
    let ok = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const saved = await draftsApi.save(srvRef.current!.id, srvRef.current!.version, latest.current.step, latest.current.payload);
          setSrv(saved); setSaveState('saved'); ok = true;
          if (userId) clearLoanDraft(userId, saved.customerId);
          break;
        } catch (e) {
          // Version conflict: adopt the server version and write this (active) session's state once more.
          if (e instanceof DraftHttpError && e.status === 409 && e.data?.draft && attempt === 0) { setSrv(e.data.draft); continue; }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof DraftHttpError && (e.status === 410 || e.status === 404)) { setSaveState('closed'); setSrv(null); }
      else setSaveState('offline');
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; void flush(); }
    }
    return ok;
  };
  const createFor = async (customer: Customer): Promise<boolean> => {
    setSaveState('saving');
    try {
      const d = await draftsApi.create(customer.id, latest.current.step, latest.current.payload);
      setSrv(d); setSaveState('saved'); setHydrated(true);
      void queryClient.invalidateQueries({ queryKey: DRAFTS_KEY });
      return true;
    } catch (e) {
      if (e instanceof DraftHttpError && e.status === 409 && e.data?.draft) { setSaveState('idle'); setDupDraft(e.data.draft); return false; }
      setSaveState('offline'); return false;
    }
  };
  /** Called before leaving step 1 (and on entry): makes sure this customer has a server draft. */
  const ensureDraft = async (): Promise<boolean> => {
    if (!draftsAllowedNow || !selectedCustomer) return true;
    if (srvRef.current && srvRef.current.customerId === selectedCustomer.id) return saveState === 'offline' ? flush() : true;
    if (srvRef.current) setSrv(null); // customer changed: the previous draft stays in the queue
    return createFor(selectedCustomer);
  };
  const goDisplay = (n: number) => {
    const t = WIZARD_DISPLAY_STEPS[Math.min(Math.max(n, 2), WIZARD_TOTAL_STEPS) - 1];
    pendingSub.current = t.p;
    // stepNow, not the closure's step: hydrate runs after the entry effect already moved to step 2.
    if (t.s === stepNow.current) setSub(t.p); else setStep(t.s as 1 | 2 | 3 | 4 | 5 | 6);
  };
  const hydrate = async (d: RequestDraft) => {
    setSrv(d); setResumeInfo(d); setSaveState('saved'); setDupDraft(null);
    const p = d.payload ?? {};
    // «نادیده گرفتن رتبه» is never restored silently: every use needs a fresh written reason (logged server-side).
    const ignore = false;
    setIgnoreCreditRank(false); setOverrideReason(null);
    if (Boolean(p.ignoreCreditRank) && canIgnoreCreditRank) setDraftNotice('این درخواست با «نادیده گرفتن رتبه» ذخیره شده بود؛ برای ادامه با همان حالت، آن را دوباره با ذکر دلیل فعال کنید.');
    if (d.feeChargeId) setFeeChargeId(d.feeChargeId);
    if (p.planId) setSelectedPlanId(p.planId);
    let n = Math.max(2, d.step);
    if (p.planId && n >= 5) {
      try {
        const plans = await listCustomerEligiblePlans(d.customerId, { ignoreCreditRank: ignore });
        queryClient.setQueryData(getListCustomerEligiblePlansQueryKey(d.customerId, { ignoreCreditRank: ignore }), plans);
        const plan = plans.plans.find((x) => x.planId === p.planId && (p.conditionId == null || x.conditionId === p.conditionId))
          ?? (d.feeChargeId ? plans.plans.find((x) => x.planId === p.planId) : undefined);
        if (plan) {
          setSelectedPlan(plan);
          if (p.amount) setAmount(p.amount); else setAmount(String(Math.min(1_000_000, Number(plan.maximumAmount || 0) || 1_000_000)));
          if (p.duration) setDuration(p.duration);
        } else n = Math.min(n, plans.credit?.fresh || ignore ? 5 : 4);
      } catch { n = Math.min(n, 5); }
    } else if (n >= 6) n = 5;
    if (!d.creditFresh && !ignore && (n >= 5 || n < Math.max(2, d.step))) setCreditNudge(true);
    setResumeAt(n);
    goDisplay(n);
    setHydrated(true);
  };
  const openServerDraft = async (customerId: number, draftId?: number) => {
    try {
      const d = draftId ? await draftsApi.get(draftId) : await draftsApi.byCustomer(customerId);
      if (d && d.customerId === customerId && d.status === 'pending_registration') { await hydrate(d); return; }
      if (draftId) setDraftNotice('این درخواست دیگر در انتظار ثبت نیست؛ درخواست تازه شروع شد.');
    } catch (e) {
      if (e instanceof DraftHttpError && e.offline) {
        setSaveState('offline');
        const local = readLoanDraft(userId, customerId);
        if (local) { draftRestore.current = { planId: local.planId, amount: local.amount, duration: local.duration }; if (local.planId) setSelectedPlanId(local.planId); setRestoredDraft(true); }
        return;
      }
      if (draftId) setDraftNotice(e instanceof DraftHttpError && e.status === 403 ? 'این درخواست مال کارشناس دیگری است و فقط خودش می‌تواند ادامه دهد.' : 'این درخواست دیگر در انتظار ثبت نیست؛ درخواست تازه شروع شد.');
    }
    const c = entryCustomer.data as unknown as Customer | undefined;
    // «ادامه» of a device draft (no server copy yet): carry its step and terms over instead of restarting at step 2.
    const local = resumeDraft && !draftId ? readLoanDraft(userId, customerId) : null;
    if (c && local && local.step > 2) {
      setSaveState('saving');
      try {
        const payload = { ...(local.planId ? { planId: local.planId } : {}), ...(local.amount ? { amount: local.amount } : {}), ...(local.duration ? { duration: local.duration } : {}) } as DraftPayload;
        const d = await draftsApi.create(c.id, local.step, payload);
        void queryClient.invalidateQueries({ queryKey: DRAFTS_KEY });
        await hydrate(d); return;
      } catch (e) {
        if (e instanceof DraftHttpError && e.status === 409 && e.data?.draft) { await hydrate(e.data.draft); return; }
        setSaveState('offline');
        draftRestore.current = { planId: local.planId, amount: local.amount, duration: local.duration }; if (local.planId) setSelectedPlanId(local.planId); setRestoredDraft(true);
        return;
      }
    }
    if (c) await createFor(c);
  };
  // Debounced autosave (~1s) of the current step and terms.
  const fingerprint = JSON.stringify(latest.current);
  useEffect(() => {
    if (!draftsAllowedNow || !hydrated || !srvRef.current || step < 2) return;
    // Opening or viewing a draft is not a change: no PUT, so «منتظر» and the 30-day clock are not reset.
    const d = srvRef.current, sp = d.payload ?? {}, np = latest.current.payload;
    const same = d.step === latest.current.step && (sp.planId ?? null) === (np.planId ?? null) && (sp.conditionId ?? null) === (np.conditionId ?? null)
      && (sp.amount ?? '') === (np.amount ?? '') && (sp.duration ?? '') === (np.duration ?? '') && Boolean(sp.ignoreCreditRank) === Boolean(np.ignoreCreditRank);
    if (same && saveState !== 'offline') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, 1000);
    return () => window.clearTimeout(timer.current);
  }, [fingerprint, hydrated, draftsAllowedNow]);
  // Offline: retry when the browser reconnects and every 15s.
  useEffect(() => {
    if (saveState !== 'offline') return;
    const retry = () => { if (srvRef.current) void flush(); else if (selectedCustomer && step > 1) void ensureDraft(); };
    window.addEventListener('online', retry);
    const id = window.setInterval(retry, 15_000);
    return () => { window.removeEventListener('online', retry); window.clearInterval(id); };
  }, [saveState, selectedCustomer?.id, step]);
  useEffect(() => { if (displayStep === 4) setCreditNudge(false); }, [displayStep]);
  const saveBlocked = draftsAllowedNow && step > 1 && saveState === 'offline';
  const draftsAllowed = draftsAllowedNow;

  // Entry from the customer page: customer pre-selected, wizard starts at step 2.
  const userId = session.data?.user?.id;
  const entryCustomer = useGetCustomer(initialCustomerId ?? 0, { query: { queryKey: getGetCustomerQueryKey(initialCustomerId ?? 0), enabled: Boolean(initialCustomerId) } });
  const entryApplied = useRef(false);
  const draftRestore = useRef<{ planId: number | null; amount: string; duration: string } | null>(null);
  const [restoredDraft, setRestoredDraft] = useState(false);
  useEffect(() => {
    if (entryApplied.current || !initialCustomerId || !entryCustomer.data || !session.data) return;
    entryApplied.current = true;
    selectCustomer(entryCustomer.data as unknown as Customer);
    setStep(2);
    void checkExistingCase(initialCustomerId).then((found) => {
      if (found) { setHydrated(true); return; }
      if (draftsAllowed) { void openServerDraft(initialCustomerId, serverDraftId); return; }
      const draft = resumeDraft ? readLoanDraft(userId, initialCustomerId) : null;
      if (draft) {
        draftRestore.current = { planId: draft.planId, amount: draft.amount, duration: draft.duration };
        if (draft.planId) setSelectedPlanId(draft.planId);
        setRestoredDraft(true);
      }
    });
  }, [entryCustomer.data, initialCustomerId, resumeDraft, session.data, userId, serverDraftId]);
  useEffect(() => {
    const restore = draftRestore.current;
    if (!restore || !selectedPlan || selectedPlan.planId !== restore.planId) return;
    draftRestore.current = null;
    if (restore.amount) setAmount(restore.amount);
    if (restore.duration) setDuration(restore.duration);
  }, [selectedPlan]);
  // Draft saving (client-side only): remember the customer, furthest step and chosen terms.
  useEffect(() => {
    if (!selectedCustomer || !userId || step < 2 || existingCase) return;
    if (draftsAllowed && hydrated && saveState !== 'offline') return;
    const previous = readLoanDraft(userId, selectedCustomer.id);
    writeLoanDraft(userId, {
      customerId: selectedCustomer.id, customerName: selectedCustomer.name,
      step: Math.max(displayStep, previous?.step ?? 0),
      planId: selectedPlanId ?? previous?.planId ?? null,
      planName: selectedPlan?.name ?? previous?.planName ?? null,
      amount: selectedPlan ? amount : previous?.amount ?? '',
      duration: selectedPlan ? duration : previous?.duration ?? '',
    });
  }, [selectedCustomer?.id, step, displayStep, selectedPlanId, selectedPlan?.planId, amount, duration, userId, saveState, hydrated, existingCase]);


  const handleNext = () => {
    if (saveBlocked) { if (srvRef.current) void flush(); else void ensureDraft(); return; }
    if (sub + 1 < (STEP_PARTS[step] ?? 1)) { setSub(sub + 1); return; }
    pendingSub.current = 0;
    setStep((s) => Math.min(s + 1, 6) as any);
  };
  const handlePrev = () => {
    if (sub > 0) { setSub(sub - 1); return; }
    const target = Math.max(step - 1, 1);
    pendingSub.current = (STEP_PARTS[target] ?? 1) - 1;
    setStep((s) => Math.max(s - 1, 1) as any);
  };
  // Rail / «ویرایش» / «تغییر مشتری»: only steps already passed can be revisited.
  const jumpTo = (n: number) => {
    const target = WIZARD_DISPLAY_STEPS[n - 1];
    if (!target || n >= displayStep) return;
    if (target.s === step) { setSub(target.p); return; }
    pendingSub.current = target.p;
    setStep(target.s as 1 | 2 | 3 | 4 | 5 | 6);
  };

  const createMutation = useCreateLoanApplication();

  const handleSubmit = async (manualValues: Record<string, string>) => {
    if (checkingSubmission || createMutation.isPending) return;
    if (saveBlocked) { void flush(); return; }
    if (!selectedCustomer || !selectedPlan || !feeChargeId || !selectedPlan.contractTemplateId) {
      setSubmitError('اطلاعات مشتری، طرح، هزینه تشکیل پرونده یا قالب قرارداد کامل نیست.');
      return;
    }
    const amountNumber = Number(amount);
    const durationAllowed = selectedPlan.allowedDurations?.some((value) => String(value) === duration);
    const termErrors: Record<string, string> = {};
    if (!Number.isFinite(amountNumber) || amountNumber <= 0 || amountNumber > Number(selectedPlan.maximumAmount || 0)) {
      termErrors.amount = 'مبلغ درخواستی برای این طرح معتبر نیست.';
    }
    if (!durationAllowed) termErrors.duration = 'مدت بازپرداخت برای این طرح معتبر نیست.';
    if (Object.keys(termErrors).length) {
      setSubmitFieldErrors(termErrors);
      setSubmitError('مبلغ یا مدت بازپرداخت با شرایط طرح انتخاب‌شده سازگار نیست.');
      return;
    }
    setSubmitError("");
    setSubmitFieldErrors({});
    let operation = "ایجاد درخواست اولیه";
    setCheckingSubmission(true);
    try {
      // A paid fee binds the plan, not an obsolete condition ID. Plan edits can
      // replace conditions while this multi-step form is still open.
      const latest = await listCustomerEligiblePlans(selectedCustomer.id, { ignoreCreditRank: previewAllPlans, creditRankOverrideReason: overrideReasonParam });
      queryClient.setQueryData(getListCustomerEligiblePlansQueryKey(selectedCustomer.id, { ignoreCreditRank: previewAllPlans, creditRankOverrideReason: overrideReasonParam }), latest);
      const current = latest.plans.find(plan =>
        plan.planId === selectedPlan.planId && plan.conditionId === selectedPlan.conditionId);
      const selectionTerms = (plan: CustomerEligiblePlan) => JSON.stringify([
        plan.maximumAmount, plan.allowedDurations, plan.needsGuarantor,
        plan.conditionNotes, plan.contractTemplateId, plan.manualVariables,
      ]);
      if (!current || selectionTerms(current) !== selectionTerms(selectedPlan)) {
        setSelectedPlan(current ?? null);
        setTermsAttempted(false);
        pendingSub.current = (previewAllPlans || latest.credit.fresh) ? 0 : 2;
        setStep((previewAllPlans || latest.credit.fresh) ? 3 : 2);
        setSubmitError((previewAllPlans || latest.credit.fresh)
          ? 'شرایط طرح هنگام تکمیل فرم تغییر کرده است. شرایط فعلی همین طرح را بررسی و انتخاب کنید؛ هزینه پرداخت‌شده حفظ شده و دوباره کسر نمی‌شود.'
          : 'اعتبارسنجی مشتری دیگر به‌روز نیست. استعلام تازه بگیرید؛ هزینه پرداخت‌شده حفظ می‌شود.');
        return;
      }
      const applicationInput = {
        ignoreCreditRank: previewAllPlans,
        creditRankOverrideReason: overrideReasonParam,
        customerId: selectedCustomer.id,
        feeChargeId,
        planIds: [selectedPlan.planId],
        planId: selectedPlan.planId,
        conditionId: selectedPlan.conditionId,
        requestedAmount: amount,
        durationMonths: Number(duration),
        preRegistration: true,
        // Retain the original manual-only contract fields for the application-bound primary generation.
        manualValues,
        ...(srvRef.current ? { draftId: srvRef.current.id } : {}),
      };
      window.clearTimeout(timer.current);
      const application = await createMutation.mutateAsync({ data: applicationInput as typeof applicationInput });
      await queryClient.invalidateQueries({ queryKey: ["/api/loan-applications"] });
      window.sessionStorage.removeItem(`loan-fee:${selectedCustomer.id}:${selectedPlan.planId}`);
      clearLoanDraft(userId, selectedCustomer.id);
      if (srvRef.current) {
        void queryClient.invalidateQueries({ queryKey: DRAFTS_KEY });
        toast({ title: 'درخواست ثبت شد', description: `پرونده‌ی ${fa(application.id)} برای ${selectedCustomer.name} ساخته شد و از «در انتظار ثبت» خارج شد.`, duration: 5000 });
        srvRef.current = null;
      }
      // Close first: the customer-page entry's close navigates back to the customer; the case page must win.
      onClose();
      setLocation(`/loan-applications/${application.id}`);
    } catch (error) {
      const fieldErrors = serverFieldErrors(error);
      const payload = (error as any)?.data ?? (error as any)?.response?.data;
      const code = payload?.code ?? payload?.error;
      if (code === 'loan_plan_condition_not_found') {
        // Handle an edit racing the preflight check without retrying a financial
        // operation or silently choosing another condition on the user's behalf.
        await queryClient.invalidateQueries({ queryKey: ["eligible-plans", selectedCustomer.id] });
        setSelectedPlan(null);
        setStep(3);
      } else if (code === 'identity_documents_missing') {
        setStep(5);
      } else if (code === 'credit_check_stale' || code === 'customer_identity_not_verified') {
        pendingSub.current = code === 'credit_check_stale' ? 2 : 1;
        setStep(2);
      } else if (code === 'filing_fee_required') {
        setFeeChargeId(null);
        setStep(4);
      }
      const extraFieldErrors = payload?.fieldErrors ?? payload?.errors ?? {};
      for (const variable of Object.keys(manualValues)) {
        if (extraFieldErrors && typeof extraFieldErrors === 'object' && variable in extraFieldErrors) {
          const rawMessage = (extraFieldErrors as any)[variable];
          const message = typeof rawMessage === 'string'
            ? rawMessage
            : Array.isArray(rawMessage) && typeof rawMessage[0] === 'string'
              ? rawMessage[0]
              : typeof rawMessage?.message === 'string' ? rawMessage.message : '';
          setSubmitFieldErrors(current => ({ ...current, [variable]: message && /[\u0600-\u06FF]/.test(message)
            ? message
            : 'مقدار این فیلد توسط سرور پذیرفته نشد.' }));
        }
      }
      if (fieldErrors.amount || fieldErrors.duration) setSubmitFieldErrors(fieldErrors);
      if (payload?.error === 'primary_template_missing_principal_mapping' || payload?.code === 'primary_template_missing_principal_mapping') {
        setSubmitError(apiErrorMessage(error, "قالب قرارداد این طرح نیاز به تنظیم نگاشت اصل تسهیلات توسط مدیر دارد."));
      } else if (fieldErrors.amount || fieldErrors.duration) {
        setSubmitError([fieldErrors.amount, fieldErrors.duration].filter(Boolean).join(' '));
      } else if (/amount|duration|loan_plan_condition_not_matched|loan_plan_not_found/i.test(String((error as any)?.data?.error ?? (error as any)?.message ?? ''))) {
        setSubmitError(apiErrorMessage(error, "مبلغ یا مدت انتخاب‌شده برای این طرح معتبر نیست."));
      } else {
      setSubmitError(`${operation}: ${apiErrorMessage(error, "عملیات انجام نشد. دوباره تلاش کنید.")}`);
      }
    } finally { setCheckingSubmission(false); }
  };

  const isSubmitting = checkingSubmission || createMutation.isPending;

  const WIZARD_STEPS = [
    { id: 1, title: "انتخاب مشتری" },
    { id: 2, title: "پروفایل و اعتبار" },
    { id: 3, title: "طرح و شرایط" },
    { id: 4, title: "هزینه تشکیل پرونده" },
    { id: 5, title: "مدارک هویتی" },
    { id: 6, title: "تایید نهایی" },
  ];
  void WIZARD_STEPS; // internal steps; the shell shows the 10 display steps below.

  const current = WIZARD_DISPLAY_STEPS[displayStep - 1];
  const upcoming = WIZARD_DISPLAY_STEPS[displayStep];
  const fa = (n: number) => n.toLocaleString('fa-IR');
  const requestExit = () => {
    if (selectedCustomer && step > 1) setExitOpen(true);
    else onClose();
  };
  const rail = (
    <nav className="lwz-rail" aria-label="مراحل ثبت درخواست" data-testid="wizard-stepper">
      {WIZARD_PHASES.map((phaseName, phase) => (
        <div key={phaseName} className="lwz-phase">
          <span className="ph">{phaseName}</span>
          <ol>
            {WIZARD_DISPLAY_STEPS.filter((d) => d.phase === phase).map((d) => {
              const state = d.n < displayStep ? 'done' : d.n === displayStep ? 'cur' : 'todo';
              const clickable = state === 'done' && !isSubmitting;
              const inner = <><span className="num" aria-hidden="true">{state === 'done' ? <Check size={15} /> : fa(d.n)}</span><span className="lb">{d.label}</span></>;
              return <li key={d.n} className={`lwz-ri ${state}`}>
                {clickable
                  ? <button type="button" onClick={() => jumpTo(d.n)} data-testid={`wizard-rail-step-${d.n}`}>{inner}<span className="lwz-sr"> (انجام شد؛ بازگشت به این مرحله)</span></button>
                  : <span aria-current={state === 'cur' ? 'step' : undefined} data-testid={`wizard-rail-step-${d.n}`}>{inner}</span>}
              </li>;
            })}
          </ol>
        </div>
      ))}
    </nav>
  );
  const progress = (
    <div className="lwz-progress" data-testid="wizard-stepper">
      <div className="lwz-bar" role="progressbar" aria-valuemin={1} aria-valuemax={WIZARD_TOTAL_STEPS} aria-valuenow={displayStep} aria-label={`مرحله ${fa(displayStep)} از ${fa(WIZARD_TOTAL_STEPS)}`}>
        {WIZARD_DISPLAY_STEPS.map((d) => <i key={d.n} className={d.n < displayStep ? 'done' : d.n === displayStep ? 'cur' : ''} />)}
      </div>
      <div className="meta">
        <span>مرحله <b>{fa(displayStep)} از {fa(WIZARD_TOTAL_STEPS)}</b> · {current ? WIZARD_PHASES[current.phase] : ''}</span>
        {upcoming ? <span className="nx">بعدی: {upcoming.label}</span> : <span className="nx">مرحله آخر</span>}
      </div>
    </div>
  );

  return createPortal(
    <div className="csx lwz" data-save-blocked={saveBlocked ? 'true' : undefined} role="dialog" aria-modal="true" aria-labelledby="lwz-title" dir="rtl" data-testid="create-loan-application-wizard"
      onKeyDown={(event) => { if (event.key === 'Escape' && !exitOpen) { event.stopPropagation(); requestExit(); } }}>
      <header className="lwz-top">
        <button type="button" className="lwz-x" onClick={requestExit} aria-label="بستن ثبت درخواست" data-testid="wizard-close"><X size={24} /></button>
        <h2 id="lwz-title" tabIndex={-1} ref={titleRef}>ثبت درخواست تسهیلات</h2>
        {selectedCustomer && step > 1 && !draftsAllowed ? <span className="lwz-saved" role="status" data-testid="wizard-draft-saved"><Check size={16} aria-hidden="true" /> <span className="t">ذخیره شد</span></span> : null}
        {selectedCustomer && (step > 1 || saveState === 'offline') && draftsAllowed ? <span className={`lwz-save${saveState === 'saved' ? ' ok' : saveState === 'offline' || saveState === 'closed' ? ' bad' : ''}`} role="status" aria-live="polite" data-testid="wizard-draft-saved" data-state={saveState}>
          {saveState === 'saving' ? <><RefreshCw size={15} aria-hidden="true" /> <span className="t">در حال ذخیره…</span></>
            : saveState === 'offline' ? <><AlertCircle size={15} aria-hidden="true" /> <span className="t">ذخیره نشد، اتصال قطع است</span> <button type="button" onClick={() => { if (srvRef.current) void flush(); else void ensureDraft().then((ok) => { if (ok && step === 1) handleNext(); }); }} data-testid="wizard-save-retry">تلاش دوباره</button></>
            : saveState === 'closed' ? <><AlertCircle size={15} aria-hidden="true" /> <span className="t">این درخواست دیگر در انتظار ثبت نیست</span></>
            : srv ? <><Check size={15} aria-hidden="true" /> <span className="t">ذخیره شد، </span><span className="tm">{tehranTime(srv.updatedAt)}</span></> : null}
        </span> : null}
        {srv && step > 1 ? <span className="lwz-pending-pill" data-testid="wizard-pending-pill"><FileClock size={13} aria-hidden="true" /> <span className="t">در انتظار ثبت</span></span> : null}
        <section className="lwz-chip" aria-label="مشخصات مشتری درخواست" data-testid="wizard-customer-summary">
          <span className="av" aria-hidden="true">{selectedCustomer?.name ? selectedCustomer.name.trim().charAt(0) : <User size={16} />}</span>
          <span className="tx">
            <strong data-testid="wizard-customer-name">{selectedCustomer?.name || 'هنوز انتخاب نشده'}{selectedCustomer ? <> <CustomerIdBadge id={selectedCustomer.id} testId="wizard-customer-id" /></> : null}</strong>
            <small><bdi dir="ltr" data-testid="wizard-customer-phone">{selectedCustomer?.phone ? formatPhoneForDisplay(selectedCustomer.phone) : '—'}</bdi> · کد ملی <bdi dir="ltr" data-testid="wizard-customer-national-code">{selectedCustomer ? selectedCustomer.nationalCode || 'ثبت نشده' : '—'}</bdi></small>
          </span>
        </section>
      </header>
      {!isDesktop ? progress : null}
      <div className="lwz-body">
        {isDesktop ? rail : null}
        <main className="lwz-main" ref={mainRef}>
          <div className="lwz-inner">
            {fromCustomer && selectedCustomer && entryApplied.current && displayStep > 1 ? <p className="lwz-note ok" data-testid="wizard-from-customer-note"><User size={18} aria-hidden="true" /> <span>مشتری از پرونده مشتری انتخاب شد: <b>{selectedCustomer.name}</b>. <button type="button" className="text-link" onClick={() => jumpTo(1)} disabled={isSubmitting} data-testid="btn-change-customer">تغییر مشتری</button></span></p> : null}
            {restoredDraft && step <= 3 ? <p className="lwz-note" role="status" data-testid="wizard-draft-restored"><FileClock size={18} aria-hidden="true" /> <span><b>پیش‌نویس بازیابی شد.</b> اعتبار مشتری دوباره بررسی می‌شود و طرح و مبلغ انتخابی قبلی در مرحله «طرح و شرط» پیشنهاد می‌شود.</span></p> : null}
            {initialCustomerId && entryCustomer.isError && !selectedCustomer ? <p className="lwz-note bad" role="alert" data-testid="wizard-entry-customer-error"><AlertCircle size={18} aria-hidden="true" /> اطلاعات مشتری #{fa(initialCustomerId)} دریافت نشد؛ درخواست ذخیره‌شده دست نخورده است. صفحه را دوباره باز کن.</p> : null}
            {draftNotice ? <p className="lwz-note" role="status" data-testid="wizard-draft-notice">{draftNotice}</p> : null}
            {resumeInfo && selectedCustomer && resumeInfo.customerId === selectedCustomer.id && displayStep === resumeAt ? <div className="lwz-resume" data-testid="wizard-resume-box">
              <div className="h"><span><RotateCcw size={16} aria-hidden="true" /> ادامه‌ی درخواست نیمه‌کاره</span><span className="muted">{resumeInfo.paid ? 'هزینه‌ی پرونده واریز شده' : 'هزینه واریز نشده'}</span></div>
              <div>مشتری: <b>{resumeInfo.customerName ?? selectedCustomer.name}</b> <CustomerIdBadge id={resumeInfo.customerId} /></div>
              <b>همه‌ی اطلاعات قبلی سر جایش است؛ از مرحله {fa(displayStep)} ادامه بده.{resumeInfo.step > displayStep ? ` (آخرین مرحله‌ی ذخیره‌شده ${fa(resumeInfo.step)} بود؛ ${displayStep <= 4 || creditNudge ? 'اول استعلام اعتبار باید تازه شود' : 'طرح دوباره بررسی شود'}.)` : ''}</b>
              <span className="muted">آخرین ذخیره: {new Date(resumeInfo.updatedAt).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' })}، {tehranTime(resumeInfo.updatedAt)}{resumeInfo.updatedByName ? `، توسط ${resumeInfo.updatedByName}` : ''}</span>
              {session.data?.user?.role !== 'salesperson' && resumeInfo.salespersonName && resumeInfo.salespersonId !== (session.data?.user as { salespersonId?: number | null } | undefined)?.salespersonId
                ? <span className="muted" data-testid="wizard-resume-other"><User size={14} aria-hidden="true" /> درخواست {resumeInfo.salespersonName} را ادامه می‌دهی؛ کارشناس پرونده همان می‌ماند.</span> : null}
            </div> : null}
            {creditNudge && displayStep >= 5 ? <p className="lwz-note warn" role="alert" data-testid="wizard-credit-stale"><AlertCircle size={18} aria-hidden="true" /> <span><b>استعلام اعتبار باید تازه شود.</b> استعلام قبلی بیش از ۲۴ ساعت پیش گرفته شده است. <button type="button" className="text-link" onClick={() => jumpTo(4)} data-testid="btn-refresh-credit">تازه‌کردن استعلام</button></span></p> : null}
            {step !== 6 && submitError && <p className="form-error" role="alert" data-testid="wizard-recovery-error">{submitError}</p>}
            <div className="lwz-head">
              <span className="k">مرحله {fa(displayStep)} از {fa(WIZARD_TOTAL_STEPS)}</span>
              <h3 data-testid="wizard-step-title">{current?.label}</h3>
              {STEP_LEADS[displayStep] ? <p>{STEP_LEADS[displayStep]}</p> : null}
            </div>

      {existingCase && selectedCustomer ? <div className="lwz-resume" role="status" data-testid="wizard-existing-case">
        <div className="h"><span><RotateCcw size={16} aria-hidden="true" /> این درخواست قبلاً ثبت شده است</span><span className="muted">{existingCase.feePaid ? 'هزینه‌ی پرونده واریز شده' : 'بدون هزینه'}</span></div>
        <div>مشتری: <b>{selectedCustomer.name}</b> <CustomerIdBadge id={selectedCustomer.id} /> · پرونده‌ی {fa(existingCase.id)}</div>
        <b>هزینه‌ی تشکیل پرونده قبلاً کسر شده و پرونده ساخته شده است؛ ادامه از خود پرونده انجام می‌شود (صدور قرارداد اولیه). مبلغی دوباره کسر نمی‌شود.</b>
        <div className="form-footer">
          <button type="button" className="btn btn-primary" data-testid="btn-open-existing-case" onClick={() => {
            window.sessionStorage.removeItem(`loan-fee:${selectedCustomer.id}:${existingCase.planId ?? ''}`);
            clearLoanDraft(userId, selectedCustomer.id);
            void queryClient.invalidateQueries({ queryKey: DRAFTS_KEY });
            onClose();
            setLocation(`/loan-applications/${existingCase.id}`);
          }}>ادامه از پرونده‌ی {fa(existingCase.id)} <ChevronLeft size={18} /></button>
        </div>
      </div> : <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 10 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          className="lwz-motion"
        >
          {step === 1 && (
            <Step1Customer 
               search={search} setSearch={setSearch} 
               customers={customersData?.items || []} 
               loading={loadingCustomers}
               selectedCustomer={selectedCustomer} 
                setSelectedCustomer={selectCustomer} 
               onNext={() => { void (async () => { if (selectedCustomer && await checkExistingCase(selectedCustomer.id)) return; if (await ensureDraft()) handleNext(); })(); }} 
            />
          )}
          {step === 2 && selectedCustomer && (
            <Step2ProfileAndCredit
               canIgnoreCreditRank={canIgnoreCreditRank}
               ignoreCreditRank={previewAllPlans}
               previewLocked={Boolean(feeChargeId) || hasPendingFeeAttempt}
               onIgnoreCreditRankChange={(checked: boolean) => {
                 if (checked) { setReasonDraft(''); setReasonError(''); setReasonDialogOpen(true); return; }
                 setOverrideReason(null);
                 applyIgnoreCreditRank(false);
               }}
               customer={selectedCustomer}
               onNext={handleNext}
               onPrev={handlePrev}
               onCustomerUpdate={setSelectedCustomer}
               part={sub}
               onExitToCustomer={fromCustomer ? onClose : undefined}
            />
           )}
           {step === 3 && selectedCustomer && (
            <Step3PlanAndTerms
               ignoreCreditRank={previewAllPlans}
               overrideReason={overrideReasonParam}
               customer={selectedCustomer}
                selectedPlanId={selectedPlanId}
               selectedPlan={selectedPlan}
                onSelectPlanGroup={selectPlanGroup}
                onSelectPlan={selectPlan}
                planLocked={Boolean(feeChargeId) || hasPendingFeeAttempt}
                feeRecoveryPending={hasPendingFeeAttempt && !feeChargeId}
               amount={amount}
               setAmount={setAmount}
               duration={duration}
               setDuration={setDuration}
                attempted={termsAttempted}
                onAttempt={() => setTermsAttempted(true)}
               onNext={handleNext}
               onPrev={handlePrev}
               part={sub}
            />
          )}
            {step === 4 && selectedCustomer && selectedPlan && (
              <StepFilingFee customer={selectedCustomer} selectedPlan={selectedPlan} ignoreCreditRank={previewAllPlans} draftId={srv?.id} overrideReason={overrideReasonParam}
                feeChargeId={feeChargeId} setFeeChargeId={setFeeChargeId} onNext={handleNext} onPrev={handlePrev}
                onExistingCase={() => { if (selectedCustomer) void checkExistingCase(selectedCustomer.id); }} />
          )}
           {step === 5 && selectedCustomer && (
            <Step4IdentityDocs
               customer={selectedCustomer}
               onNext={handleNext}
               onPrev={handlePrev}
            />
          )}
           {step === 6 && selectedCustomer && selectedPlan && (
            <Step5Review
               customer={selectedCustomer}
               plan={selectedPlan}
               amount={amount}
               duration={duration}
               onNext={handleSubmit}
               onPrev={handlePrev}
                isPending={isSubmitting}
                error={submitError}
                serverErrors={submitFieldErrors}
                part={sub}
                onPartNext={handleNext}
                onEdit={jumpTo}
                feePaid={Boolean(feeChargeId)}
            />
          )}
        </motion.div>
      </AnimatePresence>}
          </div>
        </main>
      </div>
      {reasonDialogOpen && selectedCustomer ? <ConfirmDialog
        title="دلیل نادیده گرفتن رتبه"
        confirmLabel="ثبت دلیل و ادامه"
        pendingLabel="در حال ثبت…"
        pending={reasonPending}
        tone="primary"
        error={reasonError}
        onConfirm={() => void confirmOverrideReason()}
        onClose={() => { if (!reasonPending) setReasonDialogOpen(false); }}
        testId="override-reason-dialog"
      >
        <p>رتبهٔ اعتباری مشتری و ضامن در ادامهٔ این پرونده بررسی نمی‌شود. دلیل این تصمیم با نام شما و زمان ثبت در گزارش ادمین ذخیره می‌شود.</p>
        <label className="lwz-field" htmlFor="override-reason-input">
          <span>دلیل (دست‌کم {CREDIT_RANK_OVERRIDE_REASON_MIN.toLocaleString('fa-IR')} نویسه)</span>
          <textarea id="override-reason-input" data-testid="override-reason-input" rows={3} maxLength={CREDIT_RANK_OVERRIDE_REASON_MAX}
            value={reasonDraft} onChange={(event) => { setReasonDraft(event.target.value); setReasonError(''); }}
            placeholder="مثلاً: تأیید مدیر فروش به‌دلیل سابقهٔ بازپرداخت کامل وام قبلی"
            style={{ width: '100%', resize: 'vertical', font: 'inherit', padding: 8, borderRadius: 8, border: '1px solid var(--line, #d0d5dd)' }} />
          <small className="lwz-muted" data-testid="override-reason-count">{reasonDraft.trim().length.toLocaleString('fa-IR')} / {CREDIT_RANK_OVERRIDE_REASON_MIN.toLocaleString('fa-IR')}</small>
        </label>
      </ConfirmDialog> : null}
      {exitOpen ? <ConfirmDialog
        title="خروج از ثبت درخواست؟"
        confirmLabel="خروج"
        cancelLabel="ماندن"
        tone="primary"
        onConfirm={() => { setExitOpen(false); onClose(); }}
        onClose={() => setExitOpen(false)}
        testId="wizard-exit-dialog"
      >
        {draftsAllowed && srv && saveState !== 'offline'
          ? <p data-testid="wizard-exit-server">درخواست روی سرور ذخیره شد و از تب «در انتظار ثبت» در درخواست‌های تسهیلات (یا پرونده‌ی مشتری) از همین مرحله قابل ادامه است؛ چیزی پاک نمی‌شود.</p>
          : <p>پیش‌نویس روی همین دستگاه ذخیره شد و بعداً از فهرست درخواست‌ها یا پرونده مشتری قابل ادامه است.</p>}
        <p>هزینه پرداخت‌شده، مدارک و استعلام‌ها روی سرور ثبت شده‌اند.</p>
      </ConfirmDialog> : null}
      {dupDraft ? <ConfirmDialog title="یک درخواست نیمه‌کاره برای این مشتری هست" confirmLabel="ادامه‌ی همان درخواست" cancelLabel="انتخاب مشتری دیگر" tone="primary" testId="wizard-duplicate-dialog"
        onConfirm={() => { if (dupDraft.canContinue) void hydrate(dupDraft); }}
        onClose={() => { setDupDraft(null); setSrv(null); selectCustomer(null); setResumeInfo(null); setSaveState('idle'); if (step !== 1) { pendingSub.current = 0; setStep(1); } }}>
        <p><b>{dupDraft.customerName}</b> <CustomerIdBadge id={dupDraft.customerId} /> · مرحله {fa(dupDraft.step)} از {fa(dupDraft.totalSteps)} ({dupDraft.stepLabel}){dupDraft.paid ? ' · هزینه‌ی پرونده واریز شده' : ''}</p>
        <p className="lwz-muted">آخرین ذخیره {new Date(dupDraft.updatedAt).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })}، {tehranTime(dupDraft.updatedAt)}{dupDraft.updatedByName ? `، توسط ${dupDraft.updatedByName}` : ''}. برای هر مشتری فقط یک درخواست باز ممکن است.</p>
        {!dupDraft.canContinue ? <p className="lwz-note bad">این درخواست مال کارشناس دیگری است.</p> : null}
      </ConfirmDialog> : null}
    </div>,
    document.body,
  );
}

function StepFilingFee({ customer, selectedPlan, feeChargeId, setFeeChargeId, onNext, onPrev, ignoreCreditRank, draftId, overrideReason, onExistingCase }: {
  ignoreCreditRank: boolean; draftId?: number; overrideReason?: string; onExistingCase?: () => void;
  customer: Customer; selectedPlan: CustomerEligiblePlan;
  feeChargeId: number | null; setFeeChargeId: (id: number | null) => void; onNext: () => void; onPrev: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useGetFilingFeePlans({ customerId: customer.id, ignoreCreditRank, creditRankOverrideReason: overrideReason });
  const [pending, setPending] = useState(false);
  const [feeError, setFeeError] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [shareAmount, setShareAmount] = useState('');
  const [sharePending, setSharePending] = useState(false);
  const [shareSmsSent, setShareSmsSent] = useState(false);
  const keyRef = useRef<string | null>(null);
  const plan = data?.plans.find((p) => p.planId === selectedPlan.planId);
  const affordable = plan && data && BigInt(data.cashBalanceToman) >= BigInt(plan.filingFeeToman);
  const hasPendingKey = Boolean(plan && window.sessionStorage.getItem(`loan-fee:${customer.id}:${plan.planId}`));

  const pay = async () => {
    if (!plan || pending || feeChargeId) return;
    setPending(true);
    setFeeError('');
    const storageKey = `loan-fee:${customer.id}:${plan.planId}`;
    // One key per server draft + plan: a double click, a second tab or a resumed draft replays the same charge.
    keyRef.current ??= filingFeeIdempotencyKey(draftId, customer.id, plan.planId) ?? window.sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, keyRef.current);
    try {
      const feeInput = { customerId: customer.id, planId: plan.planId, ignoreCreditRank, creditRankOverrideReason: overrideReason, ...(draftId ? { draftId } : {}) };
      const charge = await chargeFilingFee(feeInput as Parameters<typeof chargeFilingFee>[0],
        { headers: { 'Idempotency-Key': keyRef.current } });
      if ((charge as { applicationId?: number | null }).applicationId) { onExistingCase?.(); return; }
      setFeeChargeId(charge.chargeId);
      await queryClient.invalidateQueries({ queryKey: getGetFilingFeePlansQueryKey({ customerId: customer.id, ignoreCreditRank, creditRankOverrideReason: overrideReason }) });
    } catch (e) {
      if ((e as { data?: { error?: string } })?.data?.error === 'open_pre_registration_case' || /open_pre_registration_case/.test(String((e as Error)?.message ?? ''))) { onExistingCase?.(); return; }
      setFeeError(apiErrorMessage(e, 'کسر هزینه انجام نشد. موجودی کیف پول نقدی را بررسی کنید.'));
      refetch();
    } finally { setPending(false); }
  };
  const createShareLink = async () => {
    if (shareUrl) {
      return;
    }
    setSharePending(true); setFeeError('');
    try {
      const body = await requestWalletShare(customer.id, { planId: selectedPlan.planId, ignoreCreditRank, creditRankOverrideReason: overrideReason });
      if (!body) return;
      setShareUrl(body.url);
      setShareAmount(String(body.amountToman || ''));
      let token = '';
      try {
        const url = new URL(body.url, window.location.origin);
         token = url.searchParams.get('token') || '';
      } catch {
        throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      }
      if (!token) throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      const smsResponse = await fetch(`/api/customers/${customer.id}/wallet/share-links/${encodeURIComponent(token)}/send-sms`, {
        method: 'POST',
        credentials: 'include',
      });
      const smsBody = await smsResponse.json().catch(() => ({}));
      if ((!smsResponse.ok && smsBody.error !== 'already_sent') || (smsResponse.ok && smsBody.status !== 'sent' && smsBody.status !== 'already_sent')) {
        throw new Error('لینک شارژ ساخته شد، اما پیامک ارسال نشد یا وضعیت ارسال نامشخص است؛ لینک را کپی و ارسال کنید.');
      }
      setShareSmsSent(true);
    } catch (e) { setFeeError(apiErrorMessage(e, 'ساخت لینک شارژ انجام نشد.')); }
    finally {
      setSharePending(false);
      void queryClient.invalidateQueries({ queryKey: getListCustomerWalletShareLinksQueryKey(customer.id) });
    }
  };

  return <div className="lwz-step" data-testid="wizard-filing-fee">
    <p className="lwz-muted">طرح و شرایط درخواست انتخاب شده است. مبلغ ثابت همین طرح فقط یک بار از کیف پول نقدی مشتری کسر و به کیف پول نقدی شرکت منتقل می‌شود.</p>
    {isLoading ? <p className="lwz-loading" role="status">در حال دریافت طرح‌ها...</p> : error ? <p role="alert" className="lwz-note bad">دریافت طرح‌ها ناموفق بود. <button type="button" className="text-link" onClick={() => refetch()}>تلاش دوباره</button></p> : (
      <>
        {!plan && (
          <p role="alert" className="lwz-note bad">طرح انتخاب‌شده دیگر واجد شرایط پرداخت نیست و مبلغی کسر نمی‌شود. برای بررسی طرح و شرایط به مرحله قبل برگردید.</p>
        )}
        <dl className="lwz-card lwz-kv lwz-fee">
          <div className="full"><dt>طرح انتخاب‌شده</dt><dd data-testid="filing-fee-plan-name">{selectedPlan.name}</dd></div>
          {plan && <div><dt>هزینه ثابت تشکیل پرونده</dt><dd className="big">{BigInt(plan.filingFeeToman).toLocaleString('fa-IR')} <small>تومان</small></dd></div>}
          <div><dt>موجودی نقدی مشتری</dt><dd className={`big${plan && !affordable && !feeChargeId ? ' lwz-errtext' : ''}`}>{BigInt(data?.cashBalanceToman ?? '0').toLocaleString('fa-IR')} <small>تومان</small></dd></div>
        </dl>
        {plan && !affordable && !feeChargeId && !hasPendingKey && <p role="alert" className="lwz-note warn">موجودی کافی نیست. ابتدا کیف پول نقدی مشتری را از <a href={`/customers/${customer.id}`}>پرونده مشتری</a> شارژ کنید، سپس به این مرحله برگردید.</p>}
        {feeError && <p role="alert" className="lwz-note bad">{feeError}</p>}
         {!feeChargeId && plan && <div className="lwz-card lwz-share">
           <strong>پرداخت توسط مشتری</strong>
           <span className="lwz-muted">لینک شارژ کسری کیف پول را برای مشتری ارسال کنید؛ شارژ بدون تأیید پرداخت انجام نمی‌شود.</span>
           <button type="button" className="btn btn-gold" disabled={sharePending || Boolean(shareUrl)} onClick={createShareLink}>{sharePending ? 'در حال ارسال…' : shareSmsSent ? 'پیامک ارسال شد' : 'ارسال لینک شارژ کیف پول (پیامک)'}</button>
           {shareSmsSent && <span role="status" className="lwz-ok">لینک شارژ با پیامک برای مشتری ارسال شد.</span>}
           {shareUrl && <><span>مبلغ لینک: <strong>{BigInt(shareAmount || '0').toLocaleString('fa-IR')} تومان</strong></span><div className="wallet-share-link"><div><input readOnly dir="ltr" value={shareUrl} aria-label="لینک شارژ" /><button type="button" className="btn btn-ghost" onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); } catch { setFeeError('کپی لینک انجام نشد؛ لینک را به‌صورت دستی از کادر انتخاب و کپی کنید.'); } }}><Copy size={16} /> کپی</button></div></div><button type="button" className="btn btn-ghost" onClick={() => refetch()}><RefreshCw size={16} /> به‌روزرسانی موجودی پس از پرداخت</button></>}
         </div>}
        {feeChargeId && <p role="status" className="lwz-note ok" data-testid="filing-fee-locked"><CheckCircle2 size={18} aria-hidden="true" /> <b>انجام‌شده.</b> هزینه همین طرح ثبت شد؛ طرح، شرط و مبلغ قفل شدند و می‌توانید مدارک پرونده را تکمیل کنید.</p>}
      </>
    )}
    <div className="form-footer">
      <button type="button" className="btn btn-ghost" onClick={onPrev}><ChevronRight size={18} /> قبلی</button>
      {!feeChargeId && <button type="button" className="btn btn-primary" disabled={!plan || (!affordable && !hasPendingKey) || pending} onClick={pay} data-testid="btn-pay-filing-fee">{pending ? 'در حال ثبت...' : hasPendingKey ? 'بازیابی نتیجه پرداخت و ادامه' : 'کسر هزینه و ادامه'}</button>}
      {feeChargeId && <button type="button" className="btn btn-primary" onClick={onNext} data-testid="btn-next-fee">ادامه <ChevronLeft size={18} /></button>}
    </div>
  </div>;
}

// --- Step 1 ---
function Step1Customer({ search, setSearch, customers, loading, selectedCustomer, setSelectedCustomer, onNext }: any) {
  const [attempted, setAttempted] = useState(false);
  const filteredCustomers = rankExactCustomerId(customers.filter((c: any) =>
    matchesCustomerSearch(search, { id: c.id, name: c.name, phone: c.phone, extra: [c.nationalCode] })
  ), search, (c: any) => c.id);

  return (
    <div className="lwz-step" data-testid="wizard-step-1">
      <label className="lwz-search">
        <Search size={20} aria-hidden="true" />
        <span className="lwz-sr">جستجوی مشتری</span>
        <input
          type="search"
          placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          data-testid="input-customer-search"
        />
      </label>
      <div className="lwz-opts" role="radiogroup" aria-label="مشتریان" aria-describedby={attempted && !selectedCustomer ? 'err-selected-customer' : undefined}>
        {loading ? (
           <div className="lwz-loading" role="status">در حال جستجو...</div>
        ) : filteredCustomers.map((c: any) => (
          <label key={c.id} className={`lwz-opt${selectedCustomer?.id === c.id ? ' on' : ''}`} data-testid={`wizard-customer-option-${c.id}`}>
            <input type="radio" name="customer" checked={selectedCustomer?.id === c.id} onChange={() => setSelectedCustomer(c)} />
            <span className="txt">
              <strong><CustomerName id={c.id} name={c.name} /></strong>
              <small><bdi dir="ltr">{c.phone}</bdi> · {c.nationalCode || "بدون کدملی"}</small>
              <small>کارشناس فروش: {c.salespersonName || "بدون تخصیص"}</small>
            </span>
            {c.verificationStatus === 'verified' ? <span className="lwz-ok lwz-badge"><CheckCircle2 size={16} aria-hidden="true" /> احراز شده</span> : <span className="lwz-muted lwz-badge">احراز نشده</span>}
          </label>
        ))}
        {!loading && filteredCustomers.length === 0 && (
          <div className="lwz-loading">مشتری یافت نشد. مشتری جدید را از بخش «مشتریان» ثبت کنید.</div>
        )}
      </div>
      {attempted && !selectedCustomer && <small role="alert" className="lwz-err" id="err-selected-customer" data-testid="error-selected-customer">برای ادامه یک مشتری را انتخاب کنید.</small>}
      <div className="form-footer">
        <span />
        <button type="button" className="btn btn-primary" onClick={() => { setAttempted(true); if (selectedCustomer) onNext(); }} data-testid="btn-next-1">
          ادامه <ChevronLeft size={18} />
        </button>
      </div>
    </div>
  );
}

// --- Step 2 ---
function Step2ProfileAndCredit({ customer, onNext, onPrev, onCustomerUpdate, canIgnoreCreditRank, ignoreCreditRank, onIgnoreCreditRankChange, previewLocked, part = 0, onExitToCustomer }: any) {
  const queryClient = useQueryClient();
  const updateCustomer = useUpdateCustomer();
  const verifyIdentity = useVerifyCustomerIdentity();
  
  const [form, setForm] = useState({
    nationalCode: customer.nationalCode || '',
    phone: customer.phone || '',
    birthDateJalali: customer.birthDateJalali || '',
    postalCode: customer.postalCode || ''
  });
  const [editMode, setEditing] = useState(!customer.nationalCode || !customer.birthDateJalali);
  const [verifyResult, setVerifyResult] = useState<CustomerVerificationResult | null>(null);
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [profileError, setProfileError] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [identityInquiryFailed, setIdentityInquiryFailed] = useState(customer.verificationStatus !== 'verified' && Boolean(customer.verificationCheckedAt));
  const [manualRequestAttempted, setManualRequestAttempted] = useState(false);
  const [manualRequestPending, setManualRequestPending] = useState(false);
  const [manualRequestMessage, setManualRequestMessage] = useState('');
  const [manualRequestError, setManualRequestError] = useState(false);
  const customerRefresh = useGetCustomer(customer.id, {
    query: { queryKey: ["wizard-customer-refresh", customer.id], enabled: !editMode, staleTime: 0, refetchInterval: !editMode && customer.verificationStatus !== 'verified' && customer.verificationCheckedAt ? 10000 : false },
  });
  const verificationChecks = verifyResult?.checks ?? customer.verificationChecks;
  const officialIdentity = {
    firstName: verifyResult?.canonical?.officialFirstName ?? customer.officialFirstName ?? '',
    lastName: verifyResult?.canonical?.officialLastName ?? customer.officialLastName ?? '',
    fatherName: verifyResult?.canonical?.officialFatherName ?? customer.officialFatherName ?? '',
    address: verifyResult?.canonical?.officialAddress ?? customer.officialAddress ?? '',
    postalCode: verifyResult?.canonical?.officialPostalCode ?? customer.officialPostalCode ?? '',
  };
  const checkRows = [
    ['shahkarLite', 'تطبیق مالکیت موبایل (شاهکار)'],
    ['personInfo', 'اطلاعات هویتی ثبت احوال'],
    ['postalCodeInfo', 'نشانی و کد پستی'],
    ['sana', 'عضویت سامانه ثنا'],
  ] as const;

  const isVerified = customer.verificationStatus === 'verified';
  const lastVerificationCheckedAt = verifyResult?.checkedAt ?? customer.verificationCheckedAt;

  useEffect(() => {
    const latest = customerRefresh.data;
    if (!latest || latest.id !== customer.id) return;
    if (verifyResult?.checkedAt && latest.verificationCheckedAt &&
        new Date(latest.verificationCheckedAt).getTime() < new Date(verifyResult.checkedAt).getTime()) return;
    onCustomerUpdate(latest);
    setVerifyResult(null);
    setVerifyError('');
    setIdentityInquiryFailed(latest.verificationStatus !== 'verified' && Boolean(latest.verificationCheckedAt));
    if (!editMode) setForm({
      nationalCode: latest.nationalCode || '', phone: latest.phone || '',
      birthDateJalali: latest.birthDateJalali || '', postalCode: latest.postalCode || '',
    });
    if (latest.verificationStatus === 'verified') {
      setManualRequestPending(false);
      setManualRequestMessage('بررسی دستی انجام شد و وضعیت هویت مشتری به‌روزرسانی شد.');
      setIdentityInquiryFailed(false);
      setManualRequestAttempted(false);
    }
  }, [customerRefresh.data, customer.id]);

  const validateProfile = () => {
    const errors: Record<string, string> = {};
    if (!validateIranianNationalCode(form.nationalCode)) errors.nationalCode = 'کد ملی ۱۰ رقمی معتبر وارد کنید.';
    if (!validateIranianMobile(form.phone)) errors.phone = 'شماره همراه باید با ۰۹ شروع شود و ۱۱ رقم باشد.';
    if (!validateJalaliBirthDate(form.birthDateJalali)) errors.birthDateJalali = 'تاریخ تولد شمسی معتبر و در گذشته وارد کنید.';
    if (!validateIranianPostalCode(form.postalCode)) errors.postalCode = 'کد پستی باید ۱۰ رقم باشد.';
    setProfileErrors(errors);
    return errors;
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError('');
    if (Object.keys(validateProfile()).length) return;
    updateCustomer.mutate({
      id: customer.id,
      data: {
        nationalCode: normalizeDigits(form.nationalCode.trim()),
        phone: normalizeDigits(form.phone.trim()),
        birthDateJalali: form.birthDateJalali.trim(),
        postalCode: form.postalCode.trim() ? normalizeDigits(form.postalCode.trim()) : null,
      }
    }, {
      onSuccess: (updated) => {
        onCustomerUpdate(updated);
        setEditing(false);
        if (part === 0) onNext();
        setProfileErrors({});
        setVerifyResult(null);
        setVerifyError('');
        setIdentityInquiryFailed(updated.verificationStatus !== 'verified' && Boolean(updated.verificationCheckedAt));
      },
      onError: (error) => {
        const mapped = serverFieldErrors(error);
        setProfileErrors(current => ({ ...current, ...mapped }));
        setProfileError(Object.keys(mapped).length ? '' : apiErrorMessage(error, 'ذخیره اطلاعات انجام نشد. دوباره تلاش کنید.'));
      },
    });
  };

  const doVerify = () => {
    setVerifyError('');
    if (editMode || isVerified) return;
    if (Object.keys(validateProfile()).length) {
      setEditing(true);
      return;
    }
    setIdentityInquiryFailed(false);
    verifyIdentity.mutate({ id: customer.id }, {
      onSuccess: (res) => {
        setVerifyResult(res);
        if (res.status === 'failed') {
          setIdentityInquiryFailed(true);
        }
        queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
        void customerRefresh.refetch();
        const firstName = res.canonical.officialFirstName ?? customer.firstName ?? null;
        const lastName = res.canonical.officialLastName ?? customer.lastName ?? null;
        const verifiedName = [firstName, lastName].filter(Boolean).join(' ') || customer.name;
        onCustomerUpdate({
          ...customer,
          name: verifiedName,
          firstName,
          lastName,
          fatherName: res.canonical.officialFatherName ?? customer.fatherName ?? null,
          address: res.canonical.officialAddress ?? customer.address ?? null,
          postalCode: res.canonical.officialPostalCode ?? customer.postalCode ?? null,
          verificationStatus: res.status === 'verified' ? 'verified' : 'unverified',
          verificationCheckedAt: res.checkedAt,
          verificationChecks: res.checks,
          officialFirstName: res.canonical.officialFirstName ?? customer.officialFirstName ?? null,
          officialLastName: res.canonical.officialLastName ?? customer.officialLastName ?? null,
          officialFatherName: res.canonical.officialFatherName ?? customer.officialFatherName ?? null,
          officialAddress: res.canonical.officialAddress ?? customer.officialAddress ?? null,
          officialPostalCode: res.canonical.officialPostalCode ?? customer.officialPostalCode ?? null,
        });
      },
      onError: (error) => {
        setIdentityInquiryFailed(true);
        setVerifyError(apiErrorMessage(error, 'استعلام سرویس‌های هویتی انجام نشد یا سرویس در دسترس نیست.'));
      },
    });
  };

  const submitManualVerificationRequest = async () => {
    if (manualRequestAttempted || manualRequestPending || !identityInquiryFailed || !validateIranianNationalCode(form.nationalCode)
      || !validateIranianMobile(form.phone) || !validateJalaliBirthDate(form.birthDateJalali)) return;
    setManualRequestAttempted(true);
    setManualRequestPending(true);
    setManualRequestMessage('');
    setManualRequestError(false);
    try {
      const response = await fetch(`/api/customers/${customer.id}/manual-verification-requests`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage({ data: body }, 'ارسال درخواست بررسی دستی انجام نشد.'));
      const isPending = body.status !== 'resolved' && body.status !== 'approved' && body.status !== 'completed' && body.pending !== false;
      setManualRequestPending(isPending);
      setManualRequestMessage(isPending
         ? 'فقط موارد ناموفق برای بررسی به مدیر ارسال شد و در انتظار رسیدگی است. تأیید سایر موارد حفظ می‌شود. این فرایند شامل رتبه اعتباری نیست.'
        : 'درخواست بررسی دستی ثبت شد. این فرایند فقط چهار بررسی هویتی را پوشش می‌دهد و شامل رتبه اعتباری نیست.');
      void queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      void customerRefresh.refetch();
    } catch (error) {
      setManualRequestPending(false);
      setManualRequestError(true);
      setManualRequestMessage(apiErrorMessage(error, 'ارسال درخواست بررسی دستی انجام نشد.'));
    }
  };

  // Credit checks
  const { data: creditChecks, refetch: refetchCredits, isError: creditChecksError } = useListCustomerCreditChecks(customer.id, {
     query: { queryKey: ["credit-checks", customer.id], enabled: isVerified }
  });
  const initiateCredit = useInitiateCustomerCreditCheck();
  const validateCredit = useValidateCustomerCreditCheck();
  const renewCredit = useRenewCustomerCreditCheckOtp();
  const refreshCredit = useRefreshCustomerCreditCheckStatus();
  const [creditOtp, setCreditOtp] = useState('');
  const [creditError, setCreditError] = useState('');
  const [creditOtpError, setCreditOtpError] = useState('');
  
  const latestCredit = creditChecks?.[0];
  const listedFreshCredit = creditChecks?.find((check) =>
    check.status === "report_generated" &&
    Date.now() - new Date(check.completedAt || check.updatedAt).getTime() < 24 * 60 * 60 * 1000
  );
  // The plan step trusts the server's credit rule, which also discards an
  // inquiry taken before the customer's identity changed (for example when
  // the customer completes their profile in the portal). Mirror that verdict
  // here so this step never shows a rank the plan step will refuse to use.
  const { data: serverCredit, refetch: refetchServerCredit } = useListCustomerEligiblePlans(customer.id, { ignoreCreditRank: false }, {
    query: { queryKey: ["eligible-plans", customer.id, false], enabled: isVerified, staleTime: 0 }
  });
  useEffect(() => {
    if (isVerified) void refetchServerCredit();
  }, [isVerified, listedFreshCredit?.id, listedFreshCredit?.status]);
  const hasFreshCredit = serverCredit ? serverCredit.credit.fresh : Boolean(listedFreshCredit);
  const creditStaleAfterIdentityChange = Boolean(listedFreshCredit) && Boolean(serverCredit) && !serverCredit?.credit.fresh;
  const freshCreditRank = serverCredit?.credit.fresh ? serverCredit.credit.rank : listedFreshCredit?.scoreLabel;
  const freshCreditAt = serverCredit?.credit.fresh ? serverCredit.credit.checkedAt : (listedFreshCredit?.completedAt || listedFreshCredit?.updatedAt);

  useEffect(() => {
    if (!latestCredit || (latestCredit.status !== 'processing' && latestCredit.status !== 'awaiting_otp')) return undefined;
    const checkStatus = () => refreshCredit.mutate({ id: customer.id, checkId: latestCredit.id }, {
      onSuccess: () => refetchCredits(),
      onError: (error) => setCreditError(apiErrorMessage(error, 'دریافت وضعیت استعلام اعتبارسنجی انجام نشد.')),
    });
    if (latestCredit.status === 'awaiting_otp') checkStatus();
    const timer = window.setInterval(checkStatus, latestCredit.status === 'processing' ? 10000 : 30000);
    return () => window.clearInterval(timer);
  }, [latestCredit?.id, latestCredit?.status]);

  const startCreditCheck = () => {
    setCreditError('');
    initiateCredit.mutate(
      { id: customer.id, data: { nationalCode: normalizeDigits(form.nationalCode!) } },
      {
        onSuccess: () => refetchCredits(),
        onError: (error) => {
          setCreditError(apiErrorMessage(error, 'شروع استعلام اعتبارسنجی انجام نشد.'));
          refetchCredits();
        },
      },
    );
  };

  const confirmCreditOtp = (event: React.FormEvent) => {
    event.preventDefault();
    if (!latestCredit || latestCredit.status !== 'awaiting_otp') return;
    if (!validateOtp(creditOtp)) {
      setCreditOtpError('کد یک‌بارمصرف باید بین ۴ تا ۸ رقم باشد.');
      return;
    }
    setCreditOtpError('');
    setCreditError('');
    validateCredit.mutate(
      {
        id: customer.id,
        checkId: latestCredit.id,
        data: { otp: normalizeDigits(creditOtp.trim()) },
      },
      {
        onSuccess: () => {
          setCreditOtp('');
          refetchCredits();
        },
        onError: (error) => {
          setCreditError(apiErrorMessage(error, 'تأیید کد اعتبارسنجی انجام نشد.'));
          setCreditOtpError(serverFieldErrors(error).otp ?? '');
          refetchCredits();
        },
      },
    );
  };

  const resendCreditOtp = () => {
    if (!latestCredit || latestCredit.status !== 'awaiting_otp') return;
    setCreditError('');
    renewCredit.mutate(
      { id: customer.id, checkId: latestCredit.id },
      {
        onSuccess: () => refetchCredits(),
        onError: (error) => {
          setCreditError(apiErrorMessage(error, 'ارسال مجدد کد انجام نشد.'));
        },
      },
    );
  };

  const isReadyForNext = isVerified && (hasFreshCredit || ignoreCreditRank);
  const [partAttempted, setPartAttempted] = useState(false);
  useEffect(() => { setPartAttempted(false); }, [part]);
  const profileFormId = `wizard-profile-form-${customer.id}`;
  const continuePart = () => {
    setPartAttempted(true);
    if (part === 0) {
      if (editMode) return;
      if (Object.keys(validateProfile()).length) { setEditing(true); return; }
      onNext();
    } else if (part === 1) {
      if (isVerified) onNext();
    } else if (isReadyForNext) {
      onNext();
    }
  };
  const prevButton = part === 0 && onExitToCustomer
    ? <button type="button" className="btn btn-ghost" onClick={onExitToCustomer} data-testid="btn-back-to-customer"><ChevronRight size={18} /> پرونده مشتری</button>
    : <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid="btn-prev-2"><ChevronRight size={18} /> قبلی</button>;
  const fieldError = (key: string) => profileErrors[key] ? <small className="lwz-err" role="alert" id={`err-profile-${key}`}>{profileErrors[key]}</small> : null;

  return (
    <div className="lwz-step" data-testid="wizard-step-2" data-part={part}>
      {part === 0 && (editMode ? (
        <form id={profileFormId} noValidate onSubmit={handleSaveProfile} className="lwz-form" data-testid="wizard-profile-form">
          {customer.verificationCheckedAt ? <p className="lwz-note warn" role="note"><AlertCircle size={18} aria-hidden="true" /> تغییر این اطلاعات، احراز هویت قبلی مشتری را باطل می‌کند.</p> : null}
          <div className="field"><label htmlFor="wz-national-code">کد ملی</label><input id="wz-national-code" dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={e => { setForm({...form, nationalCode: e.target.value}); setProfileErrors(current => ({ ...current, nationalCode: '' })); }} aria-invalid={Boolean(profileErrors.nationalCode)} aria-describedby={profileErrors.nationalCode ? 'err-profile-nationalCode' : undefined} data-testid="input-national-code" />{fieldError('nationalCode')}</div>
          <div className="field"><label htmlFor="wz-phone">شماره همراه</label><input id="wz-phone" dir="ltr" inputMode="tel" value={form.phone} onChange={e => { setForm({...form, phone: e.target.value}); setProfileErrors(current => ({ ...current, phone: '' })); }} aria-invalid={Boolean(profileErrors.phone)} aria-describedby={profileErrors.phone ? 'err-profile-phone' : undefined} data-testid="input-phone" />{fieldError('phone')}</div>
          <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={v => { setForm({...form, birthDateJalali: v}); setProfileErrors(current => ({ ...current, birthDateJalali: '' })); }} testId="input-birth-date" birthDate />{fieldError('birthDateJalali')}</div>
          <div className="field"><label htmlFor="wz-postal-code">کد پستی</label><input id="wz-postal-code" dir="ltr" inputMode="numeric" value={form.postalCode} onChange={e => { setForm({...form, postalCode: e.target.value}); setProfileErrors(current => ({ ...current, postalCode: '' })); }} aria-invalid={Boolean(profileErrors.postalCode)} aria-describedby={profileErrors.postalCode ? 'err-profile-postalCode' : undefined} data-testid="input-postal-code" />{fieldError('postalCode')}</div>
          {profileError && <div className="profile-form-error" role="alert" data-testid="error-save-profile">{profileError}</div>}
        </form>
      ) : (
        <div className="lwz-card">
          <div className="lwz-cardh"><strong>اطلاعات ثبت‌شده</strong>
            {!isVerified && <button type="button" className="text-link" onClick={() => setEditing(true)} data-testid="btn-edit-profile">ویرایش</button>}
          </div>
          <dl className="lwz-kv">
            <div><dt>کد ملی</dt><dd data-testid="display-national-code">{customer.nationalCode}</dd></div>
            <div><dt>شماره همراه</dt><dd dir="ltr" data-testid="display-phone">{customer.phone}</dd></div>
            <div><dt>تاریخ تولد</dt><dd data-testid="display-birth-date">{customer.birthDateJalali}</dd></div>
            <div><dt>کد پستی</dt><dd dir="ltr">{customer.postalCode || '—'}</dd></div>
            <div><dt>وضعیت هویت</dt><dd>{isVerified ? <span className="lwz-ok" data-testid="status-verified">احراز شده</span> : <span className="lwz-warn" data-testid="status-unverified">احراز نشده</span>}</dd></div>
          </dl>
        </div>
      ))}

      {part === 1 && <div className="lwz-card" data-testid="wizard-identity-verify">
        {!isVerified && <p className="lwz-muted">جهت ادامه، باید هویت مشتری (شاهکار، ثبت احوال، ثنا و نشانی) احراز شود.</p>}
        {lastVerificationCheckedAt && <p className="lwz-muted" data-testid="last-verification-time">آخرین استعلام: {formatDateTime(lastVerificationCheckedAt)}</p>}
        <button type="button" className="btn btn-primary lwz-wide" onClick={doVerify} disabled={isVerified || editMode || verifyIdentity.isPending} data-testid="btn-verify-identity">
          {verifyIdentity.isPending
            ? 'در حال استعلام...'
            : isVerified ? 'هویت مشتری تأیید شده است'
            : lastVerificationCheckedAt
              ? 'تلاش دوباره فقط برای موارد ناموفق'
              : 'استعلام و احراز هویت'}
        </button>
        {editMode && <p className="lwz-note warn" role="alert">اطلاعات هویتی کامل یا معتبر نیست. به مرحله قبل برگردید و اطلاعات را اصلاح کنید.</p>}
        {verifyError && <div role="alert" className="lwz-err" data-testid="verify-error">{verifyError}</div>}
        {identityInquiryFailed && !editMode && validateIranianNationalCode(form.nationalCode) && validateIranianMobile(form.phone) && validateJalaliBirthDate(form.birthDateJalali) && (
          <div className="lwz-manual">
            <p className="lwz-muted">موارد موفق تأیید شده‌اند. فقط موارد قرمز به ادمین ارجاع می‌شوند؛ رتبهٔ اعتباری قابل تأیید دستی نیست.</p>
            <button type="button" className="btn btn-ghost" onClick={submitManualVerificationRequest} disabled={manualRequestAttempted || manualRequestPending} data-testid="btn-manual-verification-request">
              {manualRequestPending ? 'در انتظار بررسی مدیر...' : 'ارسال به ادمین برای بررسی دستی'}
            </button>
            {manualRequestMessage && <div role={manualRequestPending ? 'status' : manualRequestError ? 'alert' : 'status'} className={manualRequestPending ? 'lwz-warn' : manualRequestError ? 'lwz-err' : 'lwz-ok'} data-testid="manual-verification-request-status">{manualRequestMessage}</div>}
          </div>
        )}
        <ul className="lwz-checks" data-testid="identity-checks">
          {checkRows.map(([key, label]) => {
            const check = verificationChecks?.[key];
            const ok = check?.ok === true;
            const providerStatus = typeof check?.providerStatus === 'string' ? check.providerStatus.toLowerCase() : '';
            const providerStatusMessage = !ok && providerStatus && !['ok', 'success', 'verified', 'completed'].includes(providerStatus)
              ? providerStatus.includes('unavailable') || providerStatus.includes('timeout')
                ? 'سرویس استعلام پاسخ‌گو یا در دسترس نبود.'
                : 'استعلام این سرویس ناموفق بود.'
              : '';
            return (
              <li key={key} className={ok ? 'ok' : check ? 'bad' : 'idle'} data-testid={`identity-check-${key}`}>
                <span>{label}</span>
                <b>{ok ? <CheckCircle2 size={18} /> : check ? <XCircle size={18} /> : null}{ok ? 'تأیید شد' : check ? 'تأیید نشد' : 'استعلام نشده'}</b>
                {providerStatusMessage && <small>{providerStatusMessage}</small>}
              </li>
            );
          })}
        </ul>
        <div className="lwz-official">
          <strong>نتیجه رسمی استعلام</strong>
          <dl className="lwz-kv">
            <div><dt>نام رسمی</dt><dd data-testid="official-first-name">{officialIdentity.firstName || '—'}</dd></div>
            <div><dt>نام خانوادگی رسمی</dt><dd data-testid="official-last-name">{officialIdentity.lastName || '—'}</dd></div>
            <div><dt>نام پدر</dt><dd data-testid="official-father-name">{officialIdentity.fatherName || '—'}</dd></div>
            <div><dt>کد پستی رسمی</dt><dd dir="ltr" data-testid="official-postal-code">{officialIdentity.postalCode || '—'}</dd></div>
            <div className="full"><dt>نشانی رسمی</dt><dd data-testid="official-address">{officialIdentity.address || '—'}</dd></div>
          </dl>
        </div>
        {partAttempted && !isVerified && <p className="lwz-err" role="alert" data-testid="error-identity-required">برای ادامه، هویت مشتری باید احراز شود.</p>}
      </div>}

      {part === 2 && <div className="lwz-card" data-testid="wizard-credit">
        {canIgnoreCreditRank && <div className="lwz-toggle">
          <label>
            <input type="checkbox" checked={ignoreCreditRank} onChange={(event) => onIgnoreCreditRankChange(event.target.checked)} data-testid="checkbox-ignore-credit-rank" />
            عدم در نظر گرفتن رتبه اعتباری در تمام مراحل پرونده
          </label>
          <p className="lwz-muted">با فعال کردن این گزینه، رتبه و تازگی استعلام در ادامهٔ همین پرونده بررسی نمی‌شوند؛ احراز هویت، سقف مبلغ، اقساط مجاز و مدارک همچنان الزامی‌اند.{previewLocked ? ' طرح پرداخت‌شده همچنان قفل است.' : ''}</p>
        </div>}
        {creditError && <div className="profile-form-error" data-testid="credit-check-error">{creditError}</div>}
        {creditChecksError && <div className="profile-form-error" role="alert" data-testid="credit-list-error">دریافت سابقه استعلام اعتبارسنجی انجام نشد. وضعیت اتصال سرویس را بررسی و دوباره تلاش کنید.</div>}
        {latestCredit?.status === 'failed' && latestCredit.errorMessage && (
          <div className="profile-form-error" role="alert" data-testid="credit-latest-error">
            {apiErrorMessage({ data: { message: latestCredit.errorMessage } }, latestCredit.errorMessage)}
          </div>
        )}
        {!isVerified ? <p className="lwz-note warn" role="note">ابتدا هویت مشتری باید احراز شود.</p> : hasFreshCredit ? (
          <div className="lwz-result ok" data-testid="credit-status-fresh">
            <ShieldCheck size={28} aria-hidden="true" />
            <div>
              <strong>رتبه اعتباری: {freshCreditRank || 'نامشخص'}</strong>
              <span>بروزرسانی: {formatDateTime(freshCreditAt)} · اعتبار ۲۴ ساعت</span>
            </div>
          </div>
        ) : latestCredit?.status === 'awaiting_otp' ? (
          <form onSubmit={confirmCreditOtp} className="lwz-otp" data-testid="credit-status-otp">
            <strong>نیاز به تأیید پیامکی</strong>
            <p className="lwz-muted">کد اعتبارسنجی ارسال‌شده به موبایل مشتری را همین‌جا وارد کنید.</p>
            <div className="field">
              <label htmlFor="wz-credit-otp">کد اعتبارسنجی</label>
              <input id="wz-credit-otp" dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={creditOtp}
                onChange={(event) => { setCreditOtp(normalizeDigits(event.target.value).replace(/\D/g, '').slice(0, 8)); setCreditOtpError(''); }}
                minLength={4} maxLength={8} aria-invalid={Boolean(creditOtpError)} aria-describedby={creditOtpError ? 'err-credit-otp' : undefined} data-testid="input-credit-otp" />
              {creditOtpError && <small className="lwz-err" role="alert" id="err-credit-otp" data-testid="error-credit-otp">{creditOtpError}</small>}
            </div>
            <div className="lwz-row">
              <button type="submit" className="btn btn-gold" disabled={validateCredit.isPending} data-testid="btn-confirm-credit-otp">
                {validateCredit.isPending ? 'در حال بررسی...' : 'تأیید و دریافت رتبه اعتباری'}
              </button>
              <button type="button" className="text-link" onClick={resendCreditOtp} disabled={renewCredit.isPending} data-testid="btn-resend-credit-otp">
                {renewCredit.isPending ? 'در حال ارسال...' : 'ارسال مجدد کد'}
              </button>
            </div>
          </form>
        ) : latestCredit?.status === 'processing' ? (
          <div className="lwz-result" data-testid="credit-status-processing">
            <RefreshCw size={22} className="spin" aria-hidden="true" />
            <div><strong>در حال دریافت رتبه اعتباری...</strong><span>نتیجه به‌صورت خودکار نمایش داده می‌شود.</span></div>
          </div>
        ) : (
          <div className="lwz-start">
            {creditStaleAfterIdentityChange && (
              <p className="lwz-note warn" role="note" data-testid="credit-stale-identity">
                اطلاعات هویتی مشتری بعد از آخرین استعلام (رتبه {listedFreshCredit?.scoreLabel || 'نامشخص'}) تغییر کرده است؛ آن نتیجه دیگر برای انتخاب طرح معتبر نیست و استعلام تازه لازم است.
              </p>
            )}
            <p className="lwz-muted">برای انتخاب طرح تسهیلاتی، رتبه اعتباری ۲۴ ساعت اخیر الزامی است. کد یک‌بارمصرف به موبایل مشتری ارسال می‌شود.</p>
            <button type="button" className="btn btn-gold lwz-wide" onClick={startCreditCheck} disabled={initiateCredit.isPending} data-testid="btn-start-credit-check">
              {initiateCredit.isPending ? 'در حال ارسال...' : 'استعلام رتبه اعتباری'}
            </button>
          </div>
        )}
        {partAttempted && !isReadyForNext && isVerified && <p className="lwz-err" role="alert" data-testid="error-credit-required">برای ادامه، رتبه اعتباری ۲۴ ساعت اخیر لازم است.</p>}
      </div>}

      <div className="form-footer">
        {prevButton}
        {part === 0 && editMode
          ? <button type="submit" form={profileFormId} className="btn btn-primary" disabled={updateCustomer.isPending} data-testid="btn-save-profile">{updateCustomer.isPending ? 'در حال ذخیره...' : 'ذخیره و ادامه'} <ChevronLeft size={18} /></button>
          : <button type="button" className="btn btn-primary" onClick={continuePart} data-testid={part === 2 ? 'btn-next-2' : `btn-next-2-${part}`}>ادامه <ChevronLeft size={18} /></button>}
      </div>
    </div>
  );
}

// --- Step 3 ---
const GUARANTOR_SOURCE_LABEL: Record<string, string> = { consultation: 'فرم مشاوره', call_form: 'فرم تماس اول' };
function GuarantorGradeLine({ guarantor, waived }: { guarantor?: { rank: string | null; hasGuarantor: boolean | null; source: string | null } | null; waived: boolean }) {
  if (waived) return null;
  const source = guarantor?.source ? ` (${GUARANTOR_SOURCE_LABEL[guarantor.source] ?? guarantor.source})` : '';
  const text = !guarantor?.source
    ? 'رتبهٔ ضامن هنوز اعلام نشده؛ شرط‌هایی که رتبهٔ ضامن می‌خواهند با یادداشت نمایش داده می‌شوند.'
    : guarantor.rank
      ? `رتبهٔ ضامن: ${guarantor.rank}${source}؛ شرط‌هایی که این رتبه را نمی‌پذیرند حذف شده‌اند.`
      : guarantor.hasGuarantor === false
        ? `ضامن ندارد${source}؛ شرط‌های نیازمند ضامن با یادداشت نمایش داده می‌شوند.`
        : `رتبهٔ ضامن مشخص نیست${source}؛ شرط‌هایی که رتبهٔ ضامن می‌خواهند با یادداشت نمایش داده می‌شوند.`;
  return <p className="lwz-muted" role="note" data-testid="guarantor-grade-line">{text}</p>;
}
type Step3PlanAndTermsProps = {
  ignoreCreditRank: boolean;
  overrideReason?: string;
  customer: Customer;
  selectedPlanId: number | null;
  selectedPlan: CustomerEligiblePlan | null;
  onSelectPlanGroup: (planId: number) => void;
  onSelectPlan: (plan: CustomerEligiblePlan) => void;
  planLocked: boolean;
  feeRecoveryPending: boolean;
  amount: string;
  setAmount: React.Dispatch<React.SetStateAction<string>>;
  duration: string;
  setDuration: React.Dispatch<React.SetStateAction<string>>;
  attempted: boolean;
  onAttempt: () => void;
  onNext: () => void;
  onPrev: () => void;
  part?: number;
};

function Step3PlanAndTerms({ customer, selectedPlanId, selectedPlan, onSelectPlanGroup, onSelectPlan, planLocked, feeRecoveryPending, amount, setAmount, duration, setDuration, onNext, onPrev, attempted, onAttempt, ignoreCreditRank, overrideReason, part = 0 }: Step3PlanAndTermsProps) {
  const [planAttempted, setPlanAttempted] = useState(false);
  const planTried = attempted || planAttempted;
  const { data: eligibleResponse, isLoading, isError, refetch } = useListCustomerEligiblePlans(customer.id, { ignoreCreditRank, creditRankOverrideReason: overrideReason }, {
    query: { queryKey: ["eligible-plans", customer.id, ignoreCreditRank, overrideReason ?? null], staleTime: 0 }
  });
  
  const eligibleMatches = eligibleResponse?.plans || [];
  const groupedPlans = Array.from(eligibleMatches.reduce((groups, match) => {
    const matches = groups.get(match.planId) ?? [];
    matches.push(match);
    groups.set(match.planId, matches);
    return groups;
  }, new Map<number, CustomerEligiblePlan[]>()).values());
  const selectedGroup = groupedPlans.find((matches) => matches[0].planId === selectedPlanId);
  const currentCondition = selectedGroup?.find((match) => match.conditionId === selectedPlan?.conditionId);
  const maximumAmount = Number(selectedPlan?.maximumAmount || 0);
  const amountStep = maximumAmount >= 100_000_000
    ? 1_000_000
    : maximumAmount >= 10_000_000
      ? 100_000
      : 10_000;
  const minimumAmount = maximumAmount > 0 ? Math.min(amountStep, maximumAmount) : amountStep;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
      .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
      .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[^0-9]/g, '');
    if (selectedPlan && raw) {
       if (maximumAmount > 0 && Number(raw) > maximumAmount) {
          setAmount(String(maximumAmount));
          return;
       }
    }
    setAmount(raw);
  };

  const amountDisplay = amount ? Number(amount).toLocaleString('fa-IR') : '';
  const amountError = !currentCondition
    ? 'برای ادامه یکی از شروط طرح را انتخاب کنید.'
    : !amount || !Number.isFinite(Number(amount)) || Number(amount) < minimumAmount || (maximumAmount > 0 && Number(amount) > maximumAmount)
      ? `مبلغ باید بین ${minimumAmount.toLocaleString('fa-IR')} تا ${maximumAmount.toLocaleString('fa-IR')} تومان باشد.`
      : '';
  const durationError = !currentCondition?.allowedDurations?.some((value: number) => String(value) === duration)
    ? 'مدت بازپرداخت را از گزینه‌های شرط انتخاب‌شده انتخاب کنید.'
    : '';
  const continueTerms = () => {
    if (!eligibleResponse || (!ignoreCreditRank && !eligibleResponse.credit.fresh)) return;
    onAttempt();
    if (!amountError && !durationError) onNext();
  };

  const continuePlan = () => {
    setPlanAttempted(true);
    if (currentCondition) onNext();
  };

  return (
    <div className="lwz-step" data-testid="wizard-step-3" data-part={part}>
      {part === 0 && <>
      {ignoreCreditRank && <div role="status" className="lwz-note warn">انتخاب طرح، شرط و ثبت پرونده بدون تطابق رتبه اعتباری؛ این انتخاب در پرونده ثبت می‌شود و سایر کنترل‌های هویتی و مالی برقرارند.</div>}
      {ignoreCreditRank && <p role="status" className="lwz-muted">در این حالت رتبه، نبود نتیجه یا قدیمی بودن استعلام اعتباری مانع ادامه پرونده نمی‌شود؛ کنترل‌های هویتی، مبلغ، اقساط و مدارک برقرارند.</p>}
      {ignoreCreditRank && overrideReason && <p className="lwz-muted" data-testid="override-reason-summary">دلیل ثبت‌شده: «{overrideReason}»</p>}
      {eligibleResponse && <GuarantorGradeLine guarantor={eligibleResponse.guarantor} waived={ignoreCreditRank} />}
      <div className="lwz-plans">
         {isLoading ? (
            <div className="lwz-loading" role="status">در حال بارگذاری طرح‌ها...</div>
          ) : isError ? <div role="alert" className="lwz-note bad">دریافت طرح‌ها ناموفق بود. <button type="button" className="text-link" onClick={() => void refetch()}>تلاش دوباره</button></div> : eligibleMatches.length > 0 ? (
            <div className="lwz-opts" role="group" aria-label="طرح‌های واجد شرایط">
               {groupedPlans.map((matches) => {
                 const plan = matches[0];
                 const planMaximum = Math.max(...matches.map((match) => Number(match.maximumAmount)));
                 return (
                  <button
                    type="button"
                    key={plan.planId}
                    data-testid={`plan-card-${plan.planId}`}
                    onClick={() => onSelectPlanGroup(plan.planId)}
                    disabled={!plan.primaryContractPresent || planLocked}
                    aria-pressed={selectedPlanId === plan.planId}
                    className={`lwz-opt${selectedPlanId === plan.planId ? ' on' : ''}`}
                    style={{ opacity: plan.primaryContractPresent && (!planLocked || selectedPlanId === plan.planId) ? 1 : 0.6 }}
                 >
                    <span className="dot" aria-hidden="true" />
                    <span className="txt">
                       <strong>{plan.name}</strong>
                       <small>تا {planMaximum.toLocaleString('fa-IR')} تومان · {matches.length.toLocaleString('fa-IR')} شرط</small>
                       {!plan.primaryContractPresent && <small className="lwz-err">قرارداد اصلی برای این طرح تعریف نشده است.</small>}
                    </span>
                  </button>
                ); })}
            </div>
         ) : (
             !ignoreCreditRank && eligibleResponse && !eligibleResponse.credit.fresh ? (
               <div className="lwz-note bad" data-testid="empty-plans-stale-credit">
                 <b>رتبه اعتباری معتبر نیست.</b> استعلام ۲۴ ساعت اخیر بعد از آخرین تغییر اطلاعات هویتی مشتری وجود ندارد؛ به مرحله رتبه اعتباری برگردید و استعلام تازه بگیرید.
               </div>
             ) : (
             <div className="lwz-note bad" data-testid="empty-plans">
               <b>طرح واجد شرایطی نیست.</b> با رتبه اعتباری {eligibleResponse?.credit.rank || 'فعلی'}، طرح واجد شرایطی برای ثبت درخواست وجود ندارد.
             </div>
             )
         )}
      </div>
       {planTried && !selectedPlanId && <small role="alert" className="lwz-err" data-testid="error-plan-selection">برای ادامه یک طرح تسهیلاتی انتخاب کنید.</small>}

      {planLocked && (
        <p role="status" className="lwz-note ok">
          {feeRecoveryPending
            ? "نتیجه تلاش پرداخت این طرح باید در مرحله بعد بازیابی شود؛ تا آن زمان طرح قابل تغییر نیست."
            : "هزینه این طرح پرداخت شده است؛ برای جلوگیری از کسر دوباره، طرح انتخاب‌شده قابل تغییر نیست."}
        </p>
      )}

       {selectedGroup && (
         <div className="lwz-conds" data-testid="plan-conditions">
           <strong className="lwz-label">شرط دریافت این طرح را انتخاب کنید</strong>
           <div className="lwz-opts" role="group" aria-label="شروط طرح">
             {selectedGroup.map((condition) => (
               <button type="button" key={condition.conditionId}
                 className={`lwz-opt${currentCondition?.conditionId === condition.conditionId ? ' on' : ''}`}
                 aria-pressed={currentCondition?.conditionId === condition.conditionId}
                 data-testid={`condition-${condition.conditionId}`}
                 disabled={condition.conditionId <= 0 || Number(condition.maximumAmount) <= 0 || !condition.allowedDurations.length}
                 onClick={() => onSelectPlan(condition)}>
                 <span className="dot" aria-hidden="true" />
                 <span className="txt">
                 <strong>{condition.conditionName} · {condition.needsGuarantor ? 'با ضامن' : 'بدون ضامن'}</strong>
                 <small>سقف {Number(condition.maximumAmount).toLocaleString('fa-IR')} تومان · {condition.allowedDurations.map((months) => `${months.toLocaleString('fa-IR')} ماهه`).join('، ')}</small>
                 {condition.conditionNotes && <small>{condition.conditionNotes}</small>}
                 {!ignoreCreditRank && condition.guarantorGradeNote && <small className="lwz-guarantor-note" style={{ color: "var(--warn-ink, #b54708)" }} data-testid={`guarantor-note-${condition.conditionId}`}>{condition.guarantorGradeNote}</small>}
                 </span>
               </button>
             ))}
           </div>
           {planTried && !currentCondition && <small role="alert" className="lwz-err" data-testid="error-condition-selection">یکی از شروط طرح را انتخاب کنید.</small>}
         </div>
       )}
      </>}
       {part === 1 && !currentCondition && !isLoading && <p className="lwz-note warn" role="alert" data-testid="error-terms-condition">برای ادامه یکی از شروط طرح را انتخاب کنید. <button type="button" className="text-link" onClick={onPrev}>بازگشت به «طرح و شرط»</button></p>}
       {part === 1 && currentCondition && (
          <div className="loan-amount-picker">
             <div className="loan-amount-picker-head">
               <div>
                 <span>میزان تسهیلات درخواستی</span>
                 <strong>{amountDisplay || '۰'} <small>تومان</small></strong>
               </div>
               <div className="loan-amount-max">
                 <span>سقف این طرح</span>
                 <strong>{maximumAmount.toLocaleString('fa-IR')} تومان</strong>
               </div>
             </div>

             <div className="loan-amount-input-wrap">
               <input
                 type="text"
                 inputMode="numeric"
                 dir="ltr"
                 value={amountDisplay}
                 onChange={handleAmountChange}
                 aria-label="مبلغ تسهیلات درخواستی"
                 data-testid="input-amount"
               />
               <span>تومان</span>
             </div>
              {attempted && amountError && <small role="alert" className="lwz-err" data-testid="error-amount">{amountError}</small>}

             <input
               className="loan-amount-range"
               type="range"
               dir="rtl"
               min={minimumAmount}
               max={Math.max(maximumAmount, minimumAmount)}
               step={amountStep}
               value={Math.min(Math.max(Number(amount) || minimumAmount, minimumAmount), Math.max(maximumAmount, minimumAmount))}
               onChange={(event) => setAmount(event.target.value)}
               aria-label="انتخاب مبلغ تسهیلات"
               data-testid="range-amount"
             />
             <div className="loan-amount-limits">
               <span>{minimumAmount.toLocaleString('fa-IR')} تومان</span>
               <span>{maximumAmount.toLocaleString('fa-IR')} تومان</span>
             </div>

             <div className="loan-duration-picker">
               <div className="loan-duration-title">
                 <strong>مدت بازپرداخت</strong>
                 <span>{duration ? `${Number(duration).toLocaleString('fa-IR')} ماهه` : 'یک گزینه را انتخاب کنید'}</span>
               </div>
               <div className="loan-duration-options" data-testid="select-duration">
                  {currentCondition.allowedDurations?.map((dur: number) => (
                   <button
                     type="button"
                     key={dur}
                     className={String(dur) === duration ? 'active' : ''}
                     onClick={() => setDuration(String(dur))}
                     data-testid={`duration-${dur}`}
                   >
                     {dur.toLocaleString('fa-IR')} ماهه
                   </button>
                 ))}
               </div>
                {attempted && durationError && <small role="alert" className="lwz-err" data-testid="error-duration">{durationError}</small>}
             </div>
         </div>
      )}

      <div className="form-footer">
        <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid={part === 1 ? 'btn-prev-3' : 'btn-prev-3-0'}><ChevronRight size={18} /> قبلی</button>
        {part === 0
          ? <button type="button" className="btn btn-primary" onClick={continuePlan} disabled={isLoading} data-testid="btn-next-3-0">ادامه <ChevronLeft size={18} /></button>
          : <button type="button" className="btn btn-primary" onClick={continueTerms} disabled={!eligibleResponse || (!ignoreCreditRank && !eligibleResponse.credit.fresh) || isLoading || isError} data-testid="btn-next-3">ادامه <ChevronLeft size={18} /></button>}
      </div>
    </div>
  );
}

// --- Step 4 ---
function Step4IdentityDocs({ customer, onNext, onPrev }: any) {
  const queryClient = useQueryClient();
  const identityDocsQueryKey = getListCustomerIdentityDocumentsQueryKey(customer.id);
  const { data: docsData, isLoading } = useListCustomerIdentityDocuments(customer.id, {
     query: { queryKey: identityDocsQueryKey }
  });
  // Cast due to missing schema issue
  const docs = docsData || [];
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [continueAttempted, setContinueAttempted] = useState(false);

  const requiredTypes = [
     { key: "national_card_front", label: "کارت ملی (روی کارت)" },
     { key: "national_card_back", label: "کارت ملی (پشت کارت)" },
     { key: "birth_cert_p1", label: "شناسنامه (صفحه اول)" },
     { key: "birth_cert_p2", label: "شناسنامه (صفحه دوم)" },
     { key: "birth_cert_p3", label: "شناسنامه (صفحه سوم)" },
  ];

  const uploadIdentityDoc = useUploadCustomerIdentityDocument();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, reqKey: string) => {
     const input = e.currentTarget;
     const file = input.files?.[0];
     input.value = "";
     if (!file) return;
     if (!supportedDocumentFile(file)) {
       setUploadErrors(current => ({ ...current, [reqKey]: 'فقط فایل JPG، JFIF، PNG یا PDF قابل بارگذاری است.' }));
       return;
     }
     
     const type = reqKey as CustomerIdentityDocumentUploadDocumentType;
     const isReplacement = docs.some(doc => doc.documentType === reqKey);
     setUploadingType(reqKey);
     setUploadErrors(current => ({ ...current, [reqKey]: "" }));
     try {
        await uploadIdentityDoc.mutateAsync({
           customerId: customer.id,
           data: {
              documentType: type,
              file
           }
        });
        await queryClient.invalidateQueries({ queryKey: identityDocsQueryKey });
     } catch (error) {
        setUploadErrors(current => ({
           ...current,
           [reqKey]: apiErrorMessage(error, isReplacement
             ? "آپلود مجدد انجام نشد. فایل قبلی بدون تغییر باقی ماند."
             : "بارگذاری مدرک انجام نشد. دوباره تلاش کنید.")
        }));
     } finally {
        setUploadingType(null);
     }
  };

  const isAllComplete = requiredTypes.every(req => docs.some(d => d.documentType === req.key));
  const continueToReview = () => {
    setContinueAttempted(true);
    if (isAllComplete && !uploadingType) onNext();
  };

  return (
    <div className="lwz-step" data-testid="wizard-step-4">
       <p className="lwz-muted">مدارک هویتی زیر برای پرونده الزامی است. مدارک قبلی مشتری به صورت خودکار شناسایی شده‌اند. فرمت مجاز: JPG، PNG یا PDF.</p>
       <ul className="lwz-docs">
          {isLoading ? (
             <li className="lwz-loading" role="status">در حال بررسی مدارک...</li>
          ) : requiredTypes.map(req => {
             const existing = docs.find(d => d.documentType === req.key);
              const isUploading = uploadingType === req.key;
              const downloadUrl = existing
                ? `${getDownloadCustomerIdentityDocumentUrl(customer.id, existing.id)}?preview=1`
                : "";
              const rowError = uploadErrors[req.key] || (continueAttempted && !existing ? 'بارگذاری این مدرک الزامی است.' : '');
             return (
                <li key={req.key} className={`lwz-doc${existing ? ' ok' : ''}${rowError ? ' bad' : ''}`} data-testid={`identity-doc-row-${req.key}`}>
                   <div className="lwz-doch">
                      <FileText size={22} aria-hidden="true" />
                      <span className="nm">{req.label}</span>
                      {existing ? <span className="lwz-ok" data-testid={`identity-doc-status-${req.key}`}><CheckCircle2 size={16} aria-hidden="true" /> تکمیل شده</span> : <span className="lwz-muted">بارگذاری نشده</span>}
                   </div>
                   <div className="lwz-docacts">
                      {existing && (
                        <a className="btn btn-ghost" href={downloadUrl} target="_blank" rel="noreferrer" data-testid={`identity-doc-view-${req.key}`}>
                          <Search size={16} /> مشاهده فایل
                        </a>
                      )}
                      <label className="lwz-upload" style={{ cursor: uploadingType ? 'not-allowed' : 'pointer' }}>
                         <span className={`btn ${existing ? 'btn-ghost' : 'btn-gold'}`} style={{ opacity: uploadingType && !isUploading ? 0.55 : 1 }} data-testid={`identity-doc-upload-${req.key}`}>
                           {isUploading ? <><RefreshCw size={16} className="spin" /> در حال بارگذاری...</> : <><UploadCloud size={16} /> {existing ? "آپلود مجدد" : "بارگذاری"}</>}
                         </span>
                         <input type="file" disabled={Boolean(uploadingType)} className="lwz-file" onChange={(e) => handleFileChange(e, req.key)} accept={documentFileAccept} aria-label={`بارگذاری ${req.label}`} />
                      </label>
                   </div>
                   {rowError ? <div role="alert" className="lwz-err" data-testid={`error-identity-doc-${req.key}`}>{rowError}</div> : null}
               </li>
             );
          })}
       </ul>

       <div className="form-footer">
        <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid="btn-prev-4"><ChevronRight size={18} /> قبلی</button>
         <button type="button" className="btn btn-primary" onClick={continueToReview} disabled={Boolean(uploadingType)} data-testid="btn-next-4">ادامه <ChevronLeft size={18} /></button>
      </div>
    </div>
  );
}

// --- Step 5 ---
function Step5Review({ customer, plan, amount, duration, onNext, onPrev, isPending, error, serverErrors = {}, part = 0, onPartNext, onEdit, feePaid }: any) {
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const manualVariables = plan.manualVariables ?? [];
  const manualComplete = manualVariables.every((item: any) => String(manualValues[item.variable] ?? "").trim());
  const serverManualError = manualVariables.some((item: any) => serverErrors[item.variable]);
  const continueManual = () => {
    setAttempted(true);
    if (manualComplete) onPartNext();
  };
  const submitReview = () => {
    setAttempted(true);
    if (manualComplete && plan.contractTemplateId) onNext(manualValues);
  };
  const editLink = (n: number, label: string) => onEdit ? <button type="button" className="text-link" onClick={() => onEdit(n)} disabled={isPending} aria-label={`ویرایش ${label}`}>ویرایش</button> : null;
  return (
    <div className="lwz-step" data-testid="wizard-step-5" data-part={part}>
      {part === 0 && (manualVariables.length > 0 ? (
        <div className="lwz-form" data-testid="wizard-contract-fields">
          {manualVariables.map((item: any) => {
            const missing = attempted && !String(manualValues[item.variable] ?? '').trim();
            return (
            <label key={item.variable} className="field">
              <span>{item.label}</span>
              <input
                value={manualValues[item.variable] ?? ""}
                onChange={(event) => setManualValues((current) => ({ ...current, [item.variable]: event.target.value }))}
                disabled={isPending}
                aria-invalid={Boolean(missing || serverErrors[item.variable])}
                data-testid={`contract-variable-${item.variable}`}
              />
              {missing && <small role="alert" className="lwz-err" data-testid={`error-contract-variable-${item.variable}`}>تکمیل این فیلد برای تولید قرارداد الزامی است.</small>}
              {serverErrors[item.variable] && <small role="alert" className="lwz-err" data-testid={`error-contract-variable-server-${item.variable}`}>{serverErrors[item.variable]}</small>}
            </label>
          ); })}
        </div>
      ) : <p className="lwz-note" role="note" data-testid="wizard-no-contract-fields"><Info size={18} aria-hidden="true" /> قالب قرارداد این طرح فیلد دستی ندارد؛ ادامه دهید.</p>)}

      {part === 1 && <>
        <section className="lwz-card lwz-review" aria-label="مشتری">
          <div className="lwz-cardh"><strong>مشتری</strong>{editLink(2, 'اطلاعات هویتی')}</div>
          <dl className="lwz-kv">
            <div className="full"><dt>نام و کد ملی</dt><dd data-testid="review-customer-name"><CustomerName id={customer.id} name={customer.name} /> ({customer.nationalCode})</dd></div>
            <div className="full"><dt>کارشناس فروش</dt><dd>{customer.salespersonName || 'بدون تخصیص'}</dd></div>
          </dl>
        </section>
        <section className="lwz-card lwz-review" aria-label="تسهیلات">
          <div className="lwz-cardh"><strong>تسهیلات</strong>{feePaid ? <span className="lwz-muted">قفل پس از پرداخت هزینه</span> : editLink(5, 'طرح و شرط')}</div>
          <dl className="lwz-kv">
            <div className="full"><dt>طرح تسهیلاتی</dt><dd data-testid="review-plan-name">{plan.name}</dd></div>
            <div><dt>مبلغ درخواستی</dt><dd data-testid="review-amount">{Number(amount).toLocaleString('fa-IR')} تومان</dd>
              {serverErrors.amount && <small role="alert" className="lwz-err" data-testid="error-submit-amount">{serverErrors.amount}</small>}</div>
            <div><dt>مدت اقساط</dt><dd data-testid="review-duration">{Number(duration).toLocaleString('fa-IR')} ماه</dd>
              {serverErrors.duration && <small role="alert" className="lwz-err" data-testid="error-submit-duration">{serverErrors.duration}</small>}</div>
          </dl>
        </section>
        <section className="lwz-card lwz-review" aria-label="پرداخت و مدارک">
          <div className="lwz-cardh"><strong>پرداخت و مدارک</strong>{editLink(8, 'مدارک هویتی')}</div>
          <dl className="lwz-kv">
            <div><dt>هزینه تشکیل پرونده</dt><dd>{feePaid ? <span className="lwz-ok">پرداخت شد</span> : '—'}</dd></div>
            <div><dt>مدارک هویتی</dt><dd><span className="lwz-ok">کامل</span></dd></div>
          </dl>
        </section>
        <p className="lwz-note" role="note"><Info size={18} aria-hidden="true" /> با ثبت، فقط پرونده ثبت می‌شود. کارشناس ثبت ابتدا شرایط تسهیلات را تأیید می‌کند؛ قرارداد پس از این تصمیم در صفحه پرونده صادر خواهد شد.</p>
        {(serverManualError || (attempted && !manualComplete)) && <p className="lwz-note bad" role="alert" data-testid="error-review-manual-fields">بعضی از فیلدهای قرارداد کامل یا پذیرفته نشده‌اند. <button type="button" className="text-link" onClick={onPrev}>بازگشت به «اطلاعات تکمیلی قرارداد»</button></p>}
        {error && <div className="form-error" role="alert">{error}</div>}
        {attempted && !plan.contractTemplateId && <div className="form-error" role="alert" data-testid="error-contract-template">برای طرح انتخاب‌شده قالب قرارداد قابل استفاده ثبت نشده است.</div>}
      </>}

      <div className="form-footer">
          <button type="button" className="btn btn-ghost" onClick={onPrev} disabled={isPending} data-testid={part === 1 ? 'btn-prev-5' : 'btn-prev-5-0'}><ChevronRight size={18} /> قبلی</button>
          {part === 0
            ? <button type="button" className="btn btn-primary" onClick={continueManual} data-testid="btn-next-5-0">ادامه <ChevronLeft size={18} /></button>
            : <button type="button" className="btn btn-primary" onClick={submitReview} disabled={isPending} data-testid="btn-submit-wizard">
                {isPending ? <><RefreshCw size={18} className="spin" /> در حال ثبت پرونده...</> : 'ثبت پرونده و مشاهده جزئیات'}
              </button>}
      </div>
    </div>
  );
}
