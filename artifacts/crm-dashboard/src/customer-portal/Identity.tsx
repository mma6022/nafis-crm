import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ShieldCheck, ArrowLeft, IdCard, Loader2 } from 'lucide-react';
import { portalApi } from './api';
import { parseJalaliValue } from '@/lib/jalali';
import { Stepper } from '@/components/wizard/Wizard';
import { CUSTOMER_AUTH_STEPS, toLatinDigits } from './CustomerLogin';
import './portal.css';
import './customer-login.css';

/** Keeps digits only and inserts the slashes as the user types: 13700101 → 1370/01/01. */
export function formatJalaliInput(value: string) {
  const d = toLatinDigits(value).replace(/\D/g, '').slice(0, 8);
  return d.length > 6 ? `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6)}` : d.length > 4 ? `${d.slice(0, 4)}/${d.slice(4)}` : d;
}

/** Step 3 of the customer sign-up wizard (only shown until identity is verified). */
export function IdentityPage() {
  useEffect(() => { document.title = 'احراز هویت | نفیس'; }, []);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const birthInput = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const code = toLatinDigits(nationalCode).trim(); const birth = formatJalaliInput(birthDate);
    if (!/^\d{10}$/.test(code)) { setError('کد ملی باید ۱۰ رقم باشد.'); return; }
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(birth) || !parseJalaliValue(birth)) { setError('تاریخ تولد را به صورت ۱۳۷۰/۰۱/۰۱ وارد کنید.'); return; }
    setPending(true);
    try {
      const result = await portalApi.identity(code, birth);
      if (!result.identityReady) setError(result.message || 'هویت شما تأیید نشد. اطلاعات را بررسی کنید.');
      await queryClient.invalidateQueries({ queryKey: ['customer', 'me'] });
    } catch (e) { setError(e instanceof Error ? e.message : 'درخواست انجام نشد.'); }
    finally { setPending(false); }
  };
  const changeMobile = async () => {
    setPending(true); setError('');
    try {
      await portalApi.logout();
      queryClient.removeQueries({ queryKey: ['customer'] });
      navigate('/customer/login');
    } catch (e) { setError(e instanceof Error ? e.message : 'خروج انجام نشد؛ دوباره تلاش کنید.'); }
    finally { setPending(false); }
  };
  return <div className="cp customer-login" dir="rtl">
    <main className="cl-main">
      <section className="cl-card" aria-labelledby="cl-identity-title">
        <div className="cl-brand">
          <img src={`${import.meta.env.BASE_URL}brand/nafiss-logo-transparent.png`} alt="نفیس" width={180} height={56} />
          <span>گروه مالی نفیس</span>
        </div>
        <Stepper steps={CUSTOMER_AUTH_STEPS} current="identity" className="cl-stepper" testPrefix="step-customer-" />
        <div className="cl-step-icon" aria-hidden="true"><IdCard size={24} /></div>
        <h1 id="cl-identity-title" data-testid="title-identity">احراز هویت</h1>
        <p className="cl-sub">شماره همراه شما تأیید شد. فقط کد ملی و تاریخ تولد را وارد کنید؛ بقیهٔ مشخصات از سامانهٔ رسمی دریافت می‌شود.</p>
        <form className="cl-form" onSubmit={submit} noValidate>
          <div className="cl-field">
            <label className="cl-label" htmlFor="cl-national-code">کد ملی</label>
            <input id="cl-national-code" className="cl-input is-text" required inputMode="numeric" maxLength={10} dir="ltr" autoComplete="off" autoFocus
              placeholder="۱۰ رقم" value={nationalCode}
              onChange={e => { const v = toLatinDigits(e.target.value).replace(/\D/g, '').slice(0, 10); setNationalCode(v); setError(''); if (v.length === 10) birthInput.current?.focus(); }}
              data-testid="input-national-code" />
          </div>
          <div className="cl-field">
            <label className="cl-label" htmlFor="cl-birth-date">تاریخ تولد (شمسی)</label>
            <input id="cl-birth-date" ref={birthInput} className="cl-input is-text" required inputMode="numeric" dir="ltr" placeholder="1370/01/01" maxLength={10} aria-describedby="cl-birth-hint"
              value={birthDate} onChange={e => { setBirthDate(formatJalaliInput(e.target.value)); setError(''); }} data-testid="input-birth-date" />
            <small id="cl-birth-hint" className="cl-hint">روز، ماه و سال را پشت سر هم بنویسید؛ «/» خودکار گذاشته می‌شود.</small>
          </div>
          <div aria-live="polite">{error && <div className="cl-alert" role="alert" data-testid="status-identity-error">{error}</div>}</div>
          <button className="cl-btn" disabled={pending} aria-busy={pending || undefined} data-testid="button-submit-identity">
            {pending ? <><Loader2 className="cl-spin" size={18} /> در حال استعلام…</> : <>تأیید هویت و ورود <ArrowLeft size={18} /></>}
          </button>
          <button type="button" className="cl-btn cl-btn-ghost" disabled={pending} data-testid="button-identity-change-mobile" onClick={changeMobile}>تغییر شماره همراه</button>
        </form>
        <p className="cl-trust"><ShieldCheck size={15} /> اطلاعات شما فقط برای استعلام هویت استفاده می‌شود.</p>
      </section>
    </main>
  </div>;
}
