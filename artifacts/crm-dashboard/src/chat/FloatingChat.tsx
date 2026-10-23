import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MessageCircle, RotateCcw } from 'lucide-react';
import { Link } from 'wouter';
import '@/internal-chat/ic.css';

export type LauncherItem = { href: string; label: string; count: number };
const SIZE = 54;
type Pos = { x: number; y: number };
const read = (k: string): Pos | null => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null; } catch { return null; } };

export function FloatingChat({ actor, items, bottomOffset = 20 }: { actor: string; items: LauncherItem[]; bottomOffset?: number }) {
  const key = `chat-launcher:${actor}`;
  const clamp = useCallback((p: Pos): Pos => ({ x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - SIZE)), y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - SIZE)) }), []);
  const home = useCallback((): Pos => clamp({ x: 16, y: window.innerHeight - SIZE - bottomOffset }), [clamp, bottomOffset]);
  const [custom, setCustom] = useState<Pos | null>(() => read(key));
  const [pos, setPos] = useState<Pos>(() => clamp(read(key) ?? { x: 16, y: window.innerHeight - SIZE - bottomOffset }));
  const [open, setOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { const c = read(key); setCustom(c); setPos(clamp(c ?? home())); }, [key, clamp, home]);
  useEffect(() => {
    const f = () => setPos(p => clamp(custom ? p : home()));
    window.addEventListener('resize', f); return () => window.removeEventListener('resize', f);
  }, [clamp, home, custom]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const save = (p: Pos) => { setPos(p); setCustom(p); try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ } };
  const reset = () => { try { localStorage.removeItem(key); } catch { /* ignore */ } setCustom(null); setPos(home()); };
  const down = (e: PointerEvent<HTMLButtonElement>) => { drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true; setOpen(false); setPos(clamp({ x: d.ox + dx, y: d.oy + dy }));
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current; drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.moved) save(clamp({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy })); else setOpen(o => !o);
  };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const s = e.shiftKey ? 48 : 16; const m: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
    if (e.key in m) { e.preventDefault(); save(clamp({ x: pos.x + m[e.key][0], y: pos.y + m[e.key][1] })); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); }
  };
  const total = items.reduce((a, i) => a + i.count, 0);
  const below = pos.y > window.innerHeight / 2;
  const right = pos.x > window.innerWidth / 2;
  return <div ref={root} className="ic-launch" style={{ transform: `translate(${pos.x}px,${pos.y}px)` }} data-testid="floating-chat">
    <button type="button" className="ic-fab" aria-label={`گفتگو${total ? ` — ${total} پیام خوانده‌نشده` : ''}`} aria-haspopup="menu" aria-expanded={open}
      title="گفتگو (برای جابه‌جایی بکشید یا با کلیدهای جهت‌دار حرکت دهید)" onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={() => { drag.current = null; }} onKeyDown={keys} onClick={e => { e.preventDefault(); if (e.detail === 0) setOpen(o => !o); }} data-testid="button-chat-launcher">
      <MessageCircle size={24} />{total > 0 && <b data-testid="badge-launcher-unread">{total.toLocaleString('fa-IR')}</b>}
    </button>
    {open && <div className="ic-menu" role="menu" style={{ [below ? 'bottom' : 'top']: SIZE + 8, [right ? 'right' : 'left']: 0 }}>
      {items.map(i => <Link key={i.href} href={i.href} role="menuitem" onClick={() => setOpen(false)} data-testid={`link-launcher-${i.href}`}><span>{i.label}</span>{i.count > 0 && <i aria-label={`${i.count} خوانده‌نشده`}>{i.count.toLocaleString('fa-IR')}</i>}</Link>)}
      <button type="button" role="menuitem" onClick={() => { reset(); setOpen(false); }} data-testid="button-launcher-reset"><RotateCcw size={14} /> بازنشانی جایگاه</button>
    </div>}
  </div>;
}
