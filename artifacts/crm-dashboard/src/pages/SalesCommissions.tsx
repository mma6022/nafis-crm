import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Coins, Settings2, Target, Wallet } from 'lucide-react';
import { useListSalespersons } from '@workspace/api-client-react';
import { EmptyState } from '@/components/DataTools';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { useTeamSalesConfig } from '@/features/team-sales/api';
import { CommissionReport } from '@/features/team-commission/CommissionBreakdown';
import { TeamSettingsTab } from '@/features/team-commission/TeamSettingsTab';
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
  const params = new URLSearchParams(window.location.search);
  const initial = Number(params.get('salespersonId')) || null;
  const [picked, setPicked] = useState<number | null>(initial);
  const [tab, setTab] = useState<'ledger' | 'team'>(params.get('tab') === 'team' ? 'team' : 'ledger');
  const team = useTeamSalesConfig(Boolean(user));
  const target = manage ? picked ?? people.data?.[0]?.id ?? null : user?.salespersonId ?? null;
  const showTeam = isAdmin && tab === 'team';
  const pickTab = (t: 'ledger' | 'team') => { setTab(t); const u = new URL(window.location.href); if (t === 'team') u.searchParams.set('tab', 'team'); else u.searchParams.delete('tab'); window.history.replaceState(null, '', u); };
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">پاداش فروش</div><h2>{showTeam ? 'مدل فروش تیمی' : 'پورسانت فروش'}</h2><p>{showTeam ? 'سهم معرفی، پاداش درستی داده و پاداش تیمی.' : 'پله‌های هدف ماهانه، نرخ‌ها، ریز ماهانه و دفتر انباشته هر کارشناس.'}</p></div>
      {manage && !showTeam ? <select className="gp-select" value={target ?? ''} onChange={(e) => setPicked(Number(e.target.value))} data-testid="select-salesperson">{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : null}
      {isAdmin ? <div className="tc-ptabs" role="tablist" aria-label="بخش‌های پورسانت" style={{ width: '100%' }}>
        <button type="button" role="tab" aria-selected={!showTeam} onClick={() => pickTab('ledger')} data-testid="tab-ledger"><Wallet size={16} /> دفتر و گزارش</button>
        <button type="button" role="tab" aria-selected={showTeam} onClick={() => pickTab('team')} data-testid="tab-team-model"><Settings2 size={16} /> مدل فروش تیمی</button>
      </div> : null}</div>
    {showTeam ? <TeamSettingsTab /> : !target ? <div className="panel"><EmptyState title="کارشناس فروشی متصل نیست" description={manage ? 'نخست یک کارشناس فروش تعریف کنید.' : 'حساب شما به کارشناس فروش متصل نشده است.'} /></div> : <>
      <SalespersonSummaryCard id={target} />
      <div style={{ marginTop: 16 }}><CommissionReport id={target} isQualifier={team.data?.qualifierSalespersonId === target} /></div>
      <aside className="panel" style={{ marginTop: 16 }}><h3 style={{ marginBottom: 10 }}>پله‌ها و نرخ‌ها</h3><SalespersonSettingsForm id={target} canEdit={isAdmin} /></aside>
    </>}
  </section>;
}
