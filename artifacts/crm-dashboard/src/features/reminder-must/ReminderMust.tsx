/**
 * REMINDER-B — mandatory due-reminder popup (Armita crm-reminder-incoming v1.1 scenes 08–15).
 * Mounted once in CrmShell for users 8/2/3 only; renders nothing unless the server says flag.reminder_must is on for this user.
 * - role=alertdialog, no ×, Esc / outside click do nothing; it closes only when the server accepted the result (200).
 * - Waits while another form / dialog is open or the user is typing (yellow «n یادآور سررسید شد» line instead).
 * - One 10-minute snooze for the whole queue (server-enforced) → sticky yellow bar with a countdown and «الان باز کن».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, BellRing, Check, Clock, History, Phone, TriangleAlert } from 'lucide-react';
import { announceCallSaved, faClock, faNum } from '@/features/call-queue/api';
import { rmApi, useRmConfig, type RmFeed, type RmItem, type RmNext, type RmOutcome } from './api';
import './reminder-must.css';

const OVERLAY_SEL = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],.modal-backdrop,.call-sheet-backdrop,.ch-backdrop,.ic-sheet,[vaul-drawer],.dp-inbound';
const fa = faNum;
const len = (s: string) => [...s.trim()].length;
const dayLabel = (iso: string, nowIso: string) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' });
  const a = d.format(new Date(iso)), b = d.format(new Date(nowIso)), y = d.format(new Date(Date.parse(nowIso) - 86_400_000));
  if (a === b) return 'امروز'; if (a === y) return 'دیروز';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' }).format(new Date(iso));
};
const OUT: { v: RmOutcome; l: string }[] = [{ v: 'answered', l: 'پاسخ داد' }, { v: 'no_answer', l: 'پاسخ نداد' }, { v: 'follow_up', l: 'پیگیری بعدی' }];
const OUT_FA: Record<string, string> = { answered: 'پاسخ داد', no_answer: 'پاسخ نداد', follow_up: 'پیگیری بعدی' };
const NEXT: { v: RmNext; l: string; s: string }[] = [
  { v: 'tomorrow_am', l: 'فردا صبح', s: 'ساعت ۱۰:۰۰' }, { v: 'today_pm', l: 'امروز عصر', s: 'ساعت ۱۷:۰۰' },
  { v: 'in_3_days', l: '۳ روز دیگه', s: 'ساعت ۱۰:۰۰' }, { v: 'none', l: 'یادآور لازم نیست', s: 'قدم بعد در پرونده' },
];
const callKey = (id: number) => `rm-call-${id}`;

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
  const done = useCallback(async (remaining: number) => {
    setOpen(false); setForceOpen(false);
    setToast(remaining > 0 ? `ثبت شد · یادآور بعدی (${fa(remaining)} مانده) باز می‌شود` : 'ثبت شد · یادآور سررسید دیگری نداری');
    window.setTimeout(() => setToast(''), 5000);
    await qc.invalidateQueries({ queryKey: ['reminder-must', 'feed', userId] });
  }, [qc, userId]);
  if (!on || !feed) return toast ? createPortal(<div className="rmm-root"><div className="rmm-toast" role="status" data-testid="rm-toast"><Check size={16} aria-hidden="true" /> {toast}</div></div>, document.body) : null;
  return createPortal(<div className="rmm-root" data-testid="rm-root">
    {head && !open && snoozed ? <div className="rmm-snb" role="status" data-testid="rm-snoozed">
      <AlarmClock size={18} aria-hidden="true" />
      <span><b>{fa(items.length)} یادآور</b> (اولی {head.customerName} <span className="rmm-id">#{fa(head.customerId)}</span>) · <b className="rmm-cdn" data-testid="rm-countdown">{fa(new Date(snoozeLeft).toISOString().slice(14, 19))}</b> دیگر دوباره باز می‌شود · این بار بدون مهلت</span>
      <button type="button" className="btn btn-primary" onClick={() => setForceOpen(true)} data-testid="rm-open-now">الان باز کن</button>
    </div> : null}
    {head && !open && !snoozed && busy ? <p className="rmm-rq" role="status" data-testid="rm-queued"><BellRing size={15} aria-hidden="true" />
      <span><b className="rmm-qn">{fa(items.length)}</b> یادآور سررسید شد · بعد از ثبت این فرم یکی‌یکی باز می‌شوند</span></p> : null}
    {open && head ? <MustDialog key={head.reminderId} feed={feed} item={head} index={1} total={items.length} rest={items.slice(1, 4)} onDone={done}
      onSnoozed={async () => { setOpen(false); setForceOpen(false); await qc.invalidateQueries({ queryKey: ['reminder-must', 'feed', userId] }); }} /> : null}
    {toast ? <div className="rmm-toast" role="status" data-testid="rm-toast"><Check size={16} aria-hidden="true" /> {toast}</div> : null}
  </div>, document.body);
}

function MustDialog({ feed, item, index, total, rest, onDone, onSnoozed }: { feed: RmFeed; item: RmItem; index: number; total: number; rest: RmItem[];
  onDone: (remaining: number) => void; onSnoozed: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [outcome, setOutcome] = useState<RmOutcome | null>(null);
  const [note, setNote] = useState('');
  const [next, setNext] = useState<RmNext | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const r = feed.rules;
  useEffect(() => { void rmApi.shown(item.reminderId).catch(() => {}); }, [item.reminderId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true);
  }, []);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('h2')?.focus(); }, [step]);
  const first = item.customerName.split(/\s+/)[0] || item.customerName;
  const when = `${dayLabel(item.remindAt, feed.serverNow)} ${faClock(item.remindAt)}`;
  const eyebrow = item.outsideHours ? `سررسید ${when} · بیرون از ساعت کاری بود؛ با ورودت باز شد` : `یادآور ${fa(index)} از ${fa(total)} · سر وقت · ${when}`;
  const noteErr = !outcome ? 'نتیجه‌ی تماس را انتخاب کن.' : len(note) < r.noteMin ? `یادداشت یک‌خطی حداقل ${fa(r.noteMin)} نویسه.` : len(note) > r.noteMax ? `حداکثر ${fa(r.noteMax)} نویسه.` : '';
  const nextErr = !next ? 'قدم بعد را انتخاب کن.' : next !== 'none' && len(reason) < r.reasonMin ? 'دلیل یادآور بعدی را بنویس.' : len(reason) > r.reasonMax ? `حداکثر ${fa(r.reasonMax)} نویسه.` : '';
  const snooze = async () => { setSending(true); setErr(''); try { await rmApi.snooze(); onSnoozed(); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setSending(false); } };
  const submit = async () => {
    setShow(true); if (noteErr) { setStep(1); return; } if (nextErr) return;
    setSending(true); setErr('');
    try {
      let callId = Number(sessionStorage.getItem(callKey(item.reminderId)) || 0);
      if (!callId) {
        const one = note.replace(/\s+/g, ' ').trim();
        const c = await rmApi.saveCall({ customerId: item.customerId, subject: 'یادآور سررسید', customerRequest: '', expertNotes: one, outcome, oneLineNote: one, outOfList: true, context: 'out_of_list' });
        callId = c.id; sessionStorage.setItem(callKey(item.reminderId), String(callId)); announceCallSaved(callId, item.customerId);
      }
      const res = await rmApi.complete(item.reminderId, { callId, outcome: outcome!, note: note.replace(/\s+/g, ' ').trim(), next: next!, reason: reason.replace(/\s+/g, ' ').trim() });
      sessionStorage.removeItem(callKey(item.reminderId));
      onDone(res.remaining);
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد. دوباره بزن.'); } finally { setSending(false); }
  };
  const steps = ['تماس', 'نتیجه', 'قدم بعد'];
  return <div className="rmm-x" data-testid="rm-overlay">
    <div className="rmm-d" role="alertdialog" aria-modal="true" aria-labelledby="rmm-t" aria-describedby="rmm-must" data-noclose ref={ref} data-testid="rm-dialog">
      <header className="rmm-h">
        <p className="rmm-eb" data-testid="rm-eyebrow"><Clock size={14} aria-hidden="true" /> {eyebrow}</p>
        <h2 id="rmm-t" tabIndex={-1}>وقت تماس با {item.customerName}</h2>
        <ol className="rmm-stp" aria-label="مراحل">{steps.map((s, i) => <li key={s} className={i < step ? 'dn' : i === step ? 'cu' : ''} aria-current={i === step ? 'step' : undefined}>{fa(i + 1)}. {s}</li>)}</ol>
      </header>
      <p className="rmm-must" id="rmm-must"><TriangleAlert size={14} aria-hidden="true" /> تا نتیجه ثبت نشود این پنجره بسته نمی‌شود</p>
      {step === 0 ? <div className="rmm-b">
        <div className="rmm-who"><b>{item.customerName}</b> <span className="rmm-id">#{fa(item.customerId)}</span> <span className="rmm-ph" dir="ltr" data-testid="rm-phone">{item.phoneMasked}</span></div>
        <div className="rmm-rsn"><h3>دلیل یادآور</h3><p data-testid="rm-reason">{item.reason || item.subject || '—'}</p><small>{item.createdBy} · ساخته‌شده {dayLabel(item.createdAt, feed.serverNow)} {faClock(item.createdAt)}</small></div>
        {item.lastCalls?.length ? <div className="rmm-hx"><h3><History size={14} aria-hidden="true" /> آخرین تماس‌ها</h3><ul>{item.lastCalls.map((c) =>
          <li key={c.id}><span className="rmm-cd">{dayLabel(c.at, feed.serverNow)} {faClock(c.at)}{c.outcome ? ` · ${OUT_FA[c.outcome] ?? ''}` : ''}</span><p>{c.note || '—'}</p></li>)}</ul></div>
          : <p className="rmm-hint">تماس قبلی ثبت نشده.</p>}
        {rest.length ? <p className="rmm-qnx" data-testid="rm-next-list"><span>بعد از این، به ترتیب ساعت:</span> {rest.map((x) => `${faClock(x.remindAt)} ${x.customerName}`).join(' · ')}{total > rest.length + 1 ? ' · …' : ''}</p> : null}
      </div> : null}
      {step === 1 ? <div className="rmm-b">
        <fieldset className="rmm-seg"><legend>نتیجه‌ی تماس</legend>{OUT.map((o) =>
          <button key={o.v} type="button" className={outcome === o.v ? 'on' : ''} aria-pressed={outcome === o.v} onClick={() => setOutcome(o.v)} data-testid={`rm-out-${o.v}`}>{o.l}</button>)}</fieldset>
        <label className="rmm-f"><span>یادداشت یک‌خطی <small>(اجباری)</small></span>
          <input value={note} maxLength={r.noteMax + 20} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: مدارک را فردا می‌فرستد" data-testid="rm-note" aria-invalid={show && Boolean(noteErr)} />
          <small className={len(note) > r.noteMax ? 'bad' : ''}>{fa(len(note))}/{fa(r.noteMax)}</small></label>
        {show && noteErr ? <p className="rmm-err" role="alert">{noteErr}</p> : null}
      </div> : null}
      {step === 2 ? <div className="rmm-b">
        <fieldset className="rmm-nxc"><legend>یادآور بعدی</legend>{NEXT.map((n) => {
          const dis = n.v === 'today_pm' && !r.todayPmOpen;
          return <button key={n.v} type="button" className={`rmm-nx${next === n.v ? ' on' : ''}`} disabled={dis} aria-pressed={next === n.v} onClick={() => setNext(n.v)} data-testid={`rm-next-${n.v}`}>{n.l}<small>{dis ? 'دیگر ممکن نیست' : n.s}</small></button>; })}</fieldset>
        {next && next !== 'none' ? <label className="rmm-f"><span>دلیل یادآور بعدی</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: پیگیری ارسال مدارک" data-testid="rm-reason-next" />
          <small className={len(reason) > r.reasonMax ? 'bad' : ''}>{fa(len(reason))}/{fa(r.reasonMax)}</small></label> : null}
        {show && nextErr ? <p className="rmm-err" role="alert">{nextErr}</p> : null}
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
          <button type="button" className="btn btn-primary rmm-p" disabled={sending} onClick={() => void submit()} data-testid="rm-submit">{sending ? 'در حال ثبت…' : 'ثبت و بستن یادآور'}</button>
          <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => setStep(1)}>قبلی</button>
        </> : null}
      </footer>
    </div>
  </div>;
}
