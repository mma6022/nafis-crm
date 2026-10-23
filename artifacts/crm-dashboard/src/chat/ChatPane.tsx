import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserAvatar } from '@/components/UserAvatar';
import { FileText, Mic, Paperclip, RefreshCw, Send, Smile, Square } from 'lucide-react';
import type { ChatMessage, ChatPage } from '@/customer-portal/api';
import { CHAT_ACCEPT } from './chat-files';
import './chat.css';

export type ChatAdapter = {
  key: string;
  load: (beforeId?: number) => Promise<ChatPage>;
  send: (clientId: string, text: string, file?: File) => Promise<ChatMessage>;
  read: (lastMessageId: number) => Promise<unknown>;
  mine: 'customer' | 'staff';
  onActivity?: () => void;
};
type Pending = { clientId: string; text: string; file?: File; failed: boolean; error?: string };
const MAX = 16 * 1024 * 1024;
const emojis = ['😀', '😊', '👍', '🙏', '❤️', '😂', '🌹', '✅', '⏳', '📎'];
const uuid = () => crypto.randomUUID();
const msgErr = (e: unknown) => e instanceof Error ? e.message : 'ارسال انجام نشد.';
const clock = (v: string) => new Date(v).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const size = (n: number | null) => n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

const withBase = (u: string | null) => !u ? null : /^(https?:)?\/\//.test(u) || !u.startsWith('/') ? u : `${import.meta.env.BASE_URL.replace(/\/$/, '')}${u}`;
function Bubble({ m: raw, mine }: { m: ChatMessage; mine: boolean }) {
  const m = { ...raw, fileUrl: withBase(raw.fileUrl) };
  const avatar = <UserAvatar userId={m.senderType === 'staff' ? m.senderId : null} name={m.senderName} size={30} />;
  return <div className={`tg-row ${mine ? 'mine' : ''}`}>{!mine && avatar}<div className={`tg-msg ${mine ? 'mine' : ''}`} data-testid={`chat-message-${m.id}`}>
    {m.kind === 'image' && m.fileUrl && <a href={m.fileUrl} target="_blank" rel="noopener noreferrer"><img src={m.fileUrl} alt={m.fileName || 'تصویر'} loading="lazy" /></a>}
    {m.kind === 'audio' && m.fileUrl && <audio controls preload="none" src={m.fileUrl} aria-label="پیام صوتی" />}
    {m.kind === 'file' && m.fileUrl && <a className="tg-file" href={m.fileUrl} download={m.fileName || undefined}><FileText size={20} /><span>{m.fileName || 'فایل'}<br /><small>{size(m.fileSize)} · دریافت</small></span></a>}
    {m.text && <div>{m.text}</div>}<small>{clock(m.createdAt)}</small></div>{mine && avatar}</div>;
}

export function ChatPane({ adapter, visibleSelected = true }: { adapter: ChatAdapter; visibleSelected?: boolean }) {
  const ad = useRef(adapter); ad.current = adapter;
  const [latest, setLatest] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [lastRead, setLastRead] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const readSent = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const toNum = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Number(v);

  const fetchLatest = useCallback(async (initial: boolean) => {
    try {
      const page = await ad.current.load();
      setLatest(page.items); setLastRead(page.lastReadId); setStatus('ok');
      if (initial) { setOlder([]); setCursor(toNum(page.nextCursor)); }
    } catch (e) { if (initial) { setStatus('error'); setError(msgErr(e)); } }
  }, []);
  useEffect(() => {
    setStatus('loading'); setLatest([]); setOlder([]); setPending([]); setError(''); readSent.current = 0; stick.current = true;
    void fetchLatest(true);
    const t = setInterval(() => { if (visible()) void fetchLatest(false); }, 4000);
    return () => clearInterval(t);
  }, [adapter.key, fetchLatest]);

  const items = useMemo(() => {
    const map = new Map<number, ChatMessage>();
    [...older, ...latest].forEach(m => map.set(m.id, m));
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [older, latest]);
  // Client IDs are scoped to the original sender/thread and may collide in
  // merged history. Only the send acknowledgement can resolve a local retry.
  const shownPending = pending;

  useEffect(() => { if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight; }, [items.length, shownPending.length]);

  // Mark read only for the visible, selected conversation.
  useEffect(() => {
    if (!visibleSelected) return;
    const mark = () => {
      if (!visible()) return;
      const last = [...items].reverse().find(m => m.senderType !== ad.current.mine);
      if (!last || last.id <= readSent.current || (lastRead != null && last.id <= lastRead)) return;
      readSent.current = last.id;
      ad.current.read(last.id).then(() => { setLastRead(last.id); ad.current.onActivity?.(); }).catch(() => { readSent.current = 0; });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [items, lastRead, visibleSelected]);

  const loadOlder = async () => {
    if (cursor == null || moreBusy) return;
    setMoreBusy(true);
    const el = box.current, prev = el?.scrollHeight ?? 0;
    try { const page = await ad.current.load(cursor); stick.current = false; setOlder(o => [...page.items, ...o]); setCursor(toNum(page.nextCursor));
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prev; }); }
    catch (e) { setError(msgErr(e)); } finally { setMoreBusy(false); }
  };

  const deliver = async (p: Pending) => {
    setPending(list => list.some(x => x.clientId === p.clientId) ? list.map(x => x.clientId === p.clientId ? { ...x, failed: false } : x) : [...list, { ...p, failed: false }]);
    try { const m = await ad.current.send(p.clientId, p.text, p.file); stick.current = true; setLatest(l => l.some(x => x.id === m.id) ? l : [...l, m]); setPending(list => list.filter(x => x.clientId !== p.clientId)); ad.current.onActivity?.(); }
    catch (e) { setPending(list => list.map(x => x.clientId === p.clientId ? { ...x, failed: true, error: msgErr(e) } : x)); }
  };
  const submit = () => {
    const t = text.trim(); if (!t) return;
    setText(''); setEmojiOpen(false); setError(''); void deliver({ clientId: uuid(), text: t, failed: false });
  };
  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX) { setError('حجم فایل نباید بیشتر از ۱۶ مگابایت باشد.'); return; }
    setError(''); void deliver({ clientId: uuid(), text: '', file, failed: false });
  };
  const toggleRec = async () => {
    if (recording) { recorder.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('ضبط صدا در این مرورگر پشتیبانی نمی‌شود؛ می‌توانید فایل صوتی پیوست کنید.'); fileInput.current?.click(); return; }
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
        if (!blob.size) { setError('صدایی ضبط نشد.'); return; }
        pickFile(new File([blob], `voice-${Date.now()}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
      };
      recorder.current = rec; rec.start(); setRecording(true); setError('');
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد. از تنظیمات مرورگر مجاز کنید یا فایل صوتی پیوست کنید.' : 'میکروفون در دسترس نیست؛ فایل صوتی پیوست کنید.');
    }
  };
  useEffect(() => () => { if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop(); recorder.current.stream.getTracks().forEach(t => t.stop()); } }, []);

  return <>
    <div className="tg-msgs" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-live="polite" data-testid="chat-messages">
      {status === 'loading' && <div className="tg-empty" role="status">در حال دریافت گفتگو…</div>}
      {status === 'error' && <div className="tg-empty" role="alert">{error}<br /><button type="button" className="tg-ib" onClick={() => { setStatus('loading'); void fetchLatest(true); }} aria-label="تلاش دوباره" data-testid="button-chat-retry"><RefreshCw size={16} /></button></div>}
      {status === 'ok' && cursor != null && <button type="button" onClick={() => void loadOlder()} disabled={moreBusy} className="tg-file" style={{ alignSelf: 'center', background: 'none', border: 0, cursor: 'pointer', color: '#1d3a5f' }} data-testid="button-chat-older">{moreBusy ? 'در حال دریافت…' : 'پیام‌های قدیمی‌تر'}</button>}
      {status === 'ok' && !items.length && !shownPending.length && <div className="tg-empty">هنوز پیامی ردوبدل نشده است. اولین پیام را بفرستید.</div>}
      {items.map(m => <Bubble key={m.id} m={m} mine={m.senderType === adapter.mine} />)}
      {shownPending.map(p => <div key={p.clientId} className="tg-msg mine" style={{ opacity: p.failed ? 1 : .6 }}>
        <div>{p.text || p.file?.name}</div>
        {p.failed ? <small role="alert">{p.error} <button type="button" onClick={() => void deliver(p)} style={{ border: 0, background: 'none', color: '#a3361f', cursor: 'pointer' }} data-testid="button-chat-resend">ارسال دوباره</button></small> : <small>در حال ارسال…</small>}</div>)}
    </div>
    {error && status === 'ok' && <div className="tg-err" role="alert">{error}</div>}
    {emojiOpen && <div className="tg-emoji">{emojis.map(e => <button type="button" key={e} onClick={() => setText(t => t + e)} aria-label={`درج ${e}`}>{e}</button>)}</div>}
    <form className="tg-compose" onSubmit={e => { e.preventDefault(); submit(); }}>
      <input ref={fileInput} type="file" hidden accept={CHAT_ACCEPT} onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-chat-file" />
      <button type="button" className="tg-ib" aria-label="ایموجی" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(v => !v)}><Smile size={20} /></button>
      <button type="button" className="tg-ib" aria-label="پیوست فایل" onClick={() => fileInput.current?.click()} data-testid="button-chat-attach"><Paperclip size={20} /></button>
      <textarea rows={1} value={text} maxLength={4000} placeholder="پیام…" aria-label="متن پیام" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} data-testid="input-chat-text" />
      {text.trim() ? <button type="submit" className="tg-ib send" aria-label="ارسال" data-testid="button-chat-send"><Send size={18} /></button>
        : <button type="button" className={`tg-ib ${recording ? 'rec' : ''}`} aria-label={recording ? 'پایان ضبط و ارسال' : 'ضبط پیام صوتی'} onClick={() => void toggleRec()} data-testid="button-chat-record">{recording ? <Square size={16} /> : <Mic size={20} />}</button>}
    </form>
  </>;
}
