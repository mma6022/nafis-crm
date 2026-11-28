/* t984 §3: compact list header of «گفتگوهای بله» — the experts filter is a dropdown (label «کارشناس», default «همهٔ کارشناس‌ها»);
   status and star filters share ONE horizontally scrolling row with soft edge fades. Same filter state and server query as before. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { faDigits } from './model';
import './bale-fullheight.css';

export function ExpertDropdown({ experts, value, onChange }: { experts: { id: number; name: string }[]; value: number | ''; onChange: (n: number | '') => void }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null); const id = useId();
  const opts: { id: number | ''; name: string }[] = [{ id: '', name: 'همهٔ کارشناس‌ها' }, ...experts];
  const cur = opts.find((o) => o.id === value) ?? opts[0];
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const pick = (n: number | '') => { onChange(n); setOpen(false); btn.current?.focus(); };
  const move = (e: React.KeyboardEvent, i: number) => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role=option]'); if (!items) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)]?.focus(); }
  };
  return <div className="bfh-dd" ref={ref} data-testid="bfh-experts">
    <button ref={btn} type="button" className="bfh-ddb" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
      <span className="lab">کارشناس</span><span className="val">{cur.name}</span>
      <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open ? <div className="bfh-ddm" id={id} role="listbox" aria-label="کارشناس">
      {opts.map((o, i) => <button key={String(o.id)} type="button" role="option" aria-selected={o.id === value} className={`opt${o.id === value ? ' on' : ''}`} autoFocus={o.id === value}
        onClick={() => pick(o.id)} onKeyDown={(e) => move(e, i)}>{o.name}{o.id === value ? <span className="tick" aria-hidden="true">✓</span> : null}</button>)}
    </div> : null}
  </div>;
}

/** One scrolling row. The fade shows only on a side that still has chips hidden behind it (RTL aware: scrollLeft is 0 at the start = right edge, negative while scrolled). */
export function ChipRow({ children, label }: { children: ReactNode; label: string }) {
  const sc = useRef<HTMLDivElement>(null); const [fade, setFade] = useState({ l: false, r: false });
  const upd = () => { const el = sc.current; if (!el) return; const max = el.scrollWidth - el.clientWidth; const x = Math.abs(el.scrollLeft); const l = max > 2 && x < max - 2; const r = max > 2 && x > 2; setFade((p) => (p.l === l && p.r === r ? p : { l, r })); };
  useLayoutEffect(() => { upd(); const el = sc.current; if (!el) return; const ro = new ResizeObserver(upd); ro.observe(el); return () => ro.disconnect(); });
  return <div className="bfh-hs" data-fade-l={fade.l || undefined} data-fade-r={fade.r || undefined}>
    <div className="bfh-fl" ref={sc} onScroll={upd} role="group" aria-label={label} data-testid="bfh-filters">{children}</div>
  </div>;
}

export function Stars({ n }: { n: number }) {
  return <span className="bfh-stars" aria-hidden="true">{Array.from({ length: n }, (_, i) => <svg key={i} viewBox="0 0 24 24"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" /></svg>)}</span>;
}

export const StatusChip = ({ on, onClick, children, n }: { on: boolean; onClick: () => void; children: ReactNode; n?: number }) =>
  <button type="button" role="radio" aria-checked={on} className={`bfh-chip${on ? ' on' : ''}`} onClick={onClick}>{children}{n ? <span className="n">{faDigits(n)}</span> : null}</button>;
export const StarChip = ({ on, onClick, stars, label, n, text }: { on: boolean; onClick: () => void; stars?: number; label: string; n?: number; text?: string }) =>
  <button type="button" aria-pressed={on} aria-label={label} className={`bfh-chip st${on ? ' on' : ''}`} onClick={onClick}>{stars ? <Stars n={stars} /> : null}{text}{n ? <span className="n g">{faDigits(n)}</span> : null}</button>;
