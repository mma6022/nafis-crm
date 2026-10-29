import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowDown, ArrowRight, Bug, Check, CheckCheck, Download, FileText, Mic, MoreVertical, Paperclip, Pencil, RefreshCw, Reply, Search, Send, Smile, SmilePlus, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useLocation, useSearch } from 'wouter';
import { useDiagnostics } from '@/diagnostics/DiagnosticsProvider';
import { GroupAvatar, StaffAvatar, clock, dayLabel, fileTypeLabel, fsize, kindIcon, listTime, runInfo } from '@/chat/chat-ui';
import { teamChatApi, type TeamConversation, type TeamMessage, type TeamUser, type TeamPage } from './api';
import { inboxKey, useTeamInbox } from './hooks';
import '@/chat/chat.css';
import './ic.css';

const Picker = lazy(() => import('emoji-picker-react'));
const MAX = 20 * 1024 * 1024;
const uuid = () => crypto.randomUUID();
const errMsg = (e: unknown) => e instanceof Error ? e.message : 'عملیات انجام نشد.';
const visible = () => document.visibilityState === 'visible';
const withBase = (u: string | null) => !u ? null : /^(https?:)?\/\//.test(u) || !u.startsWith('/') ? u : `${import.meta.env.BASE_URL.replace(/\/$/, '')}${u}`;
// Built-in role keys only; custom role titles need the server to send `roleName` (HANDOFF §10-ج-3).
const roleFa: Record<string, string> = { admin: 'مدیر سیستم', salesperson: 'کارشناس فروش', registrar: 'ثبت‌نام‌کننده' };
const roleLabel = (r: string) => roleFa[r] ?? 'همکار';
const preview = (m: TeamMessage | null) => !m ? 'بدون پیام' : m.kind === 'deleted' ? 'پیام حذف شد' : m.text || m.fileName || 'پیوست';

export default function InternalChatPage() {
  const inbox = useTeamInbox(true);
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [pickOpen, setPickOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = new URLSearchParams(search).get('conversation');
  const select = (id: string | null) => navigate(id ? `/internal-chat?conversation=${encodeURIComponent(id)}` : '/internal-chat');
  const data = inbox.data;
  const current = data?.conversations.find(c => c.id === sel) ?? null;
  const title = (c: TeamConversation) => c.kind === 'direct' ? (c.members.find(m => m.id !== data?.myId)?.name ?? c.name) : c.name;
  const match = (c: TeamConversation) => !q.trim() || title(c).includes(q.trim());
  const groups = data?.conversations.filter(c => c.kind === 'group' && match(c)) ?? [];
  const directs = data?.conversations.filter(c => c.kind === 'direct' && match(c)) ?? [];
  const unreadConvs = data?.conversations.filter(c => c.unreadCount > 0).length ?? 0;
  const startDirect = useMutation({
    mutationFn: (u: number) => teamChatApi.direct(u),
    onSuccess: c => { void qc.invalidateQueries({ queryKey: inboxKey }); setPickOpen(false); select(c.id); },
  });
  const Row = (c: TeamConversation) => {
    const other = c.kind === 'direct' ? c.members.find(m => m.id !== data?.myId) : undefined;
    const lm = c.lastMessage; const mineLast = lm?.senderId === data?.myId;
    return <button type="button" key={c.id} className={`nf-row ${c.id === sel ? 'sel' : ''} ${c.unreadCount > 0 ? 'unread' : ''}`} aria-current={c.id === sel} onClick={() => select(c.id)} data-testid={`row-team-${c.id}`}>
      {other ? <StaffAvatar userId={other.id} name={other.name} online={other.online} /> : <GroupAvatar />}
      <span className="r-body">
        <span className="r-top"><span className="r-name">{title(c)}</span>{lm && <span className="r-time">{listTime(lm.createdAt)}</span>}</span>
        <span className="r-bot"><span className="r-prev">{lm && lm.kind !== 'deleted' && kindIcon(lm.kind)}<span>{lm && (c.kind === 'group' || mineLast) && <b>{mineLast ? 'شما' : lm.senderName}: </b>}{preview(lm)}</span></span>
          {c.unreadCount > 0 && <span className="r-badge" aria-label={`${c.unreadCount} پیام خوانده‌نشده`}>{c.unreadCount.toLocaleString('fa-IR')}</span>}</span>
      </span>
    </button>;
  };
  return <div className={`tg ic nf-chat ${sel ? 'has-sel' : ''}`} data-testid="page-internal-chat">
    <aside className="tg-list nf-list" aria-label="فهرست گفتگوهای داخلی">
      <div className="nf-lhead">
        <label className="nf-search"><Search aria-hidden="true" /><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="جست‌وجوی گفتگو یا همکار" aria-label="جست‌وجوی گفتگو" data-testid="input-team-list-search" />
          {q && <button type="button" className="clr" onClick={() => setQ('')} aria-label="پاک کردن جست‌وجو"><X /></button>}</label>
        {data && !q && <div className="nf-sum">{data.unreadCount > 0 ? <><b>{data.unreadCount.toLocaleString('fa-IR')} پیام خوانده‌نشده</b> در {unreadConvs.toLocaleString('fa-IR')} گفتگو</> : 'همهٔ پیام‌ها خوانده شده‌اند.'}</div>}
      </div>
      {inbox.isLoading && <div aria-busy="true" role="status" aria-label="در حال دریافت گفتگوها…">{[0, 1, 2, 3].map(i => <div key={i} className="nf-skrow"><span className="c nf-sk" /><span><span className="l nf-sk" style={{ width: '55%' }} /><span className="l nf-sk" style={{ width: '80%' }} /></span></div>)}</div>}
      {inbox.isError && !data && <div className="tg-empty err" role="alert"><AlertCircle /><p>{errMsg(inbox.error)}</p><button type="button" className="nf-btn s sm" onClick={() => void inbox.refetch()} data-testid="button-inbox-retry"><RefreshCw size={18} /> تلاش دوباره</button></div>}
      {data && <div className="tg-rows nf-rows">
        {!data.conversations.length && !data.users.length && <div className="tg-empty" data-testid="status-no-allowed">دسترسی شما به هیچ گفتگوی داخلی یا همکاری تعریف نشده است.</div>}
        {groups.length > 0 && <div className="nf-sec">گروه‌ها</div>}{groups.map(Row)}
        <div className="nf-sec">گفتگوی خصوصی<button type="button" onClick={() => setPickOpen(true)} data-testid="button-new-dm"><UserPlus /> گفتگوی جدید</button></div>
        {directs.map(Row)}
        {!directs.length && data.users.length > 0 && <div className="tg-empty sm">{q ? 'نتیجه‌ای پیدا نشد.' : 'با «گفتگوی جدید» یک گفتگوی خصوصی شروع کنید.'}</div>}
      </div>}
    </aside>
    <section className="tg-pane nf-pane" aria-label="گفتگو">
      {sel && data ? current
        ? <ConversationPane key={`${data.myId}:${current.id}`} conv={current} myId={data.myId} title={title(current)} onBack={() => select(null)} />
        : <div className="tg-empty" role="alert"><AlertCircle /><p>این گفتگو وجود ندارد یا به آن دسترسی ندارید.</p><button type="button" className="nf-btn s sm" onClick={() => select(null)}>بازگشت</button></div>
        : <div className="tg-empty"><Users /><p>یک گفتگو را انتخاب کنید.</p></div>}
    </section>
    {pickOpen && data && <div className="ic-sheet" onClick={() => setPickOpen(false)}><div role="dialog" aria-label="گفتگوی جدید" onClick={e => e.stopPropagation()}>
      <div className="ihd"><b>گفتگوی خصوصی با همکار</b><button type="button" className="ib" onClick={() => setPickOpen(false)} aria-label="بستن"><X /></button></div>
      {startDirect.isError && <div className="cerr" role="alert"><AlertCircle />{errMsg(startDirect.error)}</div>}
      <div className="tg-rows nf-rows">{data.users.filter(u => u.id !== data.myId).map((u: TeamUser) => <button type="button" key={u.id} className="nf-row" disabled={startDirect.isPending} onClick={() => startDirect.mutate(u.id)} data-testid={`row-user-${u.id}`}>
        <StaffAvatar userId={u.id} name={u.name} online={u.online} size={40} />
        <span className="r-body"><span className="r-top"><span className="r-name">{u.name}</span></span><span className="r-bot"><span className="role">{roleLabel(u.role)}</span>{u.online && <span className="ok">آنلاین</span>}</span></span></button>)}
        {!data.users.some(u => u.id !== data.myId) && <div className="tg-empty">همکاری برای گفتگو در دسترس نیست.</div>}</div>
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
  const [jump, setJump] = useState(false);
  // «N پیام تازه»: fixed when the conversation opens, from the inbox unread count.
  const unreadAtOpen = useRef(conv.unreadCount);
  const [divider, setDivider] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (divider !== undefined || !page.data || term) return;
    const incoming = items.filter(m => m.senderId !== myId);
    const n = unreadAtOpen.current;
    setDivider(n > 0 && incoming.length ? incoming[Math.max(0, incoming.length - n)].id : null);
  }, [page.data, items, myId, term, divider]);
  const newCount = divider ? items.filter(m => m.id >= divider && m.senderId !== myId).length : 0;
  const opened = useRef(false);
  const lastLen = useRef(0);
  useEffect(() => {
    const grew = items.length > lastLen.current; lastLen.current = items.length;
    if (!box.current || divider === undefined && !term) return;
    if (!opened.current) {
      opened.current = true;
      const el = box.current.querySelector<HTMLElement>('[data-divider]');
      if (el) { el.scrollIntoView({ block: 'start' }); stick.current = false; return; }
    }
    if (stick.current) box.current.scrollTop = box.current.scrollHeight;
    else if (grew && items[items.length - 1]?.senderId !== myId) setJump(true);
  }, [items, divider, term, myId]);
  const toBottom = () => { stick.current = true; setJump(false); if (box.current) box.current.scrollTop = box.current.scrollHeight; };
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
  // Editing happens in the composer (HANDOFF §4): the field is filled with the old text.
  const [editing, setEditing] = useState<TeamMessage | null>(null);
  const editM = useMutation({
    mutationFn: (v: { m: TeamMessage; text: string }) => teamChatApi.edit(v.m.id, v.text),
    onSuccess: r => { if (!alive.current) return; patch(r); setEditing(null); setText(''); setError(''); },
    onError: e => { if (alive.current) setError(errMsg(e)); },
  });
  const startEdit = (m: TeamMessage) => { if (sendM.isPending || rec) return; setReply(null); setFile(null); setEditing(m); setText(m.text); setError(''); };
  const cancelEdit = () => { setEditing(null); setText(''); setError(''); };
  const submit = () => {
    if (editing) { if (!editM.isPending && (text.trim() || editing.kind !== 'text')) editM.mutate({ m: editing, text: text.trim() }); return; }
    if (sendM.isPending || (!text.trim() && !file)) return;
    setEmojiOpen(false); setError(''); stopTyping();
    sendM.mutate({ cid: clientId.current, text: text.trim(), file: file ?? undefined, replyToId: reply?.id });
  };
  const attach = (f?: File) => {
    if (!f) return;
    if (!f.size) { setError('فایل خالی است؛ فایل دیگری انتخاب کنید.'); return; }
    if (f.size > MAX) { setError('حجم فایل نباید بیشتر از ۲۰ مگابایت باشد.'); return; }
    if (editing) cancelEdit();
    if (sendM.isError) clientId.current = uuid();
    setError(''); setFile(f);
  };

  // typing
  const typingAt = useRef(0); const typingOff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTyping = () => { clearTimeout(typingOff.current); if (typingAt.current) { typingAt.current = 0; void teamChatApi.typing(id, false).catch(() => undefined); } };
  const onType = (v: string) => {
    if (sendM.isError && v !== text) clientId.current = uuid();
    setText(v); if (sendM.isError) setError('');
    if (!v || editing) return stopTyping();
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
  const other = conv.kind === 'direct' ? conv.members.find(m => m.id !== myId) : undefined;
  const onlineCount = conv.members.filter(m => m.online && m.id !== myId).length;
  const [members, setMembers] = useState(false);
  const [menu, setMenu] = useState(false);
  const diagnostics = useDiagnostics();
  const runs = useMemo(() => runInfo(items, m => `u${m.senderId}`, m => m.createdAt, m => m.id === divider), [items, divider]);
  const [focus, setFocus] = useState(false); const [drag, setDrag] = useState(false);
  const busy = sendM.isPending || editM.isPending;
  const fk = file ? (file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'file') : null;
  return <>
    <div className="nf-th">
      <button type="button" className="ib tg-back" onClick={onBack} aria-label="بازگشت به فهرست"><ArrowRight /></button>
      <button type="button" className="tt" onClick={() => conv.kind === 'group' && setMembers(true)} aria-label={conv.kind === 'group' ? 'اعضای گروه' : title}>
        {other ? <StaffAvatar userId={other.id} name={other.name} online={other.online} size={44} /> : <GroupAvatar size={44} />}
        <span><span className="nm">{title}</span>
          <span className="sub">{typing.length ? <span className="ok">{typing.length > 1 ? 'چند نفر' : typing[0].name} در حال نوشتن…</span>
            : conv.kind === 'group' ? <>{conv.members.length.toLocaleString('fa-IR')} عضو{onlineCount > 0 && <><span className="sep">·</span><span className="ok">{onlineCount.toLocaleString('fa-IR')} آنلاین</span></>}</>
            : <>{other && roleLabel(other.role)}{other?.online && <><span className="sep">·</span><span className="ok">آنلاین</span></>}</>}</span></span>
      </button>
      {searching && <input type="search" className="nf-msearch" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="جست‌وجو در پیام‌ها" aria-label="جست‌وجو در پیام‌ها" data-testid="input-team-search" />}
      <button type="button" className="ib" aria-label={searching ? 'بستن جست‌وجو' : 'جست‌وجو'} onClick={() => { setSearching(s => !s); setQ(''); }} data-testid="button-team-search">{searching ? <X /> : <Search />}</button>
      <div className="nf-menuw">
        <button type="button" className="ib" onClick={() => setMenu(v => !v)} aria-label="گزینه‌های بیشتر" aria-haspopup="menu" aria-expanded={menu} data-testid="button-team-menu"><MoreVertical /></button>
        {menu && <div className="nf-menu" role="menu" onMouseLeave={() => setMenu(false)}>
          {conv.kind === 'group' && <button type="button" role="menuitem" onClick={() => { setMembers(true); setMenu(false); }}><Users />اعضای گروه</button>}
          <button type="button" role="menuitem" onClick={() => { setSearching(true); setMenu(false); }}><Search />جست‌وجو در پیام‌ها</button>
          {diagnostics && <><hr /><button type="button" role="menuitem" onClick={() => { setMenu(false); diagnostics.open(); }} data-testid="button-team-menu-diagnostics"><Bug />گزارش خطا</button></>}
        </div>}
      </div>
    </div>
    <div className={`nf-msgwrap ${drag ? 'drag' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); if (!busy && !rec) attach(e.dataTransfer.files?.[0]); }}>
      <div className="tg-msgs nf-msgs" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (stick.current) setJump(false); }} aria-live="polite" data-testid="team-messages">
        {page.isLoading && <div className="tg-empty" role="status">در حال دریافت پیام‌ها…</div>}
        {page.isError && !page.data && <div className="tg-empty err" role="alert"><AlertCircle /><p>{errMsg(page.error)}</p><button type="button" className="nf-btn s sm" onClick={() => void page.refetch()} data-testid="button-messages-retry"><RefreshCw size={18} /> تلاش دوباره</button></div>}
        {page.data && hasMore && <button type="button" className="nf-older" onClick={() => void loadOlder()} disabled={moreBusy} data-testid="button-team-older">{moreBusy ? 'در حال دریافت…' : 'پیام‌های قدیمی‌تر'}</button>}
        {page.data && !items.length && <div className="tg-empty">{term ? 'پیامی با این عبارت پیدا نشد.' : 'هنوز پیامی ثبت نشده است. اولین پیام را بفرستید.'}</div>}
        {items.map((m, i) => <div key={m.id} className="nf-mgrp">
          {runs[i].newDay && <div className="nf-day">{dayLabel(m.createdAt)}</div>}
          {runs[i].newDivider && newCount > 0 && !term && <div className="nf-new" data-divider>{newCount.toLocaleString('fa-IR')} پیام تازه</div>}
          <Msg m={m} mine={m.senderId === myId} myId={myId} group={conv.kind === 'group'} first={runs[i].first} last={runs[i].last} editingThis={editing?.id === m.id}
            onReply={() => { if (!sendM.isPending && !rec) { if (sendM.isError && reply?.id !== m.id) clientId.current = uuid(); if (editing) cancelEdit(); setReply(m); } }} onEdit={() => startEdit(m)} onPatch={patch} />
        </div>)}
        {sendM.isPending && sendM.variables && <div className="mr out"><div className="m out pend"><div className="b">
          {sendM.variables.file && <div className="fl"><span className="ft"><FileText /></span><span className="fi"><span className="fn">{sendM.variables.file.name}</span><span className="fs">{fsize(sendM.variables.file.size)}</span></span></div>}
          {sendM.variables.text && <div className="tx">{sendM.variables.text}</div>}
          <div className="meta"><span className="spin" aria-hidden="true" />در حال ارسال…</div></div></div></div>}
      </div>
      {jump && <button type="button" className="nf-jump" onClick={toBottom}><ArrowDown /> پیام تازه</button>}
      {drag && <div className="nf-drop" aria-hidden="true"><Paperclip /> فایل را اینجا رها کنید</div>}
    </div>
    <div className="tg-compose nf-comp">
      <div className="ic-typing" aria-live="polite">{typing.length ? <>{typing.slice(0, 3).map(u => <StaffAvatar key={u.id} userId={u.id} name={u.name} size={20} />)}<span>{typing.map(u => u.name).join('، ')} در حال نوشتن…</span></> : null}</div>
      {error && <div className="cerr" role="alert"><AlertCircle /><span>{error}</span>{sendM.isError && !editing && <button type="button" className="nf-btn s sm" onClick={submit} disabled={sendM.isPending} data-testid="button-team-retry"><RefreshCw size={16} /> تلاش دوباره</button>}</div>}
      {editing && <div className="rbar edit"><Pencil /><span className="rq"><b>ویرایش پیام</b><span>{editing.text}</span></span><button type="button" className="ib" onClick={cancelEdit} aria-label="لغو ویرایش" data-testid="button-cancel-edit"><X /></button></div>}
      {reply && <div className="rbar"><Reply /><span className="rq"><b>پاسخ به {reply.senderName}</b><span>{reply.text || reply.fileName}</span></span><button type="button" className="ib" disabled={sendM.isPending} onClick={() => { if (sendM.isError) clientId.current = uuid(); setReply(null); }} aria-label="لغو پاسخ"><X /></button></div>}
      {file && <div className="att" data-testid="team-attachment">
        {fk === 'image' && fileUrl ? <img className="thumb" src={fileUrl} alt="" /> : <span className="ft">{fk === 'audio' ? <Mic /> : <FileText />}</span>}
        <span className="fi"><span className="fn">{file.name}</span><span className="fs">{fileTypeLabel(file.type, file.name)} · {fsize(file.size)} — می‌توانید توضیح هم بنویسید</span></span>
        {fk === 'audio' && fileUrl && <audio controls src={fileUrl} aria-label="پیش‌نمایش پیام صوتی" />}
        <button type="button" className="ib" disabled={sendM.isPending} onClick={() => { setFile(null); if (sendM.isError) clientId.current = uuid(); }} aria-label="حذف پیوست" data-testid="button-remove-attachment"><X /></button></div>}
      {emojiOpen && <div className="ic-emoji"><Suspense fallback={<div className="tg-empty">…</div>}><Picker emojiStyle={'native' as import('emoji-picker-react').EmojiStyle} onEmojiClick={d => onType(text + d.emoji)} searchPlaceHolder="جست‌وجوی ایموجی" width={Math.min(340, window.innerWidth - 24)} height={380} lazyLoadEmojis /></Suspense></div>}
      <form className="cbar" onSubmit={e => { e.preventDefault(); submit(); }}>
        <input ref={fileInput} type="file" hidden disabled={busy || rec} onChange={e => { attach(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-team-file" />
        {rec ? <>
          <button type="button" className="ib" onClick={cancelRec} aria-label="لغو ضبط" data-testid="button-cancel-record"><Trash2 /></button>
          <div className="recbar" role="status"><span className="dot" /><span className="t">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span><span className="lbl">در حال ضبط…</span></div>
        </> : <>
          <button type="button" className="ib" disabled={busy || !!editing} aria-label="پیوست فایل" onClick={() => fileInput.current?.click()} data-testid="button-team-attach"><Paperclip /></button>
          <div className={`fld ${focus ? 'on' : ''}`}>
            <textarea rows={1} value={text} disabled={busy} placeholder={editing ? 'متن ویرایش‌شده…' : file ? 'توضیح فایل (اختیاری)…' : 'پیام…'} aria-label="متن پیام" onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={e => onType(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && editing) cancelEdit(); if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} data-testid={editing ? 'input-edit-message' : 'input-team-text'} />
            <button type="button" className="ib" disabled={busy} aria-label="ایموجی" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(v => !v)} data-testid="button-team-emoji"><Smile /></button>
          </div>
        </>}
        {editing ? <button type="submit" className="sendb" disabled={editM.isPending || (!text.trim() && editing.kind === 'text')} aria-label="ذخیرهٔ ویرایش" data-testid="button-save-edit"><Check /></button>
          : rec ? <button type="button" className="sendb" aria-label="پایان ضبط" onClick={() => recorder.current?.stop()} data-testid="button-team-record"><Check /></button>
          : text.trim() || file ? <button type="submit" className="sendb" disabled={sendM.isPending} aria-label="ارسال" data-testid="button-team-send"><Send /></button>
          : <button type="button" className="sendb mic" aria-label="ضبط پیام صوتی" onClick={() => void record()} data-testid="button-team-record"><Mic /></button>}
      </form>
      <div className="chint"><span><Paperclip />عکس، ویدیو، فایل یا صدا — تا ۲۰ مگابایت</span><span className="d-only"><kbd>Enter</kbd> ارسال · <kbd>Shift+Enter</kbd> خط جدید</span></div>
    </div>
    {members && conv.kind === 'group' && <>
      <div className="nf-scrim on" onClick={() => setMembers(false)} aria-hidden="true" />
      <aside className="nf-info" aria-label="اعضای گروه" data-testid="panel-team-members">
        <div className="ihd"><b>اعضای گروه</b><button type="button" className="ib" onClick={() => setMembers(false)} aria-label="بستن"><X /></button></div>
        <div className="ci-head"><GroupAvatar size={64} /><span className="nm">{title}</span><span className="mo">{conv.members.length.toLocaleString('fa-IR')} عضو</span></div>
        <div className="ci-sec">اعضا</div>
        {[...conv.members].sort((a, b) => Number(b.online) - Number(a.online)).map(u => <div key={u.id} className="ppl"><StaffAvatar userId={u.id} name={u.name} online={u.online} size={40} />
          <span className="pi"><b>{u.name}{u.id === myId && ' (شما)'}</b><small><span className="role">{roleLabel(u.role)}</span>{u.online && <span className="ok">آنلاین</span>}</small></span></div>)}
      </aside>
    </>}
  </>;
}

function Msg({ m, mine, myId, group, first, last, editingThis, onReply, onEdit, onPatch }: { m: TeamMessage; mine: boolean; myId: number; group: boolean; first: boolean; last: boolean; editingThis: boolean; onReply: () => void; onEdit: () => void; onPatch: (m: TeamMessage) => void }) {
  const [confirm, setConfirm] = useState(false); const [pick, setPick] = useState(false); const [err, setErr] = useState('');
  const fail = (e: unknown) => setErr(errMsg(e));
  const del = useMutation({ mutationFn: () => teamChatApi.remove(m.id), onSuccess: r => { onPatch(r); setConfirm(false); }, onError: fail });
  const react = useMutation({ mutationFn: (e: string) => teamChatApi.react(m.id, e), onSuccess: r => { onPatch(r); setPick(false); }, onError: fail });
  const url = withBase(m.fileUrl);
  const deleted = m.kind === 'deleted';
  const seen = mine && m.readBy.some(u => u !== myId);
  const media = (m.kind === 'image' || m.kind === 'video') && !m.text;
  // Internal chat: my own messages carry no avatar; others get theirs on the last message of a run.
  return <div className={`mr ${mine ? 'out' : 'in'} ${first ? 'gap' : ''}`}>
    {!mine && <span className="mav">{last && <StaffAvatar userId={m.senderId} name={m.senderName} size={32} />}</span>}
    <div className={`m ${mine ? 'out' : 'in'} ${first ? '' : 'cont'} ${editingThis ? 'editing' : ''}`} data-testid={`team-message-${m.id}`}>
      {first && !mine && group && <div className="snd">{m.senderName}</div>}
      <div className={`b ${deleted ? 'del' : ''} ${media ? 'media' : ''}`}>
        {m.replyTo && <div className="rq-in"><b>{m.replyTo.senderName}</b><span>{m.replyTo.text}</span></div>}
        {deleted ? <em>این پیام حذف شد.</em> : <>
          {m.kind === 'image' && url && <a className="nf-ph" href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={m.fileName || 'تصویر'} loading="lazy" /></a>}
          {m.kind === 'audio' && url && <audio controls preload="none" src={url} aria-label="پیام صوتی" />}
          {m.kind === 'video' && url && <video className="nf-vid" controls preload="metadata" src={url} />}
          {m.kind === 'file' && url && <a className="fl" href={url} download={m.fileName || undefined}><span className={`ft ${/pdf/i.test(m.mimeType || m.fileName || '') ? 'pdf' : ''}`}><FileText /></span><span className="fi"><span className="fn">{m.fileName || 'فایل'}</span><span className="fs">{fileTypeLabel(m.mimeType, m.fileName)} · {fsize(m.fileSize)}</span></span><span className="dl" aria-label="دریافت"><Download /></span></a>}
          {m.text && <div className="tx">{m.text}</div>}
        </>}
        <div className="meta">{m.editedAt && !deleted && <span>ویرایش‌شده ·</span>}{clock(m.createdAt)}{mine && !deleted && (seen ? <CheckCheck className="seen" aria-label="خوانده شد" /> : <Check aria-label="ارسال شد" />)}</div>
      </div>
      {m.reactions.length > 0 && <div className="ic-react">{m.reactions.map(r => <button type="button" key={r.emoji} aria-pressed={r.mine} disabled={react.isPending} onClick={() => react.mutate(r.emoji)} data-testid={`reaction-${m.id}-${r.emoji}`}>{r.emoji} {r.count.toLocaleString('fa-IR')}</button>)}</div>}
      {err && <div className="cerr" role="alert"><AlertCircle />{err}</div>}
      {confirm && <div className="failbar" role="alertdialog"><span className="why">این پیام حذف شود؟</span><button type="button" className="nf-btn d" disabled={del.isPending} onClick={() => del.mutate()} data-testid="button-confirm-delete"><Trash2 size={16} /> حذف</button><button type="button" className="nf-btn g" onClick={() => setConfirm(false)}>انصراف</button></div>}
      {!deleted && <div className="ic-tools">
        <button type="button" onClick={onReply} aria-label="پاسخ" data-testid={`button-reply-${m.id}`}><Reply /></button>
        <button type="button" onClick={() => setPick(p => !p)} aria-label="واکنش" data-testid={`button-react-${m.id}`}><SmilePlus /></button>
        {mine && m.kind === 'text' && <button type="button" onClick={onEdit} aria-label="ویرایش" data-testid={`button-edit-${m.id}`}><Pencil /></button>}
        {mine && <button type="button" onClick={() => setConfirm(true)} aria-label="حذف" data-testid={`button-delete-${m.id}`}><Trash2 /></button>}
      </div>}
      {pick && <div className="ic-pop" style={mine ? { insetInlineStart: 'auto', insetInlineEnd: 0 } : undefined}><Suspense fallback={null}><Picker emojiStyle={'native' as import('emoji-picker-react').EmojiStyle} reactionsDefaultOpen={false} onEmojiClick={d => react.mutate(d.emoji)} searchPlaceHolder="جست‌وجوی ایموجی" width={Math.min(320, window.innerWidth - 24)} height={360} lazyLoadEmojis /></Suspense></div>}
    </div>
  </div>;
}
