import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cqApi, faClock, faNum, GROUP_FA, useCqConfig, type CqConfig, type QueueGroup } from './api';
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
    <section className="cq-panel"><h2>متن آماده‌ی بله · «پاسخ نداد»</h2>
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
