/** Simotel parts 1–2 UI (design simotel v1.0.2 scenes 01–17).
 *  - VoipCallBox: «تماس از تلفن ویپ» + the live call panel (ring_me countdown, dial_cust, in_call timer, ended / me_timeout / error), one call at a time.
 *  - VcHeaderBadge: header chip while a call is live, on every page.
 *  - VcCallItem / VcPlayer / CustomerCallHistory: «سابقه‌ی تماس‌ها» with recording playback (own calls + admin; server-enforced).
 *  Everything renders nothing while /voip-call/me says off (flag OFF or no extension) — those users keep today's number + «کپی». */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { AlertTriangle, Check, Clock, EyeOff, Headset, History, Lock, PenLine, Play, Pause, RefreshCw, X } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import { atText, durText, mmss } from '@/features/call-transcripts/api';
import { useVcHistory, useVcMe, vcApi, vcAudioSrc, VcError, VC_ME_KEY, vcRefresh, type VcCall, type VcHistItem, type VcMe } from './api';
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

const STAT: Record<string, [string, string]> = { answered: ['پاسخ داد', 's'], no_answer: ['پاسخ نداد', 'q'], busy: ['اشغال', 'g'] };
export function VcStat({ s }: { s: string | null }) { if (!s || !STAT[s]) return null; const [t, k] = STAT[s];
  return <span className={`vc-chip ${k}`} data-testid="vc-stat" data-st={s}>{s === 'answered' ? <Check className="i" aria-hidden="true" /> : s === 'busy' ? <span className="dot" aria-hidden="true" /> : <X className="i" aria-hidden="true" />}{t}</span>; }

function Steps({ n }: { n: number }) {
  return <ol className="vc-steps" aria-label="مراحل تماس">{['تلفن ویپ شما', 'گرفتن مشتری', 'مکالمه'].map((s, i) => <li key={s} className={i < n ? 'dn' : i === n ? 'on' : ''} aria-current={i === n ? 'step' : undefined}>
    <b>{i < n ? <Check className="i" aria-hidden="true" /> : faNum(i + 1)}</b>{s}</li>)}</ol>;
}

type BoxProps = { customerId: number; fileId?: number | null; customerName: string; onResult?: () => void; extra?: ReactNode; variant?: 'task' | 'customer'; onStarted?: () => void };
/** Returns null while off: callers keep their old buttons. */
export function VoipCallBox(p: BoxProps) {
  const q = useVcMe(); const me = q.data;
  if (!me?.on) return null;
  return <VcBoxOn me={me} {...p} />;
}
function VcBoxOn({ me, customerId, fileId = null, customerName, onResult, extra, variant = 'task', onStarted }: BoxProps & { me: VcMe }) {
  const qc = useQueryClient();
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
  const dismiss = async () => { if (!c) return; try { await vcApi.dismiss(c.id); } catch { /* still refresh */ } vcRefresh(qc); };
  const resBtn = (pri: boolean) => onResult ? <button type="button" className={`btn ${pri ? 'btn-primary' : 'btn-ghost'}`} onClick={onResult} data-testid="ts-call"><Check size={16} aria-hidden="true" /> تماس گرفتم، ثبت نتیجه</button> : null;
  const vBtn = (label: string, icon: ReactNode, pri = true, testId = 'vc-call') => <button type="button" className={`btn ${pri ? 'btn-primary' : 'btn-ghost'} vc-btn`} onClick={() => void start()} disabled={busy} aria-busy={busy || undefined} data-testid={testId}>{icon}{busy ? 'در حال شروع…' : label}</button>;
  const lockedBtn = (hint: string) => <><button type="button" className="btn btn-ghost vc-btn" aria-disabled="true" aria-describedby="vc-hint" onClick={(e) => e.preventDefault()} data-testid="vc-call" data-locked="1"><Lock size={16} aria-hidden="true" />یک تماس در جریان است</button>
    <span className="sr-only" id="vc-hint">{hint}</span></>;
  const errLine = err ? <p className="dp-err vc-err" role="alert" data-testid="vc-err">{err}</p> : null;

  // Another customer's call is live, or waiting for its result → this button is closed (one call at a time).
  if (c && !mine && (live || c.needsResult)) {
    const nm = c.customerName ?? 'مشتری دیگر';
    return <div className="vcx" data-testid="vc-box" data-state="other">
      <div className="dp-actions vc-row">{lockedBtn('یک تماس در جریان است')}{resBtn(false)}{extra}</div>
      <p className="vc-note one" role="note" data-testid="vc-one"><Lock className="i" aria-hidden="true" /><span>{live
        ? <>هر بار فقط یک تماس. الان در تماس با <b>{nm}</b> هستی؛ بعد از قطع تماس از تلفن ویپ، این دکمه باز می‌شود. کپی شماره همچنان کار می‌کند.</>
        : <>اول نتیجه‌ی تماس با <b>{nm}</b> را ثبت کن؛ تا آن موقع تماس تازه بسته است. کپی شماره همچنان کار می‌کند.</>}</span></p></div>;
  }
  if (!mine || !c || (c.state === 'ended' && !c.needsResult && c.fileId != null)) {
    return <div className="vcx" data-testid="vc-box" data-state="idle">
      <div className="dp-actions vc-row">{vBtn('تماس از تلفن ویپ', <Headset size={18} aria-hidden="true" />)}{resBtn(false)}{extra}</div>
      <p className="vc-lock vln"><Headset className="i" aria-hidden="true" /><span>اول تلفن ویپ شما زنگ می‌خورد؛ جواب بده تا شماره‌ی مشتری خودکار گرفته شود. خط تو: داخلی <bdi>{faNum(me.extension ?? '')}</bdi>
        <span className="vc-mo"> زدن روی شماره از سیم‌کارت گوشی خودت می‌گیرد؛ این دکمه از داخلی ویپ.</span></span></p>{errLine}</div>;
  }
  const nm = c.customerName ?? customerName;
  const st = c.state;
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
    ok: ['تماس تمام شد: پاسخ داد', `${dur ? `${dur}. ` : ''}${fileTxt}؛ ${c.recording === 'ready' ? 'فایل ضبط آماده است.' : c.recording === 'processing' ? 'فایل ضبط در حال آماده شدن است.' : 'فایل ضبط ندارد.'}`],
    na: ['مشتری پاسخ نداد', `بوق خورد ولی برنداشت. با وضعیت «پاسخ نداد»، ${fileTxt}.`],
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
      {kind === 'warn' || kind === 'err' ? null : <Steps n={step} />}
      <div className="vc-cwh"><span className="vc-cwi" aria-hidden="true">{kind === 'err' || kind === 'warn' ? <AlertTriangle className="i" /> : kind === 'ok' ? <Check className="i" /> : <Headset className="i" />}</span>
        <div><h3 data-testid="vc-title">{P[kind][0]}</h3><p>{P[kind][1]}</p></div></div>
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
export function VcCallItem({ i, fresh }: { i: VcHistItem; fresh?: boolean }) {
  const dur = durText(i.durationSeconds);
  const src = i.kind === 'voip' ? `تماس از تلفن ویپ، ${i.expert ?? 'کارشناس'}، ${i.fileId != null ? `خودکار به پرونده ${faNum(i.fileId)} وصل شد` : 'خودکار به سابقه‌ی مشتری وصل شد'}`
    : i.kind === 'simotel' ? `تماس ${i.direction === 'incoming' ? 'ورودی' : 'خروجی'} سیموتل، ${i.expert ?? 'کارشناس'}` : `ثبت دستی، ${i.expert ?? 'کارشناس'} (با گوشی خودش)`;
  return <li className={`vc-ci${fresh ? ' fresh' : ''}`} data-testid="vc-item" data-kind={i.kind}>
    <div className="vc-cih"><span className="vc-cic" aria-hidden="true">{i.kind === 'manual' ? <PenLine className="i" /> : <Headset className="i" />}</span>
      <b>{atText(i.at)}</b><VcStat s={i.status} />{dur ? <span className="vc-cid"><Clock className="i" aria-hidden="true" />{dur}</span> : null}</div>
    <p className="vc-cis">{src}</p>
    <Rec i={i} />
    {i.result ? <p className="vc-cir"><span className="muted">نتیجه:</span> {i.result.label ? i.result.label : ''}{i.result.label && i.result.note ? '؛ ' : ''}{i.result.note ? `«${i.result.note}»` : ''}</p>
      : i.pending ? <p className="vc-cir wait"><Lock className="i" aria-hidden="true" /><span>نتیجه هنوز ثبت نشده</span></p> : null}
  </li>;
}
/** The live/ended click call as a history row (task card «سابقه‌ی پیگیری» and the result form). */
export function vcCallAsItem(c: VcCall, expert: string | null): VcHistItem {
  return { kind: 'voip', id: `k${c.id}`, at: c.createdAt, status: c.outcome, durationSeconds: c.durationSeconds, expert, fileId: c.fileId, recording: c.recording,
    playable: c.recording === 'ready' && c.eventId != null, eventId: c.eventId, result: null, pending: c.needsResult };
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
      : items.length ? <ol className="vc-cil">{items.map((i) => <VcCallItem key={i.id} i={i} />)}</ol> : <p className="muted">هنوز تماسی ثبت نشده.</p>}
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
