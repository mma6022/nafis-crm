import { ChevronLeft } from 'lucide-react';
import { formatIntroDate, introStatusLabel, useCustomerIntroLog } from './api';

/** «پیامک معرفی کارشناس» in the customer's history: queued / sent / skipped (with reason) / failed. Hidden when empty. */
export function CustomerIntroLog({ customerId }: { customerId: number }) {
  const q = useCustomerIntroLog(customerId);
  const rows = q.data ?? [];
  if (!rows.length) return null;
  return (
    <details className="csx-sub" data-testid="section-expert-intro-sms"><summary>پیامک معرفی کارشناس ({rows.length.toLocaleString('fa-IR')}) <ChevronLeft size={16} /></summary>
      <div className="expert-intro-log">
        {rows.map((r) => <div className="expert-intro-log-row" key={r.id}>
          <span className={`delivery-status ${r.status === 'sent' ? 'sent' : r.status === 'failed' || r.status === 'uncertain' ? 'failed' : 'not_configured'}`}>{introStatusLabel(r.status)}</span>
          <span>{r.expertName ? `کارشناس: ${r.expertName}` : 'کارشناس'}{r.reason ? <span className="muted"> — {r.reason}</span> : null}</span>
          <time className="muted">{formatIntroDate(r.createdAt)}</time>
        </div>)}
      </div>
    </details>
  );
}
