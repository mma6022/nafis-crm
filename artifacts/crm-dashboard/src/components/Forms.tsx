import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { CallNoteCounter } from '@/components/CallNoteCounter';
import { callNoteOk } from '@/lib/call-note';
import { callErrorMessage } from '@/lib/call-error';
import { OtherOwnerResults } from '@/components/customer/OtherOwnerResults';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { GradePicker } from '@/components/grade/GradePicker';
import { createPortal } from 'react-dom';
import './CallForm.css';
import { ArrowLeft, ArrowRight, BellPlus, FileText, PhoneCall, Search, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Modal } from '@/components/DataTools';
import { defaultReminderJalali, formatJalaliValue, jalaliToIso, parseJalaliValue } from '@/lib/jalali';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { CallHistoryModal, CustomerCallHistory } from '@/components/CallHistory';
import { getListCustomersQueryKey, getListRemindersQueryKey, useCreateReminder, useListCustomers, useListConsultOptions, getListConsultOptionsQueryKey, type CallInput, type CallRecord, type ConsultationInput } from '@workspace/api-client-react';
import { CustomerConsultationStatus, isYesValue } from './CustomerConsultationStatus';
import { CallCustomerSelect, type CallCustomer } from './CallCustomerSelect';
import { normalizeDigits, validateIranianNationalCode } from '@/lib/customer-field-validation';
import { VoiceNoteButton } from '@/features/voice-notes/VoiceNoteButton';
import { saveQuickCreditNationalCode, useConsultProfile, type Military } from '@/features/team-sales/api';
import { Choice, faDigits, formatToman, TomanInput, WizardProgress } from '@/components/plans-consult/parts';
import { cqApi, cqLockActive, cqOn, useCqConfig } from '@/features/call-queue/api';
import { CqManualType, cqFollowUpAt, CqResultFields, cqResultError, cqSaveOutcome, emptyCqResult, focusCallResult, ManualOutcomeField, type ManualOutcome } from '@/features/call-queue/ResultFields';

type CallFormProps = {
  customers: { id: number; name: string; phone: string; salespersonName?: string | null; priority?: number | null; status?: string; nationalCode?: string | null; postalCode?: string | null; birthDateJalali?: string | null; verificationStatus?: string; isUrgent?: boolean }[];
  salespersons: { id: number; name: string }[];
  pending: boolean;
  error?: boolean;
  /** incoming2-59: the mutation's error object; its Persian server message (or a code mapping) is shown instead of the generic text. */
  errorDetail?: unknown;
  initialCustomerId?: number;
  onClose: () => void;
  onSave: (data: CallInput) => Promise<void>;
  /** Called when the user picks a customer in the picker (Calls page: decide whether the simple team-sales form applies). */
  onCustomerPicked?: (customer: CallCustomer) => void;
  /** While set, saving is blocked: 'checking' = deciding which form applies; 'error' = could not decide (retry offered). */
  pickCheck?: { state: 'checking' | 'error'; onRetry: () => void } | null;
  /** Calls page picker: with initialCustomerId, show the picked customer as a card with «تغییر مشتری» (back to step 1). */
  onChangeCustomer?: () => void;
  /**
   * crm-no-plan-option (14:51) «اعتبارسنجی سریع» for P1/P2/P3 follow-up calls (customer page only).
   * canAct = admin / registrar / the customer's own salesperson. onSaveAndCredit saves THIS call and then opens the
   * existing inquiry step (request wizard); the inquiry itself only starts on the user's click there.
   */
  quickCredit?: { canAct: boolean; onSaveAndCredit: (data: CallInput) => Promise<void> };
};

export function CallForm({ customers, salespersons, pending, error, errorDetail, initialCustomerId, onClose, onSave, onCustomerPicked, pickCheck, onChangeCustomer, quickCredit }: CallFormProps) {
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
  const [noteError, setNoteError] = useState(false);
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
  // crm-call-queue R1: «نتیجه‌ی تماس» block (flag.result) and the due-reminder pre-notice (flag.autoclose). All OFF → the form is unchanged.
  const cqCfg = useCqConfig().data;
  const cqResultOn = cqOn(cqCfg, 'result');
  const cqPreOn = cqResultOn || cqOn(cqCfg, 'autoclose');
  const cqPre = useQuery({ queryKey: ['call-queue', 'pre-call', Number(form.customerId) || 0], queryFn: () => cqApi.preCall(Number(form.customerId)), enabled: cqPreOn && !!Number(form.customerId), retry: false, staleTime: 15_000 }).data;
  const [cqVal, setCqVal] = useState(emptyCqResult);
  const [cqShowErr, setCqShowErr] = useState(false);
  // R2 «قفل تماس»: without an open CRM-button call for this customer the expert picks حضوری / بله.
  const cqLock = cqLockActive(cqCfg);
  const cqPend = useQuery({ queryKey: ['call-queue', 'pending'], queryFn: cqApi.pending, enabled: cqLock, retry: false }).data;
  const cqNeedManual = cqLock && cqPend?.pending?.customerId !== (Number(form.customerId) || 0);
  const [cqManual, setCqManual] = useState('');
  // Release 81: «نتیجه‌ی تماس» is required on every manual call log (inside CqResultFields when flag.result is on).
  const [mo, setMo] = useState<ManualOutcome | ''>('');
  const [moErr, setMoErr] = useState(false);
  /** spec §1: «ثبت تماس» stays focusable but aria-disabled until a phone log has its «نتیجه‌ی تماس». */
  const crMissing = cqResultOn ? !cqNeedManual && !cqVal.manual : !mo;
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

  const buildInput = (): CallInput | null => {
    if (pickCheck) return null;
    if (!form.customerId) { setCustomerSelectionError(true); return null; }
    if (cqResultOn) {
      // With «نتیجه‌ی تماس» on, the one-line note is the required part and «یادداشت کارشناس» becomes optional.
      if (cqResultError(cqVal, !cqNeedManual) || (cqNeedManual && !cqManual)) { setCqShowErr(true); if (!cqNeedManual && !cqVal.manual) { focusCallResult('cq'); return null; } (document.querySelector('[data-testid="cq-result"] [aria-invalid="true"], [data-testid="cq-result"] .cq-chip:not(:disabled)') as HTMLElement | null)?.focus(); return null; }
      setCqShowErr(false);
    } else {
    if (!mo) { setMoErr(true); focusCallResult('call'); return null; }
    setMoErr(false);
    // crm-call-note-min: «یادداشت کارشناس» trimmed must be >= 10 characters.
    if (!callNoteOk(form.expertNotes)) { setNoteError(true); document.getElementById('call-notes')?.focus(); return null; }
    }
    setNoteError(false);
    let reminderInput: { subject: string; message: string; remindAt: string } | undefined;
    if (reminderOpen && !cqResultOn) {
      const result = validateReminder();
      if (result.error) {
        setReminderError(result.error);
        setSheetOpen(true);
        return null;
      }
      reminderInput = result.input;
    }
    setReminderError('');
    return {
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
      },
      ...(cqResultOn ? { ...cqSaveOutcome(cqVal, cqNeedManual), oneLineNote: cqVal.oneLine.trim(), followUpAt: cqFollowUpAt(cqVal) } : {}),
      ...(cqNeedManual ? { manualType: cqManual } : {}),
      ...(cqResultOn ? {} : { call_result: mo }),
    } as CallInput;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = buildInput();
    if (input) onSave(input).catch(() => {});
  };

  // «اعتبارسنجی سریع»: only for already-prioritised (P1/P2/P3) customers in the old form.
  const showQuickCredit = Boolean(quickCredit) && selectedCustomer?.priority != null && [1, 2, 3].includes(Number(selectedCustomer.priority));
  const [qcError, setQcError] = useState('');
  const [qcConfirm, setQcConfirm] = useState(false);
  const [qcBusy, setQcBusy] = useState(false);
  const currentCode = normalizeDigits(selectedCustomer?.nationalCode ?? '').trim();
  const quickCreditGo = async (confirmReplace: boolean) => {
    if (!quickCredit || !selectedCustomer || qcBusy) return;
    const code = normalizeDigits(form.nationalCode).trim();
    if (!validateIranianNationalCode(code)) { setQcError('کد ملی ۱۰ رقمی معتبر وارد کنید.'); return; }
    if (currentCode && currentCode !== code && !confirmReplace) { setQcError(''); setQcConfirm(true); return; }
    const input = buildInput();
    if (!input) return;
    setQcBusy(true); setQcError('');
    try {
      const saved = await saveQuickCreditNationalCode(selectedCustomer.id, code, confirmReplace);
      if (saved.needsConfirm) { setQcConfirm(true); return; }
      setQcConfirm(false);
      // The call is saved first (the national code on it is now the same, so nothing else changes), then the wizard opens.
      await quickCredit.onSaveAndCredit({ ...input, profile: { ...input.profile, nationalCode: code } });
    } catch (e) {
      setQcError(e instanceof Error && e.message ? e.message : 'ثبت کد ملی انجام نشد. دوباره تلاش کنید.');
    } finally { setQcBusy(false); }
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
              {error ? <div className="profile-form-error" data-testid="error-call-submit">{callErrorMessage(errorDetail)}</div> : null}
              <div className="call-form-row">
                <div className="field call-field-customer">
                  <label id="call-customer-label" htmlFor="call-customer">مشتری</label>
                  {initialCustomerId && onChangeCustomer && selectedCustomer
                    ? <div className="call-picked" data-testid="call-picked-customer"><div><strong>{selectedCustomer.name}</strong><span dir="ltr">{selectedCustomer.phone}</span></div><button type="button" onClick={onChangeCustomer} data-testid="button-call-change-customer">تغییر مشتری</button></div>
                    : <CallCustomerSelect selected={selectedCustomer} disabled={!!initialCustomerId} onSelect={selectCustomer} />}
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
              {showQuickCredit ? <fieldset className="call-profile-box call-quick-credit" data-testid="call-quick-credit">
                <legend>اعتبارسنجی سریع</legend>
                <div className="qc-row">
                  <div className="field"><label htmlFor="qc-national-code">کد ملی مشتری</label>
                    <input id="qc-national-code" dir="ltr" inputMode="numeric" value={form.nationalCode} placeholder="۱۰ رقم" maxLength={10} disabled={!quickCredit?.canAct || qcBusy}
                      onChange={(e) => { update('nationalCode', e.target.value); setQcError(''); setQcConfirm(false); }}
                      aria-invalid={Boolean(qcError)} aria-describedby={qcError ? 'qc-err' : 'qc-hint'} data-testid="input-quick-credit-national-code" /></div>
                  <button type="button" className="btn btn-primary qc-go" disabled={!quickCredit?.canAct || qcBusy || pending || !!pickCheck} onClick={() => void quickCreditGo(false)} data-testid="button-quick-credit">
                    <FileText size={15} />{qcBusy ? 'در حال ثبت…' : 'ثبت و اعتبارسنجی'}</button>
                </div>
                {qcConfirm ? <div className="qc-confirm" role="alertdialog" aria-labelledby="qc-confirm-t" data-testid="quick-credit-confirm">
                  <p id="qc-confirm-t">این مشتری کد ملی دیگری دارد (<span dir="ltr">{currentCode}</span>). جایگزین شود؟ استعلام‌های قبلی با کد قبلی دیگر معتبر نیستند و تغییر ثبت می‌شود.</p>
                  <div><button type="button" className="btn btn-primary" disabled={qcBusy} onClick={() => void quickCreditGo(true)} data-testid="button-quick-credit-confirm">بله، جایگزین کن</button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setQcConfirm(false); update('nationalCode', currentCode); }} data-testid="button-quick-credit-cancel">انصراف</button></div>
                </div> : null}
                {qcError ? <p className="qc-err" id="qc-err" role="alert" data-testid="error-quick-credit">{qcError}</p> : null}
                <p className="qc-hint" id="qc-hint">{quickCredit?.canAct
                  ? 'اول همین تماس و کد ملی ثبت می‌شود، بعد مرحله‌ی «استعلام اعتبار» ثبت درخواست تسهیلات باز می‌شود. استعلام فقط با کلیک شما در همان مرحله شروع می‌شود (همان هزینه و دسترسی).'
                  : 'فقط کارشناس همین مشتری، ثبت‌نام‌کننده و مدیر می‌توانند اعتبارسنجی سریع را انجام دهند.'}</p>
              </fieldset> : null}
              <fieldset className="call-profile-box">
                <legend>تکمیل اطلاعات مشتری (اختیاری)</legend>
                <div className={`call-form-row ${showQuickCredit ? 'two' : 'three'}`}>
                  {showQuickCredit ? null : <div className="field"><label>کد ملی (اختیاری)</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => update('nationalCode', e.target.value)} maxLength={10} data-testid="input-call-national-code" /></div>}
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
                <VoiceNoteButton value={form.customerRequest} onChange={(v) => update('customerRequest', v)} field="call_note" testId="call-request-voice"><textarea id="call-request" value={form.customerRequest} onChange={(event) => update('customerRequest', event.target.value)} data-testid="textarea-call-request" /></VoiceNoteButton>
              </div>
              {/* Release 81: «نتیجه‌ی تماس» (phone only; a حضوری / بله log under the R2 lock hides it — PM Q4). */}
              {cqResultOn ? null : <ManualOutcomeField value={mo} onChange={(v) => { setMo(v); setMoErr(false); }} showError={moErr} idPrefix="call" submitLabel="ثبت تماس" />}
              {cqNeedManual ? <CqManualType value={cqManual} onChange={setCqManual} showError={cqShowErr} idPrefix="call-mt" /> : null}
              {cqResultOn ? <CqResultFields value={cqVal} onChange={setCqVal} showErrors={cqShowErr} pre={cqPre} noResult={cqNeedManual} submitLabel="ثبت تماس" /> : cqPre?.due?.length ? <CqResultFields.PreOnly pre={cqPre} /> : null}
              <div className="field call-grow call-grow-lg">
                <label htmlFor="call-notes">یادداشت کارشناس {cqResultOn ? <span className="cq-opt">(اختیاری)</span> : <span className="req" aria-hidden="true">*</span>}</label>
                <VoiceNoteButton value={form.expertNotes} onChange={(v) => update('expertNotes', v)} field="call_note" testId="call-notes-voice"><textarea id="call-notes" value={form.expertNotes} onChange={(event) => update('expertNotes', event.target.value)} aria-invalid={!cqResultOn && noteError && !callNoteOk(form.expertNotes)} aria-describedby="call-notes-meta" aria-required={!cqResultOn} data-testid="textarea-call-notes" /></VoiceNoteButton>
                {cqResultOn ? null : <CallNoteCounter value={form.expertNotes} showError={noteError} id="call-notes-meta" testId="call-notes-counter" />}
              </div>
            </div>

            <div className="form-footer call-form-footer">
              <div className="form-footer-actions">
                <button className={`btn btn-primary${crMissing ? ' dis' : ''}`} type="submit" disabled={pending || !!pickCheck} aria-disabled={crMissing || undefined} data-testid="button-save-call">
                  <PhoneCall size={15} />{pending ? 'در حال ثبت...' : 'ثبت تماس'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-call">انصراف</button>
              </div>
              {cqResultOn ? null : <div className="call-reminder-actions">
                <button ref={sheetOpener} className={`btn reminder-toggle ${reminderOpen ? 'active' : ''}`} type="button" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} data-testid="button-toggle-call-reminder">
                  <BellPlus size={15} /> {reminderOpen ? 'ویرایش یادآور' : 'افزودن یادآور'}
                </button>
                {reminderOpen ? <button className="btn btn-ghost" type="button" onClick={removeReminder} data-testid="button-remove-call-reminder">حذف یادآور</button> : null}
              </div>}
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

type ConsultForm = { customerId: string; creditRank: string; customerCheckStatus: string; hasCustomerSalaryDeduct: string; jobType: string; hasGuarantor: string; guarantorCreditRank: string; guarantorCheckType: string; hasGuarantorSalaryDeduct: string; guarantorJobType: string; militaryStatus: '' | Military; extraNotes: string; requestedAmountToman: number | null };
type Opt = { id: number; value: string; labelFa: string };
type ConsultStep = 'customer' | 'applicant' | 'guarantor' | 'note' | 'review';
const CONSULT_STEPS: Array<{ key: ConsultStep; title: string }> = [
  { key: 'customer', title: 'مشتری' }, { key: 'applicant', title: 'متقاضی' }, { key: 'guarantor', title: 'ضامن' },
  { key: 'note', title: 'یادداشت و مبلغ' }, { key: 'review', title: 'بازبینی و ثبت' },
];
const MILITARY_CHOICES: Array<{ value: Military; label: string }> = [
  { value: 'has_card', label: 'دارد' }, { value: 'no_card', label: 'ندارد' }, { value: 'female', label: 'مشتری خانم است' }, { value: 'unknown', label: 'نامشخص' },
];

/** Dictionary question as pill buttons (same values as the old select). */
function QuestionChoice({ id, label, value, onChange, options, error, optional }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Opt[]; error?: boolean; optional?: boolean }) {
  return <div className="field full">
    <Choice label={label} required={!optional} hint={optional ? 'اختیاری' : undefined} value={value} options={options.map((o) => ({ value: o.value, label: o.labelFa }))} onChange={onChange} testId={`select-${id}`} />
    {error ? <small role="alert" style={{ color: '#be123c' }}>این پرسش را پاسخ دهید.</small> : null}
  </div>;
}

export function CreateConsultationForm({ customers: sourceCustomers, pending, initialCustomerId, onClose, onSave }: { customers: { id: number; name: string; phone: string; salespersonName?: string | null }[]; pending: boolean; initialCustomerId?: number; onClose: () => void; onSave: (data: ConsultationInput) => void }) {
  const [form, setForm] = useState<ConsultForm>({ customerId: initialCustomerId ? String(initialCustomerId) : '', creditRank: '', customerCheckStatus: '', hasCustomerSalaryDeduct: '', jobType: '', hasGuarantor: '', guarantorCreditRank: '', guarantorCheckType: '', hasGuarantorSalaryDeduct: '', guarantorJobType: '', militaryStatus: '', extraNotes: '', requestedAmountToman: null });
  const [step, setStep] = useState<ConsultStep>('customer');
  const [attempted, setAttempted] = useState<Partial<Record<ConsultStep, boolean>>>({});
  const militaryTouched = useRef(false);
  const optionsQuery = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 0 } });
  const options = optionsQuery.data ?? [];
  const by = (key: string) => options.filter((o) => o.fieldKey === key);
  const customerId = form.customerId ? Number(form.customerId) : 0;
  const customer = sourceCustomers.find((c) => c.id === customerId) ?? null;
  // «پایان خدمت» comes prefilled from Kazemi's «اطلاعات مشاوره» (the server fills it too when left empty).
  const profile = useConsultProfile(customerId, customerId > 0);
  const profileMilitary = profile.data?.latest?.data?.military ?? null;
  useEffect(() => {
    if (!militaryTouched.current && profileMilitary) setForm((f) => ({ ...f, militaryStatus: profileMilitary }));
  }, [profileMilitary]);
  const set = (key: keyof ConsultForm) => (value: string) => setForm((f) => {
    const next = { ...f, [key]: value };
    if (key === 'hasGuarantor' && !isYesValue(value)) { next.guarantorCreditRank = ''; next.guarantorCheckType = ''; next.hasGuarantorSalaryDeduct = ''; next.guarantorJobType = ''; }
    return next;
  });
  const keys = ['credit_rank', 'customer_check_status', 'has_customer_salary_deduct', 'job_type', 'has_guarantor', 'guarantor_credit_rank', 'guarantor_check_type', 'has_guarantor_salary_deduct'];
  const missingKeys = keys.filter((k) => by(k).length === 0);
  const optionsReady = optionsQuery.isSuccess && missingKeys.length === 0;
  const guarantorYes = form.hasGuarantor !== '' && isYesValue(form.hasGuarantor);
  const requiredBy: Record<ConsultStep, (keyof ConsultForm)[]> = {
    customer: ['customerId'],
    applicant: ['creditRank', 'jobType', 'customerCheckStatus', 'hasCustomerSalaryDeduct'],
    guarantor: ['hasGuarantor', ...(guarantorYes ? ['guarantorCreditRank', 'guarantorCheckType', 'hasGuarantorSalaryDeduct'] as (keyof ConsultForm)[] : [])],
    note: [], review: [],
  };
  const stepIndex = CONSULT_STEPS.findIndex((s) => s.key === step);
  const current = CONSULT_STEPS[stepIndex];
  const bad = (k: keyof ConsultForm) => Boolean(attempted[step]) && requiredBy[step].includes(k) && !form[k];
  const stepOk = (s: ConsultStep) => requiredBy[s].every((k) => Boolean(form[k]));
  const label = (key: string, v: string) => by(key).find((o) => o.value === v)?.labelFa ?? (v || '—');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted((a) => ({ ...a, [step]: true }));
    if (step !== 'review') { if (stepOk(step)) setStep(CONSULT_STEPS[stepIndex + 1].key); return; }
    const firstBad = CONSULT_STEPS.find((s) => !stepOk(s.key));
    if (firstBad) { setAttempted((a) => ({ ...a, [firstBad.key]: true })); setStep(firstBad.key); return; }
    if (!optionsReady) return;
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
        ...(form.guarantorJobType ? { guarantorJobType: form.guarantorJobType } : {}),
      } : { hasGuarantorCheck: false, hasGuarantorSalaryDeduct: false }),
      ...(form.militaryStatus ? { militaryStatus: form.militaryStatus } : {}),
      ...(form.requestedAmountToman != null ? { requestedAmountToman: form.requestedAmountToman } : {}),
      ...(form.extraNotes.trim() ? { extraNotes: form.extraNotes.trim() } : {}),
    };
    onSave(data satisfies ConsultationInput);
  };

  const sub = customer ? <div className="pc-sub" data-testid="consult-wizard-customer"><CustomerName id={customer.id} name={customer.name} badgeTestId="badge-consult-wizard-customer" /><span dir="ltr">{faDigits(customer.phone)}</span></div> : null;
  const reviewRow = (k: string, v: string) => <><dt>{k}</dt><dd>{v}</dd></>;
  const militaryText = form.militaryStatus ? MILITARY_CHOICES.find((m) => m.value === form.militaryStatus)?.label ?? '—' : 'باید بررسی شود';

  return <Modal title="مشاوره‌ی تازه" eyebrow="پرسشنامه ارزیابی مالی" onClose={onClose} testId="create-consultation-form">
    <form onSubmit={submit} noValidate className="pc-wizard">
      {sub}
      <WizardProgress title={current.title} index={stepIndex} total={CONSULT_STEPS.length} testId="consult-wizard-progress" />
      {optionsQuery.isLoading ? <div role="status" className="profile-form-note" data-testid="status-consult-options-loading">در حال دریافت گزینه‌های پرسشنامه…</div> : null}
      {optionsQuery.isError ? <div role="alert" className="profile-form-error" data-testid="error-consult-options">دریافت گزینه‌ها انجام نشد. ثبت ممکن نیست. <button type="button" className="btn btn-ghost" onClick={() => void optionsQuery.refetch()}>تلاش دوباره</button></div> : null}
      {optionsQuery.isSuccess && missingKeys.length > 0 ? <div role="alert" className="profile-form-error" data-testid="error-consult-options-empty">برای برخی پرسش‌ها گزینه‌ای تعریف نشده است؛ ثبت تا تکمیل گزینه‌ها ممکن نیست.</div> : null}
      <div className="pc-body" data-testid={`consult-step-${step}`}>
        {step === 'customer' ? <>
          <div className="field full"><label htmlFor="consult-customer-select">مشتری <span style={{ color: '#be123c' }}>*</span></label>
            <select id="consult-customer-select" value={form.customerId} onChange={(e) => set('customerId')(e.target.value)} disabled={!!initialCustomerId} aria-invalid={bad('customerId')} data-testid="select-consultation-customer">
              <option value="" disabled>انتخاب مشتری</option>
              {sourceCustomers.map((c) => <option key={c.id} value={c.id}>{customerNameText(c.name, c.id)} · {c.phone} · کارشناس پرونده: {c.salespersonName || 'بدون تخصیص'}</option>)}
            </select>
            {bad('customerId') ? <small role="alert" style={{ color: '#be123c' }}>مشتری را انتخاب کنید.</small> : null}
          </div>
          <div className="field full"><CustomerConsultationStatus customerId={customerId || undefined} /></div>
        </> : null}

        {step === 'applicant' ? <>
          <div className="field full"><GradePicker id="consult-credit-rank" label="رتبه‌ی اعتبارسنجی متقاضی" required value={form.creditRank} onChange={(v) => set('creditRank')(v)} showError={Boolean(attempted.applicant)} testId="grade-consult-credit-rank" /></div>
          <QuestionChoice id="consult-job" label="شغل متقاضی" value={form.jobType} onChange={set('jobType')} options={by('job_type')} error={bad('jobType')} />
          <div className="pc-two">
            <QuestionChoice id="consult-check-status" label="چک متقاضی" value={form.customerCheckStatus} onChange={set('customerCheckStatus')} options={by('customer_check_status')} error={bad('customerCheckStatus')} />
            <QuestionChoice id="consult-salary-deduct" label="کسر از حقوق" value={form.hasCustomerSalaryDeduct} onChange={set('hasCustomerSalaryDeduct')} options={by('has_customer_salary_deduct')} error={bad('hasCustomerSalaryDeduct')} />
          </div>
          <div className="field full">
            <Choice label="وضعیت پایان خدمت" hint={profileMilitary && !militaryTouched.current ? 'از اطلاعات مشاوره‌ی قبلی پر شد' : 'اختیاری؛ خالی = باید بررسی شود'} value={form.militaryStatus || null} options={MILITARY_CHOICES} dashed="unknown"
              onChange={(v) => { militaryTouched.current = true; setForm((f) => ({ ...f, militaryStatus: v })); }} testId="choice-consult-military" />
          </div>
        </> : null}

        {step === 'guarantor' ? <>
          <QuestionChoice id="consult-has-guarantor" label="ضامن دارد؟" value={form.hasGuarantor} onChange={set('hasGuarantor')} options={by('has_guarantor')} error={bad('hasGuarantor')} />
          {guarantorYes ? <div className="pc-nested pc-body">
            <div className="field full"><GradePicker id="consult-guarantor-credit-rank" label="رتبه‌ی اعتبارسنجی ضامن" required value={form.guarantorCreditRank} onChange={(v) => set('guarantorCreditRank')(v)} showError={Boolean(attempted.guarantor)} emptyError="رتبه اعتبارسنجی ضامن را انتخاب کنید." testId="grade-consult-guarantor-credit-rank" /></div>
            <QuestionChoice id="consult-guarantor-job" label="شغل ضامن" optional value={form.guarantorJobType} onChange={set('guarantorJobType')} options={by('guarantor_job_type')} />
            <div className="pc-two">
              <QuestionChoice id="consult-guarantor-check" label="چک ضامن" value={form.guarantorCheckType} onChange={set('guarantorCheckType')} options={by('guarantor_check_type')} error={bad('guarantorCheckType')} />
              <QuestionChoice id="consult-guarantor-salary" label="کسر از حقوق ضامن" value={form.hasGuarantorSalaryDeduct} onChange={set('hasGuarantorSalaryDeduct')} options={by('has_guarantor_salary_deduct')} error={bad('hasGuarantorSalaryDeduct')} />
            </div>
          </div> : null}
        </> : null}

        {step === 'note' ? <>
          <div className="field full"><label htmlFor="consult-amount-toman">مبلغ مورد نیاز مشتری <span className="pc-hint">اختیاری</span></label><TomanInput id="consult-amount-toman" value={form.requestedAmountToman} onChange={(n) => setForm((f) => ({ ...f, requestedAmountToman: n }))} testId="input-consultation-amount-toman" /></div>
          <div className="field full"><label htmlFor="consult-extra-notes">یادداشت <span className="pc-hint">اختیاری</span></label><textarea id="consult-extra-notes" rows={4} value={form.extraNotes} onChange={(e) => setForm((f) => ({ ...f, extraNotes: e.target.value }))} data-testid="textarea-consultation-extra-notes" /></div>
        </> : null}

        {step === 'review' ? <div className="pc-review" data-testid="consult-review">
          <div className="pc-review-card"><header><strong>مشتری</strong>{initialCustomerId ? null : <button type="button" onClick={() => setStep('customer')}>ویرایش</button>}</header><dl>{reviewRow('نام', customer ? customerNameText(customer.name, customer.id) : '—')}</dl></div>
          <div className="pc-review-card"><header><strong>متقاضی</strong><button type="button" onClick={() => setStep('applicant')}>ویرایش</button></header><dl>
            {reviewRow('رتبه', form.creditRank || '—')}{reviewRow('شغل', label('job_type', form.jobType))}{reviewRow('چک', label('customer_check_status', form.customerCheckStatus))}
            {reviewRow('کسر از حقوق', label('has_customer_salary_deduct', form.hasCustomerSalaryDeduct))}{reviewRow('پایان خدمت', militaryText)}
          </dl></div>
          <div className="pc-review-card"><header><strong>ضامن</strong><button type="button" onClick={() => setStep('guarantor')}>ویرایش</button></header><dl>
            {reviewRow('ضامن', label('has_guarantor', form.hasGuarantor))}
            {guarantorYes ? <>{reviewRow('رتبه ضامن', form.guarantorCreditRank || '—')}{reviewRow('شغل ضامن', form.guarantorJobType ? label('guarantor_job_type', form.guarantorJobType) : '—')}{reviewRow('چک ضامن', label('guarantor_check_type', form.guarantorCheckType))}{reviewRow('کسر از حقوق ضامن', label('has_guarantor_salary_deduct', form.hasGuarantorSalaryDeduct))}</> : null}
          </dl></div>
          <div className="pc-review-card"><header><strong>یادداشت و مبلغ</strong><button type="button" onClick={() => setStep('note')}>ویرایش</button></header><dl>
            {reviewRow('مبلغ', form.requestedAmountToman != null ? `${formatToman(form.requestedAmountToman)} تومان` : '—')}{reviewRow('یادداشت', form.extraNotes.trim() || '—')}
          </dl></div>
          <p className="profile-form-note">ارائهٔ سفته برای همه امکان‌پذیر است. سقف قابل دریافت پس از تطبیق رتبه و شرایط مشتری و ضامن محاسبه می‌شود؛ تأیید نهایی نیازمند بررسی پرونده است.</p>
        </div> : null}
      </div>
      <div className="pc-footer">
        {step === 'review'
          ? <button type="submit" className="btn btn-primary" disabled={pending || !optionsReady} data-testid="button-save-consultation"><FileText size={15} />{pending ? 'در حال ثبت...' : 'ثبت و دیدن طرح‌های مناسب'}</button>
          : <button type="submit" className="btn btn-primary" data-testid="button-consult-wizard-next">بعدی <ArrowLeft size={16} /></button>}
        {stepIndex > 0
          ? <button type="button" className="btn btn-ghost" onClick={() => setStep(CONSULT_STEPS[stepIndex - 1].key)} data-testid="button-consult-wizard-back"><ArrowRight size={16} /> قبلی</button>
          : <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="button-cancel-consultation">انصراف</button>}
      </div>
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
            <input id="header-reminder-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)" data-testid="input-header-reminder-search" />
          </div>
        </div>
        <div className="form-grid">
          <div className="field full">
            <label htmlFor="header-reminder-customer">مشتری <span className="field-optional">(اختیاری)</span></label>
            <select id="header-reminder-customer" value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })} data-testid="select-header-reminder-customer">
              <option value="">بدون اتصال به مشتری</option>
              {(customers.data?.items ?? []).map((customer) => <option key={customer.id} value={customer.id}>{customerNameText(customer.name, customer.id)} · {customer.phone} · کارشناس پرونده: {customer.salespersonName || 'بدون تخصیص'}</option>)}
            </select>
            <OtherOwnerResults page={customers.data} variant="inline" testId="other-owner-results-reminder" />
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