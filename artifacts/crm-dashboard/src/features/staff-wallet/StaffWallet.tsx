/** «کیف پول من» (salesperson) / «کیف پول کارشناس‌ها» (admin). Read-only: balance = posted commissions only. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Coins, FileText, History, Info, Layers, Lock, ShoppingCart, Star, User, Wallet,
  type LucideIcon, BadgeCheck, MinusCircle, Users, Undo2,
} from 'lucide-react';
import { monthLabel, poStageLabel } from '@/lib/goods-api';
import {
  staffWalletApi, type StaffWalletPayload, type WalletLedgerRow, type WalletPending,
  fa, sep, isNeg, isZero, pct, pctShort, shortMoney, shortMoneyM, dayMonth, hm, since, kindLabel, kindChip, kindClass,
} from './api';
import { CustomerName, Sheet } from './kit';
import './nfk.css';
import './staff-wallet.css';

const PERSIAN_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const monthName = (m: string) => PERSIAN_MONTHS[Number(m.slice(5, 7)) - 1] ?? '';
export function shiftMonth(m: string, by: number) {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1 + by;
  const ny = y + Math.floor(mo / 12), nm = ((mo % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Signed amount: «+۲٬۳۴۰٬۰۰۰» green, «−۱٬۱۲۵٬۰۰۰» red. */
export function Signed({ v }: { v?: string | null }) {
  const n = isNeg(v);
  return <span className={`ltr ${n ? 'neg' : 'pos'}`}>{n ? '−' : '+'}{sep(v)}</span>;
}

const MONTH_ROWS: { kind: string; icon: LucideIcon; cls: string }[] = [
  { kind: 'salesperson_commission', icon: Coins, cls: '' },
  { kind: 'p1_referral_share', icon: Star, cls: 'p1' },
  { kind: 'data_accuracy_bonus', icon: BadgeCheck, cls: 'acc' },
  { kind: 'returned_case_deduction', icon: MinusCircle, cls: 'neg' },
  { kind: 'team_bonus', icon: Users, cls: 'team' },
];

function pendingState(p: WalletPending): [string, string] {
  if (p.state === 'manager') return ['bad', 'در دست مدیر'];
  if (p.state === 'no_order') return ['mute', 'دستور پرداخت ساخته نشده'];
  if (p.state === 'awaiting_payment') return ['wait', 'در انتظار علامت پرداخت'];
  return ['info', poStageLabel(p.state)];
}

export function rowDescription(r: WalletLedgerRow) {
  const m = r.meta;
  const basis = m?.basisAmountToman ? `${sep(m.basisAmountToman)} تومان واریزی` : '';
  let s: string;
  switch (r.kind) {
    case 'salesperson_commission':
      s = m && m.rateBps != null ? `پله ${fa(m.tier ?? 0)}، ${pct(m.rateBps)}${basis ? `ِ ${basis}` : ''}` : 'پورسانت فروش (مدل قبلی)';
      break;
    case 'p1_referral_share':
      s = `${m?.p1Kind === 'upgrade' ? 'ارتقا' : 'تماس اول'}${m?.rateBps != null ? `، ${pct(m.rateBps)}` : ''}${basis ? `ِ ${basis}` : ''}`;
      break;
    case 'data_accuracy_bonus': s = 'اطلاعات تماس اول درست بود'; break;
    case 'returned_case_deduction': s = `برگشت «${kindLabel(m?.reversedKind ?? 'salesperson_commission')}»${m?.reason ? `، دلیل: ${m.reason}` : ''}`; break;
    case 'paid_mark_reversal': s = `برگرداندن «پرداخت‌شده»${m?.reversedLedgerId ? ` برای ردیف #${fa(m.reversedLedgerId)}` : ''}${m?.reason ? `، دلیل: ${m.reason}` : ''}`; break;
    case 'team_bonus': s = `پاداش تیمی ${r.month ? monthLabel(r.month) : ''}`.trim(); break;
    default: s = kindLabel(r.kind);
  }
  return r.neutralized ? `${s} (با برگرداندن «پرداخت‌شده» خنثی شد)` : s;
}

function RowLinks({ r }: { r: { customerId: number | null; purchaseId: number | null; paymentOrderId: number | null } }) {
  return <>
    {r.customerId ? <Link className="lk" href={`/customers/${r.customerId}`}><User className="i" />پرونده</Link> : null}
    {r.purchaseId ? <Link className="lk" href={`/goods-purchases/${r.purchaseId}`}><ShoppingCart className="i" />خرید #{fa(r.purchaseId)}</Link> : null}
    {r.paymentOrderId ? <Link className="lk" href={`/payment-orders/${r.paymentOrderId}`}><FileText className="i" />دستور #{fa(r.paymentOrderId)}</Link> : null}
  </>;
}

/** Hero + three tiles; shared by the page and the dashboard card. */
export function WalletHero({ d, admin, onJump }: { d: StaffWalletPayload; admin: boolean; onJump?: (id: string) => void }) {
  const monthTotal = d.monthPostedToman;
  const newStaff = !d.ledger.length && !d.pending.length && isZero(d.balanceToman);
  const jump = (id: string) => () => onJump?.(id);
  const qualifier = d.salesperson.role === 'qualifier';
  return <>
    <section className="hero" aria-label="موجودی کیف پول">
      <span className="eb"><Wallet className="i" />{admin ? `کیف پول ${d.salesperson.name}` : 'موجودی کیف پول من'}</span>
      <span className="bal">{isNeg(d.balanceToman) ? '−' : ''}{sep(d.balanceToman)} <small>تومان</small></span>
      <p>فقط پورسانت‌های ثبت‌شده، ماه به ماه صفر نمی‌شود</p>
      <div className="mt"><span>{monthLabel(d.currentMonth)}</span>
        <b>{d.month === d.currentMonth && !isZero(monthTotal)
          ? <><span className={`ltr ${isNeg(monthTotal) ? 'dn' : 'up'}`}>{isNeg(monthTotal) ? '−' : '+'}{sep(monthTotal)}</span> تومان</>
          : d.month === d.currentMonth ? 'هنوز ثبتی ندارد' : '—'}</b></div>
    </section>
    {newStaff
      ? <div className="note" role="note"><Info className="i" /><span>اولین پورسانت {admin ? 'این کارشناس' : 'شما'} وقتی ثبت می‌شود که دستور پرداخت یکی از پرونده‌ها{admin ? 'ی او' : 'یتان'} «پرداخت‌شده» شود.</span></div>
      : <div className="tiles">
        <button type="button" className="tile rec" onClick={jump('sw-ledger')}><span className="k"><CheckCircle2 className="i" />ثبت‌شده این ماه</span>
          <span className="v"><span className="ltr">{isNeg(monthTotal) ? '−' : '+'}{sep(monthTotal)}</span> <small>تومان</small></span>
          <span className="s">{fa(d.monthRowCount)} ردیف در دفتر</span></button>
        <button type="button" className="tile pen" onClick={jump('sw-pend')}><span className="k"><Clock3 className="i" />در انتظار علامت پرداخت</span>
          <span className="v">{fa(d.pending.length)} <small>پرونده</small></span><span className="s">بعد از «پرداخت‌شده» ثبت می‌شود</span></button>
        {qualifier || !d.tier
          ? <button type="button" className="tile wide" onClick={jump('sw-month')}><span className="k"><Star className="i" /><bdi>سهم P1</bdi> این ماه</span>
            <span className="v">{isZero(d.p1Month.totalToman) ? <span className="muted">—</span> : <Signed v={d.p1Month.totalToman} />}</span>
            <span className="s">{d.p1Month.count ? `${fa(d.p1Month.count)} پرونده، ثبت‌شده` : 'هنوز ثبتی ندارد'}</span></button>
          : <button type="button" className="tile wide" onClick={jump('sw-tier')}><span className="k"><Layers className="i" />پله‌ی این ماه</span>
            <span className="v">پله {fa(d.tier.tier)} <small>({pct(d.tier.rateBps)})</small></span>
            <span className="s">{d.tier.nextTier != null ? `${shortMoney(d.tier.remainingToman)} تا پله ${fa(d.tier.nextTier)}` : 'بالاترین پله'}</span></button>}
      </div>}
  </>;
}

function Pending({ d }: { d: StaffWalletPayload }) {
  return <section className="sec" id="sw-pend">
    <header><h2><Clock3 className="i" />در انتظار</h2><span className="st wait">{fa(d.pending.length)}</span></header>
    {d.pending.length ? d.pending.map((p) => {
      const [c, t] = pendingState(p);
      return <div className="pc" key={`${p.purchaseId}-${p.kind}`}>
        <b><CustomerName name={p.customerName} id={p.customerId} fallback={`مشتری #${fa(p.customerId)}`} /></b><span className={`st ${c}`}>{t}</span>
        <span className="idl"><bdi>{kindChip(p.kind)}</bdi>{p.closerName ? ` (پیگیری: ${p.closerName})` : ''}، منتظر: {since(p.since)}</span>
        <span className="pnote"><Clock3 className="i" />مبلغ بعد از «پرداخت‌شده» حساب و ثبت می‌شود</span>
        <div className="lks"><RowLinks r={p} /></div>
      </div>;
    }) : <p className="hint">چیزی در انتظار نیست. پرونده‌هایی که به مرحله‌ی دستور پرداخت برسند اینجا می‌آیند.</p>}
  </section>;
}

function MonthBreakdown({ d, onMonth, loading }: { d: StaffWalletPayload; onMonth: (m: string) => void; loading: boolean }) {
  const role = d.salesperson.role;
  const by = new Map(d.breakdown.map((b) => [b.kind, b]));
  const reason = (kind: string): string | null => {
    if (kind === 'salesperson_commission' && role === 'qualifier') return 'در نقش شما نیست';
    if ((kind === 'p1_referral_share' || kind === 'data_accuracy_bonus') && role !== 'qualifier' && !by.get(kind)?.count) return 'فقط برای کارشناس تماس اول';
    if (kind === 'team_bonus' && !d.teamBonusEnabled && !by.get(kind)?.count) return 'این ماه خاموش است';
    return null;
  };
  const sub = (kind: string, count: number) => {
    if (!count) return kind === 'returned_case_deduction' ? 'این ماه پرونده‌ی برگشتی نداشت' : 'هنوز ثبتی ندارد';
    if (kind === 'data_accuracy_bonus' && d.stats.accuracyReviewed) return `${fa(d.stats.accuracyCorrect)} از ${fa(d.stats.accuracyReviewed)} درست`;
    if (kind === 'salesperson_commission' && d.tier && d.month === d.currentMonth) return `${fa(count)} ردیف، پله ${fa(d.tier.tier)} (${pct(d.tier.rateBps)})`;
    return `${fa(count)} ردیف`;
  };
  const reversal = by.get('paid_mark_reversal');
  return <section className="sec" id="sw-month" aria-busy={loading}>
    <header><h2><Coins className="i" />ریز ماه</h2>
      <div className="mnav">
        <button type="button" className="icon-btn" aria-label="ماه قبل" onClick={() => onMonth(shiftMonth(d.month, -1))}><ChevronRight className="i" /></button>
        <b>{monthLabel(d.month)}</b>
        <button type="button" className="icon-btn" aria-label="ماه بعد" disabled={d.month >= d.currentMonth} onClick={() => onMonth(shiftMonth(d.month, 1))}><ChevronLeft className="i" /></button>
      </div></header>
    <div>
      {MONTH_ROWS.map(({ kind, icon: Icon, cls }) => {
        const b = by.get(kind); const na = reason(kind);
        return <div className={`cr ${na ? 'na' : ''}`} key={kind}>
          <span className={`ic ${cls}`}><Icon className="i" /></span><b>{kindLabel(kind)}</b>
          <small>{na ?? sub(kind, b?.count ?? 0)}</small>
          <span className="v">{na || !b || isZero(b.totalToman) ? <span className="muted">—</span> : <Signed v={b.totalToman} />}</span>
        </div>;
      })}
      {reversal?.count ? <div className="cr"><span className="ic neg"><Undo2 className="i" /></span><b>{kindLabel('paid_mark_reversal')}</b>
        <small>{fa(reversal.count)} ردیف</small><span className="v"><Signed v={reversal.totalToman} /></span></div> : null}
    </div>
    <div className="mtot"><span>جمع ثبت‌شده‌ی {monthName(d.month)}</span><b>{isZero(d.monthPostedToman) ? '۰' : <Signed v={d.monthPostedToman} />} تومان</b></div>
  </section>;
}

function Ledger({ d, onOpen }: { d: StaffWalletPayload; onOpen: (r: WalletLedgerRow) => void }) {
  const [kind, setKind] = useState('all');
  const kinds = useMemo(() => ['all', ...Array.from(new Set(d.ledger.map((r) => r.kind)))], [d.ledger]);
  useEffect(() => { if (!kinds.includes(kind)) setKind('all'); }, [kinds, kind]);
  const rows = d.ledger.filter((r) => kind === 'all' || r.kind === kind);
  return <section className="sec" id="sw-ledger">
    <header><h2><History className="i" />دفتر کیف پول</h2><span className="muted">فقط ثبت‌شده‌ها</span></header>
    <p className="hint" style={{ marginTop: -4 }}>تاریخ هر ردیف همان تاریخ واقعی واریز است.</p>
    {d.ledger.length ? <>
      <div className="kchips" role="radiogroup" aria-label="نوع">
        {kinds.map((k) => <button type="button" key={k} className="chip" role="radio" aria-checked={k === kind} onClick={() => setKind(k)}>{k === 'all' ? 'همه' : kindChip(k)}</button>)}
      </div>
      <div className="ledger-cards">
        {rows.map((r) => <div className={`lr ${r.neutralized ? 'off' : ''}`} key={r.id}>
          <span className="t"><span className={`kt ${kindClass(r.kind)}`}>{kindChip(r.kind)}</span><b><CustomerName name={r.customerName} id={r.customerId} fallback={r.kind === 'team_bonus' ? 'تیم فروش' : '—'} /></b></span>
          <span className="a"><Signed v={r.amountToman} /><small>{dayMonth(r.date)}، {hm(r.date)}</small></span>
          <span className="ds">{rowDescription(r)}</span>
          <div className="lks"><RowLinks r={r} /><button type="button" className="lk more" onClick={() => onOpen(r)}>جزئیات<ChevronLeft className="i" /></button></div>
        </div>)}
      </div>
      <table className="lt">
        <thead><tr><th>تاریخ</th><th>نوع</th><th>مشتری و شرح</th><th>پیوندها</th><th style={{ textAlign: 'left' }}>مبلغ (تومان)</th><th aria-label="جزئیات" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className={r.neutralized ? 'off' : ''}>
          <td style={{ whiteSpace: 'nowrap' }}>{dayMonth(r.date)}<div className="muted">{hm(r.date)}</div></td>
          <td><span className={`kt ${kindClass(r.kind)}`}>{kindChip(r.kind)}</span></td>
          <td><b><CustomerName name={r.customerName} id={r.customerId} fallback={r.kind === 'team_bonus' ? 'تیم فروش' : '—'} /></b><div className="muted">{rowDescription(r)}</div></td>
          <td><div className="lks"><RowLinks r={r} /></div></td>
          <td className="n"><Signed v={r.amountToman} /></td>
          <td><button type="button" className="lk" onClick={() => onOpen(r)}>جزئیات</button></td>
        </tr>)}</tbody>
      </table>
    </> : <div className="empty" style={{ padding: 20 }}><span className="big"><Wallet className="i" /></span><h2>هنوز ردیفی ثبت نشده</h2>
      <p>اولین پورسانت بعد از «پرداخت‌شده» شدن یک دستور پرداخت اینجا می‌آید.</p></div>}
  </section>;
}

function Tier({ d, admin }: { d: StaffWalletPayload; admin: boolean }) {
  const t = d.tier;
  if (!t || d.salesperson.role === 'qualifier') return null;
  const top = Number(t.tiers[3]?.fromToman ?? 0) || 1;
  const fill = Math.min(100, (Number(t.salesToman) / top) * 100);
  return <section className="sec tier" id="sw-tier">
    <header><h2><Layers className="i" />{admin ? `پله‌ی ${d.salesperson.name}` : 'پله‌ی من'} در {monthName(d.month)}</h2></header>
    <div className="row"><span>فروش ماه</span><b>{sep(t.salesToman)} تومان</b></div>
    <div className="tbar" aria-hidden="true"><i style={{ width: `${fill}%` }} />
      {t.tiers.slice(1, 3).map((x) => <u key={x.tier} style={{ insetInlineStart: `${(Number(x.fromToman) / top) * 100}%` }} />)}</div>
    {t.nextTier != null
      ? <div className="row"><span>تا پله {fa(t.nextTier)} ({pct(t.tiers[t.nextTier]?.rateBps)})</span><b>{sep(t.remainingToman)} تومان</b></div>
      : <div className="row"><span>در بالاترین پله</span><b>{pct(t.rateBps)}</b></div>}
    <div className="tlist">{t.tiers.map((x, i) => <div key={x.tier} className={x.tier === t.tier ? 'on' : ''}>
      <b>{pctShort(x.rateBps)}</b>{i === 0 ? `زیر ${shortMoneyM(t.tiers[1]?.fromToman)}` : `از ${shortMoneyM(x.fromToman)}`}</div>)}</div>
    <p className="hint">پله را فقط مدیر تغییر می‌دهد.</p>
  </section>;
}

function Flow({ admin }: { admin: boolean }) {
  return <section className="sec" aria-label="پورسانت کی ثبت می‌شود">
    <header><h2><Info className="i" />پورسانت کی ثبت می‌شود؟</h2></header>
    <ol className="flow">
      <li className="ok"><span className="d"><ShoppingCart className="i" /></span>خرید تکمیل شد</li>
      <li className="g"><span className="d"><FileText className="i" /></span>حسابداری یا مدیر «پرداخت‌شده» زد</li>
      <li className="ok"><span className="d"><Wallet className="i" /></span>در کیف پول ثبت شد</li>
    </ol>
    <p className="hint">مبلغ با تاریخ واقعی واریز و در همان ماه ثبت می‌شود. اگر پرونده برگردد، کسر آن در ماه بعد می‌آید. «پرداخت‌شده» را فقط مدیر برمی‌گرداند؛ چیزی پاک نمی‌شود و ردیف برگشتی با دلیل در دفتر می‌آید.</p>
    <p className="lockline"><Lock className="i" />{admin ? 'هر کارشناس فقط کیف پول خودش را می‌بیند.' : 'این صفحه را فقط شما و مدیر می‌بینید.'}</p>
  </section>;
}

function RowSheet({ r, onClose }: { r: WalletLedgerRow; onClose: () => void }) {
  const payer = r.paidByRole === 'admin' ? 'مدیر' : r.paidByRole ? 'حسابداری' : 'حسابداری یا مدیر';
  const team = r.model === 'team';
  return <Sheet title={kindLabel(r.kind)} onClose={onClose} labelId="sw-row-title" className="sw-sheet">
    <div className="sum">
      <div className="r"><span>مشتری</span><b><CustomerName name={r.customerName} id={r.customerId} /></b></div>
      <div className="r"><span>شرح</span><b>{rowDescription(r)}</b></div>
      <div className="r"><span>ماه پورسانت</span><b>{r.month ? monthLabel(r.month) : '—'}{team && r.purchaseId ? '، از تاریخ واقعی واریز' : ''}</b></div>
      <div className="r"><span>وضعیت</span><b>{r.neutralized ? <span className="st mute">خنثی‌شده</span> : <span className="st paid">ثبت‌شده در کیف پول</span>}</b></div>
      <div className="r big"><span>مبلغ</span><b><Signed v={r.amountToman} /> تومان</b></div>
    </div>
    <ol className="tl">
      {r.purchaseId && r.completedAt ? <li><span className="ic"><ShoppingCart className="i" /></span><div><div className="who">{dayMonth(r.completedAt)}، {hm(r.completedAt)}</div>
        <p className="tx"><b>خرید #{fa(r.purchaseId)} تکمیل شد</b>، پورسانت در انتظار پرداخت</p></div></li> : null}
      {team && r.paymentOrderId && (r.kind === 'salesperson_commission' || r.kind === 'p1_referral_share') ? <li><span className="ic g"><FileText className="i" /></span><div><div className="who">{payer}، {dayMonth(r.date)}</div>
        <p className="tx"><b>دستور #{fa(r.paymentOrderId)} «پرداخت‌شده» شد</b></p></div></li> : null}
      <li><span className={`ic ${isNeg(r.amountToman) ? 'bad' : 'ok'}`}><Wallet className="i" /></span><div><div className="who">سیستم، {dayMonth(r.createdAt)} {hm(r.createdAt)}</div>
        <p className="tx"><b>در کیف پول ثبت شد</b>، ردیف دفتر #{fa(r.id)}</p></div></li>
    </ol>
    {r.kind === 'paid_mark_reversal' || r.kind === 'returned_case_deduction' || r.neutralized
      ? <p className="hint">چیزی پاک نمی‌شود؛ ردیف برگشتی با دلیل در دفتر می‌آید.</p> : null}
    <div className="lkgrid">
      {r.customerId ? <Link className="ghost" href={`/customers/${r.customerId}`}><User className="i s" />پرونده‌ی مشتری</Link> : null}
      {r.purchaseId ? <Link className="ghost" href={`/goods-purchases/${r.purchaseId}`}><ShoppingCart className="i s" />خرید<small>#{fa(r.purchaseId)}</small></Link> : null}
      {r.paymentOrderId ? <Link className="ghost" href={`/payment-orders/${r.paymentOrderId}`}><FileText className="i s" />دستور پرداخت<small>#{fa(r.paymentOrderId)}</small></Link> : null}
      <span className="ghost" aria-label={`ردیف دفتر شماره ${r.id}`}><History className="i s" />ردیف دفتر<small>#{fa(r.id)}</small></span>
    </div>
  </Sheet>;
}

export function NoOwnWallet() {
  return <div className="empty" data-testid="no-own-wallet"><span className="big"><Wallet className="i" /></span><h2>کیف پول کارشناسی برای حساب شما تعریف نشده</h2>
    <p>این صفحه فقط کیف پول خودِ کارشناس فروش را نشان می‌دهد. وضعیت پورسانت خریدها را در «مدیریت کیف پول ← وضعیت تراکنش‌ها» ببینید.</p>
    <Link href="/wallet-management" className="nf-btn nf-btn-primary nf-btn-lg retry">رفتن به مدیریت کیف پول</Link></div>;
}

export function WalletError({ onRetry }: { onRetry: () => void }) {
  return <div className="empty err"><span className="big"><AlertCircle className="i" /></span><h2>کیف پول باز نشد</h2>
    <p>اتصال برقرار نشد. موجودی تغییری نکرده است.</p>
    <button type="button" className="nf-btn nf-btn-primary nf-btn-lg retry" onClick={onRetry}>دوباره امتحان کن</button></div>;
}

export function useIsDesktop() {
  const mq = '(min-width: 1024px)';
  const [v, setV] = useState(() => typeof window !== 'undefined' && window.matchMedia(mq).matches);
  useEffect(() => {
    const m = window.matchMedia(mq); const on = () => setV(m.matches);
    m.addEventListener('change', on); on();
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

const initials = (n: string) => n.replace(/^(آقای|خانم)\s+/, '').trim().charAt(0) || '؟';

export default function StaffWallet() {
  const initial = new URLSearchParams(window.location.search);
  const [pick, setPick] = useState<number | null>(Number(initial.get('p')) || null);
  const [month, setMonth] = useState<string | null>(null);
  const [row, setRow] = useState<WalletLedgerRow | null>(null);
  const q = useQuery({ queryKey: ['staff-wallet', pick, month], queryFn: () => staffWalletApi.wallet({ salespersonId: pick, month }), placeholderData: (p) => p,
    retry: (n, e) => (e as { status?: number })?.status !== 403 && n < 1 });
  const d = q.data;
  const desktop = useIsDesktop();
  const admin = d?.viewer === 'admin';
  useEffect(() => {
    const u = new URL(window.location.href);
    if (pick) u.searchParams.set('p', String(pick)); else u.searchParams.delete('p');
    window.history.replaceState(window.history.state, '', u);
  }, [pick]);
  const jump = useCallback((id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), []);
  const close = useCallback(() => setRow(null), []);

  // 403 = this login has no salesperson wallet (e.g. accounting). The server never returns anyone else's wallet; say so calmly instead of "connection failed".
  if (q.isError && (q.error as { status?: number })?.status === 403) return <div className="nfk sw"><NoOwnWallet /></div>;
  if (q.isError && !d) return <div className="nfk sw"><WalletError onRetry={() => q.refetch()} /></div>;
  if (!d) return <div className="nfk sw" aria-busy="true"><div className="sk" style={{ height: 150 }} /><div className="sk" /><div className="sk" style={{ height: 240 }} /></div>;

  const intro = admin ? <div className="intro"><div><span className="idl">پاداش فروش</span><h2>کیف پول کارشناس‌ها</h2></div>
    <div className="pick" role="radiogroup" aria-label="کارشناس">
      {(d.pickers ?? []).map((p) => <button type="button" key={p.id} className="chip" role="radio" aria-checked={p.id === d.salesperson.id}
        onClick={() => { setPick(p.id); setMonth(null); }}><span className="av" aria-hidden="true">{initials(p.name)}</span>{p.name}</button>)}
    </div></div> : null;
  const hero = <WalletHero d={d} admin={admin} onJump={jump} />;
  const monthBlock = <MonthBreakdown d={d} onMonth={setMonth} loading={q.isFetching} />;
  const ledger = <Ledger d={d} onOpen={setRow} />;
  return <div className="nfk sw">
    {intro}
    {q.isError ? <div className="note" role="alert"><AlertCircle className="i" /><span>به‌روزرسانی نشد؛ آخرین داده‌ی دریافت‌شده را می‌بینید.</span></div> : null}
    {desktop
      ? <div className="dgrid"><div>{hero}{monthBlock}{ledger}</div><div><Pending d={d} /><Tier d={d} admin={admin} /><Flow admin={admin} /></div></div>
      : <>{hero}<Pending d={d} />{monthBlock}{ledger}<Tier d={d} admin={admin} /><Flow admin={admin} /></>}
    {row ? <RowSheet r={row} onClose={close} /> : null}
  </div>;
}
