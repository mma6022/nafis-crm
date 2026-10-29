import { AutoGrowTextarea } from '../../components/AutoGrowTextarea';
/** REL-83 (Armita crm-files-priority v1.0.1, scenes l_*): the full list of the expert's own files once today's cards are done (or there are none).
 * Same priority order as the cards; search runs on the server (name, customer id, file id, last ≥4 mobile digits); 10/20/50 per page.
 * The list never locks. A file returned (by the registrar or the funder) after the cards ran out shows the bar (role=status) and «پرونده برگشت خورد» + source until the file is opened. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { CalendarClock, Check, ChevronLeft, ChevronRight, FileText, History, Inbox, Phone, PhoneMissed, Search, Undo2, X } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import { fcApi, type FcLateReturn, type FcList, type FcListItem, type FcView } from './api';
import { CatPill, FC_CAT_CLS, FC_GROUP_SHORT, FC_GROUP_TITLES, RNote, fcDay } from './FcLabels';

const SIZES = [10, 20, 50] as const;
const RT_LABEL: Record<string, string> = { missing_documents: 'نقص مدارک', guarantor_documents_missing: 'نقص مدارک ضامن', collateral_rejected: 'رد وثیقه', payslip_missing: 'نقص فیش حقوقی', id_card_unreadable: 'کارت ملی ناخوانا', other: 'سایر' };
/** PM 29 Oct: bar + badge source line (who returned the file). */
const RS_LABEL: Record<string, string> = { registrar: 'از کارشناس ثبت', funder: 'از تأمین‌کننده' };
const toEn = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
/** <mark> the query inside a shown string (Persian digits match ASCII input). */
function Hl({ s, q }: { s: string; q: string }) {
  const qq = q.trim().replace(/^#/, ''); if (!qq) return <>{s}</>;
  const needle = /^[\d۰-۹٠-٩]+$/.test(qq) ? faNum(Number(toEn(qq))).replace(/٬/g, '') : qq;
  const parts = needle && !/^0/.test(toEn(qq)) ? s.split(needle) : [s];
  return <>{parts.map((p, i) => <span key={i}>{i ? <mark>{needle}</mark> : null}{p}</span>)}</>;
}
const faId = (n: number) => faNum(n).replace(/٬/g, '');
const useAsk = () => useQueryClient();

export default function FilesList({ d, cardsDone }: { d: FcView; cardsDone: number }) {
  const qc = useAsk();
  const [input, setInput] = useState(''); const [q, setQ] = useState('');
  const [page, setPage] = useState(1); const [size, setSize] = useState<number>(10);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [follow, setFollow] = useState<FcListItem | null>(null);
  useEffect(() => { const t = setTimeout(() => { setQ(input.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [input]);
  const lq = useQuery({ queryKey: ['files-carousel', 'list', q, page, size], queryFn: () => fcApi.list({ q, page, pageSize: size }), placeholderData: keepPreviousData, refetchInterval: 60_000, retry: false });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['files-carousel'] }); };
  const opened = (fileId: number) => { void fcApi.opened(fileId).catch(() => undefined).finally(refresh); };
  const bars = (d.lateReturns ?? []).filter((r) => !hidden.has(r.file_id));
  const top = d.total ? <p className="dline" role="status" data-testid="fc-dline"><Check aria-hidden="true" /><span><b>آفرین، کارت‌های امروز تمام شد ({faNum(cardsDone)} از {faNum(d.total)}).</b> بقیه‌ی کار با فهرست کامل، به همان ترتیب اولویت.</span></p>
    : <p className="dline info" role="status" data-testid="fc-nocards"><Inbox aria-hidden="true" /><span><b>امروز کارت پیشنهادی نداری.</b> فهرست کامل پرونده‌هایت به ترتیب اولویت این‌جاست.</span></p>;
  const L: FcList | undefined = lq.data;
  return <>
    {bars.map((r) => <RBar key={r.file_id} r={r} onOpen={() => opened(r.file_id)} onClose={() => setHidden((s) => new Set(s).add(r.file_id))} />)}
    {top}
    <section className="lsec" aria-label="فهرست کامل پرونده‌ها" data-testid="fc-list">
      <div className="ltb"><div className="lth"><h2>همه‌ی پرونده‌های من</h2><span className="hint" data-testid="fc-lcount">{L ? (q ? `${faNum(L.total)} نتیجه برای «${q}»، به همان ترتیب اولویت` : `${faNum(L.total)} پرونده، به ترتیب اولویت`) : '…'}</span></div>
        <div className="srch" role="search"><label className="sr-only" htmlFor="fc-q">جست‌وجو در پرونده‌ها</label><Search aria-hidden="true" />
          <input id="fc-q" className="sinp" type="search" value={input} onChange={(e) => setInput(e.target.value)} maxLength={60} placeholder="نام، شناسه، شماره‌ی پرونده یا ۴ رقم آخر موبایل" autoComplete="off" data-testid="fc-q" />
          {input ? <button type="button" className="ib sclr" aria-label="پاک کردن جست‌وجو" onClick={() => setInput('')} data-testid="fc-qclr"><X aria-hidden="true" /></button> : null}</div>
        <label className="psz"><span>در هر صفحه</span><select aria-label="تعداد در هر صفحه" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} data-testid="fc-psz">{SIZES.map((n) => <option key={n} value={n}>{faNum(n)}</option>)}</select></label>
      </div>
      {!q ? <ol className="pord" aria-label="ترتیب اولویت">{[1, 2, 3, 4, 5, 6, 7].map((g) => <li key={g} className={`g${g}`}>{FC_GROUP_SHORT[g]}</li>)}</ol> : null}
      {lq.isError ? <div className="dp-box err" role="alert" data-testid="fc-lerr">فهرست بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void lq.refetch()}>تلاش دوباره</button></div>
        : !L ? <div className="dp-skel" role="status">در حال بارگذاری فهرست…</div>
        : !L.total ? <section className="nores" role="status" data-testid="fc-nores"><Search aria-hidden="true" /><h3>{q ? `پرونده‌ای با «${q}» پیدا نشد` : 'پرونده‌ای نداری'}</h3>
            {q ? <><p>نام، شناسه‌ی مشتری، شماره‌ی پرونده یا ۴ رقم آخر موبایل را امتحان کن. فقط پرونده‌های خودت جست‌وجو می‌شوند.</p><button type="button" className="btn btn-ghost" onClick={() => setInput('')}><X size={16} aria-hidden="true" /> پاک کردن جست‌وجو</button></> : null}</section>
        : <Groups L={L} q={q} onFollow={setFollow} onOpen={opened} />}
      {L && L.pages > 1 ? <Pager L={L} onPage={(p) => { setPage(p); document.getElementById('fc-q')?.scrollIntoView({ block: 'nearest' }); }} /> : null}
    </section>
    {follow ? <FollowSheet it={follow} d={d} onClose={() => setFollow(null)} onDone={() => { setFollow(null); refresh(); }} /> : null}
  </>;
}

function Groups({ L, q, onFollow, onOpen }: { L: FcList; q: string; onFollow: (it: FcListItem) => void; onOpen: (id: number) => void }) {
  const groups = useMemo(() => { const out: Array<{ g: number; items: FcListItem[] }> = [];
    for (const it of L.items) { const last = out[out.length - 1]; if (last && last.g === it.priority_group) last.items.push(it); else out.push({ g: it.priority_group, items: [it] }); } return out; }, [L.items]);
  return <>{groups.map(({ g, items }) => <section key={g} className={`lgs g${g}${g > 5 ? ' cls' : ''}`} aria-labelledby={`fc-lg${g}`} data-testid={`fc-g${g}`}>
    <h3 className="lgh" id={`fc-lg${g}`}><span className="lgn">{faNum(g)}</span>{FC_GROUP_TITLES[g]}<small>({faNum(L.group_counts[String(g)] ?? items.length)} پرونده)</small></h3>
    <ul className="lst">{items.map((it) => <Row key={it.file_id} it={it} q={q} onFollow={() => onFollow(it)} onOpen={() => onOpen(it.file_id)} />)}</ul></section>)}</>;
}

function Row({ it, q, onFollow, onOpen }: { it: FcListItem; q: string; onFollow: () => void; onOpen: () => void }) {
  const cls = FC_CAT_CLS[it.priority_category] ?? 'k5'; const closed = it.is_closed;
  return <li className={`lrow ${cls}${closed ? ' cl' : ''}${it.returned_unopened ? ' rnew' : ''}`} data-g={it.priority_group} data-file={it.file_id} data-testid="fc-row">
    <div className="lr1"><CatPill c={it} />
      {it.returned_unopened ? <span className="nwb" title="تا وقتی پرونده را باز نکنی می‌ماند" data-testid="fc-nwb"><Undo2 aria-hidden="true" /><span className="nwt">پرونده برگشت خورد{it.return_source ? <small className="nws" data-testid="fc-nwb-src">{RS_LABEL[it.return_source]}</small> : null}</span></span> : null}
      {it.followed_up_today ? <span className="tdy" data-testid="fc-tdy"><Check aria-hidden="true" />امروز پیگیری شد</span> : null}
      <RNote c={it} /></div>
    <div className="lr2"><b className="lnm"><span><Hl s={it.customer_name} q={q} /></span><span className="cid">#<Hl s={faId(it.customer_id)} q={q} /></span></b>
      <span className="fno">پرونده‌ی <Hl s={faId(it.file_id)} q={q} /></span>
      {!closed && it.phone_masked ? <span className="ph msk" title="ماسک‌شده؛ دکمه‌ی تماس شماره‌ی کامل را می‌گیرد" data-testid="fc-pmask"><bdi dir="ltr">{it.phone_masked}</bdi></span> : null}</div>
    <div className="lr3"><History aria-hidden="true" />{closed ? `${it.priority_category === 'completed' ? 'بسته شد' : 'لغو شد'}: ${fcDay(it.closed_at ?? it.last_activity_at)}` : `آخرین فعالیت: ${fcDay(it.last_activity_at)}`}</div>
    <div className="lra">
      <button type="button" className="btn btn-primary" aria-haspopup="dialog" disabled={!it.can_follow_up} onClick={onFollow} data-testid="fc-follow"><Phone size={16} aria-hidden="true" /> پیگیری</button>
      <Link href={`/loan-applications/${it.file_id}`} className="btn btn-ghost" onClick={onOpen} data-testid="fc-edit-row"><FileText size={16} aria-hidden="true" /> ویرایش</Link>
    </div></li>;
}

function Pager({ L, onPage }: { L: FcList; onPage: (p: number) => void }) {
  const from = (L.page - 1) * L.page_size + 1, to = Math.min(L.page * L.page_size, L.total);
  return <nav className="pgn" aria-label="صفحه‌های فهرست" data-testid="fc-pgn">
    <button type="button" className="btn btn-ghost pv" aria-disabled={L.page === 1 || undefined} onClick={() => L.page > 1 && onPage(L.page - 1)}><ChevronRight size={16} aria-hidden="true" /> قبلی</button>
    {Array.from({ length: L.pages }, (_, i) => i + 1).map((p) => <button key={p} type="button" className="pgb" aria-current={p === L.page ? 'page' : undefined} aria-label={`صفحه‌ی ${faNum(p)}`} onClick={() => onPage(p)}>{faNum(p)}</button>)}
    <button type="button" className="btn btn-ghost nx" aria-disabled={L.page === L.pages || undefined} onClick={() => L.page < L.pages && onPage(L.page + 1)}>بعدی <ChevronLeft size={16} aria-hidden="true" /></button>
    <span className="hint">{faNum(from)} تا {faNum(to)} از {faNum(L.total)}</span></nav>;
}

const HM = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
function RBar({ r, onOpen, onClose }: { r: FcLateReturn; onOpen: () => void; onClose: () => void }) {
  const when = r.returned_at ? `${fcDay(r.returned_at)} ساعت ${HM.format(new Date(r.returned_at))}` : '';
  return <div className="rbar" role="status" aria-live="polite" data-testid="fc-rbar" data-file={r.file_id}><Undo2 aria-hidden="true" />
    <div className="rbt"><b>پرونده برگشت خورد</b>
      {r.return_source ? <span className="rsrc" data-testid="fc-rbar-src">{RS_LABEL[r.return_source]}</span> : null}
      <p className="rbs">پرونده‌ی {faId(r.file_id)} · <span className="rbn">{r.customer_name}</span> · {RT_LABEL[r.return_type ?? 'other'] ?? 'سایر'}{when ? ` · ${when}` : ''}. حالا در دسته‌ی ۱ فهرست است؛ فهرست مثل قبل کار می‌کند.</p></div>
    <div className="rba"><Link href={`/loan-applications/${r.file_id}`} className="btn btn-primary" onClick={onOpen} data-testid="fc-rbar-open"><FileText size={16} aria-hidden="true" /> باز کردن پرونده</Link>
      <button type="button" className="ib rbx" aria-label="بستن این نوار" onClick={onClose} data-testid="fc-rbar-x"><X aria-hidden="true" /></button></div></div>;
}

/** «پیگیری» from the list (pri.js FUS): the number comes from GET /tel/:id only when the expert taps «تماس»; after saving, back to the same list page. */
function FollowSheet({ it, d, onClose, onDone }: { it: FcListItem; d: FcView; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState(''); const [note, setNote] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [calling, setCalling] = useState(false); const [sure, setSure] = useState(false);
  const box = useRef<HTMLDivElement>(null); const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; closeBtn.current?.focus(); return () => prev?.focus?.(); }, []);
  const outs = d.outcomes.filter((o) => o.code !== 'cancelled' || it.can_cancel); const cx = outcome === 'cancelled';
  const call = async () => { setErr(''); try { const r = await fcApi.tel(it.file_id); if (!r.tel) { setErr('شماره‌ی این مشتری ثبت نشده.'); return; } setCalling(true); window.location.href = `tel:${r.tel.replace(/[^\d+]/g, '')}`; } catch (e) { setErr(e instanceof Error ? e.message : 'شماره گرفته نشد.'); } };
  const save = async () => {
    if (!outcome) { setErr('نتیجه را انتخاب کن.'); return; }
    if (cx ? !reason.trim() : !note.trim()) { setErr(cx ? 'دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود.' : 'یادداشت تماس لازم است.'); return; }
    if (cx && !sure) { setSure(true); return; }
    setBusy(true); setErr('');
    try { await fcApi.followup(cx ? { fileId: it.file_id, outcome, cancelReason: reason.trim() } : { fileId: it.file_id, outcome, note: note.trim() }); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); } };
  const OIcon = ({ code }: { code: string }) => code === 'answered' ? <Check size={16} aria-hidden="true" /> : code === 'no_answer' ? <PhoneMissed size={16} aria-hidden="true" /> : code === 'follow_up' ? <CalendarClock size={16} aria-hidden="true" /> : code === 'cancelled' ? <X size={16} aria-hidden="true" /> : null;
  return <div className="fc-dlgw fc-shw" onKeyDown={onKey} data-testid="fc-follow-sheet">
    <div className="fc-sht" ref={box} role="dialog" aria-modal="true" aria-labelledby="fc-fu-t">
      <header className="dsh"><div><span className="eb"><Phone size={14} aria-hidden="true" /> پیگیری پرونده‌ی {faId(it.file_id)}</span><h2 id="fc-fu-t">{it.customer_name} <span className="dp-id">#{faId(it.customer_id)}</span></h2></div>
        <button type="button" ref={closeBtn} className="ib" aria-label="بستن" onClick={onClose} disabled={busy}><X aria-hidden="true" /></button></header>
      <div className="dsb"><div className="fld"><CatPill c={it} /></div><RNote c={it} />
        {it.phone_masked ? <p className="dp-phone" data-testid="fc-fu-mask"><Phone size={14} aria-hidden="true" /> <bdi dir="ltr">{it.phone_masked}</bdi></p> : null}
        <button type="button" className="btn btn-primary dp-call" onClick={() => void call()} data-testid="fc-fu-call"><Phone size={16} aria-hidden="true" /> تماس با {it.customer_name}</button>
        {calling ? <div className="calling" role="status"><Phone size={16} aria-hidden="true" /> تماس شروع شد؛ نتیجه را ثبت کن</div> : null}
        <fieldset className="fc-result"><legend>نتیجه‌ی پیگیری<span className="req" aria-hidden="true">*</span></legend>
          <div className={`rlist${outs.length === 4 ? ' s4' : ''}`} role="radiogroup">{outs.map((o) => <label key={o.code} className={`rr${outcome === o.code ? ' on' : ''}${o.code === 'cancelled' ? ' cx' : ''}`}>
            <input type="radio" name="fc-fu-outcome" value={o.code} checked={outcome === o.code} onChange={() => { setOutcome(o.code); setErr(''); setSure(false); }} data-testid={`fc-fu-o-${o.code}`} /> <OIcon code={o.code} /> {o.label}</label>)}</div>
          {cx ? <><label htmlFor="fc-fu-reason"><b>دلیل لغو</b> <small>برگرداندن لغو فقط با ادمین</small></label>
            <textarea id="fc-fu-reason" className="inp tx" rows={2} value={reason} onChange={(e) => setReason(e.target.value.replace(/[\r\n]/g, ' '))} data-testid="fc-fu-reason" /></>
            : <AutoGrowTextarea className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت تماس" aria-label="یادداشت تماس" data-testid="fc-fu-note" />}
        </fieldset>
        {cx && sure ? <p className="fc-cxa" role="alert" data-testid="fc-fu-sure"><b>پرونده لغو شود؟</b> برگرداندن لغو فقط با ادمین است. برای تأیید دوباره بزن.</p> : null}
        {err ? <p className="dp-err" role="alert" data-testid="fc-fu-err">{err}</p> : null}</div>
      <footer className="dsf"><button type="button" className={`btn ${cx ? 'fc-dzf' : 'btn-primary'}`} disabled={busy} onClick={() => void save()} data-testid="fc-fu-save"><Check size={16} aria-hidden="true" /> {busy ? 'در حال ثبت…' : cx ? (sure ? 'بله، لغو شود' : 'لغو پرونده') : 'ثبت پیگیری'}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>انصراف</button>
        <span className="hint">بعد از ثبت به همین فهرست و همین صفحه برمی‌گردی. فهرست قفل نمی‌شود.</span></footer>
    </div></div>;
}
