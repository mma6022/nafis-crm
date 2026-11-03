/** TODAY-SPLIT stage 1 (Armita today-split-files-board v1.0.2 §1; Mohammad t709s2756): «کارهای امروز من» with two tabs.
 *  «مشتریان بالقوه» = the existing daily list (TodayPage, unchanged, kept mounted so it keeps its own current card).
 *  «مشتریان بالفعل» = today's FILES-61 file tasks in the approved priority order: progress, the current task card (label, reason, full number + copy,
 *  «تماس گرفتم، ثبت نتیجه», «پرونده»), «ترتیب امروز», the 3-step result dialog, done / empty / act_more states, and the file sheet (act_file / act_file_turn).
 *  Behind flag.today_split.user.<id> (server-checked, OFF by default). Writes only through the existing /files-carousel/followup. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, Check, ClipboardList, FileText, Flag, History, ListOrdered, Lock, Upload, X } from 'lucide-react';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { faNum } from '@/features/call-queue/api';
import { dpApi, useDpConfig, type DpToday } from '@/features/daily-plan/api';
import { faDate } from '@/features/daily-plan/TodayPage';
import { CallNumber } from '@/features/call-number/CallNumber';
import { fcApi, type FcCard, type FcView } from '@/features/files-carousel/api';
import { CatPill, RNote, fcDay } from '@/features/files-carousel/FcLabels';
import { loanStageLabel } from '@/lib/loan-labels';
import { FB_STEPS, fbColumnLabel, fbColumnOf } from './columns';
import { useTodaySplit } from './api';
import '@/features/daily-plan/daily-plan.css';
import '@/features/files-carousel/files-carousel.css';
import './today-split.css';

const JF = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const at = (iso?: string | null) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(JF.formatToParts(d).map((x) => [x.type, x.value])); return `${p.weekday} ${p.day} ${p.month}، ${p.hour}:${p.minute}`; };
const tehranYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Route gate for /today: users 8/2/3 with their own flag get the tabs; everyone else renders `children` (the old page) with no extra fetch. */
export default function TodaySplitGate({ children }: { children: ReactNode }) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const u = session?.user as { id?: number; role?: string } | undefined;
  const s = useTodaySplit(u?.id != null ? Number(u.id) : null, u?.role);
  if (!s.data?.on) return <>{children}</>;
  return <TodaySplit potential={children} />;
}

type Tab = 'act' | 'pot';
function TodaySplit({ potential }: { potential: ReactNode }) {
  const fq = useQuery({ queryKey: ['files-carousel', 'today'], queryFn: fcApi.today, refetchInterval: 60_000, retry: false });
  const dpOn = Boolean(useDpConfig().data?.flags.daily_plan);
  const dq = useQuery({ queryKey: ['daily-plan', 'today'], queryFn: dpApi.today, enabled: dpOn, refetchInterval: 30_000, retry: false });
  const [tab, setTab] = useState<Tab | null>(null);
  const v = fq.data;
  const remaining = v ? v.cards.filter((c) => c.state !== 'done').length : 0;
  // §1: default = بالفعل while it has tasks, else بالقوه; decided once on landing, the user may always switch.
  useEffect(() => { if (tab == null && (v || fq.isError)) setTab(v && remaining > 0 ? 'act' : 'pot'); }, [v, fq.isError, remaining, tab]);
  const dd = dq.data as DpToday | undefined;
  const potLeft = dd && 'eligible' in dd && dd.eligible ? (dd.current ? 1 : 0) + dd.upcoming.length : null;
  const cur = tab ?? 'act';
  const tabsRef = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return; e.preventDefault();
    const n: Tab = cur === 'act' ? 'pot' : 'act'; setTab(n); tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${n}"]`)?.focus(); };
  const day = v?.date ?? tehranYmd();
  return <div className="ts-page" data-testid="ts-page" data-tab={cur}>
    <div className="ts-top"><h1>کارهای امروز من</h1><span className="ts-date">{faDate(day)}</span></div>
    <div className="ts-tabs" role="tablist" aria-label="کارهای امروز" ref={tabsRef} onKeyDown={onKey}>
      <button type="button" role="tab" id="ts-t-pot" data-tab="pot" aria-selected={cur === 'pot'} aria-controls="ts-p-pot" tabIndex={cur === 'pot' ? 0 : -1} onClick={() => setTab('pot')} data-testid="ts-tab-pot">
        مشتریان بالقوه {potLeft != null ? <span className="tc" data-testid="ts-pot-count" aria-label={`${faNum(potLeft)} کار مانده`}>{faNum(potLeft)}</span> : null}</button>
      <button type="button" role="tab" id="ts-t-act" data-tab="act" aria-selected={cur === 'act'} aria-controls="ts-p-act" tabIndex={cur === 'act' ? 0 : -1} onClick={() => setTab('act')} data-testid="ts-tab-act">
        مشتریان بالفعل {v ? remaining > 0 ? <span className="tc hot" data-testid="ts-act-count" aria-label={`${faNum(remaining)} تسک مانده`}>{faNum(remaining)}</span>
          : v.total > 0 ? <span className="tc ok" data-testid="ts-act-ok" aria-label="تمام شد"><Check size={15} aria-hidden="true" /></span> : <span className="tc" data-testid="ts-act-count">۰</span> : null}</button>
    </div>
    <section role="tabpanel" id="ts-p-act" aria-labelledby="ts-t-act" hidden={cur !== 'act'} data-testid="ts-panel-act">
      {fq.isLoading ? <div className="dp-skel" role="status">در حال بارگذاری تسک‌ها…</div>
        : fq.isError || !v ? <div className="dp-box err" role="alert" data-testid="ts-act-error">تسک‌ها بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void fq.refetch()}>تلاش دوباره</button></div>
        : <ActPanel v={v} onGoPot={() => setTab('pot')} />}
    </section>
    <section role="tabpanel" id="ts-p-pot" aria-labelledby="ts-t-pot" hidden={cur !== 'pot'} className="ts-pot" data-testid="ts-panel-pot">{potential}</section>
  </div>;
}

function ActPanel({ v, onGoPot }: { v: FcView; onGoPot: () => void }) {
  const qc = useQueryClient();
  const [wiz, setWiz] = useState<FcCard | null>(null);
  const [sheet, setSheet] = useState<FcCard | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3000); return () => clearTimeout(t); }, [toast]);
  const curIdx = v.cards.findIndex((c) => c.state === 'current');
  const cur = curIdx >= 0 ? v.cards[curIdx] : null;
  const remaining = v.cards.filter((c) => c.state !== 'done').length;
  const total = v.cards.length; const done = total - remaining;
  const next = cur ? v.cards.slice(curIdx + 1).find((c) => c.state === 'pending') ?? null : null;
  const saved = (nv: FcView, name: string) => { qc.setQueryData(['files-carousel', 'today'], nv); setWiz(null); setToast(`${name}: پیگیری ثبت شد`); };
  return <>
    <p className="ts-info" data-testid="ts-act-info"><FileText size={17} aria-hidden="true" /> تسک‌های مشتریانی که پرونده‌ی وام دارند فقط این‌جا می‌آیند.{!v.split?.unlocked && v.mode !== 'list' && total > 0 ? ' تا تمام نشوند، «پرونده‌های من» بسته است.' : ''}</p>
    {v.split?.unlocked && remaining > 0 ? <div className="dp-box ts-more" role="status" data-testid="ts-act-more"><AlertCircle size={17} aria-hidden="true" /> یک تسک تازه رسید. «پرونده‌های من» باز می‌ماند؛ فقط شمار بالا رفت.</div> : null}
    {total === 0 ? <div className="dp-box ts-calm" data-testid="ts-act-empty"><ClipboardList size={22} aria-hidden="true" /><div><b>امروز تسکی برای مشتریان بالفعل نیست.</b>
      <p>کارهای امروزت در «مشتریان بالقوه» است.</p><button type="button" className="btn btn-ghost" onClick={onGoPot} data-testid="ts-go-pot">برو به مشتریان بالقوه</button></div></div> : <>
      <div className="card ts-prog" data-testid="ts-prog">
        <div className="ts-prog-h"><b data-testid="ts-pos">تسک {faNum(cur ? curIdx + 1 : total)} از {faNum(total)}</b><small>از «پرونده‌های من»، به ترتیب اولویت</small></div>
        <div className="dp-bar ts-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="پیشرفت تسک‌های بالفعل"><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
        <p className="dp-sub" data-testid="ts-sub">امروز {faNum(done)} انجام شد، {faNum(remaining)} مانده.{remaining > 0 && !v.split?.unlocked && v.mode !== 'list' ? ' بعد از آخرین تسک، «پرونده‌های من» باز می‌شود.' : ''}</p>
      </div>
      {cur ? <TaskCard key={cur.fileId} c={cur} pos={curIdx + 1} total={total} onResult={() => setWiz(cur)} onFile={() => setSheet(cur)} />
        : <div className="dp-box ok ts-done" data-testid="ts-act-done"><Check size={22} aria-hidden="true" /><div><b>تسک‌های مشتریان بالفعل امروز تمام شد.</b>
          <p>«پرونده‌های من» باز است.</p><div className="ts-acts"><Link href="/loan-applications" className="btn btn-primary" data-testid="ts-go-files">برو به پرونده‌های من</Link>
          <button type="button" className="btn btn-ghost" onClick={onGoPot} data-testid="ts-go-pot">مشتریان بالقوه</button></div></div></div>}
      {next ? <p className="fc-next ts-next" data-testid="ts-next"><Lock size={13} aria-hidden="true" /> بعدی: <b>{next.customerName}</b> <span className="dp-id">#{faNum(next.customerId)}</span> · ترتیب ثابت است، فقط تسک جاری باز است</p> : null}
      <section className="card aq" aria-labelledby="ts-order-h" data-testid="ts-order">
        <h3 id="ts-order-h"><ListOrdered size={18} aria-hidden="true" /> ترتیب امروز</h3>
        <p className="dp-sub">ترتیب ثابت است: اول برگشتی‌ها، بعد امضاها (ردشده اول)، بعد وثیقه یا صف فروش، بعد پرونده‌های قدیمی.</p>
        <ol className="aq-l">{v.cards.map((c, i) => <li key={c.fileId} className={`aq-r${c.state === 'done' ? ' dn' : c.state === 'current' ? ' on' : ''}`} data-testid="ts-order-row" data-state={c.state}>
          <span className="aq-n" aria-hidden="true">{c.state === 'done' ? <Check size={16} /> : faNum(i + 1)}</span>
          <button type="button" className="aq-b" onClick={() => setSheet(c)} aria-label={`${c.customerName}، برگه‌ی پرونده`}><b>{c.customerName}</b> <span className="dp-id">#{faNum(c.customerId)}</span>{c.fc ? <CatPill c={c.fc} small /> : <span className="dp-chip">{c.groupLabel}</span>}</button>
          <span className="aq-s">{c.state === 'done' ? 'انجام شد' : c.state === 'current' ? 'جاری' : <><Lock size={16} aria-hidden="true" /><span className="sr-only">قفل</span></>}</span>
        </li>)}</ol>
      </section>
    </>}
    {wiz ? <ResultDialog c={wiz} v={v} pos={v.cards.indexOf(wiz) + 1} onClose={() => setWiz(null)} onSaved={saved} /> : null}
    {sheet ? <FileSheet c={sheet} turn={cur} unlocked={Boolean(v.split?.unlocked || v.mode === 'list')} onClose={() => setSheet(null)} /> : null}
    {toast ? <div className="fc-toast ok" role="status" data-testid="ts-toast"><Check size={15} aria-hidden="true" /><span>{toast}</span></div> : null}
  </>;
}

function reasonOf(c: FcCard): { k: string; t: string } | null {
  const f = c.fc; if (!f) return c.reason ? { k: 'دلیل', t: c.reason } : null;
  if (f.priority_category === 'returned' && f.return_note) return { k: 'یادداشت کارشناس ثبت', t: f.return_note };
  if (f.signature_reject_reason) return { k: 'دلیل رد امضا (از پرونده)', t: f.signature_reject_reason };
  if (f.pending_item) return { k: 'منتظر', t: f.pending_item };
  return c.reason ? { k: 'دلیل', t: c.reason } : null;
}
function TaskCard({ c, pos, total, onResult, onFile }: { c: FcCard; pos: number; total: number; onResult: () => void; onFile: () => void }) {
  const r = reasonOf(c);
  return <section className="card ts-card" aria-labelledby="ts-card-h" data-testid="ts-card" data-file={c.fileId}>
    <aside className="ts-hist" aria-label="سابقه‌ی پیگیری"><h4><History size={17} aria-hidden="true" /> سابقه‌ی پیگیری</h4>
      {c.lastFollowUp ? <div className="ts-he"><b>{at(c.lastFollowUp.at)}</b><p>{c.lastFollowUp.outcomeLabel ?? 'پیگیری'}</p></div> : <p className="dp-sub">هنوز پیگیری نشده.</p>}
      {c.fc?.last_activity_at ? <div className="ts-he"><b>آخرین فعالیت پرونده</b><p>{fcDay(c.fc.last_activity_at)}</p></div> : null}</aside>
    <div className="ts-main">
      <div className="ts-chips"><span className="dp-count">تسک {faNum(pos)} از {faNum(total)}</span>{c.fc ? <CatPill c={c.fc} /> : <span className="dp-chip">{c.groupLabel}</span>}</div>
      <h2 id="ts-card-h">{c.customerName} <span className="dp-id">#{faNum(c.customerId)}</span></h2>
      <p className="ts-fno" data-testid="ts-fileno">پرونده {faNum(c.fileId)}، {loanStageLabel(c.stage)}</p>
      {c.fc ? <RNote c={c.fc} /> : null}
      {r ? <div className="dp-keynote ts-reason"><small>{r.k}</small><q data-testid="ts-reason">{r.t}</q></div> : null}
      {c.ask ? <div className="dp-keynote"><small>چی بپرسم</small><q>{c.ask}</q></div> : null}
      {c.phone ? <div className="ts-ph"><small>شماره‌ی مشتری</small><CallNumber phone={c.phone} customerId={c.customerId} via="files" testId="ts-ph" /></div> : null}
      <div className="dp-actions"><button type="button" className="btn btn-primary" onClick={onResult} data-testid="ts-call"><Check size={16} aria-hidden="true" /> تماس گرفتم، ثبت نتیجه</button>
        <button type="button" className="btn btn-ghost" onClick={onFile} data-testid="ts-file"><FileText size={16} aria-hidden="true" /> پرونده</button></div>
      <p className="ts-lock"><Lock size={13} aria-hidden="true" /> با گوشی خودت شماره را بگیر، بعد «تماس گرفتم، ثبت نتیجه» را بزن. تسک بعدی تا ثبت نتیجه قفل است.</p>
    </div>
    <aside className="ts-file" aria-label="پرونده"><h4><FileText size={17} aria-hidden="true" /> پرونده</h4>
      <dl><dt>شماره‌ی پرونده</dt><dd>{faNum(c.fileId)}</dd><dt>مرحله</dt><dd>{loanStageLabel(c.stage)}</dd>
        {c.fc?.label_detail ? <><dt>وضعیت</dt><dd>{c.fc.label_detail}</dd></> : null}</dl></aside>
  </section>;
}

/** act_result: one dialog, 3-step indicator (تماس ✓, نتیجه, یادداشت و ثبت). «لغو شده» asks the reason + a confirm, like the existing card. */
function ResultDialog({ c, v, pos, onClose, onSaved }: { c: FcCard; v: FcView; pos: number; onClose: () => void; onSaved: (v: FcView, name: string) => void }) {
  const [o, setO] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLDivElement>(null); const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; first.current?.focus(); return () => prev?.focus?.(); }, []);
  const cx = o === 'cancelled'; const step = !o ? 2 : 3;
  const submit = async () => {
    if (!o) { setErr('نتیجه را انتخاب کن.'); return; }
    if (!note.trim()) { setErr(cx ? 'دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود.' : 'یادداشت یک‌خطی لازم است.'); return; }
    if (cx && !confirm) { setConfirm(true); return; }
    setBusy(true); setErr('');
    try { const r = await fcApi.followup(cx ? { fileId: c.fileId, outcome: 'cancelled', cancelReason: note.trim() } : { fileId: c.fileId, outcome: o, note: note.trim() }); onSaved(r.view, c.customerName); }
    catch (e) { setConfirm(false); setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); return; }
    if (e.key === 'Tab' && box.current) { const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea')]; if (!f.length) return;
      const a = f[0], b = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); } else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); } } };
  return <div className="ts-ov" onKeyDown={onKey} data-testid="ts-result-wrap">
    <div className="ts-dlg" role="dialog" aria-modal="true" aria-labelledby="ts-r-h" ref={box} data-testid="ts-result">
      <header><div><small>تسک {faNum(pos)} از {faNum(v.cards.length)} مشتریان بالفعل، پرونده {faNum(c.fileId)}</small><h2 id="ts-r-h">ثبت نتیجه، {c.customerName} <span className="dp-id">#{faNum(c.customerId)}</span></h2></div>
        <button type="button" ref={first} className="ts-x" onClick={onClose} disabled={busy} aria-label="بستن"><X size={20} aria-hidden="true" /></button></header>
      <div className="ts-body">
        <ol className="ts-steps" aria-label={`گام ${faNum(step)} از ۳`}>{['تماس', 'نتیجه', 'یادداشت و ثبت'].map((t, i) => <li key={t} className={i + 1 < step ? 'dn' : i + 1 === step ? 'on' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
          <span>{i + 1 < step ? <Check size={13} aria-hidden="true" /> : faNum(i + 1)}</span>{t}</li>)}</ol>
        {c.phone ? <div className="ts-ph sm"><small>شماره‌ی مشتری</small><CallNumber phone={c.phone} customerId={c.customerId} via="files" testId="ts-r-ph" /></div> : null}
        <fieldset className="ts-res"><legend>نتیجه</legend><div className="ts-rlist" role="radiogroup">{v.outcomes.map((x) => <label key={x.code} className={`ts-rr${o === x.code ? ' on' : ''}${x.code === 'cancelled' ? ' cx' : ''}`}>
          <input type="radio" name="ts-o" value={x.code} checked={o === x.code} onChange={() => { setO(x.code); setErr(''); setConfirm(false); }} data-testid={`ts-o-${x.code}`} /> {x.label}</label>)}</div></fieldset>
        {c.state === 'current' ? <div className="ts-chips"><span className="ts-turn" data-testid="ts-r-turn"><Flag size={14} aria-hidden="true" /> نوبت این پرونده‌ست</span></div> : null}
        <p className="ts-hint" role="note" data-testid="ts-r-fu"><History size={14} aria-hidden="true" /> <span>این تماس پیگیری امروز همین پرونده هم حساب می‌شود. نتیجه‌ی نهایی فقط «لغو شده» یا رفتن پرونده به مرحله‌ی بعد است؛ تماس به‌تنهایی پرونده را جلو نمی‌برد. بدون نتیجه‌ی نهایی، پرونده روی تخته «پیگیری شد، فردا» می‌شود و نوبت به پرونده‌ی بعدی می‌رسد.</span></p>
        <p className="dp-sub">«لغو شده» قدم دلیل لغو را باز می‌کند، مثل امروز.</p>
        <label className="ts-nl" htmlFor="ts-note"><b>{cx ? 'دلیل لغو' : 'یادداشت یک‌خطی'}</b></label>
        <textarea id="ts-note" className="inp" rows={2} value={note} maxLength={cx ? v.cancelReasonMax ?? 500 : v.noteMax} onChange={(e) => { setNote(e.target.value.replace(/[\r\n]/g, ' ')); setErr(''); setConfirm(false); }}
          placeholder={cx ? 'مثلاً «از بانک دیگری وام گرفت و دیگر نیاز ندارد»' : 'خلاصه‌ی تماس در یک خط'} data-testid="ts-note" />
        {confirm ? <p className="dp-box warn sm" role="alert" data-testid="ts-cx-confirm"><AlertCircle size={15} aria-hidden="true" /> <b>برگرداندن لغو فقط با ادمین است.</b> پرونده از «پرونده‌های من» و کارهای امروز بیرون می‌رود. برای لغو، دوباره دکمه را بزن.</p> : null}
        {err ? <p className="dp-err" role="alert" data-testid="ts-err">{err}</p> : null}
      </div>
      <footer><button type="button" className={`btn ${cx ? 'fc-dzf' : 'btn-primary'}`} disabled={busy || !o || !note.trim()} onClick={() => void submit()} data-testid="ts-save">
        {busy ? 'در حال ثبت…' : cx ? confirm ? 'بله، لغو شود و تسک بعدی' : 'لغو پرونده و تسک بعدی' : 'ثبت و تسک بعدی'}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} data-testid="ts-later">بعداً</button></footer>
    </div>
  </div>;
}

/** act_file / act_file_turn: the board card sheet of the same customer. Stage 1: the turn = today's current بالفعل task (the only file the
 * FILES-61 write lock lets through); stage 3 swaps in the whole-board turn. «باز کردن پرونده: مرحله» only on the turn, else the turn hint. */
function FileSheet({ c, turn, unlocked, onClose }: { c: FcCard; turn: FcCard | null; unlocked: boolean; onClose: () => void }) {
  // Stage 1: after the list opens (REL-83 (ب)) FILES-61 locks nothing, so every file opens; the chip still marks the current task's file.
  const isTurn = turn?.fileId === c.fileId; const canOpen = isTurn || unlocked;
  const col = fbColumnOf(c.stage, c.status); const ci = FB_STEPS.findIndex((s) => s.key === col);
  const box = useRef<HTMLDivElement>(null); const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; first.current?.focus(); return () => prev?.focus?.(); }, []);
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Tab' && box.current) { const f = [...box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')]; if (!f.length) return;
      const a = f[0], b = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); } else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); } } };
  const stage = loanStageLabel(c.stage);
  return <div className="ts-ov" onKeyDown={onKey} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="ts-sheet-wrap">
    <div className="ts-dlg" role="dialog" aria-modal="true" aria-labelledby="ts-s-h" ref={box} data-testid="ts-sheet" data-turn={isTurn ? '1' : '0'}>
      <header><div><small>پرونده {faNum(c.fileId)}، ستون «{fbColumnLabel(col)}»</small><h2 id="ts-s-h">{c.customerName} <span className="dp-id">#{faNum(c.customerId)}</span></h2></div>
        <button type="button" ref={first} className="ts-x" onClick={onClose} aria-label="بستن"><X size={20} aria-hidden="true" /></button></header>
      <div className="ts-body">
        <div className="ts-chips">{isTurn ? <span className="ts-turn" data-testid="ts-turn"><Flag size={14} aria-hidden="true" /> نوبت این پرونده‌ست</span>
          : unlocked ? null : <span className="ts-noturn" data-testid="ts-noturn"><Lock size={14} aria-hidden="true" /> نوبتش نیست</span>}{c.fc ? <CatPill c={c.fc} /> : null}</div>
        <ol className="ts-stepper" aria-label={`مرحله: ${fbColumnLabel(col)}`}>{FB_STEPS.map((s, i) => <li key={s.key} className={i < ci ? 'dn' : i === ci ? 'on' : ''} aria-current={i === ci ? 'step' : undefined}>
          <span>{i < ci ? <Check size={12} aria-hidden="true" /> : faNum(i + 1)}</span>{s.label}</li>)}</ol>
        {c.phone ? <div className="ts-ph sm"><small>شماره‌ی مشتری</small><CallNumber phone={c.phone} customerId={c.customerId} via="files" testId="ts-s-ph" /></div> : null}
        <dl className="ts-kv"><dt>مرحله</dt><dd>{stage}</dd><dt>آخرین فعالیت</dt><dd>{fcDay(c.fc?.last_activity_at)}</dd>
          <dt>پیگیری امروز</dt><dd data-testid="ts-s-today">{c.state === 'done' ? `امروز ثبت شد${c.lastFollowUp?.outcomeLabel ? `، ${c.lastFollowUp.outcomeLabel}` : ''}` : 'هنوز تماسی ثبت نشده'}</dd>
          <dt>آخرین پیگیری</dt><dd>{c.lastFollowUp ? `${at(c.lastFollowUp.at)}${c.lastFollowUp.outcomeLabel ? `، ${c.lastFollowUp.outcomeLabel}` : ''}` : 'هنوز پیگیری نشده'}</dd></dl>
        {canOpen ? <p className="ts-hint"><Lock size={14} aria-hidden="true" /> مرحله فقط با فرم خود پرونده جلو می‌رود؛ جابه‌جا کردن کارت روی تخته نیست.</p>
          : <p className="ts-hint" role="note" data-testid="ts-turn-hint"><Lock size={14} aria-hidden="true" /> نوبت این پرونده نیست. پرونده‌ها به ترتیب باز می‌شوند{turn ? <>؛ الان نوبت <b>{turn.customerName}</b> است.</> : '.'}</p>}
      </div>
      <footer>{canOpen ? <Link href={`/loan-applications/${c.fileId}`} className="btn btn-primary" data-testid="ts-open"><Upload size={16} aria-hidden="true" /> باز کردن پرونده: {stage}</Link>
        : <><button type="button" className="btn btn-primary" disabled aria-disabled="true" data-testid="ts-open"><Lock size={16} aria-hidden="true" /> باز کردن پرونده</button>
          <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="ts-back">برگشت به تسک</button></>}</footer>
    </div>
  </div>;
}
