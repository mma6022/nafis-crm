/** ویرایش نام مشتری — Armita v1.0. Renders nothing while flag.customer_name_edit is OFF. */
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, Lock, PenLine } from 'lucide-react';
import {
  CNE_INVALID_FA, CNE_NOCHANGE, CNE_REQUIRED, CNE_SAVED, CNE_SERVER, CNE_VERIFIED_HINT,
  cneNormalizePart, fetchCneView, patchCneName, type CneView,
} from './api';
import './customer-name-edit.css';

const I = { className: 'i', 'aria-hidden': true } as const;

type Props = {
  customerId: number | null | undefined;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  onSaved?: (name: string, firstName: string, lastName: string) => void;
  toast?: (message: string) => void;
  children: React.ReactNode;
  rowClassName?: string;
};

type FieldErr = { first?: string; last?: string };

function useDesktop(): boolean {
  const [desk, setDesk] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesk(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desk;
}

export function CustomerNameEdit({ customerId, name, firstName, lastName, onSaved, toast, children, rowClassName }: Props) {
  const [view, setView] = useState<CneView | null>(null);
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [err, setErr] = useState<FieldErr>({});
  const [note, setNote] = useState('');
  const [serv, setServ] = useState('');
  const [busy, setBusy] = useState(false);
  const desk = useDesktop();
  const firstRef = useRef<HTMLInputElement>(null);
  const firstId = useId();
  const lastId = useId();

  useEffect(() => {
    if (!customerId) { setView(null); return; }
    let live = true;
    void fetchCneView(customerId).then((r) => {
      if (!live) return;
      if (r.ok) setView(r.data);
      else setView(null);
    });
    return () => { live = false; };
  }, [customerId, name, firstName, lastName]);

  useEffect(() => {
    const clsOpen = 'ed-open';
    const clsEdit = 'is-editing';
    if (open) {
      document.body.classList.add(clsEdit);
      if (!desk) document.body.classList.add(clsOpen);
      else document.body.classList.remove(clsOpen);
    } else {
      document.body.classList.remove(clsEdit, clsOpen);
    }
    return () => { document.body.classList.remove(clsEdit, clsOpen); };
  }, [open, desk]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => firstRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [open, desk]);

  if (!customerId || !view) {
    return <div className={rowClassName || 'nmr ed-view'}>{children}</div>;
  }

  const start = () => {
    setFirst(view.firstName || firstName || '');
    setLast(view.lastName || lastName || '');
    setErr({}); setNote(''); setServ('');
    setOpen(true);
  };
  const cancel = () => { setOpen(false); setErr({}); setNote(''); setServ(''); };

  const validate = () => {
    const f = cneNormalizePart(first);
    const l = cneNormalizePart(last);
    const next: FieldErr = {
      first: f.ok ? undefined : (first.trim() ? CNE_INVALID_FA : CNE_REQUIRED),
      last: l.ok ? undefined : (last.trim() ? CNE_INVALID_FA : CNE_REQUIRED),
    };
    if (!f.ok) next.first = f.message;
    if (!l.ok) next.last = l.message;
    setErr(next);
    return f.ok && l.ok ? { first: f.value, last: l.value } : null;
  };

  const save = async () => {
    if (busy) return;
    const v = validate();
    if (!v) return;
    const same = v.first === (view.firstName || '') && v.last === (view.lastName || '')
      && `${v.first} ${v.last}` === (view.name || name);
    if (same || `${v.first} ${v.last}` === (view.name || name)) {
      setNote(CNE_NOCHANGE); setServ(''); return;
    }
    setBusy(true); setNote(''); setServ('');
    const r = await patchCneName(customerId, v.first, v.last);
    setBusy(false);
    if (!r.ok) {
      if (r.field === 'firstName') setErr((e) => ({ ...e, first: r.message || CNE_INVALID_FA }));
      else if (r.field === 'lastName') setErr((e) => ({ ...e, last: r.message || CNE_INVALID_FA }));
      else setServ(r.message || CNE_SERVER);
      return;
    }
    if (r.data.unchanged) { setNote(CNE_NOCHANGE); return; }
    setView({ ...view, name: r.data.name, firstName: r.data.firstName, lastName: r.data.lastName, canEdit: true, identityVerified: false, identity_verified: false, showVerifiedBadge: false });
    setOpen(false);
    toast?.(CNE_SAVED);
    onSaved?.(r.data.name, r.data.firstName, r.data.lastName);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter') { e.preventDefault(); void save(); }
  };

  const fields = (mobile: boolean) => (
    <div className={mobile ? undefined : 'ed-form ed-desk'} onKeyDown={onKey}>
      {serv ? <div className="ed-serv" role="alert"><CircleAlert {...I} /><span>{serv}</span></div> : null}
      <div className="ed-row">
        <div className="ed-f">
          <label htmlFor={`${firstId}${mobile ? '-m' : ''}`}>نام</label>
          <input id={`${firstId}${mobile ? '-m' : ''}`} ref={mobile === !desk ? firstRef : undefined} value={first}
            onChange={(e) => { setFirst(e.target.value); setErr((x) => ({ ...x, first: undefined })); setNote(''); }}
            aria-invalid={err.first ? true : undefined} aria-describedby={err.first ? `${firstId}-err${mobile ? '-m' : ''}` : undefined} autoComplete="given-name" />
          {err.first ? <div className="ed-err" id={`${firstId}-err${mobile ? '-m' : ''}`} role="alert"><CircleAlert {...I} />{err.first}</div> : null}
        </div>
        <div className="ed-f">
          <label htmlFor={`${lastId}${mobile ? '-m' : ''}`}>نام خانوادگی</label>
          <input id={`${lastId}${mobile ? '-m' : ''}`} value={last}
            onChange={(e) => { setLast(e.target.value); setErr((x) => ({ ...x, last: undefined })); setNote(''); }}
            aria-invalid={err.last ? true : undefined} aria-describedby={err.last ? `${lastId}-err${mobile ? '-m' : ''}` : undefined} autoComplete="family-name" />
          {err.last ? <div className="ed-err" id={`${lastId}-err${mobile ? '-m' : ''}`} role="alert"><CircleAlert {...I} />{err.last}</div> : null}
        </div>
      </div>
      <div className="ed-acts">
        <button className="btn pri" type="button" onClick={() => void save()} disabled={busy}>ذخیره</button>
        <button className="btn gh" type="button" onClick={cancel} disabled={busy}>انصراف</button>
        {note ? <span className="ed-note" role="status">{note}</span> : null}
      </div>
    </div>
  );

  const pencil = view.canEdit ? (
    <button className="ed-pen" type="button" aria-label="ویرایش نام" onClick={start} data-testid="cne-pen">
      <PenLine {...I} />
      <span className="ed-tip" aria-hidden="true">ویرایش نام</span>
    </button>
  ) : view.showVerifiedBadge ? (
    <span className="chip s lock" data-testid="cne-verified"><Lock {...I} />احراز شده</span>
  ) : null;

  const hint = view.showVerifiedBadge ? <span className="ed-hint">{CNE_VERIFIED_HINT}</span> : null;

  const sheet = open && typeof document !== 'undefined' ? createPortal(
    <>
      <button type="button" className="ed-scrim" aria-label="بستن" onClick={cancel} />
      <div className="ed-sheet" role="dialog" aria-modal="true" aria-labelledby="cne-sheet-title">
        <div className="grab" aria-hidden="true" />
        <h3 id="cne-sheet-title">ویرایش نام</h3>
        {fields(true)}
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <>
      <div className={rowClassName || 'nmr ed-view'}>
        {children}
        {pencil}
      </div>
      {hint}
      {open ? fields(false) : null}
      {sheet}
    </>
  );
}

export function cneParseHistoryReason(reason: string | null | undefined): { oldName: string; newName: string } | null {
  if (!reason) return null;
  try {
    const j = JSON.parse(reason);
    if (j && typeof j.oldName === 'string' && typeof j.newName === 'string') return j;
  } catch { /* plain text */ }
  return null;
}
