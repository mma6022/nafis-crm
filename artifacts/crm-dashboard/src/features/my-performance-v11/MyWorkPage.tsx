/** عملکرد من v1.1 (flag.my_performance_v1). Own work report. «استعلام» is not a metric on this page. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { formatSpJalaliField, toApiDay, toJalaliValue } from '@/features/sales-performance/sales-performance-dates';
import { useMyWorkMe, useMyWorkReport, type MpDelta, type MpMetric, type MpReport } from './api';
import { deltaText, faDuration, faNum } from './format';
import './my-performance-v11.css';
import MyWorkV12Page from '../my-performance-v12/MyWorkV12Page';

type Period = 'day' | 'week' | 'month' | 'custom';

function paramsFrom(search: string): { period: Period; from?: string; to?: string } {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = q.get('period');
  const period: Period = raw === 'week' || raw === 'month' || raw === 'custom' ? raw : 'day';
  return { period, from: q.get('from') || undefined, to: q.get('to') || undefined };
}

function longDate(isoDay?: string): string {
  const d = isoDay ? new Date(`${isoDay}T12:00:00+03:30`) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

function rangeNote(period: Period, r: MpReport['range']): string {
  const prev = period === 'day' ? 'دیروز' : period === 'week' ? 'هفتهٔ قبل' : period === 'month' ? 'ماه قبل' : r.previousLabel;
  const head = period === 'day' ? `بازه: امروز، ${longDate(r.to)}` : period === 'week' ? `بازه: این هفته، ${r.label}` : period === 'month' ? `بازه: این ماه، ${r.label}` : `بازه: ${r.label}`;
  return `${head} · نسبت به ${prev}`;
}

function Delta({ d }: { d: MpDelta }) {
  const v = deltaText(d);
  if (!v) return null;
  return <div className={`delta ${v.cls}`}>{v.text}</div>;
}

function Card({ title, metric, unit, extra, avg }: { title: string; metric: MpMetric; unit?: string; extra?: ReactNode; avg?: number }) {
  return (
    <article className="card">
      <h3>{title}</h3>
      <div className="num">{faNum(metric.value)}{unit ? <span className="u">{unit}</span> : null}</div>
      <Delta d={metric.delta} />
      {extra}
      {avg != null ? <p className="avg">میانگین تیم: {faNum(avg)}</p> : null}
    </article>
  );
}

export default function MyWorkPage() {
  const [location, setLocation] = useLocation();
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const parsed = useMemo(() => paramsFrom(search), [search, location]);
  const me = useMyWorkMe(true);
  const ready = Boolean(me.data?.canView);
  const report = useMyWorkReport(ready, {
    period: parsed.period,
    from: parsed.period === 'custom' ? parsed.from : undefined,
    to: parsed.period === 'custom' ? parsed.to : undefined,
  });
  const [from, setFrom] = useState(() => toJalaliValue(parsed.from) || '');
  const [to, setTo] = useState(() => toJalaliValue(parsed.to) || '');

  useEffect(() => { document.title = 'عملکرد من | نفیس وام'; }, []);

  const go = (period: Period, f?: string, t?: string) => {
    const p = new URLSearchParams();
    p.set('period', period);
    if (period === 'custom' && f && t) { p.set('from', f); p.set('to', t); }
    setLocation(`/my-work?${p.toString()}`);
  };

  if (me.isFetched && (me.failureReason as { status?: number } | undefined)?.status === 404) return <NotFound />;
  if (me.isFetched && !me.isError && me.data && !me.data.canView) return <NotFound />;
  if (me.data?.v12) return <MyWorkV12Page />;

  const data = report.data;
  const maxBar = Math.max(1, ...(data?.trend.columns.map((c) => c.value) ?? [1]));

  return (
    <div className="mpv11" dir="rtl" lang="fa" data-testid="page-my-work">
      <div className="kicker">
        <div className="who">{data?.self.name ?? me.data?.self?.name ?? ''}{data?.self.teamName ? ` · ${data.self.teamName}` : ''}</div>
      </div>

      <div className="range" role="group" aria-label="بازه">
        {([['day', 'امروز'], ['week', 'این هفته'], ['month', 'این ماه'], ['custom', 'بازهٔ دلخواه']] as const).map(([id, label]) => (
          <button key={id} type="button" className="chip" aria-pressed={parsed.period === id} data-testid={`mp-period-${id}`} onClick={() => go(id, parsed.from, parsed.to)}>{label}</button>
        ))}
      </div>
      {data ? <p className="range-note">{rangeNote(parsed.period, data.range)}</p> : <p className="range-note">در حال بارگذاری…</p>}

      {parsed.period === 'custom' ? (
        <form className="custom" aria-label="بازهٔ دلخواه" onSubmit={(e) => { e.preventDefault(); const f = toApiDay(from); const t = toApiDay(to); if (f && t) go('custom', f, t); }}>
          <div className="fld">
            <label htmlFor="mp-from">از</label>
            <PersianDatePicker value={from} onChange={setFrom} testId="mp-from" displayDigits formatDisplay={formatSpJalaliField} noFuture ariaLabel="از" />
          </div>
          <div className="fld">
            <label htmlFor="mp-to">تا</label>
            <PersianDatePicker value={to} onChange={setTo} testId="mp-to" displayDigits formatDisplay={formatSpJalaliField} noFuture ariaLabel="تا" />
          </div>
          <button className="btn pri" type="submit" data-testid="mp-apply-range">اعمال بازه</button>
        </form>
      ) : null}

      {report.isError ? <p className="err" role="alert">گزارش الان در دسترس نیست. دوباره تلاش کنید.</p> : null}

      {data ? <>
        <section className="grid" aria-label="شاخص‌های شما">
          <article className="card calls">
            <h3>تماس‌ها</h3>
            <div className="num">{faNum(data.self.calls.value)}<span className="u">تماس</span></div>
            <Delta d={data.self.calls.delta} />
            <div className="break">
              <div><span>خروجی</span><b>{faNum(data.self.outbound.value)}</b></div>
              <div><span>ورودی</span><b>{faNum(data.self.inbound.value)}</b></div>
              <div><span>جواب‌داده</span><b>{faNum(data.self.answered.value)}</b></div>
              <div><span>بی‌پاسخ</span><b>{faNum(data.self.noAnswer.value)}</b></div>
            </div>
            <p className="dur">مدت کل مکالمه: {faDuration(data.self.durationSec.value)}</p>
          </article>

          <Card title="مشتری جدید" metric={data.self.newCustomers} avg={data.team?.averages.newCustomers} />

          <Card title="پروندهٔ بازشده" metric={data.self.filed} avg={data.team?.averages.filed} />
          <Card title="رسیده به قرارداد" metric={data.self.signed} />
          <article className="card">
            <h3>گفتگوی بله</h3>
            <div className="num">{faNum(data.self.baleChats.value)}<span className="u">گفتگو</span></div>
            <p className="dur">{faNum(data.self.baleMessages.value)} پیام ارسال‌شده</p>
            <Delta d={data.self.baleChats.delta} />
          </article>
          <article className="card">
            <h3>پیگیری‌ها</h3>
            <div className="num">{faNum(data.self.followups.done)}<span className="u">از {faNum(data.self.followups.due)} سررسید</span></div>
            <div className="bar-track" aria-hidden="true"><i style={{ width: `${data.self.followups.due ? Math.round((data.self.followups.done / data.self.followups.due) * 100) : 0}%` }} /></div>
          </article>
        </section>

        <div className="lower">
          <section className="block">
            <h2>روند تماس‌ها</h2>
            <div className="chart" role="img" aria-label={data.trend.kind === 'hour' ? 'تماس‌ها از ساعت ۹ تا ۱۸' : 'تماس‌های بازه'}>
              <div className="bars">
                {data.trend.columns.map((c) => (
                  <div key={c.key} className={`col${c.current ? ' is-current' : ''}`}>
                    <i style={{ height: `${Math.max(6, Math.round((c.value / maxBar) * 100))}%` }} />
                    <span>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="block" aria-label="تیم من">
            <h2>تیم من</h2>
            <div className="team">
              <div className="rank-row">
                {data.team && data.team.rank != null ? <span className="badge">رتبهٔ شما: {faNum(data.team.rank)} از {faNum(data.team.of)} نفر</span> : <span className="badge soft">رتبه در این بازه محاسبه نمی‌شود</span>}
                {data.team?.name ? <span className="badge soft">{data.team.name}</span> : null}
              </div>
              {data.team ? (
                <table className="cmp">
                  <thead><tr><th>شاخص</th><th>شما</th><th>میانگین تیم</th></tr></thead>
                  <tbody>
                    <tr><td>تماس‌ها</td><td className="you">{faNum(data.self.calls.value)}</td><td>{faNum(data.team.averages.calls)}</td></tr>
                    <tr><td>مشتری جدید</td><td className="you">{faNum(data.self.newCustomers.value)}</td><td>{faNum(data.team.averages.newCustomers)}</td></tr>
                    <tr><td>پروندهٔ بازشده</td><td className="you">{faNum(data.self.filed.value)}</td><td>{faNum(data.team.averages.filed)}</td></tr>
                    <tr><td>رسیده به قرارداد</td><td className="you">{faNum(data.self.signed.value)}</td><td>{faNum(data.team.averages.signed)}</td></tr>
                    <tr><td>پیام بله</td><td className="you">{faNum(data.self.baleMessages.value)}</td><td>{faNum(data.team.averages.baleMessages)}</td></tr>
                  </tbody>
                </table>
              ) : <p className="ph">برای این حساب تیمی ثبت نشده است.</p>}
            </div>
          </section>
        </div>
      </> : null}
    </div>
  );
}
