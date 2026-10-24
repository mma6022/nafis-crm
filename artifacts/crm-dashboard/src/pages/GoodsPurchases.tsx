import { useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { ShoppingBag, Plus, Wallet } from 'lucide-react';
import { EmptyState, SearchField } from '@/components/DataTools';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { SectionTabs, Wizard, type ListSection } from '@/components/goods/GpKit';
import { CompanyPlanWallets } from '@/components/PlanWallets';
import { RegistrationSuggestions, type RegistrationSuggestion } from '@/components/RegistrationSuggestions';
import { api, errText, listOf, toman, stageLabel, stageIndex, STAGES, useMe, type EligibleWallet, type Purchase } from '@/lib/goods-api';
import { normalizePersianSearchText } from '@/lib/search';

/** What happens next per stage; `act` = the team (not the customer) has to do something. */
export const NEXT_STEP: Record<string, { text: string; act: boolean; finance?: boolean }> = {
  discharge_pending: { text: 'تأیید تخلیه در پلتفرم بیرونی', act: true },
  invoice_draft: { text: 'ثبت اقلام فاکتور', act: true },
  invoice_signature: { text: 'منتظر امضای مشتری در امضامی', act: false },
  settlement_pending: { text: 'تعیین درصد واریزی و ثبت تسویه', act: true, finance: true },
  acknowledgement_signature: { text: 'منتظر امضای رسید و اقرارنامه', act: false },
  registrar_confirmation: { text: 'تأیید نهایی ثبت‌کننده', act: true },
  completed: { text: 'دستور پرداخت', act: false },
};
type GoodsFilter = { stage?: string; mine?: boolean };

export default function GoodsPurchases() {
  const { can } = useMe();
  const manage = can('goods_purchases.manage');
  const finance = can('goods_finance.manage');
  const [search, setSearch] = useTableState('goods.search', '');
  const [active, setActive] = useTableState('goods.section', 'all');
  const [creating, setCreating] = useState(false);
  const [suggested, setSuggested] = useState<RegistrationSuggestion | null>(null);
  const list = useQuery({ queryKey: ['goods-purchases'], queryFn: () => api.get<unknown>('/goods-purchases').then((d) => listOf<Purchase>(d)), refetchInterval: 30_000 });
  const normalizedSearch = normalizePersianSearchText(search.trim());
  const all = list.data ?? [];
  const isMine = (p: Purchase) => { const n = NEXT_STEP[p.stage]; return Boolean(n?.act && manage && (!n.finance || finance)); };
  const matches = (p: Purchase, f: GoodsFilter) => (!f.stage || p.stage === f.stage) && (!f.mine || isMine(p));
  // Section registry: the coming «در انتظار ایجاد» section plugs in here as `{ kind: 'custom', render }`.
  const sections: ListSection<GoodsFilter>[] = [
    { key: 'all', label: 'همه', testId: 'goods-all', count: all.length, kind: 'list', params: {} },
    { key: 'mine', label: 'کار با ماست', testId: 'goods-mine', tone: 'gold', count: all.filter(isMine).length, kind: 'list', params: { mine: true }, hidden: !manage },
    ...STAGES.map((s) => ({ key: s.key, label: s.label, testId: `goods-${s.key}`, count: all.filter((p) => p.stage === s.key).length, kind: 'list' as const, params: { stage: s.key } })),
  ];
  const section = sections.find((s) => s.key === active && !s.hidden) ?? sections[0];
  const rows = section.kind === 'list' ? all.filter((p) => matches(p, section.params) && normalizePersianSearchText(`${p.customerName} ${p.planName} ${p.id}`).includes(normalizedSearch)) : [];
  return <section className="data-page gp-page">
    <div className="page-intro gp-intro">
      <div><div className="eyebrow">خرید کالا</div><h2>خریدهای کالا</h2><p>از رزرو اعتبار تا امضای فاکتور، تسویه و دستور پرداخت.</p></div>
      <div className="gp-intro-tools">
        <SearchField value={search} onChange={setSearch} placeholder="مشتری، طرح یا شماره" testId="search-goods-purchases" />
        {manage ? <button className="btn btn-primary" onClick={() => { setSuggested(null); setCreating(true); }} data-testid="button-new-goods-purchase"><Plus size={16} />خرید تازه</button> : null}
      </div>
    </div>
    <SectionTabs sections={sections} active={section.key} onPick={setActive} label="بخش‌های خرید کالا" />
    {section.kind === 'custom' ? section.render() : list.isLoading ? <SkeletonPanel rows={5} /> : list.isError ? <div className="panel"><div className="gp-alert">{errText(list.error)}</div><ErrorState onRetry={() => list.refetch()} /></div> : !rows.length ? <div className="panel"><EmptyState title="خریدی پیدا نشد" description="برای شروع، یک کیف پول دارای اعتبار طرح را انتخاب کنید." /></div> : <>
      <div className="panel table-wrap gp-desktop-only"><table className="data-table gp-table">
        <thead><tr><th>خرید</th><th>مشتری</th><th>اعتبار</th><th>مرحله</th><th>قدم بعد</th></tr></thead>
        <tbody>{rows.map((p) => { const n = NEXT_STEP[p.stage]; return <tr key={p.id} className={isMine(p) ? 'gp-row-mark' : ''} data-testid={`row-goods-purchase-${p.id}`}>
          <td className="mono"><Link href={`/goods-purchases/${p.id}`}>#{p.id.toLocaleString('fa-IR')}</Link></td>
          <td><Link href={`/goods-purchases/${p.id}`} className="primary-cell">{p.customerName}</Link><span className="secondary-cell gp-sub">{p.customerSalespersonName || 'بدون کارشناس'} · {p.planName}</span></td>
          <td className="gp-money">{toman(p.creditAmountToman)}</td>
          <td><span className="gp-stage-cell"><span className={`gp-chip ${p.stage === 'completed' ? 'green' : n?.act ? 'gold' : 'blue'}`}><i />{stageLabel(p.stage)}</span><small>{(stageIndex(p.stage) + 1).toLocaleString('fa-IR')}/{STAGES.length.toLocaleString('fa-IR')}</small></span></td>
          <td>{p.stage === 'completed' ? <Link className="text-link" href={`/goods-purchases/${p.id}`}>{n.text}</Link> : <span className={n?.act ? 'gp-next act' : 'gp-next'}>{n?.text ?? '—'}</span>}</td>
        </tr>; })}</tbody>
      </table></div>
      <div className="gp-cards-list gp-mobile-only">{rows.map((p) => { const n = NEXT_STEP[p.stage]; return <Link key={p.id} href={`/goods-purchases/${p.id}`} className={`gp-mcard ${isMine(p) ? 'mark' : ''}`} data-testid={`card-goods-purchase-${p.id}`}>
        <div className="gp-mcard-top"><strong>{p.customerName}</strong><span className="mono">#{p.id.toLocaleString('fa-IR')}</span></div>
        <div className="gp-mcard-mid"><span className="gp-money">{toman(p.creditAmountToman)}</span><span className={`gp-chip ${p.stage === 'completed' ? 'green' : n?.act ? 'gold' : 'blue'}`}><i />{stageLabel(p.stage)} · {(stageIndex(p.stage) + 1).toLocaleString('fa-IR')}/{STAGES.length.toLocaleString('fa-IR')}</span></div>
        <span className={n?.act ? 'gp-next act' : 'gp-next'}>قدم بعد: {n?.text ?? '—'}</span>
      </Link>; })}</div>
    </>}
    <details className="panel gp-fold"><summary>پیشنهادهای شروع خرید</summary><RegistrationSuggestions kind="goods" onSelect={row => { setSuggested(row); setCreating(true); }} /></details>
    <details className="panel gp-fold"><summary><Wallet size={15} /> کیف پول‌های طرح شرکت</summary><CompanyPlanWallets /></details>
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
  const [step, setStep] = useState(0);
  return <Wizard title="شروع خرید کالا" testId="create-goods-purchase" steps={['انتخاب کیف پول طرح', 'تأیید رزرو']} step={step} onClose={onClose} onBack={step ? () => setStep(0) : undefined}
    next={step === 0 ? { label: 'بعدی', disabled: !selected, onClick: () => setStep(1), testId: 'button-next-purchase' }
      : { label: create.isPending ? 'در حال رزرو…' : `رزرو ${selected ? toman(selected.balanceToman) : ''}`, icon: <ShoppingBag size={15} />, disabled: !selected || create.isPending, onClick: () => selected && create.mutate(selected), testId: 'button-confirm-purchase' }}>
    {step === 0 ? <>
      <p className="secondary-cell" style={{ marginBottom: 10 }}>کل موجودی مثبت کیف پول آن طرح رزرو می‌شود. هر کیف پول فقط یک رزرو فعال دارد.</p>
      <SearchField value={q} onChange={setQ} placeholder="نام، موبایل یا کد ملی مشتری" testId="search-eligible" />
      {eligible.data?.unassignedNotice ? <div className="gp-alert warn">{eligible.data.unassignedNotice}</div> : null}
      <div className="gp-pick-list">
        {eligible.isLoading ? <SkeletonPanel rows={3} /> : eligible.isError ? <div className="gp-alert">{errText(eligible.error)}</div> : !items.length ? <EmptyState title="کیف پول واجد شرایطی نیست" description="فقط مشتریان با موجودی مثبت تفکیک‌شده به طرح نمایش داده می‌شوند." /> :
          items.map((w) => <button type="button" key={`${w.customerId}-${w.planId}`} className={`gp-pick ${selected === w ? 'on' : ''}`} onClick={() => setPicked(w)} data-testid={`pick-wallet-${w.customerId}-${w.planId}`}>
            <Wallet size={18} /><div><strong>{w.customerName}</strong><span>کارشناس فروش فعلی: {w.customerSalespersonName || 'بدون تخصیص'}</span><span>{w.planName}</span></div><b>{toman(w.balanceToman)}</b>
          </button>)}
      </div>
    </> : <>
      <div className="gp-kv gp-review"><span>مشتری</span><b>{selected?.customerName}</b><span>طرح</span><b>{selected?.planName}</b><span>کارشناس فروش</span><b>{selected?.customerSalespersonName || 'بدون تخصیص'}</b><span>مبلغ رزرو</span><b>{toman(selected?.balanceToman)}</b></div>
      <p className="secondary-cell">با رزرو، کل موجودی این کیف پول برای این خرید کنار گذاشته می‌شود.</p>
      {create.isError ? <div className="gp-alert">{errText(create.error)}</div> : null}
    </>}
  </Wizard>;
}
