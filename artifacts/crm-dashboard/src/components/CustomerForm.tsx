import { ClipboardPaste, LoaderCircle, Settings2, Sparkles, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getListAllocationProgramsQueryKey, getListCustomerTagsQueryKey, lookupCustomerByPhone, useCreateCustomer, useCreateCustomerRepeatRequest, useGetAuthSession, useListAllocationPrograms, useListCustomerTags, useParseCustomerText, useUpdateCustomer, useUpdateCustomerTags, type Customer, type Salesperson } from '@workspace/api-client-react';
import { initials } from './CrmShell';
import { AllocationProgramManager } from './AllocationProgramManager';
import { PersianDatePicker } from './PersianDatePicker';
import { Modal } from './DataTools';
import { normalizeDigits } from '@/lib/customer-field-validation';
import { formatPhoneForDisplay } from '@/lib/phone';
import { refreshCustomerViews } from './RepeatRequestReview';
import { CustomerTagCreate } from './CustomerTagCreate';

type Props = { open: boolean; customer?: Customer | null; salespersons: Salesperson[]; onClose: () => void; onSaved: () => void };

export function CustomerForm({ open, customer, salespersons, onClose, onSaved }: Props) {
  const queryClient = useQueryClient();
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const parseText = useParseCustomerText();
  const repeat = useCreateCustomerRepeatRequest();
  const updateTags = useUpdateCustomerTags();
  const tagsCatalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey(), enabled: open } });
  const [tags, setTags] = useState<string[]>([]);
  const [matched, setMatched] = useState<Customer | null>(null);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [createdForTags, setCreatedForTags] = useState<Customer | null>(null);
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session.data?.user.role === 'admin';
  const programs = useListAllocationPrograms({ query: { queryKey: getListAllocationProgramsQueryKey(), enabled: open } });
  const [programsOpen, setProgramsOpen] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', nationalCode: '', postalCode: '', birthDateJalali: '', description: '', salespersonId: '', priority: '', status: 'in_progress', isUrgent: false });
  const defaultProgram = programs.data?.find((program) => program.isDefault);
  useEffect(() => {
    setForm({ name: customer?.name ?? '', phone: customer?.phone ?? '', nationalCode: customer?.nationalCode ?? '', postalCode: customer?.postalCode ?? '', birthDateJalali: customer?.birthDateJalali ?? '', description: customer?.description ?? '', salespersonId: customer?.salespersonId ? String(customer.salespersonId) : '', priority: customer?.priority ? String(customer.priority) : '', status: customer?.status ?? 'in_progress', isUrgent: customer?.isUrgent ?? false });
    setSourceText('');
    setTags(customer?.tags.filter(tag => tag !== 'repeat_request') ?? []);
    setMatched(null); setExplanation(''); setError(''); setCreatedForTags(null);
  }, [customer, open]);
  useEffect(() => {
    if (!open || customer || !defaultProgram || !isAdmin) return;
    setForm((current) => current.salespersonId ? current : { ...current, salespersonId: `allocation:${defaultProgram.id}` });
  }, [customer, defaultProgram, isAdmin, open]);
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
  const saveTagsAndFinish = async (saved: Customer) => {
    if (tags.length || (customer && tagsCatalog.isSuccess)) {
      try {
        await updateTags.mutateAsync({ id: saved.id, data: { tags: [...tags, ...saved.tags.filter(tag => tag === 'repeat_request')] } });
      } catch {
        setCreatedForTags(saved);
        setError('پرونده ذخیره شد، اما برچسب‌ها ذخیره نشدند. دوباره تلاش کنید؛ مشتری تازه دیگری ساخته نمی‌شود.');
        return;
      }
    }
    refreshCustomerViews(queryClient, saved.id);
    onSaved();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || form.phone.trim().length < 3) return;
    setError('');
    if (createdForTags) { await saveTagsAndFinish(createdForTags); return; }
    const allocationProgramId = isAdmin && form.salespersonId.startsWith('allocation:') ? Number(form.salespersonId.split(':')[1]) : null;
    const data = { name: form.name.trim(), phone: form.phone.trim(), nationalCode: form.nationalCode.trim() || null, postalCode: form.postalCode.trim() || null, birthDateJalali: form.birthDateJalali.trim() || null, description: form.description.trim(), ...(isAdmin ? { salespersonId: allocationProgramId ? null : form.salespersonId ? Number(form.salespersonId) : null, allocationProgramId: customer ? null : allocationProgramId } : {}), priority: form.priority ? Number(form.priority) : null, status: form.status as any, isUrgent: form.isUrgent };
    if (customer) {
      try { const saved = await update.mutateAsync({ id: customer.id, data }); await saveTagsAndFinish(saved); }
      catch { setError('ذخیره پرونده انجام نشد. اطلاعات را بررسی و دوباره تلاش کنید.'); }
      return;
    }
    setChecking(true);
    try {
      const match = await lookupCustomerByPhone({ phone: normalizeDigits(form.phone.trim()) });
      if (match.customer) { setMatched(match.customer); return; }
      const saved = await create.mutateAsync({ data });
      await saveTagsAndFinish(saved);
    } catch (cause) {
      const failure = cause as { status?: number; data?: { code?: string; customer?: Customer; message?: string } };
      if (failure.status === 409 && failure.data?.code === 'duplicate_mobile') {
        if (failure.data.customer) setMatched(failure.data.customer);
        else {
          try {
            const match = await lookupCustomerByPhone({ phone: normalizeDigits(form.phone.trim()) });
            if (match.customer) setMatched(match.customer);
            else setError('این شماره قبلاً ثبت شده است. دوباره تلاش کنید.');
          } catch { setError('بررسی مشتری موجود انجام نشد. دوباره تلاش کنید.'); }
        }
      } else if (failure.status === 409) setError('کد ملی واردشده برای مشتری دیگری ثبت شده است. کد ملی را بررسی کنید؛ پرونده جدیدی ایجاد نشد.');
      else setError('بررسی یا ثبت مشتری انجام نشد. لطفاً دوباره تلاش کنید.');
    } finally { setChecking(false); }
  };
  const pending = checking || create.isPending || update.isPending || updateTags.isPending;
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
          <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => setValue('birthDateJalali', v)} placeholder="YYYY/MM/DD" testId="input-customer-birth-date" birthDate /></div>
          <div className="field"><label htmlFor="customer-priority">اولویت پیگیری</label><select id="customer-priority" value={form.priority} onChange={(e) => setValue('priority', e.target.value)} data-testid="select-customer-priority"><option value="">بدون اولویت</option>{[1, 2, 3].map((value) => <option value={value} key={value}>اولویت {value}</option>)}</select></div>
          {isAdmin ? <div className="field">
            <div className="field-label-actions"><label htmlFor="customer-salesperson">کارشناس فروش</label>{!isEditing ? <button type="button" className="field-link-button" onClick={() => setProgramsOpen(true)} data-testid="button-manage-allocation-programs"><Settings2 size={13} /> تعریف برنامه تخصیص</button> : null}</div>
            <select id="customer-salesperson" value={form.salespersonId} onChange={(e) => setValue('salespersonId', e.target.value)} data-testid="select-customer-salesperson">
              <option value="">بدون تخصیص</option>
              {!isEditing && (programs.data ?? []).map((program) => <option value={`allocation:${program.id}`} key={`allocation-${program.id}`}>تخصیص عادلانه — {program.name}{program.isDefault ? ' (پیش‌فرض)' : ''}</option>)}
              {salespersons.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
            </select>
          </div> : null}
          <div className="field"><label htmlFor="customer-status">وضعیت</label><select id="customer-status" value={form.status} onChange={(e) => setValue('status', e.target.value)} data-testid="select-customer-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div>
          <div className="field full"><label className="boolean-field"><input type="checkbox" checked={form.isUrgent} onChange={(e) => setForm(c => ({ ...c, isUrgent: e.target.checked }))} data-testid="checkbox-customer-is-urgent" /> <strong>مشتری فوری</strong> (نیاز به پیگیری سریع)</label></div>
          <div className="field full"><label>برچسب‌های مشتری</label>
            {tagsCatalog.isLoading ? <div className="skeleton loading-line" /> : tagsCatalog.isError ? <div className="profile-form-error" role="alert">فهرست برچسب‌ها دریافت نشد. <button type="button" className="field-link-button" onClick={() => void tagsCatalog.refetch()}>تلاش دوباره</button></div> : <div className="tag-selector">{(tagsCatalog.data ?? []).filter(tag => tag.key !== 'repeat_request').map(tag => <label className="tag-choice" key={tag.key}><input type="checkbox" checked={tags.includes(tag.key)} onChange={e => setTags(current => e.target.checked ? [...current, tag.key] : current.filter(key => key !== tag.key))} data-testid={`checkbox-form-tag-${tag.key}`} />{tag.label}</label>)}</div>}
            <CustomerTagCreate onCreated={tag => setTags(current => current.includes(tag.key) ? current : [...current, tag.key])} />
          </div>
          <div className="field full"><label htmlFor="customer-description">توضیحات</label><textarea id="customer-description" value={form.description} onChange={(e) => setValue('description', e.target.value)} placeholder="زمینه تماس یا نیاز مالی مشتری..." data-testid="textarea-customer-description" /></div>
        </div>
        {error && <div className="profile-form-error" role="alert" data-testid="error-save-customer">{error}</div>}
        <div className="form-footer"><button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-customer">{pending ? 'در حال بررسی و ذخیره…' : createdForTags ? 'تلاش دوباره برای ذخیره برچسب‌ها' : isEditing ? 'ذخیره تغییرات' : 'ثبت مشتری'}</button><button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-customer">انصراف</button></div>
      </form>
      {programsOpen && isAdmin ? <AllocationProgramManager salespersons={salespersons} onClose={() => setProgramsOpen(false)} /> : null}
      {matched && <Modal title="این شماره همراه قبلاً ثبت شده است" eyebrow="درخواست دوباره مشتری" onClose={() => setMatched(null)} testId="duplicate-mobile" wide>
        <p className="profile-form-note">پرونده جدید ساخته نمی‌شود و کارشناس فعلی تغییر نمی‌کند. برای ثبت درخواست جدید، دلیل تماس دوباره را بنویسید.</p>
        <div className="duplicate-profile" data-testid="profile-existing-customer">
          {([
            ['نام مشتری', matched.name], ['شماره همراه', formatPhoneForDisplay(matched.phone)], ['شناسه', `#${matched.id.toLocaleString('fa-IR')}`],
            ['کارشناس فعلی', matched.salespersonName || 'بدون تخصیص'], ['کد ملی', matched.nationalCode || 'ثبت نشده'],
            ['کد پستی', matched.postalCode || 'ثبت نشده'], ['تاریخ تولد', matched.birthDateJalali || 'ثبت نشده'],
            ['نام', matched.firstName || 'ثبت نشده'], ['نام خانوادگی', matched.lastName || 'ثبت نشده'],
            ['نام پدر', matched.fatherName || 'ثبت نشده'], ['نشانی', matched.address || 'ثبت نشده'],
            ['ایمیل', matched.email || 'ثبت نشده'], ['وضعیت', matched.status],
            ['اولویت', matched.priority?.toLocaleString('fa-IR') || 'بدون اولویت'],
            ['فوری', matched.isUrgent ? 'بله' : 'خیر'], ['وضعیت احراز', matched.verificationStatus],
            ['تاریخ ثبت', matched.createdAt], ['آخرین فعالیت', matched.lastActivityAt || 'ثبت نشده'],
            ['نام رسمی', [matched.officialFirstName, matched.officialLastName].filter(Boolean).join(' ') || 'ثبت نشده'],
            ['نام پدر رسمی', matched.officialFatherName || 'ثبت نشده'],
            ['نشانی رسمی', matched.officialAddress || 'ثبت نشده'],
            ['کد پستی رسمی', matched.officialPostalCode || 'ثبت نشده'],
            ['رتبه اعتباری', matched.creditRank || 'ثبت نشده'],
            ['امتیاز اعتباری', matched.creditScore == null ? 'ثبت نشده' : String(matched.creditScore)],
            ['تعداد فعالیت‌ها', matched.activityCount.toLocaleString('fa-IR')],
            ['برچسب‌ها', matched.tags.join('، ') || 'بدون برچسب'],
            ['درخواست‌های جدید', matched.pendingRepeatRequestCount.toLocaleString('fa-IR')],
            ['توضیحات پرونده', matched.description || 'ثبت نشده'],
          ] as [string, string][]).map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
        </div>
        <div className="field"><label htmlFor="repeat-explanation">دلیل درخواست دوباره</label><textarea id="repeat-explanation" required value={explanation} onChange={e => setExplanation(e.target.value)} placeholder="این بار مشتری چه درخواستی دارد؟" data-testid="textarea-repeat-explanation" /></div>
        {repeat.isError && <div className="profile-form-error" role="alert">ثبت درخواست جدید انجام نشد. دوباره تلاش کنید.</div>}
        <div className="form-footer"><button className="btn btn-primary" type="button" disabled={!explanation.trim() || repeat.isPending} onClick={() => repeat.mutate({ data: { phone: normalizeDigits(form.phone.trim()), requestedName: form.name.trim(), submittedDescription: form.description.trim() || null, explanation: explanation.trim() } }, { onSuccess: () => { refreshCustomerViews(queryClient, matched.id); onSaved(); }, onError: (cause) => { const failure = cause as { status?: number }; if (failure.status === 404) setError('پرونده با این شماره دیگر پیدا نشد. دوباره بررسی کنید.'); } })} data-testid="button-create-repeat-request">{repeat.isPending ? 'در حال ثبت…' : 'ثبت درخواست برای پرونده موجود'}</button><button className="btn btn-ghost" type="button" onClick={() => setMatched(null)} disabled={repeat.isPending} data-testid="button-cancel-repeat-request">انصراف</button></div>
      </Modal>}
    </div>
  </div>;
}
