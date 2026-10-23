/**
 * Site page loader (full page navigations of the static site). See ./page-loader-core for the overlay itself.
 * - Shows on qualifying same-origin link clicks and native form submits (never on first load).
 * - Ignored: tel:/mailto:/sms:, other origins (Emzami, WhatsApp/Telegram/Bale, Instagram…), downloads and file
 *   links, target other than _self, modifier/middle clicks, same-page #hash links, clicks a handler already
 *   preventDefault()ed (React islands, the menu), and anything with [data-no-loader].
 * - Back/forward cache: hidden on pagehide(persisted) and every pageshow, so a restored page is never stuck.
 * - Native form submits disable their submit button until the page changes (restored on pageshow / «بستن»).
 */
import { createPageLoader } from './page-loader-core';

export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}
export interface LinkLike {
  href: string;
  target?: string | null;
  download?: boolean;
  noLoader?: boolean;
}

const FILE_RE = /\.(pdf|zip|rar|png|jpe?g|webp|avif|gif|svg|ico|xml|txt|json|csv|xlsx?|docx?|mp4|mp3|webm)$/i;

/** The URL a click will navigate this tab to (and should show the loader for), or null. */
export function loaderUrlForLink(a: LinkLike, ev: ClickLike, here: string): URL | null {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
  if (a.noLoader || a.download) return null;
  const t = (a.target ?? '').trim().toLowerCase();
  if (t && t !== '_self') return null;
  let u: URL;
  let h: URL;
  try {
    h = new URL(here);
    u = new URL(a.href, h);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== h.origin) return null;
  if (FILE_RE.test(u.pathname)) return null;
  // same document, only the hash differs (or href="#…"): the browser scrolls, no page change
  if (u.pathname === h.pathname && u.search === h.search && (u.hash !== '' || a.href.trim().startsWith('#'))) return null;
  return u;
}

export interface FormLike {
  method: string;
  target?: string | null;
  action: string;
  defaultPrevented: boolean;
  noLoader?: boolean;
}
/** Native (non-JS) form submit that navigates this tab. */
export function loaderForSubmit(f: FormLike, here: string): boolean {
  if (f.defaultPrevented || f.noLoader) return false;
  if (f.method.toLowerCase() === 'dialog') return false;
  const t = (f.target ?? '').trim().toLowerCase();
  if (t && t !== '_self') return false;
  try {
    const u = new URL(f.action || here, here);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === new URL(here).origin;
  } catch {
    return false;
  }
}

export function initPageLoader() {
  let pending: string | null = null;
  const disabled: HTMLButtonElement[] = [];
  const restore = () => {
    for (const b of disabled.splice(0)) {
      b.disabled = false;
      b.removeAttribute('aria-busy');
      b.removeAttribute('aria-disabled');
    }
  };
  const loader = createPageLoader({
    busyTarget: () => document.getElementById('main') ?? document.body,
    onRetry: () => {
      restore();
      if (pending) location.assign(pending);
      else location.reload();
    },
    onClose: () => {
      try {
        window.stop(); // stay on this page: cancel the navigation still in flight
      } catch {
        /* ignore */
      }
      restore();
    },
  });

  // Bubble phase on window = after every other handler, so defaultPrevented is final.
  window.addEventListener('click', (e) => {
    if (loader.active) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement | SVGAElement>('a[href]') : null;
    if (!a || !(a instanceof HTMLAnchorElement)) return;
    const u = loaderUrlForLink(
      { href: a.getAttribute('href') ?? '', target: a.target, download: a.hasAttribute('download'), noLoader: a.closest('[data-no-loader]') != null },
      e,
      location.href,
    );
    if (!u) return;
    pending = u.href;
    loader.start();
  });

  window.addEventListener('submit', (e) => {
    if (loader.active) return;
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    const sub = (e as SubmitEvent).submitter;
    const ok = loaderForSubmit(
      {
        method: sub?.getAttribute('formmethod') ?? f.getAttribute('method') ?? 'get',
        target: sub?.getAttribute('formtarget') ?? f.getAttribute('target'),
        action: sub?.getAttribute('formaction') ?? f.getAttribute('action') ?? '',
        defaultPrevented: e.defaultPrevented,
        noLoader: f.hasAttribute('data-no-loader'),
      },
      location.href,
    );
    if (!ok) return;
    pending = null;
    if (sub instanceof HTMLButtonElement && !sub.disabled) {
      // Locked at once: aria-disabled now + the loader's capture-phase click/submit blockers (installed by start()
      // below, synchronously) swallow every repeat tap from this moment. Native `disabled` follows a task later,
      // because disabling the submitter inside its own submit event would drop its name/value from the request.
      sub.setAttribute('aria-disabled', 'true');
      sub.setAttribute('aria-busy', 'true');
      disabled.push(sub);
      setTimeout(() => {
        if (disabled.includes(sub)) sub.disabled = true;
      });
    }
    loader.start();
  });

  const reset = () => {
    loader.stop();
    restore();
    pending = null;
  };
  window.addEventListener('pageshow', reset);
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) reset();
  });
}
