import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserAvatar } from '@/components/UserAvatar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCheck, FileText, Mic, Paperclip, Pencil, RefreshCw, Reply, Search, Send, Smile, SmilePlus, Square, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useLocation, useSearch } from 'wouter';
import { teamChatApi, type TeamConversation, type TeamMessage, type TeamUser, type TeamPage } from './api';
import { inboxKey, useTeamInbox } from './hooks';
import '@/chat/chat.css';
import './ic.css';

const Picker = lazy(() => import('emoji-picker-react'));
const MAX = 20 * 1024 * 1024;
const uuid = () => crypto.randomUUID();
const errMsg = (e: unknown) => e instanceof Error ? e.message : 'عملیات انجام نشد.';
const clock = (v: string) => new Date(v).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
const visible = () => document.visibilityState === 'visible';
const fsize = (n: number | null) => n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const withBase = (u: string | null) => !u ? null : /^(https?:)?\/\//.test(u) || !u.startsWith('/') ? u : `${import.meta.env.BASE_URL.replace(/\/$/, '')}${u}`;
const roleFa: Record<string, string> = { admin: 'مدیر', salesperson: 'کارشناس فروش', registrar: 'ثبت‌کننده' };
const Av = ({ name, online }: { name: string; online?: boolean }) => <span className="tg-av">{name?.[0] || '؟'}{online && <span className="tg-dot" title="آنلاین" />}</span>;

export default function InternalChatPage() {
  const inbox = useTeamInbox(true);
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [pickOpen, setPickOpen] = useState(false);
  const sel = new URLSearchParams(search).get('conversation');
  const select = (id: string | null) => navigate(id ? `/internal-chat?conversation=${encodeURIComponent(id)}` : '/internal-chat');
  const data = inbox.data;
  const current = data?.conversations.find(c => c.id === sel) ?? null;
  const groups = data?.conversations.filter(c => c.kind === 'group') ?? [];
  const directs = data?.conversations.filter(c => c.kind === 'direct') ?? [];
  const startDirect = useMutation({
    mutationFn: (u: number) => teamChatApi.direct(u),
    onSuccess: c => { void qc.invalidateQueries({ queryKey: inboxKey }); setPickOpen(false); select(c.id); },
  });
  const title = (c: TeamConversation) => c.kind === 'direct' ? (c.members.find(m => m.id !== data?.myId)?.name ?? c.name) : c.name;
  const Row = (c: TeamConversation) => {
    const other = c.kind === 'direct' ? c.members.find(m => m.id !== data?.myId) : undefined;
    return <button type="button" key={c.id} className="tg-row" aria-current={c.id === sel} onClick={() => select(c.id)} data-testid={`row-team-${c.id}`}>
      {c.kind === 'group' ? <span className="tg-av"><Users size={18} /></span> : <Av name={title(c)} online={other?.online} />}
      <span className="tg-meta"><strong>{title(c)}</strong><small>{c.lastMessage ? `${c.lastMessage.senderName}: ${c.lastMessage.kind === 'deleted' ? 'پیام حذف شد' : c.lastMessage.text || c.lastMessage.fileName || 'پیوست'}` : 'بدون پیام'}</small></span>
      {c.unreadCount > 0 && <span className="tg-badge" aria-label={`${c.unreadCount} پیام خوانده‌نشده`}>{c.unreadCount.toLocaleString('fa-IR')}</span>}
    </button>;
  };
  return <div className={`tg ic ${sel ? 'has-sel' : ''}`} data-testid="page-internal-chat">
    <aside className="tg-list" aria-label="فهرست گفتگوهای داخلی">
      {inbox.isLoading && <div className="tg-empty" role="status">در حال دریافت گفتگوها…</div>}
      {inbox.isError && !data && <div className="tg-empty" role="alert">{errMsg(inbox.error)}<br /><button type="button" className="tg-ib" onClick={() => void inbox.refetch()} aria-label="تلاش دوباره" data-testid="button-inbox-retry"><RefreshCw size={16} /></button></div>}
      {data && <div className="tg-rows">
        {!data.conversations.length && !data.users.length && <div className="tg-empty" data-testid="status-no-allowed">دسترسی شما به هیچ گفتگوی داخلی یا همکاری تعریف نشده است.</div>}
        {groups.length > 0 && <div className="ic-sec">گروه‌ها</div>}{groups.map(Row)}
        <div className="ic-sec">گفتگوی خصوصی<button type="button" onClick={() => setPickOpen(true)} data-testid="button-new-dm"><UserPlus size={13} style={{ verticalAlign: 'middle' }} /> جدید</button></div>
        {directs.map(Row)}
        {!directs.length && data.users.length > 0 && <div className="tg-empty">با «جدید» یک گفتگوی خصوصی شروع کنید.</div>}
      </div>}
    </aside>
    <section className="tg-pane" aria-label="گفتگو">
      {sel && data ? current
        ? <ConversationPane key={`${data.myId}:${current.id}`} conv={current} myId={data.myId} title={title(current)} onBack={() => select(null)} />
        : <div className="tg-empty" role="alert">این گفتگو وجود ندارد یا به آن دسترسی ندارید.<br /><button type="button" className="tg-file" onClick={() => select(null)}>بازگشت</button></div>
        : <div className="tg-empty">یک گفتگو را انتخاب کنید.</div>}
    </section>
    {pickOpen && data && <div className="ic-sheet" onClick={() => setPickOpen(false)}><div role="dialog" aria-label="گفتگوی جدید" onClick={e => e.stopPropagation()}>
      <h3>گفتگوی خصوصی با همکار</h3>
      {startDirect.isError && <div className="tg-err" role="alert">{errMsg(startDirect.error)}</div>}
      <div className="tg-rows">{data.users.filter(u => u.id !== data.myId).map((u: TeamUser) => <button type="button" key={u.id} className="tg-row" disabled={startDirect.isPending} onClick={() => startDirect.mutate(u.id)} data-testid={`row-user-${u.id}`}><Av name={u.name} online={u.online} /><span className="tg-meta"><strong>{u.name}</strong><small>{roleFa[u.role] ?? u.role}</small></span></button>)}
        {!data.users.some(u => u.id !== data.myId) && <div className="tg-empty">همکاری برای گفتگو در دسترس نیست.</div>}</div>
      <div className="ic-bar"><span /><button type="button" onClick={() => setPickOpen(false)}>بستن</button></div>
    </div></div>}
  </div>;
}

function ConversationPane({ conv, myId, title, onBack }: { conv: TeamConversation; myId: number; title: string; onBack: () => void }) {
  const id = conv.id;
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [searching, setSearching] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const messageKey = ['internal-chat', 'messages', myId, id, term] as const;
  const page = useQuery({ queryKey: messageKey, queryFn: () => teamChatApi.messages(id, { q: term || undefined }), refetchInterval: 3000, refetchOnWindowFocus: true, refetchOnReconnect: true });
  const [older, setOlder] = useState<TeamMessage[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [sent, setSent] = useState<TeamMessage[]>([]);
  const termRef = useRef(term); termRef.current = term;
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOlder([]); setOlderMore(null); setSent([]); }, [term]);

  const items = useMemo(() => {
    const m = new Map<number, TeamMessage>();
    [...older, ...(term ? [] : sent), ...(page.data?.messages ?? [])].forEach(x => m.set(x.id, x));
    return [...m.values()].sort((a, b) => a.id - b.id);
  }, [older, page.data, sent, term]);
  const hasMore = olderMore ?? page.data?.hasMore ?? false;
  const patch = useCallback((m: TeamMessage) => {
    if (!alive.current) return;
    setOlder(items => items.map(x => x.id === m.id ? m : x));
    setSent(items => items.map(x => x.id === m.id ? m : x));
    qc.setQueryData<TeamPage>(['internal-chat', 'messages', myId, id, term], old => old ? { ...old, messages: old.messages.map(x => x.id === m.id ? m : x) } : old);
  }, [qc, myId, id, term]);

  const box = useRef<HTMLDivElement>(null); const stick = useRef(true);
  useEffect(() => { if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight; }, [items.length]);
  const loadOlder = async () => {
    const first = items[0]; if (!first || moreBusy) return;
    const forTerm = term; setMoreBusy(true);
    const el = box.current, prev = el?.scrollHeight ?? 0;
    try {
      const p = await teamChatApi.messages(id, { beforeId: first.id, q: forTerm || undefined });
      if (!alive.current || termRef.current !== forTerm) return;
      stick.current = false; setOlder(o => [...p.messages, ...o]); setOlderMore(p.hasMore);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prev; });
    } catch { /* retry via button */ } finally { if (alive.current) setMoreBusy(false); }
  };

  // read receipts: only latest incoming, selected + visible
  const readSent = useRef(0);
  const readM = useMutation({ mutationFn: (last: number) => teamChatApi.read(id, last), onSuccess: () => void qc.invalidateQueries({ queryKey: inboxKey }), onError: () => { readSent.current = 0; } });
  const readFn = useRef(readM.mutate); readFn.current = readM.mutate;
  useEffect(() => {
    if (term) return;
    const mark = () => {
      if (!visible()) return;
      const last = [...items].reverse().find(m => m.senderId !== myId);
      if (!last || last.id <= readSent.current || last.readBy.includes(myId) && conv.unreadCount === 0) return;
      readSent.current = last.id; readFn.current(last.id);
    };
    mark(); document.addEventListener('visibilitychange', mark); window.addEventListener('focus', mark);
    return () => { document.removeEventListener('visibilitychange', mark); window.removeEventListener('focus', mark); };
  }, [items, myId, term, conv.unreadCount]);

  // composer
  const [text, setText] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [reply, setReply] = useState<TeamMessage | null>(null);
  const [error, setError] = useState(''); const [emojiOpen, setEmojiOpen] = useState(false);
  const clientId = useRef(uuid());
  const fileInput = useRef<HTMLInputElement>(null);
  const fileUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  const sendM = useMutation({
    mutationFn: (v: { cid: string; text: string; file?: File; replyToId?: number }) => teamChatApi.send(id, v.cid, v.text, v.file, v.replyToId),
    onSuccess: (m, v) => {
      if (!alive.current) return;
      if (clientId.current === v.cid) { clientId.current = uuid(); setText(''); setFile(null); setReply(null); setError(''); }
      stick.current = true; setSent(s => s.some(x => x.id === m.id) ? s : [...s, m]);
      void qc.invalidateQueries({ queryKey: ['internal-chat'] });
    },
    onError: e => { if (alive.current) setError(errMsg(e)); },
  });
  const submit = () => {
    if (sendM.isPending || (!text.trim() && !file)) return;
    setEmojiOpen(false); setError(''); stopTyping();
    sendM.mutate({ cid: clientId.current, text: text.trim(), file: file ?? undefined, replyToId: reply?.id });
  };
  const attach = (f?: File) => {
    if (!f) return;
    if (f.size > MAX) { setError('حجم فایل نباید بیشتر از ۲۰ مگابایت باشد.'); return; }
    if (sendM.isError) clientId.current = uuid();
    setError(''); setFile(f);
  };

  // typing
  const typingAt = useRef(0); const typingOff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTyping = () => { clearTimeout(typingOff.current); if (typingAt.current) { typingAt.current = 0; void teamChatApi.typing(id, false).catch(() => undefined); } };
  const onType = (v: string) => {
    if (sendM.isError && v !== text) clientId.current = uuid();
    setText(v); if (sendM.isError) setError('');
    if (!v) return stopTyping();
    if (Date.now() - typingAt.current > 2500) { typingAt.current = Date.now(); void teamChatApi.typing(id, true).catch(() => undefined); }
    clearTimeout(typingOff.current); typingOff.current = setTimeout(stopTyping, 3500);
  };
  useEffect(() => () => { clearTimeout(typingOff.current); if (typingAt.current) void teamChatApi.typing(id, false).catch(() => undefined); }, [id]);

  // voice
  const [rec, setRec] = useState(false); const [secs, setSecs] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderStarting = useRef(false);
  useEffect(() => { if (!rec) return; const t = setInterval(() => setSecs(s => s + 1), 1000); return () => clearInterval(t); }, [rec]);
  const record = async () => {
    if (recorderStarting.current || recorder.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('ضبط صدا در این مرورگر پشتیبانی نمی‌شود؛ می‌توانید فایل صوتی پیوست کنید.'); return; }
    recorderStarting.current = true;
    let acquiredStream: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      acquiredStream = stream;
      if (!alive.current) { stream.getTracks().forEach(t => t.stop()); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks: Blob[] = [];
      r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (!alive.current) return; setRec(false);
        const type = (r.mimeType || 'audio/webm').split(';')[0]; const blob = new Blob(chunks, { type });
        if (!blob.size) { setError('صدایی ضبط نشد.'); return; }
        attach(new File([blob], `voice-${Date.now()}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
      };
      recorder.current = r; setSecs(0); r.start(); setRec(true); setError('');
    } catch (e) {
      acquiredStream?.getTracks().forEach(t => t.stop());
      recorder.current = null;
      if (alive.current) { setRec(false); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد.' : 'میکروفون در دسترس نیست؛ فایل صوتی پیوست کنید.'); }
    } finally { recorderStarting.current = false; }
  };
  const cancelRec = () => { const r = recorder.current; if (r) { r.onstop = null; r.stream.getTracks().forEach(t => t.stop()); if (r.state !== 'inactive') r.stop(); recorder.current = null; } setRec(false); };
  useEffect(() => () => { const r = recorder.current; if (r) { r.onstop = null; r.stream.getTracks().forEach(t => t.stop()); if (r.state !== 'inactive') r.stop(); } }, []);

  const typing = (page.data?.typingUsers ?? []).filter(u => u.id !== myId);
  const sub = conv.kind === 'group' ? conv.members.map(m => m.name).join('، ') : (conv.members.find(m => m.id !== myId)?.online ? 'آنلاین' : '');
  return <>
    <div className="tg-head">
      <button type="button" className="tg-ib tg-back" onClick={onBack} aria-label="بازگشت به فهرست"><ArrowRight size={18} /></button>
      {conv.kind === 'group' ? <span className="tg-av"><Users size={18} /></span> : <Av name={title} />}
      <div className="tg-meta"><strong>{title}</strong><small>{sub}</small></div>
      {searching && <input type="search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="جست‌وجو در پیام‌ها" aria-label="جست‌وجو در پیام‌ها" style={{ padding: '6px 10px', borderRadius: 16, border: '1px solid #ddd', font: 'inherit', width: 180 }} data-testid="input-team-search" />}
      <button type="button" className="tg-ib" aria-label={searching ? 'بستن جست‌وجو' : 'جست‌وجو'} onClick={() => { setSearching(s => !s); setQ(''); }} data-testid="button-team-search">{searching ? <X size={18} /> : <Search size={18} />}</button>
    </div>
    <div className="tg-msgs" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-live="polite" data-testid="team-messages">
      {page.isLoading && <div className="tg-empty" role="status">در حال دریافت پیام‌ها…</div>}
      {page.isError && !page.data && <div className="tg-empty" role="alert">{errMsg(page.error)}<br /><button type="button" className="tg-ib" onClick={() => void page.refetch()} aria-label="تلاش دوباره" data-testid="button-messages-retry"><RefreshCw size={16} /></button></div>}
      {page.data && hasMore && <button type="button" className="tg-file" style={{ alignSelf: 'center', background: 'none', border: 0, cursor: 'pointer', color: '#1d3a5f' }} onClick={() => void loadOlder()} disabled={moreBusy} data-testid="button-team-older">{moreBusy ? 'در حال دریافت…' : 'پیام‌های قدیمی‌تر'}</button>}
      {page.data && !items.length && <div className="tg-empty">{term ? 'پیامی با این عبارت پیدا نشد.' : 'هنوز پیامی ثبت نشده است. اولین پیام را بفرستید.'}</div>}
      {items.map(m => <Msg key={m.id} m={m} mine={m.senderId === myId} myId={myId} group={conv.kind === 'group'} onReply={() => { if (!sendM.isPending && !rec) { if (sendM.isError && reply?.id !== m.id) clientId.current = uuid(); setReply(m); } }} onPatch={patch} />)}
    </div>
    <div className="ic-typing" aria-live="polite">{typing.length ? `${typing.map(u => u.name).join('، ')} در حال نوشتن…` : ''}</div>
    {reply && <div className="ic-bar"><Reply size={14} /><span>پاسخ به {reply.senderName}: {reply.text || reply.fileName}</span><button type="button" disabled={sendM.isPending} onClick={() => { if (sendM.isError) clientId.current = uuid(); setReply(null); }} aria-label="لغو پاسخ"><X size={14} /></button></div>}
    {file && <div className="ic-bar" data-testid="team-attachment">
      {file.type.startsWith('audio/') && fileUrl ? <audio controls src={fileUrl} aria-label="پیش‌نمایش پیام صوتی" /> : file.type.startsWith('image/') && fileUrl ? <img src={fileUrl} alt="" style={{ height: 36, borderRadius: 6 }} /> : <FileText size={18} />}
      <span>{file.name} · {fsize(file.size)}</span><button type="button" disabled={sendM.isPending} onClick={() => { setFile(null); if (sendM.isError) clientId.current = uuid(); }} aria-label="حذف پیوست" data-testid="button-remove-attachment"><X size={16} /></button></div>}
    {rec && <div className="ic-bar danger" role="status"><Mic size={14} /><span>در حال ضبط… {secs.toLocaleString('fa-IR')} ثانیه</span><button type="button" onClick={cancelRec} data-testid="button-cancel-record">لغو</button></div>}
    {error && <div className="tg-err ic-bar danger" role="alert"><span>{error}</span>{sendM.isError && <button type="button" onClick={submit} disabled={sendM.isPending} data-testid="button-team-retry">تلاش مجدد ارسال</button>}</div>}
    <div className="ic-compose-wrap">
      {emojiOpen && <div className="ic-emoji"><Suspense fallback={<div className="tg-empty">…</div>}><Picker emojiStyle={'native' as import('emoji-picker-react').EmojiStyle} onEmojiClick={d => onType(text + d.emoji)} searchPlaceHolder="جست‌وجوی ایموجی" width={Math.min(340, window.innerWidth - 24)} height={380} lazyLoadEmojis /></Suspense></div>}
      <form className="tg-compose" onSubmit={e => { e.preventDefault(); submit(); }}>
        <input ref={fileInput} type="file" hidden disabled={sendM.isPending || rec} onChange={e => { attach(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-team-file" />
        <button type="button" className="tg-ib" disabled={sendM.isPending || rec} aria-label="ایموجی" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(v => !v)} data-testid="button-team-emoji"><Smile size={20} /></button>
        <button type="button" className="tg-ib" disabled={sendM.isPending || rec} aria-label="پیوست فایل" onClick={() => fileInput.current?.click()} data-testid="button-team-attach"><Paperclip size={20} /></button>
        <textarea rows={1} value={text} disabled={sendM.isPending || rec} maxLength={4000} placeholder="پیام…" aria-label="متن پیام" onChange={e => onType(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} data-testid="input-team-text" />
        {text.trim() || file ? <button type="submit" className="tg-ib send" disabled={sendM.isPending} aria-label="ارسال" data-testid="button-team-send"><Send size={18} /></button>
          : <button type="button" className={`tg-ib ${rec ? 'rec' : ''}`} aria-label={rec ? 'پایان ضبط' : 'ضبط پیام صوتی'} onClick={() => rec ? recorder.current?.stop() : void record()} data-testid="button-team-record">{rec ? <Square size={16} /> : <Mic size={20} />}</button>}
      </form>
    </div>
  </>;
}

function Msg({ m, mine, myId, group, onReply, onPatch }: { m: TeamMessage; mine: boolean; myId: number; group: boolean; onReply: () => void; onPatch: (m: TeamMessage) => void }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(m.text);
  const [confirm, setConfirm] = useState(false); const [pick, setPick] = useState(false); const [err, setErr] = useState('');
  const fail = (e: unknown) => setErr(errMsg(e));
  const edit = useMutation({ mutationFn: () => teamChatApi.edit(m.id, draft.trim()), onSuccess: r => { onPatch(r); setEditing(false); setErr(''); }, onError: fail });
  const del = useMutation({ mutationFn: () => teamChatApi.remove(m.id), onSuccess: r => { onPatch(r); setConfirm(false); }, onError: fail });
  const react = useMutation({ mutationFn: (e: string) => teamChatApi.react(m.id, e), onSuccess: r => { onPatch(r); setPick(false); }, onError: fail });
  const url = withBase(m.fileUrl);
  const deleted = m.kind === 'deleted';
  const seen = mine && m.readBy.some(u => u !== myId);
  const avatar = <UserAvatar userId={m.senderId} name={m.senderName} size={30} />;
  return <div className={`ic-row ${mine ? 'mine' : ''}`}>{!mine && avatar}<div className={`ic-msg ${mine ? 'mine' : ''}`} data-testid={`team-message-${m.id}`}>
    <div className="tg-msg" style={mine ? undefined : { background: '#fff' }} >
      {!mine && group && <div className="who">{m.senderName}</div>}
      {m.replyTo && <div className="ic-reply"><b>{m.replyTo.senderName}</b>{m.replyTo.text}</div>}
      {deleted ? <em style={{ opacity: .6 }}>این پیام حذف شد.</em> : <>
        {m.kind === 'image' && url && <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={m.fileName || 'تصویر'} loading="lazy" /></a>}
        {m.kind === 'audio' && url && <audio controls preload="none" src={url} aria-label="پیام صوتی" />}
        {m.kind === 'video' && url && <video controls preload="metadata" src={url} style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8 }} />}
        {m.kind === 'file' && url && <a className="tg-file" href={url} download={m.fileName || undefined}><FileText size={20} /><span>{m.fileName || 'فایل'}<br /><small>{fsize(m.fileSize)} · دریافت</small></span></a>}
        {editing ? <div className="ic-edit"><textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={4000} aria-label="ویرایش پیام" data-testid="input-edit-message" />
          <div className="ic-tools" style={{ opacity: 1 }}><button type="button" disabled={edit.isPending || (!draft.trim() && m.kind === 'text')} onClick={() => edit.mutate()} data-testid="button-save-edit">ذخیره</button><button type="button" onClick={() => { setEditing(false); setDraft(m.text); }}>انصراف</button></div></div>
          : m.text && <div>{m.text}</div>}
      </>}
      <small>{m.senderName} · {clock(m.createdAt)}{m.editedAt && !deleted ? ' · ویرایش‌شده' : ''} {mine && !deleted && (seen ? <CheckCheck size={12} style={{ verticalAlign: 'middle', color: '#2f7d5b' }} aria-label="خوانده شد" /> : <Check size={12} style={{ verticalAlign: 'middle' }} aria-label="ارسال شد" />)}</small>
    </div>
    {m.reactions.length > 0 && <div className="ic-react">{m.reactions.map(r => <button type="button" key={r.emoji} aria-pressed={r.mine} disabled={react.isPending} onClick={() => react.mutate(r.emoji)} data-testid={`reaction-${m.id}-${r.emoji}`}>{r.emoji} {r.count.toLocaleString('fa-IR')}</button>)}</div>}
    {err && <div className="tg-err" role="alert">{err}</div>}
    {confirm && <div className="ic-bar danger" role="alertdialog"><span>این پیام حذف شود؟</span><button type="button" disabled={del.isPending} onClick={() => del.mutate()} data-testid="button-confirm-delete">حذف</button><button type="button" onClick={() => setConfirm(false)}>انصراف</button></div>}
    {!deleted && <div className="ic-tools">
      <button type="button" onClick={onReply} aria-label="پاسخ" data-testid={`button-reply-${m.id}`}><Reply size={13} /></button>
      <button type="button" onClick={() => setPick(p => !p)} aria-label="واکنش" data-testid={`button-react-${m.id}`}><SmilePlus size={13} /></button>
      {mine && m.kind === 'text' && <button type="button" onClick={() => { setDraft(m.text); setEditing(true); }} aria-label="ویرایش" data-testid={`button-edit-${m.id}`}><Pencil size={13} /></button>}
      {mine && <button type="button" onClick={() => setConfirm(true)} aria-label="حذف" data-testid={`button-delete-${m.id}`}><Trash2 size={13} /></button>}
    </div>}
    {pick && <div className="ic-pop" style={mine ? { insetInlineStart: 'auto', insetInlineEnd: 0 } : undefined}><Suspense fallback={null}><Picker emojiStyle={'native' as import('emoji-picker-react').EmojiStyle} reactionsDefaultOpen={false} onEmojiClick={d => react.mutate(d.emoji)} searchPlaceHolder="جست‌وجوی ایموجی" width={Math.min(320, window.innerWidth - 24)} height={360} lazyLoadEmojis /></Suspense></div>}
  </div>{mine && avatar}</div>;
}
