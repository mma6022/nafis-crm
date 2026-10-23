import { Clock3, MessageSquareText, PhoneCall, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CallReportDialog } from '@/components/voip/CallReportDialog';
import { getListCallsQueryKey, useListCalls, type CallRecord } from '@workspace/api-client-react';
import '@/components/voip/CallReportDialog.css';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';
import { Pagination } from '@/components/DataTools';

type HistoryProps = {
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  customerSalespersonName?: string | null;
  selectedCallId?: number | null;
  onSelectCall?: (call: CallRecord) => void;
  compact?: boolean;
  limit?: number;
};

export function CustomerCallHistory({
  customerId,
  customerName,
  selectedCallId,
  compact = false,
  limit,
}: HistoryProps) {
  const [offset, setOffset] = useState(0);
  const pageLimit = limit ?? (compact ? 5 : 500);
  useEffect(() => setOffset(0), [customerId]);
  const params = { customerId: customerId || undefined, limit: pageLimit, offset };
  const calls = useListCalls(params, {
    query: {
      queryKey: getListCallsQueryKey(params),
      enabled: Boolean(customerId),
      staleTime: 15_000,
    },
  });
  const items = calls.data?.items ?? [];
  const [openId, setOpenId] = useState<number | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!compact && selectedCallId && items.length) {
      selectedRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [compact, items.length, selectedCallId]);

  if (!customerId) {
    return compact ? <div className="call-history-empty"><UserRound size={18} /><span>برای دیدن تماس‌های قبلی، ابتدا مشتری را انتخاب کنید.</span></div> : null;
  }
  if (calls.isLoading) {
    return <div className="call-history-empty"><Clock3 className="spin" size={18} /><span>در حال دریافت تاریخچه تماس‌ها…</span></div>;
  }
  if (calls.isError) {
    return <div className="profile-form-error">دریافت تاریخچه تماس‌ها انجام نشد.</div>;
  }
  if (!items.length) {
    return <div className="call-history-empty"><PhoneCall size={18} /><span>برای {customerName || 'این مشتری'} هنوز تماسی ثبت نشده است.</span></div>;
  }

  return (
    <div className={`customer-call-history ${compact ? 'compact' : ''}`} data-testid={`call-history-customer-${customerId}`}>
      {openId != null ? <CallReportDialog callId={openId} onClose={() => setOpenId(null)} /> : null}
      {limit != null && (calls.data?.total ?? 0) > pageLimit && <div className="call-history-page-controls" style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
        <Pagination total={calls.data?.total ?? 0} offset={offset} limit={pageLimit} onChange={setOffset} testId="call-history" />
      </div>}
      {items.map((call) => (
        <button
          type="button"
          key={call.id}
          ref={call.id === selectedCallId ? selectedRowRef : undefined}
          className={`call-history-row ${call.id === selectedCallId ? 'selected' : ''}`}
          onClick={() => setOpenId(call.id)}
          data-testid={`button-call-history-${call.id}`}
        >
          <span className="call-history-marker"><PhoneCall size={13} /></span>
          <span className="call-history-main">
            <span className="call-history-title cr-subject">{call.subject || 'تماس پیگیری'}</span>
            <span className="cr-notes">{call.expertNotes || 'یادداشت کارشناس ثبت نشده'}</span>
            {call.systemSummary ? <span className="cr-sys">{call.systemSummary}</span> : null}
          </span>
          <span className="call-history-meta">
            <time>{formatDateTime(call.createdAt)}</time>
            <span>کارشناس فروش ثبت‌شده: {call.salespersonName || 'ثبت نشده'}</span>
            <span>کارشناس فعلی پرونده: {call.customerSalespersonName || 'بدون تخصیص'}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function CallHistoryModal({
  customerId,
  customerName,
  customerPhone,
  customerSalespersonName,
  selectedCallId,
  onClose,
}: Required<Pick<HistoryProps, 'customerId'>> & Omit<HistoryProps, 'compact' | 'onSelectCall'> & { onClose: () => void }) {
  return (
    <Modal title={`تاریخچه تماس‌های ${customerName || 'مشتری'}`} eyebrow="قبل و بعد هر مکالمه" onClose={onClose} testId="customer-call-history-modal">
      <div className="call-history-modal-intro">
        <MessageSquareText size={18} />
        <div>
          <strong>{customerName || 'مشتری'}</strong>
          {customerPhone ? <span dir="ltr">{customerPhone}</span> : null}
          <span>کارشناس فعلی پرونده: {customerSalespersonName || 'بدون تخصیص'}</span>
          <p>تماس انتخاب‌شده با رنگ آبی مشخص شده است.</p>
        </div>
      </div>
      <CustomerCallHistory
        customerId={customerId}
        customerName={customerName}
        selectedCallId={selectedCallId}
      />
    </Modal>
  );
}