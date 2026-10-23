import { useMemo, useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { RefreshCw } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useGetSalesReport, type GetSalesReportParams, type SalesReportMetric } from '@workspace/api-client-react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { jalaliValueToGregorian } from '@/lib/jalali';
import './SalesReports.css';

type Period = 'day' | 'week' | 'month' | 'quarter' | 'custom';
type Gran = 'day' | 'week' | 'month';
const periods: [Period, string][] = [['day', 'روز'], ['week', 'هفته'], ['month', 'ماه'], ['quarter', 'فصل'], ['custom', 'بازه دلخواه']];
const grans: [Gran, string][] = [['day', 'روزانه'], ['week', 'هفتگی'], ['month', 'ماهانه']];
const fa = (n: number | null | undefined) => (n ?? 0).toLocaleString('fa-IR');
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪`);
const tehranToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
const day = (d: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const toman = (v: string) => `${BigInt(v || '0').toLocaleString('fa-IR')} تومان`;
const todayJalali = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}/${parts.month}/${parts.day}`;
};

function Card({ label, value, sub, hl }: { label: string; value: string; sub?: string; hl?: boolean }) {
  return <div className={`sr-card ${hl ? 'hl' : ''}`} data-testid={`card-${label}`}><small>{label}</small><b>{value}</b>{sub ? <span>{sub}</span> : null}</div>;
}
const ratio = (a: number, b: number, rate: number | null) => `${fa(a)} از ${fa(b)} (${pct(rate)})`;

export default function SalesReports() {
  const [period, setPeriod] = useTableState<Period>('salesReports.period', 'day');
  const [gran, setGran] = useTableState<Gran>('salesReports.gran', 'day');
  const [anchorJ, setAnchorJ] = useTableState('salesReports.anchor', todayJalali);
  const [fromJ, setFromJ] = useTableState('salesReports.from', '');
  const [toJ, setToJ] = useTableState('salesReports.to', '');
  const [sp, setSp] = useTableState('salesReports.salesperson', '');
  const anchor = jalaliValueToGregorian(anchorJ) ?? tehranToday();
  const from = jalaliValueToGregorian(fromJ);
  const to = jalaliValueToGregorian(toJ);
  const customReady = period !== 'custom' || Boolean(from && to && from <= to);
  const params: GetSalesReportParams = useMemo(() => ({
    period, granularity: gran,
    ...(period === 'custom' ? { from, to } : { anchor }),
    ...(sp ? { salespersonId: Number(sp) } : {}),
  }), [period, gran, anchor, from, to, sp]);
  const q = useGetSalesReport(params, { query: { queryKey: ['/api/sales-reports', params], enabled: customReady, refetchOnMount: 'always', staleTime: 0 } });
  const { refetch } = q;
  const r = q.data;
  const trend = useMemo(() => (r?.trend ?? []).map((t) => ({ ...t, label: day(t.date) })), [r]);
  const m: SalesReportMetric | undefined = r?.summary;
  const cur = r?.cohorts.find((c) => c.key === 'current');

  return (
    <div className="sr" dir="rtl" data-testid="page-sales-reports">
      <div className="sr-bar">
        <div className="field">بازه
          <div className="sr-seg">{periods.map(([k, l]) => <button key={k} type="button" className={period === k ? 'on' : ''} onClick={() => setPeriod(k)} data-testid={`button-period-${k}`}>{l}</button>)}</div>
        </div>
        {period === 'custom' ? <>
          <div className="field">از<PersianDatePicker value={fromJ} onChange={setFromJ} testId="input-from" /></div>
          <div className="field">تا<PersianDatePicker value={toJ} onChange={setToJ} testId="input-to" /></div>
        </> : <div className="field">تاریخ مرجع<PersianDatePicker value={anchorJ} onChange={(v) => v && setAnchorJ(v)} testId="input-anchor" /></div>}
        <div className="field">گام نمودار
          <div className="sr-seg">{grans.map(([k, l]) => <button key={k} type="button" className={gran === k ? 'on' : ''} onClick={() => setGran(k)} data-testid={`button-gran-${k}`}>{l}</button>)}</div>
        </div>
        {r?.scope.canSelectSalesperson ? <label className="field">کارشناس
          <select value={sp} onChange={(e) => setSp(e.target.value)} data-testid="select-salesperson">
            <option value="">همه کارشناسان</option>
            {r.salespeople.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label> : null}
        <button type="button" className="btn btn-ghost" onClick={() => refetch()} disabled={q.isFetching || !customReady} data-testid="button-refresh"><RefreshCw size={15} /> {q.isFetching ? 'در حال به‌روزرسانی' : 'به‌روزرسانی'}</button>
      </div>

      {!customReady ? <div className="sr-note">برای بازه دلخواه، تاریخ شروع و پایان معتبر انتخاب کنید.</div> : null}
      {q.isLoading && customReady ? <SkeletonPanel rows={6} /> : null}
      {q.isError && customReady ? <><div className="sr-warn" role="alert">{q.error instanceof Error ? q.error.message : 'دریافت گزارش با خطا روبه‌رو شد.'}</div><ErrorState onRetry={() => refetch()} /></> : null}

      {r && m && customReady && !q.isError ? <>
        <div className="sr-note" data-testid="text-range">بازه گزارش: {day(r.range.from)} تا {day(r.range.to)} ({r.range.timezone})</div>
        {m.leads === 0 && m.contacted === 0 && m.requests === 0 ? <div className="sr-panel" data-testid="status-empty">در این بازه شماره یا تماسی ثبت نشده است. بازه یا تاریخ مرجع را تغییر دهید.</div> : null}

        <div className="sr-grid">
          <Card label="شماره‌های در دسترس (همه، نه فقط جدید)" value={fa(m.leads)} />
          <Card label="شماره‌های جدید در این بازه" value={fa(cur?.leads)} hl />
          <Card label="شماره‌های تماس‌گرفته‌شده" value={fa(m.contacted)} sub={`نرخ تماس ${pct(m.contactRate)}`} />
          <Card label="پاسخ‌داده‌شده" value={fa(m.answered)} />
          <Card label="بدون پاسخ (تماس بی‌پاسخ ثبت‌شده)" value={fa(m.unanswered)} sub={`نرخ ${pct(m.noAnswerRate)}`} />
          <Card label="نتیجه نامشخص (جدا از بی‌پاسخ)" value={fa(m.unknownOutcome)} />
          <Card label="درخواست‌دهندگان یکتا" value={fa(m.requesters)} sub={`نرخ ${pct(m.requestRate)}`} />
          <Card label="مجموع درخواست‌ها" value={fa(m.requests)} sub="ممکن است بیش از یک درخواست برای هر نفر باشد" />
          <Card label="مشتریان دارای پرونده (یکتا)" value={fa(m.caseCustomers)} sub={`نرخ ${pct(m.caseRate)}`} />
          <Card label="مجموع پرونده‌های تشکیل‌شده" value={fa(m.cases)} />
          <Card label="مبلغ درخواست‌شده" value={toman(m.requestedAmount)} />
          <Card label="درخواست‌دهنده با تماس (پیگیری)" value={fa(m.contactedRequesters)} sub={`${ratio(m.contactedRequesters, m.contacted, m.contactedRequestRate)}؛ دارای پرونده و تماس: ${fa(m.contactedCaseCustomers)}`} hl />
        </div>

        <div className="sr-panel">
          <h2>گروه‌های ثبت‌نام (درصدها با مخرج)</h2>
          <div className="sr-warn" data-testid="text-overlap-warning">هشدار: گروه‌های «روزهای قبل، هفته قبل، ماه قبل و قدیمی‌تر» به‌صورت عمدی هم‌پوشانی دارند و جمع آن‌ها برابر مجموع نیست. فقط گروه‌های «جاری» و «قبلی» بازه را افراز می‌کنند.</div>
          <table><thead><tr><th>گروه ثبت شماره</th><th>شماره‌ها</th><th>تماس‌گرفته / کل گروه</th><th>بی‌پاسخ / تماس‌گرفته</th><th>نتیجه نامشخص</th><th>درخواست‌دهنده / کل گروه</th><th>درخواست‌دهنده با تماس / تماس‌گرفته</th><th>پرونده (مشتری یکتا) / کل گروه</th><th>درخواست / پرونده</th><th>سهم درخواست‌کنندگان</th></tr></thead>
            <tbody>{r.cohorts.map((c) => <tr key={c.key} data-testid={`row-cohort-${c.key}`}>
              <td>{c.label}</td><td>{fa(c.leads)}</td>
              <td>{ratio(c.contacted, c.leads, c.contactRate)}</td>
               <td>{ratio(c.unanswered, c.contacted, c.noAnswerRate)}</td><td>{fa(c.unknownOutcome)}</td>
              <td>{ratio(c.requesters, c.leads, c.requestRate)}</td>
               <td>{ratio(c.contactedRequesters, c.contacted, c.contactedRequestRate)}</td>
              <td>{ratio(c.caseCustomers, c.leads, c.caseRate)}</td>
               <td>{fa(c.requests)} / {fa(c.cases)}</td><td>{ratio(c.requesters, m.requesters, c.requestShare)}</td></tr>)}</tbody></table>
        </div>

        <div className="sr-panel">
          <h2>ماه شمسیِ تاریخ مرجع: درخواست‌های شماره‌های جدید و قدیمی</h2>
          <table><thead><tr><th>گروه</th><th>درخواست‌دهنده یکتا</th><th>تعداد درخواست</th><th>سهم از درخواست‌کنندگان یکتا</th><th>مبلغ درخواست (تومان)</th></tr></thead><tbody>
            {([['جدید (ثبت‌نام همین ماه)', r.monthly.current], ['قدیمی‌تر', r.monthly.previous]] as [string, SalesReportMetric][]).map(([l, x]) =>
              <tr key={l}><td>{l}</td><td>{fa(x.requesters)}</td><td>{fa(x.requests)}</td><td>{pct(x.requestShare)}</td><td>{toman(x.requestedAmount)}</td></tr>)}
          </tbody></table>
          <div className="sr-note">{day(r.monthly.from)} تا {day(r.monthly.to)}</div>
        </div>

        {trend.length === 0 ? <div className="sr-panel">داده‌ای برای نمودار وجود ندارد.</div> : <div className="sr-two">
          <div className="sr-panel"><h2>روند تعداد</h2><div className="sr-chart"><ResponsiveContainer><AreaChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
            <Area type="linear" dataKey="leads" name="شماره‌های جدید" stroke="#0f172a" fill="#0f172a22" />
            <Area type="monotone" dataKey="contacted" name="تماس‌گرفته" stroke="#2f7d6d" fill="#2f7d6d22" />
            <Area type="monotone" dataKey="unanswered" name="بدون پاسخ" stroke="#a32940" fill="#a3294022" />
            <Area type="monotone" dataKey="requesters" name="درخواست‌دهنده" stroke="#bc9252" fill="#bc925233" />
             <Area type="monotone" dataKey="caseCustomers" name="مشتریان دارای پرونده" stroke="#5970a8" fill="#5970a822" />
            <Area type="monotone" dataKey="newRequesters" name="درخواست‌دهنده جدید" stroke="#5b6fb0" fill="#5b6fb022" />
            <Area type="monotone" dataKey="previousRequesters" name="درخواست‌دهنده قدیمی" stroke="#7a6a8a" fill="#7a6a8a22" />
          </AreaChart></ResponsiveContainer></div></div>
          <div className="sr-panel"><h2>روند نرخ‌ها (درصد)</h2><div className="sr-chart"><ResponsiveContainer><LineChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" /><YAxis domain={[0, 100]} unit="%" /><Tooltip /><Legend />
            <Line type="monotone" connectNulls={false} dataKey="contactRate" name="نرخ تماس" stroke="#2f7d6d" />
            <Line type="monotone" connectNulls={false} dataKey="noAnswerRate" name="نرخ بی‌پاسخ" stroke="#a32940" />
            <Line type="monotone" connectNulls={false} dataKey="requestRate" name="نرخ درخواست" stroke="#bc9252" />
             <Line type="monotone" connectNulls={false} dataKey="contactedRequestRate" name="نرخ تبدیل پیگیری" stroke="#5b6fb0" />
            <Line type="monotone" connectNulls={false} dataKey="caseRate" name="نرخ پرونده" stroke="#0f172a" />
          </LineChart></ResponsiveContainer></div></div>
        </div>}

        {r.definitions.length ? <div className="sr-panel"><h2>تعریف‌ها</h2><ul>{r.definitions.map((d, i) => <li key={i}>{d}</li>)}</ul></div> : null}
      </> : null}
    </div>
  );
}
