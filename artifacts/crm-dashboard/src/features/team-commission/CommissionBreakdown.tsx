import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ChevronLeft, ChevronRight, Coins, Gift, History, Layers, MinusCircle, Star, Users } from 'lucide-react';
import { api, type SalespersonSummary } from '@/lib/goods-api';
import { fa, faDateTime, jalaliLabel, KIND_CHIPS, KIND_LABELS, pct, tm } from './api';
import './team-commission.css';

const ICON: Record<string, [string, typeof Coins]> = {
  salesperson_commission: ['', Coins], p1_referral_share: ['p1', Star], data_accuracy_bonus: ['ok', Gift], returned_case_deduction: ['neg', MinusCircle], team_bonus: ['team', Users],
};
const KD: Record<string, string> = { salesperson_commission: 't', p1_referral_share: 'p1', data_accuracy_bonus: 'ok', returned_case_deduction: 'neg', team_bonus: 't' };
const shiftMonth = (m: string, d: number) => { const [y, mo] = m.split('-').map(Number); const i = y * 12 + (mo - 1) + d; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
const big = (v: string | number | null | undefined) => { try { return BigInt(String(v ?? '0').split('.')[0] || '0'); } catch { return 0n; } };
const sign = (v: string) => (big(v) < 0n ? '−' : '+');

function describe(t: SalespersonSummary['transactions'][number]): string {
  const m = (t.meta ?? {}) as Record<string, any>;
  const who = t.customerName ?? '';
  const base = m.basisAmountToman ? ` از ${tm(m.basisAmountToman)}` : '';
  switch (t.kind) {
    case 'salesperson_commission': return m.model === 'team' ? `${who} · ${m.tier ? `پله ${fa(m.tier)} · ` : ''}${pct(Number(m.rateBps ?? 0))}${base}` : `${who} · مدل قبلی`;
    case 'p1_referral_share': return `${who} · ${m.p1Kind === 'upgrade' ? 'ارتقا' : 'تماس اول'} ${pct(Number(m.rateBps ?? 0))}${base}`;
    case 'data_accuracy_bonus': return `${who} · ${big(t.amountToman) < 0n ? 'اصلاح مدیر' : '«اطلاعات درست بود»'}`;
    case 'returned_case_deduction': return `${who} · برگشت ${m.reversedKind === 'p1_referral_share' ? 'سهم معرفی' : 'پورسانت'}${m.reason ? ` — ${m.reason}` : ''}`;
    case 'team_bonus': return `فروش تیم ${tm(m.teamSalesToman ?? 0)} · سهم ${pct(Number(m.splitBps ?? 0))}`;
    default: return who;
  }
}

/** Monthly breakdown + ledger with kind filter chips (design crm-commission 16-19). */
export function CommissionReport({ id, isQualifier }: { id: number; isQualifier: boolean }) {
  const [month, setMonth] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('');
  const qs = new URLSearchParams(); if (month) qs.set('month', month); if (kind) qs.set('kind', kind);
  const q = useQuery({ queryKey: ['salesperson-summary', id, month, kind], queryFn: () => api.get<SalespersonSummary>(`/goods-finance/salespersons/${id}/summary${qs.toString() ? `?${qs}` : ''}`), staleTime: 30_000, placeholderData: (p) => p });
  const s = q.data;
  const cur = s?.month ?? month ?? '';
  const st = s?.stats;
  const rows = (s?.breakdown ?? []).filter((r) => r.count > 0 || ['salesperson_commission', 'returned_case_deduction'].includes(r.kind) || (isQualifier && ['p1_referral_share', 'data_accuracy_bonus'].includes(r.kind)));
  const detail = (k: string, count: number) => {
    if (!st) return '';
    if (k === 'p1_referral_share') return count ? `${fa(count)} پرونده · ${fa(st.p1FirstCall)} تماس اول، ${fa(st.p1Upgrade)} ارتقا` : isQualifier ? 'هنوز ندارد' : 'ندارد (فقط برای کارشناس تماس اول)';
    if (k === 'data_accuracy_bonus') return st.accuracyReviewed ? `${fa(st.accuracyCorrect)} «درست بود» از ${fa(st.accuracyReviewed)} بررسی` : isQualifier ? 'هنوز بررسی نشده' : 'ندارد (فقط برای کارشناس تماس اول)';
    if (k === 'returned_case_deduction') return st.reversedCases ? `${fa(st.reversedCases)} پرونده` : 'ندارد';
    if (k === 'salesperson_commission') return count ? `${fa(count)} فروش` : 'ندارد';
    return count ? `${fa(count)} ردیف` : 'ندارد';
  };
  const chips = ['', 'salesperson_commission', ...(isQualifier ? ['p1_referral_share', 'data_accuracy_bonus'] : []), 'returned_case_deduction', 'team_bonus'];
  const tx = s?.transactions ?? [];
  return <div className="tc tc-rcols" data-testid="tc-report">
    <section className="tc-sec" data-testid="tc-breakdown">
      <header><h2><Layers size={20} /> ریز پورسانت {cur ? jalaliLabel(cur) : ''}</h2>
        <span className="tc-month"><button type="button" className="tc-ib" aria-label="ماه قبل" onClick={() => setMonth(shiftMonth(cur, -1))} disabled={!cur}><ChevronRight size={18} /></button>
          <button type="button" className="tc-ib" aria-label="ماه بعد" onClick={() => setMonth(shiftMonth(cur, 1))} disabled={!cur}><ChevronLeft size={18} /></button></span></header>
      {q.isLoading ? <p className="tc-muted">در حال بارگذاری…</p> : <div className="tc-brk">
        {rows.map((r) => { const [c, Icon] = ICON[r.kind] ?? ['', Coins]; const v = big(r.totalToman); return <div className="r" key={r.kind} data-testid={`tc-brk-${r.kind}`}>
          <span className={`ic ${c}`}><Icon size={18} /></span><div><b>{KIND_LABELS[r.kind] ?? r.kind}</b><small>{detail(r.kind, r.count)}</small></div>
          <span className={`v ${v < 0n ? 'amt-neg' : v > 0n ? '' : 'tc-muted'}`}>{v ? `${v < 0n ? '−' : ''}${tm(r.totalToman)}` : '—'}</span></div>; })}
        <div className="r tot"><span /><div>جمع این ماه</div><span className="v" data-testid="tc-month-total">{big(s?.monthTotalToman) < 0n ? '−' : ''}{tm(s?.monthTotalToman ?? '0')}</span></div>
      </div>}
    </section>
    <section className="tc-sec" data-testid="tc-ledger">
      <header><h2><History size={20} /> دفتر تراکنش‌ها</h2></header>
      <div className="tc-fl" role="toolbar" aria-label="نوع تراکنش">{chips.map((k) => <button key={k || 'all'} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} data-testid={`tc-chip-${k || 'all'}`}>{k ? KIND_CHIPS[k] : 'همه'}</button>)}</div>
      {!tx.length ? <p className="tc-muted">تراکنشی نیست.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>تاریخ</th><th>نوع</th><th>شرح</th><th>خرید</th><th>مبلغ</th></tr></thead><tbody>
        {tx.map((t, i) => <tr key={t.id ?? i}><td className="secondary-cell">{faDateTime(t.createdAt)}</td><td><span className={`tc-kd ${KD[t.kind ?? ''] ?? 't'}`}>{KIND_CHIPS[t.kind ?? ''] ?? t.kind}</span></td><td>{describe(t)}{t.customerId ? <> <CustomerIdBadge id={t.customerId} /></> : null}</td>
          <td>{t.purchaseId ? <Link className="text-link" href={`/goods-purchases/${t.purchaseId}`}>#{fa(t.purchaseId)}</Link> : '—'}</td>
          <td className={big(t.amountToman) < 0n ? 'amt-neg' : 'amt-pos'}>{sign(t.amountToman)}{tm(t.amountToman)}</td></tr>)}
      </tbody></table></div>}
    </section>
  </div>;
}
