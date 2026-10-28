import { AlertCircle, AlertTriangle, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, HelpCircle, Info, Search, Timer, X } from 'lucide-react';
import { CALL_NOTE_MIN, callNoteLength, callNoteMinMessage } from '@/lib/call-note';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TransferCheckBox } from './TransferCheckBox';
import { fa, fetchCities, fetchPlanOptions, fmtDateTime, shortName, submitFirstCallEdit, submitSimpleForm, TeamSalesApiError, type TransferCheck, type CallResult, type FirstCallEditResult, type FirstCallSummary, type Military, type QualifyResult, type SimpleAnswers, type SuggestedPlan, type Tri } from './api';
import { FIRST_CALL_FIELD_LABELS, firstCallValueText } from './first-call-edit-labels';
import { NoPlanChip, PlanChip } from './PlanChip';
import { JOB_LABELS, JOB_ORDER, MILITARY_LABELS, planMeta, planReasonText, type PlanEvaluation, type PlanReason } from './plan-reasons';
import './team-sales.css';
import { saveFileCard, type FileCard as FileCardResult } from '@/features/history/api';
import { useSiteAnswers, saWhen, faN as saFaN } from '@/features/site-answers/api';
import { siteHints, sitePrefill, type SiteHints, type SitePrefill } from '@/features/site-answers/prefill';
import { Globe } from 'lucide-react';
import '@/features/site-answers/site-answers.css';
import { GradeChip } from '@/components/grade/GradeChip';
import { GradePicker } from '@/components/grade/GradePicker';
import { gradeText, isLegacy } from '@/lib/credit-grade';
import { CustomerName } from '@/components/customer/CustomerName';
import { VoiceNoteButton } from '@/features/voice-notes/VoiceNoteButton';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { formatJalaliValue, jalaliToIso, parseJalaliValue, tehranPersianParts } from '@/lib/jalali';
import { tehranJalaliValue } from '@/lib/goods-api';
import { focusCallResult, MANUAL_OUTCOME_MISSING, MANUAL_OUTCOME_OPTIONS, ManualOutcomeField, type ManualOutcome } from '@/features/call-queue/ResultFields';

/**
 * First-call form (design crm-call-form-plans): 6 steps when the customer answered —
 * 1 result, 2 need + docs, 3 applicant, 4 guarantor, 5 matching plans, 6 note + urgency (urgency is the last question).
 * crm-no-plan-option: the applicant step got a sub-step (7: military service, job, city) shown right after 3, so the
 * progress bar counts 7 steps; step 4 asks the guarantor's job after «بله»; step 5 has «هیچ طرحی به این مشتری نمی‌خوره».
 * Other call results keep only step 1 and the note.
 * Release 81: step 1 starts with the required 3-button «نتیجه‌ی تماس» (جواب داد / جواب نداد / خاموش یا اشغال); after «جواب داد»
 * the expert picks صحبت کردیم / گفت بعداً زنگ بزنید / شماره اشتباه. The two no-answer choices make every first-call question optional (note only).
 */
type Draft = {
  /** Release 81: required «نتیجه‌ی تماس» (call_logs.call_result). جواب نداد / خاموش یا اشغال → callResult no_answer, questions skipped. */
  manual: ManualOutcome | null;
  step: number; callResult: CallResult | null; callbackAt: string; callbackDate: string; callbackHour: string; callbackMinute: string; amount: string;
  urgency: SimpleAnswers['urgency']; docsReady: SimpleAnswers['docsReady']; creditRank: string | null;
  cheque: 'check' | 'promissory' | 'none' | null; bounced: 'yes' | 'no' | null;
  gAvail: Tri | null; gCheque: Tri | null; gRank: string | null; selected: number[]; note: string;
  military: Military | null; jobType: string | null; gJobType: string | null; city: string; cityTouched: boolean;
  /** null = not touched: follows the server default (checked when no plan fits or depends). */
  noPlan: boolean | null; noPlanNote: string;
  /** HISTORY-A v1.2: «متقاضی یا یکی از خانواده‌اش بازنشسته‌ی تأمین اجتماعی هست؟» (required) + optional relation (family only). */
  sso: SsoRetiree | null; ssoRel: string;
};
export type SsoRetiree = 'self' | 'family' | 'none';
export const SSO_RETIREE: Array<[SsoRetiree, string]> = [['self', 'خود متقاضی'], ['family', 'یکی از خانواده'], ['none', 'هیچ‌کدام']];
const SSO_REL_MAX = 40;
/** Expert-only hint (never shown to the customer; no loan amount or rate). */
export function RetireeHint({ sso, rel, small }: { sso: SsoRetiree | null | undefined; rel?: string | null; small?: boolean }) {
  if (sso !== 'self' && sso !== 'family') return null;
  return <div className={`reth${small ? ' sm' : ''}`} role="note" data-testid="reth"><Info size={16} aria-hidden="true" className="i" />
    <span><b>ترنا و طرح بازنشسته‌ها رو پیشنهاد بده</b>
      {sso === 'family' ? <small>{rel ? `${rel} متقاضی` : 'یکی از خانواده‌ی متقاضی'} بازنشسته‌ی تأمین اجتماعی است؛ می‌تونه همون عضو خانواده رو هم معرفی کنه تا خودش متقاضی بشه.</small>
        : <small>متقاضی خودش بازنشسته‌ی تأمین اجتماعی است.</small>}
      <em className="xo">فقط برای کارشناس · به مشتری نشان داده نمی‌شود</em></span></div>;
}
const EMPTY: Draft = { manual: null, step: 1, callResult: null, callbackAt: '', callbackDate: '', callbackHour: '', callbackMinute: '', amount: '', urgency: null, docsReady: null, creditRank: null, cheque: null, bounced: null,
  gAvail: null, gCheque: null, gRank: null, selected: [], note: '',
  military: null, jobType: null, gJobType: null, city: '', cityTouched: false, noPlan: null, noPlanNote: '', sso: null, ssoRel: '' };
// New key: a 3-step draft from the old form has a different step numbering and must not be restored into this one.
/** «زمان تماس بعدی»: Jalali date + Tehran hour/minute → ISO (UTC) for the API; '' while incomplete/invalid. */
export function callbackIso(date: string, hour: string, minute: string): string {
  const p = parseJalaliValue(date);
  if (!p || hour.trim() === '' || minute.trim() === '') return '';
  return jalaliToIso(p.year, p.month, p.day, Number(hour), Number(minute)) ?? '';
}
/** Drafts saved before the Jalali picker held a browser-local datetime-local value; carry it over as Tehran Jalali parts. */
function migrateCallback(raw: Partial<Draft>): Partial<Draft> {
  if (!raw.callbackAt || raw.callbackDate !== undefined) return raw;
  const t = new Date(raw.callbackAt);
  if (Number.isNaN(t.getTime())) return { ...raw, callbackAt: '' };
  const p = tehranPersianParts(t);
  const hm = new Intl.DateTimeFormat('en-US-u-nu-latn', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tehran' }).format(t).split(':');
  return { ...raw, callbackAt: t.toISOString(), callbackDate: formatJalaliValue(p.year, p.month, p.day), callbackHour: hm[0], callbackMinute: hm[1] };
}
const draftKey = (userId: number | undefined, customerId: number) => `nafis-ts-firstcall-draft:${userId ?? 0}:${customerId}`;
const STEP_NOTE = 6;
const STEP_PROFILE = 7; // applicant sub-step (between 3 and 4)
const NO_PLAN_NOTE_MAX = 200;
/** crm-first-call-edit: the wizard prefilled from «خلاصه‌ی تماس اول» (no call result step, no local draft). */
export type FirstCallEditMode = {
  fc: FirstCallSummary; canSend: boolean; sendBlockedReason: string | null;
  onSaved: (r: FirstCallEditResult) => void;
};
/** HISTORY-A v1.2 «تکمیل/ویرایش پرونده مشتری»: same questions as the first-call form (steps 2,3,7,4 on one page), saved as answers only. */
export type FileFormMode = { answers: Record<string, unknown> | null; city?: string | null; complete: boolean; onSaved: (card: FileCardResult) => void };
function draftFromAnswers(a: Record<string, any> | null, city?: string | null): Draft {
  if (!a) return { ...EMPTY, step: 2, callResult: 'answered', city: city ?? '', cityTouched: Boolean(city) };
  return { ...draftFromFirstCall({ answers: a, note: '', selectedPlans: [], noPlanFit: false, noPlanNote: null } as unknown as FirstCallSummary), note: '', selected: [], noPlan: null,
    city: a.city ?? city ?? '', cityTouched: Boolean(a.city ?? city) };
}
function draftFromFirstCall(fc: FirstCallSummary): Draft {
  const a = fc.answers as FirstCallSummary['answers'] & { ssoRetiree?: SsoRetiree | null; ssoRetireeRelation?: string | null };
  const cheque: Draft['cheque'] = a.checkStatus && a.checkStatus !== 'none' ? 'check' : a.canPromissory === 'yes' ? 'promissory' : a.checkStatus ? 'none' : null;
  const tri = (v: unknown): Tri | null => (v === 'yes' || v === 'no' || v === 'unknown' ? v : null);
  const ids = (fc.selectedPlans ?? []).map((p) => Number(p.id));
  return { ...EMPTY, step: 2, callResult: 'answered', amount: a.amountMillion != null ? String(a.amountMillion) : '',
    urgency: (a.urgency as Draft['urgency']) ?? null, docsReady: (a.docsReady as Draft['docsReady']) ?? null, creditRank: a.creditRank ?? null,
    cheque, bounced: a.bouncedCheque === 'yes' || a.bouncedCheque === 'no' ? a.bouncedCheque : null,
    gAvail: tri(a.guarantorAvailable), gCheque: tri(a.guarantorCheque), gRank: a.gRank ?? null, selected: ids, note: fc.note ?? '',
    military: (a.military as Military) ?? null, jobType: a.jobType ?? null, gJobType: a.gJobType ?? null,
    city: a.city ?? '', cityTouched: Boolean(a.city), noPlan: fc.noPlanFit ? true : ids.length ? false : null, noPlanNote: fc.noPlanNote ?? '',
    sso: a.ssoRetiree === 'self' || a.ssoRetiree === 'family' || a.ssoRetiree === 'none' ? a.ssoRetiree : null, ssoRel: a.ssoRetireeRelation ?? '' };
}
const MILITARY: Array<[Military, string]> = (['has_card', 'no_card', 'female', 'unknown'] as Military[]).map((k) => [k, MILITARY_LABELS[k]]);

const CALL_RESULTS: Array<[CallResult, string]> = [
  ['answered', 'جواب داد و صحبت کردیم'], ['no_answer', 'جواب نداد / خاموش'], ['callback', 'گفت بعداً زنگ بزنید'], ['wrong_number', 'شماره اشتباه'],
];
/** Release 81: after «جواب داد», what happened on the call (the old step-1 list without «جواب نداد / خاموش»). */
const ANSWERED_RESULTS: Array<[CallResult, string]> = [['answered', 'صحبت کردیم'], ['callback', 'گفت بعداً زنگ بزنید'], ['wrong_number', 'شماره اشتباه']];
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

/** Searchable job picker (same six options as the plan editor's job list) + a separate dashed «نمی‌دونه». */
function JobQuestion({ name, legend, value, onChange, error, hint, mark, siteHint, pf }: {
  name: string; legend: string; value: string | null; onChange: (v: string | null) => void; error: ReactNode; hint?: string; mark?: ReactNode; siteHint?: ReactNode; pf?: boolean;
}) {
  const [q, setQ] = useState('');
  const unknown = value === 'unknown';
  const norm = (x: string) => x.replace(/[\u200c\s]+/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
  const list = JOB_ORDER.filter((k) => !q.trim() || norm(JOB_LABELS[k]).includes(norm(q)));
  return <fieldset className={`ts-q${pf ? ' fq-pf' : ''}`}><legend>{legend} <span className="req">*</span><span className="ts-new">جدید</span>{hint ? <span className="ts-muted small"> {hint}</span> : null}{mark}</legend>{siteHint}
    <div className="ts-search"><Search size={18} aria-hidden="true" />
      <input className="ts-inp" type="search" value={q} onChange={(e) => setQ(e.target.value.slice(0, 40))} placeholder="جست‌وجو با نام شغل (مثلاً کارمند)" aria-label={`جست‌وجو در ${legend}`} disabled={unknown} data-testid={`ts-job-search-${name}`} /></div>
    <div className="ts-chips col ts-joblist" role="radiogroup" aria-label={legend}>
      {list.map((k) => <button key={k} type="button" role="radio" aria-checked={value === k} disabled={unknown} className="ts-opt" onClick={() => onChange(k)} data-testid={`ts-opt-${name}-${k}`}>{JOB_LABELS[k]}</button>)}
      {!list.length ? <p className="ts-muted small" role="status">شغلی با «{q}» پیدا نشد.</p> : null}
    </div>
    <div className="ts-unknown-row">
      <button type="button" role="checkbox" aria-checked={unknown} className="ts-opt dash" data-testid={`ts-opt-${name}-unknown`}
        onClick={() => { setQ(''); onChange(unknown ? null : 'unknown'); }}>نمی‌دونه</button>
      <span className="ts-muted small">طرح‌هایی که شغل خاصی می‌خواهند «بستگی دارد» می‌شوند، حذف نمی‌شوند.</span>
    </div>
    {error}
  </fieldset>;
}

/** City of residence: free text with autocomplete from cities already saved on customers (the CRM has no city list). */
function CityQuestion({ customerId, value, onChange }: { customerId: number; value: string; onChange: (v: string) => void }) {
  const [items, setItems] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { fetchCities(customerId, value).then((r) => { if (live) setItems(r.items.filter((c) => c !== value)); }).catch(() => { if (live) setItems([]); }); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [customerId, value]);
  return <div className="ts-q ts-city"><label htmlFor="ts-city">شهر محل سکونت <span className="ts-muted small">اختیاری</span><span className="ts-new">جدید</span></label>
    <input id="ts-city" className="ts-inp" value={value} autoComplete="off" role="combobox" aria-expanded={open && items.length > 0} aria-controls="ts-city-list" aria-autocomplete="list"
      onChange={(e) => { onChange(e.target.value.slice(0, 60)); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
      placeholder="جست‌وجو با نام شهر (مثلاً تهران)" data-testid="ts-city" />
    {open && items.length ? <ul className="ts-city-list" id="ts-city-list" role="listbox" data-testid="ts-city-list">
      {items.slice(0, 8).map((c) => <li key={c} role="option" aria-selected={false}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(c); setOpen(false); }}>{c}</button></li>)}
    </ul> : null}
    <p className="ts-muted small">اگر شهر مشتری در پرونده خالی باشد، همین در پرونده ثبت می‌شود؛ شهر ثبت‌شده عوض نمی‌شود.</p>
  </div>;
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

const STRICT_LABELS: Record<string, string> = { manual: 'نتیجه‌ی تماس', callResult: 'نتیجه‌ی گفت‌وگو', callbackAt: 'زمان تماس بعدی', amount: 'مبلغ', docsReady: 'مدارک', creditRank: 'رتبه', cheque: 'چک صیادی / سفته',
  bounced: 'چک برگشتی', military: 'نظام وظیفه', sso: 'بازنشستگی تأمین اجتماعی', jobType: 'شغل', gAvail: 'ضامن', gJobType: 'شغل ضامن', gCheque: 'چک ضامن', gRank: 'رتبه‌ی ضامن', note: 'یادداشت', urgency: 'فوریت' };
/** release 69 polish: rule codes «(H2)» are internal; digits Persian («۱ از ۳»، «۴ ساعت»). */
export const reasonText = (x: string) => fa(String(x ?? '').replace(/\s*\((?:H|R)\d+\)/g, ''));
const maskPh = (p: string) => { const s = String(p ?? ''); return s.length >= 8 ? `${s.slice(0, 4)}***${s.slice(-4)}` : s; };

export function SimpleCallForm({ customer, userId, noteMin = CALL_NOTE_MIN, onClose: onCloseRaw, onDone, onNext, onChangeCustomer, edit, file, strict = false, confirmClose = false, closeConfirmBody, reopenNotice = false, returnLabel, eyebrow }: {
  customer: { id: number; name: string; phone: string; priority?: number | null };
  userId: number | undefined; noteMin?: number;
  onClose: () => void; onDone: (r: QualifyResult) => void; onNext: () => void;
  /** Calls page «ثبت تماس جدید»: back to the customer picker (step 1). */
  onChangeCustomer?: () => void;
  /** crm-first-call-edit: edit the latest first call instead of recording a new call. */
  edit?: FirstCallEditMode;
  /** incoming2-59 (Armita crm-incoming-call v1.1, opt-in): «بعدی»/submit aria-disabled until this step's required fields are filled,
   *  a click shows the field errors + «N مورد مانده: …»; phone masked in the header. Default off → customer page unchanged. */
  strict?: boolean;
  /** Body of the close confirm (Armita v1.1 wording by default). */
  closeConfirmBody?: string;
  /** incoming2-59 (Armita v1.1.1 scene 13 fc_reopen): reopened on opening the customer file; the local draft keeps the values. */
  reopenNotice?: boolean;
  /** incoming2-59 PM rule (opt-in): closing before the save (X, scrim, Esc, «بستن») asks «بستن بدون ثبت تماس؟» first. */
  confirmClose?: boolean;
  /** release 69 (Armita live-59 #2): opened from «تماس ورودی داشتم» — the result footer is one «برگشت به کار N» (onNext),
   *  no «پرونده مشتری» / «مشتری بعدی صف»; the caller closes, toasts and stays on the same current task. */
  returnLabel?: string;
  /** release 69 polish: small line above the title, e.g. «تماس ورودی». */
  eyebrow?: string;
  /** HISTORY-A v1.2: Today-card file column «تکمیل/ویرایش پرونده مشتری» — answers only, single «ذخیره‌ی پرونده», no call/priority. */
  file?: FileFormMode;
}) {
  const key = draftKey(userId, customer.id);
  const [d, setD] = useState<Draft>(() => { if (file) return draftFromAnswers(file.answers, file.city); if (edit) return draftFromFirstCall(edit.fc); try { const raw = localStorage.getItem(key); return raw ? { ...EMPTY, ...migrateCallback(JSON.parse(raw)) } : EMPTY; } catch { return EMPTY; } });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState('');
  // R3 «بررسی سپردن»: refused hand-off → the draft stays; resend with a reason (warn) or see the way back (block).
  const [tc, setTc] = useState<{ check: TransferCheck; edit: boolean; send: boolean } | null>(null);
  const [rankLetter, setRankLetter] = useState<string | null>(null);
  const [gRankLetter, setGRankLetter] = useState<string | null>(null);
  const [result, setResult] = useState<QualifyResult | null>(null);
  const [editResult, setEditResult] = useState<FirstCallEditResult | null>(null);
  const done = Boolean(result || editResult);
  const [cfm, setCfm] = useState(false);
  const doneRef = useRef(false); doneRef.current = done;
  const cfmRef = useRef(false); cfmRef.current = cfm;
  const onClose = useCallback(() => {
    if (cfmRef.current) { setCfm(false); return; }
    if (confirmClose && !doneRef.current) setCfm(true); else onCloseRaw();
  }, [confirmClose, onCloseRaw]);
  const [plans, setPlans] = useState<{ key: string; list: PlanEvaluation[] | null; error: string; noPlanDefault?: boolean }>({ key: '', list: null, error: '' });
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyToast, setCopyToast] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!result && !edit && !file) try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* quota */ } }, [d, key, result, edit]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [d.step, result, editResult]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    // Escape inside the Jalali date popover only closes the popover, not the whole form.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.ts-callback-popover')) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  const set = (patch: Partial<Draft>) => { setD((c) => ({ ...c, ...patch })); setErrors({}); setServerError(''); };
  // v82 (Armita site-apply-wizard v1.0.1 §۴ب): the customer's site answers prefill EMPTY fields only (never in «ویرایش» of a saved
  // first call), each marked «از فرم سایت» and still editable; non one-to-one answers become «سایت: …» hint lines.
  const siteQ = useSiteAnswers(customer.id, !edit);
  const site = edit ? null : siteQ.data?.latest ?? null;
  const [pfv, setPfv] = useState<SitePrefill>({});
  const pfDone = useRef(false);
  useEffect(() => {
    if (!site || pfDone.current || result || editResult) return;
    if (!file && d.callResult !== 'answered') return; // a no-answer first call never carries prefilled answers
    pfDone.current = true;
    const want = sitePrefill(site.answers); const took: SitePrefill = {};
    for (const [k, v] of Object.entries(want)) if ((d as Record<string, unknown>)[k] == null) (took as Record<string, unknown>)[k] = v;
    if (!Object.keys(took).length) return;
    setPfv(took); setD((c) => { const n = { ...c } as Record<string, unknown>; for (const [k, v] of Object.entries(took)) if (n[k] == null) n[k] = v; return n as Draft; });
  }, [site, file, d, result, editResult]);
  const hints: SiteHints = site ? siteHints(site.answers) : {};
  const isPf = (k: keyof SitePrefill) => pfv[k] != null && (d as Record<string, unknown>)[k] === pfv[k];
  const pfMark = (k: keyof SitePrefill) => isPf(k) ? <i className="fsite" data-testid={`ts-pf-${k}`}>از فرم سایت</i> : null;
  const pfHint = (k: keyof SiteHints) => hints[k] ? <p className="fsh-s" data-testid={`ts-sh-${k}`}><Globe size={13} aria-hidden="true" />{hints[k]}</p> : null;
  const pfCls = (k: keyof SitePrefill) => `ts-q${isPf(k) ? ' fq-pf' : ''}`;
  const pfCount = Object.keys(pfv).length;
  const siteBanner = site && (pfCount || Object.keys(hints).length) && !result && !editResult ? <p className="fsb" role="note" data-testid="ts-site-banner"><Globe size={14} aria-hidden="true" />
    <span>{pfCount ? <b>{saFaN(pfCount)} جواب از فرم سایت پر شد</b> : <b>جواب‌های فرم سایت به‌عنوان راهنما آمده</b>} ({saWhen(site.submittedAt)})؛ همه قابل تغییر است. بقیه را از مشتری بپرس.</span></p> : null;

  const answered = d.callResult === 'answered';
  const steps = file ? [2, 3, STEP_PROFILE, 4] : edit ? [2, 3, STEP_PROFILE, 4, 5, STEP_NOTE] : answered ? [1, 2, 3, STEP_PROFILE, 4, 5, STEP_NOTE] : [1, STEP_NOTE];
  const total = steps.length;
  const idx = Math.max(0, steps.indexOf(d.step)) + 1;
  const titles: Record<number, string> = { 1: 'نتیجه‌ی تماس', 2: 'نیاز و مدارک', 3: 'متقاضی — رتبه و چک', [STEP_PROFILE]: 'متقاضی — خدمت، شغل و شهر', 4: 'ضامن', 5: 'طرح‌های مناسب', 6: answered ? 'یادداشت و فوریت' : 'یادداشت' };

  const validate = (step: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!d.manual) e.manual = MANUAL_OUTCOME_MISSING;
      else if (!d.callResult) e.callResult = 'بعد از «جواب داد» بگو چه شد: صحبت کردیم، بعداً زنگ بزنید یا شماره اشتباه.';
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
      if (file && !d.urgency) e.urgency = 'فوریت را انتخاب کن.';
    }
    if (step === 3) {
      if (!d.creditRank) e.creditRank = rankLetter ? `زیررتبه‌ی ${rankLetter} را انتخاب کن (${rankLetter}1، ${rankLetter}2 یا ${rankLetter}3) یا «نمی‌دونه» را بزن.` : 'رتبه‌ی اعتباری را انتخاب کن (یا «نمی‌دونه»).';
      else if (isLegacy(d.creditRank)) e.creditRank = `رتبه‌ی ${d.creditRank} قدیمی است؛ زیررتبه را دوباره انتخاب کن.`;
      if (!d.cheque) e.cheque = 'یکی از گزینه‌ها را انتخاب کن.';
      if (!d.bounced) e.bounced = 'چک برگشتی را مشخص کن.';
    }
    if (step === STEP_PROFILE) {
      if (!d.military) e.military = 'وضعیت نظام وظیفه را انتخاب کن (یا «نمی‌دونه»).';
      if (!d.jobType) e.jobType = 'شغل متقاضی را انتخاب کن (یا «نمی‌دونه»).';
      if (!d.sso) e.sso = 'یکی را انتخاب کن.';
      if ([...d.ssoRel.trim()].length > SSO_REL_MAX) e.sso = `نسبت حداکثر ${SSO_REL_MAX} نویسه.`;
    }
    if (step === 4) {
      if (!d.gAvail) e.gAvail = 'یکی از گزینه‌ها را انتخاب کن.';
      if (d.gAvail === 'yes') {
        if (!d.gJobType) e.gJobType = 'شغل ضامن را انتخاب کن (یا «نمی‌دونه»).';
        if (!d.gCheque) e.gCheque = 'چک ضامن را مشخص کن (یا «نمی‌دونه»).';
        if (!d.gRank) e.gRank = gRankLetter ? `زیررتبه‌ی ${gRankLetter} را انتخاب کن (${gRankLetter}1، ${gRankLetter}2 یا ${gRankLetter}3) یا «نمی‌دونه» را بزن.` : 'رتبه‌ی ضامن را انتخاب کن (یا «نمی‌دونه»).';
      }
    }
    if (step === STEP_NOTE) {
      if (callNoteLength(d.note) < noteMin) e.note = 'short';
      if (answered && !d.urgency) e.urgency = 'فوریت را انتخاب کن.';
    }
    return e;
  };
  const go = (step: number) => set({ step });
  const next = () => {
    const e = validate(d.step);
    if (Object.keys(e).length) { setErrors(e); if (e.manual) focusCallResult('ts'); return; }
    const i = steps.indexOf(d.step);
    go(steps[Math.min(i + 1, steps.length - 1)]);
  };
  const back = () => { const i = steps.indexOf(d.step); if (i > 0) go(steps[i - 1]); };

  const answers = useMemo<SimpleAnswers>(() => {
    const a: SimpleAnswers = { mode: 'simple', callResult: d.callResult ?? 'no_answer', formVersion: 2 };
    if (d.callResult === 'callback' && d.callbackAt) {
      // callbackAt is '' until date+hour+minute are complete; never call toISOString on an invalid date (it throws and crashes the page)
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
      a.military = d.military; a.jobType = d.jobType;
      a.gJobType = d.gAvail === 'yes' ? d.gJobType : null;
      a.city = d.city.trim() || null;
      a.ssoRetiree = d.sso;
      a.ssoRetireeRelation = d.sso === 'family' ? d.ssoRel.trim() || null : null;
    }
    return a;
  }, [d]);
  // Matching only depends on the answers of steps 2-4 (urgency and city have no effect on plans).
  const planKey = answered ? JSON.stringify({ ...answers, urgency: null, city: null, ssoRetireeRelation: null }) : '';
  const planReq = useRef('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (d.step !== 5 || !answered || planReq.current === planKey) return;
    planReq.current = planKey; // the latest request wins; a reply for older answers is ignored
    setPlans({ key: planKey, list: null, error: '' });
    fetchPlanOptions(customer.id, { ...answers, urgency: null, city: null }).then((r) => {
      if (planReq.current !== planKey) return;
      setPlans({ key: planKey, list: r.plans, error: '', noPlanDefault: r.noPlanDefault === true });
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
  // «هیچ طرحی نمی‌خوره» and plan selection are mutually exclusive: picking a plan unticks it, ticking it clears the plans.
  const toggle = (id: number) => set({ selected: d.selected.includes(id) ? d.selected.filter((x) => x !== id) : [...d.selected, id], noPlan: false });
  const noPlan = answered && (d.noPlan ?? (planList ? plans.noPlanDefault === true && !d.selected.length : false));
  const toggleNoPlan = () => set(noPlan ? { noPlan: false } : { noPlan: true, selected: [] });
  // Prefill the city from the customer's file once (never overwrites what the expert typed).
  useEffect(() => {
    if (d.step !== STEP_PROFILE || d.cityTouched || d.city) return;
    let live = true;
    fetchCities(customer.id, '').then((r) => { if (live && r.customerCity) setD((c) => (c.cityTouched || c.city ? c : { ...c, city: r.customerCity ?? '' })); }).catch(() => {});
    return () => { live = false; };
  }, [d.step, d.cityTouched, d.city, customer.id]);

  const submitEdit = async (send: boolean, transferOverrideReason?: string) => {
    if (!edit) return;
    for (const s of steps) { const e = validate(s); if (Object.keys(e).length) { set({ step: s }); setErrors(e); return; } }
    setPending(true); setServerError(''); setTc(null);
    try {
      const r = await submitFirstCallEdit(customer.id, { answers: { ...answers, noPlanFit: noPlan }, note: d.note.trim(),
        selectedPlans: noPlan ? [] : selectedPlans.map((p) => p.planId), noPlanNote: noPlan ? d.noPlanNote.trim() || undefined : undefined,
        send, baseId: edit.fc.id, ...(transferOverrideReason ? { transferOverrideReason } : {}) });
      setEditResult(r); edit.onSaved(r);
    } catch (err) {
      if (err instanceof TeamSalesApiError && err.transferCheck) { setTc({ check: err.transferCheck, edit: true, send }); return; }
      const msg = err instanceof TeamSalesApiError && err.message ? err.message : 'اتصال به سرور برقرار نشد. چیزی ذخیره نشد؛ دوباره امتحان کن.';
      setServerError(`ذخیره انجام نشد: ${msg}`);
    } finally { setPending(false); }
  };
  const fileMissing = file ? steps.reduce<Record<string, string>>((m, s) => ({ ...m, ...validate(s) }), {}) : {};
  const submitFile = async () => {
    if (!file) return;
    if (Object.keys(fileMissing).length) { setErrors(fileMissing); return; }
    setPending(true); setServerError('');
    try { const card = await saveFileCard(customer.id, answers); file.onSaved(card); }
    catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'اتصال به سرور برقرار نشد. چیزی ذخیره نشد؛ دوباره امتحان کن.';
      setServerError(`ذخیره انجام نشد: ${msg}`);
    } finally { setPending(false); }
  };
  const submit = async (transferOverrideReason?: string) => {
    for (const s of steps) { const e = validate(s); if (Object.keys(e).length) { set({ step: s }); setErrors(e); return; } }
    setPending(true); setServerError(''); setTc(null);
    try {
      const r = await submitSimpleForm(customer.id, answered ? { ...answers, noPlanFit: noPlan } : answers, d.note.trim(),
        answered ? (noPlan ? [] : selectedPlans.map((p) => p.planId)) : undefined, noPlan ? d.noPlanNote.trim() || undefined : undefined, transferOverrideReason, d.manual ?? undefined);
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      setResult(r); onDone(r);
    } catch (err) {
      if (err instanceof TeamSalesApiError && err.transferCheck) { setTc({ check: err.transferCheck, edit: false, send: false }); return; }
      const msg = err instanceof TeamSalesApiError && err.message ? err.message : 'اتصال به سرور برقرار نشد. چیزی ثبت نشد؛ دوباره امتحان کن.';
      setServerError(`ثبت انجام نشد: ${msg}`);
    } finally { setPending(false); }
  };
  // Calls page decision 5: no tel: link; the number is shown LTR with «کپی» (clipboard) and a toast.
  const copyPhone = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(customer.phone); ok = true; } catch { /* clipboard blocked */ }
    setCopied(ok); setCopyToast(ok ? 'شماره کپی شد' : 'کپی انجام نشد؛ شماره را دستی انتخاب کنید');
    setTimeout(() => { setCopied(false); setCopyToast(''); }, 2500);
  };

  const summary = [d.manual && d.manual !== 'answered' ? label(MANUAL_OUTCOME_OPTIONS.map((o) => [o.key, o.label] as [ManualOutcome, string]), d.manual)
      : label(CALL_RESULTS.map(([k, v]) => [k, k === 'answered' ? 'جواب داد' : v] as [CallResult, string]), d.callResult),
    d.callResult === 'callback' && d.callbackAt && !Number.isNaN(new Date(d.callbackAt).getTime()) ? `تماس بعدی: ${fmtDateTime(new Date(d.callbackAt).toISOString())}` : ''].filter(Boolean);

  const prio = customer.priority ? `اولویت ${fa(customer.priority)}` : 'بدون اولویت';
  const err = (k: string) => errors[k] && errors[k] !== 'empty' && errors[k] !== 'short' ? <p className="ts-err" role="alert" id={`ts-err-${k}`} data-testid={`ts-err-${k}`}><AlertCircle size={16} /> {errors[k]}</p> : null;
  const noteLen = callNoteLength(d.note);
  const rankChip = (v: string | null) => (v === 'unknown' ? 'نمی‌دونه' : v ? gradeText(v) : '');
  const guarantorSummary = d.gAvail === 'yes'
    ? `ضامن ${d.gCheque === 'yes' ? 'با چک' : d.gCheque === 'no' ? 'بدون چک' : '(چک نامعلوم)'} · ${d.gRank === 'unknown' ? 'رتبه نامعلوم' : rankChip(d.gRank)}`
    : d.gAvail === 'no' ? 'بدون ضامن' : 'ضامن نامعلوم';

  const stepBody = (step: number): ReactNode => {
    if (step === 2) return <>
      <div className="ts-script"><b>بپرس:</b><p>«چه مبلغی لازم دارید؟ مدارکتون آماده‌ست؟»</p></div>
      {siteBanner}
      <div className="ts-q"><label htmlFor="ts-amount">مبلغ وام موردنیاز <span className="req">*</span> <span className="ts-muted small">بین ۱۰ تا ۵۰۰۰</span></label>{pfHint('amount')}
        <div className="ts-suffix"><input id="ts-amount" className="ts-inp" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d۰-۹٠-٩]/g, '').slice(0, 5) })} aria-invalid={Boolean(errors.amount)} data-testid="ts-amount" /><span>میلیون تومان</span></div>{err('amount')}</div>
      <fieldset className={pfCls('docsReady')}><legend>مدارک <span className="req">*</span>{pfMark('docsReady')}</legend>{pfHint('docsReady')}<Chips name="docs" list={DOCS} value={d.docsReady} onChange={(v) => set({ docsReady: v })} />{err('docsReady')}</fieldset>
      {file ? <fieldset className={pfCls('urgency')}><legend>فوریت <span className="req">*</span>{pfMark('urgency')}</legend><Chips name="urgency" list={URGENCY} value={d.urgency} onChange={(v) => set({ urgency: v })} />{err('urgency')}</fieldset>
        : <div className="ts-alert info" role="note"><Info size={18} /> سؤال «فوریت» به آخر فرم رفت؛ بعد از صحبت درباره‌ی طرح‌ها پرسیده می‌شود.</div>}
    </>;
    if (step === 3) return <>
      <div className="ts-script"><b>بپرس:</b><p>«رتبه‌ی اعتبارسنجی‌تون چنده؟ چک صیادی دارید؟»</p></div>
      <RankQuestion name="rank" legend="رتبه‌ی اعتباری متقاضی" value={d.creditRank} error={err('creditRank')}
        onChange={(v, l) => { setRankLetter(l); set({ creditRank: v }); }} />
      <fieldset className={pfCls('cheque')}><legend>چک صیادی یا سفته دارد؟ <span className="req">*</span>{pfMark('cheque')}</legend><Chips name="cheque" list={CHEQUE} value={d.cheque} onChange={(v) => set({ cheque: v })} />{err('cheque')}</fieldset>
      <fieldset className={pfCls('bounced')}><legend>چک برگشتی رفع‌نشده؟ <span className="req">*</span>{pfMark('bounced')}</legend>{pfHint('bounced')}<Chips name="bounced" list={BOUNCED} value={d.bounced} onChange={(v) => set({ bounced: v })} />{err('bounced')}</fieldset>
    </>;
    if (step === STEP_PROFILE) return <>
      <div className="ts-script"><b>بپرس:</b><p>«کارت پایان خدمت دارید؟ شغلتون چیه؟ ساکن کدوم شهر هستید؟»</p></div>
      <fieldset className={pfCls('military')}><legend>وضعیت نظام وظیفه <span className="req">*</span><span className="ts-new">جدید</span>{pfMark('military')}</legend>{pfHint('military')}
        <Chips name="military" list={MILITARY} value={d.military} dashed="unknown" onChange={(v) => set({ military: v })} />{err('military')}</fieldset>
      {d.military === 'no_card' ? <p className="ts-hint" data-testid="ts-mil-hint">طرح‌هایی که پایان خدمت لازم دارند «مناسب نیست» می‌شوند.</p> : null}
      <JobQuestion name="jobType" legend="شغل متقاضی" value={d.jobType} error={err('jobType')} onChange={(v) => set({ jobType: v })} mark={pfMark('jobType')} siteHint={pfHint('jobType')} pf={isPf('jobType')} />
      <CityQuestion customerId={customer.id} value={d.city} onChange={(v) => set({ city: v, cityTouched: true })} />
      <fieldset className="ts-q" data-testid="ts-q-sso"><legend>متقاضی یا یکی از خانواده‌اش بازنشسته‌ی تأمین اجتماعی هست؟ <span className="req">*</span><span className="ts-new">جدید</span></legend>{pfHint('sso')}
        <Chips name="sso" list={SSO_RETIREE} value={d.sso} onChange={(v) => set({ sso: v, ssoRel: v === 'family' ? d.ssoRel : '' })} />{err('sso')}</fieldset>
      {d.sso === 'family' ? <div className="ts-q ts-sub-q"><label htmlFor="ts-sso-rel">نسبت <span className="ts-muted small">اختیاری · مثلاً پدر، مادر، همسر</span></label>
        <input id="ts-sso-rel" className="ts-inp" value={d.ssoRel} maxLength={SSO_REL_MAX} onChange={(e) => set({ ssoRel: e.target.value.slice(0, SSO_REL_MAX) })} data-testid="ts-sso-rel" /></div> : null}
      <RetireeHint sso={d.sso} rel={d.ssoRel.trim() || null} small />
    </>;
    if (step === 4) return <>
      <div className="ts-script"><b>بپرس:</b><p>«می‌تونید یک ضامن معرفی کنید؟»</p></div>
      <fieldset className={pfCls('gAvail')}><legend>ضامن می‌تونه معرفی کنه؟ <span className="req">*</span><span className="ts-new">جدید</span>{pfMark('gAvail')}</legend>{isPf('gAvail') ? null : pfHint('gAvail')}
        <Chips name="gAvail" list={TRI} value={d.gAvail} dashed="unknown" onChange={(v) => { if (v !== 'yes') setGRankLetter(null); set({ gAvail: v }); }} />{err('gAvail')}</fieldset>
      {d.gAvail === 'no' ? <p className="ts-hint" data-testid="ts-g-hint">طرح‌هایی که ضامن لازم دارند «مناسب نیست» می‌شوند.</p> : null}
      {d.gAvail === 'unknown' ? <p className="ts-hint" data-testid="ts-g-hint">طرح‌هایی که ضامن لازم دارند در گروه «بستگی دارد» می‌آیند.</p> : null}
      {d.gAvail === 'yes' ? <div className="ts-sub-q" data-testid="ts-g-follow">
        <fieldset className="ts-q"><legend>ضامن می‌تونه چک بده؟ <span className="req">*</span><span className="ts-new">جدید</span></legend>
          <Chips name="gCheque" list={TRI} value={d.gCheque} dashed="unknown" onChange={(v) => set({ gCheque: v })} />{err('gCheque')}</fieldset>
        <RankQuestion name="gRank" legend="رتبه‌ی اعتباری ضامن" isNew hint="همیشه بعد از «بله» پرسیده می‌شود" value={d.gRank} error={err('gRank')}
          onChange={(v, l) => { setGRankLetter(l); set({ gRank: v }); }} />
        <JobQuestion name="gJobType" legend="شغل ضامن" value={d.gJobType} error={err('gJobType')} onChange={(v) => set({ gJobType: v })} />
      </div> : null}
    </>;
    return null;
  };
  let body: ReactNode;
  if (editResult) {
    const r = editResult; const h = r.handoff;
    body = <div className="ts-result" data-testid="ts-edit-result" data-suggested={r.suggestedPriority} data-priority={r.priorityAfter ?? 'none'}>
      <p className="ts-muted center">{h ? 'ذخیره شد و به کارشناس فروش رفت' : 'ذخیره شد — تماس جدیدی ثبت نشد'}</p>
      <div className={`ts-bignum p${r.priorityAfter ?? 3}`} aria-label={`اولویت ${r.priorityAfter ?? ''}`}>{fa(r.priorityAfter ?? 0)}</div>
      <h3 className="center">{h ? 'اولویت ۱ — ارسال به کارشناس فروش' : r.priorityRaised ? `اولویت از ${fa(r.priorityBefore ?? 0)} به ${fa(r.priorityAfter ?? 0)} رفت` : `اولویت ${fa(r.priorityAfter ?? 0)} — بدون تغییر`}</h3>
      {!h && r.suggestedPriority !== r.priorityAfter ? <p className="ts-muted center" data-testid="ts-edit-suggested">
        {r.suggestedPriority === 1 ? 'با جواب‌های تازه، پیشنهاد سیستم اولویت ۱ است؛ برای ارسال از «ذخیره و ارسال به کارشناس فروش» یا «ارتقا به اولویت ۱» استفاده کن.'
          : `پیشنهاد سیستم: اولویت ${fa(r.suggestedPriority)}. اولویت خودکار پایین آورده نمی‌شود.`}</p> : null}
      {h ? <>
        <div className="ts-ok-card" data-testid="ts-handoff">
          <span className="ts-av" aria-hidden="true">{shortName(h.closerName).slice(0, 1)}</span>
          <div><b>{h.message}</b><p>{h.assignment === 'previous_expert' ? 'کارشناس قبلی مشتری' : 'تقسیم عادلانه'} — به {h.closerName} اعلان و یادآور رسید</p></div>
        </div>
        <p className="ts-muted center">مهلت تماس تا {h.dueLabel}</p>
      </> : null}
      {r.noSuitablePlan ? <div className="ts-alert warn" role="note" data-testid="ts-edit-noplan-warn"><AlertTriangle size={18} /> با جواب‌های تازه هیچ طرحی مناسب نیست.</div> : null}
      {r.changed.length ? <div className="ts-why" data-testid="ts-edit-changed"><b>تغییرها</b><ul>{r.changed.map((c) => <li key={c.field}>
        {FIRST_CALL_FIELD_LABELS[c.field] ?? c.field}: {firstCallValueText(c.field, c.old)} ← {firstCallValueText(c.field, c.new)}</li>)}</ul></div>
        : <p className="ts-muted center">جواب‌ها تغییری نکرد.</p>}
      {r.reasons.length ? <div className="ts-why"><b>{`چرا پیشنهاد اولویت ${fa(r.suggestedPriority)}؟`}</b><ul>{r.reasons.map((x, i) => <li key={i}>{reasonText(x)}</li>)}</ul></div> : null}
    </div>;
  } else if (result) {
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
          <div><b>{h.message}</b><p>{h.assignment === 'previous_expert' ? 'کارشناس قبلی مشتری' : 'تقسیم عادلانه'} — به {h.closerName} اعلان و یادآور رسید</p></div>
        </div>
        <p className="center"><span className="ts-pill ok"><Timer size={15} /> مهلت تماس {h.closerName}: ۳ ساعت کاری</span></p>
        <p className="ts-muted center">یعنی تا {h.dueLabel}</p>
      </> : null}
      {!h && r.nextActionAt && r.outcome !== 'cold_archive' ? <p className="center"><span className="ts-pill">{r.outcome === 'no_answer' ? `تلاش ${fa(r.attempts)} از ${fa(r.maxAttempts ?? 3)} — تماس دوباره:` : 'تماس دوباره:'} {fmtDateTime(r.nextActionAt)}</span></p> : null}
      {result.selectedPlans?.length ? <div className="ts-plans-box" data-testid="ts-result-plans">
        <p>{h ? `طرح‌هایی که انتخاب کردی روی پرونده و ردیف فهرست برای ${h.closerName} دیده می‌شود:` : 'طرح‌هایی که انتخاب کردی روی پرونده و ردیف فهرست مشتری دیده می‌شود:'}</p>
        <div className="ts-picked">{result.selectedPlans.map((p: SuggestedPlan) => <PlanChip key={p.id} plan={p} />)}</div>
      </div> : null}
      {result.noPlanFit ? <div className="ts-plans-box" data-testid="ts-result-noplan">
        <p>روی پرونده و ردیف فهرست مشتری این برچسب دیده می‌شود:</p>
        <div className="ts-picked"><NoPlanChip /></div>
        {result.noPlanNote ? <p>چرا: «{result.noPlanNote}»</p> : null}
      </div> : null}
      {r.reasons.length ? <div className="ts-why"><b>{reasonsTitle}</b><ul>{r.reasons.map((x, i) => <li key={i}>{reasonText(x)}</li>)}</ul></div> : null}
    </div>;
  } else if (d.step === 1) {
    body = <>
      <div className="ts-script"><b>بگو:</b><p>«سلام، وقتتون بخیر. از نفیس وام تماس می‌گیرم، شماره‌تون رو برای مشاوره‌ی وام گذاشته بودید.»</p></div>
      <ManualOutcomeField value={d.manual ?? ''} idPrefix="ts" showError={Boolean(errors.manual)} submitLabel="بعدی"
        onChange={(m) => set(m === 'answered' ? { manual: m, callResult: d.callResult && d.callResult !== 'no_answer' ? d.callResult : 'answered' } : { manual: m, callResult: 'no_answer' })} />
      {d.manual === 'answered' ? <fieldset className="ts-q"><legend>چه شد؟ <span className="req">*</span></legend>
        <Chips name="callResult" list={ANSWERED_RESULTS} value={d.callResult} onChange={(v) => set({ callResult: v })} cols />{err('callResult')}</fieldset>
        : d.manual ? <div className="crs" role="note" data-testid="ts-na-optional"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
          <span><b>سؤال‌های فرم تماس اول برای این تماس لازم نیست</b><small>پرونده «تکمیل نشده» می‌ماند و در تماس بعدی با «جواب داد» دوباره باز می‌شود.</small></span></div> : null}
      {d.callResult === 'callback' ? <div className="ts-q"><label id="ts-callback-label">زمان تماس بعدی <span className="req">*</span></label>
        <div className="ts-callback-row" id="ts-callback" role="group" aria-labelledby="ts-callback-label" data-testid="ts-callback-at" data-iso={d.callbackAt} aria-invalid={Boolean(errors.callbackAt)}>
          <PersianDatePicker value={d.callbackDate} minValue={tehranJalaliValue(0)} onChange={(v) => set({ callbackDate: v, callbackAt: callbackIso(v, d.callbackHour, d.callbackMinute) })} placeholder="انتخاب تاریخ (شمسی)" testId="ts-callback-date" popoverClassName="ts-callback-popover" />
          <div className="reminder-time-grid ts-callback-time" dir="ltr">
            <input className="ts-inp" type="number" inputMode="numeric" min="0" max="23" placeholder="ساعت" value={d.callbackHour} onChange={(e) => set({ callbackHour: e.target.value, callbackAt: callbackIso(d.callbackDate, e.target.value, d.callbackMinute) })} aria-label="ساعت تماس بعدی (به وقت تهران)" data-testid="ts-callback-hour" />
            <span>:</span>
            <input className="ts-inp" type="number" inputMode="numeric" min="0" max="59" placeholder="دقیقه" value={d.callbackMinute} onChange={(e) => set({ callbackMinute: e.target.value, callbackAt: callbackIso(d.callbackDate, d.callbackHour, e.target.value) })} aria-label="دقیقه" data-testid="ts-callback-minute" />
          </div>
        </div>
        <p className="ts-callback-note">ساعت به وقت تهران</p>{err('callbackAt')}</div> : null}
    </>;
  } else if (file) {
    body = <div className="ffq" data-testid="ff-body">{steps.map((st) => <section key={st} className="ffs"><h4 className="fsh">{titles[st]}</h4>{stepBody(st)}</section>)}</div>;
  } else if (d.step === 2 || d.step === 3 || d.step === STEP_PROFILE || d.step === 4) {
    body = stepBody(d.step);
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
        {d.military ? <span className="ts-pill">{d.military === 'unknown' ? 'خدمت نامعلوم' : MILITARY_LABELS[d.military]}</span> : null}
        {d.jobType ? <span className="ts-pill">{d.jobType === 'unknown' ? 'شغل نامعلوم' : JOB_LABELS[d.jobType]}</span> : null}
        <button type="button" className="ts-link" onClick={() => go(3)} data-testid="ts-edit-answers">ویرایش</button></div>
      {plans.error ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> طرح‌ها بارگذاری نشد: {plans.error} <button type="button" className="ts-link" onClick={retryPlans}>دوباره امتحان کن</button></div>
        : !planList ? <p className="ts-loading" role="status">در حال بررسی طرح‌ها…</p> : <>
          {noneFit ? <div className="ts-nofit" role="status" data-testid="ts-nofit"><b>با جواب‌های این تماس هیچ طرحی مناسب نیست</b>
            <p>گزینه‌ی «هیچ طرحی به این مشتری نمی‌خوره» پایین فهرست خودکار زده شد. اگر مشتری جواب داد و قصد وام دارد، اولویت ۲ می‌گیرد. اگر فقط کنجکاو است یا چک برگشتی دارد، اولویت ۳ می‌گیرد.</p></div> : null}
          {fit.length ? <section className="ts-group fit" data-testid="ts-group-fit"><h3 className="ts-group-h">مناسب <small>{fa(fit.length)} طرح</small></h3>{fit.map(card)}</section> : null}
          {dep.length ? <section className="ts-group depends" data-testid="ts-group-depends"><h3 className="ts-group-h">بستگی دارد <small>{fa(dep.length)} طرح</small></h3>
            <p className="ts-group-x">به جوابی بستگی دارد که «نمی‌دونه» بود یا در این تماس پرسیده نمی‌شود. اگر انتخاب کنی، با برچسب «مشروط» به کارشناس بعدی می‌رسد.</p>{dep.map(card)}</section> : null}
          {no.length ? <>
            <button type="button" className="ts-showall" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} data-testid="ts-show-all">
              {showAll ? <><ChevronUp size={18} /> بستن طرح‌های نامناسب</> : <><ChevronDown size={18} /> نمایش همه ({fa(no.length)} طرح نامناسب، با دلیل)</>}</button>
            {showAll ? <section className="ts-group no" data-testid="ts-group-no"><h3 className="ts-group-h">مناسب نیست <small>{fa(no.length)} طرح</small></h3>{no.map(card)}</section> : null}
          </> : null}
          {!planList.length ? <p className="ts-muted">هیچ طرح فعالی تعریف نشده است.</p> : null}
          <div className="ts-noplan-wrap">
            <div role="checkbox" tabIndex={0} aria-checked={noPlan} className="ts-plan ts-noplan" data-testid="ts-noplan"
              onClick={toggleNoPlan} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleNoPlan(); } }}>
              <span className="ts-box" aria-hidden="true">{noPlan ? <Check size={16} /> : null}</span>
              <span className="ts-plan-main"><b>هیچ طرحی به این مشتری نمی‌خوره</b>
                <span className="ts-plan-meta">با انتخاب طرح جمع نمی‌شود. اگر مشتری جواب داد و قصد وام دارد، اولویت ۲ می‌گیرد. اگر فقط کنجکاو است یا چک برگشتی دارد، اولویت ۳ می‌گیرد. «ارتقا به اولویت ۱» دستی همچنان ممکن است.</span></span>
              <Ban size={20} className="ts-noplan-ic" aria-hidden="true" />
            </div>
            {noPlan ? <div className="ts-q ts-noplan-why"><label htmlFor="ts-noplan-note">چرا؟ <span className="ts-muted small">اختیاری، کوتاه</span></label>
              <input id="ts-noplan-note" className="ts-inp" value={d.noPlanNote} maxLength={NO_PLAN_NOTE_MAX} onChange={(e) => set({ noPlanNote: e.target.value.slice(0, NO_PLAN_NOTE_MAX) })}
                placeholder="مثلاً: سقف طرح‌ها کمتر از مبلغ درخواستی است" data-testid="ts-noplan-note" />
              <span className="ts-muted small" data-testid="ts-noplan-count">{fa(d.noPlanNote.trim().length)} از {fa(NO_PLAN_NOTE_MAX)} نویسه</span></div> : null}
          </div>
        </>}
    </>;
  } else {
    body = <>
      {edit && (noPlan || (planList && !planList.some((p) => p.status !== 'no'))) ? <div className="ts-alert warn" role="note" data-testid="ts-edit-noplan-warn">
        <AlertTriangle size={18} /> با این جواب‌ها طرح مناسبی انتخاب نشده. ذخیره ممکن است؛ فقط حواست باشد.</div> : null}
      {edit && !edit.canSend && edit.sendBlockedReason ? <div className="ts-alert info" role="note" data-testid="ts-edit-send-blocked"><Info size={18} /> {edit.sendBlockedReason}</div> : null}
      <div className="ts-script">{answered ? <><b>قبل از قطع تماس بپرس:</b><p>«برای شما چقدر فوریه؟»</p></>
        : <><b>قبل از قطع تماس:</b><p>یادداشت کامل بنویس تا مشتری مجبور نشه همه‌چیز رو دوباره تعریف کنه.</p></>}</div>
      <div className="ts-q"><label htmlFor="ts-note">یادداشت تماس <span className="req">*</span></label>
        <VoiceNoteButton value={d.note} onChange={(note) => set({ note: note.slice(0, 4000) })} field="first_call_note" maxLength={4000} testId="ts-note-voice"><textarea id="ts-note" className={`ts-inp ts-note${errors.note ? ' bad' : ''}`} rows={4} value={d.note} onChange={(e) => set({ note: e.target.value.slice(0, 4000) })} placeholder="مثلاً: شغل، مبلغ، ضامن، بهترین ساعت تماس…" aria-invalid={Boolean(errors.note)} aria-describedby="ts-note-meta" data-testid="ts-note" /></VoiceNoteButton>
        <div className="ts-note-meta" id="ts-note-meta"><span className={errors.note ? 'bad' : ''} role={errors.note ? 'alert' : undefined} data-testid="ts-note-msg">{errors.note ? callNoteMinMessage(noteMin) : `حداقل ${fa(noteMin)} نویسه`}</span><span className={noteLen < noteMin ? (errors.note ? 'bad' : '') : 'okc'} aria-live="polite" data-testid="ts-note-count">{fa(noteLen)} / {fa(noteMin)}</span></div></div>
      {answered ? <div className="ts-answers" data-testid="ts-picked"><span className="ts-muted small">طرح‌های انتخاب‌شده:</span>
        {noPlan ? <NoPlanChip testId="ts-picked-noplan" /> : selectedPlans.length ? selectedPlans.map((p) => <PlanChip key={p.planId} plan={{ name: p.planName, status: p.status === 'depends' ? 'depends' : 'fit', reasons: p.reasons.filter((r) => r.kind === 'unknown').map(planReasonText) }} />)
          : <span className="ts-muted small">هیچ طرحی انتخاب نشد</span>}
        <button type="button" className="ts-link" onClick={() => go(5)} data-testid="ts-change-plans">تغییر</button></div> : null}
      {answered ? <fieldset className={pfCls('urgency')}><legend>فوریت <span className="req">*</span> <span className="ts-muted small">آخرین سؤال فرم</span>{pfMark('urgency')}</legend>
        <Chips name="urgency" list={URGENCY} value={d.urgency} onChange={(v) => set({ urgency: v })} />{err('urgency')}</fieldset> : null}
      {!answered && summary.length ? <div className="ts-summary"><span className="ts-muted">خلاصه:</span>{summary.map((s, i) => <span key={i} className="ts-pill">{s}</span>)}</div> : null}
      {edit ? <p className="ts-muted small" data-testid="ts-edit-hint">«فقط ذخیره» تماس جدیدی ثبت نمی‌کند. «ذخیره و ارسال به کارشناس فروش» همان «ارتقا به اولویت ۱» است.</p> : null}
      {serverError ? <div className="ts-alert" role="alert"><AlertCircle size={18} /> {serverError}</div> : null}
      {tc ? <TransferCheckBox tc={tc.check} pending={pending} onOverride={(r) => { void (tc.edit ? submitEdit(tc.send, r) : submit(r)); }} /> : null}
    </>;
  }

  const lastStep = d.step === steps[steps.length - 1];
  const nextLabel = 'بعدی';
  const missing = strict && !done && !edit ? validate(d.step) : {};
  const blocked = Object.keys(missing).length > 0;
  const shown = Object.keys(errors).filter((k) => errors[k]);
  // release 69 (Armita live-59 #6): field errors stay inline; at most ONE short counter in the footer next to the button
  // (never above the content). Tapping it scrolls/focuses the first missing field.
  const jumpToFirst = () => { const b = bodyRef.current; if (!b) return; const k = shown[0];
    const el = (k ? b.querySelector<HTMLElement>(`#ts-err-${k}`) : null) ?? b.querySelector<HTMLElement>('[aria-invalid="true"]') ?? b.querySelector<HTMLElement>('.ts-err');
    if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const f = el.matches('input,textarea,select,button,[tabindex]') ? el : el.closest('.ts-q, fieldset, div')?.querySelector<HTMLElement>('input,textarea,select,button,[tabindex]:not([tabindex="-1"])');
    f?.focus({ preventScroll: true }); };
  const strictSummary = (strict || file) && shown.length ? <button type="button" className="ts-fcount" onClick={jumpToFirst} aria-label={`${shown.map((k) => STRICT_LABELS[k] ?? k).join('، ')} — برو به اولین مورد`} data-testid="ts-missing">{shown.length === 1 ? 'یک مورد مانده' : shown.length === 2 ? 'دو مورد مانده' : `${fa(shown.length)} مورد مانده`}</button> : null;
  return <div className="ts-layer" dir="rtl">
    <div className="ts-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={dialogRef} className={`ts-wz${strict || file ? ' strict' : ''}${file ? ' ffm' : ''}`} role="dialog" aria-modal="true" aria-labelledby="ts-wz-title" tabIndex={-1} data-testid="ts-simple-form">
      <div className="ts-wz-head">
        <div className="ts-wz-who">
          {eyebrow ? <p className="ts-eyebrow" data-testid="ts-eyebrow">{eyebrow}</p> : null}
          <h2 id="ts-wz-title">{file ? (file.complete ? 'ویرایش پرونده مشتری' : 'تکمیل پرونده مشتری') : edit ? 'ویرایش خلاصه‌ی تماس اول' : 'فرم تماس'} — <CustomerName id={customer.id} name={customer.name} badgeTestId="ts-wz-customer-id" /></h2>
          <div className="sub"><span className="ltr" dir="ltr" data-testid="ts-phone">{fa(strict || file ? maskPh(customer.phone) : customer.phone)}</span>
            {strict || file ? null : <button type="button" className="ts-copy" onClick={copyPhone} aria-label={`کپی شماره‌ی ${customer.name}`} data-testid="ts-copy-phone"><Copy size={13} /> {copied ? 'کپی شد' : 'کپی'}</button>}
            <span className="ts-badge gray">{prio}</span> <span className="ts-badge">نسخه‌ی ساده</span></div>
        </div>
        <button type="button" className="ts-ib" onClick={onClose} aria-label="بستن" data-testid="ts-close"><X size={22} /></button>
      </div>
      {reopenNotice && !done ? <div className="ts-reopen" role="status" data-testid="ts-reopen"><b>اطلاعات تماس اول این مشتری هنوز ثبت نشده</b>
        <small>مقادیر قبلی نگه داشته شده · کار این مشتری در لیست امروز باز است</small></div> : null}
      {file ? <p className="fmh" data-testid="ff-head">همان سؤال‌های فرم تماس اول · {file.answers ? 'پاسخ‌های قبلی پر شده‌اند' : 'هنوز پاسخی ثبت نشده'}{Object.keys(fileMissing).length ? <> · <span className="mc">{fa(Object.keys(fileMissing).length)} مورد مانده</span></> : null}</p> : <div className="ts-progress">
        <div className="row"><b>{done ? 'نتیجه' : titles[d.step]}</b><span className="ts-muted" data-testid="ts-step-of">{editResult ? 'ذخیره شد' : result ? 'ثبت شد' : `مرحله ${fa(idx)} از ${fa(total)}`}</span></div>
        <div className="bars" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} className={done || i < idx ? 'on' : ''} />)}</div>
      </div>}
      <div className="ts-wz-body" ref={bodyRef}>{onChangeCustomer && !done ? <div className="ts-picked-customer" data-testid="ts-picked-customer"><div><b><CustomerName id={customer.id} name={customer.name} badgeTestId="ts-picked-customer-id" /></b><span className="ts-muted"> | {prio}</span></div><button type="button" onClick={onChangeCustomer} data-testid="ts-change-customer"><ChevronRight size={16} aria-hidden="true" /> تغییر مشتری</button></div> : null}{body}</div>
      {copyToast ? <div className={`ts-toast${copied ? ' ok' : ''}`} role="status" data-testid="ts-copy-toast">{copyToast}</div> : null}
      <div className="ts-wz-foot">
        {strictSummary ? <div className="ts-fcount-row" role="status">{strictSummary}</div> : null}
        {file ? <div className="ts-two grow">
          <button type="button" className="ts-ghost narrow" onClick={onClose} data-testid="ff-cancel">انصراف</button>
          <button type="button" className="ts-primary" onClick={() => void submitFile()} disabled={pending} aria-disabled={Object.keys(fileMissing).length > 0 || undefined} data-testid="ff-save"><Check size={18} /> {pending ? 'در حال ذخیره…' : 'ذخیره‌ی پرونده'}</button>
        </div> : editResult ? <div className="ts-two">
          <button type="button" className="ts-primary" onClick={onClose} data-testid="ts-edit-close">بازگشت به پرونده</button>
        </div> : result && returnLabel ? <div className="ts-two">
          <button type="button" className="ts-primary" onClick={onNext} autoFocus data-testid="ts-return-current">{returnLabel}</button>
        </div> : result ? <div className="ts-two">
          <button type="button" className="ts-ghost" onClick={onClose} data-testid="ts-open-file">پرونده مشتری</button>
          <button type="button" className="ts-primary" onClick={onNext} data-testid="ts-next-customer">مشتری بعدی صف</button>
        </div> : <div className="ts-two grow">
          {idx > 1 ? <button type="button" className="ts-ghost narrow" onClick={back}><ChevronRight size={18} /> قبلی</button> : <button type="button" className="ts-ghost narrow" onClick={onClose}>بستن</button>}
          {d.step === 5 ? <span className="ts-foot-note" data-testid="ts-selected-count">{noPlan ? 'هیچ طرحی نمی‌خوره' : d.selected.length ? `${fa(selectedPlans.length || d.selected.length)} طرح انتخاب شد` : 'انتخاب اختیاری است'}</span> : null}
          {lastStep && edit ? <>
            <button type="button" className="ts-ghost" onClick={() => void submitEdit(false)} disabled={pending} data-testid="ts-edit-save">{pending ? 'در حال ذخیره…' : 'فقط ذخیره'}</button>
            <button type="button" className="ts-primary" onClick={() => void submitEdit(true)} disabled={pending || !edit.canSend}
              title={!edit.canSend ? edit.sendBlockedReason ?? undefined : undefined} aria-describedby={!edit.canSend ? 'ts-edit-send-why' : undefined} data-testid="ts-edit-send">
              <Check size={18} /> ذخیره و ارسال به کارشناس فروش</button>
            {!edit.canSend ? <span id="ts-edit-send-why" className="sr-only">{edit.sendBlockedReason}</span> : null}
          </> : lastStep ? <button type="button" className="ts-primary" onClick={() => void submit()} disabled={pending} aria-disabled={blocked || undefined} data-testid="ts-submit"><Check size={18} /> {pending ? 'در حال ثبت…' : d.callResult === 'no_answer' ? 'ثبت تماس بی‌پاسخ' : 'ثبت و تعیین اولویت'}</button>
            : <button type="button" className={`ts-primary${d.step === 1 && !d.manual ? ' dis' : ''}`} onClick={next} disabled={d.step === 5 && !planList} aria-disabled={blocked || (d.step === 1 && !d.manual) || undefined} data-testid="ts-next">{nextLabel} <ChevronLeft size={18} /></button>}
        </div>}
        {!done && !edit && !file ? <p className="ts-muted center small">پیش‌نویس روی همین دستگاه نگه داشته می‌شود</p> : null}
      </div>
      {cfm ? <div className="ts-cfx"><section className="ts-cfm" role="alertdialog" aria-modal="true" aria-labelledby="ts-cfm-t" data-testid="ts-close-confirm">
        <h2 id="ts-cfm-t">بستن بدون ثبت تماس؟</h2>
        <p>{closeConfirmBody ?? 'مشتری ثبت شده، ولی این تماس و اطلاعات تماس اول ثبت نمی‌شود. تا ثبت فرم، با باز کردن پرونده‌ی این مشتری یا تماس بعدی، همین فرم دوباره باز می‌شود و کارش در لیست امروز می‌ماند.'}</p>
        <div className="ts-cfm-a"><button type="button" className="ts-primary" autoFocus onClick={() => setCfm(false)} data-testid="ts-cfm-stay">ادامهٔ فرم</button>
          <button type="button" className="ts-ghost" onClick={() => { setCfm(false); onCloseRaw(); }} data-testid="ts-cfm-discard">بستن بدون ثبت</button></div>
      </section></div> : null}
    </div>
  </div>;
}
