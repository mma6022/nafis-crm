import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import './row-menu.css';

/**
 * crm-row-menu-fix (2026-10-24): the shared «⋯ کارهای بیشتر» menu for table rows.
 *
 * Earlier row menus were `<details>` + `position:absolute` pop-overs inside the table wrapper. That wrapper has
 * `overflow-x:auto` (which also clips vertically), so with a one-row search result, or on the last rows, the menu was
 * clipped or hidden. This renders the menu through a Radix portal on <body>, with `position:fixed` from the
 * floating layer. It flips up when there is no room below (`avoidCollisions` + `collisionPadding`), aligns to the trigger's
 * inline-end in RTL, and closes on outside click, Esc, page/table scroll and window resize. It is keyboard
 * accessible (Enter/Space/↓ open; ↑/↓/Home/End/typeahead move; Esc closes and focus returns to the trigger).
 */
export type RowMenuItem = {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Internal route: rendered as a real link (middle-click / new tab keep working). */
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
};

export function RowActionsMenu({ items, label, triggerTestId, triggerClassName, contentTestId, icon, iconSize = 20 }: {
  items: RowMenuItem[];
  /** Accessible name of the ⋯ trigger, e.g. «کارهای بیشتر برای علی رضایی». */
  label: string;
  triggerTestId?: string;
  triggerClassName?: string;
  contentTestId?: string;
  icon?: ReactNode;
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Where the trigger was when the menu opened. Focusing the trigger can nudge the horizontally scrollable table
    // wrapper by a pixel or two (seen on the one-row search result), which must not close the menu; a real scroll moves it.
    const at = trigger.current?.getBoundingClientRect();
    const onScroll = (e: Event) => {
      // Scrolling inside the menu itself (long menus on short screens) must not close it.
      if (content.current && e.target instanceof Node && content.current.contains(e.target)) return;
      const now = trigger.current?.getBoundingClientRect();
      if (at && now && Math.abs(now.left - at.left) < 4 && Math.abs(now.top - at.top) < 4) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onResize); };
  }, [open]);

  if (!items.length) return null;
  return <DropdownMenuPrimitive.Root dir="rtl" modal={false} open={open} onOpenChange={setOpen}>
    <DropdownMenuPrimitive.Trigger asChild ref={trigger}>
      <button type="button" className={`nf-rowmenu-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`} aria-label={label} title={label} data-testid={triggerTestId}
        // Row-level handlers (e.g. «click row → open report» in Calls) must not fire from the trigger.
        onClick={(e) => e.stopPropagation()}>
        {icon ?? <MoreHorizontal size={iconSize} aria-hidden="true" />}
      </button>
    </DropdownMenuPrimitive.Trigger>
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content ref={content} className="nf-rowmenu" side="bottom" align="end" sideOffset={6}
        avoidCollisions collisionPadding={8} sticky="partial" loop data-testid={contentTestId}
        // Clicks/keys inside the portal still bubble through the React tree; keep them away from row handlers.
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {items.map((it) => it.href
          ? <DropdownMenuPrimitive.Item key={it.key} asChild disabled={it.disabled} className={`nf-rowmenu-item${it.danger ? ' danger' : ''}`}>
              <Link href={it.href} data-testid={it.testId} aria-label={it.ariaLabel}>{it.icon}<span>{it.label}</span></Link>
            </DropdownMenuPrimitive.Item>
          : <DropdownMenuPrimitive.Item key={it.key} disabled={it.disabled} className={`nf-rowmenu-item${it.danger ? ' danger' : ''}`}
              onSelect={() => it.onSelect?.()} data-testid={it.testId} aria-label={it.ariaLabel}>{it.icon}<span>{it.label}</span></DropdownMenuPrimitive.Item>)}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  </DropdownMenuPrimitive.Root>;
}

/** Same items, rendered inline (mobile cards, which are not inside a clipping table wrapper). */
export function RowMenuInline({ items, className }: { items: RowMenuItem[]; className?: string }) {
  return <>{items.map((it) => it.href
    ? <Link key={it.key} href={it.href} className={`${className ?? ''}${it.danger ? ' danger' : ''}`.trim() || undefined} data-testid={it.testId} aria-label={it.ariaLabel}>{it.icon} {it.label}</Link>
    : <button key={it.key} type="button" className={it.danger ? 'danger' : undefined} disabled={it.disabled} onClick={() => it.onSelect?.()} data-testid={it.testId} aria-label={it.ariaLabel}>{it.icon} {it.label}</button>)}</>;
}
