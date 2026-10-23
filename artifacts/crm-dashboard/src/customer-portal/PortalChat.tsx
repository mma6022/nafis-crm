// «گفتگو» (HANDOFF part 2 §2): one thread with the case expert + sending documents.
// Transport is the existing /api/customer-portal/chat API; uploads use XHR only to show progress and allow «لغو».
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertCircle, ArrowRight, Camera, Check, Download, FileText, Image as ImageIcon, Mic, MessageSquare,
  Paperclip, Plus, RefreshCw, Send, Square, Trash2, Upload, WifiOff, X,
} from 'lucide-react';
import { portalApi, type ChatMessage } from './api';
import { ExpertPickerButton } from './ExpertPicker';
import { Icon, fa, money } from './PortalUi';
import { HelpCard, useCaseExpert } from './Portal2Ui';
import { CHAT_ACCEPT_DOCS, CHAT_ACCEPT_IMAGES, acceptChatFile, chatFileKind, type ChatFileKind } from '@/chat/chat-files';

type Pick = { id: string; file: File; url: string | null; bad: '' | 'type' | 'size' | 'empty' };
type Out = { clientId: string; text: string; file?: File; url: string | null; state: 'queued' | 'up' | 'failed'; pct: number; error?: string; at: number };
const uuid = () => crypto.randomUUID();
const clock = (v: string | number) => new Date(v).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (v: string) => new Date(v).toDateString();
const dayLabel = (v: string) => {
  const d = new Date(v); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'امروز';
  if (d.toDateString() === y.toDateString()) return 'دیروز';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
};
const bytes = (n?: number | null) => n == null ? '' : n >= 1048576 ? `${fa((n / 1048576).toFixed(1).replace('.', '٫'))} مگابایت` : `${money(Math.max(1, Math.ceil(n / 1024)))} کیلوبایت`;
const shortBytes = (n: number) => n >= 1048576 ? `${fa((n / 1048576).toFixed(1).replace('.', '٫'))} م.ب` : `${money(Math.max(1, Math.ceil(n / 1024)))} ک.ب`;
const withBase = (u: string | null) => !u ? null : /^(https?:)?\/\//.test(u) || !u.startsWith('/') ? u : `${import.meta.env.BASE_URL.replace(/\/$/, '')}${u}`;
const KIND_LABEL: Record<ChatFileKind, string> = { image: 'عکس', pdf: 'PDF', word: 'Word', audio: 'صوت', file: 'فایل' };
const badText = (p: Pick) => p.bad === 'size' ? `${p.file.name} بیشتر از ۱۶ مگابایت است. فایل کوچک‌تری انتخاب کنید.`
  : p.bad === 'empty' ? `${p.file.name} خالی است.` : `این نوع فایل پذیرفته نمی‌شود (${p.file.name}). عکس، PDF، Word یا فایل صوتی بفرستید.`;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const toNum = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Number(v);

/** POST /api/customer-portal/chat/messages with upload progress (same body as portalApi.chatSend). */
function sendWithProgress(clientId: string, text: string, file: File | undefined, onPct: (n: number) => void, signal: { xhr?: XMLHttpRequest }) {
  if (!file) return portalApi.chatSend(clientId, text);
  return new Promise<ChatMessage>((resolve, reject) => {
    const xhr = new XMLHttpRequest(); signal.xhr = xhr;
    const d = new FormData(); d.append('clientId', clientId); d.append('text', text); d.append('file', file);
    xhr.open('POST', '/api/customer-portal/chat/messages'); xhr.withCredentials = true; xhr.responseType = 'json';
    xhr.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      const body = xhr.response as { message?: string; id?: number } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) { resolve(body as ChatMessage); return; }
      if (xhr.status === 401) window.dispatchEvent(new Event('cp-session-expired'));
      const persian = typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message) ? body.message : '';
      reject(new Error(persian || (xhr.status === 429 ? 'کمی صبر کنید و دوباره ارسال کنید.' : 'ارسال نشد. اتصال اینترنت را بررسی کنید و دوباره بفرستید.')));
    };
    xhr.onerror = () => reject(new Error('ارسال نشد. اتصال اینترنت را بررسی کنید و دوباره بفرستید.'));
    xhr.onabort = () => reject(new Error('abort'));
    xhr.send(d);
  });
}

function Paper() { return <div className="nfp-thumb"><div className="nfp-paper"><i /><i /><i /><i /><i /></div></div>; }
function FileBadge({ kind, ext }: { kind: ChatFileKind; ext?: string }) {
  return <span className={`nfp-fi${kind === 'word' || kind === 'audio' ? ' nfp-w' : kind === 'image' ? ' nfp-img' : ''}`}>{kind === 'pdf' ? 'PDF' : kind === 'word' ? 'DOCX' : kind === 'audio' ? <Icon icon={Mic} small /> : (ext || 'FILE').toUpperCase()}</span>;
}

function Bubble({ m, mine }: { m: ChatMessage; mine: boolean }) {
  const url = withBase(m.fileUrl);
  const kind = chatFileKind(m.mimeType, m.fileName);
  const sender = !mine && <span className="nfp-sn">{m.senderName || 'کارشناس'} · کارشناس فروش</span>;
  const meta = <div className="nfp-meta">{clock(m.createdAt)}{mine && <span className="nfp-ok"><Icon icon={Check} />ارسال شد</span>}</div>;
  let body = null;
  if (m.kind === 'image' && url) body = <div className="nfp-att"><a className="nfp-thumb-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`باز کردن تصویر ${m.fileName || ''}`}><div className="nfp-thumb"><img src={url} alt={m.fileName || 'تصویر'} loading="lazy" /></div></a>{m.text && <span className="nfp-cap">{m.text}</span>}</div>;
  else if (m.kind === 'audio' && url) body = <div className="nfp-att"><audio controls preload="none" src={url} aria-label="پیام صوتی" />{m.text && <span className="nfp-cap">{m.text}</span>}</div>;
  else if (m.kind === 'file' && url) body = <div className="nfp-att"><a className="nfp-file" href={url} download={m.fileName || undefined} aria-label={`دانلود ${m.fileName || 'فایل'}`}><FileBadge kind={kind} /><span className="nfp-ft"><b>{m.fileName || 'فایل'}</b><small>{bytes(m.fileSize)}</small></span><span className="nfp-dl"><Icon icon={Download} small /></span></a>{m.text && <span className="nfp-cap">{m.text}</span>}</div>;
  else body = <div className="nfp-bub">{m.text}</div>;
  return <div className={`nfp-m${mine ? ' nfp-me' : ''}`} data-testid={`chat-message-${m.id}`}>{sender}{body}{meta}</div>;
}

function OutBubble({ o, onCancel, onRetry, onRemove }: { o: Out; onCancel: () => void; onRetry: () => void; onRemove: () => void }) {
  const kind = o.file ? chatFileKind(o.file.type, o.file.name) : null;
  const visual = !o.file ? null : kind === 'image' && o.url ? <div className="nfp-thumb"><img src={o.url} alt="" /></div>
    : <div className="nfp-file"><FileBadge kind={kind!} /><span className="nfp-ft"><b>{o.file.name}</b><small>{o.state === 'queued' ? 'در صف ارسال…' : bytes(o.file.size)}</small></span></div>;
  if (o.state === 'failed') return <div className="nfp-m nfp-me" role="alert"><div className={o.file ? 'nfp-att nfp-fail' : 'nfp-att nfp-fail'}>
    {visual}{o.text && (o.file ? <span className="nfp-cap">{o.text}</span> : <span className="nfp-cap">{o.text}</span>)}
    <p className="nfp-fail-msg"><Icon icon={AlertCircle} /><span>{o.error || 'ارسال نشد. اتصال اینترنت را بررسی کنید و دوباره بفرستید.'}</span></p>
    <div className="nfp-acts2"><button type="button" className="nfp-mini-btn nfp-pri" onClick={onRetry} data-testid="button-chat-resend"><Icon icon={RefreshCw} small />ارسال دوباره</button><button type="button" className="nfp-mini-btn nfp-dng" onClick={onRemove}><Icon icon={Trash2} small />حذف</button></div>
  </div><div className="nfp-meta">{clock(o.at)}</div></div>;
  if (!o.file) return <div className="nfp-m nfp-me" aria-live="polite"><div className="nfp-bub" style={{ opacity: .7 }}>{o.text}</div><div className="nfp-meta">در حال ارسال…</div></div>;
  return <div className="nfp-m nfp-me" aria-live="polite"><div className="nfp-att nfp-up">{visual}{o.text && <span className="nfp-cap">{o.text}</span>}
    <div className="nfp-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={o.pct} aria-label="پیشرفت ارسال"><span style={{ width: `${o.pct}%` }} /></div>
    {o.state === 'up' && <div className="nfp-up-row"><Icon icon={Upload} small />در حال ارسال… {fa(o.pct)}٪ از {bytes(o.file.size)}<button type="button" className="nfp-mini-btn nfp-x" onClick={onCancel} aria-label="لغو ارسال"><Icon icon={X} small />لغو</button></div>}
    {o.state === 'queued' && <div className="nfp-up-row">در صف ارسال…<button type="button" className="nfp-mini-btn nfp-x" onClick={onCancel} aria-label="لغو ارسال"><Icon icon={X} small />لغو</button></div>}
  </div></div>;
}

export function PortalChat() {
  const qc = useQueryClient();
  const { assigned, caseNo } = useCaseExpert();
  const thread = useQuery({ queryKey: ['customer', 'chat-thread'], queryFn: portalApi.chatThread, refetchInterval: 8000 });
  const [latest, setLatest] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [lastRead, setLastRead] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [moreBusy, setMoreBusy] = useState(false);
  const [out, setOut] = useState<Out[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [caption, setCaption] = useState('');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState(false);
  const [drag, setDrag] = useState(false);
  const [recording, setRecording] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const stick = useRef(true);
  const readSent = useRef(0);
  const active = useRef<{ xhr?: XMLHttpRequest; id?: string }>({});
  const recorder = useRef<MediaRecorder | null>(null);
  const attachBtn = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const docs = useRef<HTMLInputElement>(null);

  const fetchLatest = useCallback(async (initial: boolean) => {
    try {
      const page = await portalApi.chatMessages();
      setLatest(page.items); setLastRead(page.lastReadId); setStatus('ok');
      if (initial) { setOlder([]); setCursor(toNum(page.nextCursor)); }
    } catch { if (initial) setStatus('error'); }
  }, []);
  useEffect(() => {
    void fetchLatest(true);
    const t = setInterval(() => { if (visible()) void fetchLatest(false); }, 4000);
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [fetchLatest]);
  const items = useMemo(() => {
    const map = new Map<number, ChatMessage>();
    [...older, ...latest].forEach(m => map.set(m.id, m));
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [older, latest]);
  useEffect(() => { if (stick.current && status === 'ok') window.scrollTo({ top: document.documentElement.scrollHeight }); }, [items.length, out.length, status]);
  useEffect(() => {
    const onScroll = () => { const el = document.documentElement; stick.current = el.scrollHeight - window.scrollY - window.innerHeight < 120; };
    window.addEventListener('scroll', onScroll, { passive: true }); return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // Mark read only while the page is visible.
  useEffect(() => {
    const mark = () => {
      if (!visible()) return;
      const last = [...items].reverse().find(m => m.senderType !== 'customer');
      if (!last || last.id <= readSent.current || (lastRead != null && last.id <= lastRead)) return;
      readSent.current = last.id;
      portalApi.chatRead(last.id).then(() => { setLastRead(last.id); void qc.invalidateQueries({ queryKey: ['customer', 'chat-thread'] }); }).catch(() => { readSent.current = 0; });
    };
    mark(); document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [items, lastRead, qc]);
  const loadOlder = async () => {
    if (cursor == null || moreBusy) return;
    setMoreBusy(true); const prev = document.documentElement.scrollHeight;
    try { const page = await portalApi.chatMessages(cursor); stick.current = false; setOlder(o => [...page.items, ...o]); setCursor(toNum(page.nextCursor));
      requestAnimationFrame(() => window.scrollBy(0, document.documentElement.scrollHeight - prev)); }
    catch { setNote('پیام‌های قدیمی‌تر دریافت نشد. دوباره تلاش کنید.'); } finally { setMoreBusy(false); }
  };

  /* ---------- sending: one upload at a time (the server allows two in flight per customer) ---------- */
  const busy = useRef(false);
  const outRef = useRef<Out[]>([]);
  const setOutSync = useCallback((fn: (l: Out[]) => Out[]) => { outRef.current = fn(outRef.current); setOut(outRef.current); }, []);
  const pump = useCallback(() => {
    if (busy.current) return;
    const next = outRef.current.find(o => o.state === 'queued');
    if (!next) return;
    busy.current = true; active.current = { id: next.clientId };
    setOutSync(l => l.map(o => o.clientId === next.clientId ? { ...o, state: 'up', pct: 0 } : o));
    const drop = (l: Out[]) => l.filter(o => { if (o.clientId === next.clientId && o.url) URL.revokeObjectURL(o.url); return o.clientId !== next.clientId; });
    void sendWithProgress(next.clientId, next.text, next.file, pct => setOutSync(l => l.map(o => o.clientId === next.clientId ? { ...o, pct } : o)), active.current)
      .then(m => {
        stick.current = true;
        setLatest(l => l.some(x => x.id === m.id) ? l : [...l, m]);
        setOutSync(drop);
        void qc.invalidateQueries({ queryKey: ['customer', 'chat-thread'] });
      })
      .catch((e: unknown) => {
        const aborted = e instanceof Error && e.message === 'abort';
        setOutSync(l => aborted ? drop(l) : l.map(o => o.clientId === next.clientId ? { ...o, state: 'failed', error: e instanceof Error ? e.message : undefined } : o));
      })
      .finally(() => { busy.current = false; active.current = {}; setTimeout(() => pump(), 0); });
  }, [qc, setOutSync]);
  const enqueue = (entries: Array<{ text: string; file?: File }>) => {
    stick.current = true;
    setOutSync(l => [...l, ...entries.map(e => ({ clientId: uuid(), text: e.text, file: e.file, url: e.file && chatFileKind(e.file.type, e.file.name) === 'image' ? URL.createObjectURL(e.file) : null, state: 'queued' as const, pct: 0, at: Date.now() }))]);
    setTimeout(() => pump(), 0);
  };
  const cancel = (id: string) => {
    if (active.current.id === id) { active.current.xhr?.abort(); return; }
    setOutSync(l => l.filter(o => { if (o.clientId === id && o.url) URL.revokeObjectURL(o.url); return o.clientId !== id; }));
  };
  // Retry keeps the same clientId so the server de-duplicates a send that actually arrived.
  const retry = (id: string) => { setOutSync(l => l.map(o => o.clientId === id ? { ...o, state: 'queued', pct: 0, error: undefined } : o)); setTimeout(() => pump(), 0); };
  const submitText = () => { const t = text.trim(); if (!t) return; setText(''); setNote(''); enqueue([{ text: t.slice(0, 6000) }]); };

  /* ---------- picking files ---------- */
  const addFiles = (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    // Copy now: the input's FileList is live and is emptied when its value is reset right after this call.
    const files = Array.from(list);
    setSheet(false); setNote('');
    setPicks(p => [...p, ...files.map(f => { const c = acceptChatFile(f); const file = c.ok ? c.file : f;
      return { id: uuid(), file, url: c.ok && chatFileKind(file.type, file.name) === 'image' ? URL.createObjectURL(file) : null, bad: c.ok ? '' as const : c.reason }; })]);
  };
  const removePick = (id: string) => setPicks(p => p.filter(x => { if (x.id === id && x.url) URL.revokeObjectURL(x.url); return x.id !== id; }));
  const clearPicks = () => { picks.forEach(p => p.url && URL.revokeObjectURL(p.url)); setPicks([]); setCaption(''); };
  const good = picks.filter(p => !p.bad);
  const bad = picks.filter(p => p.bad);
  const sendPicks = () => {
    if (!good.length || bad.length) return;
    // The caption travels with the first file only, so it is not repeated under every attachment.
    enqueue(good.map((p, i) => ({ text: i === 0 ? caption.trim().slice(0, 6000) : '', file: p.file })));
    setPicks([]); setCaption('');
  };
  const openSheet = () => setSheet(true);
  const closeSheet = useCallback(() => { setSheet(false); attachBtn.current?.focus(); }, []);
  useEffect(() => {
    if (!sheet) return;
    const first = sheetRef.current?.querySelector<HTMLElement>('button:not([hidden])'); first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSheet(); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [sheet, closeSheet]);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); };

  /* ---------- voice (same recorder as ChatPane) ---------- */
  const toggleRec = async () => {
    if (recording) { recorder.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setNote('ضبط صدا در این مرورگر پشتیبانی نمی‌شود؛ فایل صوتی را از «مدرک» انتخاب کنید.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); setRecording(false);
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) { setNote('صدایی ضبط نشد.'); return; }
        const c = acceptChatFile(new File([blob], `voice-${Date.now()}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
        if (!c.ok) { setNote(c.reason === 'size' ? 'پیام صوتی بیشتر از ۱۶ مگابایت است؛ کوتاه‌تر ضبط کنید.' : 'این مرورگر قالب صوتی پذیرفتنی ضبط نمی‌کند؛ فایل صوتی را از «مدرک» انتخاب کنید.'); return; }
        enqueue([{ text: '', file: c.file }]);
      };
      recorder.current = rec; rec.start(); setRecording(true); setNote('');
    } catch (e) {
      setNote(e instanceof DOMException && e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد. از تنظیمات مرورگر مجاز کنید یا فایل صوتی بفرستید.' : 'میکروفون در دسترس نیست؛ فایل صوتی بفرستید.');
    }
  };
  useEffect(() => () => { if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop(); recorder.current.stream.getTracks().forEach(t => t.stop()); } }, []);

  /* ---------- render ---------- */
  const t = thread.data;
  const name = t?.expertName || 'کارشناس فروش';
  const isOnline = !!t?.expertOnline && !thread.isError;
  const myFiles = items.filter(m => m.senderType === 'customer' && m.kind !== 'text' && m.fileUrl).reverse();
  const inputs = <>
    <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} data-testid="input-chat-camera" />
    <input ref={gallery} type="file" hidden multiple accept={CHAT_ACCEPT_IMAGES} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} data-testid="input-chat-gallery" />
    <input ref={docs} type="file" hidden multiple accept={CHAT_ACCEPT_DOCS} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} data-testid="input-chat-file" /></>;

  let body;
  if (status === 'loading') body = <div className="nfp-msgs" aria-busy="true"><p className="nfp-sr" role="status">در حال دریافت گفتگو…</p>
    {[60, 45, 70, 40].map((w, i) => <div key={i} className={`nfp-m${i % 2 ? ' nfp-me' : ''}`}><div className="nfp-sk" style={{ height: i === 2 ? 120 : 52, width: w * 3, maxWidth: '70vw', borderRadius: 18 }} /></div>)}</div>;
  else if (status === 'error') body = <div className="nfp-msgs"><div className="nfp-empty nfp-err" role="alert"><span className="nfp-big"><Icon icon={AlertCircle} /></span><h2>گفتگو بارگیری نشد</h2><p>اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.</p>
    <button type="button" className="nf-btn nf-btn--secondary" onClick={() => { setStatus('loading'); void fetchLatest(true); }} data-testid="button-chat-retry"><Icon icon={RefreshCw} small />تلاش دوباره</button></div></div>;
  else if (!items.length && !out.length) body = <div className="nfp-msgs"><div className="nfp-empty"><span className="nfp-big"><Icon icon={MessageSquare} /></span><h2>اولین پیام را بفرستید</h2><p>سؤال‌تان را بنویسید یا مدارک پرونده را همین‌جا بفرستید. کارشناس فروش در همین صفحه جواب می‌دهد.</p>
    <button type="button" className="nf-btn nf-btn--primary" onClick={openSheet} data-testid="button-chat-empty-attach"><Icon icon={Paperclip} small />ارسال مدرک</button></div></div>;
  else {
    let prevDay = '';
    body = <div className="nfp-msgs" data-testid="chat-messages">
      {cursor != null && <button type="button" className="nf-btn nf-btn--text nf-btn--sm nfp-older" onClick={() => void loadOlder()} disabled={moreBusy} data-testid="button-chat-older">{moreBusy ? 'در حال دریافت…' : 'پیام‌های قدیمی‌تر'}</button>}
      {items.map(m => { const k = dayKey(m.createdAt); const sep = k !== prevDay; prevDay = k;
        return <div key={m.id} style={{ display: 'contents' }}>{sep && <span className="nfp-day">{dayLabel(m.createdAt)}</span>}<Bubble m={m} mine={m.senderType === 'customer'} /></div>; })}
      {out.map(o => <OutBubble key={o.clientId} o={o} onCancel={() => cancel(o.clientId)} onRetry={() => retry(o.clientId)} onRemove={() => cancel(o.clientId)} />)}
    </div>;
  }

  const preview = picks.length > 0 && <section className="nfp-pv" aria-labelledby="nfp-pvh">
    <div className="nfp-pv-h"><span id="nfp-pvh">آماده‌ی ارسال ({fa(picks.length)} فایل)</span><button type="button" className="nfp-mini-btn" onClick={clearPicks} aria-label="لغو و حذف همه"><Icon icon={X} small />لغو</button></div>
    <div className="nfp-pv-items">{picks.map(p => { const kind = chatFileKind(p.file.type, p.file.name); const ext = (p.file.name.split('.').pop() || '').toUpperCase();
      return <div key={p.id} className={`nfp-pv-it${p.bad ? ' nfp-bad' : ''}`}>{p.url ? <div className="nfp-thumb"><img src={p.url} alt="" /></div> : <div className="nfp-pdf">{kind === 'pdf' ? 'PDF' : kind === 'word' ? 'DOCX' : kind === 'audio' ? <Icon icon={Mic} /> : ext.slice(0, 5)}</div>}
        <small>{p.file.name} · {shortBytes(p.file.size)}</small><button type="button" className="nfp-rm" onClick={() => removePick(p.id)} aria-label={`حذف ${p.file.name}`}><Icon icon={X} /></button></div>; })}
      <button type="button" className="nfp-pv-add" onClick={openSheet}><Icon icon={Plus} />افزودن</button></div>
    {bad.map(p => <p key={p.id} className="nf-error" role="alert"><Icon icon={AlertCircle} small />{badText(p)}</p>)}
    <input className="nf-input" aria-label="توضیح برای فایل‌ها (اختیاری)" placeholder="توضیح (اختیاری)، مثلاً: فیش شهریور" value={caption} maxLength={6000} onChange={e => setCaption(e.target.value)} data-testid="input-chat-caption" />
    <button type="button" className="nf-btn nf-btn--primary nf-btn--block" aria-disabled={!good.length || bad.length > 0 || undefined} onClick={sendPicks} data-testid="button-chat-send-files"><Icon icon={Send} small />ارسال {fa(good.length)} فایل</button>
  </section>;

  const comp = status === 'ok' && <div className="nfp-comp">
    {!online && <p className="nf-error" role="status"><Icon icon={WifiOff} small />اتصال اینترنت قطع است. پیام‌ها بعد از وصل شدن، با «ارسال دوباره» فرستاده می‌شوند.</p>}
    {note && <p className="nf-error" role="alert"><Icon icon={AlertCircle} small />{note}</p>}
    {preview || <div className="nfp-comp-row">
      <button ref={attachBtn} type="button" className="nfp-attach-btn" aria-label="ارسال مدرک یا فایل" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(s => !s)} data-testid="button-chat-attach"><Icon icon={Paperclip} />مدرک</button>
      <textarea className="nfp-ta" rows={1} maxLength={6000} aria-label="متن پیام" placeholder={recording ? 'در حال ضبط… برای پایان، دکمه‌ی توقف را بزنید' : 'پیام خود را بنویسید…'} value={text} disabled={recording}
        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width:1024px)').matches) { e.preventDefault(); submitText(); } }} data-testid="input-chat-text" />
      {text.trim() ? <button type="button" className="nfp-send" aria-label="ارسال پیام" onClick={submitText} data-testid="button-chat-send"><Icon icon={Send} /></button>
        : <button type="button" className="nfp-send nfp-mic" aria-label={recording ? 'پایان ضبط و ارسال' : 'ضبط پیام صوتی'} aria-pressed={recording} onClick={() => void toggleRec()} data-testid="button-chat-record" style={recording ? { background: 'var(--nf-danger)', color: '#fff' } : undefined}><Icon icon={recording ? Square : Mic} /></button>}
    </div>}
  </div>;

  const pick = sheet && <><div className="nfp-scrim nfp-pop" aria-hidden="true" onClick={closeSheet} /><div ref={sheetRef} className="nfp-sheet nfp-pop" role="dialog" aria-modal="true" aria-labelledby="nfp-pk"><div className="nfp-grab" aria-hidden="true" />
    <h2 id="nfp-pk">ارسال مدرک</h2>
    <nav className="nfp-pick" aria-label="نوع مدرک">
      <button type="button" className="nfp-m-only" onClick={() => camera.current?.click()}><span className="nfp-ic"><Icon icon={Camera} /></span><span><b>عکس گرفتن با دوربین</b><small>برای کارت ملی، فیش یا هر برگه</small></span></button>
      <button type="button" onClick={() => gallery.current?.click()}><span className="nfp-ic"><Icon icon={ImageIcon} /></span><span><b>انتخاب عکس</b><small>JPG، PNG یا WEBP</small></span></button>
      <button type="button" onClick={() => docs.current?.click()}><span className="nfp-ic"><Icon icon={FileText} /></span><span><b>انتخاب فایل</b><small>PDF، Word (DOCX) یا فایل صوتی</small></span></button></nav>
    <div className="nfp-rules"><span>هر فایل حداکثر <b>۱۶ مگابایت</b>؛ چند فایل را می‌توانید با هم انتخاب کنید.</span></div></div></>;

  return <div className="nfp-cp-wrap" data-testid="page-customer-chat">
    <section className={`nfp-cp${drag ? ' nfp-drop' : ''}`} aria-label="گفتگو با کارشناس"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={e => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
      <div className="nfp-cp-hd"><Link className="nfp-back" href="/customer" aria-label="بازگشت"><Icon icon={ArrowRight} /></Link>
        <span className="nfp-av" aria-hidden="true">{name.replace(/^(خانم|آقای)\s+/, '').charAt(0)}<span className={`nfp-on${isOnline ? '' : ' nfp-off'}`} /></span>
        <span className="nfp-who2"><b data-testid="text-chat-expert">{name}</b><small className={isOnline ? undefined : 'nfp-off'} data-testid="text-expert-online">{thread.isError ? 'وضعیت نامشخص' : isOnline ? 'کارشناس پرونده · آنلاین' : 'آفلاین · پیام بگذارید، بعداً جواب می‌دهد'}</small></span>
        <ExpertPickerButton className="nfp-icon-btn" ariaLabel="تماس با کارشناس فروش" testId="button-chat-call" assigned={assigned} caseNo={caseNo} /></div>
      <div>{status === 'ok' && (items.length > 0 || out.length > 0) && <div className="nfp-docbar"><span className="nfp-ic"><Icon icon={Upload} /></span><span className="nfp-t"><b>مدارک را اینجا بفرستید</b><small>عکس، PDF، Word یا فایل صوتی</small></span>
        <button type="button" className="nf-btn nf-btn--secondary" onClick={openSheet} data-testid="button-chat-docbar"><Icon icon={Paperclip} small />ارسال مدرک</button></div>}{body}</div>
      {comp}{pick}{inputs}
    </section>
    <aside className="nfp-cp-side">
      <section className="nfp-card" aria-labelledby="nfp-sd"><div className="nfp-exp"><span className="nfp-av"><Icon icon={Upload} /></span><div><b id="nfp-sd">ارسال مدرک</b><small>عکس، PDF، Word یا صوت؛ هر فایل تا ۱۶ مگابایت</small></div></div>
        <div style={{ marginTop: 12 }}><button type="button" className="nf-btn nf-btn--primary nf-btn--block" onClick={() => docs.current?.click()} data-testid="button-chat-side-pick"><Icon icon={Paperclip} small />انتخاب فایل</button></div>
        <p className="nfp-muted" style={{ marginTop: 8 }}>فایل را می‌توانید روی همین صفحه بکشید و رها کنید.</p></section>
      <section className="nfp-card" aria-labelledby="nfp-fl"><h2 id="nfp-fl">فایل‌های این گفتگو</h2>{!myFiles.length ? <p className="nfp-muted">هنوز فایلی نفرستاده‌اید.</p>
        : <div className="nfp-list">{myFiles.slice(0, 8).map(m => { const k = chatFileKind(m.mimeType, m.fileName);
          return <a key={m.id} className="nfp-li" href={withBase(m.fileUrl) ?? undefined} target="_blank" rel="noopener noreferrer"><span className="nfp-ic nfp-ok"><Icon icon={k === 'image' ? ImageIcon : k === 'audio' ? Mic : FileText} small /></span>
            <span className="nfp-t"><b className={m.text ? undefined : 'nfp-ltr'}>{m.text || m.fileName || KIND_LABEL[k]}</b><small>{KIND_LABEL[k]} · {dayLabel(m.createdAt)} {clock(m.createdAt)}</small></span></a>; })}</div>}</section>
      <HelpCard title="ترجیح می‌دهید تلفنی صحبت کنید؟" text="یکی از کارشناس‌های فروش را انتخاب کنید." id="nfp-hc-chat" />
    </aside>
  </div>;
}
