import { useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { ShoppingBag, Plus, Wallet } from 'lucide-react';
import { EmptyState, Modal, SearchField } from '@/components/DataTools';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { CompanyPlanWallets } from '@/components/PlanWallets';
import { RegistrationSuggestions, type RegistrationSuggestion } from '@/components/RegistrationSuggestions';
import { api, errText, listOf, toman, stageLabel, stageIndex, STAGES, useMe, type EligibleWallet, type Purchase } from '@/lib/goods-api';
import { normalizePersianSearchText } from '@/lib/search';

export default function GoodsPurchases() {
  const { can } = useMe();
  const [search, setSearch] = useTableState('goods.search', '');
  const [stage, setStage] = useTableState('goods.stage', '');
  const [creating, setCreating] = useState(false);
  const [suggested, setSuggested] = useState<RegistrationSuggestion | null>(null);
  const list = useQuery({ queryKey: ['goods-purchases'], queryFn: () => api.get<unknown>('/goods-purchases').then((d) => listOf<Purchase>(d)), refetchInterval: 30_000 });
  const normalizedSearch = normalizePersianSearchText(search.trim());
  const rows = (list.data ?? []).filter((p) => (!stage || p.stage === stage) && normalizePersianSearchText(`${p.customerName} ${p.planName} ${p.id}`).includes(normalizedSearch));
  return <section className="data-page">
    <div className="page-intro">
      <div><div className="eyebrow">اعتبار خرید کالا</div><h2>خریدهای کالا</h2><p>از رزرو کامل اعتبار کیف پول تا امضای فاکتور، تسویه و دستور پرداخت.</p></div>
      {can('goods_purchases.manage') ? <button className="btn btn-primary" onClick={() => { setSuggested(null); setCreating(true); }} data-testid="button-new-goods-purchase"><Plus size={16} />خرید تازه</button> : null}
    </div>
    <RegistrationSuggestions kind="goods" onSelect={row => { setSuggested(row); setCreating(true); }} />
    <CompanyPlanWallets />
    <div className="gp-toolbar">
      <SearchField value={search} onChange={setSearch} placeholder="جستجوی مشتری، طرح یا شماره" testId="search-goods-purchases" />
      <div className="filter-tabs">
        <button className={`filter-tab ${!stage ? 'active' : ''}`} onClick={() => setStage('')}>همه</button>
        {STAGES.map((s) => <button key={s.key} className={`filter-tab ${stage === s.key ? 'active' : ''}`} onClick={() => setStage(s.key)}>{s.label}</button>)}
      </div>
    </div>
    {list.isLoading ? <SkeletonPanel rows={5} /> : list.isError ? <div className="panel"><div className="gp-alert">{errText(list.error)}</div><ErrorState onRetry={() => list.refetch()} /></div> : !rows.length ? <div className="panel"><EmptyState title="خریدی پیدا نشد" description="برای شروع، یک کیف پول دارای اعتبار طرح را انتخاب کنید." /></div> :
      <div className="gp-cards">{rows.map((p) => <Link key={p.id} href={`/goods-purchases/${p.id}`} className="gp-card" data-testid={`card-goods-purchase-${p.id}`}>
        <div className="gp-card-top"><span className="mono">#{p.id.toLocaleString('fa-IR')}</span><span className={`inline-badge ${p.stage === 'completed' ? 'active' : 'gold'}`}>{stageLabel(p.stage)}</span></div>
        <strong>{p.customerName}</strong><span className="secondary-cell" style={{ display: 'block', marginTop: 3 }}>کارشناس فروش فعلی: {p.customerSalespersonName || 'بدون تخصیص'}</span><span className="secondary-cell">{p.planName}</span>
        <div className="gp-amount">{toman(p.creditAmountToman)}</div>
        <div className="gp-progress"><i style={{ transform: `scaleX(${(stageIndex(p.stage) + 1) / STAGES.length})` }} /></div>
        <span className="secondary-cell">{formatDateTime(p.createdAt)}</span>
      </Link>)}</div>}
    {creating ? <CreatePurchase initial={suggested} onClose={() => setCreating(false)} /> : null}
  </section>;
}

function CreatePurchase({ onClose, initial }: { onClose: () => void; initial: RegistrationSuggestion | null }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const [q, setQ] = useState(initial?.phone || initial?.customerName || '');
  const [picked, setPicked] = useState<EligibleWallet | null>(null);
  const eligible = useQuery({ queryKey: ['goods-eligible', q], queryFn: () => api.get<{ items: EligibleWallet[]; unassignedNotice?: string }>(`/goods-purchases/eligible?q=${encodeURIComponent(q.trim())}`), staleTime: 0, refetchInterval: 30_000 });
  const create = useMutation({
    mutationFn: (w: EligibleWallet) => api.post<Purchase>('/goods-purchases', { customerId: w.customerId, planId: w.planId }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['goods-purchases'] }); qc.invalidateQueries({ queryKey: ['goods-eligible'] }); qc.invalidateQueries({ queryKey: ['registration-suggestions', 'goods'] }); onClose(); go(`/goods-purchases/${p.id}`); },
  });
  const items = listOf<EligibleWallet>(eligible.data);
  const selected = items.find(w => w.customerId === (picked?.customerId ?? initial?.customerId)
    && w.planId === (picked?.planId ?? initial?.planId)) ?? null;
  return <Modal title="شروع خرید کالا" eyebrow="انتخاب کیف پول طرح" onClose={onClose} testId="create-goods-purchase" wide>
    <p className="secondary-cell" style={{ marginBottom: 10 }}>کل موجودی مثبت کیف پول آن طرح رزرو می‌شود. هر کیف پول فقط یک رزرو فعال دارد.</p>
    <SearchField value={q} onChange={setQ} placeholder="نام، موبایل یا کد ملی مشتری" testId="search-eligible" />
    {eligible.data?.unassignedNotice ? <div className="gp-alert warn">{eligible.data.unassignedNotice}</div> : null}
    <div className="gp-pick-list">
      {eligible.isLoading ? <SkeletonPanel rows={3} /> : eligible.isError ? <div className="gp-alert">{errText(eligible.error)}</div> : !items.length ? <EmptyState title="کیف پول واجد شرایطی نیست" description="فقط مشتریان با موجودی مثبت تفکیک‌شده به طرح نمایش داده می‌شوند." /> :
        items.map((w) => <button type="button" key={`${w.customerId}-${w.planId}`} className={`gp-pick ${selected === w ? 'on' : ''}`} onClick={() => setPicked(w)} data-testid={`pick-wallet-${w.customerId}-${w.planId}`}>
          <Wallet size={18} /><div><strong>{w.customerName}</strong><span>کارشناس فروش فعلی: {w.customerSalespersonName || 'بدون تخصیص'}</span><span>{w.planName}</span></div><b>{toman(w.balanceToman)}</b>
        </button>)}
    </div>
    {create.isError ? <div className="gp-alert">{errText(create.error)}</div> : null}
    <div className="form-footer">
      <button className="btn btn-primary" disabled={!selected || create.isPending} onClick={() => selected && create.mutate(selected)} data-testid="button-confirm-purchase"><ShoppingBag size={15} />{create.isPending ? 'در حال رزرو…' : selected ? `رزرو ${toman(selected.balanceToman)}` : 'یک کیف پول انتخاب کنید'}</button>
      <button className="btn btn-ghost" onClick={onClose}>انصراف</button>
    </div>
  </Modal>;
}
