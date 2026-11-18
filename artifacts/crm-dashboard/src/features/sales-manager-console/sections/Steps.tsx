// بخش ۷ — مراحل پرونده‌ی تسهیلات (§3.6). Only whether a step exists; contract text and templates are never touched. Open files keep their own steps.
import { useState } from 'react';
import type { SectionProps } from '../SalesManagerConsolePage';
import type { Stage, StepsDoc } from '../api';
import { c, clone, fa, I, Chip, Pick, Tgl } from '../ui';
import { withPlanPrefix } from '@/lib/multi-case-plan-label';

export function StepsSection({ st, doc, set }: SectionProps<'steps'>) {
  const [plan, setPlan] = useState<string>('default');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [docAdd, setDocAdd] = useState<string | null>(null);
  const sys = st.systemStages;
  const base = (k: string): Stage[] => (k === 'default' ? doc.plans.default ?? sys : doc.plans[k] ?? doc.plans.default ?? sys);
  const list = base(plan);
  const custom = plan === 'default' ? Boolean(doc.plans.default) : Boolean(doc.plans[plan]);
  const write = (fn: (l: Stage[]) => Stage[] | void, n = 1) => { const d: StepsDoc = clone(doc); const l = clone(base(plan)); const r = fn(l) ?? l; d.plans[plan] = r; set(d, n); };
  const groupOff = (keys: string[]) => keys.every((k) => !list.find((s) => s.key === k)?.enabled);
  const setGroup = (keys: string[], off: boolean) => write((l) => { for (const s of l) if (keys.includes(s.key)) s.enabled = !off; });
  const g = st.stageGroups;
  const why = (s: Stage) => (g.contract.includes(s.key) ? 'خاموش با «قرارداد لازم نیست»' : g.guarantor.includes(s.key) ? 'خاموش با «ضامن لازم نیست»' : g.collateral.includes(s.key) ? 'خاموش با «وثیقه لازم نیست»' : 'خاموش');
  const movable = list.filter((s) => s.key !== 'completed');
  let ph = 0; let n = 0;
  const activeN = list.filter((s) => s.enabled).length;
  return (
    <>
      <div className={c('plans')}>
        <Pick on={plan === 'default'} onClick={() => setPlan('default')} cnt={doc.plans.default ? 'سفارشی' : undefined}>پیش‌فرض سیستم</Pick>
        {st.plans.map((p) => <Pick key={p.key} on={plan === p.key} onClick={() => setPlan(p.key)} cnt={doc.plans[p.key] ? 'سفارشی' : undefined}>{withPlanPrefix(p.name)}</Pick>)}
      </div>
      <div className={c('row1')} style={{ marginTop: 12 }}>
        <Tgl on={groupOff(g.contract)} onClick={() => setGroup(g.contract, !groupOff(g.contract))}>قرارداد لازم نیست</Tgl>
        <Tgl on={groupOff(g.guarantor)} onClick={() => setGroup(g.guarantor, !groupOff(g.guarantor))}>ضامن لازم نیست</Tgl>
        <Tgl on={groupOff(g.collateral)} onClick={() => setGroup(g.collateral, !groupOff(g.collateral))}>وثیقه لازم نیست</Tgl>
        <span className={c('sp')} />
        {custom ? <button className={c('btn lk')} type="button" onClick={() => { const d: StepsDoc = clone(doc); if (plan === 'default') d.plans.default = null; else delete d.plans[plan]; set(d); }}><I n="undo" />بازگشت به {plan === 'default' ? 'مراحل سیستم' : 'پیش‌فرض'}</button> : null}
      </div>
      <p className={c('hint')} style={{ marginTop: 6 }}>متن قرارداد عوض نمی‌شود؛ فقط بودن یا نبودن مرحله. پرونده‌های باز با همان مراحل قبلی ادامه می‌دهند.</p>
      {list.map((s, i) => {
        const head = s.phase !== ph ? (ph = s.phase, <div key={`ph${s.phase}-${i}`} className={c('phase')}>فاز {fa(s.phase)}</div>) : null;
        if (s.enabled) n++;
        const off = !s.enabled; const done = s.key === 'completed'; const mi = movable.findIndex((x) => x.key === s.key);
        const note = off ? why(s) : s.custom ? 'مرحله‌ی تازه‌ی این طرح' : s.optional ? 'اختیاری؛ کارشناس می‌تواند رد شود' : s.docs.length ? `${fa(s.docs.length)} مدرک لازم` : '';
        return [head, (
          <div key={s.key} className={c('stg', off && 'off', s.custom && 'cust', docAdd === s.key && 'ed')}>
            <span className={c('sno')}>{off ? '–' : fa(n)}</span>
            <span>
              {renaming === s.key
                ? <input className={c('inp')} defaultValue={s.label} aria-label="نام مرحله" autoFocus onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.label) write((l) => { l[i]!.label = v.slice(0, 60); }); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                : <b>{s.label}</b>}
              <small>نوبت {s.turn === 'us' ? 'ما' : 'مشتری'}{note ? `، ${note}` : ''}</small>
            </span>
            {done ? <><span /><span /></> : (<>
              <Tgl cls="xa" on={s.optional} disabled={off} onClick={() => write((l) => { l[i]!.optional = !l[i]!.optional; })}>اختیاری</Tgl>
              <span className={c('row1')} style={{ gap: 6 }}>
                <button className={c('ib xa')} type="button" aria-label="تغییر نام" onClick={() => setRenaming(s.key)}><I n="edit" /></button>
                <button className={c('ib')} type="button" aria-label={off ? 'روشن کردن مرحله' : 'خاموش کردن مرحله'} onClick={() => write((l) => { l[i]!.enabled = !l[i]!.enabled; })}>{off ? <I n="plus" /> : <I n="x" />}</button>
              </span>
            </>)}
            <span className={c('row1')} style={{ gap: 6 }}>
              {done ? <Chip k="lock"><I n="lock" />همیشه آخر</Chip> : (<>
                <button className={c('ib')} type="button" aria-label="بالاتر" disabled={mi <= 0} onClick={() => write((l) => { const j = i - 1; [l[j], l[i]] = [l[i]!, l[j]!]; l[i - 1]!.phase = Math.min(l[i - 1]!.phase, l[i]!.phase); })}><I n="up" /></button>
                <button className={c('ib')} type="button" aria-label="پایین‌تر" disabled={mi >= movable.length - 1} onClick={() => write((l) => { const j = i + 1; [l[j], l[i]] = [l[i]!, l[j]!]; l[i + 1]!.phase = Math.max(l[i + 1]!.phase, l[i]!.phase); })}><I n="down" /></button>
              </>)}
            </span>
            {!off && !done && (s.docs.length || docAdd === s.key) ? (
              <div className={c('docs')}>
                <span className={c('lbl')}>مدارک لازم:</span>
                {s.docs.map((d, k) => <span key={k} className={c('chip')}>{d}<button className={c('ib')} type="button" aria-label={`حذف ${d}`} onClick={() => write((l) => { l[i]!.docs.splice(k, 1); })}><I n="x" /></button></span>)}
                {docAdd === s.key
                  ? <input className={c('inp')} placeholder="نام مدرک" aria-label="نام مدرک" autoFocus onBlur={(e) => { const v = e.target.value.trim(); if (v) write((l) => { l[i]!.docs.push(v.slice(0, 60)); }); setDocAdd(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                  : <button className={c('btn dash')} type="button" onClick={() => setDocAdd(s.key)}><I n="plus" />مدرک</button>}
              </div>
            ) : !off && !done && s.turn === 'customer' ? <div className={c('docs')}><button className={c('btn lk')} type="button" onClick={() => setDocAdd(s.key)}><I n="plus" />مدرک لازم</button></div> : null}
          </div>
        )];
      })}
      <div className={c('row1')} style={{ marginTop: 10 }}>
        <button className={c('btn dash')} type="button" onClick={() => write((l) => { const k = `custom_${Date.now().toString(36)}`; const at = Math.max(0, l.length - 1); const prev = l[at - 1]; l.splice(at, 0, { key: k, label: 'مرحله‌ی تازه', phase: prev?.phase ?? 5, turn: 'us', enabled: true, optional: false, docs: [], custom: true }); setRenaming(k); })}><I n="plus" />افزودن مرحله</button>
        <span className={c('hint')}>{fa(activeN)} مرحله‌ی فعال از {fa(list.length)}</span>
      </div>
    </>
  );
}
