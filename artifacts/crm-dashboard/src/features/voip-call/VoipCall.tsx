/** Simotel parts 1–2 UI (design simotel v1.0.2 scenes 01–17).
 *  - VoipCallBox: «تماس از تلفن ویپ» + the live call panel (ring_me countdown, dial_cust, in_call timer, ended / me_timeout / error), one call at a time.
 *  - VcHeaderBadge: header chip while a call is live, on every page.
 *  - VcCallItem / VcPlayer / CustomerCallHistory: «سابقه‌ی تماس‌ها» with recording playback (own calls + admin; server-enforced).
 *  Everything renders nothing while /voip-call/me says off (flag OFF or no extension) — those users keep today's number + «کپی». */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { AlertCircle, AlertTriangle, Check, Clock, EyeOff, Flag, Headset, History, Lock, MessageSquare, PenLine, Play, Pause, RefreshCw, Sparkles, X } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import { atText, durText, mmss } from '@/features/call-transcripts/api';
import { useS132First, useVcHistory, useVcMe, vcApi, vcAudioSrc, VcError, VC_ME_KEY, vcRefresh, type S132Bar, type S132Status, type VcCall, type VcHistItem, type VcMe } from './api';
import './voip-call.css';

const LIVE = new Set(['requesting', 'ring_me', 'dial_cust', 'in_call']);
const ms = (s: string | null) => (s ? new Date(s).getTime() : NaN);
/** 1 s ticker while `on` (countdown / talk timer); stops otherwise. */
function useTick(on: boolean) { const [, set] = useState(0); useEffect(() => { if (!on) return; const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, [on]); }
function talkSeconds(c: VcCall) { if (c.state === 'in_call' && c.custAnsweredAt) return Math.max(0, Math.floor((Date.now() - ms(c.custAnsweredAt)) / 1000)); return c.durationSeconds ?? 0; }
function ringLeft(c: VcCall, total: number) {
  if (c.state === 'requesting') return total;
  if (c.secondsLeft == null) return total;
  return c.secondsLeft;
}

const STAT: Record<string, [string, string]> = { answered: ['پاسخ داد', 's'], no_answer: ['پاسخ نداد', 'q'], busy: ['اشغال', 'g'], failed: ['ناموفق', 'r'] };
/** VNA (t757u): the customer got the «عدم پاسخ» SMS for this call. */
const NoAnsSms = ({ on }: { on?: boolean }) => (on ? <span className="vc-chip q" data-testid="vc-nosms">پیامک عدم پاسخ رفت</span> : null);
export function VcStat({ s, s132 }: { s: string | null; s132?: boolean }) { if (!s || !STAT[s]) return null; const [t0, k] = STAT[s]; const t = s132 ? S_LBL[s as S132Status] : t0;
  return <span className={`vc-chip ${k}`} data-testid="vc-stat" data-st={s}>{s === 'answered' ? <Check className="i" aria-hidden="true" /> : s === 'busy' ? <span className="dot" aria-hidden="true" /> : <X className="i" aria-hidden="true" />}{t}</span>; }

function Steps({ n, four }: { n: number; four?: boolean }) {
  return <ol className={`vc-steps${four ? ' four' : ''}`} aria-label="مراحل تماس">{(four ? ['تلفن ویپ شما', 'گرفتن مشتری', 'مکالمه', 'نتیجه از سیموتل'] : ['تلفن ویپ شما', 'گرفتن مشتری', 'مکالمه']).map((s, i) => <li key={s} className={i < n ? 'dn' : i === n ? 'on' : ''} aria-current={i === n ? 'step' : undefined}>
    <b>{i < n ? <Check className="i" aria-hidden="true" /> : faNum(i + 1)}</b>{s}</li>)}</ol>;
}

type BoxProps = { customerId: number; fileId?: number | null; customerName: string; onResult?: () => void; extra?: ReactNode; variant?: 'task' | 'customer'; onStarted?: () => void;
  /** SIMOTEL-132: «فرم تماس اول» after the customer's first VoIP call was answered (only reached while me.s132 is present). */
  onFirstForm?: (callId: number) => void;
  /** SIMOTEL-132: a call was saved by itself (the task left «کارهای امروز من»); the lists are refreshed here too. */
  onAuto?: () => void };
/** Returns null while off: callers keep their old buttons. */
export function VoipCallBox(p: BoxProps) {
  const q = useVcMe(); const me = q.data;
  const qc = useQueryClient();
  // SIMOTEL-132: a new automatic save → refresh «کارهای امروز من» / the files carousel so the next task opens by itself.
  const lastId = me?.s132?.last?.callId ?? null; const seen = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (seen.current !== undefined && lastId != null && lastId !== seen.current) {
      void qc.invalidateQueries({ queryKey: ['daily-plan'] }); void qc.invalidateQueries({ queryKey: ['files-carousel'] });
      void qc.invalidateQueries({ queryKey: ['voip-call', 'history'] }); p.onAuto?.();
    }
    seen.current = lastId;
  }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me?.on) return null;
  // SIMOTEL-132 c (item 5): the automatic-save strip now sits at the top of the page (S132TopBar), not inside the task card.
  return <VcBoxOn me={me} {...p} />;
}
/** SIMOTEL-132 c: the «ثبت خودکار» strip at the top of «کارهای امروز من», above the progress card (renders only while me.s132.last exists). */
export const S132InSplit = createContext(false);
export function S132TopBar({ split }: { split?: boolean }) {
  const inSplit = useContext(S132InSplit); // the split page shows it once, under its tabs
  const me = useVcMe().data; const last = me?.on ? me.s132?.last ?? null : null;
  return last && (split || !inSplit) ? <S132AutoBar b={last} /> : null;
}
const S132_WAIT = 120;
function VcBoxOn({ me, customerId, fileId = null, customerName, onResult, extra, variant = 'task', onStarted, onFirstForm }: BoxProps & { me: VcMe }) {
  const qc = useQueryClient();
  const s132 = Boolean(me.s132); // SIMOTEL-132 flag on for this user (absent → everything below is today's UI)
  const firstQ = useS132First(customerId, s132);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const c = me.call ?? null; const total = me.timeoutSeconds ?? 30;
  const mine = c != null && c.customerId === customerId && (fileId == null || c.fileId == null || c.fileId === fileId);
  const live = c != null && LIVE.has(c.state);
  useTick(Boolean(mine && live));
  const start = async () => {
    if (busy) return; setBusy(true); setErr('');
    try { const r = await vcApi.start({ customerId, fileId }); qc.setQueryData<VcMe>(VC_ME_KEY, (o) => ({ ...(o ?? { on: true }), on: true, call: r.call })); if (r.call?.state !== 'error') onStarted?.(); }
    catch (e) { setErr(e instanceof VcError ? e.message : 'شروع تماس ناموفق بود.'); vcRefresh(qc); }
    finally { setBusy(false); }
  };
  const sc = s132 && mine ? c?.s132 ?? null : null;
  const pick = async (st: S132Status) => {
    if (busy || !c) return; setBusy(true); setErr('');
    try { await vcApi.status(c.id, st); } catch (e) { setErr(e instanceof VcError ? e.message : 'ثبت نشد؛ دوباره بزن.'); } finally { setBusy(false); vcRefresh(qc); }
  };
  const dismiss = async () => { if (!c) return; try { await vcApi.dismiss(c.id); } catch { /* still refresh */ } vcRefresh(qc); };
  const resBtn = (pri: boolean) => onResult ? <button type="button" className={`btn ${pri ? 'btn-primary' : 'btn-ghost'}`} onClick={onResult} data-testid="ts-call"><Check size={16} aria-hidden="true" /> تماس گرفتم، ثبت نتیجه</button> : null;
  const vBtn = (label: string, icon: ReactNode, pri = true, testId = 'vc-call') => <button type="button" className={`btn ${pri ? 'btn-primary' : 'btn-ghost'} vc-btn`} onClick={() => void start()} disabled={busy} aria-busy={busy || undefined} data-testid={testId}>{icon}{busy ? 'در حال شروع…' : label}</button>;
  const lockedBtn = (hint: string) => <><button type="button" className="btn btn-ghost vc-btn" aria-disabled="true" aria-describedby="vc-hint" onClick={(e) => e.preventDefault()} data-testid="vc-call" data-locked="1"><Lock size={16} aria-hidden="true" />یک تماس در جریان است</button>
    <span className="sr-only" id="vc-hint">{hint}</span></>;
  const errLine = err ? <p className="dp-err vc-err" role="alert" data-testid="vc-err">{err}</p> : null;

  // SIMOTEL-132 B (flag.simotel132b only; `me.s132b` is absent while off): a call taken or dialed on the VoIP phone itself closes the button.
  if (me.s132b?.busy && !(c && live)) return <div className="vcx" data-testid="vc-box" data-state="b-busy">
    <div className="dp-actions vc-row">{lockedBtn('یک تماس در جریان است')}{resBtn(false)}{extra}</div>
    <p className="vc-note one" role="note" data-testid="vc-one-b"><Lock className="i" aria-hidden="true" /><span>الان روی تلفن ویپ در تماس هستی؛ بعد از قطع آن، این دکمه باز می‌شود. کپی شماره همچنان کار می‌کند.</span></p></div>;
  // Another customer's call is live, or waiting for its result → this button is closed (one call at a time).
  const oPh = s132 && c && !mine ? c.s132?.phase : undefined;
  if (c && !mine && (live || c.needsResult || oPh === 'waiting' || oPh === 'late' || oPh === 'first_form')) {
    const nm = c.customerName ?? 'مشتری دیگر';
    if (!live && oPh === 'waiting') return <div className="vcx" data-testid="vc-box" data-state="other">
      <div className="dp-actions vc-row">{lockedBtn('نتیجه‌ی تماس قبلی در راه است')}{resBtn(false)}{extra}</div>
      <p className="vc-note one" role="note" data-testid="vc-one"><Lock className="i" aria-hidden="true" /><span>نتیجه‌ی تماس با <b>{nm}</b> از سیموتل در راه است؛ چند ثانیه‌ی دیگر این دکمه باز می‌شود. کپی شماره همچنان کار می‌کند.</span></p></div>;
    return <div className="vcx" data-testid="vc-box" data-state="other">
      <div className="dp-actions vc-row">{lockedBtn('یک تماس در جریان است')}{resBtn(false)}{extra}</div>
      <p className="vc-note one" role="note" data-testid="vc-one"><Lock className="i" aria-hidden="true" /><span>{live
        ? <>هر بار فقط یک تماس. الان در تماس با <b>{nm}</b> هستی؛ بعد از قطع تماس از تلفن ویپ، این دکمه باز می‌شود. کپی شماره همچنان کار می‌کند.</>
        : <>اول نتیجه‌ی تماس با <b>{nm}</b> را ثبت کن؛ تا آن موقع تماس تازه بسته است. کپی شماره همچنان کار می‌کند.</>}</span></p></div>;
  }
  const scPending = sc && (sc.phase === 'waiting' || sc.phase === 'late' || sc.phase === 'first_form');
  if (!mine || !c || (c.state === 'ended' && !c.needsResult && c.fileId != null && !scPending)) {
    const fc1 = s132 && firstQ.data?.firstCall === true;
    return <div className="vcx" data-testid="vc-box" data-state="idle">
      <div className="dp-actions vc-row">{vBtn('تماس از تلفن ویپ', <Headset size={18} aria-hidden="true" />)}{resBtn(false)}{extra}</div>
      <p className="vc-lock vln"><Headset className="i" aria-hidden="true" /><span>اول تلفن ویپ شما زنگ می‌خورد؛ جواب بده تا شماره‌ی مشتری خودکار گرفته شود. {s132 ? <span data-testid="vc-s132-line">{fc1 ? 'تماس اول این مشتری است: بعد از مکالمه، فرم تماس اول باز می‌شود. ' : 'نتیجه‌ی تماس را خود سیموتل می‌فرستد و چیزی پرسیده نمی‌شود. '}</span> : null}خط تو: داخلی <bdi>{faNum(me.extension ?? '')}</bdi>
        <span className="vc-mo"> زدن روی شماره از سیم‌کارت گوشی خودت می‌گیرد؛ این دکمه از داخلی ویپ.</span></span></p>{errLine}</div>;
  }
  const nm = c.customerName ?? customerName;
  const st = c.state;
  if (sc && scPending) {
    const first = sc.firstCall;
    const k = sc.phase;
    const left = sc.waitSeconds ?? 0;
    // SIMOTEL-132 d (item 1): the copy reads the server's real wait (S132_WAIT_S, seconds after hang-up), never a hard-coded number.
    const tot = faNum(String(sc.waitTotalSeconds ?? 120));
    const saving = k === 'waiting' && sc.expertStatus != null;
    const t = saving ? [`ثبت وضعیت: ${S_LBL[sc.expertStatus!]}`, 'وضعیتی که زدی ذخیره شد؛ همین الان کار جاری بسته می‌شود.']
      : k === 'waiting' ? ['در انتظار نتیجه از سیموتل', 'تماس قطع شد. وضعیت و مدت تماس چند ثانیه‌ی دیگر خودش می‌رسد؛ لازم نیست چیزی بزنی.']
      : k === 'first_form' ? ['تماس اول: جواب داد', 'نتیجه از سیموتل آمد. فرم تماس اول را پر کن؛ مرحله‌ی اول از سیموتل پر شده است.']
      : ['نتیجه از سیموتل نرسید', first ? 'تماس اول این مشتری است: اگر جواب داد، فرم تماس اول باز می‌شود. اگر جواب نداد، اشغال بود یا ناموفق، فقط وضعیت ثبت می‌شود و «تماس اول» برای تماس بعدی می‌ماند.'
        : `${tot} ثانیه بعد از قطع تماس، وضعیتی نیامد. فقط بزن چه شد؛ فرمی باز نمی‌شود و اگر مکالمه ضبط شده باشد، یادداشت از خلاصه‌ی تماس خودش نوشته می‌شود.`];
    const SI: Record<S132Status, ReactNode> = { answered: <Check size={16} aria-hidden="true" />, no_answer: <X size={16} aria-hidden="true" />, busy: <span className="vc-sdot" aria-hidden="true" />, failed: <AlertCircle size={16} aria-hidden="true" /> };
    const sb = (s: S132Status, label: string, pri = false) => <button key={s} type="button" className={`btn ${pri ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => void pick(s)} data-testid={`vc-st-${s}`}>{SI[s]}{label}</button>;
    const btns = saving ? <button type="button" className="btn btn-ghost vc-btn" aria-disabled="true" onClick={(e) => e.preventDefault()} data-testid="vc-saving-btn"><Check size={16} aria-hidden="true" />{S_LBL[sc.expertStatus!]} ثبت شد</button>
      : k === 'waiting' ? <button type="button" className="btn btn-ghost vc-btn" aria-disabled="true" onClick={(e) => e.preventDefault()} data-testid="vc-wait-btn"><Lock size={16} aria-hidden="true" />در انتظار نتیجه</button>
      : k === 'first_form' ? <button type="button" className="btn btn-primary" onClick={() => onFirstForm?.(c.id)} data-testid="vc-first-form"><Flag size={16} aria-hidden="true" /> فرم تماس اول</button>
      : <>{sb('answered', first ? 'جواب داد، فرم تماس اول' : 'جواب داد', true)}{sb('no_answer', 'جواب نداد')}{sb('busy', 'اشغال')}{sb('failed', 'ناموفق')}
        {vBtn('دوباره زنگ بزن', <RefreshCw size={16} aria-hidden="true" />, false, 'vc-again')}</>;
    const lockTxt = saving ? 'وضعیت ثبت شد؛ تسک بعدی چند ثانیه‌ی دیگر خودش باز می‌شود.' : k === 'waiting' ? `نتیجه‌ی همین تماس در راه است؛ دکمه‌های دستی لازم نیست. اگر تا ${tot} ثانیه بعد از قطع نرسید${left > 0 ? ` (${faNum(String(left))} ثانیه‌ی دیگر)` : ''}، فقط چهار دکمه‌ی وضعیت می‌آید.`
      : k === 'first_form' ? 'تسک بعدی تا ثبت فرم تماس اول قفل است.'
      : first ? 'تسک بعدی تا زدن وضعیت (و با «جواب داد»، تا ثبت فرم تماس اول) قفل است.' : 'فقط یک ضربه: تسک با زدن وضعیت از «کارهای امروز من» می‌رود و تسک بعدی باز می‌شود.';
    return <div className="vcx" data-testid="vc-box" data-state={st} data-kind={`s132-${saving ? 'saving' : k}`}>
      <section className={`vc-cw ${k === 'first_form' || saving ? 'ok' : 'dial'}${k === 'late' ? ' s132l' : ''}`} aria-label="وضعیت تماس" role="status" aria-live="polite" data-testid="vc-panel">
        <Steps n={k === 'first_form' ? 4 : 3} four />
        <div className="vc-cwh"><span className="vc-cwi" aria-hidden="true">{k === 'first_form' || saving ? <Check className="i" /> : <Clock className="i" />}</span>
          <div><h3 data-testid="vc-title">{t[0]}</h3><p>{t[1]}</p></div></div>
        {k === 'waiting' && !saving ? <div className="vc-cdn"><span className="vc-bar" role="progressbar" aria-label="انتظار برای نتیجه از سیموتل" aria-valuemin={0} aria-valuemax={S132_WAIT} aria-valuenow={S132_WAIT - left}>
          <i style={{ width: `${Math.round(((S132_WAIT - left) / S132_WAIT) * 100)}%` }} /></span><span className="muted">معمولاً چند ثانیه</span></div> : null}
      </section>
      <div className="dp-actions vc-row">{btns}{extra}</div>
      <p className="vc-lock"><Lock className="i" aria-hidden="true" /><span>{lockTxt}</span></p>{errLine}
    </div>;
  }
  const kind = st === 'requesting' || st === 'ring_me' ? 'ring' : st === 'dial_cust' ? 'dial' : st === 'in_call' ? 'talk' : st === 'me_timeout' ? 'warn' : st === 'error' ? 'err'
    : c.outcome === 'answered' ? 'ok' : c.outcome === 'busy' ? 'bz' : 'na';
  const step = kind === 'ring' ? 0 : kind === 'dial' || kind === 'na' || kind === 'bz' ? 1 : kind === 'talk' ? 2 : 3;
  const left = ringLeft(c, total);
  const dur = durText(c.durationSeconds);
  const fileTxt = c.fileId != null ? `تماس خودکار به پرونده ${faNum(c.fileId)} وصل شد` : 'تماس خودکار به سابقه‌ی همین مشتری وصل شد';
  const P: Record<string, [string, string]> = {
    ring: ['تلفن ویپ شما زنگ می‌خورد، جواب بده', `بعد از جواب دادن، شماره‌ی ${nm} خودکار گرفته می‌شود.`],
    dial: ['در حال گرفتن شماره‌ی مشتری…', 'روی خط بمان؛ صدای بوق را از همان تلفن ویپ می‌شنوی.'],
    talk: [`در مکالمه با ${nm}`, 'برای پایان، قطع تماس از تلفن ویپ. این تماس ضبط می‌شود.'],
    ok: [s132 ? 'تماس تمام شد: جواب داد' : 'تماس تمام شد: پاسخ داد', `${dur ? `${dur}. ` : ''}${fileTxt}؛ ${c.recording === 'ready' ? 'فایل ضبط آماده است.' : c.recording === 'processing' ? 'فایل ضبط در حال آماده شدن است.' : 'فایل ضبط ندارد.'}`],
    na: s132 ? ['مشتری جواب نداد', `بوق خورد ولی برنداشت. با وضعیت «جواب نداد»، ${fileTxt}.`] : ['مشتری پاسخ نداد', `بوق خورد ولی برنداشت. با وضعیت «پاسخ نداد»، ${fileTxt}.`],
    bz: ['خط مشتری اشغال بود', `با وضعیت «اشغال»، ${fileTxt}.`],
    warn: ['تلفن ویپ را جواب ندادی', `${faNum(total)} ثانیه گذشت و تماس لغو شد. با مشتری تماسی گرفته نشد، پس قفل آزاد شد و ثبت نتیجه لازم نیست.`],
    err: ['تماس برقرار نشد', 'سامانه‌ی تلفن جواب نداد. دوباره امتحان کن، یا شماره را کپی کن و با گوشی خودت بگیر. قفل آزاد است.'],
  };
  const ended = kind === 'ok' || kind === 'na' || kind === 'bz';
  const btns = ended ? <>{c.needsResult ? resBtn(true) : <button type="button" className="btn btn-primary" onClick={() => void dismiss()} data-testid="vc-dismiss"><Check size={16} aria-hidden="true" /> باشه</button>}
      {vBtn('دوباره زنگ بزن', <RefreshCw size={16} aria-hidden="true" />, false, 'vc-again')}</>
    : kind === 'warn' ? <>{vBtn('دوباره زنگ بزن', <RefreshCw size={16} aria-hidden="true" />, true, 'vc-again')}{resBtn(false)}</>
    : kind === 'err' ? <>{vBtn('دوباره امتحان کن', <RefreshCw size={16} aria-hidden="true" />, true, 'vc-again')}{resBtn(false)}</>
    : lockedBtn('یک تماس در جریان است');
  const lockTxt = live ? 'تا پایان این تماس، دکمه‌ی تماس همه‌جا بسته است؛ هر بار فقط یک تماس.'
    : kind === 'warn' || kind === 'err' ? 'تماسی برقرار نشد؛ قفل آزاد است و تسک بعدی باز می‌ماند.'
    : c.needsResult ? 'تسک بعدی تا ثبت نتیجه قفل است. فرم با وضعیت همین تماس پیش‌پر می‌شود.' : 'تماس در سابقه‌ی مشتری ثبت شد.';
  return <div className="vcx" data-testid="vc-box" data-state={st} data-kind={kind}>
    <section className={`vc-cw ${kind}`} aria-label="وضعیت تماس" role="status" aria-live="polite" data-testid="vc-panel">
      {kind === 'warn' || kind === 'err' ? null : <Steps n={step} four={s132} />}
      <div className="vc-cwh"><span className="vc-cwi" aria-hidden="true">{kind === 'err' || kind === 'warn' ? <AlertTriangle className="i" /> : kind === 'ok' ? <Check className="i" /> : <Headset className="i" />}</span>
        <div><h3 data-testid="vc-title">{P[kind][0]}</h3><p>{P[kind][1]}</p>{kind === 'na' || kind === 'bz' ? <NoAnsSms on={c.noanswerSmsSent} /> : null}</div></div>
      {kind === 'ring' ? <div className="vc-cdn"><span className="vc-bar" role="progressbar" aria-label="زمان جواب دادن" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left} aria-valuetext={`${faNum(left)} ثانیه مانده`}>
        <i style={{ width: `${Math.round((left / total) * 100)}%` }} /></span><span className="muted" data-testid="vc-left">{faNum(left)} ثانیه مانده</span></div> : null}
      {kind === 'talk' ? <p className="vc-tmr"><span dir="ltr" data-testid="vc-timer" aria-label="زمان مکالمه">{mmss(talkSeconds(c))}</span><span className="vc-recdot">در حال ضبط</span></p> : null}
    </section>
    <div className="dp-actions vc-row">{btns}{extra}</div>
    <p className="vc-lock">{live || c.needsResult ? <Lock className="i" aria-hidden="true" /> : <Check className="i" aria-hidden="true" />}<span>{lockTxt}</span></p>{errLine}
  </div>;
}

/** Header chip, visible on every page while a call is live (design: «نشان سربرگ فقط در تماس زنده»). */
export function VcHeaderBadge() {
  const me = useVcMe().data; const c = me?.on ? me.call : null;
  useTick(Boolean(c && c.state === 'in_call'));
  // SIMOTEL-132 c: body[data-s132] scopes the mobile badge / bottom-bar fixes to flag-on users only.
  const on132 = Boolean(me?.on && me.s132);
  useEffect(() => { if (!on132) return; document.body.dataset.s132 = '1'; return () => { delete document.body.dataset.s132; }; }, [on132]);
  if (on132 && c && !LIVE.has(c.state) && c.s132?.phase === 'waiting' && c.s132.expertStatus == null) {
    return <span className="vc-hb dial s132w" role="status" aria-label="در انتظار نتیجه از سیموتل" data-testid="vc-badge-s132"><Headset className="i" aria-hidden="true" /><i className="vc-hb-dot" aria-hidden="true" /><span><b className="vc-hb-l">در انتظار نتیجه از سیموتل</b><b className="vc-hb-s" aria-hidden="true">نتیجه…</b>{c.customerName ? <small>{c.customerName}</small> : null}</span></span>;
  }
  if (!c || !LIVE.has(c.state)) return null;
  const t = c.state === 'in_call' ? `در مکالمه ${mmss(talkSeconds(c))}` : c.state === 'dial_cust' ? 'در حال گرفتن مشتری' : 'تلفن ویپ شما زنگ می‌خورد';
  const k = c.state === 'in_call' ? 'talk' : c.state === 'dial_cust' ? 'dial' : 'ring';
  // narrow screens: the short label keeps the page title visible (icon + timer / one word); the full text stays for screen readers
  const sh = c.state === 'in_call' ? mmss(talkSeconds(c)) : c.state === 'dial_cust' ? 'گرفتن…' : 'زنگ…';
  return <span className={`vc-hb ${k}`} role="status" aria-label={t} data-testid="vc-badge"><Headset className="i" aria-hidden="true" /><span><b className="vc-hb-l">{t}</b><b className="vc-hb-s" aria-hidden="true">{sh}</b>{c.customerName ? <small>{c.customerName}</small> : null}</span></span>;
}

const SPEEDS = [1, 1.25, 1.5, 2];
export function VcPlayer({ eventId, seconds }: { eventId: number; seconds: number | null }) {
  const a = useRef<HTMLAudioElement | null>(null);
  const [t, setT] = useState(0); const [d, setD] = useState(seconds ?? 0); const [on, setOn] = useState(false); const [sp, setSp] = useState(0); const [bad, setBad] = useState(false);
  const seek = (s: number) => { const x = a.current; if (!x) return; x.currentTime = s; setT(s); };
  return <div className={`vc-rp${on ? ' on' : ''}`} data-testid="vc-player">
    <audio ref={a} src={vcAudioSrc(eventId)} preload="none" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setD(e.currentTarget.duration)}
      onPlay={() => { setOn(true); setBad(false); }} onPause={() => setOn(false)} onEnded={() => setOn(false)} onError={() => { setOn(false); setBad(true); }} />
    <button className="vc-rpb" type="button" aria-pressed={on} aria-label={`${on ? 'توقف' : 'پخش'} فایل ضبط، ${mmss(d)}`} data-testid="vc-play"
      onClick={() => { const x = a.current; if (!x) return; if (x.paused) void x.play().catch(() => setBad(true)); else x.pause(); }}>{on ? <Pause className="i" /> : <Play className="i" />}</button>
    <span className="vc-rpw"><span className="vc-rpbar" role="slider" tabIndex={0} aria-label="جای پخش" aria-valuemin={0} aria-valuemax={Math.round(d)} aria-valuenow={Math.round(t)} aria-valuetext={`${mmss(t)} از ${mmss(d)}`}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (d) seek(((r.right - e.clientX) / r.width) * d); }}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') seek(Math.min(d, t + 5)); if (e.key === 'ArrowRight') seek(Math.max(0, t - 5)); }}>
      <i style={{ width: `${d ? Math.min(100, (t / d) * 100) : 0}%` }} /></span>
      <span className="vc-rpn"><bdi>{mmss(t)}</bdi> از <bdi>{mmss(d)}</bdi></span></span>
    <button className="vc-rps" type="button" aria-label={`سرعت پخش، ${faNum(SPEEDS[sp])} برابر`} onClick={() => { const n = (sp + 1) % SPEEDS.length; setSp(n); if (a.current) a.current.playbackRate = SPEEDS[n]; }}>{faNum(SPEEDS[sp])}x</button>
    {bad ? <span className="vc-rperr" role="status" data-testid="vc-audio-error">پخش فایل ضبط الان ممکن نیست. کمی بعد دوباره امتحان کن.</span> : null}
  </div>;
}

function Rec({ i }: { i: Pick<VcHistItem, 'kind' | 'recording' | 'playable' | 'eventId' | 'durationSeconds' | 'status'> }) {
  if (i.recording === 'processing') return <div className="vc-rp proc" role="status" data-testid="vc-rec-proc"><span className="vc-rpb" aria-hidden="true"><Clock className="i" /></span>
    <span className="vc-rpt"><b>فایل ضبط در حال آماده شدن است</b><small>معمولاً چند دقیقه؛ خودش همین‌جا پخش‌شدنی می‌شود.</small></span></div>;
  if (i.recording === 'ready' && i.playable && i.eventId != null) return <VcPlayer eventId={i.eventId} seconds={i.durationSeconds} />;
  if (i.recording === 'ready') return <p className="vc-rp none"><Lock className="i" aria-hidden="true" /><span>فایل ضبط فقط برای کارشناس همین تماس و مدیر پخش می‌شود.</span></p>;
  if (i.kind === 'manual') return <p className="vc-rp none"><EyeOff className="i" aria-hidden="true" /><span>ثبت دستی پیش از سیموتل؛ مدت و فایل ضبط ندارد.</span></p>;
  return <p className="vc-rp none"><EyeOff className="i" aria-hidden="true" /><span>فایل ضبط ندارد؛ مکالمه‌ای برقرار نشد.</span></p>;
}
export function VcCallItem({ i, fresh, s132 }: { i: VcHistItem; fresh?: boolean; s132?: boolean }) {
  const dur = durText(i.durationSeconds);
  const src = i.kind === 'voip' ? `تماس از تلفن ویپ، ${i.expert ?? 'کارشناس'}، ${i.fileId != null ? `خودکار به پرونده ${faNum(i.fileId)} وصل شد` : 'خودکار به سابقه‌ی مشتری وصل شد'}`
    : i.kind === 'simotel' ? `تماس ${i.direction === 'incoming' ? 'ورودی' : 'خروجی'} سیموتل، ${i.expert ?? 'کارشناس'}` : `ثبت دستی، ${i.expert ?? 'کارشناس'} (با گوشی خودش)`;
  return <li className={`vc-ci${fresh ? ' fresh' : ''}`} data-testid="vc-item" data-kind={i.kind}>
    <div className="vc-cih"><span className="vc-cic" aria-hidden="true">{i.kind === 'manual' ? <PenLine className="i" /> : <Headset className="i" />}</span>
      <b>{atText(i.at)}</b>{i.s132?.fixed ? <S132Pair sim={i.s132.sim} expert={i.s132.fixed} /> : <VcStat s={i.s132?.auto ? (i.s132.expert ?? i.s132.sim) : i.status} s132={s132 || i.s132 != null} />}<NoAnsSms on={i.noanswerSms} />{dur ? <span className="vc-cid"><Clock className="i" aria-hidden="true" />{dur}</span> : null}</div>
    <p className="vc-cis">{src}</p>
    <Rec i={i} />
    {i.result ? <p className="vc-cir"><span className="muted">نتیجه:</span> {i.result.label ? i.result.label : ''}{i.result.label && i.result.note ? '؛ ' : ''}{i.result.note ? `«${i.result.note}»` : ''}</p>
      : i.pending ? <p className="vc-cir wait"><Lock className="i" aria-hidden="true" /><span>نتیجه هنوز ثبت نشده</span></p> : null}
  </li>;
}
/** The live/ended click call as a history row (task card «سابقه‌ی پیگیری» and the result form). */
export function vcCallAsItem(c: VcCall, expert: string | null): VcHistItem {
  return { kind: 'voip', id: `k${c.id}`, at: c.createdAt, status: c.outcome, durationSeconds: c.durationSeconds, expert, fileId: c.fileId, recording: c.recording,
    playable: c.recording === 'ready' && c.eventId != null, eventId: c.eventId, result: null, pending: c.needsResult, noanswerSms: c.noanswerSmsSent };
}

/** Customer page «سابقه‌ی تماس‌ها» (scene 16/17). */
export function CustomerCallHistory({ customerId }: { customerId: number }) {
  const me = useVcMe().data; const on = Boolean(me?.on);
  const h = useVcHistory(customerId, on);
  const live = me?.call && me.call.customerId === customerId ? me.call.state : null;
  const qc = useQueryClient();
  useEffect(() => { if (live === 'ended') void qc.invalidateQueries({ queryKey: ['voip-call', 'history', customerId] }); }, [live, customerId, qc]);
  if (!on) return null;
  const items = h.data?.items ?? [];
  return <section className="vcx vc-hist card" aria-labelledby="vc-hist-h" data-testid="vc-history">
    <div className="vc-hh"><h3 id="vc-hist-h"><History className="i" aria-hidden="true" /> سابقه‌ی تماس‌ها</h3>{h.data ? <span className="muted">{faNum(items.length)} تماس</span> : null}</div>
    <p className="muted vc-hn">تماس‌های تلفن ویپ خودشان این‌جا می‌آیند: وضعیت، مدت و فایل ضبط. ثبت‌های دستی قدیمی هم می‌مانند.</p>
    {h.isLoading ? <div className="dp-skel" role="status">در حال بارگذاری…</div> : h.isError ? <p className="dp-err" role="alert">سابقه بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void h.refetch()}>تلاش دوباره</button></p>
      : items.length ? <ol className="vc-cil">{items.map((i) => <VcCallItem key={i.id} i={i} s132={Boolean(me?.s132)} />)}</ol> : <p className="muted">هنوز تماسی ثبت نشده.</p>}
  </section>;
}

export function useMyName(): string | null {
  const { data } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const u = data?.user as { fullName?: string | null; username?: string | null } | undefined; return u?.fullName || u?.username || null;
}
/** The click call this file's result form should attach to (ended, linked to this file, result not saved yet). */
export function useVcForFile(fileId: number): VcCall | null {
  const me = useVcMe().data; const c = me?.on ? me.call ?? null : null;
  return c && c.fileId === fileId && c.needsResult ? c : null;
}

/* ---------------- SIMOTEL-132 (flag.simotel132 only; nothing below renders while me.s132 is absent) ---------------- */
const S_LBL: Record<S132Status, string> = { answered: 'جواب داد', no_answer: 'جواب نداد', busy: 'اشغال', failed: 'ناموفق' };
const tday = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);
const dayWord = (iso: string) => { const d = new Date(iso); const n = new Date(); const t = tday(d);
  if (t === tday(n)) return 'امروز'; if (t === tday(new Date(n.getTime() + 864e5))) return 'فردا';
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(d); };
const hhmm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
/** «اشتباهه؟» keeps both: «سیموتل: X» / «کارشناس: Y». */
function S132Pair({ sim, expert }: { sim: S132Status | null; expert: S132Status }) {
  return <span className="vc-fxs" data-testid="vc-fix-pair">{sim ? <span className="vc-chip q" data-testid="vc-fix-sim">سیموتل: {S_LBL[sim]}</span> : null}<span className="vc-chip b" data-testid="vc-fix-expert">کارشناس: {S_LBL[expert]}</span></span>;
}
export function S132AutoBar({ b }: { b: S132Bar }) {
  const qc = useQueryClient();
  const [fix, setFix] = useState(false); const [edit, setEdit] = useState(false); const [txt, setTxt] = useState(b.note); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { if (!edit) setTxt(b.note); }, [b.note, edit]);
  const st = b.status ?? 'failed'; const ok = st === 'answered';
  const nm = b.customerName ?? 'مشتری';
  const run = async (f: () => Promise<unknown>, after?: () => void) => {
    if (busy) return; setBusy(true); setErr('');
    try { await f(); after?.(); } catch (e) { setErr(e instanceof VcError ? e.message : 'ثبت نشد؛ دوباره امتحان کن.'); } finally { setBusy(false); vcRefresh(qc); }
  };
  const why = st === 'no_answer' ? 'بوق خورد و برنداشت.' : st === 'busy' ? 'خط مشتری اشغال بود.' : st === 'failed' ? 'شماره در دسترس نبود یا شبکه وصل نکرد.' : '';
  // SIMOTEL-132 c (item 9): «ثبت خودکار» only when Simotel decided; a status the expert picked reads «ثبت شد … با انتخاب تو».
  const mine = b.source === 'expert';
  const src = mine ? 'با انتخاب تو' : 'از سیموتل';
  // item 8: the next step comes from the call summary; without one the board's rule decides.
  // SIMOTEL-132 d (item 5): without a summary next step, state the board rule's actual result (reminder time / «فردا» for a file).
  const bn = b.boardNext;
  const nextTxt = b.nextStep ? ` قدم بعد از خلاصه: ${b.nextStep.replace(/[.。]\s*$/, '')}.`
    : bn?.kind === 'reminder' && bn.at ? ` قدم بعد: ${dayWord(bn.at)} ${hhmm(bn.at)}، طبق قاعده‌ی تخته (یادآور همین مشتری).`
    : bn?.kind === 'file' ? ' قدم بعد: فردا، پرونده سر نوبت خودش در ترتیب برمی‌گردد («پیگیری شد، فردا»)، طبق قاعده‌ی تخته.'
    : bn?.kind === 'none' ? ' قدم بعد: زمان تازه‌ای گذاشته نشد (یادآور باز ندارد)، طبق قاعده‌ی تخته.' : ' قدم بعد: پیگیری طبق قاعده‌ی تخته.';
  const sub = ok ? `${src}، امروز ${hhmm(b.at)}. چیزی پرسیده نشد: فایل ضبط و متن مکالمه ذخیره می‌شود و تسک خودکار از «کارهای امروز من» رفت.${nextTxt}`
    : `${src}، امروز ${hhmm(b.at)}. ${why} تسک بعدی باز شد.`;
  const smsT = b.smsAt ? hhmm(b.smsAt) : '';
  const dur = durText(b.durationSeconds);
  const note = edit ? <div className="vc-anb ed" data-testid="vc-note-edit">
      <label className="sr-only" htmlFor={`vc-note-${b.callId}`}>یادداشت تماس</label>
      <textarea id={`vc-note-${b.callId}`} className="vc-nta" value={txt} maxLength={500} rows={3} onChange={(e) => setTxt(e.target.value)} autoFocus data-testid="vc-note-input" />
      <div className="vc-anb-a"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => void run(() => vcApi.note(b.callId, txt.trim()), () => setEdit(false))} data-testid="vc-note-save">ذخیره</button>
        <button type="button" className="btn btn-ghost sm" disabled={busy} onClick={() => { setEdit(false); setTxt(b.note); }}>انصراف</button></div></div>
    : b.noteState === 'pending' && !b.noteEdited ? <div className="vc-anb wait" data-testid="vc-note-pending"><p className="vc-anb-h"><span className="vc-chip q"><Clock className="i" aria-hidden="true" />در حال نوشتن خلاصه</span></p>
      <p className="vc-anb-t muted">یادداشت از خلاصه‌ی تماس خودش نوشته می‌شود؛ لازم نیست منتظر بمانی.</p></div>
    : b.note ? <div className="vc-anb" data-testid="vc-note-ready"><p className="vc-anb-h"><span className="vc-chip b">{b.noteEdited ? <PenLine className="i" aria-hidden="true" /> : <Sparkles className="i" aria-hidden="true" />}{b.noteEdited ? 'یادداشت تو' : 'یادداشت از خلاصه‌ی تماس'}</span>
        <button type="button" className="btn btn-ghost sm" onClick={() => setEdit(true)} data-testid="vc-note-editbtn"><PenLine size={14} aria-hidden="true" /> ویرایش</button></p><p className="vc-anb-t">{b.note}</p></div>
    : ok ? <div className="vc-anb fail" data-testid="vc-note-none"><p className="vc-anb-h"><span className="vc-chip q">خلاصه ساخته نشد</span><button type="button" className="btn btn-ghost sm" onClick={() => setEdit(true)} data-testid="vc-note-editbtn"><PenLine size={14} aria-hidden="true" /> نوشتن یادداشت</button></p>
      <p className="vc-anb-t muted">فایل ضبط هست. یادداشت را خودت بنویس.</p></div> : null;
  return <section className={`vcx vc-adn card ${ok ? 'ok' : st === 'failed' ? 'fl' : 'bz'}`} aria-label="ثبت خودکار از سیموتل" data-testid="vc-auto-bar" data-st={st}>
    <span className="vc-ad-ic" aria-hidden="true">{ok ? <Check className="i" /> : <Headset className="i" />}</span>
    <div className="vc-ad-b">
      <p className="vc-ad-t"><b data-testid="vc-auto-title">{mine ? 'ثبت شد' : 'ثبت خودکار'}: {nm}</b><span className="dp-id">#{faNum(b.customerId)}</span>
        {b.fixedStatus ? <S132Pair sim={b.simStatus} expert={b.fixedStatus} /> : <VcStat s={st} s132 />}
        {ok && dur ? <span className="vc-cid"><Clock className="i" aria-hidden="true" />{dur}</span> : null}
        {b.smsSent || b.smsAt ? <span className="vc-chip q" data-testid="vc-nosms"><MessageSquare className="i" aria-hidden="true" />پیامک عدم پاسخ رفت{smsT ? `، ساعت ${smsT}` : ''}</span> : null}
        {b.canFix && !b.fixedStatus ? <button type="button" className="vc-fx" onClick={() => setFix(true)} data-testid="vc-fix-open">اشتباهه؟</button> : null}</p>
      <p className="vc-ad-s" data-testid="vc-auto-sub">{sub}</p>
      {note}
      {err ? <p className="dp-err vc-err" role="alert">{err}</p> : null}
    </div>
    {!ok && !edit && !b.note ? <button type="button" className="btn btn-ghost sm vc-ad-add" onClick={() => setEdit(true)} data-testid="vc-note-add"><PenLine size={14} aria-hidden="true" /> افزودن یادداشت</button> : null}
    {fix ? <S132FixSheet b={b} busy={busy} onClose={() => setFix(false)} onSave={(v) => void run(() => vcApi.fix(b.callId, v), () => setFix(false))} /> : null}
  </section>;
}
function S132FixSheet({ b, busy, onClose, onSave }: { b: S132Bar; busy: boolean; onClose: () => void; onSave: (s: S132Status) => void }) {
  const sim = b.simStatus ?? b.status ?? 'failed';
  // item 2 / Q15: when Simotel said «جواب داد», «جواب داد» starts selected.
  const [v, setV] = useState<S132Status | null>(sim === 'answered' ? 'answered' : null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const nm = b.customerName ?? 'مشتری';
  return <div className="vc-shx" dir="rtl">
    <div className="vc-shs" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="vc-sh s132c" role="dialog" aria-modal="true" aria-labelledby="vc-fix-t" tabIndex={-1} data-testid="vc-fix-sheet" data-nodnd="">
      <button type="button" className="vc-sh-x" aria-label="بستن" onClick={onClose} data-testid="vc-fix-x"><X className="i" /></button>
      <div className="vc-sh-hd" data-testid="vc-fix-hd"><p className="muted vc-sh-e">تماس امروز {hhmm(b.at)} از تلفن ویپ</p>
      <h3 id="vc-fix-t">اصلاح وضعیت، {nm} <span className="dp-id" data-testid="vc-fix-id">#{faNum(b.customerId)}</span></h3></div>
      <p className="vc-fx-s">سیموتل ثبت کرد: <VcStat s={sim} s132 /></p>
      <fieldset className="vc-fxg"><legend>وضعیت درست</legend>
        <div role="radiogroup" aria-labelledby="vc-fix-t" className="vc-fxo pills">{(['answered', 'no_answer', 'busy', 'failed'] as S132Status[]).map((s) => <button key={s} type="button" role="radio" aria-checked={v === s} className={`vc-fxp ${s}${v === s ? ' on' : ''}`}
          onClick={() => setV(s)} data-testid={`vc-fix-${s}`}><span className="vc-fxl">{S_LBL[s]}</span>{s === sim ? <small>سیموتل</small> : null}</button>)}</div></fieldset>
      <p className="muted vc-sh-h">هر دو در سابقه می‌ماند: «سیموتل: {S_LBL[sim]}» و «کارشناس: {v ? S_LBL[v] : '…'}». با هر گزینه، از جمله «جواب داد»، فقط وضعیت عوض می‌شود و فرمی باز نمی‌شود.</p>
      {b.smsSent || b.smsAt ? <><p className="vc-sh-h"><span className="vc-chip q" data-testid="vc-fix-sms"><MessageSquare className="i" aria-hidden="true" />پیامک عدم پاسخ رفت{b.smsAt ? `، ساعت ${hhmm(b.smsAt)}` : ''}</span></p>
        <p className="muted vc-sh-h">پیامکی که رفته پس گرفته نمی‌شود؛ چیپش در سابقه می‌ماند.</p></> : null}
      <p className="vc-sh-lk" data-testid="vc-fix-lock"><Lock className="i" aria-hidden="true" /><span><b>نوبت عقب نمی‌رود:</b> تسک جاری همان می‌ماند و نتیجه فقط به سابقه‌ی {nm} اضافه می‌شود.</span></p>
      <div className="vc-sh-a"><button type="button" className="btn btn-primary" disabled={busy || !v || v === sim} onClick={() => v && onSave(v)} data-testid="vc-fix-save"><Check size={16} aria-hidden="true" /> ذخیره</button>
        <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="vc-fix-cancel">انصراف</button></div>
    </div>
  </div>;
}
