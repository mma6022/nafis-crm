import React, { useState, useEffect, useRef } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { 
  useListManagedWallets, 
  getListManagedWalletsQueryKey,
  useListWalletTransactions,
  getListWalletTransactionsQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  createWalletTransfer
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Search, ArrowLeftRight, ArrowUp, ArrowDown, ArrowUpDown, Check, X, AlertCircle, ChevronLeft, ChevronRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { SkeletonPanel, ErrorState, formatDateTime } from '@/components/CrmShell';
import './WalletManagement.css';
import CompanyWalletPanel from './CompanyWalletPanel';

const formatMoney = (val?: string | number | null) => {
  if (val == null || val === '') return '۰';
  try {
    const cleanVal = String(val).replace(/,/g, '');
    return BigInt(cleanVal).toLocaleString('fa-IR');
  } catch {
    return '۰';
  }
};

const translateError = (code?: string | null) => {
  if (!code) return '';
  const map: Record<string, string> = {
    'insufficient_balance': 'موجودی ناکافی',
    'customer_not_found': 'مشتری یافت نشد',
    'invalid_transfer': 'اطلاعات انتقال نامعتبر است',
    'transfer_idempotency_conflict': 'درخواست تکراری با اطلاعات متفاوت ثبت شده است',
    'transfer_failed': 'ثبت انتقال در سرور با خطا روبه‌رو شد',
    'configuration_unavailable': 'تنظیمات درگاه در دسترس نیست',
    'amount_too_large': 'مبلغ از سقف مجاز درگاه بیشتر است',
    'gateway_unavailable': 'ارتباط با درگاه برقرار نشد',
    'gateway_http_error': 'درگاه پاسخ نامعتبر داد',
    'gateway_invalid_response': 'پاسخ درگاه قابل خواندن نبود',
    'gateway_rejected': 'درگاه درخواست را نپذیرفت',
    'verification_unavailable': 'بررسی پرداخت موقتاً در دسترس نیست',
    'verification_http_error': 'پاسخ بررسی درگاه نامعتبر بود',
    'verification_invalid_response': 'نتیجه بررسی درگاه قابل خواندن نبود',
    'verification_rejected': 'درگاه پرداخت را تأیید نکرد',
    'provider_already_verified': 'درگاه پرداخت را تأیید کرده، اما شارژ نیازمند تطبیق است',
  };
  return map[code] ? `${map[code]} (${code})` : /[\u0600-\u06ff]/.test(code) ? code : `خطا: ${code}`;
};

const kindTranslate: Record<string, string> = {
  payment: 'پرداخت (شارژ)',
  loan_credit: 'اعتبار تسهیلات',
  filing_fee: 'کسر هزینه تشکیل پرونده',
  goods_purchase: 'کسر بابت خرید کالا',
  transfer: 'انتقال',
  legacy: 'سابقه'
};

const txStatusTranslate: Record<string, string> = {
  requested: 'درخواست‌شده',
  gateway_ready: 'آماده درگاه',
  failed: 'ناموفق',
  cancelled: 'لغو‌شده',
  credited: 'واریزشده',
  verification_pending: 'در انتظار تأیید',
  requires_reconciliation: 'نیازمند مغایرت‌گیری',
  completed: 'تکمیل‌شده'
};

const walletTypeTranslate: Record<string, string> = {
  cash: 'نقدی',
  credit: 'اعتباری'
};

type CustomerPreselect = { id: number, name: string, phone?: string, salespersonName?: string | null } | null;

function CustomerSearch({ 
  value, 
  onChange, 
  label, 
  error,
  initialData
}: { 
  value: CustomerPreselect, 
  onChange: (val: CustomerPreselect) => void, 
  label: string, 
  error?: string,
  initialData?: CustomerPreselect
}) {
  const [search, setSearch] = useState(initialData?.name || '');
  const [debouncedSearch, setDebouncedSearch] = useState(initialData?.name || '');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (initialData && value?.id === initialData.id) {
      setSearch(initialData.name);
    }
  }, [initialData, value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { data, isLoading } = useListManagedWallets(
    { search: debouncedSearch, limit: 5 },
    { query: { queryKey: getListManagedWalletsQueryKey({ search: debouncedSearch, limit: 5 }), enabled: open } }
  );

  return (
    <div className="wallet-form-group relative" ref={ref}>
      <label>{label}</label>
      <input 
        type="text" 
        placeholder="نام، شناسه یا موبایل..." 
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
          if (value !== null) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        className={error ? '!border-red-500' : ''}
      />
      {value && <div className="text-[11px] text-teal-600 mt-1 flex flex-col gap-1"><span><Check size={12} className="inline" /> انتخاب شد (شناسه: {value.id})</span><span className="text-slate-500">کارشناس فروش: {value.salespersonName || 'بدون تخصیص'}</span></div>}
      {error && <div className="text-[11px] text-red-500 mt-1">{error}</div>}
      
      {open && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-xl z-50 max-h-56 overflow-y-auto">
          <div className="flex justify-between items-center p-2 border-b border-slate-100 sticky top-0 bg-white">
            <span className="text-[11px] text-slate-500 font-bold">نتایج جستجو</span>
            <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
          </div>
          {isLoading && <div className="p-3 text-[11px] text-slate-500 text-center">در حال جستجو...</div>}
          {!isLoading && data?.items?.length === 0 && <div className="p-3 text-[11px] text-slate-500 text-center">مشتری یافت نشد</div>}
          {data?.items?.map(c => (
            <div 
              key={c.customerId}
              className="p-2 border-b border-slate-100 hover:bg-slate-50 cursor-pointer flex flex-col transition-colors"
              onClick={() => {
                onChange({ id: c.customerId, name: c.customerName || `مشتری ${c.customerId}`, phone: c.phone, salespersonName: (c as typeof c & { customerSalespersonName?: string | null }).customerSalespersonName });
                setSearch(c.customerName || `مشتری ${c.customerId}`);
                setOpen(false);
              }}
            >
              <div className="font-bold text-[13px] text-slate-800">{c.customerName || 'بدون نام'}</div>
              <div className="text-[11px] text-slate-500">کارشناس فروش: {(c as typeof c & { customerSalespersonName?: string | null }).customerSalespersonName || 'بدون تخصیص'}</div>
              <div className="text-[11px] text-slate-500 mt-0.5" dir="ltr" style={{textAlign: 'right'}}>{c.phone} | شناسه: {c.customerId}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TransferModal({ 
  onClose, 
  initialFrom 
}: { 
  onClose: () => void, 
  initialFrom?: CustomerPreselect 
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'form' | 'confirm' | 'success'>('form');
  const [idempKey, setIdempKey] = useState('');
  
  const [fromCustomer, setFromCustomer] = useState<CustomerPreselect>(initialFrom || null);
  const [toCustomer, setToCustomer] = useState<CustomerPreselect>(null);
  const [walletType, setWalletType] = useState<'cash' | 'credit'>('cash');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const createTransfer = useMutation({
    mutationFn: (data: { body: any, key: string }) => {
      return createWalletTransfer(data.body, { headers: { 'Idempotency-Key': data.key } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListManagedWalletsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListWalletTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ['customer-wallet'] });
      setStep('success');
    },
    onError: (err: unknown) => {
      const failure = err as { data?: { error?: string; errorCode?: string; status?: string }; message?: string };
      if (failure.data?.status === 'failed') {
        setStep('form');
        setError(failure.data.errorCode || 'transfer_failed');
      } else if (failure.data?.error) {
        setError(failure.data.error);
      } else {
        setError('نتیجه درخواست مشخص نیست. برای بررسی دوباره، همین درخواست را تکرار کنید؛ درخواست جدید نسازید.');
      }
    }
  });

  const handleReview = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!fromCustomer) return setError('مشتری مبدأ را انتخاب کنید.');
    if (!toCustomer) return setError('مشتری مقصد را انتخاب کنید.');
    if (fromCustomer.id === toCustomer.id) return setError('مبدأ و مقصد نمی‌تواند یکسان باشد.');
    if (!amount.match(/^[1-9]\d*$/)) return setError('مبلغ باید عدد صحیح و بزرگتر از صفر باشد.');
    if (reason.trim().length < 3 || reason.trim().length > 500) return setError('دلیل انتقال باید بین ۳ تا ۵۰۰ نویسه باشد.');

    setIdempKey(window.crypto.randomUUID());
    setStep('confirm');
  };

  const handleSubmit = () => {
    if (createTransfer.isPending || !idempKey) return;
    setError('');
    createTransfer.mutate({
      body: {
        fromCustomerId: fromCustomer!.id,
        toCustomerId: toCustomer!.id,
        walletType,
        amountToman: amount,
        reason: reason.trim()
      },
      key: idempKey
    });
  };

  return (
    <div className="wallet-modal-overlay animate-in fade-in duration-200">
      <div className="wallet-modal-content animate-in zoom-in-95 duration-200">
        <div className="wallet-modal-header">
          <h3>
            {step === 'form' ? 'انتقال موجودی بین مشتریان' : step === 'confirm' ? 'تأیید نهایی انتقال' : 'انتقال موفق'}
          </h3>
          {step !== 'success' && <button type="button" className="wallet-modal-close" onClick={onClose} disabled={createTransfer.isPending} aria-label="بستن"><X size={18} /></button>}
        </div>
        
        {step === 'form' && (
          <form onSubmit={handleReview}>
            <div className="wallet-modal-body">
              {error && <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-[11px] font-bold">{translateError(error)}</div>}
              
              <div className="wallet-transfer-direction">
                <div className="flex-1">
                  <CustomerSearch 
                    label="از مشتری (مبدأ)" 
                    value={fromCustomer} 
                    onChange={setFromCustomer} 
                    initialData={initialFrom}
                  />
                </div>
                <div className="wallet-transfer-direction-icon">
                  <ArrowLeftRight size={18} />
                </div>
                <div className="flex-1">
                  <CustomerSearch 
                    label="به مشتری (مقصد)" 
                    value={toCustomer} 
                    onChange={setToCustomer} 
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="wallet-form-group">
                  <label>نوع کیف پول</label>
                  <select value={walletType} onChange={(e) => setWalletType(e.target.value as any)}>
                    <option value="cash">نقدی</option>
                    <option value="credit">اعتباری</option>
                  </select>
                </div>
                <div className="wallet-form-group">
                  <label>مبلغ (تومان)</label>
                  <input 
                    type="text"
                    inputMode="numeric"
                    value={amount} 
                    onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                    className="wallet-num-input"
                    placeholder="مثلا 1000000"
                    style={{textAlign: 'right'}}
                  />
                  {amount && <div className="text-[11px] text-slate-500 mt-1 font-bold">{formatMoney(amount)} تومان</div>}
                </div>
              </div>

              <div className="wallet-form-group">
                <label>دلیل انتقال</label>
                <textarea 
                  value={reason} 
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="توضیحات لازم برای مدیریت و ثبت در سوابق تراکنش (بین ۳ تا ۵۰۰ نویسه)..."
                  rows={2}
                  maxLength={500}
                />
              </div>
            </div>
            <div className="wallet-modal-footer">
              <button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button>
              <button type="submit" className="btn btn-primary">بررسی و تأیید</button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="flex flex-col h-full">
            <div className="wallet-modal-body">
              {error && <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-[11px] font-bold">{translateError(error)}</div>}
              
              <div className="text-[11px] text-amber-700 bg-amber-50 p-2.5 rounded-lg border border-amber-200 flex gap-2 items-start mb-2">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span className="leading-relaxed font-semibold">دقت کنید که این عملیات بازگشت‌ناپذیر است و مستقیماً موجودی کیف پول دو مشتری را تغییر می‌دهد. لطفاً اطلاعات زیر را با دقت بررسی کنید.</span>
              </div>

              <div className="wallet-confirm-summary">
                <div className="wallet-confirm-row">
                  <span className="wallet-confirm-label">مشتری مبدأ (فرستنده):</span>
                  <span className="wallet-confirm-value">{fromCustomer?.name} <span className="text-[10px] text-slate-500 font-mono">(ID: {fromCustomer?.id})</span></span>
                </div>
                <div className="wallet-confirm-row">
                  <span className="wallet-confirm-label">مشتری مقصد (گیرنده):</span>
                  <span className="wallet-confirm-value">{toCustomer?.name} <span className="text-[10px] text-slate-500 font-mono">(ID: {toCustomer?.id})</span></span>
                </div>
                <div className="wallet-confirm-row">
                  <span className="wallet-confirm-label">نوع کیف پول:</span>
                  <span className="wallet-confirm-value">{walletType === 'cash' ? 'نقدی' : 'اعتباری'}</span>
                </div>
                <div className="wallet-confirm-row">
                  <span className="wallet-confirm-label">مبلغ انتقال:</span>
                  <span className="wallet-confirm-value text-nafiss-blue">{formatMoney(amount)} تومان</span>
                </div>
                <div className="wallet-confirm-row">
                  <span className="wallet-confirm-label">دلیل ثبت:</span>
                  <span className="wallet-confirm-value leading-relaxed text-[11px]">{reason}</span>
                </div>
              </div>
            </div>
            
            <div className="wallet-modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => {
                setStep('form');
                setError('');
              }} disabled={createTransfer.isPending}>
                بازگشت و ویرایش
              </button>
              <button type="button" className="btn btn-primary bg-amber-600 hover:bg-amber-700" onClick={handleSubmit} disabled={createTransfer.isPending}>
                {createTransfer.isPending ? 'در حال انجام...' : 'تأیید و اجرای انتقال'}
              </button>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col h-full items-center justify-center p-8 gap-4 text-center">
            <div className="w-16 h-16 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center mb-2">
              <CheckCircle2 size={36} />
            </div>
            <h3 className="text-lg font-bold text-slate-800 m-0">انتقال با موفقیت انجام شد</h3>
            <p className="text-[13px] text-slate-500 mb-4 max-w-[80%] leading-relaxed">
              مبلغ {formatMoney(amount)} تومان از کیف پول {walletType === 'cash' ? 'نقدی' : 'اعتباری'} {fromCustomer?.name} به {toCustomer?.name} منتقل شد.
            </p>
            <button type="button" className="btn btn-primary w-full max-w-[200px]" onClick={onClose}>
              بستن
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

type WalletSortField = 'customerName' | 'phone' | 'cashBalanceToman' | 'creditBalanceToman';
const walletColumns: { key: WalletSortField; label: string }[] = [
  { key: 'customerName', label: 'نام مشتری' },
  { key: 'phone', label: 'شماره موبایل' },
  { key: 'cashBalanceToman', label: 'موجودی نقدی' },
  { key: 'creditBalanceToman', label: 'موجودی اعتباری' },
];
type WalletTextFilters = { search: string; name: string; phone: string; minCash: string; maxCash: string; minCredit: string; maxCredit: string };
const emptyWalletFilters: WalletTextFilters = { search: '', name: '', phone: '', minCash: '', maxCash: '', minCredit: '', maxCredit: '' };

function WalletsTab({ isAdmin, onTransfer }: { isAdmin: boolean, onTransfer: (customer: CustomerPreselect) => void }) {
  const [filters, setFilters] = useTableState('wallets.filters', { page: 1, limit: 20, ...emptyWalletFilters, sortBy: '' as WalletSortField | '', sortDir: 'asc' as 'asc' | 'desc' });
  const [draft, setDraft] = useTableState<WalletTextFilters>('wallets.draft', emptyWalletFilters);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(prev => (Object.keys(draft) as (keyof WalletTextFilters)[]).every(key => prev[key] === draft[key])
        ? prev : { ...prev, ...draft, page: 1 });
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);

  const changeDraft = (key: keyof WalletTextFilters, value: string) => setDraft(prev => ({ ...prev, [key]: value }));
  const invalidRange = (min: string, max: string) => min !== '' && max !== '' && BigInt(min) > BigInt(max);
  const hasInvalidRange = invalidRange(filters.minCash, filters.maxCash) || invalidRange(filters.minCredit, filters.maxCredit);
  const toggleSort = (key: WalletSortField) => setFilters(prev => ({
    ...prev, page: 1, sortBy: key, sortDir: prev.sortBy === key && prev.sortDir === 'asc' ? 'desc' : 'asc'
  }));
  const params = { 
    page: filters.page, 
    limit: filters.limit, 
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.name ? { name: filters.name } : {}),
    ...(filters.phone ? { phone: filters.phone } : {}),
    ...(filters.minCash ? { minCash: filters.minCash } : {}),
    ...(filters.maxCash ? { maxCash: filters.maxCash } : {}),
    ...(filters.minCredit ? { minCredit: filters.minCredit } : {}),
    ...(filters.maxCredit ? { maxCredit: filters.maxCredit } : {}),
    ...(filters.sortBy ? { sortBy: filters.sortBy, sortDir: filters.sortDir } : {}),
  };

  const { data, isLoading, isError, refetch } = useListManagedWallets(
    params,
    { query: { queryKey: getListManagedWalletsQueryKey(params), enabled: !hasInvalidRange } }
  );

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-300">
      <div className="wallet-filters wallet-account-filters">
        <div className="relative wallet-account-search">
          <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            aria-label="جستجوی نام، موبایل یا شناسه مشتری"
            placeholder="جستجوی نام، موبایل یا شناسه..."
            className="pl-3 pr-9 w-full"
            value={draft.search}
            onChange={(e) => changeDraft('search', e.target.value)}
          />
        </div>
        <label className="wallet-account-field">نام مشتری
          <input type="text" value={draft.name} onChange={e => changeDraft('name', e.target.value)} placeholder="فیلتر نام" />
        </label>
        <label className="wallet-account-field">شماره موبایل
          <input type="text" dir="ltr" value={draft.phone} onChange={e => changeDraft('phone', e.target.value)} placeholder="فیلتر موبایل" />
        </label>
        <div className="wallet-account-field wallet-account-range"><span>موجودی نقدی (تومان)</span>
          <div className="wallet-range-controls"><input type="text" inputMode="numeric" aria-label="حداقل موجودی نقدی" placeholder="از" value={draft.minCash} onChange={e => changeDraft('minCash', e.target.value.replace(/\D/g, '').slice(0, 30))} />
          <input type="text" inputMode="numeric" aria-label="حداکثر موجودی نقدی" placeholder="تا" value={draft.maxCash} onChange={e => changeDraft('maxCash', e.target.value.replace(/\D/g, '').slice(0, 30))} /></div>
        </div>
        <div className="wallet-account-field wallet-account-range"><span>موجودی اعتباری (تومان)</span>
          <div className="wallet-range-controls"><input type="text" inputMode="numeric" aria-label="حداقل موجودی اعتباری" placeholder="از" value={draft.minCredit} onChange={e => changeDraft('minCredit', e.target.value.replace(/\D/g, '').slice(0, 30))} />
          <input type="text" inputMode="numeric" aria-label="حداکثر موجودی اعتباری" placeholder="تا" value={draft.maxCredit} onChange={e => changeDraft('maxCredit', e.target.value.replace(/\D/g, '').slice(0, 30))} /></div>
        </div>
        <button type="button" className="btn btn-ghost !h-9 !px-3 !text-[11px]" onClick={() => { setDraft(emptyWalletFilters); setFilters(prev => ({ ...prev, ...emptyWalletFilters, sortBy: '', sortDir: 'asc', page: 1 })); }}>
          <RotateCcw size={14} className="ml-1" /> حذف فیلترها و ترتیب
        </button>
      </div>

      {hasInvalidRange ? (
        <p role="alert" className="text-red-700 text-sm">حداقل موجودی نباید از حداکثر آن بیشتر باشد.</p>
      ) : isLoading ? (
        <SkeletonPanel rows={5} />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <div className="wallet-table-container">
          <div className="overflow-x-auto">
            <table className="wallet-table">
              <thead>
                <tr>
                  {walletColumns.map(({ key, label }) => <th key={key} aria-sort={filters.sortBy === key ? filters.sortDir === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <button type="button" className="wallet-sort-button" onClick={() => toggleSort(key)} title={`مرتب‌سازی بر اساس ${label}`}>
                      {label}{filters.sortBy !== key ? <ArrowUpDown size={13} /> : filters.sortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                    </button>
                  </th>)}
                  {isAdmin && <th>عملیات ویژه</th>}
                </tr>
              </thead>
              <tbody>
                {data?.items?.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 5 : 4} className="text-center py-12 text-slate-500">
                      مشتری با کیف پول یافت نشد.
                    </td>
                  </tr>
                ) : (
                  data?.items?.map(wallet => {
                    const salespersonName = (wallet as typeof wallet & { customerSalespersonName?: string | null }).customerSalespersonName;
                    return <tr key={`wallet-${wallet.customerId}`}>
                      <td>
                        <Link href={`/customers/${wallet.customerId}`} className="wallet-customer-link">
                          {wallet.customerName || 'بدون نام'}
                        </Link>
                        <span className="block text-[11px] text-slate-500">کارشناس فروش: {salespersonName || 'بدون تخصیص'}</span>
                      </td>
                      <td className="wallet-num-input text-[12px] font-medium" style={{textAlign: 'right'}}>{wallet.phone}</td>
                      <td>
                        <span className="currency-value">{formatMoney(wallet.cashBalanceToman)}</span>
                        <span className="currency-unit">تومان</span>
                      </td>
                      <td>
                        <span className="currency-value text-teal-700">{formatMoney(wallet.creditBalanceToman)}</span>
                        <span className="currency-unit text-teal-600/70">تومان</span>
                      </td>
                      {isAdmin && (
                        <td>
                          <button 
                            className="btn btn-ghost !h-8 !px-3 !text-[11px]"
                            onClick={() => onTransfer({ id: wallet.customerId, name: wallet.customerName || '', phone: wallet.phone, salespersonName })}
                            title="انتقال موجودی"
                          >
                            <ArrowLeftRight size={13} className="ml-1" /> انتقال
                          </button>
                        </td>
                      )}
                    </tr>;
                  })
                )}
              </tbody>
            </table>
          </div>
          
          {data && data.total > 0 && (
            <div className="wallet-pagination">
              <span className="wallet-pagination-info">
                نمایش {(filters.page - 1) * filters.limit + 1} تا {Math.min(filters.page * filters.limit, data.total)} از {data.total}
              </span>
              <div className="wallet-pagination-controls">
                <button 
                  className="wallet-pagination-btn"
                  disabled={filters.page === 1}
                  onClick={() => setFilters(p => ({ ...p, page: p.page - 1 }))}
                >
                  <ChevronRight size={14} /> قبلی
                </button>
                <button 
                  className="wallet-pagination-btn"
                  disabled={filters.page * filters.limit >= data.total}
                  onClick={() => setFilters(p => ({ ...p, page: p.page + 1 }))}
                >
                  بعدی <ChevronLeft size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TransactionsTab() {
  const [filters, setFilters] = useTableState('transactions.filters', {
    page: 1,
    limit: 20,
    search: '',
    customerId: '',
    actorId: '',
    walletType: '',
    kind: '',
    status: '',
    from: '',
    to: ''
  });

  const [debouncedSearch, setDebouncedSearch] = useTableState('transactions.draftSearch', filters.search);
  const [debouncedCustomerId, setDebouncedCustomerId] = useTableState('transactions.draftCustomerId', filters.customerId);
  const [debouncedActorId, setDebouncedActorId] = useTableState('transactions.draftActorId', filters.actorId);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(prev => {
        if (debouncedSearch !== prev.search || debouncedCustomerId !== prev.customerId || debouncedActorId !== prev.actorId) {
          return { 
            ...prev, 
            search: debouncedSearch, 
            customerId: debouncedCustomerId, 
            actorId: debouncedActorId, 
            page: 1 
          };
        }
        return prev;
      });
    }, 400);
    return () => clearTimeout(t);
  }, [debouncedSearch, debouncedCustomerId, debouncedActorId]);

  const updateFilter = (key: string, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value, page: 1 }));
  };

  const resetFilters = () => {
    setDebouncedSearch('');
    setDebouncedCustomerId('');
    setDebouncedActorId('');
    setFilters({
      page: 1,
      limit: 20,
      search: '',
      customerId: '',
      actorId: '',
      walletType: '',
      kind: '',
      status: '',
      from: '',
      to: ''
    });
  };

  const params: any = { page: filters.page, limit: filters.limit };
  if (filters.search) params.search = filters.search;
  if (filters.customerId) params.customerId = parseInt(filters.customerId, 10);
  if (filters.actorId) params.actorId = parseInt(filters.actorId, 10);
  if (filters.walletType) params.walletType = filters.walletType;
  if (filters.kind) params.kind = filters.kind;
  if (filters.status) params.status = filters.status;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;

  const { data, isLoading, isError, refetch } = useListWalletTransactions(
    params,
    { query: { queryKey: getListWalletTransactionsQueryKey(params) } }
  );

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-300">
      <div className="wallet-filters">
        <div className="relative">
          <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input 
            type="text" 
            placeholder="جستجوی تراکنش..." 
            className="pl-3 pr-9 w-[180px]"
            value={debouncedSearch}
            onChange={(e) => setDebouncedSearch(e.target.value)}
          />
        </div>
        
        <input 
          type="text" 
          inputMode="numeric"
          placeholder="شناسه مشتری" 
          className="w-[120px] wallet-num-input"
          value={debouncedCustomerId}
          onChange={(e) => setDebouncedCustomerId(e.target.value.replace(/\D/g, ''))}
          style={{textAlign: 'right'}}
        />

        <input 
          type="text" 
          inputMode="numeric"
          placeholder="شناسه کاربر/عامل" 
          className="w-[130px] wallet-num-input"
          value={debouncedActorId}
          onChange={(e) => setDebouncedActorId(e.target.value.replace(/\D/g, ''))}
          style={{textAlign: 'right'}}
        />
        
        <select value={filters.walletType} onChange={e => updateFilter('walletType', e.target.value)} className="w-[130px]">
          <option value="">همه کیف پول‌ها</option>
          <option value="cash">نقدی</option>
          <option value="credit">اعتباری</option>
        </select>

        <select value={filters.kind} onChange={e => updateFilter('kind', e.target.value)} className="w-[140px]">
          <option value="">همه انواع عملیات</option>
          <option value="payment">پرداخت (شارژ)</option>
          <option value="loan_credit">اعتبار تسهیلات</option>
          <option value="filing_fee">کسر هزینه تشکیل پرونده</option>
          <option value="goods_purchase">کسر بابت خرید کالا</option>
          <option value="transfer">انتقال</option>
          <option value="legacy">سابقه</option>
        </select>

        <select value={filters.status} onChange={e => updateFilter('status', e.target.value)} className="w-[150px]">
          <option value="">همه وضعیت‌ها</option>
          {Object.entries(txStatusTranslate).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        
        <div className="flex items-center gap-2 border-r border-slate-200 pr-3">
          <span className="text-[11px] text-slate-500 font-bold">از</span>
          <input type="date" value={filters.from} onChange={e => updateFilter('from', e.target.value)} className="w-[115px] font-mono text-[11px]" />
        </div>
        
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 font-bold">تا</span>
          <input type="date" value={filters.to} onChange={e => updateFilter('to', e.target.value)} className="w-[115px] font-mono text-[11px]" />
        </div>

        <button 
          className="btn btn-ghost !h-9 !px-3 !text-[11px] mr-auto"
          onClick={resetFilters}
          title="پاک کردن فیلترها"
        >
          <RotateCcw size={14} className="ml-1" />
          حذف فیلترها
        </button>
      </div>

      {isLoading ? (
        <SkeletonPanel rows={6} />
      ) : isError ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <div className="wallet-table-container">
          <div className="overflow-x-auto">
            <table className="wallet-table">
              <thead>
                <tr>
                  <th>زمان تراکنش</th>
                  <th>مشتری و ارتباط</th>
                  <th>شرح و نوع کیف پول</th>
                  <th>مبلغ</th>
                  <th>وضعیت</th>
                  <th>توضیحات و خطا</th>
                  <th>عامل سیستم</th>
                </tr>
              </thead>
              <tbody>
                {data?.items?.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-slate-500">
                      تراکنشی با این مشخصات یافت نشد.
                    </td>
                  </tr>
                ) : (
                  data?.items?.map(tx => {
                    const isOutgoing = String(tx.amountToman).startsWith('-');
                    const txOwnerNames = tx as typeof tx & { customerSalespersonName?: string | null; otherCustomerSalespersonName?: string | null };
                    return (
                      <tr key={`${tx.kind}-${tx.recordId}`}>
                        <td className="text-[11px] text-slate-500 font-mono" dir="ltr" style={{textAlign: 'right'}}>
                          {formatDateTime(tx.createdAt)}
                        </td>
                        <td>
                          <div className="flex flex-col gap-1.5">
                            <Link href={`/customers/${tx.customerId}`} className="wallet-customer-link text-[12px]">
                              {tx.customerName || `مشتری ${tx.customerId}`}
                            </Link>
                            <span className="text-[10px] text-slate-500">کارشناس فروش: {txOwnerNames.customerSalespersonName || 'بدون تخصیص'}</span>
                            
                            {tx.kind === 'transfer' && tx.otherCustomerName ? (
                              <div className="text-[10px] text-slate-600 bg-slate-50 p-1 px-2 rounded-md border border-slate-100 w-fit font-bold">
                                {isOutgoing ? (
                                  <>مبدأ: {tx.customerName}{txOwnerNames.customerSalespersonName ? ` (${txOwnerNames.customerSalespersonName})` : ''} <ArrowLeftRight size={10} className="inline mx-1 text-slate-400" /> مقصد: <Link href={`/customers/${tx.otherCustomerId}`} className="hover:text-nafiss-blue transition-colors">{tx.otherCustomerName}</Link>{txOwnerNames.otherCustomerSalespersonName ? ` (${txOwnerNames.otherCustomerSalespersonName})` : ''}</>
                                ) : (
                                  <>مبدأ: <Link href={`/customers/${tx.otherCustomerId}`} className="hover:text-nafiss-blue transition-colors">{tx.otherCustomerName}</Link>{txOwnerNames.otherCustomerSalespersonName ? ` (${txOwnerNames.otherCustomerSalespersonName})` : ''} <ArrowLeftRight size={10} className="inline mx-1 text-slate-400" /> مقصد: {tx.customerName}{txOwnerNames.customerSalespersonName ? ` (${txOwnerNames.customerSalespersonName})` : ''}</>
                                )}
                              </div>
                            ) : tx.otherCustomerName ? (
                              <div className="text-[10px] text-slate-500 flex items-center gap-1 bg-slate-50 py-0.5 px-1.5 rounded w-fit border border-slate-100">
                                <Link href={`/customers/${tx.otherCustomerId}`} className="text-slate-600 hover:text-nafiss-blue transition-colors">
                                  {tx.otherCustomerName}
                                </Link>
                                {txOwnerNames.otherCustomerSalespersonName && <span> · کارشناس فروش: {txOwnerNames.otherCustomerSalespersonName}</span>}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <div className="flex flex-col gap-1 items-start">
                            <span className={`wallet-status-badge kind-${tx.kind}`}>
                              {kindTranslate[tx.kind] || tx.kind}
                            </span>
                            <span className="text-[10px] text-slate-500 mr-1 font-bold">
                              کیف {walletTypeTranslate[tx.walletType] || tx.walletType}
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="currency-value" dir="ltr" style={{display:'inline-block'}}>{formatMoney(tx.amountToman)}</span>
                          <span className="currency-unit mr-1">تومان</span>
                        </td>
                        <td>
                          <span className={`wallet-status-badge status-${tx.status}`}>
                            {txStatusTranslate[tx.status] || tx.status}
                          </span>
                        </td>
                        <td className="max-w-[220px]">
                          <div className="truncate text-[11px] leading-relaxed" title={tx.reason || ''}>
                            {tx.reason || '-'}
                          </div>
                          {tx.errorCode && (
                            <div className="text-[10px] text-red-600 mt-1 font-mono bg-red-50 p-1 px-1.5 rounded w-fit border border-red-100" title="کد خطا">
                              {translateError(tx.errorCode)}
                            </div>
                          )}
                        </td>
                        <td className="text-[11px] text-slate-600">
                          {tx.actorName ? (
                            <div className="flex flex-col">
                              <span>{tx.actorName}</span>
                              <span className="text-[9px] text-slate-400 font-mono" dir="ltr" style={{textAlign: 'right'}}>(ID: {tx.actorId})</span>
                            </div>
                          ) : 'نامشخص'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {data && data.total > 0 && (
            <div className="wallet-pagination">
              <span className="wallet-pagination-info">
                نمایش {(filters.page - 1) * filters.limit + 1} تا {Math.min(filters.page * filters.limit, data.total)} از {data.total}
              </span>
              <div className="wallet-pagination-controls">
                <button 
                  className="wallet-pagination-btn"
                  disabled={filters.page === 1}
                  onClick={() => setFilters(p => ({ ...p, page: p.page - 1 }))}
                >
                  <ChevronRight size={14} /> قبلی
                </button>
                <button 
                  className="wallet-pagination-btn"
                  disabled={filters.page * filters.limit >= data.total}
                  onClick={() => setFilters(p => ({ ...p, page: p.page + 1 }))}
                >
                  بعدی <ChevronLeft size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WalletManagement() {
  const [activeTab, setActiveTab] = useTableState<'wallets' | 'transactions' | 'company'>('walletManagement.tab', 'wallets');
  
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey() } });
  const isAdmin = session?.user?.role === 'admin';

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferInitialFrom, setTransferInitialFrom] = useState<CustomerPreselect>(null);

  return (
    <div className="wallet-page">
      <div className="page-intro animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div>
          <h2>مدیریت کیف پول</h2>
          <p>مشاهده موجودی و تراکنش‌های کیف پول مشتریان</p>
        </div>
        {isAdmin && (
          <button 
            className="btn btn-primary"
            onClick={() => {
              setTransferInitialFrom(null);
              setTransferOpen(true);
            }}
          >
            <ArrowLeftRight size={15} />
            انتقال موجودی
          </button>
        )}
      </div>

      <div className="wallet-tabs animate-in fade-in duration-300">
        <button 
          className={`wallet-tab ${activeTab === 'wallets' ? 'active' : ''}`}
          onClick={() => setActiveTab('wallets')}
        >
          کیف پول مشتریان
        </button>
        <button 
          className={`wallet-tab ${activeTab === 'transactions' ? 'active' : ''}`}
          onClick={() => setActiveTab('transactions')}
        >
          فهرست تراکنش‌ها
        </button>
        {isAdmin && <button className={`wallet-tab ${activeTab === 'company' ? 'active' : ''}`} onClick={() => setActiveTab('company')}>کیف پول شرکت نفیس وام</button>}
      </div>

      {activeTab === 'wallets' ? (
        <WalletsTab 
          isAdmin={isAdmin} 
          onTransfer={(customer) => {
            setTransferInitialFrom(customer);
            setTransferOpen(true);
          }} 
        />
      ) : activeTab === 'company' && isAdmin ? (
        <CompanyWalletPanel />
      ) : (
        <TransactionsTab />
      )}

      {transferOpen && (
        <TransferModal 
          onClose={() => setTransferOpen(false)} 
          initialFrom={transferInitialFrom} 
        />
      )}
    </div>
  );
}
