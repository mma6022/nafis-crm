// بخش ۶ — تقسیم مشتری بین تیم‌ها و کارشناس‌ها (§3.5). The sample-lead test never moves a counter.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectionProps } from '../SalesManagerConsolePage';
import { smcApi, type Cond, type DistDoc, type DistRule, type Method, type RouteResult } from '../api';
import { c, clone, fa, I, Chip, Kw, Pick, Stp, Tok, uid, latin } from '../ui';

export const FIELDS: [string, string, [string, string][]][] = [
  ['priority', 'اولویت', [['1', 'اولویت ۱'], ['2', 'اولویت ۲'], ['3', 'اولویت ۳']]],
  ['status', 'وضعیت', [['new_lead', 'لید تازه'], ['followup', 'پیگیری'], ['returning', 'مشتری قبلی']]],
  ['credit_rank', 'رتبه‌ی اعتباری', [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['?', 'نمی‌دونه']]],
  ['amount', 'مبلغ درخواست', []],
  ['job', 'شغل', [['employee', 'کارمند'], ['retired', 'بازنشسته'], ['military', 'نظامی'], ['self', 'آزاد']]],
  ['docs', 'مدارک', [['payslip', 'فیش حقوقی دارد'], ['none', 'مدرک ندارد']]],
  ['bounced_check', 'چک برگشتی یا معوق', [['yes', 'دارد'], ['no', 'ندارد']]],
  ['need_time', 'زمان نیاز', [['week', 'همین هفته'], ['month', 'همین ماه'], ['later', 'بعدتر']]],
  ['source', 'منبع', [['site', 'سایت'], ['bale', 'بله'], ['call', 'تماس'], ['referral', 'معرفی']]],
];
const METHODS_TEAM: [Method['method'], string][] = [['direct', 'مستقیم'], ['ratio', 'به نسبت'], ['percent', 'درصدی'], ['round_robin', 'نوبتی بین همه']];
const METHODS_MEMBER: [Method['method'], string][] = [['direct', 'مستقیم'], ['ratio', 'به نسبت'], ['round_robin', 'نوبتی بین همه'], ['capacity', 'بر اساس ظرفیت'], ['percent', 'درصدی']];
const fieldOf = (f: string) => FIELDS.find((x) => x[0] === f) ?? FIELDS[0]!;
const AMOUNTS: [string, string][] = [['100', '۱۰۰ میلیون'], ['200', '۲۰۰ میلیون'], ['300', '۳۰۰ میلیون'], ['500', '۵۰۰ میلیون'], ['1000', 'یک میلیارد']];
const SAMPLE: Record<string, string> = { priority: '1', status: 'new_lead', credit_rank: 'B', amount: '350', job: 'employee', docs: 'payslip', bounced_check: 'no', need_time: 'week', source: 'site' };

export function DistSection({ st, doc, docs, set }: SectionProps<'dist'>) {
  const teams = docs.teams.teams.filter((t) => !t.deleted);
  const [tid, setTid] = useState(teams[0]?.id ?? '');
  const [lead, setLead] = useState<Record<string, string>>(SAMPLE);
  const [res, setRes] = useState<RouteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (fn: (d: DistDoc) => void, n = 1) => { const d = clone(doc); fn(d); set(d, n); setRes(null); };
  const log = useQuery({ queryKey: ['smc-dist-log', st.today], queryFn: () => smcApi<{ rows: { at: string; customer: string; team: string; expert: string; reason: string }[] }>(`/distribution/log?date=${st.today}`) });
  const names = (lvl: 'team' | 'member') => (lvl === 'team' ? teams.map((t) => [t.id, t.name] as [string, string]) : docs.teams.experts.filter((e) => e.teamId === tid).map((e) => [e.id, e.displayName] as [string, string]));
  const stale = (lvl: 'team' | 'member', i: number) => st.stale.find((s) => s.level === lvl && s.index === i && (lvl === 'team' || s.teamId === tid));
  const member = doc.member[tid] ?? { rules: [], fallback: { method: 'capacity', targets: [] } };
  const ensureMember = (d: DistDoc) => (d.member[tid] = d.member[tid] ?? { rules: [], fallback: { method: 'capacity', targets: [] } });

  const ruleRow = (lvl: 'team' | 'member', r: DistRule, i: number, list: DistRule[]) => {
    const edit = (fn: (x: DistRule) => void) => upd((d) => { const l = lvl === 'team' ? d.team.rules : ensureMember(d).rules; fn(l[i]!); });
    const swap = (j: number) => upd((d) => { const l = lvl === 'team' ? d.team.rules : ensureMember(d).rules; [l[i], l[j]] = [l[j]!, l[i]!]; });
    const s = stale(lvl, i); const hit = res && (lvl === 'team' ? res.teamRule === i + 1 : res.teamId === tid && res.memberRule === i + 1);
    return (
      <div key={r.id} className={c('rule', hit && 'hit')}>
        <span className={c('rno')}>{fa(i + 1)}</span>
        <span className={c('rc')}>
          <Kw>اگر</Kw>
          {r.conds.map((cd, k) => <CondEd key={k} cd={cd} onChange={(n) => edit((x) => { x.conds[k] = n; })} onRemove={r.conds.length > 1 ? () => edit((x) => { x.conds.splice(k, 1); }) : undefined} />)}
          {r.conds.length < 3 ? <button className={c('tok n')} type="button" aria-label="شرط دیگر" onClick={() => edit((x) => { x.conds.push({ field: 'credit_rank', values: ['A'] }); })}>و…</button> : null}
          <Kw>آنگاه</Kw>
          <MethodEd lvl={lvl} m={r} names={names(lvl)} onChange={(m) => edit((x) => { x.method = m.method; x.targets = m.targets; })} />
          {s ? <Chip k="r">{s.text}</Chip> : null}
        </span>
        <span className={c('ra')}>
          <button className={c('ib')} type="button" aria-label="بالاتر" disabled={i === 0} onClick={() => swap(i - 1)}><I n="up" /></button>
          <button className={c('ib')} type="button" aria-label="پایین‌تر" disabled={i === list.length - 1} onClick={() => swap(i + 1)}><I n="down" /></button>
          <button className={c('ib')} type="button" aria-label="حذف قانون" onClick={() => upd((d) => { const l = lvl === 'team' ? d.team.rules : ensureMember(d).rules; l.splice(i, 1); })}><I n="x" /></button>
        </span>
      </div>
    );
  };
  const fb = (lvl: 'team' | 'member', m: Method) => {
    const pct = m.method === 'percent' ? m.targets : [];
    return (
      <div className={c('rule fb')}>
        <I n="rf" /><span className={c('kw')}>بقیه</span>
        <MethodEd lvl={lvl} m={m} names={names(lvl)} fallback onChange={(n) => upd((d) => { if (lvl === 'team') d.team.fallback = n; else ensureMember(d).fallback = n; })} />
        {m.method === 'percent' ? <span className={c('hint')}>{pct.map((x) => `${names(lvl).find((y) => y[0] === x.id)?.[1] ?? ''}: ${fa(x.weight ?? 0)}٪`).join('، ')}</span> : null}
        {m.method === 'percent' && pct.length === 2 ? <span className={c('split')}><span style={{ width: `${pct[0]!.weight}%`, background: 'var(--brand)' }} /><span style={{ width: `${pct[1]!.weight}%`, background: 'var(--gold-400)' }} /></span> : null}
        {m.method === 'capacity' ? <span className={c('hint')}>به کسی که امروز جای خالی بیشتری دارد</span> : null}
      </div>
    );
  };
  const test = async () => {
    setBusy(true);
    try { setRes(await smcApi<RouteResult>('/distribution/test', { method: 'POST', body: { lead, dist: doc } })); } finally { setBusy(false); }
  };
  const newRule = (lvl: 'team' | 'member'): DistRule => ({ id: uid('d'), conds: [{ field: 'credit_rank', values: ['A', 'B'] }], method: 'direct', targets: names(lvl).slice(0, 1).map(([id]) => ({ id })) });
  const ms = docs.teams.experts.filter((e) => e.teamId === tid);
  return (
    <>
      <div className={c('lvl')}><span className={c('ln')}>۱</span><h3>بین تیم‌ها</h3><span className={c('hint')}>اولین قانونی که بخورد، تیم را تعیین می‌کند</span></div>
      {doc.team.rules.map((r, i, l) => ruleRow('team', r, i, l))}
      {fb('team', doc.team.fallback)}
      <button className={c('btn dash')} type="button" onClick={() => upd((d) => { d.team.rules.push(newRule('team')); })}><I n="plus" />افزودن قانون بین تیم‌ها</button>
      <div className={c('lvl')}><span className={c('ln')}>۲</span><h3>داخل تیم</h3>{teams.map((t) => <Pick key={t.id} on={t.id === tid} onClick={() => { setTid(t.id); setRes(null); }}>{t.name}</Pick>)}</div>
      <div className={c('dgrid')}>
        <div>
          {member.rules.map((r, i, l) => ruleRow('member', r, i, l))}
          {fb('member', member.fallback)}
          <button className={c('btn dash')} type="button" onClick={() => upd((d) => { ensureMember(d).rules.push(newRule('member')); })}><I n="plus" />افزودن قانون داخل تیم</button>
          <div className={c('h3')}>سقف و نسبت هر کارشناس</div>
          <table className={c('tbl')}>
            <thead><tr><th>کارشناس</th><th>سهم درصدی</th><th>سقف لید تازه در روز</th><th>وضعیت</th></tr></thead>
            <tbody>
              {ms.map((e) => { const cap = doc.caps[e.id] ?? { percent: 0, dailyCap: 12 }; return (
                <tr key={e.id}>
                  <td className={c('nm')}><b>{e.displayName}</b>{!e.userId ? <span className={c('hint')}> بدون حساب؛ لید نمی‌گیرد</span> : null}</td>
                  <td><Stp label={`سهم ${e.displayName}`} value={cap.percent} min={0} max={100} step={5} fmt={(v) => `${fa(v)}٪`} onChange={(v) => upd((d) => { d.caps[e.id] = { ...cap, percent: v }; const m = ensureMember(d); if (m.fallback.method === 'percent') m.fallback.targets = ms.map((x) => ({ id: x.id, weight: x.id === e.id ? v : d.caps[x.id]?.percent ?? 0 })); })} /></td>
                  <td><Stp label={`سقف ${e.displayName}`} value={cap.dailyCap} min={0} max={200} onChange={(v) => upd((d) => { d.caps[e.id] = { ...cap, dailyCap: v }; })} /></td>
                  <td>{e.status === 'active' ? <Chip k="ok">فعال</Chip> : <Chip k="g">{e.status === 'leave' ? 'مرخصی' : 'غیرفعال'}</Chip>}</td>
                </tr>); })}
            </tbody>
          </table>
          {(() => { const s = ms.reduce((a, e) => a + (doc.caps[e.id]?.percent ?? 0), 0); return s !== 100 && member.fallback.method === 'percent' ? <p className={c('err')}>جمع سهم‌ها {fa(s)}٪ است؛ باید ۱۰۰٪ باشد.</p> : null; })()}
          <p className={c('hint')} style={{ marginTop: 6 }}>اگر کارشناس مرخصی است یا سقفش پر شده، لید به نفر بعدی همان تیم می‌رسد؛ اگر همه پر باشند، به صف مدیر فروش.</p>
        </div>
        <div className={c('pane test')}>
          <div className={c('h3')} style={{ marginTop: 0 }}><I n="play" />آزمایش با یک لید نمونه</div>
          {FIELDS.map(([f, l, vals]) => (
            <div key={f} className={c('f')}>
              <span className={c('lbl')}>{l}</span>
              {f === 'amount'
                ? <input className={c('inp')} inputMode="numeric" aria-label="مبلغ به میلیون تومان" value={fa(lead.amount ?? '')} onChange={(e) => setLead({ ...lead, amount: latin(e.target.value).replace(/\D/g, '') })} style={{ maxWidth: 160 }} />
                : <Tok label={l} k="n" value={lead[f] ?? ''} options={[['', '—'], ...vals]} onChange={(v) => setLead({ ...lead, [f]: v })} />}
              {f === 'amount' ? <span className={c('hint')}>میلیون تومان</span> : null}
            </div>
          ))}
          <button className={c('btn pri')} type="button" style={{ marginTop: 8, width: '100%' }} disabled={busy} onClick={() => void test()}><I n="play" />ببین به کی می‌رسد</button>
          {res ? (
            <ol className={c('path')} aria-live="polite">
              {res.path.map((p, i) => <li key={i} className={c(p.level === 3 && 'res')}><I n={p.level === 1 ? 'team' : 'user'} /><span>{p.text}</span></li>)}
            </ol>
          ) : null}
          <p className={c('hint')}>آزمایش چیزی ثبت نمی‌کند و نوبت هیچ قانونی را جلو نمی‌برد.</p>
        </div>
      </div>
      <div className={c('h3')}>تاریخچه‌ی تقسیم <span className={c('hint')}>امروز</span></div>
      {log.data?.rows.length ? (
        <table className={c('tbl hist')}>
          <thead><tr><th>ساعت</th><th>مشتری</th><th>تیم</th><th>کارشناس</th><th>دلیل</th></tr></thead>
          <tbody>{log.data.rows.map((r, i) => <tr key={i}><td>{r.at}</td><td><b style={{ color: 'var(--ink)' }}>{r.customer}</b></td><td>{r.team}</td><td>{r.expert}</td><td>{r.reason}</td></tr>)}</tbody>
        </table>
      ) : <p className={c('hint')}>امروز هنوز مشتری‌ای با این قانون‌ها تقسیم نشده. تقسیم لیدهای تازه هنوز با تنظیم فعلی «تیم‌های فروش» است.</p>}
    </>
  );
}

function CondEd({ cd, onChange, onRemove }: { cd: Cond; onChange: (c: Cond) => void; onRemove?: () => void }) {
  const [f, l, vals] = fieldOf(cd.field);
  return (
    <span className={c('cond')}>
      <Tok label="شرط" value={f} options={FIELDS.map(([k, n]) => [k, n] as [string, string])} onChange={(nf) => onChange({ field: nf, values: nf === 'amount' ? ['gt', '500'] : [fieldOf(nf)[2][0]![0]] })} />
      {f === 'amount' ? (<>
        <Tok label="بیشتر یا کمتر" k="n" value={cd.values[0] ?? 'gt'} options={[['gt', 'بیشتر از'], ['lt', 'کمتر از']]} onChange={(v) => onChange({ field: f, values: [v, cd.values[1] ?? '500'] })} />
        <Tok label="مبلغ" k="n" value={cd.values[1] ?? '500'} options={AMOUNTS} onChange={(v) => onChange({ field: f, values: [cd.values[0] ?? 'gt', v] })} />
      </>) : (
        <span className={c('vals')} role="group" aria-label={l}>
          {vals.map(([v, n]) => <button key={v} type="button" aria-pressed={cd.values.includes(v)} className={c('tok', cd.values.includes(v) ? 'on' : 'n', 'nv')} onClick={() => { const has = cd.values.includes(v); const nv = has ? cd.values.filter((x) => x !== v) : [...cd.values, v]; if (nv.length) onChange({ field: f, values: nv }); }}>{n}</button>)}
        </span>
      )}
      {onRemove ? <button className={c('ib')} type="button" aria-label="حذف شرط" onClick={onRemove}><I n="x" /></button> : null}
    </span>
  );
}

function MethodEd({ lvl, m, names, onChange, fallback }: { lvl: 'team' | 'member'; m: Method; names: [string, string][]; onChange: (m: Method) => void; fallback?: boolean }) {
  const list = (lvl === 'team' ? METHODS_TEAM : METHODS_MEMBER).filter(([k]) => !(fallback && k === 'direct'));
  const even = (ids: string[]) => ids.map((id, i) => ({ id, weight: Math.floor(100 / ids.length) + (i === 0 ? 100 % ids.length : 0) }));
  const change = (k: Method['method']) => onChange({ method: k, targets: k === 'direct' ? names.slice(0, 1).map(([id]) => ({ id })) : k === 'ratio' ? names.map(([id], i) => ({ id, weight: i === 0 ? 2 : 1 })) : k === 'percent' ? even(names.map(([id]) => id)) : [] });
  return (
    <>
      <Tok label="روش" k="g" value={m.method} options={list} onChange={change} />
      {m.method === 'direct' ? <Tok label="به" k="g" value={m.targets[0]?.id ?? ''} options={names} onChange={(v) => onChange({ method: 'direct', targets: [{ id: v }] })} /> : null}
      {m.method === 'ratio' || m.method === 'percent' ? names.map(([id, n]) => { const w = m.targets.find((x) => x.id === id)?.weight ?? 0; return (
        <span key={id} className={c('cond')}><span className={c('hint')}>{n}</span>
          <Stp label={`سهم ${n}`} value={w} min={m.method === 'ratio' ? 1 : 0} max={m.method === 'ratio' ? 10 : 100} step={m.method === 'ratio' ? 1 : 5} fmt={(v) => (m.method === 'percent' ? `${fa(v)}٪` : fa(v))}
            onChange={(v) => onChange({ method: m.method, targets: names.map(([x]) => ({ id: x, weight: x === id ? v : m.targets.find((y) => y.id === x)?.weight ?? 0 })) })} />
        </span>); }) : null}
    </>
  );
}
