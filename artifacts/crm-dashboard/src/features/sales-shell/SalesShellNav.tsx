/** SALES-SHELL v2 (Armita sales-shell-redesign v1.0.1): desktop bottom dock (≥1024) / mobile 5-slot tab bar + «بیشتر» sheet.
 *  Pure presentation: the shell passes the SAME permission/lock-filtered nav items it used for the old sidebar, so nothing is lost.
 *  Layers (spec §5): header 30 < scrim 38 / «بیشتر» 39 < dock 40 < modals 60+ < reminder lock. The dock is inert under any modal. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import { LayoutGrid, LifeBuoy, LogOut, Moon, UserPlus } from 'lucide-react';
import { faNum } from './api';
import './sales-shell.css';

export type SsBadge = { n: number; tone: 'r' | 'g' | 'n'; what: string };
export type SsItem = { key: string; href?: string; label: string; full: string; icon: ReactNode; badge?: SsBadge | null; moon?: boolean; onSelect?: () => void; testId: string; avatar?: boolean };
export type SsGroup = { title: string; items: SsItem[] };

const PRIMARY_FULL = 'الان مشتری جدید دارم';
const PRIMARY_ARIA = 'الان مشتری جدید دارم: تماس ورودی؛ مشتری قبلی یا جدید، کار جاری عوض نمی‌شود';
const PRIMARY_TIP = 'تماس ورودی؛ کار جاری عوض نمی‌شود';
const MORE_ARIA = 'بیشتر: یادآورها، پیام‌ها، دستیار و بقیه';

const ariaOf = (it: SsItem) => it.badge && it.badge.n > 0 ? `${it.full}، ${faNum(it.badge.n)} ${it.badge.what}` : it.full;
const badgeEl = (b?: SsBadge | null) => b && b.n > 0 ? <b className={`ss-bdg${b.tone === 'r' ? '' : ` ${b.tone}`}`} aria-hidden="true">{b.n > 99 ? '+۹۹' : faNum(b.n)}</b> : null;
const sumBadges = (items: SsItem[]) => items.reduce((s, i) => s + (i.badge?.n ?? 0), 0);

/** Overlay watch: any open dialog/modal outside the shell nav → dock/bar inert; an aria-modal one outside <main> → main inert too. */
const OV_SEL = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],.modal-backdrop,.call-sheet-backdrop,.ch-backdrop,.ic-sheet,[vaul-drawer]';
export function useSsOverlay(main: HTMLElement | null) {
  const [st, setSt] = useState({ any: false, outsideMain: false });
  useEffect(() => {
    let f = 0;
    const check = () => {
      f = 0;
      const shown = Array.from(document.querySelectorAll<HTMLElement>(OV_SEL)).filter((el) => {
        if (el.closest('.ss-more,.nas-chw,.nas-qr,.diag-layer-content,.diag-backdrop,.sn-panel')) return false;
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false;
        const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const outsideMain = shown.some((el) => (el.matches('[aria-modal="true"],.modal-backdrop') || el.closest('.rmm-x')) && !(main && main.contains(el)));
      setSt((p) => (p.any === shown.length > 0 && p.outsideMain === outsideMain ? p : { any: shown.length > 0, outsideMain }));
    };
    const sch = () => { if (!f) f = requestAnimationFrame(check); };
    const mo = new MutationObserver(sch);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-modal', 'open', 'hidden', 'style', 'class'] });
    sch();
    return () => { mo.disconnect(); if (f) cancelAnimationFrame(f); };
  }, [main]);
  return st;
}

/** Roving tabindex inside one nav: a single Tab stop; ← next (RTL), → previous, Home/End. */
function useRoving(count: number, activeIdx: number) {
  const [idx, setIdx] = useState(Math.max(0, activeIdx));
  const refs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => { setIdx(Math.max(0, Math.min(count - 1, activeIdx))); }, [activeIdx, count]);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const k = e.key; if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) return;
    const cur = refs.current.findIndex((el) => el === document.activeElement); const from = cur >= 0 ? cur : idx;
    const n = k === 'Home' ? 0 : k === 'End' ? count - 1 : k === 'ArrowLeft' ? (from + 1) % count : (from - 1 + count) % count;
    e.preventDefault(); setIdx(n); refs.current[n]?.focus();
  }, [count, idx]);
  const bind = (i: number) => ({ tabIndex: i === idx ? 0 : -1, ref: (el: HTMLElement | null) => { refs.current[i] = el; }, onFocus: () => setIdx(i) });
  return { bind, onKeyDown };
}

type Props = {
  before: SsItem[]; after: SsItem[]; // desktop dock, right → left around the primary button
  tabs: SsItem[]; // mobile: today, customers | files
  daily: SsItem[]; // mobile «بیشتر» › کار هر روز
  groups: SsGroup[]; // «پرونده و پرداخت», «حساب من»
  primary: (() => void) | null;
  isActive: (href: string) => boolean;
  healthOk: boolean;
  onLogout: () => void; logoutPending: boolean;
  location: string; mobile: boolean; blocked: boolean;
};

export function SalesShellNav(p: Props) {
  const [open, setOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { setOpen(false); }, [p.location, p.mobile]);
  useEffect(() => { if (p.blocked) setOpen(false); }, [p.blocked]);
  const close = useCallback((focus: boolean) => { setOpen(false); if (focus) window.setTimeout(() => moreBtn.current?.focus(), 0); }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    window.addEventListener('keydown', k, true);
    window.setTimeout(() => panel.current?.querySelector<HTMLElement>('a,button')?.focus(), 0);
    return () => window.removeEventListener('keydown', k, true);
  }, [open, close]);

  const moreGroups: SsGroup[] = useMemo(() => [...(p.mobile && p.daily.length ? [{ title: 'کار هر روز', items: p.daily }] : []), ...p.groups].filter((g) => g.items.length), [p.mobile, p.daily, p.groups]);
  const moreItems = moreGroups.flatMap((g) => g.items);
  const moreN = sumBadges(moreItems);
  const moreActive = moreItems.some((i) => i.href && p.isActive(i.href));
  const moreHas = moreItems.length > 0 || true; // «خروج» and «پشتیبانی تیم» always live there

  const dockList = p.mobile ? p.tabs : [...p.before, ...p.after];
  const activeOf = (it: SsItem) => Boolean(it.href && p.isActive(it.href));
  // focus order = DOM order: [before…, primary, after…, more] (desktop) / [tabs[0..1], primary, tabs[2..], more] (mobile)
  const order: ('p' | 'm' | SsItem)[] = p.mobile
    ? [...p.tabs.slice(0, 2), ...(p.primary ? ['p' as const] : []), ...p.tabs.slice(2), ...(moreHas ? ['m' as const] : [])]
    : [...p.before, ...(p.primary ? ['p' as const] : []), ...p.after, ...(moreHas ? ['m' as const] : [])];
  const activeIdx = order.findIndex((o) => typeof o === 'object' ? activeOf(o) : o === 'm' && moreActive);
  const rv = useRoving(order.length, activeIdx);

  const itemEl = (it: SsItem, i: number) => {
    const act = activeOf(it);
    const inner = <>
      <span className={`${p.mobile ? 'ss-tb-ic' : 'ss-ic'}${it.avatar ? ' ss-avx' : ''}`} aria-hidden="true">{it.icon}{badgeEl(it.badge)}{it.moon ? <span className="ss-moon"><Moon size={13} /></span> : null}</span>
      <span className="ss-lb">{it.label}</span>
      {!p.mobile ? <span className="ss-tip" aria-hidden="true">{it.full}</span> : null}
    </>;
    const cls = p.mobile ? 'ss-tb-i' : 'ss-i';
    const common = { className: cls, 'aria-label': ariaOf(it), 'data-testid': `ss-${it.testId}`, ...rv.bind(i) };
    if (it.href) return <Link key={it.key} href={it.href} {...common} aria-current={act ? 'page' : undefined} {...(it.key === 'ast' ? { 'data-ss-ast': '' } : {})}>{inner}</Link>;
    return <button key={it.key} type="button" {...common} onClick={it.onSelect} {...(it.key === 'ast' ? { 'data-ss-ast': '' } : {})}>{inner}</button>;
  };
  const primaryEl = (i: number) => p.mobile
    ? <button key="primary" type="button" className="ss-tb-p" aria-label={PRIMARY_ARIA} onClick={p.primary!} data-testid="ss-primary" {...rv.bind(i)}>
        <span className="ss-pc" aria-hidden="true"><UserPlus size={26} /></span><span className="ss-pf" aria-hidden="true">{PRIMARY_FULL}</span><span className="ss-ps" aria-hidden="true">مشتری جدید</span>
      </button>
    : <button key="primary" type="button" className="ss-p" aria-label={PRIMARY_ARIA} onClick={p.primary!} data-testid="ss-primary" {...rv.bind(i)}>
        <span className="ss-pi" aria-hidden="true"><UserPlus size={24} /></span><span aria-hidden="true">{PRIMARY_FULL}</span><span className="ss-tip" aria-hidden="true">{PRIMARY_TIP}</span>
      </button>;
  const moreEl = (i: number) => <button key="more" type="button" ref={(el) => { moreBtn.current = el; rv.bind(i).ref(el); }} tabIndex={rv.bind(i).tabIndex} onFocus={rv.bind(i).onFocus}
      className={p.mobile ? 'ss-tb-i' : 'ss-i'} aria-label={moreN ? `${MORE_ARIA}، ${faNum(moreN)} مورد تازه` : MORE_ARIA} aria-expanded={open} aria-controls="ss-more" aria-current={moreActive ? 'page' : undefined}
      onClick={() => setOpen((o) => !o)} data-testid="ss-more-btn">
      <span className={p.mobile ? 'ss-tb-ic' : 'ss-ic'} aria-hidden="true"><LayoutGrid size={24} />{moreN ? <b className="ss-bdg" aria-hidden="true">{moreN > 99 ? '+۹۹' : faNum(moreN)}</b> : null}</span>
      <span className="ss-lb">بیشتر</span>{!p.mobile ? <span className="ss-tip" aria-hidden="true">بیشتر</span> : null}
    </button>;

  let n = 0;
  const nodes: ReactNode[] = [];
  for (const o of order) {
    const i = n++;
    if (o === 'p') { if (!p.mobile) nodes.push(<span key="sep1" className="ss-sep" aria-hidden="true" />); nodes.push(primaryEl(i)); if (!p.mobile) nodes.push(<span key="sep2" className="ss-sep" aria-hidden="true" />); }
    else if (o === 'm') { if (!p.mobile) nodes.push(<span key="sep3" className="ss-sep" aria-hidden="true" />); nodes.push(moreEl(i)); }
    else nodes.push(itemEl(o, i));
  }
  void dockList;

  const tile = (it: SsItem) => {
    const act = activeOf(it);
    const inner = <><span className={`ss-ic${it.avatar ? ' ss-avx' : ''}`} aria-hidden="true">{it.icon}{badgeEl(it.badge)}{it.moon ? <span className="ss-moon"><Moon size={13} /></span> : null}</span><span>{it.label}</span></>;
    const pick = () => { close(false); it.onSelect?.(); };
    return it.href
      ? <Link key={it.key} href={it.href} className="ss-mt" aria-label={ariaOf(it)} aria-current={act ? 'page' : undefined} onClick={() => close(false)} data-testid={`ss-more-${it.testId}`}>{inner}</Link>
      : <button key={it.key} type="button" className="ss-mt" aria-label={ariaOf(it)} onClick={pick} data-testid={`ss-more-${it.testId}`}>{inner}</button>;
  };

  return <>
    <nav className={p.mobile ? 'ss-tb' : 'ss-dock'} aria-label="ناوبری اصلی" onKeyDown={rv.onKeyDown} inert={p.blocked || undefined} data-testid={p.mobile ? 'ss-tabbar' : 'ss-dock'}>{nodes}</nav>
    {open ? <>
      <div className={`ss-scrim${p.mobile ? '' : ' lite'}`} aria-hidden="true" onClick={() => close(false)} data-testid="ss-scrim" />
      <section ref={panel} id="ss-more" className={`ss-more ${p.mobile ? 'ss-msh' : 'ss-mpop'}`} aria-label="بیشتر" dir="rtl" data-testid="ss-more">
        {p.mobile ? <div className="ss-grab" aria-hidden="true" /> : null}
        {moreGroups.map((g) => <div key={g.title} className="ss-mg"><h3>{g.title}</h3><div className="ss-mgrid">{g.items.map(tile)}</div></div>)}
        <div className="ss-mfoot"><span className={p.healthOk ? 'is-ok' : ''}><LifeBuoy size={16} aria-hidden="true" /> پشتیبانی تیم: {p.healthOk ? 'سامانه در دسترس است' : 'در حال بررسی سامانه'}</span>
          <button type="button" className="btn btn-ghost" onClick={() => { close(false); p.onLogout(); }} disabled={p.logoutPending} data-testid="ss-logout"><LogOut size={16} aria-hidden="true" /> خروج</button></div>
      </section>
    </> : null}
  </>;
}

/** Keeps --ss-dock-h in sync with the rendered dock/bar so <main> never scrolls content under it. */
export function useDockHeight(mobile: boolean) {
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(mobile ? '.ss-tb' : '.ss-dock'); if (!el) return;
    const st = document.documentElement.style;
    const m = () => { const r = el.getBoundingClientRect(); st.setProperty('--ss-dock-h', `${Math.round(r.height)}px`); st.setProperty('--ss-dock-l', `${Math.round(r.left)}px`); };
    m(); const ro = new ResizeObserver(m); ro.observe(el); window.addEventListener('resize', m);
    return () => { ro.disconnect(); window.removeEventListener('resize', m); st.removeProperty('--ss-dock-h'); st.removeProperty('--ss-dock-l'); };
  }, [mobile]);
}
