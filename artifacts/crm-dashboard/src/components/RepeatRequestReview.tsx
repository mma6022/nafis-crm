import { useQueryClient } from '@tanstack/react-query';
import { getGetCustomerQueryKey, getListCustomerRepeatRequestsQueryKey, getListCustomersQueryKey, useAcknowledgeCustomerRepeatRequests, useListCustomerRepeatRequests, type Customer } from '@workspace/api-client-react';
import { formatDateTime } from './CrmShell';
import { Modal } from './DataTools';

export function refreshCustomerViews(queryClient: ReturnType<typeof useQueryClient>, id?: number) {
  void queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
  void queryClient.invalidateQueries({ queryKey: ['board-customers'] });
  if (id) {
    void queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListCustomerRepeatRequestsQueryKey(id) });
  }
}

export function RepeatRequestTag({ customer, onClick }: { customer: Customer; onClick: () => void }) {
  if (!customer.pendingRepeatRequestCount) return null;
  return <button type="button" className="customer-tag-repeat" onClick={onClick} data-testid={`button-repeat-request-${customer.id}`} aria-label={`درخواست چند باره؛ ${customer.pendingRepeatRequestCount.toLocaleString('fa-IR')} درخواست جدید برای ${customer.name}`}>
    درخواست چند باره <span>({customer.pendingRepeatRequestCount.toLocaleString('fa-IR')})</span>
  </button>;
}

export function RepeatRequestReview({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const queryClient = useQueryClient();
  const requests = useListCustomerRepeatRequests(customer.id, { query: { queryKey: getListCustomerRepeatRequestsQueryKey(customer.id), enabled: true } });
  const acknowledge = useAcknowledgeCustomerRepeatRequests();
  const pending = requests.data?.filter(item => item.status === 'pending') ?? [];
  return <Modal title="درخواست‌های جدید این مشتری را مشاهده کردید؟" eyebrow={customer.name} onClose={onClose} testId="repeat-request-review">
    <p className="profile-form-note">قبل از تأیید، توضیحات هر درخواست تازه را بررسی کنید. با انتخاب «بله» نشان درخواست چند باره برداشته می‌شود.</p>
    {requests.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div>
      : requests.isError ? <div className="profile-form-error" role="alert">دریافت درخواست‌ها انجام نشد. <button type="button" className="field-link-button" onClick={() => void requests.refetch()}>تلاش دوباره</button></div>
      : pending.length ? <div className="repeat-request-list">{pending.map(item => <article className="repeat-request-item" key={item.id} data-testid={`repeat-request-${item.id}`}>
        <strong>نام ثبت‌شده: {item.requestedName}</strong>
        <p><b>توضیحات ارسال‌شده:</b> {item.submittedDescription || 'توضیحی ثبت نشده است.'}</p>
        <p><b>دلیل درخواست دوباره:</b> {item.explanation}</p>
        <small>{formatDateTime(item.createdAt)}</small>
      </article>)}</div> : <p role="status">درخواست جدیدی برای بررسی باقی نمانده است.</p>}
    {acknowledge.isError && <div className="profile-form-error" role="alert">تأیید ذخیره نشد. دوباره تلاش کنید.</div>}
    <div className="form-footer">
      <button className="btn btn-primary" type="button" disabled={requests.isLoading || requests.isError || !pending.length || acknowledge.isPending} onClick={() => acknowledge.mutate({ id: customer.id }, { onSuccess: () => { refreshCustomerViews(queryClient, customer.id); onClose(); } })} data-testid="button-acknowledge-repeat">{acknowledge.isPending ? 'در حال ثبت…' : 'بله، مشاهده کردم'}</button>
      <button className="btn btn-ghost" type="button" disabled={acknowledge.isPending} onClick={onClose} data-testid="button-dismiss-repeat">خیر، بعداً بررسی می‌کنم</button>
    </div>
  </Modal>;
}