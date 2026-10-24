/**
 * crm-nid-quick (PM 16:37): tabs opened before a release keep running the old JS bundle until a reload,
 * so a fixed form (e.g. «ویرایش سریع» without «کد ملی») still behaves the old way for that user.
 * index.html is served no-cache and assets are hashed + immutable, so the served index.html always names
 * the current entry bundle. This watcher compares it with the bundle this tab is running and, when a new
 * release is live: shows a banner, reloads on the next in-app navigation, and reloads right away when the
 * tab is shown again with no form/dialog open. A failed lazy-chunk load (old chunk gone) also reloads once.
 */
const ENTRY_RE = /assets\/index-[A-Za-z0-9_-]+\.js/;
const CHECK_EVERY_MS = 2 * 60 * 1000;
const MIN_GAP_MS = 20 * 1000;
const RELOAD_GUARD_KEY = 'nafis.appVersion.reloadedFor';

export function entryFromHtml(html: string): string | null {
  const match = html.match(ENTRY_RE);
  return match ? match[0] : null;
}

function runningEntry(): string | null {
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
    const entry = entryFromHtml(script.getAttribute('src') ?? '');
    if (entry) return entry;
  }
  return null;
}

function formOrDialogOpen() {
  return Boolean(document.querySelector('[role="dialog"], [aria-modal="true"], .csx-formhost, .modal-backdrop'));
}

function reloadOnce(reason: string, servedEntry: string) {
  try {
    // Never loop: one automatic reload per served bundle per tab session.
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === servedEntry) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, servedEntry);
  } catch { /* storage blocked: still reload */ }
  console.info('[app-version] reloading:', reason);
  window.location.reload();
  return true;
}

function showBanner(servedEntry: string) {
  if (document.getElementById('app-update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'app-update-banner';
  bar.setAttribute('role', 'status');
  bar.setAttribute('dir', 'rtl');
  bar.dataset.testid = 'app-update-banner';
  bar.style.cssText = 'position:fixed;inset-inline:12px;bottom:12px;z-index:2147483000;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 14px;border-radius:12px;background:#0f172a;color:#fff;font:500 13px/1.7 Vazirmatn,Tahoma,sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.25);max-width:560px;margin-inline:auto';
  const text = document.createElement('span');
  text.textContent = 'نسخهٔ جدید پنل منتشر شده است. برای استفاده از آخرین تغییرات، صفحه را تازه کنید.';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.testid = 'button-app-update-reload';
  button.textContent = 'به‌روزرسانی';
  button.style.cssText = 'border:0;border-radius:8px;padding:6px 14px;background:#22c55e;color:#06210f;font:700 13px Vazirmatn,Tahoma,sans-serif;cursor:pointer';
  button.addEventListener('click', () => { try { sessionStorage.setItem(RELOAD_GUARD_KEY, servedEntry); } catch { /* ignore */ } window.location.reload(); });
  bar.append(text, button);
  document.body.appendChild(bar);
}

export function startAppVersionWatch() {
  if (import.meta.env.DEV || typeof window === 'undefined') return;
  const mine = runningEntry();
  // Lazy chunk of a removed release (stale tab): reload once instead of a broken screen.
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    reloadOnce('chunk load failed', `chunk:${mine ?? 'unknown'}`);
  });
  if (!mine) return;
  let served: string | null = null;
  let lastCheck = 0;
  const stale = () => served !== null && served !== mine;
  const onStale = () => {
    if (document.visibilityState === 'visible' && !formOrDialogOpen() && !document.hasFocus()) {
      if (reloadOnce('new release while idle', served!)) return;
    }
    showBanner(served!);
  };
  const check = async (force = false) => {
    const now = Date.now();
    if (stale() || (!force && now - lastCheck < MIN_GAP_MS)) return;
    lastCheck = now;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}?__v=${now}`, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' } });
      if (!response.ok) return;
      const entry = entryFromHtml(await response.text());
      if (entry && entry !== mine) { served = entry; onStale(); }
    } catch { /* offline: try later */ }
  };
  // In-app navigation unmounts the current page anyway: switch to the new release there.
  const wrap = (name: 'pushState' | 'replaceState') => {
    const original = history[name].bind(history);
    history[name] = ((...args: Parameters<History['pushState']>) => {
      const result = original(...args);
      if (stale() && name === 'pushState') reloadOnce('navigation after release', served!);
      return result;
    }) as History['pushState'];
  };
  wrap('pushState');
  window.addEventListener('popstate', () => { if (stale()) reloadOnce('navigation after release', served!); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (stale()) { if (!formOrDialogOpen()) reloadOnce('tab shown after release', served!); return; }
    void check();
  });
  window.addEventListener('focus', () => { void check(); });
  window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  window.setTimeout(() => { void check(true); }, 15 * 1000);
}
