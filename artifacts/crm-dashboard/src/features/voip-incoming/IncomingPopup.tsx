/** Part 4 (design simotel v1.2 scenes 27–33): the incoming-call card. Answer / hang up stay on the VoIP phone; this card only shows who is calling.
 *  The current task and turn never change (no lock is bypassed). Not fetched for a plain admin («مدیر فروش» and experts get it), and renders nothing while flag.voip_incoming is off. */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Check, Clock, EyeOff, FileText, Headset, History, Info, Lock, PenLine, Search, X } from 'lucide-react';
import { CallNumber } from '@/features/call-number/CallNumber';
import { dayAt, dur, fa, useViMe, viApi, viRefresh, ViError, type ViCall } from './api';
import { NewCustomerInline } from './NewCustomerInline';
import './vi.css';

export function IncomingPopup() {
  const q = useViMe(); const d = q.data;
  if (!d?.on || !d.calls?.length) return null;
  return <div className="vi vi-pop-wrap" data-testid="vi-pop-wrap">{d.calls.map((c) => <IncomingCard key={c.eventId} c={c} ext={d.extension ?? ''} />)}</div>;
}

function Tick({ since }: { since: string }) {
  const [, set] = useState(0); useEffect(() => { const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <span dir="ltr" className="vi-tm">{`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`}</span>;
}

const KIND_CHIP: Record<ViCall['kind'], [string, string]> = { own: ['مشتری خودت', 's'], unknown: ['شماره ناشناس', 'g'], hidden: ['شماره نامشخص', 'q'], other: ['مشتری کارشناس دیگر', 'b'], support: ['پشتیبانی', 'b'] };

export function IncomingCard({ c, ext }: { c: ViCall; ext: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(''); const [err, setErr] = useState(''); const [how, setHow] = useState<string | null>(null);
  const act = async (a: 'close' | 'later' | 'log') => { setBusy(a); setErr('');
    try { await viApi.act(c.eventId, a); viRefresh(qc); void qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('/api/voip/after-call') }); }
    catch (e) { setErr(e instanceof ViError ? e.message : 'انجام نشد.'); } finally { setBusy(''); } };
  const transfer = async () => { setBusy('transfer'); setErr('');
    try { const r = await viApi.transfer(c.eventId); setHow(r.howTo); } catch (e) { setErr(e instanceof ViError ? e.message : 'انجام نشد.'); viRefresh(qc); } finally { setBusy(''); } };
  const ended = c.state === 'ended';
  const title = ended ? (c.outcome === 'answered' ? 'تماس ورودی تمام شد: پاسخ دادی' : 'تماس ورودی بی‌پاسخ ماند')
    : c.state === 'talking' ? 'تماس ورودی؛ در مکالمه' : 'تماس ورودی؛ تلفن ویپ شما زنگ می‌خورد';
  const [chip, chipK] = KIND_CHIP[c.kind];
  const caseHref = c.customer ? (c.file && (c.kind === 'own' || (c.kind === 'other' && c.phone)) ? `/loan-applications/${c.file.id}` : `/customers/${c.customer.id}`) : null;
  return <section className={`vi-pop card ${c.state}`} role="dialog" aria-modal="false" aria-labelledby={`vi-h-${c.eventId}`} data-testid="vi-pop" data-kind={c.kind} data-state={c.state}>
    <header className="vi-ph">
      <span className="vi-pi" aria-hidden="true">{ended ? <Check className="i" /> : <Headset className="i" />}</span>
      <div className="vi-pt"><h3 id={`vi-h-${c.eventId}`} data-testid="vi-title">{title}</h3>
        <p>داخلی <bdi>{fa(c.extension ?? ext)}</bdi>؛ جواب دادن و قطع تماس از خود تلفن ویپ است.</p></div>
      <button type="button" className="vi-x" aria-label="بستن این پنجره (تماس قطع نمی‌شود)" title="بستن پنجره؛ تماس قطع نمی‌شود" onClick={() => void act('close')} disabled={!!busy} data-testid="vi-close"><X className="i" /></button>
    </header>
    <div className="vi-pb">
      <div className="vi-who">
        <span className={`chip ${chipK}`} data-testid="vi-chip">{chip}</span>
        {c.state === 'talking' ? <span className="chip s"><Headset className="i" aria-hidden="true" />در مکالمه <Tick since={c.startedAt} /></span> : null}
        {ended && c.durationSeconds != null ? <span className="chip q"><Clock className="i" aria-hidden="true" />{dur(c.durationSeconds)}</span> : null}
      </div>
      {c.customer ? <p className="vi-nm"><b data-testid="vi-name">{c.customer.name}</b> <span className="muted">#{fa(c.customer.id)}</span></p>
        : c.kind === 'hidden' ? <p className="vi-nm"><b>شماره‌ی تماس‌گیرنده نمایش داده نشد</b></p>
        : <p className="vi-nm"><b>شماره در CRM پیدا نشد</b></p>}
      {c.file ? <p className="vi-ln"><FileText className="i" aria-hidden="true" /><span>پرونده {fa(c.file.id)}، {c.file.label}</span></p> : null}
      {c.ownerName ? <p className="vi-ln"><Info className="i" aria-hidden="true" /><span>کارشناس: <b>{c.ownerName}</b>{c.kind === 'support' ? ' (فقط برای اطلاع)' : ''}</span></p> : null}
      {c.phone ? <div className="vi-phone"><CallNumber phone={c.phone} size="md" testId="vi-cn" /></div>
        : c.kind === 'other' || c.kind === 'support' ? <p className="vi-ln muted"><EyeOff className="i" aria-hidden="true" /><span>شماره‌ی مشتری کارشناس دیگر این‌جا نشان داده نمی‌شود.</span></p> : null}
      {c.lastCall ? <div className="vi-last" data-testid="vi-last"><History className="i" aria-hidden="true" /><span><small>آخرین تماس</small>{dayAt(c.lastCall.at)}؛ {c.lastCall.text}</span></div> : null}

      {how ? <p className="vi-how" role="status" data-testid="vi-how"><ArrowLeftRight className="i" aria-hidden="true" /><span>{how}</span></p> : null}
      <div className="vi-acts">
        {caseHref && (c.kind === 'own' || c.kind === 'support' || (c.kind === 'other' && !!c.phone)) ? /* other + number = sales_manager (server sends the number only to them) */ <Link className="btn btn-primary vi-b" href={caseHref} data-testid="vi-open"><FileText size={16} aria-hidden="true" />باز کردن پرونده</Link> : null}
        {c.kind === 'other' && c.transfer ? <button type="button" className="btn btn-primary vi-b" disabled={!c.transfer.available || !!busy} aria-describedby={`vi-tr-${c.eventId}`} onClick={() => void transfer()} data-testid="vi-transfer">
          <ArrowLeftRight size={16} aria-hidden="true" />انتقال به {c.transfer.ownerName}{c.transfer.extension ? <> (داخلی <bdi>{fa(c.transfer.extension)}</bdi>)</> : null}</button> : null}
        {c.kind === 'unknown' && c.phone && !c.support ? <NewCustomerInline source="incoming" eventId={c.eventId} /> : null}
        {c.kind === 'unknown' || c.kind === 'hidden' ? <Link className="btn btn-ghost vi-b" href="/customers" data-testid="vi-search"><Search size={16} aria-hidden="true" />جست‌وجو</Link> : null}
        {ended && c.canLog ? <>
          <button type="button" className="btn btn-primary vi-b" onClick={() => void act('log')} disabled={!!busy} data-testid="vi-log"><PenLine size={16} aria-hidden="true" />ثبت تماس ورودی</button>
          <button type="button" className="btn btn-ghost vi-b" onClick={() => void act('later')} disabled={!!busy} data-testid="vi-later">بعداً</button></> : null}
      </div>
      {c.kind === 'other' && c.transfer && !c.transfer.available ? <p className="vi-ln muted" id={`vi-tr-${c.eventId}`} data-testid="vi-tr-reason"><Lock className="i" aria-hidden="true" /><span>{c.transfer.reason}</span></p> : null}
      {c.kind === 'other' && c.transfer?.available ? <p className="vi-ln muted" id={`vi-tr-${c.eventId}`}><Info className="i" aria-hidden="true" /><span>انتقال روی خود تلفن ویپ انجام می‌شود؛ این دکمه راهنمایش را نشان می‌دهد.</span></p> : null}
      {c.kind === 'support' ? <p className="vi-ln muted"><Info className="i" aria-hidden="true" /><span>تماس پشتیبانی است؛ انتقال لازم نیست.</span></p> : null}
      {err ? <p className="dp-err" role="alert" data-testid="vi-err">{err}</p> : null}
      <p className="vi-lock"><Lock className="i" aria-hidden="true" /><span>{ended && c.canLog ? 'ثبت این تماس اختیاری است و چیزی را قفل نمی‌کند.' : 'کار جاری و نوبت عوض نمی‌شود. تا پایان این تماس، دکمه‌ی تماس از تلفن ویپ بسته است.'}</span></p>
    </div>
  </section>;
}
