import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListCustomerTagsQueryKey, useListCustomerTags, useUpdateCustomerTags, type Customer } from '@workspace/api-client-react';
import { refreshCustomerViews } from './RepeatRequestReview';
import { CustomerTagCreate } from './CustomerTagCreate';

export function CustomerTagEditor({ customer }: { customer: Customer }) {
  const queryClient = useQueryClient();
  const catalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey() } });
  const update = useUpdateCustomerTags();
  const [selected, setSelected] = useState<string[] | null>(null);
  const choices = catalog.data?.filter(tag => tag.key !== 'repeat_request') ?? [];
  const current = selected ?? customer.tags.filter(tag => tag !== 'repeat_request');
  const changed = current.slice().sort().join('|') !== customer.tags.filter(tag => tag !== 'repeat_request').slice().sort().join('|');
  return <div className="panel" style={{ marginBottom: 16 }} data-testid="panel-customer-tags">
    <div className="panel-head"><div><h3>برچسب‌های مشتری</h3><p>دسته‌بندی پرونده برای جست‌وجوی سریع در جدول و بورد</p></div></div>
    {catalog.isLoading ? <div className="skeleton loading-line" /> : catalog.isError ? <div className="profile-form-error" role="alert">فهرست برچسب‌ها دریافت نشد. <button type="button" className="field-link-button" onClick={() => void catalog.refetch()}>تلاش دوباره</button></div> : <div className="tag-selector">
      {choices.length ? choices.map(tag => <label className="tag-choice" key={tag.key}><input type="checkbox" checked={current.includes(tag.key)} disabled={update.isPending} onChange={event => setSelected(event.target.checked ? [...current, tag.key] : current.filter(key => key !== tag.key))} data-testid={`checkbox-customer-tag-${tag.key}`} />{tag.label}</label>) : <p>برچسبی در فهرست تعریف نشده است.</p>}
    </div>}
    <CustomerTagCreate onCreated={tag => setSelected(previous => [...new Set([...(previous ?? customer.tags.filter(key => key !== 'repeat_request')), tag.key])])} />
    {update.isError && <div className="profile-form-error" role="alert">برچسب‌ها ذخیره نشدند. دوباره تلاش کنید.</div>}
    <div className="form-footer"><button className="btn btn-primary" type="button" disabled={!changed || catalog.isLoading || catalog.isError || update.isPending} onClick={() => update.mutate({ id: customer.id, data: { tags: [...current, ...customer.tags.filter(tag => tag === 'repeat_request')] } }, { onSuccess: () => { setSelected(null); refreshCustomerViews(queryClient, customer.id); } })} data-testid="button-save-customer-tags">{update.isPending ? 'در حال ذخیره…' : 'ذخیره برچسب‌ها'}</button></div>
  </div>;
}