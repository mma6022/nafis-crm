/** FILES-BOARD stage 3 (Armita today-split-files-board v1.0.4 §3, screens 14-board … 23-board_nodrag): «پرونده‌های من» as a 7-column status board.
 *  Only with the user's own flag.files_board (server-checked, OFF by default; users 8/2/3 on top of files_lock). The server computes ONE turn for the
 *  whole board (REL-83 order minus files followed up today, recomputed on every request) and blocks writes on any other own file (423 board_turn) and
 *  on closed files (423 board_closed). Cards are not draggable: a stage changes only through the file's own forms. Reads stay open. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, Bell, Check, Clock, Eye, Flag, Layers, Lock, Plus, Upload, X } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import { toPersianDigits } from '@/lib/customer-id';
import { CallNumber } from '@/features/call-number/CallNumber';
import { CreateWizard } from '@/components/loan-applications/CreateWizard';
import { fcApi, type FbBoard, type FbCard, type FcView } from '@/features/files-carousel/api';
import { CatPill, fcDay } from '@/features/files-carousel/FcLabels';
import { loanStageLabel } from '@/lib/loan-labels';
import { FB_COLUMNS, FB_STEPS, fbColumnLabel, fbColumnOf, type FbColumn } from './columns';
import '@/features/daily-plan/daily-plan.css';
import '@/features/files-carousel/files-carousel.css';
import './today-split.css';

const faName = (s?: string | null) => toPersianDigits(s ?? '');
/** Column subtitles (tsf.js COLS). Half-space labels («تکمیل‌شده», «لغوشده») stay inside the board only (PM default 4). */
const SUB: Record<FbColumn, string> = { draft: 'نوبت تو', documents: 'نوبت تو', collateral: 'نوبت تو', signature: 'نوبت مشتری و تو', review: 'نزد کارشناس ثبت یا تأمین‌کننده', completed: 'بسته، ۳۰ روز اخیر', cancelled: 'بسته، ۳۰ روز اخیر' };
const CLOSED_COLS = new Set<FbColumn>(['completed', 'cancelled']);
export const FB_NODRAG = 'کارت‌ها کشیدنی نیستند؛ پرونده را باز کن و از فرم خودش ادامه بده';
export const FB_LATER = 'امروز پیگیری شد (تماس تسک بالفعل یا ثبت نتیجه در پرونده)؛ فردا سر جای خودش در ترتیب برمی‌گردد';
export const fbLockHint = (turnName: string | null | undefined) => turnName ? `به ترتیب باز می‌شود؛ اول پرونده‌ی ${toPersianDigits(turnName)} را باز کن` : 'امروز همه‌ی پرونده‌های باز پیگیری شدند؛ فردا به ترتیب باز می‌شوند';
const JT = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hm = (iso?: string | null) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : JT.format(d); };
const dayAt = (iso?: string | null) => { const d = fcDay(iso); return d === 'امروز' && iso ? `امروز ${hm(iso)}` : d; };
const MOBILE = '(max-width: 1023.98px)';
const useBoard = (enabled = true) => useQuery({ queryKey: ['files-carousel', 'board'], queryFn: fcApi.board, refetchInterval: 60_000, retry: false, enabled });
export { useBoard };

export default function FilesBoard() {
  const q = useBoard();
  if (q.isLoading) return <div className="dp-page"><div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div></div>;
  if (q.isError || !q.data) return <div className="dp-page"><div className="dp-box err" role="alert" data-testid="fb-error">پرونده‌ها بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void q.refetch()}>تلاش دوباره</button></div></div>;
  return <Board b={q.data} />;
}

function Board({ b }: { b: FbBoard }) {
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [sheet, setSheet] = useState<number | null>(null);
  const [toast, setToast] = useState<{ t: string; lock?: boolean } | null>(null);
  const [openClosed, setOpenClosed] = useState<Record<string, boolean>>({});
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);
  const byCol = useMemo(() => { const m = new Map<FbColumn, FbCard[]>(FB_COLUMNS.map((c) => [c.key, []])); for (const c of b.cards) m.get(fbColumnOf(c.stage, c.status))!.push(c); return m; }, [b.cards]);
  const turn = b.turn ? b.cards.find((c) => c.fileId === b.turn!.fileId) ?? null : null;
  const turnCol = turn ? fbColumnOf(turn.stage, turn.status) : null;
  const startIdx = Math.max(0, FB_COLUMNS.findIndex((c) => c.key === (turnCol ?? 'draft')));
  const [sel, setSel] = useState(startIdx);
  const kbw = useRef<HTMLDivElement>(null);
  const mob = () => window.matchMedia(MOBILE).matches;
  // Mobile: one column per view; START = the turn file's column (PM). Chips and horizontal swipe stay in sync.
  useEffect(() => { if (!mob()) return; const el = kbw.current?.children[startIdx] as HTMLElement | undefined; el?.scrollIntoView({ block: 'nearest', inline: 'start' }); setSel(startIdx); }, [startIdx]);
  const onScroll = () => { const w = kbw.current; if (!w || !mob()) return; const i = Math.round(Math.abs(w.scrollLeft) / Math.max(1, w.clientWidth)); if (i !== sel && i >= 0 && i < FB_COLUMNS.length) setSel(i); };
  const goCol = (i: number) => { setSel(i); const el = kbw.current?.children[i] as HTMLElement | undefined; el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' }); };
  const onChipKey = (e: React.KeyboardEvent) => { const m: Record<string, number> = { ArrowLeft: sel + 1, ArrowRight: sel - 1, Home: 0, End: FB_COLUMNS.length - 1 }; if (!(e.key in m)) return; e.preventDefault();
    const n = (m[e.key] + FB_COLUMNS.length) % FB_COLUMNS.length; goCol(n); (e.currentTarget.children[n] as HTMLElement | undefined)?.focus(); };
  const chips = useRef<HTMLDivElement>(null);
  useEffect(() => { const c = chips.current, el = c?.children[sel] as HTMLElement | undefined; if (!c || !el || c.scrollWidth <= c.clientWidth) return;
    const a = el.getBoundingClientRect(), b = c.getBoundingClientRect(); c.scrollLeft += (a.left + a.width / 2) - (b.left + b.width / 2); }, [sel]);
  const lockHint = fbLockHint(turn?.customerName);
  // board_after_task / board_more notes (derived from the payload; nothing stored).
  const recent = [...b.cards].filter((c) => c.state === 'later' && c.followedToday && Date.now() - Date.parse(c.followedToday.at) < 30 * 60_000).sort((x, y) => y.followedToday!.at.localeCompare(x.followedToday!.at))[0];
  const retTurn = turn && turn.fc.priority_category === 'returned' && fcDay(turn.fc.returned_at) === 'امروز' ? turn : null;
  const cur = sheet != null ? b.cards.find((c) => c.fileId === sheet) ?? null : null;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['files-carousel', 'board'] }); void qc.invalidateQueries({ queryKey: ['files-carousel', 'today'] }); };
  return <div className="ts-page fb-page" data-testid="fb-page">
    <div className="fb-hrow"><h1>پرونده‌های من</h1><span className="fb-muted" data-testid="fb-total">{faNum(b.total)} پرونده</span><span className="fb-sp" />
      <button type="button" className="btn btn-primary fb-new" onClick={() => setWizard(true)} data-testid="fb-new"><Plus size={16} aria-hidden="true" /> ثبت پرونده جدید</button></div>
    <p className="fb-note fb-kbo" data-testid="fb-turn-note"><Flag size={16} aria-hidden="true" /><span>{turn
      ? <>پرونده‌ها یکی‌یکی و به ترتیب باز می‌شوند. الان نوبت <b>{faName(turn.customerName)}</b> است (ستون «{fbColumnLabel(turnCol!)}»)؛ بقیه قفل‌اند تا آن پیگیری شود. پیگیری امروز، چه ثبت نتیجه در پرونده چه تماس تسک بالفعل، اگر نتیجه‌ی نهایی نداشته باشد «پیگیری شد، فردا» می‌شود و نوبت به بعدی می‌رسد. پرونده‌های بسته همیشه فقط‌خواندنی بازند.</>
      : <>امروز همه‌ی پرونده‌های باز پیگیری شدند؛ فردا هر کدام سر جای خودش در ترتیب برمی‌گردد. پرونده‌های بسته همیشه فقط‌خواندنی بازند.</>}</span></p>
    {retTurn ? <p className="fb-note fb-kbe" data-testid="fb-ret-note"><Bell size={16} aria-hidden="true" /><span>پرونده‌ی <b>{faName(retTurn.customerName)}</b> امروز {hm(retTurn.fc.returned_at)} برگشت خورد و نوبت اوست.</span></p> : null}
    {recent ? <p className="fb-note fb-kbe" role="status" data-testid="fb-after-note"><Check size={16} aria-hidden="true" /><span>{recent.followedToday!.source === 'call' ? 'تماس' : 'نتیجه‌ی پیگیری'} با <b>{faName(recent.customerName)}</b> ثبت شد ({hm(recent.followedToday!.at)}). نتیجه‌ی نهایی نبود، پس پرونده «پیگیری شد، فردا» شد{turn ? <> و نوبت به <b>{faName(turn.customerName)}</b> رسید</> : null}.</span></p> : null}
    <p className="fb-note fb-kbn"><Lock size={16} aria-hidden="true" /><span>وضعیت هر پرونده فقط با فرم‌های خود پرونده عوض می‌شود؛ کارت‌ها کشیدنی نیستند. در هر ستون، کارت‌ها به ترتیب اولویت‌اند.</span></p>
    <div className="fb-chips" role="tablist" aria-label="ستون‌های وضعیت" ref={chips} onKeyDown={onChipKey} data-testid="fb-chips">{FB_COLUMNS.map((c, i) =>
      <button key={c.key} type="button" role="tab" id={`fb-t-${c.key}`} aria-controls={`fb-c-${c.key}`} aria-selected={i === sel} tabIndex={i === sel ? 0 : -1} className={`fb-ch${CLOSED_COLS.has(c.key) ? ' cl' : ''}`} onClick={() => goCol(i)} data-testid="fb-chip">
        {c.label}<span className="fb-kn">{faNum(byCol.get(c.key)!.length)}</span></button>)}</div>
    <p className="fb-muted fb-khint" aria-live="polite"><span data-testid="fb-pos">ستون {faNum(sel + 1)} از {faNum(FB_COLUMNS.length)}</span>؛ برای ستون بعد بکش یا چیپ را بزن.</p>
    <div className={`fb-kbw${Object.values(openClosed).some(Boolean) ? ' wide' : ''}`} ref={kbw} onScroll={onScroll} data-testid="fb-board">{FB_COLUMNS.map((c) => {
      const items = byCol.get(c.key)!; const closed = CLOSED_COLS.has(c.key); const coll = closed && !openClosed[c.key];
      return <section key={c.key} className={`fb-kc${closed ? ' kcl' : ''}${coll ? ' kcc' : ''}`} id={`fb-c-${c.key}`} role="tabpanel" aria-labelledby={`fb-h-${c.key}`} data-testid="fb-col" data-col={c.key}>
        <header className="fb-kh"><h3 id={`fb-h-${c.key}`}>{closed ? c.key === 'completed' ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" /> : null}{c.label}<span className="fb-kn" aria-label={`${faNum(items.length)} پرونده`}>{faNum(items.length)}</span></h3>
          <p className="fb-muted">{SUB[c.key]}</p>
          {closed ? <button type="button" className="btn btn-ghost fb-kt" aria-expanded={!coll} aria-controls={`fb-l-${c.key}`} onClick={() => setOpenClosed((o) => ({ ...o, [c.key]: !o[c.key] }))} data-testid="fb-toggle">{coll ? 'نمایش' : 'جمع کن'}</button> : null}</header>
        <div className="fb-kl" id={`fb-l-${c.key}`}>{items.length ? items.map((f) => <BoardCard key={f.fileId} f={f} lockHint={lockHint} onOpen={() => setSheet(f.fileId)} onToast={(t) => setToast({ t, lock: true })} />)
          : <div className="fb-ke" data-testid="fb-empty"><Layers size={24} aria-hidden="true" /><b>این ستون خالی است</b><span className="fb-muted">پرونده‌ای در این وضعیت نداری.</span></div>}</div>
      </section>; })}</div>
    {cur ? <BoardSheet f={cur} turn={turn} onClose={() => setSheet(null)} onSaved={(name) => { setSheet(null); refresh(); setToast({ t: `${name}: پیگیری ثبت شد` }); }} onToast={(t) => setToast({ t, lock: true })} /> : null}
    {wizard ? <CreateWizard onClose={() => { setWizard(false); refresh(); }} /> : null}
    {toast ? <div className={`fc-toast fb-toast${toast.lock ? '' : ' ok'}`} role="status" data-testid="fb-toast">{toast.lock ? <Lock size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{toast.t}</span></div> : null}
  </div>;
}

function BoardCard({ f, lockHint, onOpen, onToast }: { f: FbCard; lockHint: string; onOpen: () => void; onToast: (t: string) => void }) {
  const nx = f.state === 'turn', cl = f.state === 'closed', lt = f.state === 'later';
  const x0 = useRef<[number, number] | null>(null);
  const hint = lt ? FB_LATER : lockHint;
  const stage = loanStageLabel(f.stage);
  return <article className={`fb-fc${nx ? ' nx' : cl ? ' ro fd' : ' lkd'}${lt ? ' lt' : ''}`} draggable={false} data-testid="fb-card" data-file={f.fileId} data-state={f.state}
    onPointerDown={(e) => { x0.current = [e.clientX, e.clientY]; }} onPointerUp={() => { x0.current = null; }}
    onPointerMove={(e) => { if (!x0.current || e.pointerType === 'touch') return; if (Math.hypot(e.clientX - x0.current[0], e.clientY - x0.current[1]) > 24) { x0.current = null; onToast(FB_NODRAG); } }}
    onDragStart={(e) => e.preventDefault()}>
    <div className="fb-fn-row">{nx || cl
      ? <button type="button" className="fb-fn" onClick={onOpen} aria-label={nx ? `باز کردن پرونده‌ی ${faName(f.customerName)}، پرونده ${faNum(f.fileId)}، نوبت این پرونده است` : `دیدن پرونده‌ی ${faName(f.customerName)}، پرونده ${faNum(f.fileId)}، بسته و فقط‌خواندنی`} data-testid="fb-fn">{faName(f.customerName)}</button>
      : <button type="button" className="fb-fn" aria-disabled="true" onClick={() => onToast(hint)} aria-label={`پرونده‌ی ${faName(f.customerName)}، پرونده ${faNum(f.fileId)}، قفل؛ ${hint}`} data-testid="fb-fn">{faName(f.customerName)}</button>}
      <span className="dp-id">#{faNum(f.customerId)}</span>{nx || cl ? null : <span className="fb-fcl" aria-hidden="true"><Lock size={15} /></span>}</div>
    {nx ? <span className="ts-turn fb-nxb" data-testid="fb-turn-chip"><Flag size={14} aria-hidden="true" /> نوبت این پرونده‌ست</span> : null}
    <CatPill c={f.fc} small />
    <p className="fb-fc-m"><span>پرونده {faNum(f.fileId)}</span><span>{stage}</span></p>
    <p className="fb-fc-t"><Clock size={14} aria-hidden="true" /><span>آخرین فعالیت: {dayAt(f.fc.last_activity_at)}</span>
      {lt ? <span className="ts-noturn fb-lt" data-testid="fb-later"><Clock size={14} aria-hidden="true" /> پیگیری شد، فردا</span> : null}</p>
  </article>;
}

function BoardSheet({ f, turn, onClose, onSaved, onToast }: { f: FbCard; turn: FbCard | null; onClose: () => void; onSaved: (name: string) => void; onToast: (t: string) => void }) {
  const isTurn = f.state === 'turn', cl = f.state === 'closed', cx = f.status === 'rejected';
  const col = fbColumnOf(f.stage, f.status); const ci = col === 'cancelled' ? -1 : FB_STEPS.findIndex((s) => s.key === col);
  const [res, setRes] = useState(false);
  const box = useRef<HTMLDivElement>(null); const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; first.current?.focus(); return () => prev?.focus?.(); }, []);
  useEffect(() => { if (!res) first.current?.focus(); }, [res]); // back from the result dialog: keep focus (Escape/Tab) inside the sheet
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Tab' && box.current) { const q = [...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')]; if (!q.length) return;
      const a = q[0], z = q[q.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } } };
  const stage = loanStageLabel(f.stage);
  if (res && isTurn) return <BoardResult f={f} onClose={() => setRes(false)} onSaved={() => onSaved(faName(f.customerName))} />;
  return <div className="ts-ov" onKeyDown={onKey} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="fb-sheet-wrap">
    <div className="ts-dlg" role="dialog" aria-modal="true" aria-labelledby="fb-s-h" ref={box} data-testid="fb-sheet" data-state={f.state}>
      <header><div><small>پرونده {faNum(f.fileId)}، ستون «{fbColumnLabel(col)}»</small><h2 id="fb-s-h">{faName(f.customerName)} <span className="dp-id">#{faNum(f.customerId)}</span></h2></div>
        <button type="button" ref={first} className="ts-x" onClick={onClose} aria-label="بستن"><X size={20} aria-hidden="true" /></button></header>
      <div className="ts-body">
        <div className="ts-chips">{isTurn ? <span className="ts-turn" data-testid="fb-s-turn"><Flag size={14} aria-hidden="true" /> نوبت این پرونده‌ست</span>
          : cl ? <span className="ts-noturn" data-testid="fb-s-ro"><Eye size={14} aria-hidden="true" /> فقط‌خواندنی</span>
          : <span className="ts-noturn" data-testid="fb-s-noturn"><Lock size={14} aria-hidden="true" /> نوبتش نیست</span>}<CatPill c={f.fc} /></div>
        {cx ? null : <ol className="ts-stepper" aria-label={`مرحله: ${fbColumnLabel(col)}`}>{FB_STEPS.map((s, i) => { const dn = i < ci || col === 'completed'; return <li key={s.key} className={dn ? 'dn' : i === ci ? 'on' : ''} aria-current={i === ci ? 'step' : undefined}>
          <span>{dn ? <Check size={12} aria-hidden="true" /> : faNum(i + 1)}</span>{s.label}</li>; })}</ol>}
        {f.phone ? <div className="ts-ph sm"><small>شماره‌ی مشتری</small><CallNumber phone={f.phone} customerId={f.customerId} via="files" testId="fb-s-ph" /></div> : null}
        <dl className="ts-kv"><dt>مرحله</dt><dd>{stage}</dd><dt>آخرین فعالیت</dt><dd>{dayAt(f.fc.last_activity_at)}</dd>
          {f.followedToday ? <><dt>پیگیری امروز</dt><dd data-testid="fb-s-today">{f.followedToday.source === 'call' ? 'تماس' : 'نتیجه'} {hm(f.followedToday.at)}؛ پیگیری شد، فردا</dd></> : null}
          <dt>آخرین پیگیری</dt><dd>{f.lastFollowUp ? `${dayAt(f.lastFollowUp.at)}${f.lastFollowUp.outcomeLabel ? `، ${f.lastFollowUp.outcomeLabel}` : ''}` : 'هنوز پیگیری نشده'}</dd></dl>
        {cl ? <p className="ts-hint" role="note" data-testid="fb-s-ro-note"><Eye size={14} aria-hidden="true" /> پرونده‌ی بسته همیشه باز است ولی فقط‌خواندنی؛ ویرایش یا اقدامی ندارد و در ترتیب نوبت نیست.</p>
          : isTurn ? <p className="ts-hint"><Lock size={14} aria-hidden="true" /> مرحله فقط با فرم خود پرونده جلو می‌رود؛ جابه‌جا کردن کارت روی تخته نیست.</p>
          : <p className="ts-hint" role="note" data-testid="fb-s-hint"><Lock size={14} aria-hidden="true" /> {f.state === 'later' ? FB_LATER + '.' : <>نوبت این پرونده نیست. پرونده‌ها به ترتیب باز می‌شوند{turn ? <>؛ الان نوبت <b>{faName(turn.customerName)}</b> است.</> : '.'}</>}</p>}
      </div>
      {cl ? null : <footer className="fb-sf">{isTurn ? <><Link href={`/loan-applications/${f.fileId}`} className="btn btn-primary" data-testid="fb-open"><Upload size={16} aria-hidden="true" /> باز کردن پرونده: {stage}</Link>
          <button type="button" className="btn btn-ghost" onClick={() => setRes(true)} data-testid="fb-result">تماس گرفتم، ثبت نتیجه</button></>
        : <><button type="button" className="btn btn-primary fb-dis" aria-disabled="true" aria-describedby="fb-s-dh" onClick={() => onToast(f.state === 'later' ? FB_LATER : fbLockHint(turn?.customerName))} data-testid="fb-open"><Lock size={16} aria-hidden="true" /> باز کردن پرونده</button>
          <span className="sr-only" id="fb-s-dh">نوبت این پرونده نیست</span>
          <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="fb-back">برگشت</button></>}</footer>}
    </div>
  </div>;
}

/** «تماس گرفتم، ثبت نتیجه» on the turn file: the existing /files-carousel/followup (the same outcomes and one-line note as the task dialog). */
function BoardResult({ f, onClose, onSaved }: { f: FbCard; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const v = qc.getQueryData<FcView>(['files-carousel', 'today']);
  const tq = useQuery({ queryKey: ['files-carousel', 'today'], queryFn: fcApi.today, enabled: !v, retry: false });
  const outcomes = (v ?? tq.data)?.outcomes ?? [];
  const [o, setO] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [confirm, setConfirm] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const cx = o === 'cancelled';
  const submit = async () => {
    if (!o) { setErr('نتیجه را انتخاب کن.'); return; }
    if (!note.trim()) { setErr(cx ? 'دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود.' : 'یادداشت یک‌خطی لازم است.'); return; }
    if (cx && !confirm) { setConfirm(true); return; }
    setBusy(true); setErr('');
    try { const r = await fcApi.followup(cx ? { fileId: f.fileId, outcome: 'cancelled', cancelReason: note.trim() } : { fileId: f.fileId, outcome: o, note: note.trim() }); qc.setQueryData(['files-carousel', 'today'], r.view); onSaved(); }
    catch (e) { setConfirm(false); setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <div className="ts-ov" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); } }} data-testid="fb-result-wrap">
    <div className="ts-dlg" role="dialog" aria-modal="true" aria-labelledby="fb-r-h" data-testid="fb-result-dlg">
      <header><div><small>پرونده {faNum(f.fileId)}، نوبت این پرونده</small><h2 id="fb-r-h">ثبت نتیجه، {faName(f.customerName)} <span className="dp-id">#{faNum(f.customerId)}</span></h2></div>
        <button type="button" ref={first} className="ts-x" onClick={onClose} disabled={busy} aria-label="بستن"><X size={20} aria-hidden="true" /></button></header>
      <div className="ts-body">
        {f.phone ? <div className="ts-ph sm"><small>شماره‌ی مشتری</small><CallNumber phone={f.phone} customerId={f.customerId} via="files" testId="fb-r-ph" /></div> : null}
        <fieldset className="ts-res"><legend>نتیجه</legend><div className="ts-rlist" role="radiogroup">{outcomes.map((x) => <label key={x.code} className={`ts-rr${o === x.code ? ' on' : ''}${x.code === 'cancelled' ? ' cx' : ''}`}>
          <input type="radio" name="fb-o" value={x.code} checked={o === x.code} onChange={() => { setO(x.code); setErr(''); setConfirm(false); }} data-testid={`fb-o-${x.code}`} /> {x.label}</label>)}</div></fieldset>
        <p className="ts-hint" role="note"><Clock size={14} aria-hidden="true" /> <span>نتیجه‌ی نهایی فقط «لغو شده» یا رفتن پرونده به مرحله‌ی بعد است. بدون نتیجه‌ی نهایی، پرونده «پیگیری شد، فردا» می‌شود و نوبت به پرونده‌ی بعدی می‌رسد.</span></p>
        <label className="ts-nl" htmlFor="fb-note"><b>{cx ? 'دلیل لغو' : 'یادداشت یک‌خطی'}</b></label>
        <textarea id="fb-note" className="inp" rows={2} value={note} maxLength={cx ? (v ?? tq.data)?.cancelReasonMax ?? 500 : (v ?? tq.data)?.noteMax ?? 120} onChange={(e) => { setNote(e.target.value.replace(/[\r\n]/g, ' ')); setErr(''); setConfirm(false); }} data-testid="fb-note" />
        {confirm ? <p className="dp-box warn sm" role="alert"><AlertCircle size={15} aria-hidden="true" /> <b>برگرداندن لغو فقط با ادمین است.</b> برای لغو، دوباره دکمه را بزن.</p> : null}
        {err ? <p className="dp-err" role="alert" data-testid="fb-err">{err}</p> : null}
      </div>
      <footer><button type="button" className={`btn ${cx ? 'fc-dzf' : 'btn-primary'}`} disabled={busy || !o || !note.trim()} onClick={() => void submit()} data-testid="fb-save">{busy ? 'در حال ثبت…' : cx ? confirm ? 'بله، لغو شود' : 'لغو پرونده' : 'ثبت نتیجه'}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>بعداً</button></footer>
    </div>
  </div>;
}
