import { useEffect } from 'react';

/**
 * Keeps the floating helpers («گزارش خطا» pill + draggable chat bubble) from covering action buttons.
 * - While any modal / dialog / drawer / bottom-sheet is visible, body gets `nf-overlay-open` (helpers hidden).
 *   Modals already carry their own inline «گزارش خطا» button, so nothing is lost.
 * - On phones, while a sticky action footer is on screen, body gets `nf-footer-visible` (helpers hidden too).
 */
const OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.modal-backdrop',
  '.call-sheet-backdrop',
  '.ch-backdrop',
  '.ic-sheet',
  '.mobile-nav-overlay',
  '[vaul-drawer]',
].join(',');

const FOOTER_SELECTOR = ['.call-form-footer', '.mv-actions', '.nf-sticky-footer', '[data-sticky-footer]'].join(',');

const isShown = (el: Element) => {
  if (el.closest('.diag-layer-content, .diag-backdrop')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
};

export function useFloatingGuard() {
  useEffect(() => {
    const body = document.body;
    const phone = window.matchMedia('(max-width: 640px)');
    let frame = 0;
    const check = () => {
      frame = 0;
      const overlay = Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(isShown);
      let footer = false;
      if (phone.matches && !overlay) {
        const h = window.innerHeight;
        footer = Array.from(document.querySelectorAll(FOOTER_SELECTOR)).some(el => {
          if (!isShown(el)) return false;
          const r = el.getBoundingClientRect();
          return r.bottom > h - 160 && r.top < h; // footer occupies the bottom strip where the helpers live
        });
      }
      body.classList.toggle('nf-overlay-open', overlay);
      body.classList.toggle('nf-footer-visible', footer);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(check); };
    const mo = new MutationObserver(schedule);
    mo.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-modal', 'open', 'hidden'] });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    phone.addEventListener('change', schedule);
    schedule();
    return () => {
      mo.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      phone.removeEventListener('change', schedule);
      body.classList.remove('nf-overlay-open', 'nf-footer-visible');
    };
  }, []);
}
