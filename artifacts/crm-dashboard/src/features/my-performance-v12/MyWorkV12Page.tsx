/** عملکرد من v1.2 (flag.my_performance_v12). Three tabs, one shared Jalali range. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { toApiDay, toJalaliValue } from '@/features/sales-performance/sales-performance-dates';
import { useMyWorkCalls, useMyWorkKpis, useMyWorkMe, useMyWorkReport, type MpCallRow, type MpKpiItem, type MpKpiReport, type MpReport } from './api';
import { faPhone } from '../social-hub/ui';
import { deltaText, faDuration } from '../my-performance-v11/format';
import { faNum } from './format';
import '../my-performance-v11/my-performance-v11.css';
import './my-performance-v12.css';

type Period = 'day' | 'week' | 'month' | 'custom';
type Tab = 'summary' | 'kpis' | 'calls';
type KGroup = 'sales' | 'discipline' | 'growth';

function paramsFrom(search: string): { period: Period; tab: Tab; group: KGroup; from?: string; to?: string } {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = q.get('period');
  const period: Period = raw === 'week' || raw === 'month' || raw === 'custom' ? raw : 'day';
  const tab: Tab = q.get('tab') === 'kpis' || q.get('tab') === 'calls' ? q.get('tab') as Tab : 'summary';
  const g = q.get('group');
  const group: KGroup = g === 'discipline' || g === 'growth' ? g : 'sales';
  return { period, tab, group, from: q.get('from') || undefined, to: q.get('to') || undefined };
}

function longDate(isoDay?: string): string {
  const d = isoDay ? new Date(`${isoDay}T12:00:00+03:30`) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

function rangeNote(period: Period, label: string, previousLabel: string, to?: string): string {
  const prev = period === 'day' ? 'دیروز' : period === 'week' ? 'هفتهٔ قبل' : period === 'month' ? 'ماه قبل' : previousLabel;
  const head = period === 'day' ? `بازه: امروز، ${longDate(to)}` : period === 'week' ? `بازه: این هفته، ${label}` : period === 'month' ? `بازه: این ماه، ${label}` : `بازه: ${label}`;
  return `${head} · نسبت به ${prev}`;
}

function Delta({ d }: { d: MpReport['self']['calls']['delta'] }) {
  const v = deltaText(d);
  if (!v) return null;
  return <div className={`delta ${v.cls}`}>{v.text}</div>;
}

function Card({ title, value, unit, extra, avg, children }: { title: string; value: ReactNode; unit?: string; extra?: ReactNode; avg?: ReactNode; children?: ReactNode }) {
  return (
    <article className="card">
      <h3>{title}</h3>
      <div className="num">{value}{unit ? <span className="u">{unit}</span> : null}</div>
      {extra}
      {avg != null ? <p className="avg">میانگین تیم: {avg}</p> : null}
      {children}
    </article>
  );
}

function FormulaSheet({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <div className="formula-sheet" data-open="1" role="dialog" aria-modal="true" aria-labelledby="mp-formula-t" onClick={onClose}>
      <div className="inner" onClick={(e) => e.stopPropagation()}>
        <h3 id="mp-formula-t">{title}</h3>
        <p>{text}</p>
        <button type="button" className="btn gh" onClick={onClose}>بستن</button>
      </div>
    </div>
  );
}

function KpiCard({ item, onFormula }: { item: MpKpiItem; onFormula: (item: MpKpiItem) => void }) {
  const formulaBtn = (extra?: string) => (
    <button type="button" className={extra ? `fbtn ${extra}` : 'fbtn'} onClick={() => onFormula(item)}>فرمول</button>
  );
  return (
    <article className="kc card">
      <div className="kc-a">
        <h3>{item.label}</h3>
        {formulaBtn()}
      </div>
      <div className="kc-b">
        <div className="num">{item.display}{item.incomplete ? <span className="u">داده‌ی ناقص</span> : null}</div>
      </div>
      <p className="avg">میانگین تیم: {item.teamAvgDisplay ?? '—'}</p>
      <p className="avg">رتبهٔ شما: {item.rank != null ? `${faNum(item.rank)} از ${faNum(item.of)}` : '—'}</p>
      {formulaBtn('fm')}
    </article>
  );
}

export default function MyWorkV12Page() {
  const [location, setLocation] = useLocation();
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const parsed = useMemo(() => paramsFrom(search), [search, location]);
  const me = useMyWorkMe(true);
  const ready = Boolean(me.data?.canView && me.data.v12);
  const rangeQ = {
    period: parsed.period,
    from: parsed.period === 'custom' ? parsed.from : undefined,
    to: parsed.period === 'custom' ? parsed.to : undefined,
  };
  const report = useMyWorkReport(ready && parsed.tab === 'summary', rangeQ);
  const kpis = useMyWorkKpis(ready && parsed.tab === 'kpis', rangeQ);
  const [dir, setDir] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [result, setResult] = useState<'all' | 'missed' | 'ok' | 'later'>('all');
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const calls = useMyWorkCalls(ready && parsed.tab === 'calls', {
    ...rangeQ,
    direction: dir === 'all' ? undefined : dir,
    result: result === 'all' ? undefined : result,
    waiting: waitingOnly ? '1' : undefined,
    q: q || undefined,
    page,
  });
  const [from, setFrom] = useState(() => toJalaliValue(parsed.from) || '');
  const [to, setTo] = useState(() => toJalaliValue(parsed.to) || '');
  const [formula, setFormula] = useState<{ title: string; text: string } | null>(null);
  const [sheet, setSheet] = useState(false);

  useEffect(() => { document.title = 'عملکرد من | نفیس وام'; }, []);
  useEffect(() => { setPage(1); }, [parsed.period, parsed.from, parsed.to, dir, result, waitingOnly, q]);

  const go = (next: { period?: Period; tab?: Tab; group?: KGroup; from?: string; to?: string }) => {
    const period = next.period ?? parsed.period;
    const tab = next.tab ?? parsed.tab;
    const group = next.group ?? parsed.group;
    const p = new URLSearchParams();
    p.set('period', period);
    p.set('tab', tab);
    if (tab === 'kpis') p.set('group', group);
    const f = next.from ?? (period === 'custom' ? parsed.from : undefined);
    const t = next.to ?? (period === 'custom' ? parsed.to : undefined);
    if (period === 'custom' && f && t) { p.set('from', f); p.set('to', t); }
    setLocation(`/my-work?${p.toString()}`);
  };

  if (me.isFetched && (me.failureReason as { status?: number } | undefined)?.status === 404) return <NotFound />;
  if (me.isFetched && !me.isError && me.data && !me.data.canView) return <NotFound />;

  const who = me.data?.self;
  const data = report.data;
  const kpiData = kpis.data;
  const callData = calls.data;
  const maxBar = Math.max(1, ...(data?.trend.columns.map((c) => c.value) ?? [1]));
  const rangeLabel = data?.range.label || kpiData?.label || callData?.label || '';
  const prevLabel = data?.range.previousLabel || kpiData?.previousLabel || '';
  const toDay = data?.range.to || kpiData?.to || callData?.to;
  const groupItems = kpiData ? kpiData.groups[parsed.group] : [];
  const GROUP_LABEL: Record<KGroup, string> = { sales: 'فروش فردی', discipline: 'پیگیری و نظم', growth: 'رشد فردی' };

  return (
    <div className="mpv12 mpv11" dir="rtl" lang="fa" data-testid="page-my-work-v12">
      <div className="kicker">
        <div className="who">{who?.name}{who?.teamName ? <span className="meta"> · {who.teamName}</span> : null}</div>
      </div>
      <div className="range" role="group" aria-label="بازه">
        {([['day', 'امروز'], ['week', 'این هفته'], ['month', 'این ماه'], ['custom', 'بازهٔ دلخواه']] as const).map(([k, l]) => (
          <button key={k} type="button" className="chip" aria-pressed={parsed.period === k} onClick={() => go({ period: k })}>{l}</button>
        ))}
      </div>
      {parsed.period === 'custom' ? (
        <div className="custom" data-open="1">
          <div className="fld"><label>از</label>
            <PersianDatePicker value={from} onChange={setFrom} ariaLabel="از" /></div>
          <div className="fld"><label>تا</label>
            <PersianDatePicker value={to} onChange={setTo} ariaLabel="تا" /></div>
          <button type="button" className="btn pri" disabled={!from || !to} onClick={() => {
            const f = toApiDay(from); const t = toApiDay(to);
            if (f && t) go({ period: 'custom', from: f, to: t });
          }}>اعمال بازه</button>
        </div>
      ) : null}
      <p className="range-note">{rangeNote(parsed.period, rangeLabel, prevLabel, toDay)}</p>

      <div className="tabs" role="tablist" aria-label="بخش‌های عملکرد من">
        {([['summary', 'خلاصه'], ['kpis', 'شاخص‌ها'], ['calls', 'تماس‌ها']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" className="tab" aria-current={parsed.tab === k ? 'page' : undefined} onClick={() => go({ tab: k })}>{l}</button>
        ))}
      </div>

      {parsed.tab === 'summary' ? (
        <div className="pane" data-testid="tab-summary">
          {report.isLoading ? <p className="range-note">در حال بارگذاری…</p> : null}
          {data ? (
            <>
              <div className="grid">
                <article className="card wide">
                  <h3>تماس‌ها</h3>
                  <div className="num">{faNum(data.self.calls.value)}</div>
                  <Delta d={data.self.calls.delta} />
                  <div className="break">
                    <div><b>{faNum(data.self.outbound.value)}</b><span>خروجی</span></div>
                    <div><b>{faNum(data.self.inbound.value)}</b><span>ورودی</span></div>
                    <div><b>{faNum(data.self.answered.value)}</b><span>جواب‌داده</span></div>
                    <div><b>{faNum(data.self.noAnswer.value)}</b><span>بی‌پاسخ</span></div>
                  </div>
                  <div className="num" style={{ marginTop: 8, fontSize: 20 }}>{faDuration(data.self.durationSec.value)}<span className="u">مدت کل</span></div>
                  {data.team ? <p className="avg">میانگین تیم: {faNum(data.team.averages.calls)}</p> : null}
                </article>
                <Card title="مشتری جدید" value={faNum(data.self.newCustomers.value)} extra={<Delta d={data.self.newCustomers.delta} />} avg={data.team ? faNum(data.team.averages.newCustomers) : undefined} />
                <Card title="پروندهٔ بازشده" value={faNum(data.self.filed.value)} extra={<Delta d={data.self.filed.delta} />} avg={data.team ? faNum(data.team.averages.filed) : undefined} />
                <Card title="رسیده به قرارداد" value={faNum(data.self.signed.value)} extra={<Delta d={data.self.signed.delta} />} avg={data.team ? faNum(data.team.averages.signed) : undefined} />
                <Card title="گفتگوی بله" value={faNum(data.self.baleChats.value)} extra={<><div className="avg">{faNum(data.self.baleMessages.value)} پیام ارسال‌شده</div><Delta d={data.self.baleMessages.delta} /></>} avg={data.team ? faNum(data.team.averages.baleMessages) : undefined} />
                <Card title="پیگیری" value={<>{faNum(data.self.followups.done)}<span className="u">از {faNum(data.self.followups.due)}</span></>} />
              </div>
              <div className="lower">
                <section className="chart block">
                  <h2>روند تماس‌ها</h2>
                  <div className="bars" aria-label="نمودار تماس">
                    {data.trend.columns.map((c) => (
                      <div key={c.key} className={`col${c.current ? ' today' : ''}`}>
                        <i style={{ height: `${Math.max(4, (c.value / maxBar) * 100)}%` }} />
                        <span>{c.label}</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="team block">
                  <h2>تیم من</h2>
                  {data.team ? (
                    <>
                      <div className="rank-row">
                        <span className="badge">{data.team.rank != null ? `رتبه ${faNum(data.team.rank)} از ${faNum(data.team.of)}` : 'بدون رتبه'}</span>
                        {data.team.name ? <span className="badge soft">{data.team.name}</span> : null}
                      </div>
                      <table className="cmp">
                        <thead><tr><th>شاخص</th><th>شما</th><th>میانگین تیم</th></tr></thead>
                        <tbody>
                          <tr><td>تماس‌ها</td><td className="you">{faNum(data.self.calls.value)}</td><td>{faNum(data.team.averages.calls)}</td></tr>
                          <tr><td>مشتری جدید</td><td className="you">{faNum(data.self.newCustomers.value)}</td><td>{faNum(data.team.averages.newCustomers)}</td></tr>
                          <tr><td>پروندهٔ بازشده</td><td className="you">{faNum(data.self.filed.value)}</td><td>{faNum(data.team.averages.filed)}</td></tr>
                          <tr><td>رسیده به قرارداد</td><td className="you">{faNum(data.self.signed.value)}</td><td>{faNum(data.team.averages.signed)}</td></tr>
                        </tbody>
                      </table>
                    </>
                  ) : <p className="avg">رتبهٔ تیمی برای این نقش محاسبه نمی‌شود.</p>}
                </section>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {parsed.tab === 'kpis' ? (
        <div className="pane" data-testid="tab-kpis">
          {kpis.isLoading ? <p className="range-note">در حال بارگذاری…</p> : null}
          {kpiData ? (
            <>
              <article className="kc score card">
                <h3>امتیاز عملکرد</h3>
                <div className="sc-val"><div className="num">{kpiData.score.value != null ? faNum(kpiData.score.value) : '—'}</div></div>
                <p className="avg">میانگین تیم: {kpiData.score.teamAvg != null ? faNum(kpiData.score.teamAvg, 1) : '—'}</p>
                <p className="avg">رتبهٔ شما: {kpiData.score.rank != null ? `${faNum(kpiData.score.rank)} از ${faNum(kpiData.score.of)}` : '—'}</p>
                {kpiData.score.roleLabel ? <p className="avg">نقش: {kpiData.score.roleLabel}</p> : null}
                <button type="button" className="fbtn" onClick={() => setFormula({ title: 'فرمول امتیاز عملکرد', text: kpiData.score.formula })}>فرمول</button>
              </article>
              <div className="subtabs" role="tablist" aria-label="گروه شاخص">
                {([['sales', 'فروش فردی'], ['discipline', 'پیگیری و نظم'], ['growth', 'رشد فردی']] as const).map(([k, l]) => (
                  <button key={k} type="button" className="chip" aria-pressed={parsed.group === k} onClick={() => go({ group: k })}>{l}</button>
                ))}
              </div>
              <div className="sec-h"><h2>{GROUP_LABEL[parsed.group]}</h2></div>
              {groupItems.length ? (
                <div className="kgrid">
                  {groupItems.map((item) => <KpiCard key={item.key} item={item} onFormula={(it) => setFormula({ title: it.label, text: it.formula })} />)}
                </div>
              ) : <p className="range-note">در این گروه شاخص قابل نمایش نیست.</p>}
            </>
          ) : null}
        </div>
      ) : null}

      {parsed.tab === 'calls' ? (
        <div className="pane" data-testid="tab-calls">
          {calls.isLoading ? <p className="range-note">در حال بارگذاری…</p> : null}
          {callData ? (
            <>
              <div className="cmp-grid">
                {([
                  ['تماس‌ها', callData.totals.calls, callData.teamAvg.calls, false],
                  ['جواب‌داده', callData.totals.answered, callData.teamAvg.answered, false],
                  ['بی‌پاسخ', callData.totals.noAnswer, callData.teamAvg.noAnswer, false],
                  ['مدت کل', callData.totals.durationSec, callData.teamAvg.durationSec, true],
                  ['شمارهٔ یکتا', callData.totals.unique, callData.teamAvg.unique, false],
                  ['میانگین مدت', callData.totals.avgDuration ?? 0, callData.teamAvg.avgDuration ?? 0, true],
                  ['خروجی', callData.totals.outbound, callData.teamAvg.outbound, false],
                  ['ورودی', callData.totals.inbound, callData.teamAvg.inbound, false],
                ] as Array<[string, number, number, boolean]>).map(([l, v, a, dur]) => (
                  <Card key={l} title={l} value={dur ? faDuration(v) : faNum(v)} avg={dur ? faDuration(a) : faNum(a)} />
                ))}
              </div>
              <div className="filters range">
                <button type="button" className="wait-chip" aria-pressed={waitingOnly} onClick={() => setWaitingOnly((w) => !w)}>
                  {faNum(callData.waitingCount)} تماس منتظر تماس مجدد
                </button>
                <input className="search fld" aria-label="جست‌وجو" placeholder="نام، موبایل یا شناسه" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="fg desk" role="group" aria-label="جهت">
                  <span className="lbl">جهت</span>
                  {([['all', 'همه'], ['incoming', 'ورودی'], ['outgoing', 'خروجی']] as const).map(([k, l]) => (
                    <button key={k} type="button" className="chip" aria-pressed={dir === k} onClick={() => setDir(k)}>{l}</button>
                  ))}
                </div>
                <div className="fg desk" role="group" aria-label="نتیجه">
                  <span className="lbl">نتیجه</span>
                  {([['all', 'همه'], ['missed', 'پاسخ نداد'], ['ok', 'موفق'], ['later', 'بازگشت']] as const).map(([k, l]) => (
                    <button key={k} type="button" className="chip" aria-pressed={result === k} onClick={() => setResult(k)}>{l}</button>
                  ))}
                </div>
                <button type="button" className="f-sheet-btn chip" onClick={() => setSheet(true)}>فیلتر</button>
              </div>
              <table className="ctable">
                <thead><tr><th>زمان</th><th>مشتری</th><th>شماره</th><th>جهت</th><th>نتیجه</th><th>مدت</th><th>کارها</th></tr></thead>
                <tbody>
                  {callData.rows.map((r) => (
                    <tr key={r.id} className={r.waitingCallback ? 'wait-row' : undefined}>
                      <td>{r.atLabel}</td>
                      <td>{r.customerName || '—'}{r.customerId != null ? <span className="idb">#{faNum(r.customerId)}</span> : null}</td>
                      <td><bdi dir="ltr" className="phone">{r.phone ? faPhone(r.phone) : '—'}</bdi></td>
                      <td>{r.direction === 'incoming' ? 'ورودی' : r.direction === 'outgoing' ? 'خروجی' : '—'}</td>
                      <td>{r.resultLabel}</td>
                      <td>{r.durationSec != null ? faDuration(r.durationSec) : '—'}</td>
                      <td>{r.waitingCallback && r.hasVoip ? <button type="button" className="btn pri">تماس</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mlist">
                {callData.rows.map((r) => (
                  <article key={r.id} className={`mcall${r.waitingCallback ? ' wait-row' : ''}`}>
                    <div className="topr"><span>{r.atLabel}</span><span>{r.direction === 'incoming' ? 'ورودی' : r.direction === 'outgoing' ? 'خروجی' : '—'}</span></div>
                    <div className="who-c">{r.customerName || '—'}{r.customerId != null ? <span className="idb">#{faNum(r.customerId)}</span> : null}</div>
                    <div className="row2"><bdi dir="ltr" className="phone">{r.phone ? faPhone(r.phone) : '—'}</bdi><span>{r.resultLabel} · {r.durationSec != null ? faDuration(r.durationSec) : '—'}</span></div>
                    {r.waitingCallback && r.hasVoip ? <div className="acts"><button type="button" className="btn pri">تماس</button></div> : null}
                  </article>
                ))}
              </div>
              {callData.totalRows > callData.pageSize ? (
                <nav className="range" aria-label="صفحه‌های فهرست تماس">
                  <button type="button" className="chip" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>قبلی</button>
                  <span className="meta">{faNum(callData.page)} از {faNum(Math.max(1, Math.ceil(callData.totalRows / callData.pageSize)))}</span>
                  <button type="button" className="chip" disabled={page * callData.pageSize >= callData.totalRows} onClick={() => setPage((p) => p + 1)}>بعدی</button>
                </nav>
              ) : null}
              {sheet ? (
                <div className="f-sheet" data-open="1" role="dialog" aria-label="فیلتر جهت و نتیجه">
                  <div className="inner">
                    <h3>فیلتر</h3>
                    <div className="range" role="group" aria-label="جهت">
                      {([['all', 'همه'], ['incoming', 'ورودی'], ['outgoing', 'خروجی']] as const).map(([k, l]) => (
                        <button key={k} type="button" className="chip" aria-pressed={dir === k} onClick={() => setDir(k)}>{l}</button>
                      ))}
                    </div>
                    <div className="range" role="group" aria-label="نتیجه">
                      {([['all', 'همه'], ['missed', 'پاسخ نداد'], ['ok', 'موفق'], ['later', 'بازگشت']] as const).map(([k, l]) => (
                        <button key={k} type="button" className="chip" aria-pressed={result === k} onClick={() => setResult(k)}>{l}</button>
                      ))}
                    </div>
                    <button type="button" className="btn pri" onClick={() => setSheet(false)}>نمایش نتیجه</button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {formula ? <FormulaSheet title={formula.title} text={formula.text} onClose={() => setFormula(null)} /> : null}
    </div>
  );
}


