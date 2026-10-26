import { useState } from 'react';
import { toPersianDigits } from '@/lib/customer-id';
import { otherOwnerLabel, otherOwnerLimitedOf, otherOwnerMatchesOf, requestTransferCall, type TransferCallInfo } from '@/lib/other-owner';
import './other-owner.css';

/**
 * Faded, read-only hints for other salespersons' customers (exact id / mobile / full-name match).
 * Never a link to the profile: partial name, #id, masked mobile and «کارشناس این مشتری: X» only.
 * The single action «انتقال تماس به کارشناسش» shows the owner's internal extension (Task C).
 * Rendered after the user's own results.
 */
export function OtherOwnerResults({ page, variant = 'block', testId = 'other-owner-results' }: {
  page: unknown; variant?: 'block' | 'inline'; testId?: string;
}) {
  const items = otherOwnerMatchesOf(page);
  const limited = otherOwnerLimitedOf(page);
  const [info, setInfo] = useState<Record<number, TransferCallInfo | { error: string } | 'loading'>>({});
  if (!items.length && !limited) return null;
  const transfer = async (id: number) => {
    setInfo((prev) => ({ ...prev, [id]: 'loading' }));
    try { const r = await requestTransferCall(id); setInfo((prev) => ({ ...prev, [id]: r })); }
    catch (error) { setInfo((prev) => ({ ...prev, [id]: { error: error instanceof Error ? error.message : 'خطا' } })); }
  };
  return (
    <div className={`oo-results oo-${variant}`} role="group" aria-label="مشتریان سایر کارشناسان" data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}>
      {items.length ? <p className="oo-title">مشتریان سایر کارشناسان</p> : null}
      {items.length ? <ul className="oo-list">
        {items.map((item) => {
          const state = info[item.id];
          return (
            <li key={item.id} className="oo-row" data-testid={`other-owner-${item.id}`}>
              <span className="oo-name">{item.name}</span>
              <span className="cust-id-badge oo-badge" dir="ltr" data-testid={`other-owner-badge-${item.id}`}>#{toPersianDigits(item.id)}</span>
              {item.maskedPhone ? <span className="oo-phone" dir="ltr" data-testid={`other-owner-masked-phone-${item.id}`}>{toPersianDigits(item.maskedPhone)}</span> : null}
              <span className="oo-owner" data-testid={`other-owner-label-${item.id}`}>{otherOwnerLabel(item.ownerName)}</span>
              <span className="oo-actions">
                <button type="button" className="oo-transfer" data-testid={`button-transfer-call-${item.id}`}
                  disabled={state === 'loading'} onClick={(event) => { event.stopPropagation(); void transfer(item.id); }}>
                  {state === 'loading' ? 'در حال دریافت…' : 'انتقال تماس به کارشناسش'}
                </button>
                {state && state !== 'loading' && 'error' in state ? <span className="oo-transfer-error" role="alert">{state.error}</span> : null}
                {state && state !== 'loading' && !('error' in state) ? <span className="oo-transfer-info" role="status" data-testid={`transfer-call-info-${item.id}`}>
                  {state.extension ? <>داخلی {state.ownerName}: <b dir="ltr">{toPersianDigits(state.extension)}</b></> : <>برای {state.ownerName} داخلی ثبت نشده است</>}
                  {state.notified ? ' · به کارشناس اطلاع داده شد' : ''}
                </span> : null}
              </span>
            </li>
          );
        })}
      </ul> : null}
      {limited ? <p className="oo-limit" role="status" data-testid="other-owner-limited">جست‌وجو در مشتریان سایر کارشناسان موقتاً محدود شده است؛ چند دقیقهٔ دیگر دوباره تلاش کنید.</p> : null}
    </div>
  );
}
