import { AlertCircle, ClipboardPaste, LoaderCircle, Settings2, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getListAllocationProgramsQueryKey, getListCustomerTagsQueryKey, lookupCustomerByPhone, useCreateCustomer, useCreateCustomerRepeatRequest, useGetAuthSession, useListAllocationPrograms, useListCustomerTags, useParseCustomerText, useUpdateCustomer, useUpdateCustomerTags, type Customer, type Salesperson } from '@workspace/api-client-react';
import { initials } from './CrmShell';
import { AllocationProgramManager } from './AllocationProgramManager';
import { PersianDatePicker } from './PersianDatePicker';
import { Sheet } from '@/pages/customers-ui';
import '@/pages/customers.css';
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
    setMatched(null); setExplanation(''); setError(''); setCreatedForTags(null); setFieldErrors({});
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
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'نام مشتری را وارد کنید.';
    if (form.phone.trim().length < 3) errors.phone = 'شماره موبایل را وارد کنید.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) { window.setTimeout(() => document.getElementById(errors.name ? 'customer-name' : 'customer-phone')?.focus(), 0); return; }
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
  const salespersonField = isAdmin ? <div className="field">
    <div className="field-label-actions"><label htmlFor="customer-salesperson">کارشناس فروش</label>{!isEditing ? <button type="button" className="field-link-button" onClick={() => setProgramsOpen(true)} data-testid="button-manage-allocation-programs"><Settings2 size={13} /> تعریف برنامه تخصیص</button> : null}</div>
    <select id="customer-salesperson" value={form.salespersonId} onChange={(e) => setValue('salespersonId', e.target.value)} data-testid="select-customer-salesperson">
      <option value="">بدون تخصیص</option>
      {!isEditing && (programs.data ?? []).map((program) => <option value={`allocation:${program.id}`} key={`allocation-${program.id}`}>تخصیص عادلانه — {program.name}{program.isDefault ? ' (پیش‌فرض)' : ''}</option>)}
      {salespersons.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
    </select>
    <p className="hint">فقط مدیر می‌تواند کارشناس تعیین کند.</p>
  </div> : null;
  const moreFields = <>
    <div className="field"><label htmlFor="customer-national-code">کد ملی</label><input id="customer-national-code" dir="ltr" inputMode="numeric" value={form.nationalCode} onChange={(e) => setValue('nationalCode', e.target.value)} maxLength={10} data-testid="input-customer-national-code" /></div>
    <div className="field"><label htmlFor="customer-postal-code">کد پستی</label><input id="customer-postal-code" dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(e) => setValue('postalCode', e.target.value)} maxLength={10} data-testid="input-customer-postal-code" /></div>
    <div className="field"><label>تاریخ تولد (شمسی)</label><PersianDatePicker value={form.birthDateJalali} onChange={(v) => setValue('birthDateJalali', v)} placeholder="YYYY/MM/DD" testId="input-customer-birth-date" birthDate /></div>
    <div className="field"><label htmlFor="customer-priority">اولویت پیگیری</label><select id="customer-priority" value={form.priority} onChange={(e) => setValue('priority', e.target.value)} data-testid="select-customer-priority"><option value="">بدون اولویت</option>{[1, 2, 3].map((value) => <option value={value} key={value}>اولویت {value}</option>)}</select></div>
    <div className="field"><label htmlFor="customer-status">وضعیت</label><select id="customer-status" value={form.status} onChange={(e) => setValue('status', e.target.value)} data-testid="select-customer-status"><option value="in_progress">در حال انجام</option><option value="cancelled">لغو شده</option><option value="completed">اتمام</option></select></div>
    <div className="field"><label className="boolean-field"><input type="checkbox" checked={form.isUrgent} onChange={(e) => setForm(c => ({ ...c, isUrgent: e.target.checked }))} data-testid="checkbox-customer-is-urgent" /> <strong>مشتری فوری</strong> (نیاز به پیگیری سریع)</label></div>
    <div className="field"><label>برچسب‌های مشتری</label>
      {tagsCatalog.isLoading ? <div className="skeleton loading-line" /> : tagsCatalog.isError ? <div className="profile-form-error" role="alert">فهرست برچسب‌ها دریافت نشد. <button type="button" className="field-link-button" onClick={() => void tagsCatalog.refetch()}>تلاش دوباره</button></div> : <div className="tag-selector">{(tagsCatalog.data ?? []).filter(tag => tag.key !== 'repeat_request').map(tag => <label className="tag-choice" key={tag.key}><input type="checkbox" checked={tags.includes(tag.key)} onChange={e => setTags(current => e.target.checked ? [...current, tag.key] : current.filter(key => key !== tag.key))} data-testid={`checkbox-form-tag-${tag.key}`} />{tag.label}</label>)}</div>}
      <CustomerTagCreate onCreated={tag => setTags(current => current.includes(tag.key) ? current : [...current, tag.key])} />
    </div>
  </>;
  const createRepeat = () => matched && repeat.mutate({ data: { phone: normalizeDigits(form.phone.trim()), requestedName: form.name.trim(), submittedDescription: form.description.trim() || null, explanation: explanation.trim() } }, { onSuccess: () => { refreshCustomerViews(queryClient, matched.id); onSaved(); }, onError: (cause) => { const failure = cause as { status?: number }; if (failure.status === 404) setError('پرونده با این شماره دیگر پیدا نشد. دوباره بررسی کنید.'); } });
  return <div className="csx csx-formhost" dir="rtl">
    <Sheet title={isEditing ? `ویرایش ${initials(customer?.name)}` : 'مشتری جدید'} onClose={onClose} testId="customer-form" initialFocus="#customer-name"
      footer={<>
        <button className="csx-ghost" type="button" onClick={onClose} data-testid="button-cancel-customer">انصراف</button>
        <button className="csx-primary" type="submit" form="customer-form-el" disabled={pending} data-testid="button-save-customer">{pending ? 'در حال بررسی و ذخیره…' : createdForTags ? 'تلاش دوباره برای ذخیره برچسب‌ها' : isEditing ? 'ذخیره تغییرات' : 'ثبت مشتری'}</button>
      </>}>
      <span className="csx-sr" id="customer-form-title">{isEditing ? 'ویرایش پرونده' : 'افزودن مشتری جدید'}</span>
      <button type="button" className="csx-sr" onClick={onClose} data-testid="button-close-customer-form">بستن</button>
      {error && <div className="csx-note bad" role="alert" data-testid="error-save-customer"><p>{error}</p></div>}
      <form id="customer-form-el" onSubmit={submit} noValidate>
        <div className="form-grid">
          {!isEditing ? <details className="csx-more ai-customer-import" open={sourceText.length > 0 || undefined}>
            <summary><Sparkles size={18} aria-hidden="true" /> استخراج خودکار از متن پیام</summary>
            <div className="body">
              <label htmlFor="customer-source-text" className="hint">متن دایرکت اینستاگرام را اینجا پیست کنید.</label>
              <div className="ai-customer-textarea-wrap">
                <ClipboardPaste size={17} />
                <textarea id="customer-source-text" value={sourceText} onChange={(event) => setSourceText(event.target.value)}
                  onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData('text'); setSourceText(text); window.setTimeout(() => analyzeCustomerText(text), 0); }}
                  placeholder={'مثلاً:\nسلام من علی مرادی‌ام\n09120504376\nلطفاً زودتر تماس بگیرید'} data-testid="textarea-customer-source" />
              </div>
              <button type="button" className="csx-ghost" disabled={parseText.isPending || sourceText.trim().length < 3} onClick={() => analyzeCustomerText()} data-testid="button-parse-customer-text">
                {parseText.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {parseText.isPending ? 'در حال تحلیل…' : 'تحلیل متن'}
              </button>
              {parseText.isError ? <p className="err" role="alert" data-testid="error-parse-customer-text">تحلیل متن انجام نشد. دوباره تلاش کنید یا اطلاعات را دستی وارد کنید.</p> : null}
              {parseText.isSuccess ? <p className="hint ok" data-testid="success-parse-customer-text">نام، شماره تماس و توضیحات استخراج شد؛ لطفاً قبل از ثبت بررسی کنید.</p> : null}
            </div>
          </details> : null}
          <div className="field"><label htmlFor="customer-name">نام و نام خانوادگی</label><input id="customer-name" value={form.name} onChange={(e) => { setValue('name', e.target.value); setFieldErrors(c => ({ ...c, name: '' })); }} required aria-invalid={Boolean(fieldErrors.name) || undefined} aria-describedby={fieldErrors.name ? 'customer-name-err' : undefined} data-testid="input-customer-name" />
            {fieldErrors.name ? <p className="err" id="customer-name-err"><AlertCircle size={16} aria-hidden="true" /> {fieldErrors.name}</p> : null}</div>
          <div className="field"><label htmlFor="customer-phone">شماره موبایل</label><input id="customer-phone" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => { setValue('phone', e.target.value); setFieldErrors(c => ({ ...c, phone: '' })); setMatched(null); }} required minLength={3} aria-invalid={Boolean(fieldErrors.phone || matched) || undefined} aria-describedby={fieldErrors.phone || matched ? 'customer-phone-err' : undefined} data-testid="input-customer-phone" />
            {fieldErrors.phone ? <p className="err" id="customer-phone-err"><AlertCircle size={16} aria-hidden="true" /> {fieldErrors.phone}</p> : null}
            {matched ? <p className="err" id="customer-phone-err"><AlertCircle size={16} aria-hidden="true" /> این شماره برای «{matched.name}» ثبت شده است.</p> : null}
          </div>
          {matched ? <div className="csx-dupe" data-testid="duplicate-mobile">
            <Link href={`/customers/${matched.id}`} className="csx-link" onClick={onClose} data-testid="link-open-existing-customer">باز کردن پرونده موجود</Link>
            <p className="hint">پرونده جدید ساخته نمی‌شود و کارشناس فعلی تغییر نمی‌کند. اگر مشتری درخواست تازه‌ای دارد، دلیل تماس دوباره را بنویسید تا برای همان پرونده ثبت شود.</p>
            <details className="csx-more">
              <summary>اطلاعات پرونده موجود</summary>
              <div className="body duplicate-profile" data-testid="profile-existing-customer">
                {([
                  ['نام مشتری', matched.name], ['شماره همراه', formatPhoneForDisplay(matched.phone)], ['شناسه', `#${matched.id.toLocaleString('fa-IR', { useGrouping: false })}`],
                  ['کارشناس فعلی', matched.salespersonName || 'بدون تخصیص'], ['کد ملی', matched.nationalCode || 'ثبت نشده'],
                  ['کد پستی', matched.postalCode || 'ثبت نشده'], ['تاریخ تولد', matched.birthDateJalali || 'ثبت نشده'],
                  ['وضعیت', matched.status === 'completed' ? 'اتمام' : matched.status === 'cancelled' ? 'لغو شده' : 'در حال انجام'],
                  ['اولویت', matched.priority?.toLocaleString('fa-IR') || 'بدون اولویت'],
                  ['فوری', matched.isUrgent ? 'بله' : 'خیر'],
                  ['تعداد فعالیت‌ها', matched.activityCount.toLocaleString('fa-IR')],
                  ['درخواست‌های جدید', matched.pendingRepeatRequestCount.toLocaleString('fa-IR')],
                  ['توضیحات پرونده', matched.description || 'ثبت نشده'],
                ] as [string, string][]).map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
              </div>
            </details>
            <div className="field"><label htmlFor="repeat-explanation">دلیل درخواست دوباره</label><textarea id="repeat-explanation" value={explanation} onChange={e => setExplanation(e.target.value)} placeholder="این بار مشتری چه درخواستی دارد؟" data-testid="textarea-repeat-explanation" /></div>
            {repeat.isError && <p className="err" role="alert">ثبت درخواست جدید انجام نشد. دوباره تلاش کنید.</p>}
            <div className="csx-two">
              <button className="csx-ghost" type="button" onClick={() => setMatched(null)} disabled={repeat.isPending} data-testid="button-cancel-repeat-request">انصراف</button>
              <button className="csx-primary" type="button" disabled={!explanation.trim() || repeat.isPending} onClick={createRepeat} data-testid="button-create-repeat-request">{repeat.isPending ? 'در حال ثبت…' : 'ثبت درخواست برای پرونده موجود'}</button>
            </div>
          </div> : null}
          <div className="field"><label htmlFor="customer-description">توضیح (اختیاری)</label><textarea id="customer-description" value={form.description} onChange={(e) => setValue('description', e.target.value)} placeholder="زمینه تماس یا نیاز مالی مشتری..." data-testid="textarea-customer-description" /></div>
          {salespersonField}
          {isEditing ? moreFields : <details className="csx-more" data-testid="customer-form-more">
            <summary>اطلاعات بیشتر (اختیاری)</summary>
            <div className="body">{moreFields}</div>
          </details>}
        </div>
      </form>
      {programsOpen && isAdmin ? <AllocationProgramManager salespersons={salespersons} onClose={() => setProgramsOpen(false)} /> : null}
    </Sheet>
  </div>;
}
