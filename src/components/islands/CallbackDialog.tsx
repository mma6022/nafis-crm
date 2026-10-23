/**
 * Header «مشاوره‌ی رایگان» / mobile-menu «درخواست مشاوره‌ی رایگان» → <dialog> with the sheet CallbackForm
 * (CALLBACK-HANDOFF.md: bottom sheet on mobile, 520px modal on desktop; focus → name field; Esc closes; focus
 * returns to the opener). Links keep href="/contact#callback" so they work without JS. Never a floating button.
 */
import { useEffect, useRef, useState } from 'react';
import { I } from '../ui/I';
import CallbackForm from './CallbackForm';
import { CB_TITLE } from '../../lib/callback';

export default function CallbackDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [src, setSrc] = useState('page-header');
  const [n, setN] = useState(0);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-callback]');
      const d = ref.current;
      if (!a || !d || typeof d.showModal !== 'function' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      opener.current = a;
      const mm = document.getElementById('mmenu');
      if (mm && !mm.hidden) document.getElementById('menu-btn')?.click();
      setSrc(a.dataset.callback || 'page-header');
      setN((x) => x + 1); // fresh form every time it opens
      d.showModal();
    };
    document.addEventListener('click', onClick);
    const d = ref.current;
    const onClose = () => {
      const o = opener.current;
      // opener inside the (now closed) mobile menu → return focus to the menu button
      if (o && o.offsetParent === null) document.getElementById('menu-btn')?.focus();
      else o?.focus();
    };
    d?.addEventListener('close', onClose);
    return () => {
      document.removeEventListener('click', onClick);
      d?.removeEventListener('close', onClose);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      id="cb-dialog"
      className="cb-dialog"
      aria-labelledby="cb-dlg-h"
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="sheet-grab" aria-hidden="true" />
      <div className="dlg-head">
        <h2 id="cb-dlg-h">{CB_TITLE}</h2>
        <button type="button" className="icon-btn" aria-label="بستن" onClick={() => ref.current?.close()}>
          <I name="x" />
        </button>
      </div>
      <p className="dlg-lead">نام و شماره‌تان را بگذارید تا کارشناس نفیس وام با شما تماس بگیرد و رایگان راهنمایی‌تان کند.</p>
      {n > 0 && <CallbackForm key={n} variant="sheet" src={src} autoFocus />}
    </dialog>
  );
}
