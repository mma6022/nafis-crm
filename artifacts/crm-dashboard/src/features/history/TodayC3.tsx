/**
 * HISTORY-A v1.2 (Armita crm-reminder-incoming §الف): Today card in three columns for a customer who already had calls.
 * history (right, «سابقه‌ی تماس‌ها») · middle (existing card + inline «ارتقا به اولویت یک») · file (left, first-call answers).
 * Mobile (<1024px): one column, middle first, the side columns are <details> (closed).
 */
import { SiteAnswersBlock } from '@/features/site-answers/SiteAnswersBlock';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowUp, Check, ChevronLeft, FileText, History, PencilLine, User, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fetchNextCloser, TeamSalesApiError } from '@/features/team-sales/api';
import { FIRST_CALL_FIELD_LABELS, firstCallValueText } from '@/features/team-sales/first-call-edit-labels';
import { RetireeHint, SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { callHistoryKey, fileCardKey, historyKey, promoteToP1, useCallHistory, useFileCard, type FileCard, type HistorySummary } from './api';
import './history.css';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const faN = (v: number | string) => String(v).replace(/\d/g, (d) => FA[Number(d)]);
const jAt = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };
const useWide = () => {
  const q = '(min-width: 1024px)';
  const [w, setW] = useState(() => typeof window === 'undefined' || window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setW(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return w;
};

/** Side column: always open on desktop; a closed <details> on mobile. */
function Side({ cls, icon, title, sub, testId, children }: { cls: string; icon: ReactNode; title: string; sub: ReactNode; testId: string; children: ReactNode }) {
  const wide = useWide();
  const [open, setOpen] = useState(wide);
  useEffect(() => setOpen(wide), [wide]);
  return <details className={`c3s ${cls}`} open={open} data-testid={testId}
    onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (wide && !o) (e.currentTarget as HTMLDetailsElement).open = true; else setOpen(o); }}>
    <summary onClick={(e) => { if (wide) e.preventDefault(); }}><span className="c3t">{icon}<b>{title}</b><small>{sub}</small></span><ChevronLeft size={18} className="i" aria-hidden="true" /></summary>
    <div className="c3b">{children}</div>
  </details>;
}

export function C3History({ customerId }: { customerId: number }) {
  const q = useCallHistory(customerId);
  const items = q.data?.items ?? [];
  return <Side cls="c3h" icon={<History size={16} aria-hidden="true" />} title="سابقه‌ی تماس‌ها" testId="c3-history"
    sub={q.isLoading ? 'در حال بارگذاری…' : `${faN(items.length)}${q.data?.nextBefore ? '+' : ''} تماس · جدیدترین بالا`}>
    {q.isError ? <p className="hx-err" role="alert">سابقه بارگذاری نشد.</p>
      : !items.length && !q.isLoading ? <p className="dp-hint">تماس ثبت‌شده‌ای نیست.</p>
      : <ol className="calls" data-testid="c3-calls">{items.map((c) => <li key={c.id}>
        <div className="clh"><span className="cd">{jAt(c.at)}</span><span className={`hx-tg ${c.tone}`}>{c.result}</span></div>
        {c.by ? <span className="ce"><User size={13} aria-hidden="true" /> {c.by}</span> : null}
        {c.note ? <p style={{ whiteSpace: 'pre-line' }}>{c.note}</p> : null}</li>)}</ol>}
  </Side>;
}

const GROUPS: Array<{ title: string | null; keys: string[] }> = [
  { title: 'متقاضی', keys: ['amountMillion', 'urgency', 'docsReady', 'creditRank', 'cheque', 'bouncedCheque', 'military', 'jobType', 'city', 'ssoRetiree'] },
  { title: 'ضامن', keys: ['guarantorAvailable', 'guarantorCheque', 'gRank', 'gJobType'] },
];
const LABEL: Record<string, string> = { ...FIRST_CALL_FIELD_LABELS, amountMillion: 'مبلغ موردنیاز', cheque: 'چک صیادی یا سفته', bouncedCheque: 'چک برگشتی رفع‌نشده',
  military: 'پایان خدمت', guarantorAvailable: 'ضامن دارد؟', city: 'شهر', ssoRetiree: 'بازنشسته‌ی تأمین اجتماعی' };

/** `editable={false}` (REMINDER-3COL popup): read-only file — the save would be refused server-side (expert_lockdown) for this customer. */
export function C3File({ customerId, name, phone, priority, onSavedToast, editable = true, lockedHint }: { customerId: number; name: string; phone: string; priority: number | null;
  onSavedToast: (t: string) => void; editable?: boolean; lockedHint?: string }) {
  const qc = useQueryClient();
  const q = useFileCard(customerId);
  const [form, setForm] = useState(false);
  const f: FileCard | undefined = q.data;
  const canEdit = Boolean(f?.canEdit) && editable;
  const hint = f?.canEdit && !editable && lockedHint ? <p className="dp-hint c3-lk" data-testid="c3-file-locked">{lockedHint}</p> : null;
  const fresh = new Set(f?.changedFields ?? []);
  const missTxt = f ? (f.missingCount ? `${faN(f.missingCount)} مورد مانده` : 'کامل') : '';
  const val = (k: string) => {
    const a = f?.answers ?? {};
    if (k === 'ssoRetiree') { const t = firstCallValueText(k, a.ssoRetiree); return a.ssoRetiree === 'family' && a.ssoRetireeRelation ? `${t} · ${a.ssoRetireeRelation}` : t; }
    if (k === 'city') return f?.city || '—';
    return firstCallValueText(k, a[k]);
  };
  const g = f?.answers?.guarantorAvailable === 'yes';
  return <Side cls="c3f" icon={<FileText size={16} aria-hidden="true" />} title="پرونده‌ی مشتری" testId="c3-file"
    sub={f ? <>پاسخ‌های فرم تماس اول · <span className={f.missingCount ? 'mc' : ''} data-testid="c3-file-count">{missTxt}</span></> : q.isLoading ? 'در حال بارگذاری…' : ''}>
    <SiteAnswersBlock customerId={customerId} showEmpty />
    {q.isError ? <p className="hx-err" role="alert">پرونده بارگذاری نشد.</p> : !f ? null : !f.answers ? <div className="fempty" data-testid="c3-file-empty">
      <p><AlertCircle size={16} aria-hidden="true" /> هنوز فرم تماس اول این مشتری پر نشده. همان سؤال‌ها را بپرس و پرونده را کامل کن.</p>
      {canEdit ? <button type="button" className="btn fcb" onClick={() => setForm(true)} data-testid="c3-file-complete"><PencilLine size={20} aria-hidden="true" />
        <span><b>تکمیل پرونده مشتری</b><span className="mc">{faN(f.missingCount)} مورد مانده</span></span></button> : hint}
    </div> : <>
      <div className="hx-tgs"><span className={`hx-tg ${f.priority === 1 ? 'p1' : 'pn'}`}>{f.priority == null ? 'بدون اولویت' : `اولویت ${faN(f.priority)}`}</span>
        <span className={`hx-tg ${f.complete ? 'ok' : 'warn'}`}>{f.complete ? `کامل · ${faN(f.total)} از ${faN(f.total)}` : `${faN(f.total - f.missingCount)} از ${faN(f.total)}`}</span></div>
      {GROUPS.map((gr) => { const keys = gr.title === 'ضامن' ? (g ? gr.keys : ['guarantorAvailable']) : gr.keys;
        return <div key={gr.title}><h5>{gr.title}</h5><dl className="fkv">{keys.map((k) => { const miss = f.missing.includes(k);
          return <div key={k} className={fresh.has(k) ? 'chg' : undefined} data-testid={`c3-f-${k}`}><dt>{LABEL[k] ?? k}</dt>
            <dd className={miss ? 'mc' : undefined}>{miss ? 'خالی' : val(k)}{fresh.has(k) ? <em className="nw">تازه</em> : null}</dd></div>; })}</dl>
          {gr.title === 'متقاضی' && (f.answers?.ssoRetiree === 'self' || f.answers?.ssoRetiree === 'family') ? <p className="adm"><Zap size={13} aria-hidden="true" /> پیشنهاد بازنشسته‌ها در ستون وسط</p> : null}</div>; })}
      {f.missingCount ? <div className="fmiss"><p data-testid="c3-file-missing">مانده: {f.missing.map((k) => LABEL[k] ?? k).join('، ')}</p></div> : null}
      {canEdit ? <div className="fact">{f.missingCount
        ? <button type="button" className="btn fcb" onClick={() => setForm(true)} data-testid="c3-file-complete"><PencilLine size={20} aria-hidden="true" /><span><b>تکمیل پرونده مشتری</b><span className="mc">{faN(f.missingCount)} مورد مانده</span></span></button>
        : <button type="button" className="btn btn-ghost feb" onClick={() => setForm(true)} data-testid="c3-file-edit"><PencilLine size={18} aria-hidden="true" /> ویرایش پرونده مشتری</button>}</div> : hint}
    </>}
    {form && f ? createPortal(<SimpleCallForm customer={{ id: customerId, name, phone, priority: priority ?? f.priority ?? null }} userId={undefined} onClose={() => setForm(false)} onDone={() => {}} onNext={() => {}}
      file={{ answers: f.answers, city: f.city, complete: Boolean(f.answers), onSaved: (card) => { setForm(false); qc.setQueryData(fileCardKey(customerId), card);
        void qc.invalidateQueries({ queryKey: historyKey(customerId) }); onSavedToast('پرونده ذخیره شد · اولویت و کارشناس تغییری نکرد'); } }} />, document.body) : null}
  </Side>;
}

/** Inline «ارتقا به اولویت یک» at the bottom of the middle column (.upr → .upz → .p1on). Same API/rules as the history box. */
export function C3Upgrade({ customerId, name, d, onUpgraded }: { customerId: number; name: string; d: HistorySummary; onUpgraded?: (r: { kept: boolean }) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ closer: string | null } | null>(null);
  const [closer, setCloser] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setDone(null); setReason(''); setError(''); }, [customerId]);
  useEffect(() => { if (!open || !d.handoff) return; let live = true; fetchNextCloser(customerId).then((n) => { if (live) setCloser(n.name); }, () => {}); return () => { live = false; }; }, [open, d.handoff, customerId]);
  const t = reason.trim();
  const go = async () => {
    if (!t) { setError('دلیل کوتاه را بنویس.'); return; }
    setPending(true); setError('');
    try { const r = await promoteToP1(customerId, t); setDone({ closer: r.kept ? null : (r.closerName ?? null) }); setOpen(false);
      void qc.invalidateQueries({ queryKey: historyKey(customerId) }); void qc.invalidateQueries({ queryKey: fileCardKey(customerId) }); void qc.invalidateQueries({ queryKey: callHistoryKey(customerId) });
      onUpgraded?.({ kept: r.kept }); }
    catch (e) { setError(`ارتقا انجام نشد؛ ${e instanceof TeamSalesApiError && e.message ? e.message : 'اتصال به سرور برقرار نشد.'}`); }
    finally { setPending(false); }
  };
  const from = d.priority == null ? 'بدون اولویت' : `اولویت ${faN(d.priority)}`;
  if (done || d.isP1) return <div className="upr"><span className="p1on" role="status" data-testid="c3-p1on"><Zap size={16} aria-hidden="true" />
    {done ? (done.closer ? `ارتقا یافت · سپرده شد به ${done.closer}` : 'ارتقا یافت · اولویت ۱') : 'این مشتری اولویت ۱ است'}{done || d.upgradedByExpert ? <small>{done ? 'برگرداندن فقط با ادمین · در گزارش مدیر ثبت شد' : 'برگرداندن فقط با ادمین'}</small> : null}</span></div>;
  if (!d.canUpgrade) return null;
  if (!open) return <div className="upr"><button type="button" className="btn upb" onClick={() => setOpen(true)} aria-expanded="false" data-testid="c3-upgrade"><ArrowUp size={18} aria-hidden="true" /> ارتقا به اولویت یک</button>
    <p className="hint dp-hint">دلیل کوتاه لازم است · برگرداندن فقط با ادمین</p></div>;
  return <div className="upz" role="group" aria-labelledby="c3-upz-t" data-testid="c3-upgrade-confirm">
    <h3 id="c3-upz-t"><ArrowUp size={18} aria-hidden="true" /> ارتقا به اولویت یک؟</h3>
    <p>{d.handoff ? `${name} از ${from} به اولویت ۱ می‌رود و به ${closer ?? 'کارشناس پیگیری'} سپرده می‌شود.` : `${name} از ${from} به اولویت ۱ می‌رود و در کارهای روزهای بعد جلوتر می‌آید.`} مدیر تیم این تغییر را در گزارش می‌بیند. برگرداندن فقط با ادمین.</p>
    <label htmlFor="c3-up-reason">دلیل کوتاه<span className="req">*</span></label>
    <input id="c3-up-reason" className="ts-inp" autoFocus value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }}
      placeholder="مثلاً «فیش را فرستاد و این هفته وام لازم دارد»" aria-required="true" data-testid="c3-up-reason" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }} />
    <span className="hx-cnt">{faN(t.length)} نویسه</span>
    {error ? <p className="hx-err" role="alert" data-testid="c3-up-error">{error}</p> : null}
    <div className="hx-cfb cfb"><button type="button" className="btn btn-primary" onClick={() => void go()} disabled={pending || !t} data-testid="c3-up-go"><Check size={18} /> {pending ? 'در حال ارتقا…' : 'ارتقا بده'}</button>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={pending} data-testid="c3-up-cancel">انصراف</button></div>
  </div>;
}
export { RetireeHint };
