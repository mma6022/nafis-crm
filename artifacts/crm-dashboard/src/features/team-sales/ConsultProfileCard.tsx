import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { History, Pencil } from 'lucide-react';
import { consultProfileKey, editConsultProfile, fmtDateTime, useConsultProfile, type ConsultEditable, type ConsultProfileData } from './api';
import { NoPlanChip, PlanChip } from './PlanChip';
import { JOB_LABELS, JOB_ORDER, MILITARY_LABELS } from './plan-reasons';
import './team-sales.css';
import { GradeChip } from '@/components/grade/GradeChip';
import { CREDIT_SUBGRADES } from '@/lib/credit-grade';

/**
 * crm-no-plan-option (14:51): «اطلاعات مشاوره» — Kazemi's first-call answers kept on the customer.
 * The grade is the customer's own statement («اظهار مشتری»); the official inquiry grade sits beside it and is what plan
 * matching uses. Every save is a new version (history is never deleted); later salespeople can edit (logged).
 */
const URG: Record<string, string> = { now: 'همین الان / این هفته', month: 'تا یک ماه', later: 'بعداً', curious: 'فقط کنجکاوه' };
const GA: Record<string, string> = { yes: 'می‌تونه معرفی کنه', no: 'نمی‌تونه', unknown: 'نمی‌دونه' };
const TRI: Record<string, string> = { yes: 'بله', no: 'خیر', unknown: 'نمی‌دونه' };
const SOURCE: Record<string, string> = { first_call: 'فرم تماس اول', edit: 'ویرایش', backfill: 'انتقال از فرم‌های قبلی' };
export const CONSULT_FIELD_LABELS: Record<string, string> = {
  jobType: 'شغل متقاضی', guarantorAvailable: 'ضامن', guarantorCheque: 'چک ضامن', creditRank: 'رتبه‌ی متقاضی',
  gRank: 'رتبه‌ی ضامن', gJobType: 'شغل ضامن', military: 'نظام وظیفه', city: 'شهر', urgency: 'فوریت',
  selectedPlans: 'طرح‌ها', noPlanFit: 'هیچ طرحی نمی‌خوره', noPlanNote: 'چرا (بدون طرح)',
};
const job = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? JOB_LABELS[v] ?? v : '—');
const rank = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? <GradeChip value={v} /> : '—');

type Draft = Record<ConsultEditable, string>;
const draftOf = (d: ConsultProfileData): Draft => ({
  jobType: d.jobType ?? '', guarantorAvailable: d.guarantorAvailable ?? '', guarantorCheque: d.guarantorCheque ?? '',
  creditRank: d.creditRank ?? '', gRank: d.gRank ?? '', gJobType: d.gJobType ?? '', military: d.military ?? '',
  city: d.city ?? '', urgency: d.urgency ?? '',
});

/** onEditFirstCall: crm-first-call-edit — «ویرایش» opens the first-call wizard (admin, the qualifier or the owner). */
export function ConsultProfileCard({ customerId, onEditFirstCall }: { customerId: number; onEditFirstCall?: () => void }) {
  const q = useConsultProfile(customerId);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  if (!q.data?.latest?.data) return null;
  const { latest, versions, official, canEdit } = q.data;
  const d = latest.data!;
  const g = d.guarantorAvailable === 'yes';

  const startEdit = () => { setDraft(draftOf(d)); setErr(''); setEditing(true); };
  const set = (k: ConsultEditable, v: string) => setDraft((x) => (x ? { ...x, [k]: v } : x));
  const save = async () => {
    if (!draft) return;
    const before = draftOf(d);
    const changes: Partial<Record<ConsultEditable, string | null>> = {};
    (Object.keys(draft) as ConsultEditable[]).forEach((k) => { if (draft[k] !== before[k]) changes[k] = draft[k].trim() || null; });
    if (!Object.keys(changes).length) { setEditing(false); return; }
    setBusy(true); setErr('');
    try {
      await editConsultProfile(customerId, changes);
      await qc.invalidateQueries({ queryKey: consultProfileKey(customerId) });
      setEditing(false);
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : 'ذخیره نشد.'); } finally { setBusy(false); }
  };
  const sel = (k: ConsultEditable, opts: [string, string][], label: string) =>
    <label className="cp-f"><span>{label}</span><select value={draft?.[k] ?? ''} onChange={(e) => set(k, e.target.value)} data-testid={`consult-edit-${k}`}>
      <option value="">— ثبت نشده —</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  const jobOpts: [string, string][] = [...JOB_ORDER.map((j) => [j, JOB_LABELS[j]] as [string, string]), ['unknown', 'نمی‌دونه']];
  const rankOpts: [string, string][] = [...CREDIT_SUBGRADES.map((r) => [r, r] as [string, string]), ['unknown', 'نمی‌دونه']];
  const triOpts = Object.entries(TRI) as [string, string][];

  return <section className="fc-sum cp-card" aria-labelledby="h-consult" data-testid="case-consult-profile">
    <h3 id="h-consult">اطلاعات مشاوره <small>{[d.submitterName ? `ثبت: ${d.submitterName}` : '', d.formDate ? fmtDateTime(d.formDate) : '',
      latest.source === 'edit' ? `آخرین ویرایش: ${latest.actorName ?? '—'}` : ''].filter(Boolean).join(' · ')}</small></h3>
    {!editing ? <dl className="fc-grid">
      <div><dt>شغل متقاضی</dt><dd data-testid="consult-job">{job(d.jobType)}</dd></div>
      <div><dt>نظام وظیفه</dt><dd>{d.military ? MILITARY_LABELS[d.military] ?? '—' : '—'}</dd></div>
      <div><dt>شهر</dt><dd>{d.city || '—'}</dd></div>
      <div className="cp-rank"><dt>رتبه‌ی متقاضی <em>اظهار مشتری</em></dt><dd data-testid="consult-declared-rank">{rank(d.creditRank)}
        {official ? <span className="cp-official" data-testid="consult-official-rank">استعلام رسمی: <GradeChip value={official.rank} /> <small>{fmtDateTime(official.checkedAt)}</small></span> : null}</dd></div>
      <div><dt>ضامن</dt><dd>{d.guarantorAvailable ? GA[d.guarantorAvailable] : '—'}</dd></div>
      {g ? <div><dt>چک ضامن</dt><dd>{d.guarantorCheque ? TRI[d.guarantorCheque] : '—'}</dd></div> : null}
      {g ? <div><dt>رتبه‌ی ضامن <em>اظهار مشتری</em></dt><dd>{rank(d.gRank)}</dd></div> : null}
      {g ? <div><dt>شغل ضامن</dt><dd>{job(d.gJobType)}</dd></div> : null}
      <div><dt>فوریت</dt><dd>{d.urgency ? URG[d.urgency] ?? '—' : '—'}</dd></div>
      <div className="cp-plans"><dt>طرح‌ها</dt><dd className="pc-wrap" data-testid="consult-plans">{d.noPlanFit ? <NoPlanChip note={d.noPlanNote} testId="consult-noplan" />
        : d.selectedPlans.length ? d.selectedPlans.map((p) => <PlanChip key={p.id} plan={{ name: p.name, status: (p.status as 'fit' | 'depends') ?? 'fit', reasons: [] }} />) : '—'}</dd></div>
    </dl> : <div className="cp-edit" data-testid="consult-edit-form">
      {sel('jobType', jobOpts, 'شغل متقاضی')}
      {sel('military', Object.entries(MILITARY_LABELS) as [string, string][], 'نظام وظیفه')}
      <label className="cp-f"><span>شهر</span><input value={draft?.city ?? ''} maxLength={60} onChange={(e) => set('city', e.target.value)} data-testid="consult-edit-city" /></label>
      {sel('creditRank', rankOpts, 'رتبه‌ی متقاضی (اظهار مشتری)')}
      {sel('guarantorAvailable', Object.entries(GA) as [string, string][], 'ضامن')}
      {draft?.guarantorAvailable === 'yes' ? <>{sel('guarantorCheque', triOpts, 'چک ضامن')}{sel('gRank', rankOpts, 'رتبه‌ی ضامن (اظهار مشتری)')}{sel('gJobType', jobOpts, 'شغل ضامن')}</> : null}
      {sel('urgency', Object.entries(URG) as [string, string][], 'فوریت')}
      {err ? <p className="cp-err" role="alert">{err}</p> : null}
      <div className="cp-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid="consult-edit-save">{busy ? 'در حال ذخیره…' : 'ذخیره (نسخه‌ی جدید)'}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>انصراف</button></div>
    </div>}
    {official ? <p className="cp-note">تطبیق طرح‌ها با رتبه‌ی استعلام رسمی انجام می‌شود، نه اظهار مشتری.</p> : null}
    <div className="cp-foot">
      <button type="button" className="cp-link" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)} data-testid="consult-history-toggle"><History size={14} aria-hidden="true" />تاریخچه ({versions.length.toLocaleString('fa-IR')})</button>
      {onEditFirstCall && !editing ? <button type="button" className="cp-link fc-edit-btn" onClick={onEditFirstCall} data-testid="consult-edit-wizard"><Pencil size={14} aria-hidden="true" />ویرایش</button> : null}
      {canEdit && !editing ? <button type="button" className="cp-link" onClick={startEdit} data-testid="consult-edit"><Pencil size={14} aria-hidden="true" />{onEditFirstCall ? 'ویرایش سریع یک مورد' : 'ویرایش'}</button> : null}
    </div>
    {showHistory ? <ol className="cp-history" data-testid="consult-history">{versions.map((v) => <li key={v.id}>
      <b>{SOURCE[v.source] ?? v.source}</b> · {v.actorName ?? '—'} · {fmtDateTime(v.createdAt)}
      {v.source === 'edit' && v.changedFields.length ? <span> — {v.changedFields.map((f) => CONSULT_FIELD_LABELS[f] ?? f).join('، ')}</span> : null}
    </li>)}</ol> : null}
  </section>;
}
