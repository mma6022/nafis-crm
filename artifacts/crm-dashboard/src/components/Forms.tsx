import { useState, type FormEvent } from 'react';
import { BellPlus, FileText, PhoneCall, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Modal } from '@/components/DataTools';
import { defaultReminderJalali, formatJalaliValue, jalaliToIso, parseJalaliValue } from '@/lib/jalali';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { CallHistoryModal, CustomerCallHistory } from '@/components/CallHistory';
import { getListCustomersQueryKey, getListRemindersQueryKey, useCreateReminder, useListCustomers, useGetAuthSession, getGetAuthSessionQueryKey, useListConsultOptions, getListConsultOptionsQueryKey, type CallInput, type CallRecord, type ConsultationInput } from '@workspace/api-client-react';
import { ConsultationAiAssistant } from './ConsultationAiAssistant';

type CallFormProps = {
  customers: { id: number; name: string; phone: string; priority?: number | null; status?: string; nationalCode?: string | null; postalCode?: string | null; birthDateJalali?: string | null; verificationStatus?: string; isUrgent?: boolean }[];
  salespersons: { id: number; name: string }[];
  pending: boolean;
  error?: boolean;
  initialCustomerId?: number;
  onClose: () => void;
  onSave: (data: CallInput) => Promise<void>;
};

export function CallForm({ customers, salespersons, pending, error, initialCustomerId, onClose, onSave }: CallFormProps) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), staleTime: Infinity } });
  const hasAiPermission = session?.user?.role === 'admin' || session?.user?.permissions?.includes('consultation_ai.use');

  const defaultReminder = defaultReminderJalali();
  const initialCustomer = customers.find((customer) => customer.id === initialCustomerId);
  const [form, setForm] = useState({
    customerId: initialCustomerId ? String(initialCustomerId) : '',
    salespersonId: '',
    subject: '',
    customerRequest: '',
    expertNotes: '',
    nationalCode: initialCustomer?.nationalCode ?? '',
    postalCode: initialCustomer?.postalCode ?? '',
    birthDateJalali: initialCustomer?.birthDateJalali ?? '',
  });
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminder, setReminder] = useState({
    subject: '',
    message: '',
    date: formatJalaliValue(defaultReminder.year, defaultReminder.month, defaultReminder.day),
    hour: defaultReminder.hour,
    minute: defaultReminder.minute,
  });
  const [reminderError, setReminderError] = useState('');
  const [historyCall, setHistoryCall] = useState<CallRecord | null>(null);
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const selectedCustomer = customers.find((customer) => customer.id === Number(form.customerId));
  const selectCustomer = (value: string) => {
    const customer = customers.find((item) => item.id === Number(value));
    setForm((current) => ({
      ...current,
      customerId: value,
      nationalCode: customer?.nationalCode ?? '',
      postalCode: customer?.postalCode ?? '',
      birthDateJalali: customer?.birthDateJalali ?? '',
    }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.customerId) return;
    let reminderInput: { subject: string; message: string; remindAt: string } | undefined;
    if (reminderOpen) {
      const dateParts = parseJalaliValue(reminder.date);
      const remindAt = jalaliToIso(
        dateParts?.year ?? 0,
        dateParts?.month ?? 0,
        dateParts?.day ?? 0,
        Number(reminder.hour),
        Number(reminder.minute),
      );
      if (!reminder.subject.trim() || !reminder.message.trim()) {
        setReminderError('موضوع و متن یادآور را وارد کنید.');
        return;
      }
      if (!remindAt) {
        setReminderError('تاریخ یا ساعت شمسی معتبر نیست.');
        return;
      }
      if (new Date(remindAt).getTime() <= Date.now()) {
        setReminderError('زمان یادآور باید بعد از زمان فعلی باشد.');
        return;
      }
      reminderInput = {
        subject: reminder.subject.trim(),
        message: reminder.message.trim(),
        remindAt,
      };
    }
    setReminderError('');
    onSave({
      customerId: Number(form.customerId),
      salespersonId: form.salespersonId ? Number(form.salespersonId) : null,
      subject: form.subject.trim(),
      customerRequest: form.customerRequest.trim(),
      expertNotes: form.expertNotes.trim(),
      reminder: reminderInput,
      profile: {
        nationalCode: form.nationalCode.trim() || null,
        postalCode: form.postalCode.trim() || null,
        birthDateJalali: form.birthDateJalali.trim() || null,
      }
    }).catch(() => {});
  };

  const showAi = hasAiPermission && !!form.customerId;

  return (
    <Modal title="ثبت تماس جدید" eyebrow="ثبت در خط زمانی" onClose={onClose} testId={showAi ? "call-form-with-ai" : "call-form"}>
      <div className={showAi ? "call-form-layout" : ""}>
        <div className={showAi ? "call-form-main" : ""}>
          <form onSubmit={submit}>
            {error ? <div className="profile-form-error" data-testid="error-call-submit" style={{ marginBottom: '14px' }}>ثبت تماس با خطا مواجه شد. لطفاً دوباره تلاش کنید.</div> : null}
            <div className="form-grid">
              <div className="field full">
            <label htmlFor="call-customer">مشتری</label>
            <select id="call-customer" value={form.customerId} onChange={(event) => selectCustomer(event.target.value)} required data-testid="select-call-customer" disabled={!!initialCustomerId}>
              <option value="">یک مشتری را انتخاب کنید</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name} · {customer.phone}
                </option>
              ))}
            </select>
            {selectedCustomer && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', fontSize: '10px' }}>
                {selectedCustomer.isUrgent && <span style={{ padding: '2px 6px', borderRadius: '10px', background: '#fee2e2', color: '#b91c1c' }}>فوری</span>}
                {selectedCustomer.verificationStatus === 'unverified' && <span style={{ padding: '2px 6px', borderRadius: '10px', background: '#fef3c7', color: '#b45309' }}>احراز نشده</span>}
              </div>
            )}
          </div>
          <div className="field full call-form-history-panel">
            <div className="call-form-history-head">
              <div><label>تماس‌های قبلی مشتری</label><p>برای مشاهده متن کامل و ترتیب تماس‌ها روی هر ردیف کلیک کنید.</p></div>
            </div>
            <CustomerCallHistory
              customerId={form.customerId ? Number(form.customerId) : undefined}
              customerName={selectedCustomer?.name}
              compact
              onSelectCall={setHistoryCall}
            />
          </div>
          <div className="field full" style={{ padding: '16px', background: '#f8fafc', borderRadius: '12px', border: '1px solid #e2e8f0', marginBottom: '8px' }}>
            <div style={{ marginBottom: '12px', fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>تکمیل اطلاعات مشتری (اختیاری)</div>
            <div className="form-grid">
              <div className="field"><label>کد ملی</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => update('nationalCode', e.target.value)} maxLength={10} data-testid="input-call-national-code" /></div>
              <div className="field"><label>کد پستی</label><input dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => update('postalCode', e.target.value)} maxLength={10} data-testid="input-call-postal-code" /></div>
              <div className="field"><label>تاریخ تولد</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => update('birthDateJalali', v)} testId="input-call-birth-date" /></div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="call-salesperson">کارشناس فروش</label>
            <select id="call-salesperson" value={form.salespersonId} onChange={(event) => update('salespersonId', event.target.value)} data-testid="select-call-salesperson">
              <option value="">بدون تخصیص</option>
              {salespersons.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="call-subject">موضوع تماس</label>
            <input id="call-subject" value={form.subject} onChange={(event) => update('subject', event.target.value)} placeholder="مثلاً پیگیری مدارک" data-testid="input-call-subject" />
          </div>
          <div className="field full">
            <label htmlFor="call-request">درخواست مشتری</label>
            <textarea id="call-request" value={form.customerRequest} onChange={(event) => update('customerRequest', event.target.value)} data-testid="textarea-call-request" />
          </div>
          <div className="field full">
            <label htmlFor="call-notes">یادداشت کارشناس</label>
            <textarea id="call-notes" value={form.expertNotes} onChange={(event) => update('expertNotes', event.target.value)} data-testid="textarea-call-notes" />
          </div>
        </div>

        {reminderOpen ? (
          <div className="reminder-inline-panel" data-testid="panel-call-reminder">
            <div className="reminder-inline-title"><BellPlus size={16} /> یادآور این مشتری</div>
            {reminderError ? <div className="profile-form-error" data-testid="error-call-reminder">{reminderError}</div> : null}
            <div className="form-grid">
              <div className="field full">
                <label htmlFor="reminder-subject">موضوع یادآور</label>
                <input id="reminder-subject" value={reminder.subject} maxLength={160} onChange={(event) => setReminder({ ...reminder, subject: event.target.value })} data-testid="input-reminder-subject" />
              </div>
              <div className="field full">
                <label htmlFor="reminder-message">متن یادآور</label>
                <textarea id="reminder-message" value={reminder.message} maxLength={2000} onChange={(event) => setReminder({ ...reminder, message: event.target.value })} data-testid="textarea-reminder-message" />
              </div>
              <div className="field full">
                <label>تاریخ شمسی</label>
                <PersianDatePicker value={reminder.date} onChange={(value) => setReminder({ ...reminder, date: value })} placeholder="انتخاب تاریخ یادآور" testId="input-reminder-date" />
              </div>
              <div className="field full">
                <label>ساعت</label>
                <div className="reminder-time-grid">
                  <input type="number" min="0" max="23" value={reminder.hour} onChange={(event) => setReminder({ ...reminder, hour: event.target.value })} aria-label="ساعت" data-testid="input-reminder-hour" />
                  <span>:</span>
                  <input type="number" min="0" max="59" value={reminder.minute} onChange={(event) => setReminder({ ...reminder, minute: event.target.value })} aria-label="دقیقه" data-testid="input-reminder-minute" />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="form-footer call-form-footer">
          <div className="form-footer-actions">
            <button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-call">
              <PhoneCall size={15} />{pending ? 'در حال ثبت...' : 'ثبت تماس'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-call">انصراف</button>
          </div>
          <button className={`btn reminder-toggle ${reminderOpen ? 'active' : ''}`} type="button" onClick={() => setReminderOpen((value) => !value)} data-testid="button-toggle-call-reminder">
            <BellPlus size={15} /> {reminderOpen ? 'حذف یادآور' : 'افزودن یادآور'}
          </button>
        </div>
      </form>
      </div>
      {showAi ? (
        <div className="call-form-sidebar">
          <ConsultationAiAssistant 
            customerId={Number(form.customerId)} 
            onInsertNote={(text) => update('expertNotes', form.expertNotes ? form.expertNotes + '\n\n' + text : text)} 
          />
        </div>
      ) : null}
      </div>
      {historyCall ? (
        <CallHistoryModal
          customerId={Number(form.customerId)}
          customerName={historyCall.customerName}
          customerPhone={historyCall.customerPhone}
          selectedCallId={historyCall.id}
          onClose={() => setHistoryCall(null)}
        />
      ) : null}
    </Modal>
  );
}

export function CreateConsultationForm({ customers, pending, initialCustomerId, onClose, onSave }: { customers: { id: number; name: string; phone: string }[]; pending: boolean; initialCustomerId?: number; onClose: () => void; onSave: (data: ConsultationInput) => void }) {
  const [form, setForm] = useState({ 
    customerId: initialCustomerId ? String(initialCustomerId) : '', requestedAmount: '', loanPurpose: '', loanPref: '', jobType: '', creditRank: '', collateralType: '', 
    hasGuarantor: false, guarantorCreditRank: '', guarantorJobType: '', guarantorCollateralType: '', guarantorCheckType: '',
    hasCheck: false, hasPromissory: false, hasBusinessLicense: false, hasAccountTurnover: false, needsFastReceive: false, hasAvgBalance: false,
    hasGuarantorCheck: false, hasGuarantorPromissory: false, hasCustomerSalaryDeduct: false, hasGuarantorSalaryDeduct: false
  });
  const { data: options } = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: Infinity } });
  
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.customerId) return;
    onSave({
      customerId: Number(form.customerId),
      requestedAmount: form.requestedAmount.trim() || undefined,
      loanPurpose: form.loanPurpose.trim() || undefined,
      loanPref: form.loanPref.trim() || undefined,
      jobType: form.jobType.trim() || undefined,
      creditRank: form.creditRank.trim() || undefined,
      collateralType: form.collateralType.trim() || undefined,
      hasGuarantor: form.hasGuarantor,
      guarantorCreditRank: form.hasGuarantor ? (form.guarantorCreditRank.trim() || undefined) : undefined,
      guarantorJobType: form.hasGuarantor ? (form.guarantorJobType.trim() || undefined) : undefined,
      guarantorCollateralType: form.hasGuarantor ? (form.guarantorCollateralType.trim() || undefined) : undefined,
      guarantorCheckType: form.hasGuarantor ? (form.guarantorCheckType.trim() || undefined) : undefined,
      hasCheck: form.hasCheck, hasPromissory: form.hasPromissory, hasBusinessLicense: form.hasBusinessLicense, hasAccountTurnover: form.hasAccountTurnover, needsFastReceive: form.needsFastReceive, hasAvgBalance: form.hasAvgBalance,
      hasGuarantorCheck: form.hasGuarantor ? form.hasGuarantorCheck : false, hasGuarantorPromissory: form.hasGuarantor ? form.hasGuarantorPromissory : false,
      hasCustomerSalaryDeduct: form.hasCustomerSalaryDeduct, hasGuarantorSalaryDeduct: form.hasGuarantor ? form.hasGuarantorSalaryDeduct : false
    });
  };
  
  const jobs = options?.filter(o => o.fieldKey === 'job_type') ?? [];
  const guarantorJobs = options?.filter(o => o.fieldKey === 'guarantor_job_type') ?? [];
  const loans = options?.filter(o => o.fieldKey === 'loan_pref') ?? [];
  const ranks = options?.filter(o => o.fieldKey === 'credit_rank') ?? [];
  const guarantorRanks = options?.filter(o => o.fieldKey === 'guarantor_credit_rank') ?? [];
  const collaterals = options?.filter(o => o.fieldKey === 'collateral_type') ?? [];
  const checks = options?.filter(o => o.fieldKey === 'guarantor_check_type') ?? [];
  const guarantorChoices = options?.filter(o => o.fieldKey === 'has_guarantor') ?? [];

  let booleans: [keyof typeof form, string][] = [['hasCheck','چک مشتری'],['hasPromissory','سفته مشتری'],['hasCustomerSalaryDeduct', 'کسر حقوق مشتری'],['hasBusinessLicense','جواز کسب دارد'],['hasAccountTurnover','گردش حساب دارد'],['hasAvgBalance','میانگین موجودی دارد'],['needsFastReceive','دریافت سریع لازم است']];
  if (form.hasGuarantor) {
    booleans = [...booleans, ['hasGuarantorCheck', 'چک ضامن'],['hasGuarantorPromissory', 'سفته ضامن'],['hasGuarantorSalaryDeduct', 'کسر حقوق ضامن']];
  }

  return <Modal title="ثبت درخواست مشاوره" eyebrow="ارزیابی مالی جدید" onClose={onClose} testId="create-consultation-form"><form onSubmit={submit}><div className="form-grid"><div className="field full"><label>مشتری</label><select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))} required disabled={!!initialCustomerId} data-testid="select-consultation-customer"><option value="">انتخاب مشتری</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}</select></div><div className="field"><label>مبلغ درخواستی</label><input value={form.requestedAmount} onChange={e => setForm(f => ({ ...f, requestedAmount: e.target.value }))} data-testid="input-consultation-amount" /></div><div className="field"><label>هدف تسهیلات</label><input value={form.loanPurpose} onChange={e => setForm(f => ({ ...f, loanPurpose: e.target.value }))} data-testid="input-consultation-purpose" /></div><div className="field"><label>نوع تسهیلات درخواستی</label><select value={form.loanPref} onChange={e => setForm(f => ({ ...f, loanPref: e.target.value }))} data-testid="input-consultation-loan-pref"><option value="">انتخاب کنید</option>{loans.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>شغل مشتری</label><select value={form.jobType} onChange={e => setForm(f => ({ ...f, jobType: e.target.value }))} data-testid="input-consultation-job"><option value="">انتخاب کنید</option>{jobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>رتبه اعتباری مشتری</label><select value={form.creditRank} onChange={e => setForm(f => ({ ...f, creditRank: e.target.value }))} data-testid="input-consultation-rank"><option value="">انتخاب کنید</option>{ranks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>وثیقه مشتری</label><select value={form.collateralType} onChange={e => setForm(f => ({ ...f, collateralType: e.target.value }))} data-testid="input-consultation-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>ضامن دارد؟</label><select value={form.hasGuarantor ? '1' : '0'} onChange={e => setForm(f => ({ ...f, hasGuarantor: e.target.value === '1' }))} data-testid="select-consultation-has-guarantor">{guarantorChoices.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div>{form.hasGuarantor && <><div className="field"><label>شغل ضامن</label><select value={form.guarantorJobType} onChange={e => setForm(f => ({ ...f, guarantorJobType: e.target.value }))} data-testid="input-consultation-guarantor-job"><option value="">انتخاب کنید</option>{guarantorJobs.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>رتبه اعتباری ضامن</label><select value={form.guarantorCreditRank} onChange={e => setForm(f => ({ ...f, guarantorCreditRank: e.target.value }))} data-testid="input-consultation-guarantor-rank"><option value="">انتخاب کنید</option>{guarantorRanks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>وثیقه ضامن</label><select value={form.guarantorCollateralType} onChange={e => setForm(f => ({ ...f, guarantorCollateralType: e.target.value }))} data-testid="input-consultation-guarantor-collateral"><option value="">انتخاب کنید</option>{collaterals.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div><div className="field"><label>نوع چک ضامن</label><select value={form.guarantorCheckType} onChange={e => setForm(f => ({ ...f, guarantorCheckType: e.target.value }))} data-testid="input-consultation-guarantor-check-type"><option value="">انتخاب کنید</option>{checks.map(o => <option key={o.id} value={o.value}>{o.labelFa}</option>)}</select></div></>}<div className="field full"><label>شاخص‌های مالی و مدارک</label><div className="boolean-grid">{booleans.map(([key, label]) => <label className="boolean-field" key={String(key)}>{label}<input type="checkbox" checked={Boolean(form[key])} onChange={(event) => setForm(f => ({ ...f, [key]: event.target.checked }))} data-testid={`checkbox-consultation-${String(key)}`} /></label>)}</div></div></div><div className="form-footer"><button type="submit" className="btn btn-primary" disabled={pending} data-testid="button-save-consultation"><FileText size={15} />{pending ? 'در حال ثبت...' : 'ثبت درخواست'}</button><button type="button" className="btn btn-ghost" onClick={onClose} data-testid="button-cancel-consultation">انصراف</button></div></form></Modal>;
}

export function CreateReminderForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const defaultReminder = defaultReminderJalali();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    customerId: '',
    subject: '',
    message: '',
    date: formatJalaliValue(defaultReminder.year, defaultReminder.month, defaultReminder.day),
    hour: defaultReminder.hour,
    minute: defaultReminder.minute,
  });
  const [formError, setFormError] = useState('');
  const customers = useListCustomers(
    { search: search || undefined, limit: 20, offset: 0 },
    { query: { queryKey: getListCustomersQueryKey({ search: search || undefined, limit: 20, offset: 0 }), staleTime: 20_000 } },
  );
  const createReminder = useCreateReminder();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const dateParts = parseJalaliValue(form.date);
    const remindAt = jalaliToIso(
      dateParts?.year ?? 0,
      dateParts?.month ?? 0,
      dateParts?.day ?? 0,
      Number(form.hour),
      Number(form.minute),
    );
    if (!form.subject.trim() || !form.message.trim()) {
      setFormError('موضوع و متن یادآور را وارد کنید.');
      return;
    }
    if (!remindAt) {
      setFormError('تاریخ یا ساعت شمسی معتبر نیست.');
      return;
    }
    if (new Date(remindAt).getTime() <= Date.now()) {
      setFormError('زمان یادآور باید بعد از زمان فعلی باشد.');
      return;
    }
    setFormError('');
    createReminder.mutate(
      {
        data: {
          customerId: form.customerId ? Number(form.customerId) : null,
          subject: form.subject.trim(),
          message: form.message.trim(),
          remindAt,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
          onClose();
        },
      },
    );
  };

  return (
    <Modal title="ثبت یادآور جدید" eyebrow="پیگیری شخصی" onClose={onClose} testId="header-reminder-form">
      <form onSubmit={submit}>
        {formError || createReminder.isError ? <div className="profile-form-error" data-testid="error-header-reminder">{formError || 'ثبت یادآور انجام نشد. دوباره تلاش کنید.'}</div> : null}
        <div className="field full">
          <label htmlFor="header-reminder-search">جست‌وجوی مشتری</label>
          <div className="searchbar compact">
            <Search size={15} />
            <input id="header-reminder-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="نام یا شماره تماس" data-testid="input-header-reminder-search" />
          </div>
        </div>
        <div className="form-grid">
          <div className="field full">
            <label htmlFor="header-reminder-customer">مشتری <span className="field-optional">(اختیاری)</span></label>
            <select id="header-reminder-customer" value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })} data-testid="select-header-reminder-customer">
              <option value="">بدون اتصال به مشتری</option>
              {(customers.data?.items ?? []).map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone}</option>)}
            </select>
          </div>
          <div className="field full">
            <label htmlFor="header-reminder-subject">موضوع یادآور</label>
            <input id="header-reminder-subject" value={form.subject} maxLength={160} onChange={(event) => setForm({ ...form, subject: event.target.value })} data-testid="input-header-reminder-subject" />
          </div>
          <div className="field full">
            <label htmlFor="header-reminder-message">متن یادآور</label>
            <textarea id="header-reminder-message" value={form.message} maxLength={2000} onChange={(event) => setForm({ ...form, message: event.target.value })} data-testid="textarea-header-reminder-message" />
          </div>
          <div className="field">
            <label>تاریخ شمسی</label>
            <PersianDatePicker value={form.date} onChange={(value) => setForm({ ...form, date: value })} testId="input-header-reminder-date" />
          </div>
          <div className="field">
            <label>ساعت</label>
            <div className="reminder-time-grid">
              <input type="number" min="0" max="23" value={form.hour} onChange={(event) => setForm({ ...form, hour: event.target.value })} aria-label="ساعت" data-testid="input-header-reminder-hour" />
              <span>:</span>
              <input type="number" min="0" max="59" value={form.minute} onChange={(event) => setForm({ ...form, minute: event.target.value })} aria-label="دقیقه" data-testid="input-header-reminder-minute" />
            </div>
          </div>
        </div>
        <div className="form-footer">
          <button className="btn btn-primary" type="submit" disabled={createReminder.isPending} data-testid="button-save-header-reminder"><BellPlus size={15} />{createReminder.isPending ? 'در حال ثبت...' : 'ثبت یادآور'}</button>
          <button className="btn btn-ghost" type="button" onClick={onClose}>انصراف</button>
          <Link href="/reminders" className="btn btn-ghost" onClick={onClose}>مشاهده همه یادآورها</Link>
        </div>
      </form>
    </Modal>
  );
}