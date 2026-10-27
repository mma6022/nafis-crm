/**
 * crm-call-queue R3 «بررسی سپردن» (spec §7ج-2/3): the receiver's live numbers when a hand-off does not meet the rule.
 * warn → the hand-off goes ahead only with a written reason («انتقال با نادیده گرفتن شرط», disabled until the reason is written).
 * block → no hand-off for Kazemi: the reason and the receiver's way back; an admin may still override with a reason.
 * Only shown when the server sends transferCheck (flag.transfer_check on).
 */
import { useState } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { TransferCheck } from './api';

const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
export const REASON_MIN = 5;

export function TransferCheckBox({ tc, pending, onOverride, actionLabel = 'انتقال با نادیده گرفتن شرط' }: {
  tc: TransferCheck; pending: boolean; onOverride: (reason: string) => void; actionLabel?: string;
}) {
  const [reason, setReason] = useState('');
  const r = reason.trim();
  const block = !tc.canOverride;
  return <div className={`ts-alert ${block ? '' : 'info'} ts-tc`} role="alert" data-testid="ts-transfer-check" data-mode={tc.settings.mode} style={{ flexDirection: 'column' }}>
    <div style={{ display: 'flex', gap: 8 }}>
      {block ? <ShieldAlert size={18} /> : <AlertTriangle size={18} />}
      <div>
        <b>{tc.eligible ? `${tc.name || 'کارشناس گیرنده'} امروز شرط دریافت مشتری را ندارد` : `سپردن به ${tc.name || 'این کاربر'} ممکن نیست`}</b>
        {tc.eligible ? <div data-testid="ts-tc-numbers" style={{ fontWeight: 500 }}>
          درصد به‌موقع: {tc.onTimePct == null ? 'هنوز تماسی نیست' : `${fa(tc.onTimePct)}٪`} (باید بالای {fa(tc.settings.newPct)}٪ باشد) ·
          پیگیری عقب‌افتاده: {fa(tc.overdue)} (باید کمتر از {fa(tc.settings.newMaxOverdue)} باشد)
        </div> : null}
        {tc.reasons.length ? <div style={{ fontWeight: 500 }} data-testid="ts-tc-reasons">{fa(tc.reasons.join('؛ '))}</div> : null}
        {block && tc.wayBack ? <div style={{ fontWeight: 500 }} data-testid="ts-tc-wayback">{fa(tc.wayBack)}</div> : null}
        {block ? <div style={{ fontWeight: 500 }}>{tc.eligible ? 'مدیر روی «جلوگیری» گذاشته است؛ سپردن انجام نشد و چیزی تغییر نکرد.' : 'چیزی تغییر نکرد.'}</div> : null}
      </div>
    </div>
    {!block ? <div style={{ width: '100%' }}>
      <label htmlFor="ts-tc-reason" className="ts-lbl">دلیل نادیده گرفتن شرط <span className="ts-muted">(اجباری؛ در گزارش مدیر ثبت می‌شود)</span></label>
      <textarea id="ts-tc-reason" className="ts-inp" rows={2} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} data-testid="ts-tc-reason" />
      {tc.reasonError ? <div data-testid="ts-tc-reason-error">{tc.reasonError}</div> : null}
      <button type="button" className="ts-primary" disabled={pending || r.length < REASON_MIN} onClick={() => onOverride(r)} data-testid="ts-tc-override">{pending ? 'در حال ثبت…' : actionLabel}</button>
    </div> : null}
  </div>;
}
