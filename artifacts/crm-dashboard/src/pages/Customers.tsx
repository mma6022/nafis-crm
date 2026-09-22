import { ChevronLeft, ChevronRight, Edit3, Hash, Plus, Search, UserRound, LayoutList, Kanban, PhoneCall, FileText, Trash2, Palette, Save, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type UIEvent } from 'react';
import { Link } from 'wouter';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getListCustomersQueryKey, getListSalespersonsQueryKey, listCustomers, useGetAuthSession, useListCustomers, useListSalespersons, useUpdateCustomer, useUpdateAuthProfile, useDeleteCustomer, useCreateCall, useCreateConsultation, getListCallsQueryKey, getListConsultationsQueryKey, getListRemindersQueryKey, type Customer, type CallInput, type ConsultationInput, type ListCustomersParams } from '@workspace/api-client-react';
import { CustomerForm } from '@/components/CustomerForm';
import { CallForm, CreateConsultationForm } from '@/components/Forms';
import { ErrorState, formatDate, SkeletonPanel } from '@/components/CrmShell';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { Modal } from '@/components/DataTools';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { formatPhoneForDisplay } from '@/lib/phone';

export default function Customers() {
  const queryClient = useQueryClient();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session.data?.user.role === 'admin';
  const isSalesperson = session.data?.user.customerScope === 'assigned';
  const priorityColors = {
    none: session.data?.user.priorityColors?.none ?? '#fff7d6',
    '1': session.data?.user.priorityColors?.['1'] ?? '#fee2e2',
    '2': session.data?.user.priorityColors?.['2'] ?? '#ffedd5',
    '3': session.data?.user.priorityColors?.['3'] ?? '#dcfce7',
  };
  const [view, setView] = useState<'table' | 'board'>('table');
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [status, setStatus] = useState('in_progress');
  const [priority, setPriority] = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minCallCount, setMinCallCount] = useState('');
  const [maxCallCount, setMaxCallCount] = useState('');
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [newCallFor, setNewCallFor] = useState<Customer | null>(null);
  const [newConsultFor, setNewConsultFor] = useState<Customer | null>(null);
  const [colorSettingsOpen, setColorSettingsOpen] = useState(false);

  const isBoard = view === 'board';
  
  const pHasPriority = priority === 'null' ? false : undefined;
  const pPriority = priority && priority !== 'null' ? Number(priority) : undefined;
  const sharedParams = useMemo(() => ({
    search: search || undefined,
    customerId: customerId ? Number(customerId) : undefined,
    salespersonId: salespersonId ? Number(salespersonId) : undefined,
    dateFrom: jalaliValueToGregorian(dateFrom),
    dateTo: jalaliValueToGregorian(dateTo),
    minCallCount: minCallCount ? Number(minCallCount) : undefined,
    maxCallCount: maxCallCount ? Number(maxCallCount) : undefined,
  }), [search, customerId, salespersonId, dateFrom, dateTo, minCallCount, maxCallCount]);

  const params = useMemo(() => ({
    ...sharedParams,
    status: status || undefined,
    priority: pPriority,
    hasPriority: pHasPriority,
    limit: pageSize,
    offset,
  } as ListCustomersParams), [sharedParams, status, pPriority, pHasPriority, pageSize, offset]);
  
  const customers = useListCustomers(params, { query: { queryKey: getListCustomersQueryKey(params), enabled: !isBoard } });
  const salespersons = useListSalespersons({ query: { queryKey: getListSalespersonsQueryKey(), staleTime: 60_000 } });
  
  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();
  const createCall = useCreateCall();
  const createConsult = useCreateConsultation();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    queryClient.invalidateQueries({ queryKey: ['board-customers'] });
    queryClient.invalidateQueries({ queryKey: ['calls-customers'] });
    queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
  };

  const handleSaveCall = async (data: CallInput) => {
    try {
      await createCall.mutateAsync({ data });
      setNewCallFor(null);
      invalidateAll();
    } catch {
      // Mutation error state is rendered in the modal area below.
    }
  };

  const handleSaveConsult = (data: ConsultationInput) => {
    createConsult.mutate({ data }, { onSuccess: () => { setNewConsultFor(null); invalidateAll(); } });
  };

  const page = customers.data;
  const updateInlineCustomer = (
    customer: Customer,
    patch: { priority?: number | null; status?: 'in_progress' | 'cancelled' | 'completed' },
  ) => {
    const queryKey = getListCustomersQueryKey(params);
    const previous = queryClient.getQueryData<typeof page>(queryKey);
    queryClient.setQueryData<typeof page>(queryKey, (current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === customer.id ? { ...item, ...patch } : item),
    } : current);
    updateCustomer.mutate(
      { id: customer.id, data: patch },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData<typeof page>(queryKey, (current) => current ? {
            ...current,
            items: current.items.map((item) => item.id === saved.id ? saved : item),
          } : current);
          void queryClient.invalidateQueries({ queryKey: ['board-customers'] });
          void queryClient.invalidateQueries({ queryKey, exact: true });
        },
        onError: () => queryClient.setQueryData(queryKey, previous),
      },
    );
  };
  const pageCount = Math.max(1, Math.ceil((page?.total ?? 0) / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;
  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (customer: Customer) => { setEditing(customer); setFormOpen(true); };
  const removeCustomer = (customer: Customer) => {
    if (!window.confirm(`مشتری «${customer.name}» و تمام تماس‌ها و مشاوره‌های مرتبط برای همیشه حذف شوند؟ این عملیات قابل بازگشت نیست.`)) return;
    deleteCustomer.mutate({ id: customer.id }, { onSuccess: invalidateAll });
  };

  const priorityColumns = [
    { value: null, label: 'بدون اولویت' },
    { value: 1, label: 'اولویت ۱' },
    { value: 2, label: 'اولویت ۲' },
    { value: 3, label: 'اولویت ۳' },
  ];

  return <section>
    <div className="page-intro">
      <div>
        <div className="eyebrow">پایگاه ارتباط با مشتری</div>
        <h2>فهرست مشتریان</h2>
        <p>{!isBoard && page?.total ? `${page.total.toLocaleString('fa-IR')} پرونده، آماده برای پیگیری دقیق` : 'پرونده‌ها را جست‌وجو و مدیریت کنید.'}</p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ display: 'flex', background: '#f1f5f9', padding: '4px', borderRadius: '12px', gap: '4px' }}>
          <button className={`view-toggle-btn ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')} data-testid="btn-view-table"><LayoutList size={15}/> جدول</button>
          <button className={`view-toggle-btn ${view === 'board' ? 'active' : ''}`} onClick={() => setView('board')} data-testid="btn-view-board"><Kanban size={15}/> بورد</button>
        </div>
        <button className="btn btn-primary" onClick={openCreate} data-testid="button-create-customer"><Plus size={17} /> مشتری جدید</button>
         <button className="btn btn-ghost" onClick={() => setColorSettingsOpen(true)} data-testid="button-open-priority-colors"><Palette size={16} /> رنگ اولویت‌ها</button>
      </div>
    </div>
    
    <div className="toolbar" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', alignItems: 'center' }}>
      <div className="customer-search-row">
        <div className="searchbar">
          <Search />
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="نام یا شماره تماس مشتری" aria-label="جستجوی نام یا شماره تماس مشتری" data-testid="input-search-customers" />
        </div>
        <div className="searchbar customer-id-search">
          <Hash />
          <input type="number" min="1" step="1" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setOffset(0); }} placeholder="شناسه مشتری" aria-label="جستجو بر اساس شناسه مشتری" data-testid="input-search-customer-id" />
        </div>
      </div>
      {view === 'table' && (
        <select className="select-control" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} aria-label="فیلتر وضعیت" data-testid="select-filter-status">
          <option value="">همه وضعیت‌ها</option>
          <option value="in_progress">در حال انجام</option>
          <option value="cancelled">لغو شده</option>
          <option value="completed">اتمام</option>
        </select>
      )}
      {view === 'table' ? <select className="select-control" value={priority} onChange={(e) => { setPriority(e.target.value); setOffset(0); }} aria-label="فیلتر اولویت" data-testid="select-filter-priority">
        <option value="">همه اولویت‌ها</option>
        <option value="null">بدون اولویت</option>
        {[1, 2, 3].map((value) => <option value={value} key={value}>اولویت {value}</option>)}
      </select> : null}
      {!isSalesperson ? <select className="select-control" value={salespersonId} onChange={(e) => { setSalespersonId(e.target.value); setOffset(0); }} aria-label="فیلتر کارشناس" data-testid="select-filter-salesperson">
        <option value="">همه کارشناسان</option>
        {(salespersons.data ?? []).map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
      </select> : null}
      <PersianDatePicker value={dateFrom} onChange={(value) => { setDateFrom(value); setOffset(0); }} placeholder="از تاریخ شمسی" testId="input-filter-date-from" />
      <PersianDatePicker value={dateTo} onChange={(value) => { setDateTo(value); setOffset(0); }} placeholder="تا تاریخ شمسی" testId="input-filter-date-to" />
      <input type="number" min="0" className="select-control" value={minCallCount} onChange={e => { setMinCallCount(e.target.value); setOffset(0); }} placeholder="حداقل تماس" aria-label="حداقل تماس" title="حداقل تماس" data-testid="input-filter-min-calls" />
      <input type="number" min="0" className="select-control" value={maxCallCount} onChange={e => { setMaxCallCount(e.target.value); setOffset(0); }} placeholder="حداکثر تماس" aria-label="حداکثر تماس" title="حداکثر تماس" data-testid="input-filter-max-calls" />
    </div>
    {updateCustomer.isError ? <div className="profile-form-error" data-testid="error-update-customer">تغییر وضعیت یا اولویت ذخیره نشد. دوباره تلاش کنید.</div> : null}

    {!isBoard && customers.isLoading ? <SkeletonPanel rows={6} /> : !isBoard && customers.isError ? <ErrorState onRetry={() => customers.refetch()} /> : (
      <>
        {view === 'table' ? (
          <div className="customer-table-wrap">
            {page?.items?.length ? (
              <table className="customer-table">
                <thead><tr><th>مشتری</th><th>وضعیت</th><th>اولویت</th><th>تعداد تماس</th><th>کارشناس</th><th>آخرین فعالیت</th><th>عملیات</th></tr></thead>
                <tbody>
                  {page.items.map((customer) => (
                    <tr key={customer.id} style={{ backgroundColor: priorityColors[String(customer.priority ?? 'none') as keyof typeof priorityColors] }} data-testid={`row-customer-${customer.id}`}>
                      <td>
                        <Link href={`/customers/${customer.id}`} style={{ textDecoration: 'none' }} data-testid={`link-customer-${customer.id}`}>
                          <span className="customer-name">{customer.name}</span>
                          <span className="customer-tags customer-tags-table">
                            {customer.isUrgent && <span className="customer-tag customer-tag-urgent">فوری</span>}
                            {customer.verificationStatus === 'unverified' && <span className="customer-tag customer-tag-unverified">احراز نشده</span>}
                          </span>
                          <span className="customer-phone-display" dir="ltr">{formatPhoneForDisplay(customer.phone)}</span>
                          <span className="customer-sub"><bdi>شناسه #{customer.id.toLocaleString('fa-IR')}</bdi></span>
                        </Link>
                      </td>
                      <td>
                         <select 
                           className={`inline-select status-pill ${customer.status === 'in_progress' ? 'status-new' : customer.status === 'completed' ? 'status-active' : 'status-muted'}`}
                           value={customer.status}
                            onChange={(e) => updateInlineCustomer(customer, { status: e.target.value as 'in_progress' | 'cancelled' | 'completed' })}
                           data-testid={`select-inline-status-${customer.id}`}
                         >
                           <option value="in_progress">در حال انجام</option>
                           <option value="cancelled">لغو شده</option>
                           <option value="completed">اتمام</option>
                         </select>
                      </td>
                      <td>
                         <select 
                           className="inline-select"
                           style={{ fontWeight: 700, color: customer.priority ? 'var(--ink-deep)' : '#94a3b8' }}
                           value={customer.priority ? String(customer.priority) : 'null'}
                            onChange={(e) => updateInlineCustomer(customer, { priority: e.target.value === 'null' ? null : Number(e.target.value) })}
                           data-testid={`select-inline-priority-${customer.id}`}
                         >
                           <option value="null">بدون اولویت</option>
                           <option value="1">اولویت ۱</option>
                           <option value="2">اولویت ۲</option>
                           <option value="3">اولویت ۳</option>
                         </select>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="board-col-count">{customer.activityCount} تماس</span>
                      </td>
                      <td>{customer.salespersonName || 'بدون تخصیص'}</td>
                      <td>{formatDate(customer.lastActivityAt || customer.createdAt)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <button className="row-action" title="ثبت تماس" onClick={() => setNewCallFor(customer)} data-testid={`button-new-call-${customer.id}`}><PhoneCall size={15} /></button>
                            <button className="row-action" title="ثبت درخواست مشاوره" onClick={() => setNewConsultFor(customer)} data-testid={`button-new-consult-${customer.id}`}><FileText size={15} /></button>
                           <button className="row-action" title="ویرایش مشتری" onClick={() => openEdit(customer)} data-testid={`button-edit-customer-${customer.id}`}><Edit3 size={15} /></button>
                           {isAdmin ? <button className="row-action danger" title="حذف مشتری" disabled={deleteCustomer.isPending} onClick={() => removeCustomer(customer)} data-testid={`button-delete-customer-${customer.id}`}><Trash2 size={15} /></button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">
                <UserRound />
                <strong>مشتری‌ای پیدا نشد</strong>
                <p>فیلترها را تغییر دهید یا اولین پرونده را بسازید.</p>
                <button className="btn btn-gold" style={{ marginTop: 15 }} onClick={openCreate} data-testid="button-empty-create-customer">
                  <Plus size={15} /> افزودن مشتری
                </button>
              </div>
            )}
            {page?.items?.length ? (
              <div className="pagination">
                <div className="page-size-control">
                  <span>نمایش</span>
                  <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setOffset(0); }} data-testid="select-page-size">
                    {[10, 25, 50].map((size) => <option key={size} value={size}>{size.toLocaleString('fa-IR')}</option>)}
                  </select>
                  <span>مورد در هر صفحه</span>
                </div>
                <span>{page.total.toLocaleString('fa-IR')} پرونده · صفحه {currentPage.toLocaleString('fa-IR')} از {pageCount.toLocaleString('fa-IR')}</span>
                <div className="pagination-actions">
                  <button className="page-btn" disabled={currentPage === 1} onClick={() => setOffset(Math.max(0, offset - pageSize))} aria-label="صفحه قبل" data-testid="button-previous-page"><ChevronRight size={16} /></button>
                  {paginationItems(currentPage, pageCount).map((item, index) => item === 'ellipsis'
                    ? <span className="pagination-ellipsis" key={`ellipsis-${index}`}>…</span>
                    : <button key={item} className={`page-btn ${item === currentPage ? 'active' : ''}`} onClick={() => setOffset((item - 1) * pageSize)} aria-label={`صفحه ${item}`} data-testid={`button-page-${item}`}>{item.toLocaleString('fa-IR')}</button>)}
                  <button className="page-btn" disabled={currentPage === pageCount} onClick={() => setOffset(offset + pageSize)} aria-label="صفحه بعد" data-testid="button-next-page"><ChevronLeft size={16} /></button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="board-grid">
            {priorityColumns.map((column) => <BoardColumn key={String(column.value)} column={column} color={priorityColors[String(column.value ?? 'none') as keyof typeof priorityColors]} filters={sharedParams} onCall={setNewCallFor} onConsult={setNewConsultFor} onEdit={openEdit} onDelete={isAdmin ? removeCustomer : undefined} onMove={(id, priorityValue) => updateCustomer.mutate({ id, data: { priority: priorityValue } }, { onSuccess: invalidateAll })} />)}
          </div>
        )}
      </>
    )}
    
    <CustomerForm open={formOpen} customer={editing} salespersons={salespersons.data ?? []} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); invalidateAll(); }} />
    {newCallFor && <CallForm customers={[newCallFor]} salespersons={salespersons.data ?? []} pending={createCall.isPending} error={createCall.isError} initialCustomerId={newCallFor.id} onClose={() => setNewCallFor(null)} onSave={handleSaveCall} />}
    {newConsultFor && <CreateConsultationForm customers={[newConsultFor]} pending={createConsult.isPending} initialCustomerId={newConsultFor.id} onClose={() => setNewConsultFor(null)} onSave={handleSaveConsult} />}
    {colorSettingsOpen && session.data?.user ? (
      <PriorityColorsModal
        colors={priorityColors}
        onClose={() => setColorSettingsOpen(false)}
      />
    ) : null}
  </section>;
}

function PriorityColorsModal({ colors, onClose }: {
  colors: { none: string; '1': string; '2': string; '3': string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(colors);
  const update = useUpdateAuthProfile();
  useEffect(() => setForm(colors), [colors]);
  const defaults = { none: '#fff7d6', '1': '#fee2e2', '2': '#ffedd5', '3': '#dcfce7' };
  const options = [
    ['none', 'بدون اولویت'],
    ['1', 'اولویت ۱'],
    ['2', 'اولویت ۲'],
    ['3', 'اولویت ۳'],
  ] as const;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { data: { priorityColors: form } },
      {
        onSuccess: (nextSession) => {
          queryClient.setQueryData(getGetAuthSessionQueryKey(), nextSession);
          onClose();
        },
      },
    );
  };
  return (
    <Modal title="رنگ اولویت‌ها" eyebrow="تنظیمات شخصی شما" onClose={onClose} testId="priority-colors">
      <form onSubmit={submit}>
        <p style={{ color: '#64748b', marginTop: 0 }}>رنگ سطرهای جدول و کارت‌های بورد را برای حساب خودتان انتخاب کنید.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: 12 }}>
          {options.map(([key, label]) => (
            <label key={key} style={{ display: 'grid', gap: 8, padding: 14, borderRadius: 12, border: '1px solid #e2e8f0', background: form[key] }}>
              <strong>{label}</strong>
              <input type="color" value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} data-testid={`input-popup-priority-color-${key}`} style={{ width: '100%', height: 40 }} />
            </label>
          ))}
        </div>
        {update.isError ? <div className="profile-form-error" style={{ marginTop: 14 }}>ذخیره رنگ‌ها انجام نشد.</div> : null}
        <div className="form-footer">
          <button className="btn btn-primary" type="submit" disabled={update.isPending} data-testid="button-save-popup-priority-colors"><Save size={15} />{update.isPending ? 'در حال ذخیره…' : 'ذخیره رنگ‌ها'}</button>
          <button className="btn btn-ghost" type="button" onClick={() => setForm(defaults)}><RotateCcw size={14} /> پیش‌فرض</button>
        </div>
      </form>
    </Modal>
  );
}

function BoardColumn({ column, color, filters, onCall, onConsult, onEdit, onDelete, onMove }: {
  column: { value: number | null; label: string };
  color: string;
  filters: Omit<ListCustomersParams, 'priority' | 'hasPriority' | 'limit' | 'offset' | 'status'>;
  onCall: (customer: Customer) => void;
  onConsult: (customer: Customer) => void;
  onEdit: (customer: Customer) => void;
  onDelete?: (customer: Customer) => void;
  onMove: (id: number, priority: number | null) => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ['board-customers', column.value, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listCustomers({
      ...filters,
      status: 'in_progress',
      priority: column.value ?? undefined,
      hasPriority: column.value === null ? false : undefined,
      offset: pageParam,
      limit: pageParam === 0 ? 15 : 5,
    }),
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
  const customers = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 100 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  };

  return <div
    className="board-column"
    onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add('drag-over'); }}
    onDragLeave={(event) => event.currentTarget.classList.remove('drag-over')}
    onDrop={(event) => {
      event.preventDefault();
      event.currentTarget.classList.remove('drag-over');
      const id = Number(event.dataTransfer.getData('customerId'));
      if (id) onMove(id, column.value);
    }}
    data-testid={`board-column-${column.value}`}
  >
    <div className="board-col-header">
      {column.label}
      <span className="board-col-count">{total.toLocaleString('fa-IR')}</span>
    </div>
    <div className="board-col-cards" onScroll={onScroll} data-testid={`board-scroll-${column.value}`}>
      {query.isLoading ? <div className="board-loading">در حال بارگذاری…</div> : query.isError ? <button className="btn btn-ghost" onClick={() => query.refetch()}>تلاش دوباره</button> : customers.length ? customers.map((customer) => (
        <div key={customer.id} className="board-card" style={{ backgroundColor: color }} draggable onDragStart={(event) => event.dataTransfer.setData('customerId', String(customer.id))} data-testid={`board-card-${customer.id}`}>
          <div className="board-card-name">
            <Link href={`/customers/${customer.id}`} className="board-customer-link">
              <span className="board-customer-name">{customer.name}</span>
              <span className="customer-tags">
                {customer.isUrgent && <span className="customer-tag customer-tag-urgent">فوری</span>}
                {customer.verificationStatus === 'unverified' && <span className="customer-tag customer-tag-unverified">احراز نشده</span>}
              </span>
            </Link>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onCall(customer)} title="تماس"><PhoneCall size={12} /></button>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onConsult(customer)} title="مشاوره"><FileText size={12} /></button>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onEdit(customer)} title="ویرایش مشتری" data-testid={`button-board-edit-customer-${customer.id}`}><Edit3 size={12} /></button>
              {onDelete ? <button className="row-action danger" style={{ padding: 2 }} onClick={() => onDelete(customer)} title="حذف مشتری" data-testid={`button-board-delete-customer-${customer.id}`}><Trash2 size={12} /></button> : null}
            </div>
          </div>
          <div className="board-card-phone" dir="ltr">{formatPhoneForDisplay(customer.phone)}</div>
          <div className="board-card-id"><bdi>شناسه #{customer.id.toLocaleString('fa-IR')}</bdi></div>
          <div className="board-card-meta">
            <span>{customer.salespersonName || 'بدون تخصیص'}</span>
            <span className="board-col-count">{customer.activityCount} تماس</span>
          </div>
        </div>
      )) : <div className="board-empty">مشتری‌ای در این ستون نیست.</div>}
      {query.isFetchingNextPage ? <div className="board-loading">در حال دریافت ۵ مورد بعدی…</div> : null}
    </div>
    <div className="board-column-pagination">
      <span>{customers.length.toLocaleString('fa-IR')} از {total.toLocaleString('fa-IR')}</span>
      <span>{query.hasNextPage ? 'برای ادامه اسکرول کنید' : 'انتهای فهرست'}</span>
    </div>
  </div>;
}

function paginationItems(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1].filter((page) => page >= 1 && page <= total));
  const sorted = [...pages].sort((a, b) => a - b);
  const result: Array<number | 'ellipsis'> = [];
  sorted.forEach((page, index) => {
    if (index && page - sorted[index - 1] > 1) result.push('ellipsis');
    result.push(page);
  });
  return result;
}
