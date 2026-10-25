import { useState } from 'react';
import { History, HelpCircle, Pencil } from 'lucide-react';
import { fa, fmtDateTime, type FirstCallEditInfo, type FirstCallSummary, type SuggestedPlan } from './api';
import { FIRST_CALL_FIELD_LABELS, firstCallValueText } from './first-call-edit-labels';
import { NoPlanChip, PlanChip } from './PlanChip';
import { JOB_LABELS, MILITARY_LABELS } from './plan-reasons';
import './team-sales.css';
import { GradeChip } from '@/components/grade/GradeChip';

/** Case page: «طرح‌های پیشنهادی (n)» under the name/phone header (HANDOFF crm-call-form-plans §5). */
export function SuggestedPlansBox({ plans, actorName }: { plans: SuggestedPlan[]; actorName?: string | null }) {
  if (!plans.length) return null;
  const cond = plans.filter((p) => p.status === 'depends');
  return <div className="fc-box" data-testid="case-suggested-plans">
    <h3>طرح‌های پیشنهادی ({fa(plans.length)}) <small>{actorName ? `انتخاب ${actorName} در تماس اول` : 'انتخاب‌شده در تماس اول'}</small></h3>
    <div className="pc-wrap">{plans.map((p) => <PlanChip key={p.id} plan={p} size="lg" testId={`case-plan-${p.id}`} />)}</div>
    {cond.map((p) => <p key={p.id} className="fc-cond"><HelpCircle size={14} aria-hidden="true" /><span>«{p.name}» مشروط است: {p.reasons.join('؛ ')}.</span></p>)}
  </div>;
}

/** crm-no-plan-option: case page — grey «بدون طرح مناسب» chip + the optional «چرا؟» note. */
export function NoPlanBox({ note, actorName }: { note?: string | null; actorName?: string | null }) {
  return <div className="fc-box" data-testid="case-no-plan">
    <h3>طرح پیشنهادی <small>{actorName ? `نظر ${actorName} در تماس اول` : 'نظر کارشناس در تماس اول'}</small></h3>
    <div className="pc-wrap"><NoPlanChip size="lg" testId="case-noplan-chip" note={note} /></div>
    {note ? <p className="fc-why" data-testid="case-noplan-note">چرا: «{note}»</p> : null}
  </div>;
}

const DOCS: Record<string, string> = { all: 'همه آماده‌ست', partial: 'بخشی', none: 'آماده نیست' };
const URG: Record<string, string> = { now: 'همین الان / این هفته', month: 'تا یک ماه', later: 'بعداً', curious: 'فقط کنجکاوه' };
const GA: Record<string, string> = { yes: 'می‌تونه معرفی کنه', no: 'نمی‌تونه', unknown: 'نمی‌دونه' };
const TRI: Record<string, string> = { yes: 'بله', no: 'خیر', unknown: 'نمی‌دونه' };
const rank = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? <GradeChip value={v} /> : '—');

/** Case page: «خلاصه‌ی تماس اول» with every answer of the latest first-call form. */
export function FirstCallSummaryCard({ fc, editInfo, onEdit }: { fc: FirstCallSummary; editInfo?: FirstCallEditInfo; onEdit?: () => void }) {
  const a = fc.answers;
  const [showEdits, setShowEdits] = useState(false);
  const edits = editInfo?.edits ?? [];
  const cheque = a.checkStatus && a.checkStatus !== 'none' ? 'چک دارد' : a.canPromissory === 'yes' ? 'فقط سفته' : a.checkStatus ? 'هیچ‌کدام' : '—';
  const g = a.guarantorAvailable === 'yes';
  return <section className="fc-sum" aria-labelledby="h-first-call" data-testid="case-first-call">
    <h3 id="h-first-call">خلاصه‌ی تماس اول <small>{[fc.actorName, fmtDateTime(fc.createdAt), fc.priority ? `اولویت ${fa(fc.priority)}` : ''].filter(Boolean).join(' · ')}</small></h3>
    <dl className="fc-grid">
      <div><dt>مبلغ</dt><dd>{a.amountMillion ? `${fa(a.amountMillion)} میلیون تومان` : '—'}</dd></div>
      <div><dt>مدارک</dt><dd>{DOCS[a.docsReady ?? ''] ?? '—'}</dd></div>
      <div><dt>فوریت</dt><dd>{URG[a.urgency ?? ''] ?? '—'}</dd></div>
      <div><dt>رتبه‌ی متقاضی</dt><dd>{rank(a.creditRank)}</dd></div>
      <div><dt>چک صیادی</dt><dd>{cheque}</dd></div>
      <div><dt>چک برگشتی</dt><dd>{TRI[a.bouncedCheque ?? ''] ?? '—'}</dd></div>
      <div><dt>ضامن</dt><dd>{GA[a.guarantorAvailable ?? ''] ?? '—'}</dd></div>
      {g ? <div><dt>چک ضامن</dt><dd>{TRI[a.guarantorCheque ?? ''] ?? '—'}</dd></div> : null}
      {g ? <div><dt>رتبه‌ی ضامن</dt><dd>{rank(a.gRank)}</dd></div> : null}
      {a.military ? <div><dt>نظام وظیفه</dt><dd>{MILITARY_LABELS[a.military] ?? '—'}</dd></div> : null}
      {a.jobType ? <div><dt>شغل متقاضی</dt><dd>{a.jobType === 'unknown' ? 'نمی‌دونه' : JOB_LABELS[a.jobType] ?? '—'}</dd></div> : null}
      {g && a.gJobType ? <div><dt>شغل ضامن</dt><dd>{a.gJobType === 'unknown' ? 'نمی‌دونه' : JOB_LABELS[a.gJobType] ?? '—'}</dd></div> : null}
      {a.city ? <div><dt>شهر</dt><dd>{a.city}</dd></div> : null}
    </dl>
    {fc.note ? <p className="fc-note">«{fc.note}»</p> : null}
    {edits.length || (editInfo?.canEdit && onEdit) ? <div className="cp-foot">
      {edits.length ? <button type="button" className="cp-link" aria-expanded={showEdits} onClick={() => setShowEdits((v) => !v)} data-testid="fc-edit-history-toggle">
        <History size={14} aria-hidden="true" />ویرایش‌ها ({fa(edits.length)})</button> : <span />}
      {editInfo?.canEdit && onEdit ? <button type="button" className="cp-link fc-edit-btn" onClick={onEdit} data-testid="fc-edit"><Pencil size={14} aria-hidden="true" />ویرایش</button> : null}
    </div> : null}
    {showEdits ? <ol className="cp-history fc-edits" data-testid="fc-edit-history">{edits.map((e) => <li key={e.id} data-testid={`fc-edit-${e.id}`}>
      <b>{e.actorName ?? '—'}</b> · {fmtDateTime(e.createdAt)}{e.sentToCloser ? <span className="ts-pill ok">ارسال به کارشناس فروش</span> : null}
      {e.priorityAfter !== e.priorityBefore && e.priorityAfter ? <span className="ts-pill">اولویت {fa(e.priorityBefore ?? 0)} ← {fa(e.priorityAfter)}</span> : null}
      {e.changed.length ? <ul>{e.changed.map((c) => <li key={c.field}><span className="ts-muted">{FIRST_CALL_FIELD_LABELS[c.field] ?? c.field}:</span> {firstCallValueText(c.field, c.old)} ← {firstCallValueText(c.field, c.new)}</li>)}</ul>
        : <p className="ts-muted small">بدون تغییر در جواب‌ها</p>}
    </li>)}</ol> : null}
  </section>;
}
