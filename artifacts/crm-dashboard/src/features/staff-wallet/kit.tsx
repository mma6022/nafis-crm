import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Bottom sheet on mobile, centred card on desktop (design kit .sheet). Escape and scrim close it. */
export function Sheet({ title, onClose, children, className = '', labelId }: { title: ReactNode; onClose: () => void; children: ReactNode; className?: string; labelId: string }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return <>
    <div className="scrim" onClick={onClose} aria-hidden="true" />
    <section className={`sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelId}>
      <div className="grab m-only" />
      <div className="sh"><h2 id={labelId}>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="بستن"><X className="i" /></button></div>
      {children}
    </section>
  </>;
}

export function Dlg({ onClose, children, labelId, busy }: { onClose: () => void; children: ReactNode; labelId: string; busy?: boolean }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose, busy]);
  return <>
    <div className="scrim" onClick={busy ? undefined : onClose} aria-hidden="true" />
    <section className="dlg" role="alertdialog" aria-modal="true" aria-labelledby={labelId}>{children}</section>
  </>;
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => { const t = window.setTimeout(onDone, 4000); return () => window.clearTimeout(t); }, [text, onDone]);
  return <div className="toast" role="status">{text}</div>;
}

/**
 * Single render point for a customer's name in the wallet and transaction-status pages.
 * Swap this body for the shared customer-ID badge (feat/customer-id-badge) on rebase; `id` is already passed everywhere.
 */
export function CustomerName({ name, id, fallback = '—' }: { name: string | null | undefined; id?: number | null; fallback?: ReactNode }) {
  void id;
  return <>{name ?? fallback}</>;
}
