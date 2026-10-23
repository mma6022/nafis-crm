import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, useLocation, useSearch } from 'wouter';
import { AlertCircle, ArrowRight, ChevronLeft, Clock, LockKeyhole, Pencil, RefreshCw } from 'lucide-react';
import { portalApi, PortalApiError } from './api';
import { useWizard, type WizardStep } from '@/components/wizard/Wizard';
import { SUPPORT_PHONE } from './customer-stage-map';
import logoUrl from './assets/nafis-logo-full.svg';
import './portal.css';
import './nfp.css';

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
const I = ({ icon: Icon, small, className = '' }: { icon: typeof Clock; small?: boolean; className?: string }) => <Icon className={`nfp-i${small ? ' nfp-s' : ''} ${className}`} aria-hidden="true" />;

/** Server message + support phone for account conflicts (409) and unavailable SMS/registration (503). */
export function AuthError({ error, testId }: { error: unknown; testId?: string }) {
  const text = typeof error === 'string' ? error : message(error);
  const support = error instanceof PortalApiError && (error.status === 409 || error.status === 503);
  return <div className="nfp-alert" role="alert" data-testid={testId}><I icon={AlertCircle} /><span>{text}{support && <> پشتیبانی: <a href={`tel:${SUPPORT_PHONE.tel}`} className="nfp-ltr" dir="ltr">{SUPPORT_PHONE.display}</a></>}</span></div>;
}

const STEP_INDEX = { mobile: 1, code: 2, identity: 3 } as const;
/** Shared frame of the three-step sign-in wizard (handoff §1): logo, step meta, progress bar, trust line and side panel on desktop. */
export function AuthFrame({ step, titleId, onBack, footer, children }: { step: keyof typeof STEP_INDEX; titleId: string; onBack?: () => void; footer?: ReactNode; children: ReactNode }) {
  const n = STEP_INDEX[step];
  return <div className="cp nfp" dir="rtl"><main className="nfp-auth">
    <div className="nfp-auth-top"><img src={logoUrl} alt="نفیس وام" /></div>
    <div className="nfp-auth-shell"><section className="nfp-auth-card" aria-labelledby={titleId}>
      <span className="nfp-logo-in"><img src={logoUrl} alt="نفیس وام" /></span>
      <div className="nfp-wz-meta">{onBack ? <button type="button" className="nfp-wz-back" onClick={onBack} data-testid="button-wizard-back"><I icon={ArrowRight} small />قبلی</button> : <span />}
        <span>مرحله <b>{fa(n)}</b> از {fa(CUSTOMER_AUTH_STEPS.length)}<span className="nfp-sep" aria-hidden="true" />{CUSTOMER_AUTH_STEPS[n - 1].title}</span></div>
      <div className="nf-progress" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={n} aria-label="پیشرفت ورود" style={{ ['--steps' as string]: 3 }}>
        {CUSTOMER_AUTH_STEPS.map((item, i) => <span key={item.key} className={i + 1 < n ? 'is-done' : i + 1 === n ? 'is-current' : ''} data-testid={`step-customer-${item.key}`} />)}</div>
      {children}
      <p className="nfp-trust"><I icon={LockKeyhole} small />ورود امن با کد یک‌بارمصرف پیامکی</p>
      {footer}
    </section>
    <aside className="nfp-auth-side" aria-label="درباره‌ی پیگیری درخواست">
      <div style={{ display: 'grid', gap: 10 }}><h2>پیگیری درخواست وام، <span className="nfp-gold">بدون تماس و انتظار</span></h2><p>بعد از ورود، همیشه می‌بینید پرونده‌تان کجاست و قدم بعدی چیست.</p></div>
      <ol><li><span>۱</span><div><b>ورود با شماره همراه</b><small>کد یک‌بارمصرف پیامکی</small></div></li>
        <li><span>۲</span><div><b>احراز هویت، فقط بار اول</b><small>کد ملی و تاریخ تولد</small></div></li>
        <li><span>۳</span><div><b>دیدن وضعیت و مرحله‌ی بعدی</b><small>امضا، مدارک و کارشناس پرونده</small></div></li></ol>
      <p style={{ fontSize: 14 }}>پشتیبانی: <a href={`tel:${SUPPORT_PHONE.tel}`} className="nfp-ltr" dir="ltr">{SUPPORT_PHONE.display}</a></p>
    </aside></div>
  </main></div>;
}
export const NextHint = ({ text }: { text: string }) => <div className="nfp-next-hint"><I icon={ChevronLeft} /><span>مرحله‌ی بعد: <b>{text}</b></span></div>;

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
  return <div className={`nfp-otp${invalid ? ' nfp-bad' : ''}`} dir="ltr" role="group" aria-labelledby="otp-label">
    {chars.map((char, index) => <input
      key={index}
      ref={el => { refs.current[index] = el; }}
      className={char && !invalid ? 'nfp-f' : ''}
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
  const [error, setErrorText] = useState('');
  const lastError = useRef<unknown>(null);
  const setError = (value: unknown) => { lastError.current = typeof value === 'string' ? null : value; setErrorText(typeof value === 'string' ? value : message(value)); };
  const expired = new URLSearchParams(useSearch()).get('expired') === '1';
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
    } catch (e) { setError(e); setCode(''); lastAutoSubmit.current = ''; }
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
    try { await otp.mutateAsync(); wizard.update({ sentAt: Date.now() }); setResendRemaining(RESEND_SECONDS); setCode(''); lastAutoSubmit.current = ''; setStep('code'); } catch (e) { setError(e); }
  };
  const resend = () => {
    setError('');
    otp.mutate(undefined, { onSuccess: () => { wizard.update({ sentAt: Date.now() }); setResendRemaining(RESEND_SECONDS); setCode(''); lastAutoSubmit.current = ''; }, onError: e => setError(e) });
  };
  const changeNumber = () => { setStep('mobile'); setError(''); setCode(''); lastAutoSubmit.current = ''; setTimeout(() => mobileInput.current?.focus(), 0); };

  const failed = error ? (lastError.current ?? error) : '';
  return <AuthFrame step={step} titleId="cl-title" onBack={step === 'code' ? changeNumber : undefined}
    footer={step === 'mobile' ? <Link href="/login" className="nfp-staff" data-testid="link-staff-login">ورود کارکنان</Link> : undefined}>
    {step === 'mobile' ? <>
      {expired && <div className="nfp-alert nfp-warn" role="status" data-testid="status-session-expired"><I icon={Clock} /><span>نشست شما پایان یافته است. دوباره وارد شوید.</span></div>}
      <div><h1 id="cl-title">ورود یا ثبت‌نام</h1></div>
      <p className="nfp-sub">شماره همراهی را بنویسید که به نام خودتان است. اگر حساب نداشته باشید، خودکار ساخته می‌شود.</p>
      {error && <AuthError error={failed} />}
      <form onSubmit={requestCode} noValidate>
        <div className="nf-field"><label className="nf-label" htmlFor="cl-mobile">شماره همراه</label>
          <input id="cl-mobile" ref={mobileInput} className="nf-input nf-input--ltr" type="tel" inputMode="numeric" dir="ltr" autoComplete="tel-national"
            placeholder="۰۹xx xxx xxxx" autoFocus value={mobile} maxLength={20}
            aria-invalid={Boolean(mobileError) || undefined} aria-describedby="cl-mobile-hint"
            onChange={e => { setMobile(normalizeMobile(e.target.value)); setError(''); }}
            data-testid="input-customer-mobile" />
          {mobileError ? <span id="cl-mobile-hint" className="nf-error" aria-live="polite"><I icon={AlertCircle} small />{mobileError}</span>
            : <span id="cl-mobile-hint" className="nf-hint" aria-live="polite">کد ورود به همین شماره پیامک می‌شود.</span>}</div>
        <button className="nf-btn nf-btn--primary nf-btn--block" disabled={busy} aria-busy={busy} data-testid="button-customer-auth">
          {otp.isPending ? <><I icon={RefreshCw} small className="nfp-spin-i" />در حال ارسال کد…</> : 'دریافت کد ورود'}
        </button>
      </form>
      <NextHint text="وارد کردن کد شش‌رقمی پیامک‌شده" />
    </> : <>
      <div><h1 id="cl-title">کد تأیید را وارد کنید</h1></div>
      <p className="nfp-sub">کد شش‌رقمی به این شماره پیامک شد:</p>
      <div><span className="nfp-phone-chip"><bdi className="nfp-ltr" dir="ltr">{formatMobile(mobile)}</bdi>
        <button type="button" onClick={changeNumber} disabled={busy} data-testid="button-change-mobile"><I icon={Pencil} small />تغییر شماره</button></span></div>
      <form onSubmit={submitCode} noValidate>
        <div className="nf-field"><span className="nf-label" id="otp-label">کد تأیید</span>
          <OtpBoxes value={code} onChange={value => { setCode(value); setError(''); }} disabled={verify.isPending} invalid={Boolean(error)} />
          <div aria-live="polite">{error ? <AuthError error={failed} /> : <span className="nf-hint">با پر شدن شش رقم، خودکار بررسی می‌شود.</span>}</div></div>
        <button className="nf-btn nf-btn--primary nf-btn--block" disabled={busy || code.length !== OTP_LENGTH} aria-busy={busy} data-testid="button-customer-auth">
          {verify.isPending ? <><I icon={RefreshCw} small className="nfp-spin-i" />در حال بررسی…</> : 'تأیید و ورود'}
        </button>
        <div className="nfp-resend">
          {resendRemaining > 0
            ? <span aria-live="off">ارسال دوباره‌ی کد تا <b dir="ltr">{countdown(resendRemaining)}</b> دیگر</span>
            : <span>کد را دریافت نکردید؟</span>}
          <button type="button" disabled={busy || resendRemaining > 0} onClick={resend} data-testid="button-resend-otp">
            {otp.isPending ? 'در حال ارسال…' : 'ارسال دوباره'}
          </button>
        </div>
      </form>
      <NextHint text="احراز هویت با کد ملی (فقط بار اول)" />
    </>}
  </AuthFrame>;
}
