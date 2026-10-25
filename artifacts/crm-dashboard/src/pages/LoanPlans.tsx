import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Edit3, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GradePickerMulti } from '@/components/grade/GradePicker';
import { GradeChipList } from '@/components/grade/GradeChip';
import { expandGradeList, legacyLettersIn, sortGrades, type GradeLetter } from '@/lib/credit-grade';
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
import { GoodsPlanSettingsFields, blankGoodsPlanForm, saveGoodsPlanSettings, type GoodsPlanForm } from '@/components/GoodsPlanSettingsFields';
import { api, errText, useMe } from '@/lib/goods-api';
import { ErrorState, formatDate, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Modal } from '@/components/DataTools';
import { CHECK_KIND_LABEL, encodeSide, NO_REQUIREMENTS, requirementsText, sideRequirements, type SideRequirements } from '@/lib/plan-requirements';
import { Choice, faDigits, formatToman, LockBadge, TomanInput, WizardProgress, YES_NO, yn } from '@/components/plans-consult/parts';

const INSTALLMENT_OPTIONS = [6, 9, 12, 18, 24, 36, 48] as const;
type InstallmentOption = (typeof INSTALLMENT_OPTIONS)[number];
type PlanWithStatus = LoanPlan & { active?: boolean };


const GRANT_TIMES = [
  { value: 'under_7', label: 'زیر ۷ روز' },
  { value: '7_to_10', label: 'بین ۷ تا ۱۰ روز' },
  { value: '10_to_15', label: '۱۰ تا ۱۵ روز' },
];

const blankForm = {
  name: '',
  filingFeeToman: '0',
  bankName: '',
  platformName: '',
  principalAmount: '',
  annualInterest: '',
  loanType: '',
  processMode: '',
  grantDays: '',
  notes: '',
  contractTemplateId: '',
  platformCompanyName: '',
  goodsStoreName: '',
  commissionPercent: '',
  operationCostsPercent: '',
  grantedDiscountPercent: '',
  purchaseCommissionPercent: '',
  salesCommissionPercent: '',
  loanAcquisitionFeePercent: '',
  penaltyMode: 'amount',
  penaltyValue: '',
  contractDurationDays: '',
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
  id?: number;
  maxPrincipal: string;
  installmentOptions: InstallmentOption[];
  customerRanks: string[];
  customerJobs: string[];
  /** crm-plans-consult: cheque / promissory / salary deduction, combinable (encoded to collateral_type + needs_* on save). */
  customer: SideRequirements;
  needsGuarantor: boolean;
  guarantorRanks: string[];
  guarantorJobs: string[];
  guarantor: SideRequirements;
  /** crm-no-plan-option: applicant must have military service done (women exempt). Off by default. */
  needsMilitaryService: boolean;
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
  const [filter, setFilter] = useTableState<'all' | 'active' | 'inactive'>('plans.filter', 'active');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<LoanPlan | null | undefined>(undefined);
  const params = filter === 'all' ? undefined : { active: filter === 'active' };
  const list = useListLoanPlans(params, { query: { queryKey: getListLoanPlansQueryKey(params), staleTime: 30_000 } });
  const detail = useGetLoanPlan(selectedId ?? 0, { query: { queryKey: getGetLoanPlanQueryKey(selectedId ?? 0), enabled: Boolean(selectedId) } });
  const create = useCreateLoanPlan();
  const update = useUpdateLoanPlan();
  const plans = list.data ?? [];
  const selected = detail.data ?? plans.find((plan) => plan.id === selectedId) ?? null;
  const { can } = useMe();
  const canGoodsFinance = can('goods_finance.manage');
  const [goodsError, setGoodsError] = useState('');
  const persistGoods = async (planId: number, data: LoanPlanInput, goods: GoodsPlanForm) => {
    if (data.loanType !== 'goods' || !canGoodsFinance) return true;
    try { await saveGoodsPlanSettings(planId, goods); client.invalidateQueries({ queryKey: ['goods-plan-settings', planId] }); setGoodsError(''); return true; }
    catch (e) { setGoodsError(`طرح ذخیره شد اما تنظیمات مالی خرید کالا ذخیره نشد: ${errText(e)}`); return false; }
  };
  const save = (data: LoanPlanInput, goods: GoodsPlanForm) => {
    if (editing?.id) {
      update.mutate({ id: editing.id, data }, { onSuccess: async () => {
        if (!(await persistGoods(editing.id, data, goods))) return;
        setEditing(undefined);
        client.invalidateQueries({ queryKey: getListLoanPlansQueryKey() });
        client.invalidateQueries({ queryKey: getGetLoanPlanQueryKey(editing.id) });
      } });
    } else {
      create.mutate({ data }, { onSuccess: async (created) => {
        setSelectedId(created.id);
        client.invalidateQueries({ queryKey: getListLoanPlansQueryKey() });
        if (!(await persistGoods(created.id, data, goods))) { setEditing(created); return; }
        setEditing(undefined);
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
          <div className="plan-facts"><div className="plan-fact">سقف تسهیلات<strong>{plan.principalAmount ? `${plan.principalAmount} تومان` : '—'}</strong></div><div className="plan-fact">سود سالانه<strong>{plan.annualInterest || '—'}</strong></div><div className="plan-fact">اقساط<strong>{plan.installmentTerms?.map((term) => term.installments).join('، ') || plan.installments || '—'}</strong></div></div>
        </div>; }) : <div className="panel"><EmptyState title="طرحی در این فیلتر نیست" description="یک طرح تازه ایجاد کنید یا فیلتر را روی همه طرح‌ها بگذارید." /></div>}
      </div>
      <PlanDetail plan={selected} loading={Boolean(selectedId) && detail.isLoading} onEdit={() => selected && setEditing(selected)} />
    </div>}
    {editing !== undefined ? <PlanForm plan={editing} pending={create.isPending || update.isPending} goodsError={goodsError || (create.isError || update.isError ? errText(create.error ?? update.error) : '')} canGoodsFinance={canGoodsFinance} onClose={() => { setEditing(undefined); setGoodsError(''); }} onSave={save} /> : null}
  </section>;
}

function PlanDetail({ plan, loading, onEdit }: { plan: LoanPlan | null; loading: boolean; onEdit: () => void }) {
  const dictionaries = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 5 * 60_000 } });
  const templatesReq = useListContractTemplates({ query: { queryKey: getListContractTemplatesQueryKey(), staleTime: 60_000 } });
  const options = dictionaries.data ?? [];
  if (loading) return <SkeletonPanel rows={4} />;
  if (!plan) return <div className="panel"><div className="empty-state"><ShieldCheck /><strong>یک طرح را انتخاب کنید</strong><p>جزئیات شروط و مدارک مورد نیاز در این بخش نمایش داده می‌شود.</p></div></div>;
  const documentOptions = optionsFor(options, 'required_document');
  return <div className="panel">
    <div className="panel-head"><div><div className="eyebrow">جزئیات طرح</div><h3>{plan.name}</h3><p>{plan.bankName || 'بانک مشخص نشده'} · آخرین ثبت {formatDate(plan.createdAt)}</p></div><button className="table-action" onClick={onEdit}><Edit3 size={13} />ویرایش</button></div>
     <div className="plan-facts"><div className="plan-fact">نوع طرح <LockBadge>فقط کارکنان</LockBadge><strong>{optionsFor(options, 'loan_type').find((item) => item.value === plan.loanType)?.labelFa || plan.loanType || '—'}</strong></div><div className="plan-fact">روش اجرا<strong>{plan.processMode || '—'}</strong></div><div className="plan-fact">هزینه ثابت تشکیل پرونده<strong>{BigInt(plan.filingFeeToman).toLocaleString('fa-IR')} تومان</strong></div><div className="plan-fact">زمان انجام<strong>{GRANT_TIMES.find((item) => item.value === plan.grantDays)?.label || plan.grantDays || '—'}</strong></div><div className="plan-fact">قالب قرارداد<strong>{templatesReq.data?.find((template) => template.id === plan.contractTemplateId)?.name || '—'}</strong></div></div>
     {plan.loanType === 'goods' ? <section className="plan-detail-section"><h4>اطلاعات خرید کالا</h4><div className="plan-facts"><div className="plan-fact">شرکت پلتفرم<strong>{plan.platformCompanyName || '—'}</strong></div><div className="plan-fact">فروشگاه خریدار<strong>{plan.goodsStoreName || '—'}</strong></div><div className="plan-fact">حق‌العمل<strong>{plan.commissionPercent == null ? '—' : `${plan.commissionPercent}٪`}</strong></div><div className="plan-fact">هزینه عملیات<strong>{plan.operationCostsPercent == null ? '—' : `${plan.operationCostsPercent}٪`}</strong></div><div className="plan-fact">تخفیف اعطایی<strong>{plan.grantedDiscountPercent == null ? '—' : `${plan.grantedDiscountPercent}٪`}</strong></div><div className="plan-fact">حق‌العمل خرید<strong>{plan.purchaseCommissionPercent == null ? '—' : `${plan.purchaseCommissionPercent}٪`}</strong></div><div className="plan-fact">حق‌العمل فروش<strong>{plan.salesCommissionPercent == null ? '—' : `${plan.salesCommissionPercent}٪`}</strong></div><div className="plan-fact">کارمزد اخذ وام<strong>{plan.loanAcquisitionFeePercent == null ? '—' : `${plan.loanAcquisitionFeePercent}٪`}</strong></div><div className="plan-fact">وجه التزام<strong>{plan.penaltyValue == null ? '—' : `${plan.penaltyValue.toLocaleString('fa-IR')}${plan.penaltyMode === 'percent' ? '٪' : ' تومان'}`}</strong></div><div className="plan-fact">مدت قرارداد<strong>{plan.contractDurationDays == null ? '—' : `${plan.contractDurationDays} روز`}</strong></div></div></section> : null}
    {plan.installmentTerms?.length ? <section className="plan-detail-section"><h4>اقساط و درصدها</h4><div className="installment-terms-display">{plan.installmentTerms.map((term) => <div className="term-display-card" key={term.installments}><strong>{term.installments} قسط</strong><span>پیش‌پرداخت: {term.prepaymentPercent}٪</span><span>کسر از مشتری: {term.deductionPercent}٪</span><span>واریزی مشتری: {term.depositPercent}٪</span></div>)}</div></section> : null}
    {plan.requiredDocuments?.length ? <section className="plan-detail-section"><h4>مدارک مورد نیاز</h4><div className="docs-list">{labelsFor(plan.requiredDocuments, documentOptions).map((label) => <span className="doc-badge" key={label}>{label}</span>)}</div></section> : null}
    {plan.notes ? <section className="plan-detail-section"><h4>توضیحات</h4><p className="subtle-note">{plan.notes}</p></section> : null}
    <section className="plan-detail-section">
      <div className="panel-head"><div><h3>مسیرهای تأیید</h3><p>کافی است مشتری با یکی از مسیرها جور باشد.</p></div><CheckCircle2 size={18} color="#3f918a" /></div>
      <div className="condition-list">{plan.conditions?.length ? [...plan.conditions].sort((a, b) => a.sortOrder - b.sortOrder).map((condition, index) => {
        const customerRanks = sortGrades(parseStringArray(condition.customerRanks));
        const guarantorRanks = sortGrades(parseStringArray(condition.guarantorRanks));
        const customerJobs = labelsFor(condition.customerJobs ?? [], optionsFor(options, 'job_type'));
        const guarantorJobs = labelsFor(condition.guarantorJobs ?? [], optionsFor(options, 'guarantor_job_type'));
        const sides = conditionSides(condition);
        return <div className="condition-item" key={condition.id}>
          <strong>مسیر {faDigits(index + 1)}</strong>
          <ul>
             {condition.maxPrincipal ? <li>سقف مبلغ: {condition.maxPrincipal} تومان</li> : null}
            {condition.installmentOptions?.length ? <li>اقساط مجاز: {condition.installmentOptions.join('، ')}</li> : null}
            {customerRanks.length ? <li>رتبه مشتری: <GradeChipList values={customerRanks} testId={`text-condition-customer-ranks-${condition.id}`} /></li> : null}
            {customerJobs.length ? <li>مشاغل مشتری: {customerJobs.join('، ')}</li> : null}
            {condition.needsMilitaryService ? <li data-testid={`text-condition-military-${condition.id}`}>پایان خدمت متقاضی لازم است (خانم‌ها معاف)</li> : null}
            <li data-testid={`text-condition-customer-req-${condition.id}`}>تضمین متقاضی: {requirementsText(sides.customer)}</li>
            <li>{condition.needsGuarantor ? 'ضامن لازم است' : 'ضامن لازم نیست'}</li>
            {condition.needsGuarantor && guarantorRanks.length ? <li>رتبه ضامن: <GradeChipList values={guarantorRanks} testId={`text-condition-guarantor-ranks-${condition.id}`} /></li> : null}
            {condition.needsGuarantor && guarantorJobs.length ? <li>مشاغل ضامن: {guarantorJobs.join('، ')}</li> : null}
            {condition.needsGuarantor ? <li data-testid={`text-condition-guarantor-req-${condition.id}`}>تضمین ضامن: {requirementsText(sides.guarantor)}</li> : null}
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
    customer: { ...NO_REQUIREMENTS },
    needsGuarantor: false,
    guarantorRanks: [],
    guarantorJobs: [],
    guarantor: { ...NO_REQUIREMENTS },
    needsMilitaryService: false,
    notes: '',
  };
}

/** crm-plans-consult: route side requirements of a stored condition (collateral_type + needs_* flags). */
export function conditionSides(condition: LoanPlan['conditions'][number]) {
  return {
    customer: sideRequirements(condition.collateralType, { check: condition.needsCustomerCheck, promissory: condition.needsCustomerPromissory, salary: condition.needsCustomerSalaryDeduct }),
    guarantor: sideRequirements(condition.guarantorCollateralType, { check: condition.needsGuarantorCheck, promissory: condition.needsGuarantorPromissory, salary: condition.needsGuarantorSalaryDeduct }),
  };
}

type PlanStepKey = 'basics' | 'terms' | 'goods' | 'applicant' | 'cheque' | 'guarantor' | 'docs' | 'review';
const PLAN_STEPS: Array<{ key: PlanStepKey; title: string }> = [
  { key: 'basics', title: 'اطلاعات پایه' },
  { key: 'terms', title: 'مبلغ و اقساط' },
  { key: 'goods', title: 'اطلاعات خرید کالا' },
  { key: 'applicant', title: 'رتبه و شغل متقاضی' },
  { key: 'cheque', title: 'چک و تضمین متقاضی' },
  { key: 'guarantor', title: 'ضامن' },
  { key: 'docs', title: 'مدارک و قرارداد' },
  { key: 'review', title: 'بازبینی و ذخیره' },
];
const ROUTE_STEPS: PlanStepKey[] = ['applicant', 'cheque', 'guarantor'];
const CHECK_KINDS = (['any', 'physical', 'digital'] as const).map((value) => ({ value, label: CHECK_KIND_LABEL[value] }));

/** Toman field for the stored digit strings (principal / route max); a non-numeric legacy value stays a plain text box. */
function TomanText({ value, onChange, testId }: { value: string; onChange: (value: string) => void; testId?: string }) {
  if (!/^\d*$/.test(value.trim())) return <input value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />;
  return <TomanInput value={value.trim() ? Number(value) : null} onChange={(n) => onChange(n == null ? '' : String(n))} testId={testId} />;
}

function SideRequirementFields({ who, value, onChange, testId }: { who: 'متقاضی' | 'ضامن'; value: SideRequirements; onChange: (value: SideRequirements) => void; testId: string }) {
  return <>
    <Choice label={`چک ${who} لازم است؟`} required value={yn(value.check)} options={YES_NO} onChange={(v) => onChange({ ...value, check: v === 'yes' })} testId={`${testId}-check`} />
    {value.check ? <div className="pc-nested"><Choice label="چه نوع چکی؟" required value={value.checkKind} options={CHECK_KINDS} onChange={(checkKind) => onChange({ ...value, checkKind })} testId={`${testId}-check-kind`} /></div> : null}
    <div className="pc-two">
      <Choice label="سفته لازم است؟" required value={yn(value.promissory)} options={YES_NO} onChange={(v) => onChange({ ...value, promissory: v === 'yes' })} testId={`${testId}-promissory`} />
      <Choice label="گواهی کسر از حقوق لازم است؟" required value={yn(value.salary)} options={YES_NO} onChange={(v) => onChange({ ...value, salary: v === 'yes' })} testId={`${testId}-salary`} />
    </div>
  </>;
}

function PlanForm({ plan, pending, goodsError, canGoodsFinance, onClose, onSave }: { plan: LoanPlan | null; pending: boolean; goodsError: string; canGoodsFinance: boolean; onClose: () => void; onSave: (data: LoanPlanInput, goods: GoodsPlanForm) => void }) {
  const [goods, setGoods] = useState<GoodsPlanForm>(blankGoodsPlanForm);
  const dictionaries = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 5 * 60_000 } });
  const templatesReq = useListContractTemplates({ query: { queryKey: getListContractTemplatesQueryKey(), staleTime: 60_000 } });
  const options = dictionaries.data ?? [];
  const templates = templatesReq.data ?? [];
  const [form, setForm] = useState<BaseForm>(blankForm);
  const [terms, setTerms] = useState<InstallmentTermForm[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);
  const [conditions, setConditions] = useState<ConditionForm[]>([]);
  const [step, setStep] = useState<PlanStepKey>('basics');
  const [route, setRoute] = useState(0);
  const [stepError, setStepError] = useState('');
  const goodsRef = useRef<HTMLDivElement>(null);
  // Original letters, for «شرط قبلی این طرح «A و B» بود…»: still-stored letters (before the release) or the migration snapshot.
  const [sourceLetters, setSourceLetters] = useState<Record<string, GradeLetter[]>>({});
  const conversion = useQuery({
    queryKey: ['loan-plan-grade-conversion', plan?.id ?? 0],
    queryFn: () => api.get<{ items: Array<{ conditionId: number; field: 'customerRanks' | 'guarantorRanks'; original: string[] }> }>(`/loan-plans/${plan?.id}/grade-conversion`),
    enabled: Boolean(plan?.id), retry: false, staleTime: 60_000,
  });
  const conversionNote = (condition: ConditionForm, field: 'customerRanks' | 'guarantorRanks') => {
    if (condition.id == null) return null;
    const stored = sourceLetters[`${condition.id}:${field}`];
    const migrated = conversion.data?.items.find((item) => item.conditionId === condition.id && item.field === field);
    const letters = stored?.length ? stored : legacyLettersIn(migrated?.original ?? []);
    if (!letters.length) return null;
    const unchanged = expandGradeList(letters).every((g) => condition[field].includes(g));
    if (!unchanged) return null;
    const join = (list: string[]) => list.length < 2 ? list.join('') : `${list.slice(0, -1).join('، ')} و ${list[list.length - 1]}`;
    const was = join(letters), now = join(letters.map((l) => `${l}1 تا ${l}3`));
    return stored?.length
      ? <>شرط فعلی این طرح «{was}» است؛ با ذخیره به {now} تبدیل می‌شود.</>
      : <>شرط قبلی این طرح «{was}» بود؛ در انتشار به {now} تبدیل شده است.</>;
  };
  const isGoodsPlan = form.loanType === 'goods';
  const steps = PLAN_STEPS.filter((item) => item.key !== 'goods' || isGoodsPlan);
  const stepIndex = Math.max(0, steps.findIndex((item) => item.key === step));
  const current = steps[stepIndex] ?? steps[0];

  useEffect(() => {
    setForm(plan ? {
      name: plan.name,
      filingFeeToman: plan.filingFeeToman,
      bankName: plan.bankName ?? '',
      platformName: plan.platformName ?? '',
      principalAmount: plan.principalAmount ?? '',
      annualInterest: plan.annualInterest ?? '',
      loanType: plan.loanType ?? '',
      processMode: plan.processMode ?? '',
      grantDays: plan.grantDays ?? '',
      notes: plan.notes ?? '',
      contractTemplateId: plan.contractTemplateId ? String(plan.contractTemplateId) : '',
      platformCompanyName: plan.platformCompanyName ?? '',
      goodsStoreName: plan.goodsStoreName ?? '',
      commissionPercent: plan.commissionPercent == null ? '' : String(plan.commissionPercent),
      operationCostsPercent: plan.operationCostsPercent == null ? '' : String(plan.operationCostsPercent),
      grantedDiscountPercent: plan.grantedDiscountPercent == null ? '' : String(plan.grantedDiscountPercent),
      purchaseCommissionPercent: plan.purchaseCommissionPercent == null ? '' : String(plan.purchaseCommissionPercent),
      salesCommissionPercent: plan.salesCommissionPercent == null ? '' : String(plan.salesCommissionPercent),
      loanAcquisitionFeePercent: plan.loanAcquisitionFeePercent == null ? '' : String(plan.loanAcquisitionFeePercent),
      penaltyMode: plan.penaltyMode ?? 'amount',
      penaltyValue: plan.penaltyValue == null ? '' : String(plan.penaltyValue),
      contractDurationDays: plan.contractDurationDays == null ? '' : String(plan.contractDurationDays),
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
    setSourceLetters(Object.fromEntries((plan?.conditions ?? []).flatMap((condition) => [
      [`${condition.id}:customerRanks`, legacyLettersIn(parseStringArray(condition.customerRanks))],
      [`${condition.id}:guarantorRanks`, legacyLettersIn(parseStringArray(condition.guarantorRanks))],
    ])));
    // A new plan starts with one empty route; an existing plan keeps exactly its routes (none stays none).
    setConditions(plan ? [...(plan.conditions ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((condition) => ({
      id: condition.id,
      maxPrincipal: condition.maxPrincipal ?? '',
      installmentOptions: condition.installmentOptions ?? [],
      // Legacy letters open as their three sub-grades (B → B1, B2, B3); saving stores sub-grades only.
      customerRanks: expandGradeList(parseStringArray(condition.customerRanks)),
      customerJobs: condition.customerJobs ?? [],
      needsGuarantor: Boolean(condition.needsGuarantor),
      guarantorRanks: expandGradeList(parseStringArray(condition.guarantorRanks)),
      guarantorJobs: condition.guarantorJobs ?? [],
      ...conditionSides(condition),
      needsMilitaryService: Boolean(condition.needsMilitaryService),
      notes: condition.notes ?? '',
    })) : [emptyCondition()]);
    setStep('basics');
    setRoute(0);
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
    setRoute(target);
  };
  const addRoute = (copyFrom?: ConditionForm) => {
    const copy: ConditionForm = copyFrom
      ? { ...copyFrom, id: undefined, installmentOptions: [...copyFrom.installmentOptions], customerRanks: [...copyFrom.customerRanks], customerJobs: [...copyFrom.customerJobs], guarantorRanks: [...copyFrom.guarantorRanks], guarantorJobs: [...copyFrom.guarantorJobs], customer: { ...copyFrom.customer }, guarantor: { ...copyFrom.guarantor } }
      : emptyCondition();
    setConditions((current) => [...current, copy]);
    setRoute(conditions.length);
  };
  const removeRoute = (index: number) => {
    setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setRoute(Math.max(0, Math.min(index, conditions.length - 2)));
  };
  const goStep = (key: PlanStepKey, routeIndex?: number) => { setStepError(''); setStep(key); if (routeIndex != null) setRoute(routeIndex); };

  const buildInput = (): LoanPlanInput => {
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
    return {
      ...legacy,
      ...form,
      filingFeeToman: form.filingFeeToman,
      contractTemplateId: Number(form.contractTemplateId),
      platformCompanyName: form.loanType === 'goods' ? form.platformCompanyName.trim() : undefined,
      goodsStoreName: form.loanType === 'goods' ? form.goodsStoreName.trim() : undefined,
      commissionPercent: form.loanType === 'goods' && form.commissionPercent !== '' ? Number(form.commissionPercent) : undefined,
      operationCostsPercent: form.loanType === 'goods' && form.operationCostsPercent !== '' ? Number(form.operationCostsPercent) : undefined,
      grantedDiscountPercent: form.loanType === 'goods' && form.grantedDiscountPercent !== '' ? Number(form.grantedDiscountPercent) : undefined,
      purchaseCommissionPercent: form.loanType === 'goods' && form.purchaseCommissionPercent !== '' ? Number(form.purchaseCommissionPercent) : undefined,
      salesCommissionPercent: form.loanType === 'goods' && form.salesCommissionPercent !== '' ? Number(form.salesCommissionPercent) : undefined,
      loanAcquisitionFeePercent: form.loanType === 'goods' && form.loanAcquisitionFeePercent !== '' ? Number(form.loanAcquisitionFeePercent) : undefined,
      penaltyMode: form.loanType === 'goods' ? form.penaltyMode as 'amount' | 'percent' : undefined,
      penaltyValue: form.loanType === 'goods' && form.penaltyValue !== '' ? Number(form.penaltyValue) : undefined,
      contractDurationDays: form.loanType === 'goods' && form.contractDurationDays !== '' ? Number(form.contractDurationDays) : undefined,
      name: form.name.trim(),
      installments: selectedInstallments.join(','),
      installmentTerms: terms.map((term) => ({
        installments: term.installments,
        prepaymentPercent: Number(term.prepaymentPercent || 0),
        deductionPercent: Number(term.deductionPercent || 0),
        depositPercent: Number(term.depositPercent || 0),
      })),
      requiredDocuments: documents,
      conditions: conditions.map((condition, index) => {
        const customer = encodeSide(condition.customer);
        const guarantor = encodeSide(condition.needsGuarantor ? condition.guarantor : NO_REQUIREMENTS);
        return {
          maxPrincipal: condition.maxPrincipal,
          installmentOptions: condition.installmentOptions,
          customerRanks: condition.customerRanks,
          customerJobs: condition.customerJobs,
          collateralType: customer.collateralType,
          needsCustomerCheck: customer.check,
          needsCustomerPromissory: customer.promissory,
          needsCustomerSalaryDeduct: customer.salary,
          needsGuarantor: condition.needsGuarantor,
          guarantorRanks: condition.needsGuarantor ? condition.guarantorRanks : [],
          guarantorJobs: condition.needsGuarantor ? condition.guarantorJobs : [],
          guarantorCollateralType: guarantor.collateralType,
          needsGuarantorCheck: guarantor.check,
          needsGuarantorPromissory: guarantor.promissory,
          needsGuarantorSalaryDeduct: guarantor.salary,
          needsMilitaryService: condition.needsMilitaryService,
          sortOrder: index,
          notes: condition.notes,
        };
      }),
    };
  };

  /** First step whose required data is missing (steps are also natively validated when leaving them). */
  const firstInvalidStep = (): PlanStepKey | null => {
    if (!form.name.trim() || !form.grantDays || !/^\d+$/.test(form.filingFeeToman)) return 'basics';
    if (terms.some((term) => term.prepaymentPercent === '' || term.deductionPercent === '' || term.depositPercent === '')) return 'terms';
    if (isGoodsPlan && (!form.platformCompanyName.trim() || !form.goodsStoreName.trim())) return 'goods';
    if (!form.contractTemplateId) return 'docs';
    return null;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setStepError('');
    if (current.key === 'goods' && goodsRef.current) {
      const fields = Array.from(goodsRef.current.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
      if (!fields.every((field) => field.reportValidity())) return;
    }
    if (current.key !== 'review') { goStep(steps[Math.min(steps.length - 1, stepIndex + 1)].key); return; }
    const invalid = firstInvalidStep();
    if (invalid) { setStepError('چند مورد الزامی هنوز خالی است.'); setStep(invalid); return; }
    onSave(buildInput(), goods);
  };

  const condition = conditions[route];
  const isRouteStep = ROUTE_STEPS.includes(current.key);
  const loanTypeLabel = optionsFor(options, 'loan_type').find((item) => item.value === form.loanType)?.labelFa;
  const jobLabels = (values: string[], field: string) => values.length ? labelsFor(values, optionsFor(options, field)).join('، ') : 'همه‌ی مشاغل';
  const gradesText = (values: string[]) => values.length ? sortGrades(values).join('، ') : 'همه‌ی رتبه‌ها';

  const routeBar = isRouteStep ? <>
    <div className="pc-routes" data-testid="plan-route-tabs">
      <span>این مرحله برای هر مسیر جداست:</span>
      {conditions.map((_, index) => <button type="button" key={index} className={`pc-route-tab${index === route ? ' is-on' : ''}`} onClick={() => setRoute(index)} data-testid={`button-route-${index}`}>مسیر {faDigits(index + 1)}</button>)}
      <button type="button" className="pc-route-tab is-add" onClick={() => addRoute()} data-testid="button-add-condition"><Plus size={14} />مسیر تازه</button>
      {condition ? <div className="pc-route-tools">
        <button type="button" onClick={() => moveCondition(route, -1)} disabled={route === 0} aria-label="انتقال مسیر به قبل" title="انتقال به قبل"><ArrowRight size={15} /></button>
        <button type="button" onClick={() => moveCondition(route, 1)} disabled={route >= conditions.length - 1} aria-label="انتقال مسیر به بعد" title="انتقال به بعد"><ArrowLeft size={15} /></button>
        <button type="button" onClick={() => addRoute(condition)} aria-label="کپی این مسیر" title="کپی این مسیر" data-testid="button-copy-condition"><Copy size={15} /></button>
        <button type="button" onClick={() => removeRoute(route)} aria-label="حذف این مسیر" title="حذف این مسیر" data-testid="button-remove-condition"><Trash2 size={15} /></button>
      </div> : null}
    </div>
    <p className="pc-route-note">کافی است مشتری با یکی از مسیرها جور باشد.</p>
  </> : null;

  const noRoute = <div className="empty-state compact-empty" data-testid="status-no-routes"><p>این طرح مسیری ندارد. بدون مسیر، شرایط کلی طرح بررسی می‌شود. برای افزودن شرط، «مسیر تازه» را بزنید.</p></div>;

  return <Modal title={plan ? `ویرایش طرح — ${plan.name}` : 'طرح تسهیلاتی تازه'} eyebrow="کاتالوگ تأمین مالی" onClose={onClose} testId="loan-plan-form">
    <div className="pc-wizard">
      <div className="pc-sub">{loanTypeLabel ? <LockBadge>{loanTypeLabel}</LockBadge> : null}<span>{conditions.length ? `${faDigits(conditions.length)} مسیر` : 'بدون مسیر'}</span></div>
      <WizardProgress title={current.title} index={stepIndex} total={steps.length} testId="plan-wizard-progress" />
      {routeBar}
      <form id="plan-wizard-form" onSubmit={submit} className="loan-plan-form pc-body" data-testid={`plan-step-${current.key}`}>
        {current.key === 'basics' ? <div className="form-grid">
          <div className="field full"><label>نام طرح</label><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required data-testid="input-plan-name" /></div>
          <div className="field"><label>بانک</label><input value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} /></div>
          <div className="field"><label>پلتفرم</label><input value={form.platformName} onChange={(event) => setForm({ ...form, platformName: event.target.value })} /></div>
          <div className="field"><label>نوع طرح <LockBadge>فقط کارکنان</LockBadge></label><DictionarySelect value={form.loanType} options={optionsFor(options, 'loan_type')} onChange={(loanType) => setForm({ ...form, loanType })} testId="select-plan-loan-type" /></div>
          <div className="field"><label>روش اجرا</label><DictionarySelect value={form.processMode} options={optionsFor(options, 'process_mode')} onChange={(processMode) => setForm({ ...form, processMode })} /></div>
          <div className="field"><label>مدت زمان انجام</label><select value={form.grantDays} onChange={(event) => setForm({ ...form, grantDays: event.target.value })} required><option value="">انتخاب کنید</option>{GRANT_TIMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <div className="field"><label>هزینه ثابت تشکیل پرونده (تومان)</label><input type="text" inputMode="numeric" pattern="[0-9]+" value={form.filingFeeToman} onChange={(event) => setForm({ ...form, filingFeeToman: event.target.value.replace(/\D/g, '').slice(0, 30) })} required data-testid="input-plan-filing-fee" /></div>
          <div className="field full"><Choice label="وضعیت طرح در کاتالوگ" value={form.active ? 'on' : 'off'} options={[{ value: 'on', label: 'فعال' }, { value: 'off', label: 'غیرفعال' }]} onChange={(v) => setForm({ ...form, active: v === 'on' })} testId="choice-plan-active" /></div>
        </div> : null}

        {current.key === 'terms' ? <div className="form-grid">
          <div className="field"><label>سقف تسهیلات</label><TomanText value={form.principalAmount} onChange={(principalAmount) => setForm({ ...form, principalAmount })} testId="input-plan-principal" /></div>
          <div className="field"><label>سود سالانه</label><input value={form.annualInterest} onChange={(event) => setForm({ ...form, annualInterest: event.target.value })} /></div>
          <div className="field full"><label>تعداد اقساط</label><ChipChoices values={INSTALLMENT_OPTIONS.map((value) => ({ value, label: `${faDigits(value)} ماهه` }))} selected={selectedInstallments} onChange={updateSelectedInstallments} testId="installment-options" /></div>
          {terms.length ? <div className="field full"><label>درصدهای مربوط به هر تعداد اقساط</label><div className="installment-terms-list">{terms.map((term) => <div className="installment-term-row" key={term.installments}><strong>{faDigits(term.installments)} قسط</strong><div className="term-inputs"><label><span>پیش‌پرداخت</span><input type="number" min="0" max="100" step="0.01" value={term.prepaymentPercent} onChange={(event) => updateTerm(term.installments, 'prepaymentPercent', event.target.value)} required /></label><label><span>کسر از مشتری</span><input type="number" min="0" max="100" step="0.01" value={term.deductionPercent} onChange={(event) => updateTerm(term.installments, 'deductionPercent', event.target.value)} required /></label><label><span>واریزی به مشتری</span><input type="number" min="0" max="100" step="0.01" value={term.depositPercent} onChange={(event) => updateTerm(term.installments, 'depositPercent', event.target.value)} required /></label></div></div>)}</div></div> : null}
        </div> : null}

        {current.key === 'goods' ? <div className="form-grid">
          <div className="field"><label>نام شرکت پلتفرم</label><input value={form.platformCompanyName} onChange={(e) => setForm({ ...form, platformCompanyName: e.target.value })} required /></div>
          <div className="field"><label>نام فروشگاه خریدار کالا</label><input value={form.goodsStoreName} onChange={(e) => setForm({ ...form, goodsStoreName: e.target.value })} required /></div>
          {([
            ['commissionPercent', 'درصد حق‌العمل'], ['operationCostsPercent', 'درصد هزینه‌های عملیات'], ['grantedDiscountPercent', 'درصد تخفیف اعطایی'],
            ['purchaseCommissionPercent', 'درصد حق‌العمل خرید'], ['salesCommissionPercent', 'درصد حق‌العمل فروش'], ['loanAcquisitionFeePercent', 'درصد کارمزد اخذ وام'],
          ] as const).map(([key, label]) => <div className="field" key={key}><label>{label}</label><input type="number" min="0" max="100" step="0.01" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required /></div>)}
          <div className="field"><label>وجه التزام</label><div style={{ display: 'flex', gap: 6 }}><select value={form.penaltyMode} onChange={(e) => setForm({ ...form, penaltyMode: e.target.value })}><option value="amount">مبلغی</option><option value="percent">درصدی</option></select><input type="number" min="0" max={form.penaltyMode === 'percent' ? 100 : undefined} step="0.01" value={form.penaltyValue} onChange={(e) => setForm({ ...form, penaltyValue: e.target.value })} placeholder={form.penaltyMode === 'amount' ? 'تومان' : 'درصد'} required /></div></div>
          <div className="field"><label>مدت قرارداد (روز)</label><input type="number" min="1" step="1" value={form.contractDurationDays} onChange={(e) => setForm({ ...form, contractDurationDays: e.target.value })} required /></div>
        </div> : null}

        {current.key === 'applicant' ? (condition ? <div className="form-grid" key={`applicant-${route}`}>
          <div className="field"><label>سقف مبلغ این مسیر <span className="pc-hint">خالی = سقف طرح</span></label><TomanText value={condition.maxPrincipal} onChange={(value) => updateCondition(route, 'maxPrincipal', value)} testId={`input-condition-max-${route}`} /></div>
          <div className="field"><label>اقساط مجاز این مسیر <span className="pc-hint">خالی = همه‌ی اقساط طرح</span></label><ChipChoices values={INSTALLMENT_OPTIONS.map((value) => ({ value, label: `${faDigits(value)} ماهه` }))} selected={condition.installmentOptions} onChange={(value) => updateCondition(route, 'installmentOptions', value)} /></div>
          <div className="field full"><GradePickerMulti label="رتبه‌های مجاز متقاضی" values={condition.customerRanks} onChange={(value) => updateCondition(route, 'customerRanks', value)} note={conversionNote(condition, 'customerRanks')} testId={`grades-customer-${route}`} /></div>
          <div className="field full"><label>شغل متقاضی <span className="pc-hint">هیچ‌کدام = همه‌ی مشاغل</span></label><DictionaryChips selected={condition.customerJobs} options={optionsFor(options, 'job_type')} onChange={(value) => updateCondition(route, 'customerJobs', value)} testId={`jobs-customer-${route}`} /></div>
          <div className="field full"><Choice label="پایان خدمت متقاضی لازم است؟" hint="خانم‌ها معاف‌اند" value={yn(condition.needsMilitaryService)} options={YES_NO} onChange={(v) => updateCondition(route, 'needsMilitaryService', v === 'yes')} testId={`select-condition-military-${route}`} /></div>
          <div className="field full"><label>توضیحات این مسیر</label><input value={condition.notes} onChange={(e) => updateCondition(route, 'notes', e.target.value)} /></div>
        </div> : noRoute) : null}

        {current.key === 'cheque' ? (condition ? <div className="pc-body" key={`cheque-${route}`}>
          <SideRequirementFields who="متقاضی" value={condition.customer} onChange={(value) => updateCondition(route, 'customer', value)} testId={`req-customer-${route}`} />
        </div> : noRoute) : null}

        {current.key === 'guarantor' ? (condition ? <div className="pc-body" key={`guarantor-${route}`}>
          <Choice label="ضامن لازم است؟" required value={yn(condition.needsGuarantor)} options={YES_NO} onChange={(v) => updateCondition(route, 'needsGuarantor', v === 'yes')} testId={`choice-condition-guarantor-${route}`} />
          {condition.needsGuarantor ? <div className="pc-nested pc-body">
            <GradePickerMulti label="رتبه‌های مجاز ضامن" values={condition.guarantorRanks} onChange={(value) => updateCondition(route, 'guarantorRanks', value)} note={conversionNote(condition, 'guarantorRanks')} testId={`grades-guarantor-${route}`} />
            <div className="field"><label>شغل ضامن <span className="pc-hint">هیچ‌کدام = همه‌ی مشاغل</span></label><DictionaryChips selected={condition.guarantorJobs} options={optionsFor(options, 'guarantor_job_type')} onChange={(value) => updateCondition(route, 'guarantorJobs', value)} /></div>
            <SideRequirementFields who="ضامن" value={condition.guarantor} onChange={(value) => updateCondition(route, 'guarantor', value)} testId={`req-guarantor-${route}`} />
          </div> : <p className="subtle-note">برای این مسیر ضامن لازم نیست.</p>}
        </div> : noRoute) : null}

        {current.key === 'docs' ? <div className="pc-body">
          <div className="field full"><label>قالب قرارداد</label><select value={form.contractTemplateId} onChange={(e) => setForm({ ...form, contractTemplateId: e.target.value })} required><option value="">انتخاب قالب قرارداد</option>{templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select></div>
          <div className="field"><label>لیست مدارک مورد نیاز</label><DictionaryChips selected={documents} options={optionsFor(options, 'required_document')} onChange={setDocuments} testId="required-documents" /></div>
          <div className="field"><label>توضیحات طرح</label><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} data-testid="textarea-plan-notes" /></div>
        </div> : null}

        {current.key === 'review' ? <div className="pc-review" data-testid="plan-review">
          <div className="pc-review-card"><header><strong>اطلاعات پایه</strong><button type="button" onClick={() => goStep('basics')}>ویرایش</button></header><dl>
            <dt>نام</dt><dd>{form.name || '—'}</dd><dt>بانک / پلتفرم</dt><dd>{[form.bankName, form.platformName].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>نوع طرح</dt><dd>{loanTypeLabel ?? '—'}</dd><dt>وضعیت</dt><dd>{form.active ? 'فعال' : 'غیرفعال'}</dd>
          </dl></div>
          <div className="pc-review-card"><header><strong>مبلغ و اقساط</strong><button type="button" onClick={() => goStep('terms')}>ویرایش</button></header><dl>
            <dt>سقف</dt><dd>{/^\d+$/.test(form.principalAmount) ? `${formatToman(Number(form.principalAmount))} تومان` : form.principalAmount || '—'}</dd>
            <dt>اقساط</dt><dd>{terms.length ? terms.map((term) => faDigits(term.installments)).join('، ') : '—'}</dd>
          </dl></div>
          {isGoodsPlan ? <div className="pc-review-card"><header><strong>اطلاعات خرید کالا</strong><button type="button" onClick={() => goStep('goods')}>ویرایش</button></header><dl><dt>فروشگاه</dt><dd>{form.goodsStoreName || '—'}</dd><dt>شرکت پلتفرم</dt><dd>{form.platformCompanyName || '—'}</dd></dl></div> : null}
          {conditions.length ? conditions.map((item, index) => <div className="pc-review-card" key={index} data-testid={`review-route-${index}`}><header><strong>مسیر {faDigits(index + 1)}</strong><span style={{ display: 'flex', gap: 12 }}><button type="button" onClick={() => goStep('applicant', index)}>ویرایش متقاضی</button><button type="button" onClick={() => goStep('cheque', index)}>ویرایش تضمین</button><button type="button" onClick={() => goStep('guarantor', index)}>ویرایش ضامن</button></span></header><dl>
            <dt>سقف مسیر</dt><dd>{/^\d+$/.test(item.maxPrincipal) ? `${formatToman(Number(item.maxPrincipal))} تومان` : item.maxPrincipal || 'سقف طرح'}</dd>
            <dt>رتبه متقاضی</dt><dd>{gradesText(item.customerRanks)}</dd>
            <dt>شغل متقاضی</dt><dd>{jobLabels(item.customerJobs, 'job_type')}</dd>
            {item.needsMilitaryService ? <><dt>پایان خدمت</dt><dd>لازم است (خانم‌ها معاف)</dd></> : null}
            <dt>تضمین متقاضی</dt><dd>{requirementsText(item.customer)}</dd>
            <dt>ضامن</dt><dd>{item.needsGuarantor ? `لازم · ${gradesText(item.guarantorRanks)} · ${jobLabels(item.guarantorJobs, 'guarantor_job_type')} · ${requirementsText(item.guarantor)}` : 'لازم نیست'}</dd>
          </dl></div>) : <div className="pc-review-card"><header><strong>مسیرها</strong><button type="button" onClick={() => goStep('applicant')}>ویرایش</button></header><p className="subtle-note">بدون مسیر؛ شرایط کلی طرح بررسی می‌شود.</p></div>}
          <div className="pc-review-card"><header><strong>مدارک و قرارداد</strong><button type="button" onClick={() => goStep('docs')}>ویرایش</button></header><dl>
            <dt>قالب قرارداد</dt><dd>{templates.find((tpl) => String(tpl.id) === form.contractTemplateId)?.name || '—'}</dd>
            <dt>مدارک</dt><dd>{documents.length ? labelsFor(documents, optionsFor(options, 'required_document')).join('، ') : '—'}</dd>
          </dl></div>
        </div> : null}
      </form>
      <div ref={goodsRef} hidden={current.key !== 'goods'}>
        <GoodsPlanSettingsFields planId={plan?.id} value={goods} onChange={setGoods} templates={templates} enabled={isGoodsPlan && canGoodsFinance} />
      </div>
      {stepError ? <div className="gp-alert">{stepError}</div> : null}
      {goodsError ? <div className="gp-alert">{goodsError}</div> : null}
      <div className="pc-footer">
        <button className="btn btn-primary" type="submit" form="plan-wizard-form" disabled={pending} data-testid="button-plan-wizard-next">{current.key === 'review' ? (pending ? 'در حال ذخیره…' : 'ذخیره طرح') : <>بعدی <ArrowLeft size={16} /></>}</button>
        {stepIndex > 0 ? <button className="btn btn-ghost" type="button" onClick={() => goStep(steps[stepIndex - 1].key)} data-testid="button-plan-wizard-back"><ArrowRight size={16} /> قبلی</button> : <button className="btn btn-ghost" type="button" onClick={onClose}>انصراف</button>}
      </div>
    </div>
  </Modal>;
}
