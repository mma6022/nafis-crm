/** FILE-DETAIL v1.1 · notes column (Armita §chat): internal staff notes, newest at the BOTTOM (Mohammad), only the list scrolls,
 *  states «در حال ثبت / ثبت شد / ثبت نشد» with «ارسال دوباره». Same endpoints as CaseNotesRoom (fetchNotes/postNote, 5s poll). */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Ban, Check, ChevronDown, ChevronRight, FilePlus2, User as UserIcon, PenLine, Download, File as FileIcon, Lock, Mic, Paperclip, Play, Pause, Phone, RefreshCw, Send, Square, StickyNote, X } from 'lucide-react';
import { CaseApiError, MAX_FILE_BYTES, canReadNotes, canWriteNotes, fetchNotes, postNote, withBase, type CaseNote, type CaseUser } from '@/loan-case-history/api';
import { useVoiceRecorder } from '@/loan-case-history/useVoiceRecorder';
import { dayKey, dayLabel, fd, hm, sizeFa } from './fdv1-api';
import { vthDraftRead, vthDraftWrite, vthDraftClear } from '@/features/voip-task-hold/notes-draft';

type Pending = { clientId: string; text: string; file: File | null; st: 'sending' | 'failed'; createdAt: string };
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const merge = (a: CaseNote[], b: CaseNote[]) => { const m = new Map<number, CaseNote>(); [...a, ...b].forEach(n => m.set(n.id, n)); return [...m.values()].sort((x, y) => x.id - y.id); };
const SUPPORTED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'];
const WV = [6, 12, 18, 10, 22, 14, 8, 16, 24, 12, 7, 18, 13, 20, 9, 15, 11, 6, 14, 19, 10, 8];
const mmss = (s: number) => fd(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

function Voice({ url, label }: { url: string; label?: string }) {
  const a = useRef<HTMLAudioElement>(null);
  const [play, setPlay] = useState(false); const [p, setP] = useState(0); const [dur, setDur] = useState(0);
  return <div className="vc">
    <button className="pl" type="button" aria-label={`${play ? 'توقف' : 'پخش'} پیام صوتی${dur ? ` ${mmss(dur)}` : ''}`}
      onClick={() => { const el = a.current; if (!el) return; if (el.paused) void el.play().catch(() => setPlay(false)); else el.pause(); }}>
      {play ? <Pause className="i" aria-hidden /> : <Play className="i" aria-hidden />}</button>
    <span className="wv" aria-hidden="true">{WV.map((v, i) => <i key={i} style={{ height: v }} className={i < p * WV.length ? 'on' : undefined} />)}</span>
    <span className="d">{dur ? mmss(dur) : label || ''}</span>
    <audio ref={a} src={url} preload="metadata" onPlay={() => setPlay(true)} onPause={() => setPlay(false)} onEnded={() => { setPlay(false); setP(0); }}
      onLoadedMetadata={e => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setDur(d); }}
      onTimeUpdate={e => { const el = e.currentTarget; if (el.duration) setP(el.currentTime / el.duration); }} hidden />
  </div>;
}

function Att({ note }: { note: CaseNote }) {
  const at = note.attachment; const url = withBase(at?.fileUrl);
  if (!at || !url) return null;
  if (at.kind === 'audio') return <Voice url={url} />;
  return <div className="frow"><span className="fi"><FileIcon className="i" aria-hidden /></span>
    <span className="tx"><b dir="auto">{at.fileName}</b><span>{sizeFa(at.fileSize)}</span></span>
    <a className="ib" href={url} download={at.fileName} target="_blank" rel="noopener noreferrer" aria-label={`دانلود ${at.fileName}`}><Download className="i" aria-hidden /></a></div>;
}

function Meta({ tm, st, onRetry }: { tm: string; st?: 'sending' | 'sent' | 'failed'; onRetry?: () => void }) {
  return <span className="meta"><span>{tm}</span>
    {st === 'sending' ? <span className="st sending"><RefreshCw className="i" aria-hidden />در حال ثبت</span> : null}
    {st === 'sent' ? <span className="st sent"><Check className="i" aria-hidden />ثبت شد</span> : null}
    {st === 'failed' ? <><span className="st failed"><AlertCircle className="i" aria-hidden />ثبت نشد</span>
      <button className="btn gh sm rty" type="button" onClick={onRetry}><RefreshCw className="i" aria-hidden />ارسال دوباره</button></> : null}
  </span>;
}

export type SysLine = { id: string; at: string; text: string; kind?: 'created' | 'signed' | 'sent' | 'canceled' | 'voip' };
const SYS_ICON = { created: FilePlus2, signed: PenLine, sent: Send, canceled: Ban, voip: Phone } as const;
export function NotesColumn({ appId, user, onBack, title, sys = [], draftKey }: { appId: number; user: CaseUser & { name?: string | null }; onBack: () => void; title?: string; sys?: SysLine[]; draftKey?: string }) {
  const readable = canReadNotes(user), writable = canWriteNotes(user);
  const me = user?.id ?? null;
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [older, setOlder] = useState(false);
  const [text, setText] = useState(() => (draftKey ? vthDraftRead(draftKey) : ''));
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (draftKey) vthDraftWrite(draftKey, text); }, [draftKey, text]);
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const keepFromBottom = useRef<number | null>(null);

  const attach = (f?: File | null) => {
    if (!f) return;
    if (!SUPPORTED.includes(f.type.split(';')[0])) { setErr('قالب فایل پشتیبانی نمی‌شود؛ تصویر، PDF، Word یا فایل صوتی انتخاب کنید.'); return; }
    if (f.size > MAX_FILE_BYTES) { setErr('حجم فایل نباید بیشتر از ۱۶ مگابایت باشد.'); return; }
    setErr(''); setFile(f);
  };
  const voice = useVoiceRecorder(f => attach(f), m => setErr(m));

  const loadLatest = useCallback(async (initial: boolean) => {
    try {
      const page = await fetchNotes(appId, null, 30);
      setNotes(prev => merge(prev, page.items));
      if (initial) setCursor(page.nextCursor);
      setStatus('ok');
    } catch { if (initial) setStatus('error'); }
  }, [appId]);

  useEffect(() => {
    if (!readable) return;
    setStatus('loading'); setNotes([]); setPending([]); setCursor(null); stick.current = true;
    void loadLatest(true);
    const t = window.setInterval(() => { if (visible()) void loadLatest(false); }, 5000);
    return () => window.clearInterval(t);
  }, [appId, readable, loadLatest]);

  const loadOlder = async () => {
    if (!cursor || older) return;
    setOlder(true);
    const el = list.current; keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    try { const page = await fetchNotes(appId, cursor, 30); setNotes(prev => merge(prev, page.items)); setCursor(page.nextCursor); }
    catch { keepFromBottom.current = null; }
    finally { setOlder(false); }
  };

  // newest at the bottom: stay pinned to the bottom unless the reader scrolled up; keep position when older notes are prepended
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (keepFromBottom.current != null) { el.scrollTop = el.scrollHeight - keepFromBottom.current; keepFromBottom.current = null; return; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [notes, pending, status, sys.length]); // r4 §1: a new system line (e.g. after sending) scrolls into view
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto';
    // Armita r1 §11: grow to at most 3 lines, then scroll inside the box
    const cs = window.getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || 24;
    const max = Math.round(lh * 3 + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
    el.style.height = `${Math.min(el.scrollHeight, max)}px`; el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'; }, [text]);

  const send = async (p: Pending) => {
    setPending(prev => [...prev.filter(x => x.clientId !== p.clientId), { ...p, st: 'sending' }]);
    stick.current = true;
    try {
      const note = await postNote(appId, p.clientId, p.text, p.file);
      setNotes(prev => merge(prev, [note]));
      setPending(prev => prev.filter(x => x.clientId !== p.clientId));
    } catch (e) {
      setPending(prev => prev.map(x => x.clientId === p.clientId ? { ...x, st: 'failed' } : x));
      if (e instanceof CaseApiError && e.status && e.status !== 0 && e.status < 500) setErr(e.message);
    }
  };
  const canSend = writable && !voice.recording && (text.trim().length > 0 || !!file);
  const submit = () => {
    if (!canSend) return;
    const p: Pending = { clientId: crypto.randomUUID(), text: text.trim(), file, st: 'sending', createdAt: new Date().toISOString() };
    setText(''); setFile(null); setErr(''); if (draftKey) vthDraftClear(draftKey);
    void send(p);
  };

  const people = useMemo(() => {
    const m = new Map<number, string>();
    for (const n of [...notes].reverse()) if (!m.has(n.author.id)) m.set(n.author.id, n.author.name);
    return [...m.values()].slice(0, 3);
  }, [notes]);

  const rows: React.JSX.Element[] = [];
  let lastDay = '';
  const dayRow = (iso: string) => { const k = dayKey(iso); if (k !== lastDay) { lastDay = k; rows.push(<div className="day" key={`d${k}`}>{dayLabel(iso)}</div>); } };
  // system lines (registered / contract signed / sent / cancelled) only inside the loaded notes window, so paging stays honest
  const oldest = notes.length && cursor ? notes[0].createdAt : null;
  const feed: ({ k: 'n'; at: string; n: CaseNote } | { k: 's'; at: string; s: SysLine })[] = [
    ...notes.map(n => ({ k: 'n' as const, at: n.createdAt, n })),
    ...(status === 'ok' ? sys.filter(x => !oldest || Date.parse(x.at) >= Date.parse(oldest)).map(x => ({ k: 's' as const, at: x.at, s: x })) : []),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const f of feed) {
    dayRow(f.at);
    if (f.k === 's') { const SI = SYS_ICON[f.s.kind || 'sent'];
      rows.push(<div key={`s${f.s.id}`} className={`sys k-${f.s.kind || 'sent'}`} data-testid={`fdv1-sys-${f.s.id}`}><SI className="i" aria-hidden /><span>{f.s.text}</span><span className="sm-t">{hm(f.at)}</span></div>); continue; }
    const n = f.n;
    const out = me != null && n.author.id === me;
    const mgr = !out && Boolean((n.author as { manager?: boolean }).manager);
    rows.push(<div key={n.id} className={`msg ${out ? 'out' : 'in'}${mgr ? ' mg' : ''}`} data-st={out ? 'sent' : undefined} data-testid={`fdv1-note-${n.id}`}>
      <div className="bb">{mgr ? <span className="au"><UserIcon className="i" aria-hidden />مدیر فروش: {n.author.name.replace(/^مدیر فروش\s*[:：]?\s*/, '')}</span> : !out ? <span className="by">{n.author.name}</span> : null}<Att note={n} />{n.text ? <span className="tt">{n.text}</span> : null}</div>
      <Meta tm={hm(n.createdAt)} st={out ? 'sent' : undefined} />
    </div>);
  }
  for (const p of pending) {
    dayRow(p.createdAt);
    rows.push(<div key={p.clientId} className={`msg out${p.st === 'failed' ? ' failed' : ''}`} data-st={p.st}>
      <div className="bb">{p.file ? <div className="frow"><span className="fi"><FileIcon className="i" aria-hidden /></span><span className="tx"><b dir="auto">{p.file.name}</b><span>{sizeFa(p.file.size)}</span></span></div> : null}
        {p.text ? <span className="tt">{p.text}</span> : null}</div>
      <Meta tm={hm(p.createdAt)} st={p.st} onRetry={() => void send(p)} />
    </div>);
  }

  return <aside className="fchat" aria-label="یادداشت‌های پرونده" data-testid="fdv1-notes">
    <div className="chh"><button className="ib bkb" type="button" aria-label="برگشت به پرونده" onClick={onBack}><ChevronRight className="i" aria-hidden /></button>
      <div className="t"><div className="nmr"><span className="nm">یادداشت‌های پرونده</span>{title ? <span className="fno">{title}</span> : null}<span className="chip in"><Lock className="i" aria-hidden />داخلی</span></div><p>فقط همکاران می‌بینند؛ برای مشتری نمی‌رود</p></div>
      {people.length ? <span className="avs" aria-label={`در این یادداشت‌ها: ${people.join('، ')}`}>{people.map((nm, i) => <span key={i} className={`ava c${(i % 4) + 1}`}>{nm.trim().replace(/^(آقای|خانم)\s+/, '').slice(0, 1) || '؟'}</span>)}</span> : null}
    </div>
    <div className="cmsgs" ref={list} tabIndex={0} aria-label="یادداشت‌ها، تازه‌ترین پایین" aria-live="polite" data-testid="fdv1-notes-list"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {!readable ? null : status === 'loading' ? <span className="cload" role="status">در حال دریافت یادداشت‌ها…</span>
        : status === 'error' ? <div className="cempty" role="alert"><AlertCircle className="i" aria-hidden /><b>یادداشت‌ها دریافت نشد.</b>
          <button className="btn gh sm" type="button" onClick={() => { setStatus('loading'); void loadLatest(true); }}><RefreshCw className="i" aria-hidden />دوباره امتحان کن</button></div>
        : !rows.length ? <div className="cempty"><StickyNote className="i" aria-hidden /><b>هنوز یادداشتی ثبت نشده است.{writable ? ' اولین یادداشت را بنویسید.' : ''}</b></div>
        : <>{cursor ? <button className="btn lk sm older" type="button" onClick={() => void loadOlder()} aria-busy={older}><ChevronDown className="i up" aria-hidden />یادداشت‌های قدیمی‌تر</button> : null}{rows}</>}
    </div>
    <div className="cz">
      {!writable ? <div className="czro"><Lock className="i" aria-hidden />شما فقط اجازهٔ مشاهدهٔ یادداشت‌ها را دارید.</div> : <>
        {draftKey && (text.trim() || file) ? <small className="vh-draft" data-testid="vth-draft">پیش‌نویس؛ هنوز ثبت نشده</small> : null}
        {file ? <div className="apv"><span className="fi"><FileIcon className="i" aria-hidden /></span><span className="tx"><b dir="auto">{file.name}</b><span>{sizeFa(file.size)}</span></span>
          <button className="ib" type="button" aria-label="حذف پیوست" onClick={() => setFile(null)}><X className="i" aria-hidden /></button></div> : null}
        {err ? <p className="ferr inl" role="alert"><AlertCircle className="i" aria-hidden />{err}</p> : null}
        <div className="row">
          <button className="ib" type="button" aria-label="پیوست فایل" onClick={() => pick.current?.click()} disabled={voice.recording}><Paperclip className="i" aria-hidden /></button>
          <input ref={pick} className="upin" type="file" tabIndex={-1} aria-hidden="true" accept={SUPPORTED.join(',') + ',.docx'} onChange={e => { attach(e.target.files?.[0]); e.target.value = ''; }} />
          <label className="sr-only" htmlFor="fdv1-cmsg">یادداشت درباره‌ی این پرونده</label>
          {voice.recording ? <span className="rcd" role="status"><Mic className="i" aria-hidden />در حال ضبط {mmss(voice.seconds)}</span>
            : <textarea id="fdv1-cmsg" ref={ta} className="ta3" rows={1} placeholder="یادداشت بنویسید…" value={text}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(min-width:1024px)').matches) { e.preventDefault(); submit(); } }} data-testid="fdv1-note-input" />}
          {voice.recording ? <><button className="ib" type="button" aria-label="لغو ضبط" onClick={voice.cancel}><X className="i" aria-hidden /></button>
              <button className="snd" type="button" aria-label="پایان ضبط" onClick={voice.stop}><Square className="i" aria-hidden /></button></>
            : canSend ? <button className="snd" type="button" aria-label="ثبت یادداشت" onClick={submit} data-testid="fdv1-note-send"><Send className="i" aria-hidden /></button>
            : <>{voice.supported ? <button className="ib" type="button" aria-label="ضبط پیام صوتی" onClick={() => void voice.start()}><Mic className="i" aria-hidden /></button> : null}
              <button className="snd" type="button" aria-label="ثبت یادداشت" aria-disabled="true"><Send className="i" aria-hidden /></button></>}
        </div></>}
    </div>
  </aside>;
}
