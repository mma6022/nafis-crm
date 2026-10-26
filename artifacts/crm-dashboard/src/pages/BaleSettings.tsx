import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Info, Link2, Lock, LogOut, Power, ShieldCheck, Smartphone, Unplug } from 'lucide-react';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { toast } from '@/hooks/use-toast';
import { baleCanConnect, baleFetch, baleWhen, faNum, MODE_HINT, MODE_LABEL, STATUS_LABEL, toEnDigits, type BaleAdmin, type BaleAuditItem, type BaleMe, type BaleMode, type BalePeerBlockMode } from '@/features/bale/api';
import { BaleOutboxPanel } from '@/features/bale/BaleOutboxPanel';
import { BaleUnknownPanel } from '@/features/bale/BaleUnknownPanel';
import '@/features/bale/bale.css';

const ME_KEY = ['bale', 'me'] as const;
const ADMIN_KEY = ['bale', 'admin'] as const;
const AUDIT_KEY = ['bale', 'audit'] as const;
const MODES: BaleMode[] = ['off', 'approve_first', 'auto'];
const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'خطای ناشناخته. دوباره امتحان کنید.';
const SIGNOUT_WARN = 'اتصال در CRM قطع شد، ولی بله تأیید نکرد. برای اطمینان در اپ بله › تنظیمات › «دستگاه‌های فعال»، دستگاه «Nafis CRM» را هم حذف کنید.';

function Steps({ at }: { at: 1 | 2 | 3 | 4 }) {
  const items: [number, string, boolean][] = [[1, 'شماره', false], [2, 'کد', false], [3, 'رمز دوم', true], [4, 'وصل شد', false]];
  return <ol className="bl-steps" aria-label="مراحل اتصال">{items.map(([n, label, opt]) =>
    <li key={n} data-on={n === at} data-done={n < at} data-optional={opt} aria-current={n === at ? 'step' : undefined}><span>{faNum(n)}. {label}</span></li>)}</ol>;
}

function useCountdown(iso: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!iso) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [iso]);
  if (!iso) return null;
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return { s, label: `${faNum(Math.floor(s / 60))}:${faNum(String(s % 60).padStart(2, '0'))}` };
}

function ExpertWizard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => baleFetch<BaleMe>('/bale/me'), refetchOnWindowFocus: false });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const d = me.data;
  const step = d?.flow?.step ?? null;
  const cd = useCountdown(d?.flow?.expiresAt);
  useEffect(() => { setErr(''); inputRef.current?.focus(); }, [step]);
  useEffect(() => { if (cd && cd.s === 0 && step) void qc.invalidateQueries({ queryKey: ME_KEY }); }, [cd?.s, step, qc]);

  const call = async (path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST') => {
    setBusy(true); setErr('');
    try { const r = await baleFetch<BaleMe>(path, { method, body }); qc.setQueryData(ME_KEY, r); return r; }
    catch (e) { setErr(errMsg(e)); void qc.invalidateQueries({ queryKey: ME_KEY }); return null; }
    finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'code') void call('/bale/connect/code', { code: toEnDigits(code) }).then(r => { setCode(''); if (r?.account?.status === 'connected') { setPhone(''); toast({ title: 'حساب بله وصل شد' }); } });
    else if (step === 'password') void call('/bale/connect/password', { password }).then(r => { setPassword(''); if (r?.account?.status === 'connected') { setPhone(''); toast({ title: 'حساب بله وصل شد' }); } });
    else void call('/bale/connect/start', { phone: toEnDigits(phone) });
  };

  if (me.isLoading) return <SkeletonPanel rows={3} />;
  if (me.isError || !d) return <ErrorState onRetry={() => me.refetch()} />;
  if (!d.eligible) return null;
  const a = d.account;
  const connected = a?.status === 'connected';

  return <div className="panel bl-wiz" data-testid="panel-bale-wizard">
    <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Link2 size={18} /> حساب بله‌ی من</h3>
    <Steps at={connected ? 4 : step === 'password' ? 3 : step === 'code' ? 2 : 1} />

    {connected ? <>
      <div className="bl-done" data-testid="bale-connected">
        <span className="big"><CheckCircle2 size={34} /></span>
        <b>حساب بله‌ی شما وصل است</b>
        <span className="muted">شماره‌ی <span className="bl-ltr">{a.phoneMasked}</span>{a.connectedAt ? ` · از ${baleWhen(a.connectedAt)}` : ''}</span>
      </div>
      {!d.masterEnabled ? <div className="bl-note off"><Power size={18} /><span>بله فعلاً از طرف مدیر خاموش است. اتصال شما می‌ماند، ولی تا روشن شدن هیچ کاری انجام نمی‌شود.</span></div> : null}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, marginBottom: 8 }}>ارسال پیام از حساب من</legend>
        <div className="bl-modes" role="radiogroup" aria-label="حالت ارسال">
          {MODES.map(m => <button key={m} type="button" role="radio" aria-checked={a.mode === m} className="bl-mode" disabled={busy}
            onClick={() => { if (a.mode !== m) void call('/bale/me/mode', { mode: m }, 'PUT').then(r => r && toast({ title: `حالت: ${MODE_LABEL[m]}` })); }} data-testid={`radio-bale-mode-${m}`}>
            <span className="dot" aria-hidden="true" /><span><b>{MODE_LABEL[m]}</b><small>{MODE_HINT[m]}</small></span>
          </button>)}
        </div>
      </fieldset>
      <div className="bl-note warn"><Info size={18} /><span>پیام فقط به مشتری‌های خودتان، با فاصله‌ی تصادفی، سقف ساعتی و روزانه و بیرون از ساعت آرام فرستاده می‌شود. اولین پیام به مشتری‌ای که در بله با او گفتگو نداشته‌اید فقط با دستور خودتان می‌رود.</span></div>
      {a.lastError === 'signout_failed' ? <div className="bl-note warn"><AlertCircle size={18} /><span>{SIGNOUT_WARN}</span></div> : null}
      {err ? <p className="err" role="alert" style={{ color: '#B42318', margin: 0 }}>{err}</p> : null}
      <div className="bl-acts"><button type="button" className="btn" disabled={busy} onClick={() => setConfirmOff(true)} data-testid="button-bale-disconnect"><Unplug size={16} /> قطع اتصال</button></div>
    </> : !d.masterEnabled ? <div className="bl-note off" data-testid="bale-disabled"><Power size={18} /><span>اتصال بله فعلاً از طرف مدیر خاموش است. وقتی روشن شد، از همین صفحه وصل کنید.</span></div>
    : !d.ready ? <div className="bl-note warn" data-testid="bale-not-ready"><AlertCircle size={18} /><span>سرویس بله روی سرور هنوز آماده نیست. به مدیر خبر بدهید.</span></div>
    : <form onSubmit={submit} className="bl-wiz" noValidate>
      {a && a.status !== 'connected' && !step && a.lastError === 'signout_failed' ? <div className="bl-note warn"><AlertCircle size={18} /><span>{SIGNOUT_WARN}</span></div> : null}
      {step === 'code' ? <div className="bl-field">
        <label htmlFor="bale-code">کد ورود</label>
        <span className="hint">کد را {d.flow?.codeType === 'bale' ? 'در اپ بله' : 'در بله یا پیامک'} برای شماره‌ی <span className="bl-ltr">{d.flow?.phoneMasked}</span> فرستادند.{cd ? <> اعتبار: <b className="bl-ltr" data-testid="text-bale-countdown">{cd.label}</b></> : null}</span>
        <input ref={inputRef} id="bale-code" className="ltr otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/[^\d۰-۹٠-٩]/g, ''))} aria-invalid={Boolean(err)} aria-describedby={err ? 'bale-err' : undefined} data-testid="input-bale-code" />
      </div> : step === 'password' ? <div className="bl-field">
        <label htmlFor="bale-pass"><Lock size={15} style={{ verticalAlign: '-2px' }} /> رمز دومرحله‌ای بله</label>
        <span className="hint">روی حساب بله‌ی شما رمز دومرحله‌ای گذاشته شده است. همان رمز را وارد کنید. این رمز هیچ‌جا ذخیره نمی‌شود.</span>
        <input ref={inputRef} id="bale-pass" type="password" className="ltr" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} aria-invalid={Boolean(err)} data-testid="input-bale-password" />
      </div> : <>
        <div className="bl-field">
          <label htmlFor="bale-phone"><Smartphone size={15} style={{ verticalAlign: '-2px' }} /> شماره‌ی موبایلِ حساب بله‌ی شما</label>
          <input ref={inputRef} id="bale-phone" className="ltr" type="tel" inputMode="tel" autoComplete="tel" placeholder="09121234567" maxLength={16} value={phone} onChange={e => setPhone(e.target.value)} aria-invalid={Boolean(err)} data-testid="input-bale-phone" />
          <span className="hint">فقط شماره‌ی خودتان. کد ورود برای همین شماره در بله فرستاده می‌شود. {d.startsLeft < 3 ? `این ساعت ${faNum(d.startsLeft)} بار دیگر می‌شود کد گرفت.` : ''}</span>
        </div>
        <ul className="bl-safe">
          <li><ShieldCheck size={16} /><span>کد و رمز فقط برای همین ورود به کار می‌رود و هیچ‌جا ذخیره نمی‌شود.</span></li>
          <li><ShieldCheck size={16} /><span>نشست بله رمزنگاری‌شده روی سرور شرکت نگه داشته می‌شود و به کسی نشان داده نمی‌شود.</span></li>
          <li><ShieldCheck size={16} /><span>هر وقت بخواهید از همین صفحه یا از بله › «دستگاه‌های فعال» قطعش کنید.</span></li>
        </ul>
      </>}
      {err ? <p className="err" id="bale-err" role="alert" style={{ color: '#B42318', margin: 0, display: 'flex', gap: 6 }}><AlertCircle size={16} /> {err}</p> : null}
      <div className="bl-acts">
        <button type="submit" className="btn btn-primary" disabled={busy || (step === 'code' ? code.length < 4 : step === 'password' ? !password : !phone.trim() || d.startsLeft === 0)} data-testid="button-bale-next">
          {busy ? 'لطفاً صبر کنید…' : step === 'code' ? 'تأیید کد' : step === 'password' ? 'ورود' : 'دریافت کد'}</button>
        {step ? <button type="button" className="btn" disabled={busy} onClick={() => { setCode(''); setPassword(''); void call('/bale/connect/cancel'); }} data-testid="button-bale-cancel">انصراف</button> : null}
      </div>
    </form>}

    {confirmOff && a ? <Modal title="قطع اتصال بله" onClose={() => setConfirmOff(false)} testId="bale-disconnect">
      <p>حساب بله‌ی شما از CRM جدا می‌شود و نشست ذخیره‌شده پاک می‌شود. گفتگوهای ثبت‌شده در پرونده‌ها می‌مانند.</p>
      <div className="bl-acts">
        <button type="button" className="btn btn-primary" style={{ background: '#B42318', borderColor: '#B42318' }} disabled={busy} data-testid="button-confirm-bale-disconnect"
          onClick={() => void call('/bale/me/disconnect').then(r => { setConfirmOff(false); if (r) toast({ title: 'اتصال بله قطع شد', description: r.remoteSignOut === 'failed' ? SIGNOUT_WARN : undefined }); })}><LogOut size={16} /> قطع کن</button>
        <button type="button" className="btn" onClick={() => setConfirmOff(false)}>انصراف</button>
      </div>
    </Modal> : null}
  </div>;
}

function AdminPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ADMIN_KEY, queryFn: () => baleFetch<BaleAdmin>('/admin/bale') });
  const audit = useQuery({ queryKey: AUDIT_KEY, queryFn: () => baleFetch<{ items: BaleAuditItem[] }>('/admin/bale/audit?limit=50') });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'master' } | { kind: 'disconnect'; id: number; name: string } | { kind: 'peer'; mode: BalePeerBlockMode }>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { const r = await fn() as { remoteSignOut?: string } | undefined; toast({ title: ok, description: r?.remoteSignOut === 'failed' ? 'بله خروج را تأیید نکرد؛ از کارشناس بخواهید در بله › «دستگاه‌های فعال» دستگاه Nafis CRM را حذف کند.' : undefined }); }
    catch (e) { toast({ title: errMsg(e), variant: 'destructive' }); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ['bale'] }); }
  };
  if (q.isLoading) return <SkeletonPanel rows={4} />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;
  const d = q.data;
  const l = d.limits;
  return <>
    <div className="panel" data-testid="panel-bale-master" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Power size={20} color={d.masterEnabled ? '#1F7A4D' : '#9CA3AF'} />
        <div style={{ flex: '1 1 200px' }}><b>کلید اصلی بله</b>
          <div style={{ fontSize: 13, color: 'var(--nf-ink-muted)' }}>{d.masterEnabled ? 'روشن: کارشناس‌های فروش می‌توانند حساب بله‌ی خود را وصل کنند.' : 'خاموش: هیچ اتصال تازه‌ای ساخته نمی‌شود و هیچ کاری از طرف بله انجام نمی‌شود.'}</div></div>
        <button type="button" className={d.masterEnabled ? 'btn' : 'btn btn-primary'} disabled={busy} data-testid="toggle-bale-master"
          onClick={() => d.masterEnabled ? setConfirm({ kind: 'master' }) : void run(() => baleFetch('/admin/bale/master', { method: 'PUT', body: { enabled: true } }), 'بله روشن شد')}>{d.masterEnabled ? 'خاموش کن' : 'روشن کن'}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <span className="bl-pill" data-s={d.keyReady ? 'connected' : 'error'}><i />کلید رمزنگاری: {d.keyReady ? 'آماده' : 'تنظیم نشده'}</span>
        <span className="bl-pill" data-s={d.sidecar.reachable ? 'connected' : 'error'}><i />سرویس بله: {!d.sidecar.configured ? 'تنظیم نشده' : d.sidecar.reachable ? 'در دسترس' : 'در دسترس نیست'}</span>
      </div>
    </div>

    <div className="panel" data-testid="panel-bale-experts" style={{ display: 'grid', gap: 10 }}>
      <h3 style={{ margin: 0 }}>کارشناس‌ها</h3>
      <ul className="bl-experts">{d.experts.map(x => { const a = x.account; return <li key={x.userId} data-testid={`row-bale-expert-${x.userId}`}>
        <div className="who"><b>{x.name}</b><small>{a ? <><span className="bl-ltr">{a.phoneMasked ?? '—'}</span>{a.connectedAt && a.status === 'connected' ? ` · از ${baleWhen(a.connectedAt)}` : ''}</> : 'هنوز وصل نکرده'}</small></div>
        <span className="bl-pill" data-s={a?.status ?? 'none'}><i />{a ? STATUS_LABEL[a.status] : 'وصل نشده'}</span>
        {a ? <span className="bl-pill">حالت: {MODE_LABEL[a.mode]}</span> : null}
        {a && a.mode !== 'off' ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => baleFetch(`/admin/bale/accounts/${a.id}/mode`, { method: 'PUT', body: { mode: 'off' } }), `ارسال ${x.name} خاموش شد`)} data-testid={`button-bale-force-off-${x.userId}`}>خاموش کردن ارسال</button> : null}
        {a && (a.status === 'connected' || a.hasSession) ? <button type="button" className="btn" disabled={busy} onClick={() => setConfirm({ kind: 'disconnect', id: a.id, name: x.name })} data-testid={`button-bale-admin-disconnect-${x.userId}`}><Unplug size={15} /> قطع اتصال</button> : null}
      </li>; })}</ul>
      {!d.experts.length ? <div style={{ color: 'var(--nf-ink-muted)' }}>کارشناس فروش واجد شرایطی نیست.</div> : null}
    </div>

    <div className="panel" data-testid="panel-bale-limits" style={{ display: 'grid', gap: 10 }}>
      <h3 style={{ margin: 0 }}>سقف‌های ارسال <small style={{ fontWeight: 400, color: 'var(--nf-ink-muted)' }}>(برای مرحله‌ی ارسال)</small></h3>
      <dl className="bl-limits">
        <div><dt>فاصله‌ی بین پیام‌ها</dt><dd>{faNum(l.gapMinS)} تا {faNum(l.gapMaxS)} ثانیه</dd></div>
        <div><dt>در ساعت</dt><dd>{faNum(l.perHour)} پیام</dd></div>
        <div><dt>در روز</dt><dd>{faNum(l.perDay)} پیام</dd></div>
        <div><dt>گفتگوی تازه در روز</dt><dd>{faNum(l.newChatsPerDay)}</dd></div>
        <div><dt>ساعت آرام</dt><dd>{faNum(l.quietStart)} تا {faNum(l.quietEnd)}</dd></div>
      </dl>
    </div>

    {d.peerBlock ? <div className="panel bl-policy" data-testid="panel-bale-peer-block">
      <h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>وقتی یک مشتری کارشناس را در بله مسدود کند
        {!d.peerBlock.verified ? <span className="bl-pill" data-s="error" data-testid="pill-bale-unverified"><i />تأییدنشده</span> : null}</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>تشخیص این خطا هنوز با سیم‌کارت آزمایشی بررسی نشده است. تا آن موقع حالت امن پیش‌فرض بماند: در صورت شک، کل ارسالِ آن کارشناس متوقف می‌شود.</p>
      <div className="bl-modes" role="radiogroup" aria-label="رفتار در برابر مسدود شدن">
        {(['account_stop', 'conversation_pause'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={d.peerBlock!.mode === m} className="bl-mode" disabled={busy}
          onClick={() => { if (d.peerBlock!.mode !== m) setConfirm({ kind: 'peer', mode: m }); }} data-testid={`radio-bale-peer-${m}`}>
          <span className="dot" aria-hidden="true" /><span><b>{m === 'account_stop' ? 'کل حساب متوقف شود (امن، پیش‌فرض)' : 'فقط همان گفتگو متوقف شود'}</b>
            <small>{m === 'account_stop' ? 'مثل مسدود شدن حساب: ارسال خاموش، نشست پاک و به کارشناس و مدیر خبر داده می‌شود.' : 'بقیه‌ی گفتگوها ادامه پیدا می‌کنند؛ کارشناس می‌تواند همان گفتگو را دوباره فعال کند. فقط بعد از آزمایش با سیم‌کارت.'}</small></span>
        </button>)}
      </div>
    </div> : null}

    <div className="panel" data-testid="panel-bale-audit" style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0 }}>گزارش رویدادها</h3>
      {audit.isLoading ? <SkeletonPanel rows={3} /> : audit.isError ? <ErrorState onRetry={() => audit.refetch()} /> : !audit.data?.items.length ? <div style={{ color: 'var(--nf-ink-muted)' }}>هنوز چیزی ثبت نشده.</div>
        : <ul className="bl-audit">{audit.data.items.map(x => <li key={x.id}><span className="at">{baleWhen(x.at)}</span><b>{x.actor ?? '—'}</b><span>{AUDIT_FA[x.action] ?? x.action}</span><span className="bl-pill" data-s={x.outcome === 'ok' ? 'connected' : 'error'}><i />{OUT_FA[x.outcome] ?? x.outcome}</span>{x.customerId ? <span>مشتری {faNum(x.customerId)}</span> : null}</li>)}</ul>}
    </div>

    {confirm ? <Modal title={confirm.kind === 'master' ? 'خاموش کردن بله' : confirm.kind === 'peer' ? 'تغییر رفتار در برابر مسدود شدن' : `قطع اتصال ${confirm.name}`} onClose={() => setConfirm(null)} testId="bale-admin-confirm">
      <p>{confirm.kind === 'master' ? 'اتصال تازه ممکن نمی‌شود و هیچ کاری از طرف بله انجام نمی‌شود. اتصال‌های فعلی پاک نمی‌شوند.'
        : confirm.kind === 'peer' ? (confirm.mode === 'conversation_pause' ? 'این مسیر هنوز «تأییدنشده» است. اگر تشخیص اشتباه باشد، حسابی که واقعاً مسدود شده ممکن است به ارسال ادامه دهد. فقط بعد از آزمایش با سیم‌کارت روشنش کنید.' : 'به حالت امن برمی‌گردد: در صورت شک کل ارسال کارشناس متوقف می‌شود.')
        : 'نشست بله‌ی این کارشناس از سرور پاک می‌شود و حالت ارسال خاموش می‌شود.'}</p>
      <div className="bl-acts">
        <button type="button" className="btn btn-primary" style={{ background: '#B42318', borderColor: '#B42318' }} disabled={busy} data-testid="button-confirm-bale-admin"
          onClick={() => void (confirm.kind === 'peer' ? run(() => baleFetch('/admin/bale/peer-block-mode', { method: 'PUT', body: { mode: confirm.mode } }), 'تنظیم ذخیره شد') : confirm.kind === 'master' ? run(() => baleFetch('/admin/bale/master', { method: 'PUT', body: { enabled: false } }), 'بله خاموش شد') : run(() => baleFetch(`/admin/bale/accounts/${confirm.id}/disconnect`, { method: 'POST' }), 'اتصال قطع شد')).then(() => setConfirm(null))}>تأیید</button>
        <button type="button" className="btn" onClick={() => setConfirm(null)}>انصراف</button>
      </div>
    </Modal> : null}
  </>;
}

const AUDIT_FA: Record<string, string> = {
  'connect.start': 'درخواست کد', 'connect.start_limited': 'درخواست کد (بیش از سقف)', 'connect.code': 'ورود کد', 'connect.password': 'ورود رمز دومرحله‌ای',
  'connect.connected': 'اتصال برقرار شد', 'connect.cancel': 'انصراف از اتصال', 'disconnect.expert': 'قطع اتصال توسط کارشناس', 'disconnect.admin': 'قطع اتصال توسط مدیر',
  'mode.expert': 'تغییر حالت توسط کارشناس', 'mode.admin': 'تغییر حالت توسط مدیر', 'admin.master_on': 'روشن کردن بله', 'admin.master_off': 'خاموش کردن بله', 'chat.view': 'دیدن گفتگوی بله',
  'admin.peer_block_mode': 'تغییر رفتار در برابر مسدود شدن (تأییدنشده)', 'conversation.pause': 'توقف یک گفتگو (تأییدنشده)', 'conversation.resume': 'فعال کردن دوباره‌ی گفتگو',
  'unknown.seen': 'پیام از شماره‌ی ناشناس', 'unknown.link': 'وصل کردن گفتگوی ناشناس به مشتری', 'unknown.dismiss': 'کنار گذاشتن گفتگوی ناشناس', 'account.auto_stop': 'توقف خودکار حساب',
};
const OUT_FA: Record<string, string> = { ok: 'موفق', forbidden: 'بدون دسترسی', not_in_scope: 'خارج از محدوده', disabled: 'خاموش', rate_limited: 'سقف', wrong_code: 'کد نادرست', wrong_password: 'رمز نادرست', password_needed: 'نیاز به رمز', code_expired: 'منقضی', error: 'خطا' };

export default function BaleSettings() {
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user as { id?: number; role?: string; salespersonId?: number | null } | undefined;
  const isAdmin = user?.role === 'admin' && user.id !== 29;
  const expert = baleCanConnect(user);
  return <section className="data-page" data-testid="page-bale-settings" dir="rtl">
    <div className="page-intro"><div><span className="eyebrow">پیام‌رسان بله</span><h2>اتصال حساب بله</h2>
      <p>{isAdmin ? 'روشن و خاموش کردن بله، وضعیت اتصال کارشناس‌ها و گزارش رویدادها.' : 'حساب بله‌ی شخصی‌تان را امن به CRM وصل کنید تا گفتگوی هر مشتری در پرونده‌اش دیده شود.'}</p></div></div>
    {session.isLoading ? <SkeletonPanel rows={3} /> : <div style={{ display: 'grid', gap: 16 }}>
      {expert ? <ExpertWizard /> : null}
      {expert ? <BaleUnknownPanel /> : null}
      {expert ? <BaleOutboxPanel /> : null}
      {isAdmin ? <AdminPanel /> : null}
      {!expert && !isAdmin ? <div className="bl-note off" data-testid="bale-not-eligible"><Info size={18} /><span>اتصال حساب بله فقط برای کارشناس‌های فروش فعال است.</span></div> : null}
    </div>}
  </section>;
}
