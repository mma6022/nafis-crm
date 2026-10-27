/** «لیست‌های روزانه» for managers / admins (Armita v1.2 mg_* / cp_* / ad_set). Read-only lists; capacity override only with a reason; settings admin-only. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { BarChart3, ChevronRight, Eye, Lock, PencilLine, X } from 'lucide-react';
import { faClock, faNum } from '@/features/call-queue/api';
import { dpApi, STATE_FA, useDpConfig, type DpBoardExpert, type DpCapView, type DpOverride } from './api';
import './daily-plan.css';

const faDate = (ymd: string, opt: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', ...opt }).format(new Date(`${ymd}T12:00:00+03:30`));
const pct = (v: number | null | undefined) => v == null ? '—' : `${faNum(Math.round(v))}٪`;
function Gate({ children }: { children: (ok: true) => React.ReactNode }) {
  const c = useDpConfig().data;
  if (!c) return <div className="dp-page"><p role="status">در حال بارگذاری…</p></div>;
  if (!c.flags.daily_plan) return <div className="dp-page"><h1>لیست‌های روزانه</h1><p data-testid="dp-off">«کارهای امروز» هنوز فعال نشده است.</p></div>;
  if (!c.manager) return <div className="dp-page"><h1>لیست‌های روزانه</h1><p>فقط مدیر و ادمین.</p></div>;
  return <>{children(true)}</>;
}
const Tabs = ({ on }: { on: string }) => <nav className="dp-tabs" aria-label="بخش‌ها">
  {[['/daily-plans', 'لیست‌ها'], ['/daily-plans/report', 'گزارش مدیر'], ['/daily-plans/settings', 'تنظیمات']].map(([h, l]) => <Link key={h} href={h} className={on === h ? 'on' : ''} aria-current={on === h ? 'page' : undefined}>{l}</Link>)}
</nav>;

export function DpBoardPage() {
  return <Gate>{() => <Board />}</Gate>;
}
function Board() {
  const q = useQuery({ queryKey: ['daily-plan', 'board'], queryFn: () => dpApi.board(), refetchInterval: 60_000, retry: false });
  return <div className="dp-page wide" data-testid="dp-board">
    <header className="dp-page-h"><div><h1>لیست روزانه‌ی کارشناس‌ها</h1>{q.data ? <p>{faDate(q.data.day)} · {faClock(new Date().toISOString())}</p> : null}</div></header>
    <Tabs on="/daily-plans" />
    {q.isError ? <p className="dp-err" role="alert">بارگذاری نشد. <button type="button" onClick={() => void q.refetch()}>تلاش دوباره</button></p> : null}
    {q.data?.experts.length === 0 ? <div className="dp-box">کارشناسی با دستیار فعال نیست.</div> : null}
    <ul className="dp-board">{q.data?.experts.map((e) => <BoardRow key={e.salespersonId} e={e} day={q.data!.day} />)}</ul>
    <p className="dp-hint"><Lock size={12} aria-hidden="true" /> مدیر و ادمین لیست را می‌بینند ولی ترتیب و ردیف‌ها را عوض نمی‌کنند؛ تغییر از راه دستیار و API است.</p>
  </div>;
}
function BoardRow({ e, day }: { e: DpBoardExpert; day: string }) {
  const s = e.stats; const pc = s && s.main ? Math.round((s.mainDone / s.main) * 100) : 0;
  return <li className="dp-brow card" data-testid={`dp-brow-${e.salespersonId}`}>
    <div className="dp-who"><span className="dp-av">{e.name.slice(0, 1)}</span><div><b>{e.name}</b><small>دستیار: {e.assistant.name}{e.assistant.scope === 'p1' ? ' · فقط اولویت ۱' : ''}</small></div></div>
    <div className="dp-bmeta">{e.mode === 'auto' ? <span className="dp-chip l-auto">لیست خودکار</span> : e.mode ? <span className="dp-chip">نوشته‌ی {e.assistant.name}</span> : <span className="dp-chip muted">{STATE_FA[e.state] ?? e.state}</span>}
      <small>ظرفیت امروز: {e.capacity.capacity == null ? '—' : faNum(e.capacity.capacity)}{e.capacity.source === 'first_day' ? ' (روز اول)' : ''}{e.capacity.outOfGuard ? ' · خارج از حد' : ''}</small>
      {s?.backlog ? <span className="dp-chip warn">انباشت</span> : null}</div>
    <div className="dp-bprog">{s ? <><div className="dp-bar"><i style={{ width: `${pc}%` }} /></div>
      <small>{faNum(s.mainDone)} از {faNum(s.main)} انجام شد{s.extra ? ` · کار اضافه: ${faNum(s.extraDone)}` : ''}{s.outOfList ? ` · خارج از لیست: ${faNum(s.outOfList)}` : ''}{s.moved ? ` · جابه‌جایی: ${faNum(s.moved)}` : ''}</small></> : <small>—</small>}</div>
    <div className="dp-bnow">{e.current ? <><small>الان:</small> <b>{e.current.name}</b> <small>{e.current.typeLabel}</small></> : <small>{STATE_FA[e.state] ?? ''}</small>}</div>
    <div className="dp-bact"><Link href={`/daily-plans/expert/${e.salespersonId}/${day}`} className="btn btn-ghost" data-testid={`dp-view-${e.salespersonId}`}><Eye size={15} aria-hidden="true" /> دیدن لیست</Link>
      <Link href={`/daily-plans/capacity/${e.salespersonId}`} className="dp-link" data-testid={`dp-cap-${e.salespersonId}`}><BarChart3 size={15} aria-hidden="true" /> ظرفیت</Link></div>
  </li>;
}

export function DpExpertListPage() {
  return <Gate>{() => <ExpertList />}</Gate>;
}
function ExpertList() {
  const p = useParams<{ sp: string; date: string }>(); const sp = Number(p.sp);
  const q = useQuery({ queryKey: ['daily-plan', 'plan', sp, p.date], queryFn: () => dpApi.plan(sp, p.date), retry: false, refetchInterval: 60_000 });
  const e = q.data;
  return <div className="dp-page wide" data-testid="dp-expert-list">
    <Link href="/daily-plans" className="dp-back"><ChevronRight size={15} aria-hidden="true" /> همه‌ی کارشناس‌ها</Link>
    {q.isError ? <p className="dp-err" role="alert">{q.error instanceof Error ? q.error.message : 'بارگذاری نشد.'}</p> : null}
    {e ? <>
      <header className="dp-page-h"><div><h1>لیست {e.name} · {faDate(e.day)}</h1><p>{e.mode === 'auto' ? 'لیست خودکار' : e.mode ? `نوشته‌ی ${e.assistant.name}` : STATE_FA[e.state] ?? ''}{e.stats ? ` · ${faNum(e.stats.mainDone)} از ${faNum(e.stats.main)} انجام شد · ${pct(e.stats.completionPct)}` : ''}</p></div></header>
      <table className="dp-table"><thead><tr><th>#</th><th>مشتری</th><th>نوع</th><th>برچسب</th><th>بخش</th><th>وضعیت</th><th>جابه‌جایی</th><th>نتیجه</th></tr></thead>
        <tbody>{e.items.map((i, k) => <tr key={i.id} className={`s-${i.status}`}><td>{faNum(k + 1)}</td><td><Link href={`/customers/${i.customerId}`}>{i.name}</Link></td><td>{i.typeLabel}</td><td>{i.label ?? ''}</td>
          <td>{i.bucket === 'main' ? 'اصلی' : i.bucket === 'extra' ? 'کار اضافه' : 'خارج از لیست'}</td><td>{({ pending: 'در نوبت', current: 'جاری', done: 'انجام شد', moved: 'جابه‌جاشده', undone: 'انجام‌نشده', transferred: 'منتقل شد' } as Record<string, string>)[i.status]}</td>
          <td>{faNum(i.moveCount)} از ۲{i.movedTo ? ` · ${faClock(i.movedTo)}` : ''}</td><td>{i.outcome ? ({ answered: 'پاسخ داد', no_answer: 'پاسخ نداد', follow_up: 'پیگیری بعدی' } as Record<string, string>)[i.outcome] : ''}</td></tr>)}</tbody></table>
      {!e.items.length ? <div className="dp-box">برای این روز لیستی نیست.</div> : null}
    </> : null}
  </div>;
}

export function DpCapacityPage() {
  return <Gate>{() => <Capacity />}</Gate>;
}
function Capacity() {
  const p = useParams<{ sp: string }>(); const sp = Number(p.sp); const cfg = useDpConfig().data;
  const q = useQuery({ queryKey: ['daily-plan', 'capacity', sp], queryFn: () => dpApi.capacity(sp), retry: false });
  const [modal, setModal] = useState(false);
  const name = cfg?.experts.find((x) => x.salespersonId === sp)?.name ?? '';
  const c = q.data;
  return <div className="dp-page wide" data-testid="dp-capacity">
    <Link href="/daily-plans" className="dp-back"><ChevronRight size={15} aria-hidden="true" /> همه‌ی کارشناس‌ها</Link>
    <header className="dp-page-h"><div><h1>ظرفیت روزانه · {name}</h1></div></header>
    {q.isError ? <p className="dp-err" role="alert">{q.error instanceof Error ? q.error.message : 'بارگذاری نشد.'}</p> : null}
    {c ? <>
      <div className="dp-kpis card">
        <div className="dp-kpi"><small>ظرفیت امروز</small><b>{c.chart.length && c.chart[c.chart.length - 1].capacity != null ? faNum(c.chart[c.chart.length - 1].capacity!) : '—'}</b></div>
        <div className="dp-kpi"><small>ظرفیت {faDate(c.nextDay)}</small><b data-testid="dp-cap-next">{c.current.capacity == null ? '—' : faNum(c.current.capacity)}</b>
          <small>{c.firstWrite ? `هنوز دستیار عددی نداده · «ظرفیت روز اول» ${c.settings.firstDayCapacity == null ? 'خالی' : faNum(c.settings.firstDayCapacity)}` : c.current.outOfGuard ? 'خارج از حد' : ''}</small></div>
        <div className="dp-kpi"><small>حد تغییر روزانه</small><b>{faNum(c.settings.guardPct)}٪</b><small>تنظیم ادمین · از نوشتن دوم دستیار</small></div>
        {cfg?.manager ? <div className="dp-kpi act"><button type="button" className="btn btn-primary" onClick={() => setModal(true)} data-testid="dp-ov-open"><PencilLine size={15} aria-hidden="true" /> تغییر دستی ظرفیت</button><small>فقط ادمین · دلیل اجباری · در تاریخچه ثبت می‌شود</small></div> : null}
      </div>
      <section className="card dp-chart-c" aria-labelledby="dp-ch-h"><h2 id="dp-ch-h"><BarChart3 size={16} aria-hidden="true" /> ۱۴ روز کاری اخیر · ظرفیت و درصد انجام</h2>
        <Chart c={c} /><p className="dp-hint">جمعه و تعطیل رسمی در نمودار نیستند. روزهای «خودکار» نشان داده می‌شوند ولی در میانگین نمی‌آیند.</p></section>
      <section className="card" aria-labelledby="dp-hi-h"><h2 id="dp-hi-h">تاریخچه‌ی تغییر ظرفیت</h2>
        <table className="dp-table"><thead><tr><th>روز</th><th>تغییر</th><th>چه کسی</th><th>دلیل</th></tr></thead><tbody>
          {c.history.map((h) => <tr key={h.id} className={h.outcome !== 'ok' ? 'rej' : ''}><td>{faDate(h.day, { day: 'numeric', month: 'long' })}</td>
            <td>{h.previous == null ? `شروع ${faNum(h.requested)}` : `${faNum(h.previous)} ← ${faNum(h.requested)}`}{h.outcome !== 'ok' ? ' · رد شد' : ''}{h.label ? <span className="dp-chip warn">{h.label}</span> : null}{h.previous == null && h.actorKind === 'assistant' ? <span className="dp-chip">روز اول · بدون حد</span> : null}</td>
            <td>{h.actorName ?? ''} · {h.actorKind === 'admin' ? 'ادمین' : 'دستیار'}</td><td>{h.reason}</td></tr>)}
          {!c.history.length ? <tr><td colSpan={4}>هنوز تغییری ثبت نشده.</td></tr> : null}</tbody></table>
        <p className="dp-hint">روز اول عدد شروع را دستیار می‌دهد و حد {faNum(c.settings.guardPct)}٪ روی آن نیست؛ از نوشتن دوم حد اعمال می‌شود. اگر دستیار عددی نداد، «ظرفیت روز اول» به کار می‌رود.</p></section>
      <p className="dp-hint">کارشناس هیچ‌وقت ظرفیت یا این نمودار را نمی‌بیند؛ فقط «کار N از M».</p>
      {modal ? <OverrideModal sp={sp} name={name} c={c} onClose={() => setModal(false)} /> : null}
    </> : null}
  </div>;
}
function Chart({ c }: { c: DpCapView }) {
  const max = Math.max(10, ...c.chart.map((d) => d.capacity ?? 0));
  return <div className="dp-chart" role="img" aria-label="نمودار ظرفیت ۱۴ روز کاری">{c.chart.map((d) => <div key={d.day} className={`dp-col${d.mode === 'auto' ? ' auto' : ''}`}>
    <small>{d.capacity == null ? '—' : faNum(d.capacity)}</small><i style={{ height: `${Math.round(((d.capacity ?? 0) / max) * 100)}%` }} />
    <span className="dp-pct">{pct(d.completionPct)}{d.label ? ` · ${d.label}` : ''}</span><small>{faDate(d.day, { day: 'numeric', month: 'short' })}</small></div>)}</div>;
}
function OverrideModal({ sp, name, c, onClose }: { sp: number; name: string; c: DpCapView; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1); const [cap, setCap] = useState(String(c.current.capacity ?? '')); const [reason, setReason] = useState('');
  const [pv, setPv] = useState<DpOverride | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const n = Number(cap); const base = c.current.capacity; const g = c.settings.guardPct;
  const lo = base == null ? null : Math.ceil(base * (1 - g / 100)), hi = base == null ? null : Math.floor(base * (1 + g / 100));
  const over = base != null && Number.isFinite(n) && n > 0 && (n < lo! || n > hi!);
  const preview = async () => { if (!reason.trim()) { setErr('دلیل اجباری است.'); return; } setBusy(true); setErr('');
    try { setPv(await dpApi.override(sp, c.nextDay, { capacity: n, reason: reason.trim() })); setStep(3); } catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setBusy(false); } };
  const confirm = async () => { setBusy(true); setErr('');
    try { await dpApi.override(sp, c.nextDay, { capacity: n, reason: reason.trim(), confirm: true }); setDone(true); void qc.invalidateQueries({ queryKey: ['daily-plan'] }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'انجام نشد.'); } finally { setBusy(false); } };
  return <div className="dp-overlay" role="presentation" onClick={onClose}>
    <div className="dp-sheet" role="dialog" aria-modal="true" aria-labelledby="dp-ov-h" onClick={(e) => e.stopPropagation()} data-testid="dp-ov">
      <div className="dp-sheet-h"><div><small>مرحله‌ی {faNum(step)} از ۳</small><h2 id="dp-ov-h">تغییر دستی ظرفیت · {name}</h2><p>برای {faDate(c.nextDay)}</p></div><button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
      {done ? <div className="dp-box ok" role="status" data-testid="dp-ov-saved">ذخیره شد و در تاریخچه ثبت شد.{pv?.outOfGuard ? ' «خارج از حد» · اعلان داخل CRM به مدیرها و دستیار رفت.' : ''}</div> : step === 1 ? <>
        <div className="field"><label htmlFor="dp-ov-n">ظرفیت تازه <span className="req">*</span></label><input id="dp-ov-n" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d۰-۹]/g, '').replace(/[۰-۹]/g, (x) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(x))))} data-testid="dp-ov-n" />
          <small>فعلی: {base == null ? '—' : faNum(base)}{lo != null ? ` · حد ${faNum(g)}٪: ${faNum(lo)} تا ${faNum(hi!)}` : ''}</small></div>
        {over ? <div className="dp-box warn sm" data-testid="dp-ov-over">این عدد بیرون از حد {faNum(g)}٪ است. پذیرفته می‌شود ولی با نشان «خارج از حد» و اعلان به مدیرها.</div> : null}
        <div className="dp-sheet-f"><button type="button" className="btn btn-primary" disabled={!(n > 0)} onClick={() => setStep(2)} data-testid="dp-ov-next">ادامه</button><button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button></div>
      </> : step === 2 ? <>
        <div className="field"><label htmlFor="dp-ov-r">دلیل <span className="req">*</span></label><input id="dp-ov-r" value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} placeholder="یک خط، حداکثر ۸۰ نویسه" data-testid="dp-ov-r" /></div>
        <div className="dp-sheet-f"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void preview()} data-testid="dp-ov-preview">بررسی</button><button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>برگشت</button></div>
      </> : <>
        <dl className="dp-dl"><dt>از</dt><dd>{pv?.previous == null ? '—' : faNum(pv.previous)}</dd><dt>به</dt><dd>{faNum(n)}</dd><dt>دلیل</dt><dd>{reason}</dd></dl>
        {pv?.outOfGuard ? <div className="dp-box warn sm" data-testid="dp-ov-out">خارج از حد ({pv.guard.minAllowed != null ? `${faNum(pv.guard.minAllowed)} تا ${faNum(pv.guard.maxAllowed!)}` : '—'}). با تأیید، اعلان داخل CRM به مدیرها و دستیار می‌رود؛ پیامک یا بله نمی‌رود.</div> : null}
        <div className="dp-sheet-f"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()} data-testid="dp-ov-confirm">تأیید و ذخیره</button><button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>برگشت</button></div>
      </>}
      {err ? <p className="dp-err" role="alert" data-testid="dp-ov-err">{err}</p> : null}
    </div>
  </div>;
}

export function DpReportPage() {
  return <Gate>{() => <Report />}</Gate>;
}
function Report() {
  const q = useQuery({ queryKey: ['daily-plan', 'report'], queryFn: () => dpApi.report(), retry: false });
  return <div className="dp-page wide" data-testid="dp-report">
    <header className="dp-page-h"><div><h1>گزارش مدیر · لیست‌های روزانه</h1>{q.data ? <p>{faDate(q.data.from, { day: 'numeric', month: 'long' })} تا {faDate(q.data.to, { day: 'numeric', month: 'long' })}</p> : null}</div></header>
    <Tabs on="/daily-plans/report" />
    {q.data?.experts.map((e) => <section key={e.salespersonId} className="card" aria-label={e.name}>
      <h2>{e.name} <small>میانگین انجام: {pct(e.average)} ({faNum(e.averageDays)} روز{e.autoDays ? ` · ${faNum(e.autoDays)} روز خودکار بیرون از میانگین` : ''})</small></h2>
      <div className="dp-scroll"><table className="dp-table"><thead><tr><th>روز</th><th>لیست</th><th>ظرفیت</th><th>لیست اصلی</th><th>انجام اصلی</th><th>درصد</th><th>کار اضافه</th><th>خارج از لیست</th><th>جابه‌جایی</th><th>انجام‌نشده</th><th>منتقل شد</th></tr></thead>
        <tbody>{e.days.map((d) => <tr key={d.date}><td>{faDate(d.date, { day: 'numeric', month: 'long' })}{d.final ? '' : ' (جاری)'}</td><td>{d.mode === 'auto' ? <span className="dp-chip l-auto">خودکار</span> : d.mode ? 'دستیار' : '—'}{d.backlog ? <span className="dp-chip warn">انباشت</span> : null}</td>
          <td>{d.capacity == null ? '—' : faNum(d.capacity)}</td><td>{faNum(d.main)}</td><td>{faNum(d.mainDone)}</td><td>{pct(d.completionPct)}</td><td>{faNum(d.extraDone)} از {faNum(d.extra)}</td><td>{faNum(d.outOfList)}</td><td>{faNum(d.moved)}</td><td>{faNum(d.undone)}</td><td>{faNum(d.transferred)}</td></tr>)}</tbody></table></div>
    </section>)}
    {q.data ? <p className="dp-hint">{q.data.note} درصد = انجام‌شده‌های لیست اصلی ÷ لیست اصلی؛ کار اضافه و خارج از لیست در مخرج نیستند.</p> : null}
  </div>;
}

export function DpSettingsPage() {
  return <Gate>{() => <Settings />}</Gate>;
}
function Settings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['daily-plan', 'settings'], queryFn: dpApi.settings, retry: false });
  const [f, setF] = useState<{ guardPct: string; waitMin: string; firstDayCapacity: string } | null>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const s = q.data?.settings; const v = f ?? (s ? { guardPct: String(s.guardPct), waitMin: String(s.waitMin), firstDayCapacity: s.firstDayCapacity == null ? '' : String(s.firstDayCapacity) } : null);
  const save = async () => { if (!v) return; setErr(''); setMsg('');
    try { const r = await dpApi.saveSettings({ guardPct: Number(v.guardPct), waitMin: Number(v.waitMin), firstDayCapacity: v.firstDayCapacity.trim() === '' ? null : Number(v.firstDayCapacity) });
      setMsg(r.changed ? 'ذخیره شد و در تاریخچه‌ی تنظیمات ثبت شد.' : 'تغییری نبود.'); setF(null); void qc.invalidateQueries({ queryKey: ['daily-plan'] }); }
    catch (e) { setErr(e instanceof Error ? e.message : 'ذخیره نشد.'); } };
  const fl = q.data?.flags;
  return <div className="dp-page wide" data-testid="dp-settings">
    <header className="dp-page-h"><div><h1>تنظیمات «کارهای امروز»</h1></div></header>
    <Tabs on="/daily-plans/settings" />
    {q.isError ? <p className="dp-err" role="alert">{q.error instanceof Error ? q.error.message : 'بارگذاری نشد.'}</p> : null}
    {v ? <section className="card dp-form">
      <div className="field"><label htmlFor="dp-s-g">حد تغییر روزانه‌ی ظرفیت (٪)</label><input id="dp-s-g" inputMode="numeric" value={v.guardPct} onChange={(e) => setF({ ...v, guardPct: e.target.value })} data-testid="dp-s-guard" /><small>۱ تا ۱۰۰ · پیش‌فرض ۲۰ · از نوشتن دوم دستیار</small></div>
      <div className="field"><label htmlFor="dp-s-w">مهلت کار تکمیلی (دقیقه)</label><input id="dp-s-w" inputMode="numeric" value={v.waitMin} onChange={(e) => setF({ ...v, waitMin: e.target.value })} data-testid="dp-s-wait" /><small>۰ تا ۱۲۰ · پیش‌فرض ۱۰ · بعدش «لیست خودکار»</small></div>
      <div className="field"><label htmlFor="dp-s-f">ظرفیت روز اول</label><input id="dp-s-f" inputMode="numeric" value={v.firstDayCapacity} onChange={(e) => setF({ ...v, firstDayCapacity: e.target.value })} data-testid="dp-s-first" /><small>پیش‌فرض ۲۰ · خالی یعنی تا دستیار عدد ندهد لیست پذیرفته نمی‌شود (capacity_not_set)</small></div>
      <button type="button" className="btn btn-primary" onClick={() => void save()} data-testid="dp-s-save">ذخیره</button>
      {msg ? <p className="dp-box ok sm" role="status">{msg}</p> : null}{err ? <p className="dp-err" role="alert">{err}</p> : null}
    </section> : null}
    {fl ? <section className="card"><h2>پرچم‌ها</h2><ul className="dp-flags">
      <li><code>daily_plan</code> {fl.daily_plan ? 'روشن' : 'خاموش'}</li>
      <li><code>assistant_full_scope</code> {fl.assistant_full_scope ? 'روشن' : 'خاموش · منتظر تأیید'}</li>
      <li><code>daily_plan_discipline</code> {fl.daily_plan_discipline ? 'روشن' : 'خاموش'}</li></ul>
      <p className="dp-hint">پرچم‌ها از این صفحه عوض نمی‌شوند.</p></section> : null}
  </div>;
}
