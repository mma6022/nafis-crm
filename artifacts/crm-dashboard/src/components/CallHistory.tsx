import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { Clock3, MessageSquareText, PhoneCall, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CallReportDialog } from '@/components/voip/CallReportDialog';
import { getListCallsQueryKey, useListCalls, type CallRecord } from '@workspace/api-client-react';
import '@/components/voip/CallReportDialog.css';
import { Link } from 'wouter';
import { TXS, useCtConfig, useCustomerCtCalls } from '@/features/call-transcripts/api';
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
  // call-transcripts v1.1 (flag.call_transcripts.ui; OFF = nothing below renders): «متن و خلاصه‌ی تماس» link per recorded call.
  const ctCfg = useCtConfig(Boolean(customerId)).data;
  const ctOn = Boolean(ctCfg?.enabled);
  const ctChat = Boolean(ctCfg?.chat); // CT-CHAT (flag.call_transcripts.chat): «متن تماس» only on completed rows, a status chip on the rest
  const ctCalls = useCustomerCtCalls(customerId, ctOn).data?.calls ?? [];
  const ctByLog = new Map(ctCalls.filter((c) => c.hasRecording && c.callLogId != null).map((c) => [c.callLogId as number, c.eventId]));
  const ctRow = new Map(ctCalls.filter((c) => c.callLogId != null).map((c) => [c.callLogId as number, c]));
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
        <div key={call.id} className="call-history-item" style={{ display: 'contents' }}>
        <button
          type="button"
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
        {ctChat ? (() => { const r = ctRow.get(call.id); if (!r) return null;
          return r.textState === 'completed' ? <Link href={`/call-view/${r.eventId}`} className="call-history-ct" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: 'var(--nf-brand-600)', padding: '0 12px', minHeight: 44, border: '1px solid var(--nf-line)', borderRadius: 12, background: '#fff' }} data-testid={`link-call-transcript-${call.id}`}><MessageSquareText size={16} aria-hidden="true" />متن تماس</Link>
            : <span className="call-history-cts" style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 600, color: 'var(--nf-ink-muted)', padding: '4px 10px', borderRadius: 8, background: 'var(--nf-surface-2)' }} data-testid={`ct-state-${call.id}`} data-state={r.textState}>{TXS[r.textState]?.[0]}{r.textState === 'queued' || r.textState === 'waiting' ? '، در صف' : ''}</span>; })()
        : ctByLog.has(call.id) ? <Link href={`/call-view/${ctByLog.get(call.id)}`} className="call-history-ct" style={{ alignSelf: 'flex-start', fontSize: 14, fontWeight: 600, color: 'var(--nf-brand-600)', padding: '4px 10px', minHeight: 32 }} data-testid={`link-call-transcript-${call.id}`}>متن و خلاصه‌ی تماس</Link> : null}
        </div>
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
    <Modal title={`تاریخچه تماس‌های ${customerNameText(customerName || 'مشتری', customerId)}`} eyebrow="قبل و بعد هر مکالمه" onClose={onClose} testId="customer-call-history-modal">
      <div className="call-history-modal-intro">
        <MessageSquareText size={18} />
        <div>
          <strong><CustomerName id={customerId} name={customerName || 'مشتری'} /></strong>
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