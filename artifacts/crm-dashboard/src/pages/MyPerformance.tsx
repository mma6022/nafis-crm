/* Task D «تحلیل عملکرد من» (inside «عملکرد و پورسانت من»): روز گذشته / هفته / ماه شمسی — real numbers next to the previous
   period, then the manager assistant's written analysis. Counts and money only (no answered / result / duration). */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { toPersianDigits } from '@/lib/customer-id';
import './customers.css';
import './my-performance.css';

type Period = 'day' | 'week' | 'month';
type Numbers = { calls: number; overdueReminders: number; p1NoCall: number; siteLeadsNoCall: number; sentToRegistration: number;
  deposited: { count: number; payoutToman: string; commissionToman: string } };
type Analysis = { id: number; salespersonId: number; salespersonName: string | null; period: Period; periodStart: string; body: string; authorLabel: string | null; createdAt: string };
type Report = { salespersonId: number; period: Period; periodStart: string; label: string; complete: boolean; numbers: Numbers; previousNumbers: Numbers;
  definitions: Record<string, string>; analysis: Analysis | null; experts?: { salespersonId: number; name: string }[] };

const PS_FA: Record<Period, string> = { day: 'روز', week: 'هفته‌ی', month: 'ماه' };
function psLabel(p: Period, ps: string): string {
  const d = new Date(`${ps}T12:00:00+03:30`); if (Number.isNaN(d.getTime())) return toPersianDigits(ps);
  const opt: Intl.DateTimeFormatOptions = p === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' };
  return `${PS_FA[p]} ${new Intl.DateTimeFormat('fa-IR-u-ca-persian', { ...opt, timeZone: 'Asia/Tehran' }).format(d)}`;
}
const TABS: { id: Period; label: string; prev: string }[] = [
  { id: 'day', label: 'روز گذشته', prev: 'روز قبلش' }, { id: 'week', label: 'هفته', prev: 'هفته‌ی قبل' }, { id: 'month', label: 'ماه', prev: 'ماه قبل' }];
const fa = (n: number | string) => toPersianDigits(String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const faDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' }); const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 403 ? 'این صفحه برای حساب شما فعال نیست.' : (b as { message?: string }).message || 'دریافت اطلاعات انجام نشد.');
  return b as T;
}

/** Safe markdown subset → React elements (headings, bullets, numbered lists, **bold**). No HTML is ever injected. */
function bold(t: string, k: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((p, i) => p.startsWith('**') && p.endsWith('**') ? <b key={`${k}-${i}`}>{toPersianDigits(p.slice(2, -2))}</b> : <span key={`${k}-${i}`}>{toPersianDigits(p)}</span>);
}
/** [text](/internal/path) only — same-origin CRM paths become links; anything else stays plain text. */
function inline(t: string, k: string): ReactNode[] {
  return t.split(/(\[[^\]\n]{1,120}\]\([^)\s]{0,200}\))/g).filter(Boolean).flatMap((p, i) => {
    const m = p.match(/^\[([^\]]+)\]\(([^)\s]*)\)$/);
    if (!m) return bold(p, `${k}-${i}`);
    const href = m[2];
    return /^\/(?!\/)[\w\-/?=&%.#]*$/.test(href) ? [<a key={`${k}-a${i}`} href={href} className="csx-link">{bold(m[1], `${k}-a${i}`)}</a>] : bold(m[1], `${k}-t${i}`);
  });
}
export function SafeMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = []; let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => { if (!list) return; const L = list; const items = L.items.map((x, i) => <li key={i}>{inline(x, `li${out.length}-${i}`)}</li>);
    out.push(L.ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>); list = null; };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd(); let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*(?:\d+|[۰-۹]+)[.)]\s+(.*)$/))) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; } list.items.push(m[1]); continue; }
    flush();
    if (!line.trim()) continue;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { const lvl = Math.min(4, m[1].length + 1); const c = inline(m[2], `h${out.length}`);
      out.push(lvl <= 2 ? <h2 key={out.length}>{c}</h2> : lvl === 3 ? <h3 key={out.length}>{c}</h3> : <h4 key={out.length}>{c}</h4>); continue; }
    out.push(<p key={out.length}>{inline(line.replace(/^>\s?/, ''), `p${out.length}`)}</p>);
  }
  flush();
  return <>{out}</>;
}

function Cmp({ cur, prev, lowerIsBetter, prevLabel }: { cur: number; prev: number; lowerIsBetter?: boolean; prevLabel: string }) {
  const d = cur - prev; const good = lowerIsBetter ? d < 0 : d > 0; const bad = lowerIsBetter ? d > 0 : d < 0;
  return <div className="mp-cmp"><span>{prevLabel}: {fa(prev)}</span>
    <span className={`mp-chip ${good ? 'good' : bad ? 'bad' : ''}`}>{d === 0 ? 'بدون تغییر' : `${d > 0 ? '+' : '−'}${fa(Math.abs(d))}`}</span></div>;
}
const bigDiff = (a: string, b: string) => { try { return BigInt(a) - BigInt(b); } catch { return 0n; } };
function MoneyCmp({ cur, prev, prevLabel }: { cur: string; prev: string; prevLabel: string }) {
  const d = bigDiff(cur, prev);
  return <div className="mp-cmp"><span>{prevLabel}: {fa(prev)}</span>
    <span className={`mp-chip ${d > 0n ? 'good' : d < 0n ? 'bad' : ''}`}>{d === 0n ? 'بدون تغییر' : `${d > 0n ? '+' : '−'}${fa((d < 0n ? -d : d).toString())}`}</span></div>;
}

export default function MyPerformance() {
  const qs = useMemo(() => new URLSearchParams(window.location.search), []);
  const deep = Number(qs.get('analysis')) || null;
  const [period, setPeriod] = useState<Period>((['day', 'week', 'month'].includes(qs.get('period') ?? '') ? qs.get('period') : 'day') as Period);
  const [sp, setSp] = useState<string>(qs.get('salespersonId') ?? '');
  const [periodStart, setPeriodStart] = useState<string>('');
  const [picked, setPicked] = useState<Analysis | null>(null);
  // Deep link from the bell: open that analysis and its period.
  const deepQ = useQuery({ queryKey: ['my-performance-analysis', deep], enabled: Boolean(deep),
    queryFn: () => getJson<{ analyses: Analysis[] }>(`/api/my-performance/analyses?id=${deep}`), staleTime: 60_000 });
  useEffect(() => { const a = deepQ.data?.analyses?.[0]; if (a) { setPeriod(a.period); setPeriodStart(a.periodStart); setPicked(a); setSp(String(a.salespersonId)); window.setTimeout(() => document.querySelector('[data-testid="perf-analysis"]')?.scrollIntoView({ block: 'start' }), 600); } }, [deepQ.data]);
  const params = new URLSearchParams({ period }); if (sp) params.set('salespersonId', sp); if (periodStart) params.set('periodStart', periodStart);
  const q = useQuery({ queryKey: ['my-performance', period, sp, periodStart], queryFn: () => getJson<Report>(`/api/my-performance?${params}`), staleTime: 60_000 });
  const hp = new URLSearchParams({ period, limit: '12' }); if (sp) hp.set('salespersonId', sp);
  const hist = useQuery({ queryKey: ['my-performance-history', period, sp], queryFn: () => getJson<{ analyses: Analysis[] }>(`/api/my-performance/analyses?${hp}`), staleTime: 60_000 });
  const r = q.data; const tab = TABS.find(t => t.id === period)!;
  const analysis = picked && picked.period === period && (!r || picked.periodStart === r.periodStart) ? picked : r?.analysis ?? null;
  const n = r?.numbers; const p = r?.previousNumbers;
  const choose = (t: Period) => { setPeriod(t); setPeriodStart(''); setPicked(null); };
  return <section className="csx mp-page" dir="rtl" data-testid="page-my-performance">
    <h1 className="mp-title"><BarChart3 size={20} aria-hidden="true" /> عملکرد و پورسانت من · تحلیل عملکرد</h1>
    <div className="mp-tabs" role="tablist" aria-label="بازه">
      {TABS.map(t => <button key={t.id} role="tab" aria-selected={period === t.id} data-testid={`tab-${t.id}`} onClick={() => choose(t.id)}>{t.label}</button>)}
    </div>
    <div className="mp-head">
      <span className="csx-meta">{r ? <>بازه: <b>{toPersianDigits(r.label)}</b>{periodStart ? <> · <button type="button" className="csx-link" onClick={() => { setPeriodStart(''); setPicked(null); }}>بازه‌ی فعلی</button></> : null}</> : ' '}</span>
      {r?.experts?.length ? <label className="csx-meta">کارشناس:{' '}
        <select value={sp || String(r.salespersonId)} onChange={e => { setSp(e.target.value); setPicked(null); }} data-testid="select-expert">
          {r.experts.map(e => <option key={e.salespersonId} value={e.salespersonId}>{e.name}</option>)}</select></label> : null}
    </div>
    {q.isLoading ? <p className="csx-meta">در حال دریافت…</p> : null}
    {q.isError ? <div className="csx-note bad" role="alert"><p>{(q.error as Error).message}</p></div> : null}
    {n && p ? <div className="mp-grid" data-testid="perf-numbers">
      <div className="mp-card"><h3>تماس‌ها</h3><div className="mp-val" data-testid="num-calls">{fa(n.calls)}</div><Cmp cur={n.calls} prev={p.calls} prevLabel={tab.prev} /></div>
      <div className="mp-card"><h3>یادآورهای عقب‌افتاده</h3><div className="mp-val">{fa(n.overdueReminders)}</div><Cmp cur={n.overdueReminders} prev={p.overdueReminders} lowerIsBetter prevLabel={tab.prev} /></div>
      <div className="mp-card"><h3>اولویت ۱ بی‌تماس بیش از ۳ روز</h3><div className="mp-val">{fa(n.p1NoCall)}</div><Cmp cur={n.p1NoCall} prev={p.p1NoCall} lowerIsBetter prevLabel={tab.prev} /></div>
      <div className="mp-card"><h3>درخواست سایت بدون تماس</h3><div className="mp-val">{fa(n.siteLeadsNoCall)}</div><Cmp cur={n.siteLeadsNoCall} prev={p.siteLeadsNoCall} lowerIsBetter prevLabel={tab.prev} /></div>
      <div className="mp-card"><h3>ارسال به ثبت</h3><div className="mp-val">{fa(n.sentToRegistration)}</div><Cmp cur={n.sentToRegistration} prev={p.sentToRegistration} prevLabel={tab.prev} /></div>
      <div className="mp-card wide"><h3>وام‌های واریزشده</h3><div className="mp-val">{fa(n.deposited.count)} <small>مورد</small></div>
        <Cmp cur={n.deposited.count} prev={p.deposited.count} prevLabel={tab.prev} />
        <div className="mp-sub">مبلغ واریزی: <b>{fa(n.deposited.payoutToman)}</b> تومان</div><MoneyCmp cur={n.deposited.payoutToman} prev={p.deposited.payoutToman} prevLabel={tab.prev} />
        <div className="mp-sub">پورسانت: <b>{fa(n.deposited.commissionToman)}</b> تومان</div><MoneyCmp cur={n.deposited.commissionToman} prev={p.deposited.commissionToman} prevLabel={tab.prev} />
      </div>
    </div> : null}
    {r && !r.complete ? <p className="mp-def">بازه‌ی جاری تا همین الان حساب شده و با همان مدت از بازه‌ی قبل مقایسه شده است.</p> : null}
    <article className={`mp-an${deep && analysis?.id === deep ? ' mp-hl' : ''}`} data-testid="perf-analysis" aria-live="polite">
      <h2>تحلیل احمد</h2>
      {analysis ? <>
        <p className="mp-meta">{analysis.authorLabel ?? 'دستیار مدیر فروش'} · {faDate(analysis.createdAt)}</p>
        <SafeMarkdown text={analysis.body} />
      </> : <p className="csx-meta">برای این بازه هنوز تحلیلی ثبت نشده است.</p>}
    </article>
    {hist.data?.analyses?.length ? <details className="mp-hist"><summary>تحلیل‌های قبلی ({fa(hist.data.analyses.length)})</summary>
      <ul>{hist.data.analyses.map(a => <li key={a.id}><button type="button" data-testid={`analysis-${a.id}`} onClick={() => { setPeriodStart(a.periodStart); setPicked(a); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
        {psLabel(a.period, a.periodStart)}{a.salespersonName && r?.experts ? ` · ${a.salespersonName}` : ''} · {faDate(a.createdAt)}</button></li>)}</ul></details> : null}
  </section>;
}
