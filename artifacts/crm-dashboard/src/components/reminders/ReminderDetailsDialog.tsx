import { useEffect, useRef } from 'react';
import type { Reminder } from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';

const smsLabels: Record<string, string> = {
  pending: 'در انتظار موعد یادآوری', sending: 'در حال ارسال',
  sent: 'ارسال‌شده', blocked: 'ارسال ممکن نیست', rejected: 'رد شده توسط سامانه پیامک',
  uncertain: 'نتیجه ارسال نامشخص؛ برای جلوگیری از پیامک تکراری دوباره ارسال نشده',
  legacy_skipped: 'موعد گذشته؛ پیامک‌های گذشته ارسال نمی‌شوند',
};
const smsErrors: Record<string, string> = {
  expert_mobile_missing: 'شماره موبایل کارشناس در حساب کاربری ثبت نشده است.',
  invalid_phone: 'شماره موبایل کارشناس معتبر نیست.',
  expert_inactive: 'حساب کارشناس غیرفعال است.',
  sms_disabled: 'ارسال پیامک در تنظیمات غیرفعال است.',
  sms_relay_not_configured: 'ارتباط با سامانه پیامک آماده نیست.',
  sms_provider_rejected: 'سامانه پیامک ارسال را نپذیرفت.',
  sms_delivery_unknown: 'پاسخ قطعی ارسال دریافت نشد.',
};
export function ReminderDetailsDialog({ reminder, onClose }: { reminder: Reminder; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = contentRef.current?.closest('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab' && dialog) {
        const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  return <Modal title="جزئیات یادآور" eyebrow={`یادآور #${reminder.id}`} testId="reminder-details" onClose={onClose}>
    <div ref={contentRef} className="reminder-details">
      <h4 data-testid="reminder-details-subject">{reminder.subject}</h4>
      <dl className="reminder-details-fields">
        <dt>وضعیت</dt><dd>{reminder.done ? 'انجام‌شده' : 'باز'}</dd>
        <dt>مشتری</dt><dd>{reminder.customerName || (reminder.customerId ? `مشتری #${reminder.customerId}` : 'یادآور عمومی')}</dd>
        {reminder.customerId != null && <><dt>کارشناس پرونده</dt><dd>{reminder.customerSalespersonName || 'بدون تخصیص'}</dd></>}
        <dt>موعد یادآوری</dt><dd>{formatDateTime(reminder.remindAt)}</dd>
        <dt>زمان ثبت</dt><dd>{formatDateTime(reminder.createdAt)}</dd>
        <dt>زمان نمایش اعلان</dt><dd>{reminder.notifiedAt ? formatDateTime(reminder.notifiedAt) : 'هنوز نمایش داده نشده'}</dd>
        <dt>پیامک کارشناس</dt><dd data-testid="reminder-sms-status">{reminder.smsSent ? 'ارسال‌شده' : smsLabels[reminder.smsStatus ?? 'pending'] ?? 'ارسال نشده'}
          {reminder.smsError && <small style={{ display: 'block', color: '#be123c', marginTop: 5 }}>{smsErrors[reminder.smsError] ?? 'ارسال پیامک با مشکل مواجه شده است.'}</small>}
        </dd>
      </dl>
      <h4>متن کامل یادآور</h4>
      <div className="reminder-details-message" data-testid="reminder-details-message">{reminder.message || 'متنی ثبت نشده است.'}</div>
      <h4>تماس هنگام ثبت یادآور</h4>
      {reminder.sourceCall ? <div className="reminder-details-message" data-testid="reminder-source-call">
        <dl className="reminder-details-fields">
          <dt>زمان تماس</dt><dd>{formatDateTime(reminder.sourceCall.createdAt)}</dd>
          <dt>موضوع تماس</dt><dd data-testid="reminder-call-subject">{reminder.sourceCall.subject || 'موضوعی ثبت نشده است.'}</dd>
          <dt>کارشناس تماس</dt><dd>{reminder.sourceCall.salespersonName || 'ثبت نشده'}</dd>
        </dl>
        <h4>یادداشت کارشناس</h4>
        <div data-testid="reminder-call-notes" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reminder.sourceCall.expertNotes || 'یادداشتی ثبت نشده است.'}</div>
        {reminder.sourceCall.customerRequest && <><h4>درخواست مشتری</h4><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reminder.sourceCall.customerRequest}</div></>}
      </div> : <p data-testid="reminder-no-call-history">{reminder.callHistoryStatus === 'restricted' ? 'دسترسی به تاریخچه این تماس برای شما مجاز نیست.' : 'بدون تاریخچه تماس'}</p>}
      <div className="form-footer">
        <button type="button" className="btn btn-primary" onClick={onClose} data-testid="button-dismiss-reminder-details">بستن</button>
      </div>
    </div>
  </Modal>;
}
