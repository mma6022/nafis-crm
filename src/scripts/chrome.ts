/** Header / menu / footer / sticky-bar behaviour (designer site.js `initChrome`). Loaded once by BaseLayout. */
const desk = matchMedia('(min-width:1024px)');

/** Expert picker (data/experts.ts): the module is fetched on the first pointer/focus on a trigger, opened on click. */
type PickerMod = typeof import('./expert-picker');
let picker: Promise<PickerMod> | null = null;
const loadPicker = () => (picker ??= import('./expert-picker'));
const trigger = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-experts]') : null);

function initExpertTriggers() {
  for (const ev of ['pointerover', 'touchstart', 'focusin'] as const)
    document.addEventListener(ev, (e) => void (trigger(e.target) && loadPicker()), { passive: true });
  // role=button: Space opens it too (Enter already fires click on a link)
  document.addEventListener('keydown', (e) => {
    const el = trigger(e.target);
    if (el && e.key === ' ' && el === e.target) {
      e.preventDefault();
      el.click();
    }
  });
  document.addEventListener('click', (e) => {
    const el = trigger(e.target);
    if (!el || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!document.getElementById('xp')) return; // no picker on this page: plain link to /contact#experts
    e.preventDefault();
    // close the mobile menu first so the picker is not under it
    const mm = document.getElementById('mmenu');
    if (mm && !mm.hidden && mm.contains(el)) document.getElementById('menu-btn')?.click();
    loadPicker()
      .then((m) => m.openPicker((el.dataset.experts || 'call') as Parameters<PickerMod['openPicker']>[0], el))
      .catch(() => (location.href = el.getAttribute('href') || '/contact/#experts'));
  });
}

export function initChrome() {
  initExpertTriggers();
  const mb = document.getElementById('menu-btn');
  const mm = document.getElementById('mmenu');
  if (mb && mm)
    mb.addEventListener('click', () => {
      const open = mm.hidden;
      mm.hidden = !open;
      mb.setAttribute('aria-expanded', String(open));
      mb.setAttribute('aria-label', open ? 'بستن منو' : 'منو');
      mb.querySelector('use')?.setAttribute('href', open ? '#i-x' : '#i-menu');
      document.body.style.overflow = open ? 'hidden' : '';
    });

  const db = document.getElementById('dd-btn');
  const dm = document.getElementById('dd-svc');
  if (db && dm) {
    const close = () => {
      dm.hidden = true;
      db.setAttribute('aria-expanded', 'false');
    };
    db.addEventListener('click', (e) => {
      e.stopPropagation();
      const o = dm.hidden;
      dm.hidden = !o;
      db.setAttribute('aria-expanded', String(o));
    });
    document.addEventListener('click', (e) => {
      if (!dm.contains(e.target as Node)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dm.hidden) {
        close();
        db.focus();
      }
    });
  }

  const syncFoot = () => document.querySelectorAll<HTMLDetailsElement>('[data-foot]').forEach((d) => (d.open = desk.matches));
  syncFoot();
  desk.addEventListener('change', syncFoot);

  // Sticky bar hides while a text field is focused (virtual keyboard open).
  const isText = (t: EventTarget | null) =>
    t instanceof HTMLElement && t.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select');
  document.addEventListener('focusin', (e) => {
    if (isText(e.target)) document.body.classList.add('kbd');
  });
  document.addEventListener('focusout', (e) => {
    if (isText(e.target)) document.body.classList.remove('kbd');
  });

  // Header CTA: soft by default; primary (desktop, CSS-gated) once the page hero has left the viewport under the header.
  const hdr = document.querySelector<HTMLElement>('.hdr');
  const hero = document.querySelector('.hero, .lp-hero, .post-head');
  if (hdr && hero && 'IntersectionObserver' in window)
    new IntersectionObserver(([e]) => hdr.classList.toggle('is-stuck', !!e && !e.isIntersecting && e.boundingClientRect.top < 0), {
      rootMargin: '-72px 0px 0px 0px', // desktop header height (ANSWERS-1 §8); the CTA swap is CSS-gated to ≥1024px
    }).observe(hero);
}
