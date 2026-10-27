/* «یادداشت سرنخ (اینستاگرام)» — lead_annotator only (PM 2026-10-27 22:37). Exactly two actions on ANY customer: add a note («اینستاگرام»)
   and set / clear «مشتری فوری» with a REQUIRED reason. No edit, no call / tel link, no transfer, no financial data; phones arrive masked. */
import { useState, type FormEvent } from 'react';
import { faDate, laDetail, laNote, laSearch, laUrgent, useLeadAnnotatorMe, type LaCard, type LaDetail, type UrgentReasonValue } from '@/features/lead-annotator/api';
import { UrgentReasonPicker, urgentReasonReady } from '@/features/lead-annotator/UrgentReasonPicker';
import '@/features/lead-annotator/lead-annotator.css';
import './customers.css';

export default function LeadAnnotator() {
  const me = useLeadAnnotatorMe();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LaCard[] | null>(null);
  const [cur, setCur] = useState<LaDetail | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [pick, setPick] = useState<UrgentReasonValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (me.isLoading) return <section className="la" dir="rtl"><p>در حال بارگذاری…</p></section>;
  if (!me.data?.enabled) return <section className="la" dir="rtl"><div className="csx-note warn" role="alert"><p>این بخش برای شما فعال نیست.</p></div></section>;
  const run = async <T,>(f: () => Promise<T>) => { setBusy(true); setErr(null); setMsg(null); try { return await f(); } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(false); } };
  const search = async (e: FormEvent) => { e.preventDefault(); const r = await run(() => laSearch(q.trim())); if (r) { setItems(r.items); setCur(null); } };
  const open = async (id: number) => { const r = await run(() => laDetail(id)); if (r) { setCur(r); setNote(''); setReason(''); setPick(null); } };
  const addNote = async (e: FormEvent) => { e.preventDefault(); if (!cur) return; if (await run(() => laNote(cur.id, note.trim()))) { setMsg('یادداشت ثبت شد.'); await open(cur.id); setMsg('یادداشت ثبت شد.'); } };
  const toggle = async () => { if (!cur) return; const next = !cur.isUrgent;
    if (next && !pick) return;
    const r = await run(() => laUrgent(cur.id, next, next ? pick! : { reason: reason.trim() }));
    if (r) { await open(cur.id); setMsg(next ? '«مشتری فوری» زده شد و به کارشناس پرونده خبر داده شد.' : '«مشتری فوری» برداشته شد.'); } };
  return (
    <section className="la" dir="rtl" data-testid="page-lead-annotator">
      <h1>یادداشت سرنخ ({me.data.noteLabel})</h1>
      <p className="muted">فقط می‌توانید یادداشت بگذارید و «مشتری فوری» را با دلیل بزنید یا بردارید. شماره‌ها پوشیده نمایش داده می‌شوند.</p>
      <form className="la-search" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="نام، شماره‌ی کامل موبایل یا شماره‌ی پرونده" aria-label="جست‌وجوی مشتری" data-testid="la-q" />
        <button type="submit" disabled={busy || !q.trim()}>جست‌وجو</button>
      </form>
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
      {msg ? <div className="csx-note ok" role="status"><p>{msg}</p></div> : null}
      {items && !cur ? (items.length ? <ul className="la-list">{items.map((c) => <li key={c.id}><button type="button" onClick={() => void open(c.id)} data-testid={`la-item-${c.id}`}>
        <span>{c.name} <small className="muted">#{c.id.toLocaleString('fa-IR')}</small></span>
        <span className="la-row">{c.isUrgent ? <span className="la-urgent">مشتری فوری</span> : null}<span className="la-phone">{c.phoneMasked}</span></span></button></li>)}</ul>
        : <p className="muted">مشتری‌ای پیدا نشد.</p>) : null}
      {cur ? <article className="la-card" data-testid="la-card">
        <header><strong>{cur.name} <small className="muted">#{cur.id.toLocaleString('fa-IR')}</small></strong>
          <span className="la-row">{cur.isUrgent ? <span className="la-urgent">مشتری فوری</span> : null}<span className="la-phone">{cur.phoneMasked}</span></span></header>
        <form onSubmit={addNote} className="la-row" style={{ alignItems: 'stretch', flexDirection: 'column' }}>
          <label htmlFor="la-note">یادداشت ({me.data.noteLabel})</label>
          <textarea id="la-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="la-row"><button type="submit" disabled={busy || !note.trim()}>ثبت یادداشت</button></div>
        </form>
        <div className="la-row" style={{ alignItems: 'stretch', flexDirection: 'column' }}>
          {cur.isUrgent ? <><label htmlFor="la-reason">دلیل برداشتن «مشتری فوری» (الزامی)</label>
          <input id="la-reason" type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></>
            : <UrgentReasonPicker value={pick} onChange={setPick} options={me.data.urgentReasons} idPrefix="la" disabled={busy} />}
          <div className="la-row"><button type="button" className={cur.isUrgent ? 'ghost' : ''} disabled={busy || (cur.isUrgent ? reason.trim().length < 3 : !urgentReasonReady(pick))} onClick={() => void toggle()} data-testid="la-urgent">
            {cur.isUrgent ? 'برداشتن «مشتری فوری»' : 'زدن «مشتری فوری»'}</button></div>
        </div>
        {cur.annotations.length ? <><h2 style={{ fontSize: 16, margin: 0 }}>یادداشت‌ها</h2><ul className="la-notes">{cur.annotations.map((a) => <li key={a.id}>
          <span className="la-chip">{a.label}</span><p>{a.body}</p><small className="muted">{a.actorLabel} · {faDate(a.createdAt)}</small></li>)}</ul></> : null}
        {cur.urgentHistory.length ? <><h2 style={{ fontSize: 16, margin: 0 }}>تاریخچه‌ی «مشتری فوری»</h2><ul className="la-notes">{cur.urgentHistory.map((h, i) => <li key={i}>
          <strong>{h.isUrgent ? 'زده شد' : 'برداشته شد'}</strong>{h.reason ? <p>{h.reason}</p> : null}<small className="muted">{h.actorLabel ?? '—'} · {faDate(h.createdAt)}</small></li>)}</ul></> : null}
        <div className="la-row"><button type="button" className="ghost" onClick={() => setCur(null)}>بازگشت به نتیجه‌ها</button></div>
      </article> : null}
    </section>
  );
}
