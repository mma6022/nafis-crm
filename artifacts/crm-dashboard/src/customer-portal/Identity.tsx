import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
import { portalApi } from './api';
import { parseJalaliValue } from '@/lib/jalali';
import './portal.css';

const digits = (v: string) => v.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

export function IdentityPage() {
  useEffect(() => { document.title = 'احراز هویت | نفیس'; }, []);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const code = digits(nationalCode).trim(); const birth = digits(birthDate).trim();
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
  return <div className="cp cp-login"><main className="cp-login-main" style={{ gridColumn: '1 / -1' }}><div className="cp-login-panel">
    <span className="cp-kicker"><ShieldCheck size={14} /> مرحله دوم ورود</span>
    <h1 style={{ marginTop: 17, fontSize: 27, letterSpacing: '-.05em' }} data-testid="title-identity">احراز هویت</h1>
    <p>شماره همراه شما تأیید شده است. برای ادامه، کد ملی و تاریخ تولد خود را وارد کنید؛ سایر مشخصات از سرویس رسمی دریافت می‌شود.</p>
    <form className="cp-form" onSubmit={submit}>
      <label className="cp-field">کد ملی<input required inputMode="numeric" maxLength={10} dir="ltr" autoComplete="off" value={nationalCode} onChange={e => setNationalCode(e.target.value)} data-testid="input-national-code" /></label>
      <label className="cp-field">تاریخ تولد شمسی<input required dir="ltr" placeholder="1370/01/01" value={birthDate} onChange={e => setBirthDate(e.target.value)} data-testid="input-birth-date" /></label>
      {error && <div className="cp-alert" role="alert" data-testid="status-identity-error">{error}</div>}
      <button className="cp-btn cp-btn-primary" disabled={pending} data-testid="button-submit-identity">{pending ? 'در حال استعلام…' : 'تأیید هویت'} <ArrowLeft size={16} /></button>
    </form>
    <button type="button" className="cp-btn cp-btn-outline" style={{ marginTop: 16 }} disabled={pending}
      data-testid="button-identity-change-mobile" onClick={async () => {
        setPending(true); setError('');
        try {
          await portalApi.logout();
          queryClient.removeQueries({ queryKey: ['customer'] });
          navigate('/customer/login');
        } catch (e) { setError(e instanceof Error ? e.message : 'خروج انجام نشد؛ دوباره تلاش کنید.'); }
        finally { setPending(false); }
      }}>تغییر شماره همراه</button>
  </div></main></div>;
}
