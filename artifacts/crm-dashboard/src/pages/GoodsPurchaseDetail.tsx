import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'wouter';
import { ArrowRight, Check, FileText, Printer, RefreshCw, Send, Plus, Trash2, Banknote, ShieldCheck, Truck } from 'lucide-react';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import GoodsSettlementPreview from '@/components/GoodsSettlementPreview';
import { ConfirmDialog, Stepper } from '@/components/goods/GpKit';
import { NEXT_STEP } from '@/pages/GoodsPurchases';
import { getGetCompanyWalletQueryKey } from '@workspace/api-client-react';
import { useListContractTemplates, getListContractTemplatesQueryKey, type ContractMapping } from '@workspace/api-client-react';
import { UpdatedContractBanner } from '@/components/UpdatedContractBanner';
import { api, digitsOnly, errText, eventLabel, openAuthedFile, rawCode, stageIndex, stageLabel, STAGES, toBig, toman, docStatusLabel, useMe, type GoodsDocument, type Purchase, type PurchaseItem, type PaymentOrder } from '@/lib/goods-api';

export default function GoodsPurchaseDetail() {
  const { id } = useParams<{ id: string }>();
  const pid = Number(id);
  const qc = useQueryClient();
  const { can, user } = useMe();
  const [, go] = useLocation();
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const key = ['goods-purchase', pid];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Purchase>(`/goods-purchases/${pid}`), enabled: pid > 0, refetchInterval: 20_000 });
  const p = q.data;
  const manage = can('goods_purchases.manage');
  const finance = can('goods_finance.manage');

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; ok: string }) => api.post<unknown>(path, body),
    onSuccess: (_d, v) => { setFlash({ ok: true, text: v.ok }); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['goods-purchases'] }); qc.invalidateQueries({ queryKey: ['payment-orders'] }); qc.invalidateQueries({ queryKey: ['registration-suggestions'] }); qc.invalidateQueries({ queryKey: getGetCompanyWalletQueryKey() }); },
    onError: (e) => setFlash({ ok: false, text: errText(e) }),
  });
  const run = (path: string, ok: string, body?: unknown): void => { setFlash(null); act.mutate({ path: `/goods-purchases/${pid}${path}`, body, ok }); };
  const [ask, setAsk] = useState<Ask | null>(null);
  const askRun: AskRun = (a) => setAsk(a);
  const createOrder = useMutation({
    mutationFn: () => api.post<PaymentOrder>('/payment-orders', { purchaseId: pid }),
    onSuccess: (o) => { qc.invalidateQueries({ queryKey: ['payment-orders'] }); qc.invalidateQueries({ queryKey: ['registration-suggestions', 'payments'] }); go(`/payment-orders/${o.id}`); },
    onError: (e) => setFlash({ ok: false, text: errText(e) }),
  });

  if (q.isLoading) return <SkeletonPanel rows={6} />;
  if (q.isError || !p) return <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div>;
  const idx = stageIndex(p.stage);
  const busy = act.isPending;

  return <section className="data-page">
    <Link href="/goods-purchases" className="text-link gp-back"><ArrowRight size={14} />بازگشت به خریدها</Link>
    <div className="gp-hero2">
      <div className="gp-hero2-main">
        <div className="eyebrow">خرید کالا #{p.id.toLocaleString('fa-IR')}</div>
        <h2>{p.customerName}</h2>
        <p>کارشناس فروش فعلی: {p.customerSalespersonName || 'بدون تخصیص'} · {p.planName} · ایجاد {formatDateTime(p.createdAt)}</p>
      </div>
      <div className="gp-hero2-amount"><span>اعتبار رزروشده</span><strong>{toman(p.creditAmountToman)}</strong><em className={`gp-chip ${p.stage === 'completed' ? 'green' : 'light'}`}><i />{stageLabel(p.stage)} · {(idx + 1).toLocaleString('fa-IR')}/{STAGES.length.toLocaleString('fa-IR')}</em></div>
    </div>

    <Stepper steps={STAGES.map((st) => st.label)} current={idx} done={p.stage === 'completed'} testId="goods-stepper" />

    {flash ? <div className={`gp-alert ${flash.ok ? 'ok' : ''}`} role="status">{flash.text}</div> : null}

    <div className="gp-detail2">
      <div className="gp-main-col">
        {p.stage !== 'completed' ? <div className={`gp-now ${NEXT_STEP[p.stage]?.act ? 'act' : ''}`} data-testid="card-now">
          <span>کار الان</span><strong>{NEXT_STEP[p.stage]?.text ?? stageLabel(p.stage)}</strong>
          <small>{STAGES[idx]?.hint}</small>
        </div> : null}
        {p.stage === 'discharge_pending' ? <div className="panel gp-stage-panel">
          <div className="panel-head"><div><h3><Truck size={16} /> تأیید تخلیه اعتبار</h3><p>پس از انجام تخلیه در پلتفرم بیرونی، آن را اینجا تأیید کنید. این تأیید فقط ثبت اقدام بیرونی است.</p></div></div>
          <button className="btn btn-primary" disabled={!manage || busy} onClick={() => askRun({ title: 'تأیید تخلیه اعتبار', body: 'تخلیه اعتبار در پلتفرم بیرونی انجام شده است؟', label: 'بله، تخلیه انجام شد', path: '/discharge', ok: 'تخلیه اعتبار ثبت شد.' })} data-testid="button-discharge">تخلیه انجام شد</button>
        </div> : null}

        {idx >= 1 ? <InvoicePanel p={p} editable={manage && p.stage === 'invoice_draft' && !['sending', 'sent', 'signed', 'delivery_unknown'].includes(p.invoiceDocument?.status ?? '')} onSaved={(t) => { setFlash({ ok: true, text: t }); qc.invalidateQueries({ queryKey: key }); }} /> : null}

        {idx >= 1 && (p.items?.length ?? 0) > 0 ? <DocumentPanel title="فاکتور فروش کالا" kind="invoice" doc={p.invoiceDocument} pid={pid} active={['invoice_draft', 'invoice_signature', 'settlement_pending'].includes(p.stage) && Boolean(p.invoice_version)} canAct={manage} readOnlySignatureStatus={user?.role === 'salesperson'} busy={busy} run={run} askRun={askRun} setFlash={setFlash} /> : null}

        {idx >= 3 ? <GoodsSettlementPreview key={p.id} purchase={p} canSettle={finance && manage} busy={busy}
          onSettle={feeDiscountToman => run('/settle', 'تسویه و مبلغ نهایی واریزی ثبت شد.', { feeDiscountToman })} /> : null}

        {idx >= 4 ? <DocumentPanel title="رسید دریافت کالا و اقرارنامه" kind="acknowledgement" doc={p.acknowledgementDocument} templateId={p.acknowledgement_template_id} pid={pid} active={['acknowledgement_signature', 'registrar_confirmation'].includes(p.stage)} canAct={manage} readOnlySignatureStatus={user?.role === 'salesperson'} busy={busy} run={run} askRun={askRun} setFlash={setFlash} /> : null}

        {idx >= 5 ? <div className="panel gp-stage-panel">
          <div className="panel-head"><div><h3><ShieldCheck size={16} /> تأیید نهایی ثبت‌کننده</h3><p>با تأیید، خرید تکمیل و پورسانت کارشناس فروش یک‌بار ثبت می‌شود.</p></div></div>
          {p.stage === 'registrar_confirmation' ? <button className="btn btn-primary" disabled={!manage || busy} onClick={() => askRun({ title: 'تکمیل خرید', body: 'با تأیید، خرید تکمیل و پورسانت کارشناس فروش یک‌بار ثبت می‌شود. خرید تکمیل شود؟', label: 'تأیید و تکمیل', tone: 'green', path: '/complete', ok: 'خرید تکمیل شد.' })} data-testid="button-complete">تأیید و تکمیل</button> : <p className="secondary-cell">تکمیل‌شده در {formatDateTime(p.completedAt)}</p>}
        </div> : null}

        {p.stage === 'completed' ? <div className="panel gp-stage-panel gp-finale">
          <div><h3>دستور پرداخت</h3><p>مبلغ {toman(p.payoutAmountToman)} از روی خرید تکمیل‌شده به کارتابل پرداخت می‌رود.</p></div>
          {can('payment_orders.create') ? <button className="btn btn-gold" disabled={createOrder.isPending} onClick={() => createOrder.mutate()} data-testid="button-create-payment-order">{createOrder.isPending ? 'در حال ایجاد…' : 'ایجاد / مشاهده دستور پرداخت'}</button> : <Link href="/payment-orders" className="btn btn-ghost">کارتابل پرداخت</Link>}
        </div> : null}
      </div>

      <aside className="panel gp-events gp-history">
        <h3>رویدادها</h3>
        {(p.events ?? []).length ? <ul>{[...(p.events ?? [])].reverse().map((e, i) => <li key={i}><strong>{eventLabel(e.action)}</strong><span>{formatDateTime(e.createdAt)}</span></li>)}</ul> : <p className="secondary-cell">رویدادی ثبت نشده است.</p>}
      </aside>
    </div>
    {ask ? <ConfirmDialog title={ask.title} testId="confirm-goods-action" confirmLabel={ask.label} tone={ask.tone ?? 'primary'} busy={busy}
      onConfirm={() => { run(ask.path, ask.ok); setAsk(null); }} onClose={() => setAsk(null)}><p>{ask.body}</p></ConfirmDialog> : null}
  </section>;
}

type Ask = { title: string; body: string; label: string; path: string; ok: string; tone?: 'primary' | 'green' | 'danger' };
type AskRun = (a: Ask) => void;

function Fig({ label, v, tone }: { label: string; v?: string | null; tone?: string }) {
  return <div className={`gp-fig ${tone ?? ''}`}><span>{label}</span><strong>{v === null || v === undefined ? '—' : toman(v)}</strong></div>;
}

type Row = { title: string; quantity: string; unitPriceToman: string };
function InvoicePanel({ p, editable, onSaved }: { p: Purchase; editable: boolean; onSaved: (t: string) => void }) {
  const init = (): Row[] => (p.items?.length ? p.items.map((i: PurchaseItem) => ({ title: i.title, quantity: String(i.quantity), unitPriceToman: String(i.unitPriceToman) })) : [{ title: '', quantity: '1', unitPriceToman: '' }]);
  const [rows, setRows] = useState<Row[]>(init);
  const initFor = useRef(p.id);
  useEffect(() => { if (initFor.current !== p.id) { initFor.current = p.id; setRows(init()); } }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api.put<Purchase>(`/goods-purchases/${p.id}/invoice`, { items: rows.map((r) => ({ title: r.title.trim(), quantity: Number(r.quantity), unitPriceToman: digitsOnly(r.unitPriceToman) })) }),
    onSuccess: () => onSaved('اقلام فاکتور ذخیره شد.'),
  });
  const total = rows.reduce((s, r) => s + toBig(digitsOnly(r.unitPriceToman)) * BigInt(Math.max(0, Math.floor(Number(r.quantity) || 0))), 0n);
  const credit = toBig(p.creditAmountToman);
  const diff = credit - total;
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return <div className="panel gp-stage-panel">
    <div className="panel-head"><div><h3><FileText size={16} /> اقلام فاکتور</h3><p>جمع فاکتور باید دقیقاً برابر کل اعتبار رزروشده باشد. محاسبه نهایی روی سرور انجام می‌شود.</p></div></div>
    <div className="table-wrap"><table className="data-table gp-invoice">
      <thead><tr><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>جمع</th>{editable ? <th /> : null}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>
        <td>{editable ? <input value={r.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="مثال: یخچال ساید بای ساید" data-testid={`input-item-title-${i}`} /> : r.title}</td>
        <td>{editable ? <input type="number" min={1} step={1} value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value })} style={{ width: 70 }} /> : Number(r.quantity).toLocaleString('fa-IR')}</td>
        <td>{editable ? <input dir="ltr" inputMode="numeric" value={toBig(digitsOnly(r.unitPriceToman)) ? toBig(digitsOnly(r.unitPriceToman)).toLocaleString('en-US') : ''} onChange={(e) => set(i, { unitPriceToman: digitsOnly(e.target.value) })} data-testid={`input-item-price-${i}`} /> : toman(r.unitPriceToman)}</td>
        <td className="mono">{toman((toBig(digitsOnly(r.unitPriceToman)) * BigInt(Math.max(0, Math.floor(Number(r.quantity) || 0)))).toString())}</td>
        {editable ? <td><button className="icon-button" type="button" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="حذف ردیف"><Trash2 size={14} /></button></td> : null}
      </tr>)}</tbody>
    </table></div>
    <div className="gp-invoice-foot">
      {editable ? <button className="btn btn-ghost" type="button" onClick={() => setRows([...rows, { title: '', quantity: '1', unitPriceToman: '' }])}><Plus size={14} />ردیف تازه</button> : <span />}
      <div className="gp-totals"><span>جمع فاکتور <b>{toman(total.toString())}</b></span><span>اعتبار <b>{toman(p.creditAmountToman)}</b></span><span className={diff === 0n ? 'ok' : 'bad'}>{diff === 0n ? 'برابر با کل اعتبار' : diff > 0n ? `${toman(diff.toString())} کمتر از اعتبار` : `${toman((-diff).toString())} بیشتر از اعتبار`}</span></div>
    </div>
    {save.isError ? <div className="gp-alert">{errText(save.error)}</div> : null}
    {editable ? <div className="form-footer"><button className="btn btn-primary" disabled={save.isPending || diff !== 0n || rows.some((r) => !r.title.trim() || !(Number(r.quantity) > 0) || !digitsOnly(r.unitPriceToman))} onClick={() => save.mutate()} data-testid="button-save-invoice">{save.isPending ? 'در حال ذخیره…' : 'ذخیره فاکتور'}</button></div> : null}
  </div>;
}

const isManual = (m: ContractMapping) => (m.sourceType ?? (m.customerField ? 'customer' : m.loanPlanField ? 'loanPlan' : 'manual')) === 'manual';

function DocumentPanel({ title, kind, doc, pid, templateId, active, canAct, readOnlySignatureStatus, busy, run, askRun, setFlash }: { title: string; kind: 'invoice' | 'acknowledgement'; doc?: GoodsDocument | null; pid: number; templateId?: number | null; active: boolean; canAct: boolean; readOnlySignatureStatus: boolean; busy: boolean; run: (path: string, ok: string, body?: unknown) => void; askRun: AskRun; setFlash: (f: { ok: boolean; text: string }) => void }) {
  const qc = useQueryClient();
  const status = doc?.status;
  const signed = Boolean(doc?.signed) || status === 'signed';
  const rejected = status === 'rejected';
  const inFlight = status === 'sent' || status === 'sending' || status === 'delivery_unknown';
  const templates = useListContractTemplates({ query: { queryKey: getListContractTemplatesQueryKey(), staleTime: 60_000, enabled: kind === 'acknowledgement' } });
  const template = templates.data?.find((t) => t.id === templateId);
  const [extra, setExtra] = useState<string[]>([]);
  const [liveSignatureStatus, setLiveSignatureStatus] = useState<{
    signed: boolean; status: string; providerStatus?: string | null; checkedAt: string;
  } | null>(null);
  const fields = [...(template?.mappings ?? []).filter(isManual).map((m) => ({ variable: m.variable, label: m.label || m.variable })), ...extra.filter((v) => !(template?.mappings ?? []).some((m) => m.variable === v && isManual(m))).map((v) => ({ variable: v, label: v }))];
  const [values, setValues] = useState<Record<string, string>>({});
  const generate = useMutation({
    mutationFn: () => api.post<GoodsDocument>(`/goods-purchases/${pid}/documents/${kind}/generate`, { values: Object.fromEntries(fields.map((f) => [f.variable, (values[f.variable] ?? '').trim()])) }),
    onSuccess: () => { setFlash({ ok: true, text: 'سند تولید شد.' }); qc.invalidateQueries({ queryKey: ['goods-purchase', pid] }); },
    onError: (e) => { const c = rawCode(e); if (c.startsWith('template_value_required:')) { const v = c.split(':')[1]; setExtra((x) => (x.includes(v) ? x : [...x, v])); } setFlash({ ok: false, text: errText(e) }); },
  });
  const inquireSignatureStatus = useMutation({
    mutationFn: () => api.get<{
      signed: boolean; status: string; providerStatus?: string | null; checkedAt: string;
    }>(`/goods-purchases/${pid}/documents/${kind}/signature-status`),
    onMutate: () => { setLiveSignatureStatus(null); setFlash({ ok: true, text: 'در حال استعلام زنده از امضامی…' }); },
    onSuccess: (result) => { setLiveSignatureStatus(result); setFlash({ ok: true, text: 'استعلام زنده انجام شد؛ وضعیت پرونده تغییر نکرد.' }); },
    onError: (e) => setFlash({ ok: false, text: errText(e) }),
  });
  const missing = fields.some((f) => !(values[f.variable] ?? '').trim());
  const open = (print: boolean) => openAuthedFile(`/goods-purchases/${pid}/documents/${kind}/pdf`, print).catch((e) => setFlash({ ok: false, text: errText(e) }));
  return <div className={`panel gp-stage-panel gp-doc ${signed ? 'signed' : rejected ? 'rejected' : ''}`}>
    <div className="panel-head"><div><h3><FileText size={16} /> {title}</h3><p>{kind === 'acknowledgement' ? `قالب: ${template?.name ?? (templates.isLoading ? '…' : templateId ? `#${templateId}` : 'تنظیم نشده')}` : 'پیش‌نمایش، چاپ و ارسال برای امضای الکترونیک در امضامی.'}</p></div><span className={`inline-badge ${signed ? 'active' : rejected ? 'inactive' : 'gold'}`}>{docStatusLabel(signed ? 'signed' : status)}{doc?.version ? ` · نسخه ${doc.version.toLocaleString('fa-IR')}` : ''}</span></div>
    <div className="gp-doc-meta">
      {doc?.createdAt ? <span>تولید: {formatDateTime(doc.createdAt)}</span> : null}
      {doc?.providerStatus ? <span>وضعیت امضامی: {doc.providerStatus}</span> : null}
    </div>
    {liveSignatureStatus ? <div className="gp-alert" role="status" data-testid={`status-live-signature-${kind}`}>
      وضعیت زندهٔ امضامی: {docStatusLabel(liveSignatureStatus.status)}{liveSignatureStatus.providerStatus ? <> · <bdi dir="auto">{liveSignatureStatus.providerStatus}</bdi></> : null}
      <br />زمان استعلام: {formatDateTime(liveSignatureStatus.checkedAt)}. این استعلام فقط‌خواندنی بود و مرحلهٔ خرید را تغییر نداد.
    </div> : null}
    {kind === 'acknowledgement' && !signed && status === 'sent' ? <UpdatedContractBanner kind="goods" subjectId={pid} onDone={() => qc.invalidateQueries({ queryKey: ['goods-purchase', pid] })} /> : null}
    {rejected ? <div className="gp-alert warn">سند توسط مشتری رد شد. {kind === 'invoice' ? 'اقلام را اصلاح کنید یا نسخه تازه تولید و دوباره ارسال کنید.' : 'نسخه تازه تولید و دوباره ارسال کنید.'}</div> : null}
    {status === 'delivery_unknown' ? <div className="gp-alert warn">نتیجه ارسال قطعی نیست؛ پیش از ارسال دوباره، وضعیت را استعلام کنید.</div> : null}
    {doc?.error ? <div className="gp-alert">{doc.error}</div> : null}
    {active && !signed && !inFlight && fields.length ? <div className="form-grid gp-manual">{fields.map((f) => <div className="field" key={f.variable}><label>{f.label}</label><input value={values[f.variable] ?? ''} maxLength={5000} onChange={(e) => setValues({ ...values, [f.variable]: e.target.value })} data-testid={`input-manual-${f.variable}`} /></div>)}</div> : null}
    <div className="gp-doc-actions">
      {active && !signed && !inFlight ? <button className="btn btn-ghost" disabled={!canAct || busy || generate.isPending || missing} onClick={() => generate.mutate()} data-testid={`button-generate-${kind}`}><FileText size={14} />{generate.isPending ? 'در حال تولید…' : doc ? 'تولید نسخه تازه' : 'تولید سند'}</button> : null}
      {doc ? <><button className="btn btn-ghost" onClick={() => open(false)} data-testid={`button-preview-${kind}`}>پیش‌نمایش PDF</button><button className="btn btn-ghost" onClick={() => open(true)}><Printer size={14} />چاپ</button></> : null}
      {active && doc && !signed && ['generated', 'rejected', 'failed', 'delivery_unknown'].includes(status ?? '') ? <button className="btn btn-primary" disabled={!canAct || busy} onClick={() => askRun({ title: 'ارسال برای امضا', body: `«${title}» برای امضای الکترونیک در امضامی ارسال شود؟`, label: 'ارسال به امضامی', path: `/documents/${kind}/send`, ok: 'سند به امضامی ارسال شد.' })} data-testid={`button-send-${kind}`}><Send size={14} />{rejected || status === 'failed' ? 'ارسال دوباره' : 'ارسال به امضامی'}</button> : null}
      {doc && !signed && inFlight ? <button className="btn btn-ghost" disabled={busy || inquireSignatureStatus.isPending} onClick={() => readOnlySignatureStatus ? inquireSignatureStatus.mutate() : run(`/documents/${kind}/refresh`, 'وضعیت امضا به‌روزرسانی شد.')} data-testid={`button-refresh-${kind}`}><RefreshCw size={14} />{inquireSignatureStatus.isPending ? 'در حال استعلام…' : 'استعلام وضعیت'}</button> : null}
    </div>
  </div>;
}
