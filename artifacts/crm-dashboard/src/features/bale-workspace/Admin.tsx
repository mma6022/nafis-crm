/* «فضای کار بله» د + ز + و — «مدیریت فروش» (sales manager + admin only; the server answers 403 to everyone else).
   Blocks under «پیام‌های پیش‌فرض» in the console's Bale section, plus two pages: /bale-workspace/automation (5-step wizard) and /bale-workspace/training.
   Nothing is sent before «تأیید و شروع»; the count shown is the count confirmed (server re-checks it). Ghasemi's bot is never a sender or a choice. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bbFetch, bbUrl } from '@/features/bale-bot/api';
import { c, Chip, Tgl, I } from '@/features/sales-manager-console/ui';
import '@/features/sales-manager-console/smc.css';
import './bale-workspace.css';
import { bwsErr, fd, faNum, jDate, KIND_FA, STATUS_FA, WHO_FA, useBwsMe, type AdminState, type Audience, type Scenario } from './api';

const useAdmin = (on: boolean) => useQuery<AdminState>({ queryKey: ['bws-admin'], enabled: on, retry: false, queryFn: () => bbFetch('/bale-workspace/admin/state') });
const H = ({ children }: { children: ReactNode }) => <h3 className={c('bh3')}>{children}</h3>;
function useFlash() { const [m, setM] = useState<string | null>(null); useEffect(() => { if (!m) return; const t = setTimeout(() => setM(null), 4000); return () => clearTimeout(t); }, [m]); return [m, setM] as const; }
const audLabel = (a: Audience, experts: AdminState['experts']) => [WHO_FA[a.who], a.stars ? `ستاره: ${a.stars.map((s) => (s ? fd(s) : 'بدون')).join('، ')}` : null, a.experts ? experts.filter((e) => a.experts!.includes(e.id)).map((e) => e.name).join('، ') : null].filter(Boolean).join(' · ');

/** Console blocks (render nothing while the flag is OFF or for non-managers). */
export function BwsConsoleBlocks() {
  const me = useBwsMe(); const on = !!me.data?.canManage;
  const st = useAdmin(on); const qc = useQueryClient(); const [flash, setFlash] = useFlash();
  const [inv, setInv] = useState<string | null>(null); const [pat, setPat] = useState<string | null>(null);
  if (!on || !st.data) return null;
  const s = st.data;
  const put = async (path: string, method: 'PUT' | 'POST', body: unknown, ok: string) => { try { const r = await bbFetch<AdminState>(path, { method, body }); qc.setQueryData(['bws-admin'], r); setFlash(ok); return true; } catch (e) { setFlash(bwsErr(e)); return false; } };
  return <div className="bws-adm" data-testid="bws-console">
    <H>دعوت به بله</H>
    <div className={c('bcard')}>
      <label className={c('lbl')}>متن دعوت (بله و پیامک؛ {'{name}'} = نام مشتری)
        <textarea className={c('inp ta')} rows={2} value={inv ?? s.inviteText} onChange={(e) => setInv(e.target.value)} data-testid="bws-invite-text" /></label>
      <label className={c('lbl')}>کد الگوی پیامک دعوت (IPPanel)
        <input className={c('inp')} dir="ltr" value={pat ?? s.smsPattern} onChange={(e) => setPat(e.target.value)} placeholder="—" /></label>
      <div className="bws-pat" data-testid="bws-sms-pattern-text"><span className={c('hint')}>متن الگو (در IPPanel با دست ثبت می‌شود؛ {'{نام}'} = متغیر name، نام مشتری):</span><p>{s.smsPatternText}</p></div>
      {!s.smsPattern ? <Chip k="g">پیامک دعوت: تنظیم نشده (تا کد الگو ثبت نشود، پیامک نمی‌رود)</Chip> : null}
      <div className={c('row1')}><span className={c('sp')} /><button className={c('btn pri')} type="button" disabled={inv == null && pat == null}
        onClick={async () => { if (await put('/bale-workspace/admin/invite', 'PUT', { text: inv ?? s.inviteText, smsPattern: pat ?? s.smsPattern }, 'متن دعوت ذخیره شد.')) { setInv(null); setPat(null); } }}>ذخیره</button></div>
    </div>
    <H>شرایط طرح در بله</H>
    <div className={c('bcard')} data-testid="bws-plan-terms-link">
      <span className={c('hint')}>متن بلهٔ هر طرح در «طرح‌های تسهیلاتی»، داخل ویرایش همان طرح است ({fd(s.plans.filter((p) => p.terms).length)} طرح از {fd(s.plans.length)} متن دارد).</span>
      <div className={c('row1')}><Link className={c('btn gh')} href="/loan-plans">رفتن به طرح‌ها</Link></div>
    </div>
    <H>ارسال خودکار، انبوه و بی‌پاسخ</H>
    <div className={c('bcard')}>
      <div className={c('brow')}><span className={c('bnm')}><b>ارسال خودکار</b><span className={c('hint')}>بدون محدودیت ساعت</span></span><span className={c('sp')} />
        <Tgl on={s.autoOn} onClick={() => void put('/bale-workspace/admin/auto', 'PUT', { on: !s.autoOn }, s.autoOn ? 'ارسال خودکار خاموش شد.' : 'ارسال خودکار روشن شد.')}>{s.autoOn ? 'روشن' : 'خاموش'}</Tgl></div>
      <ScenarioRows s={s} />
      <div className={c('row1')}><Link className={c('btn dash')} href="/bale-workspace/automation" data-testid="bws-new-scenario"><I n="plus" />سناریوی تازه</Link></div>
    </div>
    <H>فایل‌های آموزشی</H>
    <div className={c('bcard')}>
      {s.training.length ? <ul className="bws-tl">{s.training.slice(0, 5).map((t) => <li key={t.id}><b>{t.title}</b><Chip k={t.audience === 'customer' ? 'b' : 'g'}>{t.audience === 'customer' ? 'مشتری' : 'کارشناس'}</Chip><span className={c('hint')}>{t.plansLabel}</span></li>)}</ul> : <span className={c('hint')}>هنوز فایلی نیست.</span>}
      <div className={c('row1')}><Link className={c('btn gh')} href="/bale-workspace/training">مدیریت فایل‌ها{s.training.length ? ` (${fd(s.training.length)})` : ''}</Link></div>
    </div>
    {flash ? <p className={`${c('hint')} bws-flash`} role="status">{flash}</p> : null}
  </div>;
}
function ScenarioRows({ s }: { s: AdminState }) {
  const qc = useQueryClient();
  const toggle = async (sc: Scenario) => { try { await bbFetch(`/bale-workspace/admin/scenarios/${sc.id}/${sc.status === 'active' ? 'pause' : 'resume'}`, { body: {} }); void qc.invalidateQueries({ queryKey: ['bws-admin'] }); } catch { /* list refreshes */ } };
  if (!s.scenarios.length) return <span className={c('hint')}>هنوز سناریویی ساخته نشده است.</span>;
  return <ul className="bws-scl" data-testid="bws-scenarios">{s.scenarios.map((sc) => <li key={sc.id}>
    <span className="nm"><b>{sc.name}</b><span className={c('hint')}>{KIND_FA[sc.kind]} · {audLabel(sc.audience, s.experts)}{sc.kind === 'noreply' && sc.cond?.hours ? ` · بعد از ${fd(sc.cond.hours)} ساعت` : ''}</span></span>
    <Chip k={sc.status === 'active' ? 'ok' : sc.status === 'done' ? 'b' : 'g'}>{STATUS_FA[sc.status]}</Chip>
    {sc.recipients != null ? <span className={c('hint')}>{faNum(sc.sent)} از {faNum(sc.recipients)}</span> : null}
    {sc.status === 'active' || sc.status === 'paused' ? <button className={c('btn gh')} type="button" onClick={() => void toggle(sc)}>{sc.status === 'active' ? 'توقف' : 'ادامه'}</button> : sc.status === 'draft' ? <Link className={c('btn lk')} href={`/bale-workspace/automation?id=${sc.id}`}>ادامهٔ ساخت</Link> : null}
  </li>)}</ul>;
}

function Shell({ title, back, children }: { title: string; back?: string; children: ReactNode }) {
  return <div className={`${c('root')} bws-page`} dir="rtl"><div className="bws-pin">
    <div className="bws-ph"><Link className={c('btn lk')} href={back ?? '/sales-admin'} aria-label="بازگشت به مدیریت فروش">مدیریت فروش ›</Link><h1>{title}</h1></div>
    {children}</div></div>;
}
function Gate({ children, title }: { children: (s: AdminState) => ReactNode; title: string }) {
  const me = useBwsMe(); const st = useAdmin(!!me.data?.canManage);
  if (me.isLoading || (me.data?.canManage && st.isLoading)) return <Shell title={title}><p className={c('hint')}>در حال بارگذاری…</p></Shell>;
  if (!me.data) return <Shell title={title}><p className={c('hint')}>این بخش فعال نیست.</p></Shell>;
  if (!me.data.canManage || !st.data) return <Shell title={title}><p className={c('hint')}>این بخش فقط برای مدیر فروش و ادمین است.</p></Shell>;
  return <Shell title={title}>{children(st.data)}</Shell>;
}

/* ---------------- د: 5-step wizard ---------------- */
const STEPS = ['نام و نوع', 'مخاطب', 'شرط', 'پیام', 'تعداد و تأیید'];
type Draft = { id?: number; name: string; kind: Scenario['kind'] | null; audience: Audience; hours: number; body: string; trainingFileId: number | null };
export function BwsAutomationPage() { return <Gate title="سناریوی ارسال در بله">{(s) => <Wizard s={s} />}</Gate>; }
function Wizard({ s }: { s: AdminState }) {
  const [, nav] = useLocation(); const qc = useQueryClient();
  const qid = Number(new URLSearchParams(window.location.search).get('id')) || 0;
  const ex = qid ? s.scenarios.find((x) => x.id === qid && x.status === 'draft') : undefined;
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(() => ex ? { id: ex.id, name: ex.name, kind: ex.kind, audience: ex.audience, hours: ex.cond?.hours ?? 24, body: ex.body, trainingFileId: ex.trainingFileId }
    : { name: '', kind: null, audience: { who: 'messaged', stars: null, experts: null }, hours: 24, body: 'سلام {name}، ', trainingFileId: null });
  const [count, setCount] = useState<{ n: number; inHours: boolean } | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => { setD({ ...d, ...p }); setCount(null); };
  const tog = <T,>(arr: T[] | null, v: T) => { const a = arr ?? []; const n = a.includes(v) ? a.filter((x) => x !== v) : [...a, v]; return n.length ? n : null; };
  const ok = [d.name.trim().length > 0 && !!d.kind, true, d.kind !== 'noreply' || (d.hours >= 1 && d.hours <= 720), d.body.trim().length > 0, true];
  const custFiles = s.training.filter((t) => t.audience === 'customer');
  useEffect(() => { if (step !== 4 || count) return; void (async () => { try { const r = await bbFetch<{ count: number; inSendHours: boolean }>('/bale-workspace/admin/scenarios/preview', { body: { audience: d.audience } }); setCount({ n: r.count, inHours: r.inSendHours }); } catch (e) { setMsg(bwsErr(e)); } })(); }, [step, count, d.audience]);
  const save = async () => { const r = await bbFetch<{ scenario: Scenario }>('/bale-workspace/admin/scenarios', { body: { id: d.id, name: d.name, kind: d.kind, audience: d.audience, cond: { hours: d.hours }, body: d.body, trainingFileId: d.trainingFileId } }); setD({ ...d, id: r.scenario.id }); return r.scenario; };
  const draft = async () => { setBusy(true); try { await save(); void qc.invalidateQueries({ queryKey: ['bws-admin'] }); setMsg('پیش‌نویس ذخیره شد؛ چیزی فرستاده نشد.'); } catch (e) { setMsg(bwsErr(e)); } finally { setBusy(false); } };
  const confirm = async () => {
    if (!count) return; setBusy(true);
    try { const sc = await save(); await bbFetch(`/bale-workspace/admin/scenarios/${sc.id}/confirm`, { body: { count: count.n } }); void qc.invalidateQueries({ queryKey: ['bws-admin'] }); nav('/sales-admin'); }
    catch (e) { setMsg(bwsErr(e)); setCount(null); } finally { setBusy(false); }
  };
  const P = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => <button type="button" role="checkbox" aria-checked={on} className={c('pick', on && 'on')} onClick={onClick}>{children}</button>;
  return <div className={c('bcard')} data-testid="bws-wizard">
    <div className="bws-prog" role="progressbar" aria-valuemin={1} aria-valuemax={5} aria-valuenow={step + 1} aria-label={`گام ${fd(step + 1)} از ۵`}><i style={{ width: `${((step + 1) / 5) * 100}%` }} /></div>
    <div className={`${c('wbar')} bws-w5`}>{STEPS.map((t, i) => <button key={t} type="button" className={c(i === step && 'on', i < step && 'done')} disabled={i > step && !ok.slice(0, i).every(Boolean)} onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}><span className={c('wn')}>{fd(i + 1)}</span>{t}</button>)}</div>
    <p className="bws-steplbl">گام {fd(step + 1)} از ۵ · {STEPS[step]}</p>
    {step === 0 ? <div className="bws-wf">
      <label className={c('lbl')}>نام سناریو<input className={c('inp')} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="مثلاً پیگیری بی‌پاسخ ۲۴ ساعته" /></label>
      <div className={c('picks')} role="radiogroup" aria-label="نوع">{(['bulk', 'noreply', 'auto'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={c('pick', d.kind === k && 'on')} onClick={() => set({ kind: k })}>{KIND_FA[k]}</button>)}</div>
      {d.kind ? <p className={c('hint')}>{d.kind === 'bulk' ? 'یک‌بار برای همهٔ مخاطبان، آرام و پشت سر هم.' : d.kind === 'noreply' ? 'اگر مشتری تا چند ساعت جواب نداد، پیام می‌رود؛ باز هم جواب نداد، به کارشناس تحویل و به «کارهای امروز» او اضافه می‌شود.' : 'بعد از اولین پیام مشتری، یک‌بار؛ فقط وقتی «ارسال خودکار» روشن است.'}</p> : null}
    </div> : null}
    {step === 1 ? <div className="bws-wf">
      <span className={c('lbl')}>چه کسانی</span>
      <div className={c('picks')} role="radiogroup" aria-label="مخاطب">{(['messaged', 'linked', 'all'] as const).map((w) => <button key={w} type="button" role="radio" aria-checked={d.audience.who === w} className={c('pick', d.audience.who === w && 'on')} onClick={() => set({ audience: { ...d.audience, who: w } })}>{WHO_FA[w]}</button>)}</div>
      <span className={c('lbl')}>ستاره (خالی = همه)</span>
      <div className={c('picks')}>{[3, 2, 1, 0].map((n) => <P key={n} on={!!d.audience.stars?.includes(n)} onClick={() => set({ audience: { ...d.audience, stars: tog(d.audience.stars, n) } })}>{n ? `${fd(n)} ستاره` : 'بدون ستاره'}</P>)}</div>
      <span className={c('lbl')}>ربات کارشناس (خالی = همه)</span>
      <div className={c('picks')}>{s.experts.map((e) => <P key={e.id} on={!!d.audience.experts?.includes(e.id)} onClick={() => set({ audience: { ...d.audience, experts: tog(d.audience.experts, e.id) } })}>{e.name}</P>)}</div>
    </div> : null}
    {step === 2 ? <div className="bws-wf">
      {d.kind === 'noreply' ? <label className={c('lbl')}>اگر مشتری تا چند ساعت جواب نداد
        <span className={c('row1')}><input className={c('inp')} style={{ width: 110 }} inputMode="numeric" dir="ltr" value={d.hours} onChange={(e) => set({ hours: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })} /><span className={c('hint')}>ساعت (۱ تا ۷۲۰)</span></span></label>
        : d.kind === 'auto' ? <p className={c('hint')}>شرط: اولین پیام مشتری بعد از تأیید. هر گفتگو فقط یک‌بار.</p>
        : <p className={c('hint')}>شرط ندارد؛ بعد از تأیید یک‌بار برای همه می‌رود. سقف روزانه ندارد.</p>}
      <p className={c('hint')}>بدون محدودیت ساعت. «لغو» یا «توقف» از طرف مشتری کسی را از فهرست بیرون نمی‌برد.</p>
    </div> : null}
    {step === 3 ? <div className="bws-wf">
      <label className={c('lbl')}>متن پیام ({'{name}'} = نام مشتری)<textarea className={c('inp ta')} rows={5} value={d.body} onChange={(e) => set({ body: e.target.value })} /></label>
      <span className={c('lbl')}>فایل آموزشی (اختیاری)</span>
      <div className={c('picks')} role="radiogroup" aria-label="فایل آموزشی"><button type="button" role="radio" aria-checked={!d.trainingFileId} className={c('pick', !d.trainingFileId && 'on')} onClick={() => set({ trainingFileId: null })}>بدون فایل</button>
        {custFiles.map((t) => <button key={t.id} type="button" role="radio" aria-checked={d.trainingFileId === t.id} className={c('pick', d.trainingFileId === t.id && 'on')} onClick={() => set({ trainingFileId: t.id })}>{t.title}</button>)}</div>
    </div> : null}
    {step === 4 ? <div className="bws-wf" data-testid="bws-confirm">
      <div className="bws-sum"><span>{d.name} · {d.kind ? KIND_FA[d.kind] : ''}</span><span className={c('hint')}>{audLabel(d.audience, s.experts)}</span></div>
      <div className="bws-count">{count ? <><b>{faNum(count.n)}</b><span>گفتگو این پیام را می‌گیرند</span></> : <span className={c('hint')}>در حال شمردن…</span>}</div>
      <p className={c('hint')}>تا «تأیید و شروع» زده نشود، چیزی فرستاده نمی‌شود.</p>
    </div> : null}
    <div className={c('row1')}>
      {step > 0 ? <button className={c('btn gh')} type="button" onClick={() => setStep(step - 1)}>قبلی</button> : null}
      <button className={c('btn lk')} type="button" disabled={busy || !ok[0] || !ok[3]} onClick={draft}>ذخیرهٔ پیش‌نویس</button>
      <span className={c('sp')} />
      {step < 4 ? <button className={c('btn pri')} type="button" disabled={!ok[step]} onClick={() => setStep(step + 1)}>بعدی</button>
        : <button className={c('btn pri')} type="button" disabled={busy || !count || !ok.every(Boolean)} onClick={confirm} data-testid="bws-confirm-go">تأیید و شروع{count ? ` (${faNum(count.n)})` : ''}</button>}
    </div>
    {msg ? <p className={`${c('hint')} bws-flash`} role="status">{msg}</p> : null}
  </div>;
}

/* ---------------- ز: training files ---------------- */
export function BwsTrainingPage() { return <Gate title="فایل‌های آموزشی">{(s) => <Training s={s} />}</Gate>; }
function Training({ s }: { s: AdminState }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(''); const [aud, setAud] = useState<'customer' | 'expert'>('customer'); const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [ids, setIds] = useState<number[]>([]); const [url, setUrl] = useState(''); const [file, setFile] = useState<File | null>(null); const fileRef = useRef<HTMLInputElement | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const done = (st: AdminState, m: string) => { qc.setQueryData(['bws-admin'], st); setMsg(m); };
  const add = async () => {
    setBusy(true);
    try {
      const meta = { title, audience: aud, planScope: scope, planIds: ids, fileName: file?.name ?? null, url: file ? null : url };
      const r = file ? await bbFetch<{ state: AdminState }>('/bale-workspace/admin/training', { raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-bws-meta': encodeURIComponent(JSON.stringify(meta)) } })
        : await bbFetch<{ state: AdminState }>('/bale-workspace/admin/training', { body: meta });
      done(r.state, `«${title}» اضافه شد.`); setTitle(''); setUrl(''); setFile(null); if (fileRef.current) fileRef.current.value = ''; setIds([]);
    } catch (e) { setMsg(bwsErr(e)); } finally { setBusy(false); }
  };
  const del = async (id: number, t: string) => { try { done(await bbFetch<AdminState>(`/bale-workspace/admin/training/${id}/delete`, { body: {} }), `«${t}» برداشته شد.`); } catch (e) { setMsg(bwsErr(e)); } };
  return <>
    <div className={c('bcard')} data-testid="bws-training">
      {s.training.length ? <ul className="bws-tl big">{s.training.map((t) => <li key={t.id}>
        <span className="nm"><b>{t.title}</b><span className={c('hint')}>{t.kind === 'link' ? 'پیوند' : t.kind === 'video' ? 'ویدیو' : 'فایل'} · {t.plansLabel} · {jDate(t.at, false)}</span></span>
        <Chip k={t.audience === 'customer' ? 'b' : 'g'}>{t.audience === 'customer' ? 'مشتری' : 'کارشناس'}</Chip>
        {t.kind === 'link' ? <a className={c('btn lk')} href={t.url} target="_blank" rel="noreferrer noopener">باز کردن</a> : <a className={c('btn lk')} href={bbUrl(t.url.replace(/^\/api/, ''))}>دریافت</a>}
        <button className={c('btn gh bad')} type="button" onClick={() => void del(t.id, t.title)} aria-label={`برداشتن ${t.title}`}><I n="trash" /></button></li>)}</ul>
        : <span className={c('hint')}>هنوز فایلی نیست.</span>}
    </div>
    <H>فایل یا پیوند تازه</H>
    <div className={c('bcard')}>
      <label className={c('lbl')}>عنوان<input className={c('inp')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً نحوهٔ ثبت سفته" /></label>
      <span className={c('lbl')}>مخاطب</span>
      <div className={c('picks')} role="radiogroup" aria-label="مخاطب">{([['customer', 'مشتری'], ['expert', 'کارشناس']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={aud === k} className={c('pick', aud === k && 'on')} onClick={() => setAud(k)}>{l}</button>)}</div>
      <span className={c('lbl')}>طرح‌ها</span>
      <div className={c('picks')}><button type="button" role="radio" aria-checked={scope === 'all'} className={c('pick', scope === 'all' && 'on')} onClick={() => setScope('all')}>همهٔ طرح‌ها</button>
        {s.plans.map((p) => <button key={p.id} type="button" role="checkbox" aria-checked={scope === 'selected' && ids.includes(p.id)} className={c('pick', scope === 'selected' && ids.includes(p.id) && 'on')}
          onClick={() => { setScope('selected'); setIds(ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id]); }}>{p.name}</button>)}</div>
      {/* Armita r3: Persian picker instead of the browser's English «Choose File»; the native input stays (hidden) for the OS dialog. */}
      <div className={c('lbl')}><span id="bws-tr-file-lbl">فایل (PDF، عکس یا ویدیو MP4، تا ۵۰ مگابایت)</span>
        <div className="bws-filepick">
          <input ref={fileRef} className="bws-vh" type="file" tabIndex={-1} aria-hidden="true" accept="application/pdf,image/jpeg,image/png,video/mp4" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className={c('btn gh')} aria-describedby="bws-tr-file-lbl" onClick={() => fileRef.current?.click()} data-testid="bws-file-pick">انتخاب فایل</button>
          <span className={`bws-fname${file ? '' : ' none'}`} dir="auto" data-testid="bws-file-name" title={file?.name}>{file ? file.name : 'فایلی انتخاب نشده'}</span>
          {file ? <button type="button" className="bws-fclear" aria-label="برداشتن فایل" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>×</button> : null}
        </div></div>
      {!file ? <label className={c('lbl')}>یا پیوند (https)<input className={c('inp')} dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label> : null}
      <div className={c('row1')}><span className={c('sp')} /><button className={c('btn pri')} type="button" disabled={busy || !title.trim() || (!file && !/^https:\/\//.test(url)) || (scope === 'selected' && !ids.length)} onClick={add}>{busy ? 'در حال افزودن…' : 'افزودن'}</button></div>
      {msg ? <p className={`${c('hint')} bws-flash`} role="status">{msg}</p> : null}
    </div>
  </>;
}
