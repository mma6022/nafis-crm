import { useSyncExternalStore } from 'react';

/**
 * Multi-tab coordination (perf 2026-10-26). Staff keep many CRM tabs open; every tab used to hold its own SSE + long-polls
 * and poll the bell every 5 s even while hidden, which exhausted the browser's per-host connection pool and froze the UI.
 * - Exactly one tab per browser profile is the "leader" (Web Locks; it moves to another tab when the leader closes).
 * - Visible tabs work normally (but slower intervals); hidden tabs stay quiet except the leader, which keeps a slow
 *   background poll so the bell/title, chimes and the assistant still reach the user once.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let leader = false;
let started = false;
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* listener errors never break polling */ } } };

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', emit);
  window.addEventListener('focus', emit);
  const locks = (navigator as Navigator & { locks?: { request: (name: string, cb: () => Promise<void>) => Promise<void> } }).locks;
  if (!locks?.request) { leader = true; return; }
  // The callback holds the lock for the tab's lifetime; the browser releases it when the tab closes or is discarded.
  locks.request('nafis-crm-tab-leader', () => { leader = true; emit(); return new Promise<void>(() => {}); }).catch(() => { leader = true; emit(); });
}
start();

export const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
export const tabLeader = () => leader;
/** Background work (bell, assistant) runs in visible tabs and in the hidden leader only. */
export const tabMayPoll = () => tabVisible() || leader;
export function onTabStateChange(l: Listener): () => void { start(); listeners.add(l); return () => { listeners.delete(l); }; }

const snap = () => (tabVisible() ? 1 : 0) | (leader ? 2 : 0);
export function useTabState(): { visible: boolean; leader: boolean } {
  const s = useSyncExternalStore(onTabStateChange, snap, () => 1);
  return { visible: (s & 1) === 1, leader: (s & 2) === 2 };
}

/** Sleeps `ms`, but wakes early when the tab state changes (e.g. the tab is shown) or the signal aborts. */
export function tabSleep(ms: number, signal?: AbortSignal, wakeIf: () => boolean = tabVisible): Promise<void> {
  return new Promise<void>((resolve) => {
    let off = () => {};
    const done = () => { clearTimeout(t); off(); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    off = onTabStateChange(() => { if (wakeIf()) done(); });
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Cross-tab once: true only for the first tab that claims `key` (e.g. one chime per new notification across all tabs). */
export function claimOnce(key: string, ttlMs = 10 * 60_000): boolean {
  try {
    const k = 'nafis-once:' + key; const now = Date.now();
    const prev = Number(localStorage.getItem(k) || 0);
    if (prev && now - prev < ttlMs) return false;
    localStorage.setItem(k, String(now));
    // Opportunistic cleanup of old keys.
    if (Math.random() < 0.05) for (let i = localStorage.length - 1; i >= 0; i--) { const n = localStorage.key(i); if (n?.startsWith('nafis-once:') && now - Number(localStorage.getItem(n) || 0) > ttlMs) localStorage.removeItem(n); }
    return true;
  } catch { return true; }
}
