/**
 * PageLoaderBridge — app-wide hook-up of the full-screen page loader (customer portal + staff panel).
 * Mounted once inside <QueryClientProvider> and the wouter <Router>; no page has to change.
 *
 * Route changes: on every location change after the first render the click lock goes up at once (invisible layer
 * swallowing clicks/Enter), then if the new route is still waiting on data — a query with no data yet that is
 * fetching (status 'pending' + fetchStatus 'fetching') or a <Suspense> boundary (future lazy() chunks) — the
 * animated logo fades in after 300 ms. It closes once nothing is pending for 50 ms. Background refetches and polling
 * of data already on screen never count. 15 s → Persian error card: «تلاش دوباره» refetches what is pending,
 * «بستن» just closes. bfcache: reset on pageshow.
 *
 * Mutations: the button that was clicked / submitted right before a mutation starts is marked busy
 * (aria-disabled, aria-busy, data-nf-busy → no pointer events, clicks/submits on it swallowed) until that mutation
 * settles — success or error — so a form can't be sent twice and is usable again after an error. Native `disabled`
 * is not touched (React owns it).
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import { createPageLoader, type PageLoader } from './page-loader-core';

const SETTLE_MS = 50;
/** A mutation that starts within this time after a click/submit belongs to that button. */
const LINK_MS = 1000;

let suspended = 0;
const suspenseListeners = new Set<() => void>();
const notifySuspense = () => suspenseListeners.forEach((f) => f());

/** <Suspense fallback={<PageLoaderSuspense />}>: a lazy chunk / suspending route counts as "waiting". */
export function PageLoaderSuspense() {
  useLayoutEffect(() => {
    suspended++;
    notifySuspense();
    return () => {
      suspended--;
      notifySuspense();
    };
  }, []);
  return null;
}

const isWaiting = (q: Query) => q.state.status === 'pending' && q.state.fetchStatus === 'fetching' && q.getObserversCount() > 0;
const pendingCount = (qc: QueryClient) => qc.getQueryCache().findAll({ predicate: isWaiting }).length + suspended;

function useRouteLoader(qc: QueryClient) {
  const [location] = useLocation();
  const search = useSearch();
  const loader = useRef<PageLoader | null>(null);
  const first = useRef(true);
  const watch = useRef<() => void>(() => {});

  if (!loader.current && typeof document !== 'undefined') {
    loader.current = createPageLoader({
      delay: 300,
      timeout: 15_000,
      busyTarget: () => document.getElementById('root'),
      onRetry: () => {
        void qc.refetchQueries({ predicate: (q) => q.state.status === 'pending' || q.state.status === 'error', type: 'active' });
        watch.current();
      },
    });
  }

  // Layout effect: runs in the same task as the click that changed the route, before the browser handles the next
  // input event, so a rapid second tap already hits the lock.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    watch.current();
  }, [location, search]);

  useEffect(() => {
    const l = loader.current;
    if (!l) return;
    let tSettle = 0;
    let unsub: (() => void) | null = null;
    const done = () => {
      window.clearTimeout(tSettle);
      unsub?.();
      unsub = null;
      suspenseListeners.delete(check);
      l.stop();
    };
    function check() {
      if (!l!.active) return done();
      window.clearTimeout(tSettle);
      if (pendingCount(qc) === 0) tSettle = window.setTimeout(() => pendingCount(qc) === 0 && done(), SETTLE_MS);
    }
    watch.current = () => {
      l.start(); // lock now; logo only after 300 ms
      if (!unsub) unsub = qc.getQueryCache().subscribe(() => queueMicrotask(check));
      suspenseListeners.add(check);
      // queries of the new route subscribe right after commit: decide after they had the chance to start
      window.clearTimeout(tSettle);
      tSettle = window.setTimeout(check, SETTLE_MS);
    };
    const onShow = () => done();
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pageshow', onShow);
      done();
    };
  }, [qc]);
}

function useMutationButtons(qc: QueryClient) {
  useEffect(() => {
    if (!document.getElementById('nfpl-busy-css')) {
      const s = document.createElement('style');
      s.id = 'nfpl-busy-css';
      s.textContent = '[data-nf-busy]{pointer-events:none;cursor:progress;opacity:.65}';
      document.head.appendChild(s);
    }
    let last: { el: HTMLElement; at: number } | null = null;
    const byMutation = new Map<number, HTMLElement>();
    const count = new WeakMap<HTMLElement, number>();

    const remember = (e: Event) => {
      const t = e.type === 'submit' ? ((e as SubmitEvent).submitter ?? (e.target as HTMLFormElement).querySelector<HTMLElement>('[type=submit]')) : e.target instanceof Element ? e.target.closest<HTMLElement>('button,[role=button],input[type=submit]') : null;
      if (t?.hasAttribute('data-nf-busy')) {
        // still sending: swallow the repeat tap / Enter before any handler sees it
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (t) last = { el: t, at: performance.now() };
    };
    const blockForm = (e: Event) => {
      const f = e.target instanceof HTMLFormElement ? e.target : null;
      if (f?.querySelector('[data-nf-busy]')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else remember(e);
    };
    const mark = (el: HTMLElement) => {
      const n = (count.get(el) ?? 0) + 1;
      count.set(el, n);
      if (n > 1) return;
      el.setAttribute('data-nf-busy', '');
      el.setAttribute('aria-busy', 'true');
      if (!el.hasAttribute('aria-disabled')) {
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('data-nf-busy-aria', '');
      }
    };
    const unmark = (el: HTMLElement) => {
      const n = (count.get(el) ?? 1) - 1;
      count.set(el, n);
      if (n > 0) return;
      el.removeAttribute('data-nf-busy');
      el.removeAttribute('aria-busy');
      if (el.hasAttribute('data-nf-busy-aria')) {
        el.removeAttribute('aria-disabled');
        el.removeAttribute('data-nf-busy-aria');
      }
    };

    window.addEventListener('click', remember, true);
    window.addEventListener('submit', blockForm, true);
    const unsub = qc.getMutationCache().subscribe((ev) => {
      const m = ev.mutation;
      if (!m) return;
      const id = m.mutationId;
      const settled = m.state.status === 'success' || m.state.status === 'error';
      if (ev.type === 'added' || (ev.type === 'updated' && m.state.status === 'pending' && !byMutation.has(id))) {
        if (!last || performance.now() - last.at > LINK_MS || !last.el.isConnected || byMutation.has(id)) return;
        byMutation.set(id, last.el);
        mark(last.el);
      } else if ((ev.type === 'updated' && settled) || ev.type === 'removed') {
        const el = byMutation.get(id);
        if (!el) return;
        byMutation.delete(id);
        unmark(el);
      }
    });
    return () => {
      unsub();
      window.removeEventListener('click', remember, true);
      window.removeEventListener('submit', blockForm, true);
      byMutation.forEach((el) => unmark(el));
      byMutation.clear();
    };
  }, [qc]);
}

export function PageLoaderBridge() {
  const qc = useQueryClient();
  useRouteLoader(qc);
  useMutationButtons(qc);
  return null;
}
