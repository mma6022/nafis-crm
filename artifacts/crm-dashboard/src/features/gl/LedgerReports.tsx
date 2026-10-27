/**
 * G5 (2026-10-27): general-ledger reports, READ-ONLY. Trial balance (2/4/6 columns), journal, account ledger, posting queue
 * and the reconciliation report. Hidden behind gl.reports (OFF); no write action lives on this page.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Lock, Scale } from 'lucide-react';
import { EmptyState, Pagination } from '@/components/DataTools';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { errText } from '@/lib/goods-api';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { faGDate, glApi, glReason, rialToman, type GlFinanceRoles, type GlLevel, type GlStatus, type GlTbRow, type GlTotals } from '@/lib/gl-api';
import './ledger.css';

type Tab = 'tb' | 'journal' | 'ledger' | 'queue' | 'rec' | 'sp';
const TABS: { key: Tab; label: string }[] = [
  { key: 'tb', label: 'تراز آزمایشی' }, { key: 'journal', label: 'دفتر روزنامه' }, { key: 'ledger', label: 'دفتر حساب' },
  { key: 'queue', label: 'صف ثبت و استثناها' }, { key: 'rec', label: 'مغایرت‌ها' }, { key: 'sp', label: 'پورسانت کارشناس‌ها' },
];
const FLAG_LABEL: Record<string, string> = {
  'gl.shadow_nonbank': 'ثبت سایهٔ غیربانکی', 'gl.shadow_bank': 'ثبت سایهٔ بانکی', 'gl.bank_blocking': 'ثبت بانکی الزامی', 'gl.reports': 'گزارش‌ها', 'gl.nightly_compare': 'کنترل شبانه',
  'gl.p7_prefunded': 'P7 پیش‌دریافت (منتظر تأیید)',
};
const Q = { staleTime: 15_000 };

function DateRange({ from, to, setFrom, setTo, id }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; id: string }) {
  return <>
    <div className="field"><label>از تاریخ</label><PersianDatePicker value={from} onChange={setFrom} placeholder="ابتدای سال مالی" testId={`gl-${id}-from`} /></div>
    <div className="field"><label>تا تاریخ</label><PersianDatePicker value={to} onChange={setTo} placeholder="امروز" testId={`gl-${id}-to`} /></div>
  </>;
}
const g = (v: string) => (v ? jalaliValueToGregorian(v) : undefined);
const Loading = () => <SkeletonPanel rows={4} />;
const Failed = ({ e, retry }: { e: unknown; retry: () => void }) => <div className="panel"><div className="gp-alert">{errText(e)}</div><ErrorState onRetry={retry} /></div>;

export default function LedgerReports() {
  const status = useQuery({ queryKey: ['gl', 'status'], queryFn: () => glApi.status(), ...Q });
  const [tab, setTab] = useState<Tab>('tb');
  const s = status.data;
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canSp = session?.user?.role === 'admin' || !!session?.user?.permissions?.includes('gl.commission_totals.view');
  const tabs = TABS.filter((t) => t.key !== 'sp' || canSp);
  return <section className="data-page gl-page" data-testid="page-gl-reports">
    <Link href="/accounting" className="text-link gp-back"><ArrowRight size={14} />بازگشت به حسابداری</Link>
    <div className="page-intro"><div><div className="eyebrow">حسابداری · فقط نمایش</div><h2><BookOpen size={20} /> دفتر کل و تراز آزمایشی</h2>
      <p>گزارش‌ها فقط از سندهای مهروموم‌شدهٔ دفتر کل ساخته می‌شوند. حساب‌های انتظامی (۸۱) جدا و بیرون از جمع نشان داده می‌شوند.</p></div></div>
    {status.isLoading ? <Loading /> : status.isError ? <Failed e={status.error} retry={() => status.refetch()} /> : !s || !s.enabled ? <GlOff /> : <>
      <StatusPanel s={s} />
      <div className="gp-tabs" role="tablist" aria-label="گزارش‌های دفتر کل">{tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
        className={`gp-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)} data-testid={`tab-gl-${t.key}`}><span>{t.label}</span>
        {t.key === 'queue' && s.queueFailed ? <b>{s.queueFailed.toLocaleString('fa-IR')}</b> : null}</button>)}</div>
      {tab === 'tb' ? <TrialBalance /> : tab === 'journal' ? <Journal /> : tab === 'ledger' ? <AccountLedger /> : tab === 'queue' ? <QueueView /> : tab === 'sp' && canSp ? <CommissionTotals /> : <Reconciliation onQueue={() => setTab('queue')} />}
    </>}
  </section>;
}

function GlOff() {
  return <div className="panel" data-testid="gl-off"><EmptyState title="دفتر کل هنوز فعال نیست"
    description="پرداخت‌ها، کیف‌ها و دستورهای پرداخت مثل همیشه کار می‌کنند. وقتی دفتر کل با استقرار روشن شود، سندها از رویدادهای همین سامانه ساخته و این‌جا نشان داده می‌شوند." />
    <p className="gl-note" style={{ textAlign: 'center' }}>این خطا نیست و داده‌ای گم نشده. روشن کردن فقط از راه استقرار است، نه از این صفحه.</p></div>;
}

function StatusPanel({ s }: { s: Extract<GlStatus, { enabled: true }> }) {
  const o = s.opening; const c = o.check2101;
  const fy = s.fiscalYears.find((f) => s.today >= f.startDate && s.today <= f.endDate) ?? s.fiscalYears[0];
  const reasons = [...(s.baseOk ? [] : [s.baseError ?? '']), ...(o.lockReasons ?? [])].filter(Boolean);
  return <div className="panel" data-testid="gl-status" style={{ marginBottom: 12 }}>
    {c?.status === 'mismatch' ? <div className="gp-alert warn" data-testid="gl-2101-warn"><AlertTriangle size={15} /> <b>موجودی اولیه با دستورهای پرداخت‌شده نمی‌خواند.</b>{' '}
      ماندهٔ ۲۱۰۱ در موجودی اولیه {rialToman(c.draftRial)} تومان است ولی جمع دستورهای پرداخت‌نشده تا تاریخ مبنا {rialToman(c.expectedRial)} تومان است. تا این اختلاف رفع نشود، تأیید سند افتتاحیه قفل است.</div> : null}
    {c?.status === 'step4_pending' ? <div className="gp-alert warn" data-testid="gl-step4-warn"><Lock size={14} /> گام ۴ (دستورهای پرداخت‌شده تا تاریخ مبنا) هنوز تأیید نشده؛ تأیید سند افتتاحیه قفل است.</div> : null}
    <FinanceRolesWarn r={s.financeRoles} />
    <div className="gl-status-grid">
      <div><h3 className="panel-title">سال مالی و تاریخ‌ها</h3><div className="gp-kv">
        <span>سال مالی</span><b>{fy ? `${fy.title.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])} (${faGDate(fy.startDate)} تا ${faGDate(fy.endDate)})` : 'تعریف نشده'}</b>
        <span>شروع دفتر کل</span><b data-testid="gl-start-date">{faGDate(s.ledgerStartDate)}</b>
        <span>تاریخ مبنا (مرز دستورهای پرداخت‌شده)</span><b data-testid="gl-base-date">{faGDate(s.baseDate)}</b>
      </div></div>
      <div><h3 className="panel-title">سند افتتاحیه</h3><div className="gp-kv">
        <span>وضعیت</span><b>{o.state === 'posted' ? 'ثبت شده' : o.state === 'draft' ? 'پیش‌نویس' : 'ثبت نشده'}</b>
        <span>گام ۴</span><b>{o.step4Done ? 'تأیید شده' : 'تأیید نشده'}</b>
        <span>سندها / صف</span><b>{s.vouchers.toLocaleString('fa-IR')} سند · {s.queuePending.toLocaleString('fa-IR')} در صف · {s.queueFailed.toLocaleString('fa-IR')} ناموفق</b>
      </div>
        {o.state !== 'posted' ? <><button type="button" className="btn btn-ghost" disabled title="تأیید با نفر دوم و از مسیر موجودی اولیه" data-testid="gl-opening-locked"><Lock size={14} />تأیید سند افتتاحیه (قفل)</button>
          {reasons.length ? <ul className="gl-note" data-testid="gl-lock-reasons">{reasons.map((r) => <li key={r}>{glReason(r)}</li>)}</ul> : null}
          <p className="gl-note">تأیید فقط با نفر دوم (غیر از ثبت‌کننده) و پس از گام ۴ و رفع اختلاف ۲۱۰۱.</p></> : null}
      </div>
      <div><h3 className="panel-title">پرچم‌ها (فقط نمایش)</h3><div className="gl-flags" data-testid="gl-flags">
        {Object.entries(s.flags).map(([k, v]) => <span key={k} className={`gp-chip ${v ? 'green' : 'muted'}`}><i />{FLAG_LABEL[k] ?? k}: {v ? 'روشن' : 'خاموش'}</span>)}</div>
        <p className="gl-note">آخرین کنترل شبانه: {s.lastRun ? `${faGDate(s.lastRun.runDate)} · ${s.lastRun.status === 'ok' ? 'بدون مغایرت' : s.lastRun.status === 'mismatch' ? `${s.lastRun.mismatchCount.toLocaleString('fa-IR')} مغایرت` : s.lastRun.status === 'not_started' ? 'دفتر شروع نشده' : 'خطا'}` : 'هنوز اجرا نشده'}</p></div>
    </div>
  </div>;
}

const COLS = { 2: 'گردش', 4: 'گردش و مانده', 6: 'کامل' } as const;
function TbCells({ r, cols }: { r: GlTotals; cols: 2 | 4 | 6 }) {
  return <>
    {cols === 6 ? <><td className="num" data-label="ماندهٔ ابتدا بدهکار">{rialToman(r.openDr)}</td><td className="num" data-label="ماندهٔ ابتدا بستانکار">{rialToman(r.openCr)}</td></> : null}
    <td className="num" data-label="گردش بدهکار">{rialToman(r.dr)}</td><td className="num" data-label="گردش بستانکار">{rialToman(r.cr)}</td>
    {cols >= 4 ? <><td className="num" data-label="مانده بدهکار">{rialToman(r.balDr)}</td><td className="num" data-label="مانده بستانکار">{rialToman(r.balCr)}</td></> : null}
  </>;
}
const addT = (a: GlTotals, r: GlTotals): GlTotals => ({ openDr: a.openDr + r.openDr, openCr: a.openCr + r.openCr, dr: a.dr + r.dr, cr: a.cr + r.cr, balDr: a.balDr + r.balDr, balCr: a.balCr + r.balCr });
const ZERO: GlTotals = { openDr: 0, openCr: 0, dr: 0, cr: 0, balDr: 0, balCr: 0 };
function TrialBalance() {
  const [cols, setCols] = useState<2 | 4 | 6>(4);
  const [level, setLevel] = useState<GlLevel>('moein');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const q = useQuery({ queryKey: ['gl', 'tb', level, g(from), g(to)], queryFn: () => glApi.trialBalance({ level, from: g(from), to: g(to) }), ...Q });
  const acc = useQuery({ queryKey: ['gl', 'accounts'], queryFn: () => glApi.accounts(), ...Q });
  const kolTitle = useMemo(() => new Map((acc.data?.accounts ?? []).filter((a) => a.code.length === 2).map((a) => [a.code, a.title])), [acc.data]);
  const head = <tr><th>حساب</th>{cols === 6 ? <><th className="num">ماندهٔ ابتدا بدهکار</th><th className="num">ماندهٔ ابتدا بستانکار</th></> : null}<th className="num">گردش بدهکار</th><th className="num">گردش بستانکار</th>{cols >= 4 ? <><th className="num">مانده بدهکار</th><th className="num">مانده بستانکار</th></> : null}</tr>;
  const name = (r: GlTbRow) => <><span className="gl-code">{level === 'tafsili' && r.tafsiliCode ? `${r.code}·${r.tafsiliCode}` : r.code}</span>{level === 'tafsili' && r.tafsiliTitle ? `${r.title} — ${r.tafsiliTitle}` : r.title}</>;
  const body = (rows: GlTbRow[], grouped: boolean) => {
    if (!grouped) return rows.map((r) => <tr key={r.key}><td className="gl-name">{name(r)}</td><TbCells r={r} cols={cols} /></tr>);
    const out: ReactElement[] = []; let cur = ''; let block: GlTbRow[] = [];
    const flush = () => { if (!block.length) return; const t = block.reduce(addT, ZERO);
      out.push(<tr key={`k${cur}`} className="gl-kol"><td className="gl-name"><span className="gl-code">{cur}</span>{kolTitle.get(cur) ?? cur}</td><TbCells r={t} cols={cols} /></tr>);
      block.forEach((r) => out.push(<tr key={r.key}><td className="gl-name">{name(r)}</td><TbCells r={r} cols={cols} /></tr>)); block = []; };
    for (const r of rows) { if (r.kol !== cur) { flush(); cur = r.kol; } block.push(r); }
    flush(); return out;
  };
  return <div className="panel" data-testid="gl-tb">
    <div className="gl-toolbar">
      <div className="gl-seg" role="group" aria-label="ستون‌ها">{([2, 4, 6] as const).map((n) => <button key={n} type="button" className={cols === n ? 'active' : ''} onClick={() => setCols(n)} title={COLS[n]} data-testid={`gl-cols-${n}`}>{n.toLocaleString('fa-IR')} ستونی</button>)}</div>
      <div className="field"><label>سطح</label><select value={level} onChange={(e) => setLevel(e.target.value as GlLevel)} data-testid="gl-tb-level"><option value="kol">کل</option><option value="moein">کل و معین</option><option value="tafsili">تفصیلی</option></select></div>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} id="tb" />
    </div>
    {q.isLoading ? <Loading /> : q.isError ? <Failed e={q.error} retry={() => q.refetch()} /> : !q.data || (!q.data.rows.length && !q.data.memoRows.length) ? <EmptyState title="سندی در این بازه نیست" description="هنوز سند مهروموم‌شده‌ای در دفتر کل ثبت نشده است." /> : <>
      <div className={`gp-alert ${q.data.balanced ? 'ok' : ''}`} data-testid="gl-tb-balanced">{q.data.balanced ? <CheckCircle2 size={14} /> : <Scale size={14} />} {q.data.balanced ? 'تراز آزمایشی تراز است' : 'تراز آزمایشی تراز نیست'}: جمع گردش بدهکار = {rialToman(q.data.totals.dr)} · جمع گردش بستانکار = {rialToman(q.data.totals.cr)} تومان</div>
      <h3 className="panel-title">تراز آزمایشی {cols.toLocaleString('fa-IR')} ستونی — {faGDate(q.data.from)} تا {faGDate(q.data.to)} (تومان)</h3>
      <div className="table-wrap"><table className="data-table gl-table"><thead>{head}</thead><tbody>
        {body(q.data.rows, level === 'moein')}
        <tr className="gl-total"><td className="gl-name">جمع</td><TbCells r={q.data.totals} cols={cols} /></tr>
      </tbody></table></div>
      {q.data.memoRows.length ? <><h3 className="panel-title" style={{ marginTop: 14 }}>حساب‌های انتظامی (بیرون از جمع)</h3>
        <div className="table-wrap"><table className="data-table gl-table" data-testid="gl-tb-memo"><thead>{head}</thead><tbody>{body(q.data.memoRows, false)}</tbody></table></div>
        <p className="gl-note">حساب‌های انتظامی فقط تعهد را نشان می‌دهند و در جمع تراز نمی‌آیند.</p></> : null}
    </>}
  </div>;
}

const KIND: Record<string, string> = { opening: 'افتتاحیه', posting: 'رویداد', reversal: 'برگشت', manual: 'دستی', backfill: 'بازسازی' };
function Journal() {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['gl', 'journal', g(from), g(to), page], queryFn: () => glApi.journal({ from: g(from), to: g(to), page }), ...Q });
  return <div className="panel" data-testid="gl-journal">
    <div className="gl-toolbar"><DateRange from={from} to={to} setFrom={(v) => { setFrom(v); setPage(1); }} setTo={(v) => { setTo(v); setPage(1); }} id="journal" /></div>
    {q.isLoading ? <Loading /> : q.isError ? <Failed e={q.error} retry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title="سندی در این بازه نیست" description="سندهای دفتر کل پس از روشن شدن ثبت، این‌جا به ترتیب تاریخ می‌آیند." /> : <>
      {q.data.items.map((v) => <div key={v.id} className="gl-voucher" data-testid={`gl-voucher-${v.id}`}>
        <div className="gl-voucher-head"><div><b>سند {v.finalNo ? `${v.finalNo.period}-${v.finalNo.seq}` : `موقت ${v.tempNo.toLocaleString('fa-IR')}`}</b> · {faGDate(v.eventDate)} · <span className="gp-chip muted">{KIND[v.kind] ?? v.kind}</span>
          {v.reversesVoucherId ? <span className="gp-chip red">برگشتِ سند #{v.reversesVoucherId.toLocaleString('fa-IR')}</span> : null}{v.reversedByVoucherId ? <span className="gp-chip gold">برگشت خورده</span> : null}</div>
          <span className="gp-money">{rialToman(v.totalRial)} تومان</span></div>
        {v.description ? <p className="gl-note">{v.description}</p> : null}
        <div className="table-wrap"><table className="data-table gl-table"><thead><tr><th>حساب</th><th>شرح</th><th className="num">بدهکار</th><th className="num">بستانکار</th></tr></thead><tbody>
          {v.lines.map((l) => <tr key={l.lineNo}><td className="gl-name"><span className="gl-code">{l.code}</span>{l.title}{l.tafsiliTitle ? ` — ${l.tafsiliTitle}` : ''}</td><td data-label="شرح">{l.description || '—'}</td>
            <td className="num" data-label="بدهکار">{l.debitRial ? rialToman(l.debitRial) : '—'}</td><td className="num" data-label="بستانکار">{l.creditRial ? rialToman(l.creditRial) : '—'}</td></tr>)}
        </tbody></table></div></div>)}
      {q.data.total > q.data.limit ? <Pagination total={q.data.total} offset={(page - 1) * q.data.limit} limit={q.data.limit} onChange={(o) => setPage(Math.floor(o / q.data!.limit) + 1)} testId="pagination-gl-journal" /> : null}
    </>}
  </div>;
}

function AccountLedger() {
  const acc = useQuery({ queryKey: ['gl', 'accounts'], queryFn: () => glApi.accounts(), ...Q });
  const [code, setCode] = useState('2201'); const [tf, setTf] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['gl', 'ledger', code, tf, g(from), g(to), page], queryFn: () => glApi.ledger({ code, tafsiliId: tf ? Number(tf) : null, from: g(from), to: g(to), page }), enabled: !!code, ...Q });
  const tafs = (acc.data?.tafsili ?? []).filter((t) => t.account === code);
  const dc = (v: number) => <>{rialToman(Math.abs(v))}<span className="gl-dc">{v > 0 ? 'بد' : v < 0 ? 'بس' : ''}</span></>;
  return <div className="panel" data-testid="gl-ledger">
    <div className="gl-toolbar">
      <div className="field"><label>حساب</label><select value={code} onChange={(e) => { setCode(e.target.value); setTf(''); setPage(1); }} data-testid="gl-ledger-account">
        {(acc.data?.accounts ?? []).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.title}</option>)}</select></div>
      {tafs.length ? <div className="field"><label>تفصیلی</label><select value={tf} onChange={(e) => { setTf(e.target.value); setPage(1); }} data-testid="gl-ledger-tafsili"><option value="">همه</option>{tafs.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.title}</option>)}</select></div> : null}
      <DateRange from={from} to={to} setFrom={(v) => { setFrom(v); setPage(1); }} setTo={(v) => { setTo(v); setPage(1); }} id="ledger" />
    </div>
    {acc.isError ? <Failed e={acc.error} retry={() => acc.refetch()} /> : q.isLoading ? <Loading /> : q.isError ? <Failed e={q.error} retry={() => q.refetch()} /> : !q.data ? null : <>
      <div className="gl-sum" data-testid="gl-ledger-sum"><span>ماندهٔ ابتدای بازه: <b>{dc(q.data.openingRial)}</b></span><span>گردش بدهکار: <b>{rialToman(q.data.debitRial)}</b></span><span>گردش بستانکار: <b>{rialToman(q.data.creditRial)}</b></span><span>ماندهٔ پایان: <b>{dc(q.data.closingRial)}</b></span></div>
      {!q.data.items.length ? <EmptyState title="گردشی در این بازه نیست" description="برای این حساب در بازهٔ انتخابی سند مهروموم‌شده‌ای نیست." /> :
        <div className="table-wrap"><table className="data-table gl-table"><thead><tr><th>تاریخ</th><th>سند</th><th>شرح</th><th className="num">بدهکار</th><th className="num">بستانکار</th><th className="num">مانده</th></tr></thead><tbody>
          {q.data.items.map((r, i) => <tr key={`${r.voucherId}-${i}`}><td className="gl-name">{faGDate(r.eventDate)}</td><td data-label="سند">موقت {r.tempNo.toLocaleString('fa-IR')}</td>
            <td data-label="شرح">{r.description || '—'}{r.tafsiliTitle ? ` · ${r.tafsiliTitle}` : ''}</td><td className="num" data-label="بدهکار">{r.debitRial ? rialToman(r.debitRial) : '—'}</td>
            <td className="num" data-label="بستانکار">{r.creditRial ? rialToman(r.creditRial) : '—'}</td><td className="num" data-label="مانده">{dc(r.runningRial)}</td></tr>)}
        </tbody></table></div>}
      {q.data.total > q.data.limit ? <Pagination total={q.data.total} offset={(page - 1) * q.data.limit} limit={q.data.limit} onChange={(o) => setPage(Math.floor(o / q.data!.limit) + 1)} testId="pagination-gl-ledger" /> : null}
    </>}
  </div>;
}

function QueueView() {
  const q = useQuery({ queryKey: ['gl', 'queue'], queryFn: () => glApi.queue(), ...Q });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Failed e={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return <div className="panel" data-testid="gl-queue">
    <div className="gl-sum"><span>در صف: <b>{d.counts.pending.toLocaleString('fa-IR')}</b></span><span>ناموفق: <b>{d.counts.failed.toLocaleString('fa-IR')}</b></span><span>ثبت‌شده: <b>{d.counts.posted.toLocaleString('fa-IR')}</b></span><span>کنار گذاشته: <b>{d.counts.skipped.toLocaleString('fa-IR')}</b></span></div>
    <p className="gl-note">این صفحه فقط نمایش است؛ تلاش دوباره فقط با مدیر و در مرحلهٔ بعد اضافه می‌شود.</p>
    {!d.items.length ? <EmptyState title="صف ثبت خالی است" description="هیچ رویداد معوق یا ناموفقی برای ثبت در دفتر کل نیست." /> :
      <div className="table-wrap"><table className="data-table gl-table"><thead><tr><th>رویداد</th><th>وضعیت</th><th className="num">تلاش</th><th>خطا</th><th>آخرین تغییر</th></tr></thead><tbody>
        {d.items.map((i) => <tr key={i.id}><td className="gl-name">{i.eventType} · {i.sourceType} #{i.sourceId.toLocaleString('fa-IR')}</td><td data-label="وضعیت"><span className={`gp-chip ${i.status === 'failed' ? 'red' : 'gold'}`}><i />{i.status === 'failed' ? 'ناموفق' : 'در صف'}</span></td>
          <td className="num" data-label="تلاش">{i.attempts.toLocaleString('fa-IR')}</td><td data-label="خطا">{i.lastError || '—'}</td><td data-label="آخرین تغییر">{formatDateTime(i.updatedAt)}</td></tr>)}
      </tbody></table></div>}
    {d.skipped.length || d.exceptions.length ? <div className="gl-status-grid" style={{ marginTop: 12 }}>
      {d.skipped.length ? <div><h3 className="panel-title">کنار گذاشته‌ها به تفکیک علت</h3><div className="gp-kv">{d.skipped.map((s) => <><span key={`s${s.code}`}>{s.code}</span><b key={`n${s.code}`}>{s.n.toLocaleString('fa-IR')}</b></>)}</div></div> : null}
      {d.exceptions.length ? <div><h3 className="panel-title">استثناها</h3><div className="gp-kv">{d.exceptions.map((s) => <><span key={`s${s.code}`}>{s.code}</span><b key={`n${s.code}`}>{s.n.toLocaleString('fa-IR')}</b></>)}</div></div> : null}
    </div> : null}
  </div>;
}

function Reconciliation({ onQueue }: { onQueue: () => void }) {
  const q = useQuery({ queryKey: ['gl', 'rec'], queryFn: () => glApi.reconciliation(), ...Q });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Failed e={q.error} retry={() => q.refetch()} />;
  const { live, lastRun, nightlyEnabled } = q.data;
  return <div data-testid="gl-rec">
    <div className="panel" style={{ marginBottom: 12 }}><div className="gl-rec-head">
      <div><b>مغایرت‌ها (دفتر کل در برابر سامانه)</b><p className="gl-note">{nightlyEnabled ? `کنترل شبانه روشن است · آخرین اجرا: ${lastRun ? `${faGDate(lastRun.runDate)}${lastRun.finishedAt ? ` (${formatDateTime(lastRun.finishedAt)})` : ''}` : 'هنوز اجرا نشده'}` : 'کنترل شبانه خاموش است؛ این نتیجه همین الان محاسبه شد.'}</p></div>
      <button type="button" className="btn btn-ghost" onClick={onQueue} data-testid="gl-rec-to-queue">رفتن به صف ثبت</button></div>
      <p className="gl-note">این گزارش فقط نمایش است؛ چیزی خودکار اصلاح نمی‌شود.</p></div>
    {live.state === 'not_started' ? <div className="panel"><EmptyState title="دفتر کل هنوز شروع نشده" description={glReason(live.reason)} /></div> : live.sections.map((s) => <div key={s.key} className="panel" style={{ marginBottom: 12 }} data-testid={`gl-rec-${s.key}`}>
      <div className="gl-rec-head"><div><b>{s.title}</b><p className="gl-note">{s.description}</p></div>
        <span className={`gp-chip ${s.status === 'ok' ? 'green' : s.status === 'mismatch' ? 'red' : 'muted'}`}><i />{s.status === 'ok' ? 'می‌خواند' : s.status === 'mismatch' ? `${s.mismatchCount.toLocaleString('fa-IR')} مغایرت` : 'بعداً'}</span></div>
      {s.status !== 'deferred' ? <div className="gl-sum"><span>دفتر کل: <b>{rialToman(s.glTotalRial)}</b></span><span>سامانه: <b>{rialToman(s.systemTotalRial)}</b></span><span>بررسی‌شده: <b>{s.checked.toLocaleString('fa-IR')}</b></span></div> : null}
      {s.rows.length ? <div className="table-wrap"><table className="data-table gl-table"><thead><tr><th>مورد</th><th className="num">دفتر کل</th><th className="num">سامانه</th><th className="num">اختلاف</th><th>علت محتمل</th></tr></thead><tbody>
        {s.rows.map((r) => <tr key={r.ref}><td className="gl-name">{r.label}</td><td className="num" data-label="دفتر کل">{rialToman(r.glRial)}</td><td className="num" data-label="سامانه">{rialToman(r.systemRial)}</td>
          <td className="num" data-label="اختلاف">{r.diffRial < 0 ? '−' : ''}{rialToman(Math.abs(r.diffRial))}</td><td data-label="علت محتمل">{live.queueOpen ? 'ردیف معوق در صف ثبت' : '—'}</td></tr>)}
      </tbody></table></div> : null}
      {s.notes.map((n) => <p key={n} className="gl-note">{n}</p>)}
    </div>)}
  </div>;
}

/** G6c: single-finance-user warning (Armita v1.3 acc_setup_solo). Counts only; trainees and hidden users are not counted. */
function FinanceRolesWarn({ r }: { r?: GlFinanceRoles }) {
  if (!r || !r.solo) return null;
  return <div className="gp-alert warn gl-wbx" data-testid="gl-solo-warn"><AlertTriangle size={15} /> <b>فقط یک نفر نقش مالی دارد.</b>{' '}
    سند افتتاحیه و هر سند دستی دو نفر لازم دارد: یکی ثبت می‌کند و دیگری تأیید. تا نفر دوم (حسابدار یا تأییدکننده‌ی سند دستی) از «کاربران» تعیین نشود، این سندها قفل می‌مانند.
    <span className="gl-dc">کارآموزها نقش مالی نمی‌گیرند و در این شمارش نیستند.</span></div>;
}

/** G6c / N2: each seller's commission total — read-only, name only, no per-case amounts and no action. */
function CommissionTotals() {
  const q = useQuery({ queryKey: ['gl', 'sp-totals'], queryFn: () => glApi.commissionTotals(), ...Q });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Failed e={q.error} retry={() => q.refetch()} />;
  const d = q.data; const t = d.totals;
  return <div className="panel" data-testid="gl-sp-totals">
    <div className="gl-kpis">
      <div className="gl-kpi"><span>پورسانت ثبت‌شده</span><b data-testid="gl-sp-registered">{rialToman(t.registeredRial)}</b><small>تومان</small></div>
      <div className="gl-kpi"><span>پرداخت‌شده</span><b data-testid="gl-sp-paid">—</b><small>هنوز در سامانه ثبت نمی‌شود</small></div>
      <div className="gl-kpi"><span>قابل پرداخت</span><b data-testid="gl-sp-payable">{rialToman(t.payableRial)}</b><small>تومان · کیف کارشناس</small></div>
    </div>
    <p className="gl-note">پورسانت با «پرداخت‌شده» شدن دستور پرداخت مشتری ثبت می‌شود؛ پیش از آن «در انتظار» است و در این جمع نیست. این صفحه فقط نمایش است.</p>
    {!d.rows.length ? <EmptyState title="پورسانتی ثبت نشده" description="هنوز برای هیچ کارشناسی پورسانت ثبت نشده است." /> :
      <div className="table-wrap"><table className="data-table gl-table"><thead><tr><th>کارشناس</th><th className="num">پرونده</th><th className="num">ثبت‌شده</th><th className="num">پرداخت‌شده</th><th className="num">قابل پرداخت</th><th className="num">دفتر کل (۲۱۰۲)</th></tr></thead><tbody>
        {d.rows.map((r) => <tr key={r.salespersonId} data-testid={`gl-sp-row-${r.salespersonId}`}><td className="gl-name">{r.name}</td>
          <td className="num" data-label="پرونده">{r.cases.toLocaleString('fa-IR')}</td><td className="num" data-label="ثبت‌شده">{rialToman(r.registeredRial)}</td>
          <td className="num" data-label="پرداخت‌شده">—</td><td className="num" data-label="قابل پرداخت">{rialToman(r.payableRial)}</td>
          <td className="num" data-label="دفتر کل (۲۱۰۲)">{rialToman(r.glPayableRial)}</td></tr>)}
        <tr className="gl-total"><td className="gl-name">جمع</td><td className="num" data-label="پرونده">{t.cases.toLocaleString('fa-IR')}</td><td className="num" data-label="ثبت‌شده">{rialToman(t.registeredRial)}</td>
          <td className="num" data-label="پرداخت‌شده">—</td><td className="num" data-label="قابل پرداخت">{rialToman(t.payableRial)}</td><td className="num" data-label="دفتر کل (۲۱۰۲)">{rialToman(t.glPayableRial)}</td></tr>
      </tbody></table></div>}
    <p className="gl-note">مبلغ هر پرونده این‌جا نشان داده نمی‌شود (فقط مدیر). ستون دفتر کل تا شروع دفتر کل صفر است.</p>
  </div>;
}
