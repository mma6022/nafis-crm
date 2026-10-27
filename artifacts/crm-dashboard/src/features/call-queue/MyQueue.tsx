import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MessageSquarePlus, Phone, Sparkles } from 'lucide-react';
import { CqResultFields, emptyCqResult, type CqResultValue } from './ResultFields';
import { cqApi, cqOn, faNum, faWhen, GROUP_FA, useCqConfig, type QueueCard, type QueueGroup } from './api';
import './call-queue.css';

const LETTER: Record<QueueGroup, string> = { due: 'الف', new: 'ب', p1: 'ج', assist: 'د' };

export default function MyQueuePage() {
  const cfg = useCqConfig().data;
  const on = cqOn(cfg, 'queue');
  const q = useQuery({ queryKey: ['call-queue', 'queue'], queryFn: cqApi.queue, enabled: on, refetchInterval: 60_000, retry: false });
  if (!cfg) return <div className="cq-page"><p role="status">در حال بارگذاری…</p></div>;
  if (!on) return <div className="cq-page"><h1>صف تماس من</h1><p data-testid="cq-queue-off">این بخش هنوز فعال نشده است.</p></div>;
  const data = q.data; const order = data?.order ?? (['due', 'new', 'p1', 'assist'] as QueueGroup[]);
  const letters = Object.fromEntries(order.map((g, i) => [g, ['الف', 'ب', 'ج', 'د'][i] ?? LETTER[g]])) as Record<QueueGroup, string>;
  return <div className="cq-page" data-testid="cq-queue">
    <header className="cq-page-h"><div><h1>صف تماس من</h1>{data ? <p>{faNum(data.total)} مشتری منتظر تماس</p> : null}</div></header>
    <p className="cq-rule" data-testid="cq-queue-rule">کارت فقط وقتی از صف بیرون می‌رود که برایش تماس ثبت شود. رد کردن یا «الان نه» ندارد.</p>
    {q.isError ? <p className="cq-err" role="alert">صف بارگذاری نشد. <button type="button" onClick={() => void q.refetch()}>تلاش دوباره</button></p> : null}
    {data ? <>
      <nav className="cq-anchors" aria-label="پرش به گروه">
        {order.map((g) => <a key={g} href={`#cq-g-${g}`} className={`cq-anchor${data.counts[g] ? '' : ' zero'}`} data-testid={`cq-anchor-${g}`}>{letters[g]}) {GROUP_FA[g]} <b>{faNum(data.counts[g] ?? 0)}</b></a>)}
      </nav>
      {data.total === 0 ? <div className="cq-empty" data-testid="cq-queue-empty">صف خالی است. همه‌ی تماس‌های لازم ثبت شده‌اند.</div> : null}
      {order.map((g) => {
        const cards = data.cards.filter((c) => c.group === g); if (!cards.length) return null;
        return <section key={g} id={`cq-g-${g}`} className={`cq-group g-${g}`} aria-labelledby={`cq-gh-${g}`}>
          <h2 id={`cq-gh-${g}`}><span className="cq-letter">{letters[g]}</span> {GROUP_FA[g]} <small>{faNum(cards.length)} مورد</small></h2>
          {cards.map((c) => <QueueCardView key={c.customerId} c={c} letters={letters} voidReasons={cfg.voidReasons} />)}
        </section>;
      })}
    </> : q.isLoading ? <p role="status">در حال بارگذاری صف…</p> : null}
  </div>;
}

function QueueCardView({ c, letters, voidReasons }: { c: QueueCard; letters: Record<QueueGroup, string>; voidReasons: { key: string; label: string }[] }) {
  const r = c.reminder; const ai = r?.source === 'assistant';
  const [mode, setMode] = useState<'' | 'edit' | 'void'>('');
  return <article className={`cq-qcard g-${c.group}`} data-testid="cq-card" data-customer={c.customerId} data-group={c.group}>
    <div className="cq-qcard-main">
      <div className="cq-tags">
        <span className={`cq-gtag g-${c.group}`}>{letters[c.group]} · {GROUP_FA[c.group]}</span>
        {c.also.map((g) => <span key={g} className={`cq-gtag ghost g-${g}`} data-testid="cq-also">{letters[g]} · {GROUP_FA[g]}</span>)}
        {c.priority ? <span className="cq-pri">اولویت {faNum(c.priority)}</span> : null}
        {c.at ? <span className={`cq-at${c.late ? ' late' : ''}`}>{faWhen(c.at)}</span> : null}
      </div>
      <h3><Link href={`/customers/${c.customerId}`}>{c.name}</Link> <span className="cq-id">#{faNum(c.customerId)}</span></h3>
      <p className="cq-reason">{c.group === 'due' && r ? `یادآور: ${r.subject || r.message || 'پیگیری'}` : c.reason}</p>
      {ai && r?.sourceNote ? <div className="cq-ai" data-testid="cq-ai-src"><span className="cq-ai-tag"><Sparkles size={12} aria-hidden="true" /> ساخته‌شده توسط دستیار</span>
        <blockquote>{r.sourceNote.span ? <>{r.sourceNote.text.slice(0, r.sourceNote.span.start)}<mark>{r.sourceNote.text.slice(r.sourceNote.span.start, r.sourceNote.span.end)}</mark>{r.sourceNote.text.slice(r.sourceNote.span.end)}</> : r.sourceNote.text}</blockquote>
        <small>یادداشت {faWhen(r.sourceNote.at)}{r.sourceNote.author ? ` · ${r.sourceNote.author}` : ''}</small>
        <div className="cq-actions">
          <button type="button" className="btn btn-ghost sm" onClick={() => setMode(mode === 'edit' ? '' : 'edit')} aria-expanded={mode === 'edit'} data-testid="cq-ai-edit">ویرایش تاریخ</button>
          <button type="button" className="btn btn-ghost sm" onClick={() => setMode(mode === 'void' ? '' : 'void')} aria-expanded={mode === 'void'} data-testid="cq-ai-void">این قول پیگیری نبود</button>
        </div>
        {mode === 'edit' ? <EditDate id={r.id} onDone={() => setMode('')} /> : null}
        {mode === 'void' ? <VoidForm id={r.id} reasons={voidReasons} onDone={() => setMode('')} /> : null}
      </div> : null}
      {c.lastCall ? <p className="cq-last">آخرین تماس {faWhen(c.lastCall.at)}{c.lastCall.text ? ` · «${c.lastCall.text}»` : ''}</p> : <p className="cq-last">هنوز تماسی ثبت نشده</p>}
    </div>
    <div className="cq-qcard-btns">
      {c.phone ? <a className="btn btn-primary" href={`tel:${c.phone}`} data-testid="cq-card-call"><Phone size={15} aria-hidden="true" /> تماس</a> : null}
      <Link className="btn btn-ghost" href={`/customers/${c.customerId}?cq=call`} data-testid="cq-card-log"><MessageSquarePlus size={15} aria-hidden="true" /> ثبت تماس</Link>
    </div>
  </article>;
}

function EditDate({ id, onDone }: { id: number; onDone: () => void }) {
  const qc = useQueryClient();
  const [val, setVal] = useState<CqResultValue>({ ...emptyCqResult(), outcome: 'follow_up' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { if (!val.followUpAt) { setErr('زمان را انتخاب کن.'); return; } setBusy(true); setErr('');
    try { await cqApi.editDate(id, val.followUpAt); void qc.invalidateQueries({ queryKey: ['call-queue'] }); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : 'ذخیره نشد.'); } finally { setBusy(false); } };
  return <div className="cq-inline" data-testid="cq-ai-edit-form"><CqResultFields value={val} onChange={setVal} showErrors={false} idPrefix={`cq-ed-${id}`} onlyTime />
    <p className="cq-hint">منبع یادآور («ساخته‌شده توسط دستیار») عوض نمی‌شود.</p>
    {err ? <p className="cq-err" role="alert">{err}</p> : null}
    <div className="cq-actions"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => void save()} data-testid="cq-ai-edit-save">ذخیره</button><button type="button" className="btn btn-ghost sm" onClick={onDone}>انصراف</button></div></div>;
}

function VoidForm({ id, reasons, onDone }: { id: number; reasons: { key: string; label: string }[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState(''); const [note, setNote] = useState(''); const [tried, setTried] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const ok = !!reason && !!note.trim() && [...note.trim()].length <= 60;
  const go = async () => { setTried(true); if (!ok) return; setBusy(true); setErr('');
    try { await cqApi.void(id, reason, note.trim()); void qc.invalidateQueries({ queryKey: ['call-queue'] }); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setBusy(false); } };
  return <div className="cq-inline" data-testid="cq-ai-void-form">
    <p>یادآور حذف نمی‌شود؛ باطل می‌شود و در خط زمانی و گزارش مدیر می‌ماند.</p>
    <div className="cq-chips" role="radiogroup" aria-label="دلیل">{reasons.map((r) => <button key={r.key} type="button" role="radio" aria-checked={reason === r.key} className={`cq-chip${reason === r.key ? ' on' : ''}`} onClick={() => setReason(r.key)} data-testid={`cq-void-${r.key}`}>{r.label}</button>)}</div>
    <input value={note} maxLength={60} onChange={(e) => setNote(e.target.value)} placeholder="توضیح کوتاه (اجباری)" aria-label="توضیح کوتاه" aria-invalid={tried && !note.trim()} data-testid="cq-void-note" />
    <small className="cq-counter">{faNum([...note].length)} / ۶۰</small>
    {tried && !ok ? <p className="cq-err" role="alert" data-testid="cq-void-err">{!reason ? 'دلیل را انتخاب کن. ' : ''}{!note.trim() ? 'توضیح کوتاه را بنویس.' : ''}</p> : null}
    {err ? <p className="cq-err" role="alert">{err}</p> : null}
    <div className="cq-actions"><button type="button" className="btn btn-danger sm" disabled={busy || (tried && !ok)} onClick={() => void go()} data-testid="cq-void-submit">باطل کردن یادآور</button><button type="button" className="btn btn-ghost sm" onClick={onDone}>انصراف</button></div>
  </div>;
}
