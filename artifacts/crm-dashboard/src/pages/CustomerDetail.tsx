import { ArrowRight, Edit3, PhoneCall, Phone, Save, Trash2, UserRound, ShieldCheck, RefreshCw, FileText, Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, getGetCustomerWalletPaymentQueryKey, getListCustomerActivityQueryKey, getListCustomerTagsQueryKey, getListCustomersQueryKey, getListConsultationsQueryKey, getListSalespersonsQueryKey, getListCustomerCreditChecksQueryKey, useDeleteCustomer, useGetAuthSession, useGetCustomer, useGetCustomerWalletPayment, useListCustomerActivity, useListCustomerTags, useListSalespersons, useListCustomerCreditChecks, useInitiateCustomerCreditCheck, useValidateCustomerCreditCheck, useRenewCustomerCreditCheckOtp, useRefreshCustomerCreditCheckStatus, useUpdateCustomer, useCreateConsultation, type CustomerUpdateStatus, type ConsultationInput } from '@workspace/api-client-react';
import { ErrorState, formatDate, formatDateTime, initials, Priority, SkeletonPanel, statusLabel } from '@/components/CrmShell';
import { formatPhoneForDisplay } from '@/lib/phone';
import { CreateConsultationForm } from '@/components/Forms';
import { CustomerConsultationStatus } from '@/components/CustomerConsultationStatus';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { WalletPaymentResult } from '@/components/WalletPaymentResult';
import { PaymentReconciliation } from '@/components/PaymentReconciliation';
import { useVoip } from '@/components/voip/VoipProvider';
import { useVoipHistory } from '@/components/voip/voip-api';
import { WalletShareHistory } from '@/components/WalletShareHistory';
import { CustomerPlanWallets } from '@/components/PlanWallets';
import { requestWalletShare } from '@/lib/wallet-share';
import { getListCustomerWalletShareLinksQueryKey } from '@workspace/api-client-react';
import { normalizeDigits, serverFieldErrors, validateIranianMobile, validateIranianNationalCode, validateIranianPostalCode, validateJalaliBirthDate, validateOtp } from '@/lib/customer-field-validation';
import { CustomerTagEditor } from '@/components/CustomerTagEditor';
import { RepeatRequestReview, RepeatRequestTag } from '@/components/RepeatRequestReview';

function inquiryErrorMessage(error: unknown, fallback: string) {
  const typed = error as { data?: { error?: unknown; message?: unknown }; response?: { data?: { error?: unknown; message?: unknown } }; message?: unknown } | null;
  const payload = typed?.data ?? typed?.response?.data;
  if (typeof payload?.message === 'string' && /[\u0600-\u06FF]/.test(payload.message)) return payload.message;
  const code = typeof payload?.error === 'string' ? payload.error : '';
  const messages: Record<string, string> = {
    provider_unavailable: 'سرویس اعتبارسنجی در دسترس نیست. کمی بعد دوباره تلاش کنید.',
    provider_timeout: 'سرویس اعتبارسنجی در زمان مقرر پاسخ نداد.',
    provider_auth_failed: 'اتصال به سرویس اعتبارسنجی ناموفق بود.',
    invalid_otp: 'کد یک‌بارمصرف معتبر نیست.',
    otp_invalid: 'کد یک‌بارمصرف معتبر نیست.',
    national_code_invalid: 'کد ملی واردشده معتبر نیست.',
  };
  if (code) return messages[code] ?? fallback;
  if (typeof typed?.message === 'string' && /[\u0600-\u06FF]/.test(typed.message)) return typed.message;
  return fallback;
}

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const id = Number(params.id);
  const customerQuery = useGetCustomer(id, { query: { queryKey: getGetCustomerQueryKey(id), enabled: Number.isFinite(id) } });
  const activityQuery = useListCustomerActivity(id, { query: { queryKey: getListCustomerActivityQueryKey(id), enabled: Number.isFinite(id) } });
  const salespersons = useListSalespersons({ query: { queryKey: getListSalespersonsQueryKey(), staleTime: 60_000 } });
  const update = useUpdateCustomer();
  const remove = useDeleteCustomer();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canCreditCheck = session.data?.user.role === 'admin' || session.data?.user.permissions?.includes('customers.credit_check') === true;
  const creditChecks = useListCustomerCreditChecks(id, { query: { queryKey: getListCustomerCreditChecksQueryKey(id), enabled: Number.isFinite(id) && canCreditCheck === true } });
  const initiateCredit = useInitiateCustomerCreditCheck();
  const validateCredit = useValidateCustomerCreditCheck();
  const renewCredit = useRenewCustomerCreditCheckOtp();
  const refreshCredit = useRefreshCustomerCreditCheckStatus();
  const customer = customerQuery.data;
  const tagCatalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey() } });
  const [reviewingRepeat, setReviewingRepeat] = useState(false);
  const walletQuery = useQuery<{ cash: { balanceToman: string; ledger: Array<{ amountToman: string; kind: string; createdAt: string }> }; credit: { balanceToman: string; ledger: Array<{ amountToman: string; kind: string; createdAt: string }> } }>({
    queryKey: ['customer-wallet', id],
    enabled: Number.isSafeInteger(id) && ['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || ''),
    queryFn: async () => {
      const response = await fetch(`/api/customers/${id}/wallet`, { credentials: 'include' });
      if (!response.ok) throw new Error('دریافت کیف پول انجام نشد');
      return response.json();
    },
    staleTime: 15_000,
  });
  const [returnedPaymentId, setReturnedPaymentId] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get('paymentIntent');
    if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  });
  const returnedPayment = useGetCustomerWalletPayment(id, returnedPaymentId ?? 0, {
    query: {
      queryKey: getGetCustomerWalletPaymentQueryKey(id, returnedPaymentId ?? 0),
      enabled: returnedPaymentId !== null && Number.isSafeInteger(id) && ['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || ''),
      retry: false,
      staleTime: 0,
      refetchOnWindowFocus: true,
    },
  });
  useEffect(() => {
    if (returnedPayment.data?.status === 'credited') {
      queryClient.invalidateQueries({ queryKey: ['customer-wallet', id] });
    }
  }, [returnedPayment.data?.status, id, queryClient]);
  const closePaymentResult = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('paymentIntent');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    setReturnedPaymentId(null);
  };
  const [cashAmount, setCashAmount] = useState('');
  const [walletError, setWalletError] = useState('');
  const [paymentPending, setPaymentPending] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [shareAmount, setShareAmount] = useState('');
  const [sharePending, setSharePending] = useState(false);
  const [shareSmsSent, setShareSmsSent] = useState(false);
  useEffect(() => {
    setShareLink(''); setShareAmount(''); setShareSmsSent(false); setCashAmount(''); setWalletError('');
  }, [id]);
  const startCashPayment = async () => {
    setWalletError('');
    if (!/^[1-9]\d*$/.test(cashAmount)) { setWalletError('مبلغ معتبر به تومان وارد کنید.'); return; }
    setPaymentPending(true);
    try {
      const response = await fetch(`/api/customers/${id}/wallet/cash-payment`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountToman: cashAmount }),
      });
      const data = await response.json();
      if (!response.ok || !data.paymentUrl) throw new Error(data.error || 'درخواست پرداخت ثبت نشد');
      window.location.assign(data.paymentUrl);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : 'خطا در شروع پرداخت');
      setPaymentPending(false);
    }
  };
  const createWalletShareLink = async () => {
    setWalletError('');
    if (!/^[1-9]\d*$/.test(cashAmount)) { setWalletError('مبلغ معتبر به تومان وارد کنید.'); return; }
    setSharePending(true);
    try {
      const body = await requestWalletShare(id, { amountToman: cashAmount });
      if (!body) return;
      setShareSmsSent(false);
      setShareLink(body.url);
      setShareAmount(String(body.amountToman || cashAmount));
      let token = '';
      try {
        const url = new URL(body.url, window.location.origin);
        token = url.searchParams.get('token') || '';
      } catch {
        throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      }
      if (!token) throw new Error('لینک شارژ ساخته شد، اما ارسال پیامک انجام نشد؛ لینک را کپی و ارسال کنید.');
      const smsResponse = await fetch(`/api/customers/${id}/wallet/share-links/${encodeURIComponent(token)}/send-sms`, {
        method: 'POST',
        credentials: 'include',
      });
      const smsBody = await smsResponse.json().catch(() => ({}));
      if ((!smsResponse.ok && smsBody.error !== 'already_sent') || (smsResponse.ok && smsBody.status !== 'sent' && smsBody.status !== 'already_sent')) {
        throw new Error('لینک شارژ ساخته شد، اما پیامک ارسال نشد یا وضعیت ارسال نامشخص است؛ لینک را کپی و ارسال کنید.');
      }
      setShareSmsSent(true);
    } catch (e) { setWalletError(e instanceof Error ? e.message : 'ساخت لینک شارژ انجام نشد'); }
    finally {
      setSharePending(false);
      void queryClient.invalidateQueries({ queryKey: getListCustomerWalletShareLinksQueryKey(id) });
    }
  };
  const [editing, setEditing] = useState(false);
  const [consultationFormOpen, setConsultationFormOpen] = useState(false);
  const createConsult = useCreateConsultation();
  const [form, setForm] = useState<{ name: string; phone: string; nationalCode: string; postalCode: string; birthDateJalali: string; description: string; priority: string; status: CustomerUpdateStatus; isUrgent: boolean }>({ name: '', phone: '', nationalCode: '', postalCode: '', birthDateJalali: '', description: '', priority: '', status: 'in_progress', isUrgent: false });
  const [salespersonSelection, setSalespersonSelection] = useState('');
  const [salespersonError, setSalespersonError] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [otp, setOtp] = useState('');
  const [creditError, setCreditError] = useState('');
  const [otpError, setOtpError] = useState('');
  const [nationalCodeError, setNationalCodeError] = useState('');
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (customer) {
      setForm({ name: customer.name, phone: customer.phone, nationalCode: customer.nationalCode ?? '', postalCode: customer.postalCode ?? '', birthDateJalali: customer.birthDateJalali ?? '', description: customer.description ?? '', priority: customer.priority ? String(customer.priority) : '', status: customer.status, isUrgent: customer.isUrgent ?? false });
      setSalespersonSelection(customer.salespersonId ? String(customer.salespersonId) : '');
      setNationalCode(current => current || customer.nationalCode || '');
    }
  }, [customer]);
  const latestCredit = creditChecks.data?.[0];
  const refreshBoth = () => {
    creditChecks.refetch();
    customerQuery.refetch();
  };

  const { dial, canCall, connection, call } = useVoip();
  const hasCallsView = session.data?.user.role === 'admin' || session.data?.user.permissions?.includes('calls.view') === true;
  const [historyPage, setHistoryPage] = useState(1);
  const historyQuery = useVoipHistory(historyPage, id, hasCallsView);
  const canDialSystem = connection === 'registered' && canCall && !call;

  useEffect(() => {
    if (!latestCredit || (latestCredit.status !== 'processing' && latestCredit.status !== 'awaiting_otp')) return;
    const checkStatus = () => refreshCredit.mutate({ id, checkId: latestCredit.id }, {
      onSuccess: refreshBoth,
      onError: (error) => setCreditError(inquiryErrorMessage(error, 'به‌روزرسانی وضعیت استعلام اعتبارسنجی انجام نشد.')),
    });
    if (latestCredit.status === 'awaiting_otp') checkStatus();
    const timer = window.setInterval(checkStatus, latestCredit.status === 'processing' ? 10000 : 30000);
    return () => window.clearInterval(timer);
  }, [latestCredit?.id, latestCredit?.status]);
  if (customerQuery.isLoading) return <section><div className="page-intro"><div><h2>پرونده مشتری</h2></div></div><SkeletonPanel rows={5} /></section>;
  if (customerQuery.isError || !customer) return <section><div className="page-intro"><div><h2>پرونده پیدا نشد</h2><p>اطلاعات این مشتری در دسترس نیست.</p></div></div><ErrorState onRetry={() => customerQuery.refetch()} /></section>;
  const save = (event: FormEvent) => {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'نام مشتری را وارد کنید.';
    if (!validateIranianMobile(form.phone)) errors.phone = 'شماره همراه باید با ۰۹ شروع شود و ۱۱ رقم باشد.';
    if (!validateIranianNationalCode(form.nationalCode)) errors.nationalCode = 'کد ملی ۱۰ رقمی معتبر وارد کنید.';
    if (form.postalCode.trim() && !validateIranianPostalCode(form.postalCode)) errors.postalCode = 'کد پستی باید ۱۰ رقم باشد.';
    if (form.birthDateJalali.trim() && !validateJalaliBirthDate(form.birthDateJalali)) errors.birthDateJalali = 'تاریخ تولد شمسی معتبر و در گذشته وارد کنید.';
    setProfileErrors(errors);
    if (Object.keys(errors).length) return;
    update.mutate({ id, data: { name: form.name.trim(), phone: normalizeDigits(form.phone.trim()), nationalCode: normalizeDigits(form.nationalCode.trim()), postalCode: form.postalCode.trim() ? normalizeDigits(form.postalCode.trim()) : null, birthDateJalali: form.birthDateJalali.trim() || null, description: form.description, priority: form.priority ? Number(form.priority) : null, status: form.status, isUrgent: form.isUrgent } }, {
      onSuccess: () => { setEditing(false); setProfileErrors({}); customerQuery.refetch(); },
      onError: (error) => {
        const mapped = serverFieldErrors(error);
        setProfileErrors(current => ({ ...current, ...(Object.keys(mapped).length ? mapped : { _form: inquiryErrorMessage(error, 'ذخیره اطلاعات انجام نشد. دوباره تلاش کنید.') }) }));
      },
    });
  };
  const reassignSalesperson = (event: FormEvent) => {
    event.preventDefault();
    setSalespersonError('');
    if (salespersonSelection === '') {
      update.mutate({ id, data: { salespersonId: null } }, { onSuccess: () => {
        void customerQuery.refetch();
        void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      }, onError: () => setSalespersonError('تغییر کارشناس فروش انجام نشد. دوباره تلاش کنید.') });
      return;
    }
    const selectedId = Number(salespersonSelection);
    const selectedPerson = (salespersons.data ?? []).find((person) => person.id === selectedId);
    if (!Number.isSafeInteger(selectedId) || selectedId <= 0 || !selectedPerson) {
      setSalespersonError('یک کارشناس معتبر از فهرست انتخاب کنید.');
      return;
    }
    update.mutate({ id, data: { salespersonId: selectedId } }, { onSuccess: () => {
      void customerQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    }, onError: () => setSalespersonError('تغییر کارشناس فروش انجام نشد. دوباره تلاش کنید.') });
  };
  const deleteCustomer = () => {
    if (!window.confirm(`مشتری «${customer.name}» و تمام تماس‌ها و مشاوره‌های مرتبط برای همیشه حذف شوند؟ این عملیات قابل بازگشت نیست.`)) return;
    remove.mutate({ id }, { onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      setLocation('/customers');
    } });
  };
  const activity = activityQuery.data ?? customer.activity ?? [];
  return <section>
    {reviewingRepeat && <RepeatRequestReview customer={customer} onClose={() => setReviewingRepeat(false)} />}
    {returnedPaymentId !== null && <WalletPaymentResult
      result={returnedPayment.data}
      loading={returnedPayment.isPending && !returnedPayment.isError}
      error={returnedPayment.isError}
      onRetry={() => returnedPayment.refetch()}
      onClose={closePaymentResult}
    />}
    <div className="page-intro"><div><Link href="/customers" className="text-link" style={{ display: 'inline-flex', gap: 5, alignItems: 'center', marginBottom: 10 }} data-testid="link-back-customers"><ArrowRight size={14} /> بازگشت به مشتریان</Link><h2>پرونده مشتری</h2><p>جزئیات ارتباط و زمینه مشاوره مالی</p></div><div style={{ display: 'flex', gap: 8 }}>{session.data?.user.role === 'admin' ? <button className="btn btn-danger" onClick={deleteCustomer} disabled={remove.isPending} data-testid="button-delete-customer-detail"><Trash2 size={15} /> {remove.isPending ? 'در حال حذف…' : 'حذف مشتری'}</button> : null}<button className="btn btn-gold" onClick={() => setConsultationFormOpen(true)} data-testid="button-create-consultation"><FileText size={15} /> ثبت درخواست مشاوره</button><button className="btn btn-primary" onClick={() => setEditing(!editing)} data-testid="button-toggle-customer-edit"><Edit3 size={15} /> {editing ? 'بستن ویرایش' : 'ویرایش پرونده'}</button></div></div>
    {['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || '') && <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head"><div><h3>کیف پول مشتری</h3><p>موجودی نقدی و اعتبار تسهیلات، به تومان</p></div><button className="btn btn-ghost" onClick={() => walletQuery.refetch()}>به‌روزرسانی</button></div>
      {walletQuery.isLoading ? <p>در حال دریافت موجودی…</p> : walletQuery.isError ? <p role="alert">دریافت کیف پول ممکن نشد. دوباره تلاش کنید.</p> : walletQuery.data && <>
        <div className="metric-grid">
          <div><span className="metric-label">کیف پول نقدی</span><strong className="metric-value">{BigInt(walletQuery.data.cash.balanceToman).toLocaleString('fa-IR')} تومان</strong></div>
          <div><span className="metric-label">کیف پول اعتباری</span><strong className="metric-value">{BigInt(walletQuery.data.credit.balanceToman).toLocaleString('fa-IR')} تومان</strong></div>
        </div>
         <div className="field" style={{ marginTop: 16 }}><label>افزایش موجودی نقدی با پرداخت واقعی زرین‌پال (تومان)</label><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><input type="number" min="1" inputMode="numeric" value={cashAmount} onChange={e => setCashAmount(e.target.value)} placeholder="مبلغ به تومان" /><button className="btn btn-primary" disabled={paymentPending} onClick={startCashPayment}>پرداخت و شارژ نقدی</button><button className="btn btn-gold" disabled={sharePending} onClick={createWalletShareLink}>{sharePending ? 'در حال ارسال…' : shareLink ? 'ساخت لینک تازه برای پرداخت جدید' : 'ارسال لینک شارژ کیف پول'}</button></div></div>
         {shareSmsSent && <p role="status" style={{ color: '#047857' }}>لینک شارژ با پیامک برای مشتری ارسال شد.</p>}
          {shareLink && <div className="wallet-share-link"><span>مبلغ لینک: <strong>{BigInt(shareAmount || '0').toLocaleString('fa-IR')} تومان</strong></span><div><input readOnly dir="ltr" value={shareLink} /><button className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(shareLink)}><Copy size={15} /> کپی</button></div></div>}
        {walletError && <p role="alert" style={{ color: '#be123c' }}>{walletError}</p>}
        <details style={{ marginTop: 16 }}><summary>تراکنش‌های کیف پول</summary>{(['cash', 'credit'] as const).map(type => <div key={type}><h4>{type === 'cash' ? 'نقدی' : 'اعتباری'}</h4>{walletQuery.data![type].ledger.length ? walletQuery.data![type].ledger.map((entry, i) => <p key={i}>{entry.kind === 'transfer_out' ? 'برداشت' : 'واریز'} {BigInt(entry.amountToman).toLocaleString('fa-IR')} تومان · {entry.kind === 'transfer_out' || entry.kind === 'transfer_in' ? 'انتقال بین مشتریان' : entry.kind === 'cash_payment' ? 'شارژ نقدی از درگاه' : entry.kind.startsWith('loan_credit') ? 'شارژ اعتبار تسهیلات' : 'سابقه کیف پول'} · {formatDateTime(entry.createdAt)}</p>) : <p>تراکنشی ثبت نشده است.</p>}</div>)}</details>
      </>}
    </div>}
    {['admin', 'salesperson', 'registrar'].includes(session.data?.user.role || '') && session.data?.user.permissions?.includes('customers.view') && <WalletShareHistory key={id} customerId={id} />}
    <CustomerPlanWallets key={`pw-${id}`} customerId={id} />
    {session.data?.user.role === 'admin' && <PaymentReconciliation customerId={id} returnedPaymentId={returnedPaymentId} />}
     {session.data?.user.role === 'admin' && <div className="panel" style={{ marginBottom: 16 }} data-testid="panel-customer-salesperson-assignment">
       <div className="panel-head"><div><h3>تغییر کارشناس فروش</h3><p>تخصیص این مشتری فقط توسط مدیر سیستم قابل تغییر است.</p></div></div>
       <form onSubmit={reassignSalesperson}>
         <div className="field">
           <label htmlFor="customer-salesperson-reassignment">کارشناس فروش</label>
           <select id="customer-salesperson-reassignment" value={salespersonSelection} onChange={(event) => { setSalespersonSelection(event.target.value); setSalespersonError(''); }} disabled={salespersons.isLoading || salespersons.isError || update.isPending} data-testid="select-customer-salesperson-reassignment">
             <option value="">بدون تخصیص</option>
             {customer.salespersonId && !(salespersons.data ?? []).some((person) => person.id === customer.salespersonId) ? <option value={customer.salespersonId} disabled>{customer.salespersonName || 'کارشناس فعلی'} (در فهرست موجود نیست)</option> : null}
             {(salespersons.data ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
           </select>
         </div>
         {salespersons.isLoading ? <p role="status">در حال دریافت فهرست کارشناسان…</p> : null}
         {salespersons.isError ? <p role="alert">فهرست کارشناسان دریافت نشد. صفحه را تازه‌سازی کنید.</p> : null}
         {salespersonError ? <p role="alert" data-testid="error-customer-salesperson-reassignment">{salespersonError}</p> : null}
         <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={salespersons.isLoading || salespersons.isError || update.isPending} data-testid="button-save-customer-salesperson">{update.isPending ? 'در حال ذخیره…' : 'ذخیره کارشناس'}</button></div>
       </form>
     </div>}
    <CustomerTagEditor customer={customer} />
    <div className="detail-grid">
      <div className="profile-card">
        <div className="profile-avatar">{initials(customer.name)}</div>
        <div className="profile-name-block">
          <h3 data-testid="text-customer-name">{customer.name}</h3>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>کارشناس فروش: {customer.salespersonName || 'بدون تخصیص'}</div>
          <div className="customer-tags">
            {customer.isUrgent && <span className="customer-tag customer-tag-urgent">فوری</span>}
            {customer.verificationStatus === 'unverified' && <span className="customer-tag customer-tag-unverified">احراز نشده</span>}
             {customer.tags.filter(key => key !== 'repeat_request').map(key => <span className="customer-tag" key={key}>{tagCatalog.data?.find(item => item.key === key)?.label ?? key}</span>)}
          </div>
           <RepeatRequestTag customer={customer} onClick={() => setReviewingRepeat(true)} />
        </div><div className="phone" dir="ltr" data-testid="text-customer-phone">{formatPhoneForDisplay(customer.phone)}</div><div className="customer-identifier" data-testid="text-customer-id">شناسه مشتری: #{customer.id.toLocaleString('fa-IR')}</div>
        <div style={{ marginTop: 14 }}><span className={`status-pill ${customer.status === 'completed' ? 'status-active' : customer.status === 'in_progress' ? 'status-new' : 'status-muted'}`}>{statusLabel(customer.status)}</span></div>
        <div className="profile-meta"><div><span>کارشناس فروش</span><strong>{customer.salespersonName || 'بدون تخصیص'}</strong></div><div><span>اولویت</span><Priority value={customer.priority} /></div><div><span>ساخته شده</span><strong>{formatDate(customer.createdAt)}</strong></div><div><span>تعداد فعالیت</span><strong>{(customer.activityCount ?? activity.length).toLocaleString('fa-IR')}</strong></div>{customer.nationalCode && <div><span>کد ملی</span><strong>{customer.nationalCode}</strong></div>}{customer.postalCode && <div><span>کد پستی</span><strong>{customer.postalCode}</strong></div>}{customer.birthDateJalali && <div><span>تاریخ تولد</span><strong dir="ltr" style={{ display: 'inline-block' }}>{customer.birthDateJalali}</strong></div>}{customer.creditRank && <div><span>رتبه اعتباری</span><strong style={{ color: '#99f6e4' }}>{customer.creditRank}</strong></div>}{customer.creditScore != null && <div><span>امتیاز اعتباری</span><strong style={{ color: '#99f6e4' }}>{customer.creditScore}</strong></div>}{customer.creditCheckedAt && <div><span>آخرین استعلام</span><strong style={{ color: '#99f6e4' }}>{formatDate(customer.creditCheckedAt)}</strong></div>}</div>
        <div className="detail-actions">
          <a className="icon-button" title="تماس با موبایل" href={`tel:${customer.phone}`} data-testid="link-call-customer"><PhoneCall size={16} /></a>
          {canCall && (
            <button 
              className="icon-button" 
              title={canDialSystem ? "تماس سیستمی" : "برای تماس سیستمی، ابتدا در بخش تلفن شرکت متصل شوید"} 
              onClick={() => {
                if (canDialSystem) dial(customer.phone);
                else setLocation('/phone');
              }} 
              data-testid="button-sys-call-customer"
            >
              <Phone size={16} color={canDialSystem ? undefined : '#94a3b8'} />
            </button>
          )}
        </div>
      </div>
      {canCreditCheck ? <div className="panel" data-testid="panel-credit-check">
        <div className="panel-head"><div><h3><ShieldCheck size={17} style={{ verticalAlign: 'middle', marginLeft: 6 }} /> استعلام اعتبار آنلاین</h3><p>استعلام مستقیم از سامانه اعتبارسنجی ایران</p></div><RefreshCw size={18} color="#9aa4b3" /></div>
        {creditError ? <div className="error-state" style={{ marginBottom: 12 }}>{creditError}</div> : null}
        {creditChecks.isError ? <div role="alert" className="error-state" style={{ marginBottom: 12 }}>دریافت سابقه استعلام اعتبارسنجی انجام نشد. اتصال سامانه را بررسی و دوباره تلاش کنید.</div> : null}
        {(() => {
          const activeCheck = creditChecks.data?.find(c => c.status === 'processing' || c.status === 'awaiting_otp');

          return (
            <>
              <div className="credit-check-form-wrapper">
                {activeCheck ? (
                  activeCheck.status === 'awaiting_otp' ? (
                    <form noValidate onSubmit={(event) => {
                      event.preventDefault();
                      if (!validateOtp(otp)) { setOtpError('کد یک‌بارمصرف باید بین ۴ تا ۸ رقم باشد.'); return; }
                      setOtpError(''); setCreditError('');
                      validateCredit.mutate({ id, checkId: activeCheck.id, data: { otp: normalizeDigits(otp) } }, {
                        onSuccess: () => { setOtp(''); refreshBoth(); },
                        onError: (error) => { setCreditError(inquiryErrorMessage(error, 'تأیید کد یک‌بارمصرف انجام نشد.')); setOtpError(serverFieldErrors(error).otp ?? ''); },
                      });
                    }}>
                      <div className="credit-check-alert"><ShieldCheck /><p style={{ margin: 0 }}>رمز یک‌بارمصرف برای موبایل مشتری ارسال شد.</p></div>
                      <div className="credit-check-row">
                        <div className="field"><label>رمز یک‌بارمصرف</label><input dir="ltr" inputMode="numeric" value={otp} onChange={(event) => { setOtp(normalizeDigits(event.target.value).replace(/\D/g, '').slice(0, 8)); setOtpError(''); }} maxLength={8} aria-invalid={Boolean(otpError)} data-testid="input-credit-otp" />{otpError && <small role="alert" style={{ color: '#be123c' }} data-testid="error-credit-otp">{otpError}</small>}</div>
                        <button className="btn btn-gold" type="submit" disabled={validateCredit.isPending}>{validateCredit.isPending ? 'در حال بررسی…' : 'تأیید و دریافت گزارش'}</button>
                        <button className="btn btn-ghost" type="button" onClick={() => renewCredit.mutate({ id, checkId: activeCheck.id }, { onSuccess: refreshBoth, onError: (error) => { setCreditError(inquiryErrorMessage(error, 'ارسال مجدد کد یک‌بارمصرف انجام نشد.')); refreshBoth(); } })} disabled={renewCredit.isPending}>ارسال مجدد</button>
                      </div>
                    </form>
                  ) : (
                    <div className="empty-state" style={{ padding: '24px 10px' }}><RefreshCw className="spin" /><strong>گزارش در حال آماده‌سازی است</strong><p>وضعیت به‌صورت خودکار به‌روزرسانی می‌شود.</p></div>
                  )
                ) : (
                  <form noValidate onSubmit={(event) => {
                    event.preventDefault();
                    if (!validateIranianNationalCode(nationalCode)) { setNationalCodeError('کد ملی ۱۰ رقمی معتبر وارد کنید.'); return; }
                    setNationalCodeError('');
                    setCreditError('برای شروع استعلام، ابتدا در ثبت درخواست تسهیلات هزینه ثابت تشکیل پرونده را از کیف پول نقدی پرداخت کنید.');
                  }}>
                    <div className="credit-check-row">
                      <div className="field"><label>کد ملی مشتری</label><input dir="ltr" inputMode="numeric" value={nationalCode} onChange={(event) => { setNationalCode(event.target.value); setNationalCodeError(''); }} placeholder="۱۰ رقم" maxLength={10} aria-invalid={Boolean(nationalCodeError)} data-testid="input-credit-national-code" />{nationalCodeError && <small role="alert" style={{ color: '#be123c' }} data-testid="error-credit-national-code">{nationalCodeError}</small>}</div>
                      <button className="btn btn-gold" type="submit"><ShieldCheck size={15} /> راهنمای شروع استعلام</button>
                    </div>
                  </form>
                )}
              </div>
              {creditChecks.data && creditChecks.data.length > 0 ? (
                <div className="credit-history">
                  {creditChecks.data.map(check => (
                    <div key={check.id} className="credit-history-item">
                      <div className="credit-history-main">
                        <div className="credit-history-title">
                          {check.scoreLabel || 'بدون امتیاز'}
                          <span className={`credit-history-status ${check.status === 'report_generated' ? 'generated' : check.status === 'failed' ? 'failed' : 'pending'}`}>
                            {check.status === 'report_generated' ? 'موفق' : check.status === 'failed' ? 'خطا' : 'در حال انجام'}
                          </span>
                        </div>
                        {check.summary ? <div className="credit-history-meta">{check.summary}</div> : null}
                        <div className="credit-history-meta" style={{ marginTop: 4 }}>
                          {check.status === 'report_generated' ? 'دریافت گزارش' : check.status === 'failed' ? 'آخرین تلاش' : 'آخرین به‌روزرسانی'}: {formatDateTime(check.completedAt || check.updatedAt)}
                        </div>
                      </div>
                      {check.status === 'report_generated' ? (
                        <a className="btn btn-ghost" style={{ padding: '0 12px', minHeight: '34px', fontSize: '11px' }} href={`/api/customers/${id}/credit-checks/${check.id}/report.pdf`} download><FileText size={14} /> دانلود PDF</a>
                      ) : null}
                      {check.status === 'failed' && check.errorMessage ? (
                        <div style={{ color: '#be123c', fontSize: '11px', maxWidth: '150px' }}>{inquiryErrorMessage({ data: { message: check.errorMessage } }, 'استعلام اعتبارسنجی ناموفق بود.')}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          );
        })()}
      </div> : null}
      {editing ? <div className="panel">
        <div className="panel-head"><div><h3>ویرایش اطلاعات پایه</h3><p>تغییرات پرونده را ذخیره کنید.</p></div></div>
        <form noValidate onSubmit={save}>
          <div className="form-grid">
            <div className="field"><label>نام مشتری</label><input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setProfileErrors(current => ({ ...current, name: '' })); }} aria-invalid={Boolean(profileErrors.name)} data-testid="input-detail-name" />{profileErrors.name && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.name}</small>}</div>
            <div className="field"><label>شماره تماس</label><input dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => { setForm({ ...form, phone: e.target.value }); setProfileErrors(current => ({ ...current, phone: '' })); }} aria-invalid={Boolean(profileErrors.phone)} data-testid="input-detail-phone" />{profileErrors.phone && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.phone}</small>}</div>
            <div className="field"><label>کد ملی</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => { setForm({ ...form, nationalCode: e.target.value }); setProfileErrors(current => ({ ...current, nationalCode: '' })); }} maxLength={10} aria-invalid={Boolean(profileErrors.nationalCode)} data-testid="input-detail-national-code" />{profileErrors.nationalCode && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.nationalCode}</small>}</div>
            <div className="field"><label>کد پستی</label><input dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => { setForm({ ...form, postalCode: e.target.value }); setProfileErrors(current => ({ ...current, postalCode: '' })); }} maxLength={10} aria-invalid={Boolean(profileErrors.postalCode)} data-testid="input-detail-postal-code" />{profileErrors.postalCode && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.postalCode}</small>}</div>
            <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => { setForm({ ...form, birthDateJalali: v }); setProfileErrors(current => ({ ...current, birthDateJalali: '' })); }} testId="input-detail-birth-date" birthDate />{profileErrors.birthDateJalali && <small role="alert" style={{ color: '#be123c' }}>{profileErrors.birthDateJalali}</small>}</div>
            <div className="field"><label>اولویت</label><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} data-testid="select-detail-priority"><option value="">بدون اولویت</option>{[1,2,3].map((value) => <option key={value} value={value}>اولویت {value}</option>)}</select></div>
            <div className="field"><label>وضعیت</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CustomerUpdateStatus })} data-testid="select-detail-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div>
            <div className="field full"><label className="boolean-field"><input type="checkbox" checked={form.isUrgent} onChange={(e) => setForm({ ...form, isUrgent: e.target.checked })} data-testid="checkbox-detail-is-urgent" /> <strong>مشتری فوری</strong></label></div>
            <div className="field full"><label>توضیحات</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="textarea-detail-description" /></div>
          </div>
          {profileErrors._form && <div role="alert" className="profile-form-error">{profileErrors._form}</div>}
          <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={update.isPending} data-testid="button-save-detail"><Save size={15} /> {update.isPending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button><button className="btn btn-ghost" type="button" onClick={() => { setEditing(false); setProfileErrors({}); }}>انصراف</button></div>
        </form>
      </div> : <div className="panel"><div className="panel-head"><div><h3>خلاصه پرونده</h3><p>اطلاعات زمینه‌ای ثبت‌شده توسط تیم</p></div><UserRound size={18} color="#9aa4b3" /></div><p style={{ color: '#66738a', fontSize: 13, lineHeight: 2, margin: 0 }}>{customer.description || 'برای این پرونده توضیحی ثبت نشده است.'}</p><div style={{ marginTop: 20, paddingTop: 15, borderTop: '1px solid #edf0f4', display: 'flex', gap: 22, color: '#7b8697', fontSize: 11 }}><span>آخرین فعالیت: <strong style={{ color: '#26395f' }}>{formatDate(customer.lastActivityAt)}</strong></span><span>شناسه پرونده: <strong style={{ color: '#26395f', fontFamily: 'var(--app-font-mono)' }}>#{customer.id}</strong></span></div></div>}
      <div style={{ gridColumn: "1 / -1" }}><CustomerConsultationStatus customerId={id} /></div><div className="panel"><div className="panel-head"><div><h3>خط زمانی ارتباط</h3><p>تماس‌ها و یادداشت‌های کارشناسان</p></div><PhoneCall size={18} color="#9aa4b3" /></div>{activityQuery.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div> : activity.length ? <div className="timeline">{activity.map((item) => <div className="timeline-item" key={item.id}><h4>{item.subject || 'تماس با مشتری'}</h4><p>{item.customerRequest || 'درخواست مشتری ثبت نشده است.'}{item.expertNotes ? ` — ${item.expertNotes}` : ''}</p><time>{item.salespersonName || 'کارشناس تیم'} · {formatDateTime(item.createdAt)}</time></div>)}</div> : <div className="empty-state"><PhoneCall /><strong>هنوز فعالیتی ثبت نشده</strong><p>بعد از اولین تماس، خط زمانی اینجا شکل می‌گیرد.</p></div>}</div>
      {hasCallsView && <div className="panel">
        <div className="panel-head">
          <div>
            <h3>تماس‌های سیستمی</h3>
            <p>سوابق تماس با تلفن شرکت</p>
          </div>
          <Phone size={18} color="#9aa4b3" />
        </div>
        {historyQuery.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div> : 
         historyQuery.isError ? <ErrorState onRetry={() => historyQuery.refetch()} /> : (
          historyQuery.data?.items && historyQuery.data.items.length > 0 ? (
            <>
              <div className="timeline">
                {historyQuery.data.items.map(record => (
                  <div className="timeline-item" key={record.id}>
                    <h4>{record.direction === 'incoming' ? 'تماس ورودی' : 'تماس خروجی'} — {record.status === 'completed' ? 'پاسخ داده شده' : record.status === 'missed' ? 'از دست رفته' : record.status === 'rejected' ? 'رد شده' : record.status === 'failed' ? 'ناموفق' : record.status}</h4>
                    <p>کارشناس: {record.actorName} (داخلی {record.extension})</p>
                    <time>{formatDateTime(record.startedAt)}</time>
                  </div>
                ))}
              </div>
              {historyQuery.data.total > historyQuery.data.limit && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
                  <button className="btn btn-ghost" disabled={historyPage === 1} onClick={() => setHistoryPage(p => p - 1)}>قبلی</button>
                  <button className="btn btn-ghost" disabled={historyPage * historyQuery.data.limit >= historyQuery.data.total} onClick={() => setHistoryPage(p => p + 1)}>بعدی</button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <Phone />
              <strong>بدون تماس سیستمی</strong>
              <p>تا به حال تماس سیستمی با این مشتری ثبت نشده است.</p>
            </div>
          )
        )}
      </div>}
    </div>
    {consultationFormOpen && (
      <CreateConsultationForm
        customers={[customer]}
        initialCustomerId={customer.id}
        pending={createConsult.isPending}
        onClose={() => setConsultationFormOpen(false)}
        onSave={(data) => {
          createConsult.mutate({ data }, {
            onSuccess: (created) => {
              void queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() });
              try { sessionStorage.setItem('nafis-open-matches', String(created.id)); } catch { /* ignore */ }
              setConsultationFormOpen(false);
              setLocation('/consultations');
            }
          });
        }}
      />
    )}
  </section>;
}
