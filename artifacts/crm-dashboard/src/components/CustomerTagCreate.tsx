import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListCustomerTagsQueryKey, useCreateCustomerTag } from '@workspace/api-client-react';

type Tag = { key: string; label: string };

export function CustomerTagCreate({ onCreated }: { onCreated: (tag: Tag) => void }) {
  const queryClient = useQueryClient();
  const create = useCreateCustomerTag();
  const [label, setLabel] = useState('');
  const submit = () => {
    const trimmed = label.trim();
    if (!trimmed || create.isPending) return;
    create.mutate({ data: { label: trimmed } }, {
      onSuccess: (tag) => {
        queryClient.setQueryData<Tag[]>(getListCustomerTagsQueryKey(), current =>
          current?.some(item => item.key === tag.key) ? current : [...(current ?? []), tag],
        );
        void queryClient.invalidateQueries({ queryKey: getListCustomerTagsQueryKey() });
        onCreated(tag);
        setLabel('');
      },
    });
  };
  return <div className="customer-tag-create">
    <label htmlFor="new-customer-tag-label">برچسب جدید</label>
    <div className="customer-tag-create-row">
      <input id="new-customer-tag-label" type="text" value={label} onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} placeholder="مثلاً پیگیری ویژه" maxLength={80} disabled={create.isPending} data-testid="input-new-customer-tag" />
      <button className="btn btn-ghost" type="button" onClick={submit} disabled={!label.trim() || create.isPending} data-testid="button-create-customer-tag">{create.isPending ? 'در حال ساخت…' : 'ساخت و انتخاب برچسب'}</button>
    </div>
    {create.isError && <div role="alert" className="profile-form-error" data-testid="error-create-customer-tag">برچسب ساخته نشد. نام دیگری وارد کنید یا دوباره تلاش کنید.</div>}
  </div>;
}