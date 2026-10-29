/** SALES-SHELL v2 · Armita sales-shell-redesign v1.0.2 §4ج (Mohammad: the expert sees the full number): full number, LTR, bold,
 *  tap = call (tel:, or the caller's own CRM call handler so «تماس با دکمه‌ی CRM» is still recorded), 44px copy button.
 *  Shows exactly what the server sent — no masking here (UNMASK-EXPERT t674u decides what the server returns). Flag-ON users only. */
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import './sales-shell.css';

const fa = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

async function copyText(t: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); return true; } } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

export function PhoneLine({ phone, tel, onCall, testId = 'ss-ph' }: { phone: string; tel?: string | null; onCall?: () => void; testId?: string }) {
  const digits = latin(phone).replace(/[^\d+]/g, '');
  const shown = fa(latin(phone).replace(/^\+98/, '0'));
  const href = `tel:${tel || digits}`;
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = window.setTimeout(() => setDone(false), 1600); return () => window.clearTimeout(t); }, [done]);
  if (!digits) return null;
  return (
    <span className="ph" data-testid={testId}>
      <a className="phn" href={href} dir="ltr" aria-label={`تماس با ${shown}`} data-testid={`${testId}-tel`}
        onClick={onCall ? (e) => { e.preventDefault(); onCall(); } : undefined}>{shown}</a>
      <button type="button" className={`phc${done ? ' done' : ''}`} aria-label={`کپی شماره‌ی ${shown}`} data-testid={`${testId}-copy`}
        onClick={() => { void copyText(latin(phone).replace(/^\+98/, '0').replace(/[^\d]/g, '')).then((ok) => setDone(ok)); }}>
        {done ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
      </button>
      {done ? <span className="ss-sr" role="status">کپی شد</span> : null}
    </span>
  );
}
