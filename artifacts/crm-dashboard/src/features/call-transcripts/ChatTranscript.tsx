/** CT-CHAT (flag.call_transcripts.chat): Armita «متن تماس به شکل چت» v1.0, the «فایل ضبط و متن کامل مکالمه» section of /call-view/<id> as a chat.
 *  Expert left / customer right (2 speakers with roles), neutral «گوینده ۱/۲» left/right without roles, one right-aligned column with colour chips
 *  for 1 or 3+ speakers, flat full text when no speaker was separated. Sticky player, click-to-seek, «در حال پخش» + follow, «برگرد به لحظه‌ی پخش».
 *  «مدیر فروش» swaps / assigns the two roles for everyone (PUT …/speaker-roles, audited server-side). Flag OFF → CallView renders the old TranscriptCard. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeftRight, Bug, Check, Copy, Crosshair, EyeOff, Headphones, Info, Pause, Play, RefreshCw, UserRound } from 'lucide-react';
import { CtError, ctReq, fa, mmss, PHASES, phaseIndex, type CtCall, type CtSegment } from './api';
import { useDiagnostics } from '@/diagnostics/DiagnosticsProvider';
import './ct-chat.css';

const SPEEDS = [1, 1.25, 1.5, 2];
const rateText = (r: number) => `${fa(String(r)).replace('.', '٫')}×`;
const pending = (s: CtCall['textState']) => s === 'queued' || s === 'processing' || s === 'waiting';
type Kind = 'roles' | 'two' | 'multi' | 'one' | 'none';
const chipN = (n: number) => ((n - 1) % 5) + 1;

export function chatKind(c: Pick<CtCall, 'transcript'>): Kind {
  const tr = c.transcript; const n = tr?.speakers.length ?? 0;
  if (!tr || !n || !tr.segments.length) return 'none';
  if (n === 1) return 'one';
  if (n === 2) return tr.speakers.every((s) => s.role === 'expert' || s.role === 'customer') && new Set(tr.speakers.map((s) => s.role)).size === 2 ? 'roles' : 'two';
  return 'multi';
}

export function ChatTranscriptCard({ c, onSaved, before }: { c: CtCall; onSaved: (c: CtCall) => void; before?: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState(0); const [dur, setDur] = useState(c.durationSeconds ?? 0); const [playing, setPlaying] = useState(false);
  const [sp, setSp] = useState(0); const [aErr, setAErr] = useState(false); const [pick, setPick] = useState(-1);
  const [tab, setTab] = useState<'chat' | 'full'>('chat'); const [toast, setToast] = useState<string | null>(null);
  const [follow, setFollow] = useState(true); const [pill, setPill] = useState(false);
  const [asg, setAsg] = useState(false); const [confirm, setConfirm] = useState(false);
  const diag = useDiagnostics();
  const tr = c.transcript; const segs = tr?.segments ?? []; const ids = tr?.speakers.map((s) => s.id) ?? [];
  const kind = chatKind(c);
  const num = (id: string) => ids.indexOf(id) + 1; // 0 = «گوینده‌ی نامشخص»
  const expertId = kind === 'roles' ? tr!.speakers.find((s) => s.role === 'expert')!.id : null;
  const [asgPick, setAsgPick] = useState<string>(expertId ?? ids[0] ?? '');
  const src = c.recording ? `/api/voip/recordings/${encodeURIComponent(c.recording.externalId)}/audio?from=${c.recording.from}&to=${c.recording.to}` : null;
  const total = dur || tr?.durationSeconds || c.durationSeconds || 0;
  const cur = useMemo(() => { if (!playing && pick >= 0) return pick; if (!playing && t === 0) return -1; let k = -1; segs.forEach((s, i) => { if (s.start <= t + 0.05) k = i; }); return k; }, [segs, t, playing, pick]);
  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 1800); };
  const seek = (s: number) => { const a = audio.current; const v = Math.max(0, Math.min(total || s, s)); setT(v); setFollow(true); if (!a) return; a.currentTime = v; void a.play().catch(() => undefined); };
  const roles = useMutation<CtCall, CtError, { expertSpeakerId: string; msg: string }>({
    mutationFn: (b) => ctReq('PUT', `/call-transcripts/calls/${c.eventId}/speaker-roles`, { expertSpeakerId: b.expertSpeakerId, transcriptAt: c.transcriptAt ?? null }),
    onSuccess: (n, b) => { onSaved(n); setAsg(false); flash(b.msg); } });
  const retx = useMutation<CtCall, CtError>({ mutationFn: () => ctReq('POST', `/call-transcripts/calls/${c.eventId}/retranscribe`), onSuccess: (n) => { setConfirm(false); onSaved(n); } });

  /* follow the playing bubble; a manual scroll stops following and shows «برگرد به لحظه‌ی پخش» */
  const nowEl = useCallback(() => list.current?.querySelector<HTMLElement>('.msg.cur-now') ?? null, []);
  const inView = (e: HTMLElement | null) => { if (!e) return true; const r = e.getBoundingClientRect(); return r.bottom > 120 && r.top < window.innerHeight - 80; };
  const userScroll = useRef(false); const auto = useRef(false);
  useEffect(() => {
    if (!playing || !follow) return; const e = nowEl(); if (!e || inView(e)) return;
    auto.current = true; e.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    window.setTimeout(() => { auto.current = false; }, 700);
  }, [cur, playing, follow, nowEl]);
  useEffect(() => {
    const mark = () => { userScroll.current = true; };
    const onScroll = () => {
      if (userScroll.current && !auto.current) { userScroll.current = false; if (!inView(nowEl())) setFollow(false); }
      setPill(!inView(nowEl()));
    };
    window.addEventListener('wheel', mark, { passive: true }); window.addEventListener('touchmove', mark, { passive: true }); window.addEventListener('keydown', mark);
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => { window.removeEventListener('wheel', mark); window.removeEventListener('touchmove', mark); window.removeEventListener('keydown', mark); document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions); };
  }, [nowEl]);
  const showPill = c.textState === 'completed' && kind !== 'none' && playing && !follow && pill;

  const label = (s: CtSegment) => num(s.speakerId) === 0 ? 'گوینده‌ی نامشخص' : s.label;
  const full = kind === 'none' ? (c.fullText ?? segs.map((s) => s.text).join(' ')) : segs.map((s) => `${label(s)}: ${s.text}`).join('\n');
  const side = (n: number, s: CtSegment) => n === 0 ? 'mid' : kind === 'roles' ? (s.speakerId === expertId ? 'out' : 'in') : kind === 'two' ? (n === 1 ? 'out' : 'in') : 'in';
  const by = (n: number, s: CtSegment) => {
    if (n === 0) return <span className="by">گوینده‌ی نامشخص</span>;
    if (kind === 'roles') return s.speakerId === expertId ? <span className="by">کارشناس: {c.expertName ?? 'نامشخص'}</span>
      : <span className="by">مشتری: {c.customerName ?? 'ثبت‌نشده'}{c.customerId ? <span className="cid">#{fa(c.customerId)}</span> : null}</span>;
    return <span className="by"><span className={`sk k${chipN(n)}`} aria-hidden="true">{fa(n)}</span>گوینده {fa(n)}</span>;
  };
  const copy = () => void navigator.clipboard?.writeText(full).then(() => flash('کپی شد'), () => undefined);

  /* ---------- player ---------- */
  const pct = total ? Math.min(100, (t / total) * 100) : 0;
  const player = src ? <div className="ply" role="group" aria-label="پخش فایل ضبط" data-testid="ct-player">
    <audio ref={audio} src={src} preload="none" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
      onPlay={() => { setPlaying(true); setAErr(false); setPick(-1); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setAErr(true); }} />
    <button className="pp" type="button" aria-pressed={playing} aria-label={playing ? 'توقف' : 'پخش'} data-testid="ct-play"
      onClick={() => { const a = audio.current; if (!a) return; if (a.paused) { setFollow(true); void a.play().catch(() => undefined); } else a.pause(); }}>{playing ? <Pause className="i" /> : <Play className="i" />}</button>
    <div className="pbar" role="slider" tabIndex={0} aria-label="جای پخش" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(t)} aria-valuetext={`${mmss(t)} از ${mmss(total)}`} data-testid="ct-bar"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (total) seek(((r.right - e.clientX) / r.width) * total); }}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') { seek(t + 5); e.preventDefault(); } if (e.key === 'ArrowRight') { seek(t - 5); e.preventDefault(); } if (e.key === 'Home') { seek(0); e.preventDefault(); } }}>
      <span className="trk">{total ? segs.filter((s) => num(s.speakerId)).map((s, i) => { const n = num(s.speakerId);
        return <i key={i} className={`sg k${kind === 'roles' && s.speakerId === expertId ? 'e' : chipN(n)}`} style={{ right: `${(s.start / total) * 100}%`, width: `${Math.max(0, (s.end - s.start) / total) * 100}%` }} />; }) : null}
        <b className="fill" style={{ width: `${pct}%` }} /><b className="kn" style={{ right: `${pct}%` }} /></span></div>
    <span className="ptm"><b>{mmss(t)}</b> از {mmss(total)}</span>
    <button className="spd" type="button" aria-label={`سرعت پخش: ${fa(String(SPEEDS[sp])).replace('.', '٫')} برابر`} data-testid="ct-speed"
      onClick={() => { const n = (sp + 1) % SPEEDS.length; setSp(n); if (audio.current) audio.current.playbackRate = SPEEDS[n]; }}>{rateText(SPEEDS[sp])}</button>
    {aErr ? <span className="rp-err" role="status" data-testid="ct-audio-error">پخش فایل ضبط الان ممکن نیست؛ متن مکالمه در دسترس است.</span> : null}
  </div> : null;

  /* ---------- body by textState ---------- */
  let body: ReactNode = null;
  if (pending(c.textState)) {
    const k = c.textState === 'processing' ? phaseIndex(c.textPhase) : -1;
    body = <div className="ttst" role="status" data-testid="ct-processing"><p className="tt"><RefreshCw className="i spn" />در حال تبدیل به متن<span className="chip b">{k < 0 ? 'در صف' : `گام ${fa(k + 1)} از ۳`}</span></p>
      <ol className="stp" aria-label="مراحل تبدیل به متن">{PHASES.map(([, l], i) => <li key={l} className={i < k ? 'dn' : i === k ? 'cur' : ''} aria-current={i === k ? 'step' : undefined}>
        <span className="n">{i < k ? <Check className="i" /> : fa(i + 1)}</span><span className="l">{l}</span></li>)}</ol>
      <p className="sub">متن و خلاصه بعد از گام سوم اینجا می‌آید. {src ? 'صدای تماس را همین الان می‌شود گوش داد.' : ''}</p></div>;
  } else if (c.textState === 'failed') {
    body = <div className="ttst fail" role="alert" data-testid="ct-failed"><p className="tt"><AlertTriangle className="i" />تبدیل به متن ناموفق</p><p className="sub">{c.textError ?? 'تبدیل ناموفق بود.'}</p>
      <div className="fa">{c.canRetranscribe ? (confirm ? <div className="af"><button className="btn pri sm" type="button" disabled={retx.isPending} onClick={() => retx.mutate()} data-testid="ct-retx-confirm"><RefreshCw className="i" />بله، تبدیل مجدد</button>
        <button className="btn gh sm" type="button" onClick={() => setConfirm(false)}>انصراف</button></div>
        : <button className="btn pri sm" type="button" onClick={() => setConfirm(true)} data-testid="ct-retx"><RefreshCw className="i" />تبدیل مجدد</button>)
        : diag ? <button className="btn gh sm" type="button" onClick={diag.open} data-testid="ct-report-error"><Bug className="i" />گزارش خطا</button> : null}</div>
      {retx.isError ? <p className="err" role="alert">{retx.error.message}</p> : null}
      {confirm ? <p className="sub sm">این کار هزینه‌ی سرویس دارد؛ مطمئنی؟</p> : null}
      {src ? <p className="sub sm">صدای تماس سالم است و پخش می‌شود.</p> : null}</div>;
  } else if (c.textState === 'completed') {
    const hint = kind === 'roles' ? (tr!.roleSource === 'manual' ? `نقش‌ها را مدیر فروش تعیین کرده${tr!.roleByName ? ` (${tr!.roleByName})` : ''}` : tr!.roleSource === 'channel' ? 'نقش‌ها از کانال‌های جدای صدا تعیین شده' : 'نقش‌ها خودکار حدس زده شده')
      : kind === 'none' ? 'گوینده‌ها از هم جدا نشد؛ متن کامل تماس در یک ستون'
      : tr?.audioSeparation === 'stereo_channels' ? (kind === 'one' ? 'فقط یک گوینده شنیده شد' : null)
      : `صدای تک‌کاناله؛ تفکیک زمانی گویندگان تقریبی است${kind === 'one' ? '؛ فقط یک گوینده شنیده شد' : ''}`;
    const nums = [...new Set(segs.map((s) => num(s.speakerId)).filter(Boolean))].sort((a, b) => a - b);
    body = <>
      <div className="ctb">{kind === 'none' ? null : <div className="seg" role="tablist" aria-label="نمایش متن">
          <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')} data-testid="ct-tab-chat">گفت‌وگو</button>
          <button type="button" role="tab" aria-selected={tab === 'full'} onClick={() => setTab('full')} data-testid="ct-tab-full">متن کامل</button></div>}
        <span className="sp" />
        {c.canAssignRoles && kind === 'roles' ? <button className="btn gh sm swp" type="button" disabled={roles.isPending} data-testid="ct-swap"
          onClick={() => roles.mutate({ expertSpeakerId: ids.find((x) => x !== expertId)!, msg: 'جای کارشناس و مشتری عوض شد' })}><ArrowLeftRight className="i" />جابه‌جا کردن کارشناس و مشتری</button> : null}
        {c.canAssignRoles && kind === 'two' ? <button className="btn gh sm asg" type="button" aria-expanded={asg} aria-controls="ct-asgm" data-testid="ct-assign"
          onClick={() => { setAsgPick(ids[0]); setAsg(!asg); }}><UserRound className="i" />تعیین نقش‌ها</button> : null}
        <button className="btn gh sm" type="button" onClick={copy} data-testid="ct-copy"><Copy className="i" />کپی متن کامل</button></div>
      {asg && c.canAssignRoles && kind === 'two' ? <div className="asm" id="ct-asgm" role="group" aria-label="تعیین نقش‌ها" data-testid="ct-assign-menu"><p className="h">کدام گوینده کارشناس است؟</p>
        {ids.map((id, i) => <label key={id} className="opt"><input type="radio" name="ct-asg" checked={asgPick === id} onChange={() => setAsgPick(id)} />
          <span><b>گوینده {fa(i + 1)} کارشناس است</b><small>گوینده {fa(2 - i)} مشتری</small></span></label>)}
        <div className="af"><button className="btn pri sm" type="button" disabled={roles.isPending || !asgPick} onClick={() => roles.mutate({ expertSpeakerId: asgPick, msg: 'نقش‌ها برای همه ذخیره شد' })} data-testid="ct-assign-save">ذخیره برای همه</button>
          <button className="btn gh sm" type="button" onClick={() => setAsg(false)}>انصراف</button></div></div> : null}
      {roles.isError ? <p className="err" role="alert" data-testid="ct-roles-error">{roles.error.message}</p> : null}
      {hint ? <p className="hint" data-testid="ct-hint"><Info className="i" />{hint}</p> : null}
      {kind === 'multi' && tab === 'chat' ? <ul className="lgd" aria-label="گوینده‌ها">{nums.map((n) => <li key={n}><span className={`sk k${chipN(n)}`} aria-hidden="true">{fa(n)}</span>گوینده {fa(n)}</li>)}</ul> : null}
      {kind === 'none' ? <div className="flat" data-testid="ct-flat">{full}</div>
        : tab === 'chat' ? <div ref={list} className={`cvl${kind === 'multi' || kind === 'one' ? ' one' : ''}${kind === 'two' ? ' nr' : ''}`} role="tabpanel" aria-label="گفت‌وگو؛ برای پخش از هر لحظه، روی حبابش بزن" data-testid="ct-lines" data-kind={kind}>
          {segs.map((s, i) => { const n = num(s.speakerId), sd = side(n, s), now = i === cur;
            return <div key={i} className={`msg ${sd} sp${n > 5 ? chipN(n) : n}${now ? ' cur-now' : ''}`} data-testid={`ct-line-${i}`} data-side={sd}>{by(n, s)}
              <button className="bb" type="button" aria-label={`پخش از ${mmss(s.start)}`} aria-current={now ? 'true' : undefined} disabled={!src} onClick={() => { seek(s.start); setPick(i); }}>{s.text}</button>
              <span className="meta"><span className="tm">{mmss(s.start)}</span>{now ? <span className="pl"><Play className="i" />در حال پخش</span> : null}</span></div>; })}</div>
        : <div className="ftx" role="tabpanel" aria-label="متن کامل" data-testid="ct-full">{segs.map((s, i) => <p key={i}><b>{label(s)}:</b> {s.text}</p>)}</div>}
      <p className="note mnote"><AlertTriangle className="i" /><span>این متن را ماشین ساخته؛ نام‌ها و عددها را با فایل ضبط مطابقت بده.</span></p></>;
  }

  return <>{before}
    <section className="card ctc trec" aria-labelledby="tT" data-testid="ct-chat">
      <div className="sh"><h3 id="tT"><Headphones className="i" />فایل ضبط و متن کامل مکالمه</h3></div>
      {c.textState === 'no_recording' ? <div className="norec" data-testid="ct-norec"><span className="chip q"><EyeOff className="i" />بدون ضبط</span>
        <p>{c.simCall ? 'این تماس دستی با سیم‌کارت گرفته شده؛ فایل ضبط و متن ندارد.' : 'فایل ضبط ندارد؛ مکالمه‌ای برقرار نشد.'}</p></div>
        : <>{player}<div className="rbd">{body}</div></>}
    </section>
    <button className={`ctc-bkp${showPill ? ' on' : ''}`} type="button" aria-hidden={!showPill} tabIndex={showPill ? 0 : -1} data-testid="ct-back-to-now"
      onClick={() => { setFollow(true); const e = nowEl(); e?.scrollIntoView({ block: 'center', behavior: 'smooth' }); window.setTimeout(() => setPill(false), 600); }}><Crosshair className="i" />برگرد به لحظه‌ی پخش</button>
    {toast ? <div className="ctc-toast" role="status" data-testid="ct-toast"><Check className="i" /><span>{toast}</span></div> : null}
  </>;
}
