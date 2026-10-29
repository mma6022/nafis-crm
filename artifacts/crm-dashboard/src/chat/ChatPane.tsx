import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { UserAvatar } from '@/components/UserAvatar';
import { AlertCircle, ArrowDown, Download, FileText, Image as ImageIcon, Mic, Paperclip, RefreshCw, Send, Smile, Square, Trash2, X } from 'lucide-react';
import type { ChatMessage, ChatPage } from '@/customer-portal/api';
import { CHAT_ACCEPT, acceptChatFile, chatFileKind } from './chat-files';
import { clock, dayLabel, fileTypeLabel, fsize, initials, runInfo } from './chat-ui';
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
const emojis = ['😀', '😊', '👍', '🙏', '❤️', '😂', '🌹', '✅', '⏳', '📎'];
const uuid = () => crypto.randomUUID();
const msgErr = (e: unknown) => e instanceof Error ? e.message : 'ارسال انجام نشد.';
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const SIZE_ERR = 'حجم فایل نباید بیشتر از ۱۶ مگابایت باشد.';
const TYPE_ERR = 'قالب فایل پشتیبانی نمی‌شود؛ تصویر، PDF، Word یا فایل صوتی معتبر ارسال کنید.';
const EMPTY_ERR = 'فایل خالی است؛ فایل دیگری انتخاب کنید.';
const withBase = (u: string | null) => !u ? null : /^(https?:)?\/\//.test(u) || !u.startsWith('/') ? u : `${import.meta.env.BASE_URL.replace(/\/$/, '')}${u}`;

/** Message body (no avatar). Shared by sent and pending messages. */
function Body({ m }: { m: ChatMessage }) {
  const url = withBase(m.fileUrl);
  const fk = chatFileKind(m.mimeType, m.fileName);
  return <>
    {m.kind === 'image' && url && <a className="nf-ph" href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={m.fileName || 'تصویر'} loading="lazy" /></a>}
    {m.kind === 'audio' && url && <audio controls preload="none" src={url} aria-label="پیام صوتی" />}
    {m.kind === 'file' && url && <a className="fl" href={url} download={m.fileName || undefined}>
      <span className={`ft ${fk === 'pdf' ? 'pdf' : ''}`}><FileText /></span>
      <span className="fi"><span className="fn">{m.fileName || 'فایل'}</span><span className="fs">{fileTypeLabel(m.mimeType, m.fileName)} · {fsize(m.fileSize)}</span></span>
      <span className="dl" aria-label="دریافت"><Download /></span></a>}
    {m.text && <div className="tx">{m.text}</div>}
  </>;
}

export function ChatPane({ adapter, visibleSelected = true, me }: { adapter: ChatAdapter; visibleSelected?: boolean; me?: { id: number; name: string } | null }) {
  const ad = useRef(adapter); ad.current = adapter;
  const staffSide = adapter.mine === 'staff';
  const [latest, setLatest] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [lastRead, setLastRead] = useState<number | null>(null);
  // «N پیام تازه» divider: fixed at the first unread incoming message when the thread opened.
  const [divider, setDivider] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<File | null>(null);
  const [bad, setBad] = useState<{ name: string; size: number; error: string } | null>(null);
  const [error, setError] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [jump, setJump] = useState(false);
  const [focus, setFocus] = useState(false);
  const [drag, setDrag] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const readSent = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const discardRec = useRef(false);
  const toNum = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Number(v);

  const fetchLatest = useCallback(async (initial: boolean) => {
    try {
      const page = await ad.current.load();
      setLatest(page.items); setLastRead(page.lastReadId); setStatus('ok');
      if (initial) {
        setOlder([]); setCursor(toNum(page.nextCursor));
        const first = page.items.find(m => m.senderType !== ad.current.mine && (page.lastReadId == null || m.id > page.lastReadId));
        setDivider(first ? first.id : null);
      }
    } catch (e) { if (initial) { setStatus('error'); setError(msgErr(e)); } }
  }, []);
  useEffect(() => {
    setStatus('loading'); setLatest([]); setOlder([]); setPending([]); setError(''); setDraft(null); setBad(null); setDivider(null); setJump(false);
    readSent.current = 0; stick.current = true;
    void fetchLatest(true);
    const t = setInterval(() => { if (visible()) void fetchLatest(false); }, 4000);
    return () => clearInterval(t);
  }, [adapter.key, fetchLatest]);

  const items = useMemo(() => {
    const map = new Map<number, ChatMessage>();
    [...older, ...latest].forEach(m => map.set(m.id, m));
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [older, latest]);
  const newCount = divider == null ? 0 : items.filter(m => m.id >= divider && m.senderType !== adapter.mine).length;
  const senderKey = (m: ChatMessage) => m.senderType === 'staff' ? `s${m.senderId ?? m.senderName}` : 'c';
  const runs = useMemo(() => runInfo(items, senderKey, m => m.createdAt, m => m.id === divider), [items, divider]);

  // Open at the «پیام تازه» divider if there is one, otherwise at the bottom.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'ok' || opened.current === adapter.key || !box.current) return;
    opened.current = adapter.key;
    const el = divider != null ? box.current.querySelector<HTMLElement>('[data-divider]') : null;
    if (el) { el.scrollIntoView({ block: 'start' }); stick.current = false; } else box.current.scrollTop = box.current.scrollHeight;
  }, [status, adapter.key, divider]);
  const lastCount = useRef(0);
  useEffect(() => {
    const grew = items.length + pending.length > lastCount.current; lastCount.current = items.length + pending.length;
    if (!box.current || opened.current !== adapter.key) return;
    if (stick.current) box.current.scrollTop = box.current.scrollHeight;
    else if (grew && items[items.length - 1]?.senderType !== adapter.mine) setJump(true);
  }, [items, pending.length, adapter.key, adapter.mine]);
  const toBottom = () => { stick.current = true; setJump(false); if (box.current) box.current.scrollTop = box.current.scrollHeight; };

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

  // Retry keeps the same clientId so the server's idempotency check holds.
  const deliver = async (p: Pending) => {
    setPending(list => list.some(x => x.clientId === p.clientId) ? list.map(x => x.clientId === p.clientId ? { ...x, failed: false } : x) : [...list, { ...p, failed: false }]);
    try { const m = await ad.current.send(p.clientId, p.text, p.file); stick.current = true; setLatest(l => l.some(x => x.id === m.id) ? l : [...l, m]); setPending(list => list.filter(x => x.clientId !== p.clientId)); ad.current.onActivity?.(); }
    catch (e) { setPending(list => list.map(x => x.clientId === p.clientId ? { ...x, failed: true, error: msgErr(e) } : x)); }
  };
  // The servers accept text + file in one request (customer-chat.ts / internal-chat.ts), so the caption travels with the file.
  const submit = () => {
    const t = text.trim(); if (!t && !draft) return;
    const file = draft ?? undefined;
    setText(''); setDraft(null); setEmojiOpen(false); setError(''); stick.current = true; void deliver({ clientId: uuid(), text: t, file, failed: false });
  };
  const pickFile = (raw: File | undefined) => {
    if (!raw) return;
    const check = acceptChatFile(raw);
    if (!check.ok) { setDraft(null); setBad({ name: raw.name, size: raw.size, error: check.reason === 'size' ? SIZE_ERR : check.reason === 'type' ? TYPE_ERR : EMPTY_ERR }); return; }
    setBad(null); setError(''); setDraft(check.file);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files?.[0]); };

  useEffect(() => { if (!recording) return; const t = setInterval(() => setSecs(s => s + 1), 1000); return () => clearInterval(t); }, [recording]);
  const toggleRec = async () => {
    if (recording) { recorder.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('ضبط صدا در این مرورگر پشتیبانی نمی‌شود؛ می‌توانید فایل صوتی پیوست کنید.'); fileInput.current?.click(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      discardRec.current = false;
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); setRecording(false); recorder.current = null;
        if (discardRec.current) return;
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) { setError('صدایی ضبط نشد.'); return; }
        const check = acceptChatFile(new File([blob], `voice-${Date.now()}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
        if (!check.ok) { setError(check.reason === 'size' ? SIZE_ERR : TYPE_ERR); return; }
        stick.current = true; void deliver({ clientId: uuid(), text: '', file: check.file, failed: false });
      };
      recorder.current = rec; rec.start(); setSecs(0); setRecording(true); setError('');
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد. از تنظیمات مرورگر مجاز کنید یا فایل صوتی پیوست کنید.' : 'میکروفون در دسترس نیست؛ فایل صوتی پیوست کنید.');
    }
  };
  const cancelRec = () => { discardRec.current = true; recorder.current?.stop(); };
  useEffect(() => () => { if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop(); recorder.current.stream.getTracks().forEach(t => t.stop()); } }, []);

  // Avatars: staff photo for every staff sender (me too) on the staff side; the customer is initials only.
  const avatarFor = (m: { senderType: string; senderId?: number | null; senderName: string | null }) => m.senderType === 'staff' && staffSide
    ? <UserAvatar userId={m.senderId} name={m.senderName} size={32} className="nf-av" />
    : <span className="avatar user-avatar nf-av nf-av-cus" aria-hidden="true" style={{ width: 32, height: 32, fontSize: 12 }}>{initials(m.senderName)}</span>;
  const showAvatar = (mine: boolean) => staffSide || !mine;
  const draftKind = draft ? chatFileKind(draft.type, draft.name) : null;
  const canSend = !!text.trim() || !!draft;

  return <>
    <div className={`nf-msgwrap ${drag ? 'drag' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="tg-msgs nf-msgs" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (stick.current) setJump(false); }} aria-live="polite" data-testid="chat-messages">
        {status === 'loading' && <div className="tg-empty" role="status">در حال دریافت گفتگو…</div>}
        {status === 'error' && <div className="tg-empty err" role="alert"><AlertCircle /><p>{error}</p><button type="button" className="nf-btn s sm" onClick={() => { setStatus('loading'); void fetchLatest(true); }} data-testid="button-chat-retry"><RefreshCw size={18} /> تلاش دوباره</button></div>}
        {status === 'ok' && cursor != null && <button type="button" onClick={() => void loadOlder()} disabled={moreBusy} className="nf-older" data-testid="button-chat-older">{moreBusy ? 'در حال دریافت…' : 'پیام‌های قدیمی‌تر'}</button>}
        {status === 'ok' && !items.length && !pending.length && <div className="tg-empty">هنوز پیامی ردوبدل نشده است. اولین پیام را بفرستید.</div>}
        {items.map((m, i) => {
          const r = runs[i]; const mine = m.senderType === adapter.mine; const media = m.kind === 'image' && !m.text;
          return <div key={m.id} className="nf-mgrp">
            {r.newDay && <div className="nf-day">{dayLabel(m.createdAt)}</div>}
            {r.newDivider && newCount > 0 && <div className="nf-new" data-divider>{newCount.toLocaleString('fa-IR')} پیام تازه</div>}
            <div className={`mr ${mine ? 'out' : 'in'} ${r.first ? 'gap' : ''}`}>
              {showAvatar(mine) && <span className="mav">{r.last && avatarFor(m)}</span>}
              <div className={`m ${mine ? 'out' : 'in'} ${r.first ? '' : 'cont'}`} data-testid={`chat-message-${m.id}`}>
                {r.first && m.senderType === 'staff' && staffSide && <div className="snd">{m.senderName}</div>}
                <div className={`b ${media ? 'media' : ''}`}><Body m={m} /><div className="meta">{clock(m.createdAt)}</div></div>
              </div>
            </div>
          </div>;
        })}
        {pending.map((p, i) => {
          const prevMine = i > 0 || items[items.length - 1]?.senderType === adapter.mine && (!me || items[items.length - 1]?.senderId === me.id);
          const last = i === pending.length - 1;
          const kind = p.file ? chatFileKind(p.file.type, p.file.name) : null;
          return <div key={p.clientId} className={`mr out ${prevMine ? '' : 'gap'}`}>
            {staffSide && <span className="mav">{last && (me ? <UserAvatar userId={me.id} name={me.name} size={32} className="nf-av" /> : null)}</span>}
            <div className={`m out ${p.failed ? 'fail' : 'pend'} ${prevMine ? 'cont' : ''}`} data-testid={`chat-pending-${p.clientId}`}>
              <div className="b">
                {p.file && <div className="fl"><span className={`ft ${kind === 'pdf' ? 'pdf' : ''}`}>{kind === 'image' ? <ImageIcon /> : kind === 'audio' ? <Mic /> : <FileText />}</span><span className="fi"><span className="fn">{p.file.name}</span><span className="fs">{fileTypeLabel(p.file.type, p.file.name)} · {fsize(p.file.size)}</span></span></div>}
                {p.text && <div className="tx">{p.text}</div>}
                <div className="meta">{p.failed ? 'ارسال نشد' : <><span className="spin" aria-hidden="true" />در حال ارسال…</>}</div>
              </div>
              {p.failed && <div className="failbar" role="alert">
                <span className="why"><AlertCircle />{p.error}</span>
                <button type="button" className="nf-btn s" onClick={() => void deliver(p)} data-testid="button-chat-resend"><RefreshCw size={16} /> تلاش دوباره</button>
                <button type="button" className="nf-btn g" onClick={() => setPending(list => list.filter(x => x.clientId !== p.clientId))} data-testid="button-chat-discard"><Trash2 size={16} /> حذف</button>
              </div>}
            </div>
          </div>;
        })}
      </div>
      {jump && <button type="button" className="nf-jump" onClick={toBottom} data-testid="button-chat-jump"><ArrowDown /> پیام تازه</button>}
      {drag && <div className="nf-drop" aria-hidden="true"><Paperclip /> فایل را اینجا رها کنید</div>}
    </div>
    <div className="tg-compose nf-comp">
      {error && status === 'ok' && <div className="cerr" role="alert"><AlertCircle />{error}</div>}
      {bad && <div className="att bad" role="alert" data-testid="chat-file-error">
        <span className="ft"><AlertCircle /></span><span className="fi"><span className="fn">{bad.name}</span><span className="fs">{bad.error}</span></span>
        <button type="button" className="ib" onClick={() => setBad(null)} aria-label="بستن"><X /></button></div>}
      {draft && <div className="att" data-testid="chat-file-ready">
        <span className={`ft ${draftKind === 'pdf' ? 'pdf' : ''}`}>{draftKind === 'image' ? <ImageIcon /> : draftKind === 'audio' ? <Mic /> : <FileText />}</span>
        <span className="fi"><span className="fn">{draft.name}</span><span className="fs">{fileTypeLabel(draft.type, draft.name)} · {fsize(draft.size)} — می‌توانید توضیح هم بنویسید</span></span>
        <button type="button" className="ib" onClick={() => setDraft(null)} aria-label="برداشتن فایل" data-testid="button-chat-remove-file"><X /></button></div>}
      {emojiOpen && <div className="tg-emoji">{emojis.map(e => <button type="button" key={e} onClick={() => setText(t => t + e)} aria-label={`درج ${e}`}>{e}</button>)}</div>}
      <form className="cbar" onSubmit={e => { e.preventDefault(); if (recording) { recorder.current?.stop(); return; } submit(); }}>
        <input ref={fileInput} type="file" hidden accept={CHAT_ACCEPT} onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-chat-file" />
        {recording ? <>
          <button type="button" className="ib" onClick={cancelRec} aria-label="لغو ضبط" data-testid="button-chat-cancel-record"><Trash2 /></button>
          <div className="recbar" role="status"><span className="dot" /><span className="t">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span><span className="lbl">در حال ضبط…</span></div>
        </> : <>
          <button type="button" className="ib" aria-label="پیوست فایل" onClick={() => fileInput.current?.click()} data-testid="button-chat-attach"><Paperclip /></button>
          <div className={`fld ${focus ? 'on' : ''}`}>
            <textarea rows={1} value={text} placeholder={draft ? 'توضیح فایل (اختیاری)…' : 'پیام…'} aria-label="متن پیام" onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} data-testid="input-chat-text" />
            <button type="button" className="ib" aria-label="ایموجی" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(v => !v)}><Smile /></button>
          </div>
        </>}
        {canSend || recording ? <button type="submit" className="sendb" aria-label={recording ? 'پایان ضبط و ارسال' : 'ارسال'} data-testid={recording ? 'button-chat-record' : 'button-chat-send'}><Send /></button>
          : <button type="button" className="sendb mic" aria-label="ضبط پیام صوتی" onClick={() => void toggleRec()} data-testid="button-chat-record">{recording ? <Square /> : <Mic />}</button>}
      </form>
      <div className="chint"><span><Paperclip />عکس، PDF، Word یا صدا — تا ۱۶ مگابایت</span><span className="d-only"><kbd>Enter</kbd> ارسال · <kbd>Shift+Enter</kbd> خط جدید</span></div>
    </div>
  </>;
}
