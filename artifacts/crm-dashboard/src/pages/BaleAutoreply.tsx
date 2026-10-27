import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, Bot, CalendarOff, Clock, Info, Lock, Plus, Power, Save, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { toast } from '@/hooks/use-toast';
import { dateToJalaliValue, jalaliValueToGregorian } from '@/lib/jalali';
import { baleCanConnect, baleFetch, baleWhen, faNum, toEnDigits } from '@/features/bale/api';
import { AR_DAYS, AR_TEXT_MAX, arStopFa, shortName, type ArAdmin, type ArHoliday, type ArItem, type ArMe, type ArPair, type ArSettings } from '@/features/bale-autoreply/api';
import { AutoreplyLive } from '@/features/bale-autoreply/AutoreplyLive';
import '@/features/bale/bale.css';
import '@/features/bale-autoreply/ar.css';

const ME_KEY = ['bale', 'ar', 'me'] as const;
const ADMIN_KEY = ['bale', 'ar', 'admin'] as const;
const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
const faTime = (hm: string) => faNum(hm);
const hoursFa = (s: ArSettings) => `${s.days.length === 7 ? 'همه‌ی روزها' : s.days.length ? s.days.map(d => AR_DAYS[d]).join('، ') : 'هیچ روزی'} · ${faTime(s.dayStart)} تا ${faTime(s.dayEnd)} (تهران)`;

/** Typed «روشن» confirmation for every ON (the server refuses ON without it: 428). */
function ConfirmOn({ title, lines, onClose, onOk, busy }: { title: string; lines: string[]; onClose: () => void; onOk: () => void; busy: boolean }) {
  const [v, setV] = useState('');
  return <Modal title={title} eyebrow="پاسخ خودکار بله" onClose={onClose} testId="ar-confirm-on">
    <form className="ar-confirm" onSubmit={e => { e.preventDefault(); if (v.trim() === 'روشن') onOk(); }}>
      <ul className="rl">{lines.map(l => <li key={l}>{l}</li>)}</ul>
      <label htmlFor="ar-confirm-input">برای تأیید، کلمه‌ی «روشن» را تایپ کنید.</label>
      <input id="ar-confirm-input" value={v} onChange={e => setV(e.target.value)} autoComplete="off" data-testid="input-ar-confirm" />
      <div className="bl-acts"><button type="submit" className="btn btn-primary" disabled={busy || v.trim() !== 'روشن'} data-testid="button-ar-confirm">روشن کن</button>
        <button type="button" className="btn" onClick={onClose}>انصراف</button></div>
    </form>
  </Modal>;
}

/** Switch card (design scenes 01 / 17 / 19). Expert: OFF only; turning ON is the admin's job. */
function SwitchCard({ pair, settings, connected, onOff, busy, admin = false }: { pair: ArPair; settings: ArSettings; connected: boolean; onOff?: () => void; busy?: boolean; admin?: boolean }) {
  const asst = pair.assistantName || 'مسعود';
  const stop = arStopFa(pair.stoppedReason);
  const st = stop ? 'bad' : pair.active ? 'on' : pair.enabled && settings.globalEnabled ? 'warn' : 'off';
  return <div className={`swc st-${st}`} data-testid="ar-switch-card">
    <span className="av0" aria-hidden="true"><Bot size={20} /></span>
    <div className="tx">
      <div className="r"><b>پاسخ خودکار {asst}</b><span className={`pil ${st === 'on' ? 'on' : st === 'bad' ? 'bad' : 'mut'}`} data-testid="ar-switch-state">{pair.active ? 'روشن' : stop ? 'خودکار خاموش شد' : pair.enabled && !settings.globalEnabled ? 'کلید کلی خاموش' : pair.enabled ? 'روشن، بله آماده نیست' : 'خاموش'}</span></div>
      <p>{pair.active ? `${asst} فقط به پیام‌هایی که مشتری می‌فرستد، با صدای ${shortName(pair.expertName)} و بدون امضا جواب می‌دهد. هیچ پیام اولی فرستاده نمی‌شود.`
        : stop ? `${stop}؛ همه‌ی پیام‌های در صف متوقف شد. فقط مدیر دوباره روشن می‌کند.`
        : !connected ? 'حساب بله وصل نیست؛ تا وصل نشود هیچ جوابی فرستاده نمی‌شود.'
        : `${asst} الان جواب نمی‌دهد. ${admin ? '' : 'روشن کردن فقط با مدیر است.'}`}</p>
      <span className="who"><Clock size={13} /> ساعت کاری: {hoursFa(settings)}{settings.holidays.length ? ` · ${faNum(settings.holidays.length)} تعطیل رسمی` : ''}</span>
      <span className="who">این ساعت {faNum(pair.sentLastHour)} از {faNum(pair.perHour)} · امروز {faNum(pair.sentToday)} از {faNum(pair.perDay)}{pair.updatedBy ? ` · آخرین تغییر: ${pair.updatedBy}، ${baleWhen(pair.updatedAt)}` : ''}</span>
    </div>
    {onOff ? <div className="ctl">
      {pair.enabled ? <button type="button" role="switch" aria-checked="true" className="tgl" disabled={busy} onClick={onOff} data-testid="ar-expert-off"><span className="k" aria-hidden="true" /> خاموش کن</button>
        : <span className="who" data-testid="ar-expert-locked"><Lock size={14} /> روشن کردن با مدیر</span>}
    </div> : null}
  </div>;
}

function ExpertView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ME_KEY, queryFn: () => baleFetch<ArMe>('/bale/me/autoreply'), refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <SkeletonPanel rows={4} />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d.paired) return <div className="bl-note off" data-testid="ar-not-paired"><Info size={18} /><span>برای شما دستیار پاسخ خودکار تعریف نشده است.</span></div>;
  const off = async () => {
    setBusy(true);
    try { await baleFetch('/bale/me/autoreply', { method: 'PUT', body: { enabled: false } }); toast({ title: `پاسخ خودکار ${d.pair.assistantName} خاموش شد` }); }
    catch (e) { toast({ title: 'انجام نشد', description: errMsg(e), variant: 'destructive' }); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ME_KEY }); }
  };
  return <>
    <SwitchCard pair={d.pair} settings={d.settings} connected={d.connected} onOff={() => void off()} busy={busy} />
    {!d.connected ? <div className="bl-note warn"><AlertCircle size={18} /><span>حساب بله وصل نیست. <Link href="/settings/bale">اتصال بله</Link></span></div> : null}
    <AutoreplyLive pair={d.pair} list={d.list} onChanged={() => void qc.invalidateQueries({ queryKey: ME_KEY })} />
  </>;
}

const RULES = [
  'فقط جواب به پیامی که مشتری می‌فرستد؛ هیچ پیام اول، پیام گروهی یا پیام تبلیغاتی.',
  'با صدای کارشناس و بدون امضا؛ در CRM با برچسب «مسعود (خودکار)» دیده می‌شود.',
  'قول، تضمین، مبلغ، تاریخ یا ناراحتی ← فقط پیام نگه‌دار و گفتگو به کارشناس سپرده می‌شود (با زنگ).',
  'جواب کارشناس از اپ یا CRM ← گفتگو دست کارشناس؛ فقط دکمه‌ی «برگردون به مسعود» آن را برمی‌گرداند.',
  'پیام قدیمی‌تر از ۲۴ ساعت ← جواب داده نمی‌شود و به کارشناس سپرده می‌شود؛ از پیام‌های جمع‌شده فقط آخرین پیام، یک بار.',
  'خارج از ساعت کاری فقط یک پیام شب برای هر گفتگو.',
  'شماره‌ی ناشناس (فقط کاظمی–مسعود): فقط جواب عمومی؛ شماره ذخیره نمی‌شود.',
  'سقف ساعتی و روزانه؛ با محدودیت یا مسدود شدن بله، همه خودکار خاموش می‌شود و فقط مدیر روشن می‌کند.',
];

function PairCard({ p, globalOn, busy, set }: { p: ArPair; globalOn: boolean; busy: boolean; set: (p: ArPair, body: Record<string, unknown>, label: string) => void }) {
  const stop = arStopFa(p.stoppedReason);
  const opt = (k: 'readsEnabled' | 'allowUnknown' | 'allowPlanFile', label: string, hidden = false) => hidden ? null
    : <button type="button" role="switch" aria-checked={p[k]} className="tgl" disabled={busy} onClick={() => set(p, { [k]: !p[k] }, label)} data-testid={`ar-pair-${p.slug}-${k}`}><span className="k" aria-hidden="true" /> {label}</button>;
  return <article className={`pair${p.active ? ' on' : ''}`} data-testid={`ar-pair-${p.slug}`}>
    <div className="r"><span className="av0" aria-hidden="true"><Bot size={20} /></span>
      <div className="tx"><b>{shortName(p.expertName)} ← {p.assistantName}</b><span className="who">{p.expertName}</span></div>
      <button type="button" role="switch" aria-checked={p.enabled} aria-label={`پاسخ خودکار ${p.assistantName}`} className="tgl" disabled={busy} onClick={() => set(p, { enabled: !p.enabled }, `پاسخ خودکار ${p.assistantName}`)} data-testid={`ar-pair-${p.slug}-enabled`}><span className="k" aria-hidden="true" /></button>
    </div>
    <div className="pst">
      <span className={`pil ${p.active ? 'on' : stop ? 'bad' : 'mut'}`}>{p.active ? 'فعال' : stop ? `خودکار خاموش شد: ${stop}` : p.enabled ? (globalOn ? 'روشن، بله آماده نیست' : 'منتظر کلید کلی') : 'خاموش'}</span>
      <span className="pil mut">بله: {!p.account ? 'وصل نیست' : p.account.status === 'connected' ? (p.account.session === 'down' ? 'اتصال ناقص' : 'وصل') : 'وصل نیست'}</span>
      <span className="pil mut">این ساعت {faNum(p.sentLastHour)}/{faNum(p.perHour)} · امروز {faNum(p.sentToday)}/{faNum(p.perDay)}</span>
      {p.handedToExpert ? <span className="pil">{faNum(p.handedToExpert)} گفتگو دست کارشناس</span> : null}
    </div>
    <div className="opts">
      {opt('readsEnabled', 'خواندن پیام‌ها و مدارک (برچسب و وضعیت)')}
      {opt('allowUnknown', 'جواب به شماره‌ی ناشناس', p.slug !== 'masoud')}
      {opt('allowPlanFile', 'فایل طرح فقط در جواب')}
    </div>
    <p className="who">{p.updatedBy ? `آخرین تغییر: ${p.updatedBy}، ${baleWhen(p.updatedAt)}` : 'هنوز تغییری نداده‌اید.'}</p>
  </article>;
}

function SettingsForm({ s, onSaved }: { s: ArSettings; onSaved: () => void }) {
  const [f, setF] = useState(s); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [hDate, setHDate] = useState(''); const [hLabel, setHLabel] = useState('');
  useEffect(() => { setF(s); }, [s]);
  const dirty = JSON.stringify(f) !== JSON.stringify(s);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await baleFetch('/admin/bale/autoreply/settings', { method: 'PUT', body: { dayStart: toEnDigits(f.dayStart), dayEnd: toEnDigits(f.dayEnd), days: f.days, holdText: f.holdText, nightText: f.nightText, holidays: f.holidays } });
      toast({ title: 'تنظیمات پاسخ خودکار ذخیره شد', description: 'هیچ کلیدی روشن نشد.' }); onSaved();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const addHoliday = () => {
    const g = jalaliValueToGregorian(hDate); if (!g) return;
    const list: ArHoliday[] = [...f.holidays.filter(h => h.date !== g), { date: g, label: hLabel.trim() || null }].sort((a, b) => a.date.localeCompare(b.date));
    setF({ ...f, holidays: list }); setHDate(''); setHLabel('');
  };
  const toggleDay = (d: number) => setF({ ...f, days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d].sort() });
  const text = (k: 'holdText' | 'nightText', label: string, hint: string) => <div className="fld">
    <label htmlFor={`ar-${k}`}>{label}</label>
    <span className="hint muted" style={{ fontSize: 13 }}>{hint}</span>
    <textarea id={`ar-${k}`} value={f[k]} maxLength={AR_TEXT_MAX} onChange={e => setF({ ...f, [k]: e.target.value })} data-testid={`input-ar-${k}`} />
    <span className="cnt">{faNum(f[k].length)} از {faNum(AR_TEXT_MAX)}</span>
    <div className="prv" aria-label="پیش‌نمایش"><div className="mo hold" style={{ justifySelf: 'end' }}><span className="mh2"><span className="ptag"><Bot size={13} /> مسعود (خودکار)</span><span className="lab">{k === 'holdText' ? 'پیام نگه‌دار · بدون تعهد' : 'پیام شب · بدون تعهد'}</span></span><div className="bub" dir="auto">{f[k] || '—'}</div></div></div>
  </div>;
  return <form className="panel" style={{ display: 'grid', gap: 14 }} onSubmit={save} data-testid="ar-settings-form">
    <h3 style={{ margin: 0 }}>ساعت کاری و متن‌ها</h3>
    <div className="bl-note off"><Info size={18} /><span>پیش‌فرض مدیر محصول ۰۸:۳۰ تا ۲۰:۰۰ است؛ آقای ابوالقاسمی «۸ تا ۲۰» گفته بود. اگر ۰۸:۰۰ مدنظر است، اینجا عوض کنید.</span></div>
    <div className="tmr" style={{ flexWrap: 'wrap' }}>
      <label htmlFor="ar-start">از</label><input id="ar-start" className="tmi" value={f.dayStart} onChange={e => setF({ ...f, dayStart: e.target.value })} inputMode="numeric" placeholder="08:30" data-testid="input-ar-start" />
      <label htmlFor="ar-end">تا</label><input id="ar-end" className="tmi" value={f.dayEnd} onChange={e => setF({ ...f, dayEnd: e.target.value })} inputMode="numeric" placeholder="20:00" data-testid="input-ar-end" />
      <span className="who">به وقت تهران؛ برای همه‌ی روزهای کاری یکسان.</span>
    </div>
    <ul className="hrs" aria-label="روزهای کاری">{AR_DAYS.map((name, d) => { const on = f.days.includes(d); return <li key={d} className={`hr${on ? '' : ' off'}`}>
      <b>{name}</b>
      <button type="button" role="switch" aria-checked={on} aria-label={`${name}: ${on ? 'کاری' : 'تعطیل'}`} className="tgl" onClick={() => toggleDay(d)} data-testid={`ar-day-${d}`}><span className="k" aria-hidden="true" /></button>
      <span className="hint muted">{on ? `${faTime(f.dayStart)} تا ${faTime(f.dayEnd)}` : 'تعطیل؛ فقط پیام شب'}</span></li>; })}</ul>
    <div className="fld"><label>تعطیلات رسمی</label><span className="hint muted" style={{ fontSize: 13 }}>این روزها مثل جمعه حساب می‌شوند: فقط پیام شب.</span>
      <div className="hadd">
        <PersianDatePicker value={hDate} onChange={setHDate} testId="input-ar-holiday-date" />
        <input value={hLabel} onChange={e => setHLabel(e.target.value)} maxLength={40} placeholder="عنوان (مثلاً تاسوعا)" aria-label="عنوان تعطیلی" data-testid="input-ar-holiday-label" />
        <button type="button" className="btn" disabled={!jalaliValueToGregorian(hDate)} onClick={addHoliday} data-testid="button-ar-holiday-add"><Plus size={16} /> افزودن</button>
      </div>
      {f.holidays.length ? <ul className="hls">{f.holidays.map(h => <li key={h.date} className="hl"><CalendarOff size={16} /><div><b>{faNum(dateToJalaliValue(new Date(`${h.date}T12:00:00Z`)))}</b>{h.label ? <span>{h.label}</span> : null}</div>
        <button type="button" className="btn btn-ghost" aria-label={`حذف ${h.label ?? h.date}`} onClick={() => setF({ ...f, holidays: f.holidays.filter(x => x.date !== h.date) })}><Trash2 size={16} /></button></li>)}</ul>
        : <span className="who">تعطیل رسمی ثبت نشده است.</span>}
    </div>
    {text('holdText', 'پیام نگه‌دار (در ساعت کاری)', 'وقتی گفتگو به کارشناس سپرده می‌شود. بدون قول، مبلغ یا تاریخ.')}
    {text('nightText', 'پیام شب (خارج از ساعت کاری)', 'یک بار برای هر گفتگو در هر شب.')}
    {err ? <p className="bl-err" role="alert"><AlertCircle size={16} /> {err}</p> : null}
    <div className="sv"><button type="submit" className="btn btn-primary" disabled={busy || !dirty} data-testid="button-ar-settings-save"><Save size={16} /> ذخیره</button>
      <button type="button" className="btn" disabled={busy || !dirty} onClick={() => setF(s)}><Undo2 size={16} /> برگرداندن</button></div>
    <span className="who">{s.updatedBy ? `آخرین تغییر: ${s.updatedBy}، ${baleWhen(s.updatedAt)}` : ''}{s.wakeConfigured ? ' · بیدارباش دستیار تنظیم شده' : ''}</span>
  </form>;
}

function AdminLive({ pairs }: { pairs: ArPair[] }) {
  const [aid, setAid] = useState(pairs[0]?.assistantId ?? 0);
  const q = useQuery({ queryKey: ['bale', 'ar', 'live', aid], enabled: Boolean(aid), refetchInterval: 15_000,
    queryFn: () => baleFetch<{ pair: ArPair; list: ArItem[] }>(`/admin/bale/autoreply/pairs/${aid}/live`) });
  return <div style={{ display: 'grid', gap: 10 }}>
    <div className="tabs2" role="tablist" aria-label="جفت">{pairs.map(p => <button key={p.assistantId} type="button" role="tab" className="ch" aria-selected={aid === p.assistantId} onClick={() => setAid(p.assistantId)}>{shortName(p.expertName)} ← {p.assistantName}</button>)}</div>
    {q.isLoading ? <SkeletonPanel rows={4} /> : q.isError || !q.data ? <ErrorState onRetry={() => q.refetch()} /> : <AutoreplyLive key={aid} pair={q.data.pair} list={q.data.list} admin onChanged={() => void q.refetch()} />}
  </div>;
}

function AdminView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ADMIN_KEY, queryFn: () => baleFetch<ArAdmin>('/admin/bale/autoreply'), refetchInterval: 20_000 });
  const [tab, setTab] = useState<'pairs' | 'settings' | 'live'>('pairs');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; lines: string[]; path: string; body: Record<string, unknown> }>(null);
  if (q.isLoading) return <SkeletonPanel rows={4} />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;
  const d = q.data; const refresh = () => void qc.invalidateQueries({ queryKey: ADMIN_KEY });
  const put = async (path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await baleFetch(path, { method: 'PUT', body }); toast({ title: ok }); setConfirm(null); }
    catch (e) { toast({ title: 'انجام نشد', description: errMsg(e), variant: 'destructive' }); }
    finally { setBusy(false); refresh(); }
  };
  const setPair = (p: ArPair, body: Record<string, unknown>, label: string) => {
    const on = Object.values(body).some(v => v === true); const path = `/admin/bale/autoreply/pairs/${p.assistantId}`;
    if (!on) return void put(path, body, `${label} خاموش شد`);
    setConfirm({ title: `روشن کردن «${label}»`, path, body, lines: [`جفت: ${p.expertName} ← ${p.assistantName}`, 'حالت حساب بله‌ی کارشناس تغییر نمی‌کند.', 'فقط جواب به پیامی که مشتری می‌فرستد؛ با همان سقف‌ها و خاموشی خودکار.', 'پیش از روشن کردن، تأیید مستقیم آقای ابوالقاسمی لازم است.'] });
  };
  const g = d.settings.globalEnabled;
  return <>
    <div className="tabs2" role="tablist" aria-label="بخش‌ها">
      {([['pairs', 'جفت‌ها و کلیدها'], ['settings', 'ساعت و متن‌ها'], ['live', 'نمای زنده']] as const).map(([k, l]) => <button key={k} type="button" role="tab" className="ch" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`ar-tab-${k}`}>{l}</button>)}
    </div>
    {tab === 'pairs' ? <>
      <div className={`swc st-${g ? 'on' : 'off'}`} data-testid="ar-global">
        <span className="av0" aria-hidden="true"><Power size={20} /></span>
        <div className="tx"><div className="r"><b>کلید کلی پاسخ خودکار</b><span className={`pil ${g ? 'on' : 'mut'}`}>{g ? 'روشن' : 'خاموش'}</span></div>
          <p>{g ? 'جفت‌هایی که خودشان روشن‌اند جواب می‌دهند.' : 'تا این کلید خاموش است، هیچ دستیاری جواب نمی‌دهد؛ حتی اگر جفتش روشن باشد.'}</p>
          <span className="who"><Clock size={13} /> {hoursFa(d.settings)} · الان {d.settings.openNow ? 'ساعت کاری' : 'خارج از ساعت کاری'}</span></div>
        <div className="ctl"><button type="button" role="switch" aria-checked={g} className="tgl" disabled={busy} data-testid="ar-global-toggle"
          onClick={() => g ? void put('/admin/bale/autoreply/settings', { globalEnabled: false }, 'کلید کلی خاموش شد')
            : setConfirm({ title: 'روشن کردن کلید کلی', path: '/admin/bale/autoreply/settings', body: { globalEnabled: true }, lines: ['همه‌ی جفت‌های روشن شروع به جواب دادن می‌کنند.', 'حالت حساب بله‌ی کارشناس‌ها تغییر نمی‌کند.', 'پیش از روشن کردن، تأیید مستقیم آقای ابوالقاسمی لازم است.'] })}><span className="k" aria-hidden="true" /> {g ? 'خاموش کن' : 'روشن کن'}</button></div>
      </div>
      <div className="pairs">{d.pairs.map(p => <PairCard key={p.assistantId} p={p} globalOn={g} busy={busy} set={setPair} />)}</div>
      <div className="panel" style={{ display: 'grid', gap: 8 }}><h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><ShieldCheck size={18} /> قانون‌های ثابت</h3>
        <ol className="rl">{RULES.map(r => <li key={r}>{r}</li>)}</ol></div>
    </> : tab === 'settings' ? <SettingsForm s={d.settings} onSaved={refresh} /> : <AdminLive pairs={d.pairs} />}
    {confirm ? <ConfirmOn title={confirm.title} lines={confirm.lines} busy={busy} onClose={() => setConfirm(null)} onOk={() => void put(confirm.path, { ...confirm.body, confirm: 'روشن' }, `${confirm.title.replace('روشن کردن ', '')} روشن شد`)} /> : null}
  </>;
}

export default function BaleAutoreply() {
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user as { id?: number; role?: string; salespersonId?: number | null } | undefined;
  const isAdmin = user?.role === 'admin' && user.id !== 29;
  const expert = baleCanConnect(user);
  return <section className="data-page arx" data-testid="page-bale-autoreply" dir="rtl">
    <div className="page-intro"><div><span className="eyebrow">پیام‌رسان بله</span><h2>پاسخ خودکار بله</h2>
      <p>{isAdmin ? 'کلیدهای هر جفت کارشناس–دستیار، ساعت کاری، متن‌ها و نمای زنده (فقط خواندنی). همه به‌طور پیش‌فرض خاموش‌اند.' : 'گفتگوهای بله و جواب‌های دستیار؛ هر وقت خواستید گفتگو را خودتان بگیرید.'}</p></div></div>
    {session.isLoading ? <SkeletonPanel rows={3} /> : isAdmin ? <AdminView /> : expert ? <ExpertView />
      : <div className="bl-note off"><Info size={18} /><span>این بخش فقط برای کارشناس‌های فروش و مدیر است.</span></div>}
  </section>;
}
