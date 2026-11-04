/** «یک تماس» page (design v1.1 scenes 18–21 expert, 24–26 manager): summary on top, sticky player, chat transcript with speakers.
 *  CT-CHAT: when the server marks the call `chat` (flag.call_transcripts.chat ON for this user) the transcript section is ChatTranscriptCard; otherwise the old TranscriptCard. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Copy, Eye, Flag, Lock, MessageSquareText, Pause, Pencil, Phone as PhoneIcon, Play, RefreshCw, ShieldCheck, Sparkles, StickyNote } from 'lucide-react';
import { atText, CtError, ctReq, durText, fa, mmss, PHASES, phaseIndex, type CtCall } from './api';
import { Phone, StatusChip, TextChip } from './shared';
import { ChatTranscriptCard } from './ChatTranscript';
import './ct.css';
import CsItemsCard from '@/features/call-summary-fields/ItemsCard';

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const pending = (s: CtCall['textState']) => s === 'queued' || s === 'processing' || s === 'waiting';
/** CT-CHAT: summary being re-made after a «مدیر فروش» role swap (chat view only) → keep refreshing until it lands. */
const regen = (c: CtCall) => !!c.chat && c.transcript?.roleSource === 'manual' && (c.summary?.state === 'queued' || c.summary?.state === 'processing');

export default function CallView() {
  const { id } = useParams<{ id: string }>(); const eventId = Number(id);
  const qc = useQueryClient();
  const key = ['call-transcripts', 'call', eventId];
  const q = useQuery<CtCall, CtError>({ queryKey: key, enabled: Number.isInteger(eventId) && eventId > 0, retry: false,
    queryFn: () => ctReq<CtCall>('GET', `/call-transcripts/calls/${eventId}`), refetchInterval: (query) => (query.state.data && (pending(query.state.data.textState) || regen(query.state.data)) ? 10_000 : false) });
  const set = (c: CtCall) => qc.setQueryData(key, c);
  if (q.isLoading) return <div className="ctp" dir="rtl"><p className="muted">در حال دریافت تماس…</p></div>;
  if (q.isError || !q.data) return <div className="ctp" dir="rtl"><p className="note"><AlertTriangle className="i" />{q.error?.code === 'call_transcripts_off' ? 'صفحه‌ی متن و خلاصه‌ی تماس فعال نیست.' : (q.error?.message ?? 'این تماس پیدا نشد.')}</p>
    <Link className="btn lk" href="/">بازگشت</Link></div>;
  const c = q.data, mgr = c.isManager && c.expertUserId !== null && !c.canEdit;
  return <div className="ctp" dir="rtl" data-testid="ct-call-view">
    <p className="cvbk">{c.isManager || (c.isViewer && !c.canEdit) ? <Link className="btn lk" href="/call-center"><ArrowRight className="i" />بازگشت به تماس‌های کارشناسان</Link>
      : <Link className="btn lk" href={c.customerId ? `/customers/${c.customerId}` : '/calls'}><ArrowRight className="i" />بازگشت به سابقه‌ی تماس‌ها</Link>}</p>
    <div className="hrow cu"><h2>{c.customerName ?? 'مشتری ثبت‌نشده'}</h2>{c.customerId ? <span className="cid">#{fa(c.customerId)}</span> : null}</div>
    <section className="card cvm" aria-label="مشخصات تماس">
      <div className="cvm-r"><span className="chip n"><PhoneIcon className="i" />{c.direction === 'incoming' ? 'تماس ورودی روی تلفن ویپ' : 'تماس خروجی از تلفن ویپ'}</span>
        <StatusChip status={c.status} />{durText(c.durationSeconds) ? <span className="ci-d">{durText(c.durationSeconds)}</span> : <span className="ci-d">بی‌مکالمه</span>}<TextChip row={c} /></div>
      <dl className="kv cvkv"><dt>زمان</dt><dd>{atText(c.startedAt)}</dd><dt>کارشناس</dt><dd>{c.expertName ?? 'نامشخص'}</dd><dt>شماره‌ی مشتری</dt><dd><Phone phone={c.phone} /></dd></dl>
      {c.isManager ? <p className="muted cvph"><Eye className="i" /><span>شماره‌ها برای مدیر فروش کامل است، طبق قاعده‌ی شماره‌ی کامل CRM.</span></p> : null}
    </section>
    <SummaryCard c={c} onSaved={set} />
    <CsItemsCard eventId={c.eventId} starts={(c.transcript?.segments ?? []).map((s) => s.start)} />
    {c.isManager ? <ReviewCard c={c} onSaved={set} /> : null}
    {c.chat ? <ChatTranscriptCard c={c} onSaved={set} before={<ExpertReviewNote c={c} />} /> : <TranscriptCard c={c} onSaved={set} mgr={mgr || c.isManager} />}
  </div>;
}

function SummaryCard({ c, onSaved }: { c: CtCall; onSaved: (c: CtCall) => void }) {
  const s = c.summary; const [ed, setEd] = useState(false);
  const [subject, setSubject] = useState(''); const [req, setReq] = useState('');
  const m = useMutation<CtCall, CtError>({ mutationFn: () => ctReq('PATCH', `/call-transcripts/calls/${c.eventId}/summary`, { subject, customerRequest: req, revision: s?.revision ?? 0, sourceHash: s?.sourceHash ?? '' }),
    onSuccess: (n) => { onSaved(n); setEd(false); } });
  if (pending(c.textState)) return <section className="card cvsm wait" aria-labelledby="sT"><div className="cvsm-h"><h3 id="sT"><StickyNote className="i" />خلاصه‌ی تماس</h3><TextChip row={c} /></div>
    <dl className="kv2"><dt>موضوع تماس</dt><dd className="sk">هنوز آماده نشده است.</dd><dt>خلاصه درخواست مشتری</dt><dd className="sk">هنوز آماده نشده است.</dd></dl>
    <p className="muted mch"><Sparkles className="i" />بعد از آماده شدن متن، خلاصه خودکار ساخته و روی همین تماس ذخیره می‌شود.</p></section>;
  if (c.textState === 'failed') return <section className="card cvsm wait" aria-labelledby="sT"><div className="cvsm-h"><h3 id="sT"><StickyNote className="i" />خلاصه‌ی تماس</h3></div>
    <p className="muted">خلاصه ساخته نشد، چون متن مکالمه آماده نشد. بعد از تبدیل مجدد، خودکار ساخته می‌شود.</p></section>;
  if (c.textState === 'no_recording') return <section className="card cvsm wait" aria-labelledby="sT"><div className="cvsm-h"><h3 id="sT"><StickyNote className="i" />خلاصه‌ی تماس</h3></div>
    <p className="muted">این تماس فایل ضبط ندارد؛ متن و خلاصه ساخته نمی‌شود.</p></section>;
  const ready = s && s.state === 'completed' && s.subject;
  if (ed && ready) return <section className="card cvsm ed" aria-labelledby="sT"><div className="cvsm-h"><h3 id="sT"><Pencil className="i" />ویرایش خلاصه‌ی تماس</h3></div>
    <label className="flab" htmlFor="sS">موضوع تماس</label><input className="inp" id="sS" type="text" maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="ct-edit-subject" />
    <p className="cnt muted"><bdi>{fa(subject.length)}</bdi> از ۱۶۰</p>
    <label className="flab" htmlFor="sR">خلاصه درخواست مشتری</label><textarea className="inp ta" id="sR" maxLength={1200} rows={4} value={req} onChange={(e) => setReq(e.target.value)} data-testid="ct-edit-request" />
    <p className="cnt muted"><bdi>{fa(req.length)}</bdi> از ۱۲۰۰</p>
    <p className="note ednote"><ShieldCheck className="i" /><span>فقط خلاصه عوض می‌شود؛ متن مکالمه و فایل ضبط دست نمی‌خورند. بعد از ذخیره، کنار خلاصه «ویرایش‌شده توسط کارشناس» می‌آید. اگر هم‌زمان کس دیگری عوضش کرده باشد، متن تو نگه داشته می‌شود تا دوباره ذخیره کنی.</span></p>
    {m.isError ? <p className="err" role="alert">{m.error.message}</p> : null}
    <div className="brow"><button className="btn pri" type="button" disabled={m.isPending || !subject.trim() || !req.trim()} onClick={() => m.mutate()} data-testid="ct-edit-save"><Check className="i" />ذخیره ویرایش</button>
      <button className="btn gh" type="button" onClick={() => setEd(false)}>انصراف</button></div></section>;
  return <section className="card cvsm" aria-labelledby="sT" data-testid="ct-summary"><div className="cvsm-h"><h3 id="sT"><StickyNote className="i" />خلاصه‌ی تماس</h3>
    {c.canEdit && ready ? <button className="btn gh" type="button" onClick={() => { setSubject(s!.subject ?? ''); setReq(s!.request ?? ''); setEd(true); }} data-testid="ct-edit"><Pencil className="i" />ویرایش</button>
      : c.isManager ? <span className="muted">ویرایش خلاصه با کارشناس همین تماس است</span> : null}</div>
    {ready ? <><dl className="kv2"><dt>موضوع تماس</dt><dd>{s!.subject}</dd><dt>خلاصه درخواست مشتری</dt><dd>{s!.request}</dd></dl>
      <p className="muted mch"><Sparkles className="i" /><span>{s!.edited ? 'ویرایش‌شده توسط کارشناس.' : 'خودکار از متن ماشینی ساخته و ذخیره شد؛ برای تصمیم، صدای اصلی را هم گوش بده.'}</span></p>
      {s!.edited && s!.keptOnSwap ? <p className="muted mch" role="status" data-testid="ct-summary-kept"><ShieldCheck className="i" /><span>نقش گوینده‌ها عوض شد؛ خلاصه چون دستی ویرایش شده بود تغییر نکرد.</span></p> : null}</>
      : <dl className="kv2"><dt>موضوع تماس</dt><dd className="sk">{s?.state === 'failed' ? 'خلاصه ساخته نشد.' : 'هنوز آماده نشده است.'}</dd><dt>خلاصه درخواست مشتری</dt><dd className="sk">{s?.state === 'failed' ? 'خلاصه ساخته نشد.' : 'هنوز آماده نشده است.'}</dd></dl>}
    {!ready && regen(c) ? <p className="muted mch" role="status" data-testid="ct-summary-regen"><Sparkles className="i" /><span>نقش گوینده‌ها عوض شد؛ خلاصه دوباره ساخته می‌شود و چند لحظه بعد همین‌جا می‌آید.</span></p> : null}
  </section>;
}

function ReviewCard({ c, onSaved }: { c: CtCall; onSaved: (c: CtCall) => void }) {
  const r = c.review ?? { flagged: false, note: '', updatedAt: null, updatedByName: null };
  const [note, setNote] = useState(r.note); const [saved, setSaved] = useState(false);
  useEffect(() => setNote(r.note), [c.eventId, r.note]);
  const m = useMutation<CtCall, CtError, { flagged?: boolean; note?: string }>({ mutationFn: (b) => ctReq('PUT', `/call-transcripts/calls/${c.eventId}/review`, b),
    onSuccess: (n, b) => { onSaved(n); if (b.note !== undefined) { setSaved(true); setTimeout(() => setSaved(false), 2000); } } });
  return <section className="card rev" aria-labelledby="rvT" data-testid="ct-review"><div className="cvsm-h"><h3 id="rvT"><Flag className="i" />بررسی مدیر فروش (احمد)</h3>
    <button className={`btn ${r.flagged ? 'pri' : 'gh'} rvf`} type="button" aria-pressed={r.flagged} disabled={m.isPending} onClick={() => m.mutate({ flagged: !r.flagged })} data-testid="ct-flag">
      <Flag className="i" />{r.flagged ? 'علامت‌خورده برای بررسی' : 'علامت برای بررسی'}</button></div>
    <label className="flab" htmlFor="rvN">یادداشت برای کارشناس <small className="muted">(اختیاری)</small></label>
    <textarea className="inp ta" id="rvN" maxLength={1000} rows={2} placeholder="مثلاً نکته‌ای برای جلسه‌ی تیم" value={note} onChange={(e) => setNote(e.target.value)} data-testid="ct-note" />
    {m.isError ? <p className="err" role="alert">{m.error.message}</p> : null}
    <div className="brow"><button className="btn gh" type="button" disabled={m.isPending || note === r.note} onClick={() => m.mutate({ note })} data-testid="ct-note-save"><Check className="i" />ذخیره یادداشت</button>
      {saved ? <span className="ok" role="status">ذخیره شد.</span> : null}</div>
    <p className="muted rvn"><Lock className="i" /><span>این یادداشت را فقط تو و کارشناس همین تماس ({c.expertName ?? 'کارشناس'}) می‌بینید. نمره یا رتبه‌ای ثبت نمی‌شود؛ علامت فقط برای پیدا کردن دوباره‌ی تماس است.</span></p>
  </section>;
}

function ExpertReviewNote({ c }: { c: CtCall }) {
  if (c.isManager || !c.review || (!c.review.flagged && !c.review.note)) return null;
  return <p className="note" data-testid="ct-review-expert"><Flag className="i" /><span>{c.review.flagged ? 'مدیر فروش این تماس را برای بررسی علامت زده است. ' : ''}{c.review.note ? `یادداشت مدیر فروش: ${c.review.note}` : ''}</span></p>;
}

function TranscriptCard({ c, onSaved, mgr }: { c: CtCall; onSaved: (c: CtCall) => void; mgr: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [t, setT] = useState(0); const [dur, setDur] = useState(c.durationSeconds ?? 0); const [playing, setPlaying] = useState(false); const [sp, setSp] = useState(0); const [aErr, setAErr] = useState(false); const [pick, setPick] = useState(-1);
  const [tab, setTab] = useState<'chat' | 'full'>('chat'); const [copied, setCopied] = useState(false); const [confirm, setConfirm] = useState(false);
  const segs = c.transcript?.segments ?? [];
  const cur = useMemo(() => { if (!playing && pick >= 0) return pick; if (!playing && t === 0) return -1; let k = -1; segs.forEach((s, i) => { if (s.start <= t + 0.05) k = i; }); return k; }, [segs, t, playing, pick]);
  const src = c.recording ? `/api/voip/recordings/${encodeURIComponent(c.recording.externalId)}/audio?from=${c.recording.from}&to=${c.recording.to}` : null;
  const seek = (s: number) => { const a = audio.current; if (!a) return; a.currentTime = s; setT(s); void a.play().catch(() => undefined); };
  const retx = useMutation<CtCall, CtError>({ mutationFn: () => ctReq('POST', `/call-transcripts/calls/${c.eventId}/retranscribe`), onSuccess: (n) => { setConfirm(false); onSaved(n); } });
  const full = segs.map((s) => `${s.label}: ${s.text}`).join('\n');
  const total = dur || c.transcript?.durationSeconds || c.durationSeconds || 0;
  const player = src ? <div className="rp" data-testid="ct-player">
    <audio ref={audio} src={src} preload="none" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
      onPlay={() => { setPlaying(true); setAErr(false); setPick(-1); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setAErr(true); }} />
    <button className="rpb" type="button" aria-pressed={playing} aria-label={`${playing ? 'توقف' : 'پخش'} فایل ضبط، ${mmss(total)}`}
      onClick={() => { const a = audio.current; if (!a) return; if (a.paused) void a.play().catch(() => undefined); else a.pause(); }}>{playing ? <Pause className="i" /> : <Play className="i" />}</button>
    <span className="rpw"><span className="rpbar" role="slider" tabIndex={0} aria-label="جای پخش" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(t)} aria-valuetext={`${mmss(t)} از ${mmss(total)}`}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (total) seek(((e.clientX - r.left) / r.width) * total); }}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(Math.min(total, t + 5)); if (e.key === 'ArrowLeft') seek(Math.max(0, t - 5)); }}>
      <i style={{ width: `${total ? Math.min(100, (t / total) * 100) : 0}%` }} /></span>
      <span className="rpn"><bdi>{mmss(t)}</bdi> از <bdi>{mmss(total)}</bdi></span></span>
    <button className="rps" type="button" aria-label={`سرعت پخش، ${fa(SPEEDS[sp])} برابر`} onClick={() => { const n = (sp + 1) % SPEEDS.length; setSp(n); if (audio.current) audio.current.playbackRate = SPEEDS[n]; }}>{fa(SPEEDS[sp])}x</button>
    {aErr ? <span className="rp-err" role="status" data-testid="ct-audio-error">پخش فایل ضبط الان ممکن نیست؛ متن مکالمه در دسترس است.</span> : null}
  </div> : <p className="rp none"><Eye className="i" /><span>فایل ضبط ندارد؛ مکالمه‌ای برقرار نشد.</span></p>;
  let body: ReactNode = null;
  if (pending(c.textState)) { const k = c.textState === 'processing' ? phaseIndex(c.textPhase) : -1;
    body = <div className="txw" role="status" data-testid="ct-processing"><ol className="steps txp" aria-label="مراحل تبدیل به متن">{PHASES.map(([, l], i) => <li key={l} className={i < k ? 'dn' : i === k ? 'on' : ''} aria-current={i === k ? 'step' : undefined}><b>{i < k ? <Check className="i" /> : fa(i + 1)}</b>{l}</li>)}</ol>
      <p>{c.textState === 'processing' ? '' : 'در صف تبدیل است. '}تبدیل مکالمه به متن ممکن است چند دقیقه طول بکشد. می‌توانی این صفحه را ببندی؛ پردازش ادامه دارد و متن و خلاصه خودشان این‌جا می‌آیند. تا آن موقع فایل ضبط پخش می‌شود.</p></div>; }
  else if (c.textState === 'failed') body = <div className="txf" role="status" data-testid="ct-failed"><p className="txf-h"><AlertTriangle className="i" /><b>تبدیل مکالمه به متن ناموفق بود.</b></p>
    {c.canRetranscribe ? <><p>{c.textError ? `${c.textError} ` : ''}با «تبدیل مجدد» دوباره به متن تبدیل و خلاصه‌اش ذخیره می‌شود.</p>
      {confirm ? <div className="brow"><button className="btn pri" type="button" disabled={retx.isPending} onClick={() => retx.mutate()} data-testid="ct-retx-confirm"><RefreshCw className="i" />بله، تبدیل مجدد</button>
        <button className="btn gh" type="button" onClick={() => setConfirm(false)}>انصراف</button></div>
        : <div className="brow"><button className="btn pri" type="button" onClick={() => setConfirm(true)} data-testid="ct-retx"><RefreshCw className="i" />تبدیل مجدد</button></div>}
      {retx.isError ? <p className="err" role="alert">{retx.error.message}</p> : null}
      <p className="muted">{confirm ? 'این کار هزینه‌ی سرویس دارد؛ مطمئنی؟' : 'یک بار دیگر می‌پرسد؛ این کار هزینه‌ی سرویس دارد.'} «تبدیل مجدد» فقط برای مدیر فروش و مدیر سیستم است.</p></>
      : <p>مدیر فروش یا مدیر سیستم تبدیل مجدد را انجام می‌دهد؛ کاری از تو لازم نیست.</p>}</div>;
  else if (c.textState === 'completed' && c.transcript) body = <>
    <div className="txt-h"><div className="seg sm" role="tablist" aria-label="نمای متن">
      <button role="tab" type="button" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>گفت‌وگو</button><button role="tab" type="button" aria-selected={tab === 'full'} onClick={() => setTab('full')} data-testid="ct-tab-full">متن کامل</button></div>
      {c.transcript.audioSeparation === 'stereo_channels' ? <span className="chip s sep"><Check className="i" />کانال‌ها جداگانه تفکیک شد</span> : null}
      <button className="btn gh cpy" type="button" onClick={() => void navigator.clipboard?.writeText(full).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}><Copy className="i" />{copied ? 'کپی شد' : 'کپی متن کامل'}</button></div>
    {tab === 'chat' ? <ol className="tll" aria-label="گفت‌وگو؛ برای پخش از هر لحظه، روی خطش بزن" data-testid="ct-lines">{segs.map((s, i) => {
      const side = s.role === 'expert' ? 'ex' : s.role === 'customer' ? 'cu' : (c.transcript!.speakers.findIndex((x) => x.id === s.speakerId) % 2 ? 'n1' : 'n0');
      return <li key={i} className={`tl ${side}`}><button className="bub" type="button" aria-current={i === cur ? 'true' : undefined} onClick={() => { seek(s.start); setPick(i); }} data-testid={`ct-line-${i}`}>
        <span className="who"><b>{s.label}</b><bdi className="at" dir="ltr">{mmss(s.start)}</bdi>{i === cur ? <span className="now">در حال پخش</span> : null}</span><span className="say">{s.text}</span>
        <span className="sr">، برای پخش از همین لحظه بزن</span></button></li>; })}</ol>
      : <div className="ftx">{segs.map((s, i) => <p key={i}><b>{s.label}:</b> {s.text}</p>)}</div>}
    <p className="note mnote"><AlertTriangle className="i" /><span>این متن را ماشین ساخته؛ نام‌ها و عددها را با فایل ضبط مطابقت بده.</span></p></>;
  void mgr;
  return <><ExpertReviewNote c={c} /><section className="card cvt" aria-labelledby="tT"><div className="cvsm-h"><h3 id="tT"><MessageSquareText className="i" />فایل ضبط و متن کامل مکالمه</h3></div>
    <div className="cvpl">{player}</div>{body}</section></>;
}
