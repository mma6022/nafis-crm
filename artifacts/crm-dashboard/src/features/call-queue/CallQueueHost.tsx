import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Phone, Send, Sparkles, X } from 'lucide-react';
import { CqResultFields, cqResultError, emptyCqResult, type CqResultValue } from './ResultFields';
import { cqApi, cqOn, CQ_SAVED_EVENT, faClock, faNum, faWhen, useCqConfig, type AfterSave, type CqConfig, type CqReminder } from './api';
import './call-queue.css';

/** Toast text per spec §4 (sv_both / sv_closed / sv_new / sv_na). */
export function afterSaveToast(a: AfterSave & { found: true }): string {
  const closed = a.closed.length ? `یادآور ${a.closed.map((c) => c.label).join('، ')} بسته شد` : '';
  const next = a.created[a.created.length - 1];
  if (a.outcome === 'no_answer') {
    const tail = next ? `تلاش بعدی ${faWhen(next.remindAt)}` : a.p1NoAnswer3 ? '۳ تلاش بی‌پاسخ · به مدیر خبر داده شد' : a.naAttempt === 3 ? '۳ تلاش بی‌پاسخ · بایگانی سرد پیشنهاد می‌شود' : '';
    return ['تماس ثبت شد', closed, tail].filter(Boolean).join(' · ');
  }
  if (closed && next) return `تماس ثبت شد · ${closed} · یادآور جدید ${next.label}`;
  if (closed) return `${closed}`;
  if (next) return `یادآور جدید ${next.label} ساخته شد`;
  return 'تماس ثبت شد.';
}

type Card = { key: string; kind: 'toast' | 'suggest' | 'bale'; a: AfterSave & { found: true }; text: string };

/** Mounted once in CrmShell. Renders nothing while every call-queue flag is OFF. */
export function CallQueueHost({ onModalActive }: { onModalActive?: (active: boolean) => void }) {
  const cfg = useCqConfig().data;
  const anyOn = Boolean(cfg?.eligible && (cfg.flags.result || cfg.flags.autoclose || cfg.flags.assistant_reminders));
  const [cards, setCards] = useState<Card[]>([]);
  const drop = (key: string) => setCards((cs) => cs.filter((c) => c.key !== key));
  useEffect(() => {
    if (!anyOn) return;
    const on = (e: Event) => {
      const { callId, noToast } = (e as CustomEvent<{ callId: number; noToast?: boolean }>).detail ?? {};
      if (!callId) return;
      void cqApi.afterSave(callId).then((a) => {
        if (!a.found) return;
        const next: Card[] = noToast ? [] : [{ key: `t${callId}`, kind: 'toast', a, text: afterSaveToast(a) }];
        if (a.suggestion) next.push({ key: `s${callId}`, kind: 'suggest', a, text: a.suggestion.text });
        if (a.outcome === 'no_answer' && a.naTemplate) next.push({ key: `b${callId}`, kind: 'bale', a, text: a.naTemplate });
        setCards((cs) => [...cs.filter((c) => !next.some((n) => n.key === c.key)), ...next]);
        window.setTimeout(() => drop(`t${callId}`), 6000);
      }).catch(() => {});
    };
    window.addEventListener(CQ_SAVED_EVENT, on);
    return () => window.removeEventListener(CQ_SAVED_EVENT, on);
  }, [anyOn]);
  const modalOn = Boolean(cfg && cqOn(cfg, 'modal') && cfg.flags.result && cfg.flags.autoclose);
  useEffect(() => { onModalActive?.(modalOn); }, [modalOn, onModalActive]);
  if (!cfg?.eligible) return null;
  return <>
    {cards.length ? <div className="cq-stack" aria-live="polite" data-testid="cq-stack">
      {cards.map((c) => c.kind === 'toast'
        ? <div key={c.key} className="cq-toast" role="status" data-testid="cq-toast">{c.text}<button type="button" aria-label="بستن" onClick={() => drop(c.key)}><X size={14} /></button></div>
        : c.kind === 'suggest' ? <SuggestCard key={c.key} a={c.a} onDone={() => drop(c.key)} />
        : <BaleCard key={c.key} a={c.a} text={c.text} onDone={() => drop(c.key)} />)}
    </div> : null}
    {modalOn ? <DueModal cfg={cfg} /> : null}
  </>;
}

function SuggestCard({ a, onDone }: { a: AfterSave & { found: true }; onDone: () => void }) {
  const s = a.suggestion!; const qc = useQueryClient();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false); const [val, setVal] = useState<CqResultValue>({ ...emptyCqResult(), outcome: 'follow_up', oneLine: '-' });
  const go = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); void qc.invalidateQueries({ queryKey: ['call-queue'] }); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setBusy(false); } };
  return <div className="cq-card cq-suggest" role="region" aria-label="پیشنهاد یادآور دستیار" data-testid="cq-suggest">
    <div className="cq-card-h"><Sparkles size={15} aria-hidden="true" /> دستیار در یادداشت «{a.customerName}» یک قول پیگیری دید</div>
    <blockquote>{s.text.slice(0, s.start)}<mark>{s.text.slice(s.start, s.end)}</mark>{s.text.slice(s.end)}</blockquote>
    <p>یادآور پیشنهادی: <b>{faWhen(s.remindAt)}</b>{s.shifted ? ' (به اولین زمان کاری منتقل شد)' : ''}</p>
    {editing ? <CqResultFields value={val} onChange={setVal} showErrors={false} idPrefix="cq-sg" onlyTime /> : null}
    {err ? <p className="cq-err" role="alert">{err}</p> : null}
    <div className="cq-actions">
      <button type="button" className="btn btn-primary" disabled={busy || (editing && !val.followUpAt)} onClick={() => void go(() => cqApi.accept(a.callId, editing ? val.followUpAt : undefined))} data-testid="cq-suggest-accept">ساخت یادآور</button>
      {editing ? null : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(true)} data-testid="cq-suggest-edit">تغییر زمان</button>}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void go(() => cqApi.reject(a.callId))} data-testid="cq-suggest-reject">قول پیگیری نبود</button>
    </div>
  </div>;
}

function BaleCard({ a, text, onDone }: { a: AfterSave & { found: true }; text: string; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'fail'>('idle'); const [err, setErr] = useState('');
  const body = text.replace(/\{name\}|\{نام\}/g, a.customerName);
  const send = async () => { setState('busy'); try { await cqApi.baleSend(a.customerId, body); setState('sent'); window.setTimeout(onDone, 2500); } catch (e) { setErr(e instanceof Error ? e.message : ''); setState('fail'); } };
  return <div className="cq-card cq-bale" role="region" aria-label="پیام آماده‌ی بله" data-testid="cq-bale">
    <div className="cq-card-h"><Send size={15} aria-hidden="true" /> پیام آماده‌ی بله برای «{a.customerName}» (فقط با زدن «ارسال» می‌رود)</div>
    <blockquote>{body}</blockquote>
    {state === 'sent' ? <p role="status" data-testid="cq-bale-sent">پیام در صف ارسال بله قرار گرفت.</p> : null}
    {state === 'fail' ? <p className="cq-err" role="alert" data-testid="cq-bale-fail">ارسال نشد{err ? `: ${err}` : ''}. تماس ثبت شده است.</p> : null}
    <div className="cq-actions">
      <button type="button" className="btn btn-primary" disabled={state === 'busy' || state === 'sent'} onClick={() => void send()} data-testid="cq-bale-send">ارسال</button>
      <button type="button" className="btn btn-ghost" onClick={onDone} data-testid="cq-bale-skip">نمی‌فرستم</button>
    </div>
  </div>;
}

/* ---------------- Blocking due-reminder modal (spec §7) ---------------- */
function DueModal({ cfg }: { cfg: CqConfig }) {
  const qc = useQueryClient();
  const due = useQuery({ queryKey: ['call-queue', 'due'], queryFn: cqApi.due, refetchInterval: 30_000, retry: false });
  const items = due.data?.enabled ? due.data.items : [];
  const snoozed = due.data?.enabled ? due.data.snoozed : [];
  const [doneCount, setDoneCount] = useState(0); const [lastToast, setLastToast] = useState('');
  const total = items.length + doneCount;
  const cur = items[0];
  // reopen exactly when a snooze ends
  useEffect(() => {
    if (!snoozed.length) return;
    const t = Math.min(...snoozed.map((s) => Date.parse(s.snoozeUntil ?? '') || Infinity)) - Date.now();
    if (!Number.isFinite(t)) return;
    const h = window.setTimeout(() => void due.refetch(), Math.max(1000, t + 500));
    return () => window.clearTimeout(h);
  }, [snoozed, due]);
  useEffect(() => { if (!items.length) setDoneCount(0); }, [items.length]);
  return <>
    {snoozed.length && !cur ? <SnoozeBar r={snoozed[0]} /> : null}
    {cur ? <DueDialog key={cur.id} r={cur} index={doneCount + 1} total={total} lastToast={lastToast} cfg={cfg}
      onSaved={(t) => { setDoneCount((n) => n + 1); setLastToast(t); void qc.invalidateQueries({ queryKey: ['call-queue'] }); void due.refetch(); }}
      onSnoozed={() => void due.refetch()} /> : null}
  </>;
}

function SnoozeBar({ r }: { r: CqReminder }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = window.setInterval(() => tick((n) => n + 1), 15_000); return () => window.clearInterval(h); }, []);
  const left = Math.max(0, Math.ceil((Date.parse(r.snoozeUntil ?? '') - Date.now()) / 60_000));
  return <div className="cq-snoozebar" role="status" data-testid="cq-snoozebar">
    <BellRing size={16} aria-hidden="true" /> یادآور {r.customerName} ۱۰ دقیقه عقب افتاد · ساعت {r.snoozeUntil ? faClock(r.snoozeUntil) : ''} دوباره باز می‌شود · {faNum(left)} دقیقه مانده
    {r.phone ? <a className="btn btn-primary sm" href={`tel:${r.phone}`} data-testid="cq-snooze-callnow">الان تماس می‌گیرم</a> : null}
  </div>;
}

function useInertBackground(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById('root'); if (!root) return;
    root.setAttribute('inert', ''); root.setAttribute('aria-hidden', 'true');
    return () => { root.removeAttribute('inert'); root.removeAttribute('aria-hidden'); };
  }, [active]);
}

function DueDialog({ r, index, total, lastToast, cfg, onSaved, onSnoozed }: { r: CqReminder; index: number; total: number; lastToast: string; cfg: CqConfig; onSaved: (toast: string) => void; onSnoozed: () => void }) {
  const [stage, setStage] = useState<'ask' | 'form'>('ask');
  const [val, setVal] = useState<CqResultValue>(emptyCqResult); const [showErr, setShowErr] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [shake, setShake] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null); const callRef = useRef<HTMLAnchorElement>(null);
  const pre = useQuery({ queryKey: ['call-queue', 'pre-call', r.customerId], queryFn: () => cqApi.preCall(r.customerId), retry: false }).data;
  useInertBackground(true);
  useEffect(() => { callRef.current?.focus(); }, []);
  useEffect(() => { if (stage === 'form') (boxRef.current?.querySelector('[role="radio"]') as HTMLElement | null)?.focus(); }, [stage]);
  const onKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setShake(true); window.setTimeout(() => setShake(false), 450); return; }
    if (e.key !== 'Tab') return;
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter((x) => x.getClientRects().length > 0);
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }, []);
  const snooze = async () => {
    if (r.snoozeUsed) return;
    setBusy(true); setErr('');
    try { await cqApi.snooze(r.id); onSnoozed(); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (cqResultError(val)) { setShowErr(true); return; }
    setBusy(true); setErr('');
    try {
      const saved = await cqApi.createCall({ customerId: r.customerId, salespersonId: cfg.salespersonId, subject: r.subject || 'پیگیری یادآور', customerRequest: '', expertNotes: val.oneLine.trim(),
        outcome: val.outcome, oneLineNote: val.oneLine.trim(), followUpAt: val.outcome === 'follow_up' ? val.followUpAt : undefined });
      const a = await cqApi.afterSave(saved.id).catch(() => null);
      // the modal shows its own «ثبت شد» line; the host still gets the event so assistant suggestions / Bale cards appear
      window.dispatchEvent(new CustomEvent(CQ_SAVED_EVENT, { detail: { callId: saved.id, noToast: true } }));
      onSaved(a && a.found ? afterSaveToast(a) : 'تماس ثبت شد.');
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد. دوباره تلاش کن.'); } finally { setBusy(false); }
  };
  const naNext = val.outcome === 'no_answer' && pre && pre.naAttemptIfNoAnswer < 3;
  return createPortal(<div className="cq-lock-backdrop" data-testid="cq-due-backdrop">
    <div ref={boxRef} className={`cq-lock${shake ? ' shake' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="cq-lock-t" aria-describedby="cq-lock-d" onKeyDown={onKey} data-testid="cq-due-modal" data-reminder={r.id}>
      <div className="cq-lock-top"><span className="cq-pill"><BellRing size={13} aria-hidden="true" /> یادآور سررسیده</span>
        {total > 1 ? <span className="cq-counter-pill" data-testid="cq-due-counter">{faNum(index)} از {faNum(total)} <i aria-hidden="true">{Array.from({ length: total }, (_, i) => <b key={i} className={i < index ? 'on' : ''} />)}</i></span> : null}</div>
      <h2 id="cq-lock-t">این مشتری رو الان باید پیگیری کنی</h2>
      {lastToast && index > 1 ? <p className="cq-lock-prev" role="status" data-testid="cq-due-prev">{faNum(index - 1)} مورد ثبت شد · {lastToast}</p> : null}
      <div className="cq-lock-cust">
        <div><b>{r.customerName}</b> <span className="cq-id">#{faNum(r.customerId)}</span>{r.priority ? <span className="cq-pri">اولویت {faNum(r.priority)}</span> : null}</div>
        <div className="cq-lock-rem">یادآور {faWhen(r.remindAt)}{r.subject ? ` · ${r.subject}` : ''}</div>
        {r.message ? <div className="cq-lock-msg">{r.message}</div> : null}
        {r.source === 'assistant' && r.sourceNote ? <div className="cq-ai-src"><Sparkles size={13} aria-hidden="true" /> ساخته‌شده توسط دستیار · «{r.sourceNote.text.slice(0, 120)}»</div> : null}
      </div>
      <p id="cq-lock-d" className={`cq-lock-desc${shake ? ' shake' : ''}`}>این پنجره بسته نمی‌شود تا تماس را بگیری و نتیجه و یادداشتش را ثبت کنی. اگر همین حالا روی تماس دیگری هستی، فقط یک بار می‌توانی ۱۰ دقیقه عقبش بیندازی.</p>
      {stage === 'ask' ? <div className="cq-lock-actions">
        <a ref={callRef} className="btn btn-primary cq-big" href={r.phone ? `tel:${r.phone}` : undefined} onClick={(e) => { if (!r.phone) e.preventDefault(); setStage('form'); }} data-testid="cq-due-call"><Phone size={17} aria-hidden="true" /> تماس با {r.customerName}</a>
        <button type="button" className="btn btn-ghost" disabled={busy} aria-disabled={r.snoozeUsed || undefined} aria-describedby="cq-busy-d" onClick={() => void snooze()} data-testid="cq-due-snooze">مشغول تماس دیگه‌ام</button>
        <small id="cq-busy-d" className="cq-hint">{r.snoozeUsed ? 'یک بار ۱۰ دقیقه عقب انداختی. برای این یادآور دوباره نمی‌شود؛ حالا فقط تماس.' : '۱۰ دقیقه · فقط یک بار برای این یادآور · در گزارش مدیر ثبت می‌شود'}</small>
      </div> : <div className="cq-lock-form" data-testid="cq-due-form">
        <CqResultFields value={val} onChange={setVal} showErrors={showErr} pre={pre} idPrefix="cq-lk" />
        {naNext ? <p className="cq-hint" data-testid="cq-due-na-next">یادآور بعدی ساخته می‌شود: {pre!.naAttemptIfNoAnswer === 1 ? '۴ ساعت بعد' : '۲۴ ساعت بعد'} (ساعت کاری)</p> : null}
        <div className="cq-lock-actions"><button type="button" className="btn btn-primary cq-big" disabled={busy} onClick={() => void save()} data-testid="cq-due-save">{busy ? 'در حال ثبت…' : 'ثبت نتیجه'}</button>
          {r.phone ? <a className="btn btn-ghost" href={`tel:${r.phone}`} data-testid="cq-due-recall"><Phone size={15} aria-hidden="true" /> دوباره تماس</a> : null}</div>
      </div>}
      {err ? <p className="cq-err" role="alert" data-testid="cq-due-error">{err}</p> : null}
    </div>
  </div>, document.body);
}
