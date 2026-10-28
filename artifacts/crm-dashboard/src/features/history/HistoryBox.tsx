import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, FileText, History, MessageCircle, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchNextCloser, TeamSalesApiError } from '@/features/team-sales/api';
import { HX_REASON_MAX, historyKey, promoteToP1, useHistorySummary, type HistorySummary } from './api';
import './history.css';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const faN = (v: number | string) => String(v).replace(/\d/g, (d) => FA[Number(d)]);
const jDay = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };
const jShort = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

function PriTag({ p }: { p: number | null }) {
  if (p == null) return <span className="hx-tg">بدون اولویت</span>;
  return <span className={`hx-tg ${p === 1 ? 'p1' : 'pn'}`} data-testid="hx-priority">اولویت {faN(p)}</span>;
}

/** «دیدن پرونده‌ی مشتری»: the customer page in a side panel (iframe, panel mode); the current form and lock stay as they are. */
export function FilePanel({ customerId, name, onClose }: { customerId: number; name: string; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; ref.current?.focus();
    // capture + stop: Escape closes only the panel, never the wizard/popup underneath.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(<div className="hx-fp" dir="rtl" data-testid="hx-file-panel">
    <div className="hx-fp-scrim" onClick={onClose} aria-hidden="true" />
    <section className="hx-fp-sheet" role="dialog" aria-modal="true" aria-label={`پرونده‌ی ${name}`}>
      <header className="hx-fp-h"><h2>پرونده‌ی {name}</h2>
        <button ref={ref} type="button" className="btn btn-ghost" onClick={onClose} aria-label="بستن پرونده" data-testid="hx-file-close"><X size={18} /> بستن</button></header>
      <iframe title={`پرونده‌ی ${name}`} src={`${base()}/customers/${customerId}?panel=1`} data-testid="hx-file-frame" />
    </section></div>, document.body);
}

function UpgradeConfirm({ name, priority, handoff, customerId, onCancel, onDone }: {
  name: string; priority: number | null; handoff: boolean; customerId: number; onCancel: () => void; onDone: (msg: string, closer: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [closer, setCloser] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { if (!handoff) return; let live = true; fetchNextCloser(customerId).then((n) => { if (live) setCloser(n.name); }, () => {}); return () => { live = false; }; }, [handoff, customerId]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (!pending) onCancel(); } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, [pending, onCancel]);
  const t = reason.trim();
  const go = async () => {
    if (!t) { setError('دلیل کوتاه را بنویس.'); ref.current?.focus(); return; }
    setPending(true); setError('');
    try { const r = await promoteToP1(customerId, t); onDone(r.message, r.kept ? null : (r.closerName ?? null)); }
    catch (e) { setError(`ارتقا انجام نشد؛ ${e instanceof TeamSalesApiError && e.message ? e.message : 'اتصال به سرور برقرار نشد.'}`); }
    finally { setPending(false); }
  };
  const from = priority == null ? 'بدون اولویت' : `اولویت ${faN(priority)}`;
  return createPortal(<div className="hx-cfx" dir="rtl"><section className="hx-cfm" role="alertdialog" aria-modal="true" aria-labelledby="hx-upt" data-testid="hx-upgrade-confirm">
    <h2 id="hx-upt">ارتقا به اولویت یک؟</h2>
    {handoff
      ? <p>{name} از {from} به اولویت ۱ می‌رود و به {closer ?? 'کارشناس پیگیری'} سپرده می‌شود. مدیر تیم این تغییر را در گزارش می‌بیند.</p>
      : <p>{name} از {from} به اولویت ۱ می‌رود و در کارهای روزهای بعد جلوتر می‌آید. مدیر تیم این تغییر را در گزارش می‌بیند.</p>}
    <label htmlFor="hx-up-reason">دلیل کوتاه<span className="req">*</span></label>
    <input id="hx-up-reason" ref={ref} value={reason} maxLength={HX_REASON_MAX} onChange={(e) => { setReason(e.target.value.slice(0, HX_REASON_MAX)); setError(''); }}
      placeholder="مثلاً «فیش را فرستاد و این هفته وام لازم دارد»" aria-required="true" aria-invalid={Boolean(error) || undefined} data-testid="hx-up-reason"
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }} />
    <span className="hx-cnt">{faN(t.length)} / {faN(HX_REASON_MAX)}</span>
    {error ? <p className="hx-err" role="alert" data-testid="hx-up-error">{error}</p> : null}
    <div className="hx-cfb">
      <button type="button" className="btn btn-primary" onClick={() => { void go(); }} disabled={pending || !t} data-testid="hx-up-go"><ArrowUp size={18} /> {pending ? 'در حال ارتقا…' : 'ارتقا بده'}</button>
      <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending} data-testid="hx-up-cancel">انصراف</button>
    </div></section></div>, document.body);
}

/**
 * «.hx» history box (Armita crm-reminder-incoming §2). Reusable: today card, «تماس ورودی داشتم» wizard, reminder popup (b).
 * Renders nothing for a first call (no logged call), while loading errors, or for a customer that is not the expert's (403).
 */
export function HistoryBox({ customerId, name, compact = false, onUpgraded, testId = 'hx-box' }: {
  customerId: number; name: string; compact?: boolean; onUpgraded?: (r: { kept: boolean }) => void; testId?: string;
}) {
  const qc = useQueryClient();
  const q = useHistorySummary(customerId);
  const [panel, setPanel] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ msg: string; closer: string | null } | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(t); }, [toast]);
  useEffect(() => { setDone(null); setConfirm(false); setPanel(false); }, [customerId]);
  if (q.isLoading) return <div className="hx-skel" aria-hidden="true" data-testid={`${testId}-loading`} />;
  const d: HistorySummary | undefined = q.data;
  if (!d || d.firstCall) return null;
  const p1 = Boolean(done) || d.isP1;
  const calls = d.calls.slice(0, compact ? 2 : 3);
  return <section className={`hx${compact ? ' cmp' : ''}`} aria-label={`سابقه‌ی ${name}`} data-testid={testId} dir="rtl">
    <div className="hx-h"><span className="hx-eb"><History size={14} /> تماس اول نیست · سابقه برای مشاوره</span>
      <div className="hx-tgs"><PriTag p={p1 ? 1 : d.priority} /><span className={`hx-tg ${d.fileTone}`} data-testid="hx-file-tag">پرونده: {d.fileStatus}</span></div></div>
    <dl className="hx-kv"><div><dt>وضعیت پرونده</dt><dd data-testid="hx-status">{d.fileStatus}</dd></div>
      <div><dt>قدم بعد</dt><dd data-testid="hx-next">{d.nextStep ? `${d.nextStep.text} · ${jShort(d.nextStep.at)}` : 'قدم بعدی ثبت نشده'}</dd></div></dl>
    <div className="hx-col">
      <div><h4>تماس‌ها و یادداشت‌های قبلی <span className="hx-cnt">({faN(d.callCount)} تماس)</span></h4>
        <ol className="hx-calls" data-testid="hx-calls">{calls.map((c) => <li key={c.id}><span className="cd">{jDay(c.at)}</span><span className={`hx-tg ${c.tone}`}>{c.result}</span>
          {c.note ? <p>{c.note}</p> : null}</li>)}</ol>
        {d.consultations ? <p className="hx-cons" data-testid="hx-cons">مشاوره: {faN(d.consultations.count)} فرم{d.consultations.lastAt ? ` · آخرین ${jDay(d.consultations.lastAt)}` : ''}{d.consultations.note ? ` · ${d.consultations.note}` : ''}</p> : null}
      </div>
      {compact ? null : <div><h4><MessageCircle size={14} /> چی بپرسه</h4><ul className="hx-ask" data-testid="hx-ask">{d.ask.map((a) => <li key={a}>{a}</li>)}</ul></div>}
    </div>
    <div className="hx-acts">
      <button type="button" className="btn btn-ghost" onClick={() => setPanel(true)} data-testid="hx-open-file"><FileText size={18} /> دیدن پرونده‌ی مشتری</button>
      {p1 ? <span className="hx-p1" role="status" data-testid="hx-p1on"><Zap size={16} /> {done ? (done.closer ? `ارتقا یافت · سپرده شد به ${done.closer}` : 'ارتقا یافت · اولویت ۱') : 'این مشتری اولویت ۱ است'}</span>
        : d.canUpgrade ? <button type="button" className="btn hx-up" aria-haspopup="dialog" onClick={() => setConfirm(true)} data-testid="hx-upgrade"><ArrowUp size={18} /> ارتقا به اولویت یک</button> : null}
    </div>
    {panel ? <FilePanel customerId={customerId} name={name} onClose={() => setPanel(false)} /> : null}
    {confirm ? <UpgradeConfirm name={name} priority={d.priority} handoff={d.handoff} customerId={customerId} onCancel={() => setConfirm(false)}
      onDone={(msg, closer) => { setConfirm(false); setDone({ msg, closer }); setToast('در گزارش مدیر ثبت شد');
        if (!d.handoff) void qc.invalidateQueries({ queryKey: historyKey(customerId) });
        onUpgraded?.({ kept: !d.handoff }); }} /> : null}
    {toast ? createPortal(<div className="hx-toast" role="status" data-testid="hx-toast"><Check size={18} /> <span>{toast}</span></div>, document.body) : null}
  </section>;
}
