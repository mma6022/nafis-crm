import { requestWalletShare } from '@/lib/wallet-share';
import { documentFileAccept, supportedDocumentFile } from '@/lib/document-upload-type';
import { getListCustomerWalletShareLinksQueryKey } from '@workspace/api-client-react';
import React, { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  useListCustomers,
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
  Info,
  Copy
} from "lucide-react";
import { Modal, EmptyState } from "@/components/DataTools";
import { PersianDatePicker } from "@/components/PersianDatePicker";
import { formatPhoneForDisplay } from "@/lib/phone";
import { Priority, formatDate, formatDateTime } from "@/components/CrmShell";
import { normalizeDigits, serverFieldErrors, validateIranianMobile, validateIranianNationalCode, validateIranianPostalCode, validateJalaliBirthDate, validateOtp } from "@/lib/customer-field-validation";

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

export function CreateWizard({ onClose }: { onClose: () => void }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canIgnoreCreditRank = ["admin", "salesperson"].includes(session.data?.user?.role ?? "");
  const [ignoreCreditRank, setIgnoreCreditRank] = useState(false);
  const previewAllPlans = canIgnoreCreditRank && ignoreCreditRank;

  // Global wizard state
  const [search, setSearch] = useState("");
  const { data: customersData, isLoading: loadingCustomers } = useListCustomers(
    { limit: 50, search: search || undefined },
    { query: { queryKey: ["wizard-customers", search] } }
  );
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [feeChargeId, setFeeChargeId] = useState<number | null>(null);
  const selectCustomer = (customer: Customer | null) => {
    if (customer?.id !== selectedCustomer?.id) {
      setIgnoreCreditRank(false);
      setFeeChargeId(null); setSelectedPlanId(null); setSelectedPlan(null); setAmount(''); setDuration(''); setTermsAttempted(false);
    }
    setSelectedCustomer(customer);
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

  const handleNext = () => setStep((s) => Math.min(s + 1, 6) as any);
  const handlePrev = () => setStep((s) => Math.max(s - 1, 1) as any);

  const createMutation = useCreateLoanApplication();

  const handleSubmit = async (manualValues: Record<string, string>) => {
    if (checkingSubmission || createMutation.isPending) return;
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
      const latest = await listCustomerEligiblePlans(selectedCustomer.id, { ignoreCreditRank: previewAllPlans });
      queryClient.setQueryData(getListCustomerEligiblePlansQueryKey(selectedCustomer.id, { ignoreCreditRank: previewAllPlans }), latest);
      const current = latest.plans.find(plan =>
        plan.planId === selectedPlan.planId && plan.conditionId === selectedPlan.conditionId);
      const selectionTerms = (plan: CustomerEligiblePlan) => JSON.stringify([
        plan.maximumAmount, plan.allowedDurations, plan.needsGuarantor,
        plan.conditionNotes, plan.contractTemplateId, plan.manualVariables,
      ]);
      if (!current || selectionTerms(current) !== selectionTerms(selectedPlan)) {
        setSelectedPlan(current ?? null);
        setTermsAttempted(false);
        setStep((previewAllPlans || latest.credit.fresh) ? 3 : 2);
        setSubmitError((previewAllPlans || latest.credit.fresh)
          ? 'شرایط طرح هنگام تکمیل فرم تغییر کرده است. شرایط فعلی همین طرح را بررسی و انتخاب کنید؛ هزینه پرداخت‌شده حفظ شده و دوباره کسر نمی‌شود.'
          : 'اعتبارسنجی مشتری دیگر به‌روز نیست. استعلام تازه بگیرید؛ هزینه پرداخت‌شده حفظ می‌شود.');
        return;
      }
      const applicationInput = {
        ignoreCreditRank: previewAllPlans,
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
      };
      const application = await createMutation.mutateAsync({ data: applicationInput });
      await queryClient.invalidateQueries({ queryKey: ["/api/loan-applications"] });
      window.sessionStorage.removeItem(`loan-fee:${selectedCustomer.id}:${selectedPlan.planId}`);
      setLocation(`/loan-applications/${application.id}`);
      onClose();
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

  return (
    <Modal
      title="ثبت درخواست جدید"
      onClose={onClose}
      testId="create-loan-application-wizard"
    >
      <section
        aria-label="مشخصات مشتری درخواست"
        data-testid="wizard-customer-summary"
        style={{ position: 'sticky', top: -22, zIndex: 2, display: 'flex', flexWrap: 'wrap', gap: '8px 20px', padding: '12px 14px', marginBottom: 16, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, color: '#0f172a', fontSize: 13, boxShadow: '0 3px 8px rgb(15 23 42 / 5%)' }}
      >
        <div style={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
          <span style={{ color: '#64748b' }}>نام مشتری: </span>
          <strong data-testid="wizard-customer-name">{selectedCustomer?.name || 'هنوز انتخاب نشده'}</strong>
        </div>
        <div>
          <span style={{ color: '#64748b' }}>موبایل: </span>
          <bdi dir="ltr" data-testid="wizard-customer-phone">{selectedCustomer?.phone ? formatPhoneForDisplay(selectedCustomer.phone) : '—'}</bdi>
        </div>
        <div>
          <span style={{ color: '#64748b' }}>کد ملی: </span>
          <bdi dir="ltr" data-testid="wizard-customer-national-code">{selectedCustomer ? selectedCustomer.nationalCode || 'ثبت نشده' : '—'}</bdi>
        </div>
      </section>
      {step !== 6 && submitError && <p className="form-error" role="alert" data-testid="wizard-recovery-error">{submitError}</p>}
      <div className="wizard-stepper" data-testid="wizard-stepper" style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between' }}>
        {WIZARD_STEPS.map((s, index) => (
          <React.Fragment key={s.id}>
            <div
              className={`wizard-step ${step === s.id ? "active" : step > s.id ? "completed" : ""}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: step >= s.id ? 1 : 0.4,
                transition: 'opacity 0.2s'
              }}
            >
              <div style={{
                width: 20, height: 20, borderRadius: '50%', 
                background: step > s.id ? 'var(--teal)' : step === s.id ? 'var(--nafiss-blue)' : '#e2e8f0',
                color: step >= s.id ? '#fff' : '#64748b',
                display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 'bold'
              }}>
                {step > s.id ? <Check size={12} /> : s.id}
              </div>
              <span style={{ fontSize: 11, fontWeight: step === s.id ? 700 : 500, color: step >= s.id ? 'var(--ink-deep)' : '#64748b' }}>
                {s.title}
              </span>
            </div>
            {index < WIZARD_STEPS.length - 1 && (
              <div style={{ height: 1, flex: 1, background: '#e2e8f0', margin: '10px 8px 0' }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 10 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          style={{ minHeight: 400, display: 'flex', flexDirection: 'column' }}
        >
          {step === 1 && (
            <Step1Customer 
               search={search} setSearch={setSearch} 
               customers={customersData?.items || []} 
               loading={loadingCustomers}
               selectedCustomer={selectedCustomer} 
                setSelectedCustomer={selectCustomer} 
               onNext={handleNext} 
            />
          )}
          {step === 2 && selectedCustomer && (
            <Step2ProfileAndCredit
               canIgnoreCreditRank={canIgnoreCreditRank}
               ignoreCreditRank={previewAllPlans}
               previewLocked={Boolean(feeChargeId) || hasPendingFeeAttempt}
               onIgnoreCreditRankChange={(checked: boolean) => {
                 setIgnoreCreditRank(checked);
                 setSelectedPlan(null); setAmount(''); setDuration(''); setTermsAttempted(false);
                 if (!feeChargeId && !hasPendingFeeAttempt) {
                   setSelectedPlanId(null);
                 }
               }}
               customer={selectedCustomer}
               onNext={handleNext}
               onPrev={handlePrev}
               onCustomerUpdate={setSelectedCustomer}
            />
           )}
           {step === 3 && selectedCustomer && (
            <Step3PlanAndTerms
               ignoreCreditRank={previewAllPlans}
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
            />
          )}
            {step === 4 && selectedCustomer && selectedPlan && (
              <StepFilingFee customer={selectedCustomer} selectedPlan={selectedPlan} ignoreCreditRank={previewAllPlans}
                feeChargeId={feeChargeId} setFeeChargeId={setFeeChargeId} onNext={handleNext} onPrev={handlePrev} />
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
            />
          )}
        </motion.div>
      </AnimatePresence>
    </Modal>
  );
}

function StepFilingFee({ customer, selectedPlan, feeChargeId, setFeeChargeId, onNext, onPrev, ignoreCreditRank }: {
  ignoreCreditRank: boolean;
  customer: Customer; selectedPlan: CustomerEligiblePlan;
  feeChargeId: number | null; setFeeChargeId: (id: number | null) => void; onNext: () => void; onPrev: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useGetFilingFeePlans({ customerId: customer.id, ignoreCreditRank });
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
    keyRef.current ??= window.sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, keyRef.current);
    try {
      const charge = await chargeFilingFee({ customerId: customer.id, planId: plan.planId, ignoreCreditRank },
        { headers: { 'Idempotency-Key': keyRef.current } });
      setFeeChargeId(charge.chargeId);
      await queryClient.invalidateQueries({ queryKey: getGetFilingFeePlansQueryKey({ customerId: customer.id, ignoreCreditRank }) });
    } catch (e) {
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
      const body = await requestWalletShare(customer.id, { planId: selectedPlan.planId, ignoreCreditRank });
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

  return <div className="panel" style={{ padding: 20, display: 'grid', gap: 16 }} data-testid="wizard-filing-fee">
    <h3>پرداخت هزینه ثابت تشکیل پرونده</h3>
    <p>طرح و شرایط درخواست انتخاب شده است. مبلغ ثابت همین طرح فقط یک بار از کیف پول نقدی مشتری کسر و به کیف پول نقدی شرکت منتقل می‌شود.</p>
    {isLoading ? <p>در حال دریافت طرح‌ها...</p> : error ? <p role="alert">دریافت طرح‌ها ناموفق بود. <button type="button" onClick={() => refetch()}>تلاش دوباره</button></p> : (
      <>
        {!plan && (
          <p role="alert" style={{ color: '#9f1239' }}>طرح انتخاب‌شده دیگر واجد شرایط پرداخت نیست و مبلغی کسر نمی‌شود. برای بررسی طرح و شرایط به مرحله قبل برگردید.</p>
        )}
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <span style={{ display: 'block', color: '#64748b', fontSize: 11 }}>طرح انتخاب‌شده</span>
          <strong data-testid="filing-fee-plan-name">{selectedPlan.name}</strong>
        </div>
        <p>موجودی نقدی مشتری: <strong>{BigInt(data?.cashBalanceToman ?? '0').toLocaleString('fa-IR')} تومان</strong></p>
        {plan && <p>هزینه ثابت تشکیل پرونده: <strong>{BigInt(plan.filingFeeToman).toLocaleString('fa-IR')} تومان</strong></p>}
        {plan && !affordable && !feeChargeId && !hasPendingKey && <p role="alert">موجودی کافی نیست. ابتدا کیف پول نقدی مشتری را از <a href={`/customers/${customer.id}`}>پرونده مشتری</a> شارژ کنید، سپس به این مرحله برگردید.</p>}
        {feeError && <p role="alert" style={{ color: '#b91c1c' }}>{feeError}</p>}
         {!feeChargeId && plan && <div style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid #bae6fd', borderRadius: 8, background: '#f0f9ff' }}>
           <strong>پرداخت توسط مشتری</strong>
           <span style={{ fontSize: 12, color: '#475569' }}>لینک شارژ کسری کیف پول را برای مشتری ارسال کنید؛ شارژ بدون تأیید پرداخت انجام نمی‌شود.</span>
           <button type="button" className="btn btn-gold" disabled={sharePending || Boolean(shareUrl)} onClick={createShareLink}>{sharePending ? 'در حال ارسال…' : shareSmsSent ? 'پیامک ارسال شد' : 'ارسال لینک شارژ کیف پول'}</button>
           {shareSmsSent && <span role="status" style={{ color: '#047857' }}>لینک شارژ با پیامک برای مشتری ارسال شد.</span>}
           {shareUrl && <><span style={{ fontSize: 12 }}>مبلغ لینک: <strong>{BigInt(shareAmount || '0').toLocaleString('fa-IR')} تومان</strong></span><div className="wallet-share-link"><div><input readOnly dir="ltr" value={shareUrl} /><button type="button" className="btn btn-ghost" onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); } catch { setFeeError('کپی لینک انجام نشد؛ لینک را به‌صورت دستی از کادر انتخاب و کپی کنید.'); } }}><Copy size={15} /> کپی</button></div></div><button type="button" className="btn btn-ghost" onClick={() => refetch()}><RefreshCw size={15} /> به‌روزرسانی موجودی پس از پرداخت</button></>}
         </div>}
        {feeChargeId && <p role="status" style={{ color: '#047857' }}>هزینه همین طرح ثبت شد؛ می‌توانید مدارک پرونده را تکمیل کنید.</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={onPrev}>بازگشت</button>
          {!feeChargeId && <button type="button" className="btn btn-primary" disabled={!plan || (!affordable && !hasPendingKey) || pending} onClick={pay}>{pending ? 'در حال ثبت...' : hasPendingKey ? 'بازیابی نتیجه پرداخت و ادامه' : 'کسر هزینه و ادامه'}</button>}
          {feeChargeId && <button type="button" className="btn btn-primary" onClick={onNext}>ادامه</button>}
        </div>
      </>
    )}
  </div>;
}

// --- Step 1 ---
function Step1Customer({ search, setSearch, customers, loading, selectedCustomer, setSelectedCustomer, onNext }: any) {
  const [attempted, setAttempted] = useState(false);
  const normalizedSearch = search.trim().toLocaleLowerCase("fa-IR");
  const filteredCustomers = customers.filter((c: any) =>
    !normalizedSearch ||
    c.name.toLocaleLowerCase("fa-IR").includes(normalizedSearch) ||
    c.phone.includes(normalizedSearch)
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="searchbar" style={{ marginBottom: 16 }}>
        <Search size={16} />
        <input
          type="text"
          placeholder="جستجوی مشتری (نام یا موبایل)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          data-testid="input-customer-search"
        />
      </div>
      <div style={{ flex: 1, overflowY: "auto", maxHeight: 320, border: "1px solid #e2e8f0", borderRadius: 10, background: '#f8fafc' }}>
        {loading ? (
           <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>در حال جستجو...</div>
        ) : filteredCustomers.map((c: any) => (
          <label
            key={c.id}
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: "1px solid #e2e8f0", cursor: "pointer",
              background: selectedCustomer?.id === c.id ? "#eff6ff" : "#fff",
              transition: 'background 0.2s'
            }}
          >
            <input type="radio" name="customer" checked={selectedCustomer?.id === c.id} onChange={() => setSelectedCustomer(c)} />
            <div style={{ flex: 1 }}>
              <strong style={{ display: "block", fontSize: 13, color: "var(--ink-deep)" }}>{c.name}</strong>
              <span style={{ display: "block", fontSize: 11, color: "#64748b" }}>کارشناس فروش: {c.salespersonName || "بدون تخصیص"}</span>
              <span style={{ fontSize: 11, color: "#64748b" }}>{c.phone} - {c.nationalCode || "بدون کدملی"}</span>
            </div>
            {c.verificationStatus === 'verified' && <CheckCircle2 size={16} color="#0f766e" />}
          </label>
        ))}
        {!loading && filteredCustomers.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>مشتری یافت نشد.</div>
        )}
      </div>
      {attempted && !selectedCustomer && <small role="alert" style={{ color: '#be123c', marginTop: 8 }} data-testid="error-selected-customer">برای ادامه یک مشتری را انتخاب کنید.</small>}
      <div className="form-footer" style={{ justifyContent: "flex-end", marginTop: 24 }}>
        <button type="button" className="btn btn-primary" onClick={() => { setAttempted(true); if (selectedCustomer) onNext(); }}>
          تایید و ادامه
        </button>
      </div>
    </div>
  );
}

// --- Step 2 ---
function Step2ProfileAndCredit({ customer, onNext, onPrev, onCustomerUpdate, canIgnoreCreditRank, ignoreCreditRank, onIgnoreCreditRankChange, previewLocked }: any) {
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
  const freshCredit = creditChecks?.find((check) =>
    check.status === "report_generated" &&
    Date.now() - new Date(check.completedAt || check.updatedAt).getTime() < 24 * 60 * 60 * 1000
  );
  const hasFreshCredit = Boolean(freshCredit);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 20 }} data-testid="wizard-step-2">
      {/* Profile Section */}
      <div className="panel" style={{ padding: 16 }}>
         <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h4 style={{ fontSize: 13, margin: 0 }}>اطلاعات پایه و هویتی</h4>
            {!editMode && !isVerified && (
               <button type="button" className="text-link" onClick={() => setEditing(true)} data-testid="btn-edit-profile">ویرایش</button>
            )}
         </div>
         {editMode ? (
            <form noValidate onSubmit={handleSaveProfile} className="form-grid" style={{ gap: 10 }}>
               <div className="field"><label>کد ملی</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={e => { setForm({...form, nationalCode: e.target.value}); setProfileErrors(current => ({ ...current, nationalCode: '' })); }} aria-invalid={Boolean(profileErrors.nationalCode)} data-testid="input-national-code" />{profileErrors.nationalCode && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.nationalCode}</small>}</div>
               <div className="field"><label>موبایل</label><input dir="ltr" inputMode="tel" value={form.phone} onChange={e => { setForm({...form, phone: e.target.value}); setProfileErrors(current => ({ ...current, phone: '' })); }} aria-invalid={Boolean(profileErrors.phone)} data-testid="input-phone" />{profileErrors.phone && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.phone}</small>}</div>
               <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={v => { setForm({...form, birthDateJalali: v}); setProfileErrors(current => ({ ...current, birthDateJalali: '' })); }} testId="input-birth-date" birthDate />{profileErrors.birthDateJalali && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.birthDateJalali}</small>}</div>
               <div className="field"><label>کد پستی</label><input dir="ltr" inputMode="numeric" value={form.postalCode} onChange={e => { setForm({...form, postalCode: e.target.value}); setProfileErrors(current => ({ ...current, postalCode: '' })); }} aria-invalid={Boolean(profileErrors.postalCode)} data-testid="input-postal-code" />{profileErrors.postalCode && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.postalCode}</small>}</div>
               {profileError && <div className="profile-form-error field full" role="alert" data-testid="error-save-profile">{profileError}</div>}
              <div className="field full" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button type="submit" className="btn btn-gold" disabled={updateCustomer.isPending} data-testid="btn-save-profile">
                  {updateCustomer.isPending ? 'در حال ذخیره...' : 'ذخیره اطلاعات'}
                </button>
              </div>
           </form>
         ) : (
           <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
             <div><span style={{color: '#64748b'}}>کد ملی:</span> <strong data-testid="display-national-code">{customer.nationalCode}</strong></div>
             <div><span style={{color: '#64748b'}}>موبایل:</span> <strong dir="ltr" data-testid="display-phone">{customer.phone}</strong></div>
             <div><span style={{color: '#64748b'}}>تاریخ تولد:</span> <strong data-testid="display-birth-date">{customer.birthDateJalali}</strong></div>
             <div><span style={{color: '#64748b'}}>وضعیت:</span> 
               {isVerified ? <span style={{ color: '#0f766e', fontWeight: 'bold' }} data-testid="status-verified"> احراز شده</span> : <span style={{ color: '#b45309' }} data-testid="status-unverified"> احراز نشده</span>}
             </div>
             
              <div style={{ gridColumn: '1 / -1', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, marginTop: 8 }}>
                 {!isVerified && (
                   <div style={{ fontSize: 11, color: '#475569', marginBottom: 10 }}>جهت ادامه، باید هویت مشتری (شاهکار، ثبت احوال، ثنا و نشانی) احراز شود.</div>
                 )}
                 {lastVerificationCheckedAt && (
                   <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }} data-testid="last-verification-time">
                     آخرین استعلام: {formatDateTime(lastVerificationCheckedAt)}
                   </div>
                 )}
                  <button type="button" className="btn btn-primary" onClick={doVerify} disabled={isVerified || editMode || verifyIdentity.isPending} style={{ width: '100%' }} data-testid="btn-verify-identity">
                   {verifyIdentity.isPending
                     ? 'در حال استعلام...'
                     : isVerified ? 'هویت مشتری تأیید شده است'
                     : lastVerificationCheckedAt
                       ? 'تلاش دوباره فقط برای موارد ناموفق'
                       : 'استعلام و احراز هویت'}
                 </button>
                  {verifyError && <div role="alert" style={{ color: '#be123c', fontSize: 11, marginTop: 8 }} data-testid="verify-error">{verifyError}</div>}
                  {identityInquiryFailed && !editMode && validateIranianNationalCode(form.nationalCode) && validateIranianMobile(form.phone) && validateJalaliBirthDate(form.birthDateJalali) && (
                    <div style={{ marginTop: 10, display: 'grid', gap: 7 }}>
                      <p style={{ margin: 0, color: '#475569', fontSize: 11 }}>موارد موفق تأیید شده‌اند. فقط موارد قرمز به ادمین ارجاع می‌شوند؛ رتبهٔ اعتباری قابل تأیید دستی نیست.</p>
                      <button type="button" className="btn btn-ghost" onClick={submitManualVerificationRequest} disabled={manualRequestAttempted || manualRequestPending} data-testid="btn-manual-verification-request">
                        {manualRequestPending ? 'در انتظار بررسی مدیر...' : 'ارسال به ادمین'}
                      </button>
                      {manualRequestMessage && <div role={manualRequestPending ? 'status' : manualRequestError ? 'alert' : 'status'} style={{ color: manualRequestPending ? '#92400e' : manualRequestError ? '#be123c' : '#047857', fontSize: 11 }} data-testid="manual-verification-request-status">{manualRequestMessage}</div>}
                    </div>
                  )}
                <div style={{ display: 'grid', gap: 7, marginTop: 12 }} data-testid="identity-checks">
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
                      <div key={key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', borderRadius: 7, background: ok ? '#ecfdf5' : '#fff1f2', color: ok ? '#047857' : '#be123c' }} data-testid={`identity-check-${key}`}>
                        <span>{label}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 700 }}>
                          {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                          {ok ? 'تأیید شد' : 'تأیید نشد'}
                        </span>
                        {providerStatusMessage && <small style={{ color: '#9f1239', display: 'block', flexBasis: '100%' }}>{providerStatusMessage}</small>}
                      </div>
                    );
                  })}
                </div>
                <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 12, paddingTop: 12 }}>
                  <strong style={{ display: 'block', marginBottom: 9 }}>نتیجه رسمی استعلام</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div><span style={{ color: '#64748b' }}>نام رسمی:</span> <strong data-testid="official-first-name">{officialIdentity.firstName || '—'}</strong></div>
                    <div><span style={{ color: '#64748b' }}>نام خانوادگی رسمی:</span> <strong data-testid="official-last-name">{officialIdentity.lastName || '—'}</strong></div>
                    <div><span style={{ color: '#64748b' }}>نام پدر:</span> <strong data-testid="official-father-name">{officialIdentity.fatherName || '—'}</strong></div>
                    <div><span style={{ color: '#64748b' }}>کد پستی رسمی:</span> <strong dir="ltr" data-testid="official-postal-code">{officialIdentity.postalCode || '—'}</strong></div>
                    <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#64748b' }}>نشانی رسمی:</span> <strong data-testid="official-address">{officialIdentity.address || '—'}</strong></div>
                  </div>
                </div>
              </div>
           </div>
         )}
      </div>

      {/* Credit Section */}
      <div className="panel" style={{ padding: 16, opacity: isVerified ? 1 : 0.5, pointerEvents: isVerified ? 'auto' : 'none' }}>
         <h4 style={{ fontSize: 13, margin: '0 0 12px' }}>وضعیت اعتباری</h4>
         {canIgnoreCreditRank && <div style={{ marginBottom: 12 }}>
           <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
             <input type="checkbox" checked={ignoreCreditRank} onChange={(event) => onIgnoreCreditRankChange(event.target.checked)} data-testid="checkbox-ignore-credit-rank" />
             عدم در نظر گرفتن رتبه اعتباری در تمام مراحل پرونده
           </label>
           <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0' }}>با فعال کردن این گزینه، رتبه و تازگی استعلام در ادامهٔ همین پرونده بررسی نمی‌شوند؛ احراز هویت، سقف مبلغ، اقساط مجاز و مدارک همچنان الزامی‌اند.{previewLocked ? ' طرح پرداخت‌شده همچنان قفل است.' : ''}</p>
         </div>}
          {creditError && (
            <div className="profile-form-error" style={{ marginBottom: 10 }} data-testid="credit-check-error">
              {creditError}
            </div>
          )}
          {creditChecksError && (
            <div className="profile-form-error" style={{ marginBottom: 10 }} role="alert" data-testid="credit-list-error">
              دریافت سابقه استعلام اعتبارسنجی انجام نشد. وضعیت اتصال سرویس را بررسی و دوباره تلاش کنید.
            </div>
          )}
          {latestCredit?.status === 'failed' && latestCredit.errorMessage && (
            <div className="profile-form-error" style={{ marginBottom: 10 }} role="alert" data-testid="credit-latest-error">
              {apiErrorMessage({ data: { message: latestCredit.errorMessage } }, latestCredit.errorMessage)}
            </div>
          )}
         {hasFreshCredit ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#ecfdf5', border: '1px solid #a7f3d0', padding: 12, borderRadius: 8 }} data-testid="credit-status-fresh">
               <ShieldCheck color="#059669" />
               <div>
                   <strong style={{ display: 'block', fontSize: 13, color: '#065f46' }}>رتبه اعتباری: {freshCredit?.scoreLabel || 'نامشخص'}</strong>
                   <span style={{ fontSize: 11, color: '#047857' }}>بروزرسانی: {formatDateTime(freshCredit?.completedAt || freshCredit?.updatedAt)}</span>
               </div>
            </div>
         ) : latestCredit?.status === 'awaiting_otp' ? (
             <form onSubmit={confirmCreditOtp} style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: 12, borderRadius: 8 }} data-testid="credit-status-otp">
               <strong style={{ display: 'block', fontSize: 12, color: '#b45309', marginBottom: 6 }}>نیاز به تایید پیامکی</strong>
                <p style={{ fontSize: 11, color: '#92400e', margin: '0 0 10px' }}>کد اعتبارسنجی ارسال‌شده به موبایل مشتری را همین‌جا وارد کنید.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) auto', gap: 8, alignItems: 'end' }}>
                  <div className="field">
                    <label>کد اعتبارسنجی</label>
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={creditOtp}
                       onChange={(event) => { setCreditOtp(normalizeDigits(event.target.value).replace(/\D/g, '').slice(0, 8)); setCreditOtpError(''); }}
                      minLength={4}
                      maxLength={8}
                      data-testid="input-credit-otp"
                    />
                    {creditOtpError && <small role="alert" style={{ color: '#be123c' }} data-testid="error-credit-otp">{creditOtpError}</small>}
                  </div>
                  <button type="submit" className="btn btn-gold" disabled={validateCredit.isPending} data-testid="btn-confirm-credit-otp">
                    {validateCredit.isPending ? 'در حال بررسی...' : 'تأیید و دریافت رتبه اعتباری'}
                  </button>
                </div>
                <button type="button" className="text-link" onClick={resendCreditOtp} disabled={renewCredit.isPending} style={{ marginTop: 10 }} data-testid="btn-resend-credit-otp">
                  {renewCredit.isPending ? 'در حال ارسال...' : 'ارسال مجدد کد'}
                </button>
             </form>
         ) : latestCredit?.status === 'processing' ? (
            <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: '#64748b' }} data-testid="credit-status-processing">
               <RefreshCw size={14} className="spin" style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: 6 }} />
                در حال دریافت رتبه اعتباری...
            </div>
         ) : (
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
               <div style={{ fontSize: 11, color: '#475569', marginBottom: 10 }}>برای انتخاب طرح تسهیلاتی، رتبه اعتباری ۲۴ ساعت اخیر الزامی است.</div>
               <button type="button" className="btn btn-gold" onClick={startCreditCheck} disabled={initiateCredit.isPending} style={{ width: '100%' }} data-testid="btn-start-credit-check">
                  {initiateCredit.isPending ? 'در حال ارسال...' : 'استعلام رتبه اعتباری'}
               </button>
            </div>
         )}
      </div>

      <div className="form-footer" style={{ justifyContent: "space-between", marginTop: 'auto' }}>
        <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid="btn-prev-2">بازگشت</button>
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={!isReadyForNext} data-testid="btn-next-2">تایید و ادامه</button>
      </div>
    </div>
  );
}

// --- Step 3 ---
type Step3PlanAndTermsProps = {
  ignoreCreditRank: boolean;
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
};

function Step3PlanAndTerms({ customer, selectedPlanId, selectedPlan, onSelectPlanGroup, onSelectPlan, planLocked, feeRecoveryPending, amount, setAmount, duration, setDuration, onNext, onPrev, attempted, onAttempt, ignoreCreditRank }: Step3PlanAndTermsProps) {
  const { data: eligibleResponse, isLoading, isError, refetch } = useListCustomerEligiblePlans(customer.id, { ignoreCreditRank }, {
    query: { queryKey: ["eligible-plans", customer.id, ignoreCreditRank], staleTime: 0 }
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

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }} data-testid="wizard-step-3">
      {ignoreCreditRank && <div role="status" style={{ fontSize: 12, padding: 12, background: '#fffbeb', borderRadius: 10 }}>انتخاب طرح، شرط و ثبت پرونده بدون تطابق رتبه اعتباری؛ این انتخاب در پرونده ثبت می‌شود و سایر کنترل‌های هویتی و مالی برقرارند.</div>}
      {ignoreCreditRank && <p role="status">در این حالت رتبه، نبود نتیجه یا قدیمی بودن استعلام اعتباری مانع ادامه پرونده نمی‌شود؛ کنترل‌های هویتی، مبلغ، اقساط و مدارک برقرارند.</p>}
      <div style={{ flex: 1, overflowY: "auto", maxHeight: 220 }}>
         {isLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>در حال بارگذاری طرح‌ها...</div>
          ) : isError ? <div role="alert">دریافت طرح‌ها ناموفق بود. <button type="button" onClick={() => void refetch()}>تلاش دوباره</button></div> : eligibleMatches.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
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
                   style={{
                      border: `1px solid ${selectedPlanId === plan.planId ? 'var(--nafiss-blue)' : '#e2e8f0'}`,
                      background: selectedPlanId === plan.planId ? 'var(--nafiss-light)' : (plan.primaryContractPresent ? '#fff' : '#f8fafc'),
                      padding: 14, borderRadius: 10, textAlign: 'right', width: '100%',
                      cursor: plan.primaryContractPresent && !planLocked ? 'pointer' : 'not-allowed',
                     transition: 'all 0.2s',
                      opacity: plan.primaryContractPresent && (!planLocked || selectedPlanId === plan.planId) ? 1 : 0.6
                   }}
                 >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                       <strong style={{ fontSize: 13, color: 'var(--ink-deep)' }}>{plan.name}</strong>
                        <span style={{ fontSize: 11, color: '#0f766e', background: '#ccfbf1', padding: '2px 8px', borderRadius: 10 }}>تا {planMaximum.toLocaleString('fa-IR')} تومان · {matches.length.toLocaleString('fa-IR')} شرط</span>
                    </div>
                    {!plan.primaryContractPresent && (
                       <div style={{ fontSize: 11, color: '#be123c', marginTop: 8 }}>قرارداد اصلی برای این طرح تعریف نشده است.</div>
                    )}
                  </button>
                ); })}
            </div>
         ) : (
             <div style={{ padding: 20, textAlign: "center", color: "#9f1239", fontSize: 12 }} data-testid="empty-plans">
               با نتیجه اعتبارسنجی فعلی، طرح واجد شرایطی برای ثبت درخواست وجود ندارد.
             </div>
         )}
      </div>
       {attempted && !selectedPlanId && <small role="alert" style={{ color: '#be123c' }} data-testid="error-plan-selection">برای ادامه یک طرح تسهیلاتی انتخاب کنید.</small>}

      {planLocked && (
        <p role="status" style={{ margin: 0, color: '#047857', fontSize: 12 }}>
          {feeRecoveryPending
            ? "نتیجه تلاش پرداخت این طرح باید در مرحله بعد بازیابی شود؛ تا آن زمان طرح قابل تغییر نیست."
            : "هزینه این طرح پرداخت شده است؛ برای جلوگیری از کسر دوباره، طرح انتخاب‌شده قابل تغییر نیست."}
        </p>
      )}

       {selectedGroup && (
         <div className="loan-condition-picker" data-testid="plan-conditions">
           <strong>شرط دریافت این طرح را انتخاب کنید</strong>
           <div className="loan-condition-options">
             {selectedGroup.map((condition) => (
               <button type="button" key={condition.conditionId}
                 className={currentCondition?.conditionId === condition.conditionId ? 'active' : ''}
                 aria-pressed={currentCondition?.conditionId === condition.conditionId}
                 data-testid={`condition-${condition.conditionId}`}
                 disabled={condition.conditionId <= 0 || Number(condition.maximumAmount) <= 0 || !condition.allowedDurations.length}
                 onClick={() => onSelectPlan(condition)}>
                 <strong>{condition.conditionName} · {condition.needsGuarantor ? 'با ضامن' : 'بدون ضامن'}</strong>
                 <small>سقف {Number(condition.maximumAmount).toLocaleString('fa-IR')} تومان · {condition.allowedDurations.map((months) => `${months.toLocaleString('fa-IR')} ماهه`).join('، ')}</small>
                 {condition.conditionNotes && <small>{condition.conditionNotes}</small>}
               </button>
             ))}
           </div>
           {attempted && !currentCondition && <small role="alert" style={{ color: '#be123c' }} data-testid="error-condition-selection">یکی از شروط طرح را انتخاب کنید.</small>}
         </div>
       )}
       {currentCondition && (
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
              {attempted && amountError && <small role="alert" style={{ color: '#be123c', display: 'block', marginTop: 5 }} data-testid="error-amount">{amountError}</small>}

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
                {attempted && durationError && <small role="alert" style={{ color: '#be123c', display: 'block', marginTop: 6 }} data-testid="error-duration">{durationError}</small>}
             </div>
         </div>
      )}

      <div className="form-footer" style={{ justifyContent: "space-between", marginTop: 'auto' }}>
        <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid="btn-prev-3">بازگشت</button>
        <button type="button" className="btn btn-primary" onClick={continueTerms} disabled={!eligibleResponse || (!ignoreCreditRank && !eligibleResponse.credit.fresh) || isLoading || isError} data-testid="btn-next-3">تایید و ادامه</button>
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }} data-testid="wizard-step-4">
       <div style={{ fontSize: 12, color: '#475569', background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}>
          مدارک هویتی زیر برای پرونده الزامی است. مدارک قبلی مشتری به صورت خودکار شناسایی شده‌اند.
       </div>
       <div style={{ flex: 1, overflowY: "auto", maxHeight: 250, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isLoading ? (
             <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>در حال بررسی مدارک...</div>
          ) : requiredTypes.map(req => {
             const existing = docs.find(d => d.documentType === req.key);
              const isUploading = uploadingType === req.key;
              const downloadUrl = existing
                ? `${getDownloadCustomerIdentityDocumentUrl(customer.id, existing.id)}?preview=1`
                : "";
             return (
                <div key={req.key} style={{ display: 'grid', gap: 8, padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 8, background: existing ? '#ecfdf5' : '#fff' }} data-testid={`identity-doc-row-${req.key}`}>
                   <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                         <FileText size={16} color={existing ? '#059669' : '#94a3b8'} />
                         <span style={{ fontSize: 12, color: existing ? '#065f46' : '#334155', fontWeight: 500 }}>{req.label}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                         {existing && (
                           <>
                             <span style={{ fontSize: 10, color: '#047857', fontWeight: 'bold' }} data-testid={`identity-doc-status-${req.key}`}>تکمیل شده</span>
                             <a
                               className="btn btn-ghost"
                               href={downloadUrl}
                               target="_blank"
                               rel="noreferrer"
                               style={{ height: 28, fontSize: 10, padding: '0 10px', textDecoration: 'none' }}
                               data-testid={`identity-doc-view-${req.key}`}
                             >
                               <Search size={14} /> مشاهده فایل
                             </a>
                           </>
                         )}
                         <label style={{ cursor: uploadingType ? 'not-allowed' : 'pointer' }}>
                            <span className="btn btn-ghost" style={{ height: 28, fontSize: 10, padding: '0 10px', opacity: uploadingType && !isUploading ? 0.55 : 1 }} data-testid={`identity-doc-upload-${req.key}`}>
                              {isUploading ? <><RefreshCw size={14} className="spin" /> در حال بارگذاری...</> : <><UploadCloud size={14} /> {existing ? "آپلود مجدد" : "بارگذاری"}</>}
                            </span>
                            <input type="file" disabled={Boolean(uploadingType)} style={{ display: 'none' }} onChange={(e) => handleFileChange(e, req.key)} accept={documentFileAccept} />
                         </label>
                      </div>
                  </div>
                    {uploadErrors[req.key] ? <div role="alert" style={{ color: '#b91c1c', fontSize: 10 }} data-testid={`error-identity-doc-${req.key}`}>{uploadErrors[req.key]}</div>
                      : continueAttempted && !existing ? <div role="alert" style={{ color: '#b91c1c', fontSize: 10 }} data-testid={`error-identity-doc-${req.key}`}>بارگذاری این مدرک الزامی است.</div> : null}
               </div>
             );
          })}
       </div>
       
       <div className="form-footer" style={{ justifyContent: "space-between", marginTop: 'auto' }}>
        <button type="button" className="btn btn-ghost" onClick={onPrev} data-testid="btn-prev-4">بازگشت</button>
         <button type="button" className="btn btn-primary" onClick={continueToReview} disabled={Boolean(uploadingType)} data-testid="btn-next-4">تایید و ادامه</button>
      </div>
    </div>
  );
}

// --- Step 5 ---
function Step5Review({ customer, plan, amount, duration, onNext, onPrev, isPending, error, serverErrors = {} }: any) {
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const manualVariables = plan.manualVariables ?? [];
  const manualComplete = manualVariables.every((item: any) => String(manualValues[item.variable] ?? "").trim());
  const submitReview = () => {
    setAttempted(true);
    if (manualComplete && plan.contractTemplateId) onNext(manualValues);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }} data-testid="wizard-step-5">
      <div className="review-card" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
         <h4 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--ink-deep)' }}>خلاصه درخواست</h4>
         <div style={{ display: 'grid', gap: 12, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: 8 }}>
               <span style={{ color: '#64748b' }}>مشتری:</span>
               <strong style={{ color: 'var(--ink-deep)' }} data-testid="review-customer-name">{customer.name} ({customer.nationalCode})</strong>
               <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {customer.salespersonName || 'بدون تخصیص'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: 8 }}>
               <span style={{ color: '#64748b' }}>طرح تسهیلاتی:</span>
               <strong style={{ color: 'var(--ink-deep)' }} data-testid="review-plan-name">{plan.name}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: 8 }}>
               <span style={{ color: '#64748b' }}>مبلغ درخواستی:</span>
               <strong style={{ color: 'var(--ink-deep)' }} dir="ltr" data-testid="review-amount">{Number(amount).toLocaleString('fa-IR')} تومان</strong>
                {serverErrors.amount && <small role="alert" style={{ color: '#be123c' }} data-testid="error-submit-amount">{serverErrors.amount}</small>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
               <span style={{ color: '#64748b' }}>مدت اقساط:</span>
               <strong style={{ color: 'var(--ink-deep)' }} data-testid="review-duration">{duration} ماه</strong>
                {serverErrors.duration && <small role="alert" style={{ color: '#be123c' }} data-testid="error-submit-duration">{serverErrors.duration}</small>}
            </div>
         </div>
      </div>

      {manualVariables.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          <h4 style={{ margin: 0, fontSize: 13 }}>اطلاعات تکمیلی قرارداد</h4>
          {manualVariables.map((item: any) => (
            <label key={item.variable} className="field">
              <span>{item.label}</span>
              <input
                value={manualValues[item.variable] ?? ""}
                onChange={(event) => setManualValues((current) => ({ ...current, [item.variable]: event.target.value }))}
                disabled={isPending}
                aria-invalid={Boolean((attempted && !String(manualValues[item.variable] ?? '').trim()) || serverErrors[item.variable])}
                data-testid={`contract-variable-${item.variable}`}
              />
              {attempted && !String(manualValues[item.variable] ?? '').trim() && <small role="alert" style={{ color: '#be123c' }} data-testid={`error-contract-variable-${item.variable}`}>تکمیل این فیلد برای تولید قرارداد الزامی است.</small>}
              {serverErrors[item.variable] && <small role="alert" style={{ color: '#be123c' }} data-testid={`error-contract-variable-server-${item.variable}`}>{serverErrors[item.variable]}</small>}
            </label>
          ))}
        </div>
      )}
      
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: '#eff6ff', color: '#1e3a8a', padding: 12, borderRadius: 8, fontSize: 11 }}>
         <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
         <div>با ادامه، فقط پرونده ثبت می‌شود. کارشناس ثبت ابتدا شرایط تسهیلات را تأیید می‌کند؛ قرارداد پس از این تصمیم در صفحه پرونده صادر خواهد شد.</div>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {attempted && !plan.contractTemplateId && <div className="form-error" role="alert" data-testid="error-contract-template">برای طرح انتخاب‌شده قالب قرارداد قابل استفاده ثبت نشده است.</div>}

      <div className="form-footer" style={{ justifyContent: "space-between", marginTop: 'auto' }}>
          <button type="button" className="btn btn-ghost" onClick={onPrev} disabled={isPending} data-testid="btn-prev-5">بازگشت</button>
          <button type="button" className="btn btn-primary" onClick={submitReview} disabled={isPending} data-testid="btn-submit-wizard">
            {isPending ? 'در حال ثبت پرونده...' : 'ثبت پرونده و مشاهده جزئیات'}
          </button>
      </div>
    </div>
  );
}
