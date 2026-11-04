/** «گزارش موارد اجباری» (design v1.2 scenes mgr_report / mgr_report_detail / mgr_report_empty): empty mandatory items per expert over a Jalali range.
 *  Desktop table, 390px cards; detail lists that expert's summaries with empty items. Read-only; admin route. */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarDays, FileText, X } from 'lucide-react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { formatJalaliValue, gregorianToJalaliValue, jalaliValueToGregorian, todayJalali } from '@/lib/jalali';
import { csReq, fa, useCsConfig, type CsDetail, type CsReport } from './api';
import './cs.css';

type P = 'week' | 'month' | 'range';
const tehranDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function preset(p: 'week' | 'month') {
  const to = tehranDay();
  if (p === 'week') { const wd = new Date(`${to}T12:00:00Z`).getUTCDay(); return { from: addDays(to, -((wd + 1) % 7)), to }; } // week starts Saturday
  const j = todayJalali(); return { from: jalaliValueToGregorian(formatJalaliValue(j.year, j.month, 1)) ?? to, to };
}
const dayF = (g: string, y = false) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', ...(y ? { year: 'numeric' } : {}) }).format(new Date(`${g}T08:30:00Z`));
const dayI = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));

export default function CsMgrReport() {
  const init = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const ip = (init.get('p') as P) || (init.get('from') ? 'range' : 'week');
  const [r, setR] = useState<{ p: P; from: string; to: string }>(() => ip === 'range' && init.get('from') ? { p: 'range', from: init.get('from')!, to: init.get('to') || init.get('from')! } : { p: ip === 'range' ? 'week' : ip, ...preset(ip === 'month' ? 'month' : 'week') });
  const [expert, setExpert] = useState<number | null>(init.get('expert') ? Number(init.get('expert')) : null);
  const [page, setPage] = useState(1);
  const cfg = useCsConfig(); const on = cfg.data?.enabled === true;
  const qs = `from=${r.from}&to=${r.to}`;
  const rep = useQuery<CsReport, Error>({ queryKey: ['cs-fields', 'report', qs], enabled: on && expert == null, retry: false, queryFn: () => csReq<CsReport>('GET', `/call-summary-fields/report?${qs}`) });
  const det = useQuery<CsDetail, Error>({ queryKey: ['cs-fields', 'detail', expert, qs, page], enabled: on && expert != null, retry: false,
    queryFn: () => csReq<CsDetail>('GET', `/call-summary-fields/report/detail?expert=${expert}&${qs}&page=${page}`) });
  if (cfg.isLoading) return null;
  if (!on) return <div className="csf page" dir="rtl"><p className="muted" data-testid="cs-report-off">این گزارش فعال نیست.</p></div>;
  const pick = (p: P) => { setPage(1); setR(p === 'range' ? { ...r, p } : { p, ...preset(p) }); };
  const per = <div className="mper"><div className="seg" role="tablist" aria-label="بازه">{(['week', 'month', 'range'] as const).map((p) =>
    <button key={p} type="button" role="tab" aria-selected={r.p === p} onClick={() => pick(p)} data-testid={`cs-per-${p}`}>{p === 'week' ? 'این هفته' : p === 'month' ? 'این ماه' : 'بازه‌ی دلخواه'}</button>)}</div>
    {r.p === 'range' ? <div className="frng"><label>از<PersianDatePicker value={gregorianToJalaliValue(r.from)} onChange={(v) => { const g = v && jalaliValueToGregorian(v); if (g) { setPage(1); setR({ ...r, from: g }); } }} testId="cs-from" /></label>
      <label>تا<PersianDatePicker value={gregorianToJalaliValue(r.to)} onChange={(v) => { const g = v && jalaliValueToGregorian(v); if (g) { setPage(1); setR({ ...r, to: g }); } }} testId="cs-to" /></label></div> : null}
    <p className="muted" data-testid="cs-range"><CalendarDays className="i" aria-hidden="true" />{dayF(r.from)} تا {dayF(r.to, true)}</p></div>;
  if (expert != null) {
    const d = det.data;
    return <div className="csf page" dir="rtl" data-testid="cs-report-detail">
      <div className="hrow"><button type="button" className="btn lk sm" onClick={() => { setExpert(null); setPage(1); }} data-testid="cs-back"><ArrowRight className="i" aria-hidden="true" />همه‌ی کارشناس‌ها</button><h2>{d?.expert.name ?? '…'}</h2></div>{per}
      {det.isError ? <p className="err" role="alert"><AlertTriangle className="i" aria-hidden="true" />{det.error.message}</p> : null}
      {d ? <p className="muted" data-testid="cs-detail-line">{fa(d.withEmpty)} خلاصه با مورد خالی، {fa(d.empty)} مورد خالی</p> : null}
      {d && !d.rows.length ? <section className="card vpad mem" role="status"><p className="tt"><FileText className="i" aria-hidden="true" />در این بازه خلاصه‌ای با مورد خالی نیست</p></section> : null}
      {d?.rows.length ? <section className="card" aria-label="تماس‌های با مورد خالی">{d.rows.map((x) => <div key={x.qualificationId} className="vrow" data-testid={`cs-vrow-${x.qualificationId}`}>
        <div><p className="nm"><Link href={`/customers/${x.customerId}`}>{x.customerName ?? 'مشتری'}</Link><span className="cid">#{fa(x.customerId)}</span><span className="muted">{dayI(x.at)}</span></p>
          <p className="sub">{x.missing.map((m) => <span key={m.key} className="chip r"><X className="i" aria-hidden="true" />{m.label}</span>)}</p></div>
        {x.eventId ? <Link className="btn gh sm" href={`/call-view/${x.eventId}`}><FileText className="i" aria-hidden="true" />خلاصه‌ی تماس</Link> : <Link className="btn gh sm" href={`/customers/${x.customerId}`}><FileText className="i" aria-hidden="true" />پرونده</Link>}</div>)}
        {d.more || page > 1 ? <div className="vm vpad">{page > 1 ? <button type="button" className="btn lk sm" onClick={() => setPage(page - 1)}>قبلی</button> : null}
          {d.more ? <button type="button" className="btn lk sm" onClick={() => setPage(page + 1)} data-testid="cs-more">تماس‌های بیشتر</button> : null}</div> : null}</section> : null}
    </div>;
  }
  const d = rep.data;
  const empty = d && d.totals.calls === 0;
  return <div className="csf page" dir="rtl" data-testid="cs-report">
    <div className="hrow"><h2>گزارش موارد اجباری</h2></div>{per}
    {rep.isError ? <p className="err" role="alert"><AlertTriangle className="i" aria-hidden="true" />{rep.error.message}</p> : null}
    {rep.isLoading ? <p className="muted">در حال دریافت…</p> : null}
    {empty ? <section className="card vpad mem" role="status" data-testid="cs-report-empty"><p className="tt"><FileText className="i" aria-hidden="true" />در این بازه خلاصه‌ی تماسی ثبت نشده است</p>
      <button type="button" className="btn gh" onClick={() => pick('week')}>این هفته</button></section> : null}
    {d && !empty ? <>
      <div className="mkp" data-testid="cs-totals"><span className="chip">تماس‌ها: {fa(d.totals.calls)}</span><span className="chip r">خلاصه با مورد خالی: {fa(d.totals.withEmpty)}</span><span className="chip r">مورد خالی: {fa(d.totals.empty)}</span></div>
      <section className="card mtab"><table><thead><tr><th>کارشناس</th><th>تماس‌ها</th><th>خلاصه با مورد خالی</th><th>جمع موارد خالی</th><th>بیشترین مورد خالی</th><th /></tr></thead>
        <tbody>{d.experts.map((e) => <tr key={e.userId} data-testid={`cs-exp-${e.userId}`}><td><b>{e.name}</b></td><td>{fa(e.calls)}</td><td>{fa(e.withEmpty)}</td><td>{fa(e.empty)}</td>
          <td>{e.top ? <span className="chip r">{e.top.label}</span> : <span className="muted">—</span>}</td>
          <td><button type="button" className="btn lk sm" onClick={() => { setExpert(e.userId); setPage(1); }} data-testid={`cs-exp-open-${e.userId}`}>جزئیات</button></td></tr>)}</tbody></table></section>
      <div className="mcards">{d.experts.map((e) => <button key={e.userId} type="button" className="card vpad mcd" onClick={() => { setExpert(e.userId); setPage(1); }} data-testid={`cs-card-${e.userId}`}>
        <p className="nm"><b>{e.name}</b></p><dl><dt>تماس‌ها</dt><dd>{fa(e.calls)}</dd><dt>خلاصه با مورد خالی</dt><dd>{fa(e.withEmpty)}</dd><dt>جمع موارد خالی</dt><dd>{fa(e.empty)}</dd></dl>
        {e.top ? <span className="chip r">بیشترین: {e.top.label}</span> : null}</button>)}</div></> : null}
  </div>;
}
