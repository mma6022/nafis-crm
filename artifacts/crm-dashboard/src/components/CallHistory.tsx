import { Clock3, MessageSquareText, PhoneCall, UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { getListCallsQueryKey, useListCalls, type CallRecord } from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';

type HistoryProps = {
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  selectedCallId?: number | null;
  onSelectCall?: (call: CallRecord) => void;
  compact?: boolean;
};

export function CustomerCallHistory({
  customerId,
  customerName,
  selectedCallId,
  onSelectCall,
  compact = false,
}: HistoryProps) {
  const params = { customerId: customerId || undefined, limit: compact ? 5 : 500, offset: 0 };
  const calls = useListCalls(params, {
    query: {
      queryKey: getListCallsQueryKey(params),
      enabled: Boolean(customerId),
      staleTime: 15_000,
    },
  });
  const items = calls.data?.items ?? [];
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
      {items.map((call) => (
        <button
          type="button"
          key={call.id}
          ref={call.id === selectedCallId ? selectedRowRef : undefined}
          className={`call-history-row ${call.id === selectedCallId ? 'selected' : ''}`}
          onClick={() => onSelectCall?.(call)}
          data-testid={`button-call-history-${call.id}`}
        >
          <span className="call-history-marker"><PhoneCall size={13} /></span>
          <span className="call-history-main">
            <span className="call-history-title">{call.subject || 'تماس پیگیری'}</span>
            <span className="call-history-summary">
              <strong>درخواست مشتری:</strong> {call.customerRequest || 'ثبت نشده'}
            </span>
            <span className="call-history-summary">
              <strong>یادداشت کارشناس:</strong> {call.expertNotes || 'ثبت نشده'}
            </span>
          </span>
          <span className="call-history-meta">
            <time>{formatDateTime(call.createdAt)}</time>
            <span>{call.salespersonName || 'بدون تخصیص'}</span>
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