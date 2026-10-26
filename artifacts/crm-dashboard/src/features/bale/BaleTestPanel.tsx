/** «حساب تستی» — admin only (never 29). A system-owned spare SIM, not linked to any expert, that can message ONLY the
 *  admin-entered allowlist (max 3). Every rule is enforced on the server; this panel only shows / asks. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Eye, EyeOff, FlaskConical, Lock, LogOut, MessageSquareText, Plus, Send, ShieldCheck, Smartphone, Trash2, Unplug } from 'lucide-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { toast } from '@/hooks/use-toast';
import { BALE_MAX_TEXT, baleFetch, baleWhen, faNum, STATUS_LABEL, TEST_MSG_STATUS_LABEL, toEnDigits, type BaleTest } from '@/features/bale/api';

const KEY = ['bale', 'test'] as const;
const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'خطای ناشناخته. دوباره امتحان کنید.';
const SIGNOUT_WARN = 'اتصال در CRM قطع شد، ولی بله تأیید نکرد. در گوشیِ سیم‌کارت تستی، بله › تنظیمات › «دستگاه‌های فعال»، «Nafis CRM test» را حذف کنید.';
const onlyDigits = (s: string) => s.replace(/[^\d۰-۹٠-٩+\s]/g, '');

/** A masked text box with a show / hide eye (numbers and codes are not shown while typed unless asked). */
function Secret({ id, label, icon, value, onChange, hint, testId, numeric = true, autoFocus, inputRef, maxLength = 16 }: {
  id: string; label: string; icon?: React.ReactNode; value: string; onChange: (v: string) => void; hint?: React.ReactNode; testId: string; numeric?: boolean; autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>; maxLength?: number;
}) {
  const [show, setShow] = useState(false);
  return <div className="bl-field">
    <label htmlFor={id}>{icon}{label}</label>
    <div className="bl-secret">
      <input ref={inputRef} id={id} className="ltr" type={show ? 'text' : 'password'} inputMode={numeric ? 'numeric' : undefined} autoComplete="off" autoCorrect="off" spellCheck={false}
        maxLength={maxLength} value={value} onChange={e => onChange(numeric ? onlyDigits(e.target.value) : e.target.value)} autoFocus={autoFocus} data-testid={testId} />
      <button type="button" className="eye" onClick={() => setShow(s => !s)} aria-label={show ? 'پنهان کن' : 'نشان بده'} aria-pressed={show} data-testid={`${testId}-eye`}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button>
    </div>
    {hint ? <span className="hint">{hint}</span> : null}
  </div>;
}

export function BaleTestPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => baleFetch<BaleTest>('/admin/bale/test'), refetchInterval: 10_000, refetchOnWindowFocus: false });
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [password, setPassword] = useState('');
  const [allowPhone, setAllowPhone] = useState(''); const [to, setTo] = useState<number | null>(null); const [text, setText] = useState('');
  const [err, setErr] = useState(''); const [sendErr, setSendErr] = useState(''); const [allowErr, setAllowErr] = useState(''); const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'disconnect' | 'off' | { remove: number; masked: string }>(null);
  const stepRef = useRef<HTMLInputElement>(null);
  const d = q.data; const step = d?.flow?.step ?? null;
  useEffect(() => { setErr(''); stepRef.current?.focus(); }, [step]);
  useEffect(() => { if (d && to != null && !d.allowlist.some(x => x.id === to)) setTo(null); if (d && to == null && d.allowlist.length) setTo(d.allowlist[0].id); }, [d, to]);

  const call = async (path: string, body?: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST', setE: (s: string) => void = setErr) => {
    setBusy(true); setE('');
    try { const r = await baleFetch<BaleTest>(path, { method, body }); qc.setQueryData(KEY, r); return r; }
    catch (e) { setE(errMsg(e)); void qc.invalidateQueries({ queryKey: KEY }); return null; }
    finally { setBusy(false); }
  };
  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'code') void call('/admin/bale/test/connect/code', { code: toEnDigits(code) }).then(r => { setCode(''); if (r?.account?.status === 'connected') { setPhone(''); toast({ title: 'حساب تستی وصل شد' }); } });
    else if (step === 'password') void call('/admin/bale/test/connect/password', { password }).then(r => { setPassword(''); if (r?.account?.status === 'connected') { setPhone(''); toast({ title: 'حساب تستی وصل شد' }); } });
    else void call('/admin/bale/test/connect/start', { phone: toEnDigits(phone) }).then(r => { if (r?.flow) setPhone(''); });
  };
  const addAllow = (e: FormEvent) => { e.preventDefault(); void call('/admin/bale/test/allowlist', { phone: toEnDigits(allowPhone) }, 'POST', setAllowErr).then(r => { if (r) { setAllowPhone(''); toast({ title: 'شماره‌ی تستی اضافه شد' }); } }); };
  const send = (e: FormEvent) => {
    e.preventDefault(); if (to == null) return; setInfo('');
    void call('/admin/bale/test/send', { allowId: to, text }, 'POST', setSendErr).then(r => { if (r) { setText(''); setInfo(r.queued?.heldUntil ? `ساعت آرام است؛ ${baleWhen(r.queued.heldUntil)} فرستاده می‌شود.` : 'در صف ارسال قرار گرفت.'); } });
  };

  if (q.isLoading) return <SkeletonPanel rows={3} />;
  if (q.isError || !d) return <ErrorState onRetry={() => q.refetch()} />;
  const a = d.account; const connected = a?.status === 'connected' && a.hasSession;
  const full = d.allowlist.length >= d.allowMax;

  return <div className="panel bl-test" data-testid="panel-bale-test">
    <div className="bl-test-hd">
      <FlaskConical size={20} color={d.enabled ? '#1F7A4D' : '#9CA3AF'} />
      <div style={{ flex: '1 1 200px' }}><h3 style={{ margin: 0 }}>حساب تستی</h3>
        <div className="muted" style={{ fontSize: 13 }}>یک سیم‌کارت یدک، متعلق به سیستم (نه هیچ کارشناسی). فقط به شماره‌های تستیِ همین فهرست پیام می‌دهد و هرگز به مشتری‌ها نمی‌رسد.</div></div>
      <button type="button" className={d.enabled ? 'btn' : 'btn btn-primary'} disabled={busy} data-testid="toggle-bale-test"
        onClick={() => d.enabled ? setConfirm('off') : void call('/admin/bale/test/enabled', { enabled: true }, 'PUT').then(r => r && toast({ title: 'حساب تستی روشن شد' }))}>{d.enabled ? 'خاموش کن' : 'روشن کن'}</button>
    </div>
    <div className="bl-chips-row">
      <span className="bl-pill" data-s={d.enabled ? 'connected' : 'none'} data-testid="pill-bale-test-switch"><i />کلید تستی: {d.enabled ? 'روشن' : 'خاموش'}</span>
      <span className="bl-pill" data-s={d.masterEnabled ? 'connected' : 'none'}><i />کلید اصلی کارشناس‌ها: {d.masterEnabled ? 'روشن' : 'خاموش'}</span>
      <span className="bl-pill" data-s={a ? (connected ? 'connected' : a.status) : 'none'} data-testid="pill-bale-test-account"><i />حساب: {a ? STATUS_LABEL[a.status] : 'وصل نشده'}</span>
    </div>
    {!d.ready ? <div className="bl-note warn"><AlertCircle size={18} /><span>کلید رمزنگاری یا سرویس بله روی سرور آماده نیست.</span></div> : null}
    {a?.stoppedReason && !connected ? <div className="bl-note warn" data-testid="bale-test-stopped"><AlertCircle size={18} /><span>حساب تستی خودکار متوقف شد: <b className="bl-ltr">{a.stoppedReason}</b>. کلید تستی خاموش شد.</span></div> : null}

    {/* 1) connect the spare SIM */}
    <section className="bl-test-sec" aria-labelledby="bt-conn"><h4 id="bt-conn"><Smartphone size={16} /> اتصال سیم‌کارت تستی</h4>
      {connected ? <>
        <div className="bl-done compact" data-testid="bale-test-connected"><span className="big"><CheckCircle2 size={28} /></span>
          <b>حساب تستی وصل است</b><span className="muted">شماره‌ی <span className="bl-ltr" data-testid="text-bale-test-phone">{a!.phoneMasked}</span>{a!.connectedAt ? ` · از ${baleWhen(a!.connectedAt)}` : ''}</span></div>
        <div className="bl-acts"><button type="button" className="btn" disabled={busy} onClick={() => setConfirm('disconnect')} data-testid="button-bale-test-disconnect"><Unplug size={16} /> قطع اتصال</button></div>
      </> : !d.enabled ? <div className="bl-note off" data-testid="bale-test-off"><Lock size={18} /><span>برای اتصال، اول کلید «حساب تستی» را روشن کنید. کلید اصلی کارشناس‌ها خاموش می‌ماند.</span></div>
      : <form onSubmit={submitLogin} className="bl-wiz" noValidate>
        <ol className="bl-steps" aria-label="مراحل اتصال">{([[1, 'شماره'], [2, 'کد'], [3, 'رمز دوم'], [4, 'تمام']] as const).map(([n, l]) =>
          <li key={n} data-on={n === (step === 'password' ? 3 : step === 'code' ? 2 : 1)} data-done={n < (step === 'password' ? 3 : step === 'code' ? 2 : 1)}><span>{faNum(n)}. {l}</span></li>)}</ol>
        {a?.lastError === 'signout_failed' ? <div className="bl-note warn"><AlertCircle size={18} /><span>{SIGNOUT_WARN}</span></div> : null}
        {step === 'code' ? <Secret id="bt-code" label="کد ورود" icon={<Lock size={15} />} value={code} onChange={v => setCode(v.replace(/[^\d۰-۹٠-٩]/g, ''))} maxLength={6} inputRef={stepRef} testId="input-bale-test-code"
            hint={<>کد را بله برای <span className="bl-ltr">{d.flow?.phoneMasked}</span> فرستاد. کد هیچ‌جا ذخیره یا ثبت نمی‌شود.</>} />
          : step === 'password' ? <Secret id="bt-pass" label="رمز دومرحله‌ای (اگر دارد)" icon={<Lock size={15} />} value={password} onChange={setPassword} numeric={false} maxLength={256} inputRef={stepRef} testId="input-bale-test-password"
            hint="این رمز فقط به بله داده می‌شود و هیچ‌جا ذخیره نمی‌شود." />
          : <Secret id="bt-phone" label="شماره‌ی سیم‌کارت تستی" icon={<Smartphone size={15} />} value={phone} onChange={setPhone} inputRef={stepRef} testId="input-bale-test-phone"
            hint={<>شماره‌ی سیم‌کارت یدک شرکت. بعد از ذخیره فقط به‌صورت پوشیده نشان داده می‌شود. {d.startsLeft < 3 ? `این ساعت ${faNum(d.startsLeft)} بار دیگر می‌شود کد گرفت.` : ''}</>} />}
        {err ? <p className="bl-err" role="alert"><AlertCircle size={16} /> {err}</p> : null}
        <div className="bl-acts">
          <button type="submit" className="btn btn-primary" data-testid="button-bale-test-next"
            disabled={busy || !d.ready || (step === 'code' ? code.length < 4 : step === 'password' ? !password : !phone.trim() || d.startsLeft === 0)}>
            {busy ? 'لطفاً صبر کنید…' : step === 'code' ? 'تأیید کد' : step === 'password' ? 'ورود' : 'دریافت کد'}</button>
          {step ? <button type="button" className="btn" disabled={busy} onClick={() => { setCode(''); setPassword(''); void call('/admin/bale/test/connect/cancel'); }} data-testid="button-bale-test-cancel">انصراف</button> : null}
        </div>
      </form>}
    </section>

    {/* 2) allowlist */}
    <section className="bl-test-sec" aria-labelledby="bt-allow"><h4 id="bt-allow"><ShieldCheck size={16} /> شماره‌های تستی مجاز <small>({faNum(d.allowlist.length)} از {faNum(d.allowMax)})</small></h4>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>حساب تستی فقط به همین شماره‌ها پیام می‌دهد و فقط پیام همین شماره‌ها را نشان می‌دهد. شماره‌ی مشتری پذیرفته نمی‌شود.</p>
      {d.allowlist.length ? <ul className="bl-allow" data-testid="list-bale-test-allow">{d.allowlist.map(x => <li key={x.id} data-testid={`row-bale-test-allow-${x.id}`}>
        <span className="bl-ltr num">{x.phoneMasked}</span>{x.peerKnown ? <span className="bl-pill" data-s="connected"><i />در بله پیدا شد</span> : null}
        <button type="button" className="btn btn-icon" disabled={busy} aria-label={`حذف ${x.phoneMasked}`} onClick={() => setConfirm({ remove: x.id, masked: x.phoneMasked })} data-testid={`button-bale-test-allow-remove-${x.id}`}><Trash2 size={16} /></button>
      </li>)}</ul> : <div className="muted" style={{ fontSize: 13 }}>هنوز شماره‌ای ثبت نشده.</div>}
      {!full ? <form onSubmit={addAllow} className="bl-allow-add" noValidate>
        <Secret id="bt-allow-phone" label="افزودن شماره‌ی تستی" value={allowPhone} onChange={v => { setAllowPhone(v); setAllowErr(''); }} testId="input-bale-test-allow" />
        <button type="submit" className="btn btn-primary" disabled={busy || !allowPhone.trim()} data-testid="button-bale-test-allow-add"><Plus size={16} /> افزودن</button>
      </form> : <div className="bl-note off"><ShieldCheck size={18} /><span>سقف ۳ شماره پر است. برای شماره‌ی تازه یکی را حذف کنید.</span></div>}
      {allowErr ? <p className="bl-err" role="alert" data-testid="text-bale-test-allow-err"><AlertCircle size={16} /> {allowErr}</p> : null}
    </section>

    {/* 3) send a test message + what came back */}
    <section className="bl-test-sec" aria-labelledby="bt-send" data-testid="box-bale-test-send"><h4 id="bt-send"><MessageSquareText size={16} /> ارسال پیام تستی</h4>
      <div className="bl-chat" data-testid="list-bale-test-messages" aria-live="polite">
        {!d.messages.length ? <div className="muted" style={{ fontSize: 13, textAlign: 'center' }}>هنوز پیامی نیست. پیام‌های رسیده از شماره‌های تستی هم همین‌جا دیده می‌شوند.</div>
          : d.messages.map(m => m.direction === 'out' && (m.status === 'failed' || m.status === 'blocked')
            ? <div key={m.id} className="bl-blocked" data-testid={`row-bale-test-msg-${m.id}`}><AlertCircle size={16} /><div>
                <b>به <span className="bl-ltr">{m.phoneMasked ?? '—'}</span> · {TEST_MSG_STATUS_LABEL[m.status]}</b>
                <span>{m.errorMessage}</span>{m.error ? <small>کد خطا: <span className="bl-ltr">{m.error}</span></small> : null}{m.text ? <q>{m.text}</q> : null}</div></div>
            : <div key={m.id} className={`bl-msg ${m.direction}${m.status === 'queued' || m.status === 'sending' ? ' pending' : ''}`} data-testid={`row-bale-test-msg-${m.id}`}>
                {m.text ?? (m.hasFile ? '📎 فایل' : '—')}
                <span className="meta">{m.direction === 'in' ? 'از' : 'به'} <span className="bl-ltr">{m.phoneMasked ?? '—'}</span> · {TEST_MSG_STATUS_LABEL[m.status]} · {baleWhen(m.sentAt ?? m.scheduledAt ?? m.createdAt)}
                  {m.error && m.status === 'queued' ? <> · تلاش دوباره (<span className="bl-ltr">{m.error}</span>)</> : null}</span>
              </div>)}
      </div>
      {connected && d.enabled && d.allowlist.length ? <form onSubmit={send} className="bl-compose" noValidate>
        <div className="bl-chips" role="radiogroup" aria-label="گیرنده">{d.allowlist.map(x =>
          <button key={x.id} type="button" role="radio" aria-checked={to === x.id} onClick={() => setTo(x.id)} data-testid={`radio-bale-test-to-${x.id}`}><span className="bl-ltr">{x.phoneMasked}</span></button>)}</div>
        <label htmlFor="bt-text" className="sr-only">متن پیام تستی</label>
        <textarea id="bt-text" className="bl-ta" value={text} maxLength={BALE_MAX_TEXT} onChange={e => setText(e.target.value)} placeholder="متن پیام تستی…" data-testid="input-bale-test-text" />
        <span className="hint">همان قوانین کارشناس‌ها: فیلتر کلمات، فاصله‌ی تصادفی، سقف {faNum(d.sendState.perHour)} در ساعت ({faNum(d.sendState.sentLastHour)} رفته) و {faNum(d.sendState.perDay)} در روز، ساعت آرام.</span>
        {d.sendState.quietNow ? <div className="bl-note off"><Lock size={18} /><span>ساعت آرام است؛ پیام تا {d.sendState.quietEnd ? baleWhen(d.sendState.quietEnd) : 'پایان ساعت آرام'} نگه داشته می‌شود.</span></div> : null}
        {sendErr ? <p className="bl-err" role="alert" data-testid="text-bale-test-send-err"><AlertCircle size={16} /> {sendErr}</p> : null}
        {info ? <p className="bl-info"><CheckCircle2 size={16} /> {info}</p> : null}
        <div className="bl-acts"><button type="submit" className="btn btn-primary" disabled={busy || to == null || !text.trim()} data-testid="button-bale-test-send"><Send size={16} /> ارسال پیام تستی</button></div>
      </form> : <div className="bl-note off"><Lock size={18} /><span>{!d.enabled ? 'کلید حساب تستی خاموش است.' : !connected ? 'اول سیم‌کارت تستی را وصل کنید.' : 'اول یک شماره‌ی تستی اضافه کنید.'}</span></div>}
      {a && a.inboundIgnored > 0 ? <p className="muted" style={{ fontSize: 12, margin: 0 }} data-testid="text-bale-test-ignored">{faNum(a.inboundIgnored)} پیام از فرستنده‌های دیگر رسید که ذخیره نشد (نه متن، نه شماره).</p> : null}
    </section>

    {confirm ? <Modal title={confirm === 'disconnect' ? 'قطع اتصال حساب تستی' : confirm === 'off' ? 'خاموش کردن حساب تستی' : 'حذف شماره‌ی تستی'} onClose={() => setConfirm(null)} testId="bale-test-confirm">
      <p>{confirm === 'disconnect' ? 'نشست حساب تستی از بله خارج و از سرور پاک می‌شود. پیام‌های در صف فرستاده نمی‌شوند.'
        : confirm === 'off' ? 'حساب تستی دیگر پیامی نمی‌فرستد و چیزی دریافت نمی‌کند. اتصال پاک نمی‌شود.'
        : <>شماره‌ی <span className="bl-ltr">{confirm.masked}</span> از فهرست حذف می‌شود و دیگر به آن پیامی نمی‌رود.</>}</p>
      <div className="bl-acts">
        <button type="button" className="btn btn-primary" style={{ background: '#B42318', borderColor: '#B42318' }} disabled={busy} data-testid="button-confirm-bale-test"
          onClick={() => void (confirm === 'disconnect' ? call('/admin/bale/test/disconnect').then(r => r && toast({ title: 'حساب تستی قطع شد', description: r.remoteSignOut === 'failed' ? SIGNOUT_WARN : undefined }))
            : confirm === 'off' ? call('/admin/bale/test/enabled', { enabled: false }, 'PUT').then(r => r && toast({ title: 'حساب تستی خاموش شد' }))
            : call(`/admin/bale/test/allowlist/${confirm.remove}`, undefined, 'DELETE', setAllowErr)).then(() => setConfirm(null))}>
          {confirm === 'disconnect' ? <><LogOut size={16} /> قطع کن</> : 'تأیید'}</button>
        <button type="button" className="btn" onClick={() => setConfirm(null)}>انصراف</button>
      </div>
    </Modal> : null}
  </div>;
}
