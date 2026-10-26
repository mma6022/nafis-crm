import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { documentFileAccept, supportedDocumentFile } from '@/lib/document-upload-type';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import { ArrowRight, BadgeCheck, Lock, Plus, CalendarDays, Check, CircleAlert, Clock3, CreditCard, Database, Download, FileText, Filter, History as HistoryIcon, Landmark, Percent, RefreshCw, RotateCcw, ShieldCheck, Undo2, Upload, X } from 'lucide-react';
import { EmptyState, Pagination, SearchField } from '@/components/DataTools';
import { PendingCreate, WaitChip } from '@/components/goods/PendingCreate';
import { forbidden, PENDING_INTRO, pendingAccess, pendingTabCount, usePendingQueue, type PendingRow } from '@/lib/pending-create';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { ConfirmDialog, SectionTabs, Stepper, Toast, Wizard, type ListSection } from '@/components/goods/GpKit';
import { KIND_LABELS } from '@/features/team-commission/api';
import { parseJalaliValue, jalaliToIso } from '@/lib/jalali';
import { usePaymentOrderCount, usePaymentOrderList, type PoListParams } from '@/lib/payment-order-queries';
import { CustomerIdBadge, CustomerName, customerNameText } from '@/components/customer/CustomerName';
import '@/features/gl/ledger.css';
import {
  api, ApiError, digitsOnly, errText, faPercent, listOf, monthLabel, openAuthedFile, percentOf, poEventLabel, poStageLabel, PO_STAGES, shortFaDate,
  tehranJalaliValue, tehranTimeNow, toBig, toman, useMe, type BankAccount, type OrderCommission, type PaymentOrder, type PreOpening,
} from '@/lib/goods-api';

const absBig = (v?: string | null) => { const b = toBig(v); return b < 0n ? -b : b; };
const canAdmin = (can: (p: string) => boolean) => can('payment_orders.admin_approve');
const invalidateOrders = (qc: ReturnType<typeof useQueryClient>, id?: number) => {
  qc.invalidateQueries({ queryKey: ['payment-orders'] });
  if (id) qc.invalidateQueries({ queryKey: ['payment-order', id] });
};

export default function PaymentOrders() {
  const params = useParams<{ id?: string }>();
  return params.id ? <OrderDetail id={Number(params.id)} /> : <OrderList />;
}

// ---------------------------------------------------------------- list
function OrderList() {
  const { can, user } = useMe();
  const canPay = can('payment_orders.pay');
  const pendingMode = pendingAccess('payments', user, can);
  const [active, setActive] = useTableState('payments.section', 'pending');
  const [pendingPage, setPendingPage] = useTableState('payments.pendingPage', 1);
  const [creating, setCreating] = useState<PendingRow | null>(null);
  const pending = usePendingQueue('payments', '', 1, Boolean(pendingMode));
  const pendingHidden = !pendingMode || forbidden(pending.error);
  const [search, setSearch] = useTableState('payments.search', '');
  const [page, setPage] = useTableState('payments.page', 1);
  const [paying, setPaying] = useState<PaymentOrder | null>(null);
  const [toast, setToast] = useState('');
  const awaiting = usePaymentOrderCount({ stage: 'awaiting_payment' });
  const sections: ListSection<PoListParams>[] = [
    { key: 'pending', label: '＋ در انتظار ایجاد', testId: 'po-pending', count: pendingTabCount(pending.data), hidden: pendingHidden, kind: 'custom',
      render: () => <PendingCreate kind="payments" search={search} page={pendingPage} onPage={setPendingPage} onCreate={setCreating} onShowAll={() => pick('all')} /> },
    { key: 'awaiting', label: 'در انتظار علامت پرداخت', testId: 'po-awaiting', tone: 'gold', count: awaiting.data ?? null, kind: 'list', params: { stage: 'awaiting_payment' } },
    { key: 'all', label: 'همه‌ی دستورها', testId: 'po-all', kind: 'list', params: {} },
    { key: 'mine', label: 'کارتابل من', testId: 'po-mine', kind: 'list', params: { mine: true } },
    { key: 'sales_approval', label: poStageLabel('sales_approval'), testId: 'po-sales', kind: 'list', params: { stage: 'sales_approval' } },
    { key: 'admin_approval', label: poStageLabel('admin_approval'), testId: 'po-admin', kind: 'list', params: { stage: 'admin_approval' } },
    { key: 'paid', label: poStageLabel('paid'), testId: 'po-paid', kind: 'list', params: { stage: 'paid' } },
  ];
  const section = sections.find((s) => s.key === active && !s.hidden) ?? sections.find((s) => s.key === 'all')!;
  const listParams = section.kind === 'list' ? section.params : {};
  const q = usePaymentOrderList(listParams, search, page, section.kind === 'list');
  const pick = (k: string) => { setActive(k); setPage(1); };
  const rows = listOf<PaymentOrder>(q.data);
  const limit = q.data?.limit ?? 25;
  const needsMark = (o: PaymentOrder) => o.stage === 'awaiting_payment';
  const count = awaiting.data ?? 0;
  return <section className="data-page gp-page">
    <div className="page-intro gp-intro">
      <div><div className="eyebrow">مالی و پرداخت</div><h2>دستورهای پرداخت</h2><p>{section.key === 'pending' ? PENDING_INTRO.payments[pending.data && !pending.data.canCreate ? 'view' : 'create'] : 'فروش تأیید می‌کند ← مدیریت تأیید می‌کند ← حسابداری واریز و «پرداخت‌شده» را ثبت می‌کند.'}</p></div>
      <SearchField value={search} onChange={(v) => { setSearch(v); setPage(1); setPendingPage(1); }} placeholder={section.key === 'pending' ? 'جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴) یا شماره خرید' : 'جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴) یا شماره دستور'} testId="search-payment-orders" />
    </div>
    {canPay && count > 0 && section.key !== 'awaiting' && section.key !== 'pending' ? <div className="gp-banner" data-testid="banner-awaiting-mark">
      <span className="gp-banner-icon"><BadgeCheck size={20} /></span>
      <div><strong>{count.toLocaleString('fa-IR')} دستور تأییدشده هنوز «پرداخت‌شده» نخورده</strong><p>پورسانت این پرونده‌ها فقط بعد از علامت «پرداخت‌شده» ثبت می‌شود.</p></div>
      <button type="button" className="btn gp-btn-gold-ghost" onClick={() => pick('awaiting')} data-testid="button-only-awaiting"><Filter size={15} />فقط همین‌ها را نشان بده</button>
    </div> : null}
    <SectionTabs sections={sections} active={section.key} onPick={pick} label="بخش‌های دستور پرداخت" />
    {section.kind === 'custom' ? section.render() : q.isLoading ? <SkeletonPanel rows={5} /> : q.isError ? <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div> : !rows.length ? <div className="panel"><EmptyState title="دستوری در این بخش نیست" description="دستور پرداخت پس از تکمیل خرید کالا ایجاد می‌شود." /></div> : <>
      <div className="panel table-wrap gp-desktop-only"><table className="data-table gp-table">
        <thead><tr><th>دستور</th><th>مشتری</th><th>مبلغ واریزی</th><th>مرحله</th><th>آخرین تغییر</th><th /></tr></thead>
        <tbody>{rows.map((o) => <tr key={o.id} className={needsMark(o) ? 'gp-row-mark' : ''} data-testid={`row-payment-order-${o.id}`}>
          <td className="mono">#{o.id.toLocaleString('fa-IR')}</td>
          <td><span className="primary-cell"><CustomerName id={o.customerId} name={o.customerName ?? '—'} badgeTestId={`badge-order-customer-id-${o.id}`} /></span><span className="secondary-cell gp-sub">خرید #{o.purchaseId.toLocaleString('fa-IR')} · {o.customerSalespersonName || 'بدون کارشناس'}</span></td>
          <td className="gp-money">{toman(o.amountToman)}</td>
          <td><StageChip stage={o.stage} />{o.preOpening ? <> <PreOpeningBadge id={o.id} /></> : null}</td>
          <td className="secondary-cell">{shortFaDate(o.updatedAt ?? o.createdAt)}</td>
          <td><div className="gp-row-actions">
            {needsMark(o) && canPay ? <button type="button" className="btn gp-btn-green sm" onClick={() => setPaying(o)} data-testid={`button-mark-paid-${o.id}`}><Check size={15} />علامت پرداخت‌شده</button> : null}
            <Link className="btn btn-ghost sm" href={`/payment-orders/${o.id}`} data-testid={`link-payment-order-${o.id}`}>جزئیات</Link>
          </div></td>
        </tr>)}</tbody>
      </table></div>
      <div className="gp-cards-list gp-mobile-only">{rows.map((o) => <div key={o.id} className={`gp-mcard ${needsMark(o) ? 'mark' : ''}`} data-testid={`card-payment-order-${o.id}`}>
        <div className="gp-mcard-top"><Link href={`/payment-orders/${o.id}`}><strong>{o.customerName ?? '—'}</strong></Link> <CustomerIdBadge id={o.customerId} /><span className="mono">#{o.id.toLocaleString('fa-IR')}</span></div>
        <div className="gp-mcard-mid"><span className="gp-money">{toman(o.amountToman)}</span><StageChip stage={o.stage} />{o.preOpening ? <PreOpeningBadge id={o.id} /> : null}</div>
        <span className="secondary-cell">خرید #{o.purchaseId.toLocaleString('fa-IR')} · {shortFaDate(o.updatedAt ?? o.createdAt)}</span>
        <div className="gp-mcard-actions">
          {needsMark(o) && canPay ? <button type="button" className="btn gp-btn-green" onClick={() => setPaying(o)} data-testid={`button-mark-paid-m-${o.id}`}><Check size={15} />علامت پرداخت‌شده</button> : null}
          <Link className="btn btn-ghost" href={`/payment-orders/${o.id}`}>جزئیات</Link>
        </div>
      </div>)}</div>
      {(q.data?.total ?? 0) > limit ? <Pagination total={q.data?.total ?? 0} offset={(page - 1) * limit} limit={limit} onChange={(o) => setPage(Math.floor(o / limit) + 1)} testId="pagination-payment-orders" /> : null}
    </>}
    {creating ? <CreateOrderWizard row={creating} onClose={() => setCreating(null)} /> : null}
    {paying ? <PayLoader id={paying.id} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setToast(`«پرداخت‌شده» برای دستور #${paying.id.toLocaleString('fa-IR')} ثبت شد`); }} /> : null}
    {toast ? <Toast text={toast} onDone={() => setToast('')} /> : null}
  </section>;
}

/** «ایجاد دستور پرداخت» from «در انتظار ایجاد»: step 1 reviews the purchase (amount locked by settlement), step 2 creates. */
function CreateOrderWizard({ row, onClose }: { row: PendingRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const [step, setStep] = useState(0);
  const create = useMutation({
    mutationFn: () => api.post<PaymentOrder>('/payment-orders', { purchaseId: row.purchaseId }),
    onSuccess: (o) => { invalidateOrders(qc, o.id); qc.invalidateQueries({ queryKey: ['registration-suggestions', 'payments'] }); qc.invalidateQueries({ queryKey: ['pending-create-counts'] }); onClose(); go(`/payment-orders/${o.id}`); },
  });
  const summary = <div className="gp-prefill-card" data-testid="card-prefilled-payment">
    <div className="gp-prefill-head"><strong><CustomerName id={row.customerId} name={row.customerName} /></strong><WaitChip days={row.waitingDays} /></div>
    <div className="gp-kv"><span>خرید کالا</span><b className="mono">#{(row.purchaseId ?? 0).toLocaleString('fa-IR')}</b><span>کارشناس</span><b>{row.customerSalespersonName || 'بدون کارشناس'}</b><span>طرح</span><b>{row.planName}</b><span>تکمیل خرید</span><b>{shortFaDate(row.completedAt)}</b></div>
    <div className="gp-prefill-total"><span>مبلغ واریزی (از تسویه)</span><b>{toman(row.amountToman)}</b></div>
  </div>;
  return <Wizard title="ایجاد دستور پرداخت" testId="create-payment-order" steps={['بازبینی خرید و مبلغ', 'ایجاد دستور']} step={step} onClose={onClose} onBack={step ? () => setStep(0) : undefined}
    next={step === 0 ? { label: 'بعدی', onClick: () => setStep(1), testId: 'button-next-payment-order' }
      : { label: create.isPending ? 'در حال ایجاد…' : 'ایجاد دستور پرداخت', icon: <Plus size={15} />, disabled: create.isPending, onClick: () => create.mutate(), testId: 'button-confirm-payment-order' }}>
    {step === 0 ? <>
      <span className="gp-prefill-tag" data-testid="tag-prefilled"><Check size={13} />از «در انتظار ایجاد» پر شد</span>
      {summary}
      <p className="gp-prefill-note"><Lock size={13} />مبلغ در تسویه قفل شده و اینجا عوض نمی‌شود.</p>
    </> : <>
      <div className="gp-kv gp-review"><span>مشتری</span><b><CustomerName id={row.customerId} name={row.customerName} /></b><span>خرید کالا</span><b>#{(row.purchaseId ?? 0).toLocaleString('fa-IR')}</b><span>مبلغ واریزی</span><b>{toman(row.amountToman)}</b></div>
      <p className="secondary-cell">دستور در مرحله‌ی «{poStageLabel('sales_approval')}» ساخته می‌شود و بعد از تأیید فروش و مدیریت، به حسابداری می‌رسد.</p>
      {create.isError ? <div className="gp-alert">{errText(create.error)}</div> : null}
    </>}
  </Wizard>;
}

function StageChip({ stage }: { stage: string }) {
  const tone = stage === 'paid' ? 'green' : stage === 'awaiting_payment' ? 'gold' : 'blue';
  return <span className={`gp-chip ${tone}`}><i />{poStageLabel(stage)}</span>;
}

/** From the list the row has no details (principal, destination), so the wizard loads the order first. */
function PayLoader({ id, onClose, onPaid }: { id: number; onClose: () => void; onPaid: () => void }) {
  const q = useQuery({ queryKey: ['payment-order', id], queryFn: () => api.get<PaymentOrder>(`/payment-orders/${id}`) });
  if (!q.data) return q.isError ? <ConfirmDialog title="علامت پرداخت‌شده" testId="pay-load-error" confirmLabel="بستن" error={errText(q.error)} onConfirm={onClose} onClose={onClose} /> : null;
  return <PayWizard order={q.data} onClose={onClose} onPaid={onPaid} />;
}

// ---------------------------------------------------------------- detail
function OrderDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const { can, isAdmin } = useMe();
  const q = useQuery({ queryKey: ['payment-order', id], queryFn: () => api.get<PaymentOrder>(`/payment-orders/${id}`), refetchInterval: 20_000 });
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<'' | 'pay' | 'sales' | 'admin' | 'unpay' | 'return'>('');
  const done = (text: string) => { setDialog(''); setToast(text); invalidateOrders(qc, id); qc.invalidateQueries({ queryKey: ['goods-purchase'] }); };
  if (q.isLoading) return <SkeletonPanel rows={6} />;
  if (q.isError || !q.data) return <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div>;
  const o = q.data;
  const idx = Math.max(0, PO_STAGES.findIndex((s) => s.key === o.stage));
  const dest = o.destinationIban ? `${o.destinationOwnerName ?? ''} ${o.destinationIban}`.trim() : '—';
  const pre = o.preOpening && typeof o.preOpening === 'object' ? o.preOpening : null;
  return <section className="data-page gp-page">
    <Link href="/payment-orders" className="text-link gp-back"><ArrowRight size={14} />بازگشت به دستورهای پرداخت</Link>
    <div className="gp-hero2" data-testid="po-hero">
      <div className="gp-hero2-main">
        <div className="eyebrow">دستور پرداخت #{o.id.toLocaleString('fa-IR')} · خرید کالا <Link href={`/goods-purchases/${o.purchaseId}`}>#{o.purchaseId.toLocaleString('fa-IR')}</Link></div>
        <h2><CustomerName id={o.customerId} name={o.customerName ?? 'مشتری'} /></h2>
        <p>کارشناس فروش: {o.customerSalespersonName || 'بدون تخصیص'}{o.planName ? ` · ${o.planName}` : ''}</p>
      </div>
      <div className="gp-hero2-amount"><span>مبلغ واریزی به مشتری</span><strong>{toBig(o.amountToman).toLocaleString('fa-IR')} <small>تومان</small></strong><em className={`gp-chip ${o.stage === 'paid' ? 'green' : 'light'}`}><i />{poStageLabel(o.stage)}</em>{pre ? <PreOpeningBadge id={o.id} /> : null}</div>
    </div>
    <Stepper steps={PO_STAGES.map((s) => s.step)} current={idx} done={o.stage === 'paid'} testId="po-stepper" />
    <div className="gp-detail2">
      <div className="gp-main-col">
        {pre ? <PreOpeningCard order={o} pre={pre} /> : null}
        {!pre && o.stage === 'sales_approval' ? (can('payment_orders.sales_approve')
          ? <ActionCard icon={<CreditCard size={18} />} title="تأیید فروش و حساب مقصد" text="حساب تأییدشدهٔ مشتری را انتخاب کن تا دستور به تأیید مدیر برود." button={<button className="btn btn-primary gp-big" onClick={() => setDialog('sales')} data-testid="button-start-sales-approve">شروع تأیید فروش</button>} />
          : <Waiting text="منتظر تأیید کارشناس فروش" />) : null}
        {!pre && o.stage === 'admin_approval' ? (canAdmin(can)
          ? <ActionCard icon={<ShieldCheck size={18} />} title="تأیید مدیریت" text={<>حساب مقصد: <span dir="ltr" className="mono">{dest}</span></>} button={<button className="btn btn-primary gp-big" onClick={() => setDialog('admin')} data-testid="button-admin-approve">تأیید پرداخت</button>} />
          : <Waiting text="منتظر تأیید مدیر" />) : null}
        {!pre && o.stage === 'awaiting_payment' ? (can('payment_orders.pay')
          ? <ActionCard tone="green" icon={<BadgeCheck size={18} />} title="پول به حساب مشتری واریز شد؟" text={<>واریز {toman(o.amountToman)} به <span dir="ltr" className="mono">{dest}</span></>}
            button={<button className="btn gp-btn-green gp-big" onClick={() => setDialog('pay')} data-testid="button-open-pay"><Check size={18} />علامت پرداخت‌شده</button>}
            foot={<><Database size={14} /> با این علامت، پورسانت این پرونده ثبت می‌شود.</>} />
          : <Waiting text="منتظر علامت «پرداخت‌شده» از حسابداری" />) : null}
        {!pre && o.stage === 'paid' ? <PaidCard order={o} dest={dest} onUnpay={o.canUnpay ? () => setDialog('unpay') : undefined} /> : null}
        {o.commission ? <CommissionCard order={o} c={o.commission} isAdmin={isAdmin} onReturn={() => setDialog('return')} onRetried={(t) => done(t)} /> : null}
        <AmountCard order={o} />
        <div className="panel gp-card"><h3><Landmark size={16} /> حساب مقصد</h3>{o.destinationIban ? <div className="gp-kv"><span>صاحب حساب</span><b>{o.destinationOwnerName ?? '—'}</b><span>شبا</span><b dir="ltr" className="mono">{o.destinationIban}</b></div> : <p className="secondary-cell">هنوز در تأیید فروش انتخاب نشده.</p>}</div>
      </div>
      <History order={o} />
    </div>
    {dialog === 'pay' ? <PayWizard order={o} onClose={() => setDialog('')} onPaid={() => done('«پرداخت‌شده» ثبت شد · پورسانت با همین تاریخ ثبت می‌شود')} /> : null}
    {dialog === 'sales' ? <SalesApproveWizard order={o} onClose={() => setDialog('')} onDone={() => done('تأیید فروش ثبت شد و دستور به تأیید مدیر رفت.')} /> : null}
    {dialog === 'admin' ? <AdminApproveDialog order={o} dest={dest} onClose={() => setDialog('')} onDone={() => done('تأیید مدیریت ثبت شد.')} /> : null}
    {dialog === 'unpay' ? <UnpayDialog order={o} onClose={() => setDialog('')} onDone={() => done('«پرداخت‌شده» برگشت؛ دستور دوباره در انتظار علامت پرداخت است.')} /> : null}
    {dialog === 'return' && o.commission ? <ReturnCaseDialog order={o} c={o.commission} onClose={() => setDialog('')} onDone={() => done('برگشت پرونده ثبت شد؛ کسر در ماه بعد اعمال می‌شود.')} /> : null}
    {toast ? <Toast text={toast} onDone={() => setToast('')} /> : null}
  </section>;
}

/** G5 (scene 726 po_pre_dr): paid before the GL start; part of the 2101 opening balance, so it has no GL voucher and no unpay. */
function PreOpeningBadge({ id }: { id: number }) {
  return <span className="gl-pre-badge" data-testid={`badge-pre-opening-${id}`}><Lock size={12} />در ماندهٔ افتتاحیه</span>;
}
function PreOpeningCard({ order: o, pre }: { order: PaymentOrder; pre: PreOpening }) {
  const [err, setErr] = useState('');
  return <div className="panel gp-card" data-testid="po-pre-opening-card">
    <h3><Lock size={16} /> پرداخت‌شده پیش از شروع دفتر کل</h3>
    <div className="gp-kv">
      <span>مشتری</span><b>{o.customerName ?? '—'}</b>
      <span>مبلغ</span><b>{toman(o.amountToman)}</b>
      <span>ثبت دستور</span><b>{shortFaDate(o.createdAt)}</b>
      <span>واریز (تهران)</span><b>{shortFaDate(pre.paidDate)}</b>
      <span>کد پیگیری</span><b dir="ltr" className="mono">{pre.trackingNo || '—'}</b>
      <span>رسید</span><b>{pre.receiptFilename ? <button type="button" className="text-link" onClick={() => openAuthedFile(`/payment-orders/${o.id}/receipt`).catch((e) => setErr(errText(e)))} data-testid="button-pre-opening-receipt">{pre.receiptFilename}</button> : '—'}</b>
      <span>سند دفتر کل</span><b>ندارد</b>
    </div>
    {err ? <div className="gp-alert">{err}</div> : null}
    <div className="gp-alert warn">این دستور تا پایان تاریخ مبنای موجودی اولیه پرداخت شده و در ماندهٔ افتتاحیهٔ ۲۱۰۱ لحاظ شده است؛ برای همین سند پرداخت جدا ندارد.</div>
    <p className="secondary-cell">«لغو پرداخت‌شده» برای این دستور نیست؛ اصلاح فقط از راه بازبینی موجودی اولیه.</p>
  </div>;
}

function ActionCard({ icon, title, text, button, foot, tone }: { icon: ReactNode; title: string; text: ReactNode; button: ReactNode; foot?: ReactNode; tone?: 'green' }) {
  return <div className={`panel gp-action ${tone ?? ''}`} data-testid="po-action-card">
    <h3>{icon}{title}</h3><p>{text}</p>{button}{foot ? <small className="gp-action-foot">{foot}</small> : null}
  </div>;
}
function Waiting({ text }: { text: string }) { return <div className="panel gp-card gp-waiting"><Clock3 size={16} /><span>{text}</span></div>; }

function AmountCard({ order: o }: { order: PaymentOrder }) {
  const pct = percentOf(o.amountToman, o.principalAmountToman);
  const def = o.planPayoutBps != null ? o.planPayoutBps / 100 : null;
  return <div className="panel gp-card" data-testid="po-amount-card"><h3><Percent size={16} /> مبلغ واریزی</h3>
    <div className="gp-kv">
      <span>اصل تسهیلات</span><b>{o.principalAmountToman ? toman(o.principalAmountToman) : '—'}</b>
      <span>درصد واریزی این پرونده</span><b>{faPercent(pct)}{def !== null ? <small className="secondary-cell"> (پیش‌فرض طرح {faPercent(def)})</small> : null}</b>
      {o.feeDiscountToman && toBig(o.feeDiscountToman) !== 0n ? <><span>تغییر نسبت به پیش‌فرض</span><b dir="auto">{toBig(o.feeDiscountToman) > 0n ? '+' : '−'}{toman(absBig(o.feeDiscountToman).toString())}</b></> : null}
    </div>
    <div className="gp-total"><span>مبلغ واریزی به مشتری</span><strong>{toman(o.amountToman)}</strong></div>
  </div>;
}

const useSources = () => useQuery({ queryKey: ['bank-accounts'], queryFn: () => api.get<unknown>('/bank-accounts').then((d) => listOf<BankAccount>(d)) });
const sourceName = (a?: BankAccount) => (a ? `${a.bankName ?? 'بانک'} · ${a.fundName || a.ownerName || ''}` : '—');

function PaidCard({ order: o, dest, onUnpay }: { order: PaymentOrder; dest: string; onUnpay?: () => void }) {
  const sources = useSources();
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  return <div className="panel gp-card gp-paid" data-testid="po-paid-card">
    <h3><BadgeCheck size={16} /> پرداخت‌شده · {shortFaDate(o.paidAt, true)}</h3>
    <div className="gp-kv">
      <span>کد پیگیری</span><b dir="ltr" className="mono">{o.trackingNumber}</b>
      <span>از حساب</span><b>{sourceName(sources.data?.find((a) => a.id === o.sourceBankAccountId))}</b>
      <span>به حساب</span><b dir="ltr" className="mono">{dest}</b>
    </div>
    <div className="gp-btn-row">
      <button className="btn btn-ghost" onClick={() => openAuthedFile(`/payment-orders/${o.id}/receipt`).catch((e) => setErr(errText(e)))} data-testid="button-download-receipt"><Download size={15} />دریافت رسید</button>
      <button className="btn btn-ghost" onClick={() => setShow(!show)} data-testid="button-toggle-receipt"><FileText size={15} />{show ? 'بستن پیش‌نمایش' : 'پیش‌نمایش رسید'}</button>
    </div>
    {err ? <div className="gp-alert">{err}</div> : null}
    {show ? <ReceiptPreview orderId={o.id} /> : null}
    {onUnpay ? <button className="btn gp-btn-danger-ghost gp-wide" onClick={onUnpay} data-testid="button-unpay"><Undo2 size={15} />برگرداندن «پرداخت‌شده» (ثبت اشتباه)</button> : null}
  </div>;
}

const COMMISSION_STATUS: Record<OrderCommission['status'], { label: string; tone: string; text: string }> = {
  legacy: { label: 'مدل قبلی', tone: 'blue', text: 'این پرونده با مدل قبلی پورسانت است؛ پورسانت هنگام «تأیید ثبت‌کننده» ثبت شده.' },
  not_posted: { label: 'ثبت نشده', tone: 'muted', text: 'با علامت «پرداخت‌شده» خودکار ثبت می‌شود.' },
  awaiting_payment: { label: 'ثبت نشده', tone: 'muted', text: 'با علامت «پرداخت‌شده» خودکار ثبت می‌شود؛ ماه پورسانت = ماه تاریخ واریز.' },
  posted: { label: 'ثبت شد', tone: 'green', text: '' },
  failed: { label: 'ثبت ناموفق', tone: 'red', text: 'ثبت پورسانت این پرونده خطا خورد.' },
  before_start: { label: 'بدون پورسانت مدل تازه', tone: 'muted', text: 'واریز پیش از شروع مدل تازه (۲ آبان ۱۴۰۵)؛ پورسانت مدل تازه ندارد.' },
  reversed: { label: 'برگشت پرونده', tone: 'red', text: '' },
};

function CommissionCard({ order: o, c, isAdmin, onReturn, onRetried }: { order: PaymentOrder; c: OrderCommission; isAdmin: boolean; onReturn: () => void; onRetried: (t: string) => void }) {
  const st = COMMISSION_STATUS[c.status];
  const retry = useMutation({ mutationFn: () => api.post(`/goods-finance/team-commission/purchases/${o.purchaseId}/post`), onSuccess: () => onRetried('ثبت دوبارهٔ پورسانت انجام شد.') });
  const label = c.status === 'posted' && c.month ? `${st.label} · ${monthLabel(c.month)}` : c.status === 'reversed' && c.reversalMonth ? `${st.label} · کسر در ${monthLabel(c.reversalMonth)}` : st.label;
  return <div className="panel gp-card" data-testid="po-commission-card">
    <div className="gp-card-head"><h3><Database size={16} /> پورسانت این پرونده</h3><span className={`gp-chip ${st.tone}`} data-testid="commission-status"><i />{label}</span></div>
    {st.text ? <p className="secondary-cell">{st.text}</p> : null}
    {c.scope === 'status' ? <p className="secondary-cell">جزئیات مبالغ فقط برای کارشناس همین پرونده و مدیر نمایش داده می‌شود.</p> : null}
    {c.rows.length ? <ul className="gp-comm-rows">{c.rows.map((r) => <li key={r.id} className={r.neutralized ? 'neutralized' : ''} data-testid={`commission-row-${r.id}`}>
      <div><strong>{KIND_LABELS[r.kind] ?? r.kind}</strong><span className="secondary-cell">{r.salespersonName ? `${r.salespersonName} · ` : ''}{monthLabel(r.month)}{r.neutralized ? ' · خنثی شد' : ''}</span></div>
      <b className={toBig(r.amountToman) < 0n ? 'neg' : 'pos'} dir="ltr">{toBig(r.amountToman) < 0n ? '−' : '+'}{absBig(r.amountToman).toLocaleString('fa-IR')} تومان</b>
    </li>)}</ul> : null}
    {isAdmin && c.lastError ? <div className="gp-alert"><CircleAlert size={14} /> {c.lastError}</div> : null}
    {retry.isError ? <div className="gp-alert">{errText(retry.error)}</div> : null}
    <div className="gp-btn-col">
      {c.canRetry ? <button className="btn btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()} data-testid="button-retry-commission"><RefreshCw size={15} />{retry.isPending ? 'در حال ثبت…' : 'ثبت دوبارهٔ پورسانت'}</button> : null}
      {c.canReturnCase ? <button className="btn gp-btn-danger-ghost" onClick={onReturn} data-testid="button-return-case"><RotateCcw size={15} />ثبت برگشت پرونده</button> : null}
    </div>
  </div>;
}

function History({ order: o }: { order: PaymentOrder }) {
  const events = [...(o.events ?? [])].reverse();
  const detailText = (d?: Record<string, unknown> | null) => {
    if (!d) return null;
    const reason = typeof d.reason === 'string' ? d.reason : null;
    return reason ? `دلیل: ${reason}` : null;
  };
  return <aside className="panel gp-history" data-testid="po-history"><h3><HistoryIcon size={16} /> تاریخچه</h3>
    {events.length ? <ul>{events.map((e, i) => <li key={i} className={e.action === 'payment_recorded' ? 'ok' : e.action === 'payment_reverted' ? 'bad' : ''}>
      <span className="secondary-cell">{e.actorName || 'سیستم'} · {shortFaDate(e.createdAt, true)}</span>
      <strong>{poEventLabel(e.action)}</strong>
      {e.action === 'payment_recorded' && o.trackingNumber && o.stage === 'paid' && i === events.findIndex((x) => x.action === 'payment_recorded') ? <span className="secondary-cell">کد پیگیری <bdi className="mono">{o.trackingNumber}</bdi></span> : null}
      {detailText(e.detail) ? <span className="secondary-cell">{detailText(e.detail)}</span> : null}
    </li>)}</ul> : <p className="secondary-cell">سابقه‌ای ثبت نشده.</p>}
  </aside>;
}

// ---------------------------------------------------------------- pay wizard
type DateChoice = 'today' | 'yesterday' | 'other';
function PayWizard({ order: o, onClose, onPaid }: { order: PaymentOrder; onClose: () => void; onPaid: () => void }) {
  const qc = useQueryClient();
  const sources = useSources();
  const [step, setStep] = useState(0);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [tracking, setTracking] = useState('');
  const [choice, setChoice] = useState<DateChoice>('today');
  const [other, setOther] = useState('');
  const [time, setTime] = useState(tehranTimeNow());
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const today = tehranJalaliValue(0), yesterday = tehranJalaliValue(1);
  const dateValue = choice === 'today' ? today : choice === 'yesterday' ? yesterday : other;
  const paidAt = (() => {
    const d = parseJalaliValue(dateValue); const t = /^(\d{1,2}):(\d{2})$/.exec(time);
    return d && t ? jalaliToIso(d.year, d.month, d.day, Number(t[1]), Number(t[2])) : null;
  })();
  const future = paidAt ? new Date(paidAt).getTime() > Date.now() + 2 * 60_000 : false;
  const source = sources.data?.find((a) => a.id === sourceId);
  const pay = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('sourceBankAccountId', String(sourceId));
      fd.append('trackingNumber', tracking.trim());
      fd.append('paidAt', paidAt!);
      if (file) fd.append('receipt', file);
      return api.upload(`/payment-orders/${o.id}/pay`, fd);
    },
    onSuccess: () => { invalidateOrders(qc, o.id); onPaid(); },
  });
  const pickFile = (f: File | null) => {
    setFileErr('');
    if (!f) return setFile(null);
    if (f.size > 10 * 1024 * 1024) { setFileErr('حجم رسید حداکثر ۱۰ مگابایت است.'); return; }
    if (!supportedDocumentFile(f)) { setFileErr('فقط تصویر یا PDF قابل قبول است.'); return; }
    setFile(f);
  };
  const steps = ['حساب مبدأ و کد پیگیری', 'زمان واریز و رسید', 'تأیید نهایی'];
  const dateLabel = choice === 'today' ? `امروز، ${shortFaDate(new Date().toISOString())}` : choice === 'yesterday' ? 'دیروز' : dateValue;
  const next = step === 0 ? { label: 'بعدی', disabled: !sourceId || !tracking.trim(), onClick: () => setStep(1) }
    : step === 1 ? { label: 'بعدی', disabled: !paidAt || future || !file, onClick: () => setStep(2) }
    : { label: pay.isPending ? 'در حال ثبت…' : 'بله، پرداخت‌شده ثبت شود', tone: 'green' as const, icon: <Check size={16} />, disabled: pay.isPending, onClick: () => pay.mutate(), testId: 'button-pay' };
  return <Wizard title="علامت پرداخت‌شده" testId="pay-wizard" steps={steps} step={step} onClose={onClose} onBack={step ? () => setStep(step - 1) : undefined} next={next}
    summary={<><span>{customerNameText(o.customerName ?? 'مشتری', o.customerId)} · دستور #{o.id.toLocaleString('fa-IR')}</span><b>{toman(o.amountToman)}</b></>}>
    {step === 0 ? <>
      <label className="gp-label">از کدام حساب واریز شد؟</label>
      {sources.isLoading ? <SkeletonPanel rows={2} /> : sources.isError ? <div className="gp-alert">{errText(sources.error)}</div> :
        <div className="gp-pick-list">{(sources.data ?? []).map((a) => <button type="button" key={a.id} className={`gp-pick ${sourceId === a.id ? 'on' : ''}`} onClick={() => setSourceId(a.id)} data-testid={`pick-source-${a.id}`}>
          <Landmark size={18} /><div><strong>{sourceName(a)}</strong><span dir="ltr" className="mono">{a.iban}</span></div>{a.accountingReady === false ? <b className="gp-chip red sm"><i />بدون موجودی اولیه</b> : null}
        </button>)}</div>}
      {source && source.accountingReady === false ? <div className="gp-alert warn" data-testid="alert-opening-balance"><CircleAlert size={14} /> برای این حساب هنوز «موجودی اولیه» در بخش حسابداری ثبت نشده و ثبت «پرداخت‌شده» رد می‌شود. اول مدیر باید در «حسابداری» موجودی اولیهٔ همین صندوق را ثبت کند.</div> : null}
      <label className="gp-label" htmlFor="pay-tracking">کد پیگیری واریز</label>
      <input id="pay-tracking" dir="ltr" value={tracking} maxLength={100} onChange={(e) => setTracking(e.target.value)} data-testid="input-tracking" />
    </> : step === 1 ? <>
      <label className="gp-label">تاریخ واقعی واریز</label>
      <div className="gp-chips" role="radiogroup">
        <button type="button" role="radio" aria-checked={choice === 'today'} className={choice === 'today' ? 'on' : ''} onClick={() => setChoice('today')} data-testid="chip-date-today">امروز، {shortFaDate(new Date().toISOString())}</button>
        <button type="button" role="radio" aria-checked={choice === 'yesterday'} className={choice === 'yesterday' ? 'on' : ''} onClick={() => setChoice('yesterday')} data-testid="chip-date-yesterday">دیروز</button>
        <button type="button" role="radio" aria-checked={choice === 'other'} className={choice === 'other' ? 'on' : ''} onClick={() => setChoice('other')} data-testid="chip-date-other"><CalendarDays size={14} />تاریخ دیگر</button>
      </div>
      {choice === 'other' ? <div style={{ marginTop: 8 }}><PersianDatePicker value={other} onChange={setOther} noFuture testId="input-paid-date" popoverClassName="gp-date-pop" /></div> : null}
      <small className="secondary-cell">پیش‌فرض امروز است؛ اگر واریز روز دیگری بوده، عوضش کن. پورسانت با همین تاریخ ثبت می‌شود.</small>
      <label className="gp-label" htmlFor="pay-time">ساعت واریز</label>
      <input id="pay-time" type="time" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} data-testid="input-paid-time" />
      <small className="secondary-cell">به وقت تهران. زمان آینده قبول نمی‌شود.</small>
      {future ? <div className="gp-alert" role="alert">تاریخ و ساعت واریز نمی‌تواند در آینده باشد.</div> : null}
      <label className="gp-label">رسید واریز</label>
      <input ref={input} type="file" hidden accept={documentFileAccept} onChange={(e) => { pickFile(e.target.files?.[0] ?? null); e.target.value = ''; }} data-testid="input-receipt" />
      {file ? <div className="gp-file on" data-testid="receipt-picked"><FileText size={20} /><div><strong dir="ltr">{file.name}</strong><span>{Math.max(1, Math.round(file.size / 1024)).toLocaleString('fa-IR')} کیلوبایت · آمادهٔ بارگذاری</span></div><button type="button" onClick={() => setFile(null)} aria-label="حذف رسید"><X size={16} /></button></div>
        : <button type="button" className="gp-file" onClick={() => input.current?.click()} data-testid="button-pick-receipt"><Upload size={20} /><div><strong>انتخاب رسید</strong><span>تصویر یا PDF، حداکثر ۱۰ مگابایت</span></div></button>}
      {fileErr ? <div className="gp-alert">{fileErr}</div> : null}
    </> : <>
      <div className="gp-kv gp-review" data-testid="pay-review">
        <span>مبلغ</span><b>{toman(o.amountToman)}</b>
        <span>به حساب</span><b dir="ltr" className="mono">{o.destinationIban ?? '—'}</b>
        <span>از حساب</span><b>{sourceName(source)}</b>
        <span>کد پیگیری</span><b dir="ltr" className="mono">{tracking}</b>
        <span>تاریخ واریز</span><b>{dateLabel} · {time.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])}</b>
        <span>رسید</span><b dir="ltr">{file?.name}</b>
      </div>
      <div className="gp-note"><Database size={14} /> با این علامت، پورسانت این پرونده با تاریخ واریز ثبت می‌شود.</div>
      {pay.isError ? <div className="gp-alert" role="alert">{errText(pay.error)}</div> : null}
    </>}
  </Wizard>;
}

// ---------------------------------------------------------------- approvals / revert dialogs
function SalesApproveWizard({ order, onClose, onDone }: { order: PaymentOrder; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const cid = order.customerId;
  const accountsKey = ['customer-bank-accounts', cid];
  const accounts = useQuery({ queryKey: accountsKey, queryFn: () => api.get<unknown>(`/customers/${cid}/bank-accounts`).then((d) => listOf<BankAccount>(d)), enabled: Boolean(cid) });
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'iban' | 'card'>('iban');
  const [value, setValue] = useState('');
  const verify = useMutation({
    mutationFn: () => api.post<BankAccount>(`/customers/${cid}/bank-accounts/verify`, mode === 'iban' ? { iban: `IR${digitsOnly(value)}` } : { cardNumber: digitsOnly(value) }),
    onSuccess: (a) => { setValue(''); qc.invalidateQueries({ queryKey: accountsKey }); if (a?.id) setSelected(a.id); },
  });
  const approve = useMutation({ mutationFn: () => api.post(`/payment-orders/${order.id}/sales-approve`, { customerBankAccountId: selected }), onSuccess: onDone });
  const verified = (accounts.data ?? []).filter((a) => Boolean(a.verifiedAt));
  const valid = mode === 'iban' ? digitsOnly(value).length === 24 : digitsOnly(value).length === 16;
  const acc = verified.find((a) => a.id === selected);
  return <Wizard title="تأیید فروش" testId="sales-approve" steps={['انتخاب حساب مقصد', 'تأیید و ارسال به مدیر']} step={step} onClose={onClose} onBack={step ? () => setStep(0) : undefined}
    summary={<><span>{customerNameText(order.customerName, order.customerId)} · دستور #{order.id.toLocaleString('fa-IR')}</span><b>{toman(order.amountToman)}</b></>}
    next={step === 0 ? { label: 'بعدی', disabled: !selected, onClick: () => setStep(1) } : { label: approve.isPending ? 'در حال ثبت…' : 'تأیید و ارسال به مدیر', disabled: approve.isPending, onClick: () => approve.mutate(), icon: <Check size={16} />, testId: 'button-sales-approve' }}>
    {step === 0 ? <>
      <p className="secondary-cell">فقط حساب‌هایی که مالکیتشان با کد ملی مشتری استعلام و تأیید شده قابل انتخاب‌اند.</p>
      {!cid ? <div className="gp-alert">شناسه مشتری در دستور پرداخت موجود نیست.</div> : accounts.isLoading ? <SkeletonPanel rows={2} /> : accounts.isError ? <div className="gp-alert">{errText(accounts.error)}</div> :
        verified.length ? <div className="gp-pick-list">{verified.map((a) => <button type="button" key={a.id} className={`gp-pick ${selected === a.id ? 'on' : ''}`} onClick={() => setSelected(a.id)} data-testid={`pick-dest-${a.id}`}><ShieldCheck size={18} /><div><strong>{a.bankName || 'بانک'} · {a.ownerName}</strong><span dir="ltr" className="mono">{a.iban}</span></div></button>)}</div> : <p className="secondary-cell">هنوز حساب تأییدشده‌ای برای این مشتری ثبت نشده است.</p>}
      <div className="gp-verify">
        <div className="filter-tabs"><button type="button" className={`filter-tab ${mode === 'iban' ? 'active' : ''}`} onClick={() => setMode('iban')}>شبا</button><button type="button" className={`filter-tab ${mode === 'card' ? 'active' : ''}`} onClick={() => setMode('card')}>کارت</button></div>
        <input dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'iban' ? '24 رقم بدون IR' : '16 رقم کارت'} data-testid="input-verify-account" />
        <button type="button" className="btn btn-ghost" disabled={!valid || verify.isPending || !cid} onClick={() => verify.mutate()} data-testid="button-verify-account">{verify.isPending ? 'در حال استعلام…' : 'استعلام مالکیت'}</button>
      </div>
      {verify.isError ? <div className="gp-alert">{errText(verify.error)}</div> : null}
      {verify.isSuccess ? <div className="gp-alert ok">حساب {verify.data?.bankName ?? ''} به نام {verify.data?.ownerName ?? ''} تأیید و انتخاب شد.</div> : null}
    </> : <>
      <div className="gp-kv gp-review"><span>حساب مقصد</span><b>{acc?.bankName} · {acc?.ownerName}</b><span>شبا</span><b dir="ltr" className="mono">{acc?.iban}</b><span>مبلغ</span><b>{toman(order.amountToman)}</b></div>
      {approve.isError ? <div className="gp-alert">{errText(approve.error)}</div> : null}
    </>}
  </Wizard>;
}

function AdminApproveDialog({ order, dest, onClose, onDone }: { order: PaymentOrder; dest: string; onClose: () => void; onDone: () => void }) {
  const m = useMutation({ mutationFn: () => api.post(`/payment-orders/${order.id}/admin-approve`), onSuccess: onDone });
  return <ConfirmDialog title="پرداخت تأیید شود؟" testId="admin-approve" confirmLabel="تأیید پرداخت" icon={<Check size={16} />} busy={m.isPending} error={m.isError ? errText(m.error) : null} onConfirm={() => m.mutate()} onClose={onClose}>
    <div className="gp-kv gp-review"><span>مشتری</span><b><CustomerName id={order.customerId} name={order.customerName} /></b><span>مبلغ</span><b>{toman(order.amountToman)}</b><span>حساب مقصد</span><b dir="ltr" className="mono">{dest}</b></div>
    <p className="secondary-cell">پس از تأیید، دستور به حسابداری برای واریز و علامت «پرداخت‌شده» می‌رود.</p>
  </ConfirmDialog>;
}

function UnpayDialog({ order: o, onClose, onDone }: { order: PaymentOrder; onClose: () => void; onDone: () => void }) {
  const m = useMutation({ mutationFn: (reason: string) => api.post(`/payment-orders/${o.id}/unpay`, { reason }), onSuccess: onDone });
  const rows = (o.commission?.rows ?? []).filter((r) => !r.neutralized && toBig(r.amountToman) > 0n && r.kind !== 'paid_mark_reversal' && r.kind !== 'returned_case_deduction');
  return <ConfirmDialog title="«پرداخت‌شده» برگردد؟" testId="unpay" tone="danger" icon={<Undo2 size={16} />} confirmLabel="برگرداندن و ثبت ردیف برگشتی" busy={m.isPending} error={m.isError ? errText(m.error) : null}
    reason={{ label: 'دلیل', min: 5, hint: 'در تاریخچه و ردیف دفتر نوشته می‌شود.' }} onConfirm={(r) => m.mutate(r)} onClose={onClose}>
    <p>فقط برای وقتی که علامت اشتباهی خورده و پولی واریز نشده. دستور به «در انتظار علامت پرداخت» برمی‌گردد و برای پورسانت ثبت‌شده <b>یک ردیف برگشتی در همان ماه</b> در دفتر ثبت می‌شود. چیزی پاک نمی‌شود.</p>
    {rows.length ? <ul className="gp-comm-rows compact">{rows.map((r) => <li key={r.id}><span>{r.salespersonName ? `${r.salespersonName} · ` : ''}{KIND_LABELS[r.kind] ?? r.kind}</span><b className="neg" dir="ltr">−{toBig(r.amountToman).toLocaleString('fa-IR')} تومان</b></li>)}</ul> : null}
  </ConfirmDialog>;
}

function ReturnCaseDialog({ order: o, c, onClose, onDone }: { order: PaymentOrder; c: OrderCommission; onClose: () => void; onDone: () => void }) {
  const m = useMutation({ mutationFn: (reason: string) => api.post(`/goods-finance/team-commission/purchases/${o.purchaseId}/reverse`, { reason }), onSuccess: onDone });
  const rows = c.rows.filter((r) => !r.neutralized && toBig(r.amountToman) > 0n && ['salesperson_commission', 'p1_referral_share'].includes(r.kind));
  return <ConfirmDialog title="ثبت برگشت پرونده" testId="return-case" tone="danger" icon={<RotateCcw size={16} />} confirmLabel="ثبت برگشت پرونده" busy={m.isPending} error={m.isError ? errText(m.error) : null}
    reason={{ label: 'دلیل برگشت', min: 5 }} onConfirm={(r) => m.mutate(r)} onClose={onClose}>
    <p>مشتری پرونده را برگرداند؟ پورسانت این پرونده در <b>{monthLabel(c.returnCaseMonth)}</b> از دفتر کسر می‌شود. ردیف‌های قبلی پاک نمی‌شوند.</p>
    {rows.length ? <ul className="gp-comm-rows compact" data-testid="return-case-preview">{rows.map((r) => <li key={r.id}><span>{r.salespersonName ? `${r.salespersonName} · ` : ''}{KIND_LABELS[r.kind] ?? r.kind}</span><b className="neg" dir="ltr">−{toBig(r.amountToman).toLocaleString('fa-IR')} تومان</b></li>)}</ul> : null}
  </ConfirmDialog>;
}

function ReceiptPreview({ orderId }: { orderId: number }) {
  const [state, setState] = useState<{ url: string; type: string } | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true; let made = '';
    setErr(''); setState(null);
    fetch(`/api/payment-orders/${orderId}/receipt`, { credentials: 'include' })
      .then(async (r) => { if (!r.ok) { let m = 'دریافت رسید ناموفق بود.'; try { const j = await r.json(); m = errText(new ApiError(j.error || m, r.status, j.error)); } catch { /* non-json */ } throw new Error(m); } return r.blob(); })
      .then((b) => { if (!alive) return; made = URL.createObjectURL(b); setState({ url: made, type: b.type }); })
      .catch((e: Error) => { if (alive) setErr(e.message); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [orderId, tick]);
  if (err) return <div className="gp-alert" style={{ width: '100%' }}>{err} <button className="btn btn-ghost" onClick={() => setTick((t) => t + 1)}>تلاش دوباره</button></div>;
  if (!state) return <div className="skeleton" style={{ width: '100%', height: 220, borderRadius: 12 }} />;
  const frame = { width: '100%', maxHeight: 520, border: '1px solid #e3e8ef', borderRadius: 12, background: '#f6f8fb' } as const;
  return <div style={{ width: '100%', marginTop: 12 }} data-testid="receipt-preview">
    {state.type.startsWith('image/') ? <img src={state.url} alt="رسید پرداخت" style={{ ...frame, objectFit: 'contain', display: 'block' }} />
      : state.type === 'application/pdf' ? <iframe src={state.url} title="رسید پرداخت" style={{ ...frame, height: 520 }} />
      : <p className="secondary-cell">پیش‌نمایش برای این نوع فایل ممکن نیست؛ از دکمه دریافت استفاده کنید.</p>}
  </div>;
}
