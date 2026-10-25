import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { useSfJobs, useSfPanels, sfFetch, money, when, fa, TONE, type SfPanel } from './api';
import './smart-filing.css';

/** Admin: list of smart-filing jobs + ازکی‌وام panel settings (password is write-only). */
export default function SmartFilingJobs() {
  const q = useSfJobs();
  return (
    <section className="data-page" data-testid="smart-filing-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">ثبت هوشمند</div>
          <h2>ثبت هوشمند با سارینا</h2>
          <p>پرونده‌هایی که سارینا در پنل ازکی‌وام ثبت می‌کند. روی هر کار بزنید تا گفتگو، اسکرین‌شات‌ها و درخواست کد را ببینید. ارسال نهایی پنل فقط بعد از «تأیید ارسال» شما انجام می‌شود.</p>
        </div>
      </div>
      {q.isLoading ? <SkeletonPanel rows={4} /> : q.isError || !q.data ? <ErrorState onRetry={() => void q.refetch()} /> : (
        <div className="sf-list" data-testid="smart-filing-jobs">
          {q.data.jobs.length === 0 ? <div className="panel sf-empty">هنوز کاری ساخته نشده. از صفحه‌ی پرونده دکمه‌ی «ثبت هوشمند با سارینا» را بزنید.</div> : null}
          {q.data.jobs.map(j => (
            <Link key={j.id} href={`/smart-filing/jobs/${j.id}`} className="sf-row" data-testid={`sf-job-${j.id}`}>
              <span><b>{j.customerName || '—'}</b><span className="sf-sub"> · پرونده #{fa(j.applicationId)}{j.jobType === 'training' ? ' · آموزشی' : ''}</span></span>
              <span className="sf-hide-m">{j.planName || '—'}<span className="sf-sub"> · {j.panelName}</span></span>
              <span className="sf-hide-m">{money(j.amountToman)}</span>
              <span className={`sf-pill ${TONE[j.status]}`}>{j.statusLabel}{j.progress ? ` · ${fa(j.progress)}٪` : ''}</span>
              <span className="sf-sub">آخرین پیام: {when(j.lastMessageAt ?? j.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
      <PanelSettings />
    </section>
  );
}

function PanelSettings() {
  const q = useSfPanels(true);
  if (q.isLoading || !q.data) return null;
  return (
    <div className="panel sf-settings" data-testid="smart-filing-settings">
      <h3 style={{ margin: 0 }}><KeyRound size={16} /> تنظیمات پنل</h3>
      {!q.data.keyConfigured ? <p className="sf-note sf-warn">کلید رمزنگاری روی سرور تنظیم نشده؛ ذخیره‌ی رمز ممکن نیست.</p> : null}
      {q.data.panels.map(p => <PanelForm key={p.id} panel={p} />)}
    </div>
  );
}

function PanelForm({ panel }: { panel: SfPanel }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(panel.baseUrl ?? '');
  const [username, setUsername] = useState(panel.username ?? '');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setUrl(panel.baseUrl ?? ''); setUsername(panel.username ?? ''); }, [panel.baseUrl, panel.username]);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await sfFetch(`/panels/${panel.id}`, { method: 'PUT', body: { baseUrl: url.trim(), username: username.trim(), ...(password ? { password } : {}) } });
      setPassword(''); setMsg('ذخیره شد.'); await qc.invalidateQueries({ queryKey: ['smart-filing-panels'] });
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={e => { e.preventDefault(); void save(); }} data-testid={`sf-panel-${panel.slug}`}>
      <p style={{ margin: '0 0 8px' }}><b>{panel.name}</b> <span className="sf-sub">· طرح‌های وصل‌شده: {panel.plans.map(p => `${p.name ?? '—'} (#${fa(p.id)})`).join('، ') || 'هیچ'}</span></p>
      <div className="sf-grid">
        <label>آدرس پنل<input dir="ltr" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" data-testid="sf-panel-url" /></label>
        <label>نام کاربری<input dir="ltr" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" data-testid="sf-panel-username" /></label>
        <label>رمز عبور {panel.hasPassword ? <span className="sf-sub">(ثبت شده — برای تغییر، رمز جدید بنویسید)</span> : <span className="sf-warn">(ثبت نشده)</span>}
          <input dir="ltr" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" placeholder={panel.hasPassword ? '••••••••' : ''} data-testid="sf-panel-password" /></label>
      </div>
      <div className="sf-actions" style={{ marginTop: 10 }}>
        <button className="nf-btn nf-btn-primary" disabled={busy} data-testid="sf-panel-save"><Bot size={16} /> ذخیره</button>
        {msg ? <span className="sf-note">{msg}</span> : null}
      </div>
      <p className="sf-note">رمز رمزنگاری‌شده ذخیره می‌شود و هیچ‌وقت در این صفحه نمایش داده نمی‌شود؛ فقط سارینا هنگام اجرای کار آن را می‌گیرد. ارسال نهایی بدون تأیید مدیر بسته است.</p>
    </form>
  );
}
