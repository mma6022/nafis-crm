/**
 * v10 page-usage tracker (api-server lib/page-usage.ts). Sends ONLY: route pattern (ids → ":id", no query string), enter
 * time, active-tab dwell (visibilitychange), sidebar menu clicks and the entry source (menu / link / notification /
 * assistant / history / direct). No customer data. User 29 never sends. Batched via navigator.sendBeacon, falling back to
 * fetch keepalive; every failure is swallowed — the page is never affected.
 */
import { useEffect } from 'react';

type Source = 'menu' | 'link' | 'notification' | 'assistant' | 'history' | 'direct';
type Ev = { kind: 'visit' | 'dwell' | 'menu_click'; route: string; source?: Source; enteredAt: string; dwellMs?: number };
const EXCLUDED = [29];
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const URL_ = () => `${base()}/api/page-usage`;

export function routePattern(path: string): string {
  try {
    const p = String(path || '/').split(/[?#]/)[0];
    const segs = p.split('/').filter(Boolean).slice(0, 8).map(s => (/^[a-z][a-z_-]{0,39}$/i.test(s) ? s.toLowerCase() : ':id'));
    return '/' + segs.join('/');
  } catch { return '/'; }
}
function stripBase(href: string): string {
  const b = base(); let h = href;
  try { if (/^https?:/i.test(h)) h = new URL(h).pathname; } catch { /* ignore */ }
  return b && h.startsWith(b) ? h.slice(b.length) || '/' : h;
}

let queue: Ev[] = [];
let enabled = true;
function send(force = false) {
  try {
    if (!enabled || !queue.length) return;
    if (!force && queue.length < 10) return;
    const batch = queue.splice(0, 50); const body = JSON.stringify({ events: batch });
    let ok = false;
    try { ok = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(URL_(), new Blob([body], { type: 'application/json' })); } catch { ok = false; }
    if (!ok) {
      try {
        void fetch(URL_(), { method: 'POST', body, keepalive: true, credentials: 'include', headers: { 'Content-Type': 'application/json' } })
          .then(r => r.ok ? r.json().then((j: { enabled?: boolean }) => { if (j && j.enabled === false) { enabled = false; queue = []; } }).catch(() => undefined) : undefined)
          .catch(() => undefined);
      } catch { /* silent */ }
    }
    if (queue.length >= 10) send();
  } catch { /* silent */ }
}

/** Mount once in the CRM shell. `location` = wouter location (base-relative). */
export function usePageUsage(userId: number | null | undefined, location: string) {
  // config + global listeners (once per user)
  useEffect(() => {
    if (!userId || EXCLUDED.includes(Number(userId))) return;
    enabled = true;
    let alive = true;
    try {
      void fetch(`${base()}/api/page-usage/config`, { credentials: 'include' }).then(r => r.ok ? r.json() : null)
        .then((j: { enabled?: boolean } | null) => { if (alive && j && j.enabled === false) { enabled = false; queue = []; } }).catch(() => undefined);
    } catch { /* silent */ }
    const onClick = (e: MouseEvent) => {
      try {
        const t = e.target as Element | null; if (!t || !t.closest) return;
        const menu = t.closest('a.side-link') as HTMLAnchorElement | null;
        if (menu) {
          const href = routePattern(stripBase(menu.getAttribute('href') || ''));
          state.intent = { source: 'menu', at: Date.now() };
          if (enabled) { queue.push({ kind: 'menu_click', route: href, source: 'menu', enteredAt: new Date().toISOString() }); send(); }
          return;
        }
        const src: Source = t.closest('[class^="sn-"], [class*=" sn-"], [data-testid^="notification"], [data-testid*="-notification"]') ? 'notification'
          : t.closest('[class^="nas-"], [class*=" nas-"], [data-testid^="assistant"]') ? 'assistant' : 'link';
        state.intent = { source: src, at: Date.now() };
      } catch { /* silent */ }
    };
    const onPop = () => { state.intent = { source: 'history', at: Date.now() }; };
    const onVis = () => {
      try {
        if (document.visibilityState === 'hidden') { closeDwell(); send(true); }
        else if (state.route) state.visibleSince = Date.now();
      } catch { /* silent */ }
    };
    const onHide = () => { try { closeDwell(); send(true); } catch { /* silent */ } };
    const iv = window.setInterval(() => { try { closeDwell(); if (document.visibilityState === 'visible' && state.route) state.visibleSince = Date.now(); send(true); } catch { /* silent */ } }, 60_000);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPop);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      document.removeEventListener('click', onClick, true); window.removeEventListener('popstate', onPop);
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); window.clearInterval(iv);
      try { closeDwell(); send(true); } catch { /* silent */ }
      state.route = null;
    };
  }, [userId]);
  // page entries
  useEffect(() => {
    if (!userId || EXCLUDED.includes(Number(userId))) return;
    try {
      const route = routePattern(location);
      if (route === state.route) return;
      closeDwell();
      const i = state.intent; const fresh = i && Date.now() - i.at < 2000;
      const source: Source = state.route == null && !fresh ? 'direct' : fresh ? i!.source : 'link';
      state.intent = null; state.route = route; state.enteredAt = new Date().toISOString();
      state.visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
      if (enabled) { queue.push({ kind: 'visit', route, source, enteredAt: state.enteredAt }); send(); }
    } catch { /* silent */ }
  }, [userId, location]);
}
const state: { route: string | null; enteredAt: string; visibleSince: number | null; intent: { source: Source; at: number } | null } = { route: null, enteredAt: '', visibleSince: null, intent: null };
function closeDwell() {
  if (!state.route || state.visibleSince == null) return;
  const ms = Date.now() - state.visibleSince; state.visibleSince = null;
  if (enabled && ms >= 500) queue.push({ kind: 'dwell', route: state.route, enteredAt: state.enteredAt, dwellMs: Math.min(ms, 4 * 3600_000) });
}
