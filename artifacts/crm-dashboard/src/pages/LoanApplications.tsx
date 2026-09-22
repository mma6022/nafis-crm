import { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { 
  useListLoanApplications, 
  useListCustomers, 
  useListLoanPlans, 
  useCreateLoanApplication, 
  useDeleteLoanApplication,
  getListLoanApplicationsQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  type LoanApplication,
  type LoanApplicationInput,
  type Customer,
  type LoanPlan,
} from '@workspace/api-client-react';
import { Plus, Search, Filter, Trash2, ArrowLeft, Clock, FileText, CheckCircle, XCircle } from 'lucide-react';
import { SkeletonPanel, ErrorState, formatDate } from '@/components/CrmShell';
import { Modal, EmptyState } from '@/components/DataTools';

const STAGE_LABELS: Record<string, string> = {
  draft: 'پیش‌نویس',
  primary_contract_pending_signature: 'امضای قرارداد اصلی',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  collateral_review: 'بررسی وثیقه',
  expert_approval: 'تأیید کارشناس',
  admin_approval: 'تأیید مدیریت',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل شده',
};

const STATUS_LABELS: Record<string, string> = {
  requested: 'درخواست شده',
  reviewing: 'در حال بررسی',
  approved: 'تأیید شده',
  rejected: 'رد شده',
};

const STATUS_STYLES: Record<string, string> = {
  requested: 'status-new',
  reviewing: 'status-active',
  approved: 'status-active',
  rejected: 'status-failed',
};

export default function LoanApplications() {
  const queryClient = useQueryClient();

  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const canCreate = user?.role === 'admin' || user?.permissions?.includes('loan_applications.create');
  const canDelete = user?.role === 'admin' || user?.permissions?.includes('loan_applications.delete');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<LoanApplication | null>(null);

  // Parse status and stage from a combined filter
  const isStageFilter = STAGE_LABELS[statusFilter] !== undefined;
  const statusParam = isStageFilter ? undefined : statusFilter || undefined;
  const stageParam = isStageFilter ? statusFilter : undefined;

  const queryParams = {
    limit: 100,
    search: search || undefined,
    status: statusParam,
    stage: stageParam,
    planId: planFilter ? Number(planFilter) : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  } as any;

  const { data: appsPage, isLoading, isError, refetch } = useListLoanApplications(
    queryParams, 
    { query: { queryKey: getListLoanApplicationsQueryKey(queryParams) } }
  );
  
  const { data: plansData } = useListLoanPlans({ active: true });
  const plans = plansData || [];

  const deleteMutation = useDeleteLoanApplication({
    mutation: {
      onSuccess: () => {
        setDeleteConfirm(null);
        queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
      }
    }
  });

  const apps = appsPage?.items || [];

  return (
    <section className="data-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">جریان کار</div>
          <h2>درخواست‌های تسهیلات</h2>
          <p>مدیریت جامع پرونده‌های مالی مشتریان از درخواست تا پرداخت.</p>
        </div>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
            <Plus size={16} /> ثبت درخواست جدید
          </button>
        )}
      </div>

      <div className="toolbar" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
          <div className="searchbar" style={{ flex: 1 }}>
            <Search size={16} />
            <input 
              type="search" 
              placeholder="جستجوی نام مشتری یا شماره پرونده..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)} 
            />
          </div>
          <select className="select-control" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">همه وضعیت‌ها و مراحل</option>
            <optgroup label="وضعیت">
              <option value="requested">درخواست شده</option>
              <option value="reviewing">در حال بررسی</option>
              <option value="approved">تأیید شده</option>
              <option value="rejected">رد شده</option>
            </optgroup>
            <optgroup label="مرحله">
              {Object.entries(STAGE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </optgroup>
          </select>
          <select className="select-control" value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
            <option value="">همه طرح‌ها</option>
            {plans.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 10, width: '100%', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#475569' }}>از تاریخ:</span>
          <input type="date" className="select-control" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span style={{ fontSize: 12, color: '#475569' }}>تا تاریخ:</span>
          <input type="date" className="select-control" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {isLoading ? <SkeletonPanel rows={6} /> : isError ? <ErrorState onRetry={() => refetch()} /> : (
        <div className="customer-table-wrap">
          <table className="customer-table">
            <thead>
              <tr>
                <th>پرونده / مشتری</th>
                <th>طرح تسهیلاتی</th>
                <th>مبلغ درخواستی</th>
                <th>وضعیت / مرحله</th>
                <th>تاریخ‌ها</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {apps.length > 0 ? apps.map(app => (
                <tr key={app.id}>
                  <td>
                    <Link href={`/loan-applications/${app.id}`} style={{ textDecoration: 'none' }}>
                      <strong className="customer-name" style={{ color: 'var(--nafiss-blue)', display: 'block', fontSize: 13 }}>
                        {app.customerName || 'مشتری ناشناس'}
                      </strong>
                      <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'var(--font-mono)' }}>
                        پرونده #{app.id}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span style={{ fontWeight: 600, color: '#334155' }}>{app.planName || 'بدون طرح'}</span>
                    {app.durationMonths && <span style={{ display: 'block', fontSize: 10, color: '#64748b' }}>{app.durationMonths} ماهه</span>}
                  </td>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      {Number(app.requestedAmount).toLocaleString('fa-IR')} ریال
                    </span>
                    {app.approvedAmount && (
                      <span style={{ display: 'block', fontSize: 10, color: '#0f766e' }}>
                        مصوب: {Number(app.approvedAmount).toLocaleString('fa-IR')}
                      </span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <span className={`status-pill ${STATUS_STYLES[app.status] || 'status-muted'}`}>
                        {STATUS_LABELS[app.status] || app.status}
                      </span>
                      {app.stage && (
                        <span style={{ fontSize: 10, color: '#475569', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>
                          {STAGE_LABELS[app.stage] || app.stage}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, color: '#64748b' }}>ثبت: {formatDate(app.createdAt)}</span>
                      {app.updatedAt && app.updatedAt !== app.createdAt && (
                        <span style={{ fontSize: 11, color: '#475569' }}>به‌روزرسانی: {formatDate(app.updatedAt)}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Link href={`/loan-applications/${app.id}`} className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }}>
                        مشاهده و بررسی
                      </Link>
                      {canDelete && (
                        <button 
                          className="btn btn-ghost" 
                          style={{ padding: '0 8px', height: 32, color: '#be123c' }}
                          onClick={() => setDeleteConfirm(app)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title="درخواستی یافت نشد" description="با فیلترهای فعلی هیچ درخواست تسهیلاتی پیدا نشد." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {wizardOpen && <CreateWizard onClose={() => setWizardOpen(false)} />}
      
      {deleteConfirm && (
        <Modal title="حذف درخواست تسهیلات" onClose={() => setDeleteConfirm(null)} testId="delete-confirm-modal">
          <div style={{ padding: '10px 0 20px', color: '#475569', fontSize: 13, lineHeight: 1.6 }}>
            آیا از حذف پرونده شماره {deleteConfirm.id} متعلق به {deleteConfirm.customerName} اطمینان دارید؟ پرونده پنهان شده اما سوابق حقوقی و مالی آن به صورت امن در سیستم حفظ می‌شود.
          </div>
          <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setDeleteConfirm(null)} disabled={deleteMutation.isPending}>انصراف</button>
            <button 
              className="btn" 
              style={{ background: '#be123c', color: '#fff' }} 
              onClick={() => deleteMutation.mutate({ id: deleteConfirm.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'در حال حذف...' : 'حذف پرونده'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function CreateWizard({ onClose }: { onClose: () => void }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  
  const { data: customersData } = useListCustomers({ limit: 50 }, { query: { queryKey: ['wizard-customers', search] } }); 
  
  const [planId, setPlanId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  
  const { data: plans } = useListLoanPlans({ active: true });

  const createMutation = useCreateLoanApplication({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
        setLocation(`/loan-applications/${data.id}`);
        onClose();
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId || !planId || !amount || !duration) return;
    createMutation.mutate({
      data: {
        customerId,
        planIds: [planId],
        planId,
        requestedAmount: amount, 
        durationMonths: Number(duration),
      }
    });
  };

  const filteredCustomers = (customersData?.items || []).filter(c => c.name.includes(search) || c.phone.includes(search));

  return (
    <Modal title="ثبت درخواست جدید" eyebrow={`مرحله ${step} از ۲`} onClose={onClose} testId="create-loan-application-wizard">
      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="searchbar">
            <Search size={16} />
            <input 
              type="text" 
              placeholder="جستجوی مشتری (نام یا موبایل)..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
            {customersData?.items?.map(c => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: customerId === c.id ? '#f8fafc' : '#fff' }}>
                <input type="radio" name="customer" checked={customerId === c.id} onChange={() => setCustomerId(c.id)} />
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', fontSize: 13, color: 'var(--ink-deep)' }}>{c.name}</strong>
                  <span style={{ fontSize: 11, color: '#64748b' }}>{c.phone} - {c.nationalCode || 'بدون کدملی'}</span>
                </div>
              </label>
            ))}
            {customersData?.items?.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                مشتری یافت نشد.
              </div>
            )}
          </div>
          <div className="form-footer" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-primary" disabled={!customerId} onClick={() => setStep(2)}>مرحله بعد</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="field full">
              <label>انتخاب طرح تسهیلاتی</label>
              <select value={planId || ''} onChange={(e) => setPlanId(Number(e.target.value))} required>
                <option value="">انتخاب کنید...</option>
                {plans?.map(p => (
                  <option key={p.id} value={p.id}>{p.name} (سقف: {p.principalAmount})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>مبلغ درخواستی (ریال)</label>
              <input type="number" required value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" />
            </div>
            <div className="field">
              <label>مدت زمان (تعداد اقساط/ماه)</label>
              <input type="number" required value={duration} onChange={(e) => setDuration(e.target.value)} dir="ltr" min="1" />
            </div>
          </div>
          <div className="form-footer" style={{ marginTop: 24, justifyContent: 'space-between' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}><ArrowLeft size={16} style={{ transform: 'rotate(180deg)' }} /> بازگشت</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={createMutation.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'در حال ثبت...' : 'ثبت درخواست'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
