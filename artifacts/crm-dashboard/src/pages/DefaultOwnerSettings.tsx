/* «قانون ثبت مشتری» + «ثبت‌شده‌ها بر اساس ثبت‌کننده» (admin only; crm-default-owner, PM 2026-10-27 22:12). Counts only — no names / phones of customers. */
import { useEffect, useState } from 'react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { gregorianToJalaliValue, jalaliValueToGregorian } from '@/lib/jalali';
import '@/features/lead-annotator/lead-annotator.css';
import './customers.css';

type Cfg = { enabled: boolean; ownerSalespersonId: number; registrarMode: 'all' | 'selected'; registrarUserIds: number[]; sourceMode: 'all' | 'selected'; sources: string[]; updatedAt?: string | null };
type Opts = { salespersons: { id: number; name: string }[]; registrars: { id: number; name: string; role: string }[]; sources: { key: string; label: string; reserved: boolean }[] };
type Src = { source: string; label: string; count: number; inferred: number };
type Ch = { channel: string | null; label: string; count: number };
type Reg = { userId: number | null; name: string; salespersonName: string | null; registered: number; reachedRegistration: number; reachedDeposit: number; bySource: Src[]; byChannel: Ch[] };
type Report = { from: string; to: string; timezone: string; totals: { registered: number; reachedRegistration: number; reachedDeposit: number; bySource: Src[]; byChannel: Ch[] }; registrars: Reg[] };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function req<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/api${p}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json' } });
  const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error((b as { error?: string }).error || `HTTP ${r.status}`); return b as T;
}
const fa = (n: number) => n.toLocaleString('fa-IR');
const tehranDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);

export default function DefaultOwnerSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null); const [saved, setSaved] = useState<Cfg | null>(null); const [opts, setOpts] = useState<Opts | null>(null);
  const [from, setFrom] = useState(tehranDay(new Date(Date.now() - 6 * 86_400_000))); const [to, setTo] = useState(tehranDay(new Date()));
  const [rep, setRep] = useState<Report | null>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { req<{ settings: Cfg; options: Opts }>('/admin/default-owner-rule').then((r) => { setCfg(r.settings); setSaved(r.settings); setOpts(r.options); }).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { req<Report>(`/admin/registered-by?from=${from}&to=${to}`).then(setRep).catch((e) => setErr((e as Error).message)); }, [from, to]);
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

      <h2 style={{ fontSize: 18, margin: '8px 0 0' }}>ثبت‌شده‌ها بر اساس ثبت‌کننده</h2>
      <div className="chips" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="smr-date"><span>از تاریخ</span><PersianDatePicker value={gregorianToJalaliValue(from)} noFuture onChange={(v) => { const g = jalaliValueToGregorian(v); if (g) setFrom(g > to ? to : g); }} testId="dor-from" /></div>
        <div className="smr-date"><span>تا تاریخ</span><PersianDatePicker value={gregorianToJalaliValue(to)} noFuture onChange={(v) => { const g = jalaliValueToGregorian(v); if (g) setTo(g < from ? from : g); }} testId="dor-to" /></div>
      </div>
      {rep ? <>
        <small>به وقت تهران · فقط شمارش (بدون نام و شماره‌ی مشتری)</small>
        <div className="dor-wrap"><table className="dor-table" data-testid="dor-report"><thead><tr><th>ثبت‌کننده</th><th>ثبت</th><th>به ثبت‌نام رسید</th><th>به ودیعه رسید</th><th>منبع ورود</th><th>کانال</th></tr></thead>
          <tbody>{rep.registrars.map((r) => <tr key={String(r.userId)}><td>{r.name}{r.salespersonName ? <small> · {r.salespersonName}</small> : null}</td>
            <td className="n" data-l="ثبت">{fa(r.registered)}</td><td className="n" data-l="ثبت‌نام">{fa(r.reachedRegistration)}</td><td className="n" data-l="ودیعه">{fa(r.reachedDeposit)}</td>
            <td className="src">{r.bySource.map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{r.byChannel.map((c) => `${c.label}: ${fa(c.count)}`).join('، ')}</td></tr>)}
            <tr><td><strong>جمع</strong></td><td className="n" data-l="ثبت"><strong>{fa(rep.totals.registered)}</strong></td><td className="n" data-l="ثبت‌نام">{fa(rep.totals.reachedRegistration)}</td><td className="n" data-l="ودیعه">{fa(rep.totals.reachedDeposit)}</td>
              <td className="src">{rep.totals.bySource.map((s) => `${s.label}: ${fa(s.count)}`).join('، ')}</td><td className="src">{rep.totals.byChannel.map((c) => `${c.label}: ${fa(c.count)}`).join('، ')}</td></tr>
          </tbody></table></div>
        {!rep.registrars.length ? <p className="muted">در این بازه مشتری‌ای ثبت نشده.</p> : null}
      </> : <p>در حال بارگذاری…</p>}
    </section>
  );
}
