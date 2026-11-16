/** SALES-FIXES 480000 (t810u item 9): the search button at the top. On tap the page dims and only a centred search box shows (enamad.ir style).
 *  Results = the expert's OWN matching customers and their cases (server-scoped GET /sales-fixes/search). A case opens the full case page
 *  (/loan-applications/:id); the browser back button returns to the board. A customer opens their «کارهای امروز من» customer page. */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Search, X, FolderOpen, User } from 'lucide-react';
import { loanStageLabel } from '@/lib/loan-labels';
import { toPersianDigits } from '@/lib/customer-id';
import { sfApi, fa, faDay, PRIO_FA, SF_SEARCH_EV, openSfSearch, type Sf480Hit } from './api';
import './sf480.css';

export function SfSearchButton({ big }: { big?: boolean }) {
  return <button type="button" className={big ? 'btn btn-ghost sf-sbtn big' : 'sf-sbtn'} onClick={openSfSearch} aria-label="جست‌وجوی مشتری یا پرونده" data-testid="sf-search-btn">
    <Search size={18} aria-hidden="true" /><span className="lt">جست‌وجو</span></button>;
}

const LIFE_FA: Record<string, string> = { in_progress: 'در حال انجام', completed: 'تکمیل‌شده', cancelled: 'لغوشده' };

export function SfSearchHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => { const on = () => setOpen(true); window.addEventListener(SF_SEARCH_EV, on); return () => window.removeEventListener(SF_SEARCH_EV, on); }, []);
  return open ? <SfSearchOverlay onClose={() => setOpen(false)} /> : null;
}

function SfSearchOverlay({ onClose }: { onClose: () => void }) {
  const [, setLoc] = useLocation();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Sf480Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; inp.current?.focus(); document.body.classList.add('sf-noscroll');
    return () => { document.body.classList.remove('sf-noscroll'); prev?.focus?.(); }; }, []);
  useEffect(() => {
    const t = q.trim(); if (t.length < 2) { setItems(null); setErr(''); return; }
    const ac = new AbortController(); setBusy(true);
    const h = window.setTimeout(() => { sfApi.search(t, ac.signal).then((r) => { setItems(r.items); setErr(''); }).catch((e) => { if (!ac.signal.aborted) setErr(e?.message || 'جست‌وجو انجام نشد.'); }).finally(() => { if (!ac.signal.aborted) setBusy(false); }); }, 250);
    return () => { ac.abort(); window.clearTimeout(h); };
  }, [q]);
  const go = (href: string) => { onClose(); setLoc(href); };
  return <div className="sf-ov" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }} data-testid="sf-search" data-nodnd="">
    <div className="sf-sbox" role="dialog" aria-modal="true" aria-label="جست‌وجو در مشتریان و پرونده‌های من">
      <div className="sf-sinp"><Search size={22} aria-hidden="true" />
        <input ref={inp} type="search" inputMode="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="نام، شماره یا شناسه‌ی مشتری…" aria-label="نام، شماره یا شناسه‌ی مشتری" data-testid="sf-search-q" />
        <button type="button" className="sf-sx" onClick={onClose} aria-label="بستن جست‌وجو" data-testid="sf-search-close"><X size={20} aria-hidden="true" /></button></div>
      <p className="sf-shint">فقط مشتری‌ها و پرونده‌های خودت. پرونده را بزن تا صفحه‌ی کاملش باز شود؛ با «برگشت» به همین‌جا برمی‌گردی.</p>
      <div className="sf-sres" aria-live="polite" data-testid="sf-search-res">
        {err ? <p className="sf-serr" role="alert">{err}</p>
          : q.trim().length < 2 ? <p className="sf-sempty">دست‌کم دو حرف یا چهار رقم بنویس.</p>
          : busy && !items ? <p className="sf-sempty">در حال جست‌وجو…</p>
          : items && !items.length ? <p className="sf-sempty" data-testid="sf-search-none">مشتری یا پرونده‌ای با «{toPersianDigits(q.trim())}» در فهرست تو پیدا نشد.</p>
          : (items ?? []).map((c) => <section key={c.id} className="sf-shit" data-testid="sf-hit">
            <button type="button" className="sf-scust" onClick={() => go(`/today?customer=${c.id}`)} data-testid="sf-hit-customer">
              <User size={18} aria-hidden="true" /><b>{toPersianDigits(c.name)}</b><span className="dp-id">#{fa(c.id)}</span>
              {c.phoneLast4 ? <span className="sf-mut" dir="ltr">•••{fa(c.phoneLast4)}</span> : null}
              {c.priority ? <span className="sf-pr">{PRIO_FA[c.priority] ?? ''}</span> : null}
              <span className="sf-go">صفحه‌ی مشتری</span></button>
            {c.cases.length ? <ul className="sf-scases">{c.cases.map((k) => <li key={k.id}>
              <button type="button" className="sf-scase" onClick={() => go(`/loan-applications/${k.id}`)} data-testid="sf-hit-case">
                <FolderOpen size={16} aria-hidden="true" /><span>پرونده {fa(k.id)}</span><span className="sf-mut">{k.planName ? toPersianDigits(k.planName) : 'بدون طرح'}</span>
                <span className={`sf-life ${k.life}`}>{LIFE_FA[k.life ?? ''] ?? ''}</span><span className="sf-mut">{loanStageLabel(k.stage)}</span>
                {k.createdAt ? <span className="sf-mut">{faDay(k.createdAt)}</span> : null}</button></li>)}</ul>
              : <p className="sf-mut sf-nocase">پرونده‌ی تسهیلات ندارد.</p>}
          </section>)}
      </div>
    </div>
  </div>;
}
