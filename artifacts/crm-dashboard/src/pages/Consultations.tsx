import { ClipboardList, Edit3, Save, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListConsultationsQueryKey, useListConsultations, useListCustomers, useUpdateConsultation, useMatchConsultationLoanPlans, getMatchConsultationLoanPlansQueryKey, useListConsultOptions, getListConsultOptionsQueryKey, useCreateConsultationLoanApplication, type Consultation, type ConsultationUpdate, type LoanPlan } from '@workspace/api-client-react';
import { ErrorState, formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Modal, Pagination, SearchField } from '@/components/DataTools';

const limit = 8;
export default function Consultations() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Consultation | null>(null);
  const [matching, setMatching] = useState<Consultation | null>(null);
  const params = { search: search || undefined, limit, offset };
  const query = useListConsultations(params, { query: { queryKey: getListConsultationsQueryKey(params) } });
  const customers = useListCustomers({ limit: 100 }, { query: { queryKey: ['consultation-customers', 100], staleTime: 60_000 } });
  const update = useUpdateConsultation();
  const save = (data: ConsultationUpdate) => { if (!editing) return; const consultationId = editing.id; update.mutate({ id: consultationId, data }, { onSuccess: () => { setEditing(null); queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() }); queryClient.invalidateQueries({ queryKey: getMatchConsultationLoanPlansQueryKey(consultationId) }); } }); };
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">ارزیابی مالی</div><h2>درخواست‌های مشاوره</h2><p>درخواست‌ها را با زمینه مشتری و شاخص‌های مالی کنار هم ببینید.</p></div><div className="data-summary"><ClipboardList size={17} /><span>در صف بررسی</span><strong data-testid="text-total-consultations">{(query.data?.total ?? 0).toLocaleString('fa-IR')}</strong></div></div>
    <div className="data-toolbar"><div className="toolbar"><SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="جست‌وجو بر اساس نام مشتری یا شماره تماس..." testId="consultations" /></div></div>
    {query.isLoading ? <SkeletonPanel rows={6} /> : query.isError ? <ErrorState onRetry={() => query.refetch()} /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>مشتری</th><th>مبلغ درخواستی</th><th>هدف و شغل</th><th>شاخص‌های اعتبار</th><th>آخرین تغییر</th><th>عملیات</th></tr></thead><tbody>{(query.data?.items ?? []).length ? query.data?.items.map((item) => <tr key={item.id} data-testid={`row-consultation-${item.id}`}><td><span className="primary-cell">{item.customerName}</span><span className="secondary-cell mono">{item.customerPhone}</span></td><td><span className="primary-cell">{item.requestedAmount || 'ثبت نشده'}</span><span className="secondary-cell">{item.loanPref || 'نوع تسهیلات مشخص نشده'}</span></td><td><span className="primary-cell">{item.loanPurpose || 'بدون هدف ثبت‌شده'}</span><span className="secondary-cell">{item.jobType || 'شغل ثبت نشده'}</span></td><td><span className={`inline-badge ${item.creditRank ? 'gold' : 'inactive'}`}>{item.creditRank ? `رتبه ${item.creditRank}` : 'رتبه نامشخص'}</span><span className="secondary-cell">{item.hasGuarantor ? 'ضامن دارد' : 'بدون ضامن'}</span></td><td className="secondary-cell" data-testid={`text-consultation-date-${item.id}`}>{formatDateTime(item.updatedAt)}</td><td><div style={{display: 'flex', gap: 8}}><button className="table-action" onClick={() => setMatching(item)} data-testid={`button-match-consultation-${item.id}`}><ShieldCheck size={14} /> تطابق</button><button className="table-action" onClick={() => setEditing(item)} data-testid={`button-edit-consultation-${item.id}`}><Edit3 size={14} /> ویرایش</button></div></td></tr>) : <tr><td colSpan={6}><EmptyState title="درخواست مشاوره‌ای پیدا نشد" description="با تغییر جست‌وجو یا ثبت درخواست جدید از سمت تیم، این فهرست تکمیل می‌شود." /></td></tr>}</tbody></table><Pagination total={query.data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} testId="consultations" /></div>}
    {editing ? <ConsultationForm consultation={editing} customers={customers.data?.items ?? []} pending={update.isPending} onClose={() => setEditing(null)} onSave={save} /> : null}
    {matching ? <MatchesModal consultation={matching} onClose={() => setMatching(null)} /> : null}
  </section>;
}

function ConsultationForm({ consultation, customers, pending, onClose, onSave }: { consultation: Consultation; customers: { id: number; name: string; phone: string }[]; pending: boolean; onClose: () => void; onSave: (data: ConsultationUpdate) => void }) {
  const [form, setForm] = useState({
    customerId: String(consultation.customerId), requestedAmount: consultation.requestedAmount ?? '', loanPurpose: consultation.loanPurpose ?? '', jobType: consultation.jobType ?? '', creditRank: consultation.creditRank ?? '', collateralType: consultation.collateralType ?? '', loanPref: consultation.loanPref ?? '', needDays: consultation.needDays ?? '', receiveMode: consultation.receiveMode ?? '', extraNotes: consultation.extraNotes ?? '',
    guarantorCreditRank: consultation.guarantorCreditRank ?? '', guarantorCheckType: consultation.guarantorCheckType ?? '', guarantorJobType: consultation.guarantorJobType ?? '', guarantorCollateralType: consultation.guarantorCollateralType ?? '',
    hasCheck: Boolean(consultation.hasCheck), hasPromissory: Boolean(consultation.hasPromissory), hasGuarantor: Boolean(consultation.hasGuarantor), hasBusinessLicense: Boolean(consultation.hasBusinessLicense), hasAccountTurnover: Boolean(consultation.hasAccountTurnover), needsFastReceive: Boolean(consultation.needsFastReceive), hasAvgBalance: Boolean(consultation.hasAvgBalance),
    hasGuarantorCheck: Boolean(consultation.hasGuarantorCheck), hasGuarantorPromissory: Boolean(consultation.hasGuarantorPromissory), hasCustomerSalaryDeduct: Boolean(consultation.hasCustomerSalaryDeduct), hasGuarantorSalaryDeduct: Boolean(consultation.hasGuarantorSalaryDeduct)
  });
  
  const { data: options } = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: Infinity } });
  
  const setValue = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { 
    event.preventDefault(); 
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
  const ranks = options?.filter(o => o.fieldKey === 'credit_rank') ?? [];
  const guarantorRanks = options?.filter(o => o.fieldKey === 'guarantor_credit_rank') ?? [];
  const checks = options?.filter(o => o.fieldKey === 'guarantor_check_type') ?? [];
  const loans = options?.filter(o => o.fieldKey === 'loan_pref') ?? [];
  const collaterals = options?.filter(o => o.fieldKey === 'collateral_type') ?? [];
  const guarantorChoices = options?.filter(o => o.fieldKey === 'has_guarantor') ?? [];

  return <Modal title="ویرایش درخواست مشاوره" eyebrow={`پرونده ${consultation.customerName}`} onClose={onClose} testId="consultation-form"><form onSubmit={submit}><div className="form-grid"><div className="field full"><label htmlFor="consult-customer">مشتری</label><select id="consult-customer" value={form.customerId} onChange={(event) => setValue('customerId', event.target.value)} data-testid="select-consultation-customer">{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone}</option>)}</select></div><div className="field"><label htmlFor="consult-amount">مبلغ درخواستی</label><input id="consult-amount" value={form.requestedAmount} onChange={(event) => setValue('requestedAmount', event.target.value)} data-testid="input-consultation-amount" /></div><div className="field"><label htmlFor="consult-purpose">هدف تسهیلات</label><input id="consult-purpose" value={form.loanPurpose} onChange={(event) => setValue('loanPurpose', event.target.value)} data-testid="input-consultation-purpose" /></div><div className="field"><label htmlFor="consult-job">شغل مشتری</label><select id="consult-job" value={form.jobType} onChange={(event) => setValue('jobType', event.target.value)} data-testid="input-consultation-job"><option value="">انتخاب کنید</option>{jobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label htmlFor="consult-rank">رتبه اعتباری مشتری</label><select id="consult-rank" value={form.creditRank} onChange={(event) => setValue('creditRank', event.target.value)} data-testid="input-consultation-rank"><option value="">انتخاب کنید</option>{ranks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>وثیقه مشتری</label><select value={form.collateralType} onChange={(e) => setValue('collateralType', e.target.value)} data-testid="input-consultation-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field full"><label className="boolean-field">ضامن دارد<input type="checkbox" checked={form.hasGuarantor} onChange={e => setForm(f => ({ ...f, hasGuarantor: e.target.checked }))} data-testid="checkbox-consultation-hasGuarantor" /></label></div>{form.hasGuarantor && <><div className="field"><label>شغل ضامن</label><select value={form.guarantorJobType} onChange={(e) => setValue('guarantorJobType', e.target.value)} data-testid="input-consultation-guarantor-job"><option value="">انتخاب کنید</option>{jobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>رتبه اعتباری ضامن</label><select value={form.guarantorCreditRank} onChange={(e) => setValue('guarantorCreditRank', e.target.value)} data-testid="input-consultation-guarantor-rank"><option value="">انتخاب کنید</option>{ranks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>نوع چک ضامن</label><select value={form.guarantorCheckType} onChange={(e) => setValue('guarantorCheckType', e.target.value)} data-testid="input-consultation-guarantor-check-type"><option value="">انتخاب کنید</option>{checks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>وثیقه ضامن</label><select value={form.guarantorCollateralType} onChange={(e) => setValue('guarantorCollateralType', e.target.value)} data-testid="input-consultation-guarantor-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div></>}<div className="field"><label htmlFor="consult-loan">ترجیح تسهیلات</label><select id="consult-loan" value={form.loanPref} onChange={(event) => setValue('loanPref', event.target.value)} data-testid="input-consultation-loan"><option value="">انتخاب کنید</option>{loans.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label htmlFor="consult-days">مدت مورد نیاز</label><input id="consult-days" value={form.needDays} onChange={(event) => setValue('needDays', event.target.value)} data-testid="input-consultation-days" /></div><div className="field"><label htmlFor="consult-receive">شیوه دریافت</label><input id="consult-receive" value={form.receiveMode} onChange={(event) => setValue('receiveMode', event.target.value)} data-testid="input-consultation-receive" /></div><div className="field full"><label>شاخص‌های مالی و مدارک</label><div className="boolean-grid">{booleans.map(([key, label]) => <label className="boolean-field" key={String(key)}>{label}<input type="checkbox" checked={Boolean(form[key])} onChange={(event) => setValue(key, event.target.checked)} data-testid={`checkbox-consultation-${String(key)}`} /></label>)}</div></div><div className="field full"><label htmlFor="consult-notes">یادداشت تکمیلی</label><textarea id="consult-notes" value={form.extraNotes} onChange={(event) => setValue('extraNotes', event.target.value)} data-testid="textarea-consultation-notes" /></div></div><div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-consultation"><Save size={15} />{pending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button><button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-consultation">انصراف</button></div></form></Modal>;
}

function parseAmount(amt?: string | null) {
  if (!amt) return 0;
  const digits = amt.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) & 0xf)).replace(/[^0-9]/g, '');
  return parseInt(digits, 10) || 0;
}

function planDocumentGroups(plan: LoanPlan) {
  const customer = [...(plan.requiredDocuments ?? [])];
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
  const { data, isLoading, isError, refetch } = useMatchConsultationLoanPlans(consultation.id, {
    query: { queryKey: getMatchConsultationLoanPlansQueryKey(consultation.id), enabled: true, retry: 1 }
  });
  
  const createApp = useCreateConsultationLoanApplication();
  const [createdPlans, setCreatedPlans] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const requested = parseAmount(consultation.requestedAmount);
  const eligibleMatches = (data || []).filter(m => m.status === 'eligible');
  
  let packages: { plans: typeof eligibleMatches, total: number, id: string }[] = [];
  if (requested > 0 && eligibleMatches.length > 1) {
    const combos: typeof packages = [];
    for (let i = 0; i < eligibleMatches.length; i++) {
      for (let j = i + 1; j < eligibleMatches.length; j++) {
        const sum2 = parseAmount(eligibleMatches[i].plan.principalAmount) + parseAmount(eligibleMatches[j].plan.principalAmount);
        if (sum2 >= requested) {
          combos.push({ plans: [eligibleMatches[i], eligibleMatches[j]], total: sum2, id: `pkg-${eligibleMatches[i].plan.id}-${eligibleMatches[j].plan.id}` });
        }
        for (let k = j + 1; k < eligibleMatches.length; k++) {
           const sum3 = sum2 + parseAmount(eligibleMatches[k].plan.principalAmount);
           if (sum3 >= requested) {
             combos.push({ plans: [eligibleMatches[i], eligibleMatches[j], eligibleMatches[k]], total: sum3, id: `pkg-${eligibleMatches[i].plan.id}-${eligibleMatches[j].plan.id}-${eligibleMatches[k].plan.id}` });
           }
        }
      }
    }
    combos.sort((a, b) => a.total - b.total);
    packages = combos.slice(0, 2);
  }

  const handleCreateApp = (planIds: number[], pkgId: string) => {
    setErrorMsg('');
    createApp.mutate({ 
      id: consultation.id, 
      data: { 
        planIds,
        planId: planIds[0],
        customerId: consultation.customerId,
        requestedAmount: consultation.requestedAmount || '0',
        durationMonths: 12
      } 
    }, {
      onSuccess: () => {
        setCreatedPlans(prev => [...prev, pkgId]);
      },
      onError: (err) => {
        setErrorMsg(err instanceof Error ? err.message : 'خطا در ثبت درخواست');
      }
    });
  };

  return (
    <Modal title="تطابق طرح‌های تسهیلاتی" eyebrow={`پرونده ${consultation.customerName}`} onClose={onClose} testId="matches-modal">
      {isLoading ? (
        <SkeletonPanel rows={4} />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="طرحی برای تطابق یافت نشد" description="هیچ طرح فعالی برای بررسی شرایط این درخواست وجود ندارد." />
      ) : (
        <div className="match-list">
          {errorMsg && <div className="error-state" style={{ marginBottom: 12 }}>{errorMsg}</div>}
          
          {packages.length > 0 && (
            <div className="packages-section" style={{ marginBottom: 20, padding: 16, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0' }}>
              <h4 style={{ margin: '0 0 12px', color: 'var(--ink-deep)' }}>بسته‌های پیشنهادی ترکیبی</h4>
              <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>برای رسیدن به مبلغ {consultation.requestedAmount}، می‌توانید این طرح‌ها را همزمان پیش ببرید:</p>
              <div style={{ display: 'grid', gap: 12 }}>
                {packages.map(pkg => (
                  <div key={pkg.id} style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <strong style={{ color: 'var(--nafiss-blue)' }}>مجموع: {pkg.total.toLocaleString('fa-IR')}</strong>
                      <button 
                        className="btn btn-primary" 
                        onClick={() => handleCreateApp(pkg.plans.map(m => m.plan.id), pkg.id)}
                        disabled={createApp.isPending || createdPlans.includes(pkg.id)}
                      >
                        {createdPlans.includes(pkg.id) ? 'درخواست ثبت شد' : createApp.isPending ? 'در حال ثبت...' : 'ثبت درخواست ترکیبی'}
                      </button>
                    </div>
                    <ul style={{ margin: 0, paddingRight: 20, fontSize: 12, color: '#475569' }}>
                      {pkg.plans.map(m => (
                        <li key={m.plan.id}>{m.plan.name} ({m.plan.principalAmount || 'نامشخص'})</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.map((match, idx) => {
            const pidStr = `plan-${match.plan.id}`;
            const documents = planDocumentGroups(match.plan);
            return (
              <div key={idx} className={`match-card ${match.status}`} data-testid={`match-card-${match.plan.id}`}>
                <div className="match-head">
                  <h4>{match.plan.name}</h4>
                  <span className="match-status-badge">
                    {match.status === 'eligible' ? 'واجد شرایط' : match.status === 'needs_review' ? 'نیازمند بررسی' : 'عدم تطابق'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{match.plan.bankName || 'بدون بانک'} {match.plan.platformName ? `· ${match.plan.platformName}` : ''}</span>
                  <strong>{match.plan.principalAmount || 'مبلغ نامشخص'}</strong>
                </div>
                
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12, lineHeight: 1.9 }}>
                  <div><span>نوع وام: {match.plan.loanType || '-'}</span> | <span>زمان دریافت: {match.plan.grantDays || '-'}</span></div>
                  <div><strong>مدارک مشتری:</strong> {documents.customer.join('، ') || 'مدرک خاصی ثبت نشده'}</div>
                  <div><strong>مدارک ضامن:</strong> {match.plan.needsGuarantor ? documents.guarantor.join('، ') : 'نیاز ندارد'}</div>
                </div>
                
                {match.failedRequirements.length > 0 && (
                  <div className="match-section error-text" style={{ color: '#be123c', background: '#fff1f2', padding: 8, borderRadius: 6, marginBottom: 8 }}>
                    <strong style={{ fontSize: 11 }}>شروط پاس‌نشده:</strong>
                    <ul style={{ margin: '4px 0 0', paddingRight: 20, fontSize: 11 }}>
                      {match.failedRequirements.map((req, i) => <li key={i}>{req}</li>)}
                    </ul>
                  </div>
                )}
                
                {match.missingInformation.length > 0 && (
                  <div className="match-section" style={{ color: '#b45309', background: '#fffbeb', padding: 8, borderRadius: 6, marginBottom: 8 }}>
                    <strong style={{ fontSize: 11 }}>اطلاعات ناقص (نیاز به تکمیل فرم):</strong>
                    <ul style={{ margin: '4px 0 0', paddingRight: 20, fontSize: 11 }}>
                      {match.missingInformation.map((info, i) => <li key={i}>{info}</li>)}
                    </ul>
                  </div>
                )}
                
                {match.status === 'eligible' && match.matchedConditionId && (
                  <div className="match-section" style={{ color: '#0f766e', fontSize: 11, marginBottom: 8 }}>
                    <CheckCircle2 size={14} style={{ display: 'inline', marginLeft: 4, verticalAlign: 'middle' }} />
                    تایید شده از طریق مسیر شرطی جایگزین.
                  </div>
                )}
                
                {match.status === 'eligible' && (
                  <div style={{ marginTop: 12, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                    <button 
                      className="btn btn-gold" 
                      style={{ width: '100%' }}
                      onClick={() => handleCreateApp([match.plan.id], pidStr)}
                      disabled={createApp.isPending || createdPlans.includes(pidStr)}
                    >
                      {createdPlans.includes(pidStr) ? 'درخواست ثبت شد' : createApp.isPending ? 'در حال ثبت...' : 'ثبت درخواست برای این طرح'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
