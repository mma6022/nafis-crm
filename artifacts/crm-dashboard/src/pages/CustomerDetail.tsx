import { ArrowRight, Edit3, PhoneCall, Save, Trash2, UserRound, ShieldCheck, RefreshCw, FileText } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, getListCustomerActivityQueryKey, getListCustomersQueryKey, getListSalespersonsQueryKey, getListCustomerCreditChecksQueryKey, useDeleteCustomer, useGetAuthSession, useGetCustomer, useListCustomerActivity, useListSalespersons, useListCustomerCreditChecks, useInitiateCustomerCreditCheck, useValidateCustomerCreditCheck, useRenewCustomerCreditCheckOtp, useRefreshCustomerCreditCheckStatus, useUpdateCustomer, useCreateConsultation, type CustomerUpdateStatus, type ConsultationInput } from '@workspace/api-client-react';
import { ErrorState, formatDate, formatDateTime, initials, Priority, SkeletonPanel, statusLabel } from '@/components/CrmShell';
import { formatPhoneForDisplay } from '@/lib/phone';
import { CreateConsultationForm } from '@/components/Forms';
import { PersianDatePicker } from '@/components/PersianDatePicker';

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
  const [editing, setEditing] = useState(false);
  const [consultationFormOpen, setConsultationFormOpen] = useState(false);
  const createConsult = useCreateConsultation();
  const [form, setForm] = useState<{ name: string; phone: string; nationalCode: string; postalCode: string; birthDateJalali: string; description: string; priority: string; status: CustomerUpdateStatus; salespersonId: string; isUrgent: boolean }>({ name: '', phone: '', nationalCode: '', postalCode: '', birthDateJalali: '', description: '', priority: '', status: 'in_progress', salespersonId: '', isUrgent: false });
  const [nationalCode, setNationalCode] = useState('');
  const [otp, setOtp] = useState('');
  const [creditError, setCreditError] = useState('');
  useEffect(() => {
    if (customer) {
      setForm({ name: customer.name, phone: customer.phone, nationalCode: customer.nationalCode ?? '', postalCode: customer.postalCode ?? '', birthDateJalali: customer.birthDateJalali ?? '', description: customer.description ?? '', priority: customer.priority ? String(customer.priority) : '', status: customer.status, salespersonId: customer.salespersonId ? String(customer.salespersonId) : '', isUrgent: customer.isUrgent ?? false });
      setNationalCode(current => current || customer.nationalCode || '');
    }
  }, [customer]);
  const latestCredit = creditChecks.data?.[0];
  const refreshBoth = () => {
    creditChecks.refetch();
    customerQuery.refetch();
  };

  useEffect(() => {
    if (!latestCredit || (latestCredit.status !== 'processing' && latestCredit.status !== 'awaiting_otp')) return;
    if (latestCredit.status === 'processing') {
      const timer = window.setInterval(() => refreshCredit.mutate({ id, checkId: latestCredit.id }, { onSuccess: refreshBoth }), 10000);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [latestCredit?.id, latestCredit?.status]);
  if (customerQuery.isLoading) return <section><div className="page-intro"><div><h2>پرونده مشتری</h2></div></div><SkeletonPanel rows={5} /></section>;
  if (customerQuery.isError || !customer) return <section><div className="page-intro"><div><h2>پرونده پیدا نشد</h2><p>اطلاعات این مشتری در دسترس نیست.</p></div></div><ErrorState onRetry={() => customerQuery.refetch()} /></section>;
  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id, data: { name: form.name, phone: form.phone, nationalCode: form.nationalCode.trim() || null, postalCode: form.postalCode.trim() || null, birthDateJalali: form.birthDateJalali.trim() || null, description: form.description, priority: form.priority ? Number(form.priority) : null, status: form.status, salespersonId: form.salespersonId ? Number(form.salespersonId) : null, isUrgent: form.isUrgent } }, { onSuccess: () => { setEditing(false); customerQuery.refetch(); } });
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
    <div className="page-intro"><div><Link href="/customers" className="text-link" style={{ display: 'inline-flex', gap: 5, alignItems: 'center', marginBottom: 10 }} data-testid="link-back-customers"><ArrowRight size={14} /> بازگشت به مشتریان</Link><h2>پرونده مشتری</h2><p>جزئیات ارتباط و زمینه مشاوره مالی</p></div><div style={{ display: 'flex', gap: 8 }}>{session.data?.user.role === 'admin' ? <button className="btn btn-danger" onClick={deleteCustomer} disabled={remove.isPending} data-testid="button-delete-customer-detail"><Trash2 size={15} /> {remove.isPending ? 'در حال حذف…' : 'حذف مشتری'}</button> : null}<button className="btn btn-gold" onClick={() => setConsultationFormOpen(true)} data-testid="button-create-consultation"><FileText size={15} /> ثبت درخواست مشاوره</button><button className="btn btn-primary" onClick={() => setEditing(!editing)} data-testid="button-toggle-customer-edit"><Edit3 size={15} /> {editing ? 'بستن ویرایش' : 'ویرایش پرونده'}</button></div></div>
    <div className="detail-grid">
      <div className="profile-card">
        <div className="profile-avatar">{initials(customer.name)}</div>
        <div className="profile-name-block">
          <h3 data-testid="text-customer-name">{customer.name}</h3>
          <div className="customer-tags">
            {customer.isUrgent && <span className="customer-tag customer-tag-urgent">فوری</span>}
            {customer.verificationStatus === 'unverified' && <span className="customer-tag customer-tag-unverified">احراز نشده</span>}
          </div>
        </div><div className="phone" dir="ltr" data-testid="text-customer-phone">{formatPhoneForDisplay(customer.phone)}</div><div className="customer-identifier" data-testid="text-customer-id">شناسه مشتری: #{customer.id.toLocaleString('fa-IR')}</div>
        <div style={{ marginTop: 14 }}><span className={`status-pill ${customer.status === 'completed' ? 'status-active' : customer.status === 'in_progress' ? 'status-new' : 'status-muted'}`}>{statusLabel(customer.status)}</span></div>
        <div className="profile-meta"><div><span>کارشناس فروش</span><strong>{customer.salespersonName || 'بدون تخصیص'}</strong></div><div><span>اولویت</span><Priority value={customer.priority} /></div><div><span>ساخته شده</span><strong>{formatDate(customer.createdAt)}</strong></div><div><span>تعداد فعالیت</span><strong>{(customer.activityCount ?? activity.length).toLocaleString('fa-IR')}</strong></div>{customer.nationalCode && <div><span>کد ملی</span><strong>{customer.nationalCode}</strong></div>}{customer.postalCode && <div><span>کد پستی</span><strong>{customer.postalCode}</strong></div>}{customer.birthDateJalali && <div><span>تاریخ تولد</span><strong dir="ltr" style={{ display: 'inline-block' }}>{customer.birthDateJalali}</strong></div>}{customer.creditRank && <div><span>رتبه اعتباری</span><strong style={{ color: '#99f6e4' }}>{customer.creditRank}</strong></div>}{customer.creditScore != null && <div><span>امتیاز اعتباری</span><strong style={{ color: '#99f6e4' }}>{customer.creditScore}</strong></div>}{customer.creditCheckedAt && <div><span>آخرین استعلام</span><strong style={{ color: '#99f6e4' }}>{formatDate(customer.creditCheckedAt)}</strong></div>}</div>
        <div className="detail-actions"><a className="icon-button" title="تماس با مشتری" href={`tel:${customer.phone}`} data-testid="link-call-customer"><PhoneCall size={16} /></a></div>
      </div>
      {canCreditCheck ? <div className="panel" data-testid="panel-credit-check">
        <div className="panel-head"><div><h3><ShieldCheck size={17} style={{ verticalAlign: 'middle', marginLeft: 6 }} /> استعلام اعتبار آنلاین</h3><p>استعلام مستقیم از سامانه اعتبارسنجی ایران</p></div><RefreshCw size={18} color="#9aa4b3" /></div>
        {creditError ? <div className="error-state" style={{ marginBottom: 12 }}>{creditError}</div> : null}
        {(() => {
          const activeCheck = creditChecks.data?.find(c => c.status === 'processing' || c.status === 'awaiting_otp');

          return (
            <>
              <div className="credit-check-form-wrapper">
                {activeCheck ? (
                  activeCheck.status === 'awaiting_otp' ? (
                    <form onSubmit={(event) => { event.preventDefault(); setCreditError(''); validateCredit.mutate({ id, checkId: activeCheck.id, data: { otp } }, { onSuccess: () => { setOtp(''); refreshBoth(); }, onError: (error) => setCreditError(error instanceof Error ? error.message : 'تأیید رمز انجام نشد.') }); }}>
                      <div className="credit-check-alert"><ShieldCheck /><p style={{ margin: 0 }}>رمز یک‌بارمصرف برای موبایل مشتری ارسال شد.</p></div>
                      <div className="credit-check-row">
                        <div className="field"><label>رمز یک‌بارمصرف</label><input dir="ltr" inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value)} maxLength={8} required data-testid="input-credit-otp" /></div>
                        <button className="btn btn-gold" type="submit" disabled={validateCredit.isPending}>{validateCredit.isPending ? 'در حال بررسی…' : 'تأیید و دریافت گزارش'}</button>
                        <button className="btn btn-ghost" type="button" onClick={() => renewCredit.mutate({ id, checkId: activeCheck.id }, { onSuccess: refreshBoth, onError: (error) => setCreditError(error instanceof Error ? error.message : 'ارسال مجدد انجام نشد.') })} disabled={renewCredit.isPending}>ارسال مجدد</button>
                      </div>
                    </form>
                  ) : (
                    <div className="empty-state" style={{ padding: '24px 10px' }}><RefreshCw className="spin" /><strong>گزارش در حال آماده‌سازی است</strong><p>وضعیت به‌صورت خودکار به‌روزرسانی می‌شود.</p></div>
                  )
                ) : (
                  <form onSubmit={(event) => { event.preventDefault(); setCreditError(''); initiateCredit.mutate({ id, data: { nationalCode } }, { onSuccess: refreshBoth, onError: (error) => { setCreditError(error instanceof Error ? error.message : 'شروع استعلام انجام نشد.'); refreshBoth(); } }); }}>
                    <div className="credit-check-row">
                      <div className="field"><label>کد ملی مشتری</label><input dir="ltr" inputMode="numeric" value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} placeholder="۱۰ رقم" required maxLength={10} data-testid="input-credit-national-code" /></div>
                      <button className="btn btn-gold" type="submit" disabled={initiateCredit.isPending}><ShieldCheck size={15} /> {initiateCredit.isPending ? 'در حال ارسال…' : 'شروع استعلام جدید'}</button>
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
                        <div style={{ color: '#be123c', fontSize: '11px', maxWidth: '150px' }}>{check.errorMessage}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          );
        })()}
      </div> : null}
      {editing ? <div className="panel"><div className="panel-head"><div><h3>ویرایش اطلاعات پایه</h3><p>تغییرات پرونده را ذخیره کنید.</p></div></div><form onSubmit={save}><div className="form-grid"><div className="field"><label>نام مشتری</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-detail-name" /></div><div className="field"><label>شماره تماس</label><input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} data-testid="input-detail-phone" /></div><div className="field"><label>کد ملی</label><input dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => setForm({ ...form, nationalCode: e.target.value })} maxLength={10} data-testid="input-detail-national-code" /></div><div className="field"><label>کد پستی</label><input dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} maxLength={10} data-testid="input-detail-postal-code" /></div><div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => setForm({ ...form, birthDateJalali: v })} testId="input-detail-birth-date" /></div><div className="field"><label>کارشناس فروش</label><select value={form.salespersonId} onChange={(e) => setForm({ ...form, salespersonId: e.target.value })} data-testid="select-detail-salesperson"><option value="">بدون تخصیص</option>{(salespersons.data ?? []).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></div><div className="field"><label>اولویت</label><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} data-testid="select-detail-priority"><option value="">بدون اولویت</option>{[1,2,3].map((value) => <option key={value} value={value}>اولویت {value}</option>)}</select></div><div className="field"><label>وضعیت</label><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CustomerUpdateStatus })} data-testid="select-detail-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div><div className="field full"><label className="boolean-field"><input type="checkbox" checked={form.isUrgent} onChange={(e) => setForm({ ...form, isUrgent: e.target.checked })} data-testid="checkbox-detail-is-urgent" /> <strong>مشتری فوری</strong></label></div><div className="field full"><label>توضیحات</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="textarea-detail-description" /></div></div><div className="form-footer"><button className="btn btn-primary" type="submit" disabled={update.isPending} data-testid="button-save-detail"><Save size={15} /> {update.isPending ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button><button className="btn btn-ghost" type="button" onClick={() => setEditing(false)}>انصراف</button></div></form></div> : <div className="panel"><div className="panel-head"><div><h3>خلاصه پرونده</h3><p>اطلاعات زمینه‌ای ثبت‌شده توسط تیم</p></div><UserRound size={18} color="#9aa4b3" /></div><p style={{ color: '#66738a', fontSize: 13, lineHeight: 2, margin: 0 }}>{customer.description || 'برای این پرونده توضیحی ثبت نشده است.'}</p><div style={{ marginTop: 20, paddingTop: 15, borderTop: '1px solid #edf0f4', display: 'flex', gap: 22, color: '#7b8697', fontSize: 11 }}><span>آخرین فعالیت: <strong style={{ color: '#26395f' }}>{formatDate(customer.lastActivityAt)}</strong></span><span>شناسه پرونده: <strong style={{ color: '#26395f', fontFamily: 'var(--app-font-mono)' }}>#{customer.id}</strong></span></div></div>}
      <div className="panel"><div className="panel-head"><div><h3>خط زمانی ارتباط</h3><p>تماس‌ها و یادداشت‌های کارشناسان</p></div><PhoneCall size={18} color="#9aa4b3" /></div>{activityQuery.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div> : activity.length ? <div className="timeline">{activity.map((item) => <div className="timeline-item" key={item.id}><h4>{item.subject || 'تماس با مشتری'}</h4><p>{item.customerRequest || 'درخواست مشتری ثبت نشده است.'}{item.expertNotes ? ` — ${item.expertNotes}` : ''}</p><time>{item.salespersonName || 'کارشناس تیم'} · {formatDateTime(item.createdAt)}</time></div>)}</div> : <div className="empty-state"><PhoneCall /><strong>هنوز فعالیتی ثبت نشده</strong><p>بعد از اولین تماس، خط زمانی اینجا شکل می‌گیرد.</p></div>}</div>
    </div>
    {consultationFormOpen && (
      <CreateConsultationForm
        customers={[customer]}
        initialCustomerId={customer.id}
        pending={createConsult.isPending}
        onClose={() => setConsultationFormOpen(false)}
        onSave={(data) => {
          createConsult.mutate({ data }, {
            onSuccess: () => {
              setConsultationFormOpen(false);
              setLocation('/consultations');
            }
          });
        }}
      />
    )}
  </section>;
}
