import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  prepareRejectedContractResend, sendContractGeneration,
  getGetLoanApplicationQueryKey, getListContractGenerationsQueryKey,
} from '@workspace/api-client-react';
import { Send } from 'lucide-react';
import { Modal } from '@/components/DataTools';
import { useToast } from '@/hooks/use-toast';
import { CERTIFICATE_INACTIVE_MESSAGE, isCertificateInactiveError } from '@/lib/contract-send-errors.mjs';

export function RejectedContractResend({ applicationId, generationId, rejected, repairPending = false }: {
  applicationId: number; generationId: number; rejected: boolean; repairPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const send = useMutation({
    mutationFn: async () => {
      if (rejected || repairPending) await prepareRejectedContractResend(generationId);
      return sendContractGeneration(generationId);
    },
    onSuccess: () => {
      setOpen(false);
      toast({ title: 'درخواست امضا پذیرفته شد', description: 'امضامی ارسال را پذیرفت؛ وضعیت و دریافت مشتری را بررسی کنید.' });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(applicationId) }),
        queryClient.invalidateQueries({ queryKey: getListContractGenerationsQueryKey() }),
      ]);
    },
  });
  return <>
    <button type="button" className="btn btn-primary" data-testid="button-resend-rejected-contract"
      style={{ padding: '0 10px', height: 32 }} disabled={send.isPending}
      onClick={() => { send.reset(); setOpen(true); }}>
      <Send size={14} /> {repairPending ? 'اصلاح ارسال مجدد قرارداد' : rejected ? 'ارسال مجدد قرارداد ردشده' : 'تلاش مجدد ارسال قرارداد'}
    </button>
    {open && <Modal title="ارسال مجدد قرارداد" testId="modal-resend-rejected-contract" onClose={() => { if (!send.isPending) setOpen(false); }}>
      <p>همان سند، بدون تغییر مبلغ یا مفاد، با شناسهٔ فایل و درخواست تازه برای امضا ارسال می‌شود. سوابق ارسال قبلی حفظ می‌شود.</p>
      {repairPending && <p role="status">ارسال قبلی هنوز آمادهٔ امضاست، اما از فایل ردشده استفاده کرده است. این کار درخواست تازه ایجاد می‌کند و درخواست قبلی را خودکار لغو نمی‌کند. اگر مشتری قبلاً امضا کرده، ابتدا وضعیت امضا را بررسی کنید.</p>}
      {send.isError && isCertificateInactiveError(send.error) && <p className="form-error" role="alert" data-testid="error-resend-certificate-inactive">{CERTIFICATE_INACTIVE_MESSAGE}</p>}
      {send.isError && !isCertificateInactiveError(send.error) && <p className="form-error" role="alert">ارسال مجدد انجام نشد. وضعیت امضا را بررسی و صفحه را تازه‌سازی کنید؛ قرارداد امضاشده یا غیرجاری دوباره ارسال نمی‌شود.</p>}
      <button type="button" className="btn btn-primary" disabled={send.isPending || send.isError}
        onClick={() => send.mutate()}>{send.isPending ? 'در حال ارسال...' : 'تأیید و ارسال'}</button>
    </Modal>}
  </>;
}
