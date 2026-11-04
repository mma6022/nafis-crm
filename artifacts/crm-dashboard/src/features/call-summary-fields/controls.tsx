/** Shared «موارد اجباری» controls (design v1.2 cs.js: rank chips, seg, docs checkboxes, read-only plan). */
import { AlertTriangle, Check, FileText, Lock, Pencil, Play, X } from 'lucide-react';
import { CS_DOCS, DOC3, DOC_LABEL, RET, YN, docsStatus, fa, mmssAt, type CsKey, type CsState } from './api';

const TAG: Record<CsState, [string, typeof Check, string]> = {
  a: ['b', FileText, 'از متن تماس'], c: ['s', Check, 'تأییدشده'], u: ['g', AlertTriangle, 'نامشخص؛ بررسی کن'], m: ['r', X, 'پرسیده نشد'],
  e: ['s', Pencil, 'اصلاح کارشناس'], x: ['', Pencil, 'دستی پر کن'], n: ['g', X, 'مشتری جواب نداد'],
};
export function CsTag({ s, k }: { s: CsState; k?: string }) { const [c, I, t] = TAG[s]; return <span className={`chip ${c} mtag`} data-testid={k ? `cs-tag-${k}` : undefined} data-state={s}><I className="i" aria-hidden="true" />{t}</span>; }
export function CsJump({ at, current, onJump, k }: { at: number; current?: boolean; onJump?: () => void; k: string }) {
  const t = mmssAt(at);
  if (!onJump) return <span className="jmp" data-testid={`cs-at-${k}`}><Play className="i" aria-hidden="true" /><bdi dir="ltr">{t}</bdi></span>;
  return <button type="button" className="jmp" aria-label={`پرش به لحظه‌ی ${t} در متن تماس`} aria-current={current ? 'true' : undefined} onClick={onJump} data-testid={`cs-jmp-${k}`}><Play className="i" aria-hidden="true" /><bdi dir="ltr">{t}</bdi></button>;
}

const LET = ['A', 'B', 'C', 'D', 'E'];
/** Letter chips A–E, «نمی‌دانم», «ضامن ندارد» (guarantor); an optional sub-grade row (1–3) once a letter is picked. */
export function CsRank({ name, value, onChange, guarantor, k }: { name: string; value: string | null; onChange: (v: string) => void; guarantor?: boolean; k: string }) {
  const letter = value && /^[A-E]/.test(value) ? value[0] : null;
  return <div>
    <div className="rk" role="radiogroup" aria-label={name} data-testid={`cs-rk-${k}`}>
      {LET.map((r) => <button key={r} type="button" role="radio" aria-checked={letter === r} dir="ltr" onClick={() => onChange(r)} data-testid={`cs-rk-${k}-${r}`}>{r}</button>)}
      <button type="button" role="radio" aria-checked={value === 'unknown'} className="w" onClick={() => onChange('unknown')} data-testid={`cs-rk-${k}-unknown`}>نمی‌دانم</button>
      {guarantor ? <button type="button" role="radio" aria-checked={value === 'none'} className="w" onClick={() => onChange('none')} data-testid={`cs-rk-${k}-none`}>ضامن ندارد</button> : null}
    </div>
    {letter ? <div className="rk sub" role="radiogroup" aria-label={`${name}، زیررتبه (اختیاری)`}>
      <small className="muted">زیررتبه (اختیاری)</small>
      {['1', '2', '3'].map((d) => <button key={d} type="button" role="radio" aria-checked={value === letter + d} dir="ltr" onClick={() => onChange(value === letter + d ? letter : letter + d)} data-testid={`cs-rk-${k}-${letter}${d}`}>{letter}{d}</button>)}
    </div> : null}
  </div>;
}
export function CsSeg({ name, opts, value, onChange, k }: { name: string; opts: [string, string][]; value: string | null; onChange: (v: string) => void; k: string }) {
  return <div className="seg" role="radiogroup" aria-label={name} data-testid={`cs-seg-${k}`}>{opts.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} aria-selected={value === v} onClick={() => onChange(v)} data-testid={`cs-seg-${k}-${v}`}>{l}</button>)}</div>;
}
export function DocsChip({ d }: { d: readonly string[] }) { const s = docsStatus(d); return <span className={`chip ${s === 'all' ? 's' : s === 'partial' ? 'g' : 'r'} dst`} title="خودکار از تیک‌ها" data-testid="cs-dst"><Lock className="i" aria-hidden="true" />{DOC3[s]}</span>; }
/** Six checkboxes + a separate dashed «هیچ‌کدام آماده نیست». value: null = empty, [] = none ready. */
export function CsDocs({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const sel = value ?? []; const none = value != null && value.length === 0;
  return <>
    <p className="flab dsl">وضعیت (خودکار از تیک‌ها) {value != null ? <DocsChip d={sel} /> : <span className="chip q dst"><Lock className="i" aria-hidden="true" />بی‌مقدار</span>}</p>
    <p className="flab">مدارک آماده</p>
    <div className="dck" role="group" aria-label="مدارک آماده" data-testid="cs-docs">
      {CS_DOCS.map((d) => <label key={d} className="ckb"><input type="checkbox" checked={sel.includes(d)} data-testid={`cs-doc-${d}`}
        onChange={(e) => { const n = e.target.checked ? [...sel, d] : sel.filter((x) => x !== d); onChange(n.length ? CS_DOCS.filter((x) => n.includes(x)) : null); }} /><span>{DOC_LABEL[d]}</span></label>)}
      <label className="ckb nn"><input type="checkbox" checked={none} data-testid="cs-doc-none" onChange={(e) => onChange(e.target.checked ? [] : null)} /><span>هیچ‌کدام آماده نیست</span></label>
    </div>
  </>;
}
export function PlanRO({ value, onPick }: { value: string | null; onPick?: () => void }) {
  return <p className="rov" data-testid="cs-plan-ro"><Lock className="i" aria-hidden="true" /><span>از طرح‌های انتخاب‌شده: <b>{value || 'هنوز طرحی انتخاب نشده'}</b></span>
    {onPick ? <button type="button" className="btn lk sm" onClick={onPick} data-testid="cs-plan-pick"><Pencil className="i" aria-hidden="true" />انتخاب در «طرح‌های مناسب»</button> : null}</p>;
}
/** The control for one item key. */
export function CsControl({ k, value, onChange, onPickPlan }: { k: CsKey; value: unknown; onChange: (v: unknown) => void; onPickPlan?: () => void }) {
  switch (k) {
    case 'creditRank': return <CsRank name="رتبه‌ی متقاضی" k={k} value={(value as string) ?? null} onChange={onChange} />;
    case 'gRank': return <CsRank name="رتبه‌ی ضامن" k={k} guarantor value={(value as string) ?? null} onChange={onChange} />;
    case 'planType': return <PlanRO value={(value as string) ?? null} onPick={onPickPlan} />;
    case 'docs': return <CsDocs value={Array.isArray(value) ? (value as string[]) : null} onChange={onChange} />;
    case 'sso': return <CsSeg name="بازنشستگی تأمین اجتماعی" k={k} opts={Object.entries(RET)} value={(value as string) ?? null} onChange={onChange} />;
    default: return <CsSeg name={k === 'arrears' ? 'معوقه' : 'چک برگشتی'} k={k} opts={Object.entries(YN)} value={(value as string) ?? null} onChange={onChange} />;
  }
}
export const countLine = (n: number, total = 7) => `${fa(n)} از ${fa(total)} مقدار دارد`;
export function MissLine({ n, testId = 'cs-mfn' }: { n: number; testId?: string }) {
  if (n <= 0) return null;
  return <p className="mfn" role="status" data-testid={testId}><Pencil className="i" aria-hidden="true" />{fa(n)} مورد خالی ماند، بعداً هم می‌شود تکمیلش کرد</p>;
}
