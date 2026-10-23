/* Shared presentational helpers for the «مشتریان» list + detail redesign (handoff screens/crm-customers).
   No data logic lives here. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const fa = (n: number) => n.toLocaleString('fa-IR');

/** «۲۰ دقیقه پیش», «دیروز», «۳ روز پیش» … falls back to a Jalali date after a week. */
export function relativeTime(value?: string | null) {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return 'همین حالا';
  if (diff < 3600) return `${fa(Math.floor(diff / 60))} دقیقه پیش`;
  if (diff < 86400) return `${fa(Math.floor(diff / 3600))} ساعت پیش`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return 'دیروز';
  if (days < 7) return `${fa(days)} روز پیش`;
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

export function jalaliDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const STATUS_LABEL: Record<string, string> = { in_progress: 'در حال انجام', completed: 'اتمام', cancelled: 'لغو شده' };

export function StatusPill({ status }: { status: string }) {
  return <span className="csx-st" data-s={status}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PriorityLabel({ value }: { value?: number | null }) {
  return <span className="csx-pr" data-p={value ?? undefined}>{value ? `اولویت ${fa(value)}` : 'بدون اولویت'}</span>;
}

export function initialsOf(name: string) {
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? '؟') + (parts.length > 1 ? '' : '');
}

/** Keeps focus inside a sheet/dialog, closes on Escape, restores focus to the opener on unmount. */
export function useDialogFocus(onClose: () => void, initialSelector?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = (initialSelector && node?.querySelector<HTMLElement>(initialSelector)) || node;
    first?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')).filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const [a, z] = [items[0], items[items.length - 1]];
      if (event.shiftKey && document.activeElement === a) { event.preventDefault(); z.focus(); }
      else if (!event.shiftKey && document.activeElement === z) { event.preventDefault(); a.focus(); }
    };
    node?.addEventListener('keydown', onKey);
    return () => { node?.removeEventListener('keydown', onKey); opener?.focus?.({ preventScroll: true }); };
  }, [initialSelector]);
  return ref;
}

export function Sheet({ title, onClose, children, footer, side, testId, initialFocus }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; side?: boolean; testId?: string; initialFocus?: string;
}) {
  const ref = useDialogFocus(onClose, initialFocus);
  const id = `csx-sheet-${testId ?? 'x'}`;
  return <>
    <div className="csx-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className={`csx-sheet${side ? ' side-sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} data-testid={testId} dir="rtl">
      <div className="grab" aria-hidden="true" />
      <div className="sh"><h2 id={id}>{title}</h2><button type="button" className="csx-ib" onClick={onClose} aria-label="بستن" data-testid={testId ? `${testId}-close` : undefined}><X size={22} /></button></div>
      {children}
      {footer ? <div className="csx-sfoot">{footer}</div> : null}
    </div>
  </>;
}

export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, pending, error, onConfirm, onClose, testId, cancelLabel = 'انصراف', tone = 'danger' }: {
  title: string; children: ReactNode; confirmLabel: string; pendingLabel?: string; pending?: boolean; error?: string;
  onConfirm: () => void; onClose: () => void; testId?: string; cancelLabel?: string; tone?: 'danger' | 'primary';
}) {
  const ref = useDialogFocus(onClose, '[data-autofocus]');
  return <>
    <div className="csx-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="csx-dlg" role="alertdialog" aria-modal="true" aria-labelledby="csx-dlg-title" aria-describedby="csx-dlg-desc" tabIndex={-1} data-testid={testId} dir="rtl">
      <h2 id="csx-dlg-title">{title}</h2>
      <div id="csx-dlg-desc" style={{ display: 'grid', gap: 8 }}>{children}</div>
      {error ? <div className="csx-note bad" role="alert"><p>{error}</p></div> : null}
      <div className="acts">
        <button type="button" className={tone === 'danger' ? 'csx-danger' : 'csx-primary'} onClick={onConfirm} disabled={pending} data-testid={testId ? `${testId}-confirm` : undefined}>{pending ? (pendingLabel ?? 'در حال انجام…') : confirmLabel}</button>
        <button type="button" className="csx-ghost" onClick={onClose} data-autofocus data-testid={testId ? `${testId}-cancel` : undefined}>{cancelLabel}</button>
      </div>
    </div>
  </>;
}
