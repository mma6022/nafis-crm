/* Restricted customer page for a lead_annotator (bug 2026-10-27 23:44): /customers/:id for a customer the user cannot open in full.
   Server: GET /api/lead-annotator/customers/:id/case (no phone, no owner, stage, amounts, documents, calls or finance).
   Exactly two actions: a note («اینستاگرام») and «مشتری فوری» with a required reason. No edit / call / transfer / finance UI. */
import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { faDate, laCase, laNote, laUrgent, type UrgentReasonValue } from './api';
import { UrgentReasonPicker, urgentReasonReady } from './UrgentReasonPicker';
import './lead-annotator.css';
import { RegistrarCard } from '@/features/registrar-view/RegistrarCard';

export function RestrictedCase({ id, registrar = false }: { id: number; registrar?: boolean }) {
  const qc = useQueryClient();
  const key = ['lead-annotator', 'case', id];
  const q = useQuery({ queryKey: key, queryFn: () => laCase(id), retry: false });
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<UrgentReasonValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await f(); await qc.invalidateQueries({ queryKey: key }); setMsg(ok); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); }
  };
  const back = <div className="csx-crumb"><Link href="/customers" data-testid="link-back-customers">→ مشتریان</Link></div>;
  if (q.isLoading) return <section className="la" dir="rtl" aria-busy="true" data-testid="la-case-loading">{back}<p role="status">در حال بارگذاری…</p></section>;
  if (q.isError || !q.data) return <section className="la" dir="rtl" data-testid="la-case-error">{back}
    <div className="csx-note bad" role="alert"><p>{(q.error as Error | null)?.message || 'پرونده باز نشد.'}</p></div></section>;
  const c = q.data;
  const addNote = async (e: FormEvent) => { e.preventDefault(); if (await run(() => laNote(id, note.trim()), 'یادداشت ثبت شد.')) setNote(''); };
  const setUrgent = async () => { if (!reason) return;
    if (await run(() => laUrgent(id, true, reason), '«مشتری فوری» زده شد و به کارشناس پرونده خبر داده شد.')) setReason(null); };
  return (
    <section className="la" dir="rtl" data-testid="la-case">
      {back}
      <header className="la-case-head">
        <h1>{c.name} <small className="muted" dir="ltr">#{c.id.toLocaleString('fa-IR')}</small></h1>
        {c.isUrgent ? <span className="la-urgent" data-testid="la-case-urgent">مشتری فوری</span> : null}
      </header>
      <p className="muted">این پرونده متعلق به کارشناس دیگری است. فقط می‌توانید یادداشت ({c.noteLabel}) بگذارید و «مشتری فوری» را با دلیل بزنید.</p>
      <RegistrarCard id={id} enabled={registrar} />
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
      {msg ? <div className="csx-note ok" role="status"><p>{msg}</p></div> : null}
      <article className="la-card">
        <form onSubmit={addNote} className="la-col">
          <label htmlFor="la-case-note">یادداشت ({c.noteLabel})</label>
          <textarea id="la-case-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="la-case-note" />
          <div className="la-row"><button type="submit" disabled={busy || !note.trim()} data-testid="la-case-note-save">ثبت یادداشت</button></div>
        </form>
      </article>
      <article className="la-card">
        {c.isUrgent ? <p className="muted" data-testid="la-case-urgent-on">این مشتری «فوری» است. برداشتن آن با ثبت تماس کارشناس یا با مدیر انجام می‌شود.</p> : <>
          <UrgentReasonPicker value={reason} onChange={setReason} options={c.urgentReasons} idPrefix="la-case" disabled={busy} />
          <div className="la-row"><button type="button" disabled={busy || !urgentReasonReady(reason)} onClick={() => void setUrgent()} data-testid="la-case-urgent-set">زدن «مشتری فوری»</button></div>
        </>}
      </article>
      {c.annotations.length ? <article className="la-card"><h2 className="la-h2">یادداشت‌ها</h2><ul className="la-notes">{c.annotations.map((a) => <li key={a.id}>
        <span className="la-chip">{a.label}</span><p>{a.body}</p><small className="muted">{a.actorLabel} · {faDate(a.createdAt)}</small></li>)}</ul></article> : null}
      {c.urgentHistory.length ? <article className="la-card"><h2 className="la-h2">تاریخچه‌ی «مشتری فوری»</h2><ul className="la-notes">{c.urgentHistory.map((h, i) => <li key={i}>
        <strong>{h.isUrgent ? 'زده شد' : 'برداشته شد'}</strong>{h.reason ? <p>{h.reason}</p> : null}<small className="muted">{h.actorLabel ?? '—'} · {faDate(h.createdAt)}</small></li>)}</ul></article> : null}
    </section>
  );
}
