/**
 * Expert picker behaviour (markup: components/experts/ExpertPicker.astro; spec: Armita CONTACT-EXPERTS.md). Lazy:
 * scripts/chrome.ts imports this module on the first pointer/focus/click on a `[data-experts]` trigger.
 * Native modal <dialog> (top layer, rest of the page inert) + explicit Tab focus trap; initial focus on «بستن»;
 * Esc / backdrop click / × close; focus returns to the trigger; ↑/↓/Home/End move between experts.
 * < 768px bottom sheet (CSS); ≥ 768px a 400px popover (max 100vw − 32px) anchored under the trigger (above it if there is no room),
 * clamped to the viewport and re-positioned on scroll / resize. prefers-reduced-motion: no animation (CSS).
 */
import type { PickerMode } from '../data/picker-trigger'; // type only: no data / link templates in the client bundle

const ICON: Record<PickerMode, string> = { call: 'phone', whatsapp: 'wa', telegram: 'tg', bale: 'bale' };
const wide = matchMedia('(min-width:768px)');
let opener: HTMLElement | null = null;
let wired = false;

const focusables = (d: HTMLElement) =>
  [...d.querySelectorAll<HTMLElement>('a[href]:not([hidden]),button')].filter((el) => !el.closest('[hidden]'));

function place(d: HTMLDialogElement) {
  const card = d.querySelector<HTMLElement>('.xp-card');
  if (!card) return;
  if (!wide.matches || !opener || !opener.getClientRects().length) {
    card.style.removeProperty('--xp-x');
    card.style.removeProperty('--xp-y');
    return;
  }
  const r = opener.getBoundingClientRect();
  const w = card.offsetWidth || 400;
  const h = card.offsetHeight || 300;
  const M = 12;
  const vw = document.documentElement.clientWidth;
  const vh = innerHeight;
  // RTL: align the card's right edge with the trigger's right edge, then clamp into the viewport
  let x = r.right - w;
  x = Math.max(M, Math.min(x, vw - w - M));
  let y = r.bottom + 8;
  if (y + h > vh - M && r.top - 8 - h >= M) y = r.top - 8 - h;
  y = Math.max(M, Math.min(y, vh - h - M));
  card.style.setProperty('--xp-x', `${Math.round(x)}px`);
  card.style.setProperty('--xp-y', `${Math.round(y)}px`);
}

function close(d: HTMLDialogElement) {
  if (d.open) d.close();
}

function wire(d: HTMLDialogElement) {
  if (wired) return;
  wired = true;
  const reposition = () => d.open && place(d);
  addEventListener('resize', reposition, { passive: true });
  addEventListener('scroll', reposition, { passive: true, capture: true });
  wide.addEventListener('change', reposition);
  d.addEventListener('close', () => {
    document.documentElement.classList.remove('xp-lock');
    const o = opener;
    opener = null;
    if (o && o.isConnected && o.getClientRects().length) o.focus({ preventScroll: true });
    else document.getElementById('menu-btn')?.focus({ preventScroll: true }); // opener was in the (now closed) mobile menu
  });
  // backdrop click: the dialog box itself is the area around .xp-card
  d.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest('[data-xp-close]')) close(d);
    else if (t.closest('a[href]')) setTimeout(() => close(d), 0); // picked: let the link open, then close
  });
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(d);
  });
  d.addEventListener('keydown', (e) => {
    const f = focusables(d);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(d);
    } else if (e.key === 'Tab') {
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && (i === f.length - 1 || i === -1)) {
        e.preventDefault();
        f[0].focus();
      }
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const links = f.filter((el) => el.tagName === 'A');
      const j = links.indexOf(document.activeElement as HTMLElement);
      const n = links.length;
      if (!n) return;
      const k = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowDown' ? (j + 1) % n : (j - 1 + n) % n;
      e.preventDefault();
      links[k]?.focus();
    }
  });
}

export function openPicker(mode: PickerMode, from: HTMLElement | null) {
  const d = document.getElementById('xp') as HTMLDialogElement | null;
  if (!d) return false;
  wire(d);
  const m: PickerMode = mode in ICON ? mode : 'call';
  d.dataset.mode = m;
  d.querySelectorAll<HTMLElement>('[data-ch]').forEach((el) => (el.hidden = el.dataset.ch !== m));
  d.querySelector('#xp-ic')?.setAttribute('href', `#i-${ICON[m]}`);
  const via = d.querySelector('#xp-via');
  if (via) via.textContent = d.getAttribute(`data-via-${m}`) || '';
  opener = from;
  if (!wide.matches) document.documentElement.classList.add('xp-lock');
  if (typeof d.showModal === 'function') d.showModal();
  else d.setAttribute('open', '');
  place(d);
  d.querySelector<HTMLElement>('[data-xp-close]')?.focus();
  return true;
}
