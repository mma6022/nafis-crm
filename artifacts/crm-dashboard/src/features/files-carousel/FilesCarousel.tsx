/** FILES-61 «پرونده‌های من» (Armita crm-files-cards v1.0): one file at a time in the assistant's order; the next card stays locked until a result + one-line note is saved.
 * No list, no search, no skip, no reorder. Paging back is read-only. Edit = the existing file page (same powers as today). «ثبت پرونده جدید» = the existing wizard. */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, CalendarClock, Check, ChevronLeft, ChevronRight, FileText, Lock, Pencil, Phone, PhoneMissed, Plus, X } from 'lucide-react';
import { CreateWizard } from '@/components/loan-applications/CreateWizard';
import { faNum } from '@/features/call-queue/api';
import { maskTel, phone11 } from '@/features/expert-lockdown/IncomingWizard';
import '@/features/daily-plan/daily-plan.css';
import './files-carousel.css';
import { fcApi, type FcCard, type FcView } from './api';
import FilesList from './FilesList';
import { CatPill, RNote, fcDay } from './FcLabels';

/** REMINDER-68 (Armita review #1): masked ۰۹۱۲***۰۰۱۲ for the expert; the «تماس» tel: link keeps the full number. */
const telFa = (p: string) => maskTel(phone11(p) ?? p.replace(/^\+98/, '0'));
const JFMT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const jalaliAt = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : JFMT.format(d); };
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;

export default function FilesCarousel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['files-carousel', 'today'], queryFn: fcApi.today, refetchInterval: 60_000, retry: false });
  const [view, setView] = useState<number | null>(null); // index of a card being paged back to (read-only); null = current
  const [wizard, setWizard] = useState(false);
  const [anim, setAnim] = useState<'' | 'out' | 'in'>('');
  const [cxOut, setCxOut] = useState<string | null>(null); // FILES-CANCEL: name on the leaving card («لغو شد» tag)
  const [toast, setToast] = useState<{ name: string } | null>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const prevIds = useRef<number[] | null>(null); const [shift, setShift] = useState<{ left: number; back: number } | null>(null);
  useEffect(() => {
    if (!q.data) return; const ids = q.data.cards.filter((c) => c.state !== 'done').map((c) => c.fileId);
    const prev = prevIds.current; prevIds.current = ids; if (!prev) return;
    const done = new Set(q.data.cards.filter((c) => c.state === 'done').map((c) => c.fileId));
    const left = prev.filter((id) => !ids.includes(id) && !done.has(id)).length; const back = ids.filter((id) => !prev.includes(id)).length;
    if (left || back) setShift({ left, back });
  }, [q.data]);
  if (q.isLoading) return <div className="dp-page"><div className="dp-skel" role="status" data-testid="fc-loading">در حال بارگذاری پرونده‌ها…</div></div>;
  if (q.isError || !q.data) return <div className="dp-page"><h1>پرونده‌های من</h1><div className="dp-box err" role="alert" data-testid="fc-error">پرونده‌ها بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void q.refetch()}>تلاش دوباره</button></div></div>;
  const d = q.data;
  const curIdx = d.cards.findIndex((c) => c.state === 'current');
  const shownIdx = view ?? (curIdx >= 0 ? curIdx : d.cards.length - 1);
  const shown = d.cards[shownIdx] ?? null;
  const next = curIdx >= 0 ? d.cards[curIdx + 1] ?? null : null;
  const onSaved = (v: FcView, cancelledName?: string) => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (cancelledName != null) { setCxOut(cancelledName); setToast({ name: cancelledName }); }
    const apply = () => { qc.setQueryData(['files-carousel', 'today'], v); setView(null); setCxOut(null); setAnim(reduce ? '' : 'in'); setTimeout(() => { setAnim(''); titleRef.current?.focus(); }, reduce ? 0 : 290); };
    if (reduce) apply(); else { setAnim('out'); setTimeout(apply, 280); }
  };
  const listMode = d.mode === 'list';
  return <div className={`dp-page fc-page${listMode ? ' fc-wide' : ''}`} data-testid="fc-page" data-mode={d.mode ?? 'cards'}>
    <header className="dp-head card fc-head" data-testid="fc-head">
      <div className="dp-head-t"><div><h1>پرونده‌های من</h1><p>{d.orderSource === 'assistant' ? 'به ترتیب اولویت دستیار' : 'ترتیب پیش‌فرض (دستیار هنوز ترتیب نداده)'}</p></div>
        <button type="button" className="btn btn-ghost fc-new" onClick={() => setWizard(true)} data-testid="fc-new"><Plus size={16} aria-hidden="true" /> ثبت پرونده جدید</button></div>
      {d.total ? <>
        <div className="dp-pos" data-testid="fc-pos"><b>پرونده {faNum(d.index ?? d.total)} از {faNum(d.total)}</b></div>
        <div className="dp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.done} aria-label="پیگیری پرونده‌ها"><i style={{ width: `${Math.round((d.done / d.total) * 100)}%` }} /></div>
        <p className="dp-sub" data-testid="fc-sub">{faNum(d.done)} پیگیری شد · {faNum(Math.max(0, d.total - d.done - (curIdx >= 0 ? 1 : 0)))} پرونده بعد از این</p>
      </> : null}
    </header>
    {shift ? <div className="dp-box warn banner" role="status" data-testid="fc-shift">{shift.left ? `${faNum(shift.left)} پرونده از نوبت تو بیرون رفت (اقدامش با واحد دیگری است). ` : ''}{shift.back ? `${faNum(shift.back)} پرونده به نوبت تو برگشت و بعد از کارت جاری آمد.` : ''} <button type="button" className="dp-link" onClick={() => setShift(null)}>باشه</button></div> : null}
    <p className="sr-only" aria-live="polite">{d.index ? `پرونده ${faNum(d.index)} از ${faNum(d.total)}` : ''}</p>
    {listMode && view == null ? <FilesList d={d} cardsDone={d.total} />
      : !d.total ? <div className="dp-box" data-testid="fc-empty">پرونده‌ی در جریانی که اقدامش با تو باشد نداری.{d.waiting?.total ? <p className="fc-waiting" data-testid="fc-waiting">{faNum(d.waiting.total)} پرونده‌ی شما منتظر قدم بعدی دیگرانه: {d.waiting.groups.map(w => `${w.label} ${faNum(w.count)}`).join('، ')}</p> : null}</div>
      : curIdx < 0 && view == null ? <div className="dp-box ok" data-testid="fc-done">همه‌ی پرونده‌های امروز پیگیری شد. ترتیب فردا را دستیار می‌نویسد.</div> : null}
    {toast ? <div className="fc-toast cx" role="status" data-testid="fc-cx-toast"><Check size={15} aria-hidden="true" /><span>پرونده لغو شد · کارت بعدی</span><span className="cxs">{toast.name} · برگرداندن فقط با ادمین</span></div> : null}
    {shown && (view != null || curIdx >= 0) ? <div className={`fc-deck ${anim}`}>
      {cxOut != null && anim === 'out' ? <span className="fc-cxtag" data-testid="fc-cx-tag">لغو شد</span> : null}
      <FileCard key={`${shown.fileId}-${shown.state}`} c={shown} d={d} readOnly={shown.state !== 'current'} titleRef={titleRef} onSaved={onSaved} />
    </div> : null}
    {d.total ? <nav className="fc-nav" aria-label="پرونده‌های قبلی">
      <button type="button" className="btn btn-ghost" disabled={shownIdx <= 0} onClick={() => setView(Math.max(0, shownIdx - 1))} data-testid="fc-prev"><ChevronRight size={16} aria-hidden="true" /> قبلی (فقط دیدن)</button>
      {view != null && view !== curIdx ? <button type="button" className="btn btn-ghost" onClick={() => setView(null)} data-testid="fc-back-current">برگشت به پرونده‌ی جاری <ChevronLeft size={16} aria-hidden="true" /></button> : null}
    </nav> : null}
    {next && view == null ? <p className="fc-next" data-testid="fc-next"><Lock size={13} aria-hidden="true" /> بعدی: پرونده‌ی #{faNum(next.fileId)} {next.fc ? <CatPill c={next.fc} small /> : <span className={`dp-chip fc-g-${next.group}`} data-testid="fc-next-group">{next.groupLabel}</span>}{next.returnedToday ? <span className="dp-chip extra">برگشت به نوبت تو</span> : null} · تا ثبت نتیجه قفل است</p> : null}
    {wizard ? <CreateWizard onClose={() => { setWizard(false); void qc.invalidateQueries({ queryKey: ['files-carousel', 'today'] }); }} /> : null}
  </div>;
}

function FileCard({ c, d, readOnly, titleRef, onSaved }: { c: FcCard; d: FcView; readOnly: boolean; titleRef: React.RefObject<HTMLHeadingElement | null>; onSaved: (v: FcView, cancelledName?: string) => void }) {
  const [outcome, setOutcome] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [reason, setReason] = useState(''); const [rErr, setRErr] = useState(''); const [confirm, setConfirm] = useState(false);
  const cx = outcome === 'cancelled'; const rMax = d.cancelReasonMax ?? 120;
  useEffect(() => { setOutcome(''); setNote(''); setErr(''); setReason(''); setRErr(''); setConfirm(false); }, [c.fileId]);
  const askCancel = () => { if (!reason.trim()) { setRErr('دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود.'); document.getElementById('fc-cx-reason')?.focus(); return; } setRErr(''); setConfirm(true); };
  const doCancel = async () => {
    setBusy(true); setErr('');
    try { const r = await fcApi.followup({ fileId: c.fileId, outcome: 'cancelled', cancelReason: reason.trim() }); setConfirm(false); onSaved(r.view, c.customerName); }
    catch (e) { setConfirm(false); if (e instanceof Error && (e as any).code === 'reason_required') setRErr(e.message); else setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  const OIcon = ({ code }: { code: string }) => code === 'answered' ? <Check size={16} aria-hidden="true" /> : code === 'no_answer' ? <PhoneMissed size={16} aria-hidden="true" /> : code === 'follow_up' ? <CalendarClock size={16} aria-hidden="true" /> : code === 'cancelled' ? <X size={16} aria-hidden="true" /> : null;
  const save = async () => {
    if (!outcome) { setErr('نتیجه را انتخاب کن.'); return; }
    if (!note.trim()) { setErr('یادداشت یک‌خطی لازم است.'); return; }
    setBusy(true); setErr('');
    try { const r = await fcApi.followup({ fileId: c.fileId, outcome, note: note.trim() }); onSaved(r.view); }
    catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <section className={`dp-cur card fc-card${readOnly ? ' ro' : ''}`} aria-labelledby="fc-title" data-testid={readOnly ? 'fc-card-ro' : 'fc-card'} data-file={c.fileId}>
    <div className="dp-cur-top"><span className="dp-count">پرونده {faNum(c.position)} از {faNum(d.total)}</span>
      <span className="dp-chips">{c.fc ? <CatPill c={c.fc} /> : <span className={`dp-chip fc-g-${c.group}`} data-testid="fc-group">{c.groupLabel}</span>}{c.returnedToday ? <span className="dp-chip extra" data-testid="fc-returned">برگشت به نوبت تو</span> : null}</span></div>
    {c.fc ? <RNote c={c.fc} /> : null}
    <h2 id="fc-title" tabIndex={-1} ref={readOnly ? undefined : titleRef}>{c.customerName} <span className="dp-id">#{faNum(c.customerId)}</span></h2>
    <p className="fno" data-testid="fc-fileno">{c.typeLabel} #{faNum(c.fileId)}</p>
    {!c.reason && !c.ask ? <p className="dfb" data-testid="fc-default">ترتیب پیش‌فرض</p> : null}
    {c.reason ? <p className="dp-reason" data-testid="fc-reason">{c.reason}</p> : null}
    {c.ask ? <div className="dp-keynote"><small>چی بپرسم</small><q data-testid="fc-ask">{c.ask}</q></div> : null}
    {c.fc ? <p className="lfu" data-testid="fc-lastact">آخرین فعالیت پرونده: {fcDay(c.fc.last_activity_at)}</p> : null}
    <p className="lfu" data-testid="fc-last">آخرین پیگیری: {c.lastFollowUp ? <>{jalaliAt(c.lastFollowUp.at)}{c.lastFollowUp.outcomeLabel ? ` · ${c.lastFollowUp.outcomeLabel}` : ''}</> : 'ندارد'}</p>
    {readOnly ? <div className="dp-box sm" data-testid="fc-ro-note">{c.todayFollowUp?.outcome === 'cancelled' ? <><span className="fc-cxtag in" data-testid="fc-ro-cx">لغو شد</span> دلیل لغو: {c.todayFollowUp.note}</> : c.todayFollowUp ? <>امروز ثبت شد: {c.todayFollowUp.outcomeLabel} · {c.todayFollowUp.note}</> : 'فقط دیدن؛ نوبت این پرونده نشده.'}</div> : <>
      {c.phone ? <p className="dp-phone" dir="ltr" data-testid="fc-phone"><Phone size={14} aria-hidden="true" /> {telFa(c.phone)}</p> : null}
      <div className="dp-actions">
        {c.phone ? <a className="btn btn-primary dp-call" href={telHref(c.phone)} data-testid="fc-call"><Phone size={16} aria-hidden="true" /> تماس با {c.customerName}</a> : null}
        <Link href={`/loan-applications/${c.fileId}`} className="btn btn-ghost" data-testid="fc-edit"><Pencil size={16} aria-hidden="true" /> ویرایش پرونده</Link>
        <Link href={`/customers/${c.customerId}`} className="btn btn-ghost" data-testid="fc-customer"><FileText size={16} aria-hidden="true" /> مشتری</Link>
        <a href={`/customers/${c.customerId}#sec-calls`} target="_blank" rel="noopener" className="btn btn-ghost" data-testid="fc-history">تاریخچه</a>
      </div>
      <fieldset className="fc-result" data-testid="fc-result"><legend>نتیجه‌ی پیگیری</legend>
        <div className={`rlist${d.outcomes.length === 4 ? ' s4' : ''}`} role="radiogroup">{d.outcomes.map((o) => <label key={o.code} className={`rr${outcome === o.code ? ' on' : ''}${o.code === 'cancelled' ? ' cx' : ''}`}>
          <input type="radio" name="fc-outcome" value={o.code} checked={outcome === o.code} onChange={() => { setOutcome(o.code); setErr(''); }} data-testid={`fc-o-${o.code}`} /> <OIcon code={o.code} /> {o.label}</label>)}</div>
        {cx ? <div className="fc-cxf" data-testid="fc-cxf">
          <div className="fc-cxl"><label htmlFor="fc-cx-reason"><b>دلیل لغو<span className="req" aria-hidden="true">*</span></b> <small>کوتاه، حداکثر ۱۲۰ نویسه</small></label><span className="cnt" aria-live="polite" data-testid="fc-cx-count">{faNum([...reason].length)} / {faNum(rMax)}</span></div>
          <textarea id="fc-cx-reason" className={`inp tx${rErr ? ' bad' : ''}`} rows={2} maxLength={rMax} value={reason} aria-required="true" aria-invalid={rErr ? true : undefined} aria-describedby={rErr ? 'fc-cx-err' : undefined}
            onChange={(e) => { setReason(e.target.value.replace(/[\r\n]/g, ' ')); if (rErr && e.target.value.trim()) setRErr(''); }} placeholder="مثلاً «از بانک دیگری وام گرفت و دیگر نیاز ندارد»" data-testid="fc-cx-reason" />
          {rErr ? <p className="dp-err" id="fc-cx-err" role="alert" data-testid="fc-cx-err">{rErr}</p> : null}
          <p className="fc-cxn" data-testid="fc-cx-info"><AlertCircle size={15} aria-hidden="true" /> پرونده‌ی لغوشده از «پرونده‌های من» و کارهای امروز بیرون می‌رود. برگرداندن لغو فقط با ادمین است.</p>
          {err ? <p className="dp-err" role="alert" data-testid="fc-err">{err}</p> : null}
          <button type="button" className={`btn fc-dz fc-save${reason.trim() ? '' : ' off'}`} aria-disabled={!reason.trim() || busy} onClick={askCancel} data-testid="fc-cx-btn"><X size={16} aria-hidden="true" /> لغو پرونده و پرونده‌ی بعدی</button>
          <p className="fc-cxh" data-testid="fc-cx-hint"><Lock size={13} aria-hidden="true" /> {reason.trim() ? 'بعد از زدن، یک تأیید دیگر می‌آید.' : 'تا دلیل لغو نوشته نشود، این دکمه غیرفعال است.'}</p>
        </div> : <>
        <input className="inp" maxLength={d.noteMax} value={note} onChange={(e) => setNote(e.target.value.replace(/[\r\n]/g, ' '))} placeholder="یادداشت یک‌خطی (حداکثر ۸۰ نویسه)" aria-label="یادداشت یک‌خطی" data-testid="fc-note" />
        {err ? <p className="dp-err" role="alert" data-testid="fc-err">{err}</p> : null}
        <button type="button" className="btn btn-primary fc-save" disabled={busy} onClick={() => void save()} data-testid="fc-save">{busy ? 'در حال ثبت…' : 'ثبت نتیجه و پرونده‌ی بعدی'}</button>
        </>}
      </fieldset>
      {confirm ? <CancelConfirm c={c} reason={reason.trim()} busy={busy} onBack={() => setConfirm(false)} onYes={() => void doCancel()} /> : null}
    </>}
  </section>;
}

/** FILES-CANCEL f_cxok: alertdialog (bottom sheet on mobile); initial focus on «برگشت»; Esc = برگشت. */
function CancelConfirm({ c, reason, busy, onBack, onYes }: { c: FcCard; reason: string; busy: boolean; onBack: () => void; onYes: () => void }) {
  const back = useRef<HTMLButtonElement>(null); const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; back.current?.focus(); return () => { prev?.focus?.(); }; }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) onBack(); return; }
    if (e.key === 'Tab' && box.current) { const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled])')]; if (!f.length) return;
      const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  };
  return <div className="fc-dlgw" onKeyDown={onKey} data-testid="fc-cx-dialog-wrap">
    <div className="fc-dlg" ref={box} role="alertdialog" aria-modal="true" aria-labelledby="fc-cx-t" aria-describedby="fc-cx-w" data-testid="fc-cx-dialog">
      <div className="fc-cxhd"><AlertCircle size={24} aria-hidden="true" /><h2 id="fc-cx-t">پرونده لغو شود؟</h2></div>
      <p className="fc-cxwho"><b>{c.customerName}</b> <span className="dp-id">#{faNum(c.customerId)}</span> · پرونده‌ی {faNum(c.fileId)}</p>
      <div className="fc-cxq"><small>دلیل لغو</small><q data-testid="fc-cx-q">{reason}</q></div>
      <p className="fc-cxa" id="fc-cx-w"><Lock size={14} aria-hidden="true" /><span><b>برگرداندن لغو فقط با ادمین است.</b> پرونده از «پرونده‌های من» و کارهای امروز بیرون می‌رود و کارت بعدی باز می‌شود.</span></p>
      <div className="fc-acts">
        <button type="button" ref={back} className="btn btn-ghost" onClick={onBack} disabled={busy} data-testid="fc-cx-back">برگشت</button>
        <button type="button" className="btn fc-dzf" onClick={onYes} disabled={busy} data-testid="fc-cx-yes"><X size={16} aria-hidden="true" /> {busy ? 'در حال لغو…' : 'بله، لغو شود'}</button>
      </div>
    </div>
  </div>;
}
