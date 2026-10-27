/* Customer page top block (crm-instagram-leads §0-9..12 + urgent v1.1 §0-13..22): registrar card, «فوری» banner with flagger / reason / attempts,
 * flag sheet (reason required), admin-only clear sheet (clear reason required, no bell), auto-clear banner after a CRM call with a saved report. */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '@/pages/customers-ui';
import { refreshCustomerViews } from '@/components/RepeatRequestReview';
import { clearUrgent, detailKey, faNum, faWhen, flagUrgent, setRank, toUtc, useIntakeDetail, useIntakeOptions } from './api';
import { UrgentReasonChips, urgentPickReady, type UrgentPickValue } from './UrgentPick';
import './lead-intake.css';

const AUTO_BANNER_MS = 3 * 86_400_000;
export function LeadIntakePanel({ customerId }: { customerId: number }) {
  const qc = useQueryClient();
  const d = useIntakeDetail(customerId); const o = useIntakeOptions();
  const [flagOpen, setFlagOpen] = useState(false); const [clearOpen, setClearOpen] = useState(false); const [rankOpen, setRankOpen] = useState(false);
  const [pick, setPick] = useState<UrgentPickValue>({ on: true, reasonCode: '', reasonText: '' });
  const [clr, setClr] = useState({ code: '', note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [tried, setTried] = useState(false);
  if (!d.data) return null;
  const { card, urgent } = d.data;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: detailKey(customerId) }); await qc.invalidateQueries({ queryKey: ['lead-intake'] }); refreshCustomerViews(qc, customerId); };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setErr(''); try { await fn(); setMsg(ok); await refresh(); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); } };
  const max = o.data?.urgentOtherMax ?? 80; const cmax = o.data?.clearNoteMax ?? 80;
  const doFlag = async () => { setTried(true); if (!urgentPickReady(pick, max)) return;
    const r = await run(() => flagUrgent(customerId, pick.reasonCode, pick.reasonCode === 'other' ? pick.reasonText.trim() : undefined), 'علامت فوری ثبت شد.');
    if (r) { setFlagOpen(false); setTried(false); setPick({ on: true, reasonCode: '', reasonText: '' }); } };
  const clearReady = Boolean(clr.code) && (clr.code !== 'other' || clr.note.trim().length > 0) && [...clr.note].length <= cmax;
  const doClear = async () => { setTried(true); if (!clearReady) return;
    const r = await run(() => clearUrgent(customerId, clr.code, clr.note.trim() || undefined), 'علامت فوری برداشته شد.');
    if (r) { setClearOpen(false); setTried(false); setClr({ code: '', note: '' }); } };
  const lc = urgent.lastClear;
  const showAuto = !urgent.isUrgent && lc?.auto && Date.now() - Date.parse(toUtc(lc.at)) < AUTO_BANNER_MS;
  return <section className="li-panel" data-testid="li-panel" dir="rtl">
    {msg ? <div className="csx-note ok" role="status" data-testid="li-msg"><p>{msg}</p></div> : null}
    {err && !flagOpen && !clearOpen ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
    {urgent.isUrgent ? <div className="li-urgent" data-testid="li-urgent-banner">
      <strong>مشتری فوری{urgent.flag?.flaggedBy ? ` · ${urgent.flag.flaggedBy}` : ''}</strong>
      <span>{urgent.flag?.reason ?? 'دلیل ثبت نشده'}{urgent.flag?.flaggedAt ? ` · ${faWhen(urgent.flag.flaggedAt)}` : ''}</span>
      {urgent.flag?.attempts ? <span data-testid="li-urgent-attempts">{faNum(urgent.flag.attempts)} بار دیگر هم فوری زده شد.</span> : null}
      <span>با تماس از دکمه‌ی CRM و ثبت گزارش، علامت خودکار برداشته می‌شود.</span>
      {d.data.canClearUrgent ? <div className="li-row"><button type="button" className="csx-ghost" onClick={() => { setErr(''); setClearOpen(true); }} data-testid="li-urgent-clear-open">برداشتن علامت فوری</button></div> : null}
    </div> : <>
      {showAuto ? <div className="li-urgent auto" data-testid="li-urgent-auto"><strong>علامت فوری برداشته شد · خودکار</strong>
        <span>بعد از تماس CRM و ثبت گزارش{lc?.waitedMin != null ? ` · ${faNum(lc.waitedMin)} دقیقه بعد از علامت` : ''} · {faWhen(lc?.at)}</span></div> : null}
      <div className="li-row"><button type="button" className="csx-ghost" onClick={() => { setErr(''); setFlagOpen(true); }} data-testid="li-urgent-flag-open">علامت فوری بزن</button></div>
    </>}
    {card ? <article className="li-card" data-testid="li-registrar-card">
      <h3>ثبت‌کننده: {card.registrar.name}{card.isNew ? <span className="li-tag new" data-testid="li-new">جدید</span> : null}</h3>
      <div className="li-meta"><span>منبع: <b>{card.leadSourceLabel}{card.leadSourceOther ? ` (${card.leadSourceOther})` : ''}</b></span>
        <span>رتبه‌ی اعتباری: <b data-testid="li-rank">{card.rankLabel}</b></span><span>{faWhen(card.registeredAt)}</span></div>
      {card.note ? <p className="li-note" data-testid="li-note">{card.note}</p> : null}
      {card.canEditRank ? (rankOpen ? <div className="li-chips" role="radiogroup" aria-label="رتبه‌ی اعتباری">{(o.data?.ranks ?? []).map((r) =>
        <button key={r.key} type="button" className="csx-chip" role="radio" aria-checked={card.rank === r.key} disabled={busy}
          onClick={async () => { if (await run(() => setRank(customerId, r.key), 'رتبه به‌روز شد.')) setRankOpen(false); }} data-testid={`li-rank-set-${r.key}`}>{r.label}</button>)}</div>
        : <div className="li-row"><button type="button" className="field-link-button" onClick={() => setRankOpen(true)} data-testid="li-rank-edit">تغییر رتبه</button></div>) : null}
      {d.data.events.length ? <details><summary>تغییرهای رتبه ({faNum(d.data.events.length)})</summary><ul>{d.data.events.map((e) =>
        <li key={e.id}>{e.oldLabel} ← {e.newLabel} · {e.actorLabel ?? ''} · {faWhen(e.createdAt)}</li>)}</ul></details> : null}
    </article> : null}
    {flagOpen ? <Sheet title="علامت فوری" onClose={() => setFlagOpen(false)} testId="li-flag-sheet"
      footer={<><button type="button" className="csx-ghost" onClick={() => setFlagOpen(false)}>انصراف</button>
        <button type="button" className="csx-primary" disabled={busy} onClick={() => void doFlag()} data-testid="li-flag-save">ثبت علامت فوری</button></>}>
      <UrgentReasonChips value={pick} onChange={setPick} reasons={o.data?.urgentReasons} max={max} idPrefix="li-flag" showErrors={tried} />
      {tried && !urgentPickReady(pick, max) ? <div className="csx-note warn" role="status"><p>دلیل را کامل کن تا علامت ثبت شود.</p></div> : null}
      <p className="hint">به کارشناس پرونده خبر داده می‌شود (فقط اعلان داخل CRM).</p>
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
    </Sheet> : null}
    {clearOpen ? <Sheet title="برداشتن علامت فوری" onClose={() => setClearOpen(false)} testId="li-clear-sheet"
      footer={<><button type="button" className="csx-ghost" onClick={() => setClearOpen(false)}>انصراف</button>
        <button type="button" className="csx-primary" disabled={busy} onClick={() => void doClear()} data-testid="li-clear-save">برداشتن علامت</button></>}>
      <div className="li-block" role="radiogroup" aria-label="دلیل برداشتن"><span className="li-lbl">چرا برداشته می‌شود؟</span>
        <div className="li-chips">{(o.data?.clearReasons ?? []).map((r) => <button type="button" key={r.code} className="csx-chip" role="radio" aria-checked={clr.code === r.code}
          onClick={() => setClr({ ...clr, code: r.code })} data-testid={`li-clear-${r.code}`}>{r.label}</button>)}</div></div>
      <div className="field"><label htmlFor="li-clear-note">توضیح {clr.code === 'other' ? '(الزامی)' : '(اختیاری)'}</label>
        <input id="li-clear-note" maxLength={cmax} value={clr.note} onChange={(e) => setClr({ ...clr, note: e.target.value })} data-testid="li-clear-note" />
        <span className="li-count">{faNum([...clr.note].length)} / {faNum(cmax)}</span></div>
      {tried && !clearReady ? <div className="csx-note warn" role="status"><p>{!clr.code ? 'یکی از دلیل‌ها را بزن.' : 'برای «سایر» یک توضیح کوتاه بنویس.'}</p></div> : null}
      <p className="hint">برداشتن علامت اعلانی نمی‌فرستد.</p>
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
    </Sheet> : null}
  </section>;
}
