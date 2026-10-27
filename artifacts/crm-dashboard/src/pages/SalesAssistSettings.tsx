/* «تنظیمات دستیار فروش» (admin only) — Armita's a_set / a_chg / a_reset. Levels 0–10 per signal (5 = default points, 0 = ignored,
   10 = double). Site lead and «از کاظمی» are fixed tiers (PM rule: always on top), so they are shown but not editable. */
import { Minus, Plus, RotateCcw, Save, ShieldCheck, ArrowUp, ArrowDown, Lock } from 'lucide-react';
import { useCqConfig } from '@/features/call-queue/api';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchWeights, faNum, previewWeights, saName, saveWeights, type SaPreviewItem, type SaSettings, type SaWeights } from '@/features/sales-assist/api';
import '@/features/sales-assist/sales-assist.css';
import './customers.css';

const hoursLabel = (h: number, def: number) => (h === 0 ? 'تا فردا صبح' : `${faNum(h)} ساعت`) + (h === def ? ' (پیش‌فرض)' : '');

export default function SalesAssistSettings() {
  const hideNotNow = Boolean(useCqConfig().data?.flags.hide_not_now);
  const qc = useQueryClient();
  const [w, setW] = useState<SaWeights | null>(null);
  const [draft, setDraft] = useState<SaSettings | null>(null);
  const [sp, setSp] = useState<number | null>(null);
  const [prev, setPrev] = useState<SaPreviewItem[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [p1, setP1] = useState<{ quota: number; redDays: number } | null>(null);
  useEffect(() => { fetchWeights().then((r) => { setW(r); setDraft(structuredClone(r.settings)); setP1(r.p1 ? { quota: r.p1.quota, redDays: r.p1.redDays } : null); setSp(r.previewable[0]?.id ?? null); }).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => {
    if (!draft || !sp) return;
    const t = window.setTimeout(() => { previewWeights(sp, draft.levels).then((r) => setPrev(r.items)).catch(() => setPrev(null)); }, 250);
    return () => window.clearTimeout(t);
  }, [draft, sp]);
  useEffect(() => { if (!msg) return; const t = window.setTimeout(() => setMsg(null), 5000); return () => window.clearTimeout(t); }, [msg]);
  const changes = useMemo(() => {
    if (!w || !draft) return 0;
    return Object.keys(draft.levels).filter((k) => draft.levels[k] !== w.settings.levels[k]).length + (draft.snoozeHours !== w.settings.snoozeHours ? 1 : 0)
      + (p1 && w.p1 ? (p1.quota !== w.p1.quota ? 1 : 0) + (p1.redDays !== w.p1.redDays ? 1 : 0) : 0);
  }, [w, draft, p1]);
  if (err && !w) return <section className="csx" dir="rtl"><div className="csx-note bad" role="alert"><p>{err}</p></div></section>;
  if (!w || !draft) return <section className="csx" dir="rtl"><p>در حال بارگذاری…</p></section>;
  const set = (k: string, v: number) => setDraft({ ...draft, levels: { ...draft.levels, [k]: Math.max(0, Math.min(10, v)) } });
  const save = async () => {
    setBusy(true); setErr(null);
    try { const r = await saveWeights({ ...draft, ...(p1 ? { p1 } : {}) }); setW({ ...w, settings: r.settings, ...(r.p1 ? { p1: r.p1 } : {}) }); if (r.p1) setP1({ quota: r.p1.quota, redDays: r.p1.redDays }); setDraft(structuredClone(r.settings)); setMsg('ذخیره شد'); void qc.invalidateQueries({ queryKey: ['sales-assist'] }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const allDefault = Object.keys(draft.levels).every((k) => draft.levels[k] === w.defaults.levels[k]) && draft.snoozeHours === w.defaults.snoozeHours
    && (!p1 || !w.p1Defaults || (p1.quota === w.p1Defaults.quota && p1.redDays === w.p1Defaults.redDays));
  return <section className="csx sa-set" dir="rtl" data-testid="page-sales-assist-settings">
    <div className="sa-set-h"><h1>تنظیمات دستیار فروش <span className="sa-badge"><ShieldCheck size={15} /> فقط مدیر</span></h1>
      <button type="button" className="csx-ghost" onClick={() => { setDraft(structuredClone(w.defaults)); if (w.p1Defaults) setP1({ ...w.p1Defaults }); setMsg('وزن‌ها به پیش‌فرض برگشت؛ برای اعمال، ذخیره کنید'); }} data-testid="sa-reset"><RotateCcw size={17} /> بازگشت به پیش‌فرض</button></div>
    <p className="sa-help">وزن هر نشانه (۰ تا ۱۰) تعیین می‌کند چه کسی در «پیشنهاد دستیار فروش» بالاتر بیاید. ۰ یعنی آن نشانه حساب نمی‌شود. برای همه‌ی کارشناسان یکسان است.</p>
    <div className="sa-set-g">
      <div className="sa-sigs">
        <div className="sa-sig locked"><div><b>سرنخ سایت</b><small>سرنخ‌های سایت در مهلت، همیشه اول</small></div><span className="sa-lock"><Lock size={15} /> همیشه اول</span></div>
        <div className="sa-sig locked"><div><b>از کاظمی</b><small>تا اولین تماس، بعد از سرنخ‌های سایت</small></div><span className="sa-lock"><Lock size={15} /> بعد از سرنخ سایت</span></div>
        {w.signals.map((s) => { const v = draft.levels[s.key]; const changed = v !== s.default;
          return <div key={s.key} className={`sa-sig${changed ? ' chg' : ''}`} data-testid={`sa-sig-${s.key}`}>
            <div><b>{s.label}</b><small>{s.help}</small>{changed ? <span className="sa-def">پیش‌فرض {faNum(s.default)}</span> : null}
              <div className="sa-bar" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < v ? 'on' : ''} />)}</div></div>
            <div className="sa-step"><button type="button" onClick={() => set(s.key, v - 1)} disabled={v <= 0} aria-label={`کم کردن ${s.label}`}><Minus size={18} /></button>
              <output aria-live="polite">{faNum(v)}</output>
              <button type="button" onClick={() => set(s.key, v + 1)} disabled={v >= 10} aria-label={`زیاد کردن ${s.label}`}><Plus size={18} /></button></div>
          </div>; })}
{hideNotNow ? null : <><div className="sa-sig sa-snz"><div><b>بعد از «الان نه»، مشتری تا کی پنهان بماند؟</b><small>«تا فردا صبح» یعنی تا ساعت ۹ صبح بعد</small></div>
          <div className="sa-seg" role="radiogroup">{w.snoozeOptions.map((h) => <button key={h} type="button" role="radio" aria-checked={draft.snoozeHours === h} className={draft.snoozeHours === h ? 'on' : ''} onClick={() => setDraft({ ...draft, snoozeHours: h })}>{hoursLabel(h, w.defaults.snoozeHours)}</button>)}</div></div></>}
        {p1 && w.p1 && w.p1Limits ? <>{/* Task B: today's P1 quota (oldest first) and the red threshold. «بی‌تماس» = the manager report's rule (more than N days). */}
          <div className="sa-sig" data-testid="sa-p1-quota"><div><b>سهمیه‌ی روزانه‌ی اولویت ۱ بی‌تماس</b><small>هر روز این تعداد از قدیمی‌ترین مشتری‌های اولویت ۱ که بیش از {faNum(w.p1.noCallDays)} روز تماس نگرفته‌اند، بعد از یادآورهای گذشته بالا می‌آیند. ۰ یعنی خاموش.</small></div>
            <div className="sa-step"><button type="button" onClick={() => setP1({ ...p1, quota: Math.max(w.p1Limits!.quota[0], p1.quota - 1) })} disabled={p1.quota <= w.p1Limits.quota[0]} aria-label="کم کردن سهمیه"><Minus size={18} /></button>
              <output aria-live="polite">{faNum(p1.quota)}</output>
              <button type="button" onClick={() => setP1({ ...p1, quota: Math.min(w.p1Limits!.quota[1], p1.quota + 1) })} disabled={p1.quota >= w.p1Limits.quota[1]} aria-label="زیاد کردن سهمیه"><Plus size={18} /></button></div></div>
          <div className="sa-sig" data-testid="sa-p1-red"><div><b>برچسب قرمز بعد از چند روز بی‌تماس؟</b><small>بیش از این تعداد روز: برچسب قرمز و اول سهمیه</small></div>
            <div className="sa-step"><button type="button" onClick={() => setP1({ ...p1, redDays: Math.max(w.p1Limits!.redDays[0], p1.redDays - 1) })} disabled={p1.redDays <= w.p1Limits.redDays[0]} aria-label="کم کردن روز"><Minus size={18} /></button>
              <output aria-live="polite">{faNum(p1.redDays)}</output>
              <button type="button" onClick={() => setP1({ ...p1, redDays: Math.min(w.p1Limits!.redDays[1], p1.redDays + 1) })} disabled={p1.redDays >= w.p1Limits.redDays[1]} aria-label="زیاد کردن روز"><Plus size={18} /></button></div></div></> : null}
      </div>
      <div className="sa-prev"><div className="sa-prev-h"><b>پیش‌نمایش ترتیب</b>
        <select className="sa-sel" value={sp ?? ''} onChange={(e) => setSp(Number(e.target.value))} aria-label="کارشناس">{w.previewable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        {prev ? <ol>{prev.map((it) => <li key={it.customerId} className={it.rank === 4 ? 'cut' : ''}>
          {it.rank === 4 ? <span className="sa-cut">این ۳ نفر در باکس دیده می‌شوند</span> : null}
          <span className="rk">{faNum(it.rank)}</span><span className="nm">{saName(it)}</span>
          <span className="pt">{it.tier === 3 ? 'سرنخ سایت' : it.tier === 2 ? 'از کاظمی' : faNum(Math.round(it.points))}</span>
          {it.was && it.was !== it.rank ? <span className={`mv ${it.was > it.rank ? 'up' : 'dn'}`}>{it.was > it.rank ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{faNum(Math.abs(it.was - it.rank))}</span> : null}
          <small>{it.signals.join(' · ')}</small></li>)}</ol> : <p className="sa-help">…</p>}
      </div>
    </div>
    {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
    <div className="sa-foot"><span>{changes ? `${faNum(changes)} تغییر ذخیره نشده` : allDefault ? 'همه‌ی وزن‌ها روی پیش‌فرض است' : 'تغییری ذخیره نشده نیست'}</span>
      <button type="button" className="csx-ghost" disabled={!changes} onClick={() => { setDraft(structuredClone(w.settings)); if (w.p1) setP1({ quota: w.p1.quota, redDays: w.p1.redDays }); }}>انصراف</button>
      <button type="button" className="csx-primary" disabled={!changes || busy} onClick={() => { void save(); }} data-testid="sa-save"><Save size={17} /> ذخیره</button></div>
    {msg ? <div className="ts-toast ok sa-toast" role="status">{msg}</div> : null}
  </section>;
}
