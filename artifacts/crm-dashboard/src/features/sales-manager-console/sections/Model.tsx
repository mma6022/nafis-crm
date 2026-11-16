// بخش ۵ — مدل چیدن لیست روزانه (§3.4). A model without an owner touches nobody; experts without a model keep today's order.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectionProps } from '../SalesManagerConsolePage';
import { smcApi, type Mix, type Model, type ModelDoc, type Preview, type Rule } from '../api';
import { c, clone, fa, I, Chip, Dot, Kw, Pick, Stp, Tgl, Tok, TYX, uid, addDays } from '../ui';

const MIX: [keyof Mix, string, string][] = [['followup', 'fu', 'پیگیری'], ['lead', 'lead', 'لید تازه'], ['actual', 'file', 'بالفعل (پرونده)'], ['cold', 'cold', 'سرد']];
const W: [string, string][] = [['priority', 'اولویت مشتری'], ['idleDays', 'روزهای بی‌تماس'], ['creditRank', 'رتبه‌ی اعتباری'], ['leadAge', 'تازگی لید'], ['amount', 'مبلغ درخواست'], ['fileStage', 'مرحله‌ی پرونده']];
const TEMPLATES: [string, string, Rule][] = [
  ['potential', 'مشتری بالقوه‌ی بی‌تماس', { id: '', subject: 'potential', op: 'idle_days', value: 7, outcome: 'include', outcomeValue: 'high' }],
  ['reminder', 'یادآور عقب‌افتاده', { id: '', subject: 'reminder', op: 'overdue', value: null, outcome: 'block_start', outcomeValue: 'next' }],
  ['file', 'پرونده‌ی منتظر', { id: '', subject: 'file', op: 'waiting_days_gt', value: 2, outcome: 'include' }],
  ['new_lead', 'لید تازه', { id: '', subject: 'new_lead', op: 'age_hours_lt', value: 2, outcome: 'block_start', outcomeValue: 'same_day' }],
  ['no_answer', 'جواب نداد', { id: '', subject: 'no_answer', op: 'streak', value: 3, outcome: 'retry_days', outcomeValue: { days: 3, coldAfter: 5 } }],
  ['credit_rank', 'رتبه‌ی اعتباری', { id: '', subject: 'credit_rank', op: 'in', value: ['A', 'B'], outcome: 'score', outcomeValue: 2 }],
];
const RANKS: [string, string][] = [['A', 'A'], ['A,B', 'A یا B'], ['B', 'B'], ['C', 'C'], ['D,E', 'D یا E'], ['D,E,?', 'D یا E یا نمی‌دونه']];

export function ModelSection({ st, doc, docs, set }: SectionProps<'model'>) {
  const [sel, setSel] = useState<string>(doc.models[0]?.id ?? 'system');
  const [who, setWho] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const m = doc.models.find((x) => x.id === sel) ?? null;
  const upd = (fn: (d: ModelDoc) => void, n = 1) => { const d = clone(doc); fn(d); set(d, n); };
  const updM = (fn: (x: Model) => void) => upd((d) => { const x = d.models.find((y) => y.id === sel); if (x) fn(x); });
  const experts = docs.teams.experts.filter((e) => e.teamId);
  const teams = docs.teams.teams.filter((t) => !t.deleted);
  const ownerOf = (scope: 'expert' | 'team', id: string) => doc.models.find((x) => x.assign.some((a) => a.scope === scope && a.id === id));
  const forLine = (x: Model) => x.assign.map((a) => a.scope === 'expert' ? experts.find((e) => e.id === a.id)?.displayName : `کل ${teams.find((t) => t.id === a.id)?.name}`).filter(Boolean).join('، ') || 'هنوز به کسی داده نشده';
  const savedM = st.docs.model.models.find((x) => x.id === sel);
  const target = who || m?.assign.find((a) => a.scope === 'expert')?.id || (m?.assign.find((a) => a.scope === 'team') ? experts.find((e) => e.teamId === m!.assign.find((a) => a.scope === 'team')!.id)?.id : undefined) || experts[0]?.id || '';
  const tomorrow = addDays(st.today, 1);
  const [mdeb, setMdeb] = useState(m);
  useEffect(() => { const t = setTimeout(() => setMdeb(m), 400); return () => clearTimeout(t); }, [JSON.stringify(m)]); // eslint-disable-line react-hooks/exhaustive-deps
  const pv = useQuery({ queryKey: ['smc-preview', JSON.stringify(mdeb), target], enabled: Boolean(mdeb && target), placeholderData: (p) => p,
    queryFn: () => smcApi<Preview>('/models/preview', { method: 'POST', body: { model: mdeb, expert: target, date: tomorrow } }) });
  const sum = m ? m.mix.followup + m.mix.lead + m.mix.actual + m.mix.cold : 100;

  const toggleAssign = (scope: 'expert' | 'team', id: string) => updM((x) => {
    const has = x.assign.some((a) => a.scope === scope && a.id === id);
    x.assign = has ? x.assign.filter((a) => !(a.scope === scope && a.id === id)) : [...x.assign, { scope, id }];
  });
  const assignTaken = (scope: 'expert' | 'team', id: string) => { const o = ownerOf(scope, id); return o && o.id !== sel ? o.name : null; };
  return (
    <>
      <div className={c('mlist')}>
        <button className={c('mc', sel === 'system' && 'on')} type="button" onClick={() => setSel('system')}>
          <b><I n="lock" />پیش‌فرض فعلی سیستم</b><small>چیدمان امروز سیستم؛ قابل ویرایش نیست</small><small>برای: بقیه‌ی کارشناس‌ها</small>
        </button>
        {doc.models.map((x) => {
          const dirty = JSON.stringify(x) !== JSON.stringify(st.docs.model.models.find((y) => y.id === x.id));
          return (
            <button key={x.id} className={c('mc', sel === x.id && 'on')} type="button" onClick={() => setSel(x.id)}>
              <b>{x.name}{dirty ? <Chip k="g">پیش‌نویس</Chip> : null}</b><small>{fa(x.capacity)} کار، پیگیری {fa(x.mix.followup)}٪، لید تازه {fa(x.mix.lead)}٪</small><small>برای: {forLine(x)}</small>
            </button>
          );
        })}
        <button className={c('mc add')} type="button" onClick={() => { const id = uid('m-'); upd((d) => { d.models.push({ id, name: 'مدل تازه', capacity: 25, mix: { followup: 40, lead: 30, actual: 20, cold: 10 }, rules: [], weights: { ...st.defaultWeights }, retryHours: 3, useTeamBlocks: true, assign: [] }); }); setSel(id); }}>
          <I n="plus" /> مدل تازه
        </button>
      </div>
      {!m ? (
        <p className={c('hint')} style={{ marginTop: 12 }}>کارشناسی که مدلی ندارد، همان ترتیب امروز «کارهای امروز من» را می‌بیند. برای ساختن مدل، «مدل تازه» یا یکی از مدل‌های آماده را باز کنید.</p>
      ) : (
        <div className={c('medit')}>
          <div className={c('pane')}>
            <div className={c('row1')}>
              <span className={c('lbl')}>نام مدل</span>
              <input className={c('inp')} value={m.name} aria-label="نام مدل" style={{ flex: 1 }} onChange={(e) => updM((x) => { x.name = e.target.value.slice(0, 40); })} />
              <button className={c('btn gh')} type="button" onClick={() => { const id = uid('m-'); upd((d) => { const src = d.models.find((y) => y.id === sel)!; d.models.push({ ...clone(src), id, name: `${src.name} (کپی)`, assign: [] }); }); setSel(id); }}><I n="copy" />کپی</button>
              <button className={c('ib')} type="button" aria-label="حذف مدل" onClick={() => { upd((d) => { d.models = d.models.filter((y) => y.id !== sel); }); setSel('system'); }}><I n="trash" /></button>
            </div>
            <div className={c('row1')} style={{ marginTop: 10 }}>
              <span className={c('lbl')}>برای</span>
              {experts.map((e) => { const tk = assignTaken('expert', e.id); return <Pick key={e.id} on={m.assign.some((a) => a.scope === 'expert' && a.id === e.id)} label={tk ? `${e.displayName}، الان با مدل ${tk}` : undefined} onClick={() => { if (tk) upd((d) => { for (const y of d.models) y.assign = y.assign.filter((a) => !(a.scope === 'expert' && a.id === e.id)); d.models.find((y) => y.id === sel)!.assign.push({ scope: 'expert', id: e.id }); }); else toggleAssign('expert', e.id); }}>{e.displayName}</Pick>; })}
              {teams.map((t) => { const tk = assignTaken('team', t.id); return <Pick key={t.id} on={m.assign.some((a) => a.scope === 'team' && a.id === t.id)} label={tk ? `کل ${t.name}، الان با مدل ${tk}` : undefined} onClick={() => { if (tk) upd((d) => { for (const y of d.models) y.assign = y.assign.filter((a) => !(a.scope === 'team' && a.id === t.id)); d.models.find((y) => y.id === sel)!.assign.push({ scope: 'team', id: t.id }); }); else toggleAssign('team', t.id); }}>کل {t.name}</Pick>; })}
            </div>
            <div className={c('h3')}>ظرفیت روزانه <span className={c('sp')} /><Stp label="ظرفیت روزانه" value={m.capacity} min={5} max={60} fmt={(v) => `${fa(v)} کار`} onChange={(v) => updM((x) => { x.capacity = v; })} /></div>
            <div className={c('h3')}>ترکیب لیست {sum === 100 ? <Chip k="ok">جمع ۱۰۰٪</Chip> : <Chip k="r">جمع {fa(sum)}٪؛ {fa(Math.abs(100 - sum))}٪ {sum < 100 ? 'مانده' : 'اضافه'}</Chip>}</div>
            <div className={c('mix')}>{MIX.map(([k, t]) => <span key={k} style={{ width: `${m.mix[k]}%`, background: `var(${TYX[t]![1]})` }} />)}</div>
            {MIX.map(([k, t, l]) => (
              <div key={k} className={c('mixr')}>
                <Dot t={t} /><b style={{ color: 'var(--ink)', fontSize: 14 }}>{l}</b>
                <input type="range" className={c('rgi')} min={0} max={100} step={5} value={m.mix[k]} aria-label={l} onChange={(e) => updM((x) => { x.mix[k] = Number(e.target.value); })} style={{ ['--v' as string]: `${m.mix[k]}%` }} />
                <Stp label={l} value={m.mix[k]} min={0} max={100} step={5} fmt={(v) => `${fa(v)}٪`} onChange={(v) => updM((x) => { x.mix[k] = v; })} />
              </div>
            ))}
            <p className={c('hint')}>اگر یک نوع کم بیاید، جایش با نوع بعدی همین فهرست پر می‌شود.</p>
            <div className={c('h3')}>قانون‌های ورود به لیست <span className={c('hint')}>به ترتیب بررسی می‌شوند</span></div>
            {m.rules.map((r, i) => {
              const isNew = !savedM?.rules.some((y) => y.id === r.id);
              return (
                <div key={r.id} className={c('rule', isNew && 'new')}>
                  <span className={c('rno')}>{fa(i + 1)}</span>
                  <span className={c('rc')}><RuleText r={r} onChange={(nr) => updM((x) => { x.rules[i] = nr; })} /></span>
                  <span className={c('ra')}>
                    <button className={c('ib')} type="button" aria-label="بالاتر" disabled={i === 0} onClick={() => updM((x) => { [x.rules[i - 1], x.rules[i]] = [x.rules[i]!, x.rules[i - 1]!]; })}><I n="up" /></button>
                    <button className={c('ib')} type="button" aria-label="پایین‌تر" disabled={i === m.rules.length - 1} onClick={() => updM((x) => { [x.rules[i + 1], x.rules[i]] = [x.rules[i]!, x.rules[i + 1]!]; })}><I n="down" /></button>
                    <button className={c('ib')} type="button" aria-label="حذف قانون" onClick={() => updM((x) => { x.rules.splice(i, 1); })}><I n="x" /></button>
                  </span>
                </div>
              );
            })}
            {adding ? (
              <div className={c('row1')}>
                {TEMPLATES.map(([k, l, r]) => <button key={k} className={c('tok n')} type="button" onClick={() => { updM((x) => { x.rules.push({ ...clone(r), id: uid('r') }); }); setAdding(false); }}>{l}</button>)}
                <button className={c('btn gh')} type="button" onClick={() => setAdding(false)}>لغو</button>
              </div>
            ) : <button className={c('btn dash')} type="button" onClick={() => setAdding(true)}><I n="plus" />افزودن قانون</button>}
            <div className={c('rule lockr')} style={{ marginTop: 10 }}><I n="lock" /><span className={c('kw')}>ورودی، دستور پرداخت و اقدام پرونده</span><span className={c('hint')}>همیشه فوری بالای صف؛ در مدل تغییر نمی‌کند</span></div>
            <div className={c('h3')}>وزن‌ها برای ترتیب داخل هر بازه</div>
            {W.map(([k, l]) => (
              <div key={k} className={c('wrow')}>
                <span className={c('lbl')} style={{ color: 'var(--ink-soft)' }}>{l}</span>
                <input type="range" className={c('rgi')} min={0} max={10} step={1} value={m.weights[k] ?? 0} aria-label={l} onChange={(e) => updM((x) => { x.weights[k] = Number(e.target.value); })} style={{ ['--v' as string]: `${(m.weights[k] ?? 0) * 10}%` }} />
                <b>{fa(m.weights[k] ?? 0)}</b>
              </div>
            ))}
            <div className={c('h3')}>بازه‌ها و تلاش دوباره</div>
            <div className={c('row1')}>
              <Tgl on={m.useTeamBlocks} onClick={() => updM((x) => { x.useTeamBlocks = !x.useTeamBlocks; })}>بازه‌های تیم را به کار ببر</Tgl>
              <span className={c('lbl')}>فاصله‌ی تلاش دوباره بعد از بی‌پاسخ</span>
              <Stp label="فاصله‌ی تلاش دوباره" value={m.retryHours} min={1} max={72} fmt={(v) => `${fa(v)} ساعت`} onChange={(v) => updM((x) => { x.retryHours = v; })} />
            </div>
          </div>
          <div className={c('pane prev')}>
            <div className={c('h3')}><I n="play" />لیست فردای {experts.find((e) => e.id === target)?.displayName ?? ''} با این مدل</div>
            {pv.data ? (<>
              <div className={c('kpi')}><div><b>{fa(pv.data.counts.fu)}</b><small>پیگیری</small></div><div><b>{fa(pv.data.counts.lead)}</b><small>لید تازه</small></div><div><b>{fa(pv.data.counts.file)}</b><small>بالفعل</small></div><div><b>{fa(pv.data.counts.cold)}</b><small>سرد</small></div></div>
              <div className={c('diff')}><Chip k="ok">+{fa(pv.data.diff.added)} تازه</Chip><Chip k="r">−{fa(pv.data.diff.out)} بیرون</Chip><Chip>{fa(pv.data.diff.moved)} جابه‌جا</Chip><Chip k="g">دستی‌ها می‌مانند</Chip></div>
              {pv.data.top.map((r, i) => <div key={i} className={c('pv')}><span className={c('hint')}>{fa(i + 1)}</span><Dot t={r.type === 'pay' ? 'pay' : r.type} /><b>{r.name}</b><span className={c('hint')}>{r.why}</span></div>)}
              {pv.data.more ? <p className={c('hint')} style={{ marginTop: 6 }}>{fa(pv.data.more)} کار دیگر…</p> : null}
              {!pv.data.total ? <p className={c('hint')}>برای این روز کاری چیده نشد.</p> : null}
            </>) : <p className={c('hint')}>{pv.isError ? 'پیش‌نمایش آماده نشد.' : 'در حال چیدن…'}</p>}
            <div className={c('row1')} style={{ marginTop: 8 }}>
              <select className={c('btn gh sel')} aria-label="پیش‌نمایش برای کارشناس دیگر" value={target} onChange={(e) => setWho(e.target.value)}>
                {experts.map((e) => <option key={e.id} value={e.id}>پیش‌نمایش برای {e.displayName}</option>)}
              </select>
            </div>
            <p className={c('hint')}>پیش‌نمایش چیزی ذخیره نمی‌کند. بعد از ذخیره، از لیست فردا اعمال می‌شود؛ لیست امروز و کارهای دستی دست نمی‌خورند.</p>
          </div>
        </div>
      )}
    </>
  );
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const opts = (a: number[], f: (n: number) => string) => a.map((n) => [String(n), f(n)] as [string, string]);
function RuleText({ r, onChange }: { r: Rule; onChange: (r: Rule) => void }) {
  const set = (p: Partial<Rule>) => onChange({ ...r, ...p });
  switch (r.subject) {
    case 'potential': return (<><Kw>اگر</Kw><span className={c('tok')}>مشتری بالقوه</span><Tok label="روز بی‌تماس" k="n" value={String(num(r.value, 7))} options={opts([3, 5, 7, 10, 14, 21, 30], (n) => `${fa(n)} روز`)} onChange={(v) => set({ value: Number(v) })} /><Kw>تماس نگرفته باشد، آنگاه</Kw><span className={c('tok g')}>به لیست بیاید</span><Kw>با اولویت</Kw><Tok label="اولویت" k="n" value={String(r.outcomeValue ?? 'high')} options={[['high', 'بالا'], ['normal', 'معمولی']]} onChange={(v) => set({ outcomeValue: v })} /></>);
    case 'reminder': return (<><Kw>اگر</Kw><span className={c('tok')}>یادآور</span><span className={c('tok n')}>عقب‌افتاده</span><Kw>باشد، آنگاه</Kw><Tok label="نتیجه" k="g" value={String(r.outcomeValue ?? 'next')} options={[['next', 'اول بازه‌ی بعدی'], ['same_day', 'همان روز، اول بازه']]} onChange={(v) => set({ outcomeValue: v })} /></>);
    case 'file': return (<><Kw>اگر</Kw><span className={c('tok')}>پرونده</span><Kw>بیش از</Kw><Tok label="روز انتظار" k="n" value={String(num(r.value, 2))} options={opts([1, 2, 3, 5, 7], (n) => `${fa(n)} روز`)} onChange={(v) => set({ value: Number(v) })} /><span className={c('tok n')}>منتظر اقدام کارشناس</span><Kw>بماند، آنگاه</Kw><span className={c('tok g')}>به لیست بیاید</span></>);
    case 'new_lead': return (<><Kw>اگر</Kw><span className={c('tok')}>لید تازه</span><Kw>کمتر از</Kw><Tok label="ساعت از ثبت" k="n" value={String(num(r.value, 2))} options={opts([1, 2, 4, 8, 24], (n) => `${fa(n)} ساعت`)} onChange={(v) => set({ value: Number(v) })} /><Kw>از ثبتش گذشته، آنگاه</Kw><Tok label="نتیجه" k="g" value={String(r.outcomeValue ?? 'same_day')} options={[['same_day', 'همان روز، اول بازه'], ['next', 'اول بازه‌ی بعدی']]} onChange={(v) => set({ outcomeValue: v })} /></>);
    case 'no_answer': { const ov = (r.outcomeValue ?? { days: 3, coldAfter: 5 }) as { days: number; coldAfter: number };
      return (<><Kw>اگر</Kw><span className={c('tok')}>جواب نداد</span><Tok label="بار پشت سر هم" k="n" value={String(num(r.value, 3))} options={opts([2, 3, 4, 5], (n) => `${fa(n)} بار`)} onChange={(v) => set({ value: Number(v) })} /><Kw>پشت سر هم، آنگاه</Kw><Tok label="روز بعد" k="g" value={String(ov.days)} options={opts([1, 2, 3, 5, 7], (n) => `${fa(n)} روز بعد دوباره`)} onChange={(v) => set({ outcomeValue: { ...ov, days: Number(v) } })} /><Kw>و بعد از</Kw><Tok label="سرد شدن" k="n" value={String(ov.coldAfter)} options={opts([4, 5, 6, 8, 10], (n) => `${fa(n)} بار`)} onChange={(v) => set({ outcomeValue: { ...ov, coldAfter: Number(v) } })} /><span className={c('tok g')}>سرد شود</span></>); }
    case 'credit_rank': return (<><Kw>اگر</Kw><span className={c('tok')}>رتبه‌ی اعتباری</span><Tok label="رتبه" k="n" value={(Array.isArray(r.value) ? (r.value as string[]) : ['A', 'B']).join(',')} options={RANKS} onChange={(v) => set({ value: v.split(',') })} /><Kw>باشد، آنگاه</Kw><Tok label="امتیاز" k="g" value={String(num(r.outcomeValue, 2))} options={opts([1, 2, 3, 5], (n) => `امتیاز +${fa(n)}`)} onChange={(v) => set({ outcomeValue: Number(v) })} /></>);
    default: return <Kw>قانون</Kw>;
  }
}
