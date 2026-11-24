import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Lock, Pencil, Plus } from 'lucide-react';
import { fa, faDate, messageError, shApi } from './api';
import { AfterConnect, Radio, Switch, Wizard } from './ui';

type Bot = { id: number; network: string; networkLabel: string; name: string; handle: string | null; unified: boolean; status: 'draft' | 'connected' | 'off'; managers: string[]; lastMessageAt: string | null };
type Legacy = { id: number; name: string; liveStatus: string; customers: number; moved: number; percent: number; redirectAuto: boolean; migratedAt: string | null; offAt: string | null; state: 'redirecting' | 'readonly' | 'off' };
type Data = { bots: Bot[]; legacy: Legacy[]; networks: { key: string; label: string }[]; redirectText: string; connectEnabled: boolean; legacyFinish: boolean; baleLive: boolean };
const NET_LETTER: Record<string, string> = { bale: 'ب', eitaa: 'ا', telegram: 'ت', whatsapp: 'و', instagram: 'ای', rubika: 'ر' };
const STATUS: Record<Bot['status'], [string, string]> = { connected: ['متصل', 'ok'], draft: ['در انتظار اتصال', 'amber'], off: ['خاموش', ''] };

export function BotsTab({ toast }: { toast: (t: string) => void }) {
  const q = useQuery<Data>({ queryKey: ['sh-bots'], queryFn: () => shApi('/bots'), retry: false });
  const [add, setAdd] = useState(false); const [redir, setRedir] = useState(false); const [err, setErr] = useState('');
  const [mig, setMig] = useState<Legacy | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); try { await fn(); await q.refetch(); toast(ok); } catch (e) { setErr(messageError(e)); } };
  if (q.isLoading) return <p className="sh-sub">در حال دریافت…</p>;
  if (!q.data) return <p className="sh-err" role="alert">دریافت ربات‌ها انجام نشد.</p>;
  const d = q.data; const free = d.networks.filter((n) => !d.bots.some((b) => b.network === n.key));
  return <>
    <div className="sh-sech"><span className="sh-chip tint">یک مشتری در همهٔ شبکه‌ها</span><span className="sh-sp" />
      <button type="button" className="sh-btn pri sm" onClick={() => setAdd(true)} disabled={!free.length} data-testid="sh-bot-add"><Plus aria-hidden="true" />افزودن ربات</button></div>
    <div className="sh-grid sh-g2">
      {d.bots.map((b) => { const [st, cls] = STATUS[b.status]; return <article className="sh-card sh-botc" key={b.id} data-testid={`sh-bot-${b.network}`}>
        <div className="hd"><span className="sh-ava" aria-hidden="true">{NET_LETTER[b.network] ?? 'ر'}</span><div className="sh-sp"><h3 className="sh-h3">{b.name.includes(b.networkLabel) ? b.name : `${b.name}، ${b.networkLabel}`}</h3><div className="sh-sub" dir="ltr" style={{ textAlign: 'right' }}>{b.handle ? `@${b.handle.replace(/^@/, '')}` : 'هنوز نشانی ندارد'}</div></div><span className={`sh-chip ${cls}`}>{st}</span></div>
        <dl><dt>مدیریت</dt><dd>{b.managers.length ? b.managers.join('، ') : 'مدیران'}</dd><dt>مشتریان</dt><dd>همهٔ کارشناس‌ها</dd><dt>آخرین پیام</dt><dd>{b.lastMessageAt ? faDate(b.lastMessageAt) : 'هنوز پیامی نیست'}</dd></dl>
        <div className="sh-row"><Link href={`/social-hub/bots/${b.id}/access`} className="sh-btn pri sh-sp" data-testid={`sh-bot-access-${b.id}`}>دسترسی‌ها</Link><button type="button" className="sh-btn sec" disabled title="در این نسخه خاموش است">ویرایش اتصال</button></div>
      </article>; })}
      {free.length ? <button type="button" className="sh-addc" onClick={() => setAdd(true)} data-testid="sh-bot-add-card"><Plus aria-hidden="true" /><b>افزودن ربات یک شبکهٔ دیگر</b><span className="sh-sub">{free.map((n) => n.label).join('، ')}</span></button> : null}
    </div>
    <div className="sh-sech" style={{ marginTop: 28 }}><div><h2 className="sh-h2">ربات‌های قدیمی</h2><div className="sh-sub">مشتری شناخته‌شده در ربات جدید دوباره احراز نمی‌شود</div></div>
      <button type="button" className="sh-btn sec sm" onClick={() => setRedir(true)} data-testid="sh-redirect-edit"><Pencil aria-hidden="true" />ویرایش پیام هدایت</button></div>
    {err ? <p className="sh-err" role="alert">{err}</p> : null}
    <div className="sh-tbl">
      <div className="sh-tr leg hd"><span>ربات</span><span>وضعیت</span><span>مشتریان منتقل‌شده</span><span>هدایت خودکار</span><span /></div>
      {!d.legacy.length ? <div className="sh-empty sh-sub">ربات قدیمی‌ای نیست.</div> : d.legacy.map((l) => <div className="sh-tr leg" key={l.id} data-testid="sh-legacy-row">
        <b>{l.name}</b>
        <span>{l.state === 'redirecting' ? <span className="sh-chip ok">هدایت فعال</span> : l.state === 'readonly' ? <span className="sh-chip"><Lock aria-hidden="true" />فقط‌خواندنی</span> : <span className="sh-chip">خاموش</span>}</span>
        {l.customers ? <span className="sh-legp"><span className="sh-bar" aria-hidden="true"><i style={{ width: `${l.percent}%` }} /></span><span className="sh-sub">{fa(l.moved)} از {fa(l.customers)} مشتری، {fa(l.percent)}٪</span></span> : <span className="sh-sub">مشتری ندارد</span>}
        {l.state === 'redirecting' ? <><span className={`sh-ctl${d.connectEnabled ? '' : ' sh-off'}`}><Switch on={l.redirectAuto} label="پیام هدایت" onChange={(v) => void act(() => shApi(`/legacy/${l.id}/redirect`, 'PUT', { on: v }), v ? 'هدایت خودکار روشن شد.' : 'هدایت خودکار خاموش شد.')} testId={`sh-legacy-auto-${l.id}`} />{d.connectEnabled ? null : <AfterConnect />}</span>
          <span className="sh-row sh-wrap" style={{ justifyContent: 'flex-end' }}><button type="button" className="sh-btn sec sm" disabled={!d.connectEnabled} title={d.connectEnabled ? undefined : 'پس از اتصال ربات'} onClick={() => void act(async () => { const r = await shApi<{ queued: number }>(`/legacy/${l.id}/send-once`, 'POST'); toast(`${fa(r.queued)} پیام در صف ارسال ثبت شد.`); }, 'ثبت شد.')} data-testid={`sh-legacy-once-${l.id}`}>ارسال یک‌باره</button>
          {d.legacyFinish ? <button type="button" className="sh-btn ghost sm" onClick={() => setMig(l)} data-testid={`sh-legacy-finish-${l.id}`}>پایان انتقال</button> : null}</span></>
          : <><span className="sh-sub">{l.offAt ? `خاموش شدن: ${faDate(l.offAt)}` : 'خارج از این انتقال'}</span>
          {d.legacyFinish && l.state === 'readonly' ? <span className="sh-row" style={{ justifyContent: 'flex-end' }}><button type="button" className="sh-btn ghost sm" onClick={() => void act(() => shApi(`/legacy/${l.id}/migrated/undo`, 'POST'), 'انتقال بازگردانده شد؛ ربات قدیمی دوباره فعال است.')} data-testid={`sh-legacy-undo-${l.id}`}>بازگرداندن</button></span> : <span />}</>}
      </div>)}
    </div>
    {redir ? <RedirectEditor text={d.redirectText} onClose={() => setRedir(false)} onSaved={() => { setRedir(false); void q.refetch(); toast('پیام هدایت ذخیره شد.'); }} /> : null}
    {mig && d.legacyFinish ? <Wizard title="پایان انتقال" short onClose={() => setMig(null)} testId="sh-legacy-confirm" foot={<><button type="button" className="sh-btn pri" onClick={() => { const l = mig; setMig(null); void act(() => shApi(`/legacy/${l.id}/migrated`, 'POST'), 'ربات قدیمی فقط‌خواندنی شد.'); }} data-testid="sh-legacy-confirm-yes">فقط‌خواندنی کن</button><button type="button" className="sh-btn ghost" onClick={() => setMig(null)} data-testid="sh-legacy-confirm-back">بازگشت</button></>}>
      <div className="sh-sumbox"><div className="sh-sumr"><span className="sh-lbl">ربات</span><b>{mig.name}</b></div><div className="sh-sumr"><span className="sh-lbl">فقط‌خواندنی از</span><b>{faDate(new Date().toISOString())}</b></div>
        <div className="sh-sumr"><span className="sh-lbl">خاموش شدن</span><b data-testid="sh-legacy-offdate">{faDate(new Date(Date.now() + 30 * 86400_000).toISOString())}</b></div>
        <div className="sh-sumr"><span className="sh-lbl">بازگرداندن</span><span>تا پیش از خاموش شدن، با «بازگرداندن» در همین ردیف</span></div></div></Wizard> : null}
    {add ? <AddBotWizard networks={free} baleLive={d.baleLive} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); void q.refetch(); toast('ربات به‌صورت پیش‌نویس ثبت شد.'); }} /> : null}
  </>;
}
function RedirectEditor({ text, onClose, onSaved }: { text: string; onClose: () => void; onSaved: () => void }) {
  const [t, setT] = useState(text); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setErr(''); try { await shApi('/redirect-text', 'PUT', { text: t }); onSaved(); } catch (e) { setErr(messageError(e)); } finally { setBusy(false); } };
  return <Wizard title="پیام هدایت به ربات جدید" onClose={onClose} testId="sh-redirect" foot={<><button type="button" className="sh-btn pri" disabled={busy} onClick={() => void save()}>ذخیره پیام</button><button type="button" className="sh-btn ghost" onClick={onClose}>انصراف</button></>}>
    <div className="sh-stack"><p className="sh-sub" style={{ margin: 0 }}>فقط برای مشتریانی که ربات قدیمی را شروع کرده‌اند.</p>
      <textarea className="sh-ta" rows={6} value={t} onChange={(e) => setT(e.target.value)} aria-label="متن پیام هدایت" /><span className="sh-sub">{fa([...t].length)} از ۱۰۰۰ نویسه</span>
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div></Wizard>;
}
function AddBotWizard({ networks, baleLive, onClose, onSaved }: { networks: { key: string; label: string }[]; baleLive: boolean; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(0); const [net, setNet] = useState(networks[0]?.key ?? ''); const [handle, setHandle] = useState('');
  const [access, setAccess] = useState<'like_bale' | 'managers'>('like_bale'); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); setErr(''); try { await shApi('/bots', 'POST', { network: net, handle: handle.trim() || null, access }); onSaved(); } catch (e) { setErr(messageError(e)); } finally { setBusy(false); } };
  const steps = ['شبکه', 'نشانی', 'دسترسی', 'اتصال']; const label = networks.find((n) => n.key === net)?.label ?? '';
  return <Wizard title="افزودن ربات" steps={steps} cur={step} onClose={onClose} testId="sh-addbot"
    foot={step === 3 ? <><button type="button" className="sh-btn pri" disabled={busy} onClick={() => void save()} data-testid="sh-addbot-save">ثبت پیش‌نویس</button><button type="button" className="sh-btn ghost" onClick={() => setStep(2)}>قبلی</button></>
      : <><button type="button" className="sh-btn pri" disabled={!net} onClick={() => setStep(step + 1)} data-testid="sh-addbot-next">ادامه</button><button type="button" className="sh-btn ghost" onClick={() => (step ? setStep(step - 1) : onClose())}>{step ? 'قبلی' : 'انصراف'}</button></>}>
    {step === 0 ? <div className="sh-stack" role="radiogroup" aria-label="شبکه">
      <Radio on={false} disabled title="بله" sub="ربات «نفیس وام» در بله" right={<span className={`sh-chip ${baleLive ? 'ok' : 'amber'}`}>{baleLive ? 'متصل' : 'در انتظار اتصال'}</span>} testId="sh-addbot-bale" />
      {networks.map((n) => <Radio key={n.key} on={net === n.key} title={n.label} sub={`ربات «نفیس وام» در ${n.label}`} onClick={() => setNet(n.key)} />)}</div>
    : step === 1 ? <label className="sh-frow"><span className="sh-lbl">نشانی ربات در {label} (اختیاری)</span><div className="sh-fld"><input dir="ltr" value={handle} maxLength={64} onChange={(e) => setHandle(e.target.value)} placeholder="@nafisvambot" /></div><span className="sh-sub">نام ربات: نفیس وام، {label}</span></label>
    : step === 2 ? <div className="sh-stack" role="radiogroup" aria-label="دسترسی"><Radio on={access === 'like_bale'} title="مثل ربات بله" sub="همان دسترسی‌های ربات بله کپی می‌شود" onClick={() => setAccess('like_bale')} /><Radio on={access === 'managers'} title="فقط مدیران" sub="بعداً در صفحهٔ دسترسی‌ها تغییر دهید" onClick={() => setAccess('managers')} /></div>
    : <div className="sh-stack">
      <div className="sh-sumbox"><div className="sh-sumr"><span className="sh-lbl">شبکه</span><b>{label}</b></div><div className="sh-sumr"><span className="sh-lbl">نشانی</span><b dir="ltr">{handle || '—'}</b></div><div className="sh-sumr"><span className="sh-lbl">دسترسی</span><b>{access === 'like_bale' ? 'مثل ربات بله' : 'فقط مدیران'}</b></div></div>
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div>}
  </Wizard>;
}
