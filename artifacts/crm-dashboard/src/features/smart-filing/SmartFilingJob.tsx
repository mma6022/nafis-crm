import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Send, ShieldCheck, KeyRound, RotateCcw, XCircle } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { useSfJob, sfFetch, money, when, fa, TONE, base, type SfMessage, type SfCodeRequest } from './api';
import './smart-filing.css';

/** One smart-filing job: summary + progress, chat with screenshots, code box, approval and manual outcome. */
export default function SmartFilingJob() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const q = useSfJob(id);
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [count]);
  const act = async (path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true); setErr(null);
    try { await sfFetch(`/jobs/${id}${path}`, { method: 'POST', body: body ?? {} }); await qc.invalidateQueries({ queryKey: ['smart-filing-job', id] }); return true; }
    catch (e) { setErr((e as Error).message); return false; } finally { setBusy(false); }
  };
  if (q.isLoading) return <section className="data-page"><SkeletonPanel rows={6} /></section>;
  if (q.isError || !q.data) return <section className="data-page"><ErrorState onRetry={() => void q.refetch()} /></section>;
  const { job, messages, codeRequest, isAdmin } = q.data;
  const open = ['queued', 'running', 'waiting_human', 'ready_for_approval'].includes(job.status);
  return (
    <section className="data-page sf-job" data-testid="smart-filing-job">
      <div className="panel sf-summary" data-testid="sf-summary">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Link href="/smart-filing" className="sf-sub"><ChevronRight size={14} /> همه‌ی کارها</Link>
          <span className={`sf-pill ${TONE[job.status]}`} data-testid="sf-status">{job.statusLabel}</span>
        </div>
        <dl>
          <div><dt>مشتری</dt><dd>{job.customerName || '—'}</dd></div>
          <div><dt>طرح</dt><dd>{job.planName || '—'} <span className="sf-sub">· {job.panelName}</span></dd></div>
          <div><dt>مبلغ</dt><dd>{money(job.amountToman)}</dd></div>
          <div><dt>پرونده</dt><dd><Link href={`/loan-applications/${job.applicationId}`}>#{fa(job.applicationId)}</Link>{job.jobType === 'training' ? ' · آموزشی' : ''}</dd></div>
        </dl>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}><span>{job.stepLabel || 'مرحله: —'}</span><span>{fa(job.progress)}٪</span></div>
          <div className="sf-bar" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${job.progress}%` }} /></div>
        </div>
        {isAdmin ? (
          <div className="sf-actions">
            {job.status === 'ready_for_approval' ? <button className="nf-btn nf-btn-primary" disabled={busy} onClick={() => void act('/approve-submit', {}, 'ارسال نهایی در پنل ازکی‌وام تأیید شود؟')} data-testid="sf-approve-submit"><ShieldCheck size={16} /> تأیید ارسال</button> : null}
            <Outcome busy={busy} onPick={(o, note) => act('/outcome', { outcome: o, note }, `نتیجه «${o === 'approved' ? 'تأیید شد' : 'رد شد'}» ثبت شود؟`)} />
            {['error', 'rejected', 'cancelled'].includes(job.status) ? <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('/retry')} data-testid="sf-retry"><RotateCcw size={16} /> تلاش دوباره</button> : null}
            {open || job.status === 'error' ? <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('/cancel', {}, 'این کار لغو شود؟')} data-testid="sf-cancel"><XCircle size={16} /> لغو</button> : null}
          </div>
        ) : null}
        {open && job.runner && !job.runner.online ? (
          <p className="sf-note sf-warn" data-testid="sf-runner-offline">
            سارینا الان به CRM وصل نیست{job.runner.lastSeenAt ? ` (آخرین اتصال ${new Date(job.runner.lastSeenAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })})` : ''}؛ کار در صف می‌ماند و پیام‌ها ذخیره می‌شوند تا سارینا وصل شود.
          </p>
        ) : null}
        {err ? <p className="sf-note sf-warn" role="alert">{err}</p> : null}
      </div>

      <CodeBox code={codeRequest} busy={busy} onSubmit={code => act('/code', { code })} />

      <div className="panel" style={{ padding: 0 }}>
        <div className="sf-chat" data-testid="sf-chat">
          {messages.map(m => <Message key={m.id} m={m} />)}
          <div ref={endRef} />
        </div>
        <Composer disabled={busy} onSend={text => act('/messages', { text })} />
      </div>
    </section>
  );
}

function Message({ m }: { m: SfMessage }) {
  const who = m.author === 'runner' ? 'سارینا' : m.author === 'user' ? (m.userName || 'شما') : '';
  return (
    <div className={`sf-msg ${m.author}`} data-testid={`sf-msg-${m.id}`}>
      {m.author !== 'system' ? <span className="sf-meta">{who} · {when(m.createdAt)}{m.stepLabel ? ` · ${m.stepLabel}` : ''}</span> : null}
      {m.body}{m.author === 'system' ? <span className="sf-sub"> · {when(m.createdAt)}</span> : null}
      {m.data && m.kind !== 'code_request' ? <pre>{JSON.stringify(m.data, null, 2)}</pre> : null}
      {m.screenshotUrl ? <a href={`${base()}${m.screenshotUrl}`} target="_blank" rel="noreferrer"><img src={`${base()}${m.screenshotUrl}`} alt="اسکرین‌شات پنل" loading="lazy" /></a> : null}
    </div>
  );
}

function CodeBox({ code, busy, onSubmit }: { code: SfCodeRequest; busy: boolean; onSubmit: (c: string) => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [left, setLeft] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // Count down from the server's secondsLeft (re-anchored on every poll) so a wrong phone clock can't disable the box.
  useEffect(() => {
    if (!code) { setLeft(0); return; }
    const deadline = Date.now() + (typeof code.secondsLeft === 'number' ? code.secondsLeft * 1000 : new Date(code.expiresAt).getTime() - Date.now());
    const tick = () => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick(); const t = window.setInterval(tick, 1000); return () => window.clearInterval(t);
  }, [code?.id, code?.expiresAt, code?.secondsLeft]);
  const active = Boolean(code) && left > 0;
  // A new code request brings the box into view and focuses the input.
  useEffect(() => {
    if (!code?.id) return;
    boxRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    boxRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [code?.id]);
  return (
    <div ref={boxRef} className={`panel sf-code${active ? '' : ' off'}`} data-testid="sf-code-box" data-active={active ? '1' : '0'}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <b><KeyRound size={15} /> {active ? (code!.target === 'customer' ? 'کد به موبایل مشتری رفته — از مشتری بپرسید' : 'کد به شماره‌ی ما رفته') : 'الان درخواست کدی باز نیست'}</b>
        {active ? <span className="sf-pill warn" data-testid="sf-code-countdown">{fa(Math.floor(left / 60))}:{fa(String(left % 60).padStart(2, '0'))}</span> : null}
      </div>
      {active && code!.prompt ? <span className="sf-note">{code!.prompt}</span> : null}
      <form onSubmit={e => { e.preventDefault(); if (value.trim()) void onSubmit(value.trim()).then(ok => { if (ok) setValue(''); }); }}>
        <input inputMode="numeric" autoComplete="one-time-code" value={value} disabled={!active || busy} onChange={e => setValue(e.target.value)} placeholder="کد" data-testid="sf-code-input" />
        <button className="nf-btn nf-btn-primary" disabled={!active || busy || !value.trim()} data-testid="sf-code-submit">ارسال کد</button>
      </form>
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (t: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const send = () => { if (text.trim()) void onSend(text.trim()).then(ok => { if (ok) setText(''); }); };
  return (
    <form className="sf-composer" onSubmit={e => { e.preventDefault(); send(); }}>
      <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="راهنمایی برای سارینا بنویسید…" maxLength={2000}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} data-testid="sf-composer-input" />
      <button className="nf-btn nf-btn-primary" disabled={disabled || !text.trim()} aria-label="ارسال" data-testid="sf-composer-send"><Send size={16} /></button>
    </form>
  );
}

function Outcome({ busy, onPick }: { busy: boolean; onPick: (o: 'approved' | 'rejected', note: string) => Promise<boolean> }) {
  const [openSel, setOpenSel] = useState(false);
  if (!openSel) return <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => setOpenSel(true)} data-testid="sf-outcome">ثبت نتیجه</button>;
  return (
    <span className="sf-outcome">
      <button className="nf-btn nf-btn-primary" disabled={busy} onClick={() => void onPick('approved', '').then(() => setOpenSel(false))} data-testid="sf-outcome-approved">تأیید شد</button>
      <button className="nf-btn nf-btn-ghost" style={{ color: 'var(--nf-danger)' }} disabled={busy} onClick={() => void onPick('rejected', '').then(() => setOpenSel(false))} data-testid="sf-outcome-rejected">رد شد</button>
      <button className="nf-btn nf-btn-ghost" onClick={() => setOpenSel(false)}>انصراف</button>
    </span>
  );
}
