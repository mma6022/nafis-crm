import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, HelpCircle, Info, Phone, Timer, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fa, fetchPlanOptions, fmtDateTime, shortName, submitSimpleForm, TeamSalesApiError, type CallResult, type QualifyResult, type SimpleAnswers, type SuggestedPlan, type Tri } from './api';
import { PlanChip } from './PlanChip';
import { planMeta, planReasonText, type PlanEvaluation, type PlanReason } from './plan-reasons';
import './team-sales.css';
import { GradeChip } from '@/components/grade/GradeChip';
import { GradePicker } from '@/components/grade/GradePicker';
import { gradeText, isLegacy } from '@/lib/credit-grade';

/**
 * First-call form (design crm-call-form-plans): 6 steps when the customer answered —
 * 1 result, 2 need + docs, 3 applicant, 4 guarantor, 5 matching plans, 6 note + urgency (urgency is the last question).
 * Other call results keep only step 1 and the note.
 */
type Draft = {
  step: number; callResult: CallResult | null; callbackAt: string; amount: string;
  urgency: SimpleAnswers['urgency']; docsReady: SimpleAnswers['docsReady']; creditRank: string | null;
  cheque: 'check' | 'promissory' | 'none' | null; bounced: 'yes' | 'no' | null;
  gAvail: Tri | null; gCheque: Tri | null; gRank: string | null; selected: number[]; note: string;
};
const EMPTY: Draft = { step: 1, callResult: null, callbackAt: '', amount: '', urgency: null, docsReady: null, creditRank: null, cheque: null, bounced: null,
  gAvail: null, gCheque: null, gRank: null, selected: [], note: '' };
// New key: a 3-step draft from the old form has a different step numbering and must not be restored into this one.
const draftKey = (userId: number | undefined, customerId: number) => `nafis-ts-firstcall-draft:${userId ?? 0}:${customerId}`;
const STEP_NOTE = 6;

const CALL_RESULTS: Array<[CallResult, string]> = [
  ['answered', 'جواب داد و صحبت کردیم'], ['no_answer', 'جواب نداد / خاموش'], ['callback', 'گفت بعداً زنگ بزنید'], ['wrong_number', 'شماره اشتباه'],
];
const URGENCY: Array<[NonNullable<SimpleAnswers['urgency']>, string]> = [['now', 'همین الان / این هفته'], ['month', 'تا یک ماه'], ['later', 'بعداً'], ['curious', 'فقط کنجکاوه']];
const DOCS: Array<[NonNullable<SimpleAnswers['docsReady']>, string]> = [['all', 'همه آماده‌ست'], ['partial', 'بخشی'], ['none', 'آماده نیست']];
const CHEQUE: Array<[NonNullable<Draft['cheque']>, string]> = [['check', 'چک دارد'], ['promissory', 'فقط سفته'], ['none', 'هیچ‌کدام']];
const BOUNCED: Array<['no' | 'yes', string]> = [['no', 'خیر'], ['yes', 'بله']];
const TRI: Array<[Tri, string]> = [['yes', 'بله'], ['no', 'خیر'], ['unknown', 'نمی‌دونه']];
const label = <T extends string>(list: Array<[T, string]>, v: T | null | undefined) => list.find(([k]) => k === v)?.[1] ?? '';
const toDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function Chips<T extends string>({ name, list, value, onChange, cols, dashed }: { name: string; list: Array<[T, string]>; value: T | null | undefined; onChange: (v: T) => void; cols?: boolean; dashed?: T }) {
  return <div className={`ts-chips${cols ? ' col' : ''}`} role="radiogroup" aria-label={name}>
    {list.map(([k, text]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={`ts-opt${dashed === k ? ' dash' : ''}`} onClick={() => onChange(k)} data-testid={`ts-opt-${name}-${k}`}>{text}</button>)}
  </div>;
}

/** Sub-grade picker + a separate dashed «نمی‌دونه» that disables both rows (HANDOFF §3). */
function RankQuestion({ name, legend, value, onChange, error, isNew, hint }: {
  name: string; legend: string; value: string | null; onChange: (v: string | null, letter: string | null) => void; error: ReactNode; isNew?: boolean; hint?: string;
}) {
  const unknown = value === 'unknown';
  const [gen, setGen] = useState(0); // remount the picker to clear a half-picked letter when «نمی‌دونه» is pressed
  return <fieldset className="ts-q"><legend>{legend} <span className="req">*</span>{isNew ? <span className="ts-new">جدید</span> : null}{hint ? <span className="ts-muted small"> {hint}</span> : null}</legend>
    <GradePicker key={gen} label={legend} hideLabel value={value && !unknown ? value : ''} disabled={unknown}
      onChange={(v, pending, l) => onChange(v || null, pending ? (l ?? null) : null)} testId={`ts-grade-${name}`} />
    <div className="ts-unknown-row">
      <button type="button" role="checkbox" aria-checked={unknown} className="ts-opt dash" data-testid={`ts-opt-${name}-unknown`}
        onClick={() => { if (unknown) onChange(null, null); else { setGen((g) => g + 1); onChange('unknown', null); } }}>نمی‌دونه</button>
      <span className="ts-muted small">{name === 'rank' ? 'اگر مشتری رتبه‌اش را نمی‌داند.' : 'اگر مشتری رتبه‌ی ضامن را نمی‌داند.'}</span>
    </div>
    {error}
  </fieldset>;
}

const reasonIcon = (k: PlanReason['kind']) => (k === 'met' ? <Check size={14} aria-hidden="true" /> : k === 'violated' ? <X size={14} aria-hidden="true" /> : k === 'warning' ? <AlertTriangle size={14} aria-hidden="true" /> : <HelpCircle size={14} aria-hidden="true" />);
/** Card lines: fit → one green line of what is met; depends → the «اگر …» lines; no → every violation (red). Warnings always. */
function reasonLines(p: PlanEvaluation): Array<{ kind: PlanReason['kind']; text: string }> {
  const t = (r: PlanReason) => planReasonText(r);
  const lines: Array<{ kind: PlanReason['kind']; text: string }> = [];
  if (p.status === 'no') p.reasons.filter((r) => r.kind === 'violated').forEach((r) => lines.push({ kind: 'violated', text: t(r) }));
  else if (p.status === 'depends') p.reasons.filter((r) => r.kind === 'unknown').forEach((r) => lines.push({ kind: 'unknown', text: t(r) }));
  else {
    const met = p.reasons.filter((r) => r.kind === 'met').map(t).filter(Boolean);
    if (met.length && p.amountFits) lines.push({ kind: 'met', text: met.join(' · ') });
  }
  p.reasons.filter((r) => r.kind === 'warning').forEach((r) => lines.push({ kind: 'warning', text: t(r) }));
  return lines.filter((l) => l.text);
}
const STATUS_FA = { fit: 'مناسب', depends: 'بستگی دارد', no: 'مناسب نیست' } as const;

function PlanCard({ p, checked, onToggle }: { p: PlanEvaluation; checked: boolean; onToggle: () => void }) {
  const disabled = p.status === 'no';
  return <div role="checkbox" tabIndex={0} aria-checked={checked} aria-disabled={disabled || undefined} className={`ts-plan ${p.status}`}
    aria-label={`${p.planName} — ${STATUS_FA[p.status]}`} data-testid={`ts-plan-${p.planId}`} data-status={p.status}
    onClick={() => { if (!disabled) onToggle(); }} onKeyDown={(e) => { if (!disabled && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onToggle(); } }}>
    <span className="ts-box" aria-hidden="true">{checked ? <Check size={16} /> : null}</span>
    <span className="ts-plan-main">
      <b>{p.planName}</b>
      <span className="ts-plan-meta">{planMeta(p)}</span>
      {reasonLines(p).map((l, i) => <span key={i} className={`ts-plan-why ${l.kind}`}>{reasonIcon(l.kind)}<span>{l.text}</span></span>)}
    </span>
    <span className={`ts-status ${p.status}`}>{STATUS_FA[p.status]}</span>
  </div>;
}

export function SimpleCallForm({ customer, userId, noteMin = 30, onClose, onDone, onNext }: {
  customer: { id: number; name: string; phone: string; priority?: number | null };
  userId: number | undefined; noteMin?: number;
  onClose: () => void; onDone: (r: QualifyResult) => void; onNext: () => void;
}) {
  const key = draftKey(userId, customer.id);
  const [d, setD] = useState<Draft>(() => { try { const raw = localStorage.getItem(key); return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY; } catch { return EMPTY; } });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState('');
  const [rankLetter, setRankLetter] = useState<string | null>(null);
  const [gRankLetter, setGRankLetter] = useState<string | null>(null);
  const [result, setResult] = useState<QualifyResult | null>(null);
  const [plans, setPlans] = useState<{ key: string; list: PlanEvaluation[] | null; error: string }>({ key: '', list: null, error: '' });
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!result) try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* quota */ } }, [d, key, result]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [d.step, result]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  const set = (patch: Partial<Draft>) => { setD((c) => ({ ...c, ...patch })); setErrors({}); setServerError(''); };

  const answered = d.callResult === 'answered';
  const steps = answered ? [1, 2, 3, 4, 5, STEP_NOTE] : [1, STEP_NOTE];
  const total = steps.length;
  const idx = Math.max(0, steps.indexOf(d.step)) + 1;
  const titles: Record<number, string> = { 1: 'نتیجه‌ی تماس', 2: 'نیاز و مدارک', 3: 'متقاضی', 4: 'ضامن', 5: 'طرح‌های مناسب', 6: answered ? 'یادداشت و فوریت' : 'یادداشت' };

  const validate = (step: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!d.callResult) e.callResult = 'نتیجه‌ی تماس را انتخاب کن.';
      if (d.callResult === 'callback') {
        const t = d.callbackAt ? Date.parse(d.callbackAt) : NaN;
        if (Number.isNaN(t)) e.callbackAt = 'زمان تماس بعدی را مشخص کن.';
        else if (t <= Date.now()) e.callbackAt = 'زمان تماس بعدی باید در آینده باشد.';
      }
    }
    if (!answered && step !== 1 && step !== STEP_NOTE) return e;
    if (step === 2) {
      const amount = Number(toDigits(d.amount));
      if (!d.amount.trim() || !Number.isFinite(amount) || amount < 10 || amount > 5000) e.amount = 'مبلغ را بین ۱۰ تا ۵۰۰۰ میلیون تومان بنویس.';
      if (!d.docsReady) e.docsReady = 'وضعیت مدارک را انتخاب کن.';
    }
    if (step === 3) {
      if (!d.creditRank) e.creditRank = rankLetter ? `زیررتبه‌ی ${rankLetter} را انتخاب کن (${rankLetter}1، ${rankLetter}2 یا ${rankLetter}3) یا «نمی‌دونه» را بزن.` : 'رتبه‌ی اعتباری را انتخاب کن (یا «نمی‌دونه»).';
      else if (isLegacy(d.creditRank)) e.creditRank = `رتبه‌ی ${d.creditRank} قدیمی است؛ زیررتبه را دوباره انتخاب کن.`;
      if (!d.cheque) e.cheque = 'یکی از گزینه‌ها را انتخاب کن.';
      if (!d.bounced) e.bounced = 'چک برگشتی را مشخص کن.';
    }
    if (step === 4) {
      if (!d.gAvail) e.gAvail = 'یکی از گزینه‌ها را انتخاب کن.';
      if (d.gAvail === 'yes') {
        if (!d.gCheque) e.gCheque = 'چک ضامن را مشخص کن (یا «نمی‌دونه»).';
        if (!d.gRank) e.gRank = gRankLetter ? `زیررتبه‌ی ${gRankLetter} را انتخاب کن (${gRankLetter}1، ${gRankLetter}2 یا ${gRankLetter}3) یا «نمی‌دونه» را بزن.` : 'رتبه‌ی ضامن را انتخاب کن (یا «نمی‌دونه»).';
      }
    }
    if (step === STEP_NOTE) {
      const n = d.note.trim().length;
      if (n === 0) e.note = 'empty';
      else if (n < noteMin) e.note = 'short';
      if (answered && !d.urgency) e.urgency = 'فوریت را انتخاب کن.';
    }
    return e;
  };
  const go = (step: number) => set({ step });
  const next = () => {
    const e = validate(d.step);
    if (Object.keys(e).length) { setErrors(e); return; }
    const i = steps.indexOf(d.step);
    go(steps[Math.min(i + 1, steps.length - 1)]);
  };
  const back = () => { const i = steps.indexOf(d.step); if (i > 0) go(steps[i - 1]); };

  const answers = useMemo<SimpleAnswers>(() => {
    const a: SimpleAnswers = { mode: 'simple', callResult: d.callResult ?? 'no_answer', formVersion: 2 };
    if (d.callResult === 'callback' && d.callbackAt) {
      // datetime-local is '' until picked; never call toISOString on an invalid date (it throws and crashes the page)
      const t = new Date(d.callbackAt);
      if (!Number.isNaN(t.getTime())) a.callbackAt = t.toISOString();
    }
    if (d.callResult === 'answered') {
      a.urgency = d.urgency;
      a.amountMillion = Number(toDigits(d.amount));
      a.docsReady = d.docsReady; a.creditRank = d.creditRank; a.bouncedCheque = d.bounced;
      a.checkStatus = d.cheque === 'check' ? 'any' : 'none';
      a.canPromissory = d.cheque === 'none' ? 'no' : 'yes';
      a.guarantorAvailable = d.gAvail;
      a.guarantorCheque = d.gAvail === 'yes' ? d.gCheque : null;
      a.gRank = d.gAvail === 'yes' ? d.gRank : null;
    }
    return a;
  }, [d]);
  // Matching only depends on the answers of steps 2-4 (urgency has no effect on plans).
  const planKey = answered ? JSON.stringify({ ...answers, urgency: null }) : '';
  const planReq = useRef('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (d.step !== 5 || !answered || planReq.current === planKey) return;
    planReq.current = planKey; // the latest request wins; a reply for older answers is ignored
    setPlans({ key: planKey, list: null, error: '' });
    fetchPlanOptions(customer.id, { ...answers, urgency: null }).then((r) => {
      if (planReq.current !== planKey) return;
      setPlans({ key: planKey, list: r.plans, error: '' });
      // a plan that is no longer selectable with the changed answers drops out of the selection
      const ok = new Set(r.plans.filter((p) => p.status !== 'no').map((p) => p.planId));
      setD((c) => (c.selected.every((id) => ok.has(id)) ? c : { ...c, selected: c.selected.filter((id) => ok.has(id)) }));
    }).catch((err) => {
      if (planReq.current !== planKey) return;
      setPlans({ key: planKey, list: null, error: err instanceof TeamSalesApiError && err.message ? err.message : 'اتصال به سرور برقرار نشد.' });
    });
  }, [d.step, answered, planKey, customer.id, answers, retry]);
  const retryPlans = () => { planReq.current = ''; setRetry((n) => n + 1); };
  const planList = plans.key === planKey ? plans.list : null;
  const selectedPlans = useMemo(() => {
    const byId = new Map((planList ?? []).map((p) => [p.planId, p]));
    return d.selected.map((id) => byId.get(id)).filter((p): p is PlanEvaluation => !!p && p.status !== 'no');
  }, [planList, d.selected]);
  const toggle = (id: number) => set({ selected: d.selected.includes(id) ? d.selected.filter((x) => x !== id) : [...d.selected, id] });

  const submit = async () => {
    for (const s of steps) { const e = validate(s); if (Object.keys(e).length) { set({ step: s }); setErrors(e); return; } }
    setPending(true); setServerError('');
    try {
      const r = await submitSimpleForm(customer.id, answers, d.note.trim(), answered ? selectedPlans.map((p) => p.planId) : undefined);
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      setResult(r); onDone(r);
    } catch (err) {
      const msg = err instanceof TeamSalesApiError && err.message ? err.message : 'اتصال به سرور برقرار نشد. چیزی ثبت نشد؛ دوباره امتحان کن.';
      setServerError(`ثبت انجام نشد: ${msg}`);
    } finally { setPending(false); }
  };
  const copyPhone = async () => {
    try { await navigator.clipboard.writeText(customer.phone); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const summary = [label(CALL_RESULTS.map(([k, v]) => [k, k === 'answered' ? 'جواب داد' : v] as [CallResult, string]), d.callResult),
    d.callResult === 'callback' && d.callbackAt && !Number.isNaN(new Date(d.callbackAt).getTime()) ? `تماس بعدی: ${fmtDateTime(new Date(d.callbackAt).toISOString())}` : ''].filter(Boolean);

  const prio = customer.priority ? `اولویت ${fa(customer.priority)}` : 'بدون اولویت';
  const err = (k: string) => errors[k] && errors[k] !== 'empty' && errors[k] !== 'short' ? <p className="ts-err" role="alert" id={`ts-err-${k}`} data-testid={`ts-err-${k}`}><AlertCircle size={16} /> {errors[k]}</p> : null;
  const noteLen = d.note.trim().length;
  const rankChip = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? gradeText(v) : '');
  const guarantorSummary = d.gAvail === 'yes'
    ? `ضامن ${d.gCheque === 'yes' ? 'با چک' : d.gCheque === 'no' ? 'بدون چک' : '(چک نامعلوم)'} · ${d.gRank === 'unknown' ? 'رتبه نامعلوم' : rankChip(d.gRank)}`
    : d.gAvail === 'no' ? 'بدون ضامن' : 'ضامن نامعلوم';

  let body: ReactNode;
  if (result) {
    const r = result.result; const h = result.handoff;
    const none = r.priority == null; const max = r.maxAttempts ?? 3;
    const reasonsTitle = none ? 'چرا بدون اولویت؟' : `چرا اولویت ${fa(r.priority ?? 0)}؟`;
    body = <div className="ts-result" data-testid="ts-result" data-priority={none ? 'none' : r.priority} data-outcome={r.outcome} data-attempts={r.attempts}>
      <p className="ts-muted center">{none ? 'اولویتی تعیین نشد — فقط تماس بی‌پاسخ شمرده شد' : 'سیستم اولویت را تعیین کرد'}</p>
      {none
        ? <div className="ts-bignum p0" aria-label={`بی‌پاسخ ${r.attempts} از ${max}`} data-testid="ts-noanswer-count">{fa(r.attempts)}<small>از {fa(max)}</small></div>
        : <div className={`ts-bignum p${r.priority}`} aria-label={`اولویت ${r.priority}`}>{fa(r.priority ?? 0)}</div>}
      <h3 className="center">{none ? `بدون اولویت — جواب نداد (بی‌پاسخ ${fa(r.attempts)} از ${fa(max)})` : r.priority === 1 ? 'اولویت ۱ — مشتری آماده‌ی پیگیری است' : r.priority === 2 ? 'اولویت ۲ — در صف تماس دوباره‌ی شما' : r.outcome === 'invalid' ? 'اولویت ۳ — شماره نامعتبر' : r.outcome === 'cold_archive' ? 'اولویت ۳ — بایگانی سرد' : 'اولویت ۳'}</h3>
      {none ? <p className="ts-muted center" data-testid="ts-noanswer-hint">اولویت فقط وقتی تعیین می‌شود که با مشتری صحبت کنید. دفعه‌ی بعد هم همین فرم باز می‌شود؛ بعد از {fa(max)} تلاش بی‌پاسخ، بایگانی سرد.</p> : null}
      {r.outcome === 'cold_archive' ? <p className="ts-muted center" data-testid="ts-archived-hint">مشتری به «بایگانی سرد» رفت. اگه خودش دوباره پیام داد یا زنگ زد، دوباره در صف شما میاد.</p> : null}
      {h ? <>
        <div className="ts-ok-card" data-testid="ts-handoff">
          <span className="ts-av" aria-hidden="true">{shortName(h.closerName).slice(0, 1)}</span>
          <div><b>{h.message}</b><p>نوبت چرخشی — به {h.closerName} اعلان و یادآور رسید</p></div>
        </div>
        <p className="center"><span className="ts-pill ok"><Timer size={15} /> مهلت تماس {h.closerName}: ۳ ساعت کاری</span></p>
        <p className="ts-muted center">یعنی تا {h.dueLabel}</p>
      </> : null}
      {!h && r.nextActionAt && r.outcome !== 'cold_archive' ? <p className="center"><span className="ts-pill">{r.outcome === 'no_answer' ? `تلاش ${fa(r.attempts)} از ${fa(r.maxAttempts ?? 3)} — تماس دوباره:` : 'تماس دوباره:'} {fmtDateTime(r.nextActionAt)}</span></p> : null}
      {result.selectedPlans?.length ? <div className="ts-plans-box" data-testid="ts-result-plans">
        <p>{h ? `طرح‌هایی که انتخاب کردی روی پرونده و ردیف فهرست برای ${h.closerName} دیده می‌شود:` : 'طرح‌هایی که انتخاب کردی روی پرونده و ردیف فهرست مشتری دیده می‌شود:'}</p>
        <div className="ts-picked">{result.selectedPlans.map((p: SuggestedPlan) => <PlanChip key={p.id} plan={p} />)}</div>
      </div> : null}
      {r.reasons.length ? <div className="ts-why"><b>{reasonsTitle}</b><ul>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
    </div>;
  } else if (d.step === 1) {
    body = <>
      <div className="ts-script"><b>بگو:</b><p>«سلام، وقتتون بخیر. از نفیس وام تماس می‌گیرم، شماره‌تون رو برای مشاوره‌ی وام گذاشته بودید.»</p></div>
      <fieldset className="ts-q"><legend>نتیجه‌ی تماس <span className="req">*</span></legend>
        <Chips name="callResult" list={CALL_RESULTS} value={d.callResult} onChange={(v) => set({ callResult: v })} cols />{err('callResult')}</fieldset>
      {d.callResult === 'callback' ? <div className="ts-q"><label htmlFor="ts-callback">زمان تماس بعدی <span className="req">*</span></label>
        <input id="ts-callback" className="ts-inp ltr" type="datetime-local" value={d.callbackAt} onChange={(e) => set({ callbackAt: e.target.value })} aria-invalid={Boolean(errors.callbackAt)} data-testid="ts-callback-at" />{err('callbackAt')}</div> : null}
    </>;
  } else if (d.step === 2) {
    body = <>
      <div className="ts-script"><b>بپرس:</b><p>«چه مبلغی لازم دارید؟ مدارکتون آماده‌ست؟»</p></div>
      <div className="ts-q"><label htmlFor="ts-amount">مبلغ وام موردنیاز <span className="req">*</span> <span className="ts-muted small">بین ۱۰ تا ۵۰۰۰</span></label>
        <div className="ts-suffix"><input id="ts-amount" className="ts-inp" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d۰-۹٠-٩]/g, '').slice(0, 5) })} aria-invalid={Boolean(errors.amount)} data-testid="ts-amount" /><span>میلیون تومان</span></div>{err('amount')}</div>
      <fieldset className="ts-q"><legend>مدارک <span className="req">*</span></legend><Chips name="docs" list={DOCS} value={d.docsReady} onChange={(v) => set({ docsReady: v })} />{err('docsReady')}</fieldset>
      <div className="ts-alert info" role="note"><Info size={18} /> سؤال «فوریت» به آخر فرم رفت؛ بعد از صحبت درباره‌ی طرح‌ها پرسیده می‌شود.</div>
    </>;
  } else if (d.step === 3) {
    body = <>
      <div className="ts-script"><b>بپرس:</b><p>«رتبه‌ی اعتبارسنجی‌تون چنده؟ چک صیادی دارید؟»</p></div>
      <RankQuestion name="rank" legend="رتبه‌ی اعتباری متقاضی" value={d.creditRank} error={err('creditRank')}
        onChange={(v, l) => { setRankLetter(l); set({ creditRank: v }); }} />
      <fieldset className="ts-q"><legend>چک صیادی یا سفته دارد؟ <span className="req">*</span></legend><Chips name="cheque" list={CHEQUE} value={d.cheque} onChange={(v) => set({ cheque: v })} />{err('cheque')}</fieldset>
      <fieldset className="ts-q"><legend>چک برگشتی رفع‌نشده؟ <span className="req">*</span></legend><Chips name="bounced" list={BOUNCED} value={d.bounced} onChange={(v) => set({ bounced: v })} />{err('bounced')}</fieldset>
    </>;
  } else if (d.step === 4) {
    body = <>
      <div className="ts-script"><b>بپرس:</b><p>«می‌تونید یک ضامن معرفی کنید؟»</p></div>
      <fieldset className="ts-q"><legend>ضامن می‌تونه معرفی کنه؟ <span className="req">*</span><span className="ts-new">جدید</span></legend>
        <Chips name="gAvail" list={TRI} value={d.gAvail} dashed="unknown" onChange={(v) => { if (v !== 'yes') setGRankLetter(null); set({ gAvail: v }); }} />{err('gAvail')}</fieldset>
      {d.gAvail === 'no' ? <p className="ts-hint" data-testid="ts-g-hint">طرح‌هایی که ضامن لازم دارند «مناسب نیست» می‌شوند.</p> : null}
      {d.gAvail === 'unknown' ? <p className="ts-hint" data-testid="ts-g-hint">طرح‌هایی که ضامن لازم دارند در گروه «بستگی دارد» می‌آیند.</p> : null}
      {d.gAvail === 'yes' ? <div className="ts-sub-q" data-testid="ts-g-follow">
        <fieldset className="ts-q"><legend>ضامن می‌تونه چک بده؟ <span className="req">*</span><span className="ts-new">جدید</span></legend>
          <Chips name="gCheque" list={TRI} value={d.gCheque} dashed="unknown" onChange={(v) => set({ gCheque: v })} />{err('gCheque')}</fieldset>
        <RankQuestion name="gRank" legend="رتبه‌ی اعتباری ضامن" isNew hint="همیشه بعد از «بله» پرسیده می‌شود" value={d.gRank} error={err('gRank')}
          onChange={(v, l) => { setGRankLetter(l); set({ gRank: v }); }} />
      </div> : null}
    </>;
  } else if (d.step === 5) {
    const fit = (planList ?? []).filter((p) => p.status === 'fit');
    const dep = (planList ?? []).filter((p) => p.status === 'depends');
    const no = (planList ?? []).filter((p) => p.status === 'no');
    const noneFit = !!planList && !fit.length && !dep.length;
    const card = (p: PlanEvaluation) => <PlanCard key={p.planId} p={p} checked={d.selected.includes(p.planId)} onToggle={() => toggle(p.planId)} />;
    body = <>
      <div className="ts-script"><b>بگو:</b><p>{noneFit ? '«فعلاً با شرایطی که گفتید طرح مناسبی نداریم؛ همکارم بررسی می‌کنه و خبرتون می‌کنه.»' : '«با شرایطی که گفتید این طرح‌ها به شما می‌خوره؛ همکارم جزئیاتش رو توضیح می‌ده.»'}</p></div>
      <div className="ts-answers" data-testid="ts-answers"><span className="ts-muted small">جواب‌ها:</span>
        {d.creditRank === 'unknown' ? <span className="ts-pill">رتبه نامعلوم</span> : <GradeChip value={d.creditRank} />}
        <span className="ts-pill">{label(CHEQUE, d.cheque)}</span><span className="ts-pill">{guarantorSummary}</span>
        <span className="ts-pill">{fa(toDigits(d.amount))} میلیون</span>
        <button type="button" className="ts-link" onClick={() => go(3)} data-testid="ts-edit-answers">ویرایش</button></div>
      {plans.error ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> طرح‌ها بارگذاری نشد: {plans.error} <button type="button" className="ts-link" onClick={retryPlans}>دوباره امتحان کن</button></div>
        : !planList ? <p className="ts-loading" role="status">در حال بررسی طرح‌ها…</p> : <>
          {noneFit ? <div className="ts-nofit" role="status" data-testid="ts-nofit"><b>با جواب‌های این تماس هیچ طرحی مناسب نیست</b>
            <p>می‌توانی بدون انتخاب ادامه بدهی؛ اولویت طبق قانون H6 تعیین می‌شود (اولویت ۳).</p></div> : null}
          {fit.length ? <section className="ts-group fit" data-testid="ts-group-fit"><h3 className="ts-group-h">مناسب <small>{fa(fit.length)} طرح</small></h3>{fit.map(card)}</section> : null}
          {dep.length ? <section className="ts-group depends" data-testid="ts-group-depends"><h3 className="ts-group-h">بستگی دارد <small>{fa(dep.length)} طرح</small></h3>
            <p className="ts-group-x">به جوابی بستگی دارد که «نمی‌دونه» بود یا در این تماس پرسیده نمی‌شود. اگر انتخاب کنی، با برچسب «مشروط» به کارشناس بعدی می‌رسد.</p>{dep.map(card)}</section> : null}
          {no.length ? <>
            <button type="button" className="ts-showall" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} data-testid="ts-show-all">
              {showAll ? <><ChevronUp size={18} /> بستن طرح‌های نامناسب</> : <><ChevronDown size={18} /> نمایش همه ({fa(no.length)} طرح نامناسب، با دلیل)</>}</button>
            {showAll ? <section className="ts-group no" data-testid="ts-group-no"><h3 className="ts-group-h">مناسب نیست <small>{fa(no.length)} طرح</small></h3>{no.map(card)}</section> : null}
          </> : null}
          {!planList.length ? <p className="ts-muted">هیچ طرح فعالی تعریف نشده است.</p> : null}
        </>}
    </>;
  } else {
    body = <>
      <div className="ts-script">{answered ? <><b>قبل از قطع تماس بپرس:</b><p>«برای شما چقدر فوریه؟»</p></>
        : <><b>قبل از قطع تماس:</b><p>یادداشت کامل بنویس تا مشتری مجبور نشه همه‌چیز رو دوباره تعریف کنه.</p></>}</div>
      {errors.note === 'empty' ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> بدون یادداشت نمی‌شه ثبت کرد. چند خط از صحبت با مشتری بنویس.</div> : null}
      <div className="ts-q"><label htmlFor="ts-note">یادداشت تماس <span className="req">*</span></label>
        <textarea id="ts-note" className={`ts-inp ts-note${errors.note ? ' bad' : ''}`} rows={4} value={d.note} onChange={(e) => set({ note: e.target.value.slice(0, 4000) })} placeholder="مثلاً: شغل، مبلغ، ضامن، بهترین ساعت تماس…" aria-invalid={Boolean(errors.note)} aria-describedby="ts-note-meta" data-testid="ts-note" />
        <div className="ts-note-meta" id="ts-note-meta"><span className={errors.note ? 'bad' : ''}>{errors.note === 'empty' ? 'یادداشت الزامی است' : errors.note === 'short' ? `یادداشت باید حداقل ${fa(noteMin)} حرف باشد` : `حداقل ${fa(noteMin)} نویسه`}</span><span className={noteLen < noteMin ? (errors.note ? 'bad' : '') : 'okc'} data-testid="ts-note-count">{fa(noteLen)} نویسه</span></div></div>
      {answered ? <div className="ts-answers" data-testid="ts-picked"><span className="ts-muted small">طرح‌های انتخاب‌شده:</span>
        {selectedPlans.length ? selectedPlans.map((p) => <PlanChip key={p.planId} plan={{ name: p.planName, status: p.status === 'depends' ? 'depends' : 'fit', reasons: p.reasons.filter((r) => r.kind === 'unknown').map(planReasonText) }} />)
          : <span className="ts-muted small">هیچ طرحی انتخاب نشد</span>}
        <button type="button" className="ts-link" onClick={() => go(5)} data-testid="ts-change-plans">تغییر</button></div> : null}
      {answered ? <fieldset className="ts-q"><legend>فوریت <span className="req">*</span> <span className="ts-muted small">آخرین سؤال فرم</span></legend>
        <Chips name="urgency" list={URGENCY} value={d.urgency} onChange={(v) => set({ urgency: v })} />{err('urgency')}</fieldset> : null}
      {!answered && summary.length ? <div className="ts-summary"><span className="ts-muted">خلاصه:</span>{summary.map((s, i) => <span key={i} className="ts-pill">{s}</span>)}</div> : null}
      {serverError ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> {serverError}</div> : null}
    </>;
  }

  const lastStep = d.step === steps[steps.length - 1];
  const nextLabel = d.step === 5 && planList && !planList.some((p) => p.status !== 'no') ? 'بدون انتخاب، بعدی' : 'بعدی';
  return <div className="ts-layer" dir="rtl">
    <div className="ts-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={dialogRef} className="ts-wz" role="dialog" aria-modal="true" aria-labelledby="ts-wz-title" tabIndex={-1} data-testid="ts-simple-form">
      <div className="ts-wz-head">
        <div className="ts-wz-who">
          <h2 id="ts-wz-title">فرم تماس — {customer.name}</h2>
          <div className="sub"><span className="ltr" data-testid="ts-phone">{fa(customer.phone)}</span>
            <button type="button" className="ts-copy" onClick={copyPhone} aria-label="کپی شماره" data-testid="ts-copy-phone"><Copy size={13} /> {copied ? 'کپی شد' : 'کپی'}</button>
            <span className="ts-badge gray">{prio}</span> <span className="ts-badge">نسخه‌ی ساده</span></div>
        </div>
        <a className="ts-ib call" href={`tel:${customer.phone}`} aria-label="تماس با مشتری"><Phone size={20} /></a>
        <button type="button" className="ts-ib" onClick={onClose} aria-label="بستن" data-testid="ts-close"><X size={22} /></button>
      </div>
      <div className="ts-progress">
        <div className="row"><b>{result ? 'نتیجه' : titles[d.step]}</b><span className="ts-muted" data-testid="ts-step-of">{result ? 'ثبت شد' : `مرحله ${fa(idx)} از ${fa(total)}`}</span></div>
        <div className="bars" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} className={result || i < idx ? 'on' : ''} />)}</div>
      </div>
      <div className="ts-wz-body" ref={bodyRef}>{body}</div>
      <div className="ts-wz-foot">
        {result ? <div className="ts-two">
          <button type="button" className="ts-ghost" onClick={onClose} data-testid="ts-open-file">پرونده مشتری</button>
          <button type="button" className="ts-primary" onClick={onNext} data-testid="ts-next-customer">مشتری بعدی صف</button>
        </div> : <div className="ts-two grow">
          {idx > 1 ? <button type="button" className="ts-ghost narrow" onClick={back}><ChevronRight size={18} /> قبلی</button> : <button type="button" className="ts-ghost narrow" onClick={onClose}>بستن</button>}
          {d.step === 5 ? <span className="ts-foot-note" data-testid="ts-selected-count">{d.selected.length ? `${fa(selectedPlans.length || d.selected.length)} طرح انتخاب شد` : 'انتخاب اختیاری است'}</span> : null}
          {lastStep ? <button type="button" className="ts-primary" onClick={submit} disabled={pending} data-testid="ts-submit"><Check size={18} /> {pending ? 'در حال ثبت…' : d.callResult === 'no_answer' ? 'ثبت تماس بی‌پاسخ' : 'ثبت و تعیین اولویت'}</button>
            : <button type="button" className="ts-primary" onClick={next} disabled={d.step === 5 && !planList} data-testid="ts-next">{nextLabel} <ChevronLeft size={18} /></button>}
        </div>}
        {!result ? <p className="ts-muted center small">پیش‌نویس روی همین دستگاه نگه داشته می‌شود</p> : null}
      </div>
    </div>
  </div>;
}
