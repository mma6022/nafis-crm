/** CALL-COPY v1.0.4 (Mohammad's direct request, Armita sales-shell-redesign v1.0.4 change 3 + the 13 revised screen folders):
 *  the desktop «تماس با [نام]» button is gone everywhere. The customer's full number is shown big, grouped, tabular, with a copy
 *  button and a «کپی شد» toast (copy is allowed in lockdown too). Desktop (≥700px): plain text, NO tel: link anywhere in the DOM.
 *  Below 700px: tapping the number dials, through the caller's own CRM call-start (`onDial`) — or, when the surface never had one,
 *  through cqTelClick (the lock's server call-start), exactly like the link it replaces.
 *  Shows exactly what the server sent: no masking or unmasking happens here (server scope rules unchanged). */
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cqDial, cqLockActive, cqTelClick } from '@/features/call-queue/api';
import './call-number.css';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const faD = (s: string) => s.replace(/\d/g, (d) => FA[Number(d)]);
/** 09121234567 → «۰۹۱۲ ۱۲۳ ۴۵۶۷» (thin no-break spaces; copy strips them). Other shapes stay as sent. */
export function groupPhone(p: string): string {
  const d = latin(p).replace(/^\+98/, '0').replace(/[^\d*]/g, '');
  const g = /^0\d{10}$/.test(d) ? `${d.slice(0, 4)}\u202f${d.slice(4, 7)}\u202f${d.slice(7)}` : d || latin(p);
  return faD(g);
}
/** Opens a tel: link the way the old buttons did (anchor click, so the page's own tel: handling still applies). */
export function dialTel(phone: string) {
  const d = latin(phone).replace(/[^\d+]/g, ''); if (!d) return;
  const a = document.createElement('a'); a.href = `tel:${d}`; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}
export const NARROW_QUERY = '(max-width: 699.98px)';
export function useNarrow(): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  const [n, setN] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(NARROW_QUERY); const on = () => setN(m.matches); on();
    m.addEventListener?.('change', on); return () => m.removeEventListener?.('change', on);
  }, []);
  return n;
}
export async function copyText(t: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); return true; } } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

type Props = {
  phone: string | null | undefined;
  /** Mobile tap: the surface's own CRM call-start (+ dial). */
  onDial?: () => void;
  /** Used only when there is no onDial: mobile tap goes through cqTelClick(customerId, via) like the old raw link. */
  customerId?: number | null; via?: string; onErr?: (m: string) => void;
  size?: 'lg' | 'md' | 'sm'; testId?: string; className?: string; disabled?: boolean;
};
export function CallNumber({ phone, onDial, customerId, via = 'number', onErr, size = 'lg', testId = 'cn', className = '', disabled = false }: Props) {
  const narrow = useNarrow();
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = window.setTimeout(() => setDone(false), 1800); return () => window.clearTimeout(t); }, [done]);
  const raw = latin(phone ?? '').replace(/^\+98/, '0');
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const masked = raw.includes('*');
  const shown = groupPhone(phone ?? '');
  const canDial = narrow && !masked && /^0?\d{7,}$/.test(digits);
  return (
    <span className={`cn cn-${size} ${className}`.trim()} data-testid={testId} data-mode={canDial ? 'tap' : 'text'}>
      {canDial
        ? <a className="cn-n cn-tap" href={`tel:${digits}`} dir="ltr" aria-label={`تماس با ${shown}`} data-testid={`${testId}-tel`}
            aria-disabled={disabled || undefined}
            onClick={(e) => { e.stopPropagation(); if (disabled) { e.preventDefault(); return; } if (onDial) { e.preventDefault(); onDial(); return; } cqTelClick(e, customerId, via, onErr); }}>{shown}</a>
        : <span className="cn-n" dir="ltr" data-testid={`${testId}-num`}>{shown}</span>}
      {masked ? null : <button type="button" className={`cn-c${done ? ' done' : ''}`} aria-label={`کپی شماره‌ی ${shown}`} title="کپی شماره" data-testid={`${testId}-copy`}
        onClick={(e) => { e.stopPropagation(); void copyText(digits).then((ok) => setDone(ok)); }}>
        {done ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
      </button>}
      {done ? <span className="cn-toast" role="status" data-testid={`${testId}-toast`}>کپی شد</span> : null}
    </span>
  );
}
/** The primary action that replaced «تماس با [نام]»: opens the result form through the surface's own call-start path. */
export const CALLED_LABEL = 'تماس گرفتم، ثبت نتیجه';

/** «تماس گرفتم، ثبت نتیجه» on surfaces whose old button was a tel: link through cqTelClick: with the call lock ON the same server
 *  call-start runs (no dial) and the lock's own «گزارش تماس» form opens; with the lock OFF the surface's result form opens. */
export async function calledThenForm(customerId: number | null | undefined, via: string, openForm: () => void, onErr?: (m: string) => void) {
  if (customerId && cqLockActive()) {
    const r = await cqDial(customerId, via, false);
    if (r && !r.ok) { onErr?.(r.error); return; }
    if (r) return;
  }
  openForm();
}
