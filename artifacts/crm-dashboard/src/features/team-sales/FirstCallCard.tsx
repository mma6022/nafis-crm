import { HelpCircle } from 'lucide-react';
import { fa, fmtDateTime, type FirstCallSummary, type SuggestedPlan } from './api';
import { PlanChip } from './PlanChip';
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

const DOCS: Record<string, string> = { all: 'همه آماده‌ست', partial: 'بخشی', none: 'آماده نیست' };
const URG: Record<string, string> = { now: 'همین الان / این هفته', month: 'تا یک ماه', later: 'بعداً', curious: 'فقط کنجکاوه' };
const GA: Record<string, string> = { yes: 'می‌تونه معرفی کنه', no: 'نمی‌تونه', unknown: 'نمی‌دونه' };
const TRI: Record<string, string> = { yes: 'بله', no: 'خیر', unknown: 'نمی‌دونه' };
const rank = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? <GradeChip value={v} /> : '—');

/** Case page: «خلاصه‌ی تماس اول» with every answer of the latest first-call form. */
export function FirstCallSummaryCard({ fc }: { fc: FirstCallSummary }) {
  const a = fc.answers;
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
    </dl>
    {fc.note ? <p className="fc-note">«{fc.note}»</p> : null}
  </section>;
}
