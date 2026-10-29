import { useState, useMemo, useEffect } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useListContractTemplates,
  useCreateContractTemplate,
  useUpdateContractTemplate,
  useDeleteContractTemplate,
  useAnalyzeContractTemplate,
  useGetContractCustomerFields,
  useListContractGenerations,
  useGenerateContract,
  useSendContractGeneration,
  prepareRejectedContractResend,
  useCheckContractSignatureStatus,
  getContractSignatureStatus,
  useDeleteContractGeneration,
  useListCustomers,
  useListLoanPlans,
  useGetCustomer,
  getListContractTemplatesQueryKey,
  getListContractGenerationsQueryKey,
  getGetLoanApplicationQueryKey,
  getListLoanApplicationsQueryKey,
  downloadContractGeneration,
  downloadContractTemplate,
  type ContractTemplate,
  type ContractGeneration,
  type ContractSignatureStatus,
  type ReadOnlySignatureStatus,
  type Customer,
  type ContractMapping,
  type ContractMappingFormulaTokensItem,
  type ContractMappingSourceType,
  getGetCustomerQueryKey,
  getListCustomersQueryKey,
  getListLoanPlansQueryKey,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { FileSignature, Plus, Download, FileText, Send, CheckCircle2, AlertCircle, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { SkeletonPanel } from '@/components/CrmShell';
import { useToast } from '@/hooks/use-toast';
import { CERTIFICATE_INACTIVE_MESSAGE } from '@/lib/contract-send-errors.mjs';
import { classifyProviderStatus, providerReportsSigned, providerReportsRejected, type SignatureStatusWorkflowOutcome } from '@/lib/loan-signature-verification-errors.mjs';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

const getErrorMessage = (err: any, defaultMsg: string) => {
  const providerMessages: Record<string, string> = {
    provider_configuration: 'تنظیمات اتصال به امضامی کامل نیست.',
    collaborator_required: 'نام، شماره همراه و کد ملی مشتری باید در پرونده تکمیل شود.',
    collaborator_invalid: 'فرمت شماره همراه یا کد ملی مشتری معتبر نیست. شماره همراه باید با ۰۹ و کد ملی شامل ۱۰ رقم باشد.',
    artifact_integrity: 'فایل قرارداد معتبر نیست. قرارداد را دوباره صادر کنید.',
    certificate_inactive: CERTIFICATE_INACTIVE_MESSAGE,
    provider_auth_failed: 'ورود CRM به سرویس امضامی ناموفق بود. نام کاربری یا رمز سرویس باید بررسی شود.',
    provider_certificate_check_failed: 'امضامی نتوانست وضعیت گواهی مشتری را بررسی کند.',
    provider_file_upload_failed: 'آپلود فایل PDF قرارداد در امضامی ناموفق بود.',
    provider_contract_send_failed: 'فایل آپلود شد، اما ثبت و ارسال قرارداد در امضامی ناموفق بود.',
    provider_state_persist_failed: 'قرارداد در امضامی ثبت شد، اما ذخیره نتیجه در CRM انجام نشد. همان قرارداد را دوباره ارسال کنید.',
    contract_generation_not_linkable: 'قرارداد ارسال‌شده هنوز در CRM نهایی نشده و قابل اتصال به پرونده نیست.',
    provider_timeout: 'سرویس امضامی در زمان مقرر پاسخ نداد.',
    provider_unavailable: 'ارتباط شبکه با سرویس امضامی برقرار نشد.',
    provider_delivery_failed: 'ارسال به امضامی انجام نشد. کمی بعد دوباره تلاش کنید.',
    document_generation_failed: 'تولید فایل قرارداد انجام نشد. قالب Word و اطلاعات واردشده را بررسی کنید.',
    invalid_contract_template: 'قالب Word قابل پردازش نیست. علامت‌های متغیر یا ساختار فایل را بررسی کنید.',
    pdf_conversion_failed: 'فایل Word ساخته شد، اما تبدیل آن به PDF انجام نشد.',
    formula_value_invalid: 'مقدار یکی از فیلدهای فرمولی طرح عددی یا قابل محاسبه نیست. مدت اقساط و درصدهای طرح را بررسی کنید.',
    conversion_queue_full: 'سامانه در حال تبدیل چند قرارداد است. کمی بعد دوباره تلاش کنید.',
    'Template not found': 'قالب قرارداد پیدا نشد یا قبلاً حذف شده است.',
    'Generation not found': 'قرارداد صادرشده پیدا نشد.',
    'PDF is not available': 'نسخه PDF این قرارداد هنوز آماده نیست.',
    'Generation is already being sent': 'این قرارداد در حال ارسال برای امضاست. کمی صبر کنید.',
    'Contract has not been sent': 'این قرارداد هنوز برای امضای دیجیتال ارسال نشده است.',
    provider_status_failed: 'دریافت وضعیت قرارداد از امضامی انجام نشد. کمی بعد دوباره تلاش کنید.',
  };
  const payload = err?.data ?? err?.response?.data;
  const responseError = payload?.error;
  if (typeof payload?.message === 'string' && /[\u0600-\u06FF]/.test(payload.message)) return payload.message;
  if (typeof responseError === 'string') {
    if (providerMessages[responseError]) return providerMessages[responseError];
    if (/[\u0600-\u06FF]/.test(responseError)) return responseError;
  }
  if (typeof err?.message === 'string' && /[\u0600-\u06FF]/.test(err.message)) return err.message;
  return defaultMsg;
};

const formatProviderStatus = (status?: string | null) => {
  if (!status) return 'وضعیت نامشخص';
  const normalized = status.toLowerCase().replace(/[\s_\-\u200c]+/g, '');
  const classification = classifyProviderStatus(status);
  if (classification === 'signed') return 'امضا تکمیل شده';
  if (classification === 'pending') return 'در انتظار امضا';
  if (providerReportsRejected(status)) return 'رد شده';
  if (classification === 'negative' && ['cancelled', 'canceled'].some(value => normalized.includes(value))) return 'لغو شده';
  if (classification === 'negative' && normalized.includes('expired')) return 'منقضی شده';
  return status;
};

const providerStatusIsSigned = (status?: string | null) => {
  return providerReportsSigned(status);
};

const formatStatus = (status?: string, providerStatus?: string | null) => {
  if (typeof providerStatus === 'string' && providerStatus.trim()) {
    const providerClassification = classifyProviderStatus(providerStatus);
    if (providerClassification === 'signed') return 'امضا شده';
    if (providerClassification === 'pending') return 'در انتظار امضا';
    if (providerClassification === 'negative') return formatProviderStatus(providerStatus);
    return providerStatus;
  }
  if (status === 'signed') return 'امضا شده';
  switch (status) {
    case 'generated': return 'صادر شده';
    case 'sending': return 'در حال ارسال';
    case 'sent': return 'ارسال شده';
    case 'failed': return 'خطا در ارسال';
    default: return status || 'نامشخص';
  }
};

const getStatusStyle = (status?: string, providerStatus?: string | null) => {
  if (typeof providerStatus === 'string' && providerStatus.trim()) {
    switch (classifyProviderStatus(providerStatus)) {
      case 'signed': return 'status-active';
      case 'pending': return 'status-new';
      case 'negative': return 'status-failed';
      default: return 'status-muted';
    }
  }
  if (status === 'signed') return 'status-active';
  switch (status) {
    case 'sent': return 'status-active';
    case 'sending': return 'status-new';
    case 'generated': return 'status-new';
    case 'failed': return 'status-failed';
    default: return 'status-muted';
  }
};

const CONTRACT_STAGE_LABELS: Record<string, string> = {
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  funder_amendment_review: 'بررسی اصلاحیهٔ تأمین‌کننده',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
};

type ContractSignatureStatusResult = ContractSignatureStatus & SignatureStatusWorkflowOutcome & {
  readOnly?: boolean;
  providerStatusTitle?: string | null;
  kind?: string | null;
};

function ErrorModal({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} testId="error-modal">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: '#fff1f2', padding: 16, borderRadius: 12, border: '1px solid #fecdd3' }}>
        <AlertCircle size={24} color="#be123c" style={{ flexShrink: 0 }} />
        <div>
          <p style={{ color: '#9f1239', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{message}</p>
        </div>
      </div>
      <div className="form-footer" style={{ marginTop: 24, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose} style={{ color: '#be123c', borderColor: '#fecdd3', background: '#fff' }}>متوجه شدم</button>
      </div>
    </Modal>
  );
}

function ConfirmModal({ title, message, onConfirm, onClose, confirmText = 'تایید', danger = false, isPending = false }: { title: string; message: string; onConfirm: () => void; onClose: () => void; confirmText?: string; danger?: boolean; isPending?: boolean }) {
  return (
    <Modal title={title} onClose={onClose} testId="confirm-modal">
      <div style={{ padding: '8px 0 16px', fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
        {message}
      </div>
      <div className="form-footer" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={isPending}>انصراف</button>
        <button
          className="btn"
          style={danger ? { background: '#be123c', color: '#fff' } : { background: 'var(--nafiss-blue)', color: '#fff' }}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? 'در حال انجام...' : confirmText}
        </button>
      </div>
    </Modal>
  );
}

const checkCustomerField = (fieldKey: string | null | undefined, customer: any) => {
  if (!fieldKey || !customer) return { present: false };
  if (fieldKey === 'current.dateJalali') return { present: true };

  let actualKey = fieldKey;
  if (fieldKey.startsWith('customer.')) {
    actualKey = fieldKey.substring('customer.'.length);
  }

  const val = customer[actualKey];
  return { present: val !== null && val !== undefined && val !== '' };
};

const MANUAL_MAPPING = '$$MANUAL$$';
const PLAN_MAPPING_PREFIX = '$$PLAN$$:';
const mappingSource = (mapping: { customerField?: string | null; loanPlanField?: string | null }) =>
  mapping.loanPlanField ? `${PLAN_MAPPING_PREFIX}${mapping.loanPlanField}` : mapping.customerField ?? MANUAL_MAPPING;
const serializeMapping = (variable: string, source: string, label?: string) => ({
  variable,
  customerField: source === MANUAL_MAPPING || source.startsWith(PLAN_MAPPING_PREFIX) ? null : source,
  loanPlanField: source.startsWith(PLAN_MAPPING_PREFIX) ? source.slice(PLAN_MAPPING_PREFIX.length) : null,
  label: source === MANUAL_MAPPING ? (label?.trim() || variable) : variable,
});

function normalizedMapping(mapping: ContractMapping): ContractMapping {
  const sourceType = mapping.sourceType ?? (mapping.formula ? 'formula' : mapping.date ? 'date' : mapping.constantValue != null ? 'constant' : mapping.customerField ? 'customer' : mapping.loanPlanField ? 'loanPlan' : 'manual');
  return {
    ...mapping,
    sourceType,
    formula: mapping.formula?.tokens ? {
      tokens: mapping.formula.tokens.map((token) => token.type === 'operator'
        ? { ...token, value: token.value === '×' ? '*' : token.value === '÷' ? '/' : token.value }
        : token),
    } : mapping.formula,
  };
}

function isValidFormula(mapping: ContractMapping | undefined) {
  if (!mapping || mapping.sourceType !== 'formula' || !mapping.formula?.tokens?.length) return false;
  const tokens = mapping.formula.tokens;
  if (tokens.length < 3 || tokens.length % 2 === 0) return false;
  return tokens.every((token, index) => {
    const operand = index % 2 === 0;
    if (operand) return token.type === 'field' || (token.type === 'literal' && Number.isFinite(Number(token.value)));
    return token.type === 'operator' && ['+', '-', '*', '/', '×', '÷'].includes(String(token.value));
  });
}

function hasInvalidFormula(mappings: ContractMapping[]) {
  return mappings.some((mapping) => mapping.sourceType === 'formula' && !isValidFormula(mapping));
}

function MappingEditor({ variables, customerFields, loanPlanFields, value, onChange }: {
  variables: string[];
  customerFields: Array<{ value: string; label: string }>;
  loanPlanFields: Array<{ value: string; label: string }>;
  value: ContractMapping[];
  onChange: (mappings: ContractMapping[]) => void;
}) {
  const update = (variable: string, patch: Partial<ContractMapping>) => onChange(variables.map((name) => {
    const current = normalizedMapping(value.find((mapping) => mapping.variable === name) ?? { variable: name, sourceType: 'manual' });
    return name === variable ? { ...current, ...patch } : current;
  }));
  const fields = [...customerFields.map((field) => ({ ...field, sourceType: 'customer' as const })), ...loanPlanFields.map((field) => ({ ...field, sourceType: 'loanPlan' as const }))];
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '50vh', overflowY: 'auto', paddingRight: 4 }}>
    <div style={{ fontSize: 11, color: '#64748b', background: '#f8fafc', padding: 8, borderRadius: 8 }}>
      فرمول به‌صورت یکی‌درمیان ساخته می‌شود: عدد یا فیلد، سپس عملگر (+، −، ×، ÷)، و دوباره عدد یا فیلد. برای افزودن جزء بعدی از کنترل «افزودن جزء فرمول» استفاده کنید.
    </div>
    {variables.map((variable) => {
      const mapping = normalizedMapping(value.find((item) => item.variable === variable) ?? { variable, sourceType: 'manual', label: variable });
      const sourceType = mapping.sourceType as ContractMappingSourceType;
      const tokens = mapping.formula?.tokens ?? [{ type: 'literal', value: '100' }, { type: 'operator', value: '-' }, { type: 'field', field: loanPlanFields[0]?.value ?? '' }];
      return <div key={variable} style={{ border: '1px solid #e2e8f0', padding: 12, borderRadius: 10 }}>
        <strong style={{ display: 'block', fontSize: 12, direction: 'ltr', color: 'var(--nafiss-blue)', marginBottom: 10 }}>%{variable}%</strong>
        <div className="field"><label>نوع متغیر</label><select value={sourceType} onChange={(event) => {
          const next = event.target.value as ContractMappingSourceType;
          const base: ContractMapping = { variable, sourceType: next, label: mapping.label || variable, customerField: null, loanPlanField: null, constantValue: null, formula: null, date: null };
          if (next === 'customer') base.customerField = customerFields[0]?.value ?? null;
          if (next === 'loanPlan') base.loanPlanField = loanPlanFields[0]?.value ?? null;
          if (next === 'constant') base.constantValue = '';
          if (next === 'formula') base.formula = { tokens };
          if (next === 'date') base.date = { mode: 'contract_date' };
          onChange(variables.map((item) => item === variable ? base : normalizedMapping(value.find((candidate) => candidate.variable === item) ?? { variable: item, sourceType: 'manual' })));
        }}>
          <option value="customer">اطلاعات مشتری</option><option value="loanPlan">اطلاعات طرح تسهیلات</option><option value="manual">ورودی دستی هنگام صدور</option><option value="constant">متن ثابت</option><option value="formula">فرمول محاسباتی</option><option value="date">تاریخ قرارداد</option><option value="contractNumber">شماره قرارداد خودکار</option>
        </select></div>
        {sourceType === 'contractNumber' && <div style={{ fontSize: 11, color: '#475569', background: '#f8fafc', padding: 10, borderRadius: 8 }}>شماره به‌صورت سال شمسی + ماه + شمارنده ماهانه از ۱۰۰۱ ساخته می‌شود؛ مانند 1405071001.</div>}
        {sourceType === 'customer' && <div className="field"><label>فیلد مشتری</label><select value={mapping.customerField ?? ''} onChange={(event) => update(variable, { customerField: event.target.value, loanPlanField: null })}>{customerFields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select></div>}
        {sourceType === 'loanPlan' && <div className="field"><label>فیلد طرح</label><select value={mapping.loanPlanField ?? ''} onChange={(event) => update(variable, { loanPlanField: event.target.value, customerField: null })}>{loanPlanFields.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select></div>}
        {sourceType === 'manual' && <div className="field"><label>عنوان ورودی</label><input value={mapping.label ?? variable} onChange={(event) => update(variable, { label: event.target.value })} /></div>}
        {sourceType === 'constant' && <div className="field"><label>متن ثابت</label><textarea value={mapping.constantValue ?? ''} onChange={(event) => update(variable, { constantValue: event.target.value })} required /></div>}
        {sourceType === 'date' && <div className="form-grid"><div className="field"><label>مبنای تاریخ</label><select value={mapping.date?.mode ?? 'contract_date'} onChange={(event) => update(variable, { date: { mode: event.target.value as 'contract_date' | 'contract_date_plus_days', offsetDays: mapping.date?.offsetDays } })}><option value="contract_date">روز قرارداد</option><option value="contract_date_plus_days">روز قرارداد + تعداد روز</option></select></div>{mapping.date?.mode === 'contract_date_plus_days' && <div className="field"><label>تعداد روز</label><input type="number" min="0" step="1" value={mapping.date.offsetDays ?? 0} onChange={(event) => update(variable, { date: { mode: 'contract_date_plus_days', offsetDays: Number(event.target.value) } })} /></div>}</div>}
        {sourceType === 'formula' && <div style={{ display: 'grid', gap: 8 }}>{tokens.map((token, index) => {
          const operand = index % 2 === 0;
          return <div key={index} style={{ display: 'flex', gap: 6 }}>
            {operand ? <select value={token.type === 'field' ? 'field' : 'literal'} onChange={(event) => {
              const next = [...tokens];
              next[index] = event.target.value === 'field'
                ? { type: 'field', field: loanPlanFields[0]?.value ?? customerFields[0]?.value ?? '' }
                : { type: 'literal', value: '0' };
              update(variable, { formula: { tokens: next } });
            }}><option value="literal">عدد</option><option value="field">فیلد</option></select> : <strong style={{ minWidth: 54, alignSelf: 'center' }}>عملگر</strong>}
            {token.type === 'field' ? <select value={token.field ?? ''} onChange={(event) => {
              const next = [...tokens];
              next[index] = { type: 'field', field: event.target.value };
              update(variable, { formula: { tokens: next } });
            }}>{fields.map((field) => <option key={`${field.sourceType}-${field.value}`} value={field.value}>{field.sourceType === 'customer' ? 'مشتری — ' : 'طرح — '}{field.label}</option>)}</select> : operand ? <input value={String(token.value ?? '')} onChange={(event) => {
              const next = [...tokens];
              next[index] = { type: 'literal', value: event.target.value };
              update(variable, { formula: { tokens: next } });
            }} placeholder="عدد" /> : <select value={String(token.value ?? '+')} onChange={(event) => {
              const next = [...tokens];
              next[index] = { type: 'operator', value: event.target.value };
              update(variable, { formula: { tokens: next } });
            }}><option value="+">+</option><option value="-">−</option><option value="*">×</option><option value="/">÷</option></select>}
            {tokens.length > 3 && index === tokens.length - 1 && <button type="button" className="btn btn-ghost" onClick={() => update(variable, { formula: { tokens: tokens.slice(0, -2) } })}>حذف جفت آخر</button>}
          </div>;
        })}<button type="button" className="btn btn-ghost" onClick={() => update(variable, { formula: { tokens: [...tokens, { type: 'operator', value: '+' }, { type: 'field', field: loanPlanFields[0]?.value ?? customerFields[0]?.value ?? '' }] } })}>افزودن عملگر و مقدار</button></div>}
      </div>;
    })}
  </div>;
}

export default function Contracts() {
  const queryClient = useQueryClient();
  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const canManage = user?.role === 'admin' || user?.permissions?.includes('contracts.manage');
  const canGenerate = user?.role === 'admin' || user?.permissions?.includes('contracts.generate');
  const canSend = user?.role === 'admin' || user?.permissions?.includes('contracts.send');

  const [activeTab, setActiveTab] = useTableState<'generations' | 'templates'>('contracts.tab', 'generations');
  const [templateWizardOpen, setTemplateWizardOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ContractTemplate | null>(null);
  const [generationWizardOpen, setGenerationWizardOpen] = useState<ContractTemplate | null>(null);

  const [errorDialog, setErrorDialog] = useState<{title: string, message: string} | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ContractTemplate | null>(null);
  const [generationDeleteConfirm, setGenerationDeleteConfirm] = useState<ContractGeneration | null>(null);
  const [signatureStatusDialog, setSignatureStatusDialog] = useState<ContractSignatureStatusResult | null>(null);

  const { data: templates, isLoading: loadingTemplates } = useListContractTemplates({
    query: { queryKey: getListContractTemplatesQueryKey() },
  });

  const { data: generations, isLoading: loadingGenerations } = useListContractGenerations({
    query: { queryKey: getListContractGenerationsQueryKey() },
  });

  const { data: customersData } = useListCustomers({ limit: 100 }, {
    query: { queryKey: getListCustomersQueryKey({ limit: 100 }) }
  });
  const customersMap = useMemo(() => {
    const map = new Map<number, Customer>();
    if (customersData?.items) {
      customersData.items.forEach(c => map.set(c.id, c));
    }
    return map;
  }, [customersData]);

  const { toast } = useToast();

  const removeTemplate = useDeleteContractTemplate({
    mutation: {
      onSuccess: () => {
        toast({ title: 'قالب حذف شد', description: 'قالب از فهرست صدور قرارداد کنار گذاشته شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractTemplatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        setDeleteConfirm(null);
      },
      onError: (err: any) => {
        setDeleteConfirm(null);
        setErrorDialog({ title: 'خطا در حذف', message: getErrorMessage(err, 'حذف قالب انجام نشد.') });
      },
    },
  });

  const removeGeneration = useDeleteContractGeneration({
    mutation: {
      onSuccess: () => {
        toast({ title: 'قرارداد حذف شد', description: 'قرارداد از فهرست قراردادهای صادرشده حذف شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        setGenerationDeleteConfirm(null);
      },
      onError: (err: any) => {
        setGenerationDeleteConfirm(null);
        setErrorDialog({ title: 'خطا در حذف', message: getErrorMessage(err, 'حذف قرارداد انجام نشد.') });
      },
    },
  });

  const handleDownloadTemplate = async (id: number, name: string) => {
    try {
      const blob = await downloadContractTemplate(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = name.replace(/[^a-zA-Z0-9\u0600-\u06FF\s-_]/g, '_');
      a.download = `${safeName || 'template'}.docx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setErrorDialog({ title: 'خطا در دانلود', message: getErrorMessage(err, 'دریافت فایل قالب با مشکل روبه‌رو شد.') });
    }
  };

  const handleDownloadGeneration = async (id: number, type: 'docx' | 'pdf') => {
    try {
      const blob = await downloadContractGeneration(id, type);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contract-${id}.${type}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setErrorDialog({ title: 'خطا در دانلود', message: getErrorMessage(err, 'دریافت فایل قرارداد با مشکل روبه‌رو شد.') });
    }
  };

  const handleDeleteTemplate = (template: ContractTemplate) => {
    setDeleteConfirm(template);
  };

  return (
    <>
      <div className="page-intro">
        <div>
          <h2>مدیریت قراردادها</h2>
          <p>اسناد حقوقی و قراردادهای مشتریان</p>
        </div>
      </div>

      <div className="toolbar" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 10, width: '100%', alignItems: 'center' }}>
          <div className="segmented-tabs" style={{ display: 'flex', background: '#f1f5f9', padding: 4, borderRadius: 12 }}>
            <button
              className={`btn ${activeTab === 'generations' ? 'active' : ''}`}
              style={{ minHeight: 34, background: activeTab === 'generations' ? '#fff' : 'transparent', color: activeTab === 'generations' ? 'var(--nafiss-blue)' : '#64748b', boxShadow: activeTab === 'generations' ? '0 2px 8px rgba(0,0,0,0.05)' : 'none' }}
              onClick={() => setActiveTab('generations')}
            >
              <FileText size={14} /> قراردادهای صادر شده
            </button>
            <button
              className={`btn ${activeTab === 'templates' ? 'active' : ''}`}
              style={{ minHeight: 34, background: activeTab === 'templates' ? '#fff' : 'transparent', color: activeTab === 'templates' ? 'var(--nafiss-blue)' : '#64748b', boxShadow: activeTab === 'templates' ? '0 2px 8px rgba(0,0,0,0.05)' : 'none' }}
              onClick={() => setActiveTab('templates')}
            >
              <FileSignature size={14} /> قالب‌های قرارداد
            </button>
          </div>
          {activeTab === 'templates' && canManage && (
            <button className="btn btn-primary" onClick={() => setTemplateWizardOpen(true)} style={{ marginRight: 'auto' }}>
              <Plus size={16} /> تعریف قرارداد جدید
            </button>
          )}
        </div>
      </div>

      {activeTab === 'templates' ? (
        loadingTemplates ? (
          <SkeletonPanel rows={4} />
        ) : templates?.length ? (
          <div className="customer-table-wrap">
            <table className="customer-table">
              <thead>
                <tr>
                  <th>شناسه</th>
                  <th>نام قالب</th>
                  <th>تعداد متغیرها</th>
                  <th>عملیات</th>
                </tr>
              </thead>
              <tbody>
                {templates.map(tpl => (
                  <tr key={tpl.id}>
                    <td>
                      <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>#{tpl.id}</span>
                    </td>
                    <td><strong className="customer-name">{tpl.name}</strong></td>
                    <td>
                      <span style={{ background: '#f1f5f9', color: '#475569', padding: '4px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600 }}>
                        {tpl.variables?.length ?? 0} متغیر
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {canGenerate && (
                          <button
                            className="btn btn-primary"
                            style={{ minHeight: 30, fontSize: 11, padding: '0 10px' }}
                            onClick={() => setGenerationWizardOpen(tpl)}
                          >
                            <FileSignature size={14} /> صدور قرارداد
                          </button>
                        )}
                        <button
                          className="btn btn-ghost"
                          style={{ minHeight: 30, fontSize: 11, padding: '0 10px' }}
                          onClick={() => tpl.id && handleDownloadTemplate(tpl.id, tpl.name)}
                        >
                          <Download size={14} /> دانلود DOCX
                        </button>
                        {canManage && (
                          <>
                            <button
                              className="btn btn-ghost"
                              style={{ minHeight: 30, fontSize: 11, padding: '0 10px' }}
                              onClick={() => setEditingTemplate(tpl)}
                            >
                              <Pencil size={14} /> ویرایش
                            </button>
                            <button
                              className="btn btn-ghost"
                              style={{ minHeight: 30, fontSize: 11, padding: '0 10px', color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }}
                              onClick={() => handleDeleteTemplate(tpl)}
                            >
                              <Trash2 size={14} /> حذف
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div style={{ background: '#f8fafc', width: 64, height: 64, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: '#94a3b8' }}>
              <FileSignature size={32} />
            </div>
            <strong>قالبی یافت نشد</strong>
            <p>هیچ قالب قراردادی در سیستم ثبت نشده است.</p>
            {canManage && (
              <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setTemplateWizardOpen(true)}>
                <Plus size={16} /> تعریف قرارداد جدید
              </button>
            )}
          </div>
        )
      ) : (
        loadingGenerations ? (
          <SkeletonPanel rows={5} />
        ) : generations?.length ? (
          <div className="customer-table-wrap">
            <table className="customer-table">
              <thead>
                <tr>
                  <th>شناسه صدور</th>
                  <th>مشتری</th>
                  <th>قالب</th>
                  <th>وضعیت</th>
                  <th>وضعیت امضا</th>
                  <th>عملیات</th>
                </tr>
              </thead>
              <tbody>
                {generations.map(gen => {
                  const customer = gen.customerId ? customersMap.get(gen.customerId) : null;
                  const generationCustomer = gen as ContractGeneration & { customerName?: string | null; customerSalespersonName?: string | null };
                  const tpl = templates?.find(t => t.id === gen.templateId);
                  
                  return (
                    <tr key={gen.id}>
                      <td>
                        <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>#{gen.id}</span>
                      </td>
                      <td>
                        {customer || generationCustomer.customerName ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <strong className="customer-name">{generationCustomer.customerName || customer?.name}</strong>
                            <span style={{ fontSize: 11, color: '#64748b' }}>کارشناس فروش: {generationCustomer.customerSalespersonName || customer?.salespersonName || 'بدون تخصیص'}</span>
                            {customer?.phone && <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'var(--font-mono)' }} dir="ltr">{customer.phone}</span>}
                          </div>
                        ) : (
                          'مشتری ' + gen.customerId
                        )}
                      </td>
                      <td>
                        <span style={{ color: '#475569', fontSize: 12, fontWeight: 500 }}>
                          {gen.templateName || tpl?.name || 'نامشخص'}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${getStatusStyle(gen.status, gen.providerStatus)}`}>
                          {formatStatus(gen.status, gen.providerStatus)}
                        </span>
                      </td>
                      <td>
                        {gen.providerContractId ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
                            <span style={{ fontSize: 11, color: '#0f766e', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, background: '#ccfbf1', padding: '4px 8px', borderRadius: 6, width: 'fit-content' }}>
                              <CheckCircle2 size={12} /> شناسه: <span style={{ fontFamily: 'var(--font-mono)' }}>{gen.providerContractId}</span>
                            </span>
                            {gen.providerStatus && (
                              <span style={{ fontSize: 11, color: '#475569' }}>{formatProviderStatus(gen.providerStatus)}</span>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>بدون امضای دیجیتال</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {gen.id && (
                            <button
                              className="btn btn-ghost"
                              style={{ minHeight: 30, fontSize: 11, padding: '0 10px' }}
                              onClick={() => handleDownloadGeneration(gen.id!, 'docx')}
                            >
                              <Download size={14} /> DOCX
                            </button>
                          )}
                          {gen.id && gen.pdfUrl && (
                            <button
                              className="btn btn-ghost"
                              style={{ minHeight: 30, fontSize: 11, padding: '0 10px' }}
                              onClick={() => handleDownloadGeneration(gen.id!, 'pdf')}
                            >
                              <Download size={14} /> PDF
                            </button>
                          )}
                          {gen.id && canSend && (
                            <SendContractButton generation={gen} onError={(title, msg) => setErrorDialog({ title, message: msg })} />
                          )}
                          {gen.id && gen.providerContractId && (
                            <CheckSignatureStatusButton
                              generationId={gen.id}
                              applicationId={gen.loanApplicationId}
                              readOnly={user?.role === 'salesperson'}
                              onSuccess={setSignatureStatusDialog}
                              onError={(title, msg) => setErrorDialog({ title, message: msg })}
                            />
                          )}
                          {gen.id && canManage && (
                            <button
                              className="btn btn-ghost"
                              style={{ minHeight: 30, fontSize: 11, padding: '0 10px', color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }}
                              onClick={() => setGenerationDeleteConfirm(gen)}
                            >
                              <Trash2 size={14} /> حذف
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div style={{ background: '#f8fafc', width: 64, height: 64, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: '#94a3b8' }}>
              <FileText size={32} />
            </div>
            <strong>قراردادی صادر نشده است</strong>
            <p>تا کنون هیچ قراردادی برای مشتریان صادر نشده است.</p>
          </div>
        )
      )}

      {templateWizardOpen && (
        <TemplateWizard onClose={() => setTemplateWizardOpen(false)} onError={(title, msg) => setErrorDialog({ title, message: msg })} />
      )}

      {editingTemplate && (
        <EditTemplateWizard template={editingTemplate} onClose={() => setEditingTemplate(null)} onError={(title, msg) => setErrorDialog({ title, message: msg })} />
      )}

      {generationWizardOpen && (
        <GenerationWizard template={generationWizardOpen} onClose={() => setGenerationWizardOpen(null)} onError={(title, msg) => setErrorDialog({ title, message: msg })} />
      )}

      {errorDialog && (
        <ErrorModal
          title={errorDialog.title}
          message={errorDialog.message}
          onClose={() => setErrorDialog(null)}
        />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title="حذف قالب قرارداد"
          message={`آیا از حذف قالب «${deleteConfirm.name}» اطمینان دارید؟ قراردادهای صادرشده قبلی حفظ می‌شوند.`}
          danger
          isPending={removeTemplate.isPending}
          confirmText="حذف قالب"
          onClose={() => setDeleteConfirm(null)}
          onConfirm={() => removeTemplate.mutate({ id: deleteConfirm.id! })}
        />
      )}

      {generationDeleteConfirm && (
        <ConfirmModal
          title="حذف قرارداد صادرشده"
          message={generationDeleteConfirm.providerContractId
            ? `قرارداد شماره ${generationDeleteConfirm.id} از فهرست CRM حذف می‌شود، اما قرارداد ارسال‌شده در امضامی لغو یا حذف نخواهد شد. ادامه می‌دهید؟`
            : `آیا از حذف قرارداد شماره ${generationDeleteConfirm.id} از فهرست CRM اطمینان دارید؟`}
          danger
          isPending={removeGeneration.isPending}
          confirmText="حذف قرارداد"
          onClose={() => setGenerationDeleteConfirm(null)}
          onConfirm={() => generationDeleteConfirm.id && removeGeneration.mutate({ id: generationDeleteConfirm.id })}
        />
      )}

      {signatureStatusDialog && (
        <Modal title="وضعیت امضای قرارداد" onClose={() => setSignatureStatusDialog(null)} testId="signature-status-modal">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: signatureStatusDialog.signed ? '#ecfdf5' : '#eff6ff', padding: 16, borderRadius: 12, border: `1px solid ${signatureStatusDialog.signed ? '#a7f3d0' : '#bfdbfe'}` }}>
            {signatureStatusDialog.signed
              ? <CheckCircle2 size={24} color="#047857" style={{ flexShrink: 0 }} />
              : <RefreshCw size={24} color="#1d4ed8" style={{ flexShrink: 0 }} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <strong style={{ color: signatureStatusDialog.signed ? '#047857' : '#1e40af' }}>
                {signatureStatusDialog.signed ? 'امضامی امضای قرارداد را تکمیل‌شده گزارش کرده است' : 'امضامی امضای قرارداد را تکمیل‌شده گزارش نکرده است'}
              </strong>
              <span style={{ color: '#475569', fontSize: 13 }}>
                وضعیت خام امضامی: <bdi dir="auto">{signatureStatusDialog.providerStatus ?? signatureStatusDialog.providerStatusTitle ?? 'در پاسخ گزارش نشده'}</bdi>
              </span>
            </div>
          </div>
          {signatureStatusDialog.workflowAdvanced && <p role="status" data-testid="status-contract-workflow-advanced" style={{ margin: '12px 0 0', color: '#047857', fontSize: 13 }}>
            پرونده به مرحلهٔ «{signatureStatusDialog.nextStage ? CONTRACT_STAGE_LABELS[signatureStatusDialog.nextStage] ?? signatureStatusDialog.nextStage : 'بعدی'}» منتقل شد.
          </p>}
          {signatureStatusDialog.readOnly && <p role="status" data-testid="status-contract-readonly-inquiry" style={{ margin: '12px 0 0', color: '#475569', fontSize: 12 }}>
            این استعلام فقط‌خواندنی بود؛ وضعیت ذخیره‌شده و مرحلهٔ پرونده تغییر نکرد.
          </p>}
          {signatureStatusDialog.signed && !signatureStatusDialog.workflowAdvanced && !signatureStatusDialog.readOnly && <p role="status" data-testid="status-contract-workflow-unchanged" style={{ margin: '12px 0 0', color: '#475569', fontSize: 12 }}>
            امضامی امضا را گزارش کرده است؛ در این استعلام گذار تازه‌ای در مرحلهٔ پرونده ثبت نشد.
          </p>}
          <p style={{ margin: '10px 0 0', color: '#64748b', fontSize: 12 }}>گزارش امضا به‌تنهایی به معنای تصویب مبلغ یا تأمین مالی نیست.</p>
          <div className="form-footer" style={{ marginTop: 24, justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setSignatureStatusDialog(null)}>بستن</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function TemplateWizard({ onClose, onError }: { onClose: () => void, onError: (title: string, msg: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { toast } = useToast();

  const analyze = useAnalyzeContractTemplate({
    mutation: {
      onError: (err: any) => {
        onError('خطا در تحلیل', getErrorMessage(err, 'فرمت فایل معتبر نیست.'));
      }
    }
  });

  const create = useCreateContractTemplate({
    mutation: {
      onSuccess: () => {
        toast({ title: 'قالب ذخیره شد', description: 'قالب قرارداد جدید با موفقیت ثبت شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractTemplatesQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        onError('خطا در ذخیره', getErrorMessage(err, 'ذخیره قالب با مشکل روبه‌رو شد.'));
      }
    }
  });

  const { data: customerFieldsData } = useGetContractCustomerFields();
  const customerFields = customerFieldsData?.fields ?? [];
  const loanPlanFields = customerFieldsData?.loanPlanFields ?? [];
  const [mappings, setMappings] = useState<ContractMapping[]>([]);
  useEffect(() => {
    if (analyze.data) setMappings(analyze.data.variables.map((variable) => ({ variable, sourceType: 'manual', label: variable })));
  }, [analyze.data]);

  const handleAnalyze = () => {
    if (!file) {
      onError('فایل انتخاب نشده', 'لطفاً یک فایل DOCX انتخاب کنید.');
      return;
    }
    analyze.mutate({ data: { file } });
  };

  const handleSave = () => {
    if (!name.trim()) {
      onError('نام قالب', 'لطفاً نام قالب را وارد کنید.');
      return;
    }
    if (!analyze.data) return;

    const missing = analyze.data.variables.filter(v => !mappings.find((mapping) => mapping.variable === v)?.sourceType);
    if (missing.length > 0) {
      onError('متغیرهای نامشخص', 'لطفاً تمام متغیرها را نگاشت کنید.');
      return;
    }
    if (hasInvalidFormula(mappings)) {
      onError('فرمول نامعتبر', 'فرمول باید با یک عدد یا فیلد شروع شود و به‌صورت یکی‌درمیان عملگر و عملوند داشته باشد.');
      return;
    }

    create.mutate({
      data: {
        name,
        uploadToken: analyze.data.uploadToken,
         mappings: mappings.map(normalizedMapping),
      }
    });
  };

  return (
    <Modal title="تعریف قالب قرارداد جدید" eyebrow="آپلود و تحلیل" onClose={onClose} testId="template-wizard">
      {!analyze.data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="field">
            <label>نام قالب</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="مثال: قرارداد مشاوره مالی..."
              maxLength={120}
            />
          </div>
          <div className="field">
            <label>فایل Word (DOCX)</label>
            <div style={{ border: '1px dashed #cbd5e1', padding: 20, borderRadius: 10, textAlign: 'center', background: '#f8fafc' }}>
              <input
                type="file"
                accept=".docx"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                style={{ display: 'block', width: '100%' }}
              />
              <p style={{ fontSize: 11, color: '#64748b', marginTop: 10, marginBottom: 0 }}>
                فرمت Word حفظ می‌شود. متغیرها را به صورت %variable% یا %%variable%% در فایل قرار دهید.
              </p>
            </div>
          </div>
          <div className="form-footer">
            <button
              className="btn btn-primary"
              onClick={handleAnalyze}
              disabled={analyze.isPending || !file}
            >
              {analyze.isPending ? 'در حال تحلیل...' : 'تحلیل فایل'}
            </button>
            <button className="btn btn-ghost" onClick={onClose} disabled={analyze.isPending}>
              انصراف
            </button>
          </div>
          {analyze.isError && (
            <div className="profile-form-error" style={{ marginTop: 14 }}>
              خطا در تحلیل فایل. مطمئن شوید فرمت فایل DOCX معتبر است.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: '#ecfdf5', color: '#065f46', padding: '12px 16px', borderRadius: 10, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={16} />
            تحلیل با موفقیت انجام شد. {analyze.data.variables.length} متغیر در فایل یافت شد.
          </div>
          
           <MappingEditor variables={analyze.data.variables} customerFields={customerFields} loanPlanFields={loanPlanFields} value={mappings} onChange={setMappings} />

          <div className="form-footer">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={create.isPending || hasInvalidFormula(mappings)}
            >
              {create.isPending ? 'در حال ذخیره...' : 'ذخیره قالب'}
            </button>
            <button className="btn btn-ghost" onClick={() => analyze.reset()} disabled={create.isPending}>
              آپلود فایل دیگر
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditTemplateWizard({ template, onClose, onError }: { template: ContractTemplate; onClose: () => void, onError: (title: string, msg: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(template.name);
  const [mappings, setMappings] = useState<ContractMapping[]>(() => (template.mappings ?? []).map(normalizedMapping));
  useEffect(() => {
    const variables = template.variables ?? [];
    setMappings((current) => variables.map((variable) => normalizedMapping(
      current.find((mapping) => mapping.variable === variable)
        ?? template.mappings?.find((mapping) => mapping.variable === variable)
        ?? { variable, sourceType: 'manual', label: variable },
    )));
  }, [template]);
  const { data: customerFieldsData } = useGetContractCustomerFields();
  const customerFields = customerFieldsData?.fields ?? [];
  const loanPlanFields = customerFieldsData?.loanPlanFields ?? [];
  const update = useUpdateContractTemplate({
    mutation: {
      onSuccess: () => {
        toast({ title: 'قالب ویرایش شد', description: 'نام و نگاشت متغیرهای قالب ذخیره شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractTemplatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        onError('خطا در ویرایش', getErrorMessage(err, 'ذخیره تغییرات قالب انجام نشد.'));
      },
    },
  });

  const handleSave = () => {
    if (!template.id || !name.trim()) {
      onError('نام قالب', 'لطفاً نام قالب را وارد کنید.');
      return;
    }
    const variables = template.variables ?? [];
    if (variables.some((variable) => !mappings.find((mapping) => mapping.variable === variable)?.sourceType)) {
      onError('متغیرهای نامشخص', 'لطفاً تمام متغیرها را نگاشت کنید.');
      return;
    }
    if (hasInvalidFormula(mappings)) {
      onError('فرمول نامعتبر', 'فرمول باید با یک عدد یا فیلد شروع شود و به‌صورت یکی‌درمیان عملگر و عملوند داشته باشد.');
      return;
    }
    update.mutate({
      id: template.id,
      data: {
        name: name.trim(),
         mappings: mappings.map(normalizedMapping),
      },
    });
  };

  return (
    <Modal title="ویرایش قالب قرارداد" eyebrow="نام و نگاشت متغیرها" onClose={onClose} testId="edit-template-wizard">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>نام قالب</label>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
        </div>
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: 12, borderRadius: 10, fontSize: 11, color: '#64748b' }}>
          برای تغییر فایل Word، قالب جدیدی تعریف کنید. این کار نسخه قراردادهای صادرشده را قابل ردیابی نگه می‌دارد.
        </div>
        <MappingEditor variables={template.variables ?? []} customerFields={customerFields} loanPlanFields={loanPlanFields} value={mappings} onChange={setMappings} />
        <div className="form-footer">
          <button className="btn btn-primary" onClick={handleSave} disabled={update.isPending || hasInvalidFormula(mappings)}>
            {update.isPending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}
          </button>
          <button className="btn btn-ghost" onClick={onClose} disabled={update.isPending}>انصراف</button>
        </div>
      </div>
    </Modal>
  );
}

function GenerationWizard({ template, onClose, onError }: { template: ContractTemplate; onClose: () => void, onError: (title: string, msg: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [loanPlanId, setLoanPlanId] = useState<number | ''>('');
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const { data: plansData, isLoading: loadingPlans } = useListLoanPlans({ active: true }, {
    query: { queryKey: getListLoanPlansQueryKey({ active: true }), staleTime: 30_000 },
  });
  const matchingPlans = (plansData ?? []).filter((plan) => plan.contractTemplateId === template.id);
  useEffect(() => {
    if (matchingPlans.length === 1) setLoanPlanId(matchingPlans[0].id);
    else if (!matchingPlans.some((plan) => plan.id === loanPlanId)) setLoanPlanId('');
  }, [template.id, matchingPlans.length, matchingPlans.map((plan) => plan.id).join(',')]);

  const { data: searchData, isFetching: searching } = useListCustomers(
    { search: debouncedSearch, limit: 10 },
    { query: { queryKey: getListCustomersQueryKey({ search: debouncedSearch, limit: 10 }), enabled: customerId === '' } }
  );

  const { data: customerData, isFetching: loadingCustomer } = useGetCustomer(Number(customerId), {
    query: { queryKey: getGetCustomerQueryKey(Number(customerId)), enabled: customerId !== '' }
  });

  const generate = useGenerateContract({
    mutation: {
      onSuccess: () => {
        toast({ title: 'قرارداد صادر شد', description: 'قرارداد با موفقیت تولید شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        onClose();
      },
      onError: (err: any) => {
        onError('خطا در صدور', getErrorMessage(err, 'صدور قرارداد با مشکل روبه‌رو شد.'));
      }
    }
  });

  const missingFields = useMemo(() => {
    if (!customerData || !template.mappings) return [];
    return template.mappings
      .filter(m => m.customerField != null)
      .filter(m => !checkCustomerField(m.customerField, customerData).present)
      .map(m => m.label || m.customerField!);
  }, [customerData, template.mappings]);

  const manualMappings = template.mappings?.filter(m => (m.sourceType ?? (!m.customerField && !m.loanPlanField ? 'manual' : 'customer')) === 'manual') ?? [];
  const autoMappings = template.mappings?.filter(m => (m.sourceType ?? (m.customerField ? 'customer' : m.loanPlanField ? 'loanPlan' : 'manual')) === 'customer') ?? [];

  const hasBlankManual = useMemo(() => {
    return manualMappings.some(m => !manualValues[m.variable]?.trim());
  }, [manualMappings, manualValues]);

  const handleGenerate = () => {
    if (customerId === '') return;
    if (loanPlanId === '') return;
    generate.mutate({
      data: {
        templateId: template.id!,
        customerId: Number(customerId),
        loanPlanId: Number(loanPlanId),
        manualValues
      }
    });
  };

  return (
    <Modal title="صدور قرارداد جدید" eyebrow={`قالب: ${template.name}`} onClose={onClose} testId="generation-wizard">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>طرح تسهیلاتی</label>
          {loadingPlans ? <span style={{ color: '#64748b', fontSize: 12 }}>در حال بارگذاری طرح‌ها...</span> : matchingPlans.length === 0 ? <span style={{ color: '#be123c', fontSize: 12 }}>هیچ طرح فعالی به این قالب قرارداد متصل نیست.</span> : <select value={loanPlanId} onChange={(event) => setLoanPlanId(event.target.value ? Number(event.target.value) : '')}><option value="">انتخاب طرح</option>{matchingPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select>}
        </div>
        {customerId === '' ? (
          <div className="field">
            <label>جستجو و انتخاب مشتری</label>
            <input 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
              placeholder="نام، شماره موبایل یا کدملی مشتری را جستجو کنید..." 
            />
            {searching && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>در حال جستجو...</div>}
            
            {searchData?.items && searchData.items.length > 0 && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: 'auto', background: '#fff' }}>
                {searchData.items.map(c => (
                  <div 
                    key={c.id} 
                    onClick={() => setCustomerId(c.id)}
                    style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}
                    className="hover-elevate"
                  >
                    <span><strong>{c.name}</strong><span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {c.salespersonName || 'بدون تخصیص'}</span></span>
                    <span dir="ltr" style={{ color: '#64748b' }}>{c.phone}</span>
                  </div>
                ))}
              </div>
            )}
            {debouncedSearch && searchData?.items?.length === 0 && !searching && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>مشتری یافت نشد.</div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', border: '1px solid #e2e8f0', padding: 12, borderRadius: 10 }}>
            <div>
               <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>مشتری انتخاب شده</div>
               {loadingCustomer ? (
                 <div style={{ fontSize: 12, fontWeight: 700 }}>در حال دریافت اطلاعات...</div>
               ) : (
                 <div style={{ fontSize: 12, fontWeight: 700 }}>{customerData?.name} - <span dir="ltr">{customerData?.phone}</span>
                   <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: '#64748b' }}>کارشناس فروش: {customerData?.salespersonName || 'بدون تخصیص'}</span>
                 </div>
               )}
            </div>
            <button className="btn btn-ghost" style={{ minHeight: 30, fontSize: 10 }} onClick={() => { setCustomerId(''); setManualValues({}); }}>تغییر مشتری</button>
          </div>
        )}

        {customerId !== '' && !loadingCustomer && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {autoMappings.length > 0 && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#f8fafc' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 10 }}>وضعیت فیلدهای سیستمی</div>
                {missingFields.length > 0 ? (
                  <div style={{ color: '#be123c', background: '#fff1f2', padding: 10, borderRadius: 8, fontSize: 11, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <strong>اطلاعات مشتری ناقص است:</strong>
                      <ul style={{ margin: '4px 0 0', paddingRight: 16 }}>
                        {missingFields.map(f => <li key={f}>{f}</li>)}
                      </ul>
                      <p style={{ margin: '4px 0 0' }}>لطفاً ابتدا پروفایل مشتری را تکمیل کنید.</p>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: '#0f766e', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={14} /> تمام اطلاعات سیستمی مورد نیاز در پروفایل مشتری موجود است.
                  </div>
                )}
              </div>
            )}

            {manualMappings.length > 0 && missingFields.length === 0 && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 10 }}>ورود اطلاعات دستی</div>
                <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                  {manualMappings.map(m => (
                    <div className="field" key={m.variable}>
                      <label>{m.label || m.variable}</label>
                      <input
                        value={manualValues[m.variable] || ''}
                        onChange={e => setManualValues({ ...manualValues, [m.variable]: e.target.value })}
                        placeholder="مقدار را وارد کنید"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {manualMappings.length === 0 && missingFields.length === 0 && (
              <div style={{ border: '1px dashed #cbd5e1', background: '#f8fafc', padding: 20, borderRadius: 10, textAlign: 'center', color: '#475569', fontSize: 12 }}>
                این قالب نیازی به ورود اطلاعات دستی ندارد. آماده صدور است.
              </div>
            )}

            <div className="form-footer">
              <button
                className="btn btn-primary"
                onClick={handleGenerate}
                disabled={generate.isPending || loadingPlans || loanPlanId === '' || matchingPlans.length === 0 || missingFields.length > 0 || hasBlankManual}
              >
                <FileSignature size={16} />
                {generate.isPending ? 'در حال صدور...' : 'صدور نهایی قرارداد'}
              </button>
              <button className="btn btn-ghost" onClick={onClose} disabled={generate.isPending}>
                انصراف
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SendContractButton({ generation, onError }: { generation: ContractGeneration, onError: (title: string, msg: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const send = useSendContractGeneration({
    mutation: {
      onSuccess: () => {
        toast({ title: 'ارسال شد', description: 'قرارداد جهت امضای دیجیتال ارسال شد.' });
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        if (generation.loanApplicationId) queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(generation.loanApplicationId) });
        setShowConfirm(false);
      },
      onError: (err: any) => {
        setShowConfirm(false);
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        onError('خطا در ارسال', getErrorMessage(err, 'مشکلی در ارتباط با سرویس امضای دیجیتال پیش آمد.'));
      }
    }
  });

  const isSigned = generation.status === 'signed' || providerStatusIsSigned(generation.providerStatus);
  const isRejected = generation.status === 'sent' && providerReportsRejected(generation.providerStatus) && !generation.supersededAt;
  const isSendingOrSent = isSigned || (generation.status === 'sent' && !isRejected) || generation.status === 'sending';
  const isFailed = generation.status === 'failed';
  const confirmSend = async () => {
    if (preparing || send.isPending) return;
    if (isRejected) {
      setPreparing(true);
      try {
        await prepareRejectedContractResend(generation.id!);
      } catch {
        setShowConfirm(false);
        onError('ارسال مجدد انجام نشد', 'وضعیت رد باید در امضامی تأیید شود و قرارداد همچنان قرارداد جاری و بدون امضای پرونده باشد. وضعیت را تازه‌سازی کنید.');
        await queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        return;
      } finally {
        setPreparing(false);
      }
    }
    send.mutate({ id: generation.id! });
  };

  return (
    <>
      <button
        className="btn btn-ghost"
        style={{ minHeight: 30, fontSize: 11, padding: '0 10px', background: isSendingOrSent ? '#f8fafc' : '#fff', color: isSendingOrSent ? '#94a3b8' : 'var(--nafiss-blue)', borderColor: isSendingOrSent ? '#e2e8f0' : 'var(--nafiss-light)' }}
        onClick={() => setShowConfirm(true)}
        disabled={isSendingOrSent || preparing || send.isPending || Boolean(generation.supersededAt)}
      >
        <Send size={14} />
        {isSigned ? 'امضا شده' : isRejected ? 'ارسال مجدد قرارداد ردشده' : isSendingOrSent ? 'ارسال شده' : isFailed ? 'تلاش مجدد ارسال' : 'ارسال برای امضا'}
      </button>

      {showConfirm && (
        <ConfirmModal
          title="ارسال قرارداد برای امضا"
          message={isRejected ? 'همان فایل قرارداد، بدون تغییر مبلغ یا مفاد، با یک درخواست امضای تازه ارسال می‌شود. شناسه و وضعیت ارسال ردشده در سوابق حفظ می‌شود. ارسال مجدد انجام شود؟' : 'آیا از ارسال این قرارداد برای امضای دیجیتال اطمینان دارید؟'}
          isPending={send.isPending || preparing}
          confirmText="بله، ارسال شود"
          onClose={() => setShowConfirm(false)}
          onConfirm={() => void confirmSend()}
        />
      )}
    </>
  );
}

function CheckSignatureStatusButton({ generationId, applicationId, readOnly, onSuccess, onError }: {
  generationId: number;
  applicationId?: number | null;
  readOnly: boolean;
  onSuccess: (status: ContractSignatureStatusResult) => void;
  onError: (title: string, msg: string) => void;
}) {
  const queryClient = useQueryClient();
  const checkStatus = useCheckContractSignatureStatus({
    mutation: {
      onSuccess: (status) => {
        const workflowResult = status as typeof status & SignatureStatusWorkflowOutcome;
        onSuccess(workflowResult);
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() });
        if (workflowResult.workflowAdvanced) {
          queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
          if (applicationId != null) {
            queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(applicationId) });
          }
        }
      },
      onError: (err: any) => {
        onError('خطا در بررسی وضعیت', getErrorMessage(err, 'دریافت وضعیت امضای قرارداد انجام نشد.'));
      },
    },
  });
  const readStatus = useMutation<ReadOnlySignatureStatus, unknown>({
    mutationFn: () => getContractSignatureStatus(generationId),
    onSuccess: (status) => onSuccess({ ...status, workflowAdvanced: false, nextStage: null, readOnly: true }),
    onError: (err: any) => onError('خطا در بررسی وضعیت', getErrorMessage(err, 'دریافت وضعیت امضای قرارداد انجام نشد.')),
  });
  const pending = readOnly ? readStatus.isPending : checkStatus.isPending;

  return (
    <button
      className="btn btn-ghost"
      style={{ minHeight: 30, fontSize: 11, padding: '0 10px', color: '#1d4ed8', borderColor: '#bfdbfe', background: '#eff6ff' }}
      onClick={() => readOnly ? readStatus.mutate() : checkStatus.mutate({ id: generationId })}
      disabled={pending}
    >
      <RefreshCw size={14} className={pending ? 'spin' : undefined} />
      {pending ? 'در حال بررسی...' : 'بررسی وضعیت امضا'}
    </button>
  );
}
