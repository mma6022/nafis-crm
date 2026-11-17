// بخش ۲ — لیست روزانه‌ی کارشناس‌ها (§3.1). The list is the live «کارهای امروز» engine; the manager only adds, removes or moves.
import { useEffect, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectionProps } from '../SalesManagerConsolePage';
import { smcApi, type Block, type DailyDoc, type DailyOp, type Queue, type QRow } from '../api';
import { c, clone, fa, hm, I, Chip, Pick, Seg, Stp, TY, TyLabel, Dot, relDay, addDays } from '../ui';

const SRC: Record<QRow["source"], ReactElement> = {
  urgent: <Chip k="lock"><I n="lock" />فوری، خودکار</Chip>, system: <Chip>سیستم</Chip>, manual: <Chip k="g">دستی</Chip>, moved: <Chip k="g">جابه‌جا شده</Chip>, removed: <Chip k="r">حذف‌شده</Chip>,
};
export function DailySection({ st, doc, docs, set }: SectionProps<'daily'>) {
  const experts = docs.teams.experts.filter((e) => e.teamId && e.status !== 'inactive');
  // v1.2: /daily-plans/expert/:sp/:date and /daily-plans/capacity/:sp land here as ?expert=&date= / ?capacity= (merge-v1.2.md §4)
  const [who, setWho] = useState(() => { const q = new URLSearchParams(location.search); const sp = Number(q.get('expert') ?? q.get('capacity'));
    return (sp ? experts.find((e) => e.salespersonId === sp)?.id : undefined) ?? experts[0]?.id ?? ''; });
  const [date, setDate] = useState(() => { const d = new URLSearchParams(location.search).get('date'); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= st.today ? d : addDays(st.today, 1); });
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [editBlocks, setEditBlocks] = useState(false);
  const ops = doc.ops ?? [];
  const opsKey = JSON.stringify(ops);
  const all = useQuery({
    queryKey: ['smc-queue', date, opsKey, JSON.stringify(doc.blocks), JSON.stringify(st.meta)],
    queryFn: async () => Object.fromEntries(await Promise.all(experts.map(async (e) => [e.id, await smcApi<Queue>('/queue', { method: 'POST', body: { expert: e.id, date, daily: { blocks: doc.blocks, ops } } })] as const))) as Record<string, Queue>,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
  const q = all.data?.[who];
  const exp = experts.find((e) => e.id === who);
  const upd = (fn: (d: DailyDoc) => void, n = 1) => { const d = clone(doc); d.ops = d.ops ?? []; fn(d); set(d, n); };
  const pushOp = (o: DailyOp) => upd((d) => {
    // a newer move/remove of the same customer that day replaces the older draft one
    d.ops = d.ops!.filter((x) => !(x.expertId === o.expertId && x.date === o.date && x.customerId === o.customerId && (o.op === 'move' ? x.op === 'move' : o.op === 'remove' ? x.op === 'move' || x.op === 'remove' : false)));
    d.ops.push(o);
  });
  useEffect(() => { if (!menu) return; const k = () => setMenu(null); const t = setTimeout(() => addEventListener('click', k), 0); return () => { clearTimeout(t); removeEventListener('click', k); }; }, [menu]);

  const rows = q?.rows ?? [];
  const blocks = q?.blocks ?? [];
  let n = 0;
  const posInBlock = (r: QRow) => rows.filter((x) => x.blockIdx === r.blockIdx && !x.locked && x.source !== 'removed').findIndex((x) => x.key === r.key);
  const move = (r: QRow, dir: -1 | 1) => {
    const inB = rows.filter((x) => x.blockIdx === r.blockIdx && !x.locked && x.source !== 'removed'); const i = posInBlock(r);
    if (r.customerId == null) return;
    if (i + dir >= 0 && i + dir < inB.length) pushOp({ op: 'move', expertId: who, date, customerId: r.customerId, blockIdx: r.blockIdx, sort: i + dir });
    else if (r.blockIdx + dir >= 0 && r.blockIdx + dir < blocks.length) pushOp({ op: 'move', expertId: who, date, customerId: r.customerId, blockIdx: r.blockIdx + dir, sort: dir < 0 ? 999 : 0 });
  };
  const live = rows.filter((r) => r.source !== 'removed');
  const firstKey = live.find((r) => !r.locked)?.key; const lastKey = [...live].reverse().find((r) => !r.locked)?.key;
  const restore = (r: QRow) => {
    if (r.customerId == null) return;
    if (r.draft) upd((d) => { d.ops = d.ops!.filter((x) => !(x.expertId === who && x.date === date && x.customerId === r.customerId && x.op === 'remove')); });
    else pushOp({ op: 'restore', expertId: who, date, customerId: r.customerId, ref: r.overrideId ?? undefined });
  };
  const qrow = (r: QRow) => {
    const del = r.source === 'removed'; if (!del) n++;
    const cls = r.locked ? 'urg' : r.source === 'manual' ? 'man' : r.source === 'moved' ? 'mv' : del ? 'del' : '';
    const mk = `${r.key}`;
    return (
      <div key={r.key} className={c('qr', cls, r.overCapacity && 'ov')}>
        <span className={c('no')}>{del ? '–' : fa(n)}</span>
        <TyLabel t={r.type === 'cold' ? 'fu' : r.type} />
        <span className={c('who')}><b>{r.name}</b><small>{r.why}{r.overCapacity ? '، بیرون از ظرفیت مدل' : ''}{r.draft ? '، پیش‌نویس' : ''}</small></span>
        <span className={c('src')}>{SRC[r.source]}</span>
        <span className={c('acts')}>
          {del ? <button className={c('btn lk')} type="button" onClick={() => restore(r)}><I n="undo" />برگرداندن</button>
            : r.locked ? null : (<>
              <button className={c('ib')} type="button" aria-label="بالاتر" disabled={r.key === firstKey} onClick={() => move(r, -1)}><I n="up" /></button>
              <button className={c('ib')} type="button" aria-label="پایین‌تر" disabled={r.key === lastKey} onClick={() => move(r, 1)}><I n="down" /></button>
              <span className={c('rel')}>
                <button className={c('ib x2')} type="button" aria-label="جابه‌جایی زمان پیگیری" aria-expanded={menu === mk} onClick={() => setMenu(menu === mk ? null : mk)}><I n="clock" /></button>
                <button className={c('ib mo')} type="button" aria-label="زمان یا حذف" aria-expanded={menu === mk} onClick={() => setMenu(menu === mk ? null : mk)}><I n="more" /></button>
                {menu === mk ? <TimeMenu r={r} blocks={blocks} today={st.today} date={date} onOp={(o) => { pushOp({ ...o, expertId: who, date, customerId: r.customerId! }); setMenu(null); }} /> : null}
              </span>
              <button className={c('ib x2')} type="button" aria-label="حذف از لیست این روز" onClick={() => pushOp({ op: 'remove', expertId: who, date, customerId: r.customerId! })}><I n="x" /></button>
            </>)}
        </span>
      </div>
    );
  };
  const scopeBlocks = blocksScope(doc, who, exp?.teamId ?? null);
  return (
    <>
      <div className={c('row1')}>
        <span className={c('lbl')}>کارشناس</span>
        {experts.map((e) => <Pick key={e.id} on={e.id === who} onClick={() => setWho(e.id)} cnt={all.data?.[e.id] ? `${fa(all.data[e.id]!.count)} کار` : undefined}>{e.displayName}</Pick>)}
        <span className={c('sp')} />
        <span className={c('row1')} style={{ gap: 6 }}>
          <button className={c('ib')} type="button" aria-label="روز قبل" disabled={date <= st.today} onClick={() => setDate(addDays(date, -1))}><I n="up" style={{ transform: 'rotate(90deg)' }} /></button>
          <select className={c('pick sel')} aria-label="روز" value={date} onChange={(e) => setDate(e.target.value)}>
            {Array.from({ length: 15 }, (_, i) => addDays(st.today, i)).map((d) => <option key={d} value={d}>{relDay(st.today, d)}</option>)}
          </select>
          <button className={c('ib')} type="button" aria-label="روز بعد" disabled={date >= addDays(st.today, 14)} onClick={() => setDate(addDays(date, 1))}><I n="down" style={{ transform: 'rotate(90deg)' }} /></button>
        </span>
      </div>
      <div className={c('row1')} style={{ marginTop: 12 }}>
        {q?.model ? <Chip k="b">مدل: {q.model.name}</Chip> : <Chip>مدل: پیش‌فرض سیستم</Chip>}
        <span className={c('hint')}>{q?.model ? `ظرفیت ${fa(q.model.capacity)} کار؛ ` : ''}{fa(q?.count ?? 0)} کار چیده شده{q?.noAccount ? '؛ حساب کاربری وصل نیست' : ''}</span>
        <span className={c('sp')} />
        <button className={c('btn gh')} type="button" onClick={() => void all.refetch()}><I n="rf" />چیدن دوباره با مدل</button>
        <button className={c('btn gh')} type="button" onClick={() => setAdding(adding == null ? Math.max(0, blocks.findIndex((b) => b.k === 'potential')) : null)}><I n="plus" />افزودن مشتری</button>
      </div>
      {adding != null && adding >= 0 ? <AddCustomer blocks={blocks} at={adding} onAdd={(id, bi, atTime) => { pushOp({ op: 'add', expertId: who, date, customerId: id, blockIdx: bi, atTime }); setAdding(null); }} onClose={() => setAdding(null)} /> : null}
      <div className={c('h3')}>بازه‌های کاری <span className={c('hint')}>برای {exp?.displayName}</span></div>
      <div className={c('blocks')}>
        {blocks.map((b, i) => <span key={i} className={c('blk')}>{fa(b.from / 60 | 0)} تا {fa(b.to / 60 | 0)}<em className={c(b.k === 'actual' ? 'a' : 'p')}>{b.kindFa}</em></span>)}
        <button className={c('btn lk')} type="button" onClick={() => setEditBlocks(!editBlocks)}><I n="edit" />ویرایش بازه‌ها</button>
      </div>
      {editBlocks ? <BlockEditor doc={doc} who={who} whoName={exp?.displayName ?? ''} teamId={exp?.teamId ?? null} teamName={docs.teams.teams.find((t) => t.id === exp?.teamId)?.name ?? ''} current={scopeBlocks} onChange={(d) => set(d)} /> : null}
      <div className={c('row1')} style={{ marginTop: 14 }}><div className={c('legend')}>{Object.keys(TY).map((t) => <span key={t}><Dot t={t} />{TY[t]![0]}</span>)}</div></div>
      {all.isLoading ? <p className={c('hint')}>در حال چیدن لیست…</p> : null}
      {blocks.map((b, bi) => {
        const inB = rows.filter((r) => r.blockIdx === bi);
        return (
          <div key={bi} className={c('qgrp')}>
            <div className={c('qgh')}>{b.label}<Chip k={b.k === 'actual' ? 'ok' : 'b'}>{b.kindFa}</Chip><span className={c('hint')}>{fa(inB.filter((r) => r.source !== 'removed').length)} کار</span></div>
            {inB.length ? inB.map(qrow) : <div className={c('qr empty')}><span /><span className={c('hint')}>کاری در این بازه نیست</span></div>}
            <div className={c('qadd')}><button className={c('btn dash')} type="button" onClick={() => setAdding(bi)}><I n="plus" />افزودن مشتری به این بازه</button></div>
          </div>
        );
      })}
      {ops.length ? <p className={c('hint')}>{fa(ops.length)} تغییر دستی در پیش‌نویس؛ تا «ذخیره و اعمال» نزنید، لیست کارشناس عوض نمی‌شود.</p> : null}
    </>
  );
}

function TimeMenu({ r, blocks, today, date, onOp }: { r: QRow; blocks: (Block & { label: string })[]; today: string; date: string; onOp: (o: Omit<DailyOp, 'expertId' | 'date' | 'customerId'>) => void }) {
  const [mode, setMode] = useState<'menu' | 'time' | 'day'>('menu');
  const [t, setT] = useState(blocks[r.blockIdx]?.from ?? 600);
  const [day, setDay] = useState(addDays(date, 1));
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (mode === 'time') return (
    <div className={c('tmenu')} role="dialog" aria-label="ساعت دقیق" onClick={stop}>
      <Stp label="ساعت" value={t} min={blocks[0]?.from ?? 480} max={(blocks[blocks.length - 1]?.to ?? 1080) - 15} step={15} fmt={hm} onChange={setT} />
      <button type="button" onClick={() => { const bi = Math.max(0, blocks.findIndex((b) => t < b.to)); onOp({ op: 'move', blockIdx: bi, atTime: `${String(t / 60 | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }); }}><I n="clock" />ثبت ساعت</button>
    </div>
  );
  if (mode === 'day') return (
    <div className={c('tmenu')} role="dialog" aria-label="انتقال به روز دیگر" onClick={stop}>
      <select className={c('inp')} value={day} onChange={(e) => setDay(e.target.value)} aria-label="روز">
        {Array.from({ length: 14 }, (_, i) => addDays(today, i + 1)).filter((d) => d !== date).map((d) => <option key={d} value={d}>{relDay(today, d)}</option>)}
      </select>
      <button type="button" onClick={() => onOp({ op: 'remove', toDate: day, blockIdx: r.blockIdx })}><I n="cal" />انتقال</button>
    </div>
  );
  return (
    <div className={c('tmenu')} role="menu" onClick={stop}>
      <button role="menuitem" type="button" disabled={r.blockIdx <= 0} onClick={() => onOp({ op: 'move', blockIdx: r.blockIdx - 1, sort: 999 })}><I n="up" />یک بازه زودتر</button>
      <button role="menuitem" type="button" disabled={r.blockIdx >= blocks.length - 1} onClick={() => onOp({ op: 'move', blockIdx: r.blockIdx + 1, sort: 0 })}><I n="down" />یک بازه دیرتر</button>
      <button role="menuitem" type="button" onClick={() => setMode('time')}><I n="clock" />ساعت دقیق…</button>
      <button role="menuitem" type="button" onClick={() => setMode('day')}><I n="cal" />انتقال به روز دیگر…</button>
      <button role="menuitem" type="button" className={c('mo-only')} onClick={() => onOp({ op: 'remove' })}><I n="x" />حذف از لیست این روز</button>
    </div>
  );
}

function AddCustomer({ blocks, at, onAdd, onClose }: { blocks: (Block & { label: string })[]; at: number; onAdd: (id: number, bi: number, atTime: string | null) => void; onClose: () => void }) {
  const [text, setText] = useState(''); const [bi, setBi] = useState(at);
  useEffect(() => setBi(at), [at]);
  const res = useQuery({ queryKey: ['smc-cust', text], enabled: text.trim().length >= 2, queryFn: () => smcApi<{ rows: { id: number; name: string; owner: string }[] }>(`/customers/search?q=${encodeURIComponent(text.trim())}`), staleTime: 30_000 });
  return (
    <div className={c('bed')}>
      <div className={c('row1')}>
        <input className={c('inp')} style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="نام یا شماره‌ی مشتری" aria-label="جست‌وجوی مشتری" autoFocus />
        <select className={c('tok n sel')} value={bi} onChange={(e) => setBi(Number(e.target.value))} aria-label="بازه">{blocks.map((b, i) => <option key={i} value={i}>{b.label}</option>)}</select>
        <button className={c('ib')} type="button" aria-label="بستن" onClick={onClose}><I n="x" /></button>
      </div>
      {(res.data?.rows ?? []).map((r) => (
        <div key={r.id} className={c('br')}><b style={{ color: 'var(--ink)' }}>{r.name}</b><span className={c('hint')}>{r.owner}</span><span className={c('sp')} /><button className={c('btn gh')} type="button" onClick={() => onAdd(r.id, bi, null)}><I n="plus" />افزودن</button></div>
      ))}
      {text.trim().length >= 2 && res.data && !res.data.rows.length ? <p className={c('hint')}>مشتری‌ای پیدا نشد.</p> : null}
    </div>
  );
}

type Scope = 'expert' | 'team' | 'global';
function blocksScope(doc: DailyDoc, who: string, teamId: string | null): { scope: Scope; blocks: Block[] | null } {
  if (doc.blocks.expert[who]) return { scope: 'expert', blocks: doc.blocks.expert[who]! };
  if (teamId && doc.blocks.team[teamId]) return { scope: 'team', blocks: doc.blocks.team[teamId]! };
  return { scope: 'global', blocks: doc.blocks.global };
}
const SYS: Block[] = [{ from: 540, to: 660, k: 'actual' }, { from: 660, to: 780, k: 'potential' }, { from: 780, to: 960, k: 'actual' }, { from: 960, to: 1080, k: 'potential' }];
function BlockEditor({ doc, who, whoName, teamId, teamName, current, onChange }: { doc: DailyDoc; who: string; whoName: string; teamId: string | null; teamName: string; current: { scope: Scope; blocks: Block[] | null }; onChange: (d: DailyDoc) => void }) {
  const [scope, setScope] = useState<Scope>(current.scope);
  const list = (scope === 'expert' ? doc.blocks.expert[who] : scope === 'team' ? (teamId ? doc.blocks.team[teamId] : null) : doc.blocks.global) ?? current.blocks ?? SYS;
  const write = (bl: Block[] | null) => {
    const d = clone(doc);
    if (scope === 'expert') { if (bl) d.blocks.expert[who] = bl; else delete d.blocks.expert[who]; }
    else if (scope === 'team' && teamId) { if (bl) d.blocks.team[teamId] = bl; else delete d.blocks.team[teamId]; }
    else d.blocks.global = bl;
    onChange(d);
  };
  const edit = (i: number, p: Partial<Block>) => write(list.map((b, j) => (j === i ? { ...b, ...p } : b)));
  return (
    <div className={c('bed')}>
      <div className={c('row1')}><b style={{ color: 'var(--ink)' }}>ویرایش بازه‌ها</b><span className={c('sp')} />
        <Seg<Scope> label="دامنه" value={scope} options={[['expert', `فقط ${whoName}`], ['team', `کل ${teamName}`], ['global', 'همه‌ی تیم‌ها']] as [Scope, string][]} onChange={setScope} />
      </div>
      {list.map((b, i) => (
        <div key={i} className={c('br')}>
          <span className={c('lbl')}>از</span><Stp label="شروع بازه" value={b.from} min={i ? list[i - 1]!.to : 360} max={b.to - 30} step={30} fmt={hm} onChange={(v) => edit(i, { from: v })} />
          <span className={c('lbl')}>تا</span><Stp label="پایان بازه" value={b.to} min={b.from + 30} max={list[i + 1]?.from ?? 1320} step={30} fmt={hm} onChange={(v) => edit(i, { to: v })} />
          <Seg label="نوع بازه" value={b.k} options={[['actual', 'بالفعل'], ['potential', 'بالقوه'], ['any', 'همه']]} onChange={(v) => edit(i, { k: v })} />
          <button className={c('ib')} type="button" aria-label="حذف بازه" disabled={list.length <= 1} onClick={() => write(list.filter((_, j) => j !== i))}><I n="x" /></button>
        </div>
      ))}
      <div className={c('row1')}>
        <button className={c('btn dash')} type="button" disabled={(list[list.length - 1]?.to ?? 0) > 1260} onClick={() => { const l = list[list.length - 1]; const f = l ? l.to : 540; write([...list, { from: f, to: Math.min(1320, f + 60), k: 'any' }]); }}><I n="plus" />افزودن بازه</button>
        <span className={c('sp')} /><button className={c('btn lk')} type="button" onClick={() => write(null)}>بازگشت به پیش‌فرض</button>
      </div>
    </div>
  );
}
