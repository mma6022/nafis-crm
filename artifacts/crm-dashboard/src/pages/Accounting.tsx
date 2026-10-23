import { useRef, useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Landmark, Paperclip, Plus } from 'lucide-react';
import { EmptyState, Modal, Pagination } from '@/components/DataTools';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { accountingApi, type AccountingDocument, type AccountingFund } from '@/lib/accounting-api';
import { digitsOnly, errText, toBig, toman, useMe } from '@/lib/goods-api';
import { jalaliValueToGregorian } from '@/lib/jalali';

const MAX_FILES = 10;
const MAX_SIZE = 8 * 1024 * 1024;
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const sourceLabel = { manual: 'دستی', payment_order: 'دستور پرداخت', opening: 'موجودی اولیه' } as const;
const docTypeLabel = { credit: 'بستانکار', debit: 'بدهکار' } as const;
const txLabel = { deposit: 'واریز', withdrawal: 'برداشت' } as const;
const REFRESH = { staleTime: 10_000, refetchInterval: 15_000 };
const todayInIran = () => {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('/');
};

const faDate = (g: string) => { const d = new Date(`${g}T00:00:00Z`); return Number.isNaN(d.getTime()) ? g : new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeZone: 'UTC' }).format(d); };

function checkFiles(existing: number, files: File[]): string {
  if (existing + files.length > MAX_FILES) return `حداکثر ${MAX_FILES.toLocaleString('fa-IR')} پیوست برای هر سند مجاز است.`;
  for (const f of files) {
    const jpegAlias = /\.(jfif|jpe?g)$/i.test(f.name) && ['', 'application/octet-stream', 'image/jfif', 'image/pjpeg'].includes(f.type);
    if (!MIMES.includes(f.type) && !jpegAlias) return `نوع فایل «${f.name}» مجاز نیست (فقط JPEG، PNG، WebP و PDF).`;
    if (f.size > MAX_SIZE) return `حجم «${f.name}» بیش از ۸ مگابایت است.`;
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024) return 'مجموع حجم پیوست‌ها نباید بیش از ۱۶ مگابایت باشد.';
  return '';
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['accounting'] }), qc.invalidateQueries({ queryKey: ['payment-orders'] })]);
}

export default function Accounting() {
  const { can } = useMe();
  const [fundId, setFundId] = useTableState('accounting.fund', '');
  const [from, setFrom] = useTableState('accounting.from', '');
  const [to, setTo] = useTableState('accounting.to', '');
  const [page, setPage] = useTableState('accounting.page', 1);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState<AccountingFund | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const funds = useQuery({ queryKey: ['accounting', 'funds'], queryFn: () => accountingApi.funds(), ...REFRESH });
  const gFrom = from ? jalaliValueToGregorian(from) : undefined;
  const gTo = to ? jalaliValueToGregorian(to) : undefined;
  const list = useQuery({ queryKey: ['accounting', 'list', fundId, gFrom, gTo, page], queryFn: () => accountingApi.list({ fundId, from: gFrom, to: gTo, page }), ...REFRESH });
  const items = funds.data?.items ?? [];
  const canManage = can('accounting.manage');
  const canOpen = can('accounting.opening');
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">خزانه</div><h2>حسابداری</h2><p>صندوق‌ها، موجودی و اسناد حسابداری ثبت‌شده. اسناد پس از ثبت تغییرناپذیرند.</p></div>
      {canManage ? <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-new-document"><Plus size={16} />سند دستی</button> : null}</div>
    {funds.isLoading ? <SkeletonPanel rows={3} /> : funds.isError ? <div className="panel"><div className="gp-alert">{errText(funds.error)}</div><ErrorState onRetry={() => funds.refetch()} /></div> : !items.length ? <div className="panel"><EmptyState title="صندوقی وجود ندارد" description="ابتدا حساب بانکی شرکت را ثبت کنید." /></div> :
      <div className="gp-bank-grid">{items.map((f) => <div key={f.id} className="gp-bank-card" data-testid={`card-fund-${f.id}`}>
        <div className="gp-card-top"><Landmark size={18} /><span className={`inline-badge ${f.initialized ? 'gold' : ''}`}>{f.initialized ? 'فعال' : 'بدون موجودی اولیه'}</span></div>
        <strong>{f.fundName || f.bankName}</strong><span>{f.ownerName}</span>
        <span className="mono gp-iban" dir="ltr">{f.iban}</span>
        {f.initialized ? <strong data-testid={`text-balance-${f.id}`}>{toman(f.balanceToman)}</strong> : canOpen ? <button className="btn btn-ghost" onClick={() => setOpening(f)} data-testid={`button-opening-${f.id}`}>ثبت موجودی اولیه</button> : <small>منتظر ثبت موجودی اولیه</small>}
      </div>)}</div>}
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <div className="field"><label>صندوق</label><select value={fundId} onChange={(e) => { setFundId(e.target.value); setPage(1); }} data-testid="select-filter-fund"><option value="">همه صندوق‌ها</option>{items.map((f) => <option key={f.id} value={f.id}>{f.fundName}</option>)}</select></div>
        <div className="field"><label>از تاریخ</label><PersianDatePicker value={from} onChange={(v) => { setFrom(v); setPage(1); }} testId="filter-from" /></div>
        <div className="field"><label>تا تاریخ</label><PersianDatePicker value={to} onChange={(v) => { setTo(v); setPage(1); }} testId="filter-to" /></div>
      </div>
      {list.isLoading ? <SkeletonPanel rows={5} /> : list.isError ? <><div className="gp-alert">{errText(list.error)}</div><ErrorState onRetry={() => list.refetch()} /></> : !list.data?.items.length ? <EmptyState title="سندی پیدا نشد" description="با این فیلترها سندی ثبت نشده است." /> : <>
        <div className="data-table-wrap" style={{overflowX:'auto',maxWidth:'100%'}}><table className="data-table"><thead><tr><th>شماره</th><th>صندوق</th><th>تاریخ سند</th><th>تاریخ تراکنش</th><th>نوع</th><th>مبلغ</th><th>شرح</th><th>منشأ</th><th /></tr></thead><tbody>
          {list.data.items.map((d) => <tr key={d.id} data-testid={`row-document-${d.id}`}><td>{d.id.toLocaleString('fa-IR')}</td><td>{d.fundName}</td><td>{faDate(d.documentDate)}</td><td>{faDate(d.transactionDate)}</td><td>{docTypeLabel[d.documentType]} / {txLabel[d.transactionType]}</td><td>{toman(d.amountToman)}</td><td>{d.purpose}</td><td><span className="inline-badge">{sourceLabel[d.source]}</span></td><td><button className="table-action" onClick={() => setDetail(d.id)} data-testid={`button-detail-${d.id}`}>جزئیات</button></td></tr>)}
        </tbody></table></div>
        <Pagination total={list.data.total} offset={(list.data.page - 1) * list.data.limit} limit={list.data.limit} onChange={(o) => setPage(Math.floor(o / list.data!.limit) + 1)} testId="accounting" />
      </>}
    </div>
    {creating ? <CreateDoc funds={items.filter((f) => f.initialized)} onClose={() => setCreating(false)} /> : null}
    {opening ? <Opening fund={opening} onClose={() => setOpening(null)} /> : null}
    {detail !== null ? <Detail id={detail} canManage={canManage} onClose={() => setDetail(null)} /> : null}
  </section>;
}

function Opening({ fund, onClose }: { fund: AccountingFund; onClose: () => void }) {
  const inv = useInvalidate();
  const [amount, setAmount] = useState('');
  const m = useMutation({ mutationFn: () => accountingApi.opening(fund.id, digitsOnly(amount) || '0'), onSuccess: async () => { await inv(); onClose(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!m.isPending && amount.trim()) m.mutate(); };
  return <Modal title="موجودی اولیه صندوق" eyebrow={fund.fundName} onClose={onClose} testId="opening">
    <form onSubmit={submit}><div className="form-grid"><div className="field full"><label>مبلغ (تومان) - صفر مجاز است</label><input required inputMode="numeric" dir="ltr" disabled={m.isPending} value={amount} onChange={(e) => setAmount(digitsOnly(e.target.value))} data-testid="input-opening-amount" /></div>
      <div className="field full"><p>موجودی اولیه فقط یک بار قابل ثبت است و بعد از آن تغییر نمی‌کند. {amount ? toman(amount) : ''}</p></div></div>
      {m.isError ? <div className="gp-alert">{errText(m.error)}</div> : null}
      <div className="form-footer"><button className="btn btn-primary" disabled={m.isPending || !amount.trim()} data-testid="button-submit-opening">{m.isPending ? 'در حال ثبت…' : 'ثبت موجودی اولیه'}</button><button type="button" className="btn btn-ghost" disabled={m.isPending} onClick={onClose}>انصراف</button></div></form>
  </Modal>;
}

function FilePick({ files, setFiles, disabled, existing = 0, setError }: { files: File[]; setFiles: (f: File[]) => void; disabled: boolean; existing?: number; setError: (e: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return <div className="field full"><label>پیوست‌ها (JPEG, PNG, WebP, PDF؛ تا ۸ مگابایت)</label>
    <input ref={ref} type="file" multiple disabled={disabled} accept={[...MIMES, '.jfif'].join(',')} data-testid="input-files" onChange={(e) => {
      const next = [...files, ...Array.from(e.target.files ?? [])]; setFiles(next); setError(checkFiles(existing, next)); if (ref.current) ref.current.value = '';
    }} />
    {files.map((f, i) => <small key={i} style={{ display: 'block' }}>{f.name} <button type="button" className="table-action" disabled={disabled} onClick={() => { const next = files.filter((_, j) => j !== i); setFiles(next); setError(checkFiles(existing, next)); }}>حذف</button></small>)}
  </div>;
}

function CreateDoc({ funds, onClose }: { funds: AccountingFund[]; onClose: () => void }) {
  const inv = useInvalidate();
  const requestKey = useRef(crypto.randomUUID());
  const [f, setF] = useState({ fundId: '', documentDate: '', transactionDate: '', amount: '', purpose: '', documentType: '', transactionType: '', accountType: '', accountNumber: '', ownerName: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState('');
  const today = todayInIran();
  const m = useMutation({ mutationFn: (v: Parameters<typeof accountingApi.create>[0]) => accountingApi.create(v, files), onSuccess: async () => { await inv(); onClose(); } });
  const fund = funds.find((x) => String(x.id) === f.fundId);
  const submit = (e: FormEvent) => {
    e.preventDefault(); if (m.isPending) return;
    const doc = jalaliValueToGregorian(f.documentDate); const tx = jalaliValueToGregorian(f.transactionDate);
    const amt = digitsOnly(f.amount);
    if (!f.fundId || !doc || !tx || !amt || !f.purpose.trim() || !f.documentType || !f.transactionType) return setErr('همه فیلدها الزامی است.');
    if (toBig(amt) <= 0n) return setErr('مبلغ باید بیشتر از صفر باشد.');
    if (f.transactionDate > today) return setErr('تاریخ تراکنش نمی‌تواند در آینده باشد.');
    if (f.transactionType === 'withdrawal' && fund && toBig(amt) > toBig(fund.balanceToman)) return setErr('موجودی صندوق برای این برداشت کافی نیست.');
    const fe = checkFiles(0, files); if (fe) return setErr(fe);
    const hasAccount = !!(f.accountType || f.accountNumber.trim() || f.ownerName.trim());
    if (hasAccount && (!f.accountType || !f.accountNumber.trim() || !f.ownerName.trim())) return setErr('نوع شماره، شماره شبا یا کارت و نام صاحب حساب را کامل وارد کنید.');
    setErr('');
    m.mutate({ requestKey: requestKey.current, fundId: Number(f.fundId), documentDate: doc, transactionDate: tx, amountToman: amt, purpose: f.purpose.trim(), documentType: f.documentType as 'credit', transactionType: f.transactionType as 'deposit',
      ...(hasAccount ? {counterpartyAccountType:f.accountType as 'iban' | 'card',counterpartyAccountNumber:f.accountNumber.trim(),counterpartyOwnerName:f.ownerName.trim()} : {}),
    });
  };
  return <Modal title="ثبت سند دستی" eyebrow="حسابداری" onClose={onClose} testId="new-document" wide>
    <form onSubmit={submit} noValidate><div className="form-grid">
      <div className="field full"><label>صندوق</label><select disabled={m.isPending} value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })} data-testid="select-fund"><option value="" disabled>انتخاب کنید</option>{funds.map((x) => <option key={x.id} value={x.id}>{x.fundName} - {toman(x.balanceToman)}</option>)}</select></div>
      <div className="field"><label>تاریخ سند</label><PersianDatePicker value={f.documentDate} onChange={(v) => setF({ ...f, documentDate: v })} testId="input-document-date" /></div>
      <div className="field"><label>تاریخ تراکنش</label><PersianDatePicker value={f.transactionDate} onChange={(v) => setF({ ...f, transactionDate: v })} testId="input-transaction-date" /></div>
      <div className="field"><label>نوع سند</label><select disabled={m.isPending} value={f.documentType} onChange={(e) => setF({ ...f, documentType: e.target.value })} data-testid="select-document-type"><option value="" disabled>انتخاب کنید</option><option value="credit">بستانکار</option><option value="debit">بدهکار</option></select></div>
      <div className="field"><label>نوع تراکنش</label><select disabled={m.isPending} value={f.transactionType} onChange={(e) => setF({ ...f, transactionType: e.target.value, accountType:'',accountNumber:'',ownerName:'' })} data-testid="select-transaction-type"><option value="" disabled>انتخاب کنید</option><option value="deposit">واریز</option><option value="withdrawal">برداشت</option></select></div>
      {f.transactionType ? <>
        <div className="field full"><label>مشخصات حساب {f.transactionType === 'deposit' ? 'مبدأ' : 'مقصد'} (اختیاری)</label><select disabled={m.isPending} value={f.accountType} onChange={e=>setF({...f,accountType:e.target.value,accountNumber:'',ownerName:e.target.value ? f.ownerName : ''})} data-testid="select-counterparty-account-type">
          <option value="">بدون ثبت مشخصات حساب</option><option value="iban">شماره شبا</option><option value="card">شماره کارت</option>
        </select></div>
        {f.accountType ? <>
          <div className="field"><label htmlFor="counterparty-number">{f.accountType === 'iban' ? 'شماره شبا' : 'شماره کارت'} {f.transactionType === 'deposit' ? 'مبدأ' : 'مقصد'}</label><input id="counterparty-number" dir="ltr" inputMode={f.accountType === 'card' ? 'numeric' : 'text'} maxLength={50} placeholder={f.accountType === 'iban' ? 'IR…' : 'شماره ۱۶ رقمی'} disabled={m.isPending} value={f.accountNumber} onChange={e=>setF({...f,accountNumber:e.target.value})} data-testid="input-counterparty-number" /></div>
          <div className="field"><label htmlFor="counterparty-owner">نام صاحب حساب {f.transactionType === 'deposit' ? 'مبدأ' : 'مقصد'}</label><input id="counterparty-owner" maxLength={200} disabled={m.isPending} value={f.ownerName} onChange={e=>setF({...f,ownerName:e.target.value})} data-testid="input-counterparty-owner" /></div>
        </> : null}
      </> : null}
      <div className="field full"><label>مبلغ (تومان){f.amount ? ` - ${toman(f.amount)}` : ''}</label><input inputMode="numeric" dir="ltr" disabled={m.isPending} value={f.amount} onChange={(e) => setF({ ...f, amount: digitsOnly(e.target.value) })} data-testid="input-amount" /></div>
      <div className="field full"><label>شرح</label><input maxLength={500} disabled={m.isPending} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} data-testid="input-purpose" /></div>
      <FilePick files={files} setFiles={setFiles} disabled={m.isPending} setError={setErr} />
    </div>
    {err ? <div className="gp-alert" data-testid="error-document-form">{err}</div> : null}
    {m.isError ? <div className="gp-alert">{errText(m.error)}</div> : null}
    <div className="form-footer"><button className="btn btn-primary" disabled={m.isPending} data-testid="button-submit-document">{m.isPending ? 'در حال ثبت…' : 'ثبت سند'}</button><button type="button" className="btn btn-ghost" disabled={m.isPending} onClick={onClose}>انصراف</button></div></form>
  </Modal>;
}

function Detail({ id, canManage, onClose }: { id: number; canManage: boolean; onClose: () => void }) {
  const { can } = useMe();
  const inv = useInvalidate();
  const q = useQuery({ queryKey: ['accounting', 'doc', id], queryFn: () => accountingApi.get(id), ...REFRESH });
  const [files, setFiles] = useState<File[]>([]);
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => accountingApi.attach(id, files), onSuccess: async () => { setFiles([]); await inv(); } });
  const d: AccountingDocument | undefined = q.data;
  const upload = () => { if (m.isPending || !files.length) return; const e = checkFiles(d?.attachments.length ?? 0, files); if (e) return setErr(e); setErr(''); m.mutate(); };
  return <Modal title={`سند شماره ${id.toLocaleString('fa-IR')}`} eyebrow="جزئیات سند" onClose={onClose} testId="document-detail" wide>
    {q.isLoading ? <SkeletonPanel rows={4} /> : q.isError || !d ? <><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></> : <>
      <div className="form-grid">
        {([['صندوق', d.fundName], ['منشأ', sourceLabel[d.source]], ['تاریخ سند', faDate(d.documentDate)], ['تاریخ تراکنش', faDate(d.transactionDate)], ['نوع سند', docTypeLabel[d.documentType]], ['نوع تراکنش', txLabel[d.transactionType]], ['مبلغ', toman(d.amountToman)], ['شرح', d.purpose], ['موجودی قبل', toman(d.balanceBeforeToman)], ['موجودی بعد', toman(d.balanceAfterToman)], ['ثبت‌کننده', d.createdByName || '—'], ['زمان ثبت', formatDateTime(d.createdAt)]] as [string, string][]).map(([k, v]) => <div className="field" key={k}><label>{k}</label><div>{v}</div></div>)}
        {d.source === 'payment_order' && d.sourceOrderId ? <div className="field full"><label>سند خودکار دستور پرداخت</label><div>دستور پرداخت شماره {d.sourceOrderId.toLocaleString('fa-IR')} {can('payment_orders.view') ? <a className="table-action" href={`${import.meta.env.BASE_URL}payment-orders`.replace('//', '/')}>فهرست دستورهای پرداخت</a> : null}</div></div> : null}
        {d.source === 'opening' ? <div className="field full"><p>این سند، موجودی اولیه صندوق است.</p></div> : null}
        {d.source !== 'opening' ? <>
          <div className="field"><label>{d.counterpartyAccountType === 'card' ? 'شماره کارت' : d.counterpartyAccountType === 'iban' ? 'شماره شبا' : 'شماره شبا یا کارت'} {d.transactionType === 'deposit' ? 'مبدأ' : 'مقصد'}</label><div dir="ltr" className="mono" style={{overflowWrap:'anywhere'}} data-testid="text-counterparty-number">{d.counterpartyAccountNumber || 'ثبت نشده'}</div></div>
          <div className="field"><label>نام صاحب حساب {d.transactionType === 'deposit' ? 'مبدأ' : 'مقصد'}</label><div data-testid="text-counterparty-owner">{d.counterpartyOwnerName || 'ثبت نشده'}</div></div>
        </> : null}
      </div>
      <h4 style={{ margin: '14px 0 6px' }}><Paperclip size={14} /> پیوست‌ها</h4>
      {!d.attachments.length ? <small>پیوستی ندارد.</small> : <ul>{d.attachments.map((a) => <li key={a.id}><FileText size={13} /> <a className="table-action" href={accountingApi.attachmentUrl(d.id, a.id)} target="_blank" rel="noreferrer" download={a.name} data-testid={`link-attachment-${a.id}`}>{a.name}</a> <small>{Math.ceil(a.size / 1024).toLocaleString('fa-IR')} کیلوبایت</small></li>)}</ul>}
      {canManage ? <div style={{ marginTop: 10 }}><FilePick files={files} setFiles={setFiles} disabled={m.isPending} existing={d.attachments.length} setError={setErr} />
        {err ? <div className="gp-alert">{err}</div> : null}{m.isError ? <div className="gp-alert">{errText(m.error)}</div> : null}
        <div className="form-footer"><button className="btn btn-primary" disabled={m.isPending || !files.length} onClick={upload} data-testid="button-upload-attachments">{m.isPending ? 'در حال بارگذاری…' : 'افزودن پیوست'}</button></div></div> : null}
    </>}
  </Modal>;
}
