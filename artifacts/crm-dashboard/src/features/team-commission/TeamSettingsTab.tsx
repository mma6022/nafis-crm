import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CalendarDays, Check, Coins, Gift, History, Layers, Lock, Power, Star, Users } from 'lucide-react';
import { fa, faDateTime, jalaliLabel, latin, pct, tcApi, tm, TeamCommissionApiError, type TeamSettings, type TeamSettingsPayload } from './api';
import './team-commission.css';

type Form = Omit<TeamSettings, 'teamSplit'> & { teamSplit: Array<{ salespersonId: number; percent: string }> };
const SAMPLE = 300_000_000n;
const bpsOf = (p: string): number | null => {
  const s = latin(p).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(Number(s) * 100);
  return v >= 0 && v <= 10000 ? v : null;
};
const amountOk = (v: string) => /^\d{1,20}$/.test(latin(v)) && BigInt(latin(v)) > 0n;
const groupDigits = (v: string) => { const d = latin(v).replace(/\D/g, ''); return d ? fa(BigInt(d).toLocaleString('en-US')).replace(/,/g, '٬') : ''; };
const faPct = (p: string) => `${fa(String(Number(latin(p))))}٪`;
const of = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10000n;
const short = (n: bigint) => (n >= 1_000_000_000n ? `${fa((Number(n) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 }))} میلیارد` : `${fa((Number(n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 }))} میلیون`);

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {};
  const P = 'عدد باید بین ۰ تا ۱۰۰ باشد (حداکثر دو رقم اعشار).';
  for (const k of ['p1FirstCallPercent', 'p1UpgradePercent', 'teamBonusPercent'] as const) if (bpsOf(f[k]) == null) e[k] = P;
  for (const k of ['dataAccuracyBonusToman', 'teamBonusThresholdToman'] as const) if (!amountOk(f[k])) e[k] = 'مبلغ باید عددی مثبت به تومان باشد.';
  if (!/^1[45]\d\d[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])$/.test(latin(f.modelStartDate))) e.modelStartDate = 'تاریخ شمسی نامعتبر است (مثل ۱۴۰۵/۰۸/۰۲).';
  const parts = f.teamSplit.map((t) => bpsOf(t.percent));
  if (parts.some((p) => p == null)) e.teamSplit = P;
  else { const sum = parts.reduce<number>((a, b) => a + (b ?? 0), 0); if (sum !== 10000) e.teamSplit = `جمع سهم‌ها باید ۱۰۰٪ باشد؛ الان ${fa(String(sum / 100))}٪ است.`; }
  return e;
}
const LABELS: Record<string, string> = {
  enabled: 'مدل فروش تیمی', basis: 'مبنای درصدها', postingMoment: 'زمان ثبت پورسانت', modelStartDate: 'تاریخ شروع مدل',
  p1FirstCallPercent: 'سهم P1 تماس اول', p1UpgradePercent: 'سهم P1 از راه ارتقا', dataAccuracyBonusToman: 'پاداش درستی داده',
  teamBonusEnabled: 'پاداش تیمی ماهانه', teamBonusPercent: 'درصد پاداش تیمی', teamBonusThresholdToman: 'آستانه‌ی پاداش تیمی', teamBonusBasis: 'مبنای پاداش تیمی', teamSplit: 'تقسیم پاداش تیمی',
};
function show(k: string, f: Form, names: Map<number, string>): string {
  const v = (f as any)[k];
  if (k === 'enabled' || k === 'teamBonusEnabled') return v ? 'روشن' : 'خاموش';
  if (k === 'basis') return v === 'deposit' ? 'مبلغ واریزی' : 'مبنای قبلی';
  if (k === 'postingMoment') return v === 'payment_paid' ? 'پرداخت‌شده' : 'تأیید نهایی';
  if (k === 'teamBonusBasis') return v === 'total' ? 'کل فروش' : 'مازاد آستانه';
  if (k === 'modelStartDate') return jalaliLabel(latin(v).replace(/\//g, '-'));
  if (k.endsWith('Toman')) return tm(latin(v));
  if (k === 'teamSplit') return f.teamSplit.map((t) => `${names.get(t.salespersonId) ?? `#${t.salespersonId}`} ${faPct(t.percent)}`).join(' / ');
  return faPct(v);
}
const norm = (f: Form) => JSON.stringify({ ...f, modelStartDate: latin(f.modelStartDate).replace(/\//g, '-'), teamSplit: f.teamSplit.map((t) => ({ ...t, percent: String(bpsOf(t.percent)) })),
  p1FirstCallPercent: String(bpsOf(f.p1FirstCallPercent)), p1UpgradePercent: String(bpsOf(f.p1UpgradePercent)), teamBonusPercent: String(bpsOf(f.teamBonusPercent)),
  dataAccuracyBonusToman: latin(f.dataAccuracyBonusToman), teamBonusThresholdToman: latin(f.teamBonusThresholdToman) });
const changedKeys = (a: Form, b: Form) => Object.keys(LABELS).filter((k) => JSON.stringify((JSON.parse(norm(a)) as any)[k]) !== JSON.stringify((JSON.parse(norm(b)) as any)[k]));

/** Admin tab «مدل فروش تیمی» on /sales-commissions (approved design crm-commission 10-15). Settings are versioned; posted rows never change. */
export function TeamSettingsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['team-commission-settings'], queryFn: tcApi.settings, staleTime: 0 });
  const [f, setF] = useState<Form | null>(null);
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<{ msg: string; fields: Record<string, string> } | null>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { if (q.data && !f) setF(q.data.settings); }, [q.data, f]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 6000); return () => window.clearTimeout(t); }, [toast]);
  const names = useMemo(() => new Map((q.data?.members ?? []).map((m) => [m.salespersonId, m.name])), [q.data]);
  if (q.isLoading || (!f && !q.isError)) return <div className="tc tc-sec" aria-busy="true"><p className="tc-muted">در حال بارگذاری تنظیمات…</p></div>;
  if (q.isError || !q.data || !f) return <div className="tc tc-sec"><div className="tc-errbox" role="alert"><AlertCircle size={18} /> {q.error instanceof Error ? q.error.message : 'تنظیمات خوانده نشد.'}</div><button type="button" className="tc-ghost sm" onClick={() => q.refetch()}>تلاش دوباره</button></div>;
  const data: TeamSettingsPayload = q.data;
  const local = validate(f);
  const errs: Record<string, string> = tried ? { ...local, ...(serverErr?.fields ?? {}) } : serverErr?.fields ?? {};
  const changes = changedKeys(data.settings, f);
  const errCount = Object.keys(errs).length;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF({ ...f, [k]: v }); if (serverErr?.fields[k as string]) setServerErr({ ...serverErr, fields: Object.fromEntries(Object.entries(serverErr.fields).filter(([x]) => x !== k)) }); };
  const startSave = () => { setTried(true); if (Object.keys(local).length || !changes.length) return; setConfirm(true); };
  const save = async () => {
    setBusy(true); setServerErr(null);
    try {
      const body: Partial<TeamSettings> = { ...f, modelStartDate: latin(f.modelStartDate).replace(/\//g, '-'), p1FirstCallPercent: latin(f.p1FirstCallPercent), p1UpgradePercent: latin(f.p1UpgradePercent),
        teamBonusPercent: latin(f.teamBonusPercent), dataAccuracyBonusToman: latin(f.dataAccuracyBonusToman), teamBonusThresholdToman: latin(f.teamBonusThresholdToman),
        teamSplit: f.teamSplit.map((t) => ({ salespersonId: t.salespersonId, percent: latin(t.percent) })) };
      const next = await tcApi.saveSettings(body);
      qc.setQueryData(['team-commission-settings'], next);
      setF(next.settings); setTried(false); setConfirm(false);
      setToast(`تنظیمات ذخیره شد · نسخه‌ی ${fa(next.versionId ?? 0)}`);
    } catch (e) {
      setConfirm(false);
      setServerErr({ msg: e instanceof TeamCommissionApiError ? e.message : 'ذخیره نشد.', fields: e instanceof TeamCommissionApiError ? e.errors : {} });
    } finally { setBusy(false); }
  };
  const field = (id: keyof Form, label: string, unit: string, opts: { help?: ReactNode; ex?: ReactNode; amount?: boolean } = {}) => <div className="tc-sf">
    <label className="tc-lbl" htmlFor={`tc-${id}`}>{label}</label>
    <div className="tc-unit"><input id={`tc-${id}`} className="tc-inp" inputMode={opts.amount ? 'numeric' : 'decimal'} value={opts.amount ? groupDigits(String(f[id])) : fa(String(f[id]))}
      onChange={(e) => set(id, (opts.amount ? latin(e.target.value).replace(/\D/g, '') : latin(e.target.value).replace(/[^\d.]/g, '')) as never)}
      aria-invalid={errs[id] ? true : undefined} aria-describedby={errs[id] ? `tc-${id}-e` : undefined} data-testid={`tc-set-${id}`} /><span className="u">{unit}</span></div>
    {errs[id] ? <p className="tc-ferr" id={`tc-${id}-e`} role="alert"><AlertCircle size={16} /> {errs[id]}</p> : null}
    {opts.help ? <span className="help">{opts.help}</span> : null}
    {opts.ex && !errs[id] ? <span className="tc-ex">{opts.ex}</span> : null}
  </div>;
  const seg = (k: 'basis' | 'postingMoment' | 'teamBonusBasis', label: string, options: [string, string][], help?: string) => <div className="tc-sf">
    <span className="tc-lbl" id={`tc-${k}-l`}>{label}</span>
    <div className="tc-seg" role="radiogroup" aria-labelledby={`tc-${k}-l`}>{options.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={f[k] === v} onClick={() => set(k, v as never)} data-testid={`tc-set-${k}-${v}`}>{t}</button>)}</div>
    {help ? <span className="help">{help}</span> : null}
  </div>;
  const p1a = bpsOf(f.p1FirstCallPercent), p1b = bpsOf(f.p1UpgradePercent), tb = bpsOf(f.teamBonusPercent);
  const thr = amountOk(f.teamBonusThresholdToman) ? BigInt(latin(f.teamBonusThresholdToman)) : 0n;
  const sample12 = 12_000_000_000n;
  const teamEx = tb != null ? of(f.teamBonusBasis === 'total' ? sample12 : sample12 - thr > 0n ? sample12 - thr : 0n, tb) : 0n;
  const splitEx = f.teamSplit.map((t) => short(of(teamEx, bpsOf(t.percent) ?? 0))).join(' / ');

  const secMaster = <section className="tc-sec" data-testid="tc-sec-master">
    <div className="tc-tg"><div className="tt"><b><Power size={18} /> مدل فروش تیمی</b><span className="tc-muted">{f.enabled ? 'روشن' : 'خاموش · پیش‌فرض'}</span></div>
      <button type="button" className="tc-sw" role="switch" aria-checked={f.enabled} aria-label="مدل فروش تیمی" onClick={() => set('enabled', !f.enabled)} data-testid="tc-set-enabled" /></div>
    {!f.enabled ? <div className="tc-offbox">خاموش است: پورسانت همه همان مدل قبلی (پلکانی، هنگام تأیید نهایی) حساب می‌شود و کارت «درستی اطلاعات تماس اول» نمایش داده نمی‌شود.</div> : null}
    {seg('basis', 'مبنای همه‌ی درصدها', [['deposit', 'مبلغ واریزی به مشتری (دستور پرداخت)'], ['legacy_base', 'مبنای قبلی پورسانت']])}
    {seg('postingMoment', 'زمان ثبت پورسانت', [['payment_paid', 'وقتی دستور پرداخت «پرداخت‌شده» شود'], ['final_approval', 'هنگام تأیید نهایی ثبت‌کننده']], 'اگر پرونده بعد از ثبت برگردد، پورسانت‌های درصدی ماه بعد از همه‌ی دریافت‌کننده‌ها کسر می‌شود.')}
  </section>;
  const secP1 = <section className="tc-sec">
    <header><h2><Star size={20} /> سهم معرفی P1 ({names.get(data.members.find((m) => m.role === 'qualifier')?.salespersonId ?? 0) ?? 'کارشناس تماس اول'})</h2></header>
    {field('p1FirstCallPercent', 'مشتری P1 در تماس اول', '٪', { ex: p1a != null ? `نمونه: واریز ۳۰۰ میلیون ← ${tm(of(SAMPLE, p1a))}` : null })}
    {field('p1UpgradePercent', 'مشتری P1 از راه ارتقا', '٪', { ex: p1b != null ? `نمونه: واریز ۳۰۰ میلیون ← ${tm(of(SAMPLE, p1b))}` : null })}
    <span className="tc-help">فقط یکی از این دو برای هر پرونده. در پله‌ی خود کارشناس تماس اول حساب نمی‌شود و از سهم کارشناس پیگیری کم نمی‌شود.</span>
  </section>;
  const secB = <section className="tc-sec"><header><h2><Gift size={20} /> پاداش درستی داده</h2></header>
    {field('dataAccuracyBonusToman', 'مبلغ ثابت برای هر «اطلاعات درست بود»', 'تومان', { amount: true, help: 'وقتی کارشناس پیگیری «اطلاعات درست بود» را ثبت کند؛ به واریز وابسته نیست و بابت برگشت پرونده کسر نمی‌شود.' })}
  </section>;
  const secT = <section className="tc-sec" data-testid="tc-sec-team">
    <div className="tc-tg"><div className="tt"><b><Users size={18} /> پاداش تیمی ماهانه</b><span className="tc-muted">{f.teamBonusEnabled ? 'روشن' : 'خاموش · پیش‌فرض'}</span></div>
      <button type="button" className="tc-sw" role="switch" aria-checked={f.teamBonusEnabled} aria-label="پاداش تیمی ماهانه" onClick={() => set('teamBonusEnabled', !f.teamBonusEnabled)} data-testid="tc-set-teamBonusEnabled" /></div>
    {f.teamBonusEnabled ? <>
      {field('teamBonusPercent', 'درصد از فروش ماهانه‌ی تیم', '٪')}
      {field('teamBonusThresholdToman', 'وقتی فروش تیم بالای این مبلغ باشد', 'تومان', { amount: true, help: thr ? `یعنی ${short(thr)} تومان در یک ماه شمسی` : undefined })}
      {seg('teamBonusBasis', 'درصد از کدام مبلغ؟', [['total', 'کل فروش ماه'], ['above_threshold', 'فقط مبلغ بالای آستانه']])}
      <div className="tc-sf"><span className="tc-lbl">تقسیم بین کارشناس‌ها</span>
        <div className="tc-split">{f.teamSplit.map((t, i) => <div key={t.salespersonId}><small>{names.get(t.salespersonId) ?? `#${t.salespersonId}`}</small>
          <div className="tc-unit"><input className="tc-inp" inputMode="decimal" value={fa(t.percent)} aria-invalid={errs.teamSplit ? true : undefined} aria-label={`سهم ${names.get(t.salespersonId) ?? ''}`}
            onChange={(e) => set('teamSplit', f.teamSplit.map((x, j) => (j === i ? { ...x, percent: latin(e.target.value).replace(/[^\d.]/g, '') } : x)))} data-testid={`tc-set-split-${t.salespersonId}`} /><span className="u">٪</span></div></div>)}</div>
        {errs.teamSplit ? <p className="tc-ferr" role="alert" data-testid="tc-split-error"><AlertCircle size={16} /> {errs.teamSplit}</p> : <span className="tc-ex">نمونه: فروش ماه ۱۲ میلیارد ← {short(teamEx)} تومان؛ {splitEx} تومان</span>}
      </div>
    </> : <div className="tc-offbox">خاموش است و هیچ پاداش تیمی حساب نمی‌شود. با روشن‌کردن: {pct(tb ?? 0)} فروش تیم بالای {short(thr)} تومان، تقسیم {f.teamSplit.map((t) => fa(String(Number(latin(t.percent))))).join('/')}.</div>}
  </section>;
  const secD = <section className="tc-sec"><header><h2><CalendarDays size={20} /> تاریخ شروع مدل</h2></header>
    <div className="tc-sf"><label className="tc-lbl" htmlFor="tc-modelStartDate">از این تاریخ اعمال می‌شود (شمسی)</label>
      <input id="tc-modelStartDate" className="tc-inp" dir="ltr" style={{ textAlign: 'left' }} value={fa(f.modelStartDate.replace(/-/g, '/'))} onChange={(e) => set('modelStartDate', latin(e.target.value).replace(/[^\d/-]/g, ''))}
        aria-invalid={errs.modelStartDate ? true : undefined} data-testid="tc-set-modelStartDate" />
      {errs.modelStartDate ? <p className="tc-ferr" role="alert"><AlertCircle size={16} /> {errs.modelStartDate}</p> : <span className="help">{jalaliLabel(latin(f.modelStartDate).replace(/\//g, '-'))} — فقط فروش‌هایی که از این تاریخ به بعد ثبت می‌شوند. پورسانت‌های قبلی دست نمی‌خورند.</span>}
    </div></section>;
  const secR = <section className="tc-sec"><header><h2><Layers size={20} /> نرخ پلکانی کارشناس‌ها</h2><span className="tc-rotag"><Lock size={14} /> بدون تغییر</span></header>
    <div style={{ overflowX: 'auto' }}><table className="tc-ro"><thead><tr><th>کارشناس</th><th>زیر پله ۱</th><th>پله ۱</th><th>پله ۲</th><th>پله ۳</th></tr></thead><tbody>
      {data.members.map((m) => <tr key={m.salespersonId}><td><b>{m.name}</b></td>{m.tiers ? [m.tiers.rate0Bps, m.tiers.rate1Bps, m.tiers.rate2Bps, m.tiers.rate3Bps].map((r, i) => <td key={i}>{pct(r)}</td>) : <td colSpan={4} className="tc-muted">تنظیم نشده</td>}</tr>)}
    </tbody></table></div>
    <span className="tc-help">کارشناس پیگیری همان نرخ پله‌ی خودش را می‌گیرد و فروش در پله‌ی خودش حساب می‌شود. این صفحه نرخ‌ها را تغییر نمی‌دهد؛ از تب «دفتر و گزارش» ویرایش کنید.</span>
  </section>;
  const secV = <section className="tc-sec" data-testid="tc-sec-versions"><header><h2><History size={20} /> نسخه‌های تنظیمات</h2></header>
    {data.versions.length ? <ul className="tc-vers">{data.versions.slice(0, 6).map((v) => <li key={v.versionId}><span>نسخه‌ی {fa(v.versionId)}{v.versionId === data.versionId ? ' · فعلی' : ''}</span><span className="tc-muted">{v.createdByName ?? '—'} · {faDateTime(v.effectiveAt ?? v.createdAt)}</span></li>)}</ul>
      : <p className="tc-muted">هنوز ذخیره نشده؛ مقادیر پیش‌فرض نمایش داده می‌شود.</p>}
    <span className="tc-help">هر پورسانت با نسخه‌ی تنظیمات زمان ثبتش ذخیره می‌شود؛ تغییر تنظیمات ردیف‌های ثبت‌شده را دوباره حساب نمی‌کند.</span></section>;

  return <div className="tc" data-testid="tc-settings" style={{ paddingBottom: changes.length || errCount ? 140 : 0 }}>
    <div className="tc-base" style={{ marginBottom: 16 }}><Coins size={20} /><span>مبنای همه‌ی درصدها {f.basis === 'deposit' ? 'مبلغ واریزی به مشتری (مبلغ دستور پرداخت)' : 'مبنای قبلی پورسانت'} است.</span></div>
    {serverErr?.msg && !confirm ? <div className="tc-errbox" role="alert" style={{ marginBottom: 16 }}><AlertCircle size={18} /> <span>ذخیره نشد. {serverErr.msg}</span></div> : null}
    {tried && Object.keys(local).length ? <div className="tc-errbox" role="alert" style={{ marginBottom: 16 }}><AlertCircle size={18} /> <span>ذخیره نشد. {fa(Object.keys(local).length)} مورد را درست کن.</span></div> : null}
    <div className="tc-sgrid"><div>{secMaster}{secP1}{secB}{secD}</div><div>{secT}{secR}{secV}</div></div>
    {changes.length || errCount ? <div className="tc-savebar" data-testid="tc-savebar" data-floating-avoid="" data-sticky-footer="">
      <span className={`chg ${errCount ? 'bad' : ''}`}>{errCount && tried ? `${fa(errCount)} خطا را درست کن` : `${fa(changes.length)} تغییر ذخیره‌نشده`}</span>
      <button type="button" className="tc-ghost" onClick={() => { setF(data.settings); setTried(false); setServerErr(null); }}>لغو</button>
      <button type="button" className="tc-primary" onClick={startSave} data-testid="tc-save"><Check size={18} /> ذخیره‌ی تنظیمات</button>
    </div> : null}
    {confirm ? <div className="tc-layer" dir="rtl"><div className="tc-scrim" onClick={() => !busy && setConfirm(false)} aria-hidden="true" />
      <div className="tc-sheet" role="alertdialog" aria-modal="true" aria-labelledby="tc-cf-h" data-testid="tc-confirm">
        <div className="tc-grab" aria-hidden="true" />
        <h2 id="tc-cf-h">ذخیره‌ی تنظیمات؟</h2>
        <div className="tc-diff">{changes.map((k) => <div className="r" key={k}><span>{LABELS[k]}</span><span><s>{show(k, data.settings, names)}</s> ← <b>{show(k, f, names)}</b></span></div>)}</div>
        <p>از همین لحظه روی فروش‌های تازه (از {jalaliLabel(latin(f.modelStartDate).replace(/\//g, '-'))} به بعد) اعمال می‌شود. پورسانت‌هایی که قبلاً ثبت شده‌اند تغییر نمی‌کنند.</p>
        <button type="button" className="tc-primary" onClick={save} disabled={busy} data-testid="tc-confirm-save"><Check size={18} /> {busy ? 'در حال ذخیره…' : 'بله، ذخیره کن'}</button>
        <button type="button" className="tc-ghost" onClick={() => setConfirm(false)} disabled={busy}>بازگشت</button>
      </div></div> : null}
    {toast ? <div className="tc-toast" role="status" data-testid="tc-settings-toast"><Check size={18} /> {toast}</div> : null}
  </div>;
}
