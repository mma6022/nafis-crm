import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getListCustomersQueryKey } from '@workspace/api-client-react';
import { normalizeDigits } from '@/lib/customer-field-validation';

type Lead = {
  id: string | number;
  name?: string | null;
  phone?: string | null;
  request?: string | null;
};

const conversionErrors: Record<string, string> = {
  duplicate_mobile: 'این شماره در فهرست مشتریان وجود دارد. پروندهٔ تازه ساخته نشد؛ مورد را بررسی کنید.',
  incomplete_lead: 'برای ثبت مشتری، نام، موبایل و درخواست باید ابتدا در گفت‌وگوی دایرکت دریافت شوند.',
  allocation_program_unavailable: 'برنامهٔ پیش‌فرض تخصیص کارشناس فعال نیست یا کارشناس فعالی ندارد. تنظیمات تخصیص را بررسی کنید.',
  allocation_program_missing: 'برنامهٔ پیش‌فرض تخصیص کارشناس تعریف نشده است. تنظیمات تخصیص را بررسی کنید.',
  already_converted: 'این گفت‌وگو قبلاً به پروندهٔ مشتری تبدیل شده است. فهرست را به‌روزرسانی کنید.',
};

export default function InstagramLeadReview({ lead, onConverted }: { lead: Lead; onConverted: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(lead.name ?? '');
  const [phone, setPhone] = useState(lead.phone ?? '');
  const [request, setRequest] = useState(lead.request ?? '');
  const [edited, setEdited] = useState({ name: false, phone: false, request: false });
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Polling can fill a selected lead while this form is open. Refresh only
  // untouched fields so a staff member's in-progress corrections are preserved.
  useEffect(() => { if (!edited.name) setName(lead.name ?? ''); }, [lead.name, edited.name]);
  useEffect(() => { if (!edited.phone) setPhone(lead.phone ?? ''); }, [lead.phone, edited.phone]);
  useEffect(() => { if (!edited.request) setRequest(lead.request ?? ''); }, [lead.request, edited.request]);
  const complete = Boolean(lead.name?.trim() && lead.phone?.trim() && lead.request?.trim());
  const phoneDigits = normalizeDigits(phone).replace(/[\s().+-]/g, '');
  const valid = name.trim().split(/\s+/).length >= 2 &&
    /^[۰-۹٠-٩0-9+\s().-]+$/.test(phone) &&
    /^(?:09\d{9}|9\d{9}|989\d{9}|00989\d{9})$/.test(phoneDigits) &&
    request.trim().length >= 3;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || !valid || !reviewed || pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/instagram/threads/${encodeURIComponent(String(lead.id))}/convert`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), request: request.trim(), reviewed: true }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { code?: string; error?: string };
        throw new Error(conversionErrors[result.code ?? ''] ??
          (response.status === 403 ? 'مجوز ثبت مشتری برای حساب شما فعال نیست.' : `ثبت مشتری انجام نشد (${response.status}).`));
      }
      await queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      onConverted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ثبت مشتری انجام نشد.');
    } finally {
      setPending(false);
    }
  }

  return <section className="instagram-lead-review" aria-labelledby="instagram-review-heading">
    <div className="instagram-review-heading">
      <strong id="instagram-review-heading">بررسی دستی در صورت نیاز</strong>
      <p>با دریافت نام و نام خانوادگی و موبایل، ثبت خودکار بدون تأیید مدیر انجام می‌شود: مشتری جدید «تأییدنشده»، بدون اولویت و با برنامهٔ پیش‌فرض تخصیص کارشناس ثبت می‌شود. برای شمارهٔ موجود، درخواست چندباره ثبت می‌شود و مشخصات و کارشناس قبلی تغییر نمی‌کنند. این فرم برای رسیدگی دستی به موارد حل‌نشده است؛ شمارهٔ نوشته‌شده در دایرکت به‌تنهایی تأیید هویت نیست.</p>
    </div>
    {!complete ? <p className="instagram-review-notice">برای ثبت خودکار، نام و نام خانوادگی و موبایل کافی است؛ این فرم دستی علاوه بر آن‌ها به شرح درخواست نیاز دارد.</p> : null}
    <form onSubmit={(event) => void submit(event)}>
      <label>نام و نام خانوادگی
        <input value={name} onChange={(event) => { setName(event.target.value); setEdited((current) => ({ ...current, name: true })); }} maxLength={100} required
          data-testid="input-instagram-review-name" />
      </label>
      <label>موبایل
        <input value={phone} onChange={(event) => { setPhone(event.target.value); setEdited((current) => ({ ...current, phone: true })); }} inputMode="tel" dir="ltr" required
          data-testid="input-instagram-review-phone" />
      </label>
      <label>درخواست مشتری
        <textarea value={request} onChange={(event) => { setRequest(event.target.value); setEdited((current) => ({ ...current, request: true })); }} rows={3} maxLength={2000} required
          data-testid="input-instagram-review-request" />
      </label>
      <label className="instagram-review-confirmation">
        <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}
          data-testid="checkbox-instagram-review-confirm" />
        شماره و اطلاعات این متقاضی را بررسی کرده‌ام و ثبت پروندهٔ مشتری را تأیید می‌کنم.
      </label>
      {error ? <p className="instagram-review-error" role="alert">{error}</p> : null}
      <button type="submit" disabled={!complete || !valid || !reviewed || pending} data-testid="button-instagram-convert">
        {pending ? <LoaderCircle size={15} className="instagram-spinning" /> : <Check size={15} />}
        {pending ? 'در حال ثبت…' : 'افزودن به مشتریان با تخصیص پیش‌فرض'}
      </button>
    </form>
  </section>;
}