// v1.2 «مدیریت فروش»: the options that lived only on the old pages (merge-v1.2.md §2), now editable here (Mohammad t358s1318 §2).
// Values are the live ones, read through the old pages' own functions; «ذخیره» goes through the old pages' own validators and savers
// (same tables, same log rows) plus one history row, so «برگرداندن» in the toast or in «تاریخچه» puts the rows back exactly.
// None of these blocks writes notification_settings / team_sales_config.
import { useState, type ReactNode } from 'react';
import type { FoldKey, MergeState } from './api';
import { useMerge } from './merge-ctx';
import { useEffect, useRef } from 'react';
import { c, clone, fa, I, Chip, Pick, Seg, Stp, Tgl } from './ui';
/** «چهارشنبه ۲۷ آبان»: Jalali, Persian digits, never Gregorian (exact, t360s1344). */
const jDay = (iso: string) => {
  const d = new Date(iso + 'T12:00:00+03:30'); const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', { timeZone: 'Asia/Tehran', ...o }).format(d).replace(/[٠-٩]/g, (x) => '۰۱۲۳۴۵۶۷۸۹'['٠١٢٣٤٥٦٧٨٩'.indexOf(x)]!);
  try { return fmt({ weekday: 'long', day: 'numeric', month: 'long' }); } catch { return ''; }
};
/** Armita review (13b): an opened form scrolls itself above the dock + unsaved bar (scroll-margin-bottom in smc.css). */
const useLift = (on: unknown) => { const r = useRef<HTMLDivElement>(null); useEffect(() => { if (on) requestAnimationFrame(() => r.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })); }, [on]); return r; };

const RO = () => <p className={c('hint ro')}><I n="lock" />مقدار زنده، فقط نمایش.</p>;
const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className={c('mrow')}><span className={c('lbl')}>{k}</span><b>{children}</b></div>;
const Fld = ({ k, children }: { k: string; children: ReactNode }) => <div className={c('mrow ed')}><span className={c('lbl')}>{k}</span><span className={c('mctl')}>{children}</span></div>;
const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className={c('mblock')} data-testid="sam-block"><h3>{title}</h3>{children}<RO /></div>
);
const teamName = (m: MergeState, id: number) => m.values.teams.find((t) => t.id === id)?.name ?? `تیم ${fa(id)}`;

/** One folded block: view ↔ edit. Shows «ویرایش» only to who may write (the old pages' check AND this page's access). */
function EditBlock<T>({ fk, title, init, view, form, body, okMsg }: {
  fk: FoldKey; title: string; init: T; view: ReactNode; form: (d: T, set: (d: T) => void) => ReactNode; body: (d: T) => unknown; okMsg: string;
}) {
  const mg = useMerge(); const [d, setD] = useState<T | null>(null);
  const can = Boolean(mg?.m.canWriteFolded);
  const lift = useLift(d ? fk : null);
  return (
    <div className={c('mblock', d && 'editing')} data-testid={`sam-block-${fk}`}>
      <div className={c('mbh')}>
        <h3>{title}</h3><span className={c('sp')} />
        {can && !d ? <button className={c('btn gh')} type="button" data-testid={`sam-edit-${fk}`} onClick={() => setD(clone(init))}><I n="edit" />ویرایش</button> : null}
      </div>
      {d ? (
        <>
          {form(d, (x) => setD(clone(x)))}
          <div className={c('row1 mact lift')} ref={lift}>
            <span className={c('sp')} />
            <button className={c('btn gh')} type="button" onClick={() => setD(null)}>لغو</button>
            <button className={c('btn pri')} type="button" data-testid={`sam-save-${fk}`} disabled={mg?.saving === fk} onClick={async () => { if (mg && await mg.save(fk, body(d), okMsg)) setD(null); }}>ذخیره</button>
          </div>
        </>
      ) : view}
      {!can ? <RO /> : null}
    </div>
  );
}

/* ---------------- لیست روزانه و ظرفیت ---------------- */
export function MergeDaily({ m }: { m: MergeState }) {
  const d = m.values.daily;
  return (
    <>
      <EditBlock fk="daily" title="ظرفیت و تنظیمات لیست روزانه (از «لیست‌های روزانه»)" init={d} okMsg="تنظیمات لیست روزانه ذخیره شد. در تاریخچه ثبت شد."
        body={(x) => x}
        view={<>
          <Row k="حد تغییر ظرفیت در روز">{fa(d.guardPct)}٪</Row>
          <Row k="مهلت کار تکمیلی">{fa(d.waitMin)} دقیقه</Row>
          <Row k="ظرفیت روز اول">{d.firstDayCapacity == null ? 'خودکار' : `${fa(d.firstDayCapacity)} کار`}</Row>
        </>}
        form={(x, set) => <>
          <Fld k="حد تغییر ظرفیت در روز"><Stp label="حد تغییر ظرفیت" value={x.guardPct} min={0} max={100} step={5} fmt={(v) => `${fa(v)}٪`} onChange={(v) => set({ ...x, guardPct: v })} /></Fld>
          <Fld k="مهلت کار تکمیلی"><Stp label="مهلت کار تکمیلی" value={x.waitMin} min={0} max={240} step={5} fmt={(v) => `${fa(v)} دقیقه`} onChange={(v) => set({ ...x, waitMin: v })} /></Fld>
          <Fld k="ظرفیت روز اول">
            <Tgl on={x.firstDayCapacity == null} onClick={() => set({ ...x, firstDayCapacity: x.firstDayCapacity == null ? 10 : null })}>خودکار</Tgl>
            {x.firstDayCapacity != null ? <Stp label="ظرفیت روز اول" value={x.firstDayCapacity} min={1} max={60} fmt={(v) => `${fa(v)} کار`} onChange={(v) => set({ ...x, firstDayCapacity: v })} /> : null}
          </Fld>
        </>} />
      <CapacityBlock m={m} />
    </>
  );
}
type CapPreview = { preview: { previous: number | null; capacity: number; outOfGuard: boolean; label: string | null; guard: { maxAllowed: number | null; minAllowed: number | null } } };
function CapacityBlock({ m }: { m: MergeState }) {
  const mg = useMerge(); const cap = m.capacity;
  const [sp, setSp] = useState<number | null>(null); const [n, setN] = useState(10); const [reason, setReason] = useState(''); const [pv, setPv] = useState<CapPreview['preview'] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lift = useLift(sp != null ? `${sp}-${pv ? 1 : 0}-${err ?? ''}` : null);
  if (!cap.day || !cap.experts.length) return null;
  const can = Boolean(mg?.m.canWriteFolded);
  const pick = (id: number) => { const e = cap.experts.find((x) => x.salespersonId === id); setSp(id); setN(e?.capacity ?? 10); setPv(null); setErr(null); };
  const ask = async (confirm: boolean) => {
    if (!mg || sp == null) return;
    if (!reason.trim()) { setErr('دلیل را بنویسید.'); return; }
    setErr(null);
    if (!confirm) {
      try {
        const r = await fetch('/api/sales-admin/merge/section/capacity', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salespersonId: sp, date: cap.day, capacity: n, reason }) });
        const j = await r.json(); if (!r.ok) { setErr(j.message ?? 'نشد.'); return; } setPv((j as CapPreview).preview);
      } catch { setErr('اتصال برقرار نشد.'); }
      return;
    }
    if (await mg.save('capacity', { salespersonId: sp, date: cap.day, capacity: n, reason, confirm: true }, 'ظرفیت ذخیره شد. در تاریخچه ثبت شد.')) { setSp(null); setPv(null); setReason(''); }
  };
  return (
    <div className={c('mblock')} data-testid="sam-block-capacity">
      <div className={c('mbh')}><h3>ظرفیت کارشناس‌ها برای {cap.day ? <span>{jDay(cap.day)}</span> : null}</h3></div>
      {cap.experts.map((e) => (
        <div key={e.salespersonId} className={c('mrow')}>
          <span className={c('lbl')}>{e.name}</span><b>{e.capacity == null ? 'تنظیم نشده' : `${fa(e.capacity)} کار`}</b>
          {can ? <button className={c('btn lk')} type="button" onClick={() => pick(e.salespersonId)}>تغییر</button> : null}
        </div>
      ))}
      {sp != null ? (
        <div className={c('mvc lift')} data-testid="sam-capacity-form" ref={lift}>
          <b>ظرفیت تازه‌ی {cap.experts.find((x) => x.salespersonId === sp)?.name}</b>
          <Fld k="ظرفیت"><Stp label="ظرفیت" value={n} min={0} max={60} fmt={(v) => `${fa(v)} کار`} onChange={(v) => { setN(v); setPv(null); }} /></Fld>
          <label className={c('mrow ed')}><span className={c('lbl')}>دلیل</span><input className={c('inp')} value={reason} maxLength={200} placeholder="مثلاً مرخصی نیم‌روز" onChange={(e) => { setReason(e.target.value); setPv(null); }} /></label>
          {pv ? <p className={c('hint')} role="status">{fa(String(pv.previous ?? '—'))} ← {fa(pv.capacity)} کار{pv.outOfGuard ? `؛ ${pv.label ?? 'خارج از حد'} (مدیرها خبردار می‌شوند)` : '؛ در حد مجاز'}</p> : null}
          {err ? <p className={c('err')} role="alert">{err}</p> : null}
          <div className={c('row1')}><span className={c('sp')} />
            <button className={c('btn gh')} type="button" onClick={() => setSp(null)}>لغو</button>
            {pv ? <button className={c('btn pri')} type="button" disabled={mg?.saving === 'capacity'} onClick={() => void ask(true)}>تأیید و ثبت</button>
              : <button className={c('btn pri')} type="button" onClick={() => void ask(false)}>بررسی</button>}
          </div>
        </div>
      ) : null}
      {!can ? <RO /> : null}
    </div>
  );
}

/* ---------------- مدل لیست و صف تماس ---------------- */
export function MergeModel({ m }: { m: MergeState }) {
  const q = m.values.queue; const a = m.values.assist;
  const init = { queue: q, assist: { levels: { ...a.settings.levels }, snoozeHours: a.settings.snoozeHours ?? 3 }, p1: { quota: a.p1.quota, redDays: a.p1.redDays } };
  return (
    <>
      <EditBlock fk="model" title="صف تماس و وزن دستیار فروش (از «تنظیمات صف تماس» و «تنظیمات دستیار فروش»)" init={init} okMsg="صف تماس و وزن دستیار ذخیره شد. در تاریخچه ثبت شد."
        body={(x) => x}
        view={<>
          <Row k="ترتیب گروه‌ها">{q.order.map((g, i) => `${fa(i + 1)}. ${m.labels.queueGroups[g] ?? g}`).join('، ')}</Row>
          <Row k="قرمز شدن «جدید» بعد از">{fa(q.newRedHours)} ساعت</Row>
          <Row k="روز بی‌تماس اولویت ۱">{fa(q.p1StaleDays)} روز</Row>
          <div className={c('mrow col')}><span className={c('lbl')}>متن آماده‌ی بله «جواب نداد»</span><q className={c('tmpl')}>{fa(q.naTemplate)}</q></div>
          <div className={c('wgrid')}>
            {Object.entries(m.labels.signals).map(([k, l]) => <Row key={k} k={l}>{fa(a.settings.levels?.[k] ?? 0)} از ۱۰</Row>)}
          </div>
          <Row k="سهمیه‌ی اولویت ۱ در روز">{fa(a.p1.quota)}</Row>
          <Row k="روز بی‌تماس تا قرمز">{fa(a.p1.redDays)} روز</Row>
        </>}
        form={(x, set) => <>
          <div className={c('mrow col ed')}><span className={c('lbl')}>ترتیب گروه‌ها</span>
            <ol className={c('ord')}>{x.queue.order.map((g, i) => (
              <li key={g}><span>{fa(i + 1)}. {m.labels.queueGroups[g] ?? g}</span><span className={c('sp')} />
                <button className={c('ib')} type="button" aria-label={`بالا بردن ${m.labels.queueGroups[g] ?? g}`} disabled={i === 0} onClick={() => { const o = [...x.queue.order]; [o[i - 1], o[i]] = [o[i]!, o[i - 1]!]; set({ ...x, queue: { ...x.queue, order: o } }); }}><I n="up" /></button>
                <button className={c('ib')} type="button" aria-label={`پایین بردن ${m.labels.queueGroups[g] ?? g}`} disabled={i === x.queue.order.length - 1} onClick={() => { const o = [...x.queue.order]; [o[i + 1], o[i]] = [o[i]!, o[i + 1]!]; set({ ...x, queue: { ...x.queue, order: o } }); }}><I n="down" /></button>
              </li>))}</ol>
          </div>
          <Fld k="قرمز شدن «جدید» بعد از"><Stp label="ساعت قرمز شدن" value={x.queue.newRedHours} min={1} max={168} fmt={(v) => `${fa(v)} ساعت`} onChange={(v) => set({ ...x, queue: { ...x.queue, newRedHours: v } })} /></Fld>
          <Fld k="روز بی‌تماس اولویت ۱"><Stp label="روز بی‌تماس" value={x.queue.p1StaleDays} min={1} max={60} fmt={(v) => `${fa(v)} روز`} onChange={(v) => set({ ...x, queue: { ...x.queue, p1StaleDays: v } })} /></Fld>
          <label className={c('mrow col ed')}><span className={c('lbl')}>متن آماده‌ی بله «جواب نداد»</span>
            <textarea className={c('inp ta')} rows={3} maxLength={500} value={x.queue.naTemplate} onChange={(e) => set({ ...x, queue: { ...x.queue, naTemplate: e.target.value } })} /></label>
          <div className={c('wgrid')}>
            {Object.entries(m.labels.signals).map(([k, l]) => <Fld key={k} k={l}><Stp label={l} value={x.assist.levels[k] ?? 0} min={0} max={10} onChange={(v) => set({ ...x, assist: { ...x.assist, levels: { ...x.assist.levels, [k]: v } } })} /></Fld>)}
          </div>
          <Fld k="پنهان ماندن پیشنهاد"><Seg label="پنهان ماندن" value={String(x.assist.snoozeHours)} options={[['1', '۱ ساعت'], ['3', '۳ ساعت'], ['0', 'تا فردا']]} onChange={(v) => set({ ...x, assist: { ...x.assist, snoozeHours: Number(v) } })} /></Fld>
          <Fld k="سهمیه‌ی اولویت ۱ در روز"><Stp label="سهمیه‌ی اولویت ۱" value={x.p1.quota} min={0} max={50} onChange={(v) => set({ ...x, p1: { ...x.p1, quota: v } })} /></Fld>
          <Fld k="روز بی‌تماس تا قرمز"><Stp label="روز تا قرمز" value={x.p1.redDays} min={1} max={60} fmt={(v) => `${fa(v)} روز`} onChange={(v) => set({ ...x, p1: { ...x.p1, redDays: v } })} /></Fld>
        </>} />
    </>
  );
}

/* ---------------- تقسیم: درصد تیم‌ها (نمایش) + مالک پیش‌فرض مشتری (ویرایش) ---------------- */
export function MergeDist({ m }: { m: MergeState }) {
  const o = m.values.defaultOwner; const seller = (id: number | null) => (id != null ? m.labels.sellers[String(id)] ?? `کارشناس ${fa(id)}` : '—');
  const src = (s: 'new_customers' | 'site_leads') => m.values.intake.filter((x) => x.source === s).map((x) => `${teamName(m, x.teamId)} ${fa(x.percent)}٪`).join('، ');
  const regName = (id: number) => m.labels.registrars.find((r) => r.id === id)?.name ?? `کاربر ${fa(id)}`;
  const init = { config: { enabled: o.enabled, ownerSalespersonId: o.ownerSalespersonId ?? 6, registrarMode: o.registrarMode, registrarUserIds: o.registrarUserIds, sourceMode: o.sourceMode, sources: o.sources },
    dsb: { ...m.values.defaultSourceBySeller } as Record<string, string>, dsbTouched: false };
  const conv = m.conversion;
  return (
    <>
      <Block title="درصد پیش‌فرض بین تیم‌ها (از «تیم‌های فروش»)">
        <Row k="مشتری جدید">{src('new_customers') || '—'}</Row>
        <Row k="لید فرم سایت">{src('site_leads') || '—'}</Row>
      </Block>
      <EditBlock fk="owner" title="مالک پیش‌فرض مشتری (از «قانون ثبت مشتری»)" init={init} okMsg="مالک پیش‌فرض مشتری ذخیره شد. در تاریخچه ثبت شد."
        body={(x) => ({ config: x.config, ...(x.dsbTouched ? { defaultSourceBySeller: x.dsb } : {}) })}
        view={<>
          <Row k="وضعیت">{o.enabled ? <Chip k="b">روشن</Chip> : <Chip k="g">خاموش</Chip>}</Row>
          <Row k="کارشناس مقصد">{seller(o.ownerSalespersonId)}</Row>
          <Row k="ثبت‌کننده‌ها">{o.registrarMode === 'all' ? 'همه' : o.registrarNames.join('، ') || '—'}</Row>
          <Row k="منبع ورود">{o.sourceMode === 'all' ? 'همه' : o.sources.map((s) => m.labels.regSources[s] ?? s).join('، ') || '—'}</Row>
          <div className={c('mrow col')}><span className={c('lbl')}>منبع پیش‌فرض فرم ثبت</span>
            <b>{Object.keys(m.values.defaultSourceBySeller).length ? Object.entries(m.values.defaultSourceBySeller).map(([sp, s]) => `${m.labels.sellers[sp] ?? `کارشناس ${fa(sp)}`}: ${m.labels.leadSources[s] ?? s}`).join('، ') : 'برای هیچ کارشناسی تعیین نشده'}</b></div>
          {conv.applicable ? (
            <div className={c('conv')} data-testid="sam-conversion">
              <b>طبق تصمیم محمد، این قانون جدا حذف و به قانون تقسیم تبدیل می‌شود:</b>
              <p>«اگر ثبت‌کننده {o.registrarMode === 'all' ? 'هر کسی' : o.registrarNames.join(' یا ')} و منبع {o.sourceMode === 'all' ? 'هر منبعی' : o.sources.map((s) => m.labels.regSources[s] ?? s).join(' یا ')} باشد → مستقیم به {seller(o.ownerSalespersonId)}»، قانون ۱ بین تیم‌ها و قانون ۱ داخل تیمش.</p>
              {conv.blockers.length
                ? <p className={c('hint')}>هنوز اعمال نمی‌شود: {conv.blockers[0]}</p>
                : <p className={c('hint')}><I n="rf" />{fa(conv.parity?.cases ?? 0)} حالت ثبت بررسی شد؛ همه به همان کارشناس امروز می‌رسند.</p>}
            </div>
          ) : null}
        </>}
        form={(x, set) => <>
          <Fld k="وضعیت"><Tgl on={x.config.enabled} onClick={() => set({ ...x, config: { ...x.config, enabled: !x.config.enabled } })}>{x.config.enabled ? 'روشن' : 'خاموش'}</Tgl></Fld>
          <label className={c('mrow ed')}><span className={c('lbl')}>کارشناس مقصد</span>
            <select className={c('tok n sel')} aria-label="کارشناس مقصد" value={x.config.ownerSalespersonId} onChange={(e) => set({ ...x, config: { ...x.config, ownerSalespersonId: Number(e.target.value) } })}>
              {m.labels.activeSellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <Fld k="ثبت‌کننده‌ها"><Seg label="ثبت‌کننده‌ها" value={x.config.registrarMode} options={[['all', 'همه'], ['selected', 'فقط این‌ها']]} onChange={(v) => set({ ...x, config: { ...x.config, registrarMode: v } })} /></Fld>
          {x.config.registrarMode === 'selected' ? <div className={c('picks')}>{m.labels.registrars.map((r) => (
            <Pick key={r.id} on={x.config.registrarUserIds.includes(r.id)} label={regName(r.id)} onClick={() => set({ ...x, config: { ...x.config, registrarUserIds: x.config.registrarUserIds.includes(r.id) ? x.config.registrarUserIds.filter((y) => y !== r.id) : [...x.config.registrarUserIds, r.id] } })}>{r.name}</Pick>))}</div> : null}
          <Fld k="منبع ورود"><Seg label="منبع ورود" value={x.config.sourceMode} options={[['all', 'همه'], ['selected', 'فقط این‌ها']]} onChange={(v) => set({ ...x, config: { ...x.config, sourceMode: v } })} /></Fld>
          {x.config.sourceMode === 'selected' ? <div className={c('picks')}>{Object.entries(m.labels.regSources).map(([k, l]) => (
            <Pick key={k} on={x.config.sources.includes(k)} onClick={() => set({ ...x, config: { ...x.config, sources: x.config.sources.includes(k) ? x.config.sources.filter((y) => y !== k) : [...x.config.sources, k] } })}>{l}</Pick>))}</div> : null}
          <div className={c('mrow col ed')}><span className={c('lbl')}>منبع پیش‌فرض فرم ثبت</span>
            {Object.entries(x.dsb).map(([sp, s]) => (
              <div key={sp} className={c('row1')}><span>{m.labels.sellers[sp] ?? `کارشناس ${fa(sp)}`}</span><span className={c('sp')} />
                <select className={c('tok n sel')} aria-label={`منبع پیش‌فرض ${m.labels.sellers[sp] ?? sp}`} value={s} onChange={(e) => set({ ...x, dsbTouched: true, dsb: { ...x.dsb, [sp]: e.target.value } })}>
                  {Object.entries(m.labels.leadSources).filter(([k]) => k !== 'other').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button className={c('ib')} type="button" aria-label={`حذف ${m.labels.sellers[sp] ?? sp}`} onClick={() => { const n = { ...x.dsb }; delete n[sp]; set({ ...x, dsbTouched: true, dsb: n }); }}><I n="trash" /></button>
              </div>))}
            <select className={c('tok n sel')} aria-label="افزودن کارشناس" value="" onChange={(e) => { if (e.target.value) set({ ...x, dsbTouched: true, dsb: { ...x.dsb, [e.target.value]: 'instagram' } }); }}>
              <option value="">افزودن کارشناس…</option>
              {m.labels.activeSellers.filter((s) => !(String(s.id) in x.dsb)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </>} />
    </>
  );
}

/* ---------------- نظم پیگیری و تحویل ---------------- */
export function MergeDiscipline({ m }: { m: MergeState }) {
  const d = m.values.discipline; const recv = (id: number) => m.labels.receivers[String(id)] ?? `کارشناس ${fa(id)}`;
  const n = (x: typeof d, set: (v: typeof d) => void, k: keyof typeof d, label: string, min: number, max: number, unit = '') =>
    <Fld k={label}><Stp label={label} value={x[k] as number} min={min} max={max} fmt={(v) => `${fa(v)}${unit}`} onChange={(v) => set({ ...x, [k]: v })} /></Fld>;
  return (
    <EditBlock fk="discipline" title="آستانه‌ها و بررسی تحویل (از «نظم پیگیری تیم»)" init={d} okMsg="نظم پیگیری و تحویل ذخیره شد. در تاریخچه ثبت شد."
      body={(x) => x}
      view={<>
        <Row k="پنجره‌ی به‌موقع">{fa(d.onTimeMin)} تا {fa(d.onTimeCapMin)} دقیقه</Row>
        <Row k="حد گزارش مشتری جدید">{fa(d.newPct)}٪، حداکثر {fa(d.newMaxOverdue)} عقب‌افتاده</Row>
        <Row k="حد عقب‌افتاده برای محدودیت">{fa(d.restrictOverdue)}</Row>
        <Row k="هشدار بعد از">{fa(d.alertDays)} روز</Row>
        <Row k="وزن‌ها">گزارش {fa(d.wReport)}، عقب‌افتاده {fa(d.wOverdue)}، بی‌تماس {fa(d.wNocall)}</Row>
        <Row k="افت تماس">{fa(d.dropPct)}٪</Row>
        <Row k="بررسی تحویل مشتری">{d.transferMode === 'block' ? 'جلوگیری' : 'فقط هشدار'}</Row>
        <Row k="مشتری نمی‌گیرند">{d.excludedReceivers.map(recv).join('، ') || '—'}</Row>
      </>}
      form={(x, set) => <>
        {n(x, set, 'onTimeMin', 'پنجره‌ی به‌موقع از', 1, 120, ' دقیقه')}
        {n(x, set, 'onTimeCapMin', 'پنجره‌ی به‌موقع تا', 1, 120, ' دقیقه')}
        {n(x, set, 'newPct', 'حد گزارش مشتری جدید', 1, 100, '٪')}
        {n(x, set, 'newMaxOverdue', 'حداکثر عقب‌افتاده', 0, 100)}
        {n(x, set, 'restrictOverdue', 'حد عقب‌افتاده برای محدودیت', 1, 200)}
        {n(x, set, 'alertDays', 'هشدار بعد از', 1, 10, ' روز')}
        {n(x, set, 'wReport', 'وزن گزارش', 0, 100)}
        {n(x, set, 'wOverdue', 'وزن عقب‌افتاده', 0, 100)}
        {n(x, set, 'wNocall', 'وزن بی‌تماس', 0, 50)}
        {n(x, set, 'dropPct', 'افت تماس', 1, 100, '٪')}
        <Fld k="بررسی تحویل مشتری"><Seg label="بررسی تحویل" value={x.transferMode} options={[['warn', 'فقط هشدار'], ['block', 'جلوگیری']]} onChange={(v) => set({ ...x, transferMode: v })} /></Fld>
        <div className={c('mrow col ed')}><span className={c('lbl')}>مشتری نمی‌گیرند</span>
          <div className={c('picks')}>{m.labels.activeSellers.map((s) => (
            <Pick key={s.id} on={x.excludedReceivers.includes(s.id)} onClick={() => set({ ...x, excludedReceivers: x.excludedReceivers.includes(s.id) ? x.excludedReceivers.filter((y) => y !== s.id) : [...x.excludedReceivers, s.id] })}>{s.name}</Pick>))}</div></div>
      </>} />
  );
}
export function MergeBanner({ m }: { m: MergeState }) {
  return (
    <div className={c('mbanner', m.parity.ok ? 'ok' : 'warn')} role="status" data-testid="sam-parity">
      <I n={m.parity.ok ? 'rf' : 'lock'} />
      <span>{m.parity.ok
        ? `مقدارهای صفحه‌های قدیم ${m.importedAtFa ? `${m.importedAtFa} ` : ''}به این صفحه منتقل شد و با مقدار زنده یکی است.`
        : `${fa(m.parity.diffs.length)} مقدار با زمان انتقال فرق دارد؛ صفحه مقدار زنده را نشان می‌دهد.`}</span>
    </div>
  );
}
