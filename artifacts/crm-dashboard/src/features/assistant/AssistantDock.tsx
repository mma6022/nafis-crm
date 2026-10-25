import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getListRemindersQueryKey, useCreateReminder } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Bell, BellOff, Moon, Phone, Send, Clock, Copy, X, Volume2, VolumeX, CheckCheck, Check } from 'lucide-react';
import { CreateReminderForm } from '@/components/Forms';
import { toast } from '@/hooks/use-toast';
import { AssistantAvatar, type AvState } from './AssistantAvatar';
import { asFetch, asTime, asWhen, asVisibleTo, chime, faNum, unlockAudio, type AsAction, type AsMessage, type AsMine, type AsPrefs, type AsThread, type AsProposal } from './api';
import './assistant.css';

type ThreadState = AsThread & { lastId: number; loaded: boolean };
type Mine = { assistants: AsMine[]; prefs: AsPrefs };
const EMPTY: ThreadState = { messages: [], userSeen: [], typing: false, online: false, prefs: { sound: true, dnd: false, dndUntil: null, quiet: false }, lastId: 0, loaded: false };
const KIND_FA: Record<string, string> = { suggestion: 'پیشنهاد', alert: 'هشدار', digest: 'خلاصه', text: '', reminder_proposal: 'پیشنهاد یادآور', brief: 'خلاصه', report: 'گزارش' };
const BUBBLE_MS = 12_000;
/** Tehran wall-clock → ISO (Iran has no DST since 2022: fixed UTC+03:30). */
function tehranAt(dayOffset: number, h: number, min = 0) {
  const off = 210 * 60_000; const t = new Date(Date.now() + off);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + dayOffset, h, min) - off).toISOString();
}
function quickTimes(): { label: string; at: string }[] {
  const out = [{ label: 'یک ساعت دیگه', at: new Date(Date.now() + 3600_000).toISOString() }];
  const eve = tehranAt(0, 18); if (Date.parse(eve) > Date.now() + 15 * 60_000) out.push({ label: 'امروز عصر (۱۸)', at: eve });
  out.push({ label: 'فردا صبح (۱۰)', at: tehranAt(1, 10) });
  return out;
}

/** One-click save of a reminder: always through the existing POST /api/reminders under the expert's own session. */
function useSaveReminder() {
  const create = useCreateReminder(); const qc = useQueryClient();
  const save = async (customerId: number | null, text: string, remindAt: string) => {
    const subject = (text.trim() || 'پیگیری').slice(0, 80);
    const r = await create.mutateAsync({ data: { customerId, subject, message: text.trim() || subject, remindAt } });
    void qc.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    return r as unknown as { id: number };
  };
  return { save, busy: create.isPending };
}

function ProposalCard({ m, onDecided }: { m: AsMessage; onDecided: (m: AsMessage, p: AsProposal) => void }) {
  const p = m.proposal; const { save, busy } = useSaveReminder(); const [working, setWorking] = useState(false);
  if (!p) return null;
  if (p.status !== 'pending') return <div className="nas-prp done" data-testid={`proposal-${p.id}-${p.status}`}>{p.status === 'accepted' ? <><Check size={14} /> یادآور ثبت شد · {asWhen(p.remindAt)}</> : p.status === 'rejected' ? 'رد شد' : 'زمانش گذشت'}</div>;
  const decide = async (accept: boolean) => {
    if (working || busy) return; setWorking(true);
    try {
      let reminderId: number | undefined;
      if (accept) reminderId = (await save(p.customerId, p.note || m.body, p.remindAt)).id;
      const r = await asFetch<{ proposal: AsProposal }>(`/assistant/reminder-proposals/${p.id}/decide`, { method: 'POST', body: accept ? { accept: true, reminderId } : { accept: false } });
      onDecided(m, r.proposal);
      if (accept) toast({ title: 'یادآور ثبت شد', description: asWhen(p.remindAt) });
    } catch (e) { toast({ title: (e as Error).message || 'ثبت یادآور انجام نشد.' }); } finally { setWorking(false); }
  };
  return <div className="nas-prp" data-testid={`proposal-${p.id}`}>
    <div className="pt"><Clock size={15} /> {asWhen(p.remindAt)}{p.note ? <> · {p.note}</> : null}</div>
    <div className="pb">
      <button type="button" className="btn btn-primary" disabled={working || busy} onClick={() => void decide(true)} data-testid={`button-proposal-accept-${p.id}`}>{working ? 'در حال ثبت…' : 'ثبت یادآور'}</button>
      <button type="button" className="btn" disabled={working} onClick={() => void decide(false)} data-testid={`button-proposal-reject-${p.id}`}>لازم نیست</button>
    </div>
  </div>;
}

/** «یادآور بذار» quick picker: one click per time; «جزئیات» falls back to the full CRM form. */
function QuickReminder({ m, onClose, onFull }: { m: AsMessage; onClose: () => void; onFull: () => void }) {
  const { save, busy } = useSaveReminder();
  const pick = async (at: string) => {
    try { await save(m.customerId, m.body.slice(0, 300), at); toast({ title: 'یادآور ثبت شد', description: asWhen(at) }); onClose(); }
    catch (e) { toast({ title: (e as Error).message || 'ثبت یادآور انجام نشد.' }); }
  };
  return <div className="nas-qr" role="dialog" aria-label="یادآور بذار" data-testid="assistant-quick-reminder">
    <div className="bh"><b>یادآور{m.customerName ? ` · ${m.customerName}` : ''}</b><span className="sp" /><button type="button" className="bx" aria-label="بستن" onClick={onClose}><X size={18} /></button></div>
    <div className="qg">{quickTimes().map(q => <button key={q.label} type="button" className="btn" disabled={busy} onClick={() => void pick(q.at)}>{q.label}</button>)}</div>
    <button type="button" className="open" onClick={onFull}>زمان دیگر / جزئیات</button>
  </div>;
}
/** HANDOFF §1: a call form / full-screen modal is open (same selectors as useFloatingGuard, minus the assistant's own windows). */
const OVERLAY_SEL = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],.modal-backdrop,.call-sheet-backdrop,.ch-backdrop,.ic-sheet,.mobile-nav-overlay,[vaul-drawer]';
function useForeignOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let f = 0;
    const check = () => {
      f = 0;
      setOpen(Array.from(document.querySelectorAll(OVERLAY_SEL)).some(el => {
        if (el.closest('.nas-chw,.nas-qr,.diag-layer-content,.diag-backdrop')) return false;
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false;
        const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none';
      }));
    };
    const sch = () => { if (!f) f = requestAnimationFrame(check); };
    const mo = new MutationObserver(sch);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-modal', 'open', 'hidden'] });
    sch();
    return () => { mo.disconnect(); if (f) cancelAnimationFrame(f); };
  }, []);
  return open;
}
const typingInField = () => { const el = document.activeElement as HTMLElement | null; return Boolean(el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type)) || el.isContentEditable) && !el.closest('.nas-chw')); };
type Anchor = { top: number; bottom: number; left: number; right: number; cx: number };
function useAnchor(el: HTMLElement | null, active: boolean, key?: string | number) {
  const [a, setA] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    if (!el || !active) { setA(null); return; }
    const m = () => { const t = key != null ? el.querySelector<HTMLElement>(`[data-thread="${key}"]`) : null; const r = (t ?? el).getBoundingClientRect(); setA({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, cx: r.left + r.width / 2 }); };
    m(); window.addEventListener('resize', m); window.addEventListener('scroll', m, { passive: true, capture: true });
    return () => { window.removeEventListener('resize', m); window.removeEventListener('scroll', m, { capture: true }); };
  }, [el, active, key]);
  return a;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(r => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

/** Long-polls one thread (wait=20) and reports merged state up. Backs off when the server answers instantly with nothing new. */
function ThreadPoller({ threadId, onData }: { threadId: number; onData: (id: number, d: Partial<AsThread>, fresh: AsMessage[], first: boolean) => void }) {
  const cb = useRef(onData); cb.current = onData;
  useEffect(() => {
    const ac = new AbortController(); let last = 0; let first = true; let fails = 0;
    (async () => {
      while (!ac.signal.aborted) {
        const t0 = Date.now();
        try {
          const d = await asFetch<AsThread>(`/assistant/threads/${threadId}/messages?after=${last}&wait=${first ? 0 : 20}`, { signal: ac.signal });
          fails = 0;
          const fresh = d.messages.filter(m => m.id > last);
          if (fresh.length) last = Math.max(last, ...fresh.map(m => m.id));
          cb.current(threadId, d, fresh, first); first = false;
          if (!fresh.length && Date.now() - t0 < 1500) await sleep(document.hidden ? 15000 : 4000, ac.signal);
          else if (document.hidden) await sleep(3000, ac.signal);
        } catch (e) {
          if (ac.signal.aborted) return;
          fails++; await sleep(Math.min(60000, 3000 * 2 ** Math.min(fails, 4)), ac.signal);
        }
      }
    })();
    return () => ac.abort();
  }, [threadId]);
  return null;
}

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    try { const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
  }
}

function MsgActions({ m, onAct, compact }: { m: AsMessage; onAct: (m: AsMessage, a: AsAction) => void; compact?: boolean }) {
  return <div className={compact ? 'nas-ma' : 'nas-bac'}>
    <button type="button" className="btn btn-primary" onClick={() => onAct(m, 'call')} data-testid={`button-as-call-${m.id}`}><Phone size={16} /> تماس بگیر</button>
    <button type="button" className="btn" onClick={() => onAct(m, 'remind')} data-testid={`button-as-remind-${m.id}`}><Clock size={16} /> یادآور بذار</button>
    <button type="button" className="btn" onClick={() => onAct(m, 'copy')} title="ارسال مستقیم به‌زودی — فعلاً متن کپی می‌شود" data-testid={`button-as-copy-${m.id}`}><Copy size={16} /> پیام رو بفرست<small>ارسال مستقیم به‌زودی</small></button>
    <button type="button" className="btn lat" onClick={() => onAct(m, 'later')} data-testid={`button-as-later-${m.id}`}>بعداً</button>
  </div>;
}

/** HANDOFF §1 placement: desktop/tablet — avatars live in a slot at the bottom of the dark sidebar (56px + name), the bubble opens to
 *  the left over the content; phone — 44px avatar in the sticky top bar next to the bell, bubble full-width under the bar with its tail
 *  on the avatar. Nothing floats over page content, so card buttons at 390px are never covered. Without a slot it falls back to the
 *  old fixed bottom-left dock. */
export function AssistantDock({ user, bottomOffset, phone, slot }: { user: { id: number; role?: string | null; salespersonId?: number | null } | null | undefined; bottomOffset: number; phone: boolean; slot?: HTMLElement | null }) {
  const allowed = asVisibleTo(user);
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const mine = useQuery({ queryKey: ['assistant-mine', user?.id], enabled: allowed, refetchInterval: 30_000, retry: false, queryFn: () => asFetch<Mine>('/assistant/mine') });
  const list = mine.data?.assistants ?? [];
  const [threads, setThreads] = useState<Record<number, ThreadState>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [bubble, setBubble] = useState<AsMessage | null>(null);
  const [remindFor, setRemindFor] = useState<AsMessage | null>(null);
  const [quickFor, setQuickFor] = useState<AsMessage | null>(null);
  const hoverRef = useRef(false);
  const [prefs, setPrefs] = useState<AsPrefs | null>(null);
  const openRef = useRef(openId); openRef.current = openId;
  const prefsNow = prefs ?? mine.data?.prefs ?? EMPTY.prefs;
  const prefsRef = useRef(prefsNow); prefsRef.current = prefsNow;
  const overlay = useForeignOverlay();
  const overlayRef = useRef(overlay); overlayRef.current = overlay;
  // Messages that arrived while a form was open / the user was typing (by id, so re-delivered messages count once).
  const queueRef = useRef(new Map<number, AsMessage>());
  const [queued, setQueued] = useState(0);
  // When the form closes, show the most important queued message once (unless DND or its chat is already open).
  useEffect(() => {
    if (overlay || !queueRef.current.size) return;
    const list = [...queueRef.current.values()]; queueRef.current.clear(); setQueued(0);
    const top = list.find(m => m.priority === 'high') ?? list[list.length - 1];
    if (top && !prefsRef.current.dnd && openRef.current !== top.threadId) setBubble(top);
  }, [overlay]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const anchor = useAnchor(anchorEl, Boolean(slot) && (bubble != null || Object.values(threads).some(t => t.typing)), bubble?.threadId);

  useEffect(() => { const f = () => unlockAudio(); window.addEventListener('pointerdown', f, { once: true }); return () => window.removeEventListener('pointerdown', f); }, []);

  const onData = useCallback((id: number, d: Partial<AsThread>, fresh: AsMessage[], first: boolean) => {
    setThreads(prev => {
      const cur = prev[id] ?? EMPTY;
      const byId = new Map(cur.messages.map(m => [m.id, m])); for (const m of d.messages ?? []) byId.set(m.id, m);
      const messages = [...byId.values()].sort((a, b) => a.id - b.id).slice(-200);
      return { ...prev, [id]: { ...cur, ...d, messages, lastId: messages.length ? messages[messages.length - 1].id : cur.lastId, loaded: true } };
    });
    if (d.prefs) setPrefs(d.prefs);
    const incoming = fresh.filter(m => m.author !== 'user');
    if (first || !incoming.length) return;
    void qc.invalidateQueries({ queryKey: ['assistant-mine'] });
    const loud = incoming.filter(m => !m.suppressed);
    const p = d.prefs ?? prefsRef.current;
    if (!loud.length || p.dnd) return;
    const top = loud.find(m => m.priority === 'high') ?? loud[loud.length - 1];
    if (p.sound && (!p.quiet || top.priority === 'high')) chime(top.priority === 'high');
    // A form / full-screen window is open or the user is typing: queue (the avatar's unread count shows it) instead of popping up.
    if (overlayRef.current || typingInField()) { for (const m of loud) queueRef.current.set(m.id, m); setQueued(queueRef.current.size); return; }
    if (openRef.current !== id) setBubble(top);
  }, [qc]);

  // Mark read while a thread is open.
  const openThread = openId != null ? threads[openId] : undefined;
  const lastAsId = openThread ? Math.max(0, ...openThread.messages.filter(m => m.author !== 'user' && !m.readAt).map(m => m.id)) : 0;
  useEffect(() => {
    if (openId == null || !lastAsId) return;
    asFetch(`/assistant/threads/${openId}/read`, { method: 'POST', body: { upTo: lastAsId } }).then(() => {
      setThreads(prev => { const t = prev[openId]; if (!t) return prev; const at = new Date().toISOString(); return { ...prev, [openId]: { ...t, messages: t.messages.map(m => m.author !== 'user' && m.id <= lastAsId && !m.readAt ? { ...m, readAt: at } : m) } }; });
      void qc.invalidateQueries({ queryKey: ['assistant-mine'] });
    }).catch(() => undefined);
  }, [openId, lastAsId, qc]);
  useEffect(() => { if (openId != null && !list.some(a => a.threadId === openId)) setOpenId(null); }, [list, openId]);
  useEffect(() => { if (bubble && !list.some(a => a.threadId === bubble.threadId)) setBubble(null); }, [list, bubble]);

  const act = useCallback(async (m: AsMessage, a: AsAction) => {
    if (a === 'copy') { const ok = await copyText(m.body); toast({ title: ok ? 'متن کپی شد' : 'کپی نشد', description: 'ارسال مستقیم به‌زودی؛ فعلاً متن را خودتان برای مشتری بفرستید.' }); }
    if (a === 'call') { if (m.customerId) setLocation(`/customers/${m.customerId}`); else toast({ title: 'این پیام به مشتری خاصی وصل نیست.' }); }
    if (a === 'remind') { if (m.customerId) setQuickFor(m); else setRemindFor(m); }
    setBubble(b => (b?.id === m.id ? null : b));
    setThreads(prev => { const t = prev[m.threadId]; if (!t) return prev; const at = new Date().toISOString(); return { ...prev, [m.threadId]: { ...t, messages: t.messages.map(x => x.id === m.id ? { ...x, actedAt: at, actionTaken: a, readAt: x.readAt ?? at } : x) } }; });
    asFetch(`/assistant/messages/${m.id}/action`, { method: 'POST', body: { action: a } }).catch(() => undefined);
  }, [setLocation]);

  useEffect(() => {
    if (!bubble || bubble.kind === 'reminder_proposal' || bubble.priority === 'high') return;
    const id = bubble.id; let t: ReturnType<typeof setTimeout>;
    const arm = () => { t = setTimeout(() => { if (hoverRef.current) arm(); else setBubble(b => (b?.id === id ? null : b)); }, BUBBLE_MS); };
    arm(); return () => clearTimeout(t);
  }, [bubble]);
  const decided = useCallback((m: AsMessage, p: AsProposal) => {
    setBubble(b => (b?.id === m.id ? null : b));
    setThreads(prev => { const t = prev[m.threadId]; if (!t) return prev; const at = new Date().toISOString(); return { ...prev, [m.threadId]: { ...t, messages: t.messages.map(x => x.id === m.id ? { ...x, proposal: p, actedAt: at, readAt: x.readAt ?? at } : x) } }; });
  }, []);

  const savePrefs = async (body: { sound?: boolean; dndMinutes?: number }) => {
    try { const r = await asFetch<{ prefs: AsPrefs }>('/assistant/prefs', { method: 'PUT', body }); setPrefs(r.prefs); } catch (e) { toast({ title: (e as Error).message }); }
  };

  if (!allowed || !list.length) return null;
  const pollers = list.map(a => <ThreadPoller key={a.threadId} threadId={a.threadId} onData={onData} />);
  const bubbleA = bubble ? list.find(a => a.threadId === bubble.threadId) : undefined;
  const openA = openId != null ? list.find(a => a.threadId === openId) : undefined;
  const typingA = !openA && !bubble ? list.find(a => threads[a.threadId]?.typing) : undefined;

  const showBubble = Boolean(bubble && bubbleA) && !overlay;
  const pop = showBubble ? <div className="nas-bub" role="status" aria-live="polite" data-testid="assistant-bubble" onPointerEnter={() => { hoverRef.current = true; }} onPointerLeave={() => { hoverRef.current = false; }}>
        <div className="bh"><b>{bubbleA!.label}</b>{bubble!.customerName ? <span>· {bubble!.customerName}</span> : null}<span className="sp" />
          <button type="button" className="bx" aria-label="بستن" onClick={() => setBubble(null)}><X size={18} /></button></div>
        {KIND_FA[bubble!.kind] ? <div className={`nas-kl k-${bubble!.kind}`}>{KIND_FA[bubble!.kind]}{bubble!.priority === 'high' ? ' · فوری' : ''}</div> : null}
        <div className="tx2">{bubble!.body}</div>
        {bubble!.kind === 'reminder_proposal' ? <ProposalCard m={bubble!} onDecided={decided} /> : (bubble!.kind === 'suggestion' || bubble!.kind === 'alert') ? <MsgActions m={bubble!} onAct={act} /> : null}
        <button type="button" className="open" onClick={() => { setOpenId(bubble!.threadId); setBubble(null); }}>باز کردن گفتگو</button>
      </div> : typingA && !overlay ? <div className="nas-bub ty" data-testid="assistant-typing-bubble"><span className="dots"><i /><i /><i /></span>{typingA.label} در حال نوشتن…</div> : null;
  const avatars = <div className="nas-avs">
        {list.map(a => {
          const t = threads[a.threadId]; const st: AvState = prefsNow.dnd || overlay ? 'dnd' : t?.typing ? 'think' : bubble?.threadId === a.threadId ? 'attn' : 'idle';
          const online = t?.online ?? a.online;
          return <button key={a.id} type="button" className="nas-fav" data-thread={a.threadId} onClick={() => { setOpenId(o => o === a.threadId ? null : a.threadId); setBubble(null); }}
            aria-label={`${a.label}${a.unread ? ` — ${a.unread} پیام تازه` : ''}`} aria-expanded={openId === a.threadId} data-testid={`button-assistant-${a.slug}`}>
            <AssistantAvatar slug={a.slug} state={st} size={slot ? (phone ? 44 : 56) : (phone ? 46 : 54)} />
            <i className={`dt${online ? '' : ' nc'}`} title={online ? 'وصل' : 'وصل نیست'} data-testid={`assistant-dot-${a.slug}`} />
            {a.unread > 0 ? <b className="bd2">{faNum(a.unread)}</b> : null}
            {prefsNow.dnd || overlay ? <span className="moon"><Moon size={12} /></span> : null}
            {!phone ? <span className="nmt">{a.name}</span> : null}
          </button>;
        })}
      </div>;

  if (slot) {
    return <>
      {pollers}
      {createPortal(<div className={`nas-slotted${phone ? ' top' : ' side'}`} data-testid="assistant-dock" data-placement={phone ? 'topbar' : 'sidebar'}>
        {!phone && overlay ? <div className="nas-dndc" data-testid="assistant-dnd-card"><Moon size={14} /> <span><b>مزاحم نشو</b> تا این پنجره باز است{queued ? ` · ${faNum(queued)} پیام در صف` : ''}</span></div> : null}
        <span ref={setAnchorEl} className="nas-anchor">{avatars}</span>
      </div>, slot)}
      {pop ? <div className={`nas-pop ${phone ? 'top' : 'side'}`} style={phone ? { top: Math.max(8, (anchor?.bottom ?? 68) + 10), ['--tail' as string]: `${Math.round(anchor?.cx ?? 40)}px` } : { bottom: Math.max(12, window.innerHeight - (anchor?.bottom ?? window.innerHeight - 24)) }} data-testid="assistant-pop">{pop}</div> : null}
    {openA ? <ChatPanel a={openA} t={openThread ?? EMPTY} prefs={prefsNow} onClose={() => setOpenId(null)} onAct={act} onPrefs={savePrefs} onDecided={decided}
      onSent={m => setThreads(prev => { const t = prev[m.threadId] ?? EMPTY; if (t.messages.some(x => x.id === m.id)) return prev; return { ...prev, [m.threadId]: { ...t, messages: [...t.messages, m], lastId: Math.max(t.lastId, m.id) } }; })} /> : null}
    {quickFor ? <QuickReminder m={quickFor} onClose={() => setQuickFor(null)} onFull={() => { setRemindFor(quickFor); setQuickFor(null); }} /> : null}
    {remindFor ? <CreateReminderForm onClose={() => setRemindFor(null)} /> : null}
    </>;
  }
  return <>
    {pollers}
    <div className="nas-dock" style={{ bottom: bottomOffset }} data-testid="assistant-dock" data-placement="fixed">
      {pop}
      {avatars}
    </div>
    {openA ? <ChatPanel a={openA} t={openThread ?? EMPTY} prefs={prefsNow} onClose={() => setOpenId(null)} onAct={act} onPrefs={savePrefs} onDecided={decided}
      onSent={m => setThreads(prev => { const t = prev[m.threadId] ?? EMPTY; if (t.messages.some(x => x.id === m.id)) return prev; return { ...prev, [m.threadId]: { ...t, messages: [...t.messages, m], lastId: Math.max(t.lastId, m.id) } }; })} /> : null}
    {quickFor ? <QuickReminder m={quickFor} onClose={() => setQuickFor(null)} onFull={() => { setRemindFor(quickFor); setQuickFor(null); }} /> : null}
    {remindFor ? <CreateReminderForm onClose={() => setRemindFor(null)} /> : null}
  </>;
}

const CHIPS: Record<'sales' | 'filing', string[]> = { sales: ['بعدی کیه؟', 'یادآورهای امروزم', 'کدوم مشتری منتظره؟'], filing: ['پرونده‌های منتظر ثبت', 'کدوم کد منتظره؟'] };
function ChatPanel({ a, t, prefs, onClose, onAct, onPrefs, onSent, onDecided }: { a: AsMine; t: ThreadState; prefs: AsPrefs; onClose: () => void; onAct: (m: AsMessage, a: AsAction) => void; onDecided: (m: AsMessage, p: AsProposal) => void; onPrefs: (b: { sound?: boolean; dndMinutes?: number }) => void; onSent: (m: AsMessage) => void }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const seen = useMemo(() => new Map(t.userSeen.map(s => [s.id, s.seen])), [t.userSeen]);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [t.messages.length, t.typing]);
  useEffect(() => { const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc); }, [onClose]);
  const send = async (e?: FormEvent, preset?: string) => {
    e?.preventDefault(); const b = (preset ?? text).trim(); if (!b || busy) return;
    setBusy(true);
    try { const r = await asFetch<{ message: AsMessage }>(`/assistant/threads/${a.threadId}/messages`, { method: 'POST', body: { body: b, clientId: `c${Date.now()}${Math.random().toString(36).slice(2, 7)}` } }); onSent(r.message); if (preset === undefined) setText(''); }
    catch (err) { toast({ title: (err as Error).message }); } finally { setBusy(false); }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } };
  const online = t.loaded ? t.online : a.online;
  return <div className="nas-chw" role="dialog" aria-label={a.label} data-testid="assistant-chat">
    <div className="chh">
      <AssistantAvatar slug={a.slug} state={prefs.dnd ? 'dnd' : t.typing ? 'think' : 'idle'} size={40} />
      <div className="tt"><b>{a.label}</b><span className="s"><i className={online ? '' : 'off'} />{t.typing ? 'در حال نوشتن…' : online ? 'آنلاین' : 'آفلاین'}</span></div>
      <button type="button" className="ib" onClick={() => onPrefs({ sound: !prefs.sound })} aria-label={prefs.sound ? 'بی‌صدا کردن' : 'صدادار کردن'} title={prefs.sound ? 'صدا روشن' : 'صدا خاموش'} data-testid="button-as-sound">{prefs.sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
      <button type="button" className={`ib${prefs.dnd ? ' on' : ''}`} onClick={() => onPrefs({ dndMinutes: prefs.dnd ? 0 : 60 })} aria-pressed={prefs.dnd} title={prefs.dnd ? 'مزاحم نشو روشن است — برای خاموش کردن بزنید' : 'مزاحم نشو (۱ ساعت)'} data-testid="button-as-dnd">{prefs.dnd ? <BellOff size={18} /> : <Bell size={18} />}</button>
      <button type="button" className="ib" onClick={onClose} aria-label="بستن" data-testid="button-as-close"><X size={20} /></button>
    </div>
    {prefs.dnd ? <div className="cban dnd"><Moon size={16} /> <span><b>مزاحم نشو</b>{prefs.dndUntil ? `تا ${asTime(prefs.dndUntil)}` : ''} — پیام‌ها نگه داشته می‌شوند و صدایی پخش نمی‌شود.</span></div>
      : !online ? <div className="cban off"><span>{a.name} الان وصل نیست؛ پیامت می‌ماند و وقتی وصل شد جواب می‌دهد.</span></div> : null}
    <div className="chb" ref={body}>
      {!t.loaded ? <div className="dsep">در حال بارگذاری…</div> : !t.messages.length ? <div className="dsep">هنوز پیامی نیست. هر سؤالی دربارهٔ مشتری‌هایتان دارید بپرسید.</div> : null}
      {t.messages.map(m => m.author === 'user'
        ? <div key={m.id} className="msg mine"><div className="bdy">{m.body}</div><span className="tm">{asTime(m.createdAt)} · {(seen.get(m.id) ?? Boolean(m.pickedAt)) ? <><CheckCheck size={13} /> دیده شد</> : <><Check size={13} /> در صف</>}</span></div>
        : m.author === 'system' ? <div key={m.id} className="sys">{m.body}</div>
        : <div key={m.id} className={`msg as k-${m.kind}${m.priority === 'high' ? ' hi' : ''}`}>
          {KIND_FA[m.kind] || m.customerName ? <div className="kl">{KIND_FA[m.kind]}{m.priority === 'high' ? ' · فوری' : ''}{m.customerName ? <span className="cu"> · {m.customerName}</span> : null}</div> : null}
          <div className="bdy">{m.body}</div>
          {m.kind === 'reminder_proposal' ? <ProposalCard m={m} onDecided={onDecided} /> : (m.kind === 'suggestion' || m.kind === 'alert') && !m.actedAt ? <MsgActions m={m} onAct={onAct} compact /> : null}
          <span className="tm">{asTime(m.createdAt)}{m.actionTaken ? ` · ${{ call: 'تماس', remind: 'یادآور', copy: 'کپی شد', later: 'بعداً' }[m.actionTaken] ?? ''}` : ''}{m.suppressed === 'dnd' ? ' · نگه‌داشته‌شده در مزاحم نشو' : m.suppressed === 'digested' ? ' · در خلاصه' : ''}</span>
        </div>)}
      {t.typing ? <div className="typ"><span className="dots"><i /><i /><i /></span>در حال نوشتن…</div> : null}
    </div>
    {!t.messages.some(m => m.author === 'user') ? <div className="nas-chips">{CHIPS[a.kind].map(c => <button key={c} type="button" disabled={busy} onClick={() => void send(undefined, c)}>{c}</button>)}</div> : null}
    <form className="chf" onSubmit={send}>
      <textarea className="inp" rows={1} value={text} maxLength={2000} onChange={e => setText(e.target.value)} onKeyDown={keys} placeholder={`پیام به ${a.label}…`} aria-label="متن پیام" data-testid="input-as-message" />
      <button type="submit" className={`snd${text.trim() ? '' : ' off'}`} disabled={!text.trim() || busy} aria-label="ارسال" data-testid="button-as-send"><Send size={20} /></button>
    </form>
  </div>;
}
