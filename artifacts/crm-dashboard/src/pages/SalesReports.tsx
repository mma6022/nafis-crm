/** «گزارش فروش تیم» (/sales-reports) — admin only. Data: GET /api/manager/sales-report (api-server lib/team-sales-report.ts).
 *  Design: nafis-design/screens/crm-sales-report (spec.md §1–§6). Experts get 403 + «رفتن به عملکرد من». */
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, Lock, RefreshCw, Settings2 } from 'lucide-react';
import { asFetch, AsError } from '@/features/assistant/api';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { toast } from '@/hooks/use-toast';
import './sales-report.css';

type Range = 'today' | 'yesterday' | 'week' | 'month' | 'prev_month' | 'custom';
type Ov = { overdueReminders: number; p1NoCall: number };
type Flags = { traineeMoney: boolean; overdueCard: boolean; noCommissionAlert: boolean };
type TRow = { salespersonId?: number; name?: string; trainee?: boolean; label?: string; calls: number; previousCalls: number; sentToRegistration: number; deposits: number;
  payoutToman: string | null; commissionToman: string | null; openPaymentOrders: number | null; overdue: Ov };
type Stage = { stage: string; label: string; count: number; amount: number };
type Old = { customerId: number; customerName: string; stageLabel: string; daysInStage: number; link: string; purchaseId?: number; applicationId?: number };
type Report = {
  label: string; previousLabel: string; compareNote: string; complete: boolean; flags: Flags; footnote: string; empty: boolean;
  experts: { salespersonId: number; name: string; trainee: boolean }[]; plans: { id: number; name: string; active: boolean }[];
  kpis: {
    deposited: { current: { count: number; payoutToman: string }; previous: { count: number; payoutToman: string } };
    commission: { current: string; previous: string; openPaymentOrders: number; noCommissionDeposits: number };
    calls: { current: number; previous: number }; sentToRegistration: { current: number; previous: number };
    leads: { current: number; previous: number; siteLeadsNoCall: number }; overdue: { now: Ov; weekAgo: Ov | null } | null;
  };
  table: { experts: TRow[]; expertsTotal: TRow; trainees: TRow[]; traineesTotal: TRow | null };
  funnel: { key: string; label: string; current: number; previous: number; ofPrevious: number | null }[];
  trend: { step: 'day' | 'week' | 'month'; points: { label: string; calls: number; previousCalls: number | null; payoutToman: string; previousPayoutToman: string | null }[] };
  sources: { key: string; label: string; leads: number; sentToRegistration: number; deposits: number; payoutToman: string }[];
  openInvoices: { count: number; amountToman: number; byStage: Stage[]; oldest: Old[] };
  stuck: { count: number; thresholdDays: number; byStage: Stage[]; oldest: Old[] };
  definitions: Record<string, string>;
};

const RANGES: [Range, string][] = [['today', 'امروز'], ['yesterday', 'دیروز'], ['week', 'این هفته'], ['month', 'این ماه'], ['prev_month', 'ماه قبل'], ['custom', 'بازه دلخواه']];
const ERRORS: Record<string, string> = { bad_dates: 'تاریخ‌ها درست نیست.', bad_order: '«تا» باید بعد از «از» باشد.', future: 'بازه از آینده شروع شده است.', too_long: 'بازه حداکثر ۴۰۰ روز.', unknown_expert: 'این کارشناس پیدا نشد.', unknown_plan: 'این طرح پیدا نشد.' };
const fa = (n: number | null | undefined) => (n ?? 0).toLocaleString('fa-IR');
const big = (v: string | number | null | undefined) => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };
const toman = (v: string | number | null | undefined) => big(v).toLocaleString('fa-IR');
const short = (v: string | number) => { const n = Number(big(v)); return n >= 1e9 ? `${(n / 1e9).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} میلیارد` : n >= 1e6 ? `${(n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: 0 })} میلیون` : n.toLocaleString('fa-IR'); };
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪`);

/** Change chip vs previous window. lowerIsBetter flips the colour (overdue). */
function Delta({ cur, prev, lowerIsBetter = false }: { cur: bigint | number; prev: bigint | number; lowerIsBetter?: boolean }) {
  const c = Number(cur), p = Number(prev);
  if (c === p) return <span className="tsr-dl">بدون تغییر</span>;
  if (p === 0) return <span className={`tsr-dl ${lowerIsBetter ? 'bad' : 'good'}`}>تازه</span>;
  const d = ((c - p) / p) * 100; const up = d > 0; const good = lowerIsBetter ? !up : up;
  return <span className={`tsr-dl ${good ? 'good' : 'bad'}`} dir="rtl">{up ? '▲' : '▼'} {Math.abs(d).toLocaleString('fa-IR', { maximumFractionDigits: 0 })}٪</span>;
}
function Kpi({ title, value, unit, sub, cmp, wide, tag, testId }: { title: string; value: ReactNode; unit?: string; sub?: ReactNode; cmp?: ReactNode; wide?: boolean; tag?: ReactNode; testId: string }) {
  return <div className={`tsr-kpi${wide ? ' wide' : ''}`} data-testid={testId}><h3>{title}{tag}</h3><div className="tsr-val">{value}{unit ? <small>{unit}</small> : null}</div>{sub}{cmp ? <div className="tsr-cmp">{cmp}</div> : null}</div>;
}

function NoAccess() {
  return <div className="tsr" dir="rtl" data-testid="page-sales-reports-noaccess"><section className="tsr-sec"><div className="tsr-empty"><Lock size={28} aria-hidden />
    <b>گزارش فروشِ تیم فقط برای مدیر است.</b><span>عدد و پورسانت خودتان را در «عملکرد من» ببینید.</span>
    <a className="tsr-btn" href="/my-performance" data-testid="link-my-performance">رفتن به عملکرد من</a></div></section></div>;
}
function Skeleton() {
  return <div className="tsr" dir="rtl" aria-busy="true" aria-label="در حال بارگذاری" data-testid="status-loading">
    <div className="tsr-kpis">{Array.from({ length: 6 }).map((_, i) => <div key={i} className={`tsr-sk${i < 2 ? ' tsr-kpi wide' : ' tsr-kpi'}`} style={{ ['--h' as string]: '110px' }} />)}</div>
    <div className="tsr-sk" style={{ ['--h' as string]: '260px' }} /><div className="tsr-sk" style={{ ['--h' as string]: '200px' }} /></div>;
}

function FlagsPanel({ flags }: { flags: Flags }) {
  const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  const set = async (k: keyof Flags, v: boolean) => {
    if (busy) return; setBusy(true);
    try { await asFetch('/manager/sales-report/settings', { method: 'PUT', body: { [k]: v } }); await qc.invalidateQueries({ queryKey: ['team-sales-report'] }); toast({ title: 'ذخیره شد' }); }
    catch (e) { toast({ title: (e as Error).message }); } finally { setBusy(false); }
  };
  const row = (k: keyof Flags, title: string, help: string) => <label className="tsr-flag"><input type="checkbox" checked={flags[k]} disabled={busy} onChange={(e) => void set(k, e.target.checked)} data-testid={`toggle-${k}`} />
    <span><b>{title}</b><small>{help}</small></span></label>;
  return <details className="tsr-sec" data-testid="panel-flags" style={{ display: 'block' }}><summary><Settings2 size={18} aria-hidden /><h2 style={{ fontSize: 15 }}>تنظیمات گزارش (فقط مدیر)</h2></summary>
    <div className="tsr-flags">
      {row('traineeMoney', 'کارآموزها مبلغ و پورسانت داشته باشند', 'خاموش: در گروه کارآموزها مبلغ و پورسانت «—» است.')}
      {row('overdueCard', 'کارت «عقب‌افتاده» بالای صفحه', 'خاموش: بالای صفحه ۵ کارت می‌ماند.')}
      {row('noCommissionAlert', 'اعلان مدیر برای «واریز بدون پورسانت»', 'فقط برای واریزهای بعد از روشن کردن؛ به کارشناس‌ها چیزی نمی‌رود.')}
    </div></details>;
}

export default function SalesReports() {
  const init = useMemo(() => new URLSearchParams(window.location.search), []);
  const [range, setRange] = useState<Range>(() => (RANGES.some(([k]) => k === init.get('range')) ? init.get('range') as Range : 'month'));
  const [fromJ, setFromJ] = useState(''); const [toJ, setToJ] = useState('');
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [expert, setExpert] = useState(init.get('expert') ?? '');
  const [plan, setPlan] = useState(init.get('plan') ?? '');
  const [metric, setMetric] = useState<'calls' | 'money'>('calls');
  const [trOpen, setTrOpen] = useState(false);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ range });
    if (range === 'custom' && applied) { p.set('from', applied.from); p.set('to', applied.to); }
    if (expert) p.set('expert', expert); if (plan) p.set('plan', plan);
    return p.toString();
  }, [range, applied, expert, plan]);
  const ready = range !== 'custom' || Boolean(applied);
  const q = useQuery<Report, AsError>({ queryKey: ['team-sales-report', qs], queryFn: () => asFetch<Report>(`/manager/sales-report?${qs}`), enabled: ready, staleTime: 30_000, retry: (n, e) => e?.status !== 403 && e?.status !== 422 && n < 2 });
  const r = q.data;
  const trend = useMemo(() => (r?.trend.points ?? []).map(p => ({ label: p.label, cur: metric === 'calls' ? p.calls : Number(big(p.payoutToman)), prev: metric === 'calls' ? p.previousCalls : p.previousPayoutToman == null ? null : Number(big(p.previousPayoutToman)) })), [r, metric]);

  if (q.error?.status === 403 || q.error?.status === 401) return <NoAccess />;
  const applyCustom = () => {
    const f = jalaliValueToGregorian(fromJ), t = jalaliValueToGregorian(toJ);
    if (!f || !t) { toast({ title: 'هر دو تاریخ را انتخاب کنید.' }); return; }
    setApplied({ from: f, to: t });
  };
  const pickExpert = (id?: number) => { if (id != null) setExpert(String(id) === expert ? '' : String(id)); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const experts = r?.experts ?? []; const plans = r?.plans ?? [];
  const k = r?.kpis; const flags = r?.flags;
  const money = (v: string | null) => (v == null ? <span className="tsr-na" title="کارآموزها سهم ندارند">سهم ندارد</span> : toman(v));
  const ovCell = (o: Ov) => <span className={`tsr-od${o.overdueReminders + o.p1NoCall > 20 ? ' hi' : ''}`}>{fa(o.overdueReminders)} + {fa(o.p1NoCall)}</span>;
  const trRow = (x: TRow, cls = 'row') => <tr key={x.salespersonId ?? x.label} className={`${cls}${x.salespersonId != null && String(x.salespersonId) === expert ? ' pick' : ''}`} onClick={x.salespersonId != null ? () => pickExpert(x.salespersonId) : undefined} data-testid={x.salespersonId != null ? `row-expert-${x.salespersonId}` : `row-total-${x.trainee === undefined ? (x.label?.includes('کارآموز') && !x.label.includes('بدون') ? 'trainees' : 'experts') : ''}`}>
    <td>{x.name ?? x.label}</td><td className="num">{fa(x.calls)}<small><Delta cur={x.calls} prev={x.previousCalls} /></small></td><td className="num">{fa(x.sentToRegistration)}</td><td className="num">{fa(x.deposits)}</td>
    <td className="num">{money(x.payoutToman)}</td><td className="num">{money(x.commissionToman)}</td><td className="num">{x.openPaymentOrders == null ? <span className="tsr-na">—</span> : fa(x.openPaymentOrders)}</td>{flags?.overdueCard ? <td className="num">{ovCell(x.overdue)}</td> : null}</tr>;
  const card = (x: TRow) => <button type="button" key={x.salespersonId} className={`tsr-ecard${String(x.salespersonId) === expert ? ' pick' : ''}`} onClick={() => pickExpert(x.salespersonId)} data-testid={`card-expert-${x.salespersonId}`}>
    <div className="hd">{x.name}</div>
    <div className="g"><div><span>تماس</span><b>{fa(x.calls)}</b></div><div><span>ارسال به ثبت</span><b>{fa(x.sentToRegistration)}</b></div><div><span>واریز</span><b>{fa(x.deposits)}</b></div></div>
    <div className="money"><span>مبلغ: <b>{money(x.payoutToman)}</b></span><span>پورسانت: <b>{money(x.commissionToman)}</b></span>{flags?.overdueCard ? <span>عقب‌افتاده: {ovCell(x.overdue)}</span> : null}</div></button>;
  const oldList = (items: Old[], tail: (o: Old) => ReactNode) => <ul className="tsr-olist">{items.map(o => <li key={o.link}><div className="cn"><a href={o.link}>{o.customerName}</a> <CustomerIdBadge id={o.customerId} /><div className="cm">{o.stageLabel}</div></div><div className="am">{tail(o)}</div></li>)}</ul>;
  const stages = (s: Stage[], withAmount: boolean) => { const max = Math.max(1, ...s.map(x => x.count)); return <div className="tsr-stg">{s.map((x, i) => <div key={x.stage} className={`s${i === 0 ? ' top' : ''}`}><span className="nm">{x.label}</span><span className="tr"><i style={{ width: `${(x.count / max) * 100}%` }} /></span><b>{fa(x.count)}{withAmount ? <span className="tsr-muted"> · {short(x.amount)}</span> : null}</b></div>)}</div>; };

  return (
    <div className="tsr" dir="rtl" data-testid="page-sales-reports">
      <div className="tsr-top"><span className="ttl"><BarChart3 size={18} aria-hidden />گزارش فروشِ کل تیم</span>
        <button type="button" className="tsr-btn ghost" style={{ marginInlineStart: 'auto' }} onClick={() => void q.refetch()} disabled={q.isFetching} data-testid="button-refresh"><RefreshCw size={16} aria-hidden />تازه‌سازی</button></div>
      <div className="tsr-fbar">
        <div className="tsr-seg" role="group" aria-label="بازه">{RANGES.map(([key, l]) => <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)} data-testid={`button-range-${key}`}>{l}</button>)}</div>
        <label className={`tsr-sel${expert ? ' on' : ''}`}><span>کارشناس</span><select value={expert} onChange={(e) => setExpert(e.target.value)} data-testid="select-expert">
          <option value="">کل تیم</option>
          <optgroup label="کارشناس‌ها">{experts.filter(e => !e.trainee).map(e => <option key={e.salespersonId} value={e.salespersonId}>{e.name}</option>)}</optgroup>
          <optgroup label="کارآموزها">{experts.filter(e => e.trainee).map(e => <option key={e.salespersonId} value={e.salespersonId}>{e.name}</option>)}</optgroup>
        </select></label>
        <label className={`tsr-sel${plan ? ' on' : ''}`}><span>طرح</span><select value={plan} onChange={(e) => setPlan(e.target.value)} data-testid="select-plan">
          <option value="">همه‌ی طرح‌ها</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (غیرفعال)'}</option>)}</select></label>
        {r ? <div className="tsr-range" data-testid="text-range"><b>{r.label}</b><span>در مقایسه با {r.previousLabel}</span></div> : null}
      </div>
      {range === 'custom' ? <div className="tsr-custom" data-testid="panel-custom"><span>از</span><PersianDatePicker value={fromJ} onChange={setFromJ} testId="input-from" /><span>تا</span><PersianDatePicker value={toJ} onChange={setToJ} testId="input-to" />
        <button type="button" className="tsr-btn" onClick={applyCustom} data-testid="button-apply">نمایش</button></div> : null}

      {!ready ? <section className="tsr-sec"><div className="tsr-empty">بازه را انتخاب کنید و «نمایش» را بزنید.</div></section>
        : q.isLoading ? <Skeleton />
        : q.error ? <section className="tsr-sec" data-testid="status-error"><div className="tsr-err"><b>گزارش بار نشد</b><span>{ERRORS[q.error.code ?? ''] ?? 'اتصال یا سرور مشکل داشت.'}</span>
            <button type="button" className="tsr-btn" onClick={() => void q.refetch()} data-testid="button-retry">تلاش دوباره</button></div></section>
        : r && k && flags ? <>
          <div className={`tsr-kpis${flags.overdueCard ? '' : ' five'}`} data-testid="kpis">
            <Kpi wide testId="kpi-deposited" title="واریز به مشتری" value={toman(k.deposited.current.payoutToman)} unit="تومان" sub={<div className="tsr-sub"><b>{fa(k.deposited.current.count)}</b> واریز</div>}
              cmp={<><Delta cur={big(k.deposited.current.payoutToman)} prev={big(k.deposited.previous.payoutToman)} /><span>قبل: <b>{short(k.deposited.previous.payoutToman)}</b> تومان در {fa(k.deposited.previous.count)} واریز</span></>} />
            <Kpi wide testId="kpi-commission" title="پورسانت ثبت‌شده" value={toman(k.commission.current)} unit="تومان"
              sub={<div className={`tsr-sub${k.commission.noCommissionDeposits ? ' bad' : ''}`}>دستور پرداخت باز: <b>{fa(k.commission.openPaymentOrders)}</b> · واریز بدون پورسانت: <b>{fa(k.commission.noCommissionDeposits)}</b></div>}
              cmp={<><Delta cur={big(k.commission.current)} prev={big(k.commission.previous)} /><span>قبل: <b>{short(k.commission.previous)}</b> تومان</span></>} />
            <Kpi testId="kpi-calls" title="تماس‌ها" value={fa(k.calls.current)} cmp={<><Delta cur={k.calls.current} prev={k.calls.previous} /><span>قبل: <b>{fa(k.calls.previous)}</b></span></>} />
            <Kpi testId="kpi-sent" title="ارسال به ثبت" value={fa(k.sentToRegistration.current)} cmp={<><Delta cur={k.sentToRegistration.current} prev={k.sentToRegistration.previous} /><span>قبل: <b>{fa(k.sentToRegistration.previous)}</b></span></>} />
            <Kpi testId="kpi-leads" title="سرنخ تازه" value={fa(k.leads.current)} sub={<div className={`tsr-sub${k.leads.siteLeadsNoCall ? ' bad' : ''}`}>سرنخ سایت بی‌تماس: <b>{fa(k.leads.siteLeadsNoCall)}</b></div>}
              cmp={<><Delta cur={k.leads.current} prev={k.leads.previous} /><span>قبل: <b>{fa(k.leads.previous)}</b></span></>} />
            {k.overdue ? <Kpi testId="kpi-overdue" title="عقب‌افتاده" tag={<span className="tsr-now">الان</span>} value={fa(k.overdue.now.overdueReminders + k.overdue.now.p1NoCall)}
              sub={<div className="tsr-sub">یادآور: <b>{fa(k.overdue.now.overdueReminders)}</b> · اولویت ۱ بی‌تماس: <b>{fa(k.overdue.now.p1NoCall)}</b></div>}
              cmp={k.overdue.weekAgo ? <><Delta lowerIsBetter cur={k.overdue.now.overdueReminders + k.overdue.now.p1NoCall} prev={k.overdue.weekAgo.overdueReminders + k.overdue.weekAgo.p1NoCall} /><span>۷ روز پیش: <b>{fa(k.overdue.weekAgo.overdueReminders + k.overdue.weekAgo.p1NoCall)}</b></span></> : <span>۷ روز پیش: <b>—</b> (هنوز عکس ۷ روز پیش نیست)</span>} /> : null}
          </div>
          {r.empty ? <section className="tsr-sec" data-testid="status-empty"><div className="tsr-empty"><b>در این بازه هنوز رویدادی ثبت نشده</b><span>بازه‌ی دیگری را انتخاب کنید.</span></div></section> : null}

          <section className="tsr-sec" data-testid="section-experts"><header><h2>کارشناس‌ها</h2><span className="tsr-muted">روی هر ردیف بزنید تا گزارش فقط برای همان کارشناس شود.</span></header>
            <div className="tsr-tblw tsr-d"><table className="tsr-tbl"><thead><tr><th>نام</th><th className="num">تماس</th><th className="num">ارسال به ثبت</th><th className="num">واریز</th><th className="num">مبلغ واریز (تومان)</th><th className="num">پورسانت (تومان)</th><th className="num">دستور پرداخت باز</th>{flags.overdueCard ? <th className="num">عقب‌افتاده (یادآور + اولویت ۱)</th> : null}</tr></thead>
              <tbody>{r.table.experts.map(x => trRow(x))}{trRow(r.table.expertsTotal, 'tot')}
                {r.table.trainees.length ? <tr className="tgh"><td colSpan={flags.overdueCard ? 8 : 7}><button type="button" className="tsr-tgbtn" aria-expanded={trOpen} onClick={() => setTrOpen(o => !o)} data-testid="button-trainees">{trOpen ? '▾' : '◂'} کارآموزها ({fa(r.table.trainees.length)} نفر)
                  {r.table.traineesTotal ? <span className="sm">{fa(r.table.traineesTotal.calls)} تماس · {fa(r.table.traineesTotal.sentToRegistration)} ارسال به ثبت · {fa(r.table.traineesTotal.deposits)} واریز</span> : null}</button></td></tr> : null}
                {trOpen ? r.table.trainees.map(x => trRow(x)) : null}{trOpen && r.table.traineesTotal ? trRow(r.table.traineesTotal, 'tot') : null}</tbody></table></div>
            <div className="tsr-ecards tsr-m">{r.table.experts.map(card)}
              <div className="tsr-ecard" style={{ cursor: 'default' }} data-testid="card-experts-total"><div className="hd">{r.table.expertsTotal.label}</div>
                <div className="g"><div><span>تماس</span><b>{fa(r.table.expertsTotal.calls)}</b></div><div><span>ارسال به ثبت</span><b>{fa(r.table.expertsTotal.sentToRegistration)}</b></div><div><span>واریز</span><b>{fa(r.table.expertsTotal.deposits)}</b></div></div>
                <div className="money"><span>مبلغ: <b>{money(r.table.expertsTotal.payoutToman)}</b></span><span>پورسانت: <b>{money(r.table.expertsTotal.commissionToman)}</b></span></div></div>
              {r.table.trainees.length ? <div className="tsr-trgrp"><button type="button" className="tsr-tgbtn" aria-expanded={trOpen} onClick={() => setTrOpen(o => !o)}>{trOpen ? '▾' : '◂'} کارآموزها ({fa(r.table.trainees.length)} نفر)</button>{trOpen ? r.table.trainees.map(card) : null}</div> : null}
            </div>
            <p className="tsr-muted" style={{ margin: 0 }}>{r.definitions.scope}</p>
          </section>

          <div className="tsr-row2">
            <section className="tsr-sec" data-testid="section-trend"><header><h2>روند</h2>
              <div className="tsr-seg sm" role="group" aria-label="معیار روند"><button type="button" aria-pressed={metric === 'calls'} onClick={() => setMetric('calls')} data-testid="button-trend-calls">تماس</button><button type="button" aria-pressed={metric === 'money'} onClick={() => setMetric('money')} data-testid="button-trend-money">مبلغ واریز</button></div></header>
              <div style={{ width: '100%', height: 240 }} dir="ltr"><ResponsiveContainer><LineChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nf-line)" /><XAxis dataKey="label" reversed tick={{ fontSize: 12 }} /><YAxis orientation="right" width={56} tick={{ fontSize: 12 }} tickFormatter={(v: number) => metric === 'money' ? short(v) : fa(v)} />
                <Tooltip formatter={(v: number) => (metric === 'money' ? `${toman(v)} تومان` : fa(v))} /><Legend />
                <Line type="monotone" dataKey="cur" name="این بازه" stroke="var(--nf-brand-600)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="prev" name="بازه‌ی قبل" stroke="var(--nf-ink-faint)" strokeDasharray="5 4" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              </LineChart></ResponsiveContainer></div></section>
            <section className="tsr-sec" data-testid="section-funnel"><header><h2>قیف</h2></header><div className="tsr-fun">
              {r.funnel.map((s) => { const max = Math.max(1, r.funnel[0]?.current ?? 1); return <div className="tsr-fr" key={s.key}><span className="lb">{s.label}</span><span className="v">{fa(s.current)}<small>{s.ofPrevious == null ? '' : `${pct(s.ofPrevious)} از قبلی`}</small></span><span className="tr"><i style={{ width: `${Math.min(100, (s.current / max) * 100)}%` }} /></span></div>; })}
            </div><p className="tsr-muted" style={{ margin: 0 }}>{r.definitions.funnel}</p></section>
          </div>

          <section className="tsr-sec" data-testid="section-sources"><header><h2>منبع مشتری</h2></header>
            <div className="tsr-tblw"><table className="tsr-tbl"><thead><tr><th>منبع</th><th className="num">سرنخ</th><th className="num">ارسال به ثبت</th><th className="num">واریز</th><th className="num">مبلغ واریز (تومان)</th></tr></thead>
              <tbody>{r.sources.map(s => <tr key={s.key}><td>{s.label}</td><td className="num">{fa(s.leads)}</td><td className="num">{fa(s.sentToRegistration)}</td><td className="num">{fa(s.deposits)}</td><td className="num">{toman(s.payoutToman)}</td></tr>)}</tbody></table></div></section>

          <div className="tsr-money2">
            <section className="tsr-sec" data-testid="section-open-invoices"><header><h2>فاکتورهای کالای باز</h2><a className="tsr-muted" href="/goods-purchases">همه</a></header>
              <div className="tsr-big"><b>{fa(r.openInvoices.count)}</b><span>فاکتور · {toman(r.openInvoices.amountToman)} تومان</span></div>
              {stages(r.openInvoices.byStage, true)}{oldList(r.openInvoices.oldest, o => `${fa(o.daysInStage)} روز`)}</section>
            <section className="tsr-sec" data-testid="section-stuck"><header><h2>پرونده‌های گیرکرده</h2><a className="tsr-muted" href="/loan-applications">همه</a></header>
              <div className="tsr-big"><b>{fa(r.stuck.count)}</b><span>پرونده بیش از {fa(r.stuck.thresholdDays)} روز در یک مرحله</span></div>
              {stages(r.stuck.byStage, false)}{oldList(r.stuck.oldest, o => `${fa(o.daysInStage)} روز`)}</section>
          </div>

          <details className="tsr-sec" data-testid="panel-definitions"><summary><h2 style={{ fontSize: 15 }}>هر عدد یعنی چه؟</h2></summary>
            <ul className="tsr-defs">{Object.entries(r.definitions).map(([key, v]) => <li key={key}>{v}</li>)}</ul></details>
          <FlagsPanel flags={flags} />
          <p className="tsr-foot" data-testid="text-footnote">{r.footnote}</p>
        </> : null}
    </div>
  );
}
