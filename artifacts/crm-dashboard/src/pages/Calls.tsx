import { Download, PhoneCall, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { getCustomer, useGetAuthSession, getGetAuthSessionQueryKey, type CustomerDetail, listCalls, useListCalls, useCreateCall, useListCustomers, useListSalespersons, getListCallsQueryKey, getListRemindersQueryKey, getListCustomersQueryKey, type CallInput, type CallRecord } from '@workspace/api-client-react';
import '@/components/voip/CallReportDialog.css';
import { ErrorState, formatDateTime, initials, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Pagination, SearchField } from '@/components/DataTools';
import { CallForm } from '@/components/Forms';
import type { CallCustomer } from '@/components/CallCustomerSelect';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { useCallLauncher } from '@/features/team-sales/useCallLauncher';
import { CallReportDialog } from '@/components/voip/CallReportDialog';
import { removeCompletedAfterCallFromQueue } from '@/components/voip/after-call-cache';

import { RecordedCallsPanel } from '@/components/RecordedCallsPanel';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliValueToGregorian } from '@/lib/jalali';

const limit = 8;
export default function Calls() {
  const [tab, setTab] = useTableState<'manual' | 'recordings'>('calls.tab', 'manual');
  return <>
    <div role="tablist" aria-label="نوع گزارش تماس" style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
      <button role="tab" aria-selected={tab === 'recordings'} className={`btn ${tab === 'recordings' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('recordings')} data-testid="tab-recordings">گزارش مرکز تماس</button>
      <button role="tab" aria-selected={tab === 'manual'} className={`btn ${tab === 'manual' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('manual')} data-testid="tab-manual">تماس‌های ثبت‌شده دستی</button>
    </div>
    {tab === 'recordings' ? <RecordedCallsPanel /> : <ManualCalls />}
  </>;
}

export function ManualCalls() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useTableState('calls.search', '');
  const [offset, setOffset] = useTableState('calls.offset', 0);
  const [open, setOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const emptyFilters = { salespersonId: '', from: '', to: '' };
  const [draftFilters, setDraftFilters] = useTableState('calls.draft', emptyFilters);
  const [filters, setFilters] = useTableState('calls.filters', emptyFilters);
  const [filterError, setFilterError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const params = {
    search: search || undefined, limit, offset,
    salespersonId: filters.salespersonId ? Number(filters.salespersonId) : undefined,
    from: jalaliValueToGregorian(filters.from), to: jalaliValueToGregorian(filters.to),
  };
  const calls = useListCalls(params, { query: { queryKey: getListCallsQueryKey(params) } });
  const customers = useListCustomers({ limit: 100 }, { query: { queryKey: ['calls-customers', 100], staleTime: 60_000 } });
  const salespersons = useListSalespersons({ query: { queryKey: ['calls-salespersons'], staleTime: 60_000 } });
  const create = useCreateCall();
  const items = calls.data?.items ?? [];
  // «ثبت تماس جدید» (pick a customer first): once a customer is picked, the same shared rule as everywhere else
  // decides whether the simple team-sales form applies; saving the legacy form is blocked until that is known.
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const canCustomersView = user?.role === 'admin' || (user?.permissions ?? []).includes('customers.view');
  const [simpleFor, setSimpleFor] = useState<CustomerDetail | null>(null);
  const [pickFetch, setPickFetch] = useState<{ id: number; state: 'checking' | 'error' } | null>(null);
  const pickSeq = useRef(0);
  const launcher = useCallLauncher<CustomerDetail>(user, Boolean(user) && canCustomersView, (customer, kind) => {
    if (kind === 'simple') { setOpen(false); setSimpleFor(customer); }
  });
  const checkPicked = async (picked: { id: number }) => {
    const seq = ++pickSeq.current;
    launcher.cancel();
    setPickFetch({ id: picked.id, state: 'checking' });
    try {
      const full = await getCustomer(picked.id);
      if (seq !== pickSeq.current) return;
      setPickFetch(null);
      launcher.launch(full);
    } catch {
      if (seq === pickSeq.current) setPickFetch({ id: picked.id, state: 'error' });
    }
  };
  const lastPicked = useRef<CallCustomer | null>(null);
  const onCustomerPicked = (customer: CallCustomer) => {
    lastPicked.current = customer;
    if (!user || user.salespersonId == null) return; // only a salesperson can be the qualifier
    void checkPicked(customer);
  };
  const pickCheck = pickFetch
    ? { state: pickFetch.state, onRetry: () => { if (lastPicked.current) void checkPicked(lastPicked.current); } }
    : launcher.status ? { state: launcher.status === 'error' ? 'error' as const : 'checking' as const, onRetry: launcher.retry } : null;
  const closeCallForm = () => { pickSeq.current++; setPickFetch(null); launcher.cancel(); setOpen(false); };
  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    const from = jalaliValueToGregorian(draftFilters.from);
    const to = jalaliValueToGregorian(draftFilters.to);
    if ((draftFilters.from && !from) || (draftFilters.to && !to) || (from && to && from > to)) {
      setFilterError('تاریخ‌ها را بررسی کنید؛ تاریخ شروع نباید بعد از تاریخ پایان باشد.');
      return;
    }
    setFilterError(''); setExportError(''); setFilters({ ...draftFilters }); setOffset(0);
  };
  const exportReport = async () => {
    setExporting(true); setExportError('');
    try {
      const rows: CallRecord[] = [];
      // Fetch every page using the same server-side filters and authorization as the table.
      const ids = new Set<number>();
      let expectedTotal: number | undefined;
      for (let pageOffset = 0; ; pageOffset += 500) {
        const result = await listCalls({ ...params, offset: pageOffset, limit: 500 });
        if (expectedTotal !== undefined && result.total !== expectedTotal)
          throw new Error('تعداد تماس‌ها هنگام دریافت گزارش تغییر کرد. دوباره تلاش کنید.');
        expectedTotal = result.total;
        for (const row of result.items) {
          if (ids.has(row.id)) throw new Error('تماس‌ها هنگام دریافت گزارش تغییر کردند. دوباره تلاش کنید.');
          ids.add(row.id); rows.push(row);
        }
        if (rows.length >= result.total) break;
        if (!result.items.length) throw new Error('دریافت همهٔ ردیف‌های گزارش انجام نشد.');
      }
      const cell = (value: unknown) => {
        let text = String(value ?? '');
        if (typeof value !== 'number' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const csv = [
        ['شناسه تماس', 'مشتری', 'شماره تماس', 'کارشناس تماس', 'موضوع', 'یادداشت کارشناس', 'خلاصه سیستم', 'زمان تماس'],
        ...rows.map(row => [row.id, row.customerName, row.customerPhone, row.salespersonName, row.subject, row.expertNotes, row.systemSummary, formatDateTime(row.createdAt)]),
      ].map(row => row.map(cell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `calls-${params.from ?? 'all'}-${params.to ?? 'all'}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'دریافت گزارش ناموفق بود.');
    } finally { setExporting(false); }
  };
  const save = async (data: CallInput) => {
    try {
      const saved = await create.mutateAsync({ data });
      setOpen(false);
      await removeCompletedAfterCallFromQueue(queryClient, { callLogId: saved.id });
      queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      queryClient.invalidateQueries({ queryKey: ['calls-customers'] });
      queryClient.invalidateQueries({ queryKey: ['board-customers'] });
    } catch {
      // Keep the form open so the user can retry.
    }
  };
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">ارتباطات مشتری</div><h2>تاریخچه تماس‌ها</h2><p>هر تماس، یک قدم روشن‌تر برای ادامه مسیر مشتری.</p></div><div className="data-summary"><PhoneCall size={17} /><span>کل تماس‌های ثبت‌شده</span><strong data-testid="text-total-calls">{(calls.data?.total ?? 0).toLocaleString('fa-IR')}</strong></div></div>
    <div className="data-toolbar"><div className="toolbar"><SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="جست‌وجو در مشتری، موضوع یا یادداشت..." testId="calls" /><div className="subtle-note">نمایش ۸ مورد در هر صفحه</div></div><button className="btn btn-primary" onClick={() => { setPickFetch(null); launcher.cancel(); setOpen(true); }} data-testid="button-new-call"><Plus size={16} /> ثبت تماس جدید</button></div>
    <form className="panel" onSubmit={applyFilters} style={{ marginBottom: 16 }} data-testid="form-call-filters">
      <div className="form-grid">
        <div className="field"><label htmlFor="calls-expert">کارشناس تماس</label><select id="calls-expert" value={draftFilters.salespersonId} onChange={event => setDraftFilters({ ...draftFilters, salespersonId: event.target.value })} data-testid="select-calls-expert">
          <option value="">همهٔ کارشناسان مجاز</option>
          {(salespersons.data ?? []).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>{salespersons.isError ? <small role="alert">دریافت کارشناسان ناموفق بود. <button type="button" onClick={() => salespersons.refetch()}>تلاش دوباره</button></small> : null}</div>
        <div className="field"><label>تاریخ شروع (شمسی)</label><PersianDatePicker value={draftFilters.from} onChange={from => setDraftFilters({ ...draftFilters, from })} testId="input-calls-from" /></div>
        <div className="field"><label>تاریخ پایان (شمسی)</label><PersianDatePicker value={draftFilters.to} onChange={to => setDraftFilters({ ...draftFilters, to })} testId="input-calls-to" /></div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        <button type="submit" className="btn btn-primary" disabled={exporting} data-testid="button-calls-apply">نمایش گزارش</button>
        <button type="button" className="btn btn-ghost" disabled={exporting} onClick={() => { setDraftFilters(emptyFilters); setFilters(emptyFilters); setSearch(''); setFilterError(''); setExportError(''); setOffset(0); }} data-testid="button-calls-clear">پاک کردن فیلترها</button>
        <button type="button" className="btn btn-ghost" disabled={exporting || calls.isLoading || calls.isError || !calls.data?.total} onClick={exportReport} data-testid="button-calls-export"><Download size={16} />{exporting ? 'در حال دریافت…' : 'دریافت گزارش CSV'}</button>
      </div>
      <p className="subtle-note" style={{ marginTop: 12 }}>گزارش نمایش‌داده‌شده: {salespersons.data?.find(person => String(person.id) === filters.salespersonId)?.name || 'همهٔ کارشناسان مجاز'} · شروع: {filters.from || 'بدون محدودیت'} · پایان: {filters.to || 'بدون محدودیت'} — تاریخ پایان شامل تمام تماس‌های همان روز است. خروجی شامل همهٔ صفحات گزارش است.</p>
      {filterError || exportError ? <p role="alert" className="form-error">{filterError || exportError}</p> : null}
    </form>
    {calls.isLoading ? <SkeletonPanel rows={6} /> : calls.isError ? <ErrorState onRetry={() => calls.refetch()} /> : <div className="data-table-wrap"><table className="data-table calls-table"><thead><tr><th>مشتری</th><th>موضوع تماس</th><th>یادداشت کارشناس و خلاصه سیستم</th><th>کارشناس ثبت‌کننده تماس</th><th>زمان ثبت</th></tr></thead><tbody>{items.length ? items.map((call) => <tr key={call.id} tabIndex={0} role="button" onClick={() => setSelectedCall(call)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedCall(call); }} data-testid={`row-call-${call.id}`}><td><span className="primary-cell"><span className="avatar" style={{ display:'inline-grid', width:28, height:28, marginLeft:8, verticalAlign:'middle' }}>{initials(call.customerName)}</span>{call.customerName}</span><span className="secondary-cell mono">{call.customerPhone}</span><span className="secondary-cell">کارشناس پرونده: {call.customerSalespersonName || 'بدون تخصیص'}</span></td><td><span className="primary-cell cr-subject">{call.subject || 'تماس پیگیری'}</span><span className="secondary-cell">شناسه تماس #{call.id.toLocaleString('fa-IR')}</span></td><td><span className="cr-notes">{call.expertNotes || 'یادداشتی ثبت نشده است.'}</span>{call.systemSummary ? <span className="cr-sys" style={{display:'block'}}>{call.systemSummary}</span> : null}</td><td>{call.salespersonName || 'بدون تخصیص'}</td><td className="secondary-cell" data-testid={`text-call-date-${call.id}`}>{formatDateTime(call.createdAt)}</td></tr>) : <tr><td colSpan={5}><EmptyState title="تماسی ثبت نشده است" description="با ثبت اولین تماس، تاریخچه ارتباطات اینجا دیده می‌شود." /></td></tr>}</tbody></table><Pagination total={calls.data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} testId="calls" /></div>}
    {open ? <CallForm customers={customers.data?.items ?? []} salespersons={salespersons.data ?? []} pending={create.isPending} error={create.isError} onClose={closeCallForm} onSave={save} onCustomerPicked={onCustomerPicked} pickCheck={pickCheck} /> : null}
    {simpleFor ? <SimpleCallForm customer={simpleFor} userId={user?.id} noteMin={launcher.config?.noteMinLength ?? 30}
      onClose={() => setSimpleFor(null)} onNext={() => setSimpleFor(null)}
      onDone={() => {
        queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
        queryClient.invalidateQueries({ queryKey: ['calls-customers'] });
        queryClient.invalidateQueries({ queryKey: ['board-customers'] });
      }} /> : null}
    {selectedCall ? <CallReportDialog callId={selectedCall.id} onClose={() => setSelectedCall(null)} /> : null}
  </section>;
}
