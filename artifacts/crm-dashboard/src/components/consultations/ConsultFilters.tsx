// crm-consult-filters: search/filter bar, «فیلترهای بیشتر», removable chips, summary bar and admin CSV for «مشاوره‌ها».
// Built on Armita's consult-list bar (screens/crm-plans-consult-refactor 20-consult-list): search · همه/امروز/این هفته · کارشناس.
// Desktop (≥981px) opens the extra filters inline; mobile opens the same fields in a bottom sheet.
import { CalendarDays, Check, ChevronDown, Download, SlidersHorizontal, X, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { GradePickerMulti } from '@/components/grade/GradePicker';
import { gradeText } from '@/lib/credit-grade';
import { useDialogFocus } from '@/pages/customers-ui';
import {
  amountBad, CASE_LABEL, CHEQUE_LABEL, EMPTY_FILTERS, fa, JOB_ORDER, JOB_SHORT, MILITARY_LABEL, pct, periodBounds, PERIOD_LABEL, PLAN_RESULT_LABEL, PLAN_TYPE_LABEL,
  type ConsultFilterState, type ConsultReport, type Period,
} from '@/lib/consult-report';
import '@/pages/calls.css';
import './consult-filters.css';

type Update = (patch: Partial<ConsultFilterState>) => void;
type Ctx = { f: ConsultFilterState; update: Update; report?: ConsultReport; salespersons: { id: number; name: string }[]; scoped: boolean; canPlanType: boolean };

/** Every active filter as a removable chip (the period «همه» and an empty search are not filters). */
export function activeChips({ f, report, salespersons }: Pick<Ctx, 'f' | 'report' | 'salespersons'>): { key: string; label: string; clear: Partial<ConsultFilterState> }[] {
  const out: { key: string; label: string; clear: Partial<ConsultFilterState> }[] = [];
  const grades = (xs: string[]) => xs.map((g) => gradeText(g)).join('، ');
  if (f.search.trim()) out.push({ key: 'search', label: `جست‌وجو: «${f.search.trim()}»`, clear: { search: '' } });
  if (f.period !== 'all') out.push({ key: 'period', label: f.period === 'range' ? `تاریخ: ${f.from || '…'} تا ${f.to || '…'}` : `تاریخ: ${PERIOD_LABEL[f.period]}`, clear: { period: 'all', from: '', to: '' } });
  for (const id of f.salespersonIds) out.push({ key: `sp${id}`, label: `کارشناس: ${salespersons.find((s) => s.id === id)?.name ?? `#${fa(id)}`}`, clear: { salespersonIds: f.salespersonIds.filter((x) => x !== id) } });
  if (f.planResult) out.push({ key: 'planResult', label: `نتیجه: ${PLAN_RESULT_LABEL[f.planResult]}`, clear: { planResult: '' } });
  if (f.planId) out.push({ key: 'planId', label: `طرح مناسب: ${report?.plans.find((p) => String(p.id) === f.planId)?.name ?? `#${fa(Number(f.planId))}`}`, clear: { planId: '' } });
  if (f.planType) out.push({ key: 'planType', label: `نوع طرح: ${PLAN_TYPE_LABEL[f.planType]}`, clear: { planType: '' } });
  if (f.grades.length) out.push({ key: 'grades', label: `رتبه‌ی متقاضی: ${grades(f.grades)}`, clear: { grades: [] } });
  if (f.guarantor) out.push({ key: 'guarantor', label: f.guarantor === 'yes' ? 'ضامن دارد' : 'ضامن ندارد', clear: { guarantor: '' } });
  if (f.guarantorGrades.length) out.push({ key: 'gGrades', label: `رتبه‌ی ضامن: ${grades(f.guarantorGrades)}`, clear: { guarantorGrades: [] } });
  if (f.jobs.length) out.push({ key: 'jobs', label: `شغل متقاضی: ${f.jobs.map((j) => JOB_SHORT[j]).join('، ')}`, clear: { jobs: [] } });
  if (f.guarantorJobs.length) out.push({ key: 'gJobs', label: `شغل ضامن: ${f.guarantorJobs.map((j) => JOB_SHORT[j]).join('، ')}`, clear: { guarantorJobs: [] } });
  if (f.cheque) out.push({ key: 'cheque', label: CHEQUE_LABEL[f.cheque], clear: { cheque: '' } });
  if (f.military) out.push({ key: 'military', label: `پایان خدمت: ${MILITARY_LABEL[f.military]}`, clear: { military: '' } });
  if (f.city.trim()) out.push({ key: 'city', label: `شهر: ${f.city.trim()}`, clear: { city: '' } });
  if (f.amountMin.trim() || f.amountMax.trim()) out.push({ key: 'amount', label: `مبلغ: ${f.amountMin.trim() || '…'} تا ${f.amountMax.trim() || '…'} میلیون`, clear: { amountMin: '', amountMax: '' } });
  if (f.caseStatus) out.push({ key: 'case', label: CASE_LABEL[f.caseStatus], clear: { caseStatus: '' } });
  return out;
}
/** Filters beyond the top bar (search · period · کارشناس), for the «فیلترهای بیشتر» badge. */
const moreCount = (f: ConsultFilterState) => [f.planResult, f.planId, f.planType, f.guarantor, f.cheque, f.military, f.city.trim(), f.caseStatus, f.amountMin.trim() || f.amountMax.trim()].filter(Boolean).length
  + [f.grades, f.guarantorGrades, f.jobs, f.guarantorJobs].filter((x) => x.length).length;

function Choice<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T | ''; options: [T, string][]; onChange: (v: T | '') => void; testId: string }) {
  return <div className="csf-g" role="group" aria-label={label}><span className="csf-gl">{label}</span><div className="csf-chips">
    <button type="button" className="csf-ch" aria-pressed={value === ''} onClick={() => onChange('')} data-testid={`${testId}-all`}>همه</button>
    {options.map(([v, l]) => <button key={v} type="button" className="csf-ch" aria-pressed={value === v} onClick={() => onChange(value === v ? '' : v)} data-testid={`${testId}-${v}`}>{l}</button>)}
  </div></div>;
}
function Multi({ label, values, options, onChange, testId }: { label: string; values: string[]; options: [string, string][]; onChange: (v: string[]) => void; testId: string }) {
  return <div className="csf-g" role="group" aria-label={label}><span className="csf-gl">{label}{values.length ? <button type="button" className="csf-lnk" onClick={() => onChange([])}>پاک کردن</button> : null}</span><div className="csf-chips">
    {options.map(([v, l]) => { const on = values.includes(v); return <button key={v} type="button" className="csf-ch" aria-pressed={on} onClick={() => onChange(on ? values.filter((x) => x !== v) : [...values, v])} data-testid={`${testId}-${v}`}>{on ? <Check size={15} aria-hidden="true" /> : null}{l}</button>; })}
  </div></div>;
}

export function DateRangeFields({ f, update, idp }: { f: ConsultFilterState; update: Update; idp: string }) {
  const bad = f.period === 'range' && periodBounds(f).bad;
  return <><div className="csf-rg">
    <label>از تاریخ<PersianDatePicker value={f.from} onChange={(v) => update({ period: 'range', from: v })} placeholder="از…" testId={`${idp}-from`} /></label>
    <label>تا تاریخ<PersianDatePicker value={f.to} onChange={(v) => update({ period: 'range', to: v })} placeholder="تا…" testId={`${idp}-to`} minValue={f.from || undefined} /></label>
  </div>{bad ? <p role="alert" className="clx-err">بازه‌ی تاریخ درست نیست؛ «از» باید قبل از «تا» باشد.</p> : null}</>;
}

/** The extra filters, shared by the desktop panel and the mobile sheet. */
export function MoreFilterFields({ f, update, report, canPlanType }: Ctx) {
  const plans = report?.plans ?? [];
  const jobOpts = JOB_ORDER.map((j) => [j, JOB_SHORT[j]] as [string, string]);
  return <div className="csf-more">
    <section className="csf-sec"><h3>طرح‌ها</h3>
      <Choice label="نتیجه‌ی طرح‌ها" value={f.planResult} options={Object.entries(PLAN_RESULT_LABEL) as [ConsultFilterState['planResult'] & string, string][]} onChange={(v) => update({ planResult: v })} testId="csf-result" />
      <div className="csf-g"><label className="csf-gl" htmlFor="csf-plan">طرح مشخص (مناسب بوده)</label>
        <select id="csf-plan" className="csf-in" value={f.planId} onChange={(e) => update({ planId: e.target.value })} data-testid="csf-plan">
          <option value="">همه‌ی طرح‌ها</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (غیرفعال)'}</option>)}
        </select></div>
      {canPlanType ? <Choice label="نوع طرح (فقط مدیر)" value={f.planType} options={Object.entries(PLAN_TYPE_LABEL) as ['score' | 'goods', string][]} onChange={(v) => update({ planType: v })} testId="csf-ptype" /> : null}
      <Choice label="وضعیت بعدی" value={f.caseStatus} options={Object.entries(CASE_LABEL) as ['opened' | 'not', string][]} onChange={(v) => update({ caseStatus: v })} testId="csf-case" />
    </section>
    <section className="csf-sec"><h3>متقاضی</h3>
      <GradePickerMulti label="رتبه‌ی متقاضی" values={f.grades} onChange={(v) => update({ grades: v })} testId="csf-grades" />
      <Multi label="شغل متقاضی" values={f.jobs} options={jobOpts} onChange={(v) => update({ jobs: v })} testId="csf-job" />
      <Choice label="چک" value={f.cheque} options={Object.entries(CHEQUE_LABEL) as ['has' | 'no' | 'bounced', string][]} onChange={(v) => update({ cheque: v })} testId="csf-cheque" />
      <Choice label="پایان خدمت" value={f.military} options={Object.entries(MILITARY_LABEL) as [NonNullable<ConsultFilterState['military']> & string, string][]} onChange={(v) => update({ military: v })} testId="csf-mil" />
    </section>
    <section className="csf-sec"><h3>ضامن</h3>
      <Choice label="ضامن" value={f.guarantor} options={[['yes', 'دارد'], ['no', 'ندارد']]} onChange={(v) => update({ guarantor: v, ...(v === 'no' ? { guarantorGrades: [], guarantorJobs: [] } : {}) })} testId="csf-guar" />
      {f.guarantor !== 'no' ? <>
        <GradePickerMulti label="رتبه‌ی ضامن" values={f.guarantorGrades} onChange={(v) => update({ guarantorGrades: v })} testId="csf-ggrades" />
        <Multi label="شغل ضامن" values={f.guarantorJobs} options={jobOpts} onChange={(v) => update({ guarantorJobs: v })} testId="csf-gjob" />
      </> : null}
    </section>
    <section className="csf-sec"><h3>شهر و مبلغ</h3>
      <div className="csf-g"><label className="csf-gl" htmlFor="csf-city">شهر</label>
        <input id="csf-city" className="csf-in" value={f.city} maxLength={60} onChange={(e) => update({ city: e.target.value })} placeholder="مثلاً تهران" data-testid="csf-city" /></div>
      <div className="csf-g" role="group" aria-label="مبلغ درخواستی (میلیون تومان)"><span className="csf-gl">مبلغ درخواستی <small>(میلیون تومان؛ فقط مشاوره‌هایی که مبلغ دارند)</small></span>
        <div className="csf-rg">
          <label>از<input className="csf-in" inputMode="numeric" value={f.amountMin} onChange={(e) => update({ amountMin: e.target.value })} placeholder="۱۰۰" data-testid="csf-amin" /></label>
          <label>تا<input className="csf-in" inputMode="numeric" value={f.amountMax} onChange={(e) => update({ amountMax: e.target.value })} placeholder="۵۰۰" data-testid="csf-amax" /></label>
        </div>{amountBad(f) ? <p role="alert" className="clx-err">مبلغ را با عدد وارد کنید؛ «از» نباید از «تا» بیشتر باشد.</p> : null}</div>
    </section>
  </div>;
}

function SalespersonPicker({ f, update, salespersons }: Pick<Ctx, 'f' | 'update' | 'salespersons'>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const names = f.salespersonIds.map((id) => salespersons.find((s) => s.id === id)?.name).filter(Boolean);
  const value = !names.length ? 'همه' : names.length === 1 ? names[0] : `${fa(names.length)} نفر`;
  return <div className="clx-rel" ref={ref}>
    <button type="button" className="csf-sp" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} data-testid="csf-salesperson"><b>کارشناس:</b> {value} <ChevronDown size={16} aria-hidden="true" /></button>
    {open ? <div className="clx-dd csf-dd" role="dialog" aria-label="فیلتر کارشناس">
      <button type="button" aria-pressed={!f.salespersonIds.length} onClick={() => update({ salespersonIds: [] })}>همه‌ی کارشناسان</button>
      {salespersons.map((s) => { const on = f.salespersonIds.includes(s.id); return <button key={s.id} type="button" aria-pressed={on} onClick={() => update({ salespersonIds: on ? f.salespersonIds.filter((x) => x !== s.id) : [...f.salespersonIds, s.id] })} data-testid={`csf-sp-${s.id}`}>
        <span className={`csf-cb${on ? ' on' : ''}`} aria-hidden="true">{on ? <Check size={13} /> : null}</span>{s.name}</button>; })}
      <div className="ft"><span className="csf-muted">چند کارشناس را می‌توانید با هم انتخاب کنید.</span><button type="button" className="clx-gbtn" onClick={() => setOpen(false)}>بستن</button></div>
    </div> : null}
  </div>;
}

function PeriodSeg({ f, update, onRange }: { f: ConsultFilterState; update: Update; onRange: () => void }) {
  return <div className="clx-pseg csf-pseg" role="group" aria-label="تاریخ ثبت">
    {(['all', 'today', 'week', 'month'] as Period[]).map((p) => <button key={p} type="button" aria-pressed={f.period === p} onClick={() => update({ period: p, from: '', to: '' })} data-testid={`csf-period-${p}`}>{PERIOD_LABEL[p]}</button>)}
    <button type="button" aria-pressed={f.period === 'range'} onClick={onRange} data-testid="csf-period-range"><CalendarDays size={16} aria-hidden="true" /> بازه</button>
  </div>;
}

export function SummaryBar({ report, loading }: { report?: ConsultReport; loading: boolean }) {
  const s = report?.summary;
  const tile = (label: string, n: number | undefined, tone: string, testId: string, showPct = true) => <div className={`csf-st ${tone}`} data-testid={testId}>
    <span>{label}</span><strong>{n == null ? '…' : fa(n)}</strong>{showPct ? <small>{s && n != null ? pct(n, s.total) : ''}</small> : <small>نتیجه‌ی فیلتر</small>}</div>;
  return <div className="csf-sum" aria-busy={loading} aria-label="خلاصه‌ی نتیجه">
    {tile('کل مشاوره‌ها', s?.total, 'tot', 'csf-sum-total', false)}
    {tile('با طرح مناسب', s?.withPlan, 'ok', 'csf-sum-plan')}
    {tile('فقط باید بررسی شود', s?.reviewOnly, 'rv', 'csf-sum-review')}
    {tile('بدون طرح مناسب', s?.noPlan, 'no', 'csf-sum-none')}
    {tile('پرونده تشکیل شد', s?.cases, 'cs', 'csf-sum-cases')}
  </div>;
}

function ChipsRow({ chips, update, onClear, extra }: { chips: ReturnType<typeof activeChips>; update: Update; onClear: () => void; extra?: ReactNode }) {
  if (!chips.length && !extra) return null;
  return <div className="csf-chiprow" data-testid="csf-chips">
    {chips.map((c) => <span key={c.key} className="csf-chip">{c.label}<button type="button" onClick={() => update(c.clear)} aria-label={`حذف فیلتر ${c.label}`} data-testid={`csf-chip-x-${c.key}`}><X size={14} /></button></span>)}
    {chips.length ? <button type="button" className="csf-clear" onClick={onClear} data-testid="csf-clear">پاک کردن فیلترها</button> : null}
    {extra}
  </div>;
}

function FilterSheet({ ctx, onClose, onClear, total }: { ctx: Ctx; onClose: () => void; onClear: () => void; total: number | undefined }) {
  const ref = useDialogFocus(onClose);
  const { f, update } = ctx;
  return <>
    <div className="clx-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="clx-msh csf-msh" role="dialog" aria-modal="true" aria-labelledby="csf-msh-t" tabIndex={-1} dir="rtl" data-testid="csf-sheet">
      <div className="grab" aria-hidden="true" />
      <div className="hd"><h2 id="csf-msh-t">فیلتر مشاوره‌ها</h2><button type="button" className="csf-xb" onClick={onClose} aria-label="بستن"><X size={22} /></button></div>
      <section className="csf-sec"><h3>تاریخ ثبت</h3><div className="csf-chips">
        {(['all', 'today', 'week', 'month', 'range'] as Period[]).map((p) => <button key={p} type="button" className="csf-ch" aria-pressed={f.period === p} onClick={() => update(p === 'range' ? { period: p } : { period: p, from: '', to: '' })} data-testid={`csf-m-period-${p}`}>{PERIOD_LABEL[p]}</button>)}
      </div>{f.period === 'range' ? <DateRangeFields f={f} update={update} idp="csf-m" /> : null}</section>
      {!ctx.scoped && ctx.salespersons.length ? <section className="csf-sec"><Multi label="کارشناس" values={f.salespersonIds.map(String)} options={ctx.salespersons.map((s) => [String(s.id), s.name])} onChange={(v) => update({ salespersonIds: v.map(Number) })} testId="csf-m-sp" /></section> : null}
      <MoreFilterFields {...ctx} />
      <div className="sf"><button type="button" className="clx-gbtn" onClick={onClear}>پاک کردن</button><button type="button" className="clx-pbtn" onClick={onClose} data-testid="csf-sheet-show">نمایش {total == null ? '…' : fa(total)} مشاوره</button></div>
    </div>
  </>;
}

export function ConsultFilterBar({ ctx, desktop, searchText, setSearchText, onClear, loading, exporting, exportError, onExport }: {
  ctx: Ctx; desktop: boolean; searchText: string; setSearchText: (v: string) => void; onClear: () => void; loading: boolean;
  exporting: boolean; exportError: string; onExport: () => void;
}) {
  const { f, update, report } = ctx;
  const [panel, setPanel] = useState(() => moreCount(f) > 0 || f.period === 'range');
  const [sheet, setSheet] = useState(false);
  const chips = activeChips(ctx);
  const more = moreCount(f);
  const total = report?.total;
  const exportBtn = report?.canExport ? <button type="button" className="clx-gbtn csf-exp" disabled={exporting || loading || !total} onClick={onExport} data-testid="csf-export"><Download size={16} aria-hidden="true" />{exporting ? 'در حال آماده‌سازی…' : 'خروجی اکسل (CSV)'}</button> : null;
  const searchBox = <label className="csf-search"><Search size={19} aria-hidden="true" />
    <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="نام، موبایل یا شناسه‌ی مشتری (#۱۲۳۴)" aria-label="جست‌وجو در مشاوره‌ها" data-testid="input-search-consultations" />
    {searchText ? <button type="button" className="x" onClick={() => setSearchText('')} aria-label="پاک کردن جست‌وجو"><X size={16} /></button> : null}</label>;
  if (!desktop) return <div className="csf-bar m" data-testid="csf-bar">
    {searchBox}
    <div className="csf-mrow">
      <button type="button" className="csf-mbtn" onClick={() => setSheet(true)} aria-haspopup="dialog" data-testid="csf-open-sheet"><SlidersHorizontal size={18} aria-hidden="true" /> فیلترها{chips.length ? <span className="cnt">{fa(chips.length - (f.search.trim() ? 1 : 0))}</span> : null}</button>
      <span className="csf-mper">{f.period === 'range' ? 'بازه‌ی دلخواه' : PERIOD_LABEL[f.period]}</span>
    </div>
    <SummaryBar report={report} loading={loading} />
    <ChipsRow chips={chips} update={update} onClear={onClear} />
    {sheet ? <FilterSheet ctx={ctx} onClose={() => setSheet(false)} onClear={onClear} total={total} /> : null}
  </div>;
  return <div className="csf-bar" data-testid="csf-bar">
    <div className="csf-row">
      {searchBox}
      <PeriodSeg f={f} update={update} onRange={() => { update({ period: 'range' }); setPanel(true); }} />
      {!ctx.scoped && ctx.salespersons.length ? <SalespersonPicker f={f} update={update} salespersons={ctx.salespersons} /> : <span className="csf-sp static" data-testid="csf-salesperson-own"><b>کارشناس:</b> مشاوره‌های من</span>}
      <button type="button" className="csf-morebtn" aria-expanded={panel} aria-controls="csf-panel" onClick={() => setPanel(!panel)} data-testid="csf-more"><SlidersHorizontal size={17} aria-hidden="true" /> فیلترهای بیشتر{more ? <span className="cnt">{fa(more)}</span> : null}<ChevronDown size={16} className={panel ? 'up' : ''} aria-hidden="true" /></button>
    </div>
    {panel ? <div id="csf-panel" className="csf-panel" data-testid="csf-panel">
      {f.period === 'range' ? <section className="csf-sec"><h3>بازه‌ی تاریخ ثبت</h3><DateRangeFields f={f} update={update} idp="csf" /></section> : null}
      <MoreFilterFields {...ctx} />
    </div> : null}
    <SummaryBar report={report} loading={loading} />
    <ChipsRow chips={chips} update={update} onClear={onClear} extra={exportBtn} />
    {exportError ? <p role="alert" className="clx-err">{exportError}</p> : null}
  </div>;
}
export { EMPTY_FILTERS };
