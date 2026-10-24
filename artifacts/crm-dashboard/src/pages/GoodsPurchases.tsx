import { useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { Check, Lock, Plus, ShoppingBag, Wallet } from 'lucide-react';
import { EmptyState, SearchField } from '@/components/DataTools';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { SectionTabs, Wizard, type ListSection } from '@/components/goods/GpKit';
import { CompanyPlanWallets } from '@/components/PlanWallets';
import { PendingCreate, WaitChip } from '@/components/goods/PendingCreate';
import { forbidden, PENDING_INTRO, pendingAccess, pendingTabCount, usePendingQueue, type PendingRow } from '@/lib/pending-create';
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
  const { can, user } = useMe();
  const manage = can('goods_purchases.manage');
  const pendingMode = pendingAccess('goods', user, can);
  const finance = can('goods_finance.manage');
  const [search, setSearch] = useTableState('goods.search', '');
  const [active, setActive] = useTableState('goods.section', 'pending');
  const [pendingPage, setPendingPage] = useTableState('goods.pendingPage', 1);
  const [creating, setCreating] = useState(false);
  const [suggested, setSuggested] = useState<PendingRow | null>(null);
  const pending = usePendingQueue('goods', '', 1, Boolean(pendingMode));
  const pendingHidden = !pendingMode || forbidden(pending.error);
  const list = useQuery({ queryKey: ['goods-purchases'], queryFn: () => api.get<unknown>('/goods-purchases').then((d) => listOf<Purchase>(d)), refetchInterval: 30_000 });
  const normalizedSearch = normalizePersianSearchText(search.trim());
  const all = list.data ?? [];
  const isMine = (p: Purchase) => { const n = NEXT_STEP[p.stage]; return Boolean(n?.act && manage && (!n.finance || finance)); };
  const matches = (p: Purchase, f: GoodsFilter) => (!f.stage || p.stage === f.stage) && (!f.mine || isMine(p));
  const sections: ListSection<GoodsFilter>[] = [
    { key: 'pending', label: '＋ در انتظار ایجاد', testId: 'goods-pending', count: pendingTabCount(pending.data), hidden: pendingHidden, kind: 'custom',
      render: () => <PendingCreate kind="goods" search={search} page={pendingPage} onPage={setPendingPage} onCreate={(row) => { setSuggested(row); setCreating(true); }} onShowAll={() => setActive('all')} /> },
    { key: 'all', label: 'همه‌ی خریدها', testId: 'goods-all', count: all.length, kind: 'list', params: {} },
    { key: 'mine', label: 'کار با ماست', testId: 'goods-mine', tone: 'gold', count: all.filter(isMine).length, kind: 'list', params: { mine: true }, hidden: !manage || pendingMode === 'view' },
    ...STAGES.map((s) => ({ key: s.key, label: s.label, testId: `goods-${s.key}`, count: all.filter((p) => p.stage === s.key).length, kind: 'list' as const, params: { stage: s.key } })),
  ];
  const section = sections.find((s) => s.key === active && !s.hidden) ?? sections.find((s) => s.key === 'all')!;
  const rows = section.kind === 'list' ? all.filter((p) => matches(p, section.params) && normalizePersianSearchText(`${p.customerName} ${p.planName} ${p.id}`).includes(normalizedSearch)) : [];
  return <section className="data-page gp-page">
    <div className="page-intro gp-intro">
      <div><div className="eyebrow">خرید کالا</div><h2>خریدهای کالا</h2><p>{section.key === 'pending' ? PENDING_INTRO.goods[pending.data && !pending.data.canCreate ? 'view' : 'create'] : 'از رزرو اعتبار تا امضای فاکتور، تسویه و دستور پرداخت.'}</p></div>
      <div className="gp-intro-tools">
        <SearchField value={search} onChange={(v) => { setSearch(v); setPendingPage(1); }} placeholder={section.key === 'pending' ? 'نام، موبایل یا شماره پرونده' : 'مشتری، طرح یا شماره'} testId="search-goods-purchases" />
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
    <details className="panel gp-fold"><summary><Wallet size={15} /> کیف پول‌های طرح شرکت</summary><CompanyPlanWallets /></details>
    {creating ? <CreatePurchase initial={suggested} onClose={() => setCreating(false)} /> : null}
  </section>;
}

function CreatePurchase({ onClose, initial }: { onClose: () => void; initial: PendingRow | null }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  // Opened from «در انتظار ایجاد»: step 1 is prefilled from the case; «مشتری دیگری انتخاب کن» falls back to search.
  const [prefilled, setPrefilled] = useState(Boolean(initial));
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<EligibleWallet | null>(null);
  const eligible = useQuery({ queryKey: ['goods-eligible', q], queryFn: () => api.get<{ items: EligibleWallet[]; unassignedNotice?: string }>(`/goods-purchases/eligible?q=${encodeURIComponent(q.trim())}`), staleTime: 0, refetchInterval: 30_000, enabled: !prefilled });
  const create = useMutation({
    mutationFn: (w: EligibleWallet) => api.post<Purchase>('/goods-purchases', { customerId: w.customerId, planId: w.planId }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['goods-purchases'] }); qc.invalidateQueries({ queryKey: ['goods-eligible'] }); qc.invalidateQueries({ queryKey: ['registration-suggestions', 'goods'] }); qc.invalidateQueries({ queryKey: ['pending-create-counts'] }); onClose(); go(`/goods-purchases/${p.id}`); },
  });
  const items = listOf<EligibleWallet>(eligible.data);
  const fromQueue: EligibleWallet | null = prefilled && initial && initial.planId ? { customerId: initial.customerId, customerName: initial.customerName, customerSalespersonName: initial.customerSalespersonName, planId: initial.planId, planName: initial.planName, balanceToman: initial.balanceToman ?? '0' } : null;
  const selected = fromQueue ?? items.find(w => w.customerId === picked?.customerId && w.planId === picked?.planId) ?? null;
  const [step, setStep] = useState(0);
  return <Wizard title="شروع خرید کالا" testId="create-goods-purchase" steps={[fromQueue ? 'مشتری و طرح' : 'انتخاب کیف پول طرح', 'تأیید رزرو']} step={step} onClose={onClose} onBack={step ? () => setStep(0) : undefined}
    next={step === 0 ? { label: 'بعدی', disabled: !selected, onClick: () => setStep(1), testId: 'button-next-purchase' }
      : { label: create.isPending ? 'در حال رزرو…' : `رزرو ${selected ? toman(selected.balanceToman) : ''}`, icon: <ShoppingBag size={15} />, disabled: !selected || create.isPending, onClick: () => selected && create.mutate(selected), testId: 'button-confirm-purchase' }}>
    {step === 0 && fromQueue && initial ? <>
      <span className="gp-prefill-tag" data-testid="tag-prefilled"><Check size={13} />از «در انتظار ایجاد» پر شد</span>
      <div className="gp-prefill-card" data-testid="card-prefilled-goods">
        <div className="gp-prefill-head"><strong>{initial.customerName}</strong><WaitChip days={initial.waitingDays} /></div>
        <div className="gp-kv"><span>پرونده</span><b className="mono">#{(initial.applicationId ?? 0).toLocaleString('fa-IR')}</b><span>کارشناس</span><b>{initial.customerSalespersonName || 'بدون کارشناس'}</b><span>طرح</span><b>{initial.planName}</b></div>
        <div className="gp-prefill-total"><span>موجودی کیف پول طرح</span><b>{toman(fromQueue.balanceToman)}</b></div>
      </div>
      <p className="gp-prefill-note"><Lock size={13} />مشتری و طرح از روی پرونده آمده‌اند. اگر اشتباه است، <button type="button" className="text-link gp-linkbtn" onClick={() => { setPrefilled(false); setQ(initial.phone || initial.customerName); }} data-testid="button-pick-other-customer">مشتری دیگری انتخاب کن</button>.</p>
    </> : step === 0 ? <>
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
