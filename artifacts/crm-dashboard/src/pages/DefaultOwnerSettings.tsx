/* «قانون ثبت مشتری» + «ثبت‌شده‌ها بر اساس ثبت‌کننده» (admin only; crm-default-owner, PM 2026-10-27 22:12). Counts only — no names / phones of customers. */
import { useEffect, useState } from 'react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { gregorianToJalaliValue, jalaliValueToGregorian } from '@/lib/jalali';
import '@/features/lead-annotator/lead-annotator.css';
import './customers.css';
import '@/features/lead-intake/lead-intake.css';

type Cfg = { enabled: boolean; ownerSalespersonId: number; registrarMode: 'all' | 'selected'; registrarUserIds: number[]; sourceMode: 'all' | 'selected'; sources: string[]; updatedAt?: string | null };
type Opts = { salespersons: { id: number; name: string }[]; registrars: { id: number; name: string; role: string }[]; sources: { key: string; label: string; reserved: boolean }[] };
type Src = { source: string; label: string; count: number; inferred: number };
type Ch = { channel: string | null; label: string; count: number };
type LsC = { leadSource: string | null; label: string; count: number };
type Flg = { key: string; kind: string; name: string; flagged: number; autoCleared: number; manualCleared: number; open: number; maxPerDay: number; heavyDays: { date: string; count: number }[] };
type IntakeSettings = { defaultSourceBySeller: Record<string, string>; intakeStartedAt: string | null; leadSources: { key: string; label: string }[]; sellers: { id: number; name: string }[];
  log: { id: number; key: string; oldValue: string | null; newValue: string | null; actorUserId: number | null; via: string; createdAt: string }[] };
type Reg = { userId: number | null; name: string; salespersonName: string | null; registered: number; called: number; repeatRequests: number; byLeadSource: LsC[]; reachedRegistration: number; reachedDeposit: number; bySource: Src[]; byChannel: Ch[] };
type Report = { from: string; to: string; timezone: string; leadSources: { key: string; label: string }[]; intakeStartedAt: string | null;
  urgentByFlagger: { rows: Flg[]; totals: { flagged: number; autoCleared: number; manualCleared: number; open: number } };
  totals: { registered: number; called: number; repeatRequests: number; byLeadSource: LsC[]; reachedRegistration: number; reachedDeposit: number; bySource: Src[]; byChannel: Ch[] }; registrars: Reg[] };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function req<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${p}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json' } });
  const b = await r.json().catch(() => ({})); if (!r.ok) { const e = b as { error?: string; message?: string }; throw new Error(e.message || e.error || `HTTP ${r.status}`); } return b as T;
}
const fa = (n: number) => n.toLocaleString('fa-IR');
const tehranDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);

export default function DefaultOwnerSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null); const [saved, setSaved] = useState<Cfg | null>(null); const [opts, setOpts] = useState<Opts | null>(null);
  const [from, setFrom] = useState(tehranDay(new Date(Date.now() - 6 * 86_400_000))); const [to, setTo] = useState(tehranDay(new Date()));
  const [srcFilter, setSrcFilter] = useState('all'); const [repErr, setRepErr] = useState<string | null>(null);
  const [isx, setIsx] = useState<IntakeSettings | null>(null); const [isxDraft, setIsxDraft] = useState<Record<string, string>>({}); const [isxMsg, setIsxMsg] = useState<string | null>(null);
  const [rep, setRep] = useState<Report | null>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { req<{ settings: Cfg; options: Opts }>('/admin/default-owner-rule').then((r) => { setCfg(r.settings); setSaved(r.settings); setOpts(r.options); }).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { setRepErr(null); req<Report>(`/admin/registered-by?from=${from}&to=${to}${srcFilter !== 'all' ? `&source=${srcFilter}` : ''}`).then(setRep).catch((e) => { setRep(null); setRepErr((e as Error).message); }); }, [from, to, srcFilter]);
  useEffect(() => { req<IntakeSettings>('/lead-intake/admin/settings').then((r) => { setIsx(r); setIsxDraft(r.defaultSourceBySeller); }).catch(() => setIsx(null)); }, []);
  const saveIsx = async () => { setIsxMsg(null); try { const clean = Object.fromEntries(Object.entries(isxDraft).filter(([, v]) => v && v !== 'none'));
    const r = await req<IntakeSettings>('/lead-intake/admin/settings', { method: 'PUT', body: JSON.stringify({ defaultSourceBySeller: clean }) }); setIsx(r); setIsxDraft(r.defaultSourceBySeller); setIsxMsg('ذخیره شد.'); }
    catch (e) { setIsxMsg((e as Error).message); } };
  if (err && !cfg) return <section className="dor" dir="rtl"><div className="csx-note bad" role="alert"><p>{err}</p></div></section>;
  if (!cfg || !opts) return <section className="dor" dir="rtl"><p>در حال بارگذاری…</p></section>;
  const dirty = JSON.stringify({ ...cfg, updatedAt: null }) !== JSON.stringify({ ...saved, updatedAt: null });
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const save = async () => { setBusy(true); setErr(null); try { const r = await req<{ settings: Cfg }>('/admin/default-owner-rule', { method: 'PUT', body: JSON.stringify(cfg) }); setCfg(r.settings); setSaved(r.settings); setMsg('ذخیره شد.'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <section className="dor" dir="rtl" data-testid="page-default-owner">
      <h1 style={{ fontSize: 20, margin: 0 }}>قانون ثبت مشتری</h1>
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
      {msg ? <div className="csx-note ok" role="status"><p>{msg}</p></div> : null}
      <fieldset><legend>وضعیت</legend>
        <label><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} data-testid="dor-enabled" /> فعال: مشتری جدید به کارشناس زیر برود</label>
        <label>کارشناس مقصد: <select value={cfg.ownerSalespersonId} onChange={(e) => setCfg({ ...cfg, ownerSalespersonId: Number(e.target.value) })}>
          {opts.salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <small>ثبت‌کننده‌ی واقعی همیشه جدا ذخیره می‌شود؛ فقط کارشناس پرونده عوض می‌شود.</small>
      </fieldset>
      <fieldset><legend>ثبت‌کننده‌ها</legend>
        <div className="chips"><label><input type="radio" checked={cfg.registrarMode === 'all'} onChange={() => setCfg({ ...cfg, registrarMode: 'all' })} /> همه</label>
          <label><input type="radio" checked={cfg.registrarMode === 'selected'} onChange={() => setCfg({ ...cfg, registrarMode: 'selected' })} /> فقط انتخاب‌شده‌ها</label></div>
        {cfg.registrarMode === 'selected' ? <div className="chips">{opts.registrars.map((u) => <label key={u.id}><input type="checkbox" checked={cfg.registrarUserIds.includes(u.id)} onChange={() => setCfg({ ...cfg, registrarUserIds: toggleIn(cfg.registrarUserIds, u.id) })} /> {u.name}</label>)}</div> : null}
      </fieldset>
      <fieldset><legend>منبع ورود</legend>
        <div className="chips"><label><input type="radio" checked={cfg.sourceMode === 'all'} onChange={() => setCfg({ ...cfg, sourceMode: 'all' })} /> همه</label>
          <label><input type="radio" checked={cfg.sourceMode === 'selected'} onChange={() => setCfg({ ...cfg, sourceMode: 'selected' })} /> فقط انتخاب‌شده‌ها</label></div>
        {cfg.sourceMode === 'selected' ? <div className="chips">{opts.sources.map((s) => <label key={s.key}><input type="checkbox" checked={cfg.sources.includes(s.key)} onChange={() => setCfg({ ...cfg, sources: toggleIn(cfg.sources, s.key) })} /> {s.label}</label>)}</div> : null}
      </fieldset>
      <div><button type="button" disabled={!dirty || busy} onClick={() => void save()} data-testid="dor-save">ذخیره</button></div>

      {isx ? <fieldset data-testid="li-settings"><legend>منبع پیش‌فرض فرم ثبت (بر اساس کارشناس ثبت‌کننده)</legend>
        <small>وقتی این کارشناس مشتری ثبت می‌کند، این منبع از اول انتخاب شده است؛ ثبت‌کننده می‌تواند عوضش کند.</small>
        {isx.sellers.map((sp) => <label key={sp.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{sp.name}
          <select value={isxDraft[String(sp.id)] ?? 'none'} onChange={(e) => setIsxDraft({ ...isxDraft, [String(sp.id)]: e.target.value })} data-testid={`li-set-${sp.id}`}>
            <option value="none">بدون پیش‌فرض</option>{isx.leadSources.filter((x) => x.key !== 'none').map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>)}
        <div><button type="button" onClick={() => void saveIsx()} disabled={JSON.stringify(isxDraft) === JSON.stringify(isx.defaultSourceBySeller)} data-testid="li-set-save">ذخیره منبع پیش‌فرض</button></div>
        {isxMsg ? <small role="status">{isxMsg}</small> : null}
        {isx.log.length ? <details><summary>تاریخچه تغییر ({fa(isx.log.length)})</summary><ul>{isx.log.map((l) => <li key={l.id}><bdi dir="ltr">{l.newValue}</bdi> · {l.via}{l.actorUserId ? ` · کاربر ${fa(l.actorUserId)}` : ''} · {new Date(l.createdAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}</li>)}</ul></details> : null}
      </fieldset> : null}

      <h2 style={{ fontSize: 18, margin: '8px 0 0' }}>ثبت‌شده‌ها بر اساس ثبت‌کننده</h2>
      <div className="chips" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="smr-date"><span>از تاریخ</span><PersianDatePicker value={gregorianToJalaliValue(from)} noFuture onChange={(v) => { const g = jalaliValueToGregorian(v); if (g) setFrom(g > to ? to : g); }} testId="dor-from" /></div>
        <label className="smr-date"><span>منبع مشتری</span><select value={srcFilter} onChange={(e) => setSrcFilter(e.target.value)} data-testid="dor-source-filter">
          <option value="all">همه</option>{(rep?.leadSources ?? []).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
        <div className="smr-date"><span>تا تاریخ</span><PersianDatePicker value={gregorianToJalaliValue(to)} noFuture onChange={(v) => { const g = jalaliValueToGregorian(v); if (g) setTo(g < from ? from : g); }} testId="dor-to" /></div>
      </div>
      {repErr ? <div className="csx-note warn" role="alert" data-testid="dor-report-err"><p>{repErr}</p></div> : null}
      {rep ? <>
        <small>به وقت تهران · فقط شمارش (بدون نام و شماره‌ی مشتری)</small>
        <div className="dor-wrap"><table className="dor-table" data-testid="dor-report"><thead><tr><th>ثبت‌کننده</th><th>ثبت</th><th>تماس CRM</th><th>درخواست دوباره</th><th>به ثبت‌نام رسید</th><th>به ودیعه رسید</th><th>منبع مشتری</th><th>منبع ورود</th><th>کانال</th></tr></thead>
          <tbody>{rep.registrars.map((r) => <tr key={String(r.userId)}><td>{r.name}{r.salespersonName ? <small> · {r.salespersonName}</small> : null}</td>
            <td className="n" data-l="ثبت">{fa(r.registered)}</td><td className="n" data-l="تماس CRM">{fa(r.called ?? 0)}</td><td className="n" data-l="درخواست دوباره">{fa(r.repeatRequests ?? 0)}</td><td className="n" data-l="ثبت‌نام">{fa(r.reachedRegistration)}</td><td className="n" data-l="ودیعه">{fa(r.reachedDeposit)}</td>
            <td className="src">{(r.byLeadSource ?? []).map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{r.bySource.map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{r.byChannel.map((c) => `${c.label}: ${fa(c.count)}`).join('، ')}</td></tr>)}
            <tr><td><strong>جمع</strong></td><td className="n" data-l="ثبت"><strong>{fa(rep.totals.registered)}</strong></td><td className="n" data-l="تماس CRM">{fa(rep.totals.called ?? 0)}</td><td className="n" data-l="درخواست دوباره">{fa(rep.totals.repeatRequests ?? 0)}</td><td className="n" data-l="ثبت‌نام">{fa(rep.totals.reachedRegistration)}</td><td className="n" data-l="ودیعه">{fa(rep.totals.reachedDeposit)}</td>
              <td className="src">{(rep.totals.byLeadSource ?? []).map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{rep.totals.bySource.map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{rep.totals.byChannel.map((c) => `${c.label}: ${fa(c.count)}`).join('، ')}</td></tr>
          </tbody></table></div>
        {!rep.registrars.length ? <p className="muted">در این بازه مشتری‌ای ثبت نشده.</p> : null}
        <small>«درخواست دوباره» = شماره‌ی تکراری؛ پرونده‌ی تازه ساخته نمی‌شود و در «ثبت» حساب نمی‌شود.</small>
        <h3 style={{ fontSize: 16, margin: '8px 0 0' }}>علامت فوری بر اساس علامت‌زننده</h3>
        <div className="dor-wrap"><table className="dor-table" data-testid="dor-urgent"><thead><tr><th>علامت‌زننده</th><th>علامت</th><th>برداشته با تماس CRM</th><th>برداشته دستی</th><th>هنوز باز</th><th>روزهای پر</th></tr></thead>
          <tbody>{rep.urgentByFlagger.rows.map((f) => <tr key={f.key}><td>{f.name}</td><td className="n" data-l="علامت">{fa(f.flagged)}</td><td className="n" data-l="خودکار">{fa(f.autoCleared)}</td>
            <td className="n" data-l="دستی">{fa(f.manualCleared)}</td><td className="n" data-l="باز">{fa(f.open)}</td><td className="src">{f.heavyDays.map((d) => `${new Date(`${d.date}T12:00:00Z`).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })}: ${fa(d.count)} علامت`).join('، ')}</td></tr>)}
            <tr><td><strong>جمع</strong></td><td className="n"><strong>{fa(rep.urgentByFlagger.totals.flagged)}</strong></td><td className="n">{fa(rep.urgentByFlagger.totals.autoCleared)}</td><td className="n">{fa(rep.urgentByFlagger.totals.manualCleared)}</td><td className="n">{fa(rep.urgentByFlagger.totals.open)}</td><td /></tr>
          </tbody></table></div>
      </> : <p>در حال بارگذاری…</p>}
    </section>
  );
}
