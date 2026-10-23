import { ArrowDown, ArrowUp, ArrowUpDown, Edit3, Eye, FileText, Hash, Kanban, LayoutList, Lock, MoreHorizontal, Palette, Phone, PhoneCall, Plus, RotateCcw, Save, Search, SlidersHorizontal, Trash2, UserRound, UsersRound, X, AlertTriangle, Clock, Smartphone, ShieldCheck, ShieldAlert, Zap, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode, type UIEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getGetCrmSummaryQueryKey, getGetCustomerQueryKey, getListCustomerTagsQueryKey, getListCustomersQueryKey, getListSalespersonsQueryKey, listCustomers, useGetAuthSession, useGetCrmSummary, useListCustomerTags, useListCustomers, useListSalespersons, useUpdateCustomer, useUpdateAuthProfile, useDeleteCustomer, useCreateCall, useCreateConsultation, getListCallsQueryKey, getListConsultationsQueryKey, getListRemindersQueryKey, type Customer, type CallInput, type ConsultationInput, type ListCustomersParams } from '@workspace/api-client-react';
import { CustomerForm } from '@/components/CustomerForm';
import { AdminCustomerPhoneEditor } from '@/components/AdminCustomerPhoneEditor';
import { ManualCustomerIdentity } from '@/components/ManualCustomerIdentity';
import { RepeatRequestReview, RepeatRequestTag } from '@/components/RepeatRequestReview';
import { DuplicateCustomerReview } from '@/components/DuplicateCustomerReview';
import { CallForm, CreateConsultationForm } from '@/components/Forms';
import { formatDateTime } from '@/components/CrmShell';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { Modal } from '@/components/DataTools';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { formatPhoneForDisplay } from '@/lib/phone';
import { removeCompletedAfterCallFromQueue } from '@/components/voip/after-call-cache';
import { useTableState } from '@/hooks/use-table-state';
import { ConfirmDialog, PriorityLabel, Sheet, StatusPill, initialsOf, jalaliDate, relativeTime, useMinWidth } from './customers-ui';
import './customers.css';

const fa = (n: number) => n.toLocaleString('fa-IR');
const faId = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false });
const STATUS_TABS = [
  { value: 'in_progress', label: 'در حال انجام' },
  { value: 'completed', label: 'اتمام' },
  { value: 'cancelled', label: 'لغو شده' },
  { value: '', label: 'همه' },
] as const;
const MOBILE_STEP = 10;

export default function Customers() {
  const queryClient = useQueryClient();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session.data?.user.role === 'admin';
  const [manualIdentity, setManualIdentity] = useState<Customer | null>(null);
  const isSalesperson = session.data?.user.customerScope === 'assigned';
  const permissions = session.data?.user.permissions ?? [];
  // §8: hide actions the role cannot use (the server already enforces the same permissions).
  const can = (permission: string) => isAdmin || permissions.includes(permission);
  const sessionReady = Boolean(session.data?.user);
  const canView = !sessionReady || can('customers.view');
  const canCreate = can('customers.create');
  const canUpdate = can('customers.update');
  const canCall = can('calls.create');
  const canConsult = can('consultations.create');
  const canSummary = can('dashboard.view');
  const readOnly = sessionReady && !canCreate && !canUpdate;
  const priorityColors = {
    none: session.data?.user.priorityColors?.none ?? '#fff7d6',
    '1': session.data?.user.priorityColors?.['1'] ?? '#fee2e2',
    '2': session.data?.user.priorityColors?.['2'] ?? '#ffedd5',
    '3': session.data?.user.priorityColors?.['3'] ?? '#dcfce7',
  };
  const [view, setView] = useTableState<'table' | 'board'>('customers.view', 'table');
  const [search, setSearch] = useTableState('customers.search', '');
  const [customerId, setCustomerId] = useTableState('customers.customerId', '');
  const [status, setStatus] = useTableState('customers.status', 'in_progress');
  const [priority, setPriority] = useTableState('customers.priority', '');
  const [tag, setTag] = useTableState('customers.tag', '');
  const tagCatalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey() } });
  const [reviewing, setReviewing] = useState<Customer | null>(null);
  const [salespersonId, setSalespersonId] = useTableState('customers.salespersonId', '');
  const [dateFrom, setDateFrom] = useTableState('customers.dateFrom', '');
  const [dateTo, setDateTo] = useTableState('customers.dateTo', '');
  const [minCallCount, setMinCallCount] = useTableState('customers.minCallCount', '');
  const [maxCallCount, setMaxCallCount] = useTableState('customers.maxCallCount', '');
  const [offset, setOffset] = useTableState('customers.offset', 0);
  const [pageSize, setPageSize] = useTableState('customers.pageSize', 10);
  const [lastCallSort, setLastCallSort] = useTableState<'asc' | 'desc' | undefined>('customers.lastCallSort', undefined);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [newCallFor, setNewCallFor] = useState<Customer | null>(null);
  const [newConsultFor, setNewConsultFor] = useState<Customer | null>(null);
  const [colorSettingsOpen, setColorSettingsOpen] = useState(false);
  const [duplicateReviewOpen, setDuplicateReviewOpen] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [changingPhone, setChangingPhone] = useState<Customer | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [toast, setToast] = useState('');

  // Desktop (≥1024) shows the table + pager; phones/tablets show cards with «نمایش بیشتر».
  const isDesktop = useMinWidth(1024);
  const [mobileCount, setMobileCount] = useState(MOBILE_STEP);
  // The board is desktop-only and optional (PM decision); the list is the default everywhere else.
  const isBoard = view === 'board' && isDesktop;
  const resetPaging = () => { setOffset(0); setMobileCount(MOBILE_STEP); };

  const pHasPriority = priority === 'null' ? false : undefined;
  const pPriority = priority && priority !== 'null' ? Number(priority) : undefined;
  const sharedParams = useMemo(() => ({
    search: search || undefined,
    tag: tag || undefined,
    customerId: customerId ? Number(customerId) : undefined,
    salespersonId: salespersonId ? Number(salespersonId) : undefined,
    dateFrom: jalaliValueToGregorian(dateFrom),
    dateTo: jalaliValueToGregorian(dateTo),
    minCallCount: minCallCount ? Number(minCallCount) : undefined,
    maxCallCount: maxCallCount ? Number(maxCallCount) : undefined,
  }), [search, tag, customerId, salespersonId, dateFrom, dateTo, minCallCount, maxCallCount]);

  const params = useMemo(() => ({
    ...sharedParams,
    status: status || undefined,
    priority: pPriority,
    hasPriority: pHasPriority,
    limit: isDesktop ? pageSize : mobileCount,
    offset: isDesktop ? offset : 0,
    sortBy: lastCallSort ? 'lastCallAt' : undefined,
    sortDirection: lastCallSort,
  } as ListCustomersParams), [sharedParams, status, pPriority, pHasPriority, pageSize, offset, lastCallSort, isDesktop, mobileCount]);

  const customers = useListCustomers(params, { query: { queryKey: getListCustomersQueryKey(params), enabled: !isBoard && canView, refetchInterval: 30_000, placeholderData: isDesktop ? undefined : keepPreviousData } });
  const salespersons = useListSalespersons({ query: { queryKey: getListSalespersonsQueryKey(), staleTime: 60_000 } });
  // Tab counters (Armita's idea #1) — read-only use of the existing dashboard summary.
  const summary = useGetCrmSummary({ query: { queryKey: getGetCrmSummaryQueryKey(), enabled: canSummary && sessionReady, staleTime: 30_000 } });
  const tabCount = (value: string) => {
    if (!summary.data) return null;
    if (!value) return summary.data.totalCustomers;
    return summary.data.statusCounts.find(item => item.status === value)?.count ?? 0;
  };

  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();
  const createCall = useCreateCall();
  const createConsult = useCreateConsultation();
  const [, setLocation] = useLocation();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    queryClient.invalidateQueries({ queryKey: ['board-customers'] });
    queryClient.invalidateQueries({ queryKey: ['calls-customers'] });
    queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCrmSummaryQueryKey() });
  };

  const handleSaveCall = async (data: CallInput) => {
    try {
      const saved = await createCall.mutateAsync({ data });
      setNewCallFor(null);
      await removeCompletedAfterCallFromQueue(queryClient, { callLogId: saved.id });
      invalidateAll();
    } catch {
      // Mutation error state is rendered in the modal area below.
    }
  };

  const handleSaveConsult = (data: ConsultationInput) => {
    createConsult.mutate({ data }, { onSuccess: (created) => { setNewConsultFor(null); invalidateAll(); try { sessionStorage.setItem('nafis-open-matches', String(created.id)); } catch { /* ignore */ } setLocation('/consultations'); } });
  };

  const page = customers.data;
  const updateInlineCustomer = (
    customer: Customer,
    patch: { priority?: number | null; status?: 'in_progress' | 'cancelled' | 'completed'; salespersonId?: number | null },
  ) => {
    if (updateCustomer.isPending || (patch.salespersonId !== undefined && !isAdmin)) return;
    setInlineError('');
    const queryKey = getListCustomersQueryKey(params);
    const previous = queryClient.getQueryData<typeof page>(queryKey);
    queryClient.setQueryData<typeof page>(queryKey, (current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === customer.id ? { ...item, ...patch,
        ...(patch.salespersonId !== undefined ? { salespersonName: salespersons.data?.find(p => p.id === patch.salespersonId)?.name ?? null } : {}),
      } : item),
    } : current);
    updateCustomer.mutate(
      { id: customer.id, data: patch },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData<typeof page>(queryKey, (current) => current ? {
            ...current,
            items: current.items.map((item) => item.id === saved.id ? saved : item),
          } : current);
          queryClient.setQueryData(getGetCustomerQueryKey(saved.id), saved);
          invalidateAll();
          void queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(saved.id) });
        },
        onError: (error) => {
          queryClient.setQueryData(queryKey, previous);
          setInlineError(error instanceof Error ? error.message : 'تغییر مشتری ذخیره نشد. دوباره تلاش کنید.');
        },
      },
    );
  };
  const pageCount = Math.max(1, Math.ceil((page?.total ?? 0) / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;
  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (customer: Customer) => { setEditing(customer); setFormOpen(true); };
  // The old window.confirm is replaced by an accessible alertdialog (handoff §6/§9); the mutation is unchanged.
  const removeCustomer = (customer: Customer) => { deleteCustomer.reset(); setDeleting(customer); };
  const confirmRemove = () => {
    if (!deleting) return;
    const name = deleting.name;
    deleteCustomer.mutate({ id: deleting.id }, { onSuccess: () => { setDeleting(null); invalidateAll(); setToast(`مشتری «${name}» حذف شد.`); } });
  };
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 4000); return () => window.clearTimeout(t); }, [toast]);

  const priorityColumns = [
    { value: null, label: 'بدون اولویت' },
    { value: 1, label: 'اولویت ۱' },
    { value: 2, label: 'اولویت ۲' },
    { value: 3, label: 'اولویت ۳' },
  ];

  const tagLabel = (key: string) => tagCatalog.data?.find(item => item.key === key)?.label ?? key;
  const salespersonLabel = (id: string) => salespersons.data?.find(p => String(p.id) === id)?.name ?? `کارشناس ${id}`;
  const activeFilters: { key: string; label: ReactNode; clear: () => void }[] = [];
  if (customerId) activeFilters.push({ key: 'id', label: <>کد مشتری {faId(Number(customerId))}</>, clear: () => setCustomerId('') });
  if (priority) activeFilters.push({ key: 'priority', label: priority === 'null' ? 'بدون اولویت' : `اولویت ${fa(Number(priority))}`, clear: () => setPriority('') });
  if (salespersonId && !isSalesperson) activeFilters.push({ key: 'sp', label: salespersonLabel(salespersonId), clear: () => setSalespersonId('') });
  if (tag) activeFilters.push({ key: 'tag', label: tagLabel(tag), clear: () => setTag('') });
  if (dateFrom || dateTo) activeFilters.push({ key: 'date', label: `ثبت ${dateFrom ? `از ${dateFrom}` : ''}${dateFrom && dateTo ? ' ' : ''}${dateTo ? `تا ${dateTo}` : ''}`, clear: () => { setDateFrom(''); setDateTo(''); } });
  if (minCallCount || maxCallCount) activeFilters.push({ key: 'calls', label: `تماس ${minCallCount ? `حداقل ${fa(Number(minCallCount))}` : ''}${minCallCount && maxCallCount ? '، ' : ''}${maxCallCount ? `حداکثر ${fa(Number(maxCallCount))}` : ''}`, clear: () => { setMinCallCount(''); setMaxCallCount(''); } });
  const clearFilters = () => { setCustomerId(''); setPriority(''); if (!isSalesperson) setSalespersonId(''); setTag(''); setDateFrom(''); setDateTo(''); setMinCallCount(''); setMaxCallCount(''); setLastCallSort(undefined); resetPaging(); };
  const hasQuery = Boolean(search) || activeFilters.length > 0;
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const ownSalespersonId = session.data?.user.salespersonId ?? null;

  const callHref = (customer: Customer) => `tel:${customer.phone.replace(/[^\d+]/g, '')}`;
  const tagsFor = (customer: Customer) => <>
    {customer.isUrgent ? <span className="csx-tag warn"><Zap size={14} aria-hidden="true" /> فوری</span> : null}
    {customer.verificationStatus === 'verified' ? <span className="csx-tag ok"><ShieldCheck size={14} aria-hidden="true" /> احراز شده</span> : customer.verificationStatus === 'unverified' ? <span className="csx-tag bad"><ShieldAlert size={14} aria-hidden="true" /> احراز نشده</span> : null}
    {customer.portalOrigin ? <span className="csx-tag info" data-testid="tag-portal-origin"><Smartphone size={14} aria-hidden="true" /> ثبت از پنل مشتریان</span> : null}
    {customer.tags.filter(key => key !== 'repeat_request').map(key => <span className="csx-tag" key={key}>{tagLabel(key)}</span>)}
    <RepeatRequestTag customer={customer} onClick={() => setReviewing(customer)} />
  </>;
  const salespersonCell = (customer: Customer) => customer.salespersonName
    ? <span className="asg"><span className="csx-av" aria-hidden="true">{initialsOf(customer.salespersonName)}</span>{customer.salespersonName}{isSalesperson && customer.salespersonId === ownSalespersonId ? ' (شما)' : ''}</span>
    : <span className="asg"><span className="none">بدون کارشناس</span></span>;

  const legacyActions = (customer: Customer) => {
    const list: ReactNode[] = [];
    if (canCall) list.push(<button key="call" type="button" onClick={() => setNewCallFor(customer)} data-testid={`button-new-call-${customer.id}`}><PhoneCall size={17} aria-hidden="true" /> ثبت تماس</button>);
    if (canConsult) list.push(<button key="consult" type="button" onClick={() => setNewConsultFor(customer)} data-testid={`button-new-consult-${customer.id}`}><FileText size={17} aria-hidden="true" /> درخواست مشاوره</button>);
    if (canUpdate) list.push(<button key="edit" type="button" onClick={() => openEdit(customer)} data-testid={`button-edit-customer-${customer.id}`}><Edit3 size={17} aria-hidden="true" /> ویرایش سریع</button>);
    if (isAdmin) {
      list.push(<button key="mi" type="button" aria-label={`احراز دستی ${customer.name}`} onClick={() => setManualIdentity(customer)} data-testid={`button-manual-identity-${customer.id}`}><ShieldCheck size={17} aria-hidden="true" /> احراز دستی</button>);
      list.push(<button key="ph" type="button" onClick={() => setChangingPhone(customer)} data-testid={`button-change-phone-${customer.id}`}><Smartphone size={17} aria-hidden="true" /> تغییر موبایل</button>);
      list.push(<button key="del" type="button" className="danger" disabled={deleteCustomer.isPending} onClick={() => removeCustomer(customer)} data-testid={`button-delete-customer-${customer.id}`}><Trash2 size={17} aria-hidden="true" /> حذف مشتری</button>);
    }
    return list;
  };

  if (sessionReady && !canView) {
    return <section className="csx" dir="rtl">
      <div className="csx-empty lock" data-testid="customers-denied">
        <div className="big"><Lock size={34} aria-hidden="true" /></div>
        <h2>به فهرست مشتریان دسترسی ندارید</h2>
        <p>این بخش برای نقش شما فعال نیست. اگر فکر می‌کنید باید دسترسی داشته باشید، با مدیر سامانه هماهنگ کنید.</p>
        <div className="acts"><Link href="/" className="csx-primary">بازگشت به داشبورد</Link></div>
      </div>
    </section>;
  }

  const filterBody = <>
    <div className="csx-fgrp" role="radiogroup" aria-label="اولویت" data-testid="select-filter-priority">
      <span className="lbl">اولویت</span>
      <div className="csx-chips">
        {[['', 'همه'], ['1', 'اولویت ۱'], ['2', 'اولویت ۲'], ['3', 'اولویت ۳'], ['null', 'بدون اولویت']].map(([value, label]) => (
          <button key={value || 'all'} type="button" role="radio" className="csx-chip" aria-checked={priority === value} data-p={value && value !== 'null' ? value : undefined} onClick={() => { setPriority(value); resetPaging(); }}>{label}</button>
        ))}
      </div>
    </div>
    {!isSalesperson ? <div className="csx-fld">
      <label htmlFor="csx-f-sp">کارشناس فروش</label>
      <select id="csx-f-sp" className="csx-inp" value={salespersonId} onChange={(e) => { setSalespersonId(e.target.value); resetPaging(); }} data-testid="select-filter-salesperson">
        <option value="">همه کارشناسان</option>
        {(salespersons.data ?? []).map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
      </select>
    </div> : null}
    <div className="csx-fld">
      <label htmlFor="csx-f-tag">برچسب</label>
      <select id="csx-f-tag" className="csx-inp" value={tag} onChange={e => { setTag(e.target.value); resetPaging(); }} disabled={tagCatalog.isLoading || tagCatalog.isError} data-testid="select-filter-customer-tag"><option value="">{tagCatalog.isError ? 'دریافت برچسب‌ها ناموفق بود' : 'همه برچسب‌ها'}</option>{(tagCatalog.data ?? []).map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select>
      {tagCatalog.isError && <button type="button" className="csx-link" onClick={() => void tagCatalog.refetch()}>تلاش دوباره برای برچسب‌ها</button>}
    </div>
    <div className="csx-fgrp">
      <span className="lbl">تاریخ ثبت (شمسی)</span>
      <div className="csx-two">
        <PersianDatePicker value={dateFrom} onChange={(value) => { setDateFrom(value); resetPaging(); }} placeholder="از تاریخ" testId="input-filter-date-from" />
        <PersianDatePicker value={dateTo} onChange={(value) => { setDateTo(value); resetPaging(); }} placeholder="تا تاریخ" testId="input-filter-date-to" />
      </div>
    </div>
    <div className="csx-fgrp">
      <span className="lbl">تعداد تماس</span>
      <div className="csx-two">
        <input type="number" inputMode="numeric" min="0" className="csx-inp" value={minCallCount} onChange={e => { setMinCallCount(e.target.value); resetPaging(); }} placeholder="حداقل" aria-label="حداقل تماس" data-testid="input-filter-min-calls" />
        <input type="number" inputMode="numeric" min="0" className="csx-inp" value={maxCallCount} onChange={e => { setMaxCallCount(e.target.value); resetPaging(); }} placeholder="حداکثر" aria-label="حداکثر تماس" data-testid="input-filter-max-calls" />
      </div>
    </div>
    <div className="csx-fld">
      <label htmlFor="csx-f-id">کد مشتری</label>
      <div className="csx-idsearch"><Hash size={18} aria-hidden="true" /><input id="csx-f-id" type="number" inputMode="numeric" min="1" step="1" value={customerId} onChange={(e) => { setCustomerId(e.target.value); resetPaging(); }} placeholder="مثلاً ۲۳۱۸" aria-label="جستجو بر اساس شناسه مشتری" data-testid="input-search-customer-id" /></div>
    </div>
    <div className="csx-fgrp" role="radiogroup" aria-label="ترتیب">
      <span className="lbl">ترتیب</span>
      <div className="csx-chips">
        <button type="button" role="radio" className="csx-chip" aria-checked={!lastCallSort} onClick={() => { setLastCallSort(undefined); resetPaging(); }}>پیش‌فرض</button>
        <button type="button" role="radio" className="csx-chip" aria-checked={lastCallSort === 'desc'} onClick={() => { setLastCallSort('desc'); resetPaging(); }}>آخرین تماس (جدیدترین)</button>
        <button type="button" role="radio" className="csx-chip" aria-checked={lastCallSort === 'asc'} onClick={() => { setLastCallSort('asc'); resetPaging(); }}>آخرین تماس (قدیمی‌ترین)</button>
      </div>
    </div>
  </>;

  const statusLabel = STATUS_TABS.find(t => t.value === status)?.label ?? '';
  const emptyState = () => {
    if (hasQuery) return <div className="csx-empty" data-testid="customers-no-results">
      <div className="big"><Search size={34} aria-hidden="true" /></div>
      <h2>مشتری‌ای پیدا نشد</h2>
      <p>{search ? <>برای «<bdi>{search}</bdi>»{activeFilters.length ? ' با فیلترهای فعلی' : ''} نتیجه‌ای نبود. املای نام یا شماره را بررسی کنید.</> : 'با این فیلترها نتیجه‌ای نبود.'}</p>
      <div className="acts">
        {activeFilters.length ? <button type="button" className="csx-ghost" onClick={clearFilters}>پاک کردن فیلترها</button> : null}
        {search ? <button type="button" className="csx-ghost" onClick={() => { setSearch(''); resetPaging(); }}>پاک کردن جستجو</button> : null}
        {canCreate ? <button type="button" className="csx-primary" onClick={openCreate} data-testid="button-empty-create-customer"><Plus size={18} aria-hidden="true" /> ثبت مشتری جدید</button> : null}
      </div>
    </div>;
    if (status && (summary.data?.totalCustomers ?? 1) > 0) return <div className="csx-empty" data-testid="customers-empty-tab">
      <div className="big"><UserRound size={34} aria-hidden="true" /></div>
      <h2>مشتری‌ای در «{statusLabel}» نیست</h2>
      <p>تب «همه» را ببینید یا وضعیت دیگری را انتخاب کنید.</p>
      <div className="acts"><button type="button" className="csx-ghost" onClick={() => { setStatus(''); resetPaging(); }}>نمایش همه</button>
        {canCreate ? <button type="button" className="csx-primary" onClick={openCreate} data-testid="button-empty-create-customer"><Plus size={18} aria-hidden="true" /> ثبت مشتری جدید</button> : null}</div>
    </div>;
    if (isSalesperson) return <div className="csx-empty" data-testid="customers-empty">
      <div className="big"><UserRound size={34} aria-hidden="true" /></div>
      <h2>هنوز مشتری‌ای به شما تخصیص داده نشده</h2>
      <p>وقتی مدیر مشتری‌ای را به شما تخصیص دهد، اینجا نمایش داده می‌شود.</p>
      {canCreate ? <div className="acts"><button type="button" className="csx-primary" onClick={openCreate} data-testid="button-empty-create-customer"><Plus size={18} aria-hidden="true" /> ثبت مشتری جدید</button></div> : null}
    </div>;
    return <div className="csx-empty" data-testid="customers-empty">
      <div className="big"><UserRound size={34} aria-hidden="true" /></div>
      <h2>هنوز مشتری‌ای ثبت نشده</h2>
      <p>اولین مشتری را ثبت کنید؛ درخواست‌های سایت و پنل مشتریان هم خودکار اینجا می‌آیند.</p>
      {canCreate ? <div className="acts"><button type="button" className="csx-primary" onClick={openCreate} data-testid="button-empty-create-customer"><Plus size={18} aria-hidden="true" /> ثبت اولین مشتری</button></div> : null}
    </div>;
  };

  const sortIcon = lastCallSort === 'asc' ? <ArrowUp size={15} /> : lastCallSort === 'desc' ? <ArrowDown size={15} /> : <ArrowUpDown size={15} />;

  return <section className="csx" dir="rtl" data-testid="page-customers">
    <h1 className="csx-sr">مشتریان</h1>
    <div className="csx-top">
      <div className="csx-bar">
        <label className="csx-search">
          <Search size={20} aria-hidden="true" />
          <span className="csx-sr">جستجوی نام یا شماره تماس مشتری</span>
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); resetPaging(); }} placeholder={isDesktop ? 'نام یا شماره تماس مشتری' : 'نام یا شماره تماس'} aria-label="جستجوی نام یا شماره تماس مشتری" data-testid="input-search-customers" />
        </label>
        {!isDesktop ? <button type="button" className="csx-fbtn" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog" data-testid="button-open-filters"><SlidersHorizontal size={20} aria-hidden="true" /> فیلتر{activeFilters.length ? <span className="n">{fa(activeFilters.length)}</span> : null}</button> : null}
        {canCreate ? <button type="button" className={isDesktop ? 'csx-primary' : 'csx-primary csx-fab'} onClick={openCreate} data-testid="button-create-customer"><Plus size={20} aria-hidden="true" /> مشتری جدید</button> : null}
      </div>
      {!isBoard ? <div className="csx-tabs" role="tablist" aria-label="وضعیت پیگیری" data-testid="select-filter-status">
        {STATUS_TABS.map(tab => {
          const n = canSummary ? tabCount(tab.value) : null;
          return <button key={tab.value || 'all'} type="button" role="tab" className="csx-tab" aria-selected={status === tab.value} data-s={tab.value || undefined} onClick={() => { setStatus(tab.value); resetPaging(); }} data-testid={`tab-status-${tab.value || 'all'}`}>
            {tab.value ? <span className="dot" aria-hidden="true" /> : null}{tab.label}
            {canSummary ? <span className="n" aria-label={n == null ? 'در حال شمارش' : `${fa(n)} مشتری`}>{n == null ? '…' : fa(n)}</span> : null}
          </button>;
        })}
      </div> : <p className="csx-meta" style={{ padding: '0 16px 12px', margin: 0 }}>نمای بورد فقط مشتریان «در حال انجام» را بر اساس اولویت نشان می‌دهد؛ کارت‌ها را برای تغییر اولویت بکشید.</p>}
    </div>

    {readOnly ? <div className="csx-note warn" role="note"><Eye size={20} aria-hidden="true" /><p>دسترسی شما «فقط مشاهده» است؛ ثبت، ویرایش و تماس غیرفعال است.</p></div>
      : isSalesperson ? <div className="csx-note" role="note"><UserRound size={20} aria-hidden="true" /><p>فقط مشتریانی که به شما تخصیص داده شده‌اند نمایش داده می‌شوند.</p></div> : null}

    <div className="csx-tools">
      {isDesktop ? <button type="button" className="csx-fbtn" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog" data-testid="button-open-filters"><SlidersHorizontal size={20} aria-hidden="true" /> فیلتر{activeFilters.length ? <span className="n">{fa(activeFilters.length)}</span> : null}</button> : null}
      {!isBoard ? <p className="csx-cnt" aria-live="polite">{customers.isLoading ? 'در حال دریافت…' : `${fa(total)} مشتری`}{isDesktop ? ' · به‌روزرسانی خودکار هر ۳۰ ثانیه' : ''}</p> : null}
      <span className="grow" />
      {isDesktop ? <div className="csx-viewseg" role="group" aria-label="نوع نمایش">
        <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')} data-testid="btn-view-table"><LayoutList size={17} aria-hidden="true" /> فهرست</button>
        <button type="button" className={view === 'board' ? 'active' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')} data-testid="btn-view-board"><Kanban size={17} aria-hidden="true" /> بورد</button>
      </div> : null}
      {isAdmin ? <button type="button" className="csx-ghost sm" onClick={() => setDuplicateReviewOpen(true)} data-testid="button-open-duplicate-customers"><UsersRound size={17} aria-hidden="true" /> ادغام تکراری‌ها</button> : null}
      <button type="button" className="csx-ghost sm" onClick={() => setColorSettingsOpen(true)} data-testid="button-open-priority-colors" aria-label="رنگ اولویت‌ها"><Palette size={17} aria-hidden="true" />{isDesktop ? ' رنگ اولویت‌ها' : ''}</button>
    </div>

    {activeFilters.length || lastCallSort ? <div className="csx-activef" aria-label="فیلترهای فعال">
      {activeFilters.map(f => <span key={f.key} className="csx-chip" aria-pressed="true">{f.label}<button type="button" className="rm" aria-label={`حذف فیلتر ${typeof f.label === 'string' ? f.label : ''}`.trim()} onClick={() => { f.clear(); resetPaging(); }}><X size={15} aria-hidden="true" /></button></span>)}
      {lastCallSort ? <span className="csx-chip" aria-pressed="true">{lastCallSort === 'desc' ? 'آخرین تماس (جدیدترین)' : 'آخرین تماس (قدیمی‌ترین)'}<button type="button" className="rm" aria-label="حذف ترتیب" onClick={() => { setLastCallSort(undefined); resetPaging(); }}><X size={15} aria-hidden="true" /></button></span> : null}
      {activeFilters.length > 1 ? <button type="button" className="csx-link" onClick={clearFilters}>پاک کردن همه</button> : null}
    </div> : null}

    {inlineError ? <div className="csx-note bad" role="alert" data-testid="error-update-customer"><AlertTriangle size={20} aria-hidden="true" /><p>{inlineError}</p></div> : null}

    {isBoard ? <div className="board-grid">
      {priorityColumns.map((column) => <BoardColumn key={String(column.value)} column={column} color={priorityColors[String(column.value ?? 'none') as keyof typeof priorityColors]} filters={sharedParams} tagLabels={tagCatalog.data ?? []} onReview={setReviewing} onCall={setNewCallFor} onConsult={setNewConsultFor} onEdit={openEdit} onManualIdentity={isAdmin ? setManualIdentity : undefined} onDelete={isAdmin ? removeCustomer : undefined} onMove={(id, priorityValue) => updateCustomer.mutate({ id, data: { priority: priorityValue } }, { onSuccess: invalidateAll })} />)}
    </div> : customers.isLoading ? (
      isDesktop ? <div className="csx-sktable" aria-busy="true" aria-label="در حال دریافت فهرست مشتریان" data-testid="customers-loading">{Array.from({ length: 7 }, (_, i) => <div className="row" key={i}><span className="csx-sk" /><span className="csx-sk" /><span className="csx-sk" /><span className="csx-sk" /><span className="csx-sk" /></div>)}</div>
        : <div className="csx-skcards" aria-busy="true" aria-label="در حال دریافت فهرست مشتریان" data-testid="customers-loading">{Array.from({ length: 3 }, (_, i) => <div className="csx-skcard" key={i}><span className="csx-sk" style={{ width: '45%' }} /><span className="csx-sk" style={{ width: '70%', height: 22 }} /><span className="csx-sk" style={{ width: '55%' }} /><span className="csx-sk" style={{ height: 52 }} /></div>)}</div>
    ) : customers.isError ? (
      <div className="csx-empty err" role="alert" data-testid="customers-error">
        <div className="big"><AlertTriangle size={34} aria-hidden="true" /></div>
        <h2>فهرست مشتریان دریافت نشد</h2>
        <p>ارتباط با سرور برقرار نشد. اینترنت را بررسی کنید و دوباره تلاش کنید؛ اگر ادامه داشت با پشتیبانی فنی هماهنگ کنید.</p>
        <div className="acts"><button type="button" className="csx-primary" onClick={() => customers.refetch()} disabled={customers.isFetching}><RotateCcw size={18} aria-hidden="true" /> {customers.isFetching ? 'در حال تلاش…' : 'تلاش دوباره'}</button></div>
      </div>
    ) : !items.length ? emptyState() : isDesktop ? (
      <>
        <div className="csx-tablewrap">
          <table className="csx-table">
            <caption className="csx-sr">فهرست مشتریان</caption>
            <thead><tr>
              <th scope="col">مشتری</th><th scope="col">موبایل</th><th scope="col">وضعیت</th><th scope="col">اولویت</th><th scope="col">کارشناس فروش</th>
              <th scope="col" aria-sort={lastCallSort === 'asc' ? 'ascending' : lastCallSort === 'desc' ? 'descending' : 'none'}>
                <button type="button" className="sortbtn" data-testid="button-sort-last-call" title={lastCallSort === 'desc' ? 'مرتب‌سازی از قدیمی‌ترین تماس' : 'مرتب‌سازی از جدیدترین تماس'} onClick={() => { setLastCallSort(current => current === 'desc' ? 'asc' : 'desc'); resetPaging(); }}>آخرین تماس {sortIcon}</button>
              </th>
              <th scope="col" className="col-reg">ثبت</th><th scope="col"><span className="csx-sr">عملیات</span></th>
            </tr></thead>
            <tbody>
              {items.map((customer) => {
                const extra = legacyActions(customer);
                return <tr key={customer.id} className={customer.isUrgent || customer.pendingRepeatRequestCount > 0 ? 'hl' : ''} data-testid={`row-customer-${customer.id}`}>
                  <td>
                    <div className="nm"><Link href={`/customers/${customer.id}`} data-testid={`link-customer-${customer.id}`}>{customer.name}</Link></div>
                    <div className="csx-chips" style={{ marginTop: 6 }}>{tagsFor(customer)}</div>
                    <div className="csx-meta reg-inline">ثبت {jalaliDate(customer.createdAt)}</div>
                  </td>
                  <td><span className="phone ltr" dir="ltr">{formatPhoneForDisplay(customer.phone)}</span><div className="csx-meta">کد {faId(customer.id)}</div></td>
                  <td>{canUpdate ? <select className="csx-isel st" data-s={customer.status} value={customer.status} disabled={updateCustomer.isPending} aria-label={`وضعیت ${customer.name}`} onChange={(e) => updateInlineCustomer(customer, { status: e.target.value as 'in_progress' | 'cancelled' | 'completed' })} data-testid={`select-inline-status-${customer.id}`}>
                    <option value="in_progress">در حال انجام</option><option value="completed">اتمام</option><option value="cancelled">لغو شده</option>
                  </select> : <StatusPill status={customer.status} />}</td>
                  <td>{canUpdate ? <select className="csx-isel" data-p={customer.priority ?? undefined} style={{ backgroundColor: priorityColors[String(customer.priority ?? 'none') as keyof typeof priorityColors] }} value={customer.priority ? String(customer.priority) : 'null'} disabled={updateCustomer.isPending} aria-label={`اولویت ${customer.name}`} onChange={(e) => updateInlineCustomer(customer, { priority: e.target.value === 'null' ? null : Number(e.target.value) })} data-testid={`select-inline-priority-${customer.id}`}>
                    <option value="null">بدون اولویت</option><option value="1">اولویت ۱</option><option value="2">اولویت ۲</option><option value="3">اولویت ۳</option>
                  </select> : <PriorityLabel value={customer.priority} />}</td>
                  <td>{isAdmin ? <>
                    <select className="csx-isel" value={customer.salespersonId ?? ''} aria-label={`تغییر کارشناس مشتری ${customer.id}`} title="انتخاب و تغییر کارشناس این مشتری" data-testid={`select-inline-salesperson-${customer.id}`} disabled={updateCustomer.isPending || salespersons.isLoading || salespersons.isError} onChange={e => updateInlineCustomer(customer, { salespersonId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">بدون کارشناس</option>
                      {customer.salespersonId != null && !salespersons.data?.some(p => p.id === customer.salespersonId) && <option value={customer.salespersonId}>{customer.salespersonName || `کارشناس ${customer.salespersonId}`}</option>}
                      {(salespersons.data ?? []).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </select>
                    {salespersons.isError && <button type="button" className="csx-link" onClick={() => void salespersons.refetch()}>دریافت دوبارهٔ کارشناسان</button>}
                  </> : salespersonCell(customer)}</td>
                  <td data-testid={`last-call-${customer.id}`} title={customer.lastCallAt ? formatDateTime(customer.lastCallAt) : undefined}>{customer.lastCallAt ? relativeTime(customer.lastCallAt) : '—'}<div className="csx-meta">{fa(customer.activityCount)} فعالیت</div></td>
                  <td className="csx-meta col-reg">{jalaliDate(customer.createdAt)}</td>
                  <td><div className="csx-tact">
                    {canCall ? <a className="csx-ib line call" href={callHref(customer)} aria-label={`تماس با ${customer.name}`} title="تماس"><Phone size={18} aria-hidden="true" /></a> : null}
                    <Link href={`/customers/${customer.id}`} className="csx-ghost">پرونده</Link>
                    {extra.length ? <details className="csx-menu" onKeyDown={(e) => { if (e.key === 'Escape') (e.currentTarget as HTMLDetailsElement).open = false; }}>
                      <summary aria-label={`کارهای بیشتر برای ${customer.name}`}><MoreHorizontal size={20} aria-hidden="true" /></summary>
                      <div className="pop" onClick={(e) => { const d = (e.currentTarget.parentElement as HTMLDetailsElement); if ((e.target as HTMLElement).closest('button')) d.open = false; }}>{extra}</div>
                    </details> : null}
                  </div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div className="csx-pager">
          <label className="csx-meta">نمایش <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setOffset(0); }} data-testid="select-page-size">{[10, 25, 50].map((size) => <option key={size} value={size}>{fa(size)}</option>)}</select> در هر صفحه</label>
          <span className="csx-meta">{fa(total)} مشتری، صفحه {fa(currentPage)} از {fa(pageCount)}</span>
          <div className="pages">
            <button type="button" className="csx-pg" disabled={currentPage === 1} onClick={() => setOffset(Math.max(0, offset - pageSize))} aria-label="صفحه قبل" data-testid="button-previous-page"><ChevronRight size={18} /></button>
            {paginationItems(currentPage, pageCount).map((item, index) => item === 'ellipsis'
              ? <span className="csx-meta" key={`ellipsis-${index}`}>…</span>
              : <button type="button" key={item} className={`csx-pg ${item === currentPage ? 'active' : ''}`} aria-current={item === currentPage ? 'page' : undefined} onClick={() => setOffset((item - 1) * pageSize)} aria-label={`صفحه ${item}`} data-testid={`button-page-${item}`}>{fa(item)}</button>)}
            <button type="button" className="csx-pg" disabled={currentPage === pageCount} onClick={() => setOffset(offset + pageSize)} aria-label="صفحه بعد" data-testid="button-next-page"><ChevronLeft size={18} /></button>
          </div>
        </div>
      </>
    ) : (
      <>
        <ul className="csx-list cards" aria-label="فهرست مشتریان">
          {items.map(customer => {
            const extra = legacyActions(customer);
            return <li key={customer.id} className={`csx-card${customer.isUrgent || customer.pendingRepeatRequestCount > 0 ? ' hl' : ''}`} data-testid={`row-customer-${customer.id}`}>
              <div className="r1"><StatusPill status={customer.status} /><PriorityLabel value={customer.priority} /><span className="age" data-testid={`last-call-${customer.id}`}><Clock size={15} aria-hidden="true" /> {customer.lastCallAt ? `آخرین تماس ${relativeTime(customer.lastCallAt)}` : 'هنوز تماسی ثبت نشده'}</span></div>
              <h3 className="nm"><Link href={`/customers/${customer.id}`} data-testid={`link-customer-${customer.id}`}>{customer.name}</Link></h3>
              <div className="csx-chips">{tagsFor(customer)}</div>
              <div className="row"><span className="phone" dir="ltr"><Phone size={16} aria-hidden="true" /> {formatPhoneForDisplay(customer.phone)}</span><span className="csx-meta">کد {faId(customer.id)}</span></div>
              <div className="row">{salespersonCell(customer)}<span className="csx-meta">{fa(customer.activityCount)} فعالیت</span></div>
              <div className="csx-acts">
                {canCall ? <a className="csx-call" href={callHref(customer)} aria-label={`تماس با ${customer.name}`}><Phone size={19} aria-hidden="true" /> تماس</a> : null}
                <Link href={`/customers/${customer.id}`} className="csx-ghost">پرونده مشتری</Link>
              </div>
              {extra.length ? <details className="csx-more csx-cardmore"><summary>کارهای بیشتر</summary><div className="more csx-menu-inline">{extra}</div></details> : null}
            </li>;
          })}
        </ul>
        {items.length < total ? <button type="button" className="csx-loadmore" onClick={() => setMobileCount(c => c + MOBILE_STEP)} disabled={customers.isFetching} data-testid="button-load-more">{customers.isFetching ? 'در حال دریافت…' : `نمایش بیشتر (${fa(items.length)} از ${fa(total)})`}</button>
          : items.length > MOBILE_STEP ? <p className="csx-meta" style={{ textAlign: 'center' }}>همهٔ {fa(total)} مشتری نمایش داده شد.</p> : null}
      </>
    )}

    {filtersOpen ? <Sheet title="فیلترها" side={isDesktop} onClose={() => setFiltersOpen(false)} testId="customers-filters" footer={<>
      <button type="button" className="csx-ghost" onClick={clearFilters} disabled={!activeFilters.length && !lastCallSort}>پاک کردن</button>
      <button type="button" className="csx-primary" onClick={() => setFiltersOpen(false)} data-testid="button-apply-filters">{customers.isFetching && !customers.data ? 'در حال شمارش…' : `نمایش ${fa(total)} مشتری`}</button>
    </>}>{filterBody}</Sheet> : null}

    {deleting ? <ConfirmDialog title={`حذف «${deleting.name}»؟`} confirmLabel="حذف برای همیشه" pendingLabel="در حال حذف…" pending={deleteCustomer.isPending} error={deleteCustomer.isError ? (deleteCustomer.error instanceof Error ? deleteCustomer.error.message : 'حذف انجام نشد. دوباره تلاش کنید.') : undefined} onConfirm={confirmRemove} onClose={() => setDeleting(null)} testId="dialog-delete-customer">
      <p>پرونده، تماس‌ها و مشاوره‌های مرتبط با این مشتری برای همیشه حذف می‌شوند.</p>
      <p><strong>این کار برگشت‌پذیر نیست.</strong></p>
    </ConfirmDialog> : null}
    {toast ? <div className="csx-toast" role="status">{toast}</div> : null}

    <CustomerForm open={formOpen} customer={editing} salespersons={salespersons.data ?? []} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); invalidateAll(); }} />
    {isAdmin && manualIdentity && <ManualCustomerIdentity key={manualIdentity.id} customer={manualIdentity} onClose={() => setManualIdentity(null)} />}
    {isAdmin && changingPhone && <AdminCustomerPhoneEditor key={changingPhone.id} customer={changingPhone} onClose={() => setChangingPhone(null)} />}
    {reviewing && <RepeatRequestReview customer={reviewing} onClose={() => setReviewing(null)} />}
    {isAdmin && duplicateReviewOpen ? <DuplicateCustomerReview onClose={() => setDuplicateReviewOpen(false)} salespersons={salespersons.data ?? []} salespersonLoading={salespersons.isLoading} salespersonError={salespersons.isError} onRetrySalespersons={() => { void salespersons.refetch(); }} /> : null}
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

function BoardColumn({ column, color, filters, tagLabels, onReview, onCall, onConsult, onEdit, onManualIdentity, onDelete, onMove }: {
  column: { value: number | null; label: string };
  color: string;
  filters: Omit<ListCustomersParams, 'priority' | 'hasPriority' | 'limit' | 'offset' | 'status'>;
  tagLabels: { key: string; label: string }[];
  onReview: (customer: Customer) => void;
  onCall: (customer: Customer) => void;
  onConsult: (customer: Customer) => void;
  onEdit: (customer: Customer) => void;
  onManualIdentity?: (customer: Customer) => void;
  onDelete?: (customer: Customer) => void;
  onMove: (id: number, priority: number | null) => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ['board-customers', column.value, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listCustomers({
      ...filters,
      status: 'in_progress',
      sortBy: 'boardTags',
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
         <div key={customer.id} className={`board-card ${customer.pendingRepeatRequestCount > 0 ? 'repeat-highlight' : ''}`} style={{ backgroundColor: color }} draggable onDragStart={(event) => event.dataTransfer.setData('customerId', String(customer.id))} data-testid={`board-card-${customer.id}`}>
          <div className="board-card-name">
            <Link href={`/customers/${customer.id}`} className="board-customer-link">
              <span className="board-customer-name">{customer.name}</span>{(customer as { portalOrigin?: boolean }).portalOrigin ? <span className="tag-portal" data-testid="tag-portal-origin" style={{ marginInlineStart: 6, fontSize: 10, padding: '1px 7px', borderRadius: 9, background: '#f3ecdb', color: '#7a5a1f', fontWeight: 700 }}>پنل مشتریان</span> : null}
              <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {customer.salespersonName || 'بدون تخصیص'}</span>
              <span className="customer-tags">
                {customer.isUrgent && <span className="customer-tag customer-tag-urgent">فوری</span>}
                {customer.verificationStatus === 'unverified' && <span className="customer-tag customer-tag-unverified">احراز نشده</span>}
                {customer.tags.filter(key => key !== 'repeat_request').map(key => <span className="customer-tag" key={key}>{tagLabels.find(item => item.key === key)?.label ?? key}</span>)}
              </span>
            </Link>
            <RepeatRequestTag customer={customer} onClick={() => onReview(customer)} />
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onCall(customer)} title="تماس"><PhoneCall size={12} /></button>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onConsult(customer)} title="مشاوره"><FileText size={12} /></button>
              <button className="row-action" style={{ padding: 2 }} onClick={() => onEdit(customer)} title="ویرایش مشتری" data-testid={`button-board-edit-customer-${customer.id}`}><Edit3 size={12} /></button>
              {onManualIdentity && <button className="row-action" style={{ padding: 2 }} onClick={() => onManualIdentity(customer)} title="احراز دستی و ویرایش مشخصات" data-testid={`button-board-manual-identity-${customer.id}`}>احراز دستی</button>}
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
