import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Mic, NotebookPen, Paperclip, RefreshCw, Send, Square, Trash2, X } from 'lucide-react';
import {
  CaseApiError, MAX_FILE_BYTES, MAX_RECORD_SECONDS, canReadNotes, canWriteNotes, fetchNotes, postNote, withBase,
  type CaseNote, type CaseUser,
} from './api';
import { useVoiceRecorder } from './useVoiceRecorder';
import './case-history.css';

const when = (v: string) => new Date(v).toLocaleString('fa-IR-u-ca-persian', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' });
const sizeLabel = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const errText = (e: unknown) => e instanceof Error ? e.message : 'ارسال انجام نشد.';
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const mergeNotes = (a: CaseNote[], b: CaseNote[]) => {
  const map = new Map<number, CaseNote>();
  [...a, ...b].forEach(n => map.set(n.id, n));
  return [...map.values()].sort((x, y) => y.id - x.id);
};

function Avatar({ name, url }: { name: string; url: string | null }) {
  const [bad, setBad] = useState(false);
  const src = withBase(url);
  return <span className="cn-av" aria-hidden="true">{src && !bad ? <img src={src} alt="" onError={() => setBad(true)} /> : (name.trim()[0] || '؟')}</span>;
}

function NoteCard({ note }: { note: CaseNote }) {
  const a = note.attachment; const url = withBase(a?.fileUrl);
  return <article className="cn-note" data-testid={`case-note-${note.id}`}>
    <header><Avatar name={note.author.name} url={note.author.avatarUrl} /><div><strong>{note.author.name}</strong><time dateTime={note.createdAt}>{when(note.createdAt)}</time></div></header>
    {a && url && <div className="cn-att">
      {a.kind === 'image' && <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={a.fileName} loading="lazy" /></a>}
      {a.kind === 'audio' && <audio controls preload="none" src={url} aria-label="پیام صوتی" />}
      {a.kind === 'file' && <a className="cn-file" href={url} download={a.fileName}><FileText size={18} /><span>{a.fileName}<small>{sizeLabel(a.fileSize)} · دریافت</small></span></a>}
    </div>}
    {note.text && <blockquote>{note.text}</blockquote>}
  </article>;
}

export function CaseNotesRoom({ applicationId, user }: { applicationId: number; user: CaseUser }) {
  const userId = user?.id ?? null;
  const readable = canReadNotes(user), writable = canWriteNotes(user);
  const scopeKey = `${applicationId}:${userId}`;
  const scope = useRef(scopeKey); scope.current = scopeKey;
  const [notes, setNotes] = useState<CaseNote[]>([]);
  const notesRef = useRef<CaseNote[]>([]); notesRef.current = notes;
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [loadError, setLoadError] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const clientId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const moreRef = useRef(false);
  const cursorRef = useRef<string | null>(null); cursorRef.current = cursor;

  const voice = useVoiceRecorder(f => attach(f), m => setError(m));

  function attach(f: File | undefined | null) {
    if (!f) return;
    const mime = f.type.split(';')[0];
    const supported = ['image/png','image/jpeg','image/webp','application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'audio/webm','audio/ogg','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/x-m4a'];
    if (!supported.includes(mime)) { setError('قالب فایل پشتیبانی نمی‌شود؛ تصویر، PDF، Word یا فایل صوتی انتخاب کنید.'); return; }
    if (f.size > MAX_FILE_BYTES) { setError('حجم فایل نباید بیشتر از ۱۶ مگابایت باشد.'); return; }
    setError(''); setFile(f); clientId.current = null; setFailed(false);
  }

  useEffect(() => {
    if (!file || !/^(image|audio)\//.test(file.type)) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(file); setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Body flag reserves room for the fixed left dock on wide screens.
  useEffect(() => {
    if (!readable) return;
    document.body.classList.add('has-case-notes-dock');
    return () => document.body.classList.remove('has-case-notes-dock');
  }, [readable]);

  const loadLatest = useCallback(async (initial: boolean) => {
    const key = scope.current;
    try {
      const page = await fetchNotes(applicationId, null, 30);
      if (key !== scope.current) return;
      if (!initial && page.nextCursor && notesRef.current.length &&
          !page.items.some(n => notesRef.current.some(old => old.id === n.id))) setCursor(page.nextCursor);
      setNotes(prev => mergeNotes(prev, page.items));
      if (initial) setCursor(page.nextCursor);
      setStatus('ok'); setLoadError('');
    } catch (e) {
      if (key !== scope.current) return;
      if (initial) { setStatus('error'); setLoadError(errText(e)); }
    }
  }, [applicationId]);

  useEffect(() => {
    if (!readable) return;
    setStatus('loading'); setNotes([]); setCursor(null); setText(''); setFile(null); setError(''); setFailed(false); clientId.current = null;
    void loadLatest(true);
    const t = window.setInterval(() => { if (visible()) void loadLatest(false); }, 5000);
    return () => window.clearInterval(t);
  }, [scopeKey, readable, loadLatest]);

  const loadOlder = useCallback(async () => {
    const before = cursorRef.current; const key = scope.current;
    if (before == null || moreRef.current) return;
    moreRef.current = true; setMoreBusy(true);
    try {
      const page = await fetchNotes(applicationId, before, 30);
      if (key !== scope.current) return;
      setNotes(prev => mergeNotes(prev, page.items));
      if (cursorRef.current === before) setCursor(page.nextCursor);
    } catch (e) { if (key === scope.current) setLoadError(errText(e)); }
    finally { moreRef.current = false; if (key === scope.current) setMoreBusy(false); }
  }, [applicationId]);

  useEffect(() => {
    const el = sentinel.current, root = listRef.current;
    if (!el || !root || cursor == null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) void loadOlder(); }, { root, rootMargin: '120px' });
    io.observe(el); return () => io.disconnect();
  }, [cursor, loadOlder, notes.length]);

  const canSend = writable && !sending && !voice.recording && (text.trim().length > 0 || !!file);
  const send = async () => {
    if (!canSend) return;
    const key = scope.current;
    if (!clientId.current) clientId.current = crypto.randomUUID();
    setSending(true); setError('');
    try {
      const note = await postNote(applicationId, clientId.current, text, file);
      if (key !== scope.current) return;
      setNotes(prev => mergeNotes(prev, [note]));
      setText(''); setFile(null); clientId.current = null; setFailed(false);
      listRef.current?.scrollTo({ top: 0 });
    } catch (e) {
      if (key !== scope.current) return;
      setFailed(true); setError(e instanceof CaseApiError ? e.message : errText(e));
    } finally { if (key === scope.current) setSending(false); }
  };

  const empty = useMemo(() => status === 'ok' && !notes.length, [status, notes.length]);
  if (!readable) return null;

  return <aside className="cn-dock" aria-label="یادداشت‌های پرونده" data-testid="case-notes-room">
    <div className="cn-head"><NotebookPen size={18} /><div><h3>یادداشت‌های پرونده</h3><p>تازه‌ترین بالا · مشترک بین همکاران</p></div></div>
    <div className="cn-list" ref={listRef} aria-live="polite" data-testid="case-notes-list">
      {status === 'loading' && <div className="cn-skel" role="status" aria-label="در حال دریافت">{[0, 1, 2].map(i => <span key={i} />)}</div>}
      {status === 'error' && <div className="cn-empty" role="alert">{loadError}<br /><button type="button" className="cn-ib" onClick={() => { setStatus('loading'); void loadLatest(true); }} aria-label="تلاش دوباره" data-testid="button-notes-retry"><RefreshCw size={16} /></button></div>}
      {empty && <div className="cn-empty">هنوز یادداشتی ثبت نشده است.{writable ? ' اولین یادداشت را بنویسید.' : ''}</div>}
      {notes.map(n => <NoteCard key={n.id} note={n} />)}
      {status === 'ok' && cursor != null && <div ref={sentinel} className="cn-more"><button type="button" onClick={() => void loadOlder()} disabled={moreBusy} data-testid="button-notes-older">{moreBusy ? 'در حال دریافت…' : 'یادداشت‌های قدیمی‌تر'}</button></div>}
      {status === 'ok' && loadError && <div className="cn-err" role="alert">{loadError}</div>}
    </div>
    {writable ? <form className="cn-compose" onSubmit={e => { e.preventDefault(); void send(); }}>
      {error && <div className="cn-err" role="alert" data-testid="text-notes-error">{error}{failed && <button type="button" onClick={() => void send()} disabled={sending}>ارسال دوباره</button>}</div>}
      {voice.recording && <div className="cn-rec" role="status"><i /> در حال ضبط {clock(voice.seconds)} / {clock(MAX_RECORD_SECONDS)}
        <button type="button" onClick={voice.cancel} aria-label="لغو ضبط" data-testid="button-notes-record-cancel"><X size={15} /></button></div>}
      {file && <div className="cn-chip">
        {previewUrl && file.type.startsWith('audio/') && <audio controls src={previewUrl} aria-label="پیش‌نمایش صدا" />}
        {previewUrl && file.type.startsWith('image/') && <img src={previewUrl} alt="پیش‌نمایش" />}
        {!previewUrl && <FileText size={18} />}
        <span>{file.name}<small>{sizeLabel(file.size)}</small></span>
        <button type="button" disabled={sending} onClick={() => { setFile(null); clientId.current = null; setFailed(false); }} aria-label="حذف پیوست" data-testid="button-notes-remove-file"><Trash2 size={15} /></button>
      </div>}
      <textarea rows={4} value={text} disabled={sending} maxLength={6000} placeholder="یادداشت درباره این پرونده…" aria-label="متن یادداشت" data-testid="input-notes-text"
        onChange={e => { setText(e.target.value); clientId.current = null; setFailed(false); }}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <div className="cn-actions">
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,audio/*,application/pdf,.docx" onChange={e => { attach(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-notes-file" />
        <button type="button" className="cn-ib" onClick={() => fileInput.current?.click()} disabled={voice.recording || sending} aria-label="پیوست فایل" data-testid="button-notes-attach"><Paperclip size={19} /></button>
        <button type="button" className={`cn-ib${voice.recording ? ' rec' : ''}`} disabled={sending || (!voice.recording && !!file)}
          onClick={() => voice.recording ? voice.stop() : void voice.start()}
          aria-label={voice.recording ? 'پایان ضبط' : 'ضبط پیام صوتی'} data-testid="button-notes-record">{voice.recording ? <Square size={15} /> : <Mic size={19} />}</button>
        <span className="cn-hint">Ctrl+Enter</span>
        <button type="submit" className="cn-send" disabled={!canSend} data-testid="button-notes-send"><Send size={16} /> {sending ? 'در حال ارسال…' : 'ثبت یادداشت'}</button>
      </div>
    </form> : <div className="cn-readonly">شما فقط اجازهٔ مشاهدهٔ یادداشت‌ها را دارید.</div>}
  </aside>;
}
