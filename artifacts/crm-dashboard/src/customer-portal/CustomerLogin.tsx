import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowLeft, Loader2, MessageSquareText, Pencil, ShieldCheck, Smartphone } from 'lucide-react';
import { portalApi } from './api';
import { Stepper, useWizard, type WizardStep } from '@/components/wizard/Wizard';
import './customer-login.css';

/** The customer sign-in / sign-up journey, shared by CustomerLogin (steps 1–2) and IdentityPage (step 3). */
export const CUSTOMER_AUTH_STEPS: readonly WizardStep<'mobile' | 'code' | 'identity'>[] = [
  { key: 'mobile', title: 'شماره همراه' },
  { key: 'code', title: 'کد تأیید' },
  { key: 'identity', title: 'احراز هویت' },
];

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

/** Persian/Arabic-Indic digits → Latin. */
export const toLatinDigits = (value: string) => value
  .replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

/** Normalises typed/pasted mobile numbers (+98 / 0098 / 98 / 9xx) to 09xxxxxxxxx form. */
export function normalizeMobile(value: string) {
  let d = toLatinDigits(value).replace(/\D/g, '');
  if (d.startsWith('0098')) d = `0${d.slice(4)}`;
  else if (d.startsWith('98') && d.length >= 12) d = `0${d.slice(2)}`;
  else if (d.startsWith('9') && d.length === 10) d = `0${d}`;
  return d.slice(0, 11);
}
export const isValidMobile = (value: string) => /^09\d{9}$/.test(value);
const fa = (value: string | number) => String(value).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const formatMobile = (value: string) => fa(value.replace(/^(\d{4})(\d{3})(\d{0,4})$/, '$1 $2 $3').trim());
const countdown = (seconds: number) => fa(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
const message = (error: unknown) => error instanceof Error ? error.message : 'درخواست انجام نشد. دوباره تلاش کنید.';

function OtpBoxes({ value, onChange, disabled, invalid }: { value: string; onChange: (value: string) => void; disabled: boolean; invalid: boolean }) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (index: number) => { const el = refs.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))]; el?.focus(); el?.select(); };
  useEffect(() => { focus(Math.min(value.length, OTP_LENGTH - 1)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (invalid) focus(0); }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  const chars = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? '');
  const fill = (index: number, raw: string) => {
    const incoming = toLatinDigits(raw).replace(/\D/g, '');
    if (!incoming) return;
    // Keep the code contiguous; a multi-digit value (SMS autofill / paste) fills from this box onwards.
    const pos = Math.min(index, value.length);
    const next = incoming.length > 1
      ? (value.slice(0, pos) + incoming).slice(0, OTP_LENGTH)
      : (value.slice(0, pos) + incoming + value.slice(pos + 1)).slice(0, OTP_LENGTH);
    onChange(next);
    focus(pos + incoming.length);
  };
  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (chars[index]) onChange(value.slice(0, index) + value.slice(index + 1));
      else if (index > 0) { onChange(value.slice(0, index - 1) + value.slice(index)); focus(index - 1); }
    } else if (event.key === 'ArrowLeft') { event.preventDefault(); focus(index + 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); focus(index - 1); }
  };
  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    fill(index, event.clipboardData.getData('text'));
  };
  return <div className="cl-otp" dir="ltr" role="group" aria-label="کد تأیید شش‌رقمی">
    {chars.map((char, index) => <input
      key={index}
      ref={el => { refs.current[index] = el; }}
      className={`cl-otp-box${char ? ' is-filled' : ''}${invalid ? ' is-invalid' : ''}`}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete={index === 0 ? 'one-time-code' : 'off'}
      maxLength={index === 0 ? OTP_LENGTH : 1}
      aria-label={`رقم ${fa(index + 1)} از ${fa(OTP_LENGTH)}`}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={char}
      onFocus={e => e.currentTarget.select()}
      onChange={e => fill(index, e.target.value)}
      onKeyDown={e => onKeyDown(index, e)}
      onPaste={e => onPaste(index, e)}
      data-testid={index === 0 ? 'input-customer-otp' : `input-customer-otp-${index}`}
    />)}
  </div>;
}

export function CustomerLogin() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  // Progress (step + number + when the code was sent) survives a refresh; the OTP itself is never stored.
  const wizard = useWizard({ id: 'customer-login', steps: CUSTOMER_AUTH_STEPS, initial: { mobile: '', sentAt: 0 }, maxAgeMs: 10 * 60_000 });
  const mobile = wizard.data.mobile;
  const setMobile = (value: string) => wizard.update({ mobile: value });
  const step: 'mobile' | 'code' = wizard.step === 'code' && isValidMobile(mobile) ? 'code' : 'mobile';
  const setStep = (next: 'mobile' | 'code') => wizard.goTo(next);
  const [code, setCode] = useState('');
  const [resendRemaining, setResendRemaining] = useState(() => Math.max(0, RESEND_SECONDS - Math.floor((Date.now() - wizard.data.sentAt) / 1000)));
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const lastAutoSubmit = useRef('');
  const mobileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.title = 'ورود مشتریان | نفیس';
    const timer = setInterval(() => setResendRemaining(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  const session = useQuery({ queryKey: ['customer', 'me'], queryFn: portalApi.me, retry: false });
  const otp = useMutation({ mutationFn: () => portalApi.requestOtp(mobile) });
  const verify = useMutation({ mutationFn: () => portalApi.verifyOtp(mobile, toLatinDigits(code).trim()) });
  const busy = otp.isPending || verify.isPending;
  // Inline validation appears after a submit attempt, or as soon as a full-length number is invalid.
  const mobileError = (touched || mobile.length >= 11) && !isValidMobile(mobile)
    ? (!mobile ? 'شماره همراه را وارد کنید.'
      : !mobile.startsWith('09') ? 'شماره همراه باید با ۰۹ آغاز شود.'
      : 'شماره همراه باید ۱۱ رقم باشد.') : '';

  const submitCode = async (event?: FormEvent) => {
    event?.preventDefault(); setError('');
    if (!/^\d{6}$/.test(toLatinDigits(code).trim())) { setError('کد پیامک‌شدهٔ شش‌رقمی را وارد کنید.'); return; }
    try {
      const result = await verify.mutateAsync();
      if (!result.authenticated) throw new Error('تأیید ورود انجام نشد. کد را دوباره بررسی کنید.');
      wizard.reset();
      await queryClient.invalidateQueries({ queryKey: ['customer'] });
      navigate('/customer');
    } catch (e) { setError(message(e)); setCode(''); lastAutoSubmit.current = ''; }
  };
  // Submit automatically once all six digits are present (typed, pasted or SMS-autofilled).
  useEffect(() => {
    if (step === 'code' && code.length === OTP_LENGTH && !busy && lastAutoSubmit.current !== code) {
      lastAutoSubmit.current = code;
      void submitCode();
    }
  }, [code, step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session.isSuccess) return <Redirect to="/customer" />;

  const requestCode = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setTouched(true);
    if (!isValidMobile(mobile)) { mobileInput.current?.focus(); return; }
    try { await otp.mutateAsync(); wizard.update({ sentAt: Date.now() }); setResendRemaining(RESEND_SECONDS); setCode(''); lastAutoSubmit.current = ''; setStep('code'); } catch (e) { setError(message(e)); }
  };
  const resend = () => {
    setError('');
    otp.mutate(undefined, { onSuccess: () => { wizard.update({ sentAt: Date.now() }); setResendRemaining(RESEND_SECONDS); setCode(''); lastAutoSubmit.current = ''; }, onError: e => setError(message(e)) });
  };
  const changeNumber = () => { setStep('mobile'); setError(''); setCode(''); lastAutoSubmit.current = ''; setTimeout(() => mobileInput.current?.focus(), 0); };

  return <div className="cp customer-login" dir="rtl">
    <main className="cl-main">
      <section className="cl-card" aria-labelledby="cl-title">
        <div className="cl-brand">
          <img src={`${import.meta.env.BASE_URL}brand/nafiss-logo-transparent.png`} alt="نفیس" width={180} height={56} />
          <span>گروه مالی نفیس</span>
        </div>
        <Stepper steps={CUSTOMER_AUTH_STEPS} current={step} onGo={key => { if (key === 'mobile') changeNumber(); }} className="cl-stepper" testPrefix="step-customer-" />
        <div className="cl-step-icon" aria-hidden="true">{step === 'mobile' ? <Smartphone size={24} /> : <MessageSquareText size={24} />}</div>
        <h1 id="cl-title">{step === 'mobile' ? 'ورود یا ثبت‌نام' : 'کد تأیید را وارد کنید'}</h1>
        {step === 'mobile'
          ? <p className="cl-sub">شماره همراه خود را وارد کنید تا کد تأیید برایتان پیامک شود. اگر حساب ندارید، همین‌جا ساخته می‌شود.</p>
          : <p className="cl-sub">کد {fa(OTP_LENGTH)} رقمی ارسال‌شده به <bdi dir="ltr" className="cl-phone">{formatMobile(mobile)}</bdi> را وارد کنید.
            <button type="button" className="cl-change" onClick={changeNumber} disabled={busy} data-testid="button-change-mobile"><Pencil size={13} /> تغییر شماره</button></p>}

        {step === 'mobile'
          ? <form className="cl-form" onSubmit={requestCode} noValidate>
            <label className="cl-label" htmlFor="cl-mobile">شماره همراه</label>
            <div className={`cl-input-wrap${mobileError ? ' is-invalid' : ''}`}>
              <input id="cl-mobile" ref={mobileInput} className="cl-input" type="tel" inputMode="numeric" dir="ltr" autoComplete="tel-national"
                placeholder="09xx xxx xxxx" autoFocus value={mobile} maxLength={20}
                aria-invalid={Boolean(mobileError) || undefined} aria-describedby="cl-mobile-hint"
                onChange={e => { setMobile(normalizeMobile(e.target.value)); setError(''); }}
                data-testid="input-customer-mobile" />
            </div>
            <small id="cl-mobile-hint" aria-live="polite" className={`cl-hint${mobileError ? ' is-error' : ''}`}>{mobileError || 'مثال: ۰۹۱۲ ۳۴۵ ۶۷۸۹'}</small>
            {error && <div className="cl-alert" role="alert">{error}</div>}
            <button className="cl-btn" disabled={busy} aria-busy={busy} data-testid="button-customer-auth">
              {otp.isPending ? <><Loader2 className="cl-spin" size={18} /> در حال ارسال کد…</> : <>دریافت کد ورود <ArrowLeft size={18} /></>}
            </button>
          </form>
          : <form className="cl-form" onSubmit={submitCode} noValidate>
            <OtpBoxes value={code} onChange={value => { setCode(value); setError(''); }} disabled={verify.isPending} invalid={Boolean(error)} />
            <div aria-live="polite">{error && <div className="cl-alert" role="alert">{error}</div>}</div>
            <button className="cl-btn" disabled={busy || code.length !== OTP_LENGTH} aria-busy={busy} data-testid="button-customer-auth">
              {verify.isPending ? <><Loader2 className="cl-spin" size={18} /> در حال بررسی…</> : <>تأیید و ورود <ArrowLeft size={18} /></>}
            </button>
            <div className="cl-resend">
              {resendRemaining > 0
                ? <span aria-live="off">ارسال دوباره کد تا <b dir="ltr">{countdown(resendRemaining)}</b> دیگر</span>
                : <span>کد را دریافت نکردید؟</span>}
              <button type="button" className="cl-link-btn" disabled={busy || resendRemaining > 0} onClick={resend} data-testid="button-resend-otp">
                {otp.isPending ? 'در حال ارسال…' : 'ارسال دوباره'}
              </button>
            </div>
          </form>}

        <p className="cl-trust"><ShieldCheck size={14} /> ورود امن با کد یک‌بارمصرف پیامکی</p>
      </section>
      <Link href="/login" className="cl-staff" data-testid="link-staff-login">ورود کارکنان</Link>
    </main>
  </div>;
}
