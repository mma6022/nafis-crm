import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Building2, Wallet } from 'lucide-react';
import { ErrorState, formatDateTime } from '@/components/CrmShell';
import { api, errText, toBig, toman, useMe } from '@/lib/goods-api';

type PlanBalance = { planId: number; planName: string; balanceToman: string };

export function CustomerPlanWallets({ customerId }: { customerId: number }) {
  const { can } = useMe();
  const q = useQuery({ queryKey: ['customer-plan-wallets', customerId], queryFn: () => api.get<{ items: PlanBalance[]; unassignedBalanceToman: string }>(`/customers/${customerId}/plan-credit-wallets`), enabled: can('goods_purchases.view'), staleTime: 30_000 });
  if (!can('goods_purchases.view')) return null;
  const unassigned = toBig(q.data?.unassignedBalanceToman);
  return <div className="panel" data-testid="panel-plan-wallets">
    <div className="panel-head"><div><h3>اعتبار تفکیکی طرح‌ها</h3><p>موجودی قابل خرید کالا برای هر طرح، به تومان</p></div><Wallet size={18} color="#9aa4b3" /></div>
    {q.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div> : q.isError ? <><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></> : <>
      {(q.data?.items ?? []).length ? <div className="gp-figures">{q.data!.items.map((w) => <div key={w.planId} className={`gp-fig ${toBig(w.balanceToman) > 0n ? 'teal' : ''}`}><span>{w.planName}</span><strong>{toman(w.balanceToman)}</strong></div>)}</div> : <p className="secondary-cell">اعتبار تفکیک‌شده به طرحی ندارد.</p>}
      {unassigned !== 0n ? <div className="gp-alert warn">{toman(unassigned.toString())} اعتبار قدیمی بدون منشأ طرح؛ برای خرید کالا نیاز به تطبیق مالی دارد.</div> : null}
      {(q.data?.items ?? []).some((w) => toBig(w.balanceToman) > 0n) && can('goods_purchases.manage') ? <Link href="/goods-purchases" className="text-link">شروع خرید کالا</Link> : null}
    </>}
  </div>;
}

type CompanyTx = { purchaseId?: number | null; planId: number; kind: string; amountToman: string; createdAt: string };
export function CompanyPlanWallets() {
  const { user, can } = useMe();
  const allowed = can('goods_finance.view') && (user?.role === 'admin' || user?.role === 'accounting');
  const q = useQuery({ queryKey: ['goods-company-wallets'], queryFn: () => api.get<{ items: PlanBalance[]; transactions: CompanyTx[] }>('/goods-finance/company-wallets'), enabled: allowed, staleTime: 30_000 });
  if (!allowed) return null;
  const names = new Map((q.data?.items ?? []).map((w) => [w.planId, w.planName]));
  return <div className="panel" style={{ marginBottom: 16 }} data-testid="panel-company-wallets">
    <div className="panel-head"><div><h3><Building2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6 }} />کیف پول شرکت به تفکیک طرح</h3><p>خالص اعتبار تسویه‌شده و تخفیف‌های توسعه</p></div></div>
    {q.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /></div> : q.isError ? <><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></> : <>
      {(q.data?.items ?? []).length ? <div className="gp-figures">{q.data!.items.map((w) => <div key={w.planId} className="gp-fig teal"><span>{w.planName}</span><strong>{toman(w.balanceToman)}</strong></div>)}</div> : <p className="secondary-cell">هنوز تسویه‌ای ثبت نشده است.</p>}
      {(q.data?.transactions ?? []).length ? <details><summary className="text-link" style={{ cursor: 'pointer' }}>آخرین تراکنش‌ها</summary><div className="table-wrap"><table className="data-table"><thead><tr><th>تاریخ</th><th>طرح</th><th>نوع</th><th>خرید</th><th>مبلغ</th></tr></thead><tbody>
        {q.data!.transactions.slice(0, 50).map((t, i) => <tr key={i}><td className="secondary-cell">{formatDateTime(t.createdAt)}</td><td>{names.get(t.planId) ?? `#${t.planId}`}</td><td>{t.kind === 'company_credit' ? 'خالص اعتبار شرکت' : 'تخفیف توسعه'}</td><td>{t.purchaseId ? <Link className="text-link" href={`/goods-purchases/${t.purchaseId}`}>#{t.purchaseId.toLocaleString('fa-IR')}</Link> : '—'}</td><td className="mono">{toman(t.amountToman)}</td></tr>)}
      </tbody></table></div></details> : null}
    </>}
  </div>;
}
