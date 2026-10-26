import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getListRemindersQueryKey, useCreateReminder } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Bell, BellOff, Moon, Phone, Send, Clock, Copy, X, Volume2, VolumeX, CheckCheck, Check } from 'lucide-react';
import { CreateReminderForm } from '@/components/Forms';
import { toast } from '@/hooks/use-toast';
import { AssistantAvatar, type AvState } from './AssistantAvatar';
import { AsError, asFetch, asTime, asWhen, asVisibleTo, chime, faNum, unlockAudio, type AsAction, type AsMessage, type AsMine, type AsPrefs, type AsThread, type AsProposal } from './api';
import './assistant.css';

type ThreadState = AsThread & { lastId: number; loaded: boolean };
type Mine = { assistants: AsMine[]; prefs: AsPrefs };
const EMPTY: ThreadState = { messages: [], userSeen: [], typing: false, online: false, prefs: { sound: true, dnd: false, dndUntil: null, quiet: false }, lastId: 0, loaded: false };
const KIND_FA: Record<string, string> = { suggestion: 'پیشنهاد', alert: 'هشدار', digest: 'خلاصه', text: '', reminder_proposal: 'پیشنهاد یادآور', brief: 'خلاصه', report: 'گزارش' };
const BUBBLE_MS = 12_000;
/** v4: «بعداً» re-shows the same message once LATER_MS after it was pressed (pressing «بعداً» again re-arms it). Persisted per user so a reload
 *  neither loses nor repeats it; messages snoozed more than a day ago are not resurrected. */
const LATER_MS = 60 * 60_000; const LATER_MAX_AGE_MS = 24 * 3600_000;
const laterStore = (uid: number) => `nas-later-shown-${uid}`;
function loadLater(uid: number): Set<string> { try { const v = JSON.parse(localStorage.getItem(laterStore(uid)) || '[]'); return new Set(Array.isArray(v) ? v.map(String) : []); } catch { return new Set(); } }
function saveLater(uid: number, s: Set<string>) { try { localStorage.setItem(laterStore(uid), JSON.stringify([...s].slice(-200))); } catch { /* storage full / private mode: re-show only lives for this tab */ } }
/** v4: unread assistant messages as a «(۲) » prefix on the tab title; removed when everything is read. */
const TITLE_RX = /^\([۰-۹0-9+]+\)\s/;
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
  const [form, setForm] = useState(false); // v3: a form/modal (not the phone nav menu) — drives the phone «مزاحم نشو» bar
  useEffect(() => {
    let f = 0;
    const check = () => {
      f = 0;
      const shown = Array.from(document.querySelectorAll(OVERLAY_SEL)).filter(el => {
        if (el.closest('.nas-chw,.nas-qr,.diag-layer-content,.diag-backdrop')) return false;
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false;
        const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      setOpen(shown.length > 0);
      setForm(shown.some(el => !el.closest('.mobile-nav-overlay,.mobile-nav-drawer,.sn-panel')));
    };
    const sch = () => { if (!f) f = requestAnimationFrame(check); };
    const mo = new MutationObserver(sch);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-modal', 'open', 'hidden'] });
    sch();
    return () => { mo.disconnect(); if (f) cancelAnimationFrame(f); };
  }, []);
  return { open, form };
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

/* ===== v5 floating «chat head» (drag with mouse/touch, snaps to the nearest side edge, per-user position) ===== */
type Side = 'left' | 'right';
type HeadPos = { side: Side; y: number };
const DRAG_PX = 6; const EDGE = 8;
const headKey = (uid: number) => `nas-head-pos-${uid}`;
function loadHead(uid: number): HeadPos | null { try { const v = JSON.parse(localStorage.getItem(headKey(uid)) || 'null'); return v && (v.side === 'left' || v.side === 'right') && Number.isFinite(v.y) ? { side: v.side, y: v.y } : null; } catch { return null; } }
function saveHead(uid: number, p: HeadPos) { try { localStorage.setItem(headKey(uid), JSON.stringify({ side: p.side, y: Math.round(p.y) })); } catch { /* private mode: position lives for this tab */ } }
/** env(safe-area-inset-*) read once through a hidden probe (0 on desktop browsers). */
function safeInsets() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(d); const cs = getComputedStyle(d);
  const r = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  d.remove(); return r;
}
type Bounds = { minX: number; maxX: number; minY: number; maxY: number; vw: number; vh: number; top: number };
/** Where the head may sit: inside the viewport and safe areas; on phone never over the top bar (sticky on customer/job pages) or the «مزاحم نشو» bar. */
function headBounds(w: number, h: number, phone: boolean, dndBar: boolean): Bounds {
  const vw = window.innerWidth; const vh = window.innerHeight; const s = safeInsets();
  let top = s.top + EDGE;
  if (phone) {
    const tb = document.querySelector<HTMLElement>('.app-main>.topbar');
    const tbh = tb ? Math.max(tb.getBoundingClientRect().height, tb.getBoundingClientRect().bottom) : 68;
    top = Math.max(top, Math.min(tbh, 120) + EDGE);
    if (dndBar) top = Math.max(top, s.top + 44 + EDGE);
  }
  const minX = s.left + EDGE; const maxX = Math.max(minX, vw - s.right - EDGE - w);
  let bottom = vh - s.bottom;
  if (phone) { // never over the phone bottom navigation
    const nav = document.querySelector<HTMLElement>('.mobile-nav-items'); const r = nav?.getBoundingClientRect();
    if (r && r.height > 0 && r.top > vh / 2) bottom = Math.min(bottom, r.top);
  }
  const maxY = Math.max(top, bottom - EDGE - h);
  return { minX, maxX, minY: top, maxY, vw, vh, top };
}
const clampN = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

/** A bubble / typing note / DND card placed next to the head: horizontally away from its edge (desktop) or full width above/below it
 *  (phone), vertically toward the larger free space, always clamped on screen. Measures itself once rendered. */
function HeadPop({ head, side, phone, top, children, testid }: { head: DOMRect | null; side: Side; phone: boolean; top: number; children: ReactNode; testid: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<{ left: number; top: number; width: number; maxH: number; dir: 'h' | 'up' | 'down'; tail: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !head) return;
    const m = () => {
      const vw = window.innerWidth; const vh = window.innerHeight; const s = safeInsets();
      const r = head; const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
      if (!phone) {
        const width = Math.max(220, Math.min(360, (side === 'left' ? vw - r.right : r.left) - 12 - EDGE - s.right));
        const left = clampN(side === 'left' ? r.right + 12 : r.left - 12 - width, EDGE, vw - width - EDGE);
        const maxH = vh - 2 * EDGE; el.style.width = `${width}px`; const ph = Math.min(el.offsetHeight, maxH);
        const t = clampN(cy > vh / 2 ? r.bottom - ph : r.top, EDGE + s.top, vh - ph - EDGE - s.bottom);
        setSt({ left, top: t, width, maxH, dir: 'h', tail: clampN(cy - t, 18, ph - 18) });
      } else {
        const width = vw - 2 * EDGE - s.left - s.right; const left = EDGE + s.left; el.style.width = `${width}px`;
        const above = r.top - 10 - top; const below = vh - s.bottom - EDGE - (r.bottom + 10);
        const down = below >= el.offsetHeight || below >= above;
        const maxH = Math.max(120, down ? below : above); const ph = Math.min(el.offsetHeight, maxH);
        const t = down ? r.bottom + 10 : r.top - 10 - ph;
        setSt({ left, top: clampN(t, top, vh - ph - EDGE - s.bottom), width, maxH, dir: down ? 'down' : 'up', tail: clampN(cx - left, 22, width - 22) });
      }
    };
    m(); const ro = new ResizeObserver(m); ro.observe(el); window.addEventListener('resize', m);
    return () => { ro.disconnect(); window.removeEventListener('resize', m); };
  }, [head?.left, head?.top, head?.width, head?.height, side, phone, top]);
  return <div ref={ref} className={`nas-pop fl d-${st?.dir ?? 'h'} s-${side}`} data-testid={testid} data-dir={st?.dir} data-side={side}
    style={{ left: st?.left ?? -9999, top: st?.top ?? 0, width: st?.width, maxHeight: st?.maxH, visibility: st ? 'visible' : 'hidden', ['--tail' as string]: `${Math.round(st?.tail ?? 24)}px` }}>{children}</div>;
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
export function AssistantDock({ user, bottomOffset, phone }: { user: { id: number; role?: string | null; salespersonId?: number | null } | null | undefined; bottomOffset: number; phone: boolean; slot?: HTMLElement | null }) {
  const allowed = asVisibleTo(user);
  const qc = useQueryClient();
  const [loc, setLocation] = useLocation();
  const ctxCustomer = (() => { const m = /^\/customers\/(\d+)/.exec(loc); return m ? Number(m[1]) : null; })();
  const mine = useQuery({ queryKey: ['assistant-mine', user?.id], enabled: allowed, refetchInterval: 30_000, retry: false, queryFn: () => asFetch<Mine>('/assistant/mine') });
  const list = mine.data?.assistants ?? [];
  const listRef = useRef(list); listRef.current = list;
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
  const { open: overlay, form: formOpen } = useForeignOverlay();
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
  // v3 phone «مزاحم نشو» bar (HANDOFF §1 / shot 12): shown while a form is open; «خاموش کن» hides it for this form only (messages keep queueing).
  const [barOff, setBarOff] = useState(false);
  useEffect(() => { if (!overlay) setBarOff(false); }, [overlay]);
  const dndBar = phone && formOpen && !barOff;
  const dndBarRef = useRef(dndBar); dndBarRef.current = dndBar;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('nas-dnd-on', dndBar);
    return () => root.classList.remove('nas-dnd-on');
  }, [dndBar]);
  // v3 bell: «باز کردن گفتگو» on an assistant row opens that chat (only if it is one of this user's threads).
  useEffect(() => {
    const f = (e: Event) => { const id = Number((e as CustomEvent<{ threadId?: number }>).detail?.threadId); if (id && listRef.current.some(a => a.threadId === id)) { setOpenId(id); setBubble(null); } };
    window.addEventListener('nafis:assistant-open', f); return () => window.removeEventListener('nafis:assistant-open', f);
  }, []);
  // v4 «بعداً» → re-show after 60 min (one 30 s tick; waits while a form is open, the user is typing, or DND is on).
  const uid = user?.id ?? 0;
  const laterShown = useRef<Set<string> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick(x => x + 1), 30_000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!uid || !list.length || bubble || overlay || prefsNow.dnd || typingInField()) return;
    const shown = laterShown.current ??= loadLater(uid); const now = Date.now(); let pick: AsMessage | null = null; let dirty = false;
    for (const a of list) for (const m of threads[a.threadId]?.messages ?? []) {
      if (m.author === 'user' || m.actionTaken !== 'later' || !m.actedAt) continue;
      const at = Date.parse(m.actedAt); const age = now - at;
      // Same snooze = same id with actedAt within 5 min (the local click time and the server's acted_at differ by a little).
      if (!(age >= LATER_MS) || [...shown].some(e => { const [i, t] = e.split(':'); return Number(i) === m.id && Math.abs(Number(t) - at) < 300_000; })) continue;
      shown.add(`${m.id}:${at}`); dirty = true;
      if (age <= LATER_MAX_AGE_MS && openRef.current !== m.threadId && !pick) pick = m;
    }
    if (dirty) saveLater(uid, shown);
    if (pick) { const p = prefsRef.current; if (p.sound && !p.quiet) chime(false); setBubble(pick); }
  }, [tick, threads, list, bubble, overlay, prefsNow.dnd, uid]);
  // v4 tab-title badge: «(۲) …» while assistant messages are unread.
  const unreadTotal = list.reduce((n, a) => n + (a.unread > 0 ? a.unread : 0), 0);
  useEffect(() => {
    const base = document.title.replace(TITLE_RX, '');
    document.title = unreadTotal > 0 ? `(${faNum(unreadTotal)}) ${base}` : base;
  }, [unreadTotal]);
  useEffect(() => () => { document.title = document.title.replace(TITLE_RX, ''); }, []);
  // v5 floating head: position per user (side + y), clamped into view on resize / orientation change.
  const headRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [headRect, setHeadRect] = useState<DOMRect | null>(null);
  const [bTop, setBTop] = useState(EDGE);
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; thread: number | null } | null>(null);
  const place = useCallback((p: HeadPos | null) => {
    const el = headRef.current; const w = el?.offsetWidth || 56; const h = el?.offsetHeight || 56;
    const b = headBounds(w, h, phone, phone && dndBarRef.current); setBTop(b.top);
    const side = p?.side ?? 'left'; const y = clampN(p?.y ?? (b.vh - bottomOffset - h), b.minY, b.maxY);
    setPos({ side, x: side === 'left' ? b.minX : b.maxX, y });
  }, [phone, bottomOffset]);

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
    asFetch(`/assistant/messages/${m.id}/action`, { method: 'POST', body: { action: a } }).then(() => { void qc.invalidateQueries({ queryKey: ['assistant-mine'] }); }).catch(() => undefined);
  }, [setLocation, qc]);

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

  const shown = allowed && list.length > 0;
  const hidePhone = phone && formOpen; // phone form open: the «مزاحم نشو» bar speaks for the assistant; the head never covers form buttons
  useLayoutEffect(() => { if (shown && uid) place(loadHead(uid)); }, [shown, uid, place, list.length, dndBar, hidePhone]);
  useEffect(() => {
    if (!shown || !uid) return;
    const f = () => { if (!drag.current) place(loadHead(uid)); };
    window.addEventListener('resize', f); window.addEventListener('orientationchange', f); window.visualViewport?.addEventListener('resize', f);
    return () => { window.removeEventListener('resize', f); window.removeEventListener('orientationchange', f); window.visualViewport?.removeEventListener('resize', f); };
  }, [shown, uid, place]);
  useLayoutEffect(() => {
    const el = headRef.current; if (!el || !pos) { setHeadRect(null); return; }
    const r = el.getBoundingClientRect(); const t = new DOMRect(pos.x, pos.y, r.width, r.height); setHeadRect(t);
  }, [pos, list.length]);
  const tap = (threadId: number) => {
    if (bubble && bubble.threadId === threadId) { setOpenId(threadId); setBubble(null); return; } // bubble open: as before (opens its chat)
    if (bubble) setBubble(null);
    setOpenId(o => o === threadId ? null : threadId); // no bubble: the chat panel opens directly (a second tap closes it)
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pos || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]');
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, thread: t ? Number(t.dataset.thread) : null };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection; focus stays where it was
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    e.preventDefault();
    const el = headRef.current!; const b = headBounds(el.offsetWidth, el.offsetHeight, phone, dndBar);
    setPos(p => ({ side: p?.side ?? 'left', x: clampN(d.ox + dx, b.minX, b.maxX), y: clampN(d.oy + dy, b.minY, b.maxY) }));
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return; drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (e.type === 'pointercancel') { setDragging(false); place(loadHead(uid)); return; }
    if (!d.moved) { if (d.thread) tap(d.thread); return; }
    setDragging(false);
    const el = headRef.current!; const b = headBounds(el.offsetWidth, el.offsetHeight, phone, dndBar);
    const x = clampN(d.ox + e.clientX - d.sx, b.minX, b.maxX); const y = clampN(d.oy + e.clientY - d.sy, b.minY, b.maxY);
    const p: HeadPos = { side: x + el.offsetWidth / 2 < b.vw / 2 ? 'left' : 'right', y };
    saveHead(uid, p); place(p);
  };
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pos) return; const step = e.shiftKey ? 48 : 16;
    const m: Record<string, HeadPos> = { ArrowUp: { side: pos.side, y: pos.y - step }, ArrowDown: { side: pos.side, y: pos.y + step }, ArrowLeft: { side: 'left', y: pos.y }, ArrowRight: { side: 'right', y: pos.y } };
    if (!(e.key in m)) return; e.preventDefault(); const el = headRef.current!; const b = headBounds(el.offsetWidth, el.offsetHeight, phone, dndBar);
    const p = { ...m[e.key], y: clampN(m[e.key].y, b.minY, b.maxY) }; saveHead(uid, p); place(p);
  };

  if (!shown) return null;
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
  const active = list.some(a => a.unread > 0 || threads[a.threadId]?.typing);
  const avatars = <div className="nas-avs">
        {list.map(a => {
          const t = threads[a.threadId]; const st: AvState = prefsNow.dnd || overlay ? 'dnd' : t?.typing ? 'think' : bubble?.threadId === a.threadId ? 'attn' : 'idle';
          const online = t?.online ?? a.online; const hot = a.unread > 0 || Boolean(t?.typing);
          return <button key={a.id} type="button" className="nas-fav" data-thread={a.threadId} onClick={e => { if (e.detail === 0) tap(a.threadId); }}
            aria-label={`${a.label}${a.unread ? ` — ${a.unread} پیام تازه` : ''} — برای گفتگو بزنید، برای جابه‌جایی بکشید`} aria-expanded={openId === a.threadId} data-testid={`button-assistant-${a.slug}`} data-active={hot ? '1' : undefined}>
            <AssistantAvatar slug={a.slug} state={st} size={phone ? 52 : 56} robot={hot ? 'active' : 'idle'} />
            <i className={`dt${online ? '' : ' nc'}`} title={online ? 'وصل' : 'وصل نیست'} data-testid={`assistant-dot-${a.slug}`} />
            {a.unread > 0 ? <b className="bd2" data-testid={`assistant-unread-${a.slug}`}>{faNum(a.unread)}</b> : null}
            {t?.typing ? <span className="tyb" data-testid={`assistant-typing-dot-${a.slug}`}><i /><i /><i /></span> : null}
            {prefsNow.dnd || overlay ? <span className="moon"><Moon size={12} /></span> : null}
          </button>;
        })}
      </div>;
  const side = pos?.side ?? 'left';
  const chatSent = (m: AsMessage) => setThreads(prev => { const t = prev[m.threadId] ?? EMPTY; if (t.messages.some(x => x.id === m.id)) return prev; return { ...prev, [m.threadId]: { ...t, messages: [...t.messages, m], lastId: Math.max(t.lastId, m.id) } }; });
  return <>
    {pollers}
    {!hidePhone ? <div ref={headRef} className={`nas-head s-${side}${dragging ? ' drag' : ''}${active ? ' act' : ''}`} dir="rtl" data-testid="assistant-dock" data-placement="floating" data-side={side} data-dragging={dragging ? '1' : undefined}
      style={{ transform: pos ? `translate3d(${Math.round(pos.x)}px,${Math.round(pos.y)}px,0)` : undefined, visibility: pos ? 'visible' : 'hidden' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKeys} onDragStart={e => e.preventDefault()}>
      {avatars}
    </div> : null}
    {!dragging && !hidePhone && pop ? <HeadPop head={headRect} side={side} phone={phone} top={bTop} testid="assistant-pop">{pop}</HeadPop> : null}
    {!dragging && !phone && overlay ? <HeadPop head={headRect} side={side} phone={false} top={bTop} testid="assistant-dnd-card"><div className="nas-dndc"><Moon size={14} /> <span><b>مزاحم نشو</b> تا این پنجره باز است{queued ? ` · ${faNum(queued)} پیام در صف` : ''}</span></div></HeadPop> : null}
    {dndBar ? createPortal(<div className="nas-dndbar" role="status" aria-live="polite" dir="rtl" data-testid="assistant-dnd-bar">
      <Moon size={18} aria-hidden="true" /><span className="t"><b>مزاحم نشو</b> — تا این فرم باز است؛ {queued ? `${faNum(queued)} پیام در صف` : 'پیام‌ها در صف می‌مانند'}</span>
      <button type="button" onClick={() => setBarOff(true)} data-testid="button-assistant-dnd-bar-off">خاموش کن</button>
    </div>, document.body) : null}
    {openA ? <ChatPanel a={openA} t={openThread ?? EMPTY} prefs={prefsNow} phone={phone} customerId={ctxCustomer} onClose={() => setOpenId(null)} onAct={act} onPrefs={savePrefs} onDecided={decided} onSent={chatSent} /> : null}
    {quickFor ? <QuickReminder m={quickFor} onClose={() => setQuickFor(null)} onFull={() => { setRemindFor(quickFor); setQuickFor(null); }} /> : null}
    {remindFor ? <CreateReminderForm onClose={() => setRemindFor(null)} /> : null}
  </>;
}

/** v5 quick buttons. «ctx» chips are about the customer page that is open (sent with its customerId; the server checks scope). */
type Chip = { label: string; body: string; ctx?: boolean };
const CHIPS: Record<'sales' | 'filing', Chip[]> = {
  sales: [{ label: 'بعدی کیه؟', body: 'بعدی کیه؟' }, { label: 'خلاصه‌ی این مشتری', body: 'خلاصه‌ی این مشتری', ctx: true }, { label: 'لیست مدارک', body: 'لیست مدارک این مشتری', ctx: true }],
  filing: [{ label: 'پرونده‌های منتظر ثبت', body: 'پرونده‌های منتظر ثبت' }, { label: 'خلاصه‌ی این مشتری', body: 'خلاصه‌ی این مشتری', ctx: true }, { label: 'لیست مدارک', body: 'لیست مدارک این مشتری', ctx: true }],
};
/** Phone: keep the chat (and its input) inside the visual viewport, so the on-screen keyboard never covers the input. */
function useVisualViewport(on: boolean) {
  const [vv, setVv] = useState<{ h: number; t: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport; if (!on || !v) { setVv(null); return; }
    const m = () => setVv({ h: Math.round(v.height), t: Math.round(v.offsetTop) });
    m(); v.addEventListener('resize', m); v.addEventListener('scroll', m);
    return () => { v.removeEventListener('resize', m); v.removeEventListener('scroll', m); };
  }, [on]);
  return vv;
}
function ChatPanel({ a, t, prefs, phone, customerId, onClose, onAct, onPrefs, onSent, onDecided }: { a: AsMine; t: ThreadState; prefs: AsPrefs; phone: boolean; customerId: number | null; onClose: () => void; onAct: (m: AsMessage, a: AsAction) => void; onDecided: (m: AsMessage, p: AsProposal) => void; onPrefs: (b: { sound?: boolean; dndMinutes?: number }) => void; onSent: (m: AsMessage) => void }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null); const inp = useRef<HTMLTextAreaElement>(null);
  const vv = useVisualViewport(phone);
  useEffect(() => { if (vv && document.activeElement === inp.current) { body.current?.scrollTo({ top: body.current.scrollHeight }); inp.current?.scrollIntoView({ block: 'nearest' }); } }, [vv?.h, vv?.t]);
  const onFocus = () => { window.setTimeout(() => { inp.current?.scrollIntoView({ block: 'nearest' }); body.current?.scrollTo({ top: body.current.scrollHeight }); }, 300); };
  const seen = useMemo(() => new Map(t.userSeen.map(s => [s.id, s.seen])), [t.userSeen]);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [t.messages.length, t.typing]);
  useEffect(() => { const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc); }, [onClose]);
  const send = async (e?: FormEvent, preset?: string, ctx?: boolean) => {
    e?.preventDefault(); const b = (preset ?? text).trim(); if (!b || busy) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { body: b, clientId: `c${Date.now()}${Math.random().toString(36).slice(2, 7)}` };
      if (ctx && customerId) payload.customerId = customerId;
      const r = await asFetch<{ message: AsMessage }>(`/assistant/threads/${a.threadId}/messages`, { method: 'POST', body: payload }); onSent(r.message); if (preset === undefined) setText('');
    } catch (err) {
      const x = err as AsError;
      toast({ title: ctx && x.status === 404 ? 'این مشتری در فهرست این دستیار نیست.' : x.message });
    } finally { setBusy(false); }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } };
  const online = t.loaded ? t.online : a.online;
  return <div className={`nas-chw${phone ? ' ph' : ''}`} role="dialog" aria-label={a.label} data-testid="assistant-chat" style={phone && vv ? { top: vv.t, height: vv.h, bottom: 'auto' } : undefined}>
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
        ? <div key={m.id} className="msg mine"><div className="bdy">{m.body}</div><span className="tm">{asTime(m.createdAt)}{m.customerName ? ` · ${m.customerName}` : ''} · {(seen.get(m.id) ?? Boolean(m.pickedAt)) ? <><CheckCheck size={13} /> دیده شد</> : <><Check size={13} /> در صف</>}</span></div>
        : m.author === 'system' ? <div key={m.id} className="sys">{m.body}</div>
        : <div key={m.id} className={`msg as k-${m.kind}${m.priority === 'high' ? ' hi' : ''}`}>
          {KIND_FA[m.kind] || m.customerName ? <div className="kl">{KIND_FA[m.kind]}{m.priority === 'high' ? ' · فوری' : ''}{m.customerName ? <span className="cu"> · {m.customerName}</span> : null}</div> : null}
          <div className="bdy">{m.body}</div>
          {m.kind === 'reminder_proposal' ? <ProposalCard m={m} onDecided={onDecided} /> : (m.kind === 'suggestion' || m.kind === 'alert') && !m.actedAt ? <MsgActions m={m} onAct={onAct} compact /> : null}
          <span className="tm">{asTime(m.createdAt)}{m.actionTaken ? ` · ${{ call: 'تماس', remind: 'یادآور', copy: 'کپی شد', later: 'بعداً' }[m.actionTaken] ?? ''}` : ''}{m.suppressed === 'dnd' ? ' · نگه‌داشته‌شده در مزاحم نشو' : m.suppressed === 'digested' ? ' · در خلاصه' : ''}</span>
        </div>)}
      {t.typing ? <div className="typ"><span className="dots"><i /><i /><i /></span>در حال نوشتن…</div> : null}
    </div>
    <div className="nas-chips" data-testid="assistant-chips">{CHIPS[a.kind].map(c => <button key={c.label} type="button" disabled={busy || (c.ctx && !customerId)} title={c.ctx && !customerId ? 'اول صفحه‌ی یک مشتری را باز کنید' : undefined}
      onClick={() => void send(undefined, c.body, c.ctx)} data-testid={`chip-${c.ctx ? (c.body.includes('مدارک') ? 'docs' : 'summary') : 'next'}`}>{c.label}</button>)}
      {!customerId ? <span className="hint">برای «خلاصه» و «مدارک»، صفحه‌ی مشتری را باز کنید.</span> : null}</div>
    <form className="chf" onSubmit={send}>
      <textarea className="inp" rows={1} value={text} maxLength={2000} onChange={e => setText(e.target.value)} onKeyDown={keys} onFocus={onFocus} ref={inp} placeholder={`پیام به ${a.label}…`} aria-label="متن پیام" data-testid="input-as-message" />
      <button type="submit" className={`snd${text.trim() ? '' : ' off'}`} disabled={!text.trim() || busy} aria-label="ارسال" data-testid="button-as-send"><Send size={20} /></button>
    </form>
  </div>;
}
