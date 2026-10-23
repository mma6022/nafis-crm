/**
 * Full-screen page loader (framework-agnostic core; same file in nafisvam-web and the CRM).
 *
 * start(): covers the page at once with an INVISIBLE layer that swallows clicks (no double clicks), and only fades
 * the logo in if the wait passes `delay` (~300 ms, per Omid's loader README) → no flicker on fast loads. After `timeout` (~15 s) it turns into
 * a small Persian error card with «تلاش دوباره» / «بستن». stop() removes everything. The DOM and the <style> are
 * created on first use only (nothing on first load). The logo/animation come from ./loader-mark (one swappable file, loaded lazily).
 *
 * A11y: role=status + aria-live=polite («در حال بارگذاری…»), aria-busy on the busy region, role=alert on the error.
 */
type Mark = typeof import('./loader-mark');

// The logo (SVG + its CSS, ~6.5 KB) is a separate lazy chunk: prefetched when the browser is idle after load and
// again on start(), so it never weighs on first paint; the click lock itself needs none of it.
let mark: Mark | null = null;
let markP: Promise<Mark | null> | null = null;
const onMark = new Set<() => void>();
export function loadLoaderMark(): Promise<Mark | null> {
  markP ??= import('./loader-mark').then(
    (m) => {
      mark = m;
      if (!document.getElementById('nfpl-mark-css')) {
        const s = document.createElement('style');
        s.id = 'nfpl-mark-css';
        s.textContent = m.LOADER_MARK_CSS;
        document.head.appendChild(s);
      }
      for (const f of onMark) f();
      return m;
    },
    () => {
      markP = null; // offline etc.: the loader still works (text only); try again next time
      return null;
    },
  );
  return markP;
}
function prefetchMark() {
  const go = () => void loadLoaderMark();
  // first sign of interaction (finger down comes before the click) or browser idle after load, whichever is first
  for (const t of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(t, go, { once: true, passive: true, capture: true });
  const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 4000 }) : setTimeout(go, 1500));
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}
const markSvg = (still = false) => {
  // still on its way (very slow network, tapped right after load): three CSS dots until the logo arrives
  if (!mark) return '<span class="nfpl-ph" aria-hidden="true"><i></i><i></i><i></i></span>';
  return still ? mark.LOADER_MARK_SVG.replace('class="nfpl-mark"', 'class="nfpl-mark nfpl-still"') : mark.LOADER_MARK_SVG;
};

export interface PageLoaderOptions {
  delay?: number;
  timeout?: number;
  /** «تلاش دوباره» on the timeout card */
  onRetry: () => void;
  /** «بستن» on the timeout card (after the loader is removed) */
  onClose?: () => void;
  /** element that gets aria-busy (default <body>) */
  busyTarget?: () => HTMLElement | null;
}

export interface PageLoader {
  start(): void;
  stop(): void;
  readonly active: boolean;
  readonly visible: boolean;
}

export const LOADER_TEXT = 'در حال بارگذاری…';
export const LOADER_TIMEOUT_TEXT = 'بارگذاری بیشتر از حد معمول طول کشید. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.';

const CSS =
  '.nfpl{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;background:rgba(255,255,255,.82);' +
  'opacity:0;transition:opacity .2s ease;cursor:progress;-webkit-tap-highlight-color:transparent;touch-action:none;contain:strict}' +
  '.nfpl[hidden]{display:none}.nfpl.is-on{opacity:1}' +
  '.nfpl-box{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px;text-align:center;' +
  'font:500 14px/1.7 Vazirmatn,Tahoma,system-ui,sans-serif;color:#0B1450;direction:rtl}' +
  '.nfpl-err{cursor:auto;max-width:min(340px,88vw);background:#fff;border:1px solid #E3E6F3;border-radius:16px;' +
  'box-shadow:0 12px 32px rgba(11,20,80,.14);padding:22px 20px}' +
  '.nfpl-err p{margin:0;font-size:15px}.nfpl-acts{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}' +
  '.nfpl-b{font:inherit;font-weight:700;min-height:44px;padding:0 18px;border-radius:12px;cursor:pointer;border:1px solid #29369B}' +
  '.nfpl-b1{background:#29369B;color:#fff}.nfpl-b2{background:#fff;color:#29369B}' +
  '.nfpl-b:focus-visible{outline:2px solid #29369B;outline-offset:2px}' +
  '.nfpl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
  '.nfpl-still,.nfpl-still *{animation:none!important}' +
  '.nfpl-ph{display:flex;align-items:center;justify-content:center;gap:8px;width:96px;height:96px}' +
  '.nfpl-ph i{width:12px;height:12px;border-radius:50%;background:#29369B;animation:nfpl-b 1.2s ease-in-out infinite}' +
  '.nfpl-ph i:nth-child(2){animation-delay:.15s}.nfpl-ph i:nth-child(3){animation-delay:.3s}' +
  '@keyframes nfpl-b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-8px);opacity:1}}' +
  '@media (max-width:640px){.nfpl-ph{width:72px;height:72px}}' +
  '@media (prefers-reduced-motion:reduce){.nfpl-ph i{animation:none;opacity:1}}' +
  '@media (prefers-reduced-motion:reduce){.nfpl{transition:opacity .3s linear}}';

export function createPageLoader(o: PageLoaderOptions): PageLoader {
  const delay = o.delay ?? 300;
  const timeout = o.timeout ?? 15_000;
  let el: HTMLDivElement | null = null;
  let active = false;
  let visible = false;
  let tShow = 0;
  let tFail = 0;
  let failed = false;

  prefetchMark();
  const busy = () => (o.busyTarget ? o.busyTarget() : document.body);

  function ensure(): HTMLDivElement {
    if (el && el.isConnected) return el;
    if (!document.getElementById('nfpl-css')) {
      const s = document.createElement('style');
      s.id = 'nfpl-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    el = document.createElement('div');
    el.className = 'nfpl';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-page-loader', '');
    document.body.appendChild(el);
    return el;
  }

  // While active, nothing behind the layer can be clicked or submitted (covers keyboard activation too).
  const block = (e: Event) => {
    if (!active || failed) return;
    if (el && e.target instanceof Node && el.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  onMark.add(() => {
    const ph = el?.querySelector('.nfpl-ph');
    if (ph) ph.outerHTML = markSvg(failed);
  });

  function show() {
    if (!active || !el) return;
    visible = true;
    el.innerHTML = `<div class="nfpl-box">${markSvg()}<span>${LOADER_TEXT}</span></div>`;
    void el.offsetWidth; // commit opacity:0 before the transition
    el.classList.add('is-on');
  }

  function fail() {
    if (!active || !el) return;
    failed = true;
    visible = true;
    el.classList.add('is-on');
    el.innerHTML =
      `<div class="nfpl-box nfpl-err" role="alert">${markSvg(true)}` +
      `<p>${LOADER_TIMEOUT_TEXT}</p><div class="nfpl-acts">` +
      '<button type="button" class="nfpl-b nfpl-b1" data-act="retry">تلاش دوباره</button>' +
      '<button type="button" class="nfpl-b nfpl-b2" data-act="close">بستن</button></div></div>';
    el.style.cursor = 'auto';
    el.onclick = (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act === 'retry') {
        stop();
        o.onRetry();
      } else if (act === 'close') {
        stop();
        o.onClose?.();
      }
    };
    el.querySelector<HTMLElement>('[data-act=retry]')?.focus();
  }

  function start() {
    if (active) return;
    const n = ensure();
    active = true;
    failed = false;
    n.hidden = false;
    busy()?.setAttribute('aria-busy', 'true');
    window.addEventListener('click', block, true);
    window.addEventListener('submit', block, true);
    window.addEventListener('keydown', blockKeys, true);
    if (!mark) void loadLoaderMark();
    tShow = window.setTimeout(show, delay);
    tFail = window.setTimeout(fail, timeout);
  }

  function blockKeys(e: KeyboardEvent) {
    if (!active || failed) return;
    if (e.key === 'Enter' || e.key === ' ') block(e);
  }

  function stop() {
    window.clearTimeout(tShow);
    window.clearTimeout(tFail);
    window.removeEventListener('click', block, true);
    window.removeEventListener('submit', block, true);
    window.removeEventListener('keydown', blockKeys, true);
    if (active) busy()?.removeAttribute('aria-busy');
    active = visible = failed = false;
    if (el) {
      el.classList.remove('is-on');
      el.hidden = true;
      el.innerHTML = '';
      el.style.cursor = '';
      el.onclick = null;
    }
  }

  return {
    start,
    stop,
    get active() {
      return active;
    },
    get visible() {
      return visible;
    },
  };
}
