import type { KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { Link } from 'wouter';
import { toast } from '@/hooks/use-toast';
import { customerIdOf, toPersianDigits } from '@/lib/customer-id';
import './customer-name.css';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const stop = (event: SyntheticEvent) => {
  event.stopPropagation();
  event.preventDefault();
};

/**
 * Small grey «#۱۲۳۴» pill. Click / Enter / Space copies the Latin-digit id and shows «کپی شد».
 * Rendered as a focusable span (role=button) so it is valid inside row links, buttons and table rows,
 * and it never lets the click reach the parent row.
 */
export function CustomerIdBadge({ id, className, testId }: { id: unknown; className?: string; testId?: string }) {
  const value = customerIdOf(id);
  if (value === null) return null;
  const fa = toPersianDigits(value);
  const copy = async () => {
    const ok = await copyText(String(value));
    toast(ok ? { title: 'کپی شد', duration: 1600 } : { title: 'کپی نشد', description: String(value), duration: 2500 });
  };
  const onClick = (event: MouseEvent) => { stop(event); void copy(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') { stop(event); void copy(); }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') stop(event);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      dir="ltr"
      className={`cust-id-badge${className ? ` ${className}` : ''}`}
      aria-label={`کپی شناسه‌ی مشتری ${fa}`}
      title="کپی شناسه‌ی مشتری"
      data-customer-id={value}
      data-testid={testId ?? 'customer-id-badge'}
      onClick={onClick}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      #{fa}
    </span>
  );
}

type CustomerNameProps = {
  id: unknown;
  name: ReactNode;
  /** When set the name itself is a link; the badge stays outside the link. */
  href?: string;
  className?: string;
  nameClassName?: string;
  nameTestId?: string;
  badgeTestId?: string;
  /** Extra content rendered between the name and the badge (e.g. a status chip). */
  children?: ReactNode;
};

/** Customer name followed by its id badge. Use this wherever staff see a customer name. */
export function CustomerName({ id, name, href, className, nameClassName, nameTestId, badgeTestId, children }: CustomerNameProps) {
  const label = name === null || name === undefined || name === '' ? '—' : name;
  return (
    <span className={`cust-name${className ? ` ${className}` : ''}`}>
      {href
        ? <Link href={href} className={`cust-name__text${nameClassName ? ` ${nameClassName}` : ''}`} data-testid={nameTestId}>{label}</Link>
        : <span className={`cust-name__text${nameClassName ? ` ${nameClassName}` : ''}`} data-testid={nameTestId}>{label}</span>}
      {children}
      <CustomerIdBadge id={id} testId={badgeTestId} />
    </span>
  );
}

/** Plain-text form for places that can only hold text (e.g. <option>, document titles). */
export function customerNameText(name: unknown, id: unknown): string {
  const value = customerIdOf(id);
  const label = String(name ?? '').trim() || '—';
  return value === null ? label : `${label} #${toPersianDigits(value)}`;
}
