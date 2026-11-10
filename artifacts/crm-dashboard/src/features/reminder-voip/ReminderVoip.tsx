/** REMINDER-VOIP v1.1 (Armita, screens/reminder-voip): «تماس» (VoIP) on each reminder of the expert's own customer, live call states,
 *  the auto-opened «تماس گرفتم، ثبت نتیجه» form after the call, and the reminder auto-marked «انجام شد» on save.
 *  Rendered only while GET /reminder-voip/meta says on (flag.reminder_voip); otherwise the pages keep their old markup.
 *  No SMS / Bale / notification is sent from here. Who may call is decided on the server (rvStart → vcStart). */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { vthOf } from '@/features/voip-task-hold/api';
import { Bell, Calendar, Check, Clock, Copy, Eye, EyeOff, Flag, Headset, Lock, Phone, Plus, Shield, User, Users, X, ArrowLeftRight } from 'lucide-react';
import type { Reminder } from '@workspace/api-client-react';
import { useVoip } from '@/components/voip/VoipProvider';
import { useVcMe, VC_ME_KEY, vcRefresh, type VcCall, type VcMe, type S132Bar } from '@/features/voip-call/api';
import { useVoipAnywhere, vcaRegister } from '@/features/voip-call/VoipAnywhere';
import { copyText, useNarrow } from '@/features/call-number/CallNumber';
import { announceCallSaved, faNum } from '@/features/call-queue/api';
import { rvApi, rvRefresh, RvError, useRvMeta, type RvItem, type RvMeta, type RvOutcome } from './api';
import './reminder-voip.css';

const TEH = 'Asia/Tehran';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TEH, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hm = (iso: string) => faNum(new Intl.DateTimeFormat('en-GB', { timeZone: TEH, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)));
// «پنجشنبه ۱۴ آبان ۱۴۰۵» (design order; Chrome's fa-IR pattern puts the year first)
const faParts = (iso: string) => Object.fromEntries(new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TEH, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  .formatToParts(new Date(iso)).map((p) => [p.type, p.value])) as Record<string, string>;
const dayFa = (iso: string) => { const p = faParts(iso); return `${p.weekday} ${p.day} ${p.month} ${p.year}`; };
const dayShort = (iso: string) => { const p = faParts(iso); return `${p.weekday} ${p.day} ${p.month}`; };
export const isTodayTeh = (iso: string | null | undefined) => Boolean(iso) && dayKey(new Date(iso!)) === dayKey(new Date());
function whenLabel(iso: string) {
  const d = new Date(iso); const today = dayKey(new Date()); const k = dayKey(d);
  const y = dayKey(new Date(Date.now() - 86_400_000)), t = dayKey(new Date(Date.now() + 86_400_000));
  const pre = k === today ? 'امروز، ' : k === y ? 'دیروز، ' : k === t ? 'فردا، ' : '';
  return `${pre}${dayShort(iso)} ساعت ${hm(iso)}`;
}
const durFa = (s: number) => { const m = Math.floor(s / 60), r = Math.max(0, Math.round(s % 60)); return m ? `${faNum(m)} دقیقه و ${faNum(r)} ثانیه` : `${faNum(r)} ثانیه`; };
const mmss = (s: number) => faNum(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const OUTS: { k: RvOutcome; l: string; ic: ReactNode }[] = [
  { k: 'answered', l: 'پاسخ داد', ic: <Check aria-hidden="true" /> },
  { k: 'no_answer', l: 'پاسخ نداد', ic: <X aria-hidden="true" /> },
  { k: 'follow_up', l: 'پیگیری بعدی', ic: <Calendar aria-hidden="true" /> },
];
const outLabel = (o: string | null | undefined) => OUTS.find((x) => x.k === o)?.l ?? 'ثبت شد';
/** Simotel's verdict (CDR) for an ended click call; null until it arrives (no guessing from the line state). */
const callStatus = (c: VcCall): 'answered' | 'no_answer' | null => {
  // before the CDR the line-state guess (no customer pickup is ever reported live) is not a verdict: show nothing rather than «جواب نداد»
  const v = c.s132?.simStatus ?? (c.cdr ? (c.prefill ?? (c.custStatus ? (c.custStatus === 'ANSWERED' ? 'answered' : 'no_answer') : null)) : null);
  return v === 'answered' ? 'answered' : v ? 'no_answer' : null;
};
// Simotel never reports the customer's pickup live (R2 VC-CDR: only the CDR decides): once the expert's phone is picked up (dial_cust) the
// card shows the in-call strip with the timer from that moment; in_call (after the CDR) is the same strip.
const barStatus = (b: S132Bar): 'answered' | 'no_answer' | null => { const v = b.simStatus ?? b.status; return v === 'answered' ? 'answered' : v ? 'no_answer' : null; };
const RING = new Set(['requesting', 'ring_me']);
const TALK = new Set(['dial_cust', 'in_call']);

/* ---- calls started from a reminder (this tab): reminderId → callId; and which ended calls already auto-opened the form ---- */
const MAP_KEY = 'rv.calls', SHOWN_KEY = 'rv.shown';
const readJ = <T,>(k: string, d: T): T => { try { return JSON.parse(sessionStorage.getItem(k) || '') as T; } catch { return d; } };
const writeJ = (k: string, v: unknown) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const localCall = (rid: number): number | null => Number(readJ<Record<string, number>>(MAP_KEY, {})[String(rid)] || 0) || null;
const setLocalCall = (rid: number, cid: number) => { const m = readJ<Record<string, number>>(MAP_KEY, {}); m[String(rid)] = cid; writeJ(MAP_KEY, m); };
const wasShown = (cid: number) => readJ<number[]>(SHOWN_KEY, []).includes(cid);
const markShown = (cid: number) => writeJ(SHOWN_KEY, [...readJ<number[]>(SHOWN_KEY, []), cid].slice(-30));

/* ---- page-level hook: meta for the shown rows + the finished-today rows to keep visible (faded) ---- */
export function useReminderVoip(open: Reminder[] | undefined, done: Reminder[] | undefined) {
  const ids = useMemo(() => [...(open ?? []), ...(done ?? [])].map((r) => r.id), [open, done]);
  const q = useRvMeta(ids);
  const meta = q.data;
  const finished = useMemo(() => (meta?.on ? (done ?? []).filter((r) => isTodayTeh(meta.items?.[String(r.id)]?.result?.savedAt)) : []), [meta, done]);
  return { on: Boolean(meta?.on), meta: meta ?? { on: false }, finished };
}

type FormState = { r: Reminder; it: RvItem | undefined; call: VcCall | null; auto: boolean };

/** Group the rows like the design: «سررسیده», «امروز، …», then one group per day. Finished-today rows stay in their group, faded. */
export function RvList({ rows, meta, onOpen, testId = 'rv-list' }: { rows: Reminder[]; meta: RvMeta; onOpen?: (id: number) => void; testId?: string }) {
  const [form, setForm] = useState<FormState | null>(null);
  const groups = useMemo(() => {
    const now = Date.now(); const today = dayKey(new Date());
    const sorted = [...rows].sort((a, b) => a.remindAt.localeCompare(b.remindAt));
    const late: Reminder[] = [], m = new Map<string, Reminder[]>();
    for (const r of sorted) {
      const k = dayKey(new Date(r.remindAt));
      if (!r.done && new Date(r.remindAt).getTime() <= now && k !== today) late.push(r); else m.set(k, [...(m.get(k) ?? []), r]);
    }
    const out: { k: string; h: string; rs: Reminder[] }[] = [];
    if (late.length) out.push({ k: 'late', h: 'سررسیده', rs: late });
    for (const [k, rs] of m) out.push({ k, h: k === today ? `امروز، ${dayFa(rs[0].remindAt)}` : dayFa(rs[0].remindAt), rs });
    return out;
  }, [rows]);
  return <div className="rv-list" data-testid={testId}>
    {groups.map((g) => <section key={g.k} className="rv-grp" aria-label={g.h}><h3 className="rv-gh">{g.h}</h3>
      {g.rs.map((r) => <RvCard key={r.id} r={r} it={meta.items?.[String(r.id)]} meta={meta} late={g.k === 'late' || (!r.done && new Date(r.remindAt).getTime() <= Date.now())}
        onForm={(f) => setForm(f)} onOpen={onOpen} />)}
    </section>)}
    {form ? <RvResultForm {...form} onClose={() => setForm(null)} /> : null}
  </div>;
}

function Num({ phone, big }: { phone: string; big?: boolean }) {
  const narrow = useNarrow(); const [ok, setOk] = useState(false);
  const f = faNum(phone);
  return <span className={`rv-ph${big ? ' big' : ''}`}>
    {narrow ? <a className="rv-phn" href={`tel:${phone}`}><bdi dir="ltr">{f}</bdi></a> : <span className="rv-phn"><bdi dir="ltr">{f}</bdi></span>}
    <button type="button" className={`rv-phc${ok ? ' done' : ''}`} aria-label={`کپی شماره‌ی ${f}`} onClick={async (e) => { e.stopPropagation(); setOk(await copyText(phone)); }}>
      {ok ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{big ? <span>{ok ? 'کپی شد' : 'کپی'}</span> : null}</button>
  </span>;
}
function Cid({ id }: { id: number }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className={`rv-cid${ok ? ' done' : ''}`} aria-label={`شناسه‌ی مشتری ${faNum(id)}، کپی`} onClick={async (e) => { e.stopPropagation(); setOk(await copyText(String(id))); }}>#{faNum(id)}</button>;
}
function useTick(on: boolean) { const [, set] = useState(0); useEffect(() => { if (!on) return; const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, [on]); }

function RvCard({ r, it, meta, late, onForm, onOpen }: { r: Reminder; it: RvItem | undefined; meta: RvMeta; late: boolean; onForm: (f: FormState) => void; onOpen?: (id: number) => void }) {
  const qc = useQueryClient();
  const me: VcMe | undefined = useVcMe().data;
  const g = useVoipAnywhere();
  const sys = useVoip();
  const [err, setErr] = useState(''); const [busyStart, setBusyStart] = useState(false); const [hangHint, setHangHint] = useState(false); const [xfer, setXfer] = useState(false);
  const kind = it?.kind ?? (r.customerId ? 'own' : 'internal');
  const result = it?.result ?? null;
  const fin = Boolean(r.done && result);
  const name = r.customerName?.trim() || 'بدون نام';
  const callId = it?.callId ?? localCall(r.id);
  const c = me?.call ?? null;
  const mine = Boolean(c && callId && c.id === callId && !fin);
  const ring = mine && RING.has(c!.state);
  const talk = mine && TALK.has(c!.state);
  const ended = mine && !ring && !talk;
  const firstCall = Boolean(mine && (c!.s132?.firstCall || it?.callFirst));
  const otherBusy = !mine && Boolean((c && (c.active || RING.has(c.state) || TALK.has(c.state) || c.needsResult || ['waiting', 'late', 'first_form'].includes(c.s132?.phase ?? ''))) || me?.s132b?.busy);
  const voipMode = Boolean(meta.voip && g.on && me?.on);
  const sysMode = !voipMode && sys.canCall && sys.connection === 'registered';
  const callable = kind === 'own' || kind === 'support_own';
  const ext = me?.extension ? faNum(me.extension) : '';
  // once Simotel's CDR is in, the s132 auto-save takes the call out of /me's `call`; its verdict stays on s132.last (same call id)
  const bar = !fin && callId && !mine && me?.s132?.last?.callId === callId ? me.s132.last : null;
  const dur = c && mine ? (c.durationSeconds ?? c.billsec ?? null) : bar ? bar.durationSeconds : null;
  const st = c && mine ? callStatus(c) : bar ? barStatus(bar) : null;
  useTick(talk);
  const talkSecs = talk && (c!.custAnsweredAt || c!.meAnsweredAt) ? Math.max(0, (Date.now() - new Date((c!.custAnsweredAt || c!.meAnsweredAt)!).getTime()) / 1000) : 0;

  // v1.1: right after the call ends, the result form opens by itself (once per call). A first call opens the first-call form instead (VoipAnywhereFirstFormHost).
  useEffect(() => {
    if (!ended || !c || firstCall || fin || wasShown(c.id)) return;
    markShown(c.id); onForm({ r, it, call: c, auto: true });
  }, [ended, c?.id, firstCall, fin]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(e: React.MouseEvent) {
    e.stopPropagation(); setErr(''); setHangHint(false);
    if (otherBusy) { setErr('یک تماس در جریان است؛ بعد از قطع آن دوباره بزن.'); return; }
    setBusyStart(true);
    try {
      const res = await rvApi.start(r.id);
      if (res.call?.id) {
        setLocalCall(r.id, res.call.id); vcaRegister(res.call.id);
        qc.setQueryData<VcMe>(VC_ME_KEY, (old) => (old ? { ...old, call: res.call } : old));
      }
      vcRefresh(qc); void qc.invalidateQueries({ queryKey: ['reminder-voip'] });
    } catch (x) { setErr(x instanceof RvError ? x.message : 'شروع تماس ناموفق بود.'); }
    finally { setBusyStart(false); }
  }
  const vBtn = (opts: { gh?: boolean; dis?: boolean } = {}) => {
    const dis = opts.dis || otherBusy;
    return <button type="button" className={`rv-btn ${opts.gh ? 'gh' : 'pri'} rv-vbtn`} aria-disabled={dis || busyStart ? true : undefined} data-testid={`rv-call-${r.id}`}
      aria-label={`تماس از تلفن ویپ با ${name}${ext ? `، داخلی ${ext}` : ''}${it?.firstCall ? '؛ تماس اول: بعد از مکالمه فرم تماس اول خودش باز می‌شود' : ''}${otherBusy ? '؛ یک تماس در جریان است' : ''}`}
      onClick={(e) => { if (opts.dis) { e.stopPropagation(); return; } void start(e); }}>
      {otherBusy && !opts.dis ? <Lock aria-hidden="true" /> : <Headset aria-hidden="true" />}تماس</button>;
  };
  const endBtn = <button type="button" className="rv-btn end rv-vbtn" aria-label={`قطع تماس با ${name}`} data-testid={`rv-end-${r.id}`} onClick={(e) => { e.stopPropagation(); setHangHint(true); }}>
    {ring ? <span className="rv-spn" aria-hidden="true" /> : <X aria-hidden="true" />}قطع</button>;
  const sysBtn = <button type="button" className="rv-btn pri" data-testid={`rv-sys-${r.id}`} onClick={(e) => { e.stopPropagation(); if (it?.phone) void sys.dial(it.phone); }}><Phone aria-hidden="true" />تماس سیستمی</button>;
  const resBtn = (pri: boolean) => <button type="button" className={`rv-btn ${pri ? 'pri' : 'gh'}`} aria-haspopup="dialog" data-testid={`rv-res-${r.id}`}
    onClick={(e) => { e.stopPropagation(); onForm({ r, it, call: ended ? c : null, auto: false }); }}><Check aria-hidden="true" />تماس گرفتم، ثبت نتیجه</button>;
  const callBtn = () => ring || talk ? endBtn : voipMode ? vBtn() : sysMode ? sysBtn : null;
  const openFile = r.customerId ? <Link href={`/customers/${r.customerId}`} className="rv-btn gh" data-testid={`rv-open-${r.id}`}><Eye aria-hidden="true" />باز کردن پرونده (نمای ثبت‌نام)</Link> : null;
  const noneMode = !voipMode && !sysMode;

  let acts: ReactNode = null;
  if (kind === 'internal') acts = null;
  else if (kind === 'other') acts = <button type="button" className="rv-btn gh" data-testid={`rv-xfer-${r.id}`} onClick={(e) => { e.stopPropagation(); setXfer((x) => !x); }}><ArrowLeftRight aria-hidden="true" />انتقال تماس به کارشناسش</button>;
  else if (kind === 'support_other') acts = openFile;
  else if (!it?.hasPhone && it) acts = r.customerId ? <Link href={`/customers/${r.customerId}`} className="rv-btn gh" data-testid={`rv-addph-${r.id}`}><Plus aria-hidden="true" />افزودن شماره</Link> : null;
  else if (fin) acts = voipMode ? vBtn({ gh: true, dis: true }) : null;
  else if (kind === 'support_own') acts = <>{callBtn()}{openFile}</>;
  else acts = <>{callBtn()}{resBtn(ended || noneMode)}</>;

  const chips = <>
    {it?.firstCall && !fin ? <span className="rv-chip g"><Flag aria-hidden="true" />تماس اول</span> : null}
    {kind === 'support_own' || kind === 'support_other' ? <span className="rv-chip b"><Shield aria-hidden="true" />پشتیبانی</span> : null}
    {kind === 'other' ? <span className="rv-chip n"><User aria-hidden="true" />مشتری کارشناس دیگر: {it?.ownerName || 'نامشخص'}</span> : null}
  </>;
  let line: ReactNode = null;
  if (kind === 'other') line = <p className="rv-l hid"><EyeOff aria-hidden="true" /><span>شماره‌ی مشتری کارشناس دیگر نشان داده نمی‌شود.</span></p>;
  else if (kind === 'support_other') line = <p className="rv-l hid"><EyeOff aria-hidden="true" /><span>شماره نشان داده نمی‌شود؛ این مشتری را خودت ثبت‌نام نکرده‌ای.</span></p>;
  else if (it && !it.hasPhone) line = <p className="rv-l nph"><Phone aria-hidden="true" /><span>شماره ثبت نشده</span></p>;
  else if (it?.phone) line = <p className="rv-l"><Num phone={it.phone} big={noneMode && !fin} /></p>;

  return <article className={`rv-card${late && !fin ? ' late' : ''}${mine ? ' sel' : ''}${fin ? ' fin' : ''}`} data-testid={`rv-card-${r.id}`} aria-label={`یادآور: ${r.subject}${r.customerId ? `، ${name}` : ''}`}>
    <div className="rv-h">
      <span className={`rv-chip ${late && !fin ? 'r' : 'n'}`}><Clock aria-hidden="true" />{late && !fin ? 'سررسیده، ' : ''}{whenLabel(r.remindAt)}</span>
      {!r.customerId ? <span className="rv-chip q"><Users aria-hidden="true" />کار داخلی</span> : null}
      {fin ? <span className="rv-chip s rv-ok"><Check aria-hidden="true" />انجام شد</span> : null}
    </div>
    {onOpen ? <button type="button" className="rv-t rv-tb" onClick={() => onOpen(r.id)} aria-haspopup="dialog">{r.subject}</button> : <p className="rv-t">{r.subject}</p>}
    {r.message && r.message !== r.subject ? <p className="rv-msg">{r.message}</p> : null}
    {r.customerId ? <div className="rv-w">
      <p className="rv-n"><b>{name}</b><Cid id={r.customerId} />{chips}</p>
      {kind === 'support_own' || kind === 'support_other' ? <p className="rv-l"><User aria-hidden="true" /><span>کارشناس: <b>{r.customerSalespersonName || 'بدون تخصیص'}</b> <small className="rv-mut">(فقط برای اطلاع)</small></span></p> : null}
      {line}
    </div> : null}
    {fin && result ? <p className="rv-res"><span className={`rv-chip ${result.outcome === 'no_answer' ? 'n' : 's'}`}>{result.outcome === 'no_answer' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}{outLabel(result.outcome)}</span>
      <span className="rv-nt">«{result.note}»</span><small>ثبت: {isTodayTeh(result.savedAt) ? 'امروز' : dayShort(result.savedAt)} ساعت {hm(result.savedAt)}</small></p> : null}
    {ring ? <p className="rv-cst ring" role="status"><Headset aria-hidden="true" /><span><b>در حال زنگ خوردن…</b><small>اول تلفن ویپ شما{ext ? ` (داخلی ${ext})` : ''} زنگ می‌خورد، بعد شماره‌ی مشتری گرفته می‌شود.</small></span></p> : null}
    {talk ? <p className="rv-cst talk" role="status"><Headset aria-hidden="true" /><span><b>{c!.state === 'in_call' ? 'در مکالمه با' : 'در تماس با'} {name}</b><small className="rv-rec">در حال ضبط</small></span><span className="rv-tmr" dir="ltr">{mmss(talkSecs)}</span></p> : null}
    {(ended || bar) && !fin ? <p className="rv-cst ok" role="status"><Check aria-hidden="true" /><span><b>تماس تمام شد{st === 'answered' ? '، جواب داد' : st === 'no_answer' ? '، جواب نداد' : ''}</b><small>{dur != null ? `${durFa(dur)}؛ ` : st ? '' : 'در انتظار نتیجه از سیموتل؛ '}هنوز چیزی ثبت نشده</small></span></p> : null}
    {hangHint && (ring || talk) ? <p className="rv-hint" role="status">برای قطع، از خود تلفن ویپ قطع کن.</p> : null}
    {xfer && kind === 'other' ? <p className="rv-hint" role="status">این مشتری با {it?.ownerName || 'کارشناس دیگر'} است{it?.ownerExt ? `؛ تماس را روی داخلی ${faNum(it.ownerExt)} بفرست` : ''}.</p> : null}
    {err ? <p className="rv-err" role="alert">{err}</p> : null}
    {acts ? <div className="rv-a">{acts}</div> : null}
  </article>;
}

/** «تماس گرفتم، ثبت نتیجه»: result (required) + one-line note (required, ≤ 80). Desktop dialog, mobile bottom sheet. Closing without save keeps the reminder open. */
function RvResultForm({ r, it, call, auto, onClose }: FormState & { onClose: () => void }) {
  const qc = useQueryClient();
  // the form may open the moment the line goes idle (before Simotel's CDR): follow the live call until its status/duration arrive
  const lme = useVcMe().data;
  const live = lme?.call;
  const cur = call && live && live.id === call.id ? live : call;
  const lbar = call && lme?.s132?.last?.callId === call.id ? lme.s132.last : null;
  const st = (lbar ? barStatus(lbar) : null) ?? (cur ? callStatus(cur) : null);
  const pre: RvOutcome | null = st === 'answered' ? 'answered' : st ? 'no_answer' : null;
  const [outcome, setOutcome] = useState<RvOutcome | null>(pre);
  const touched = useRef(false);
  useEffect(() => { if (!touched.current && pre) setOutcome(pre); }, [pre]);
  const dur = cur ? (cur.durationSeconds ?? cur.billsec ?? lbar?.durationSeconds ?? null) : null;
  const waiting = Boolean(call && (!st || dur == null));
  useEffect(() => {
    if (!waiting) return; let n = 0;
    const t = setInterval(() => { if (++n > 40) clearInterval(t); vcRefresh(qc); }, 3000);
    return () => clearInterval(t);
  }, [waiting, qc]);
  const [note, setNote] = useState(''); const [saving, setSaving] = useState(false); const [err, setErr] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const name = r.customerName?.trim() || 'بدون نام';
  const one = note.replace(/\s+/g, ' ').trim();
  const vthMe = useVcMe().data; const vthLabel = vthOf(vthMe as any)?.on && vthOf(vthMe as any)?.queue ? vthOf(vthMe as any)!.saveLabel : null;
  const ok = Boolean(outcome) && one.length > 0 && one.length <= 80;
  async function save() {
    if (!ok || saving) { if (!outcome) setErr('نتیجه‌ی تماس را انتخاب کن.'); else if (!one) { setErr('یادداشت یک‌خطی را بنویس.'); inp.current?.focus(); } return; }
    setSaving(true); setErr('');
    try {
      if (call?.id) await rvApi.result(r.id, { outcome: outcome!, note: one, callId: call.id });
      else {
        const log = await rvApi.saveCall({ customerId: r.customerId, subject: 'یادآور سررسید', customerRequest: '', expertNotes: one, outcome: outcome === 'no_answer' ? 'no_answer' : 'answered',
          call_result: outcome === 'no_answer' ? 'no_answer' : 'answered', oneLineNote: one, outOfList: true, context: 'out_of_list' });
        announceCallSaved(log.id, Number(r.customerId));
        await rvApi.result(r.id, { outcome: outcome!, note: one, callLogId: log.id });
      }
      rvRefresh(qc); vcRefresh(qc); onClose();
    } catch (x) { setErr(x instanceof RvError ? x.message : 'ثبت نشد. دوباره تلاش کن.'); }
    finally { setSaving(false); }
  }
  return <>
    <div className="rv-bd" aria-hidden="true" onClick={onClose} />
    <section className="rv-mdl" role="dialog" aria-modal="true" aria-labelledby={`rvT${r.id}`} data-testid="rv-form">
      <header className="rv-mh"><div className="rv-mt">
        {auto ? <span className="rv-chip s rv-auto" data-testid="rv-auto"><Headset aria-hidden="true" />خودکار باز شد؛ تماس تمام شد{dur != null ? `، ${durFa(dur)}` : ''}</span> : null}
        <h2 id={`rvT${r.id}`}>تماس گرفتم، ثبت نتیجه</h2>
        <p className="rv-n"><b>{name}</b>{r.customerId ? <Cid id={r.customerId} /> : null}</p>
        {it?.phone ? <p className="rv-l"><Num phone={it.phone} /></p> : null}
      </div><button type="button" className="rv-ib" aria-label="بستن" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="rv-mb">
        <div className="rv-due"><Bell aria-hidden="true" /><p><b>یادآور: {whenLabel(r.remindAt)}</b><br />{r.subject}؛ با ثبت این تماس، این یادآور «انجام شد» می‌شود.</p></div>
        <div className="rv-fld"><span className="rv-lbl" id={`rvO${r.id}`}>نتیجه‌ی تماس<span className="rv-req">*</span></span>
          <div className="rv-seg" role="radiogroup" aria-labelledby={`rvO${r.id}`} aria-required="true">
            {OUTS.map((o) => <button key={o.k} type="button" role="radio" aria-checked={outcome === o.k} className={outcome === o.k ? 'on' : ''} data-testid={`rv-out-${o.k}`} onClick={() => { touched.current = true; setOutcome(o.k); }}>{o.ic}{o.l}</button>)}
          </div></div>
        <div className="rv-fld"><div className="rv-fh"><label className="rv-lbl" htmlFor={`rvN${r.id}`}>یادداشت یک‌خطی<span className="rv-req">*</span> <small>تک‌خط، حداکثر ۸۰ نویسه</small></label>
          <span className="rv-cnt"><b>{faNum(note.length)}</b> / ۸۰</span></div>
          <input ref={inp} id={`rvN${r.id}`} className="rv-inp" maxLength={80} value={note} aria-required="true" data-testid="rv-note"
            onChange={(e) => setNote(e.target.value.replace(/[\r\n]+/g, ' ').slice(0, 80))} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} placeholder="مثلاً «مدارک را امروز عصر می‌فرستد»" /></div>
        {err ? <p className="rv-err" role="alert">{err}</p> : null}
      </div>
      <footer className="rv-mf">
        <button type="button" className="rv-btn pri" aria-disabled={!ok || saving ? true : undefined} data-testid="rv-save" onClick={() => void save()}><Check aria-hidden="true" />{saving ? 'در حال ثبت…' : (vthLabel || 'ثبت تماس همین حالا')}</button>
        <button type="button" className="rv-btn gh rv-close" data-testid="rv-cancel" onClick={onClose}>انصراف</button>
      </footer>
    </section>
  </>;
}
