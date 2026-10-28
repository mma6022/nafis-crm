import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cqApi, cqOn, faClock, faNum, GROUP_FA, useCqConfig, type CqConfig, type DsSettings, type QueueGroup } from './api';
import './call-queue.css';

export function CallQueueSettingsPage() {
  const cfg = useCqConfig().data; const qc = useQueryClient();
  const s = useQuery({ queryKey: ['call-queue', 'settings'], queryFn: cqApi.settings, enabled: !!cfg?.manager, retry: false });
  const [draft, setDraft] = useState<CqConfig['settings'] | null>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (s.data && !draft) setDraft(s.data.settings); }, [s.data, draft]);
  if (cfg && !cfg.manager) return <div className="cq-page"><p role="alert">این صفحه فقط برای مدیر است.</p></div>;
  if (!s.data || !draft) return <div className="cq-page"><p role="status">در حال بارگذاری…</p></div>;
  const base = s.data.settings;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const bad = !(draft.newRedHours >= 1 && draft.newRedHours <= 168 && Number.isInteger(draft.newRedHours)) ? 'new' : !(draft.p1StaleDays >= 1 && draft.p1StaleDays <= 60 && Number.isInteger(draft.p1StaleDays)) ? 'p1' : ![...draft.naTemplate.trim()].length || [...draft.naTemplate].length > 200 ? 'tpl' : '';
  const move = (i: number, d: -1 | 1) => { const o = [...draft.order]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; setDraft({ ...draft, order: o as QueueGroup[] }); };
  const save = async (body: Parameters<typeof cqApi.saveSettings>[0]) => { setErr(''); setMsg('');
    try { await cqApi.saveSettings(body); const r = await s.refetch(); if (r.data) setDraft(r.data.settings); void qc.invalidateQueries({ queryKey: ['call-queue'] }); setMsg('ذخیره شد.'); } catch (e) { setErr(e instanceof Error ? e.message : 'ذخیره نشد.'); } };
  return <div className="cq-page" data-testid="cq-settings">
    <h1>تنظیمات · صف تماس</h1>
    <section className="cq-panel"><h2>ترتیب گروه‌ها</h2>
      <ol className="cq-order">{draft.order.map((g, i) => <li key={g} data-testid={`cq-order-${g}`}><span>{faNum(i + 1)}. {GROUP_FA[g]}</span>{draft.order[i] !== base.order[i] ? <em className="cq-changed">تغییر</em> : null}
        <button type="button" aria-label={`بالا بردن ${GROUP_FA[g]}`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} /></button>
        <button type="button" aria-label={`پایین بردن ${GROUP_FA[g]}`} disabled={i === draft.order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} /></button></li>)}</ol></section>
    <section className="cq-panel"><h2>آستانه‌ها</h2>
      <label>قرمز شدن «جدید» بعد از (ساعت، ۱ تا ۱۶۸)<input type="number" min={1} max={168} value={draft.newRedHours} aria-invalid={bad === 'new'} onChange={(e) => setDraft({ ...draft, newRedHours: Number(e.target.value) })} data-testid="cq-set-new" /></label>
      <label>اولویت ۱ بی‌تماس بعد از (روز، ۱ تا ۶۰)<input type="number" min={1} max={60} value={draft.p1StaleDays} aria-invalid={bad === 'p1'} onChange={(e) => setDraft({ ...draft, p1StaleDays: Number(e.target.value) })} data-testid="cq-set-p1" /></label>
      {bad === 'new' || bad === 'p1' ? <p className="cq-err" role="alert" data-testid="cq-set-bad">مقدار بیرون از بازه است.</p> : null}</section>
    <section className="cq-panel"><h2>متن آماده‌ی بله · «جواب نداد»</h2>
      <textarea value={draft.naTemplate} maxLength={200} onChange={(e) => setDraft({ ...draft, naTemplate: e.target.value })} aria-invalid={bad === 'tpl'} data-testid="cq-set-tpl" />
      <small className="cq-counter">{faNum([...draft.naTemplate].length)} / ۲۰۰</small>
      <p className="cq-hint">خودکار فرستاده نمی‌شود؛ فقط وقتی کارشناس «ارسال» بزند می‌رود.</p></section>
    <section className="cq-panel"><h2>ثابت</h2><ul className="cq-fixed"><li>بیرون رفتن از صف فقط با ثبت تماس</li><li>بستن خودکار یادآور سررسیده با ثبت تماس</li><li>«مشغول تماس دیگه‌ام» فقط ۱۰ دقیقه و یک بار برای هر یادآور (در گزارش مدیر)</li><li>ساعت کاری ۹ تا ۱۸، جمعه و تعطیل رسمی به روز کاری بعد</li></ul></section>
    <section className="cq-panel"><h2>وضعیت فعال‌سازی</h2><ul className="cq-flags" data-testid="cq-flags">{(Object.keys(s.data.flags) as (keyof typeof s.data.flags)[]).map((k) => <li key={k}><span>{s.data.flagLabels[k] ?? k}</span><b className={s.data.flags[k] ? 'on' : 'off'}>{s.data.flags[k] ? 'روشن' : 'خاموش'}</b></li>)}</ul>
      <p className="cq-hint">روشن کردن هر بخش با تأیید مدیر سیستم انجام می‌شود.</p></section>
    {msg ? <p role="status">{msg}</p> : null}{err ? <p className="cq-err" role="alert">{err}</p> : null}
    <div className={`cq-savebar${dirty ? ' dirty' : ''}`}>
      <button type="button" className="btn btn-primary" disabled={!dirty || !!bad} onClick={() => void save(draft)} data-testid="cq-set-save">ذخیره</button>
      <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setDraft(base)}>لغو</button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(true)} data-testid="cq-set-reset">برگرداندن پیش‌فرض</button>
    </div>
    {confirmReset ? <div className="cq-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cq-reset-t"><p id="cq-reset-t">همه‌ی تنظیمات صف تماس به پیش‌فرض برگردد؟</p>
      <button type="button" className="btn btn-primary" onClick={() => { setConfirmReset(false); void save({ reset: true }); }} data-testid="cq-set-reset-ok">بله، برگردان</button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>انصراف</button></div> : null}
  </div>;
}

const KIND_FA = { snooze: 'تعویق مودال', void: 'باطل کردن یادآور دستیار', p1_no_answer_3: 'اولویت ۱ · ۳ بار بی‌پاسخ' } as const;
export function CallQueueEventsPage() {
  const cfg = useCqConfig().data; const [kind, setKind] = useState(''); const [sp, setSp] = useState('');
  const ev = useQuery({ queryKey: ['call-queue', 'events', kind, sp], queryFn: () => cqApi.events({ kind, salespersonId: sp ? Number(sp) : undefined }), enabled: !!cfg?.manager, retry: false });
  if (cfg && !cfg.manager) return <div className="cq-page"><p role="alert">این صفحه فقط برای مدیر است.</p></div>;
  return <div className="cq-page" data-testid="cq-events"><h1>گزارش مدیر · صف تماس</h1>
    <div className="cq-anchors">{(['', 'snooze', 'void', 'p1_no_answer_3'] as const).map((k) => <button key={k || 'all'} type="button" className={`cq-anchor${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)} data-testid={`cq-ev-f-${k || 'all'}`}>
      {k ? KIND_FA[k] : 'همه'} {ev.data ? <b>{faNum(k ? ev.data.counts[k] ?? 0 : Object.values(ev.data.counts).reduce((a, b) => a + b, 0))}</b> : null}</button>)}
      {ev.data?.salespersons.length ? <select aria-label="کارشناس" value={sp} onChange={(e) => setSp(e.target.value)}><option value="">همه‌ی کارشناس‌ها</option>{ev.data.salespersons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : null}</div>
    {ev.data && !ev.data.items.length ? <p className="cq-empty">امروز رویدادی ثبت نشده است.</p> : null}
    {ev.data?.items.map((e) => <article key={e.id} className={`cq-ev k-${e.kind}${e.seenAt ? ' seen' : ''}`} data-testid="cq-ev-row">
      <div><span className="cq-gtag">{KIND_FA[e.kind]}</span> <time>{faClock(e.at)}</time> · <Link href={`/customers/${e.customerId}`}>{e.customerName}</Link> <span className="cq-id">#{faNum(e.customerId)}</span> · {e.salespersonName ?? '—'}</div>
      {e.reason || e.note ? <blockquote>{[e.reason, e.note].filter(Boolean).join(' · ')}</blockquote> : null}
      <small>{[e.reminderSubject ? `یادآور: ${e.reminderSubject}` : '', e.sourceText ? `منبع: «${e.sourceText.slice(0, 80)}»` : '', e.reopenAt ? `باز شدن دوباره ${faClock(e.reopenAt)}` : '', e.nextCallAt ? `ثبت تماس ${faClock(e.nextCallAt)}` : ''].filter(Boolean).join(' · ')}</small>
      {e.kind === 'p1_no_answer_3' && !e.seenAt ? <button type="button" className="btn btn-ghost sm" onClick={() => void cqApi.seen(e.id).then(() => ev.refetch())} data-testid="cq-ev-seen">دیدم</button> : null}
    </article>)}
  </div>;
}

const DS_FIELDS: { key: Exclude<keyof DsSettings, 'transferMode' | 'excludedReceivers'>; label: string; unit: string }[] = [
  { key: 'onTimeMin', label: 'پنجره‌ی «به‌موقع» بعد از برگشت به CRM', unit: 'دقیقه' },
  { key: 'onTimeCapMin', label: 'سقف «به‌موقع» وقتی برگشتی ثبت نشد', unit: 'دقیقه' },
  { key: 'newPct', label: 'حد گزارش به‌موقع برای گرفتن مشتری تازه (بالای)', unit: '٪' },
  { key: 'newMaxOverdue', label: 'حد یادآور عقب‌افتاده برای مشتری تازه (کمتر از)', unit: 'مورد' },
  { key: 'restrictOverdue', label: 'پنل محدود بالای', unit: 'یادآور عقب‌افتاده' },
  { key: 'alertDays', label: 'هشدار به مدیر بعد از', unit: 'روز کاری پشت سر هم' },
  { key: 'wReport', label: 'وزن گزارش به‌موقع', unit: 'امتیاز' },
  { key: 'wOverdue', label: 'وزن یادآور عقب‌افتاده', unit: 'امتیاز' },
  { key: 'wNocall', label: 'کسر برای هر «مشغولم» بدون تماس بعدی', unit: 'امتیاز' },
  { key: 'dropPct', label: 'سیگنال افت تماس CRM (نسبت به ۵ روز کاری قبل)', unit: '٪' },
];
const DS_KEY_FA: Record<string, string> = Object.fromEntries(DS_FIELDS.map((f) => [f.key, f.label]));

/** R2 «نظم پیگیری» — manager page: team table, daily digest signals, settings (display only; no money effect). */
export function CallQueueDisciplinePage() {
  const cfg = useCqConfig().data; const qc = useQueryClient();
  const [date, setDate] = useState('');
  const team = useQuery({ queryKey: ['call-queue', 'discipline', 'team'], queryFn: cqApi.teamDiscipline, enabled: !!cfg?.manager, retry: false, refetchInterval: 120_000 });
  const sig = useQuery({ queryKey: ['call-queue', 'signals', date], queryFn: () => cqApi.signals(date || undefined), enabled: !!cfg?.manager && Boolean(cfg?.flags?.signals), retry: false });
  const [tf, setTf] = useState('');
  const tr = useQuery({ queryKey: ['call-queue', 'transfers', tf], queryFn: () => cqApi.transfers(tf || undefined), enabled: !!cfg?.manager && Boolean(cfg?.flags?.transfer_check), retry: false });
  const ds = useQuery({ queryKey: ['call-queue', 'ds-settings'], queryFn: cqApi.dsSettings, enabled: !!cfg?.manager, retry: false });
  const [draft, setDraft] = useState<DsSettings | null>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (ds.data && !draft) setDraft(ds.data.settings); }, [ds.data, draft]);
  if (cfg && !cfg.manager) return <div className="cq-page"><p role="alert">این صفحه فقط برای مدیر است.</p></div>;
  const save = async (reset = false) => {
    if (!draft) return; setErr(''); setMsg('');
    try { const r = await cqApi.saveDs(reset ? { reset: true } : draft); setMsg(r.changed ? `${faNum(r.changed)} تنظیم ذخیره شد و در گزارش تغییرات ثبت شد.` : 'تغییری نبود.');
      setDraft(null); void qc.invalidateQueries({ queryKey: ['call-queue'] }); } catch (e) { setErr(e instanceof Error ? e.message : 'ذخیره نشد.'); }
  };
  const t = team.data;
  return <div className="cq-page" data-testid="cq-discipline-page"><h1>نظم پیگیری تیم</h1>
    <p className="cq-rule">فقط برای دیدن است؛ هیچ اثری روی حقوق یا پورسانت ندارد.</p>
    {t && !t.enabled ? <p data-testid="cq-ds-off">«امتیاز نظم پیگیری» هنوز فعال نشده است.</p> : null}
    {t?.enabled ? <table className="cq-table" data-testid="cq-ds-team"><thead><tr><th>کارشناس</th><th>امتیاز امروز</th><th>به‌موقع</th><th>عقب‌افتاده</th><th>«مشغولم» بی‌تماس</th><th>مشتری تازه</th><th>روز پشت سر هم</th></tr></thead>
      <tbody>{t.experts.map((e) => <tr key={e.userId} className={e.today.ok ? '' : 'out'} data-testid="cq-ds-row">
        <td>{e.name}{e.restricted ? <span className="cq-urgent">پنل محدود</span> : null}</td><td><b>{faNum(e.today.score)}</b></td>
        <td>{e.today.onTimePct == null ? '—' : `${faNum(e.today.onTimePct)}٪`} <small>({faNum(e.today.onTime)}/{faNum(e.today.crmCalls)})</small></td>
        <td>{faNum(e.today.overdue)}</td><td>{faNum(e.today.nocall)}</td><td>{e.today.ok ? 'بله' : 'نه'}</td><td>{e.streak ? faNum(e.streak) : '—'}</td></tr>)}</tbody></table> : null}
    {cfg?.flags?.signals ? <section className="cq-group" data-testid="cq-signals"><h2>سیگنال‌های گزارش روزانه</h2>
      <label>روز (میلادی، خالی = روز کاری قبل) <input dir="ltr" value={date} onChange={(e) => setDate(e.target.value.replace(/[^0-9-]/g, '').slice(0, 10))} placeholder="YYYY-MM-DD" data-testid="cq-signals-date" /></label>
      {sig.data?.enabled ? <><p className="cq-hint">{sig.data.workday ? '' : 'این روز تعطیل است؛ سیگنالی حساب نمی‌شود. '}{sig.data.note}</p>
        {sig.data.items.length ? sig.data.items.map((i, n) => <article key={n} className={`cq-ev k-${i.kind}`} data-testid="cq-signal-row"><span className="cq-gtag">{i.kind === 'signal_crm_drop' ? 'افت تماس از CRM' : 'ثبت دستی بدون تماس CRM'}</span> {i.name} · {i.customerId ? <Link href={`/customers/${i.customerId}`}>{i.customerName}</Link> : null} {i.text}</article>)
          : <p className="cq-empty">سیگنالی نیست.</p>}</> : null}
    </section> : null}
    {cfg?.flags?.transfer_check ? <section className="cq-group" data-testid="cq-transfers"><h2>بررسی سپردن مشتری</h2>
      <label>نمایش <select value={tf} onChange={(e) => setTf(e.target.value)} data-testid="cq-transfers-filter"><option value="">همه</option>
        <option value="override">انتقال با نادیده گرفتن شرط</option><option value="blocked">سپردن انجام نشد</option><option value="ok">با شرط</option></select></label>
      {tr.data?.counts ? <p className="cq-hint">نادیده گرفتن شرط: {faNum(tr.data.counts.override ?? 0)} · انجام نشد: {faNum(tr.data.counts.blocked ?? 0)} · با شرط: {faNum(tr.data.counts.ok ?? 0)}</p> : null}
      {tr.data?.items.length ? <table className="cq-table" data-testid="cq-transfers-table"><thead><tr><th>زمان</th><th>مشتری</th><th>گیرنده</th><th>به‌موقع / عقب‌افتاده</th><th>نتیجه</th><th>دلیل</th><th>انجام‌دهنده</th></tr></thead>
        <tbody>{tr.data.items.map((r) => <tr key={r.id} className={r.outcome === 'ok' ? '' : 'out'} data-testid="cq-transfer-row">
          <td>{faClock(r.createdAt)}</td><td><Link href={`/customers/${r.customerId}`}>{r.customerName ?? `#${faNum(r.customerId)}`}</Link></td><td>{r.toName ?? '—'}</td>
          <td>{r.onTimePct == null ? 'نامعلوم' : `${faNum(r.onTimePct)}٪`} / {faNum(r.overdue ?? 0)}</td>
          <td>{r.outcome === 'override' ? 'انتقال با نادیده گرفتن شرط' : r.outcome === 'blocked' ? 'انجام نشد' : 'با شرط'} <small>({r.mode === 'block' ? 'جلوگیری' : 'هشدار'})</small></td>
          <td>{r.overrideReason ?? (r.reasons.length ? r.reasons.join('؛ ') : '—')}</td><td>{r.actorName ?? '—'}</td></tr>)}</tbody></table>
        : tr.data ? <p className="cq-empty" data-testid="cq-transfers-empty">موردی نیست.</p> : null}
    </section> : null}
    {draft && ds.data ? <section className="cq-group" data-testid="cq-ds-settings"><h2>تنظیمات نظم پیگیری</h2>
      {DS_FIELDS.map((f) => { const [lo, hi] = ds.data.ranges[f.key] ?? [0, 1000]; return <label key={f.key} className="cq-set-row">{f.label}
        <input type="number" min={lo} max={hi} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} data-testid={`cq-ds-${f.key}`} /> <small>{f.unit} · پیش‌فرض {faNum(ds.data.defaults[f.key])}</small></label>; })}
      <label className="cq-set-row">بررسی هنگام تحویل مشتری
        <select value={draft.transferMode} onChange={(e) => setDraft({ ...draft, transferMode: e.target.value as DsSettings['transferMode'] })} data-testid="cq-ds-transferMode"><option value="warn">فقط هشدار</option><option value="block">جلوگیری (با دلیل برای عبور)</option></select></label>
      <label className="cq-set-row">کاربرانی که مشتری تحویل نمی‌گیرند (شناسه‌ی کاربر، با ویرگول)
        <input dir="ltr" value={draft.excludedReceivers.join(',')} onChange={(e) => setDraft({ ...draft, excludedReceivers: e.target.value.split(/[,، ]+/).map(Number).filter((n) => n > 0) })} data-testid="cq-ds-excluded" /></label>
      <p className="cq-hint">وزن گزارش به‌موقع + وزن یادآور عقب‌افتاده باید ۱۰۰ شود. سقف «به‌موقع» نباید از پنجره کمتر باشد.</p>
      {err ? <p className="cq-err" role="alert" data-testid="cq-ds-err">{err}</p> : null}{msg ? <p role="status" data-testid="cq-ds-msg">{msg}</p> : null}
      <div className="cq-actions"><button type="button" className="btn btn-primary" onClick={() => void save()} data-testid="cq-ds-save">ذخیره</button><button type="button" className="btn btn-ghost" onClick={() => void save(true)} data-testid="cq-ds-reset">بازگشت به پیش‌فرض</button></div>
      {ds.data.log.length ? <details><summary>گزارش تغییرات</summary><ul>{ds.data.log.slice(0, 30).map((l) => <li key={l.id}>{faClock(l.at)} · {DS_KEY_FA[l.key.replace(/^ds\./, '')] ?? l.key}: {l.oldValue ?? '—'} ← {l.newValue}</li>)}</ul></details> : null}
    </section> : null}
  </div>;
}
