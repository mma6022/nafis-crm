/**
 * instant-credit-check v1 — «اعتبارسنجی فوری» in the call form (Armita sales-shell v1.0.3 §4د scenes 16–23; code step per v1.0.4 scenes 24–27).
 * Shown only after «جواب داد» → «صحبت کردیم». Optional: it never blocks «بعدی»/«ثبت».
 * Flow: national ID (from the file, read-only; or typed + checksum) → required consent tick → «اعتبارسنجی» (ICS24 initiate, SMS to
 * the customer) → the expert types the SMS code into a masked field → validate → rank A1–E3 (saved in the file by the server).
 * The OTP lives only in this component's state until submit; it is cleared before the request returns and never shown again.
 */
import './team-sales.css';
import { AlertTriangle, Check, Clock, History, Lock, MessageSquare, Phone, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GRADE_LETTERS } from '@/lib/credit-grade';
import { fa, fetchCustomerIdentity, fmtDateTime, listCreditChecks, refreshCreditCheckStatus, renewCreditOtp, startCreditCheck,
  TeamSalesApiError, validateCreditOtp, type CreditCheckLite } from './api';

const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
export const normalizeNid = (s: string) => toLatin(s).replace(/[\s\-‐-―]/g, '').replace(/\D/g, '');
export function validNid(code: string): boolean {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const s = code.slice(0, 9).split('').reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11;
  return (s < 2 ? s : 11 - s) === Number(code[9]);
}
const RECENT_DAYS = 30;
const POLL_MS = 3000, POLL_MAX = 20;
const RESEND_AFTER_S = 120, OTP_TRIES = 5; // server caps: 5 code tries and 3 resends per inquiry
type St = 'init' | 'idle' | 'starting' | 'otp' | 'verifying' | 'processing' | 'result' | 'error' | 'blocked';

export function InstantCreditCheck({ customerId, onRank }: { customerId: number; onRank?: (rank: string) => void }) {
  const [st, setSt] = useState<St>('init');
  const [fileNid, setFileNid] = useState<string | null>(null);
  const [nid, setNid] = useState('');
  const [nidTouched, setNidTouched] = useState(false);
  const [consent, setConsent] = useState(false); // always starts empty (v1.0.3)
  const [recent, setRecent] = useState<CreditCheckLite | null>(null);
  const [res, setRes] = useState<CreditCheckLite | null>(null);
  const [check, setCheck] = useState<CreditCheckLite | null>(null);
  const [otp, setOtp] = useState('');
  const [otpErr, setOtpErr] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [prevFail, setPrevFail] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [consentAt, setConsentAt] = useState<string | null>(null);
  const [wrong, setWrong] = useState(0);
  const [left, setLeft] = useState(0);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  const otpRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { // resend countdown (v1.0.4 scene 24/25)
    if (st !== 'otp' || left <= 0) return;
    const t = window.setTimeout(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [st, left]);
  const enterOtp = (c: CreditCheckLite) => { setCheck(c); setWrong(0); setExpired(false); setLeft(RESEND_AFTER_S); setSt('otp'); setTimeout(() => otpRef.current?.focus(), 0); };

  useEffect(() => {
    let off = false;
    Promise.allSettled([fetchCustomerIdentity(customerId), listCreditChecks(customerId)]).then(([n, l]) => {
      if (off) return;
      const code = n.status === 'fulfilled' && n.value.nationalCode ? normalizeNid(n.value.nationalCode) : '';
      setPhone(n.status === 'fulfilled' ? n.value.phone : null);
      setFileNid(validNid(code) ? code : null);
      const list = l.status === 'fulfilled' ? l.value : [];
      const last = list.find((c) => c.status === 'report_generated' && c.scoreLabel && c.completedAt
        && Date.now() - Date.parse(c.completedAt) < RECENT_DAYS * 86400000);
      setRecent(last ?? null);
      setSt('idle');
    });
    return () => { off = true; };
  }, [customerId]);

  const code = fileNid ?? normalizeNid(nid);
  const nidOk = validNid(code);
  const nidBad = !fileNid && (nidTouched || code.length >= 10) && code.length > 0 && !nidOk;
  const canStart = nidOk && consent && st === 'idle';

  const finish = (c: CreditCheckLite) => {
    if (c.status === 'report_generated' && c.scoreLabel) { setRes(c); setSt('result'); setConsent(false); onRank?.(c.scoreLabel); return; }
    if (c.status === 'failed') { setErr(c.errorMessage || 'استعلام نتیجه نداد.'); setSt('error'); return; }
    setSt('processing'); void poll(c);
  };
  const poll = async (c: CreditCheckLite) => {
    for (let i = 0; i < POLL_MAX && alive.current; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!alive.current) return;
      try {
        const n = await refreshCreditCheckStatus(customerId, c.id);
        if (n.status !== 'processing' && n.status !== 'awaiting_otp') { finish(n); return; }
      } catch { /* keep polling */ }
    }
    if (alive.current) { setNote('گزارش هنوز آماده نشده؛ نتیجه بعداً در پرونده‌ی مشتری دیده می‌شود.'); setSt('error'); setErr('گزارش هنوز آماده نشده است.'); }
  };

  // server/provider messages that are not Persian are replaced with a plain expert-facing sentence
  const fa_ = (m: string | undefined, fallback: string) => (m && /[\u0600-\u06FF]/.test(m) ? m : fallback);
  const start = async () => {
    if (!nidOk || !consent) return;
    setSt('starting'); setErr(''); setNote('');
    try {
      const c = await startCreditCheck(customerId, code);
      if (c.status === 'awaiting_otp') { setConsentAt(new Date().toISOString()); enterOtp(c); return; }
      if (c.reused) setNote('نتیجه‌ی ۲۴ ساعت اخیر همین مشتری؛ استعلام تازه فرستاده نشد.');
      finish(c);
    } catch (e) {
      const ex = e as TeamSalesApiError;
      if (ex.status === 409) { // a pending inquiry for this customer → continue it
        const pending = (await listCreditChecks(customerId).catch(() => [] as CreditCheckLite[])).find((c) => c.status === 'awaiting_otp');
        if (pending) { setConsentAt(pending.createdAt ?? null); enterOtp(pending); setLeft(0); setNote('یک استعلام منتظر کد بود؛ همان ادامه پیدا می‌کند.'); return; }
      }
      if (ex.status === 429 || ex.status === 400 || ex.status === 409) { setErr(fa_(ex.message, ex.status === 409 ? 'این کد ملی در پرونده‌ی مشتری دیگری ثبت است؛ دوباره از مشتری بپرس یا به مدیر خبر بده.' : 'استعلام الان ممکن نیست.')); setSt('blocked'); return; }
      setPrevFail(new Date().toISOString()); setErr(fa_(ex.message, '')); setSt('error');
    }
  };
  const submitOtp = async () => {
    const value = toLatin(otp).replace(/\D/g, '');
    if (!check) return;
    if (value.length < 4) { setOtpErr('کد پیامکی را کامل وارد کن.'); return; }
    setOtp(''); setOtpErr(''); setSt('verifying'); // the code is gone from the UI before the request is even sent
    try { finish(await validateCreditOtp(customerId, check.id, value)); }
    catch (e) {
      const ex = e as TeamSalesApiError;
      if (ex.status === 422) { setExpired(true); setLeft(0); setCheck(null); setSt('otp'); return; } // v1.0.4 scene 27: code expired → «ارسال دوباره» starts a new inquiry
      if (ex.status === 404) { setErr(fa_(ex.message, 'این استعلام پایان یافته است.')); setCheck(null); setSt('error'); return; }
      if (ex.status === 429) { setErr(fa_(ex.message, 'سقف تلاش برای این استعلام پر شد.')); setCheck(null); setSt('blocked'); return; }
      const w = wrong + 1; setWrong(w);
      setOtpErr(ex.status === 502 || ex.status === 400 ? `کد درست نیست. دوباره از مشتری بپرسید؛ ${fa(String(Math.max(0, OTP_TRIES - w)))} تلاش دیگر مانده.` : fa_(ex.message, 'کد پذیرفته نشد؛ دوباره از مشتری بپرس.')); setSt('otp'); setTimeout(() => otpRef.current?.focus(), 0);
    }
  };
  const resend = async () => {
    if (expired || !check) { setExpired(false); void start(); return; } // expired inquiry cannot be renewed; a fresh one is sent (consent from this call stays)
    if (left > 0) return;
    setOtpErr('');
    try { await renewCreditOtp(customerId, check.id); setLeft(RESEND_AFTER_S); setNote('کد تازه برای مشتری پیامک شد.'); }
    catch (e) { setOtpErr(fa_((e as TeamSalesApiError).message, 'ارسال دوباره‌ی کد انجام نشد.')); }
  };
  const again = () => { setConsent(false); setConsentAt(null); setExpired(false); setOtp(''); setRes(null); setCheck(null); setErr(''); setNote(''); setSt('idle'); };

  const nidRO = (fileNid || (st !== 'idle' && nidOk)) ? <div className="nid" data-testid="cv-nid"><span className="nl">کد ملی</span>
    <span className="nv" dir="ltr">{fa(code)}</span><Lock className="nk" aria-hidden="true" /></div> : null;
  const consentBox = <label className="cns" data-testid="cv-consent"><input type="checkbox" id="cvC" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
    <span className="bx" aria-hidden="true"><Check className="i" /></span><span className="cl">مشتری با استعلام اعتبار موافقت کرد</span></label>;
  const hint = 'تا تیک موافقت مشتری نخورد، دکمه غیرفعال است.';
  const btn = (label: string, icon = <ShieldCheck size={18} aria-hidden="true" />) => <button type="button" id="cvB" className="ts-opt cvb" data-testid="cv-start"
    aria-disabled={!canStart} aria-describedby="cvH" onClick={() => { if (canStart) void start(); else setNidTouched(true); }}>{icon}{label}</button>;
  const scale = (rank: string) => <div className="gsc" aria-label={`رتبه ${rank} در مقیاس A تا E`}>{GRADE_LETTERS.map((l) =>
    <span key={l} className={`gl g${l}${rank[0] === l ? ' on' : ''}`} aria-hidden="true">{l}</span>)}</div>;
  const resultCard = (c: CreditCheckLite, isRecent: boolean) => <div className="cvres" role="status" data-testid={isRecent ? 'cv-recent' : 'cv-result'} data-rank={c.scoreLabel}>
    <div className={`gbig g${c.scoreLabel![0]}`}><small>رتبه‌ی اعتباری</small><b>{c.scoreLabel}</b></div>
    <div className="gmeta">{scale(c.scoreLabel!)}
      <p><Clock size={14} aria-hidden="true" /><span>{isRecent ? 'آخرین استعلام: ' : 'استعلام: '}{fmtDateTime(c.completedAt)}</span></p>
      <p className="sv"><Check size={14} aria-hidden="true" /><span>{isRecent ? 'در پرونده ذخیره است' : 'در پرونده ذخیره شد'}</span></p></div></div>;

  let body: ReactNode = null;
  if (st === 'init') body = <div className="cvs" role="status" aria-live="polite"><span className="spn" aria-hidden="true" /><span>در حال آماده‌سازی…</span></div>;
  else if (st === 'idle') body = <>
    {recent ? resultCard(recent, true) : null}
    {fileNid ? nidRO : <>
      <label className="flab" htmlFor="cvI">کد ملی مشتری</label>
      <input className={`ts-inp cvi${nidBad ? ' er' : ''}`} id="cvI" type="text" inputMode="numeric" autoComplete="off" dir="ltr" maxLength={14} placeholder="۱۰ رقم"
        value={nid} onChange={(e) => setNid(e.target.value)} onBlur={() => setNidTouched(true)} aria-invalid={nidBad || undefined}
        aria-describedby={`cvNh${nidBad ? ' cvE' : ''}`} data-testid="cv-nid-input" />
      <p className="ts-muted small" id="cvNh">۱۰ رقم؛ با رقم فارسی یا انگلیسی. فاصله و خط تیره خودکار حذف می‌شود.</p>
      {nidBad ? <p className="cve" id="cvE" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>این کد ملی معتبر نیست؛ رقم کنترل نمی‌خواند. رقم‌ها را دوباره از مشتری بپرس.</span></p> : null}
    </>}
    {consentBox}
    <div className="cvr">{recent ? btn('استعلام دوباره', <RefreshCw size={18} aria-hidden="true" />) : btn('اعتبارسنجی')}
      <span className="ts-muted small" id="cvH">{fileNid ? 'کد ملی در پرونده هست؛ دوباره پرسیده نمی‌شود. ' : ''}{hint}{recent ? ' نتیجه‌ی تازه جای این نتیجه در پرونده می‌نشیند؛ نتیجه‌ی قبلی در سابقه می‌ماند.' : ''}</span></div>
    {prevFail ? <p className="cvp"><History size={14} aria-hidden="true" /><span>تلاش قبلی، {fmtDateTime(prevFail)}: سرویس استعلام در دسترس نبود.</span></p> : null}
  </>;
  else if (st === 'starting' || st === 'verifying' || st === 'processing') body = <>{nidRO}
    <div className="cvs" role="status" aria-live="polite" data-testid="cv-loading"><span className="spn" aria-hidden="true" /><b>در حال استعلام…</b>
      <span className="ts-muted small">{st === 'starting' ? 'معمولاً چند ثانیه؛ بعد کد پیامکی را از مشتری بپرس.' : 'معمولاً چند ثانیه؛ یادداشت و قدم‌های بعد را می‌توانی ادامه بدهی.'}</span></div>
    {prevFail ? <p className="cvp"><History size={14} aria-hidden="true" /><span>تلاش قبلی، {fmtDateTime(prevFail)}: سرویس استعلام در دسترس نبود.</span></p> : null}</>;
  else if (st === 'otp') body = <>{nidRO}
    {consentAt ? <p className="cnsok"><Check size={14} aria-hidden="true" /><span>موافقت مشتری ثبت شد، {fmtDateTime(consentAt)}</span></p> : null}
    {phone ? <p className="otto"><MessageSquare size={14} aria-hidden="true" /><span>کد یک‌بارمصرف ICS24 فرستاده شد به</span> <span className="ltr" dir="ltr" data-testid="cv-otp-phone">{fa(phone)}</span></p> : null}
    <form className="cvo" data-testid="cv-otp" data-expired={expired || undefined} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!expired) void submitOtp(); }}>
      <p className="oti" id="cvOI"><Phone size={14} aria-hidden="true" /><b>کد ارسال‌شده به مشتری را از او بپرسید و وارد کنید</b></p>
      <label className="flab" htmlFor="cvO">کد تأیید</label>
      <div className="cvor">
        <input ref={otpRef} className={`ts-inp cvi otp${otpErr ? ' er' : ''}`} id="cvO" type="password" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={8}
          spellCheck={false} autoCapitalize="off" data-lpignore="true" data-1p-ignore="true" value={otp} disabled={expired} onChange={(e) => setOtp(e.target.value)}
          aria-describedby={`cvOI cvOh${otpErr || expired ? ' cvOe' : ''}`} aria-invalid={Boolean(otpErr) || undefined} data-testid="cv-otp-input" />
        <button type="submit" className="ts-opt cvb" aria-disabled={expired || undefined} data-testid="cv-otp-submit"><ShieldCheck size={18} aria-hidden="true" />تأیید کد و استعلام</button>
      </div>
      <p className="ts-muted small" id="cvOh">رقم فارسی یا انگلیسی؛ رقم‌ها پنهان نشان داده می‌شوند و کد بعد از ثبت هیچ‌جا نمی‌ماند.</p>
      {expired ? <p className="cve" id="cvOe" role="alert" data-testid="cv-otp-expired"><AlertTriangle size={16} aria-hidden="true" /><span>کد منقضی شد. «ارسال دوباره» را بزنید تا کد تازه برای مشتری برود.</span></p>
        : otpErr ? <p className="cve" id="cvOe" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{otpErr}</span></p> : null}
      <div className="otrs"><span className="tmr" data-testid="cv-otp-timer"><Clock size={14} aria-hidden="true" />{left > 0 ? <span>ارسال دوباره تا <b dir="ltr">{fa(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)}</b></span>
          : <span>{expired ? 'زمان کد تمام شد' : 'زمان تمام شد؛ اگر کد نرسیده، دوباره بفرستید'}</span>}</span>
        <button type="button" className="ts-opt cvb gh" aria-disabled={left > 0 || undefined} onClick={() => void resend()} data-testid="cv-otp-resend"><RefreshCw size={16} aria-hidden="true" />ارسال دوباره</button>
        <button type="button" className="cvl" onClick={again} data-testid="cv-otp-cancel">انصراف</button>
        <span className="ts-muted small">تعداد ارسال دوباره و تلاش محدود است.</span></div>
    </form></>;
  else if (st === 'result' && res) body = <>{nidRO}{resultCard(res, false)}</>;
  else if (st === 'error') body = <>{nidRO}
    <div className="cverr" role="alert" data-testid="cv-error"><AlertTriangle className="i" aria-hidden="true" /><div><b>سرویس استعلام الان در دسترس نیست</b>
      <span>چیزی در پرونده عوض نشد. می‌توانی دوباره امتحان کنی یا فرم را بدون استعلام ثبت کنی.{err ? ` (${err})` : ''}</span></div></div>
    <div className="cvr"><button type="button" className="ts-opt cvb" id="cvB" data-testid="cv-retry" onClick={() => void start()}><RefreshCw size={18} aria-hidden="true" />تلاش دوباره</button></div></>;
  else if (st === 'blocked') body = <>{nidRO}
    <div className="cverr" role="alert" data-testid="cv-blocked"><AlertTriangle className="i" aria-hidden="true" /><div><b>استعلام الان انجام نمی‌شود</b><span>{err}</span></div></div></>;

  return <section className="cv" aria-labelledby="cvT" data-testid="cv" data-state={st}>
    <div className="cvh"><h4 id="cvT">اعتبارسنجی فوری</h4><span className="ts-pill">اختیاری</span></div>
    {body}
    {note ? <p className="ts-muted small cvn" role="status">{note}</p> : null}
  </section>;
}
