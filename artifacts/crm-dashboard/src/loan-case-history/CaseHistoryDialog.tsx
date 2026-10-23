import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { historyActionLabel, historyDetailsFa } from '@/lib/loan-history-fa.mjs';
import { fetchHistory, type HistoryEvent } from './api';
import './case-history.css';

const when = (v: string) => new Date(v).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function CaseHistoryDialog({ applicationId, onClose }: { applicationId: number; onClose: () => void }) {
  const [items, setItems] = useState<HistoryEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const cursorRef = useRef<string | null>(null); cursorRef.current = cursor;
  const alive = useRef(true);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  const load = useCallback(async (before: string | null) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const page = await fetchHistory(applicationId, before, 30);
      if (!alive.current) return;
      setItems(prev => { const m = new Map(prev.map(i => [i.id, i])); page.items.forEach(i => m.set(i.id, i)); return [...m.values()].sort((a, b) => b.id - a.id); });
      setCursor(page.nextCursor); setStatus('ok'); setError('');
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'دریافت تاریخچه ممکن نشد.'); if (!before) setStatus('error'); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }, [applicationId]);

  useEffect(() => { alive.current = true; void load(null); return () => { alive.current = false; }; }, [load]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = prevOverflow; opener?.focus?.(); };
  }, []);

  useEffect(() => {
    const el = sentinel.current, root = body.current;
    if (!el || !root || cursor == null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) void load(cursorRef.current); }, { root, rootMargin: '100px' });
    io.observe(el); return () => io.disconnect();
  }, [cursor, load, items.length]);

  return createPortal(
    <div className="ch-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ch-dialog" ref={box} role="dialog" aria-modal="true" aria-labelledby="ch-title" data-testid="modal-case-history">
        <div className="ch-head"><div><div className="eyebrow">فقط‌خواندنی</div><h3 id="ch-title">تاریخچه پرونده</h3></div>
          <button type="button" className="modal-close" data-autofocus onClick={onClose} aria-label="بستن" data-testid="button-close-case-history"><X size={19} /></button></div>
        <div className="ch-body" ref={body} data-testid="case-history-list">
          {status === 'loading' && <div className="cn-skel" role="status" aria-label="در حال دریافت">{[0, 1, 2, 3].map(i => <span key={i} />)}</div>}
          {status === 'error' && <div className="cn-empty" role="alert">{error}<br /><button type="button" className="btn btn-ghost" onClick={() => { setStatus('loading'); void load(null); }}>تلاش دوباره</button></div>}
          {status === 'ok' && !items.length && <div className="cn-empty">هیچ سابقه عملیاتی ثبت نشده است.</div>}
          <div className="timeline">
            {items.map(h => <div className="timeline-item" key={h.id}>
              <h4>{historyActionLabel(h.action)}</h4>
              {h.reason ? <p>{historyDetailsFa(h.reason)}</p> : null}
              <time>{when(h.createdAt)}{h.author?.name ? ` · ${h.author.name}` : ''}</time>
            </div>)}
          </div>
          {status === 'ok' && cursor != null && <div ref={sentinel} className="cn-more"><button type="button" disabled={busy} onClick={() => void load(cursor)}>{busy ? 'در حال دریافت…' : 'موارد قدیمی‌تر'}</button></div>}
          {status === 'ok' && error && <div className="cn-err" role="alert">{error}</div>}
        </div>
      </div>
    </div>, document.body);
}
