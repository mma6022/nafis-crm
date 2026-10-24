/**
 * «وضعیت تراکنش‌ها» (replaces «فهرست تراکنش‌ها» in /wallet-management).
 * Design: nafis-design/screens/crm-transactions-status. Two segments: پورسانت‌ها (team-commission purchases) and
 * کیف پول مشتریان (customer wallet transactions). Reads only; admin actions reuse the existing endpoints
 * (unpay / retry posting / reverse case) that «دستورهای پرداخت» already uses.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronLeft, Clock, Coins, Filter, History, Lock, Receipt, RefreshCw, Scale, Search, ShoppingCart, Undo2, User, Wallet, X, type LucideIcon } from 'lucide-react';
import { errText, monthLabel, poStageLabel, useMe } from '@/lib/goods-api';
import { Stepper } from '@/components/wizard/Wizard';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { CustomerName, Dlg, Sheet, Toast } from '../staff-wallet/kit';
import { customerNameText } from '@/components/customer/CustomerName';
import { dayMonth, fa, fullDay, hm, sep } from '../staff-wallet/api';
import { RAW_STATUS, TX_KIND, WALLET_GROUPS, WALLET_TYPE, txActor, txApi, txSign, txWhy, walletGroupOf, type CommDetail, type CommGroup, type CommItem, type WalletTx } from './api';
import '../staff-wallet/nfk.css';
import './tx-status.css';

type Seg = 'comm' | 'wallet';
type WGroup = keyof typeof WALLET_GROUPS;
type Range = 'all' | 'today' | 'week' | 'month' | 'custom';
const CS: Record<CommGroup, [string, string, LucideIcon]> = {
  wait: ['s-wait', 'در انتظار پرداخت', Clock], paid: ['s-paid', 'پرداخت‌شده', CheckCircle2], back: ['s-back', 'برگشتی', Undo2], err: ['s-err', 'خطای ثبت', AlertTriangle],
};
const WS: Record<WGroup, [string, string, LucideIcon]> = {
  wait: ['s-wait', 'در انتظار', Clock], chk: ['s-chk', 'نیاز به بررسی', Scale], done: ['s-paid', 'انجام‌شده', CheckCircle2], fail: ['s-mute', 'ناموفق یا لغو', X],
};
/** PM decision 1: exact copy for the empty commission list. */
const COMM_EMPTY = 'هنوز پورسانتی با مدل جدید ثبت نشده. پورسانت بعد از «پرداخت‌شده» شدن دستور پرداخت اینجا میاد.';
const RANGES: [Range, string][] = [['all', 'همه'], ['today', 'امروز'], ['week', '۷ روز اخیر'], ['month', 'این ماه'], ['custom', 'از تا…']];
const STAGES: [string, string][] = [['', 'همه'], ['sales_approval', 'منتظر تأیید فروش'], ['admin_approval', 'منتظر تأیید مدیر'], ['awaiting_payment', 'در انتظار علامت پرداخت']];
const KINDS: [string, string][] = [['', 'همه'], ['payment', 'شارژ'], ['loan_credit', 'اعتبار تسهیلات'], ['goods_purchase', 'کسر خرید کالا'], ['filing_fee', 'کسر هزینه پرونده'], ['transfer', 'انتقال']];
const WTYPES: [string, string][] = [['', 'هر دو'], ['cash', 'نقدی'], ['credit', 'اعتباری']];
const PAGE = 25;

type Filters = { salespersonId: string; stage: string; kind: string; walletType: string; range: Range; fromDay: string; toDay: string };
const EMPTY: Filters = { salespersonId: '', stage: '', kind: '', walletType: '', range: 'all', fromDay: '', toDay: '' };

// ---- Tehran-calendar date ranges (Iran has no DST since 1401) ----
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
const tehranYmd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function rangeStart(r: Range): Date | null {
  if (r === 'all') return null;
  const now = new Date();
  const back = r === 'today' ? 0 : r === 'week' ? 6
    : Number(new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', day: 'numeric' }).format(now)) - 1;
  const [y, m, d] = tehranYmd(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - back) - TEHRAN_OFFSET_MS);
}
const commFrom = (r: Range) => rangeStart(r)?.toISOString() ?? null;
const walletFrom = (r: Range) => { const s = rangeStart(r); return s ? tehranYmd(new Date(s.getTime() + 60_000)) : null; };
/** «از تا…»: Shamsi days → Tehran-midnight instants (commissions) or Gregorian days (customer wallet). Either side may be empty. */
const tehranDayStart = (jalali: string, plusDays = 0) => {
  const g = jalali ? jalaliValueToGregorian(jalali) : null; if (!g) return null;
  const [y, m, d] = g.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + plusDays) - TEHRAN_OFFSET_MS);
};
const customBad = (f: Filters) => f.range === 'custom' && Boolean(f.fromDay && f.toDay && (jalaliValueToGregorian(f.fromDay) ?? '') > (jalaliValueToGregorian(f.toDay) ?? ''));
function commRange(f: Filters) {
  if (f.range !== 'custom') return { from: commFrom(f.range), to: null };
  const end = tehranDayStart(f.toDay, 1);
  return { from: tehranDayStart(f.fromDay)?.toISOString() ?? null, to: end ? new Date(end.getTime() - 1).toISOString() : null };
}
function walletRange(f: Filters) {
  if (f.range !== 'custom') return { from: walletFrom(f.range), to: null };
  return { from: (f.fromDay && jalaliValueToGregorian(f.fromDay)) || null, to: (f.toDay && jalaliValueToGregorian(f.toDay)) || null };
}
const customLabel = (f: Filters) => [f.fromDay ? `از ${fa(f.fromDay)}` : '', f.toDay ? `تا ${fa(f.toDay)}` : ''].filter(Boolean).join(' ');

function useDebounced<T>(v: T, ms = 350) {
  const [x, setX] = useState(v);
  useEffect(() => { const t = window.setTimeout(() => setX(v), ms); return () => window.clearTimeout(t); }, [v, ms]);
  return x;
}

const big = (v?: string | number | null) => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };
function Sg({ v, sign }: { v: bigint | string | number | null | undefined; sign?: number }) {
  const n = typeof v === 'bigint' ? v : big(v);
  const s = sign ?? (n < 0n ? -1 : 1);
  if (s === 0) return <span className="ltr" style={{ fontWeight: 800 }}>{sep(String(n))}</span>;
  return <span className={`ltr ${s < 0 ? 'neg' : 'pos'}`}>{s < 0 ? '−' : '+'}{sep(String(n))}</span>;
}
const Pill = ({ m, sub }: { m: [string, string, LucideIcon]; sub?: ReactNode }) => { const I = m[2]; return <><span className={`pill ${m[0]}`}><I className="i" />{m[1]}</span>{sub ? <div className="sub">{sub}</div> : null}</>; };
const when = (iso?: string | null) => (iso ? `${dayMonth(iso)} ${hm(iso)}` : '—');

// ---- commission rows ----
function commSub(r: CommItem, admin: boolean) {
  if (!admin && r.commissionState === 'manager') return 'پرداخت ثبت شد';
  if (r.group === 'paid') return `پورسانت ثبت شد، ${monthLabel(r.commissionMonth)}`;
  if (r.group === 'back') return `کسر در ${monthLabel(r.reversalMonth)}${admin && r.reversalReason ? `، ${r.reversalReason}` : ''}`;
  if (r.group === 'err') return 'پرداخت‌شده؛ پورسانت ثبت نشد';
  return r.paymentOrderId ? `دستور: ${poStageLabel(r.paymentOrderStage ?? undefined)}` : 'دستور پرداخت هنوز ساخته نشده';
}
const closerP1 = (r: CommItem) => big(r.closerCommissionToman) + big(r.p1ShareToman);
function CommAmt({ r, admin }: { r: CommItem; admin: boolean }) {
  if (!admin) return <span className="sub">{r.commissionState === 'posted' || r.commissionState === 'reversed' ? 'ثبت شد' : '—'}</span>;
  if (r.group === 'paid') return <Sg v={closerP1(r)} sign={1} />;
  if (r.group === 'back') return <Sg v={big(r.closerCommissionToman)} sign={-1} />;
  return <span className="sub">بعد از «پرداخت‌شده»</span>;
}
function CommLinks({ r, admin }: { r: CommItem; admin: boolean }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return <div className="lks">
    <Link className="lk" href={`/goods-purchases/${r.purchaseId}`} onClick={stop}><ShoppingCart className="i" />خرید #{fa(r.purchaseId)}</Link>
    {r.paymentOrderId ? <Link className="lk" href={`/payment-orders/${r.paymentOrderId}`} onClick={stop}><Receipt className="i" />دستور #{fa(r.paymentOrderId)}</Link> : null}
    {admin && (r.group === 'paid' || r.group === 'back') ? <Link className="lk" href={`/my-wallet?p=${r.salespersonId}`} onClick={stop}><History className="i" />دفتر</Link> : null}
  </div>;
}

// ---- wallet rows ----
const txKey = (t: WalletTx) => `${t.kind}-${t.recordId}`;
const txDesc = (t: WalletTx) => (t.kind === 'transfer' ? `انتقال به ${customerNameText(t.otherCustomerName ?? '—', t.otherCustomerId)}` : t.purchaseId ? `${TX_KIND[t.kind]}، خرید #${fa(t.purchaseId)}` : TX_KIND[t.kind] ?? t.kind);
const TxAmt = ({ t }: { t: WalletTx }) => <Sg v={String(t.amountToman)} sign={txSign(t.kind)} />;

export default function TransactionsStatus() {
  const { isAdmin: admin, user } = useMe();
  // Commission status is for admin and accounting only (HANDOFF §5); salespersons/registrars keep the customer-wallet list they had before.
  const canComm = admin || Boolean(user?.permissions?.includes('payment_orders.pay'));
  const qc = useQueryClient();
  const [segPick, setSeg] = useState<Seg>('comm');
  const seg: Seg = canComm ? segPick : 'wallet';
  const [group, setGroup] = useState<string>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [f, setF] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { setPage(1); }, [seg, group, q, f]);
  const switchSeg = (s: Seg) => { setSeg(s); setGroup('all'); setF(EMPTY); setSel(null); };

  const commParams = (ff: Filters, g: string, p: number, limit = PAGE) => ({ search: q, group: g === 'all' ? null : g, salespersonId: ff.salespersonId, stage: ff.stage, ...commRange(ff), page: p, limit });
  const walletParams = (ff: Filters, g: string, p: number, limit = PAGE) => ({ search: q, status: g === 'all' ? null : WALLET_GROUPS[g as WGroup]?.join(','), kind: ff.kind, walletType: ff.walletType, ...walletRange(ff), page: p, limit });
  const comm = useQuery({ queryKey: ['tx-comm', commParams(f, group, page)], queryFn: () => txApi.comm(commParams(f, group, page)), enabled: seg === 'comm', placeholderData: (p) => p });
  const wallet = useQuery({ queryKey: ['tx-wallet', walletParams(f, group, page)], queryFn: () => txApi.wallet(walletParams(f, group, page)), enabled: seg === 'wallet', placeholderData: (p) => p });
  const cur = seg === 'comm' ? comm : wallet;

  const counts = useMemo(() => {
    if (seg === 'comm') return comm.data?.counts ?? null;
    const sc = wallet.data?.statusCounts; if (!sc) return null;
    const c: Record<string, number> = { all: 0 };
    for (const g of Object.keys(WALLET_GROUPS) as WGroup[]) { c[g] = WALLET_GROUPS[g].reduce((s, k) => s + (sc[k] ?? 0), 0); c.all += c[g]; }
    return c;
  }, [seg, comm.data, wallet.data]);
  const M: Record<string, [string, string, LucideIcon]> = seg === 'comm' ? (admin ? CS : { wait: CS.wait, paid: CS.paid, back: CS.back }) : WS;

  const spName = (id: string) => comm.data?.salespersons.find((s) => String(s.id) === id)?.name ?? '';
  const active: { label: string; clear: Partial<Filters> }[] = [];
  if (seg === 'comm' && f.salespersonId) active.push({ label: `کارشناس: ${spName(f.salespersonId)}`, clear: { salespersonId: '' } });
  if (seg === 'comm' && f.stage) active.push({ label: STAGES.find((s) => s[0] === f.stage)![1], clear: { stage: '' } });
  if (seg === 'wallet' && f.kind) active.push({ label: KINDS.find((s) => s[0] === f.kind)![1], clear: { kind: '' } });
  if (seg === 'wallet' && f.walletType) active.push({ label: `کیف ${WALLET_TYPE[f.walletType]}`, clear: { walletType: '' } });
  if (f.range === 'custom') { if (f.fromDay || f.toDay) active.push({ label: customLabel(f), clear: { range: 'all', fromDay: '', toDay: '' } }); }
  else if (f.range !== 'all') active.push({ label: RANGES.find((r) => r[0] === f.range)![1], clear: { range: 'all' } });

  const refreshAll = useCallback(() => { void qc.invalidateQueries({ queryKey: ['tx-comm'] }); void qc.invalidateQueries({ queryKey: ['tx-comm-detail'] }); void qc.invalidateQueries({ queryKey: ['staff-wallet'] }); }, [qc]);

  const total = cur.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const commItems = comm.data?.items ?? [];
  const walletItems = wallet.data?.items ?? [];
  const selComm = seg === 'comm' && sel ? commItems.find((r) => String(r.purchaseId) === sel) ?? null : null;
  const selTx = seg === 'wallet' && sel ? walletItems.find((t) => txKey(t) === sel) ?? null : null;

  let body: ReactNode;
  if (cur.isError && !cur.data) {
    body = <div className="empty err"><span className="big"><AlertTriangle className="i" /></span><h2>فهرست باز نشد</h2><p>{errText(cur.error)} چیزی تغییر نکرده است.</p>
      <button type="button" className="nf-btn nf-btn-primary nf-btn-lg" onClick={() => cur.refetch()}><RefreshCw size={16} />دوباره امتحان کن</button></div>;
  } else if (!cur.data) {
    body = <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 80 }} />)}</div>;
  } else if (!(seg === 'comm' ? commItems.length : walletItems.length)) {
    const filtered = q || active.length || group !== 'all';
    if (seg === 'comm' && !filtered) body = <div className="empty" data-testid="comm-empty"><span className="big"><Coins className="i" /></span>
      <h2 style={{ maxWidth: 460, lineHeight: 1.9 }}>{COMM_EMPTY}</h2></div>;
    else body = <div className="empty"><span className="big"><Search className="i" /></span><h2>{filtered ? 'نتیجه‌ای پیدا نشد' : seg === 'comm' ? 'هنوز خریدی در مدل فروش تیمی نیست' : 'تراکنشی نیست'}</h2>
      <p>{filtered ? (q ? `برای «${q}» در این وضعیت تراکنشی نیست. وضعیت «همه» را ببین یا جست‌وجو را پاک کن.` : 'با این فیلترها تراکنشی نیست.') : seg === 'comm' ? 'وقتی خرید کالایی در مدل جدید ثبت شود، وضعیت پورسانتش این‌جا دیده می‌شود.' : ''}</p>
      {filtered ? <button type="button" className="ghost" onClick={() => { setSearch(''); setGroup('all'); setF(EMPTY); }}>پاک کردن جست‌وجو و فیلتر</button> : null}</div>;
  } else if (seg === 'comm') {
    body = <>
      <div className="txs-list">{commItems.map((r) => { const m = CS[r.group]; return (
        <div key={r.purchaseId} role="button" tabIndex={0} className={`txs-tc ${m[0]}`} onClick={() => setSel(String(r.purchaseId))} onKeyDown={(e) => { if (e.key === 'Enter') setSel(String(r.purchaseId)); }}>
          <span className="nm"><CustomerName name={r.customerName} id={r.customerId} /></span><span className="amt"><CommAmt r={r} admin={admin} /></span>
          <div className="r"><Pill m={m} /><span className="sub">{commSub(r, admin)}</span></div>
          <div className="r sub">{r.salespersonName ?? '—'}، {when(r.changedAt)}</div>
          {admin && r.group === 'err' && r.lastError ? <div className="why"><AlertTriangle className="i" />{r.lastError}</div> : null}
          <CommLinks r={r} admin={admin} />
        </div>); })}</div>
      <table className="txs-tt"><thead><tr><th>وضعیت</th><th>مشتری و کارشناس</th><th>آخرین تغییر</th><th>پورسانت</th><th>پیوندها</th></tr></thead>
        <tbody>{commItems.map((r) => { const m = CS[r.group]; return (
          <tr key={r.purchaseId} className={`${m[0]} ${sel === String(r.purchaseId) ? 'sel' : ''}`} onClick={() => setSel(String(r.purchaseId))} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setSel(String(r.purchaseId)); }}>
            <td><Pill m={m} sub={commSub(r, admin)} />{admin && r.group === 'err' && r.lastError ? <div className="sub" style={{ color: '#9A3412' }}>{r.lastError}</div> : null}</td>
            <td><div className="nm"><CustomerName name={r.customerName} id={r.customerId} /></div><div className="sub">{r.salespersonName ?? '—'}</div></td>
            <td className="sub">{when(r.changedAt)}</td>
            <td className="n"><CommAmt r={r} admin={admin} /></td>
            <td><CommLinks r={r} admin={admin} /></td>
          </tr>); })}</tbody></table>
    </>;
  } else {
    body = <>
      <div className="txs-list">{walletItems.map((t) => { const m = WS[walletGroupOf(t.status)]; const why = txWhy(t); return (
        <div key={txKey(t)} role="button" tabIndex={0} className={`txs-tc ${m[0]}`} onClick={() => setSel(txKey(t))} onKeyDown={(e) => { if (e.key === 'Enter') setSel(txKey(t)); }}>
          <span className="nm"><CustomerName name={t.customerName} id={t.customerId} /></span><span className="amt"><TxAmt t={t} /></span>
          <div className="r"><Pill m={m} /><span className="sub">{RAW_STATUS[t.status] ?? t.status}</span></div>
          <div className="r sub">{txDesc(t)}، کیف {WALLET_TYPE[t.walletType] ?? t.walletType}، {when(t.createdAt)}</div>
          {why ? <div className="why"><AlertTriangle className="i" />{why}</div> : null}
          {t.purchaseId || (t.status === 'requires_reconciliation' && admin) ? <div className="lks">
            {t.purchaseId ? <Link className="lk" href={`/goods-purchases/${t.purchaseId}`} onClick={(e) => e.stopPropagation()}><ShoppingCart className="i" />خرید #{fa(t.purchaseId)}</Link> : null}
            {t.status === 'requires_reconciliation' && admin ? <Link className="lk" style={{ color: '#6B21A8' }} href={`/customers/${t.customerId}#sec-wallet`} onClick={(e) => e.stopPropagation()}><Scale className="i" />تطبیق با درگاه</Link> : null}
          </div> : null}
        </div>); })}</div>
      <table className="txs-tt"><thead><tr><th>وضعیت</th><th>مشتری و عملیات</th><th>زمان</th><th>مبلغ (تومان)</th><th>پیوندها</th></tr></thead>
        <tbody>{walletItems.map((t) => { const m = WS[walletGroupOf(t.status)]; const why = txWhy(t); return (
          <tr key={txKey(t)} className={`${m[0]} ${sel === txKey(t) ? 'sel' : ''}`} onClick={() => setSel(txKey(t))} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setSel(txKey(t)); }}>
            <td><Pill m={m} sub={RAW_STATUS[t.status] ?? t.status} /></td>
            <td><div className="nm"><CustomerName name={t.customerName} id={t.customerId} /></div><div className="sub">{txDesc(t)}، کیف {WALLET_TYPE[t.walletType] ?? t.walletType}</div>{why ? <div className="sub" style={{ color: 'var(--c)' }}>{why}</div> : null}</td>
            <td className="sub">{when(t.createdAt)}</td>
            <td className="n"><TxAmt t={t} /></td>
            <td><div className="lks">
              {t.purchaseId ? <Link className="lk" href={`/goods-purchases/${t.purchaseId}`} onClick={(e) => e.stopPropagation()}><ShoppingCart className="i" />خرید #{fa(t.purchaseId)}</Link> : null}
              {t.status === 'requires_reconciliation' && admin ? <Link className="lk" style={{ color: '#6B21A8' }} href={`/customers/${t.customerId}#sec-wallet`} onClick={(e) => e.stopPropagation()}><Scale className="i" />تطبیق با درگاه</Link> : null}
            </div></td>
          </tr>); })}</tbody></table>
    </>;
  }

  return <div className="nfk txs">
    <div className="txs-intro">
      <div><h2>وضعیت تراکنش‌ها</h2><p>{seg === 'comm' ? 'هر خرید کالا: از «در انتظار پرداخت» تا ثبت پورسانت' : 'شارژ، اعتبار، کسر و انتقال در کیف پول مشتری‌ها'}</p></div>
      <div className="txs-tools">
        <label className="txs-search"><Search className="i" aria-hidden="true" />
          <input className="inp" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={seg === 'comm' ? 'نام یا شناسه مشتری، شماره خرید یا دستور' : 'نام، شناسه یا موبایل مشتری'} aria-label="جست‌وجو" />
          {search ? <button type="button" className="clr-x" onClick={() => setSearch('')} aria-label="پاک کردن جست‌وجو"><X size={18} /></button> : null}
        </label>
        <button type="button" className="txs-fbtn" onClick={() => setFilterOpen(true)} aria-label="فیلتر"><Filter size={18} /><span className="d-only">فیلتر</span>{active.length ? <span className="n">{fa(active.length)}</span> : null}</button>
      </div>
    </div>
    {canComm ? <div className="txs-seg" role="group" aria-label="نوع تراکنش">
      <button type="button" aria-pressed={seg === 'comm'} onClick={() => switchSeg('comm')}><Coins size={18} />پورسانت‌ها</button>
      <button type="button" aria-pressed={seg === 'wallet'} onClick={() => switchSeg('wallet')}><Wallet size={18} />کیف پول مشتریان</button>
    </div> : null}
    <div className="txs-stc" role="group" aria-label="وضعیت">
      <button type="button" aria-pressed={group === 'all'} onClick={() => setGroup('all')}><b>{counts ? fa(counts.all ?? 0) : '…'}</b><span>همه</span></button>
      {Object.entries(M).map(([k, v]) => <button key={k} type="button" className={v[0]} aria-pressed={group === k} onClick={() => setGroup(k)}><b>{counts ? fa(counts[k] ?? 0) : '…'}</b><span>{v[1]}</span></button>)}
    </div>
    {active.length ? <div className="txs-af">{active.map((a) => <button key={a.label} type="button" className="chip rm" onClick={() => setF((p) => ({ ...p, ...a.clear }))} aria-label={`حذف فیلتر ${a.label}`}>{a.label}<X size={16} /></button>)}
      <button type="button" className="clr" onClick={() => setF(EMPTY)}>پاک کردن همه</button></div> : null}
    {seg === 'comm' && !admin ? <p className="lockline"><Lock className="i" />شما وضعیت را می‌بینید؛ مبلغ پورسانت هر کارشناس را فقط خود او و مدیر می‌بینند.</p> : null}
    {cur.isError && cur.data ? <p className="note" role="alert"><AlertTriangle className="i" />به‌روزرسانی فهرست ناموفق بود؛ آخرین داده‌ی گرفته‌شده را می‌بینی.</p> : null}
    {body}
    {cur.data && total > PAGE ? <div className="txs-pager">
      <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ArrowRight size={16} />قبلی</button>
      <span>صفحه {fa(page)} از {fa(pages)}، {fa(total)} مورد</span>
      <button type="button" className="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>بعدی<ChevronLeft size={16} /></button>
    </div> : null}

    {filterOpen ? <FilterSheet seg={seg} value={f} salespersons={comm.data?.salespersons ?? []} onClose={() => setFilterOpen(false)} onApply={(v) => { setF(v); setFilterOpen(false); }}
      countFor={(v) => (seg === 'comm' ? txApi.comm(commParams(v, group, 1, 1)) : txApi.wallet(walletParams(v, group, 1, 1))).then((d) => d.total)} /> : null}
    {seg === 'comm' && sel ? <CommSheet purchaseId={Number(sel)} fallback={selComm} admin={admin} onClose={() => setSel(null)} onDone={(t) => { setToast(t); refreshAll(); }} /> : null}
    {seg === 'wallet' && selTx ? <WalletSheet t={selTx} admin={admin} onClose={() => setSel(null)} /> : null}
    {toast ? <Toast text={toast} onDone={() => setToast('')} /> : null}
  </div>;
}

// ---------------------------------------------------------------- filter sheet
function FilterSheet({ seg, value, salespersons, onClose, onApply, countFor }: { seg: Seg; value: Filters; salespersons: { id: number; name: string }[]; onClose: () => void; onApply: (v: Filters) => void; countFor: (v: Filters) => Promise<number> }) {
  const [d, setD] = useState<Filters>(value);
  const bad = customBad(d);
  const n = useQuery({ queryKey: ['tx-filter-count', seg, d], queryFn: () => countFor(d), staleTime: 10_000, enabled: !bad });
  const Ch = ({ k, opts }: { k: keyof Filters; opts: [string, string][] }) => <div className="chips">{opts.map(([v, l]) =>
    <button key={v || 'all'} type="button" className="chip" aria-pressed={d[k] === v} onClick={() => setD((p) => ({ ...p, [k]: v }))}>{l}</button>)}</div>;
  return <Sheet title="فیلتر" labelId="txs-filter-t" onClose={onClose} className="txs-sheet">
    {seg === 'comm' ? <>
      <div className="fgrp"><span className="lbl">کارشناس</span><Ch k="salespersonId" opts={[['', 'همه'], ...salespersons.map((s): [string, string] => [String(s.id), s.name])]} /></div>
      <div className="fgrp"><span className="lbl">مرحله‌ی دستور پرداخت</span><Ch k="stage" opts={STAGES} /></div>
    </> : <>
      <div className="fgrp"><span className="lbl">نوع عملیات</span><Ch k="kind" opts={KINDS} /></div>
      <div className="fgrp"><span className="lbl">کیف پول</span><Ch k="walletType" opts={WTYPES} /></div>
    </>}
    <div className="fgrp"><span className="lbl">زمان</span><Ch k="range" opts={RANGES} />
      {d.range === 'custom' ? <div className="txs-range">
        <label><span>از</span><PersianDatePicker value={d.fromDay} onChange={(v) => setD((p) => ({ ...p, fromDay: v }))} noFuture placeholder="روز شروع" testId="txs-from" popoverClassName="txs-date-pop" /></label>
        <label><span>تا</span><PersianDatePicker value={d.toDay} onChange={(v) => setD((p) => ({ ...p, toDay: v }))} noFuture minValue={d.fromDay || undefined} placeholder="روز پایان" testId="txs-to" popoverClassName="txs-date-pop" /></label>
      </div> : null}
      {bad ? <span className="ferr" role="alert">«از» نباید بعد از «تا» باشد.</span> : <span className="help">«این ماه» یعنی ماه شمسی جاری. در «از تا…» هر دو روز هم حساب می‌شوند.</span>}</div>
    <div className="foot2"><button type="button" className="ghost" onClick={() => setD(EMPTY)}>پاک کردن</button>
      <button type="button" className="nf-btn nf-btn-primary nf-btn-lg" disabled={bad} onClick={() => onApply(d.range === 'custom' && !d.fromDay && !d.toDay ? { ...d, range: 'all' } : d)}>{bad ? 'بازه را درست کنید' : n.data === undefined ? 'نمایش نتیجه‌ها' : n.data === 0 ? 'نتیجه‌ای نیست' : `نمایش ${fa(n.data)} نتیجه`}</button></div>
  </Sheet>;
}

// ---------------------------------------------------------------- wallet detail
function WalletSheet({ t, admin, onClose }: { t: WalletTx; admin: boolean; onClose: () => void }) {
  const g = walletGroupOf(t.status); const m = WS[g]; const I = m[2]; const why = txWhy(t); const s = txSign(t.kind);
  return <Sheet title={`تراکنش #${fa(t.recordId)}`} labelId="txs-w-t" onClose={onClose} className="txs-sheet">
    <div className={`stbig ${m[0]}`}><I className="i" /><div><b>{m[1]}</b><span>{RAW_STATUS[t.status] ?? t.status}</span></div></div>
    <div className="sum">
      <div className="r"><span>مشتری</span><b><CustomerName name={t.customerName} id={t.customerId} /></b></div>
      <div className="r"><span>نوع</span><b>{TX_KIND[t.kind] ?? t.kind}{t.kind === 'transfer' && (t.otherCustomerName || t.otherCustomerId) ? <> به <CustomerName name={t.otherCustomerName} id={t.otherCustomerId} /></> : null}</b></div>
      <div className="r"><span>کیف پول</span><b>{WALLET_TYPE[t.walletType] ?? t.walletType}</b></div>
      <div className="r"><span>انجام‌دهنده</span><b>{txActor(t)}</b></div>
      <div className="r"><span>زمان</span><b>{fullDay(t.createdAt)}، {hm(t.createdAt)}</b></div>
      {t.kind === 'transfer' && t.reason ? <div className="r"><span>دلیل</span><b>{t.reason}</b></div> : null}
      <div className="r big"><span>مبلغ</span><b>{s === 0 ? `${sep(String(t.amountToman))} تومان` : <><Sg v={String(t.amountToman)} sign={s} /> تومان</>}</b></div>
    </div>
    {why ? <div className={`cnote ${g === 'chk' ? '' : 'warn'}`}><AlertTriangle className="i" /><span>{why}</span></div> : null}
    <div className="lkgrid">
      <Link className="ghost" href={`/customers/${t.customerId}`}><User className="i" size={18} />پرونده‌ی مشتری</Link>
      {t.purchaseId ? <Link className="ghost" href={`/goods-purchases/${t.purchaseId}`}><ShoppingCart className="i" size={18} />خرید<small>#{fa(t.purchaseId)}</small></Link> : null}
      <Link className="ghost" href={`/customers/${t.customerId}#sec-wallet`}><Wallet className="i" size={18} />کیف پول مشتری</Link>
    </div>
    {g === 'chk' ? (admin ? <><div className="acts2"><Link className="nf-btn nf-btn-primary nf-btn-lg" href={`/customers/${t.customerId}#sec-wallet`}><Scale size={18} />تطبیق با درگاه در پرونده‌ی مشتری</Link></div>
      <p className="hint">وضعیت را از درگاه دوباره می‌پرسد. اگر پول رسیده باشد، کیف پول شارژ می‌شود.</p></>
      : <p className="lockline"><Lock className="i" />تطبیق با درگاه فقط با مدیر است.</p>) : null}
  </Sheet>;
}

// ---------------------------------------------------------------- commission detail + admin actions
type Act = null | 'rev' | 'unpay' | 'retry';
function CommSheet({ purchaseId, fallback, admin, onClose, onDone }: { purchaseId: number; fallback: CommItem | null; admin: boolean; onClose: () => void; onDone: (toast: string) => void }) {
  const dq = useQuery({ queryKey: ['tx-comm-detail', purchaseId], queryFn: () => txApi.commDetail(purchaseId) });
  const [act, setAct] = useState<Act>(null);
  const r = dq.data;
  const title = `خرید #${fa(purchaseId)}${(r ?? fallback)?.paymentOrderId ? `، دستور #${fa((r ?? fallback)!.paymentOrderId!)}` : ''}`;
  if (act === 'rev' && r) return <ReverseWizard r={r} onBack={() => setAct(null)} onClose={onClose} onDone={(t) => { setAct(null); onDone(t); }} />;
  return <>
    <Sheet title={title} labelId="txs-c-t" onClose={act ? () => undefined : onClose} className="txs-sheet">
      {dq.isError ? <div className="empty err"><span className="big"><AlertTriangle className="i" /></span><h2>جزئیات باز نشد</h2><p>{errText(dq.error)}</p><button type="button" className="ghost" onClick={() => dq.refetch()}><RefreshCw size={16} />دوباره</button></div>
        : !r ? <><div className="sk" style={{ height: 70 }} /><div className="sk" style={{ height: 140 }} /><div className="sk" style={{ height: 160 }} /></>
          : <CommDetailBody r={r} admin={admin} onAct={setAct} />}
    </Sheet>
    {act === 'unpay' && r ? <UnpayDlg r={r} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone('«پرداخت‌شده» برگشت؛ دستور دوباره در انتظار علامت پرداخت است.'); }} /> : null}
    {act === 'retry' && r ? <RetryDlg r={r} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone('ثبت دوباره‌ی پورسانت انجام شد.'); }} /> : null}
  </>;
}

const TL_LABEL: Record<string, string> = {
  order_created: 'دستور پرداخت ساخته شد', order_sales_approved: 'فروش تأیید کرد', order_admin_approved: 'مدیر تأیید کرد',
  order_payment_recorded: '«پرداخت‌شده» شد', order_payment_reverted: '«پرداخت‌شده» برگشت (ثبت اشتباه)',
  team_commission_posted: 'پورسانت در کیف پول ثبت شد', team_commission_unposted: 'برای پورسانت ثبت‌شده ردیف برگشتی همان ماه ثبت شد', team_commission_reversed: 'برگشت پرونده',
};
function CommDetailBody({ r, admin, onAct }: { r: CommDetail; admin: boolean; onAct: (a: Act) => void }) {
  const m = CS[r.group]; const I = m[2];
  const rows: ReactNode[] = [<div className="r" key="c"><span>مشتری</span><b><CustomerName name={r.customerName} id={r.customerId} /></b></div>, <div className="r" key="s"><span>کارشناس فروش</span><b>{r.salespersonName ?? '—'}</b></div>];
  if (admin && (r.group === 'paid' || r.group === 'back')) {
    rows.push(<div className="r" key="b"><span>مبنای پورسانت</span><b>{r.basisAmountToman ? `${sep(r.basisAmountToman)} تومان واریزی` : '—'}</b></div>);
    rows.push(<div className="r" key="cl"><span>پورسانت فروش، {r.salespersonName ?? '—'}</span><b><Sg v={r.closerCommissionToman} sign={r.group === 'back' ? -1 : 1} /></b></div>);
    rows.push(big(r.p1ShareToman) > 0n ? <div className="r" key="p1"><span>سهم معرفی <bdi>P1</bdi>، {r.qualifierName ?? '—'}</span><b><Sg v={r.p1ShareToman} sign={r.group === 'back' ? -1 : 1} /></b></div>
      : <div className="r" key="p1"><span>سهم معرفی <bdi>P1</bdi></span><b className="muted">ندارد</b></div>);
  }
  if (!admin && (r.group === 'paid' || r.group === 'back')) rows.push(<div className="r" key="a"><span>پورسانت</span><b>{r.commissionState === 'manager' ? 'در دست مدیر' : r.group === 'paid' ? 'ثبت شد' : 'کسر شد'}</b></div>);
  if (r.group === 'wait' || r.group === 'err') rows.push(<div className="r" key="w"><span>مبلغ پورسانت</span><b className="muted">بعد از «پرداخت‌شده» حساب می‌شود</b></div>);

  type T = { ic: LucideIcon; c: string; who?: string; t: string; tx?: string; todo?: boolean };
  const tl: T[] = [];
  for (const e of r.timeline) {
    const who = `${e.actorName ?? 'سیستم'}، ${when(e.at)}`;
    const d = e.detail ?? {};
    if (e.action === 'entered') tl.push({ ic: ShoppingCart, c: 'ok', who: `سیستم، ${when(e.at)}`, t: `خرید #${fa(r.purchaseId)} تکمیل شد`, tx: 'پورسانت در انتظار پرداخت' });
    else if (e.action === 'order_payment_recorded') tl.push({ ic: Receipt, c: 'ok', who, t: `دستور #${fa(r.paymentOrderId ?? 0)} ${TL_LABEL[e.action]}`, tx: d.paidAt ? `تاریخ واقعی واریز: ${fullDay(String(d.paidAt))} (حسابداری وارد کرد)` : undefined });
    else if (e.action === 'order_payment_reverted') tl.push({ ic: Undo2, c: 'bad', who, t: TL_LABEL[e.action], tx: d.reason ? `دلیل: ${String(d.reason)}` : undefined });
    else if (e.action === 'team_commission_posted') tl.push({ ic: Wallet, c: 'ok', who: admin ? who : `سیستم، ${when(e.at)}`, t: TL_LABEL[e.action], tx: d.month ? `ماه ${monthLabel(String(d.month))}` : undefined });
    else if (e.action === 'team_commission_unposted') tl.push({ ic: Undo2, c: 'bad', who: admin ? who : when(e.at), t: TL_LABEL[e.action] });
    else if (e.action === 'team_commission_reversed') tl.push({ ic: Undo2, c: 'bad', who: admin ? who : when(e.at), t: TL_LABEL[e.action], tx: [d.reason ? `دلیل: ${String(d.reason)}` : '', d.month ? `کسر در ${monthLabel(String(d.month))}` : ''].filter(Boolean).join('، ') || undefined });
    else if (TL_LABEL[e.action]) tl.push({ ic: Receipt, c: 'ok', who, t: e.action === 'order_created' ? `دستور پرداخت #${fa(r.paymentOrderId ?? 0)} ساخته شد` : TL_LABEL[e.action] });
  }
  if (r.group === 'wait') {
    tl.push({ ic: Receipt, c: 'g', who: 'منتظر', t: r.paymentOrderId ? `دستور #${fa(r.paymentOrderId)}: ${poStageLabel(r.paymentOrderStage ?? undefined)}` : 'دستور پرداخت هنوز ساخته نشده', todo: true });
    tl.push({ ic: Wallet, c: '', t: 'ثبت پورسانت در کیف پول', todo: true });
  } else if (r.group === 'err' && admin) tl.push({ ic: AlertTriangle, c: 'bad', t: 'ثبت پورسانت خطا داد', tx: r.lastError ?? undefined });
  else if (!admin && r.commissionState === 'manager') tl.push({ ic: Wallet, c: '', t: 'ثبت پورسانت', tx: 'در دست مدیر', todo: true });
  if (admin && r.group === 'paid' && r.ledger.length) {
    const live = r.ledger.filter((x) => !x.neutralized);
    const last = tl.slice().reverse().find((x) => x.t === TL_LABEL.team_commission_posted);
    if (last && live.length) last.tx = `${last.tx ? `${last.tx}، ` : ''}ردیف‌های دفتر ${live.map((x) => `#${fa(x.id)}`).join(' و ')}`;
  }

  const acts: ReactNode[] = [];
  if (r.canOpenOrder && r.paymentOrderId) acts.push(<Link key="o" className="nf-btn nf-btn-primary nf-btn-lg" href={`/payment-orders/${r.paymentOrderId}`}><Receipt size={18} />باز کردن دستور #{fa(r.paymentOrderId)} برای علامت پرداخت</Link>);
  if (admin && r.canRetry) acts.push(<button key="rt" type="button" className="nf-btn nf-btn-primary nf-btn-lg" onClick={() => onAct('retry')}><RefreshCw size={18} />ثبت دوباره‌ی پورسانت</button>);
  if (admin && r.canReverse) acts.push(<button key="rv" type="button" className="ghost danger" onClick={() => onAct('rev')}><Undo2 size={18} />ثبت برگشت پرونده</button>);
  if (admin && r.canUnpay) acts.push(<button key="up" type="button" className="ghost danger" onClick={() => onAct('unpay')}><Undo2 size={18} />برگرداندن «پرداخت‌شده» (ثبت اشتباه)</button>);
  if (!admin && r.group === 'paid') acts.push(<p key="l" className="lockline"><Lock className="i" />برگشت، برگرداندن «پرداخت‌شده» و ثبت دوباره فقط با مدیر است.</p>);

  return <>
    <div className={`stbig ${m[0]}`}><I className="i" /><div><b>{m[1]}</b><span>{commSub(r, admin)}</span></div></div>
    <div className="sum">{rows}</div>
    {!admin ? <p className="lockline"><Lock className="i" />مبلغ پورسانت هر کارشناس را فقط خود او و مدیر می‌بینند.</p> : null}
    <ol className="tl">{tl.map((x, i) => { const Ic = x.ic; return <li key={i} className={x.todo ? 'todo' : ''}><span className={`ic ${x.c}`}><Ic className="i" /></span><div>{x.who ? <div className="who">{x.who}</div> : null}<p className="tx"><b>{x.t}</b></p>{x.tx ? <p className="tx muted">{x.tx}</p> : null}</div></li>; })}</ol>
    <div className="lkgrid">
      <Link className="ghost" href={`/customers/${r.customerId}`}><User className="i" size={18} />پرونده‌ی مشتری</Link>
      <Link className="ghost" href={`/goods-purchases/${r.purchaseId}`}><ShoppingCart className="i" size={18} />خرید<small>#{fa(r.purchaseId)}</small></Link>
      {r.paymentOrderId ? <Link className="ghost" href={`/payment-orders/${r.paymentOrderId}`}><Receipt className="i" size={18} />دستور پرداخت<small>#{fa(r.paymentOrderId)}</small></Link> : null}
      {admin && (r.group === 'paid' || r.group === 'back') ? <Link className="ghost" href={`/my-wallet?p=${r.salespersonId}`}><History className="i" size={18} />ردیف دفتر{r.ledgerId ? <small>#{fa(r.ledgerId)}</small> : null}</Link> : null}
    </div>
    {acts.length ? <div className="acts2">{acts}</div> : null}
  </>;
}

function ReverseWizard({ r, onBack, onClose, onDone }: { r: CommDetail; onBack: () => void; onClose: () => void; onDone: (t: string) => void }) {
  const steps = [{ key: 'why', title: 'دلیل برگشت' }, { key: 'review', title: 'بازبینی و ثبت' }] as const;
  const [step, setStep] = useState<'why' | 'review'>('why');
  const [preset, setPreset] = useState<string>('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const m = useMutation({ mutationFn: () => txApi.reverse(r.purchaseId, reason.trim()), onSuccess: () => onDone('برگشت پرونده ثبت شد.') });
  const bad = reason.trim().length < 5;
  const PRESETS = ['مرجوعی کالا', 'لغو خرید', 'دلیل دیگر'];
  return <Sheet title="ثبت برگشت پرونده" labelId="txs-rev-t" onClose={m.isPending ? () => undefined : onClose} className="txs-sheet">
    <Stepper steps={steps} current={step} onGo={(k) => setStep(k)} />
    {step === 'why' ? <>
      <p className="hint" style={{ margin: 0 }}>برای وقتی است که خرید بعد از واریز لغو یا مرجوع شده.</p>
      <div className="fld"><span className="lbl" id="rv-l">دلیل <span style={{ color: 'var(--nf-danger)' }}>*</span></span>
        <div className="chips" role="group" aria-labelledby="rv-l">{PRESETS.map((p) => <button key={p} type="button" className="chip" aria-pressed={preset === p}
          onClick={() => { setPreset(p); setReason(p === 'دلیل دیگر' ? '' : `${p} بعد از واریز`); }}>{p}</button>)}</div>
        <textarea className="inp" aria-label="توضیح دلیل" value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && bad} maxLength={500} />
        {touched && bad ? <p className="ferr" role="alert"><AlertTriangle className="i" />دلیل حداقل ۵ حرف باشد.</p> : <span className="help">در تاریخچه و ردیف دفتر نوشته می‌شود.</span>}
      </div>
      <div className="foot2"><button type="button" className="ghost" onClick={onBack}>انصراف</button>
        <button type="button" className="nf-btn nf-btn-primary nf-btn-lg" onClick={() => { setTouched(true); if (!bad) setStep('review'); }}>بعدی<ChevronLeft size={18} /></button></div>
    </> : <>
      <div className="sum">
        <div className="r"><span>پرونده</span><b><CustomerName name={r.customerName} id={r.customerId} />، خرید #{fa(r.purchaseId)}</b></div>
        <div className="r"><span>دلیل</span><b>{reason.trim()}</b></div>
        <div className="r"><span>ماه کسر</span><b>{monthLabel(r.reverseMonth)} (ماه بعد)</b></div>
        <div className="r big"><span>{r.salespersonName ?? '—'}، پورسانت فروش</span><b><Sg v={r.closerCommissionToman} sign={-1} /></b></div>
        {big(r.p1ShareToman) > 0n ? <div className="r"><span>{r.qualifierName ?? '—'}، سهم معرفی <bdi>P1</bdi></span><b><Sg v={r.p1ShareToman} sign={-1} /></b></div> : null}
        <div className="r"><span>پاداش درستی داده</span><b className="muted">کم نمی‌شود</b></div>
      </div>
      <div className="cnote warn"><AlertTriangle className="i" /><span>این کار برنمی‌گردد. ردیف «کسر بابت پرونده‌ی برگشتی» در دفتر کارشناس‌ها ثبت می‌شود.</span></div>
      {m.isError ? <p className="ferr" role="alert"><AlertTriangle className="i" />{errText(m.error)}</p> : null}
      <div className="foot2"><button type="button" className="ghost" disabled={m.isPending} onClick={() => setStep('why')}><ArrowRight size={18} />قبلی</button>
        <button type="button" className="btn-red" disabled={m.isPending} onClick={() => m.mutate()}><Undo2 size={18} />{m.isPending ? 'در حال ثبت…' : 'ثبت برگشت'}</button></div>
    </>}
  </Sheet>;
}

function UnpayDlg({ r, onClose, onDone }: { r: CommDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(''); const [touched, setTouched] = useState(false);
  const m = useMutation({ mutationFn: () => txApi.unpay(r.paymentOrderId!, reason.trim()), onSuccess: onDone });
  const bad = reason.trim().length < 5;
  const posted = r.group === 'paid';
  return <Dlg onClose={onClose} labelId="txs-up" busy={m.isPending}>
    <h2 id="txs-up">«پرداخت‌شده» برگردد؟</h2>
    <p>فقط وقتی که علامت اشتباهی خورده و پولی واریز نشده. دستور #{fa(r.paymentOrderId ?? 0)} به «در انتظار علامت پرداخت» برمی‌گردد{posted ? <> و برای پورسانت ثبت‌شده <b>یک ردیف برگشتی در همان ماه</b> در دفتر ثبت می‌شود</> : null}. چیزی پاک نمی‌شود.</p>
    {posted ? <div className="sum">
      <div className="r"><span>{r.salespersonName ?? '—'}، پورسانت فروش</span><b><Sg v={r.closerCommissionToman} sign={-1} /></b></div>
      {big(r.p1ShareToman) > 0n ? <div className="r"><span>{r.qualifierName ?? '—'}، سهم معرفی <bdi>P1</bdi></span><b><Sg v={r.p1ShareToman} sign={-1} /></b></div> : null}
    </div> : null}
    <div className="fld"><label className="lbl" htmlFor="txs-ur">دلیل <span style={{ color: 'var(--nf-danger)' }}>*</span></label>
      <textarea className="inp" id="txs-ur" value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && bad} aria-describedby={touched && bad ? 'txs-ure' : undefined} maxLength={500} />
      {touched && bad ? <p className="ferr" id="txs-ure" role="alert"><AlertTriangle className="i" />دلیل لازم است (حداقل ۵ حرف).</p> : null}</div>
    {m.isError ? <p className="ferr" role="alert"><AlertTriangle className="i" />{errText(m.error)}</p> : null}
    <div className="acts2"><button type="button" className="btn-red" disabled={m.isPending} onClick={() => { setTouched(true); if (!bad) m.mutate(); }}><Undo2 size={18} />{m.isPending ? 'در حال ثبت…' : 'برگرداندن و ثبت ردیف برگشتی'}</button>
      <button type="button" className="ghost" disabled={m.isPending} onClick={onClose}>انصراف</button></div>
  </Dlg>;
}

function RetryDlg({ r, onClose, onDone }: { r: CommDetail; onClose: () => void; onDone: () => void }) {
  const m = useMutation({ mutationFn: () => txApi.retry(r.purchaseId), onSuccess: onDone });
  return <Dlg onClose={onClose} labelId="txs-rt" busy={m.isPending}>
    <h2 id="txs-rt">پورسانت خرید #{fa(r.purchaseId)} دوباره ثبت شود؟</h2>
    <p>پرداخت درست ثبت شده.{r.lastError ? <> خطای قبلی: «{r.lastError}»</> : null} اگر خطا از تنظیمات پله‌ی {r.salespersonName ?? 'کارشناس'} است، اول آن را در «پورسانت فروش» درست کن، بعد دوباره ثبت کن.</p>
    {m.isError ? <p className="ferr" role="alert"><AlertTriangle className="i" />{errText(m.error)}</p> : null}
    <div className="acts2"><button type="button" className="nf-btn nf-btn-primary nf-btn-lg" disabled={m.isPending} onClick={() => m.mutate()}><RefreshCw size={18} />{m.isPending ? 'در حال ثبت…' : 'ثبت دوباره'}</button>
      <Link className="ghost" href="/sales-commissions"><Coins size={18} />رفتن به پله‌های کارشناس</Link>
      <button type="button" className="ghost" disabled={m.isPending} onClick={onClose}>انصراف</button></div>
  </Dlg>;
}
