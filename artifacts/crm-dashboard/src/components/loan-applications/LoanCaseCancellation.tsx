import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCancelLoanApplication, type LoanApplication } from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';

export function LoanCaseCancellation({ application }: { application: LoanApplication }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const cancel = useCancelLoanApplication({ mutation: {
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      setOpen(false); setReason('');
    },
  } });
  return <>
    {application.cancellationReason && <div className="form-error" role="status" data-testid="case-cancellation-reason">
      پرونده لغو شده است. دلیل لغو: {application.cancellationReason}
    </div>}
    {application.canCancel && <button type="button" className="btn btn-danger"
      data-testid="button-cancel-case" onClick={() => { cancel.reset(); setOpen(true); }}>
      لغو پرونده
    </button>}
    {open && <Modal title="لغو پرونده" testId="cancel-case"
      onClose={() => { if (!cancel.isPending) setOpen(false); }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!reason.trim() || cancel.isPending) return;
        cancel.mutate({ id: application.id, data: { reason: reason.trim() } });
      }}>
        <p>این پرونده در مرحله فعلی بسته می‌شود و ادامه مراحل آن متوقف خواهد شد. مدارک و سوابق حفظ می‌شوند.</p>
        <p>لغو پرونده پرداخت‌های قبلی را حذف نمی‌کند و باعث برگشت خودکار پول یا موجودی کیف پول نمی‌شود.</p>
        <label className="field case-cancellation-field">دلیل لغو (الزامی)
          <textarea required rows={5} maxLength={1000} value={reason}
            placeholder="دلیل لغو این پرونده را بنویسید…"
            onChange={event => setReason(event.target.value)}
            data-testid="input-case-cancellation-reason" />
        </label>
        {cancel.isError && <div className="form-error" role="alert">{cancel.error.message}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={cancel.isPending} onClick={() => setOpen(false)}>انصراف</button>
          <button type="submit" className="btn btn-danger" disabled={!reason.trim() || cancel.isPending}
            data-testid="button-confirm-case-cancellation">{cancel.isPending ? 'در حال لغو…' : 'تأیید لغو پرونده'}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
