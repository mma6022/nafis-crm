import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Coins, Target } from 'lucide-react';
import { useListSalespersons } from '@workspace/api-client-react';
import { EmptyState } from '@/components/DataTools';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { api, digitsOnly, errText, toBig, toman, useMe, type SalespersonSettings, type SalespersonSummary } from '@/lib/goods-api';

export function useSalespersonSummary(id?: number | null) {
  return useQuery({ queryKey: ['salesperson-summary', id], queryFn: () => api.get<SalespersonSummary>(`/goods-finance/salespersons/${id}/summary`), enabled: Boolean(id), staleTime: 30_000 });
}

export function SalespersonSummaryCard({ id, compact = false }: { id: number; compact?: boolean }) {
  const q = useSalespersonSummary(id);
  if (q.isLoading) return <div className="metric-grid"><div className="metric-card skeleton" style={{ height: 110 }} /><div className="metric-card skeleton" style={{ height: 110 }} /><div className="metric-card skeleton" style={{ height: 110 }} /></div>;
  if (q.isError || !q.data) return <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div>;
  const s = q.data;
  return <div className="gp-commission">
    <div className="gp-wallet"><Coins size={20} /><span>کیف پول پورسانت</span><strong>{toman(s.balanceToman)}</strong><small>انباشته و بدون صفرشدن ماهانه</small></div>
    <div className="gp-fig"><span>فروش ماه {s.month}</span><strong>{toman(s.monthlySalesToman)}</strong></div>
    <div className="gp-fig teal"><span>کل فروش</span><strong>{toman(s.totalSalesToman)}</strong></div>
    {compact ? <Link href="/sales-commissions" className="text-link">دفتر پورسانت</Link> : null}
  </div>;
}

function Ledger({ id }: { id: number }) {
  const q = useSalespersonSummary(id);
  const tx = q.data?.transactions ?? [];
  return <div className="panel"><div className="panel-head"><div><h3>دفتر تراکنش‌ها</h3><p>پورسانت هر فروش کامل؛ پله بر اساس جمع ماه پس از فروش روی سرور محاسبه می‌شود.</p></div></div>
    {q.isLoading ? <SkeletonPanel rows={3} /> : !tx.length ? <EmptyState title="تراکنشی نیست" description="پس از تکمیل نخستین خرید کالا، پورسانت اینجا ثبت می‌شود." /> :
      <div className="table-wrap"><table className="data-table"><thead><tr><th>تاریخ</th><th>شرح</th><th>خرید</th><th>مبلغ</th></tr></thead><tbody>
        {tx.map((t, i) => <tr key={i}><td className="secondary-cell">{formatDateTime(t.createdAt)}</td><td>{t.kind === 'salesperson_commission' ? 'پورسانت فروش کامل' : t.kind}</td><td>{t.purchaseId ? <Link className="text-link" href={`/goods-purchases/${t.purchaseId}`}>#{t.purchaseId.toLocaleString('fa-IR')}</Link> : '—'}</td><td className={`mono ${toBig(t.amountToman) < 0n ? 'gp-neg' : ''}`}>{toman(t.amountToman)}</td></tr>)}
      </tbody></table></div>}
  </div>;
}

const blank: Record<keyof SalespersonSettings, string> = { target1Toman: '', target2Toman: '', target3Toman: '', rate0Percent: '', rate1Percent: '', rate2Percent: '', rate3Percent: '' };

export function SalespersonSettingsForm({ id, canEdit }: { id: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['salesperson-settings', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<SalespersonSettings | null>(`/goods-finance/salespersons/${id}/settings`) });
  const [f, setF] = useState(blank);
  useEffect(() => { const d = q.data; setF(d ? { target1Toman: String(d.target1Toman ?? ''), target2Toman: String(d.target2Toman ?? ''), target3Toman: String(d.target3Toman ?? ''), rate0Percent: String(d.rate0Percent ?? ''), rate1Percent: String(d.rate1Percent ?? ''), rate2Percent: String(d.rate2Percent ?? ''), rate3Percent: String(d.rate3Percent ?? '') } : blank); }, [q.data, id]);
  const save = useMutation({
    mutationFn: () => api.put<unknown>(`/goods-finance/salespersons/${id}/settings`, { target1Toman: digitsOnly(f.target1Toman), target2Toman: digitsOnly(f.target2Toman), target3Toman: digitsOnly(f.target3Toman), rate0Percent: Number(f.rate0Percent), rate1Percent: Number(f.rate1Percent), rate2Percent: Number(f.rate2Percent), rate3Percent: Number(f.rate3Percent) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['salesperson-summary', id] }); },
  });
  const ordered = toBig(digitsOnly(f.target1Toman)) > 0n && toBig(digitsOnly(f.target1Toman)) < toBig(digitsOnly(f.target2Toman)) && toBig(digitsOnly(f.target2Toman)) < toBig(digitsOnly(f.target3Toman));
  const submit = (e: FormEvent) => { e.preventDefault(); if (ordered) save.mutate(); };
  if (q.isLoading) return <SkeletonPanel rows={3} />;
  if (q.isError) return <div className="gp-alert">{errText(q.error)}</div>;
  const tiers: [keyof typeof f, keyof typeof f | null, string][] = [['rate0Percent', null, 'زیر پله اول'], ['rate1Percent', 'target1Toman', 'پله ۱'], ['rate2Percent', 'target2Toman', 'پله ۲'], ['rate3Percent', 'target3Toman', 'پله ۳']];
  return <form onSubmit={submit} className="gp-tiers">
    <fieldset disabled={!canEdit}>
      {tiers.map(([rate, target, label]) => <div className="gp-tier" key={rate}>
        <span className="gp-tier-name"><Target size={14} />{label}</span>
        {target ? <div className="field"><label>هدف فروش ماهانه (تومان)</label><input required dir="ltr" inputMode="numeric" value={toBig(digitsOnly(f[target])) ? toBig(digitsOnly(f[target])).toLocaleString('en-US') : ''} onChange={(e) => setF({ ...f, [target]: digitsOnly(e.target.value) })} /></div> : <div className="field"><label>بازه</label><input disabled value="از صفر تا پله اول" /></div>}
        <div className="field"><label>نرخ (%)</label><input required type="number" min={0} max={100} step={0.01} dir="ltr" value={f[rate]} onChange={(e) => setF({ ...f, [rate]: e.target.value })} /></div>
      </div>)}
    </fieldset>
    <p className="secondary-cell">ماه‌ها بر اساس تقویم شمسی تهران. پله بر اساس جمع فروش پس از فروش جدید تعیین و روی کل آن فروش اعمال می‌شود.</p>
    {!ordered && f.target1Toman ? <div className="gp-alert warn">اهداف فروش باید مثبت و صعودی باشند (پله ۱ کمتر از پله ۲ و پله ۲ کمتر از پله ۳). نرخ‌ها آزادند.</div> : null}
    {save.isError ? <div className="gp-alert">{errText(save.error)}</div> : null}
    {save.isSuccess ? <div className="gp-alert ok">تنظیمات ذخیره شد.</div> : null}
    {canEdit ? <div className="form-footer"><button className="btn btn-primary" disabled={save.isPending || !ordered}>{save.isPending ? 'در حال ذخیره…' : 'ذخیره پله‌ها'}</button></div> : null}
  </form>;
}

export default function SalesCommissions() {
  const { user, isAdmin, can } = useMe();
  const manage = isAdmin || can('goods_finance.manage');
  const people = useListSalespersons({ query: { queryKey: ['users-salespersons'], staleTime: 60_000, enabled: manage } });
  const initial = Number(new URLSearchParams(window.location.search).get('salespersonId')) || null;
  const [picked, setPicked] = useState<number | null>(initial);
  const target = manage ? picked ?? people.data?.[0]?.id ?? null : user?.salespersonId ?? null;
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">پاداش فروش</div><h2>پورسانت فروش</h2><p>پله‌های هدف ماهانه، نرخ‌ها و دفتر انباشته هر کارشناس.</p></div>
      {manage ? <select className="gp-select" value={target ?? ''} onChange={(e) => setPicked(Number(e.target.value))} data-testid="select-salesperson">{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : null}</div>
    {!target ? <div className="panel"><EmptyState title="کارشناس فروشی متصل نیست" description={manage ? 'نخست یک کارشناس فروش تعریف کنید.' : 'حساب شما به کارشناس فروش متصل نشده است.'} /></div> : <>
      <SalespersonSummaryCard id={target} />
      <div className="gp-detail-grid" style={{ marginTop: 16 }}>
        <div className="gp-main-col"><Ledger id={target} /></div>
        <aside className="panel"><h3 style={{ marginBottom: 10 }}>پله‌ها و نرخ‌ها</h3><SalespersonSettingsForm id={target} canEdit={isAdmin} /></aside>
      </div>
    </>}
  </section>;
}
