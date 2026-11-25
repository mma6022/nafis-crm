/* One-time bulk redirect to «نفیس وام». Super-admin only. flag.social_hub_redirect_v1. Never auto-starts. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fa, faDate, faDateTime, messageError, shApi, type ShRedirectPreview, type ShRedirectStatus } from './api';
import { CheckBox, Wizard, shRenderPreview } from './ui';

const digitsLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

export function RedirectWizard({ onClose, toast }: { onClose: () => void; toast: (t: string) => void }) {
  const qc = useQueryClient();
  const previewQ = useQuery<ShRedirectPreview>({ queryKey: ['sh-redirect-preview'], queryFn: () => shApi('/redirect/preview'), retry: false });
  const [step, setStep] = useState(0);
  const [sample, setSample] = useState(0);
  const [seen, setSeen] = useState(false);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const statusQ = useQuery<ShRedirectStatus>({ queryKey: ['sh-redirect-status'], queryFn: () => shApi('/redirect/status'), refetchInterval: running ? 2500 : false, retry: false });

  const p = previewQ.data;
  const recipients = p?.recipients ?? [];
  const sampleRow = recipients[sample % Math.max(recipients.length, 1)];
  const typedN = Number(digitsLatin(typed).replace(/[^\d]/g, ''));
  const countOk = p != null && typedN === p.recipientCount;
  const canStart = Boolean(p?.ready && seen && countOk && !busy);

  const start = async () => {
    if (!p || !canStart) return;
    setBusy(true); setErr('');
    try {
      await shApi('/redirect/start', 'POST', { seen: true, count: typed });
      setRunning(true);
      void qc.invalidateQueries({ queryKey: ['sh-redirect-status'] });
      toast('ارسال پیام انتقال شروع شد.');
    } catch (e: any) {
      if (e?.code === 'count_changed') { setStep(0); setSeen(false); setTyped(''); void previewQ.refetch(); setErr('تعداد گیرنده‌ها عوض شده است؛ از مرحلهٔ اول دوباره شروع کنید.'); }
      else setErr(messageError(e));
    } finally { setBusy(false); }
  };
  const stop = async () => {
    try { const r = await shApi<{ stopped: number }>('/redirect/stop', 'POST'); toast(`ارسال متوقف شد (${fa(r.stopped)} پیام نرفت).`); void statusQ.refetch(); }
    catch (e) { setErr(messageError(e)); }
  };

  useEffect(() => { if (statusQ.data?.campaign?.status && statusQ.data.campaign.status !== 'running') setRunning(false); }, [statusQ.data]);

  const st = statusQ.data;
  const steps = ['گیرنده‌ها', 'پیش‌نمایش', 'تأیید'];
  if (st?.campaign && (running || st.campaign.status !== 'running' && st.counts.sent + st.counts.failed + st.counts.queued > 0 && step === 0 && running === false && busy === false && st.campaign)) {
    /* after start we show progress instead of the 3 steps */
  }
  const showProgress = Boolean(st?.campaign) && (running || st?.campaign?.status === 'running' || st?.campaign?.status === 'stopped' || st?.campaign?.status === 'done');

  if (previewQ.isLoading) return <Wizard title="پیام انتقال به ربات نفیس وام" short onClose={onClose} testId="sh-redir" foot={<button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button>}><p className="sh-sub">در حال دریافت…</p></Wizard>;
  if (!p) return <Wizard title="پیام انتقال به ربات نفیس وام" short onClose={onClose} testId="sh-redir" foot={<button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button>}><p className="sh-err" role="alert">دریافت فهرست گیرنده‌ها انجام نشد.</p></Wizard>;

  if (showProgress && st) {
    const total = Math.max(1, (st.campaign?.recipientCount ?? (st.counts.sent + st.counts.queued + st.counts.failed + st.counts.cancelled)));
    const pct = Math.round(((st.counts.sent + st.counts.failed + st.counts.cancelled) / total) * 100);
    return <Wizard title="پیام انتقال به ربات نفیس وام" onClose={onClose} testId="sh-redir-progress"
      foot={<>{st.campaign?.status === 'running' ? <button type="button" className="sh-btn sec" onClick={() => void stop()} data-testid="sh-redir-stop">توقف ارسال</button> : null}<button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button></>}>
      <div className="sh-stack">
        <div className="sh-lbl">پیشرفت ارسال</div>
        <div className="sh-prog" data-testid="sh-redir-bar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
        <div className="sh-row sh-wrap"><span className="sh-chip ok">فرستاده شد {fa(st.counts.sent)}</span><span className="sh-chip amber">در صف {fa(st.counts.queued)}</span><span className="sh-chip bad">ارسال نشد {fa(st.counts.failed)}</span></div>
        {st.campaign?.status === 'stopped' ? <p className="sh-sub">ارسال متوقف شد.</p> : null}
        {st.campaign?.status === 'done' ? <p className="sh-sub">انجام شد {st.campaign.finishedAt ? faDate(st.campaign.finishedAt) : ''}</p> : null}
        {st.failures.length ? <div className="sh-stack"><div className="sh-lbl">ارسال‌نشده‌ها</div>{st.failures.map((f, i) => <div key={i} className="sh-sumr"><b>{f.customerName}</b><span className="sh-sub">{f.reason}</span></div>)}</div> : null}
      </div>
    </Wizard>;
  }

  return <Wizard title="پیام انتقال به ربات نفیس وام" steps={steps} cur={step} onClose={onClose} testId={`sh-redir-${step}`}
    foot={step === 2
      ? <><button type="button" className="sh-btn pri sh-retry" disabled={!canStart} onClick={() => void start()} data-testid="sh-redir-go">ارسال به {fa(p.recipientCount)} مشتری</button><button type="button" className="sh-btn ghost" onClick={() => setStep(1)}>قبلی</button></>
      : <><button type="button" className="sh-btn pri" onClick={() => setStep(step + 1)} data-testid="sh-redir-next">ادامه</button><button type="button" className="sh-btn ghost" onClick={() => (step ? setStep(step - 1) : onClose())}>{step ? 'قبلی' : 'انصراف'}</button></>}>
    {step === 0 ? <div className="sh-stack" data-testid="sh-redir-step1">
      <div className="sh-big" data-testid="sh-redir-count">{fa(p.recipientCount)} مشتری پیام می‌گیرند</div>
      <div className="sh-tbl">
        <div className="sh-tr leg hd"><span>ربات کارشناس</span><span>مشتریان</span></div>
        {p.perBot.map((b) => <div className="sh-tr leg" key={b.botId}><b>{b.expertName}</b><span>{fa(b.count)}</span></div>)}
      </div>
      {p.skipped.length ? <div className="sh-stack"><div className="sh-lbl">کنار گذاشته‌شده‌ها</div>{p.skipped.map((s) => <div key={s.reason} className="sh-sumr"><span>{s.label}</span><b>{fa(s.count)}</b></div>)}</div> : null}
    </div> : null}
    {step === 1 ? <div className="sh-stack" data-testid="sh-redir-step2">
      {sampleRow ? <><div className="sh-bubble" data-testid="sh-redir-bubble"><div className="sh-sub">{sampleRow.customerName}، کارشناس {sampleRow.expertName}</div><div style={{ whiteSpace: 'pre-wrap' }}>{shRenderPreview(p.text, { customer: sampleRow.customerName, expert: sampleRow.expertName })}</div><div className="sh-chip tint" style={{ alignSelf: 'flex-start' }}>{p.button}</div></div>
        {recipients.length > 1 ? <button type="button" className="sh-btn sec sm" onClick={() => setSample((n) => n + 1)} data-testid="sh-redir-next-cust">مشتری بعدی</button> : null}</>
        : <p className="sh-sub">گیرنده‌ای نیست.</p>}
    </div> : null}
    {step === 2 ? <div className="sh-stack" data-testid="sh-redir-step3">
      <div className="sh-sumbox">
        <div className="sh-sumr"><span className="sh-lbl">گیرنده‌ها</span><b>{fa(p.recipientCount)} مشتری</b></div>
        <div className="sh-sumr"><span className="sh-lbl">ربات‌های فرستنده</span><b>{fa(p.perBot.length)}</b></div>
        <div className="sh-sumr"><span className="sh-lbl">زمان تقریبی</span><b>حدود {fa(p.etaMinutes)} دقیقه</b></div>
      </div>
      <CheckBox on={seen} onChange={setSeen} testId="sh-redir-seen" label="متن و تعداد گیرنده‌ها را دیدم و می‌دانم این پیام برگشت‌پذیر نیست" />
      <label className="sh-frow"><span className="sh-lbl">تعداد گیرنده‌ها را بنویسید</span><div className="sh-fld"><input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" aria-label="تعداد گیرنده‌ها" data-testid="sh-redir-count-input" /></div></label>
      {err ? <p className="sh-err" role="alert">{err}</p> : null}
    </div> : null}
  </Wizard>;
}
