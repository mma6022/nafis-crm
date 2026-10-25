import React, { useState, useEffect } from 'react';
import { documentFileAccept } from '@/lib/document-upload-type';
import { Link, useLocation, useParams } from 'wouter';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  useGetLoanApplication,
  useUpdateLoanApplication,
  useUploadCustomerIdentityDocument,
  type CustomerIdentityDocumentUploadDocumentType,
  useExpertApproveLoanApplication,
  useExpertRejectLoanApplication,
  useFunderInitialApproveLoanApplication,
  useFunderInitialRejectLoanApplication,
  useAdminRejectLoanApplication,
  useApproveLoanApplicationAsAdmin,
  useCompleteLoanApplication,
  useUploadLoanApplicationDocument,
  useAddLoanApplicationManualRequirement,
  useDeleteLoanApplicationManualRequirement,
  useReviewLoanApplicationDocument,
  useDeleteLoanApplicationDocument,
  useDeleteLoanApplicationGuarantorDocument,
  useRegisterLoanApplicationGuarantor,
  useUploadLoanApplicationGuarantorDocument,
  useReviewLoanApplicationGuarantorDocument,
  useSubmitLoanApplicationCollateral,
  useReviewLoanApplicationCollateral,
  useSubmitPrimaryContractLoanApplication,
  useConfirmSignedPrimaryLoanApplication,
  useGenerateContract,
  useSendContractGeneration,
  useLinkLoanApplicationGeneratedDocument,
  useVerifyLoanApplicationGeneratedDocumentSignature,
  getLoanApplicationGeneratedDocumentSignatureStatus,
  useReviewLoanApplicationGeneratedDocument,
  useSubmitCustomerDocumentsLoanApplication,
  useReviewCustomerDocumentsLoanApplication,
  useStartGuarantorDocumentsLoanApplication,
  useSubmitGuarantorDocumentsLoanApplication,
  useReviewGuarantorDocumentsLoanApplication,
  useSubmitCollateralLoanApplication,
  useReviewCollateralLoanApplication as useReviewCollateralStage,
  getGetLoanApplicationQueryKey,
  getListLoanApplicationsQueryKey,
  useGetAuthSession,
  useListLoanApplicationCreditRankOverrides,
  getListLoanApplicationCreditRankOverridesQueryKey,
  getGetAuthSessionQueryKey,
  useAuthorizeLoanApplicationTomanReplacement,
  type TomanReplacementEligibility,
  type TomanReplacementState,
} from '@workspace/api-client-react';
import { 
  CheckCircle2, XCircle, Clock, UploadCloud, ShieldCheck, 
  FileText, Landmark, UserPlus, CreditCard, Play, FileSignature, 
  Trash2, Search, Plus, Download
} from 'lucide-react';
import { SkeletonPanel, ErrorState, formatDate } from '@/components/CrmShell';
import { CreditRankOverrideRows } from '@/components/loan-applications/CreditRankOverrideLog';
import { Modal } from '@/components/DataTools';
import { AdminCaseCorrections } from '@/components/loan-applications/AdminCaseCorrections';
import { LoanCaseCancellation } from '@/components/loan-applications/LoanCaseCancellation';
import { InitialApprovalTerms, getInitialApprovalOptions } from '@/components/loan-applications/InitialApprovalTerms';
import { UpdatedContractBanner } from '@/components/UpdatedContractBanner';
import { RejectedContractResend } from '@/components/loan-applications/RejectedContractResend';
import { PhysicalSubmission } from '@/components/loan-applications/PhysicalSubmission';
import { classifySignatureVerificationError, providerReportsSigned, providerReportsRejected, type SignatureStatusWorkflowOutcome } from '@/lib/loan-signature-verification-errors.mjs';
import { CaseNotesRoom } from '@/loan-case-history/CaseNotesRoom';
import { CaseHistoryDialog } from '@/loan-case-history/CaseHistoryDialog';
import { loanDecisionErrorMessage } from '@/lib/loan-decision-errors';
import { ACTION_ROLE_NAMES, BUSINESS_STATUS_LABELS, loanBusinessStatus } from '@/lib/loan-labels';
import '@/pages/customers.css';
import '@/pages/loan-requests.css';
import { ChevronLeft as ChevronLeftIcon, User as UserIcon } from 'lucide-react';
import { CustomerName } from '@/components/customer/CustomerName';

const STAGE_LABELS: Record<string, string> = {
  funder_initial_approval: 'تصویب مبلغ وام',
  draft: 'پیش‌نویس',
  primary_contract_pending_signature: 'در انتظار امضای قرارداد توسط مشتری',
  approved_contract_pending_signature: 'امضای قرارداد جایگزین توسط مشتری',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  collateral_review: 'بررسی وثیقه',
  physical_documents_correction: 'رفع نقص مدارک فیزیکی',
  physical_documents_submission: 'ارسال مدارک فیزیکی',
  physical_documents_review: 'بررسی مدارک فیزیکی',
  expert_approval: 'ثبت تصمیم تأمین‌کننده مالی',
  funder_documents_correction: 'اصلاح مدارک مردود تأمین‌کننده',
  funder_result_review: 'بررسی نتیجه تامین‌کننده',
  funder_amendment_pending_signature: 'در انتظار امضای الحاقیه قرارداد',
  funder_amendment_review: 'بررسی الحاقیه قرارداد',
  admin_approval: 'تأیید نهایی مدیر و شارژ اعتبار',
  wallet_charge_pending: 'در انتظار تأیید شارژ توسط کارشناس ثبت',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل شده',
};

type TimelineStep = {
  id: string;
  label: string;
  stages: string[];
};

const TIMELINE_STEPS: TimelineStep[] = [
  { id: 'contract', label: 'قرارداد اولیه', stages: ['draft', 'primary_contract_pending_signature'] },
  { id: 'customer', label: 'مدارک مشتری', stages: ['customer_documents_upload', 'customer_documents_review'] },
  { id: 'guarantor_registration', label: 'ثبت ضامن', stages: ['guarantor_registration'] },
  { id: 'initial', label: 'تصویب مبلغ وام', stages: ['funder_initial_approval'] },
  { id: 'guarantor_docs', label: 'مدارک ضامن', stages: ['guarantor_documents_upload', 'guarantor_documents_review'] },
  { id: 'collateral', label: 'وثیقه', stages: ['collateral_upload', 'collateral_review'] },
  { id: 'approval', label: 'تصمیم نهایی تأمین‌کننده', stages: ['expert_approval', 'funder_result_review', 'funder_documents_correction'] },
  { id: 'physical', label: 'مدارک فیزیکی', stages: ['physical_documents_submission', 'physical_documents_correction', 'physical_documents_review'] },
  { id: 'wallet', label: 'شارژ و تأیید مدیریت', stages: ['wallet_charge_pending', 'admin_approval'] },
  { id: 'final', label: 'خاتمه', stages: ['final_invoice_pending_signature', 'completed'] },
];

// Cases already in progress retain their original timeline; newly sequenced
// cases collect customer documents and register a guarantor before initial approval.
const NEW_CASE_TIMELINE_STEPS: TimelineStep[] = [
  { id: 'contract', label: 'قرارداد اولیه و امضا', stages: ['draft', 'primary_contract_pending_signature'] },
  { id: 'customer', label: 'مدارک مشتری', stages: ['customer_documents_upload', 'customer_documents_review'] },
  { id: 'guarantor_registration', label: 'ثبت ضامن', stages: ['guarantor_registration'] },
  { id: 'initial', label: 'تصویب مبلغ وام', stages: ['funder_initial_approval'] },
  { id: 'replacement', label: 'قرارداد جایگزین (در صورت تغییر مبلغ)', stages: ['approved_contract_pending_signature'] },
  { id: 'guarantor_docs', label: 'مدارک ضامن', stages: ['guarantor_documents_upload', 'guarantor_documents_review'] },
  { id: 'collateral', label: 'وثیقه', stages: ['collateral_upload', 'collateral_review'] },
  { id: 'approval', label: 'تصمیم نهایی تأمین‌کننده', stages: ['expert_approval', 'funder_result_review', 'funder_documents_correction'] },
  { id: 'physical', label: 'مدارک فیزیکی', stages: ['physical_documents_submission', 'physical_documents_correction', 'physical_documents_review'] },
  { id: 'wallet', label: 'شارژ و تأیید مدیریت', stages: ['wallet_charge_pending', 'admin_approval'] },
  { id: 'final', label: 'خاتمه', stages: ['final_invoice_pending_signature', 'completed'] },
];

const STATUS_LABELS: Record<string, string> = {
  requested: 'درخواست شده',
  reviewing: 'در حال بررسی',
  approved: 'تأیید شده',
  rejected: 'رد شده',
};

function isCurrentPrimaryDocument(doc: any, generationId: number | null): boolean {
  return doc.kind === 'primary' && generationId !== null
    && Number(doc.contractGenerationId) === generationId
    && doc.isCurrentPrimary !== false && doc.current !== false;
}

function normalizeTermDigits(value: string) {
  return value
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[,\u066C\s]/g, '');
}

function formatTomanAmount(value: string): string {
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString('fa-IR') : value;
}
function ApplicationTermsEditor({ appId, requestedAmount, durationMonths }: {
  appId: number;
  requestedAmount: string;
  durationMonths: number;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(requestedAmount);
  const [duration, setDuration] = useState(String(durationMonths));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const updateApplication = useUpdateLoanApplication();

  useEffect(() => {
    setAmount(requestedAmount);
    setDuration(String(durationMonths));
  }, [requestedAmount, durationMonths]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSaved(false);
    const normalizedAmount = normalizeTermDigits(amount);
    const normalizedDuration = normalizeTermDigits(duration);
    if (!/^[1-9]\d{0,17}$/.test(normalizedAmount) || !/^\d+$/.test(normalizedDuration)
      || !Number.isSafeInteger(Number(normalizedDuration)) || Number(normalizedDuration) < 1 || Number(normalizedDuration) > 600) {
      setError('مبلغ باید مثبت و مدت بازپرداخت باید بین ۱ تا ۶۰۰ ماه باشد.');
      return;
    }
    updateApplication.mutate({ id: appId, data: { requestedAmount: normalizedAmount, durationMonths: Number(normalizedDuration) } }, {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) }),
          queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() }),
        ]);
        setSaved(true);
      },
      onError: (mutationError) => {
        const failure = mutationError as { data?: { error?: string }; response?: { data?: { error?: string } } };
        const code = failure.data?.error ?? failure.response?.data?.error;
        const messages: Record<string, string> = {
          application_terms_not_eligible: 'مبلغ یا مدت انتخاب‌شده با شرایط طرح و اعتبار مشتری سازگار نیست.',
          application_not_editable: 'این پرونده دیگر قابل ویرایش نیست.',
          approved_application_terms_immutable: 'پس از تأیید یا صدور قرارداد، شرایط درخواست قابل تغییر نیست.',
          action_forbidden: 'شما مجاز به ویرایش شرایط این پرونده نیستید.',
        };
        setError((code && messages[code]) || 'ذخیره تغییرات انجام نشد؛ اطلاعات را بررسی و دوباره تلاش کنید.');
      },
    });
  };

  return <form onSubmit={submit} style={{ marginTop: 18, padding: 16, border: '1px solid #dbeafe', borderRadius: 10, background: '#f8fbff', display: 'grid', gap: 12 }}>
    <div>
      <strong style={{ fontSize: 13 }}>ویرایش شرایط درخواست</strong>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>پیش از تصویب مبلغ وام یا صدور قرارداد امکان‌پذیر است؛ اعتبارسنجی نهایی با سامانه انجام می‌شود.</p>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      <label style={{ display: 'grid', gap: 6, fontSize: 12, color: '#475569' }}>
        مبلغ درخواستی (تومان)
        <input type="text" inputMode="numeric" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} aria-label="مبلغ درخواستی جدید" />
      </label>
      <label style={{ display: 'grid', gap: 6, fontSize: 12, color: '#475569' }}>
        مدت بازپرداخت (ماه)
        <input type="text" inputMode="numeric" dir="ltr" value={duration} onChange={(event) => setDuration(event.target.value)} aria-label="مدت بازپرداخت جدید" />
      </label>
    </div>
    {error && <p role="alert" style={{ margin: 0, color: '#b91c1c', fontSize: 12 }}>{error}</p>}
    {saved && <p role="status" style={{ margin: 0, color: '#047857', fontSize: 12 }}>شرایط درخواست با موفقیت به‌روزرسانی شد.</p>}
    <div><button type="submit" className="btn btn-primary" disabled={updateApplication.isPending}>{updateApplication.isPending ? 'در حال ذخیره…' : 'ذخیره شرایط'}</button></div>
  </form>;
}

function sameTomanReplacementTerms(
  first: TomanReplacementEligibility | null | undefined,
  second: TomanReplacementEligibility | null | undefined,
): boolean {
  return Boolean(first?.eligible && second?.eligible
    && first.candidate === second.candidate
    && first.sourceGenerationId === second.sourceGenerationId
    && first.approvedAmount === second.approvedAmount
    && first.durationMonths === second.durationMonths
    && first.tomanTemplateId === second.tomanTemplateId
    && first.tomanTemplateName === second.tomanTemplateName);
}
export default function LoanApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const appId = Number(id);
  const queryClient = useQueryClient();

  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const { data: app, isLoading, isError, error, refetch } = useGetLoanApplication(appId, {
    query: { queryKey: getGetLoanApplicationQueryKey(appId), enabled: !isNaN(appId), refetchInterval: 20000, refetchOnWindowFocus: true }
  });
  const caseOpen = app?.status !== 'rejected';
  const canUpdate = caseOpen && (user?.role === 'admin' || user?.permissions?.includes('loan_applications.update'));
  const canReview = caseOpen && (user?.role === 'admin' || user?.permissions?.includes('loan_applications.review'));
  const canSalespersonAct = caseOpen && (user?.role === 'admin' || user?.role === 'salesperson');
  const canRegistrarAct = caseOpen && (user?.role === 'admin' || user?.role === 'registrar');

  const [reviewModal, setReviewModal] = useState<'initial_approve' | 'initial_reject' | 'expert_approve' | 'expert_reject' | 'admin_approve' | 'admin_reject' | 'complete' | 'review_cust_docs' | 'review_guar_docs' | 'review_collateral' | 'return_cust_docs' | 'return_guar_docs' | 'return_collateral' | 'return_physical' | 'physical_general_defect' | null>(null);
  useEffect(() => {
    if (!reviewModal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReviewModal(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [reviewModal]);
  const [reviewReason, setReviewReason] = useState('');
  const [approvedPrincipal, setApprovedPrincipal] = useState('');
  const [approvedDuration, setApprovedDuration] = useState(0);
  const [approvalError, setApprovalError] = useState('');
  const [defectReasons, setDefectReasons] = useState<Record<string, string>>({});
  const [physicalNotes, setPhysicalNotes] = useState<Record<number, string>>({});
  const [actionError, setActionError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [lastStage, setLastStage] = useState(app?.stage);
  // A refusal shown in one decision dialog must not leak into the next one.
  useEffect(() => { setApprovalError(''); }, [reviewModal]);
  if (app && app.stage !== lastStage) {
    setLastStage(app.stage);
    setSelectedStepId(null);
  }

  const expertApprove = useExpertApproveLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const expertReject = useExpertRejectLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const initialApprove = useFunderInitialApproveLoanApplication({ mutation: { onSuccess: () => { void queryClient.invalidateQueries(); setReviewModal(null); } } });
  const initialReject = useFunderInitialRejectLoanApplication({ mutation: { onSuccess: () => { void queryClient.invalidateQueries(); setReviewModal(null); } } });
  const adminApprove = useApproveLoanApplicationAsAdmin({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const adminReject = useAdminRejectLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const completeLoan = useCompleteLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });

  const submitCustDocs = useSubmitCustomerDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCustDocs = useReviewCustomerDocumentsLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const startGuarDocs = useStartGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const submitGuarDocs = useSubmitGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewGuarDocs = useReviewGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const submitCollateral = useSubmitCollateralLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCollateral = useReviewCollateralStage({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const returnForCorrection = useMutation({
    mutationFn: async ({ path, reason }: { path: string; reason: string }) => {
      const response = await fetch(`/api/loan-applications/${appId}/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(loanDecisionErrorMessage({ status: response.status, data }, 'بازگشت پرونده ممکن نشد؛ دوباره تلاش کنید.'));
      }
      return response.json();
    },
    onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); setReviewReason(''); setActionError(''); },
    onError: (e: Error) => setActionError(e.message),
  });
  const stageAction = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: object }) => {
      const response = await fetch(`/api/loan-applications/${appId}/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const errorMessages: Record<string, string> = {
          physical_documents_incomplete: 'ابتدا نقص‌های شناخته‌شده مدارک فیزیکی را برطرف کنید.',
          physical_documents_missing: 'هیچ مدرک بارگذاری‌شده‌ای برای تشکیل و تأیید فهرست مدارک فیزیکی وجود ندارد.',
          physical_defect_required: 'ابتدا نقص یک مدرک فیزیکی یا نقص عمومی را ثبت کنید.',
          physical_review_stage_required: 'تشکیل فهرست فیزیکی در این مرحله ممکن نیست.',
          physical_defects_required: 'برای اعلام نقص مدارک فیزیکی، درج دلیل کلی الزامی است.',
          review_reason_required: 'درج دلیل بازگشت پرونده الزامی است.',
          correction_note_required: 'توضیح اصلاح انجام‌شده الزامی است.',
          physical_check_not_incomplete: 'این مدرک نقص ثبت‌شده‌ای برای اصلاح ندارد.',
          invalid_stage_transition: 'این اقدام در مرحله فعلی پرونده مجاز نیست.',
          financial_posting_history_unverified: 'این پرونده سابقهٔ تأیید مالی دارد، اما ثبت پرداخت آن قابل تأیید نیست. برای جلوگیری از پرداخت تکراری، ابتدا سابقهٔ مالی را بررسی کنید.',
          admin_case_financial_terms_locked: 'شرایط مالی پروندهٔ دارای سابقهٔ پرداخت یا تکمیل قابل تغییر نیست؛ فقط یادداشت و اصلاح مدیریتی مرحله مجاز است.',
          action_forbidden: 'شما مجاز به انجام این اقدام در مرحله فعلی نیستید.',
        };
        throw new Error(errorMessages[data.error] || loanDecisionErrorMessage({ status: response.status, data }, 'ثبت تغییر ممکن نشد'));
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) }),
        queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() }),
      ]);
      setActionError('');
      const correctedCheck = variables.path.match(/^physical-checks\/(\d+)\/correct$/);
      if (correctedCheck) {
        setPhysicalNotes(prev => {
          const next = { ...prev };
          delete next[Number(correctedCheck[1])];
          return next;
        });
      }
      setDefectReasons({});
      setReviewModal(null);
      setReviewReason('');
    },
    onError: (e: Error) => setActionError(e.message),
  });

  const handleReviewAction = () => {
    const data = { reason: reviewReason };
    switch (reviewModal) {
      case 'initial_approve': {
        const normalized = approvedPrincipal.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[,\u066C\s]/g, '');
        if (!/^[0-9]+$/.test(normalized) || BigInt(normalized || '0') <= 0n || BigInt(normalized || '0').toString().length > 18) {
          setApprovalError('اصل تسهیلات باید مبلغ صحیح و مثبت به تومان باشد.');
          return;
        }
        if (BigInt(normalized) > BigInt(approvalOptions.maximumAmount)) {
          setApprovalError('اصل تسهیلات مصوب از سقف این طرح بیشتر است.');
          return;
        }
        if (!Number.isSafeInteger(approvedDuration) || approvedDuration < 1 || approvedDuration > 600 ||
          (approvedDuration !== Number(requestedDuration ?? app?.durationMonths ?? 0) && !approvalOptions.allowedDurations.includes(approvedDuration))) {
          setApprovalError('تعداد اقساط مصوب باید از گزینه‌های مجاز طرح باشد.');
          return;
        }
        setApprovalError('');
        initialApprove.mutate({ id: appId, data: { approvedAmount: BigInt(normalized).toString(), approvedDurationMonths: approvedDuration, reason: reviewReason.trim() || undefined } }, {
          onError: (error) => {
            const failure = error as { data?: { error?: string }; response?: { data?: { error?: string } } };
            const code = failure.data?.error ?? failure.response?.data?.error;
            setApprovalError(code === 'approved_duration_not_allowed' ? 'تعداد اقساط انتخاب‌شده برای این طرح مجاز نیست.'
              : code === 'approved_duration_contract_mapping_required' ? 'قالب قرارداد این طرح، تعداد اقساط را در متن قرارداد ثبت نمی‌کند. برای تغییر اقساط، ابتدا نگاشت قالب قرارداد را تکمیل کنید.'
              : code === 'approved_amount_exceeds_plan_ceiling' ? 'اصل تسهیلات مصوب از سقف این طرح بیشتر است.'
              : code === 'requested_primary_or_documents_not_verified' ? 'قرارداد اولیه یا مدارک هنوز تأیید نشده‌اند.'
              : code === 'invalid_deduction_percent' ? 'درصد کسر طرح برای تعداد اقساط انتخاب‌شده نامعتبر است. تنظیمات طرح باید اصلاح شود.'
              : code === 'guarantor_required_before_approval' ? 'ابتدا ضامن را ثبت کنید، سپس مبلغ وام را تصویب کنید.'
              : loanDecisionErrorMessage(error, 'تصویب مبلغ وام انجام نشد. شرایط را بررسی و دوباره تلاش کنید.'));
          },
        });
        break;
      }
      case 'initial_reject':
        if (!reviewReason.trim()) { setApprovalError('دلیل رد اولیه الزامی است.'); return; }
        initialReject.mutate({ id: appId, data: { reason: reviewReason.trim() } }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت رد اولیه انجام نشد. دوباره تلاش کنید.')) });
        break;
      case 'expert_approve': expertApprove.mutate({ id: appId }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت تصمیم نهایی انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'expert_reject': expertReject.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت رد تأمین‌کننده انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'admin_approve': adminApprove.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت تأیید نهایی مدیر انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'admin_reject': adminReject.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت رد مدیر انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'complete': completeLoan.mutate({ id: appId }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'خاتمهٔ پرونده انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'review_cust_docs': reviewCustDocs.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت بررسی مدارک مشتری انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'review_guar_docs': reviewGuarDocs.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت بررسی مدارک ضامن انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'review_collateral': reviewCollateral.mutate({ id: appId, data }, { onError: (error) => setApprovalError(loanDecisionErrorMessage(error, 'ثبت بررسی وثایق انجام نشد. دوباره تلاش کنید.')) }); break;
      case 'return_cust_docs': returnForCorrection.mutate({ path: 'return-customer-documents', reason: reviewReason }); break;
      case 'return_guar_docs': returnForCorrection.mutate({ path: 'return-guarantor-documents', reason: reviewReason }); break;
      case 'return_collateral': returnForCorrection.mutate({ path: 'return-collateral', reason: reviewReason }); break;
      case 'return_physical': stageAction.mutate({ path: 'return-physical-documents', body: { reason: reviewReason.trim() } }); break;
      case 'physical_general_defect': stageAction.mutate({ path: 'physical-checks/general/review', body: { reason: reviewReason.trim() } }); break;
    }
  };

  if (isLoading) return <section className="data-page csx ldx" aria-busy="true"><SkeletonPanel rows={8} /></section>;
  if (isError || !app) {
    const notFound = !isError || (error as any)?.status === 404 || (error as any)?.response?.status === 404;
    return <section className="data-page csx ldx" data-testid="loan-application-detail-error">
      <nav className="ldx-crumb" aria-label="مسیر"><Link href="/loan-applications">درخواست تسهیلات</Link><ChevronLeftIcon /><span>پرونده #{appId}</span></nav>
      <div className="ldx-card ldx-miss">
        <h1>{notFound ? 'پرونده پیدا نشد' : 'بارگذاری پرونده ناموفق بود'}</h1>
        <p>{notFound ? 'این پرونده وجود ندارد یا به شما تخصیص داده نشده است.' : 'اتصال را بررسی کنید و دوباره تلاش کنید.'}</p>
        {notFound ? <Link className="csx-primary" href="/loan-applications">بازگشت به درخواست‌ها</Link> : <ErrorState onRetry={() => refetch()} />}
      </div>
    </section>;
  }

  const customerDocs = (app.documents || []).filter((doc: any) =>
    doc.source !== 'identity_vault' && !['guarantee_check', 'guarantee_promissory'].includes(doc.requirement_key || doc.requirementKey)
  );
  const guarantor = app.guarantor as any;
  const guarantorDocs = (guarantor?.documents || []) as any[];
  const collaterals = (app.collateral || []) as any[];
  const generatedDocs = (app.generatedDocuments || []) as any[];
  const currentPrimaryGenerationId = (app as any).currentPrimaryGenerationId == null
    ? null : Number((app as any).currentPrimaryGenerationId);
  const identityDocs = ((app as any).identityDocuments || []) as any[];
  const requiredCollateral = ((app as any).requiredCollateral || []) as any[];
  const physicalChecks = ((app as any).physicalChecks || []) as any[];
  const physicalDocuments = app.physicalDocuments || [];
  const noPhysicalDocumentsDeclared = (app.history || []).some((entry: any) => entry.action === 'physical-documents-none-declared');
  const physicalDocumentsPreviouslySubmitted = (app.history || []).some((entry: any) => entry.action === 'submit-physical-documents');
  const physicalReturnReason = [...(app.history || [])].reverse().find((entry: any) => entry.action === 'return-physical-documents')?.reason;
  const hasIncompletePhysicalChecks = physicalChecks.some((check: any) => check.status === 'incomplete');
  const physicalCorrectionByCheck = new Map<number, string>();
  const physicalReasonByCheck = new Map<number, string>();
  for (const entry of ((app.history || []) as any[])) {
    const action = String(entry.action || entry.status || '');
    const correctionMatch = action.match(/^physical_corrected:(\d+)$/);
    const incompleteMatch = action.match(/^physical_incomplete:(\d+)$/);
    if (correctionMatch) physicalCorrectionByCheck.set(Number(correctionMatch[1]), entry.reason || entry.note || entry.description || '');
    if (incompleteMatch) physicalReasonByCheck.set(Number(incompleteMatch[1]), entry.reason || entry.note || entry.description || '');
  }
  const funderDefects = (((app as any).funderDefects || []) as any[]).filter((d: any) => !d.resolved_at);
  const funderDecision = (app as any).funderDecision as string | null;
  const funderReason = (app as any).funderReason as string | null;
  const requestedDuration = app.requestedDurationMonths;
  const approvalOptions = getInitialApprovalOptions(app.planSnapshot, app.conditionSnapshot);
  const openFunderApproval = () => {
    setReviewReason('');
    setApprovalError('');
    setReviewModal('expert_approve');
  };
  const openInitialDecision = (decision: 'initial_approve' | 'initial_reject') => {
    setApprovedPrincipal(String(app.approvedAmount ?? app.requestedAmount ?? ''));
    setApprovedDuration(Number(requestedDuration ?? app.durationMonths ?? 0));
    setReviewReason('');
    setApprovalError('');
    setReviewModal(decision);
  };
  const funderItems = [
    ...customerDocs.map((d: any) => ({ source: 'document', id: d.id, label: d.label || d.original_name || `مدرک ${d.id}` })),
    ...guarantorDocs.map((d: any) => ({ source: 'guarantor', id: d.id, label: d.requirement_key || `مدرک ضامن ${d.id}` })),
    ...collaterals.map((d: any) => ({ source: 'collateral', id: d.id, label: d.dataJson?.label || `وثیقه ${d.id}` })),
  ];
  const customerDocumentsApproved = customerDocs.every((doc: any) => doc.status === 'approved');
  const identityDocumentsApproved = identityDocs.length === 5 && identityDocs.every((doc: any) => Boolean(doc.approvedAt || doc.approved_at));
  const primaryContract = [...generatedDocs].reverse().find((doc: any) => isCurrentPrimaryDocument(doc, currentPrimaryGenerationId));
  const primaryContractApproved = Boolean(primaryContract?.signed && primaryContract?.status === 'approved');
  const approvedPrincipalNormalized = normalizeTermDigits(approvedPrincipal);
  const requestedPrincipalNormalized = normalizeTermDigits(String(app.requestedAmount));
  const approvalKeepsInitialContract = Boolean(primaryContract?.signed && approvedPrincipalNormalized
    && approvedPrincipalNormalized === requestedPrincipalNormalized && approvedDuration === requestedDuration);
  const newCaseSequence = app.newCaseWorkflow;
  const condition = app.conditionSnapshot as { needs_guarantor?: unknown; needsGuarantor?: unknown } | null;
  const needsGuarantor = Boolean(condition?.needs_guarantor || condition?.needsGuarantor);
  const timelineSteps = newCaseSequence
    ? NEW_CASE_TIMELINE_STEPS.filter(step => !(!needsGuarantor && ['guarantor_registration', 'guarantor_docs'].includes(step.id))
      && !(step.id === 'replacement' && app.initialContractRetained))
    : TIMELINE_STEPS.filter(step => needsGuarantor || !['guarantor_registration', 'guarantor_docs'].includes(step.id));
  const customerReviewReady = customerDocumentsApproved && identityDocumentsApproved && primaryContractApproved;
  const customerReviewDone = customerDocs.every((d: any) => ['approved', 'incomplete', 'rejected'].includes(d.status))
    && identityDocs.length === 5 && identityDocs.every((d: any) => d.approvedAt || d.approved_at || d.reviewReason || d.review_reason)
    && Boolean(primaryContract?.signed && ['approved', 'incomplete', 'rejected'].includes(primaryContract.status));
  const customerHasDefect = customerDocs.some((d: any) => ['incomplete', 'rejected'].includes(d.status))
    || identityDocs.some((d: any) => Boolean(d.reviewReason || d.review_reason))
    || Boolean(primaryContract && ['incomplete', 'rejected'].includes(primaryContract.status));
  const guarantorDocumentsApproved = Boolean(guarantor) && guarantorDocs.every((doc: any) => doc.status === 'approved');
  const guarantorReviewDone = Boolean(guarantor) && guarantorDocs.every((doc: any) => ['approved', 'incomplete', 'rejected'].includes(doc.status));
  const guarantorHasDefect = guarantorDocs.some((doc: any) => ['incomplete', 'rejected'].includes(doc.status));
  const collateralApproved = requiredCollateral.every((slot: any) => collaterals.some((item: any) => {
    const metadata = item.dataJson || (() => { try { return JSON.parse(item.data_json || '{}'); } catch { return {}; } })();
    return metadata.requirementKey === slot.key && item.status === 'approved';
  }));
  const collateralReviewDone = requiredCollateral.every((slot: any) => collaterals.some((item: any) => {
    const metadata = item.dataJson || (() => { try { return JSON.parse(item.data_json || '{}'); } catch { return {}; } })();
    return metadata.requirementKey === slot.key && ['approved', 'incomplete', 'rejected'].includes(item.status);
  }));
  const collateralHasDefect = collaterals.some((item: any) => ['incomplete', 'rejected'].includes(item.status));
  const registrarReview = (app as any).registrarReview as { allApproved: boolean; allReviewed: boolean; hasDefect: boolean } | undefined;
  const reviewFor = (stage: string, allApproved: boolean, allReviewed: boolean, hasDefect: boolean) =>
    app.stage === stage && registrarReview ? registrarReview : { allApproved, allReviewed, hasDefect };
  const isApplicationTermsOwner = user?.role === 'admin'
    || (user?.role === 'salesperson' && user.salespersonId != null
      && app.customerSalespersonId === user.salespersonId);
  const canEditApplicationTerms = Boolean(canUpdate && isApplicationTermsOwner
    && ['draft', 'funder_initial_approval'].includes(app.stage || '')
    && !['approved', 'rejected'].includes(app.status)
    && !app.approvedAmount
    && app.currentPrimaryGenerationId == null
    && !generatedDocs.some((doc: any) => doc.kind === 'primary'));

  const currentStepIndex = timelineSteps.findIndex(s => s.stages.includes(app.stage || 'draft'));
  const currentStepId = currentStepIndex >= 0 ? timelineSteps[currentStepIndex].id : 'contract';

  const activeStepId = selectedStepId || currentStepId;

  const businessStatus = loanBusinessStatus(app);
  const appAny = app as typeof app & { actionRequired?: boolean; actionRole?: string | null; customerSalespersonName?: string | null };
  const closed = businessStatus === 'completed' || businessStatus === 'canceled';
  const turnText = closed ? '' : appAny.actionRequired ? 'نیازمند اقدام شما' : businessStatus === 'waiting_customer_signature' ? 'نوبت اقدام: مشتری' : appAny.actionRole ? `نوبت اقدام: ${ACTION_ROLE_NAMES[appAny.actionRole] ?? appAny.actionRole}` : '';
  const fa = (n: number) => n.toLocaleString('fa-IR');

  return (
    <section className="data-page csx ldx" data-testid="loan-application-detail">
      <nav className="ldx-crumb" aria-label="مسیر"><Link href="/loan-applications">درخواست تسهیلات</Link><ChevronLeftIcon /><span>پرونده #{app.id}</span></nav>
      <div className="ldx-grid">
        <div className="ldx-col">
      <div className="ldx-card ldx-head">
        <div className="ldx-pills">
          {businessStatus && BUSINESS_STATUS_LABELS[businessStatus]
            ? <span className="csx-st" data-bs={businessStatus} data-testid="loan-business-status">{BUSINESS_STATUS_LABELS[businessStatus]}</span>
            : <span className={`status-pill ${app.status === 'approved' ? 'status-active' : app.status === 'rejected' ? 'status-failed' : 'status-new'}`}>{app.cancellationReason ? 'لغو شده' : STATUS_LABELS[app.status] || app.status}</span>}
          {turnText ? <span className={`csx-tag ${appAny.actionRequired ? 'bad' : ''}`} data-testid="loan-turn">{turnText}</span> : null}
        </div>
        <div className="eyebrow">پرونده تسهیلات #{app.id}</div>
        <h1 className="ldx-name"><CustomerName id={app.customerId} name={app.customerName || 'مشتری'} /></h1>
        <p className="ldx-meta">ثبت شده در {formatDate(app.createdAt)} · طرح {app.planName || 'ناشناس'}{app.stage && !closed ? <> · مرحله: {STAGE_LABELS[app.stage] || app.stage}</> : null}</p>
        {app.creditRankIgnored && <p role="status" className="ldx-warn">این پرونده با انتخاب مدیر یا کارشناس فروش، بدون تطابق رتبه اعتباری ثبت شده است.</p>}
        {user?.role === 'admin' ? <CaseCreditRankOverrides applicationId={app.id} /> : null}
        <dl className="ldx-stats">
          <div><dt>مبلغ درخواستی</dt><dd>{Number(app.requestedAmount).toLocaleString('fa-IR')} <small>تومان</small></dd></div>
          <div><dt>مبلغ مصوب</dt><dd className={app.approvedAmount ? '' : 'mute'}>{app.approvedAmount ? <>{Number(app.approvedAmount).toLocaleString('fa-IR')} <small>تومان</small></> : 'در انتظار تأیید'}</dd></div>
          <div><dt>اقساط {app.approvedAmount ? 'مصوب' : 'درخواستی'}</dt><dd>{app.durationMonths ? fa(Number(app.durationMonths)) : '—'} <small>ماهه</small></dd></div>
          <div><dt>کارشناس فروش</dt><dd className="sm">{appAny.customerSalespersonName || 'بدون تخصیص'}</dd>
            <span className="ldx-sub">کارشناس فروش ثبت‌شده: {app.salespersonNameSnapshot || 'ثبت نشده'}</span>
            <span className="ldx-sub">کارشناس فروش فعلی: {appAny.customerSalespersonName || 'بدون تخصیص'}</span></div>
        </dl>
        <div className="ldx-acts">
          {app.customerId ? <Link className="csx-ghost" href={`/customers/${app.customerId}`} data-testid="link-loan-customer"><UserIcon /> پرونده مشتری</Link> : null}
          <LoanCaseCancellation application={app} />
          <AdminCaseCorrections applicationId={appId} />
        </div>
      </div>

      <div className="ldx-card ldx-path">
        <div className="ldx-pathh"><h2>مسیر پرونده</h2>{currentStepIndex >= 0 ? <span className="muted">{fa(currentStepIndex + 1)} از {fa(timelineSteps.length)}</span> : null}</div>
      <div className="stepper-container ldx-steps" role="list">
        {timelineSteps.map((step, idx) => {
           const isPast = currentStepIndex !== -1 && idx < currentStepIndex;
           const isCurrent = idx === currentStepIndex;
           const isSelected = activeStepId === step.id;
           const connectorIsPast = currentStepIndex !== -1 && idx < currentStepIndex;
           
           return (
             <React.Fragment key={step.id}>
               <button type="button" aria-current={isCurrent ? 'step' : undefined} aria-pressed={isSelected} className={`step-item ${isPast ? 'is-past' : ''} ${isCurrent ? 'is-current' : ''} ${isSelected ? 'is-selected' : ''}`} onClick={() => setSelectedStepId(step.id)}>
                  <div className="step-circle">
                    {isPast ? <CheckCircle2 size={16} /> : <span>{idx + 1}</span>}
                  </div>
                  <div className="step-label">{step.label}{isCurrent && turnText ? <small>الان: {turnText}</small> : null}</div>
               </button>
                {idx < timelineSteps.length - 1 && (
                 <div className={`step-connector ${connectorIsPast ? 'is-past' : ''}`} />
               )}
             </React.Fragment>
           )
        })}
      </div>
      </div>

        <div className="ldx-main">
          
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>اطلاعات پایه</h3>
                <p>مبالغ و زمان‌بندی درخواست</p>
              </div>
              <Landmark size={20} color="#94a3b8" />
            </div>
            <div className="metric-grid">
              <div>
                <span className="metric-label">مبلغ درخواستی</span>
                <strong className="metric-value" style={{ fontSize: 20 }}>{Number(app.requestedAmount).toLocaleString('fa-IR')} <span style={{fontSize: 12, color: '#94a3b8'}}>تومان</span></strong>
              </div>
              <div>
                <span className="metric-label">مبلغ مصوب</span>
                <strong className="metric-value" style={{ fontSize: 20, color: app.approvedAmount ? '#0f766e' : '#94a3b8' }}>
                  {app.approvedAmount ? Number(app.approvedAmount).toLocaleString('fa-IR') : 'در انتظار تأیید'} <span style={{fontSize: 12, color: '#94a3b8'}}>{app.approvedAmount ? 'تومان' : ''}</span>
                </strong>
              </div>
              <div>
                <span className="metric-label">تعداد اقساط {app.approvedAmount ? 'مصوب' : 'درخواستی'}</span>
                <strong className="metric-value" style={{ fontSize: 20 }}>{app.durationMonths || '—'} <span style={{fontSize: 12, color: '#94a3b8'}}>ماهه</span></strong>
              </div>
              {requestedDuration && app.approvedAmount && requestedDuration !== app.durationMonths && <div>
                <span className="metric-label">تعداد اقساط درخواستی</span>
                <strong className="metric-value" style={{ fontSize: 20 }}>{requestedDuration.toLocaleString('fa-IR')} <span style={{fontSize: 12, color: '#94a3b8'}}>ماهه</span></strong>
              </div>}
              <div>
                <span className="metric-label">مبلغ خالص (پس از کسورات)</span>
                <strong className="metric-value" style={{ fontSize: 20, color: app.netAmount ? '#0f766e' : '#94a3b8' }}>
                  {app.netAmount ? Number(app.netAmount).toLocaleString('fa-IR') : '—'} <span style={{fontSize: 12, color: '#94a3b8'}}>{app.netAmount ? 'تومان' : ''}</span>
                </strong>
              </div>
            </div>
            {app.initialContractRetained && <p className="funding-guidance" role="status" style={{ margin: '12px 0 0', color: '#047857' }}>قرارداد اولیه امضاشده حفظ شده است؛ چون مبلغ و تعداد اقساط مصوب تغییر نکرد، امضای مجدد لازم نیست.</p>}
            {app.stage === 'approved_contract_pending_signature' && (app.tomanReplacement?.authorized
              ? <p className="funding-guidance" role="status" style={{ margin: '12px 0 0' }}>
                نسخهٔ تومانی جایگزین برای همان شرایط مصوب صادر می‌شود: {formatTomanAmount(app.tomanReplacement.approvedAmount)} تومان و {Number(app.tomanReplacement.durationMonths).toLocaleString('fa-IR')} ماه. اختلاف فقط در واحدِ نسخهٔ قدیمی است؛ هیچ تغییری در مبلغ یا مدت مصوب ثبت نشده و پس از امضای معتبر، پرونده به مرحلهٔ ازسرگیری بازمی‌گردد.
              </p>
              : <p className="funding-guidance" role="status" style={{ margin: '12px 0 0' }}>مبلغ یا تعداد اقساط مصوب با قرارداد اولیه تفاوت دارد؛ مشتری باید قرارداد جایگزین را امضا کند تا پرونده ادامه یابد.</p>)}
            {canEditApplicationTerms && <ApplicationTermsEditor
              appId={appId}
              requestedAmount={String(app.requestedAmount)}
              durationMonths={Number(requestedDuration ?? app.durationMonths ?? 0)}
            />}
            {app.notes && (
              <div style={{ marginTop: 20, padding: 14, background: '#f8fafc', borderRadius: 10, fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
                <strong>توضیحات:</strong> {app.notes}
              </div>
            )}
          </div>

          <LegacyTomanReplacementPanel
            appId={appId}
            eligibility={app.tomanReplacementEligibility}
            authorization={app.tomanReplacement}
            isAdmin={user?.role === 'admin'}
          />

          {activeStepId === 'initial' && <div className="panel">
            <div className="panel-head"><div><h3>تصویب مبلغ وام</h3><p>پس از قرارداد اولیه، بررسی مدارک مشتری و ثبت ضامن (در صورت نیاز)</p></div><ShieldCheck size={20} color="#94a3b8" /></div>
            <div className="funder-requested-terms">
              <span>اصل تسهیلات درخواستی <strong>{Number(app.requestedAmount).toLocaleString('fa-IR')} تومان</strong></span>
              <span>تعداد اقساط انتخاب‌شده <strong>{app.requestedDurationMonths ?? app.durationMonths ?? '—'}</strong></span>
            </div>
            <p className="funding-guidance" style={{ marginTop: 12 }}>مبلغ و تعداد اقساط در مرحلهٔ تصویب مبلغ وام قابل انتخاب‌اند و پس از آن در تصمیم نهایی تغییر نمی‌کنند.</p>
            {app.initialContractRetained && <p className="funding-guidance" role="status" style={{ marginTop: 8, color: '#047857' }}>قرارداد اولیه با شرایط درخواستی امضاشده حفظ شده است؛ امضای مجدد لازم نیست.</p>}
            {app.approvedAmount != null && (normalizeTermDigits(String(app.approvedAmount)) !== normalizeTermDigits(String(app.requestedAmount)) || requestedDuration !== app.durationMonths) && <p className="funding-guidance" role="status" style={{ marginTop: 8 }}>{app.stage === 'approved_contract_pending_signature'
              ? 'مبلغ یا تعداد اقساط مصوب تغییر کرده است؛ مشتری باید قرارداد جایگزین را امضا کند.'
              : 'مبلغ یا تعداد اقساط مصوب تغییر کرده است؛ قرارداد جایگزین مبنای ادامه پرونده است.'}</p>}
            {app.stage === 'funder_initial_approval' && primaryContract?.signed && <p className="funding-guidance" style={{ marginTop: 8 }}>اگر مبلغ و تعداد اقساط بدون تغییر تصویب شوند، همان قرارداد حفظ می‌شود؛ در غیر این صورت باید قرارداد جایگزین صادر و امضا شود.</p>}
            {app.status === 'rejected' && <p role="status" style={{ color: '#9f1239' }}>درخواست در بررسی اولیه رد شده است. قرارداد صادر نمی‌شود.</p>}
          </div>}
          {activeStepId === 'initial' && generatedDocs.some((doc: any) => doc.kind === 'primary') && <ContractSection
            appId={appId}
            docs={generatedDocs.filter((doc: any) => doc.kind === 'primary')}
            currentPrimaryGenerationId={currentPrimaryGenerationId}
            canSubmit={false}
            canVerify={true}
            readOnlySignatureStatus={user?.role === 'salesperson'}
            canUpload={false}
            canReview={false}
          />}

          {['contract', 'replacement', 'final'].includes(activeStepId) && (
            <ContractSection 
              appId={appId} 
              docs={generatedDocs} 
              currentPrimaryGenerationId={currentPrimaryGenerationId}
              tomanReplacement={app.tomanReplacement}
              isReplacement={app.stage === 'approved_contract_pending_signature'}
              manualValues={app.primaryManualValues ?? {}}
              manualVariables={app.primaryManualVariables ?? []}
              canSubmit={Boolean(canUpdate && canSalespersonAct && app.stage === 'draft')}
              canConfirmSigned={Boolean(canUpdate && canSalespersonAct && ['draft', 'primary_contract_pending_signature'].includes(app.stage || ''))}
              canResend={Boolean(canUpdate && canSalespersonAct && (user?.role === 'admin' || user?.permissions?.includes('contracts.send')) && ['primary_contract_pending_signature', 'approved_contract_pending_signature'].includes(app.stage || ''))}
              canIssuePrimary={Boolean(canUpdate && canSalespersonAct && (user?.role === 'admin' || user?.permissions?.includes('contracts.generate')) && ['draft', 'approved_contract_pending_signature'].includes(app.stage || ''))}
              canVerify={true}
              readOnlySignatureStatus={user?.role === 'salesperson'}
              canUpload={Boolean(canUpdate && canSalespersonAct && ['customer_documents_upload', 'final_invoice_pending_signature'].includes(app.stage || ''))}
              canReview={Boolean(canReview && canRegistrarAct && app.stage === 'customer_documents_review')}
            />
          )}

          {activeStepId === 'customer' && (
            <>
              <ContractSection
                appId={appId}
                docs={generatedDocs.filter((doc: any) => doc.kind === 'primary')}
                currentPrimaryGenerationId={currentPrimaryGenerationId}
                canSubmit={false}
                canVerify={true}
                readOnlySignatureStatus={user?.role === 'salesperson'}
                canUpload={Boolean(canUpdate && canSalespersonAct && app.stage === 'customer_documents_upload')}
                canReview={Boolean(canReview && canRegistrarAct && app.stage === 'customer_documents_review')}
              />
              <DocumentSection 
                appId={appId} 
                docs={customerDocs} 
                title="مدارک موردنیاز تسهیلات" 
                type="customer" 
                canUpload={Boolean(canUpdate && canSalespersonAct && app.stage === 'customer_documents_upload')} 
                canReview={Boolean(canReview && canRegistrarAct && app.stage === 'customer_documents_review')} 
                canAddRequirement={Boolean(canUpdate && canSalespersonAct && app.stage === 'customer_documents_upload')}
                canSubmit={Boolean(canUpdate && canSalespersonAct && app.stage === 'customer_documents_upload')}
                onSubmit={() => submitCustDocs.mutate({ id: appId })}
                submitPending={submitCustDocs.isPending}
                submitError={submitCustDocs.isError}
              />

              <IdentityDocumentsSection
                appId={appId}
                customerId={app.customerId}
                documents={identityDocs}
                canReview={Boolean(canReview && canRegistrarAct && app.stage === 'customer_documents_review')}
                canUpload={Boolean(canUpdate && (user?.role === 'admin' || user?.permissions?.includes('customers.update')) && canSalespersonAct && app.stage === 'customer_documents_upload')}
              />
            </>
          )}

          {['guarantor', 'guarantor_registration', 'guarantor_docs'].includes(activeStepId) && (
            <>
              <GuarantorSection
                appId={appId}
                docs={guarantorDocs}
                guarantor={guarantor}
                canRegister={Boolean(canUpdate && canSalespersonAct && ['guarantor_registration', 'guarantor_documents_upload', 'guarantor_documents_review'].includes(app.stage || ''))}
                canUpload={Boolean(canUpdate && canSalespersonAct && ['guarantor_documents_upload', 'guarantor_documents_review'].includes(app.stage || ''))}
                canReview={Boolean(canReview && canRegistrarAct && app.stage === 'guarantor_documents_review')}
              />
              {(newCaseSequence || !app.approvedAmount) && app.stage === 'guarantor_registration' && <p className="funding-guidance">در این گام فقط اطلاعات ضامن ثبت می‌شود. ارسال مدارک ضامن پس از تصویب مبلغ وام و، در صورت تغییر شرایط قرارداد، امضای قرارداد جدید انجام خواهد شد.</p>}
            </>
          )}
          
          {activeStepId === 'collateral' && (
            <CollateralSection 
              appId={appId} 
              collaterals={collaterals} 
              requiredCollateral={requiredCollateral}
              canUpload={Boolean(canUpdate && (canRegistrarAct || canSalespersonAct) && app.stage === 'collateral_upload')}
              canReview={Boolean(canReview && canRegistrarAct && app.stage === 'collateral_review')}
              canSubmit={Boolean(canUpdate && (canRegistrarAct || canSalespersonAct) && app.stage === 'collateral_upload')}
              onSubmit={() => submitCollateral.mutate({ id: appId })}
              submitPending={submitCollateral.isPending}
            />
          )}

          {activeStepId === 'physical' && (
            <>
            {(app.stage === 'physical_documents_submission' || physicalDocuments.length > 0 || noPhysicalDocumentsDeclared) &&
              <PhysicalSubmission appId={appId} documents={physicalDocuments} previouslySubmitted={physicalDocumentsPreviouslySubmitted}
                returnReason={app.stage === 'physical_documents_submission' && typeof physicalReturnReason === 'string' ? physicalReturnReason : undefined}
                canSubmit={Boolean(canUpdate && (canRegistrarAct || canSalespersonAct) && app.stage === 'physical_documents_submission')} />}
            {app.stage !== 'physical_documents_submission' && !noPhysicalDocumentsDeclared && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>بررسی مدارک فیزیکی</h3>
                  <p>ارسال و بررسی اصل مدارک</p>
                </div>
                <FileText size={20} color="#94a3b8" />
              </div>
              {physicalChecks.map((check: any) => (
                <div key={check.id} style={{ padding: 12, borderBottom: '1px solid #e2e8f0', display: 'grid', gap: 8 }}>
                  <strong>{check.label}</strong>
                  <span>{check.status === 'approved' ? 'تأیید شده' : check.status === 'incomplete' ? 'دارای نقص' : 'در انتظار بررسی'}{check.reason ? ` — ${check.reason}` : ''}</span>
                  {canRegistrarAct && canReview && app.stage === 'physical_documents_review' && <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" disabled={stageAction.isPending} onClick={() => stageAction.mutate({ path: `physical-checks/${check.id}/review`, body: { decision: 'approved' } })}>تأیید اصل مدرک</button>
                    <button className="btn" disabled={stageAction.isPending} onClick={() => {
                      const reason = window.prompt('دلیل نقص این مدرک فیزیکی:');
                      if (reason?.trim()) stageAction.mutate({ path: `physical-checks/${check.id}/review`, body: { decision: 'incomplete', reason: reason.trim() } });
                    }}>ثبت نقص</button>
                  </div>}
                  {canSalespersonAct && app.stage === 'physical_documents_correction' && check.status === 'incomplete' && <div className="field">
                    <div style={{ padding: 10, borderRadius: 8, background: '#fff7ed', color: '#9a3412', fontSize: 12 }}>
                      <strong>دلیل نقص:</strong> {check.reason || 'دلیل جزئی برای این مدرک ثبت نشده است.'}
                    </div>
                    <input aria-label={`توضیح اصلاح ${check.label}`} placeholder="شرح اصلاح انجام‌شده برای این مدرک" value={physicalNotes[check.id] || ''} onChange={e => setPhysicalNotes(prev => ({ ...prev, [check.id]: e.target.value }))} />
                    <button className="btn" disabled={!physicalNotes[check.id]?.trim() || stageAction.isPending} onClick={() => stageAction.mutate({ path: `physical-checks/${check.id}/correct`, body: { note: physicalNotes[check.id].trim() } })}>ثبت اصلاح این مدرک</button>
                  </div>}
                  {canSalespersonAct && app.stage === 'physical_documents_correction' && check.status !== 'incomplete' && physicalCorrectionByCheck.get(check.id) && (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <div style={{ padding: 10, borderRadius: 8, background: '#fff7ed', color: '#9a3412', fontSize: 12 }}>
                        <strong>دلیل نقص:</strong> {physicalReasonByCheck.get(check.id) || 'دلیل جزئی برای این مدرک ثبت نشده است.'}
                      </div>
                      <div style={{ padding: 10, borderRadius: 8, background: '#ecfdf5', color: '#047857', fontSize: 12 }}>
                        <strong>اصلاح ثبت‌شده:</strong> {physicalCorrectionByCheck.get(check.id)}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {!physicalChecks.length && <p>مدرک فیزیکی برای بررسی ثبت نشده است.</p>}
            </div>
            )}
            {noPhysicalDocumentsDeclared && <p className="funding-guidance" role="status">کارشناس ثبت اعلام کرد این طرح مدرک فیزیکی ندارد؛ بررسی مدارک فیزیکی به‌صورت خودکار تأیید شد.</p>}
            </>
          )}

          {['approval', 'wallet'].includes(activeStepId) && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>اعتبارسنجی و تأییدات</h3>
                  <p>تأییدات نهایی برای پرداخت</p>
                </div>
                <ShieldCheck size={20} color="#94a3b8" />
              </div>
              <p>{funderDecision === 'approved' ? 'تأمین‌کننده مالی پرونده را تأیید کرده است.' : funderDecision === 'rejected' ? `تأمین‌کننده مالی پرونده را رد کرده است: ${funderReason || ''}` : 'در انتظار اعلام نتیجه تأمین‌کننده مالی.'}</p>
              {funderDecision === 'approved' && app.approvedAmount && <div className="funder-terms-summary" data-testid="status-approved-terms">
                <strong>شرایط مصوب تأمین‌کننده</strong>
                <div><span>اصل درخواستی: {Number(app.requestedAmount).toLocaleString('fa-IR')} تومان</span><span>اصل مصوب: {Number(app.approvedAmount).toLocaleString('fa-IR')} تومان</span><span>تعداد اقساط مصوب: {app.durationMonths?.toLocaleString('fa-IR') || '—'}</span></div>
                {(app.approvedAmount !== app.requestedAmount || (requestedDuration && requestedDuration !== app.durationMonths)) && <p>شرایط مصوب در تصمیم اولیه ثبت شده و قرارداد اصلی بر اساس همین شرایط صادر شده است.</p>}
              </div>}
              {app.stage === 'funder_result_review' && funderDecision === 'rejected' && <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
                <p>کارشناس ثبت: مدارک مردود را انتخاب و برای هرکدام دلیل نقص را ثبت کنید.</p>
                {funderItems.map(item => {
                  const key = `${item.source}:${item.id}`;
                  return <label key={key} className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={key in defectReasons} onChange={e => setDefectReasons(prev => { const next = { ...prev }; if (e.target.checked) next[key] = ''; else delete next[key]; return next; })} />
                    <span>{item.label}</span>
                    {key in defectReasons && <input aria-label={`دلیل نقص ${item.label}`} placeholder="دلیل رد این مدرک" value={defectReasons[key]} onChange={e => setDefectReasons(prev => ({ ...prev, [key]: e.target.value }))} />}
                  </label>;
                })}
              </div>}
              {app.stage === 'funder_documents_correction' && <div style={{ marginTop: 12 }}>
                <p>مدارک زیر باید جایگزین شوند؛ سپس پرونده را دوباره به تأمین‌کننده بفرستید.</p>
                {funderDefects.filter((d: any) => !d.resolved_at).map((d: any) => <p key={d.id}>• {d.reason} ({d.source === 'collateral' ? 'وثیقه' : d.source === 'guarantor' ? 'ضامن' : 'مدرک مشتری'})</p>)}
                {funderDefects.some((d: any) => d.source === 'document') && <DocumentSection appId={appId} docs={customerDocs.filter((doc: any) => funderDefects.some((d: any) => d.source === 'document' && d.source_id === doc.id))} title="مدارک مشتری" type="customer" canUpload={Boolean(canUpdate && canSalespersonAct)} canReview={false} correctionMode canAddRequirement={false} canSubmit={false} onSubmit={() => {}} submitPending={false} submitError={false} />}
                {funderDefects.some((d: any) => d.source === 'guarantor') && <GuarantorSection appId={appId} docs={guarantorDocs.filter((doc: any) => funderDefects.some((d: any) => d.source === 'guarantor' && d.source_id === doc.id))} guarantor={guarantor} canRegister={false} canUpload={Boolean(canUpdate && canSalespersonAct)} canReview={false} correctionMode />}
                {funderDefects.some((d: any) => d.source === 'collateral') && <CollateralSection appId={appId} collaterals={collaterals.filter((doc: any) => funderDefects.some((d: any) => d.source === 'collateral' && d.source_id === doc.id))} requiredCollateral={requiredCollateral.filter((slot: any) => collaterals.some((doc: any) => funderDefects.some((d: any) => d.source === 'collateral' && d.source_id === doc.id) && doc.dataJson?.requirementKey === slot.key))} canUpload={Boolean(canUpdate && canRegistrarAct)} canReview={false} canSubmit={false} onSubmit={() => {}} submitPending={false} />}
              </div>}
            </div>
          )}

        </div>

        </div>
        <aside className="ldx-side">
          <div className={`panel ldx-action${appAny.actionRequired ? ' mine' : ''}`} data-testid="loan-action-card">
            {turnText ? <p className={`ldx-turn${appAny.actionRequired ? ' mine' : ''}`}>{appAny.actionRequired ? 'اقدام با شماست' : turnText}</p> : closed ? <p className="ldx-turn">{businessStatus === 'completed' ? 'این پرونده تکمیل شده است.' : 'این پرونده لغو شده است.'}</p> : null}
            <div className="panel-head">
              <div>
                <h3>تصمیم‌گیری</h3>
                <p>تغییر وضعیت و ثبت نتیجه پرونده</p>
              </div>
              <ShieldCheck size={20} color="#94a3b8" />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {canReview && canRegistrarAct && app.stage === 'funder_initial_approval' && app.status !== 'rejected' && <div style={{ display: 'grid', gap: 8 }}>
                <strong style={{ fontSize: 12 }}>تصمیم اولیه تأمین‌کننده مالی</strong>
                <p className="funding-guidance">اصل تسهیلات مصوب را ثبت کنید یا با دلیل، درخواست را رد کنید. مبلغ مصوب برابر مبلغ قرارداد امضاشده باشد، همان قرارداد حفظ می‌شود؛ تغییر مبلغ نیازمند امضای قرارداد جایگزین است.</p>
                <div className="funder-initial-actions">
                  <button type="button" className="btn btn-primary" data-testid="button-open-initial-approval" onClick={() => openInitialDecision('initial_approve')}>تصویب مبلغ وام</button>
                  <button type="button" className="btn funding-reject-button" data-testid="button-open-initial-rejection" onClick={() => openInitialDecision('initial_reject')}>رد اولیه درخواست</button>
                </div>
              </div>}
              {canReview && canRegistrarAct && app.stage === 'customer_documents_review' && (
                <ReviewDecisionButtons
                  approveLabel="تأیید و رفتن به مرحله بعد"
                  {...reviewFor('customer_documents_review', customerReviewReady, customerReviewDone, customerHasDefect)}
                  onApprove={() => setReviewModal('review_cust_docs')}
                  onReject={() => setReviewModal('return_cust_docs')}
                  hint="قرارداد امضاشده، پنج مدرک هویتی و همه مدارک تسهیلات را جداگانه بررسی کنید."
                />
              )}
              
              {canUpdate && canSalespersonAct && app.stage === 'guarantor_registration' && !newCaseSequence && Boolean(app.approvedAmount) && (
                <button className="btn btn-primary" onClick={() => startGuarDocs.mutate({ id: appId })} disabled={startGuarDocs.isPending}>
                  ارسال ضامن به کارشناس ثبت
                </button>
              )}
              {canUpdate && canSalespersonAct && app.stage === 'guarantor_documents_upload' && (
                <button className="btn btn-primary" onClick={() => submitGuarDocs.mutate({ id: appId })} disabled={submitGuarDocs.isPending}>
                  ارسال مجدد ضامن به کارشناس ثبت
                </button>
              )}
              {canReview && canRegistrarAct && app.stage === 'guarantor_documents_review' && (
                <ReviewDecisionButtons
                  approveLabel="تأیید و رفتن به مرحله بعد"
                  {...reviewFor('guarantor_documents_review', guarantorDocumentsApproved, guarantorReviewDone, guarantorHasDefect)}
                  onApprove={() => setReviewModal('review_guar_docs')}
                  onReject={() => setReviewModal('return_guar_docs')}
                  hint="ابتدا نتیجه بررسی همه مدارک ضامن را ثبت کنید."
                />
              )}

              {canReview && canRegistrarAct && app.stage === 'collateral_review' && (
                <ReviewDecisionButtons
                  approveLabel="تأیید و رفتن به مرحله بعد"
                  {...reviewFor('collateral_review', collateralApproved, collateralReviewDone, collateralHasDefect)}
                  onApprove={() => setReviewModal('review_collateral')}
                  onReject={() => setReviewModal('return_collateral')}
                  hint="ابتدا نتیجه بررسی همه تصاویر وثیقه موردنیاز طرح را ثبت کنید."
                />
              )}

              {canReview && canRegistrarAct && app.stage === 'expert_approval' && app.status !== 'rejected' && (
                <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 4 }}>
                  <strong style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 8 }}>تصمیم نهایی تأمین‌کننده مالی</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button type="button" data-testid="button-open-funder-approval" className="btn" style={{ background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0' }} onClick={openFunderApproval}>
                      <CheckCircle2 size={16} /> تأیید
                    </button>
                    <button className="btn" style={{ background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} onClick={() => setReviewModal('expert_reject')}>
                      <XCircle size={16} /> رد و اعلام نقص
                    </button>
                  </div>
                </div>
              )}
              {canReview && canRegistrarAct && app.stage === 'funder_result_review' && (
                funderDecision === 'approved'
                   ? <button className="btn btn-primary" disabled={stageAction.isPending} onClick={() => stageAction.mutate({ path: 'confirm-funder' })}>تأیید نتیجه تأمین‌کننده و ارسال مدارک فیزیکی</button>
                  : <button className="btn btn-primary" disabled={stageAction.isPending || !Object.keys(defectReasons).length || Object.values(defectReasons).some(reason => !reason.trim())} onClick={() => stageAction.mutate({ path: 'return-funder-documents', body: { defects: Object.entries(defectReasons).map(([key, reason]) => { const [source, id] = key.split(':'); return { source, id: Number(id), reason }; }), reason: funderReason } })}>نقص‌گذاری و بازگشت مدارک مردود به فروش</button>
              )}
              {canUpdate && canSalespersonAct && app.stage === 'funder_documents_correction' && <button className="btn btn-primary" disabled={stageAction.isPending || funderDefects.some((d: any) => !d.resolved_at)} onClick={() => stageAction.mutate({ path: 'resubmit-funder-documents' })}>ارسال مجدد مدارک به تأمین‌کننده</button>}
              {canReview && canRegistrarAct && app.stage === 'physical_documents_review' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  {!physicalChecks.length && <button className="btn btn-ghost" disabled={stageAction.isPending} onClick={() => stageAction.mutate({ path: 'prepare-physical-checks' })}>
                    تشکیل فهرست مدارک فیزیکی برای بررسی
                  </button>}
                  {(registrarReview?.allApproved ?? (physicalChecks.length > 0 && physicalChecks.every((check: any) => check.status === 'approved'))) && <button className="btn btn-primary" disabled={stageAction.isPending} onClick={() => stageAction.mutate({ path: 'approve-physical-documents' })}>
                    <CheckCircle2 size={16} /> تأیید و رفتن به مرحله بعد
                  </button>}
                  {physicalChecks.length > 0 && !(registrarReview?.hasDefect ?? hasIncompletePhysicalChecks) && <button className="btn btn-ghost" disabled={stageAction.isPending} onClick={() => { setActionError(''); setReviewReason(''); setReviewModal('physical_general_defect'); }}>
                    ثبت نقص عمومی مدارک فیزیکی
                  </button>}
                  {(registrarReview?.hasDefect ?? hasIncompletePhysicalChecks) && <button className="btn" style={{ background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} disabled={stageAction.isPending} onClick={() => { setActionError(''); setReviewReason(''); setReviewModal('return_physical'); }}>
                    <XCircle size={16} /> ثبت نقص پرونده و بازگشت به کارشناس فروش
                  </button>}
                  {hasIncompletePhysicalChecks && (
                    <p style={{ margin: 0, color: '#b45309', fontSize: 11, lineHeight: 1.7 }}>
                      تأیید نهایی ممکن نیست؛ یک یا چند مدرک دارای نقص شناخته‌شده است. نقص‌ها را به فروش بازگردانید یا نتیجه بررسی هر مدرک را اصلاح کنید.
                    </p>
                  )}
                  {!hasIncompletePhysicalChecks && physicalChecks.some((check: any) => check.status === 'pending') && (
                    <p style={{ margin: 0, color: '#475569', fontSize: 11, lineHeight: 1.7 }}>
                      نتیجه بررسی همه مدارک فیزیکی را ثبت کنید؛ سپس دکمه اقدام مناسب ظاهر می‌شود.
                    </p>
                  )}
                  {!physicalChecks.length && (
                    <p style={{ margin: 0, color: '#475569', fontSize: 11, lineHeight: 1.7 }}>
                      فهرست فیزیکی این پرونده هنوز تشکیل نشده است. ابتدا فهرست را بسازید و هر مدرک را جداگانه بررسی کنید.
                    </p>
                  )}
                </div>
              )}
              {canUpdate && canSalespersonAct && app.stage === 'physical_documents_correction' && <button className="btn btn-primary" disabled={stageAction.isPending || physicalChecks.some((d: any) => d.status === 'incomplete')} onClick={() => stageAction.mutate({ path: 'resubmit-physical-documents' })}>ارسال مجدد مدارک فیزیکی به ثبت</button>}
              {canRegistrarAct && app.stage === 'wallet_charge_pending' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <button className="btn btn-primary" disabled={stageAction.isPending} onClick={() => stageAction.mutate({ path: 'approve-wallet-charge' })}>تایید شارژ و ارسال برای مدیر</button>
                  <p style={{ margin: 0, color: '#475569', fontSize: 11, lineHeight: 1.7 }}>این اقدام فقط درخواست تأیید مدیر را ثبت می‌کند و در این مرحله اعتباری به کیف پول افزوده نمی‌شود.</p>
                </div>
              )}

              {user?.role === 'admin' && app.stage === 'admin_approval' && (
                <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 4 }}>
                  <strong style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 8 }}>تأیید مدیر و شارژ نهایی اعتبار</strong>
                  <p style={{ margin: '0 0 8px', color: '#475569', fontSize: 11, lineHeight: 1.7 }}>تأیید نهایی، اعتبار تسهیلات را به کیف پول اعتباری مشتری اضافه و پرونده را تکمیل می‌کند.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button className="btn" style={{ background: '#f0f9ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }} onClick={() => setReviewModal('admin_approve')}>
                      <CheckCircle2 size={16} /> تأیید، شارژ اعتبار و تکمیل
                    </button>
                    <button className="btn" style={{ background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} onClick={() => setReviewModal('admin_reject')}>
                      <XCircle size={16} /> رد پرونده
                    </button>
                  </div>
                </div>
              )}

              {canUpdate && app.stage === 'final_invoice_pending_signature' && generatedDocs.some(d => d.kind === 'invoice') && generatedDocs.some(d => d.kind === 'acknowledgement') && (
                 <button className="btn btn-primary" onClick={() => setReviewModal('complete')} style={{ width: '100%' }}>
                  <Play size={16} /> خاتمه و پرداخت
                </button>
              )}
            </div>
            {actionError && <p role="alert" style={{ color: '#be123c' }}>{actionError}</p>}
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>تاریخچه پرونده</h3>
                <p>گردش کار و رویدادهای ثبت‌شده؛ فقط برای مشاهده</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setHistoryOpen(true)} data-testid="button-open-case-history"><Clock size={16} /> تاریخچه پرونده</button>
            </div>
          </div>
          <CaseNotesRoom key={`${appId}:${user?.id ?? 0}`} applicationId={appId} user={user as any} />
          {historyOpen && <CaseHistoryDialog applicationId={appId} onClose={() => setHistoryOpen(false)} />}

        </aside>
      </div>

      {reviewModal && (
        <Modal 
          title={
            reviewModal === 'initial_approve' ? 'تصویب مبلغ وام' :
            reviewModal === 'initial_reject' ? 'رد اولیه درخواست' :
            reviewModal === 'expert_approve' ? 'تأیید نهایی تأمین‌کننده مالی' :
            reviewModal === 'expert_reject' ? 'رد توسط تأمین‌کننده مالی' :
            reviewModal === 'admin_approve' ? 'تأیید نهایی مدیر' :
            reviewModal === 'admin_reject' ? 'رد توسط مدیر' :
            reviewModal === 'review_cust_docs' ? 'تأیید/رد/نقص مدارک مشتری' :
            reviewModal === 'review_guar_docs' ? 'تأیید/رد/نقص مدارک ضامن' :
            reviewModal === 'review_collateral' ? 'تأیید/رد/نقص وثایق' :
            reviewModal === 'return_cust_docs' ? 'نقص مدارک و بازگشت به کارشناس فروش' :
            reviewModal === 'return_guar_docs' ? 'نقص مدارک ضامن و بازگشت به کارشناس فروش' :
            reviewModal === 'return_collateral' ? 'نقص وثیقه و بازگشت به کارشناس فروش' :
            reviewModal === 'return_physical' ? 'نقص مدارک فیزیکی و بازگشت به فروش' :
            reviewModal === 'physical_general_defect' ? 'ثبت نقص عمومی مدارک فیزیکی' :
            'خاتمه پرونده و پرداخت'
          } 
          onClose={() => { if (!expertApprove.isPending && !initialApprove.isPending && !initialReject.isPending) setReviewModal(null); }}
          testId="review-modal"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {reviewModal === 'expert_approve' && <p className="funding-guidance">شرایط تسهیلات در مرحلهٔ تصویب مبلغ وام ثبت شده‌اند و در این مرحله قابل تغییر نیستند.</p>}
            {reviewModal === 'initial_approve' && <InitialApprovalTerms
              requestedAmount={String(app.requestedAmount)}
              requestedDuration={Number(requestedDuration ?? app.durationMonths ?? 0)}
              maximumAmount={approvalOptions.maximumAmount}
              allowedDurations={approvalOptions.allowedDurations}
              approvedAmount={approvedPrincipal}
              onAmountChange={value => { setApprovedPrincipal(value); setApprovalError(''); }}
              approvedDuration={approvedDuration}
              onDurationChange={value => { setApprovedDuration(value); setApprovalError(''); }}
              signedPrimary={Boolean(primaryContract?.signed)}
              keepsInitialContract={approvalKeepsInitialContract}
            />}
            {['initial_reject', 'expert_reject', 'admin_reject'].includes(reviewModal) && <p className="funder-approval-warning">پرونده لغو نمی‌شود؛ با حفظ سوابق و دلیل رد، برای اصلاح به مرحلهٔ قبلی در کارتابل فروش برمی‌گردد.</p>}
            <div className="field">
              <label htmlFor="review-decision-reason">توضیحات / دلیل {reviewModal === 'initial_reject' || reviewModal?.startsWith('return_') || reviewModal === 'expert_reject' || reviewModal === 'admin_reject' ? '(الزامی)' : '(اختیاری)'}</label>
              {reviewModal === 'expert_approve' ? <p className="funding-guidance">تأیید نهایی بدون تغییر شرایط مصوب اولیه ثبت می‌شود.</p> : <textarea id="review-decision-reason" data-testid="input-review-decision-reason" value={reviewReason} maxLength={reviewModal === 'initial_approve' ? 500 : reviewModal === 'initial_reject' ? 1000 : undefined} onChange={e => { setReviewReason(e.target.value); setApprovalError(''); }} placeholder={reviewModal === 'return_physical' ? 'دلیل کلی نقص یا بازگشت مدارک فیزیکی...' : 'دلیل این تصمیم...'} rows={4} />}
            </div>
            {approvalError && <p className="form-error" role="alert" data-testid="error-funder-decision">{approvalError}</p>}
            {(reviewModal?.startsWith('return_') || reviewModal === 'physical_general_defect') && actionError && <p role="alert" style={{ margin: 0, color: '#be123c', fontSize: 12 }}>{actionError}</p>}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setReviewModal(null)}>انصراف</button>
              <button type="button" data-testid="button-submit-review-decision" className="btn btn-primary" onClick={handleReviewAction} disabled={((reviewModal?.startsWith('return_') || reviewModal === 'initial_reject' || reviewModal === 'expert_reject' || reviewModal === 'admin_reject' || reviewModal === 'physical_general_defect') && !reviewReason.trim()) || (reviewModal === 'initial_approve' && (!approvedPrincipal.trim() || !approvedDuration)) || initialApprove.isPending || initialReject.isPending || expertApprove.isPending || expertReject.isPending || adminApprove.isPending || adminReject.isPending || completeLoan.isPending || reviewCustDocs.isPending || reviewGuarDocs.isPending || reviewCollateral.isPending || returnForCorrection.isPending || stageAction.isPending}>
                {initialApprove.isPending || initialReject.isPending || expertApprove.isPending || expertReject.isPending || adminApprove.isPending || adminReject.isPending || completeLoan.isPending || reviewCustDocs.isPending || reviewGuarDocs.isPending || reviewCollateral.isPending || returnForCorrection.isPending || stageAction.isPending ? 'در حال ثبت...' : 'ثبت تصمیم'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ReviewDecisionButtons({ approveLabel, allReviewed, allApproved, hasDefect, onApprove, onReject, hint }: { approveLabel: string; allReviewed: boolean; allApproved: boolean; hasDefect: boolean; onApprove: () => void; onReject: () => void; hint: string }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {allApproved && <button className="btn btn-primary" onClick={onApprove}><CheckCircle2 size={15} /> {approveLabel}</button>}
      {hasDefect && <button className="btn" style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' }} onClick={onReject}><XCircle size={15} /> ثبت نقص پرونده و بازگشت به کارشناس فروش</button>}
      {!allApproved && !hasDefect && <div style={{ color: '#b45309', fontSize: 11, lineHeight: 1.7 }}>{allReviewed ? 'وضعیت این مرحله را تازه‌سازی کنید.' : hint}</div>}
    </div>
  );
}

const IDENTITY_LABELS: Record<string, string> = {
  national_card_front: 'روی کارت ملی',
  national_card_back: 'پشت کارت ملی',
  birth_cert_p1: 'صفحه اول شناسنامه',
  birth_cert_p2: 'صفحه دوم شناسنامه',
  birth_cert_p3: 'صفحه سوم شناسنامه',
};
type PreviewFile = { title: string; mime: string; url: string; downloadUrl: string };
function FilePreview({ file, onClose }: { file: PreviewFile | null; onClose: () => void }) {
  if (!file) return null;
  const mime = file.mime.toLowerCase();
  const isImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime);
  const isPdf = mime === 'application/pdf' || /\.pdf(?:\?|$)/i.test(file.title);
  return <Modal title={`مشاهده ${file.title}`} onClose={onClose} testId="loan-file-preview-modal" wide>
    <div style={{ display: 'grid', gap: 14 }}>
      {isImage ? <img src={file.url} alt={file.title} style={{ maxWidth: '100%', maxHeight: '65vh', margin: 'auto', objectFit: 'contain' }} /> :
        isPdf ? <iframe src={file.url} title={file.title} style={{ width: '100%', height: '65vh', border: '1px solid #e2e8f0', borderRadius: 8 }} /> :
        <p style={{ fontSize: 13 }}>این نوع فایل پیش‌نمایش ندارد. فایل را دانلود کنید.</p>}
      <a className="btn btn-primary" href={file.downloadUrl} download style={{ textDecoration: 'none', justifySelf: 'start' }}><Download size={15} /> دانلود {isPdf ? 'PDF' : 'فایل'}</a>
    </div>
  </Modal>;
}

function IdentityDocumentsSection({ appId, customerId, documents, canReview, canUpload }: { appId: number; customerId: number; documents: any[]; canReview: boolean; canUpload: boolean }) {
  const queryClient = useQueryClient();
  const [rejectDoc, setRejectDoc] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<Record<string, string>>({});
  const upload = useUploadCustomerIdentityDocument();
  const uploadIdentity = async (event: React.ChangeEvent<HTMLInputElement>, documentType: CustomerIdentityDocumentUploadDocumentType) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setUploadError(current => ({ ...current, [documentType]: '' }));
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(current => ({ ...current, [documentType]: 'حجم فایل باید کمتر از ۱۰ مگابایت باشد.' }));
      return;
    }
    setUploadingType(documentType);
    try {
      await upload.mutateAsync({ customerId, data: { documentType, file } });
      await queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
    } catch {
      setUploadError(current => ({ ...current, [documentType]: 'بارگذاری انجام نشد؛ فایل قبلی بدون تغییر باقی ماند. دوباره تلاش کنید.' }));
    } finally {
      setUploadingType(null);
    }
  };
  const review = useMutation({
    mutationFn: async ({ documentId, decision, reason }: { documentId: number; decision: 'approved' | 'rejected'; reason?: string }) => {
      const response = await fetch(`/api/loan-applications/${appId}/identity-documents/${documentId}/review`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason }),
      });
      if (!response.ok) throw new Error('identity_review_failed');
      return response.json();
    },
    onSuccess: () => { queryClient.invalidateQueries(); setRejectDoc(null); setReason(''); },
  });
  const url = (doc: any, preview = false) => `/api/loan-applications/${appId}/identity-documents/${doc.id}/download${preview ? '?preview=1' : ''}`;
  return (
    <div className="panel">
      <div className="panel-head">
        <div><h3>مدارک هویتی سراسری مشتری</h3><p>تأیید این مدارک برای تمام طرح‌های مشتری معتبر است؛ جایگزینی فایل نیاز به تأیید مجدد دارد.</p></div>
        <ShieldCheck size={20} color="#94a3b8" />
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {(Object.keys(IDENTITY_LABELS) as CustomerIdentityDocumentUploadDocumentType[]).map((type) => {
          const doc = documents.find((item) => (item.documentType || item.document_type) === type);
          const approved = Boolean(doc?.approvedAt || doc?.approved_at);
          const hasFile = doc?.fileAvailable === true;
          const rejectionReason = doc?.reviewReason || doc?.review_reason;
          return (
            <div key={type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
              <div><strong style={{ display: 'block', fontSize: 13 }}>{IDENTITY_LABELS[type]}</strong><span style={{ fontSize: 11, color: approved ? '#047857' : '#b45309' }}>{approved ? 'تأیید سراسری شده' : rejectionReason ? 'دارای نقص؛ نیازمند بارگذاری مجدد' : hasFile ? 'نیازمند تأیید' : 'بارگذاری نشده'}</span>{rejectionReason && <div style={{ color: '#be123c', fontSize: 11 }}>{rejectionReason}</div>}{uploadError[type] && <div className="form-error" role="alert">{uploadError[type]}</div>}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {hasFile && <button data-testid={`button-preview-identity-${doc.id}`} className="btn btn-ghost" onClick={() => setPreview({ title: IDENTITY_LABELS[type], mime: doc.mimeType || doc.mime_type || '', url: url(doc, true), downloadUrl: url(doc) })} style={{ height: 32, padding: '0 9px' }}><Search size={14} /> مشاهده</button>}
                {hasFile && <a data-testid={`link-download-identity-${doc.id}`} className="btn btn-ghost" href={url(doc)} download style={{ textDecoration: 'none', height: 32, padding: '0 9px' }}><Download size={14} /> دانلود</a>}
                {canUpload && <label className="btn btn-ghost" style={{ height: 32, padding: '0 9px', cursor: uploadingType ? 'wait' : 'pointer' }} data-testid={`identity-correction-upload-${type}`}>
                  <UploadCloud size={14} /> {uploadingType === type ? 'در حال بارگذاری...' : doc ? 'بارگذاری مجدد' : 'بارگذاری'}
                  <input type="file" accept={documentFileAccept} disabled={Boolean(uploadingType)} onChange={(event) => void uploadIdentity(event, type)} style={{ display: 'none' }} />
                </label>}
                {canReview && hasFile && !approved && <button data-testid={`button-approve-identity-${doc.id}`} className="icon-button" title="تأیید" onClick={() => review.mutate({ documentId: doc.id, decision: 'approved' })}><CheckCircle2 size={15} /></button>}
                {canReview && hasFile && <button data-testid={`button-reject-identity-${doc.id}`} className="icon-button" title="رد" style={{ color: '#be123c' }} onClick={() => setRejectDoc(doc)}><XCircle size={15} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      {canUpload && <p style={{ fontSize: 12, color: '#475569', marginTop: 12 }}>پس از رفع نقص، پرونده را با دکمهٔ «ارسال مدارک به کارشناس ثبت» دوباره برای بررسی بفرستید.</p>}
      {rejectDoc && <Modal title={`رد ${IDENTITY_LABELS[rejectDoc.documentType || rejectDoc.document_type] || 'مدرک هویتی'}`} onClose={() => setRejectDoc(null)} testId="reject-identity-document-modal">
        <div style={{ display: 'grid', gap: 14 }}><div className="field"><label>دلیل رد</label><textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div><div className="form-footer"><button className="btn btn-ghost" onClick={() => setRejectDoc(null)}>انصراف</button><button className="btn btn-primary" disabled={!reason.trim() || review.isPending} onClick={() => review.mutate({ documentId: rejectDoc.id, decision: 'rejected', reason })}>ثبت رد</button></div></div>
      </Modal>}
      {review.isError && <div className="form-error" role="alert">ثبت نتیجه مدرک هویتی انجام نشد. دوباره تلاش کنید.</div>}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function DocumentSection({ appId, docs, title, type, canUpload, canReview, correctionMode = false, canAddRequirement, canSubmit, onSubmit, submitPending, submitError }: { appId: number, docs: any[], title: string, type: 'customer' | 'guarantor', canUpload: boolean, canReview: boolean, correctionMode?: boolean, canAddRequirement?: boolean, canSubmit?: boolean, onSubmit?: () => void, submitPending?: boolean, submitError?: boolean }) {
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState<{ id: number, decision: 'incomplete' | 'rejected' } | null>(null);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reqLabel, setReqLabel] = useState('');
  const [selectedRequirement, setSelectedRequirement] = useState<any | null>(null);
  const [previewDoc, setPreviewDoc] = useState<PreviewFile | null>(null);

  const uploadCustomer = useUploadLoanApplicationDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setUploadOpen(false); setLabel(''); setFile(null); setSelectedRequirement(null); } } });
  const uploadGuarantor = useUploadLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setUploadOpen(false); setLabel(''); setFile(null); } } });
  const delCustomer = useDeleteLoanApplicationDocument({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const delGuarantor = useDeleteLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCustomer = useReviewLoanApplicationDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  const reviewGuarantor = useReviewLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  
  const addReq = useAddLoanApplicationManualRequirement({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReqOpen(false); setReqLabel(''); } } });
  const delReq = useDeleteLoanApplicationManualRequirement({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });

  const isPending = uploadCustomer.isPending || uploadGuarantor.isPending;

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || (!selectedRequirement && type === 'customer' && !/[\u0600-\u06FF]/.test(label.trim()))) return;
    const req = { id: appId, data: {
      file,
      label: selectedRequirement?.label || label || undefined,
      requirementKey: selectedRequirement?.requirement_key || selectedRequirement?.requirementKey || undefined,
    } };
    if (type === 'customer') uploadCustomer.mutate(req);
    else uploadGuarantor.mutate(req);
  };

  const handleAddReq = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqLabel.trim()) return;
    addReq.mutate({ id: appId, data: { label: reqLabel.trim() } });
  };

  const handleDel = (doc: any) => {
    if (type === 'customer' && doc.source === 'manual' && !hasFile(doc)) {
      delReq.mutate({ id: appId, documentId: doc.id });
    } else {
      if (type === 'customer') delCustomer.mutate({ id: appId, documentId: doc.id });
      else delGuarantor.mutate({ id: appId, documentId: doc.id });
    }
  };

  const openUpload = (doc?: any) => {
    setSelectedRequirement(doc || null);
    setLabel(doc?.label || '');
    setFile(null);
    setUploadOpen(true);
  };

  const fileName = (doc: any) => doc.original_name || doc.originalName || doc.filename;
  const mimeType = (doc: any) => doc.mime_type || doc.mimeType || '';
  const hasFile = (doc: any) => doc.fileAvailable === true;
  const downloadUrl = (doc: any, preview = false) => `/api/loan-applications/${appId}/${type === 'guarantor' ? 'guarantor/documents' : 'documents'}/${doc.id}/download${preview ? '?preview=1' : ''}`;
  const allRequiredUploaded = docs.every((doc) => hasFile(doc) && !['incomplete', 'rejected'].includes(doc.status));

  const handleReview = (docId: number, decision: 'approved' | 'incomplete' | 'rejected', reason?: string) => {
    if (decision !== 'approved' && !reason) {
      setReviewOpen({ id: docId, decision });
      return;
    }
    if (type === 'customer') reviewCustomer.mutate({ id: appId, documentId: docId, data: { decision, reason } });
    else reviewGuarantor.mutate({ id: appId, documentId: docId, data: { decision, reason } });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          <p>{type === 'customer' ? 'جدا از مدارک هویتی و وثایق' : 'بارگذاری و بررسی مدارک'}</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {canAddRequirement && (
            <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setReqOpen(true)}>
              <Plus size={14} /> درخواست مدرک جدید
            </button>
          )}
          {canUpload && !correctionMode && (
            <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => openUpload()}>
              <UploadCloud size={14} /> بارگذاری
            </button>
          )}
          {canSubmit && (
            <button className="btn btn-primary" onClick={onSubmit} disabled={submitPending || !allRequiredUploaded}>
              <UploadCloud size={14} /> {submitPending ? 'در حال ارسال...' : 'ارسال به کارشناس ثبت'}
            </button>
          )}
        </div>
      </div>
      
      <div className="docs-list" style={{ display: 'grid', gap: 10 }}>
        {docs.length > 0 ? docs.map(doc => (
          <div key={doc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 48, height: 48, borderRadius: 8, background: '#f1f5f9', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FileText size={18} /></div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>{doc.label || doc.filename || 'سند بدون نام'}</strong>
                <span style={{ fontSize: 11, color: doc.status === 'approved' ? '#0f766e' : (doc.status === 'rejected' || doc.status === 'incomplete') ? '#be123c' : '#94a3b8' }}>
                  {!hasFile(doc) ? 'در انتظار بارگذاری' : doc.status === 'approved' ? 'تأیید شده' : doc.status === 'incomplete' ? 'نقص مدرک' : doc.status === 'rejected' ? 'رد شده' : 'در انتظار بررسی'}
                </span>
                {hasFile(doc) && <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{fileName(doc)}</div>}
                {doc.reviewReason && <div style={{ fontSize: 10, color: '#be123c', marginTop: 2 }}>{doc.reviewReason}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {canUpload && <button data-testid={`button-upload-document-${doc.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32 }} onClick={() => openUpload(doc)}><UploadCloud size={14} /> {hasFile(doc) ? 'جایگزینی' : 'آپلود'}</button>}
              {hasFile(doc) && <button data-testid={`button-preview-document-${doc.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32 }} onClick={() => setPreviewDoc({ title: doc.label || fileName(doc) || 'مدرک', mime: mimeType(doc), url: downloadUrl(doc, true), downloadUrl: downloadUrl(doc) })}><Search size={14} /> مشاهده</button>}
              {hasFile(doc) && <a data-testid={`link-download-document-${doc.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32, textDecoration: 'none' }} href={downloadUrl(doc)} download><Download size={14} /> دانلود</a>}
              {canReview && hasFile(doc) && doc.status !== 'approved' && <button className="icon-button" style={{ width: 32, height: 32, color: '#047857', borderColor: '#a7f3d0', background: '#ecfdf5' }} onClick={() => handleReview(doc.id, 'approved')} title="تأیید"><CheckCircle2 size={14} /></button>}
              {canReview && hasFile(doc) && doc.status !== 'incomplete' && <button className="icon-button" style={{ width: 32, height: 32, color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }} onClick={() => handleReview(doc.id, 'incomplete')} title="نقص مدرک"><XCircle size={14} /></button>}
              {canReview && hasFile(doc) && doc.status !== 'rejected' && <button className="icon-button" style={{ width: 32, height: 32, color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }} onClick={() => handleReview(doc.id, 'rejected')} title="رد"><XCircle size={14} /></button>}
              {canUpload && !correctionMode && (hasFile(doc) || doc.source === 'manual') && <button className="icon-button" style={{ width: 32, height: 32 }} onClick={() => handleDel(doc)} title={doc.source === 'plan' ? 'حذف فایل' : 'حذف'}><Trash2 size={14} /></button>}
            </div>
          </div>
        )) : (
          <div className="empty-state compact-empty"><p>{type === 'customer' ? 'برای این طرح مدرک تسهیلاتی جداگانه‌ای لازم نیست. می‌توانید پرونده را به کارشناس ثبت ارسال کنید.' : 'مدرکی بارگذاری نشده است.'}</p></div>
        )}
      </div>

      {canSubmit && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e2e8f0' }}>
          {!allRequiredUploaded && <div style={{ color: '#b45309', fontSize: 11, marginTop: 7 }}>ابتدا همه مدارک موردنیاز و مدارک دارای نقص را بارگذاری یا جایگزین کنید.</div>}
          {submitError && <div style={{ color: '#be123c', fontSize: 11, marginTop: 7 }}>ارسال مدارک انجام نشد. وضعیت مدارک را بررسی و دوباره تلاش کنید.</div>}
        </div>
      )}

      {reqOpen && (
        <Modal title="درخواست مدرک جدید" onClose={() => setReqOpen(false)} testId="add-requirement-modal">
          <form onSubmit={handleAddReq} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>عنوان مدرک مورد نیاز</label>
              <input type="text" value={reqLabel} onChange={e => setReqLabel(e.target.value)} placeholder="مثال: گواهی کسر از حقوق" required />
            </div>
            {addReq.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت درخواست مدرک. دوباره تلاش کنید.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReqOpen(false)} disabled={addReq.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={addReq.isPending || !reqLabel.trim()}>
                {addReq.isPending ? 'در حال ثبت...' : 'ثبت درخواست مدرک'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {uploadOpen && (
        <Modal title={selectedRequirement ? `بارگذاری ${selectedRequirement.label}` : 'بارگذاری مدرک'} onClose={() => { setUploadOpen(false); setSelectedRequirement(null); }} testId="upload-document-modal">
          <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!selectedRequirement && <div className="field">
              <label>عنوان فارسی مدرک</label>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="مثال: گردش حساب سه‌ماهه" required />
              {label.trim() && !/[\u0600-\u06FF]/.test(label.trim()) && <small style={{ color: '#be123c' }}>عنوان مدرک باید فارسی باشد.</small>}
            </div>}
            <div className="field">
              <label>انتخاب فایل</label>
              <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} required style={{ padding: '8px 10px', background: '#fff' }} />
              <small style={{ color: '#64748b' }}>همه نوع فایل تا حجم ۱۰ مگابایت قابل بارگذاری است.</small>
            </div>
            {uploadCustomer.isError || uploadGuarantor.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در بارگذاری مدرک. دوباره تلاش کنید.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setUploadOpen(false)} disabled={isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={isPending || !file || (!selectedRequirement && type === 'customer' && !/[\u0600-\u06FF]/.test(label.trim()))}>
                {isPending ? 'در حال بارگذاری...' : 'بارگذاری'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <FilePreview file={previewDoc} onClose={() => setPreviewDoc(null)} />

      {reviewOpen && (
        <Modal title={reviewOpen.decision === 'incomplete' ? 'ثبت نقص مدرک' : 'رد مدرک'} onClose={() => setReviewOpen(null)} testId="review-document-modal">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>دلیل</label>
              <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} required rows={3} placeholder="علت نقص یا رد مدرک را بنویسید..." />
            </div>
            {reviewCustomer.isError || reviewGuarantor.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت نتیجه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReviewOpen(null)}>انصراف</button>
              <button type="button" className="btn btn-primary" disabled={!reviewReason.trim()} onClick={() => handleReview(reviewOpen.id, reviewOpen.decision, reviewReason)}>
                ثبت نتیجه
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GuarantorSection({ appId, docs, guarantor, canRegister, canUpload, canReview, correctionMode = false }: { appId: number, docs: any[], guarantor: any, canRegister: boolean, canUpload: boolean, canReview: boolean, correctionMode?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', nationalCode: '', mobile: '' });
  
  const reg = useRegisterLoanApplicationGuarantor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setOpen(false);
      }
    }
  });

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>ضامن‌ها</h3>
          <p>ثبت ضامن و مدارک مرتبط</p>
        </div>
        {canRegister && (
          <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => { setForm({ fullName: guarantor?.fullName || '', nationalCode: guarantor?.nationalCode || '', mobile: guarantor?.mobile || '' }); setOpen(true); }}>
            <UserPlus size={14} /> {guarantor ? 'تکمیل / اصلاح ضامن' : 'ثبت ضامن'}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: 10, marginBottom: docs.length ? 20 : 0 }}>
        {guarantor && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--nafiss-light)', color: 'var(--nafiss-blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <UserPlus size={18} />
            </div>
            <div>
              <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>{guarantor.fullName || 'ضامن'}</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>کدملی: {guarantor.nationalCode || '—'} · موبایل: <span dir="ltr">{guarantor.mobile || '—'}</span></span>
            </div>
          </div>
        )}
      </div>

      {docs.length > 0 || guarantor ? (
        <DocumentSection appId={appId} docs={docs} title="مدارک ضامن" type="guarantor" canUpload={canUpload} canReview={canReview} correctionMode={correctionMode} />
      ) : (
        <div className="empty-state compact-empty"><p>ضامنی ثبت نشده است.</p></div>
      )}

      {open && (
        <Modal title={guarantor ? "تکمیل / اصلاح اطلاعات ضامن" : "ثبت ضامن جدید"} onClose={() => setOpen(false)} testId="register-guarantor-modal">
          <form onSubmit={e => { e.preventDefault(); reg.mutate({ id: appId, data: form }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>نام و نام خانوادگی ضامن</label>
              <input type="text" value={form.fullName} onChange={e => setForm({...form, fullName: e.target.value})} required />
            </div>
            <div className="field">
              <label>کد ملی</label>
              <input type="text" value={form.nationalCode} onChange={e => setForm({...form, nationalCode: e.target.value})} dir="ltr" />
            </div>
            <div className="field">
              <label>شماره موبایل</label>
              <input type="text" value={form.mobile} onChange={e => setForm({...form, mobile: e.target.value})} dir="ltr" />
            </div>
            {reg.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت ضامن.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={reg.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={reg.isPending}>
                {reg.isPending ? 'در حال ثبت...' : 'ثبت ضامن'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function CollateralSection({ appId, collaterals, requiredCollateral, canUpload, canReview, canSubmit, onSubmit, submitPending }: { appId: number, collaterals: any[], requiredCollateral: any[], canUpload: boolean, canReview: boolean, canSubmit: boolean, onSubmit: () => void, submitPending: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ requirementKey: requiredCollateral[0]?.key || '', file: null as File | null });
  const [reviewOpen, setReviewOpen] = useState<{ id: number, decision: 'incomplete' | 'rejected' } | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  
  const submitMut = useSubmitLoanApplicationCollateral({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setOpen(false); } } });
  const reviewMut = useReviewLoanApplicationCollateral({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  
  const handleReview = (id: number, decision: 'approved' | 'incomplete' | 'rejected', reason?: string) => {
    if (decision !== 'approved' && !reason) {
      setReviewOpen({ id, decision });
      return;
    }
    reviewMut.mutate({ id: appId, collateralId: id, data: { decision, reason } });
  };
  const collateralMetadata = (item: any) => {
    if (item.dataJson && typeof item.dataJson === 'object') return item.dataJson;
    try { return JSON.parse(item.data_json || '{}'); } catch { return {}; }
  };
  const collateralDownloadUrl = (item: any, preview = false) => `/api/loan-applications/${appId}/collateral/${item.id}/download${preview ? '?preview=1' : ''}`;
  const hasFile = (item: any) => item.fileAvailable === true;
  const uploadedKeys = new Set(collaterals.filter(hasFile).map((item) => collateralMetadata(item).requirementKey));
  const allUploaded = requiredCollateral.length === 0 || requiredCollateral.every((slot) => uploadedKeys.has(slot.key));

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>وثایق و تضامین</h3>
          <p>سفته، چک و گواهی کسر از حقوق</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {canUpload && <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setOpen(true)}><CreditCard size={14} /> بارگذاری وثیقه</button>}
          {canSubmit && <button className="btn btn-primary" style={{ padding: '0 10px', height: 32 }} onClick={onSubmit} disabled={!allUploaded || submitPending}><UploadCloud size={14} /> {submitPending ? 'در حال ارسال...' : 'ارسال به کارشناس ثبت'}</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {collaterals.map(c => (
          (() => {
            const metadata = collateralMetadata(c);
            return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
               <div style={{ width: 48, height: 48, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CreditCard size={18} />
               </div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>نوع: {c.collateralType || c.collateral_type || 'نامشخص'}</strong>
                <span style={{ fontSize: 11, color: c.status === 'approved' ? '#0f766e' : (c.status === 'rejected' || c.status === 'incomplete') ? '#be123c' : '#94a3b8' }}>
                  {c.status === 'approved' ? 'تأیید شده' : c.status === 'incomplete' ? 'نقص مدرک' : c.status === 'rejected' ? 'رد شده' : 'در انتظار بررسی'}
                </span>
                {metadata.originalName && <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{metadata.originalName}</div>}
                {c.reviewReason && <div style={{ fontSize: 10, color: '#be123c', marginTop: 2 }}>{c.reviewReason}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {canUpload && <button data-testid={`button-upload-collateral-${c.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32 }} onClick={() => { setForm({ requirementKey: metadata.requirementKey || '', file: null }); setOpen(true); }}><UploadCloud size={14} /> {hasFile(c) ? 'جایگزینی' : 'آپلود'}</button>}
              {hasFile(c) && <button data-testid={`button-preview-collateral-${c.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32 }} onClick={() => setPreview({ title: metadata.label || 'وثیقه', mime: metadata.mimeType || '', url: collateralDownloadUrl(c, true), downloadUrl: collateralDownloadUrl(c) })}><Search size={14} /> مشاهده</button>}
              {hasFile(c) && <a data-testid={`link-download-collateral-${c.id}`} className="btn btn-ghost" style={{ padding: '0 9px', height: 32, textDecoration: 'none' }} href={collateralDownloadUrl(c)}><Download size={14} /> دانلود</a>}
              {canReview && hasFile(c) && c.status !== 'approved' && <button className="icon-button" style={{ width: 32, height: 32, color: '#047857', borderColor: '#a7f3d0', background: '#ecfdf5' }} onClick={() => handleReview(c.id, 'approved')}><CheckCircle2 size={14} /></button>}
              {canReview && hasFile(c) && c.status !== 'incomplete' && <button className="icon-button" style={{ width: 32, height: 32, color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }} onClick={() => handleReview(c.id, 'incomplete')}><XCircle size={14} /></button>}
              {canReview && hasFile(c) && c.status !== 'rejected' && <button className="icon-button" style={{ width: 32, height: 32, color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }} onClick={() => handleReview(c.id, 'rejected')}><XCircle size={14} /></button>}
            </div>
          </div>
            );
          })()
        ))}
        {collaterals.length === 0 && <div className="empty-state compact-empty"><p>وثیقه‌ای ثبت نشده است.</p></div>}
        {requiredCollateral.filter((slot) => !uploadedKeys.has(slot.key)).map((slot) => <div key={slot.key} style={{ padding: 12, border: '1px dashed #f59e0b', borderRadius: 10, color: '#92400e', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span>در انتظار بارگذاری: {slot.label}</span>{canUpload && <button data-testid={`button-upload-collateral-${slot.key}`} className="btn btn-ghost" onClick={() => { setForm({ requirementKey: slot.key, file: null }); setOpen(true); }}><UploadCloud size={14} /> آپلود</button>}</div>)}
      </div>
      {canSubmit && !allUploaded && <div style={{ color: '#b45309', fontSize: 11, marginTop: 10 }}>همه تصاویر وثیقه موردنیاز طرح را بارگذاری کنید.</div>}

      {open && (
        <Modal title="بارگذاری وثیقه" onClose={() => setOpen(false)} testId="upload-collateral-modal">
          <form onSubmit={e => { e.preventDefault(); const slot = requiredCollateral.find((item) => item.key === form.requirementKey); if (form.file && slot) submitMut.mutate({ id: appId, data: { collateralType: slot.type, requirementKey: slot.key, file: form.file } as any }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>تصویر موردنیاز طرح</label>
              <select value={form.requirementKey} onChange={e => setForm({...form, requirementKey: e.target.value})}>
                {requiredCollateral.map((slot) => <option key={slot.key} value={slot.key}>{slot.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>فایل وثیقه</label>
              <input type="file" required onChange={e => setForm({...form, file: e.target.files?.[0] || null})} style={{ padding: '8px 10px', background: '#fff' }} />
              <small style={{ color: '#64748b' }}>همه نوع فایل تا حجم ۱۰ مگابایت قابل بارگذاری است.</small>
            </div>
            {submitMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت وثیقه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={submitMut.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={submitMut.isPending || !form.file}>
                {submitMut.isPending ? 'در حال بارگذاری...' : 'ثبت وثیقه'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {reviewOpen && (
        <Modal title={reviewOpen.decision === 'incomplete' ? 'ثبت نقص وثیقه' : 'رد وثیقه'} onClose={() => setReviewOpen(null)} testId="review-collateral-modal">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>دلیل</label>
              <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} required rows={3} placeholder="علت نقص یا رد را بنویسید..." />
            </div>
            {reviewMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت نتیجه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReviewOpen(null)}>انصراف</button>
              <button type="button" className="btn btn-primary" disabled={!reviewReason.trim()} onClick={() => handleReview(reviewOpen.id, reviewOpen.decision, reviewReason)}>
                ثبت نتیجه
              </button>
            </div>
          </div>
        </Modal>
      )}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function isCurrentAuthorizedTomanReplacementSource(
  authorization: TomanReplacementState | null | undefined,
  currentPrimaryGenerationId: number | null,
  primaryDoc: any,
  isReplacement: boolean,
): boolean {
  return Boolean(isReplacement
    && authorization?.authorized
    && authorization.completedAt === null
    && authorization.replacementGenerationId === null
    && authorization.sourceGenerationId === currentPrimaryGenerationId
    && primaryDoc?.kind === 'primary'
    && Number(primaryDoc.contractGenerationId) === authorization.sourceGenerationId
    && primaryDoc.current !== false
    && primaryDoc.isCurrentPrimary !== false);
}
function ContractSection({ appId, docs = [], currentPrimaryGenerationId, tomanReplacement, canSubmit, canConfirmSigned = false, canIssuePrimary = false, canResend = false, isReplacement = false, manualValues = {}, manualVariables = [], canVerify, readOnlySignatureStatus = false, canUpload, canReview }: { appId: number, docs: any[], currentPrimaryGenerationId: number | null, tomanReplacement?: TomanReplacementState | null, canSubmit: boolean, canConfirmSigned?: boolean, canIssuePrimary?: boolean, canResend?: boolean, isReplacement?: boolean, manualValues?: Record<string, string>, manualVariables?: { variable: string; label: string }[], canVerify: boolean, readOnlySignatureStatus?: boolean, canUpload: boolean, canReview: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [signatureResult, setSignatureResult] = useState<{
    signed: boolean;
    providerStatus?: string | null;
    providerStatusTitle?: string | null;
    checkedAt?: string;
    readOnly?: boolean;
  } & SignatureStatusWorkflowOutcome | null>(null);
  const [signatureError, setSignatureError] = useState('');
  const [form, setForm] = useState({ kind: 'primary', contractGenerationId: '' });
  const [rejectDoc, setRejectDoc] = useState<any | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [issuingPrimary, setIssuingPrimary] = useState(false);
  const [primaryIssueStep, setPrimaryIssueStep] = useState('');
  const [primaryIssueError, setPrimaryIssueError] = useState('');
  const [certificateErrorOpen, setCertificateErrorOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueValues, setIssueValues] = useState<Record<string, string>>({});
  const [issueValidation, setIssueValidation] = useState('');
  const generatePrimary = useGenerateContract();
  const sendPrimary = useSendContractGeneration();
  const primaryDoc = docs.find((doc: any) => isCurrentPrimaryDocument(doc, currentPrimaryGenerationId));
  const authorizedLegacySourcePending = isCurrentAuthorizedTomanReplacementSource(
    tomanReplacement, currentPrimaryGenerationId, primaryDoc, isReplacement,
  );
  const mayIssuePrimary = Boolean(canIssuePrimary && (tomanReplacement?.authorized
    ? authorizedLegacySourcePending
    : !primaryDoc));
  const mayConfirmSignedPrimary = canConfirmSigned && !authorizedLegacySourcePending;
  const issuePrimary = async (values: Record<string, string>) => {
    if (!mayIssuePrimary || issuingPrimary) {
      if (!issuingPrimary) {
        setPrimaryIssueError('نسل قرارداد اصلی یا اجازهٔ جایگزینی تغییر کرده است؛ وضعیت پرونده را تازه‌سازی و دوباره بررسی کنید.');
        setIssueOpen(false);
      }
      return;
    }
    setIssuingPrimary(true);
    setPrimaryIssueError('');
    setCertificateErrorOpen(false);
    let step = 'تولید قرارداد اصلی';
    try {
      setPrimaryIssueStep(step);
      const generation = await generatePrimary.mutateAsync({ data: { loanApplicationId: appId, manualValues: values } });
      if (!generation.id) throw new Error('شناسه قرارداد دریافت نشد.');
      step = 'ارسال قرارداد برای امضا';
      setPrimaryIssueStep(step);
      await sendPrimary.mutateAsync({ id: generation.id });
      step = 'ثبت قرارداد در پرونده';
      setPrimaryIssueStep(step);
      await linkMut.mutateAsync({ id: appId, data: { kind: 'primary', contractGenerationId: generation.id } });
      if (!isReplacement) {
        step = 'ارسال پرونده برای بررسی امضا';
        setPrimaryIssueStep(step);
        await submitMut.mutateAsync({ id: appId });
      }
      await queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
      await queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
      setIssueOpen(false);
    } catch (failure) {
      const issue = failure as { data?: { error?: string }; response?: { data?: { error?: string } }; error?: { error?: string } };
      const code = issue.data?.error ?? issue.response?.data?.error ?? issue.error?.error;
      if (code === 'certificate_inactive') setCertificateErrorOpen(true);
      setPrimaryIssueError(code === 'existing_contract_manual_values_locked'
        ? 'این قرارداد قبلاً تولید شده و مقادیر آن قابل تغییر نیست. برای جلوگیری از تغییر مفاد سند ارسال‌شده، همان مقادیر ثبت‌شده را تأیید و دوباره تلاش کنید.'
        : code === 'approved_contract_terms_not_rendered'
        ? 'مبلغ یا تعداد اقساط مصوب در سند تولیدشده قابل تأیید نیست. قرارداد برای امضا ارسال نشده است؛ قالب و خروجی قرارداد باید بررسی شوند.'
        : code === 'application_primary_generation_mismatch'
        ? 'نسخهٔ موجود با شرایط مصوب این پرونده مطابقت ندارد. قرارداد امضاشده یا ارسال‌شده خودکار تغییر نمی‌کند؛ وضعیت نسخهٔ جاری را بررسی کنید.'
        : code === 'certificate_inactive'
        ? 'این مشتری گواهی امضای فعال ندارد. ابتدا گواهی را در سرویس امضا فعال کنید و سپس دوباره تلاش کنید؛ از همین قرارداد استفاده می‌شود.'
        : code === 'provider_certificate_check_failed'
          ? 'بررسی گواهی امضا در سرویس امضا موقتاً ناموفق بود. دوباره تلاش کنید؛ از همین قرارداد استفاده می‌شود.'
          : `${step} انجام نشد${code ? ` (${code})` : ''}. دوباره تلاش کنید؛ قرارداد موجود دوباره استفاده می‌شود.`);
      void queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
    } finally {
      setIssuingPrimary(false);
    }
  };
  
  const submitMut = useSubmitPrimaryContractLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const confirmSignedMut = useConfirmSignedPrimaryLoanApplication({
    mutation: { onSuccess: () => queryClient.invalidateQueries() },
  });
  const linkMut = useLinkLoanApplicationGeneratedDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setOpen(false); } } });
  const verifyMut = useVerifyLoanApplicationGeneratedDocumentSignature({
    mutation: {
      onMutate: () => {
        setSignatureResult(null);
        setSignatureError('');
      },
      onSuccess: (result) => {
        const observation = result as typeof result & {
          providerStatus?: string | null;
        } & SignatureStatusWorkflowOutcome;
        setSignatureResult({
          signed: Boolean(result.signed),
          providerStatus: observation.providerStatus ?? null,
          workflowAdvanced: observation.workflowAdvanced,
          nextStage: observation.nextStage ?? null,
        });
        void queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
        void queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
      },
      onError: (error) => {
        const failure = classifySignatureVerificationError(error);
        setSignatureError(failure.message);
      },
    },
  });
  const readOnlyVerifyMut = useMutation({
    mutationFn: ({ id, documentId }: { id: number; documentId: number }) =>
      getLoanApplicationGeneratedDocumentSignatureStatus(id, documentId),
    onMutate: () => {
      setSignatureResult(null);
      setSignatureError('');
    },
    onSuccess: (result) => {
      setSignatureResult({
        signed: Boolean(result.signed),
        providerStatus: result.providerStatus ?? null,
        providerStatusTitle: result.providerStatusTitle ?? null,
        checkedAt: result.checkedAt,
        readOnly: true,
        workflowAdvanced: false,
        nextStage: null,
      });
    },
    onError: (error) => {
      const failure = classifySignatureVerificationError(error);
      setSignatureError(failure.message);
    },
  });
  const reviewMut = useReviewLoanApplicationGeneratedDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setRejectDoc(null); setReviewReason(''); } } });
  const openUpload = (kind: 'primary' | 'invoice' | 'acknowledgement' = 'primary') => {
    setForm({ kind, contractGenerationId: '' });
    setOpen(true);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>قراردادها</h3>
          <p>امضای دیجیتال و صدور قرارداد</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {mayConfirmSignedPrimary && primaryDoc?.signed && (
            <button type="button" data-testid="button-confirm-signed-primary" className="btn btn-primary" disabled={confirmSignedMut.isPending} onClick={() => confirmSignedMut.mutate({ id: appId })}>
              <CheckCircle2 size={14} /> {confirmSignedMut.isPending ? 'در حال تأیید...' : 'تأیید قرارداد امضاشده و مرحله بعد'}
            </button>
          )}
          {canSubmit && primaryDoc && !primaryDoc.signed && (
            <button type="button" data-testid="button-submit-primary-contract" className="btn btn-ghost" disabled={submitMut.isPending || issuingPrimary} style={{ padding: '0 10px', height: 32 }} onClick={() => submitMut.mutate({ id: appId })}>
              <Play size={14} /> {submitMut.isPending ? 'در حال ارسال...' : 'تلاش دوباره برای ورود به بررسی امضا'}
            </button>
          )}
          {mayIssuePrimary && <button type="button" className="btn btn-primary" data-testid="button-issue-primary-contract" disabled={issuingPrimary} onClick={() => { setIssueValues(Object.fromEntries(manualVariables.map(({ variable }) => [variable, manualValues[variable] ?? '']))); setIssueValidation(''); setPrimaryIssueError(''); setIssueOpen(true); }}><FileSignature size={14} /> {isReplacement ? 'بررسی و صدور قرارداد جایگزین' : 'بررسی و صدور قرارداد اصلی'}</button>}
          {canUpload && (
            <button data-testid="button-upload-generated-document" className="btn btn-primary" style={{ padding: '0 10px', height: 32 }} onClick={() => openUpload()}>
              <FileSignature size={14} /> آپلود سند جدید
            </button>
          )}
        </div>
      </div>
      {canSubmit && !canIssuePrimary && !primaryDoc && <p className="funding-guidance">صدور قرارداد اصلی نیازمند دسترسی صدور قرارداد برای کارشناس فروش است.</p>}
      {primaryIssueError && !certificateErrorOpen && <p className="form-error" role="alert" data-testid="error-issue-primary-contract">{primaryIssueError}</p>}
      {submitMut.isError && <p className="form-error" role="alert">ورود به مرحله بررسی امضا انجام نشد. دوباره تلاش کنید.</p>}
      {confirmSignedMut.isError && <p className="form-error" role="alert">این قرارداد برای ادامه پرونده قابل تأیید نیست. وضعیت امضا و مطابقت شرایط قرارداد با پرونده را بررسی کنید.</p>}

      <div style={{ display: 'grid', gap: 10 }}>
        {docs.map(c => {
          const historicalPrimary = c.kind === 'primary' && !isCurrentPrimaryDocument(c, currentPrimaryGenerationId);
          return (
          <div key={c.id} data-testid={historicalPrimary ? `historical-primary-${c.id}` : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, opacity: historicalPrimary ? 0.8 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <FileSignature size={18} />
              </div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>نوع: {c.kind === 'primary' ? 'قرارداد اصلی' : c.kind === 'invoice' ? 'صورت‌حساب' : 'رسید'}</strong>
                {historicalPrimary && <span style={{ display: 'block', fontSize: 11, color: '#9f1239', fontWeight: 700 }}>نسخه پیشین · فقط برای مشاهده سوابق؛ قرارداد معتبر فعلی نیست</span>}
                <span style={{ fontSize: 11, color: c.signed ? '#0f766e' : '#94a3b8' }}>
                  وضعیت ثبت امضا در پرونده: {c.signed ? 'تأیید شده' : 'تأیید ثبت نشده'} · وضعیت بررسی: {c.status === 'approved' ? 'تأیید شده' : c.status === 'rejected' ? 'رد شده' : c.status === 'incomplete' ? 'ناقص' : 'در انتظار بررسی'} (شناسه صدور: {c.contractGenerationId})
                </span>
                {typeof c.provider_status === 'string' && c.provider_status.trim() !== '' && <div data-testid={`status-emzame-${c.id}`} role="status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 5, fontSize: 11, color: providerReportsSigned(c.provider_status) ? '#047857' : '#475569' }}>
                  <strong>{providerReportsSigned(c.provider_status) ? 'امضامی امضا را گزارش کرده است' : 'وضعیت امضامی'}</strong>
                  <span>وضعیت خام: <bdi dir="auto">{c.provider_status}</bdi></span>
                </div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {canResend && !historicalPrimary && c.kind === 'primary' && !c.signed && <UpdatedContractBanner kind="loan" subjectId={appId} />}
              {canResend && !historicalPrimary && c.kind === 'primary' && !c.signed &&
                c.status !== 'rejected' && c.status !== 'approved' &&
                (providerReportsRejected(c.provider_status) || c.resendRepairRequired || ['generated', 'failed'].includes(c.generation_status)) &&
                <RejectedContractResend applicationId={appId} generationId={Number(c.contractGenerationId)}
                  rejected={c.generation_status === 'sent' && providerReportsRejected(c.provider_status)}
                  repairPending={Boolean(c.resendRepairRequired)} />}
              {canUpload && c.kind === 'primary' && !historicalPrimary && <button data-testid={`button-upload-contract-${c.id}`} className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => openUpload('primary')}><UploadCloud size={14} /> {c.fileAvailable ? 'جایگزینی' : 'آپلود'}</button>}
              {canUpload && c.kind !== 'primary' && <button data-testid={`button-upload-generated-document-${c.id}`} className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => openUpload(c.kind)}><UploadCloud size={14} /> {c.fileAvailable ? 'جایگزینی' : 'آپلود'}</button>}
              {c.fileAvailable && c.downloadUrl && <button data-testid={`button-preview-contract-${c.id}`} className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setPreview({ title: c.kind === 'primary' ? 'قرارداد اصلی' : c.kind === 'invoice' ? 'صورت‌حساب' : 'رسید', mime: 'application/pdf', url: `${c.downloadUrl}?preview=1`, downloadUrl: c.downloadUrl })}><Search size={14} /> مشاهده</button>}
              {c.fileAvailable && c.downloadUrl && <a data-testid={`link-download-contract-${c.id}`} className="btn btn-ghost" href={c.downloadUrl} download style={{ padding: '0 10px', height: 32, textDecoration: 'none' }}><Download size={14} /> دانلود PDF</a>}
              {canVerify && (
                <button type="button" data-testid={`button-check-emzame-status-${c.id}`} className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} disabled={verifyMut.isPending || readOnlyVerifyMut.isPending} onClick={() => {
                  if (readOnlySignatureStatus) readOnlyVerifyMut.mutate({ id: appId, documentId: c.id });
                  else verifyMut.mutate({ id: appId, documentId: c.id });
                }}>
                  {verifyMut.isPending || readOnlyVerifyMut.isPending ? 'در حال استعلام...' : 'بررسی وضعیت امضا'}
                </button>
              )}
              {c.kind === 'primary' && !historicalPrimary && canReview && c.status !== 'approved' && (
                <button data-testid={`button-approve-contract-${c.id}`} className="btn btn-primary" style={{ padding: '0 10px', height: 32 }} disabled={!c.signed || !c.fileAvailable || reviewMut.isPending} onClick={() => reviewMut.mutate({ id: appId, documentId: c.id, data: { decision: 'approved' } })}>
                  تأیید قرارداد
                </button>
              )}
              {c.kind === 'primary' && !historicalPrimary && canReview && c.status !== 'rejected' && c.status !== 'incomplete' && (
                <button data-testid={`button-reject-contract-${c.id}`} className="btn" style={{ padding: '0 10px', height: 32, background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} disabled={!c.signed || !c.fileAvailable} onClick={() => setRejectDoc(c)}>
                  رد قرارداد
                </button>
              )}
            </div>
          </div>
        ); })}
        {docs.length === 0 && <div className="empty-state compact-empty"><p>قراردادی پیوست نشده است.</p></div>}
        {signatureError && <div className="form-error" role="alert">{signatureError}</div>}
        {reviewMut.isError && <div className="form-error" role="alert">ثبت نتیجه قرارداد انجام نشد. امضای قرارداد و مرحله پرونده را بررسی کنید.</div>}
      </div>

      {certificateErrorOpen && (
        <Modal title="گواهی امضای فعال یافت نشد" onClose={() => setCertificateErrorOpen(false)} testId="inactive-signature-certificate">
          <p className="form-error" role="alert">{primaryIssueError}</p>
          <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={() => setCertificateErrorOpen(false)}>متوجه شدم</button>
          </div>
        </Modal>
      )}
      {issueOpen && (
        <Modal title={isReplacement ? 'تأیید مقادیر و صدور قرارداد جایگزین' : 'تأیید مقادیر و صدور قرارداد اصلی'} onClose={() => { if (!issuingPrimary) setIssueOpen(false); }} testId="confirm-primary-contract-values">
          <form onSubmit={(event) => {
            event.preventDefault();
            const values = Object.fromEntries(manualVariables.map(({ variable }) => [variable, (issueValues[variable] ?? '').trim()]));
            if (Object.values(values).some((value) => !value || value.length > 5000)) {
              setIssueValidation('همه مقادیر دستی باید تکمیل شوند و حداکثر ۵۰۰۰ نویسه باشند.');
              return;
            }
            setIssueValidation('');
            void issuePrimary(values);
          }} style={{ display: 'grid', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 13 }}>مقادیر دستی زیر در متن قرارداد درج می‌شوند. آن‌ها را بررسی کنید و در صورت نیاز پیش از صدور تغییر دهید.</p>
            {manualVariables.length === 0 && <p style={{ margin: 0, fontSize: 12 }}>این قالب مقدار دستی ندارد. شرایط قرارداد را پیش از صدور بررسی کنید.</p>}
            {manualVariables.map(({ variable, label }) => <label key={variable} className="field">
              <span>{label}</span>
              <input data-testid={`confirm-contract-variable-${variable}`} value={issueValues[variable] ?? ''} maxLength={5000} required disabled={issuingPrimary} onChange={(event) => setIssueValues((current) => ({ ...current, [variable]: event.target.value }))} />
            </label>)}
            {issueValidation && <p className="form-error" role="alert">{issueValidation}</p>}
            {primaryIssueError && <p className="form-error" role="alert">{primaryIssueError}</p>}
            <div className="form-footer">
              <button type="button" className="btn btn-ghost" disabled={issuingPrimary} onClick={() => setIssueOpen(false)}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={issuingPrimary}>{issuingPrimary ? `${primaryIssueStep}...` : 'تأیید و صدور مجدد قرارداد'}</button>
            </div>
          </form>
        </Modal>
      )}

      {open && (
        <Modal title="پیوست قرارداد صادرشده" onClose={() => setOpen(false)} testId="link-contract-modal">
          <form onSubmit={e => { e.preventDefault(); if (form.contractGenerationId) linkMut.mutate({ id: appId, data: { kind: form.kind as 'primary' | 'invoice' | 'acknowledgement', contractGenerationId: Number(form.contractGenerationId) } }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>نوع سند</label>
              <select value={form.kind} onChange={e => setForm({...form, kind: e.target.value})}>
                <option value="primary">قرارداد اصلی</option>
                <option value="invoice">صورت‌حساب (Invoice)</option>
                <option value="acknowledgement">رسید تسویه</option>
              </select>
            </div>
            <div className="field">
              <label>شناسه صدور قرارداد (از بخش مدیریت قراردادها)</label>
              <input type="number" required value={form.contractGenerationId} onChange={e => setForm({...form, contractGenerationId: e.target.value})} dir="ltr" min="1" />
            </div>
            {linkMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در پیوست قرارداد.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={linkMut.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={linkMut.isPending || !form.contractGenerationId}>
                {linkMut.isPending ? 'در حال پیوست...' : 'پیوست قرارداد'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {rejectDoc && (
        <Modal title="رد قرارداد امضاشده" onClose={() => setRejectDoc(null)} testId="reject-primary-contract-modal">
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="field"><label>دلیل رد قرارداد</label><textarea rows={3} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></div>
            <div className="form-footer"><button className="btn btn-ghost" onClick={() => setRejectDoc(null)}>انصراف</button><button className="btn btn-primary" disabled={!reviewReason.trim() || reviewMut.isPending} onClick={() => reviewMut.mutate({ id: appId, documentId: rejectDoc.id, data: { decision: 'rejected', reason: reviewReason } })}>ثبت رد و بازگشت به فروش</button></div>
          </div>
        </Modal>
      )}
      <FilePreview file={preview} onClose={() => setPreview(null)} />

      {signatureResult && (
        <Modal title="وضعیت امضا در امضامی" onClose={() => setSignatureResult(null)} testId="loan-signature-status-modal">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              padding: 14,
              borderRadius: 10,
              color: signatureResult.signed ? '#047857' : '#1e40af',
              background: signatureResult.signed ? '#ecfdf5' : '#eff6ff',
              border: `1px solid ${signatureResult.signed ? '#a7f3d0' : '#bfdbfe'}`,
            }}>
              <strong>{signatureResult.signed ? 'امضامی امضای تکمیل‌شده را گزارش کرده است.' : 'امضامی امضای تکمیل‌شده گزارش نکرده است.'}</strong>
              <div style={{ marginTop: 6, fontSize: 12 }}>وضعیت خام امضامی: <bdi dir="auto">{signatureResult.providerStatus ?? signatureResult.providerStatusTitle ?? 'در پاسخ گزارش نشده'}</bdi></div>
            </div>
            {signatureResult.readOnly && <p role="status" data-testid="status-signature-readonly-inquiry" style={{ margin: 0, fontSize: 12, color: '#475569' }}>
              این استعلام فقط‌خواندنی بود؛ وضعیت ذخیره‌شده و مرحلهٔ پرونده تغییر نکرد.
            </p>}
            {signatureResult.workflowAdvanced && <p role="status" data-testid="status-signature-workflow-advanced" style={{ margin: 0, fontSize: 13, color: '#047857' }}>
              پرونده پس از ثبت امضای گزارش‌شده به مرحلهٔ «{signatureResult.nextStage ? STAGE_LABELS[signatureResult.nextStage] ?? signatureResult.nextStage : 'بعدی'}» منتقل شد.
            </p>}
            {signatureResult.signed && !signatureResult.workflowAdvanced && !signatureResult.readOnly && <p role="status" data-testid="status-signature-workflow-unchanged" style={{ margin: 0, fontSize: 12, color: '#475569' }}>
              امضامی امضا را گزارش کرده است؛ در این استعلام گذار تازه‌ای در مرحلهٔ پرونده ثبت نشد.
            </p>}
            <p style={{ margin: 0, fontSize: 12, color: '#475569' }}>گزارش امضا به‌تنهایی به معنای تصویب مبلغ یا تأمین مالی نیست.</p>
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" onClick={() => setSignatureResult(null)}>بستن</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LegacyTomanReplacementPanel({ appId, eligibility, authorization, isAdmin }: {
  appId: number;
  eligibility?: TomanReplacementEligibility | null;
  authorization?: TomanReplacementState | null;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [consentTerms, setConsentTerms] = useState<TomanReplacementEligibility | null>(null);
  const [termsChanged, setTermsChanged] = useState(false);
  const closeConsentDialog = () => {
    setOpen(false);
    setConsent(false);
    setReason('');
    setConsentTerms(null);
  };

  useEffect(() => {
    if (!open || !consentTerms || sameTomanReplacementTerms(consentTerms, eligibility)) return;
    setOpen(false);
    setConsent(false);
    setReason('');
    setConsentTerms(null);
    setError('');
    setTermsChanged(true);
  }, [open, consentTerms, eligibility?.eligible, eligibility?.candidate, eligibility?.sourceGenerationId,
    eligibility?.approvedAmount, eligibility?.durationMonths, eligibility?.tomanTemplateId,
    eligibility?.tomanTemplateName]);

  const authorize = useAuthorizeLoanApplicationTomanReplacement({
    mutation: {
      onSuccess: async (updatedApplication) => {
        queryClient.setQueryData(getGetLoanApplicationQueryKey(appId), updatedApplication);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) }),
          queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() }),
        ]);
        setOpen(false);
        setReason('');
        setConsent(false);
        setConsentTerms(null);
        setError('');
      },
      onError: (failure) => {
        const apiError = failure as {
          data?: { error?: string };
          response?: { data?: { error?: string } };
        };
        const code = apiError.data?.error ?? apiError.response?.data?.error;
        const messages: Record<string, string> = {
          admin_role_required: 'فقط مدیر مجاز به ثبت این اجازه است.',
          invalid_toman_replacement_consent: 'دلیل (حداقل ۸ نویسه)، تأیید صریح و شرایط درخواست را بررسی کنید.',
          toman_replacement_terms_stale: 'نسل قرارداد یا شرایط مصوب تغییر کرده است. اطلاعات پرونده به‌روز شد؛ دوباره بررسی کنید.',
          legacy_rial_principal_not_proven: 'مبلغ اصلِ قرارداد قبلی با مدرک قابل اتکا تطبیق داده نشد؛ اجازه ثبت نشد.',
          replacement_already_authorized: 'برای این پرونده پیش‌تر اجازهٔ جایگزینی ثبت شده است.',
          loan_application_not_found: 'پرونده پیدا نشد یا دیگر در دسترس نیست.',
          action_forbidden: 'شما مجاز به ثبت این اجازه نیستید.',
        };
        setError((code && messages[code]) || 'ثبت اجازه انجام نشد. وضعیت پرونده را تازه‌سازی و دوباره بررسی کنید.');
        if (code === 'toman_replacement_terms_stale' || code === 'replacement_already_authorized') {
          void queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
          void queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
        }
      },
    },
  });

  const isCandidate = Boolean(eligibility?.candidate || eligibility?.eligible);
  const canAuthorize = Boolean(eligibility?.eligible
    && eligibility.sourceGenerationId !== null
    && eligibility.tomanTemplateId !== null
    && /^[1-9]\d{0,17}$/.test(eligibility.approvedAmount)
    && Number.isSafeInteger(eligibility.durationMonths)
    && eligibility.durationMonths > 0);
  if (!authorization && (!isAdmin || !isCandidate || !eligibility)) return null;
  const terms = authorization || eligibility;
  if (!terms) return null;
  const amount = /^\d+$/.test(String(terms.approvedAmount)) ? BigInt(terms.approvedAmount) : null;
  const amountLabel = amount === null ? terms.approvedAmount : amount.toLocaleString('fa-IR');
  const resumeStage = authorization?.resumeStage || authorization?.priorStage || '';
  const reasonLabels: Record<string, string> = {
    application_not_eligible: 'این پرونده ردشده یا تکمیل‌شده است.',
    approved_terms_missing: 'مبلغ یا مدت مصوب معتبر در پرونده ثبت نشده است.',
    application_already_credited: 'پرونده قبلاً اعتبار دریافت کرده است و این جایگزینی مجاز نیست.',
    replacement_already_authorized: 'برای این پرونده پیش‌تر اجازهٔ جایگزینی ثبت شده است.',
    accepted_current_primary_required: 'نسل جاری قرارداد اصلی باید در پرونده امضاشده و با وضعیت پذیرش معتبر باشد.',
    attested_active_toman_template_required: 'قالب فعال و تأییدشدهٔ تومانی برای این طرح موجود نیست.',
    toman_template_terms_mapping_invalid: 'نگاشت مبلغ یا مدت در قالب تومانی معتبر نیست.',
    legacy_rial_principal_not_proven: 'بند اصل مبلغ با واحد ریال در سند امضاشده به‌طور قابل‌اثبات تطبیق داده نشد.',
  };
  const blockedReason = eligibility?.blockedReason
    ? reasonLabels[eligibility.blockedReason] || 'علت این محدودیت برای نمایش آماده نیست؛ پرونده را با مسئول سامانه بررسی کنید.'
    : '';

  return (
    <div data-testid="legacy-toman-replacement-panel" role="status" style={{ marginTop: 14, padding: 14, border: '1px solid #fde68a', borderRadius: 10, background: '#fffbeb', display: 'grid', gap: 10 }}>
      {authorization?.authorized && <div data-testid="status-toman-replacement-authorized" style={{ color: '#166534', fontSize: 12, lineHeight: 1.8 }}>
        {authorization.completedAt
          ? <>
            <strong>امضای قرارداد جایگزین تومانی تأیید و پرونده از توقف خارج شد.</strong>
            {' '}نسل جایگزین {authorization.replacementGenerationId ?? '—'} امضا شده است؛ پرونده به مرحلهٔ «{STAGE_LABELS[resumeStage] || resumeStage}» بازگشته است.
          </>
          : <>
            <strong>اجازهٔ موردی مدیر ثبت شده است؛ امضای نسخهٔ جایگزین هنوز در انتظار است.</strong>
            {' '}نسل قبلی {authorization.sourceGenerationId} و شرایط مصوب {amountLabel} تومان، {Number(authorization.durationMonths).toLocaleString('fa-IR')} ماه ثبت شده‌اند.
            {' '}پس از تأیید امضای معتبر، پرونده به مرحلهٔ «{STAGE_LABELS[resumeStage] || resumeStage}» بازمی‌گردد.
            {authorization.replacementGenerationId == null
              ? ' قرارداد جایگزین هنوز صادر نشده است.'
              : ` نسل جایگزین ${authorization.replacementGenerationId} ثبت شده است؛ امضا همچنان در انتظار می‌ماند.`}
          </>}
      </div>}
      {eligibility && isAdmin && isCandidate && !authorization?.authorized && <>
      <div>
        <strong style={{ color: '#92400e', fontSize: 13 }}>امضای قرارداد قبلی تأیید شده؛ تطبیق سند با شرایط مالی نیازمند بررسی است.</strong>
        <p style={{ margin: '6px 0 0', color: '#78350f', fontSize: 12 }}>این بررسی مانع ثبت ضامن یا تکمیل مدارک نیست؛ کنترل سند مالی پیش از تأیید نهایی و پرداخت انجام می‌شود. برابر بودن مبلغ درخواستی و مصوب به‌تنهایی دلیل صدور دوبارهٔ قرارداد نیست.</p>
        <p style={{ margin: '6px 0 0', color: '#78350f', fontSize: 12, lineHeight: 1.7 }}>
          نسل قبلی: {eligibility.sourceGenerationId ?? 'نامشخص'} · شرایط مصوب فعلی: {amountLabel} تومان، {Number(eligibility.durationMonths).toLocaleString('fa-IR')} ماه
        </p>
        {eligibility.tomanTemplateName && <p style={{ margin: '4px 0 0', color: '#78350f', fontSize: 12 }}>نسخهٔ جایگزین قابل‌صدور: {eligibility.tomanTemplateName} (تومانی)</p>}
      </div>
      {termsChanged && <p role="alert" style={{ margin: 0, color: '#92400e', fontSize: 12 }}>نسل قرارداد، مبلغ، مدت یا قالب تومانی هنگام باز بودن پنجره تغییر کرد؛ اجازهٔ قبلی لغو شد. شرایط تازه را دوباره بررسی کنید.</p>}
      {!eligibility.eligible && blockedReason && <p style={{ margin: 0, color: '#92400e', fontSize: 12 }}>{blockedReason}</p>}
      {canAuthorize
        ? <div><p style={{ margin: '0 0 8px', color: '#78350f', fontSize: 12, lineHeight: 1.7 }}>پس از بررسی سابقه، مدیر می‌تواند اجازهٔ موردی ثبت کند. این اقدام قرارداد را صادر یا ارسال نمی‌کند؛ پس از آن باید از مسیر عادی نسخهٔ جایگزین ساخته و برای امضا فرستاده شود.</p>
          <button type="button" className="btn btn-primary" data-testid="button-authorize-toman-replacement" onClick={() => { setReason(''); setConsent(false); setConsentTerms({ ...eligibility }); setError(''); setTermsChanged(false); setOpen(true); }}>بررسی و اجازهٔ موردی مدیر</button>
        </div>
        : <p style={{ margin: 0, color: '#92400e', fontSize: 12 }}>{eligibility.eligible
          ? 'دادهٔ نسل، مبلغ، مدت یا قالب برای ثبت امن اجازه کامل نیست؛ جزئیات پرونده را به‌روز و بررسی کنید.'
          : 'فعلاً امکان ثبت اجازه وجود ندارد؛ علت و شرایط پرونده را بررسی کنید.'}</p>}
      </>}
      {open && consentTerms?.eligible && (
        <Modal title="اجازهٔ موردی برای صدور قرارداد تومانی" onClose={() => { if (!authorize.isPending) closeConsentDialog(); }} testId="authorize-toman-replacement-dialog">
          <form onSubmit={(event) => {
            event.preventDefault();
            setError('');
            if (reason.trim().length < 8 || !consent || authorize.isPending ||
                consentTerms.sourceGenerationId == null || consentTerms.tomanTemplateId == null ||
                !sameTomanReplacementTerms(consentTerms, eligibility)) {
              if (!sameTomanReplacementTerms(consentTerms, eligibility)) setTermsChanged(true);
              return;
            }
            authorize.mutate({ id: appId, data: {
              consent: true,
              reason: reason.trim(),
              expectedGenerationId: consentTerms.sourceGenerationId,
              expectedApprovedAmount: consentTerms.approvedAmount,
              expectedDurationMonths: consentTerms.durationMonths,
            } });
          }} style={{ display: 'grid', gap: 14 }}>
            <div style={{ padding: 12, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#78350f', fontSize: 12, lineHeight: 1.8 }}>
              نسل امضاشدهٔ قبلی: {consentTerms.sourceGenerationId}<br />
              مبلغ مصوب: <strong>{formatTomanAmount(consentTerms.approvedAmount)} تومان</strong> · مدت مصوب: <strong>{Number(consentTerms.durationMonths).toLocaleString('fa-IR')} ماه</strong><br />
              قالب جایگزین: <strong>{consentTerms.tomanTemplateName || `قالب تومانی #${consentTerms.tomanTemplateId ?? '—'}`}</strong>
            </div>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.8, color: '#475569' }}>
              اجازه فقط مسیر صدور نسخهٔ جایگزین را باز می‌کند و به‌تنهایی هیچ قراردادی صادر یا ارسال نمی‌کند. نسخهٔ جدید باید بر اساس همین مبلغ و مدت مصوب ساخته و با امضای جدید تأیید شود.
            </p>
            <p style={{ margin: 0, padding: 11, borderRadius: 8, background: '#f8fafc', fontSize: 12, lineHeight: 1.8, color: '#334155' }}>
              PDF و امضای قبلی، سوابق و مبالغ ذخیره‌شده حفظ می‌شوند. مبلغ‌ها تبدیل، ضرب یا تقسیم نمی‌شوند؛ نسخهٔ جدید مبلغ موجود در پرونده را با واحد تومان نشان می‌دهد.
            </p>
            <label className="field">
              <span>دلیل بررسی و اجازهٔ مدیر</span>
              <textarea data-testid="input-toman-replacement-reason" rows={3} minLength={8} maxLength={1000} required value={reason} disabled={authorize.isPending} onChange={(event) => setReason(event.target.value)} />
            </label>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.8, color: '#334155' }}>
              <input data-testid="consent-toman-replacement" type="checkbox" checked={consent} disabled={authorize.isPending} onChange={(event) => setConsent(event.target.checked)} />
              <span>تأیید می‌کنم سابقه و سند قبلی حفظ می‌شود و اجازه می‌دهم برای مبلغ و مدت مصوب بالا، قرارداد جایگزین تومانی جهت امضای مجدد صادر شود.</span>
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-footer">
              <button type="button" className="btn btn-ghost" disabled={authorize.isPending} onClick={closeConsentDialog}>انصراف</button>
              <button type="submit" className="btn btn-primary" data-testid="submit-toman-replacement-consent" disabled={authorize.isPending || reason.trim().length < 8 || !consent}>
                {authorize.isPending ? 'در حال ثبت اجازه…' : 'ثبت اجازهٔ موردی'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function CaseCreditRankOverrides({ applicationId }: { applicationId: number }) {
  const { data } = useListLoanApplicationCreditRankOverrides(applicationId, {
    query: { queryKey: getListLoanApplicationCreditRankOverridesQueryKey(applicationId), staleTime: 30_000 },
  });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <details className="ldx-override-log" data-testid="case-credit-rank-overrides" open style={{ margin: '8px 0' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>سابقهٔ نادیده گرفتن رتبه ({items.length.toLocaleString('fa-IR')}) · فقط مدیر</summary>
      <div style={{ marginTop: 8 }}><CreditRankOverrideRows items={items} showCase={false} /></div>
    </details>
  );
}
