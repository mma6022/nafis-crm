import { AutoGrowTextarea } from '../../components/AutoGrowTextarea';
/**
 * REMINDER-B — mandatory due-reminder popup (Armita crm-reminder-incoming v1.1 scenes 08–15).
 * Mounted once in CrmShell for users 8/2/3 only; renders nothing unless the server says flag.reminder_must is on for this user.
 * - role=alertdialog, no ×, Esc / outside click do nothing; it closes only when the server accepted the result (200).
 * - Waits while another form / dialog is open or the user is typing (yellow «n یادآور سررسید شد» line instead).
 * - One 10-minute snooze for the whole queue (server-enforced) → sticky yellow bar with a countdown and «الان باز کن».
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, BellRing, Check, Clock, Info, Phone, TriangleAlert } from 'lucide-react';
import { announceCallSaved, faClock, faNum } from '@/features/call-queue/api';
import { rmApi, useRmConfig, type RmFeed, type RmItem, type RmNext, type RmOutcome } from './api';
import { ManualOutcomeField } from '@/features/call-queue/ResultFields';
import { C3File, C3History } from '@/features/history/TodayC3';
import { RctIcon, RctPicker, addDays, faDayLong, rctFromIso, rctIso, rctLong, rctModel, rctShort, type RctVal } from './CustomTime';
import './reminder-must.css';
import './rct.css';

const OVERLAY_SEL = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],.modal-backdrop,.call-sheet-backdrop,.ch-backdrop,.ic-sheet,[vaul-drawer],.dp-inbound';
const fa = faNum;
const len = (s: string) => [...s.trim()].length;
const dayLabel = (iso: string, nowIso: string) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' });
  const a = d.format(new Date(iso)), b = d.format(new Date(nowIso)), y = d.format(new Date(Date.parse(nowIso) - 86_400_000));
  if (a === b) return 'امروز'; if (a === y) return 'دیروز';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' }).format(new Date(iso));
};
// Release 81: step 1 asks the required manual «نتیجه‌ی تماس» (call_logs.manual_outcome); the reminder outcome is derived from it
// (جواب داد → answered, otherwise no_answer). «یادآور بعدی» in step 2 still covers the follow-up.
type RmManual = 'answered' | 'no_answer' | 'off_or_busy';
const NEXT: { v: RmNext; l: string; s: string }[] = [
  { v: 'tomorrow_am', l: 'فردا صبح', s: 'ساعت ۱۰:۰۰' }, { v: 'today_pm', l: 'امروز عصر', s: 'ساعت ۱۷:۰۰' },
  { v: 'in_3_days', l: '۳ روز دیگه', s: 'ساعت ۱۰:۰۰' }, { v: 'none', l: 'یادآور لازم نیست', s: 'قدم بعد در پرونده' },
  { v: 'custom', l: 'زمان دلخواه', s: 'روز و ساعت را خودت انتخاب کن' },
];
const callKey = (id: number) => `rm-call-${id}`;
/** CARD-FIX (Armita rem3 review §4): a reminder more than 15 minutes past its time is «عقب‌افتاده». */
const RM_OVERDUE_MS = 15 * 60_000;

function useBusy(active: boolean) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) { setBusy(false); return; }
    let f = 0;
    const check = () => {
      f = 0;
      const shown = Array.from(document.querySelectorAll(OVERLAY_SEL)).some((el) => {
        if (el.closest('.rmm-root,.nas-chw,.nas-qr,.diag-layer-content,.diag-backdrop,.mobile-nav-overlay,.mobile-nav-drawer,.sn-panel')) return false;
        const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false;
        const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const el = document.activeElement as HTMLElement | null;
      const typing = Boolean(el && !el.closest('.rmm-root,.nas-chw') && (el.tagName === 'TEXTAREA' || el.isContentEditable
        || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'search'].includes((el as HTMLInputElement).type)))
        && String((el as HTMLInputElement).value ?? el.textContent ?? '').trim());
      setBusy(shown || typing);
    };
    const sch = () => { if (!f) f = requestAnimationFrame(check); };
    const mo = new MutationObserver(sch);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-modal', 'open', 'hidden'] });
    document.addEventListener('focusin', sch); document.addEventListener('focusout', sch); document.addEventListener('input', sch);
    const iv = window.setInterval(sch, 2000); sch();
    return () => { mo.disconnect(); document.removeEventListener('focusin', sch); document.removeEventListener('focusout', sch); document.removeEventListener('input', sch); window.clearInterval(iv); if (f) cancelAnimationFrame(f); };
  }, [active]);
  return busy;
}

export function ReminderMustHost({ userId }: { userId: number }) {
  const cfg = useRmConfig(userId).data;
  const on = cfg?.enabled === true;
  const qc = useQueryClient();
  const feedQ = useQuery({ queryKey: ['reminder-must', 'feed', userId], queryFn: rmApi.feed, enabled: on, refetchInterval: 30_000, refetchOnWindowFocus: true, retry: false });
  const feed = on ? feedQ.data ?? null : null;
  const [now, setNow] = useState(() => Date.now());
  const skew = useRef(0);
  useEffect(() => { if (feed) skew.current = Date.parse(feed.serverNow) - Date.now(); }, [feed]);
  const snoozeLeft = feed?.snooze.active && feed.snooze.until ? Math.max(0, Date.parse(feed.snooze.until) - (now + skew.current)) : 0;
  useEffect(() => { if (!snoozeLeft) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [snoozeLeft > 0]);
  const expired = Boolean(feed?.snooze.active && snoozeLeft === 0);
  useEffect(() => { if (expired) void feedQ.refetch(); }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps
  const [forceOpen, setForceOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState('');
  const items = feed?.workTime ? feed.items : [];
  const head = items[0] ?? null;
  const snoozed = Boolean(head && snoozeLeft > 0 && !forceOpen);
  const busy = useBusy(on && Boolean(head) && !open);
  useEffect(() => { if (head && !snoozed && !busy && !open) setOpen(true); if (!head && open) setOpen(false); }, [head, snoozed, busy, open]);
  useEffect(() => { if (!snoozeLeft) setForceOpen(false); }, [snoozeLeft]);
  useEffect(() => { const r = document.documentElement; r.classList.toggle('rmm-open', open); return () => r.classList.remove('rmm-open'); }, [open]);
  const done = useCallback(async (remaining: number, nextLine?: string) => {
    setOpen(false); setForceOpen(false);
    const rest = remaining > 0 ? `یادآور سررسید بعدی (${fa(remaining)} مانده) باز می‌شود` : 'یادآور سررسید دیگری نداری';
    setToast(nextLine ? `نتیجه ثبت شد. ${nextLine}؛ ${rest}` : remaining > 0 ? `ثبت شد؛ یادآور بعدی (${fa(remaining)} مانده) باز می‌شود` : 'ثبت شد؛ یادآور سررسید دیگری نداری');
    window.setTimeout(() => setToast(''), 5000);
    await qc.invalidateQueries({ queryKey: ['reminder-must', 'feed', userId] });
  }, [qc, userId]);
  // SNZ-CLOSE: write the accepted snooze into the cached feed in the same render that closes the dialog; otherwise the
  // auto-open effect sees the stale feed (snooze inactive) and reopens the same reminder before the refetch lands.
  const snoozedNow = useCallback(async (until: string) => {
    qc.setQueryData<RmFeed>(['reminder-must', 'feed', userId], (f) => f ? { ...f, snooze: { ...f.snooze, active: true, until, used: true, available: false } } : f);
    setNow(Date.now()); setOpen(false); setForceOpen(false);
    await qc.invalidateQueries({ queryKey: ['reminder-must', 'feed', userId] });
  }, [qc, userId]);
  if (!on || !feed) return toast ? createPortal(<div className="rmm-root"><div className="rmm-toast" role="status" data-testid="rm-toast"><Check size={16} aria-hidden="true" /> {toast}</div></div>, document.body) : null;
  return createPortal(<div className="rmm-root" data-testid="rm-root">
    {head && !open && snoozed ? <div className="rmm-snb" role="status" data-testid="rm-snoozed">
      <AlarmClock size={18} aria-hidden="true" />
      <span><b>{fa(items.length)} یادآور</b> (اولی {head.customerName} <span className="rmm-id">#{fa(head.customerId)}</span>)، <b className="rmm-cdn" data-testid="rm-countdown">{fa(new Date(snoozeLeft).toISOString().slice(14, 19))}</b> دیگر دوباره باز می‌شود · این بار بدون مهلت</span>
      <button type="button" className="btn btn-primary" onClick={() => setForceOpen(true)} data-testid="rm-open-now">الان باز کن</button>
    </div> : null}
    {head && !open && !snoozed && busy ? <p className="rmm-rq" role="status" data-testid="rm-queued"><BellRing size={15} aria-hidden="true" />
      <span><b className="rmm-qn">{fa(items.length)}</b> یادآور سررسید شد؛ بعد از ثبت این فرم یکی‌یکی باز می‌شوند</span></p> : null}
    {open && head ? <MustDialog key={head.reminderId} feed={feed} item={head} index={1} total={items.length} rest={items.slice(1)} onDone={done}
      onSnoozed={snoozedNow} /> : null}
    {toast ? <div className="rmm-toast" role="status" data-testid="rm-toast"><Check size={16} aria-hidden="true" /> {toast}</div> : null}
  </div>, document.body);
}

function MustDialog({ feed, item, index, total, rest, onDone, onSnoozed }: { feed: RmFeed; item: RmItem; index: number; total: number; rest: RmItem[];
  onDone: (remaining: number, nextLine?: string) => void; onSnoozed: (until: string) => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [manual, setManual] = useState<RmManual | null>(null);
  const outcome: RmOutcome | null = manual == null ? null : manual === 'answered' ? 'answered' : 'no_answer';
  const [note, setNote] = useState('');
  const [next, setNext] = useState<RmNext | null>(null);
  const [reason, setReason] = useState('');
  // Q1 custom time: `ct` is the confirmed value (kept when another card is picked — PM: keep it in the UI, save only the selected card).
  const [ct, setCt] = useState<RctVal | null>(null);
  const [pk, setPk] = useState(false);
  const [prevNext, setPrevNext] = useState<RmNext | null>(null);
  const [ctBad, setCtBad] = useState(false);
  const [live, setLive] = useState('');
  const hoursRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const pkRef = useRef(false); pkRef.current = pk;
  const cancelRef = useRef<() => void>(() => {});
  const [err, setErr] = useState('');
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const [fileToast, setFileToast] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const r = feed.rules;
  const skewMs = useMemo(() => Date.parse(feed.serverNow) - Date.now(), [feed.serverNow]);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 60_000); return () => window.clearInterval(t); }, []);
  const cm = useMemo(() => (r.custom ? rctModel(r.custom, Date.now() + skewMs) : null), [r.custom, skewMs, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const presetSub = (v: RmNext): string | null => {
    if (!cm || !r.custom) return null;
    const work = (d: string) => !cm.closed(d) && !cm.hol.has(d);
    const nextWork = (d: string, same: boolean) => { let x = same ? d : addDays(d, 1); for (let i = 0; i < 40 && !work(x); i++) x = addDays(x, 1); return x; };
    if (v === 'tomorrow_am') return `${faDayLong(nextWork(cm.today, false))}، ${fa('10:00')}`;
    if (v === 'in_3_days') return `${faDayLong(nextWork(addDays(cm.today, 3), true))}، ${fa('10:00')}`;
    if (v === 'today_pm') return `امروز، ساعت ${fa('17:00')}`;
    return null;
  };
  useEffect(() => { void rmApi.shown(item.reminderId).catch(() => {}); }, [item.reminderId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pkRef.current) cancelRef.current(); } };
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true);
  }, []);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('h2')?.focus(); }, [step]);
  const first = (item.customerName ?? '').trim().split(/\s+/)[0] || 'مشتری';
  const when = `${dayLabel(item.remindAt, feed.serverNow)} ${faClock(item.remindAt)}`;
  const overdue = Date.parse(feed.serverNow) - Date.parse(item.remindAt) > RM_OVERDUE_MS;
  const eyebrow = item.outsideHours ? `سررسید ${when}، بیرون از ساعت کاری بود؛ با ورودت باز شد` : `یادآور ${fa(index)} از ${fa(total)}، ${overdue ? 'سررسید' : 'سر وقت'} ${when}`;
  const [qAll, setQAll] = useState(false);
  const qShown = qAll ? rest : rest.slice(0, 3);
  const qFull = rest.map((x) => `${faClock(x.remindAt)} ${x.customerName || 'بدون نام'}`).join('، ');
  const noteErr = !outcome ? 'نتیجه‌ی تماس را انتخاب کن.' : len(note) < r.noteMin ? `یادداشت یک‌خطی حداقل ${fa(r.noteMin)} نویسه.` : '';
  const ctBlock = next === 'custom' && (!ct || pk);
  const ctHint = !ctBlock ? '' : !ct && !pk ? 'برای «زمان دلخواه» روز و ساعت را انتخاب کن.' : pk && !ct ? 'برای «زمان دلخواه» یک ساعت انتخاب کن و «تأیید زمان» را بزن؛ تا آن موقع ثبت خاموش است.' : '«تأیید زمان» را بزن تا ثبت روشن شود.';
  const nextErr = !next ? 'قدم بعد را انتخاب کن.' : ctBlock ? ctHint : next !== 'none' && len(reason) < r.reasonMin ? 'دلیل یادآور بعدی را بنویس.' : '';
  const say = (t: string) => { setLive(''); window.setTimeout(() => setLive(t), 30); };
  const pickCard = (v: RmNext, viaKey = false) => {
    if (v === 'custom') {
      if (next !== 'custom') setPrevNext(next);
      setNext('custom'); setCtBad(false);
      if (!pk) setPk(true);
      if (!viaKey) window.setTimeout(() => (document.querySelector<HTMLElement>('#rct-pk .rct-day.on') ?? document.querySelector<HTMLElement>('#rct-pk .rct-day[tabindex="0"]'))?.focus(), 30);
      return;
    }
    if (pk) { setPk(false); say(ct ? 'پنل زمان دلخواه بسته شد؛ زمان انتخابی نگه داشته شد ولی ثبت نمی‌شود.' : 'زمان دلخواه کنار رفت'); }
    setNext(v); setCtBad(false);
  };
  cancelRef.current = () => {
    setPk(false); setCtBad(false);
    if (!ct) { setNext(prevNext); say('زمان دلخواه کنار رفت'); }
    window.setTimeout(() => cardsRef.current?.querySelector<HTMLElement>('[data-testid="rm-next-custom"]')?.focus(), 30);
  };
  const cardKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const opts = NEXT.filter((n) => !(n.v === 'today_pm' && !r.todayPmOpen) && !(n.v === 'custom' && !cm));
    const i = Math.max(0, opts.findIndex((n) => n.v === next));
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : -1; // RTL: ← goes forward
    const t = opts[(i + d + opts.length) % opts.length]; e.preventDefault();
    pickCard(t.v, true);
    window.setTimeout(() => cardsRef.current?.querySelector<HTMLElement>(`[data-testid="rm-next-${t.v}"]`)?.focus(), 0);
  };
  const snooze = async () => { setSending(true); setErr(''); try { const r = await rmApi.snooze(); onSnoozed(r.until); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setSending(false); } };
  const submit = async () => {
    setShow(true); if (noteErr) { setStep(1); return; }
    if (ctBlock) { setCtBad(true); if (!pk) setPk(true); window.setTimeout(() => (hoursRef.current?.querySelector<HTMLElement>('.rct-h:not([aria-disabled])') ?? hoursRef.current)?.focus(), 30); return; }
    if (nextErr) return;
    setSending(true); setErr('');
    try {
      let callId = Number(sessionStorage.getItem(callKey(item.reminderId)) || 0);
      if (!callId) {
        const one = note.trim(); // NOMAX: keep line breaks; the server normalizes (noteText)
        const c = await rmApi.saveCall({ customerId: item.customerId, subject: 'یادآور سررسید', customerRequest: '', expertNotes: one, outcome, call_result: manual, oneLineNote: one, outOfList: true, context: 'out_of_list' });
        callId = c.id; sessionStorage.setItem(callKey(item.reminderId), String(callId)); announceCallSaved(callId, item.customerId);
      }
      const res = await rmApi.complete(item.reminderId, { callId, outcome: outcome!, note: note.trim(), next: next!, reason: reason.replace(/\s+/g, ' ').trim(),
        ...(next === 'custom' && ct ? { remindAt: rctIso(ct) } : {}) });
      sessionStorage.removeItem(callKey(item.reminderId));
      onDone(res.remaining, res.nextAt ? `یادآور بعدی ${item.customerName?.trim() || 'مشتری'}: ${rctLong(rctFromIso(res.nextAt))}` : undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ثبت نشد. دوباره بزن.');
      if (next === 'custom' && /^remind_at_/.test(String((e as { code?: string })?.code ?? ''))) { setCt(null); setPk(true); }
    } finally { setSending(false); }
  };
  const steps = ['تماس', 'نتیجه', 'قدم بعد'];
  const savedToast = (t: string) => { setFileToast(t); window.setTimeout(() => setFileToast(''), 4000); };
  // REMINDER-3COL: same three columns as «کارهای امروز من» (C3History | middle | C3File); same endpoints and server checks
  // (own customer only, expert_lockdown unchanged). Mobile (<1024px): one column, middle first, the two sides as closed sections.
  return <div className="rmm-x" data-testid="rm-overlay">
    <div className="rmm-d rmm-c3" role="alertdialog" aria-modal="true" aria-labelledby="rmm-t" aria-describedby="rmm-must" data-noclose ref={ref} data-testid="rm-dialog">
      <header className="rmm-h">
        <p className="rmm-eb" data-testid="rm-eyebrow"><Clock size={14} aria-hidden="true" /> {eyebrow}{overdue ? <span className="rmm-od" data-testid="rm-overdue">عقب‌افتاده</span> : null}</p>
        <h2 id="rmm-t" tabIndex={-1}>وقت تماس با {item.customerName?.trim() || 'بدون نام'}</h2>
      </header>
      <p className="rmm-must" id="rmm-must"><TriangleAlert size={14} aria-hidden="true" /> تا نتیجه ثبت نشود این پنجره بسته نمی‌شود</p>
      <div className="c3g rmm-g" data-testid="rm-c3">
        <C3History customerId={item.customerId} />
        <div className="c3m rmm-m" data-testid="rm-middle">
          <ol className="rmm-stp" aria-label="مراحل">{steps.map((s, i) => <li key={s} className={i < step ? 'dn' : i === step ? 'cu' : ''} aria-current={i === step ? 'step' : undefined}>{fa(i + 1)}. {s}</li>)}</ol>
          <div className="rmm-who"><span className="rmm-id" data-testid="rm-id">#{fa(item.customerId)}</span> <span className="rmm-ph" dir="ltr" data-testid="rm-phone">{fa(item.phoneMasked)}</span></div>
          <div className="rmm-rsn"><h3>متن یادآور</h3><p data-testid="rm-reason">{item.reason || item.subject || '—'}</p><small>{item.createdBy}، ساخته‌شده {dayLabel(item.createdAt, feed.serverNow)} {faClock(item.createdAt)}</small></div>
          {step === 0 && rest.length ? <p className="rmm-qnx" title={qFull} data-testid="rm-next-list"><span>بعد از این، به ترتیب ساعت:</span> {qShown.map((x) => `${faClock(x.remindAt)} ${x.customerName || 'بدون نام'}`).join('، ')}
            {rest.length > 3 ? <button type="button" className="rmm-qmore" aria-expanded={qAll} onClick={() => setQAll(!qAll)} data-testid="rm-next-more">{qAll ? 'کمتر' : `و ${fa(rest.length - 3)} یادآور دیگر`}</button> : null}</p> : null}
        {step === 1 ? <div className="rmm-b">
          <ManualOutcomeField value={manual ?? ''} onChange={(v) => setManual(v)} showError={show && !manual} idPrefix="rm" submitLabel="بعدی" />
          <label className="rmm-f"><span>یادداشت تماس <small>(اجباری)</small></span>
            <AutoGrowTextarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: مدارک را فردا می‌فرستد" data-testid="rm-note" aria-invalid={show && Boolean(noteErr)} />
            <small className={len(note) < r.noteMin ? 'bad' : ''}>{fa(len(note))} نویسه، حداقل {fa(r.noteMin)}</small></label>
          {show && noteErr ? <p className="rmm-err" role="alert">{noteErr}</p> : null}
        </div> : null}
        {step === 2 ? <div className="rmm-b">
          <fieldset className="rmm-nxc rct-cards"><legend id="rct-lg">یادآور بعدی</legend>
            <div className="rct-cw" role="radiogroup" aria-labelledby="rct-lg" ref={cardsRef} onKeyDown={cardKey}>{NEXT.filter((n) => n.v !== 'custom' || cm).map((n) => {
            const dis = n.v === 'today_pm' && !r.todayPmOpen;
            const sub = dis ? 'دیگر ممکن نیست' : n.v === 'custom' ? (ct ? rctShort(ct) : n.s) : presetSub(n.v) ?? n.s;
            const tabSel = next ? next === n.v : n.v === 'tomorrow_am';
            return <button key={n.v} type="button" role="radio" className={`rmm-nx rct-c${next === n.v ? ' on' : ''}${n.v === 'custom' ? ' rct-cu' : ''}`} aria-disabled={dis ? true : undefined}
              aria-checked={next === n.v} tabIndex={tabSel ? 0 : -1} onClick={() => { if (!dis) pickCard(n.v); }} data-testid={`rm-next-${n.v}`}
              {...(n.v === 'custom' ? { 'aria-expanded': pk, 'aria-controls': 'rct-pk' } : {})}>
              <span className="rct-t">{n.v === 'custom' ? <RctIcon size={15} aria-hidden="true" /> : null}{n.l}</span><small>{sub}</small></button>; })}</div>
            {next === 'custom' && pk && cm && r.custom ? <RctPicker rules={r.custom} model={cm} initial={ct} bad={ctBad} hoursRef={hoursRef} announce={say}
              onConfirm={(v) => { setCt(v); setPk(false); setCtBad(false); say(`یادآور بعدی: ${rctLong(v)}`); window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="rct-change"]')?.focus(), 30); }}
              onCancel={() => cancelRef.current()} /> : null}
            {next === 'custom' && !pk && ct ? <div className="rct-sum" data-testid="rct-summary"><span><Check size={16} aria-hidden="true" /> یادآور بعدی: <b>{rctLong(ct)}</b></span>
              <button type="button" className="btn btn-ghost" onClick={() => { setPk(true); }} data-testid="rct-change">تغییر</button></div> : null}
            <p className="vh" aria-live="polite" data-testid="rct-live">{live}</p>
          </fieldset>
          {next && next !== 'none' ? <label className="rmm-f"><span>دلیل یادآور بعدی</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: پیگیری ارسال مدارک" data-testid="rm-reason-next" />
            <small>{fa(len(reason))} نویسه</small></label> : null}
          {ctBlock ? <p className={`rct-sh${ctBad ? ' bad' : ''}`} role={ctBad ? 'alert' : undefined} data-testid="rct-hint"><Info size={15} aria-hidden="true" /> {ctHint}</p>
            : show && nextErr ? <p className="rmm-err" role="alert">{nextErr}</p> : null}
        </div> : null}
        {err ? <p className="rmm-err rmm-err-b" role="alert" data-testid="rm-error">{err}</p> : null}
        <footer className="rmm-f2">
          {step === 0 ? <>
            {item.tel ? <a className="btn rmm-call" href={`tel:${item.tel}`} data-testid="rm-call"><Phone size={16} aria-hidden="true" /> تماس با {first}</a> : null}
            <button type="button" className="btn btn-primary rmm-p" onClick={() => setStep(1)} data-testid="rm-to-result">ثبت نتیجه</button>
            {feed.snooze.available ? <button type="button" className="btn btn-ghost rmm-snz" disabled={sending} onClick={() => void snooze()} data-testid="rm-snooze">
              <AlarmClock size={16} aria-hidden="true" /><span>الان مشتری جدید دارم — فقط یک بار<small>۱۰ دقیقه بعد دوباره باز می‌شود</small></span></button>
              : <p className="rmm-nosnz" data-testid="rm-no-snooze"><AlarmClock size={14} aria-hidden="true" /> مهلت ۱۰ دقیقه‌ای استفاده شد؛ این بار بدون مهلت.</p>}
          </> : null}
          {step === 1 ? <>
            <button type="button" className="btn btn-primary rmm-p" onClick={() => { setShow(true); if (!noteErr) { setShow(false); setStep(2); } }} data-testid="rm-continue">ادامه</button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>قبلی</button>
          </> : null}
          {step === 2 ? <>
            <button type="button" className="btn btn-primary rmm-p" disabled={sending} aria-disabled={ctBlock ? true : undefined} onClick={() => void submit()} data-testid="rm-submit">{sending ? 'در حال ثبت…' : 'ثبت و بستن یادآور'}</button>
            <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => setStep(1)}>قبلی</button>
          </> : null}
        </footer>
        </div>
        <C3File customerId={item.customerId} name={item.customerName} phone={item.tel} priority={null} onSavedToast={savedToast}
          editable={item.fileEdit !== false} lockedHint="تکمیل/ویرایش پرونده‌ی این مشتری از «کارهای امروز من» باز است." />
      </div>
      {fileToast ? <div className="hx-toast" role="status" data-testid="rm-file-toast"><Check size={18} aria-hidden="true" /> <span>{fileToast}</span></div> : null}
    </div>
  </div>;
}
