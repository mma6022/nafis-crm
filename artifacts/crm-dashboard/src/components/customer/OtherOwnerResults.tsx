import { toPersianDigits } from '@/lib/customer-id';
import { otherOwnerLabel, otherOwnerLimitedOf, otherOwnerMatchesOf } from '@/lib/other-owner';
import './other-owner.css';

/**
 * Faded, read-only hints for other salespersons' customers (exact id / mobile / full-name match).
 * Deliberately inert: no link, no button, no copy badge, no mobile — name, #id and owner only.
 * Rendered after the user's own results.
 */
export function OtherOwnerResults({ page, variant = 'block', testId = 'other-owner-results' }: {
  page: unknown; variant?: 'block' | 'inline'; testId?: string;
}) {
  const items = otherOwnerMatchesOf(page);
  const limited = otherOwnerLimitedOf(page);
  if (!items.length && !limited) return null;
  return (
    <div className={`oo-results oo-${variant}`} role="group" aria-label="مشتریان سایر کارشناسان" data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}>
      {items.length ? <p className="oo-title">مشتریان سایر کارشناسان</p> : null}
      {items.length ? <ul className="oo-list">
        {items.map((item) => (
          <li key={item.id} className="oo-row" aria-disabled="true" data-testid={`other-owner-${item.id}`}>
            <span className="oo-name">{item.name}</span>
            <span className="cust-id-badge oo-badge" dir="ltr" data-testid={`other-owner-badge-${item.id}`}>#{toPersianDigits(item.id)}</span>
            <span className="oo-owner" data-testid={`other-owner-label-${item.id}`}>{otherOwnerLabel(item.ownerName)}</span>
          </li>
        ))}
      </ul> : null}
      {limited ? <p className="oo-limit" role="status" data-testid="other-owner-limited">جست‌وجو در مشتریان سایر کارشناسان موقتاً محدود شده است؛ چند دقیقهٔ دیگر دوباره تلاش کنید.</p> : null}
    </div>
  );
}
