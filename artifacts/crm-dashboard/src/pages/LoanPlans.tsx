import { ArrowDown, ArrowUp, CheckCircle2, Edit3, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetLoanPlanQueryKey,
  getListConsultOptionsQueryKey,
  getListLoanPlansQueryKey,
  getListContractTemplatesQueryKey,
  useCreateLoanPlan,
  useGetLoanPlan,
  useListConsultOptions,
  useListLoanPlans,
  useListContractTemplates,
  useUpdateLoanPlan,
  type ConsultOption,
  type LoanPlan,
  type LoanPlanInput,
} from '@workspace/api-client-react';
import { ErrorState, formatDate, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Modal } from '@/components/DataTools';

const INSTALLMENT_OPTIONS = [6, 9, 12, 18, 24, 36, 48] as const;
type InstallmentOption = (typeof INSTALLMENT_OPTIONS)[number];
type PlanWithStatus = LoanPlan & { active?: boolean };

const COLLATERALS = [
  { value: 'none', label: 'بدون وثیقه' },
  { value: 'promissory', label: 'سفته' },
  { value: 'digital_check', label: 'چک دیجیتال' },
  { value: 'physical_check', label: 'چک فیزیکی' },
  { value: 'salary_deduction', label: 'کسر از حقوق' },
];

const GRANT_TIMES = [
  { value: 'under_7', label: 'زیر ۷ روز' },
  { value: '7_to_10', label: 'بین ۷ تا ۱۰ روز' },
  { value: '10_to_15', label: '۱۰ تا ۱۵ روز' },
];

const blankForm = {
  name: '',
  bankName: '',
  platformName: '',
  principalAmount: '',
  annualInterest: '',
  loanType: '',
  processMode: '',
  grantDays: '',
  notes: '',
  primaryContractTemplateId: '',
  invoiceTemplateId: '',
  acknowledgementTemplateId: '',
  active: true,
};

type BaseForm = typeof blankForm;
type InstallmentTermForm = {
  installments: InstallmentOption;
  prepaymentPercent: string;
  deductionPercent: string;
  depositPercent: string;
};
type ConditionForm = {
  maxPrincipal: string;
  installmentOptions: InstallmentOption[];
  customerRanks: string[];
  customerJobs: string[];
  collateralType: string;
  needsGuarantor: boolean;
  guarantorRanks: string[];
  guarantorJobs: string[];
  guarantorCollateralType: string;
  notes: string;
};

function optionsFor(options: ConsultOption[], fieldKey: string) {
  return options.filter((option) => option.fieldKey === fieldKey);
}

function parseStringArray(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(/[,،]/).map((item) => item.trim()).filter(Boolean);
  }
}

function parseLegacyInstallments(value: string | null | undefined): InstallmentOption[] {
  if (!value) return [];
  return value
    .split(/[,،/]/)
    .map((item) => Number(item.trim()))
    .filter((item): item is InstallmentOption => INSTALLMENT_OPTIONS.includes(item as InstallmentOption));
}

function labelsFor(values: string[], options: ConsultOption[]) {
  const labels = new Map(options.map((option) => [option.value, option.labelFa]));
  return values.map((value) => labels.get(value) ?? value);
}

function ChipChoices<T extends string | number>({
  values,
  selected,
  onChange,
  testId,
}: {
  values: Array<{ value: T; label: string }>;
  selected: T[];
  onChange: (values: T[]) => void;
  testId?: string;
}) {
  const toggle = (value: T) => {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };
  return <div className="chip-group" data-testid={testId}>
    {values.map((item) => <label className="checkbox-chip" key={String(item.value)}>
      <input type="checkbox" checked={selected.includes(item.value)} onChange={() => toggle(item.value)} />
      {item.label}
    </label>)}
  </div>;
}

function DictionarySelect({
  value,
  options,
  onChange,
  placeholder = 'انتخاب کنید',
  testId,
}: {
  value: string;
  options: ConsultOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId}>
    <option value="">{placeholder}</option>
    {options.map((option) => <option key={option.id} value={option.value}>{option.labelFa}</option>)}
  </select>;
}

function DictionaryChips({
  selected,
  options,
  onChange,
  testId,
}: {
  selected: string[];
  options: ConsultOption[];
  onChange: (values: string[]) => void;
  testId?: string;
}) {
  return <ChipChoices
    values={options.map((option) => ({ value: option.value, label: option.labelFa }))}
    selected={selected}
    onChange={onChange}
    testId={testId}
  />;
}

export default function LoanPlans() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<LoanPlan | null | undefined>(undefined);
  const params = filter === 'all' ? undefined : { active: filter === 'active' };
  const list = useListLoanPlans(params, { query: { queryKey: getListLoanPlansQueryKey(params), staleTime: 30_000 } });
  const detail = useGetLoanPlan(selectedId ?? 0, { query: { queryKey: getGetLoanPlanQueryKey(selectedId ?? 0), enabled: Boolean(selectedId) } });
  const create = useCreateLoanPlan();
  const update = useUpdateLoanPlan();
  const plans = list.data ?? [];
  const selected = detail.data ?? plans.find((plan) => plan.id === selectedId) ?? null;
  const save = (data: LoanPlanInput) => {
    if (editing?.id) {
      update.mutate({ id: editing.id, data }, { onSuccess: () => {
        setEditing(undefined);
        client.invalidateQueries({ queryKey: getListLoanPlansQueryKey() });
        client.invalidateQueries({ queryKey: getGetLoanPlanQueryKey(editing.id) });
      } });
    } else {
      create.mutate({ data }, { onSuccess: (created) => {
        setEditing(undefined);
        setSelectedId(created.id);
        client.invalidateQueries({ queryKey: getListLoanPlansQueryKey() });
      } });
    }
  };

  return <section className="data-page">
    <div className="page-intro">
      <div><div className="eyebrow">کاتالوگ تأمین مالی</div><h2>طرح‌های تسهیلاتی</h2><p>شرایط هر طرح را دقیق ببینید و نسخه فعال کاتالوگ را کنترل کنید.</p></div>
      <button className="btn btn-primary" onClick={() => setEditing(null)} data-testid="button-new-loan-plan"><Plus size={16} />طرح جدید</button>
    </div>
    <div className="filter-tabs" style={{ width: 'fit-content', marginBottom: 14 }}>
      <button className={`filter-tab ${filter === 'active' ? 'active' : ''}`} onClick={() => setFilter('active')}>فعال‌ها</button>
      <button className={`filter-tab ${filter === 'inactive' ? 'active' : ''}`} onClick={() => setFilter('inactive')}>غیرفعال‌ها</button>
      <button className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>همه طرح‌ها</button>
    </div>
    {list.isLoading ? <SkeletonPanel rows={5} /> : list.isError ? <ErrorState onRetry={() => list.refetch()} /> : <div className="plan-grid">
      <div className="plan-list">
        {plans.length ? plans.map((plan) => { const active = (plan as PlanWithStatus).active !== false; return <div className={`plan-card ${selectedId === plan.id ? 'selected' : ''}`} key={plan.id} onClick={() => setSelectedId(plan.id)} data-testid={`card-loan-plan-${plan.id}`}>
          <div className="plan-card-head"><div><h3>{plan.name}</h3><p>{plan.bankName || 'بانک مشخص نشده'}{plan.platformName ? ` · ${plan.platformName}` : ''}</p></div><span className={`inline-badge ${active ? 'active' : 'inactive'}`}>{active ? 'فعال' : 'غیرفعال'}</span></div>
          <div className="plan-facts"><div className="plan-fact">سقف تسهیلات<strong>{plan.principalAmount || '—'}</strong></div><div className="plan-fact">سود سالانه<strong>{plan.annualInterest || '—'}</strong></div><div className="plan-fact">اقساط<strong>{plan.installmentTerms?.map((term) => term.installments).join('، ') || plan.installments || '—'}</strong></div></div>
        </div>; }) : <div className="panel"><EmptyState title="طرحی در این فیلتر نیست" description="یک طرح تازه ایجاد کنید یا فیلتر را روی همه طرح‌ها بگذارید." /></div>}
      </div>
      <PlanDetail plan={selected} loading={Boolean(selectedId) && detail.isLoading} onEdit={() => selected && setEditing(selected)} />
    </div>}
    {editing !== undefined ? <PlanForm plan={editing} pending={create.isPending || update.isPending} onClose={() => setEditing(undefined)} onSave={save} /> : null}
  </section>;
}

function PlanDetail({ plan, loading, onEdit }: { plan: LoanPlan | null; loading: boolean; onEdit: () => void }) {
  const dictionaries = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 5 * 60_000 } });
  const options = dictionaries.data ?? [];
  if (loading) return <SkeletonPanel rows={4} />;
  if (!plan) return <div className="panel"><div className="empty-state"><ShieldCheck /><strong>یک طرح را انتخاب کنید</strong><p>جزئیات شروط و مدارک مورد نیاز در این بخش نمایش داده می‌شود.</p></div></div>;
  const documentOptions = optionsFor(options, 'required_document');
  return <div className="panel">
    <div className="panel-head"><div><div className="eyebrow">جزئیات طرح</div><h3>{plan.name}</h3><p>{plan.bankName || 'بانک مشخص نشده'} · آخرین ثبت {formatDate(plan.createdAt)}</p></div><button className="table-action" onClick={onEdit}><Edit3 size={13} />ویرایش</button></div>
    <div className="plan-facts"><div className="plan-fact">نوع تسهیلات<strong>{plan.loanType || '—'}</strong></div><div className="plan-fact">روش اجرا<strong>{plan.processMode || '—'}</strong></div><div className="plan-fact">زمان انجام<strong>{GRANT_TIMES.find((item) => item.value === plan.grantDays)?.label || plan.grantDays || '—'}</strong></div></div>
    {plan.installmentTerms?.length ? <section className="plan-detail-section"><h4>اقساط و درصدها</h4><div className="installment-terms-display">{plan.installmentTerms.map((term) => <div className="term-display-card" key={term.installments}><strong>{term.installments} قسط</strong><span>پیش‌پرداخت: {term.prepaymentPercent}٪</span><span>کسر از مشتری: {term.deductionPercent}٪</span><span>واریزی مشتری: {term.depositPercent}٪</span></div>)}</div></section> : null}
    {plan.requiredDocuments?.length ? <section className="plan-detail-section"><h4>مدارک مورد نیاز</h4><div className="docs-list">{labelsFor(plan.requiredDocuments, documentOptions).map((label) => <span className="doc-badge" key={label}>{label}</span>)}</div></section> : null}
    {plan.notes ? <section className="plan-detail-section"><h4>توضیحات</h4><p className="subtle-note">{plan.notes}</p></section> : null}
    <section className="plan-detail-section">
      <div className="panel-head"><div><h3>مسیرهای تأیید</h3><p>برآورده شدن حداقل یکی از شرایط برای تأیید کافی است.</p></div><CheckCircle2 size={18} color="#3f918a" /></div>
      <div className="condition-list">{plan.conditions?.length ? [...plan.conditions].sort((a, b) => a.sortOrder - b.sortOrder).map((condition, index) => {
        const customerRanks = labelsFor(parseStringArray(condition.customerRanks), optionsFor(options, 'credit_rank'));
        const guarantorRanks = labelsFor(parseStringArray(condition.guarantorRanks), optionsFor(options, 'guarantor_credit_rank'));
        const customerJobs = labelsFor(condition.customerJobs ?? [], optionsFor(options, 'job_type'));
        const guarantorJobs = labelsFor(condition.guarantorJobs ?? [], optionsFor(options, 'guarantor_job_type'));
        return <div className="condition-item" key={condition.id}>
          <strong>شرط {index + 1}</strong>
          <ul>
            {condition.maxPrincipal ? <li>سقف مبلغ: {condition.maxPrincipal}</li> : null}
            {condition.installmentOptions?.length ? <li>اقساط مجاز: {condition.installmentOptions.join('، ')}</li> : null}
            {customerRanks.length ? <li>رتبه مشتری: {customerRanks.join('، ')}</li> : null}
            {customerJobs.length ? <li>مشاغل مشتری: {customerJobs.join('، ')}</li> : null}
            <li>وثیقه مشتری: {COLLATERALS.find((item) => item.value === condition.collateralType)?.label || 'بدون وثیقه'}</li>
            <li>{condition.needsGuarantor ? 'ضامن لازم است' : 'ضامن لازم نیست'}</li>
            {condition.needsGuarantor && guarantorRanks.length ? <li>رتبه ضامن: {guarantorRanks.join('، ')}</li> : null}
            {condition.needsGuarantor && guarantorJobs.length ? <li>مشاغل ضامن: {guarantorJobs.join('، ')}</li> : null}
            {condition.needsGuarantor ? <li>وثیقه ضامن: {COLLATERALS.find((item) => item.value === condition.guarantorCollateralType)?.label || 'بدون وثیقه'}</li> : null}
            {condition.notes ? <li>توضیحات: {condition.notes}</li> : null}
          </ul>
        </div>;
      }) : <div className="subtle-note">شرطی ثبت نشده است.</div>}</div>
    </section>
  </div>;
}

function emptyCondition(): ConditionForm {
  return {
    maxPrincipal: '',
    installmentOptions: [],
    customerRanks: [],
    customerJobs: [],
    collateralType: 'none',
    needsGuarantor: false,
    guarantorRanks: [],
    guarantorJobs: [],
    guarantorCollateralType: 'none',
    notes: '',
  };
}

function PlanForm({ plan, pending, onClose, onSave }: { plan: LoanPlan | null; pending: boolean; onClose: () => void; onSave: (data: LoanPlanInput) => void }) {
  const dictionaries = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 5 * 60_000 } });
  const templatesReq = useListContractTemplates({ query: { queryKey: getListContractTemplatesQueryKey(), staleTime: 60_000 } });
  const options = dictionaries.data ?? [];
  const templates = templatesReq.data ?? [];
  const [form, setForm] = useState<BaseForm>(blankForm);
  const [terms, setTerms] = useState<InstallmentTermForm[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [conditions, setConditions] = useState<ConditionForm[]>([]);

  useEffect(() => {
    setForm(plan ? {
      name: plan.name,
      bankName: plan.bankName ?? '',
      platformName: plan.platformName ?? '',
      principalAmount: plan.principalAmount ?? '',
      annualInterest: plan.annualInterest ?? '',
      loanType: plan.loanType ?? '',
      processMode: plan.processMode ?? '',
      grantDays: plan.grantDays ?? '',
      notes: plan.notes ?? '',
      primaryContractTemplateId: plan.primaryContractTemplateId ? String(plan.primaryContractTemplateId) : '',
      invoiceTemplateId: plan.invoiceTemplateId ? String(plan.invoiceTemplateId) : '',
      acknowledgementTemplateId: plan.acknowledgementTemplateId ? String(plan.acknowledgementTemplateId) : '',
      active: (plan as PlanWithStatus).active !== false,
    } : blankForm);
    const currentTerms = plan?.installmentTerms?.length
      ? plan.installmentTerms.map((term) => ({
        installments: term.installments,
        prepaymentPercent: String(term.prepaymentPercent),
        deductionPercent: String(term.deductionPercent),
        depositPercent: String(term.depositPercent),
      }))
      : parseLegacyInstallments(plan?.installments).map((installments) => ({ installments, prepaymentPercent: '', deductionPercent: '', depositPercent: '' }));
    setTerms(currentTerms);
    setDocuments(plan?.requiredDocuments ?? []);
    setConditions((plan?.conditions ?? []).sort((a, b) => a.sortOrder - b.sortOrder).map((condition) => ({
      maxPrincipal: condition.maxPrincipal ?? '',
      installmentOptions: condition.installmentOptions ?? [],
      customerRanks: parseStringArray(condition.customerRanks),
      customerJobs: condition.customerJobs ?? [],
      collateralType: condition.collateralType ?? 'none',
      needsGuarantor: Boolean(condition.needsGuarantor),
      guarantorRanks: parseStringArray(condition.guarantorRanks),
      guarantorJobs: condition.guarantorJobs ?? [],
      guarantorCollateralType: condition.guarantorCollateralType ?? 'none',
      notes: condition.notes ?? '',
    })));
  }, [plan]);

  const selectedInstallments = terms.map((term) => term.installments);
  const updateSelectedInstallments = (selected: InstallmentOption[]) => {
    setTerms(selected.map((installments) => terms.find((term) => term.installments === installments) ?? { installments, prepaymentPercent: '', deductionPercent: '', depositPercent: '' }));
  };
  const updateTerm = (installments: InstallmentOption, key: keyof Omit<InstallmentTermForm, 'installments'>, value: string) => {
    setTerms((current) => current.map((term) => term.installments === installments ? { ...term, [key]: value } : term));
  };
  const updateCondition = <K extends keyof ConditionForm>(index: number, key: K, value: ConditionForm[K]) => {
    setConditions((current) => current.map((condition, conditionIndex) => conditionIndex === index ? { ...condition, [key]: value } : condition));
  };
  const moveCondition = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= conditions.length) return;
    setConditions((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    const legacy = plan ? {
      deductPercents: plan.deductPercents ?? undefined,
      customerRanks: plan.customerRanks ?? undefined,
      customerCheck: plan.customerCheck ?? undefined,
      needsCustomerPromissory: plan.needsCustomerPromissory,
      customerJobs: plan.customerJobs ?? undefined,
      needsGuarantor: plan.needsGuarantor,
      guarantorRanks: plan.guarantorRanks ?? undefined,
      guarantorCheck: plan.guarantorCheck ?? undefined,
      needsGuarantorPromissory: plan.needsGuarantorPromissory,
      guarantorJobs: plan.guarantorJobs ?? undefined,
      needsAccountTurnover: plan.needsAccountTurnover,
      needsAvgBalance: plan.needsAvgBalance,
      prepaymentPercents: plan.prepaymentPercents ?? undefined,
      depositPercents: plan.depositPercents ?? undefined,
      needsCustomerSalaryDeduct: plan.needsCustomerSalaryDeduct,
      needsGuarantorSalaryDeduct: plan.needsGuarantorSalaryDeduct,
    } : {};
    onSave({
      ...legacy,
      ...form,
      primaryContractTemplateId: form.primaryContractTemplateId ? Number(form.primaryContractTemplateId) : undefined,
      invoiceTemplateId: form.invoiceTemplateId ? Number(form.invoiceTemplateId) : undefined,
      acknowledgementTemplateId: form.acknowledgementTemplateId ? Number(form.acknowledgementTemplateId) : undefined,
      name: form.name.trim(),
      installments: selectedInstallments.join(','),
      installmentTerms: terms.map((term) => ({
        installments: term.installments,
        prepaymentPercent: Number(term.prepaymentPercent || 0),
        deductionPercent: Number(term.deductionPercent || 0),
        depositPercent: Number(term.depositPercent || 0),
      })),
      requiredDocuments: documents,
      conditions: conditions.map((condition, index) => ({
        maxPrincipal: condition.maxPrincipal,
        installmentOptions: condition.installmentOptions,
        customerRanks: condition.customerRanks,
        customerJobs: condition.customerJobs,
        collateralType: condition.collateralType,
        needsGuarantor: condition.needsGuarantor,
        guarantorRanks: condition.needsGuarantor ? condition.guarantorRanks : [],
        guarantorJobs: condition.needsGuarantor ? condition.guarantorJobs : [],
        guarantorCollateralType: condition.needsGuarantor ? condition.guarantorCollateralType : 'none',
        sortOrder: index,
        notes: condition.notes,
      })),
    });
  };

  return <Modal title={plan ? 'ویرایش طرح تسهیلاتی' : 'ایجاد طرح تسهیلاتی'} eyebrow="کاتالوگ تأمین مالی" onClose={onClose} testId="loan-plan-form">
    <form onSubmit={submit} className="loan-plan-form">
      <section className="loan-form-section">
        <div className="loan-form-section-title"><strong>اطلاعات پایه طرح</strong><span>مشخصات اصلی و نحوه اجرای تسهیلات</span></div>
        <div className="form-grid">
          <div className="field"><label>نام طرح</label><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required data-testid="input-plan-name" /></div>
          <div className="field"><label>بانک</label><input value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} /></div>
          <div className="field"><label>پلتفرم</label><input value={form.platformName} onChange={(event) => setForm({ ...form, platformName: event.target.value })} /></div>
          <div className="field"><label>سقف تسهیلات</label><input value={form.principalAmount} onChange={(event) => setForm({ ...form, principalAmount: event.target.value })} /></div>
          <div className="field"><label>سود سالانه</label><input value={form.annualInterest} onChange={(event) => setForm({ ...form, annualInterest: event.target.value })} /></div>
          <div className="field"><label>نوع تسهیلات</label><DictionarySelect value={form.loanType} options={optionsFor(options, 'loan_type')} onChange={(loanType) => setForm({ ...form, loanType })} /></div>
          <div className="field"><label>روش اجرا</label><DictionarySelect value={form.processMode} options={optionsFor(options, 'process_mode')} onChange={(processMode) => setForm({ ...form, processMode })} /></div>
          <div className="field"><label>مدت زمان انجام</label><select value={form.grantDays} onChange={(event) => setForm({ ...form, grantDays: event.target.value })} required><option value="">انتخاب کنید</option>{GRANT_TIMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <div className="field full"><label>تعداد اقساط</label><ChipChoices values={INSTALLMENT_OPTIONS.map((value) => ({ value, label: `${value} ماهه` }))} selected={selectedInstallments} onChange={updateSelectedInstallments} testId="installment-options" /></div>
          {terms.length ? <div className="field full"><label>درصدهای مربوط به هر تعداد اقساط</label><div className="installment-terms-list">{terms.map((term) => <div className="installment-term-row" key={term.installments}><strong>{term.installments} قسط</strong><div className="term-inputs"><label><span>پیش‌پرداخت</span><input type="number" min="0" max="100" step="0.01" value={term.prepaymentPercent} onChange={(event) => updateTerm(term.installments, 'prepaymentPercent', event.target.value)} required /></label><label><span>کسر از مشتری</span><input type="number" min="0" max="100" step="0.01" value={term.deductionPercent} onChange={(event) => updateTerm(term.installments, 'deductionPercent', event.target.value)} required /></label><label><span>واریزی به مشتری</span><input type="number" min="0" max="100" step="0.01" value={term.depositPercent} onChange={(event) => updateTerm(term.installments, 'depositPercent', event.target.value)} required /></label></div></div>)}</div></div> : null}
        </div>
      </section>

      <section className="loan-form-section">
        <div className="loan-form-section-title"><strong>مدارک و توضیحات</strong><span>مدارک لازم برای تشکیل پرونده</span></div>
        <div className="field full"><label>قالب قرارداد پایه</label><select value={form.primaryContractTemplateId} onChange={(e) => setForm({ ...form, primaryContractTemplateId: e.target.value })}><option value="">انتخاب کنید (بدون قرارداد پایه)</option>{templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select></div>
        <div className="field full"><label>قالب صورت‌حساب (Invoice)</label><select value={form.invoiceTemplateId} onChange={(e) => setForm({ ...form, invoiceTemplateId: e.target.value })}><option value="">انتخاب کنید (بدون صورت‌حساب)</option>{templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select></div>
        <div className="field full"><label>قالب رسید تسویه (Acknowledgement)</label><select value={form.acknowledgementTemplateId} onChange={(e) => setForm({ ...form, acknowledgementTemplateId: e.target.value })}><option value="">انتخاب کنید (بدون رسید)</option>{templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select></div>
        <div className="field"><label>لیست مدارک مورد نیاز</label><DictionaryChips selected={documents} options={optionsFor(options, 'required_document')} onChange={setDocuments} testId="required-documents" /></div>
        <div className="field"><label>توضیحات طرح</label><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} data-testid="textarea-plan-notes" /></div>
      </section>

      <section className="loan-form-section">
        <div className="loan-form-section-heading">
          <div className="loan-form-section-title"><strong>مسیرهای تأیید و شرایط دریافت</strong><span>هر شرط یک مسیر جایگزین برای دریافت تسهیلات است.</span></div>
          <button type="button" className="btn btn-ghost" onClick={() => setConditions((current) => [...current, emptyCondition()])} data-testid="button-add-condition"><Plus size={14} />افزودن شرط</button>
        </div>
        {conditions.length ? <div className="condition-form-list">{conditions.map((condition, index) => <div className="condition-card-form" key={index}>
          <div className="condition-card-header"><span>شرط {index + 1}</span><div className="condition-actions"><button type="button" onClick={() => moveCondition(index, -1)} disabled={index === 0} aria-label="انتقال به بالا"><ArrowUp size={14} /></button><button type="button" onClick={() => moveCondition(index, 1)} disabled={index === conditions.length - 1} aria-label="انتقال به پایین"><ArrowDown size={14} /></button><button type="button" onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="حذف شرط"><Trash2 size={14} /></button></div></div>
          <div className="form-grid">
            <div className="field"><label>سقف مبلغ تسهیلات</label><input value={condition.maxPrincipal} onChange={(event) => updateCondition(index, 'maxPrincipal', event.target.value)} /></div>
            <div className="field full"><label>تعداد اقساط مجاز</label><ChipChoices values={INSTALLMENT_OPTIONS.map((value) => ({ value, label: `${value} ماهه` }))} selected={condition.installmentOptions} onChange={(value) => updateCondition(index, 'installmentOptions', value)} /></div>
            <div className="field full"><label>رتبه‌های مجاز مشتری</label><DictionaryChips selected={condition.customerRanks} options={optionsFor(options, 'credit_rank')} onChange={(value) => updateCondition(index, 'customerRanks', value)} /></div>
            <div className="field full"><label>مشاغل مجاز مشتری</label><DictionaryChips selected={condition.customerJobs} options={optionsFor(options, 'job_type')} onChange={(value) => updateCondition(index, 'customerJobs', value)} /></div>
            <div className="field"><label>وثیقه مورد نیاز مشتری</label><select value={condition.collateralType} onChange={(event) => updateCondition(index, 'collateralType', event.target.value)}>{COLLATERALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
            <div className="field"><label>ضامن لازم دارد؟</label><select value={condition.needsGuarantor ? 'yes' : 'no'} onChange={(event) => updateCondition(index, 'needsGuarantor', event.target.value === 'yes')}><option value="no">خیر</option><option value="yes">بله</option></select></div>
          </div>
          {condition.needsGuarantor ? <div className="guarantor-section"><strong>شرایط ضامن</strong><div className="field"><label>رتبه‌های مجاز ضامن</label><DictionaryChips selected={condition.guarantorRanks} options={optionsFor(options, 'guarantor_credit_rank')} onChange={(value) => updateCondition(index, 'guarantorRanks', value)} /></div><div className="field"><label>مشاغل مجاز ضامن</label><DictionaryChips selected={condition.guarantorJobs} options={optionsFor(options, 'guarantor_job_type')} onChange={(value) => updateCondition(index, 'guarantorJobs', value)} /></div><div className="field"><label>وثیقه مورد نیاز ضامن</label><select value={condition.guarantorCollateralType} onChange={(event) => updateCondition(index, 'guarantorCollateralType', event.target.value)}>{COLLATERALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div> : null}
        </div>)}</div> : <div className="empty-state compact-empty"><p>هنوز شرطی تعریف نشده است. برای شروع «افزودن شرط» را انتخاب کنید.</p></div>}
      </section>

      <section className="loan-form-section plan-status-row"><label className="boolean-field"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />طرح در کاتالوگ فعال باشد</label></section>
      <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pending}>{pending ? 'در حال ذخیره…' : 'ذخیره طرح'}</button><button className="btn btn-ghost" type="button" onClick={onClose}>انصراف</button></div>
    </form>
  </Modal>;
}