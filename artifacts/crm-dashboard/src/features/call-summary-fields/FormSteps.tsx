/** First-call form «موارد اجباری» (design v1.2 fc_a / fc_b / fc_noans / fc_ok): two sub-steps inside the wizard.
 *  Values live in the wizard draft; this only renders the rows and reports changes. Nothing here blocks «بعدی». */
import { Check, X } from 'lucide-react';
import { CS_LABEL, type CsKey, type CsState } from './api';
import { CsControl, CsJump, CsTag, MissLine, countLine } from './controls';
import './cs.css';

export type CsMeta = { source: 'transcript' | 'confirmed' | 'expert' | 'no_answer'; reason?: string; at?: number | null };
export type CsPf = { state: CsState; atSec: number | null; text: string | null };
export const CS_SUB: CsKey[][] = [['creditRank', 'gRank', 'planType'], ['docs', 'sso', 'arrears', 'bounced']];
export const csHas = (v: unknown, m?: CsMeta) => m?.source === 'no_answer' || (v != null && v !== '');

export function csStateOf(v: unknown, m: CsMeta | undefined, pf: CsPf | undefined, hasSource: boolean): CsState {
  if (m?.source === 'no_answer') return 'n';
  if (csHas(v)) return m?.source === 'transcript' ? 'a' : m?.source === 'confirmed' ? 'c' : m?.source === 'expert' ? 'e' : pf?.state === 'a' ? 'a' : 'e';
  if (pf?.state === 'u') return 'u';
  return hasSource ? 'm' : 'x';
}

export function CsFormStep({ sub, vals, meta, pf, hasSource, errors, onSet, onNa, onReason, onUndo, onConfirm, onPickPlan }: {
  sub: 0 | 1; vals: Record<CsKey, unknown>; meta: Partial<Record<CsKey, CsMeta>>; pf: Partial<Record<CsKey, CsPf>>; hasSource: boolean; errors: Record<string, string>;
  onSet: (k: CsKey, v: unknown) => void; onNa: (k: CsKey) => void; onReason: (k: CsKey, r: string) => void; onUndo: (k: CsKey) => void; onConfirm: () => void; onPickPlan?: () => void;
}) {
  const keys = Object.keys(vals) as CsKey[];
  const n = keys.filter((k) => csHas(vals[k], meta[k])).length;
  const anyA = keys.some((k) => csStateOf(vals[k], meta[k], pf[k], hasSource) === 'a');
  return <div className="csf csf-form" data-testid={`cs-form-${sub + 1}`}>
    <ol className="steps sub" aria-label="بخش‌های موارد اجباری"><li className={sub ? 'dn' : 'on'}><b>{sub ? <Check className="i" aria-hidden="true" /> : '۱'}</b>رتبه‌ها و نوع طرح</li>
      <li className={sub ? 'on' : ''}><b>۲</b>مدارک، بازنشستگی، معوقه، چک</li></ol>
    <div className="sh mchk top"><span className={`chip ${n === keys.length ? 's' : 'r'}`} data-testid="cs-form-count">{countLine(n, keys.length)}</span><span className="sp" />
      {anyA ? <button type="button" className="btn gh sm" onClick={onConfirm} data-testid="cs-form-confirm"><Check className="i" aria-hidden="true" />همه درست است</button> : null}</div>
    {CS_SUB[sub].map((k) => {
      const m = meta[k]; const s = csStateOf(vals[k], m, pf[k], hasSource); const p = pf[k];
      return <div key={k} className={`wi ${s}`} data-testid={`cs-wi-${k}`} data-state={s}>
        <div className="mi-h"><b>{CS_LABEL[k]}</b><CsTag s={s} k={k} />{p?.atSec != null && ['a', 'u', 'c'].includes(s) ? <CsJump k={k} at={p.atSec} /> : null}
          {s === 'u' && p?.text ? <small className="hsrc">«{p.text}»</small> : null}</div>
        {s !== 'n' ? <CsControl k={k} value={vals[k]} onChange={(v) => onSet(k, v)} onPickPlan={onPickPlan} /> : null}
        {s === 'n' ? <><label className="flab" htmlFor={`cs-na-${k}`}>دلیل کوتاه</label>
          <input id={`cs-na-${k}`} className="inp ta1" type="text" maxLength={120} value={m?.reason ?? ''} onChange={(e) => onReason(k, e.target.value)}
            aria-invalid={Boolean(errors[`cs_${k}`])} data-testid={`cs-na-reason-${k}`} />
          {errors[`cs_${k}`] ? <p className="err" role="alert" id={`ts-err-cs_${k}`} data-testid={`cs-err-${k}`}>{errors[`cs_${k}`]}</p> : null}
          <button type="button" className="btn lk sm" onClick={() => onUndo(k)} data-testid={`cs-na-undo-${k}`}><X className="i" aria-hidden="true" />برگرداندن «مشتری جواب نداد»</button></>
          : !csHas(vals[k]) && k !== 'planType' ? <button type="button" className="btn lk sm" onClick={() => onNa(k)} data-testid={`cs-na-${k}`}>مشتری جواب نداد</button> : null}
      </div>;
    })}
    {sub === 1 ? <MissLine n={keys.length - n} /> : null}
  </div>;
}
