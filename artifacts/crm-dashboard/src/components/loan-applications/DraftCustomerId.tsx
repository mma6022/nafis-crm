// Render spot for CustomerIdBadge (HANDOFF §5). feat/customer-id-badge ships first; when this branch is rebased on it,
// replace this file's body with:  export { CustomerIdBadge as DraftCustomerId } from '@/components/customer/CustomerName';
// Until then: the same props, markup and behaviour (focusable, copies Latin digits, never triggers the parent row).
import type { KeyboardEvent, MouseEvent, SyntheticEvent } from 'react';
import { toast } from '@/hooks/use-toast';
import './draft-customer-id.css';

const stop = (e: SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); };
async function copyText(text: string) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const a = document.createElement('textarea'); a.value = text; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0';
    document.body.appendChild(a); a.select(); const ok = document.execCommand('copy'); a.remove(); return ok;
  } catch { return false; }
}

export function DraftCustomerId({ id, className, testId }: { id: unknown; className?: string; testId?: string }) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const faId = n.toLocaleString('fa-IR', { useGrouping: false });
  const copy = async () => { const ok = await copyText(String(n)); toast(ok ? { title: 'کپی شد', duration: 1600 } : { title: 'کپی نشد', description: String(n), duration: 2500 }); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { stop(e); void copy(); } };
  return <span role="button" tabIndex={0} dir="ltr" className={`cust-id-badge${className ? ` ${className}` : ''}`}
    aria-label={`شماره‌ی مشتری ${faId}، برای کپی بزن`} title="کپی شماره‌ی مشتری" data-customer-id={n} data-testid={testId ?? 'customer-id-badge'}
    onClick={(e: MouseEvent) => { stop(e); void copy(); }} onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
    onKeyDown={key} onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') stop(e); }}>#{faId}</span>;
}
