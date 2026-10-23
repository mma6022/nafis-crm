import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { portalApi } from './api';
import { parseJalaliValue } from '@/lib/jalali';
import { AuthError, AuthFrame, NextHint, toLatinDigits } from './CustomerLogin';

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
  const [error, setError] = useState<unknown>('');
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
    } catch (e) { setError(e instanceof Error ? e : 'درخواست انجام نشد.'); }
    finally { setPending(false); }
  };
  const changeMobile = async () => {
    setPending(true); setError('');
    try {
      await portalApi.logout();
      queryClient.removeQueries({ queryKey: ['customer'] });
      navigate('/customer/login');
    } catch (e) { setError(e instanceof Error ? e : 'خروج انجام نشد؛ دوباره تلاش کنید.'); }
    finally { setPending(false); }
  };
  return <AuthFrame step="identity" titleId="cl-identity-title" onBack={pending ? undefined : () => void changeMobile()}>
    <div><span className="nfp-ok-badge"><CheckCircle2 className="nfp-i nfp-s" aria-hidden="true" />شماره همراه تأیید شد</span></div>
    <div><h1 id="cl-identity-title" data-testid="title-identity">احراز هویت</h1></div>
    <p className="nfp-sub">فقط بار اول لازم است. بقیه‌ی مشخصات از سامانه‌ی رسمی دریافت می‌شود.</p>
    <form onSubmit={submit} noValidate>
      <div className="nf-field"><label className="nf-label" htmlFor="cl-national-code">کد ملی</label>
        <input id="cl-national-code" className="nf-input nf-input--ltr" required inputMode="numeric" maxLength={10} dir="ltr" autoComplete="off" autoFocus
          placeholder="۱۰ رقم" value={nationalCode}
          onChange={e => { const v = toLatinDigits(e.target.value).replace(/\D/g, '').slice(0, 10); setNationalCode(v); setError(''); if (v.length === 10) birthInput.current?.focus(); }}
          data-testid="input-national-code" /></div>
      <div className="nf-field"><label className="nf-label" htmlFor="cl-birth-date">تاریخ تولد (شمسی)</label>
        <input id="cl-birth-date" ref={birthInput} className="nf-input nf-input--ltr" required inputMode="numeric" dir="ltr" placeholder="۱۳۷۰/۰۱/۰۱" maxLength={10} aria-describedby="cl-birth-hint"
          value={birthDate} onChange={e => { setBirthDate(formatJalaliInput(e.target.value)); setError(''); }} data-testid="input-birth-date" />
        <span id="cl-birth-hint" className="nf-hint">روز، ماه و سال را پشت سر هم بنویسید؛ «/» خودکار گذاشته می‌شود.</span></div>
      <div aria-live="polite">{error ? <AuthError error={error} testId="status-identity-error" /> : null}</div>
      <button className="nf-btn nf-btn--primary nf-btn--block" disabled={pending} aria-busy={pending || undefined} data-testid="button-submit-identity">
        {pending ? <><RefreshCw className="nfp-i nfp-s nfp-spin-i" aria-hidden="true" />در حال استعلام…</> : 'تأیید هویت و ورود'}
      </button>
      <button type="button" className="nf-btn nf-btn--text nf-btn--block" disabled={pending} data-testid="button-identity-change-mobile" onClick={changeMobile}>تغییر شماره همراه</button>
    </form>
    <NextHint text="ورود به پرتال و دیدن درخواست‌ها" />
  </AuthFrame>;
}
