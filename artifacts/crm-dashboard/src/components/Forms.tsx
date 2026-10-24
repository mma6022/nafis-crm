import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import './CallForm.css';
import { BellPlus, FileText, PhoneCall, Search, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Modal } from '@/components/DataTools';
import { defaultReminderJalali, formatJalaliValue, jalaliToIso, parseJalaliValue } from '@/lib/jalali';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { CallHistoryModal, CustomerCallHistory } from '@/components/CallHistory';
import { getListCustomersQueryKey, getListRemindersQueryKey, useCreateReminder, useListCustomers, useListConsultOptions, getListConsultOptionsQueryKey, type CallInput, type CallRecord, type ConsultationInput } from '@workspace/api-client-react';
import { CustomerConsultationStatus, isYesValue } from './CustomerConsultationStatus';
import { CallCustomerSelect, type CallCustomer } from './CallCustomerSelect';

type CallFormProps = {
  customers: { id: number; name: string; phone: string; salespersonName?: string | null; priority?: number | null; status?: string; nationalCode?: string | null; postalCode?: string | null; birthDateJalali?: string | null; verificationStatus?: string; isUrgent?: boolean }[];
  salespersons: { id: number; name: string }[];
  pending: boolean;
  error?: boolean;
  initialCustomerId?: number;
  onClose: () => void;
  onSave: (data: CallInput) => Promise<void>;
  /** Called when the user picks a customer in the picker (Calls page: decide whether the simple team-sales form applies). */
  onCustomerPicked?: (customer: CallCustomer) => void;
  /** While set, saving is blocked: 'checking' = deciding which form applies; 'error' = could not decide (retry offered). */
  pickCheck?: { state: 'checking' | 'error'; onRetry: () => void } | null;
};

export function CallForm({ customers, salespersons, pending, error, initialCustomerId, onClose, onSave, onCustomerPicked, pickCheck }: CallFormProps) {
  const defaultReminder = defaultReminderJalali();
  const initialCustomer = customers.find((customer) => customer.id === initialCustomerId);
  const [pickedCustomer, setPickedCustomer] = useState<CallCustomer | undefined>(initialCustomer);
  const [customerSelectionError, setCustomerSelectionError] = useState(false);
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
  const selectedCustomer = pickedCustomer ?? customers.find((customer) => customer.id === Number(form.customerId));
  const selectCustomer = (customer: CallCustomer) => {
    setPickedCustomer(customer);
    setCustomerSelectionError(false);
    setForm((current) => ({
      ...current,
      customerId: String(customer.id),
      nationalCode: customer?.nationalCode ?? '',
      postalCode: customer?.postalCode ?? '',
      birthDateJalali: customer?.birthDateJalali ?? '',
    }));
    onCustomerPicked?.(customer);
  };

  const sheetOpener = useRef<HTMLButtonElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const sheetCloseRef = useRef<HTMLButtonElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // A scrolling mobile modal must not scroll its reminder sheet off-screen.
    setPortalHost(document.body);
  }, []);
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    if (sheetOpen) {
      sheetCloseRef.current?.focus();
      layout.setAttribute('inert', '');
      layout.setAttribute('aria-hidden', 'true');
    } else {
      layout.removeAttribute('inert');
      layout.removeAttribute('aria-hidden');
    }
  }, [sheetOpen, portalHost]);
  const closeSheet = () => {
    setSheetOpen(false);
    window.setTimeout(() => sheetOpener.current?.focus(), 0);
  };
  const validateReminder = (): { input?: { subject: string; message: string; remindAt: string }; error?: string } => {
    const dateParts = parseJalaliValue(reminder.date);
    const remindAt = jalaliToIso(dateParts?.year ?? 0, dateParts?.month ?? 0, dateParts?.day ?? 0, Number(reminder.hour), Number(reminder.minute));
    if (!reminder.subject.trim() || !reminder.message.trim()) return { error: 'موضوع و متن یادآور را وارد کنید.' };
    if (!remindAt) return { error: 'تاریخ یا ساعت شمسی معتبر نیست.' };
    if (new Date(remindAt).getTime() <= Date.now()) return { error: 'زمان یادآور باید بعد از زمان فعلی باشد.' };
    return { input: { subject: reminder.subject.trim(), message: reminder.message.trim(), remindAt } };
  };
  const applyReminder = () => {
    const result = validateReminder();
    if (result.error) { setReminderError(result.error); return; }
    setReminderError('');
    setReminderOpen(true);
    closeSheet();
  };
  const removeReminder = () => {
    setReminderOpen(false);
    setReminderError('');
    closeSheet();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pickCheck) return;
    if (!form.customerId) { setCustomerSelectionError(true); return; }
    let reminderInput: { subject: string; message: string; remindAt: string } | undefined;
    if (reminderOpen) {
      const result = validateReminder();
      if (result.error) {
        setReminderError(result.error);
        setSheetOpen(true);
        return;
      }
      reminderInput = result.input;
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

  return (
    <Modal title="ثبت تماس جدید" eyebrow="ثبت در خط زمانی" onClose={onClose} testId="call-form" size="call">
      <div className="call-dialog-layout" ref={layoutRef}>
        <aside className="call-dialog-side call-dialog-history" data-testid="panel-call-history" aria-label="تماس‌های قبلی">
          <div className="call-form-history-head">
            <div><label>تماس‌های قبلی مشتری</label><p>برای مشاهده متن کامل و ترتیب تماس‌ها روی هر ردیف کلیک کنید.</p></div>
          </div>
          <CustomerCallHistory
            customerId={form.customerId ? Number(form.customerId) : undefined}
            customerName={selectedCustomer?.name}
            customerSalespersonName={selectedCustomer?.salespersonName}
            compact
            limit={500}
            onSelectCall={setHistoryCall}
          />
        </aside>
        <div className="call-dialog-center">
          <form onSubmit={submit} className="call-form-shell">
            <div className="call-form-body">
              {error ? <div className="profile-form-error" data-testid="error-call-submit">ثبت تماس با خطا مواجه شد. لطفاً دوباره تلاش کنید.</div> : null}
              <div className="call-form-row">
                <div className="field call-field-customer">
                  <label id="call-customer-label" htmlFor="call-customer">مشتری</label>
                  <CallCustomerSelect selected={selectedCustomer} disabled={!!initialCustomerId} onSelect={selectCustomer} />
                  {customerSelectionError && <div role="alert" className="profile-form-error">ابتدا مشتری را انتخاب کنید.</div>}
                  {pickCheck?.state === 'checking' ? <div className="ts-call-check" role="status" data-testid="call-pick-check" data-state="checking">در حال بررسی فرم مناسب این مشتری…</div> : null}
                  {pickCheck?.state === 'error' ? <div className="ts-call-check bad" role="alert" data-testid="call-pick-check" data-state="error">نوع فرم تماس مشخص نشد. <button type="button" onClick={pickCheck.onRetry} data-testid="button-call-pick-retry">تلاش دوباره</button></div> : null}
                  {selectedCustomer && (
                    <div className="call-customer-chips">
                      {selectedCustomer.isUrgent && <span className="chip-urgent">فوری</span>}
                      {selectedCustomer.verificationStatus === 'unverified' && <span className="chip-unverified">احراز نشده</span>}
                      <span className="chip-owner">کارشناس پرونده: {selectedCustomer.salespersonName || 'بدون تخصیص'}</span>
                    </div>
                  )}
                </div>
              </div>
              <fieldset className="call-profile-box">
                <legend>تکمیل اطلاعات مشتری (اختیاری)</legend>
                <div className="call-form-row three">
                  <div className="field"><label>کد ملی</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => update('nationalCode', e.target.value)} maxLength={10} data-testid="input-call-national-code" /></div>
                  <div className="field"><label>کد پستی</label><input dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => update('postalCode', e.target.value)} maxLength={10} data-testid="input-call-postal-code" /></div>
                  <div className="field"><label>تاریخ تولد</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => update('birthDateJalali', v)} testId="input-call-birth-date" birthDate /></div>
                </div>
              </fieldset>
              <div className="call-form-row two">
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
              </div>
              <div className="field call-grow call-grow-sm">
                <label htmlFor="call-request">درخواست مشتری</label>
                <textarea id="call-request" value={form.customerRequest} onChange={(event) => update('customerRequest', event.target.value)} data-testid="textarea-call-request" />
              </div>
              <div className="field call-grow call-grow-lg">
                <label htmlFor="call-notes">یادداشت کارشناس</label>
                <textarea id="call-notes" value={form.expertNotes} onChange={(event) => update('expertNotes', event.target.value)} data-testid="textarea-call-notes" />
              </div>
            </div>

            <div className="form-footer call-form-footer">
              <div className="form-footer-actions">
                <button className="btn btn-primary" type="submit" disabled={pending || !!pickCheck} data-testid="button-save-call">
                  <PhoneCall size={15} />{pending ? 'در حال ثبت...' : 'ثبت تماس'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-call">انصراف</button>
              </div>
              <div className="call-reminder-actions">
                <button ref={sheetOpener} className={`btn reminder-toggle ${reminderOpen ? 'active' : ''}`} type="button" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} data-testid="button-toggle-call-reminder">
                  <BellPlus size={15} /> {reminderOpen ? 'ویرایش یادآور' : 'افزودن یادآور'}
                </button>
                {reminderOpen ? <button className="btn btn-ghost" type="button" onClick={removeReminder} data-testid="button-remove-call-reminder">حذف یادآور</button> : null}
              </div>
            </div>
          </form>
        </div>
        <aside className="call-dialog-side call-dialog-consult" data-testid="panel-call-consultation" aria-label="آخرین وضعیت مشاوره">
          {form.customerId ? <CustomerConsultationStatus customerId={Number(form.customerId)} /> : <div className="call-history-empty"><span>برای دیدن وضعیت مشاوره، ابتدا مشتری را انتخاب کنید.</span></div>}
        </aside>
      </div>
      {sheetOpen && portalHost ? createPortal(
        <div className="call-sheet-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeSheet(); }}>
          <div
            className="call-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="call-reminder-sheet-title"
            data-testid="panel-call-reminder"
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheet(); }
              else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
               else if (e.key === 'Tab') {
                 const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter((control) => control.getClientRects().length > 0);
                 const first = controls[0], last = controls[controls.length - 1];
                 if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
                 else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
               }
            }}
          >
            <div className="call-sheet-handle" aria-hidden="true" />
            <div className="call-sheet-head">
              <h4 id="call-reminder-sheet-title"><BellPlus size={16} /> یادآور این مشتری</h4>
              <button ref={sheetCloseRef} type="button" className="modal-close" onClick={closeSheet} aria-label="بستن یادآور" data-testid="button-close-call-reminder"><X size={18} /></button>
            </div>
            <div className="call-sheet-body">
              {reminderError ? <div className="profile-form-error" role="alert" data-testid="error-call-reminder">{reminderError}</div> : null}
              <div className="form-grid">
                <div className="field full">
                  <label htmlFor="reminder-subject">موضوع یادآور</label>
                  <input id="reminder-subject" value={reminder.subject} maxLength={160} onChange={(event) => setReminder({ ...reminder, subject: event.target.value })} data-testid="input-reminder-subject" />
                </div>
                <div className="field full">
                  <label htmlFor="reminder-message">متن یادآور</label>
                  <textarea id="reminder-message" value={reminder.message} maxLength={2000} onChange={(event) => setReminder({ ...reminder, message: event.target.value })} data-testid="textarea-reminder-message" />
                </div>
                <div className="field">
                  <label>تاریخ شمسی</label>
                  <PersianDatePicker value={reminder.date} onChange={(value) => setReminder({ ...reminder, date: value })} placeholder="انتخاب تاریخ یادآور" testId="input-reminder-date" popoverClassName="call-reminder-date-popover" />
                </div>
                <div className="field">
                  <label>ساعت</label>
                  <div className="reminder-time-grid">
                    <input type="number" min="0" max="23" value={reminder.hour} onChange={(event) => setReminder({ ...reminder, hour: event.target.value })} aria-label="ساعت" data-testid="input-reminder-hour" />
                    <span>:</span>
                    <input type="number" min="0" max="59" value={reminder.minute} onChange={(event) => setReminder({ ...reminder, minute: event.target.value })} aria-label="دقیقه" data-testid="input-reminder-minute" />
                  </div>
                </div>
              </div>
            </div>
            <div className="call-sheet-actions">
              <button type="button" className="btn btn-primary" onClick={applyReminder} data-testid="button-apply-call-reminder">اعمال یادآور</button>
              {reminderOpen ? <button type="button" className="btn btn-ghost" onClick={removeReminder} data-testid="button-sheet-remove-call-reminder">حذف یادآور</button> : null}
            </div>
          </div>
        </div>,
        portalHost,
      ) : null}
      {historyCall ? (
        <CallHistoryModal
          customerId={Number(form.customerId)}
          customerName={selectedCustomer?.name ?? historyCall.customerName}
          customerPhone={historyCall.customerPhone}
          customerSalespersonName={selectedCustomer?.salespersonName}
          selectedCallId={historyCall.id}
          onClose={() => setHistoryCall(null)}
        />
      ) : null}
    </Modal>
  );
}

type ConsultForm = { customerId: string; creditRank: string; customerCheckStatus: string; hasCustomerSalaryDeduct: string; jobType: string; hasGuarantor: string; guarantorCreditRank: string; guarantorCheckType: string; hasGuarantorSalaryDeduct: string };
type Opt = { id: number; value: string; labelFa: string };

function QuestionSelect({ id, label, value, onChange, options, error }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Opt[]; error?: boolean }) {
  return <div className="field">
    <label htmlFor={id}>{label} <span style={{ color: '#be123c' }}>*</span></label>
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error} aria-required="true" data-testid={`select-${id}`}>
      <option value="" disabled>انتخاب کنید</option>
      {options.map((o) => <option key={o.id} value={o.value}>{o.labelFa}</option>)}
    </select>
    {error ? <small role="alert" style={{ color: '#be123c' }}>این پرسش را پاسخ دهید.</small> : null}
  </div>;
}

export function CreateConsultationForm({ customers: sourceCustomers, pending, initialCustomerId, onClose, onSave }: { customers: { id: number; name: string; phone: string; salespersonName?: string | null }[]; pending: boolean; initialCustomerId?: number; onClose: () => void; onSave: (data: ConsultationInput) => void }) {
  const customers = sourceCustomers.map((customer) => ({ ...customer, name: `${customer.name} · کارشناس پرونده: ${customer.salespersonName || 'بدون تخصیص'}` }));
  const [form, setForm] = useState<ConsultForm>({ customerId: initialCustomerId ? String(initialCustomerId) : '', creditRank: '', customerCheckStatus: '', hasCustomerSalaryDeduct: '', jobType: '', hasGuarantor: '', guarantorCreditRank: '', guarantorCheckType: '', hasGuarantorSalaryDeduct: '' });
  const [attempted, setAttempted] = useState(false);
  const optionsQuery = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 0 } });
  const options = optionsQuery.data ?? [];
  const by = (key: string) => options.filter((o) => o.fieldKey === key);
  const set = (key: keyof ConsultForm) => (value: string) => setForm((f) => {
    const next = { ...f, [key]: value };
    if (key === 'hasGuarantor' && !isYesValue(value)) { next.guarantorCreditRank = ''; next.guarantorCheckType = ''; next.hasGuarantorSalaryDeduct = ''; }
    return next;
  });
  const keys = ['credit_rank', 'customer_check_status', 'has_customer_salary_deduct', 'job_type', 'has_guarantor', 'guarantor_credit_rank', 'guarantor_check_type', 'has_guarantor_salary_deduct'];
  const missingKeys = keys.filter((k) => by(k).length === 0);
  const optionsReady = optionsQuery.isSuccess && missingKeys.length === 0;
  const guarantorYes = form.hasGuarantor !== '' && isYesValue(form.hasGuarantor);
  const required: (keyof ConsultForm)[] = ['customerId', 'creditRank', 'customerCheckStatus', 'hasCustomerSalaryDeduct', 'jobType', 'hasGuarantor', ...(guarantorYes ? ['guarantorCreditRank', 'guarantorCheckType', 'hasGuarantorSalaryDeduct'] as (keyof ConsultForm)[] : [])];
  const bad = (k: keyof ConsultForm) => attempted && required.includes(k) && !form[k];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!optionsReady || required.some((k) => !form[k])) return;
    const hasG = isYesValue(form.hasGuarantor);
    const data = {
      customerId: Number(form.customerId),
      questionnaireVersion: 2 as const,
      creditRank: form.creditRank,
      jobType: form.jobType,
      customerCheckStatus: form.customerCheckStatus,
      hasCheck: form.customerCheckStatus !== 'none',
      hasCustomerSalaryDeduct: isYesValue(form.hasCustomerSalaryDeduct),
      hasGuarantor: hasG,
      ...(hasG ? {
        guarantorCreditRank: form.guarantorCreditRank,
        guarantorCheckType: form.guarantorCheckType,
        hasGuarantorCheck: form.guarantorCheckType !== 'none',
        hasGuarantorSalaryDeduct: isYesValue(form.hasGuarantorSalaryDeduct),
      } : { hasGuarantorCheck: false, hasGuarantorSalaryDeduct: false }),
    };
    onSave(data satisfies ConsultationInput);
  };

  const section: React.CSSProperties = { border: '1px solid #dbe2ee', borderRadius: 12, padding: 14, background: '#f8fafc' };
  const sectionHead: React.CSSProperties = { margin: '0 0 12px', fontSize: 13, fontWeight: 800, color: 'var(--nafiss-blue)', borderRight: '3px solid var(--nafiss-blue)', paddingRight: 8 };

  return <Modal title="ثبت مشاوره" eyebrow="پرسشنامه ارزیابی مالی" onClose={onClose} testId="create-consultation-form">
    <form onSubmit={submit} noValidate>
      {optionsQuery.isLoading ? <div role="status" className="profile-form-note" data-testid="status-consult-options-loading">در حال دریافت گزینه‌های پرسشنامه…</div> : null}
      {optionsQuery.isError ? <div role="alert" className="profile-form-error" data-testid="error-consult-options">دریافت گزینه‌ها انجام نشد. ثبت ممکن نیست. <button type="button" className="btn btn-ghost" onClick={() => void optionsQuery.refetch()}>تلاش دوباره</button></div> : null}
      {optionsQuery.isSuccess && missingKeys.length > 0 ? <div role="alert" className="profile-form-error" data-testid="error-consult-options-empty">برای برخی پرسش‌ها گزینه‌ای تعریف نشده است؛ ثبت تا تکمیل گزینه‌ها ممکن نیست.</div> : null}
      <div className="form-grid">
        <div className="field full"><label htmlFor="consult-customer-select">مشتری <span style={{ color: '#be123c' }}>*</span></label>
          <select id="consult-customer-select" value={form.customerId} onChange={(e) => set('customerId')(e.target.value)} disabled={!!initialCustomerId} aria-invalid={bad('customerId')} data-testid="select-consultation-customer">
            <option value="" disabled>انتخاب مشتری</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
          </select>
          {bad('customerId') ? <small role="alert" style={{ color: '#be123c' }}>مشتری را انتخاب کنید.</small> : null}
        </div>
        <div className="field full"><CustomerConsultationStatus customerId={form.customerId ? Number(form.customerId) : undefined} /></div>
        <div className="field full" style={section} role="group" aria-labelledby="consult-applicant-h">
          <h4 id="consult-applicant-h" style={sectionHead}>اطلاعات متقاضی</h4>
          <div className="form-grid">
            <QuestionSelect id="consult-credit-rank" label="رتبه اعتباری متقاضی" value={form.creditRank} onChange={set('creditRank')} options={by('credit_rank')} error={bad('creditRank')} />
            <QuestionSelect id="consult-check-status" label="وضعیت چک متقاضی" value={form.customerCheckStatus} onChange={set('customerCheckStatus')} options={by('customer_check_status')} error={bad('customerCheckStatus')} />
            <QuestionSelect id="consult-salary-deduct" label="وضعیت کسر از حقوق متقاضی" value={form.hasCustomerSalaryDeduct} onChange={set('hasCustomerSalaryDeduct')} options={by('has_customer_salary_deduct')} error={bad('hasCustomerSalaryDeduct')} />
            <QuestionSelect id="consult-job" label="شغل متقاضی" value={form.jobType} onChange={set('jobType')} options={by('job_type')} error={bad('jobType')} />
          </div>
        </div>
        <div className="field full" style={section} role="group" aria-labelledby="consult-guarantor-h">
          <h4 id="consult-guarantor-h" style={sectionHead}>اطلاعات ضامن</h4>
          <div className="form-grid">
            <QuestionSelect id="consult-has-guarantor" label="ضامن دارد یا نه" value={form.hasGuarantor} onChange={set('hasGuarantor')} options={by('has_guarantor')} error={bad('hasGuarantor')} />
            {guarantorYes ? <>
              <QuestionSelect id="consult-guarantor-credit-rank" label="رتبه اعتباری ضامن" value={form.guarantorCreditRank} onChange={set('guarantorCreditRank')} options={by('guarantor_credit_rank')} error={bad('guarantorCreditRank')} />
              <QuestionSelect id="consult-guarantor-check" label="وضعیت چک ضامن" value={form.guarantorCheckType} onChange={set('guarantorCheckType')} options={by('guarantor_check_type')} error={bad('guarantorCheckType')} />
              <QuestionSelect id="consult-guarantor-salary" label="ضامن کسر از حقوق دارد یا نه" value={form.hasGuarantorSalaryDeduct} onChange={set('hasGuarantorSalaryDeduct')} options={by('has_guarantor_salary_deduct')} error={bad('hasGuarantorSalaryDeduct')} />
            </> : null}
          </div>
        </div>
      </div>
      <p className="profile-form-note">ارائهٔ سفته برای همه امکان‌پذیر است. سقف قابل دریافت پس از تطبیق رتبه و شرایط مشتری و ضامن محاسبه می‌شود؛ تأیید نهایی نیازمند بررسی پرونده است.</p>
      <div className="form-footer"><button type="submit" className="btn btn-primary" disabled={pending || !optionsReady} data-testid="button-save-consultation"><FileText size={15} />{pending ? 'در حال ثبت...' : 'ثبت درخواست'}</button><button type="button" className="btn btn-ghost" onClick={onClose} data-testid="button-cancel-consultation">انصراف</button></div>
    </form>
  </Modal>;
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
              {(customers.data?.items ?? []).map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone} · کارشناس پرونده: {customer.salespersonName || 'بدون تخصیص'}</option>)}
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