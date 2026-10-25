import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Save, Send, UserRoundCheck } from 'lucide-react';
import { ErrorState } from '@/components/CrmShell';
import { EXPERT_INTRO_KEY, maskPhone, saveExpertIntroSettings, testSendExpertIntro, useExpertIntroSettings, type ExpertRow } from './api';

const KIND: Record<ExpertRow['kind'], string> = { closer: 'کارشناس فروش', qualifier: 'ارزیاب (بدون پیامک)', trainee: 'کارآموز (بدون پیامک)', other: 'سایر' };

/** «پیامک معرفی کارشناس» settings card (admin). The switch is OFF by default; the test send is a real SMS to the typed number only. */
export function ExpertIntroSmsCard() {
  const qc = useQueryClient();
  const q = useExpertIntroSettings();
  const [code, setCode] = useState('');
  const [blocked, setBlocked] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testExpert, setTestExpert] = useState<string>('sample');
  const [sampleName, setSampleName] = useState('کارشناس تست');
  const [samplePhone, setSamplePhone] = useState('');
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { if (q.data) { setCode(q.data.patternCode); setBlocked(q.data.blockedPhones.join('\n')); } }, [q.data]);
  if (q.isLoading) return <section className="panel notification-settings-card"><div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div></section>;
  if (q.isError || !q.data) return <section className="panel notification-settings-card"><ErrorState onRetry={() => q.refetch()} /></section>;
  const d = q.data;
  const sellable = d.experts.filter((e) => e.active && e.kind !== 'qualifier' && e.kind !== 'trainee');
  const missing = sellable.filter((e) => !e.phone);
  const withPhone = sellable.filter((e) => e.phone);
  const nameParam = `%${d.paramNames.name}%`, phoneParam = `%${d.paramNames.phone}%`;
  const preview = d.template.replace('[نام کارشناس]', nameParam).replace('[شماره]', phoneParam);

  const save = async (patch: Parameters<typeof saveExpertIntroSettings>[0], done: string) => {
    setBusy(true); setMsg(null);
    try { const v = await saveExpertIntroSettings(patch); qc.setQueryData(EXPERT_INTRO_KEY, v); setMsg({ ok: true, text: done }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'ذخیره انجام نشد.' }); }
    finally { setBusy(false); }
  };
  const toggle = (on: boolean) => {
    if (on && !window.confirm('با فعال‌کردن، پس از واگذاری مشتری از ارزیاب به کارشناس فروش، برای مشتری پیامک معرفی کارشناس ارسال می‌شود. ادامه می‌دهید؟')) return;
    void save({ enabled: on }, on ? 'پیامک معرفی کارشناس فعال شد.' : 'پیامک معرفی کارشناس غیرفعال شد.');
  };
  const runTest = async () => {
    setTestMsg(null);
    const body = testExpert === 'sample' ? { phone: testPhone, expertName: sampleName, expertPhone: samplePhone } : { phone: testPhone, salespersonId: Number(testExpert) };
    if (!window.confirm('یک پیامک واقعی فقط به همین شماره‌ی آزمایشی ارسال می‌شود. ادامه می‌دهید؟')) return;
    setBusy(true);
    try { const r = await testSendExpertIntro(body); setTestMsg({ ok: true, text: `ارسال شد (شناسه‌ی سامانه: ${r.providerId}).` }); setTestPhone(''); }
    catch (e) { setTestMsg({ ok: false, text: e instanceof Error ? e.message : 'ارسال آزمایشی انجام نشد.' }); }
    finally { setBusy(false); }
  };

  return (
    <section className="panel notification-settings-card expert-intro-card" data-testid="panel-expert-intro-sms">
      <div className="panel-head">
        <div><h3><UserRoundCheck size={17} /> پیامک معرفی کارشناس</h3><p>پس از تماس و واگذاری مشتری از ارزیاب به کارشناس فروش</p></div>
        <label className="settings-switch"><input type="checkbox" checked={d.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} data-testid="checkbox-expert-intro-enabled" /><span>{d.enabled ? 'فعال' : 'غیرفعال'}</span></label>
      </div>
      <div className="expert-intro-preview" data-testid="text-expert-intro-template">{preview}</div>
      <div className="settings-help">
        ارسال از {d.provider} با فرستنده <span dir="ltr">{d.fromNumber}</span> · فقط ساعت ۸ تا ۲۱ به وقت تهران (خارج از آن، ساعت ۸ صبح) · برای هر مشتری و کارشناس فقط یک بار ·
        بدون ارسال برای کارآموزان، شماره‌های آزمایشی و داخلی و مشتریان قبلی.
        {!d.ippanelEnabled ? <strong> پیامک IPPanel در بالای همین صفحه خاموش است.</strong> : null}
        {!d.relayConfigured ? <strong> رله‌ی پیامک روی سرور تنظیم نشده است.</strong> : null}
      </div>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="expert-intro-pattern">کد پترن تأییدشده در IPPanel</label>
          <input id="expert-intro-pattern" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="pattern code" data-testid="input-expert-intro-pattern" />
          <small>متن بالا باید عیناً به‌صورت پترن با متغیرهای <code>{d.paramNames.name}</code> و <code>{d.paramNames.phone}</code> در پنل تأیید شود.</small>
        </div>
        <div className="field full">
          <label htmlFor="expert-intro-blocked">شماره‌های آزمایشی (هرگز پیامک نگیرند)</label>
          <textarea id="expert-intro-blocked" dir="ltr" className="settings-template-textarea expert-intro-blocked" value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="09xxxxxxxxx" data-testid="textarea-expert-intro-blocked" />
          <small>شماره‌ی همکاران و شماره‌های مستثنا از نمایش تماس خودکار کنار گذاشته می‌شوند.</small>
        </div>
      </div>
      <div className="form-footer">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save({ patternCode: code, blockedPhones: blocked }, 'تنظیمات پیامک معرفی کارشناس ذخیره شد.')} data-testid="button-save-expert-intro"><Save size={16} />ذخیره</button>
      </div>
      {msg ? <div className={msg.ok ? 'ai-extract-success' : 'profile-form-error'} data-testid="feedback-expert-intro">{msg.text}</div> : null}

      <div className="expert-intro-experts">
        <strong>کارشناسان بدون «شماره تماس برای مشتری» ({missing.length.toLocaleString('fa-IR')})</strong>
        {missing.length ? <ul>{missing.map((e) => <li key={e.salespersonId}>{e.name} <span className="muted">· {KIND[e.kind]}</span></li>)}</ul> : <span className="muted"> همه شماره دارند.</span>}
        <small>برای این کارشناسان پیامک ارسال نمی‌شود و در سابقه‌ی مشتری «شماره‌ی کارشناس تعریف نشده» ثبت می‌شود. شماره را از «مدیریت کاربران» وارد کنید.</small>
      </div>
      {Object.keys(d.stats).length ? <div className="settings-help">صف و ارسال‌ها: {Object.entries(d.stats).map(([k, v]) => `${({ queued: 'در صف', sending: 'در حال ارسال', sent: 'ارسال‌شده', skipped: 'ارسال‌نشده', failed: 'ناموفق', uncertain: 'نامشخص' } as Record<string, string>)[k] ?? k} ${v.toLocaleString('fa-IR')}`).join(' · ')}</div> : null}

      <div className="expert-intro-test" data-testid="panel-expert-intro-test">
        <strong><Send size={15} /> ارسال آزمایشی</strong>
        <div className="form-grid">
          <div className="field"><label htmlFor="expert-intro-test-phone">شماره‌ی گیرنده‌ی آزمایشی</label><input id="expert-intro-test-phone" dir="ltr" type="tel" autoComplete="off" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="09xxxxxxxxx" data-testid="input-expert-intro-test-phone" /></div>
          <div className="field"><label htmlFor="expert-intro-test-expert">کارشناس</label>
            <select id="expert-intro-test-expert" value={testExpert} onChange={(e) => setTestExpert(e.target.value)} data-testid="select-expert-intro-test-expert">
              <option value="sample">نام و شماره‌ی نمونه</option>
              {withPhone.map((e) => <option key={e.salespersonId} value={e.salespersonId}>{e.name} ({maskPhone(e.phone)})</option>)}
            </select>
          </div>
          {testExpert === 'sample' ? <>
            <div className="field"><label htmlFor="expert-intro-sample-name">نام نمونه</label><input id="expert-intro-sample-name" value={sampleName} onChange={(e) => setSampleName(e.target.value)} /></div>
            <div className="field"><label htmlFor="expert-intro-sample-phone">شماره‌ی نمونه در متن</label><input id="expert-intro-sample-phone" dir="ltr" value={samplePhone} onChange={(e) => setSamplePhone(e.target.value)} placeholder="021xxxxxxxx" /></div>
          </> : null}
        </div>
        <div className="form-footer"><button type="button" className="btn btn-ghost" disabled={busy || !testPhone.trim() || !d.patternCode} onClick={() => void runTest()} data-testid="button-expert-intro-test"><Send size={16} />ارسال آزمایشی</button></div>
        <small>پیامک واقعی است و حتی با سوییچ خاموش فقط به همین شماره ارسال می‌شود. شماره‌ی گیرنده جایی ذخیره نمی‌شود.{!d.patternCode ? ' ابتدا کد پترن را ذخیره کنید.' : ''}</small>
        {testMsg ? <div className={testMsg.ok ? 'ai-extract-success' : 'profile-form-error'} data-testid="feedback-expert-intro-test">{testMsg.text}</div> : null}
      </div>
    </section>
  );
}
