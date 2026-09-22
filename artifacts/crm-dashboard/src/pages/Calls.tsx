import { PhoneCall, Plus } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListCalls, useCreateCall, useListCustomers, useListSalespersons, getListCallsQueryKey, getListRemindersQueryKey, getListCustomersQueryKey, type CallInput, type CallRecord } from '@workspace/api-client-react';
import { ErrorState, formatDateTime, initials, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Pagination, SearchField } from '@/components/DataTools';
import { CallForm } from '@/components/Forms';
import { CallHistoryModal } from '@/components/CallHistory';

const limit = 8;
export default function Calls() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const params = { search: search || undefined, limit, offset };
  const calls = useListCalls(params, { query: { queryKey: getListCallsQueryKey(params) } });
  const customers = useListCustomers({ limit: 100 }, { query: { queryKey: ['calls-customers', 100], staleTime: 60_000 } });
  const salespersons = useListSalespersons({ query: { queryKey: ['calls-salespersons'], staleTime: 60_000 } });
  const create = useCreateCall();
  const items = calls.data?.items ?? [];
  const save = async (data: CallInput) => {
    try {
      await create.mutateAsync({ data });
      setOpen(false);
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
    <div className="data-toolbar"><div className="toolbar"><SearchField value={search} onChange={(value) => { setSearch(value); setOffset(0); }} placeholder="جست‌وجو در مشتری، موضوع یا یادداشت..." testId="calls" /><div className="subtle-note">نمایش ۸ مورد در هر صفحه</div></div><button className="btn btn-primary" onClick={() => setOpen(true)} data-testid="button-new-call"><Plus size={16} /> ثبت تماس جدید</button></div>
    {calls.isLoading ? <SkeletonPanel rows={6} /> : calls.isError ? <ErrorState onRetry={() => calls.refetch()} /> : <div className="data-table-wrap"><table className="data-table calls-table"><thead><tr><th>مشتری</th><th>موضوع تماس</th><th>درخواست مشتری</th><th>کارشناس</th><th>زمان ثبت</th></tr></thead><tbody>{items.length ? items.map((call) => <tr key={call.id} tabIndex={0} role="button" onClick={() => setSelectedCall(call)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedCall(call); }} data-testid={`row-call-${call.id}`}><td><span className="primary-cell"><span className="avatar" style={{ display:'inline-grid', width:28, height:28, marginLeft:8, verticalAlign:'middle' }}>{initials(call.customerName)}</span>{call.customerName}</span><span className="secondary-cell mono">{call.customerPhone}</span></td><td><span className="primary-cell">{call.subject || 'تماس پیگیری'}</span><span className="secondary-cell">شناسه تماس #{call.id.toLocaleString('fa-IR')}</span></td><td>{call.customerRequest || 'درخواستی ثبت نشده است.'}</td><td>{call.salespersonName || 'بدون تخصیص'}</td><td className="secondary-cell" data-testid={`text-call-date-${call.id}`}>{formatDateTime(call.createdAt)}</td></tr>) : <tr><td colSpan={5}><EmptyState title="تماسی ثبت نشده است" description="با ثبت اولین تماس، تاریخچه ارتباطات اینجا دیده می‌شود." /></td></tr>}</tbody></table><Pagination total={calls.data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} testId="calls" /></div>}
    {open ? <CallForm customers={customers.data?.items ?? []} salespersons={salespersons.data ?? []} pending={create.isPending} error={create.isError} onClose={() => setOpen(false)} onSave={save} /> : null}
    {selectedCall?.customerId != null ? <CallHistoryModal customerId={selectedCall.customerId} customerName={selectedCall.customerName} customerPhone={selectedCall.customerPhone} selectedCallId={selectedCall.id} onClose={() => setSelectedCall(null)} /> : null}
  </section>;
}
