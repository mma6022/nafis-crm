import { ClipboardList, Edit3, Save, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { getGetConsultationQueryKey, useGetConsultation, getListConsultationsQueryKey, useListConsultations, useUpdateConsultation, useMatchConsultationLoanPlans, getMatchConsultationLoanPlansQueryKey, useListConsultOptions, getListConsultOptionsQueryKey, type Consultation, type ConsultationUpdate, type LoanPlan } from '@workspace/api-client-react';
import { ErrorState, formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { isYesValue } from '@/components/CustomerConsultationStatus';
import { consultationLabel } from '@/lib/consultation-labels';
import { GradePicker } from '@/components/grade/GradePicker';
import { GradeChip } from '@/components/grade/GradeChip';
import { gradeEditAccepted } from '@/lib/credit-grade';
import { EmptyState, Modal, Pagination, SearchField } from '@/components/DataTools';
import { useGetConsultationHistoricalLoanPlanMatches, getGetConsultationHistoricalLoanPlanMatchesQueryKey } from '@workspace/api-client-react';
import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { CallCustomerSelect, type CallCustomer } from '@/components/CallCustomerSelect';

const limit = 8;
export default function Consultations() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useTableState('consultations.search', '');
  const [offset, setOffset] = useTableState('consultations.offset', 0);
  const [editing, setEditing] = useState<Consultation | null>(null);
  const [matching, setMatching] = useState<Consultation | null>(null);
  const params = { search: search || undefined, limit, offset };
  const query = useListConsultations(params, { query: { queryKey: getListConsultationsQueryKey(params) } });
  const update = useUpdateConsultation();
  const dict = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 0 } });
  const opts = dict.data ?? [];
  const NA = 'ثبت نشده';
  const pending = dict.isLoading ? '…' : 'برچسب در دسترس نیست';
  const lab = (key: string, v?: string | null) => v ? (opts.find((o) => o.fieldKey === key && o.value === v)?.labelFa ?? pending) : NA;
  const yn = (key: string, v?: boolean | null) => v == null ? NA : (opts.find((o) => o.fieldKey === key && isYesValue(o.value) === v)?.labelFa ?? pending);
  const ans = (l: string, v: string) => <span className="secondary-cell" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{l}</span><strong style={{ color: v === NA ? '#94a3b8' : undefined, fontWeight: v === NA ? 500 : 700 }}>{v}</strong></span>;
  const rankAns = (l: string, v: string | null | undefined, testId: string) => <span className="secondary-cell" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><span>{l}</span><GradeChip value={v} testId={testId} otherLabel={v ? lab('credit_rank', v) : undefined} /></span>;
  const [handoffId] = useState<number | null>(() => {
    try {
      const raw = sessionStorage.getItem('nafis-open-matches');
      sessionStorage.removeItem('nafis-open-matches');
      const id = Number(raw);
      return raw && Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch { return null; }
  });
  const handoff = useGetConsultation(handoffId ?? 0, { query: { queryKey: getGetConsultationQueryKey(handoffId ?? 0), enabled: handoffId !== null, retry: false } });
  useEffect(() => { if (handoff.data) setMatching(handoff.data); }, [handoff.data]);
  const save = (data: ConsultationUpdate) => { if (!editing) return; const consultationId = editing.id; update.mutate({ id: consultationId, data }, { onSuccess: () => { setEditing(null); queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() }); queryClient.invalidateQueries({ queryKey: getMatchConsultationLoanPlansQueryKey(consultationId) }); } }); };
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">ارزیابی مالی</div><h2>درخواست‌های مشاوره</h2><p>درخواست‌ها را با زمینه مشتری و شاخص‌های مالی کنار هم ببینید.</p></div><div className="data-summary"><ClipboardList size={17} /><span>در صف بررسی</span><strong data-testid="text-total-consultations">{(query.data?.total ?? 0).toLocaleString('fa-IR')}</strong></div></div>
    <div className="data-toolbar"><div className="toolbar"><SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)" testId="consultations" /></div></div>
      {query.isLoading ? <SkeletonPanel rows={6} /> : query.isError ? <ErrorState onRetry={() => query.refetch()} /> : <div className="data-table-wrap" style={{ overflowX: 'auto' }}>
        {dict.isError ? <div role="alert" style={{ padding: 8, fontSize: 12, color: '#be123c' }}>برچسب‌های پرسشنامه بارگذاری نشد. <button className="table-action" onClick={() => void dict.refetch()}>تلاش دوباره</button></div> : null}
        <table className="data-table"><thead><tr><th>مشتری</th><th>متقاضی</th><th>ضامن</th><th>تاریخ ثبت</th><th>عملیات</th></tr></thead><tbody>
          {(query.data?.items ?? []).length ? query.data?.items.map((item) => <tr key={item.id} data-testid={`row-consultation-${item.id}`}>
            <td><span className="primary-cell"><CustomerName id={item.customerId} name={item.customerName} badgeTestId={`badge-consult-customer-id-${item.id}`} /></span><span className="secondary-cell mono">{item.customerPhone}</span><span className="secondary-cell">کارشناس پرونده: {item.customerSalespersonName || 'بدون تخصیص'}</span></td>
            <td style={{ minWidth: 190 }}>{rankAns('رتبه', item.creditRank, `text-consultation-rank-${item.id}`)}{ans('چک', lab('customer_check_status', item.customerCheckStatus))}{ans('کسر حقوق', yn('has_customer_salary_deduct', item.hasCustomerSalaryDeduct))}{ans('شغل', lab('job_type', item.jobType))}</td>
            <td style={{ minWidth: 190 }}>{ans('ضامن', yn('has_guarantor', item.hasGuarantor))}{item.hasGuarantor === false ? ans('رتبه ضامن', 'بدون ضامن') : rankAns('رتبه ضامن', item.guarantorCreditRank, `text-consultation-guarantor-rank-${item.id}`)}{ans('چک ضامن', item.hasGuarantor === false ? 'بدون ضامن' : lab('guarantor_check_type', item.guarantorCheckType))}{ans('کسر حقوق ضامن', item.hasGuarantor === false ? 'بدون ضامن' : yn('has_guarantor_salary_deduct', item.hasGuarantorSalaryDeduct))}</td>
            <td className="secondary-cell" data-testid={`text-consultation-date-${item.id}`}>{(item.createdAt ?? item.updatedAt) ? formatDateTime((item.createdAt ?? item.updatedAt) as string) : NA}</td>
            <td><div style={{display: 'flex', gap: 8}}><button className="table-action" onClick={() => setMatching(item)} data-testid={`button-match-consultation-${item.id}`}><ShieldCheck size={14} /> تطابق</button>{(item.questionnaireVersion ?? 0) >= 1 ? <span className="secondary-cell" data-testid={`text-consultation-immutable-${item.id}`} style={{ maxWidth: 170 }}>سابقهٔ مستقل · برای تغییر، مشاوره جدید ثبت کنید</span> : <button className="table-action" onClick={() => setEditing(item)} data-testid={`button-edit-consultation-${item.id}`}><Edit3 size={14} /> ویرایش</button>}</div></td>
          </tr>) : <tr><td colSpan={5}><EmptyState title="درخواست مشاوره‌ای پیدا نشد" description="با تغییر جست‌وجو یا ثبت درخواست جدید از سمت تیم، این فهرست تکمیل می‌شود." /></td></tr>}
        </tbody></table><Pagination total={query.data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} testId="consultations" />
      </div>}
    {editing ? <ConsultationForm consultation={editing} pending={update.isPending} onClose={() => setEditing(null)} onSave={save} /> : null}
    {matching ? <MatchesModal consultation={matching} onClose={() => setMatching(null)} /> : null}
  </section>;
}

function ConsultationForm({ consultation, pending, onClose, onSave }: { consultation: Consultation; pending: boolean; onClose: () => void; onSave: (data: ConsultationUpdate) => void }) {
  // Server-side customer search (name, mobile or «#id»), same role scope as the customer list — no longer only the first 100 customers.
  const [picked, setPicked] = useState<CallCustomer>({ id: consultation.customerId, name: consultation.customerName, phone: consultation.customerPhone, salespersonName: consultation.customerSalespersonName });
  // Legal 2026-10-24: «هدف تسهیلات» (loanPurpose), «ترجیح تسهیلات» (loanPref) and «شیوه دریافت» (receiveMode) are no longer asked;
  // their stored values stay in the form state and are saved back unchanged, so no data is lost.
  const [form, setForm] = useState({
    customerId: String(consultation.customerId), requestedAmount: consultation.requestedAmount ?? '', loanPurpose: consultation.loanPurpose ?? '', jobType: consultation.jobType ?? '', creditRank: consultation.creditRank ?? '', collateralType: consultation.collateralType ?? '', loanPref: consultation.loanPref ?? '', needDays: consultation.needDays ?? '', receiveMode: consultation.receiveMode ?? '', extraNotes: consultation.extraNotes ?? '',
    guarantorCreditRank: consultation.guarantorCreditRank ?? '', guarantorCheckType: consultation.guarantorCheckType ?? '', guarantorJobType: consultation.guarantorJobType ?? '', guarantorCollateralType: consultation.guarantorCollateralType ?? '',
    hasCheck: Boolean(consultation.hasCheck), hasPromissory: Boolean(consultation.hasPromissory), hasGuarantor: Boolean(consultation.hasGuarantor), hasBusinessLicense: Boolean(consultation.hasBusinessLicense), hasAccountTurnover: Boolean(consultation.hasAccountTurnover), needsFastReceive: Boolean(consultation.needsFastReceive), hasAvgBalance: Boolean(consultation.hasAvgBalance),
    hasGuarantorCheck: Boolean(consultation.hasGuarantorCheck), hasGuarantorPromissory: Boolean(consultation.hasGuarantorPromissory), hasCustomerSalaryDeduct: Boolean(consultation.hasCustomerSalaryDeduct), hasGuarantorSalaryDeduct: Boolean(consultation.hasGuarantorSalaryDeduct)
  });
  
  const { data: options } = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: Infinity } });
  
  const setValue = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  // PM decision 4: an unchanged old letter is saved as is; a changed rank needs its sub-grade first.
  const [gradePending, setGradePending] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const gradeBlocked = form.hasGuarantor && (gradePending || !gradeEditAccepted(form.guarantorCreditRank, consultation.guarantorCreditRank));
  const submit = (event: FormEvent) => { 
    event.preventDefault(); 
    setTriedSave(true);
    if (gradeBlocked) return;
    onSave({ 
      customerId: Number(form.customerId), requestedAmount: form.requestedAmount.trim(), loanPurpose: form.loanPurpose.trim(), jobType: form.jobType.trim(), creditRank: form.creditRank.trim(), collateralType: form.collateralType.trim(), loanPref: form.loanPref.trim(), needDays: form.needDays.trim(), receiveMode: form.receiveMode.trim(), extraNotes: form.extraNotes.trim(),
      guarantorCreditRank: form.guarantorCreditRank.trim(), guarantorCheckType: form.guarantorCheckType.trim(), guarantorJobType: form.guarantorJobType.trim(), guarantorCollateralType: form.guarantorCollateralType.trim(),
      hasCheck: form.hasCheck, hasPromissory: form.hasPromissory, hasGuarantor: form.hasGuarantor, hasBusinessLicense: form.hasBusinessLicense, hasAccountTurnover: form.hasAccountTurnover, needsFastReceive: form.needsFastReceive, hasAvgBalance: form.hasAvgBalance,
      hasGuarantorCheck: form.hasGuarantorCheck, hasGuarantorPromissory: form.hasGuarantorPromissory, hasCustomerSalaryDeduct: form.hasCustomerSalaryDeduct, hasGuarantorSalaryDeduct: form.hasGuarantorSalaryDeduct
    }); 
  };
  let booleans: [keyof typeof form, string][] = [['hasCheck','چک مشتری'],['hasPromissory','سفته مشتری'],['hasCustomerSalaryDeduct', 'کسر حقوق مشتری'],['hasBusinessLicense','جواز کسب دارد'],['hasAccountTurnover','گردش حساب دارد'],['hasAvgBalance','میانگین موجودی دارد'],['needsFastReceive','دریافت سریع لازم است']];
  if (form.hasGuarantor) {
    booleans = [...booleans, ['hasGuarantorCheck', 'چک ضامن'],['hasGuarantorPromissory', 'سفته ضامن'],['hasGuarantorSalaryDeduct', 'کسر حقوق ضامن']];
  }
  
  const jobs = options?.filter(o => o.fieldKey === 'job_type') ?? [];
  const guarantorJobs = options?.filter(o => o.fieldKey === 'guarantor_job_type') ?? [];
  const checks = options?.filter(o => o.fieldKey === 'guarantor_check_type') ?? [];
  const collaterals = options?.filter(o => o.fieldKey === 'collateral_type') ?? [];
  const guarantorChoices = options?.filter(o => o.fieldKey === 'has_guarantor') ?? [];

   return <Modal title="ویرایش درخواست مشاوره" eyebrow={`پرونده ${customerNameText(consultation.customerName, consultation.customerId)}`} onClose={onClose} testId="consultation-form"><form onSubmit={submit}><div className="form-grid"><div className="field full"><label id="consult-customer-label" htmlFor="consult-customer">مشتری</label><CallCustomerSelect id="consult-customer" labelId="consult-customer-label" testId="select-consultation-customer" selected={picked} disabled={pending} onSelect={(customer) => { setPicked(customer); setValue('customerId', String(customer.id)); }} /></div><div className="field"><label htmlFor="consult-amount">مبلغ درخواستی (تومان)</label><input id="consult-amount" value={form.requestedAmount} onChange={(event) => setValue('requestedAmount', event.target.value)} data-testid="input-consultation-amount" /><span className="secondary-cell">تومان</span></div><div className="field"><label htmlFor="consult-job">شغل مشتری</label><select id="consult-job" value={form.jobType} onChange={(event) => setValue('jobType', event.target.value)} data-testid="input-consultation-job"><option value="">انتخاب کنید</option>{jobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field full"><GradePicker id="consult-rank" label="رتبه اعتبارسنجی" readOnly value={form.creditRank} onChange={() => undefined} testId="input-consultation-rank" /><small style={{ color: '#64748b' }}>رتبه‌ی متقاضی هنگام ذخیره از اعتبارسنجی پرونده‌ی مشتری خوانده می‌شود.</small></div><div className="field"><label>وثیقه مشتری</label><select value={form.collateralType} onChange={(e) => setValue('collateralType', e.target.value)} data-testid="input-consultation-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field full"><label className="boolean-field">ضامن دارد<input type="checkbox" checked={form.hasGuarantor} onChange={e => setForm(f => ({ ...f, hasGuarantor: e.target.checked }))} data-testid="checkbox-consultation-hasGuarantor" /></label></div>{form.hasGuarantor && <><div className="field"><label>شغل ضامن</label><select value={form.guarantorJobType} onChange={(e) => setValue('guarantorJobType', e.target.value)} data-testid="input-consultation-guarantor-job"><option value="">انتخاب کنید</option>{jobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field full"><GradePicker id="consult-guarantor-rank" label="رتبه اعتبارسنجی ضامن" value={form.guarantorCreditRank} original={consultation.guarantorCreditRank} onChange={(v, p) => { setValue('guarantorCreditRank', v); setGradePending(p); }} showError={triedSave} testId="input-consultation-guarantor-rank" /></div><div className="field"><label>نوع چک ضامن</label><select value={form.guarantorCheckType} onChange={(e) => setValue('guarantorCheckType', e.target.value)} data-testid="input-consultation-guarantor-check-type"><option value="">انتخاب کنید</option>{checks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>وثیقه ضامن</label><select value={form.guarantorCollateralType} onChange={(e) => setValue('guarantorCollateralType', e.target.value)} data-testid="input-consultation-guarantor-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div></>}<div className="field"><label htmlFor="consult-days">مدت مورد نیاز</label><input id="consult-days" value={form.needDays} onChange={(event) => setValue('needDays', event.target.value)} data-testid="input-consultation-days" /></div><div className="field full"><label>شاخص‌های مالی و مدارک</label><div className="boolean-grid">{booleans.map(([key, label]) => <label className="boolean-field" key={String(key)}>{label}<input type="checkbox" checked={Boolean(form[key])} onChange={(event) => setValue(key, event.target.checked)} data-testid={`checkbox-consultation-${String(key)}`} /></label>)}</div></div><div className="field full"><label htmlFor="consult-notes">یادداشت تکمیلی</label><textarea id="consult-notes" value={form.extraNotes} onChange={(event) => setValue('extraNotes', event.target.value)} data-testid="textarea-consultation-notes" /></div></div><div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pending || gradeBlocked} data-testid="button-save-consultation"><Save size={15} />{pending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button><button className="btn btn-ghost" type="button" onClick={onClose} disabled={pending} data-testid="button-cancel-consultation">انصراف</button></div></form></Modal>;
}

function parseAmount(amt?: string | null) {
  if (!amt) return 0;
  const digits = amt.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) & 0xf)).replace(/[^0-9]/g, '');
  return parseInt(digits, 10) || 0;
}

function planDocumentGroups(plan: LoanPlan, label: (field: string, value: string) => string) {
  const customer = (plan.requiredDocuments ?? []).map(value => label('required_document', value));
  if (plan.customerCheck && plan.customerCheck !== 'none') customer.push('چک مشتری');
  if (plan.needsCustomerPromissory) customer.push('سفته مشتری');
  if (plan.needsCustomerSalaryDeduct) customer.push('گواهی کسر از حقوق مشتری');
  const guarantor: string[] = [];
  if (plan.needsGuarantor) {
    if (plan.guarantorCheck && plan.guarantorCheck !== 'none') guarantor.push('چک ضامن');
    if (plan.needsGuarantorPromissory) guarantor.push('سفته ضامن');
    if (plan.needsGuarantorSalaryDeduct) guarantor.push('گواهی کسر از حقوق ضامن');
    if (!guarantor.length) guarantor.push('مدارک هویتی و شغلی ضامن');
  }
  return {
    customer: [...new Set(customer)],
    guarantor: [...new Set(guarantor)],
  };
}

function MatchesModal({ consultation, onClose }: { consultation: Consultation; onClose: () => void }) {
  const [mode, setMode] = useState<'historical' | 'current'>('historical');
  const dictionary = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 0 } });
  const label = (field: string, value?: string | null) => consultationLabel(field, value, dictionary.data ?? []);
  const history = useGetConsultationHistoricalLoanPlanMatches(consultation.id, {
    query: { queryKey: getGetConsultationHistoricalLoanPlanMatchesQueryKey(consultation.id), retry: 1 }
  });
  const current = useMatchConsultationLoanPlans(consultation.id, {
    query: { queryKey: getMatchConsultationLoanPlansQueryKey(consultation.id), enabled: mode === 'current', staleTime: 0, retry: 1 }
  });
  const historical = mode === 'historical';
  const activeQuery = historical ? history : current;
  const { isLoading, isError, refetch } = activeQuery;
  const data = historical ? history.data?.snapshot?.matches : current.data;

  const requestedAmount = historical ? history.data?.snapshot?.requestedAmount : consultation.requestedAmount;
  const requested = parseAmount(requestedAmount);
  const eligibleMatches = (data || []).filter(m => m.status === 'eligible');
  
  const unsuitable = (data || []).filter(m => m.status !== 'eligible');
  let packages: { plans: typeof eligibleMatches, total: number, id: string }[] = [];
  if (requested > 0 && eligibleMatches.length > 1) {
    const combos: typeof packages = [];
    for (let i = 0; i < eligibleMatches.length; i++) {
      for (let j = i + 1; j < eligibleMatches.length; j++) {
        const sum2 = parseAmount(eligibleMatches[i].customerMaximumAmount) + parseAmount(eligibleMatches[j].customerMaximumAmount);
        if (sum2 >= requested) {
          combos.push({ plans: [eligibleMatches[i], eligibleMatches[j]], total: sum2, id: `pkg-${eligibleMatches[i].plan.id}-${eligibleMatches[j].plan.id}` });
        }
        for (let k = j + 1; k < eligibleMatches.length; k++) {
           const sum3 = sum2 + parseAmount(eligibleMatches[k].customerMaximumAmount);
           if (sum3 >= requested) {
             combos.push({ plans: [eligibleMatches[i], eligibleMatches[j], eligibleMatches[k]], total: sum3, id: `pkg-${eligibleMatches[i].plan.id}-${eligibleMatches[j].plan.id}-${eligibleMatches[k].plan.id}` });
           }
        }
      }
    }
    combos.sort((a, b) => a.total - b.total);
    packages = combos.slice(0, 2);
  }

  return (
    <Modal title="تطابق طرح‌های تسهیلاتی" eyebrow={`پرونده ${customerNameText(consultation.customerName, consultation.customerId)} · کارشناس پرونده: ${consultation.customerSalespersonName || 'بدون تخصیص'}`} onClose={onClose} testId="matches-modal">
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button type="button" className={`btn ${historical ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={historical} onClick={() => setMode('historical')} data-testid="button-historical-matches">نتیجهٔ زمان ثبت مشاوره</button>
        <button type="button" className={`btn ${!historical ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={!historical} onClick={() => setMode('current')} data-testid="button-current-matches">ارزیابی با شرایط فعلی</button>
        {!historical && <button type="button" className="btn btn-ghost" onClick={() => void current.refetch()} disabled={current.isFetching}>محاسبهٔ دوباره</button>}
      </div>
      <p className="profile-form-note" style={{ fontSize: 12, lineHeight: 1.9 }}>
        در ارزیابی فعلی مشاوره، سفته، میانگین حساب و گردش حساب برای همه قابل ارائه و شغل ضامن منطبق فرض می‌شود؛ شرایط وثیقه و رتبه همچنان بررسی می‌شوند.
        {historical && ' نتیجهٔ تاریخی تغییر نمی‌کند؛ برای اعمال این سیاست روی مشاوره‌های قبلی، «ارزیابی با شرایط فعلی» را انتخاب کنید.'}
      </p>
      <p data-testid="text-match-source" style={{ fontSize: 12, color: '#475569' }}>
        {historical ? history.data?.snapshot
          ? `نتیجهٔ تاریخی ثبت‌شده در ${formatDateTime(history.data.snapshot.capturedAt)}؛ تغییر یا حذف طرح‌ها این نتیجه را تغییر نمی‌دهد.`
          : 'نتیجهٔ زمان ثبت مشاوره'
          : 'ارزیابی تازه با طرح‌ها و شرایط فعال فعلی؛ نتیجهٔ تاریخی بازنویسی نمی‌شود.'}
      </p>
      {isLoading ? (
        <SkeletonPanel rows={4} />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : historical && !history.data?.snapshot ? (
        <EmptyState title="نتیجهٔ تاریخی ثبت نشده است" description="این سابقه نتیجهٔ ذخیره‌شدهٔ زمان مشاوره ندارد. ارزیابی با شرایط فعلی را می‌توانید جداگانه مشاهده کنید؛ این ارزیابی جایگزین نتیجهٔ تاریخی نیست." />
      ) : !data || data.length === 0 ? (
        <EmptyState title="طرحی برای تطابق یافت نشد" description={historical ? 'در زمان ثبت این مشاوره هیچ طرح فعالی وجود نداشت.' : 'هیچ طرح فعالی برای بررسی شرایط این درخواست وجود ندارد.'} />
      ) : (
        <div className="match-list">
          <div className="match-section" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 12, marginBottom: 16 }}>
            <strong style={{ display: 'block', color: '#1e3a8a', fontSize: 12, marginBottom: 6 }}>ثبت درخواست فقط از مسیر احراز کامل انجام می‌شود</strong>
            <p style={{ margin: '0 0 10px', color: '#475569', fontSize: 11, lineHeight: 1.8 }}>
              نتیجه این صفحه صرفاً برای مشاوره است. برای احراز هویت، اعتبارسنجی ۲۴ ساعته، انتخاب شرط دقیق و بارگذاری مدارک هویتی از ویزارد درخواست تسهیلات استفاده کنید.
            </p>
            <Link href="/loan-applications" className="btn btn-primary" data-testid="link-open-secure-loan-wizard">
              رفتن به درخواست‌های تسهیلات
            </Link>
          </div>
          
          {packages.length > 0 && (
            <div className="packages-section" style={{ marginBottom: 20, padding: 16, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0' }}>
              <h4 style={{ margin: '0 0 12px', color: 'var(--ink-deep)' }}>بسته‌های پیشنهادی ترکیبی</h4>
              <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>برای رسیدن به مبلغ {requestedAmount} تومان، می‌توانید این طرح‌ها را همزمان پیش ببرید:</p>
              <div style={{ display: 'grid', gap: 12 }}>
                {packages.map(pkg => (
                  <div key={pkg.id} style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <strong style={{ color: 'var(--nafiss-blue)' }}>مجموع: {pkg.total.toLocaleString('fa-IR')}</strong>
                      <span className="inline-badge inactive">فقط پیشنهاد مشاوره</span>
                    </div>
                    <ul style={{ margin: 0, paddingRight: 20, fontSize: 12, color: '#475569' }}>
                      {pkg.plans.map(m => (
                        <li key={m.plan.id}>{m.plan.name} ({m.customerMaximumAmount ? `${Number(m.customerMaximumAmount).toLocaleString('fa-IR')} تومان` : 'سقف مشتری در این سابقه ثبت نشده'})</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {[{ key: 'eligible', title: 'طرح‌های قابل قبول', items: eligibleMatches }, { key: 'unsuitable', title: 'طرح‌های نامناسب', items: unsuitable }].map((group) => <div key={group.key} data-testid={`match-group-${group.key}`} style={{ marginBottom: 18 }}><h4 style={{ margin: '0 0 10px', color: 'var(--nafiss-blue)', fontSize: 13 }}>{group.title} ({group.items.length.toLocaleString('fa-IR')})</h4>{group.items.length === 0 ? <p style={{ fontSize: 12, color: '#64748b' }}>{group.key === 'eligible' ? 'طرح قابل قبولی پیدا نشد.' : 'طرح نامناسبی وجود ندارد.'}</p> : group.items.map((match, idx) => {
            const pidStr = `plan-${match.plan.id}`;
            const selectedCondition = match.plan.conditions?.find(condition => condition.id === match.matchedConditionId);
            const needsGuarantor = Boolean(selectedCondition
              ? selectedCondition.needsGuarantor || selectedCondition.needsGuarantorCheck ||
                selectedCondition.needsGuarantorPromissory || selectedCondition.needsGuarantorSalaryDeduct ||
                (selectedCondition.guarantorRanks && selectedCondition.guarantorRanks !== '[]') ||
                (selectedCondition.guarantorCollateralType && selectedCondition.guarantorCollateralType !== 'none')
              : match.plan.needsGuarantor);
            const documents = planDocumentGroups({ ...match.plan, needsGuarantor,
              ...(selectedCondition ? {
                customerCheck: selectedCondition.needsCustomerCheck || ['physical_check', 'digital_check'].includes(selectedCondition.collateralType ?? '') ? 'required' : 'none',
                guarantorCheck: selectedCondition.needsGuarantorCheck || ['physical_check', 'digital_check'].includes(selectedCondition.guarantorCollateralType ?? '') ? 'required' : 'none',
                needsCustomerPromissory: selectedCondition.needsCustomerPromissory || selectedCondition.collateralType === 'promissory',
                needsGuarantorPromissory: selectedCondition.needsGuarantorPromissory || selectedCondition.guarantorCollateralType === 'promissory',
                needsCustomerSalaryDeduct: selectedCondition.needsCustomerSalaryDeduct || selectedCondition.collateralType === 'salary_deduction',
                needsGuarantorSalaryDeduct: selectedCondition.needsGuarantorSalaryDeduct || selectedCondition.guarantorCollateralType === 'salary_deduction',
              } : {}),
            }, label);
            return (
              <div key={idx} className={`match-card ${match.status}`} data-testid={`match-card-${match.plan.id}`}>
                <div className="match-head">
                  <h4>{match.plan.name}</h4>
                  <span className="match-status-badge">
                    {match.status === 'eligible' ? 'واجد شرایط' : match.status === 'needs_review' ? 'نیازمند اطلاعات بیشتر' : 'عدم تطابق'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{match.plan.bankName || 'بدون بانک'} {match.plan.platformName ? `· ${match.plan.platformName}` : ''}</span>
                  <strong data-testid={`text-customer-maximum-${match.plan.id}`}>{match.customerMaximumAmount
                    ? `حداکثر قابل دریافت مشتری: ${Number(match.customerMaximumAmount).toLocaleString('fa-IR')} تومان`
                    : match.status === 'not_eligible' ? 'با این شرایط قابل دریافت نیست'
                    : historical && match.customerMaximumAmount === undefined ? 'سقف مشتری در این سابقه ثبت نشده'
                    : 'سقف مشتری پس از تکمیل بررسی مشخص می‌شود'}</strong>
                </div>
                
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12, lineHeight: 1.9 }}>
                  <div><span>نوع وام: {label('loan_type', match.plan.loanType)}</span> | <span>زمان دریافت: {label('grant_days', match.plan.grantDays)}</span></div>
                  <div><strong>مدارک مشتری:</strong> {documents.customer.join('، ') || 'مدرک خاصی ثبت نشده'}</div>
                  <div><strong>مدارک ضامن:</strong> {needsGuarantor ? documents.guarantor.join('، ') : 'نیاز ندارد'}</div>
                </div>
                
                {match.failedRequirements.length > 0 && (
                  <div className="match-section error-text" style={{ color: '#be123c', background: '#fff1f2', padding: 8, borderRadius: 6, marginBottom: 8 }}>
                    <strong style={{ fontSize: 11 }}>دلیل نامناسب بودن:</strong>
                    <ul style={{ margin: '4px 0 0', paddingRight: 20, fontSize: 11 }}>
                      {match.failedRequirements.map((req, i) => <li key={i}>{req}</li>)}
                    </ul>
                  </div>
                )}
                
                {match.missingInformation.length > 0 && (
                  <div className="match-section" style={{ color: '#b45309', background: '#fffbeb', padding: 8, borderRadius: 6, marginBottom: 8 }}>
                    <strong style={{ fontSize: 11 }}>برای ارزیابی قطعی لازم است:</strong>
                    <ul style={{ margin: '4px 0 0', paddingRight: 20, fontSize: 11 }}>
                      {match.missingInformation.map((info, i) => <li key={i}>{info}</li>)}
                    </ul>
                  </div>
                )}
                
                {match.status === 'eligible' && match.matchedConditionId && (
                  <div className="match-section" style={{ color: '#0f766e', fontSize: 11, marginBottom: 8 }}>
                    <CheckCircle2 size={14} style={{ display: 'inline', marginLeft: 4, verticalAlign: 'middle' }} />
                    مطابق شرایط اظهارشده از طریق مسیر شرطی؛ تأیید نهایی پس از بررسی پرونده.
                  </div>
                )}
                <details className="match-section" data-testid={`match-conditions-${match.plan.id}`}>
                  <summary style={{ fontSize: 12, cursor: 'pointer' }}>{historical ? 'شرایط طرح در زمان ثبت مشاوره' : 'شرایط فعلی استفاده‌شده در ارزیابی'}</summary>
                  {(match.plan.conditions ?? []).length === 0 ? <p>شرط احراز تعریف نشده است.</p> : (match.plan.conditions ?? []).map(condition => (
                    <div key={condition.id} style={{ padding: 8, fontSize: 11 }}>
                      <strong>شرط {condition.id.toLocaleString('fa-IR')}{condition.id === match.matchedConditionId ? ' · مسیر انتخاب‌شده' : ''}</strong>
                      <dl>{Object.entries(condition).map(([key, value]) => <div key={key} style={{ display: 'flex', gap: 8 }}>
                        <dt>{conditionLabels[key] ?? key}:</dt><dd style={{ margin: 0 }}>{value == null ? 'ثبت نشده' : typeof value === 'boolean' ? value ? 'بله' : 'خیر' : Array.isArray(value) ? value.join('، ') || 'بدون محدودیت' : String(value)}</dd>
                      </div>)}</dl>
                    </div>
                  ))}
                </details>
                
                {match.status === 'eligible' && (
                  <div style={{ marginTop: 12, borderTop: '1px solid #e2e8f0', paddingTop: 12, color: '#64748b', fontSize: 11 }}>
                    برای ثبت نهایی، از ویزارد امن درخواست تسهیلات استفاده کنید.
                  </div>
                )}
              </div>
            );
          })}</div>)}
        </div>
      )}
    </Modal>
  );
}

const conditionLabels: Record<string, string> = {
  id: 'شناسه شرط', planId: 'شناسه طرح', sortOrder: 'ترتیب',
  maxPrincipal: 'حداکثر مبلغ (تومان)', customerRanks: 'رتبه‌های مشتری',
  installmentOptions: 'تعداد اقساط', customerJobs: 'شغل‌های مشتری',
  collateralType: 'وثیقه مشتری', needsGuarantor: 'نیاز به ضامن',
  guarantorRanks: 'رتبه‌های ضامن', guarantorJobs: 'شغل‌های ضامن',
  guarantorCollateralType: 'وثیقه ضامن', needsCustomerPromissory: 'سفته مشتری',
  needsGuarantorPromissory: 'سفته ضامن', needsCustomerSalaryDeduct: 'کسر حقوق مشتری',
  needsGuarantorSalaryDeduct: 'کسر حقوق ضامن', needsCustomerCheck: 'چک مشتری',
  needsGuarantorCheck: 'چک ضامن', customerCheck: 'نوع چک مشتری',
  guarantorCheck: 'نوع چک ضامن', contractTemplateId: 'شناسه قالب قرارداد',
  platformCompanyName: 'شرکت پلتفرم', goodsStoreName: 'فروشگاه کالا',
  commissionPercent: 'درصد پورسانت', operationCostsPercent: 'درصد هزینه عملیات',
  grantedDiscountPercent: 'درصد تخفیف', purchaseCommissionPercent: 'درصد پورسانت خرید',
  salesCommissionPercent: 'درصد پورسانت فروش', loanAcquisitionFeePercent: 'درصد هزینه دریافت تسهیلات',
  penaltyMode: 'نوع جریمه', penaltyValue: 'مقدار جریمه', contractDurationDays: 'مدت قرارداد (روز)',
  notes: 'یادداشت', name: 'نام شرط',
};
