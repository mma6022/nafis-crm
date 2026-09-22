import { ClipboardPaste, LoaderCircle, Settings2, Sparkles, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { getListAllocationProgramsQueryKey, useCreateCustomer, useListAllocationPrograms, useParseCustomerText, useUpdateCustomer, type Customer, type Salesperson } from '@workspace/api-client-react';
import { initials } from './CrmShell';
import { AllocationProgramManager } from './AllocationProgramManager';
import { PersianDatePicker } from './PersianDatePicker';

type Props = { open: boolean; customer?: Customer | null; salespersons: Salesperson[]; onClose: () => void; onSaved: () => void };

export function CustomerForm({ open, customer, salespersons, onClose, onSaved }: Props) {
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const parseText = useParseCustomerText();
  const programs = useListAllocationPrograms({ query: { queryKey: getListAllocationProgramsQueryKey(), enabled: open } });
  const [programsOpen, setProgramsOpen] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', nationalCode: '', postalCode: '', birthDateJalali: '', description: '', salespersonId: '', priority: '', status: 'in_progress', isUrgent: false });
  const defaultProgram = programs.data?.find((program) => program.isDefault);
  useEffect(() => {
    setForm({ name: customer?.name ?? '', phone: customer?.phone ?? '', nationalCode: customer?.nationalCode ?? '', postalCode: customer?.postalCode ?? '', birthDateJalali: customer?.birthDateJalali ?? '', description: customer?.description ?? '', salespersonId: customer?.salespersonId ? String(customer.salespersonId) : '', priority: customer?.priority ? String(customer.priority) : '', status: customer?.status ?? 'in_progress', isUrgent: customer?.isUrgent ?? false });
    setSourceText('');
  }, [customer, open]);
  useEffect(() => {
    if (!open || customer || !defaultProgram) return;
    setForm((current) => current.salespersonId ? current : { ...current, salespersonId: `allocation:${defaultProgram.id}` });
  }, [customer, defaultProgram, open]);
  if (!open) return null;
  const isEditing = Boolean(customer);
  const setValue = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const analyzeCustomerText = (text = sourceText) => {
    if (text.trim().length < 3 || parseText.isPending) return;
    parseText.mutate(
      { data: { text: text.trim() } },
      {
        onSuccess: (result) => setForm((current) => ({
          ...current,
          name: result.name,
          phone: result.phone,
          description: result.description,
        })),
      },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || form.phone.trim().length < 3) return;
    const allocationProgramId = form.salespersonId.startsWith('allocation:') ? Number(form.salespersonId.split(':')[1]) : null;
    const data = { name: form.name.trim(), phone: form.phone.trim(), nationalCode: form.nationalCode.trim() || null, postalCode: form.postalCode.trim() || null, birthDateJalali: form.birthDateJalali.trim() || null, description: form.description.trim(), salespersonId: allocationProgramId ? null : form.salespersonId ? Number(form.salespersonId) : null, allocationProgramId: customer ? null : allocationProgramId, priority: form.priority ? Number(form.priority) : null, status: form.status as any, isUrgent: form.isUrgent };
    if (customer) update.mutate({ id: customer.id, data }, { onSuccess: onSaved });
    else create.mutate({ data }, { onSuccess: onSaved });
  };
  const pending = create.isPending || update.isPending;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="modal customer-form-modal" role="dialog" aria-modal="true" aria-labelledby="customer-form-title">
      <div className="modal-head"><div><div className="eyebrow">{isEditing ? 'ویرایش پرونده' : 'پرونده تازه'}</div><h3 id="customer-form-title">{isEditing ? `ویرایش ${initials(customer?.name)}` : 'افزودن مشتری جدید'}</h3></div><button className="modal-close" onClick={onClose} aria-label="بستن" data-testid="button-close-customer-form"><X size={19} /></button></div>
      <form onSubmit={submit}>
        <div className="form-grid">
          {!isEditing ? <div className="field full ai-customer-import">
            <div className="ai-customer-import-head">
              <div><label htmlFor="customer-source-text"><Sparkles size={14} /> استخراج خودکار اطلاعات مشتری</label><p>متن دایرکت اینستاگرام را اینجا پیست کنید.</p></div>
              <button type="button" className="btn btn-ghost ai-extract-button" disabled={parseText.isPending || sourceText.trim().length < 3} onClick={() => analyzeCustomerText()} data-testid="button-parse-customer-text">
                {parseText.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {parseText.isPending ? 'در حال تحلیل…' : 'تحلیل متن'}
              </button>
            </div>
            <div className="ai-customer-textarea-wrap">
              <ClipboardPaste size={17} />
              <textarea
                id="customer-source-text"
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData('text');
                  setSourceText(text);
                  window.setTimeout(() => analyzeCustomerText(text), 0);
                }}
                placeholder={'مثلاً:\\nسلام من علی مرادی‌ام\\n09120504376\\nلطفاً زودتر تماس بگیرید'}
                data-testid="textarea-customer-source"
              />
            </div>
            {parseText.isError ? <div className="profile-form-error" data-testid="error-parse-customer-text">تحلیل متن انجام نشد. دوباره تلاش کنید یا اطلاعات را دستی وارد کنید.</div> : null}
            {parseText.isSuccess ? <div className="ai-extract-success" data-testid="success-parse-customer-text">نام، شماره تماس و توضیحات استخراج شد؛ لطفاً قبل از ثبت بررسی کنید.</div> : null}
          </div> : null}
          <div className="field"><label htmlFor="customer-name">نام مشتری</label><input id="customer-name" value={form.name} onChange={(e) => setValue('name', e.target.value)} required data-testid="input-customer-name" /></div>
          <div className="field"><label htmlFor="customer-phone">شماره تماس</label><input id="customer-phone" dir="ltr" value={form.phone} onChange={(e) => setValue('phone', e.target.value)} required minLength={3} data-testid="input-customer-phone" /></div>
          <div className="field"><label htmlFor="customer-national-code">کد ملی</label><input id="customer-national-code" dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => setValue('nationalCode', e.target.value)} maxLength={10} data-testid="input-customer-national-code" /></div>
          <div className="field"><label htmlFor="customer-postal-code">کد پستی</label><input id="customer-postal-code" dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => setValue('postalCode', e.target.value)} maxLength={10} data-testid="input-customer-postal-code" /></div>
          <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => setValue('birthDateJalali', v)} placeholder="YYYY/MM/DD" testId="input-customer-birth-date" /></div>
          <div className="field"><label htmlFor="customer-priority">اولویت پیگیری</label><select id="customer-priority" value={form.priority} onChange={(e) => setValue('priority', e.target.value)} data-testid="select-customer-priority"><option value="">بدون اولویت</option>{[1, 2, 3].map((value) => <option value={value} key={value}>اولویت {value}</option>)}</select></div>
          <div className="field">
            <div className="field-label-actions"><label htmlFor="customer-salesperson">کارشناس فروش</label>{!isEditing ? <button type="button" className="field-link-button" onClick={() => setProgramsOpen(true)} data-testid="button-manage-allocation-programs"><Settings2 size={13} /> تعریف برنامه تخصیص</button> : null}</div>
            <select id="customer-salesperson" value={form.salespersonId} onChange={(e) => setValue('salespersonId', e.target.value)} data-testid="select-customer-salesperson">
              <option value="">بدون تخصیص</option>
              {!isEditing && (programs.data ?? []).map((program) => <option value={`allocation:${program.id}`} key={`allocation-${program.id}`}>تخصیص عادلانه — {program.name}{program.isDefault ? ' (پیش‌فرض)' : ''}</option>)}
              {salespersons.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="customer-status">وضعیت</label><select id="customer-status" value={form.status} onChange={(e) => setValue('status', e.target.value)} data-testid="select-customer-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div>
          <div className="field full"><label className="boolean-field"><input type="checkbox" checked={form.isUrgent} onChange={(e) => setForm(c => ({ ...c, isUrgent: e.target.checked }))} data-testid="checkbox-customer-is-urgent" /> <strong>مشتری فوری</strong> (نیاز به پیگیری سریع)</label></div>
          <div className="field full"><label htmlFor="customer-description">توضیحات</label><textarea id="customer-description" value={form.description} onChange={(e) => setValue('description', e.target.value)} placeholder="زمینه تماس یا نیاز مالی مشتری..." data-testid="textarea-customer-description" /></div>
        </div>
        <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-customer">{pending ? 'در حال ذخیره...' : isEditing ? 'ذخیره تغییرات' : 'ثبت مشتری'}</button><button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-customer">انصراف</button></div>
      </form>
      {programsOpen ? <AllocationProgramManager salespersons={salespersons} onClose={() => setProgramsOpen(false)} /> : null}
    </div>
  </div>;
}
