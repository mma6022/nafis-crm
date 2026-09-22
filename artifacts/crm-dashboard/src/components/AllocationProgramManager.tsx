import { Edit3, Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  getListAllocationProgramsQueryKey,
  useCreateAllocationProgram,
  useListAllocationPrograms,
  useUpdateAllocationProgram,
  type AllocationProgram,
  type Salesperson,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

type Props = {
  salespersons: Salesperson[];
  onClose: () => void;
};

export function AllocationProgramManager({ salespersons, onClose }: Props) {
  const queryClient = useQueryClient();
  const programs = useListAllocationPrograms({ query: { queryKey: getListAllocationProgramsQueryKey() } });
  const create = useCreateAllocationProgram();
  const update = useUpdateAllocationProgram();
  const [editing, setEditing] = useState<AllocationProgram | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListAllocationProgramsQueryKey() });
    setEditing(null);
    setCreating(false);
  };

  return (
    <div className="modal-backdrop allocation-program-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="modal allocation-program-modal" role="dialog" aria-modal="true" aria-labelledby="allocation-program-title">
        <div className="modal-head">
          <div><div className="eyebrow">تخصیص عادلانه مشتریان</div><h3 id="allocation-program-title">برنامه‌های تخصیص</h3></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="بستن"><X size={19} /></button>
        </div>

        {creating || editing ? (
          <AllocationProgramForm
            program={editing}
            salespersons={salespersons.filter((person) => person.active)}
            pending={create.isPending || update.isPending}
            error={create.isError || update.isError}
            onCancel={() => { setEditing(null); setCreating(false); }}
            onSave={(data) => {
              if (editing) update.mutate({ id: editing.id, data }, { onSuccess: refresh });
              else create.mutate({ data }, { onSuccess: refresh });
            }}
          />
        ) : (
          <>
            <div className="allocation-program-list">
              {programs.isLoading ? <div className="board-loading">در حال دریافت برنامه‌ها…</div> : (programs.data ?? []).length ? (programs.data ?? []).map((program) => (
                <div className="allocation-program-card" key={program.id}>
                  <div>
                    <div className="allocation-program-name">
                      {program.name}
                      {program.isDefault ? <span className="status-pill status-active">پیش‌فرض</span> : null}
                    </div>
                    <div className="allocation-program-summary">
                      {program.items.map((item) => `${item.salespersonName}: ${item.quota.toLocaleString('fa-IR')}`).join(' · ')}
                    </div>
                  </div>
                  <button type="button" className="row-action" onClick={() => setEditing(program)} aria-label={`ویرایش ${program.name}`}><Edit3 size={15} /></button>
                </div>
              )) : <div className="empty-state compact"><strong>هنوز برنامه‌ای تعریف نشده است.</strong><p>اولین برنامه تخصیص عادلانه را بسازید.</p></div>}
            </div>
            <div className="form-footer">
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-create-allocation-program"><Plus size={15} /> برنامه جدید</button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>بستن</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AllocationProgramForm({
  program,
  salespersons,
  pending,
  error,
  onCancel,
  onSave,
}: {
  program: AllocationProgram | null;
  salespersons: Salesperson[];
  pending: boolean;
  error: boolean;
  onCancel: () => void;
  onSave: (data: { name: string; isDefault: boolean; items: Array<{ salespersonId: number; quota: number }> }) => void;
}) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [quotas, setQuotas] = useState<Record<number, string>>({});

  useEffect(() => {
    setName(program?.name ?? '');
    setIsDefault(program?.isDefault ?? false);
    setQuotas(Object.fromEntries((program?.items ?? []).map((item) => [item.salespersonId, String(item.quota)])));
  }, [program]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const items = salespersons
      .filter((person) => Number(quotas[person.id]) > 0)
      .map((person) => ({ salespersonId: person.id, quota: Number(quotas[person.id]) }));
    if (!name.trim() || !items.length) return;
    onSave({ name: name.trim(), isDefault, items });
  };

  return (
    <form onSubmit={submit}>
      {error ? <div className="profile-form-error">ذخیره برنامه انجام نشد. اطلاعات را بررسی کنید.</div> : null}
      <div className="field full">
        <label htmlFor="allocation-program-name">نام برنامه تخصیص</label>
        <input id="allocation-program-name" value={name} onChange={(event) => setName(event.target.value)} required placeholder="مثلاً برنامه تیم فروش اصلی" data-testid="input-allocation-program-name" />
      </div>
      <div className="allocation-expert-list">
        <div className="allocation-expert-head"><span>کارشناس</span><span>تعداد مشتری در هر نوبت</span></div>
        {salespersons.map((person) => {
          const selected = quotas[person.id] !== undefined;
          return (
            <div className="allocation-expert-row" key={person.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => setQuotas((current) => {
                    const next = { ...current };
                    if (event.target.checked) next[person.id] = '1';
                    else delete next[person.id];
                    return next;
                  })}
                />
                <span>{person.name}</span>
              </label>
              <input
                type="number"
                min="1"
                max="1000"
                disabled={!selected}
                value={quotas[person.id] ?? ''}
                onChange={(event) => setQuotas((current) => ({ ...current, [person.id]: event.target.value }))}
                aria-label={`سهم ${person.name}`}
              />
            </div>
          );
        })}
      </div>
      <label className="allocation-default-check">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        <span>این برنامه، برنامه پیش‌فرض تخصیص عادلانه باشد</span>
      </label>
      <div className="form-footer">
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'در حال ذخیره…' : program ? 'ذخیره تغییرات' : 'ایجاد برنامه'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>انصراف</button>
      </div>
    </form>
  );
}