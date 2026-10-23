import { useEffect, useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { documentFileAccept, supportedDocumentFile } from '@/lib/document-upload-type';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowRight, Check, CreditCard, Download, ShieldCheck, Upload } from 'lucide-react';
import { EmptyState, Pagination, SearchField } from '@/components/DataTools';
import { RegistrationSuggestions } from '@/components/RegistrationSuggestions';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { api, ApiError, digitsOnly, errText, eventLabel, listOf, openAuthedFile, poStageLabel, PO_STAGES, toman, useMe, type BankAccount, type PaymentOrder } from '@/lib/goods-api';

const canAdmin = (can: (p: string) => boolean) => can('payment_orders.admin_approve');

export default function PaymentOrders() {
  const params = useParams<{ id?: string }>();
  return params.id ? <OrderDetail id={Number(params.id)} /> : <OrderList />;
}

function OrderList() {
  const { can } = useMe();
  const [stage, setStage] = useTableState('payments.stage', '');
  const [search, setSearch] = useTableState('payments.search', '');
  const [page, setPage] = useTableState('payments.page', 1);
  const serverStage = stage === 'mine' ? '' : stage;
  const mineParam = stage === 'mine' ? '&mine=1' : '';
  const q = useQuery({ queryKey: ['payment-orders', search, serverStage, stage === 'mine', page], queryFn: () => api.get<{ items: PaymentOrder[]; page: number; limit: number; total: number }>(`/payment-orders?q=${encodeURIComponent(search.trim())}&stage=${serverStage}${mineParam}&page=${page}`), refetchInterval: 30_000 });
  const limit = q.data?.limit ?? 25;
  // highlight only; filtering is done by the server via mine=1
  const needsMe = (o: PaymentOrder) => (o.stage === 'sales_approval' && can('payment_orders.sales_approve')) || (o.stage === 'admin_approval' && canAdmin(can)) || (o.stage === 'awaiting_payment' && can('payment_orders.pay'));
  const rows = listOf<PaymentOrder>(q.data);
  const pick = (k: string) => { setStage(k); setPage(1); };
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">کارتابل مالی</div><h2>دستورهای پرداخت</h2><p>هر دستور سه امضا دارد: فروش، مدیریت و حسابداری.</p></div></div>
    <RegistrationSuggestions kind="payments" />
    <div className="gp-toolbar"><SearchField value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="جستجوی مشتری یا شماره" testId="search-payment-orders" /></div>
    <div className="filter-tabs" style={{ width: 'fit-content', marginBottom: 14 }}>
      <button className={`filter-tab ${stage === '' ? 'active' : ''}`} onClick={() => pick('')}>همه</button>
      <button className={`filter-tab ${stage === 'mine' ? 'active' : ''}`} onClick={() => pick('mine')}>کارتابل من</button>
      {PO_STAGES.map((s) => <button key={s.key} className={`filter-tab ${stage === s.key ? 'active' : ''}`} onClick={() => pick(s.key)}>{s.label}</button>)}
    </div>
    {q.isLoading ? <SkeletonPanel rows={5} /> : q.isError ? <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div> : !rows.length ? <div className="panel"><EmptyState title="دستوری در این کارتابل نیست" description="دستور پرداخت پس از تکمیل خرید کالا ایجاد می‌شود." /></div> :
      <div className="panel table-wrap"><table className="data-table"><thead><tr><th>شماره</th><th>مشتری</th><th>خرید</th><th>مبلغ</th><th>مرحله</th><th>ایجاد</th><th /></tr></thead><tbody>
        {rows.map((o) => <tr key={o.id} data-testid={`row-payment-order-${o.id}`}><td className="mono">#{o.id.toLocaleString('fa-IR')}</td><td><span className="primary-cell">{o.customerName ?? '—'}</span><span className="secondary-cell" style={{ display: 'block', marginTop: 3 }}>کارشناس فروش فعلی: {o.customerSalespersonName || 'بدون تخصیص'}</span></td><td><Link className="text-link" href={`/goods-purchases/${o.purchaseId}`}>#{o.purchaseId.toLocaleString('fa-IR')}</Link></td><td className="mono">{toman(o.amountToman)}</td><td><span className={`inline-badge ${o.stage === 'paid' ? 'active' : needsMe(o) ? 'gold' : ''}`}>{poStageLabel(o.stage)}</span></td><td className="secondary-cell">{formatDateTime(o.createdAt)}</td><td><Link className="table-action" href={`/payment-orders/${o.id}`}>باز کردن</Link></td></tr>)}
      </tbody></table>{(q.data?.total ?? 0) > limit ? <Pagination total={q.data?.total ?? 0} offset={(page - 1) * limit} limit={limit} onChange={(o) => setPage(Math.floor(o / limit) + 1)} testId="pagination-payment-orders" /> : null}</div>}
  </section>;
}

function OrderDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const { can } = useMe();
  const key = ['payment-order', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<PaymentOrder>(`/payment-orders/${id}`), refetchInterval: 20_000 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (text: string) => { setMsg({ ok: true, text }); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['payment-orders'] }); };
  const adminApprove = useMutation({ mutationFn: () => api.post(`/payment-orders/${id}/admin-approve`), onSuccess: () => done('تأیید مدیریت ثبت شد.'), onError: (e) => setMsg({ ok: false, text: errText(e) }) });
  if (q.isLoading) return <SkeletonPanel rows={6} />;
  if (q.isError || !q.data) return <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div>;
  const o = q.data;
  const idx = Math.max(0, PO_STAGES.findIndex((s) => s.key === o.stage));
  const history = o.events ?? [];
  const dest = o.destinationIban ? `${o.destinationOwnerName ?? ''} ${o.destinationIban}`.trim() : '—';
  return <section className="data-page">
    <Link href="/payment-orders" className="text-link gp-back"><ArrowRight size={14} />بازگشت به کارتابل</Link>
    {o.basePayoutAmountToman != null ? <div className="panel" style={{ padding: 18, marginBottom: 18 }}>
      <h3>محاسبهٔ مبلغ واریزی مشتری</h3>
      <div className="gp-figures">
        <div className="gp-fig"><span>واریزی پیش‌فرض</span><strong>{toman(o.basePayoutAmountToman)}</strong></div>
        <div className="gp-fig"><span>تخفیف کارمزد ثبت‌شده</span><strong>{toman(o.feeDiscountToman ?? '0')}</strong></div>
        <div className="gp-fig teal"><span>واریزی نهایی دستور پرداخت</span><strong>{toman(o.amountToman)}</strong></div>
      </div>
    </div> : null}
    <div className="gp-hero">
      <div><div className="eyebrow">دستور پرداخت #{o.id.toLocaleString('fa-IR')}</div><h2>{o.customerName ?? 'مشتری'}</h2><p>کارشناس فروش فعلی: {o.customerSalespersonName || 'بدون تخصیص'}</p><p>خرید <Link className="text-link" href={`/goods-purchases/${o.purchaseId}`}>#{o.purchaseId.toLocaleString('fa-IR')}</Link> · ایجاد {formatDateTime(o.createdAt)}</p></div>
      <div className="gp-hero-amount"><span>مبلغ پرداخت</span><strong>{toman(o.amountToman)}</strong><em className="inline-badge gold">{poStageLabel(o.stage)}</em></div>
    </div>
    <ol className="gp-timeline compact">{PO_STAGES.map((s, i) => <li key={s.key} className={i < idx || o.stage === 'paid' ? 'done' : i === idx ? 'current' : ''}><span className="gp-dot">{i < idx || o.stage === 'paid' ? <Check size={13} /> : (i + 1).toLocaleString('fa-IR')}</span><strong>{s.label}</strong></li>)}</ol>
    {msg ? <div className={`gp-alert ${msg.ok ? 'ok' : ''}`}>{msg.text}</div> : null}
    <div className="gp-detail-grid">
      <div className="gp-main-col">
        {o.stage === 'sales_approval' ? (can('payment_orders.sales_approve') ? <SalesApprove order={o} onDone={done} /> : <Waiting text="در انتظار تأیید کارشناس فروش" />) : null}
        {o.stage === 'admin_approval' ? <div className="panel gp-stage-panel"><div className="panel-head"><div><h3><ShieldCheck size={16} /> تأیید مدیریت</h3><p>حساب مقصد: <span dir="ltr" className="mono">{dest}</span></p></div></div>
          {canAdmin(can) ? <button className="btn btn-primary" disabled={adminApprove.isPending} onClick={() => confirm('پرداخت تأیید شود؟') && adminApprove.mutate()} data-testid="button-admin-approve">تأیید پرداخت</button> : <p className="secondary-cell">در انتظار تأیید مدیر.</p>}</div> : null}
        {o.stage === 'awaiting_payment' ? (can('payment_orders.pay') ? <PayForm order={o} dest={dest} onDone={done} /> : <Waiting text="در انتظار پرداخت حسابداری" />) : null}
        {o.stage === 'paid' ? <div className="panel gp-stage-panel gp-finale"><div><h3>پرداخت انجام شد</h3><p>کد پیگیری <b className="mono" dir="ltr">{o.trackingNumber}</b> · {formatDateTime(o.paidAt)}</p><p>از حساب: <SourceName id={o.sourceBankAccountId} /> · به حساب: <span dir="ltr" className="mono">{dest}</span></p></div>
          <button className="btn btn-gold" onClick={() => openAuthedFile(`/payment-orders/${o.id}/receipt`).catch((e) => setMsg({ ok: false, text: errText(e) }))} data-testid="button-download-receipt"><Download size={15} />رسید پرداخت</button>
          <ReceiptPreview orderId={o.id} /></div> : null}
      </div>
      <aside className="panel gp-events"><h3>تاریخچه</h3>{history.length ? <ul>{[...history].reverse().map((e, i) => <li key={i}><strong>{eventLabel(e.action)}</strong><span>{formatDateTime(e.createdAt)}</span></li>)}</ul> : <p className="secondary-cell">سابقه‌ای ثبت نشده.</p>}</aside>
    </div>
  </section>;
}

const useSources = () => useQuery({ queryKey: ['bank-accounts'], queryFn: () => api.get<unknown>('/bank-accounts').then((d) => listOf<BankAccount>(d)) });
function SourceName({ id }: { id?: number | null }) { const q = useSources(); const a = q.data?.find((x) => x.id === id); return <span>{a ? `${a.bankName} · ${a.fundName || a.ownerName}` : id ? `#${id}` : '—'}</span>; }
function Waiting({ text }: { text: string }) { return <div className="panel gp-stage-panel"><p className="secondary-cell">{text}</p></div>; }

function SalesApprove({ order, onDone }: { order: PaymentOrder; onDone: (t: string) => void }) {
  const qc = useQueryClient();
  const cid = order.customerId;
  const accountsKey = ['customer-bank-accounts', cid];
  const accounts = useQuery({ queryKey: accountsKey, queryFn: () => api.get<unknown>(`/customers/${cid}/bank-accounts`).then((d) => listOf<BankAccount>(d)), enabled: Boolean(cid) });
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'iban' | 'card'>('iban');
  const [value, setValue] = useState('');
  const verify = useMutation({
    mutationFn: () => api.post<BankAccount>(`/customers/${cid}/bank-accounts/verify`, mode === 'iban' ? { iban: `IR${digitsOnly(value)}` } : { cardNumber: digitsOnly(value) }),
    onSuccess: (a) => { setValue(''); qc.invalidateQueries({ queryKey: accountsKey }); if (a?.id) setSelected(a.id); },
  });
  const approve = useMutation({ mutationFn: () => api.post(`/payment-orders/${order.id}/sales-approve`, { customerBankAccountId: selected }), onSuccess: () => onDone('تأیید فروش ثبت شد.') });
  const verified = (accounts.data ?? []).filter((a) => Boolean(a.verifiedAt));
  const valid = mode === 'iban' ? digitsOnly(value).length === 24 : digitsOnly(value).length === 16;
  return <div className="panel gp-stage-panel">
    <div className="panel-head"><div><h3><CreditCard size={16} /> تأیید فروش و حساب مقصد</h3><p>فقط حساب‌هایی که مالکیت آن‌ها با کد ملی مشتری از طریق استعلام بانکی تأیید شده قابل انتخاب‌اند. کارت به شبا تبدیل و سپس تطبیق مالکیت انجام می‌شود.</p></div></div>
    {!cid ? <div className="gp-alert">شناسه مشتری در دستور پرداخت موجود نیست.</div> : accounts.isLoading ? <SkeletonPanel rows={2} /> : accounts.isError ? <div className="gp-alert">{errText(accounts.error)}</div> :
      verified.length ? <div className="gp-pick-list">{verified.map((a) => <button type="button" key={a.id} className={`gp-pick ${selected === a.id ? 'on' : ''}`} onClick={() => setSelected(a.id)}><ShieldCheck size={18} /><div><strong>{a.bankName || 'بانک'} · {a.ownerName}</strong><span dir="ltr" className="mono">{a.iban}</span></div><b>{a.verifiedAt ? formatDateTime(a.verifiedAt) : 'تأییدشده'}</b></button>)}</div> : <p className="secondary-cell">هنوز حساب تأییدشده‌ای برای این مشتری ثبت نشده است.</p>}
    <div className="gp-verify">
      <div className="filter-tabs"><button type="button" className={`filter-tab ${mode === 'iban' ? 'active' : ''}`} onClick={() => setMode('iban')}>شبا</button><button type="button" className={`filter-tab ${mode === 'card' ? 'active' : ''}`} onClick={() => setMode('card')}>کارت</button></div>
      <div className="field" style={{ flex: 1 }}><input dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'iban' ? '24 رقم بدون IR' : '16 رقم کارت'} data-testid="input-verify-account" /></div>
      <button className="btn btn-ghost" disabled={!valid || verify.isPending || !cid} onClick={() => verify.mutate()} data-testid="button-verify-account">{verify.isPending ? 'در حال استعلام…' : 'استعلام مالکیت'}</button>
    </div>
    {verify.isError ? <div className="gp-alert">{errText(verify.error)}</div> : null}
    {verify.isSuccess ? <div className="gp-alert ok">حساب {verify.data?.bankName ?? ''} به نام {verify.data?.ownerName ?? ''} تأیید و انتخاب شد.</div> : null}
    {approve.isError ? <div className="gp-alert">{errText(approve.error)}</div> : null}
    <div className="form-footer"><button className="btn btn-primary" disabled={!selected || approve.isPending} onClick={() => approve.mutate()} data-testid="button-sales-approve">تأیید و ارسال به مدیریت</button></div>
  </div>;
}

function PayForm({ order, dest, onDone }: { order: PaymentOrder; dest: string; onDone: (t: string) => void }) {
  const sources = useSources();
  const [f, setF] = useState({ sourceBankAccountId: '', trackingNumber: '', date: new Date().toISOString().slice(0, 10), time: new Date().toTimeString().slice(0, 5) });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const pay = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('sourceBankAccountId', f.sourceBankAccountId);
      fd.append('trackingNumber', f.trackingNumber.trim());
      fd.append('paidAt', new Date(`${f.date}T${f.time}:00+03:30`).toISOString());
      if (file) fd.append('receipt', file);
      return api.upload(`/payment-orders/${order.id}/pay`, fd);
    },
    onSuccess: () => onDone('پرداخت و رسید ثبت شد.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setErr('بارگذاری رسید الزامی است.');
    if (file.size > 10 * 1024 * 1024) return setErr('حجم رسید حداکثر ۱۰ مگابایت است.');
    if (!supportedDocumentFile(file)) return setErr('فقط تصویر یا PDF قابل قبول است.');
    setErr(''); pay.mutate();
  };
  return <form className="panel gp-stage-panel" onSubmit={submit}>
    <div className="panel-head"><div><h3><Upload size={16} /> ثبت پرداخت حسابداری</h3><p>واریز {toman(order.amountToman)} به <span dir="ltr" className="mono">{dest}</span></p></div></div>
    <div className="form-grid">
      <div className="field full"><label>حساب مبدأ</label><select required value={f.sourceBankAccountId} onChange={(e) => setF({ ...f, sourceBankAccountId: e.target.value })} data-testid="select-source-account"><option value="">{sources.isLoading ? 'در حال بارگذاری…' : 'انتخاب حساب شرکت'}</option>{(sources.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.bankName} · {a.fundName || a.ownerName} · {a.iban}</option>)}</select>{sources.isError ? <small className="gp-err-text">{errText(sources.error)}</small> : null}</div>
      <div className="field"><label>کد پیگیری</label><input required dir="ltr" value={f.trackingNumber} onChange={(e) => setF({ ...f, trackingNumber: e.target.value })} data-testid="input-tracking" /></div>
      <div className="field"><label>تاریخ پرداخت</label><input required type="date" dir="ltr" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
      <div className="field"><label>ساعت (تهران)</label><input required type="time" dir="ltr" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
      <div className="field"><label>رسید (تصویر یا PDF)</label><input type="file" accept={documentFileAccept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="input-receipt" /></div>
    </div>
    {err ? <div className="gp-alert">{err}</div> : null}
    {pay.isError ? <div className="gp-alert">{errText(pay.error)}</div> : null}
    <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pay.isPending} data-testid="button-pay">{pay.isPending ? 'در حال ثبت…' : 'ثبت پرداخت'}</button></div>
  </form>;
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
