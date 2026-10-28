/** incoming2-59 (Mohammad 10:45) «تماس ورودی داشتم» wizard — one modal shared by the carousel and the lockdown today view.
 *  Step 0: two big choices «مشتری قبلیه» / «مشتری جدیده، تازه زنگ زده».
 *   - قبلی: exact phone → own: log the call · other expert: «کارشناس پرونده: …» only · not found: offer «مشتری جدیده».
 *   - جدید: phone → duplicate check (owner name only) → name (fewest fields) → created (owner = this expert) → log the call.
 *  Logging: when the CRM's own rule says this is a first call (useCallLauncher → the qualifier's own in-progress customer with no
 *  priority) the existing first-call form (team-sales/SimpleCallForm, as FIRSTCALL-62) opens; otherwise the «خارج از لیست» log.
 *  The typed number stays full in the input; results show the CRM's masked form. No SMS/Bale (server side).
 *  SEARCH-65b reuse: «مشتری قبلیه» types a few digits or a name → 65b's live own-customer list (/incoming/suggest, ≤8, last 4 digits)
 *  → tap = 65b's /incoming/pick (same own path); «پیدا کن» with the full number is the existing exact search (other expert → owner name only). */
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, FileText, Info, Lock, Pencil, Phone, PhoneIncoming, Plus, Search, Send, User, X } from 'lucide-react';
import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, useGetAuthSession, useGetCustomer } from '@workspace/api-client-react';
import { faNum } from '@/features/call-queue/api';
import { useCallLauncher } from '@/features/team-sales/useCallLauncher';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { elApi, type ElSearch, type ElSuggest } from './api';
import { liveQueryReady } from './IncomingCall';
import './lockdown.css';
import { OutOfListLog } from './OutOfListLog';
import '@/features/daily-plan/carousel.css';

type Step = 'choose' | 'old_phone' | 'own' | 'other' | 'referred' | 'none' | 'new_form' | 'dup' | 'log' | 'ok';
/** SEARCH-C copy (Armita v1.1 scenes 16–18) in one place so later design passes only edit strings. */
export const SC = {
  own: 'مشتری خودت',
  other: 'کارشناس دیگر',
  hint: 'مشتری‌های خودت همین‌طور که می‌نویسی می‌آیند (چند رقم یا نام). مشتری همکار فقط با شماره‌ی کامل ۱۱ رقمی و «پیدا کن» پیدا می‌شود.',
  belongs: (o: string) => `این مشتری برای کارشناس ${o} است`,
  referTo: (o: string) => `ارجاع به ${o}`,
  referring: 'در حال ارجاع…',
  close: 'بستن',
  referredTitle: (o: string) => `به ${o} ارجاع شد`,
  referredLine: (o: string, t: string) => `ارجاع به کارشناس ${o} · امروز ${t}`,
  b1: (o: string) => `${o} یک اعلان داخل CRM گرفت و کار «تماس با مشتری ارجاعی» اول لیست امروزش آمد؛ کاری که الان دستش است سر جایش می‌ماند.`,
  b2: (o: string) => `به مشتری هیچ پیامی فرستاده نمی‌شود؛ به او بگو «${o} با شما تماس می‌گیرد».`,
  b3: 'کار جاری تو سر جایش است.',
  already: 'قبلاً ارجاع داده بودی؛ دوباره اعلان فرستاده نشد.',
  notReferable: 'ارجاع برای این کارشناس فعال نیست؛ بگو کارشناسش با او تماس می‌گیرد.',
};
const tehHm = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };
export const maskTel = (t: string | null) => (t ? faNum(`${t.slice(0, 4)}***${t.slice(-4)}`) : '');
export const phone11 = (s: string) => {
  const d = s.replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\D/g, '');
  const t = d.startsWith('0098') ? `0${d.slice(4)}` : d.startsWith('98') && d.length === 12 ? `0${d.slice(2)}` : d.length === 10 && d.startsWith('9') ? `0${d}` : d;
  return /^09\d{9}$/.test(t) ? t : null;
};

/** Logs the call for a customer of this expert. When the CRM's rule says first call (useCallLauncher: the qualifier's own in-progress
 *  customer with no priority) the existing first-call form (SimpleCallForm, FIRSTCALL-62) is MANDATORY (PM 10:51 (c)): it records the
 *  call and the first-call data in one save (no separate call log first → never a half-logged call), required fields as that form
 *  enforces them; then the call is mirrored as «خارج از لیست». Otherwise the «خارج از لیست» log (3 outcomes + note ≤80). */
/** SEARCH-65b pick: no full number was typed → masked phone + tel: from the customer's record (full number only in href). */
function PickedTel({ id }: { id: number }) {
  const q = useGetCustomer(id, { query: { queryKey: getGetCustomerQueryKey(id), retry: false } });
  const t = phone11(String((q.data as { phone?: string | null } | undefined)?.phone ?? ''));
  return t ? <a className="btn btn-primary iw-tel" href={`tel:${t}`} data-testid="iw-tel-call"><Phone size={15} aria-hidden="true" /> تماس</a> : null;
}

function LogCall({ customer, phone, currentNo, saveLabel, onSaved, extra, onFormOpen, onUnsaved, onKind, isNew }: {
  customer: { id: number; name: string }; phone: string | null; currentNo: number | null; saveLabel: string; onSaved: (m: string, first: boolean) => void; extra: React.ReactNode;
  onFormOpen: (open: boolean) => void; onUnsaved: () => void; onKind: (k: string) => void; isNew: boolean;
}) {
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const custQ = useGetCustomer(customer.id, { query: { queryKey: getGetCustomerQueryKey(customer.id), retry: false } });
  const [fc, setFcState] = useState(false); const savedRef = useRef<string | null>(null);
  const setFc = (v: boolean) => { setFcState(v); onFormOpen(v); };
  const launcher = useCallLauncher(user, Boolean(user), () => setFc(true));
  const cust = custQ.data ?? (custQ.isError && user ? { id: customer.id, name: customer.name, phone: phone ?? '', salespersonId: user.salespersonId ?? null, status: 'in_progress', priority: null } : null);
  const rawKind = !user || !cust ? 'wait' : launcher.choose(cust);
  // NEWCUST-65 (Mohammad 11:36, live): a closer (Hasani / Ghasemi) also records a customer they JUST registered here with the first-call form
  // (server-scoped by isInboundSelfRegistered): P1 stays with them, P2/P3 move to Kazemi. Their existing customers keep the regular «ثبت تماس».
  const closer = isNew && rawKind === 'legacy' && launcher.config?.enabled === true;
  const kind = closer ? 'simple' : rawKind;
  const auto = useRef(false);
  const [reopen, setReopen] = useState(false); // PM rule v1.1.1: an existing customer whose first-call form is still incomplete → scene 13 notice
  useEffect(() => { if (kind === 'simple' && !isNew && !closer) void elApi.firstCallIncomplete(customer.id).then((r) => setReopen(Boolean(r?.incomplete))).catch(() => undefined); }, [kind, isNew, customer.id]);
  useEffect(() => { onKind(kind); if (kind === 'simple' && cust && !auto.current) { auto.current = true; launcher.launch(cust); } }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (kind === 'wait' || kind === 'error') return <div className="tc-form">{extra}<p className="dp-hint" role="status" data-testid="iw-wait">{kind === 'error' ? 'تنظیمات فرم تماس بارگذاری نشد؛ دوباره امتحان کن.' : 'در حال آماده‌سازی فرم تماس…'}</p></div>;
  if (kind === 'simple' && cust) {
    const finish = () => { setFc(false); if (savedRef.current) onSaved(savedRef.current, true); else onUnsaved(); };
    return <div className="tc-form">{extra}
      <p className="dp-hint" data-testid="iw-first-hint"><Info size={13} aria-hidden="true" /> تماس اول این مشتری است: نتیجه‌ی تماس و فرم تماس اول با هم ثبت می‌شوند (اجباری).</p>
      <p className="tc-xol"><Lock size={13} aria-hidden="true" /> {closer ? 'اگر اولویت ۱ شد پیش خودت می‌ماند؛ اولویت ۲ یا ۳ خودکار به آقای کاظمی منتقل می‌شود · کار جاری سر جایش می‌ماند' : 'با برچسب «خارج از لیست» ثبت می‌شود · کار جاری سر جایش می‌ماند'}</p>
      <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => launcher.launch(cust)} data-testid="iw-first-open"><FileText size={15} aria-hidden="true" /> {saveLabel}</button></div>
      {fc ? createPortal(<SimpleCallForm strict confirmClose reopenNotice={reopen} closeConfirmBody={closer ? 'مشتری ثبت شده، ولی این تماس و اطلاعات تماس اول ثبت نمی‌شود.' : undefined} customer={{ id: customer.id, name: cust.name ?? customer.name, phone: cust.phone ?? phone ?? '', priority: cust.priority ?? null }} userId={user?.id}
        onClose={finish} onNext={finish}
        onDone={(r) => { savedRef.current = (r as { transferredToQualifier?: boolean }).transferredToQualifier ? `${customer.name}: فرم تماس اول ثبت شد و مشتری به آقای کاظمی منتقل شد` : `${customer.name}: تماس و فرم تماس اول ثبت شد`; void elApi.firstCallLogged(customer.id, r.callLogId).catch(() => undefined); }} />, document.body) : null}
    </div>;
  }
  return <OutOfListLog customer={customer} currentNo={currentNo} idPrefix="iw" saveLabel={saveLabel === 'ثبت تماس و فرم تماس اول' ? 'ثبت تماس' : saveLabel} onSaved={(m) => onSaved(m, false)} extra={extra} />;
}

/** Armita crm-incoming-call: big «تماس ورودی داشتم» at the top of «کارهای امروز من» (carousel + lockdown list view). */
export function IncomingTopButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  return <button type="button" className="iw-big" onClick={onClick} aria-haspopup="dialog" data-testid={testId}>
    <Phone size={22} aria-hidden="true" /><span><b>تماس ورودی داشتم</b><small>مشتری قبلی یا جدید · کار جاری عوض نمی‌شود</small></span></button>;
}

const PATHS = { old: ['نوع تماس', 'شماره', 'ثبت تماس'], new: ['نوع تماس', 'شماره و نام', 'ثبت تماس'] } as const;

export function IncomingWizard({ currentNo, onClose, onSaved, onEvent }: {
  currentNo: number | null; onClose: (why: 'cancel' | 'done') => void; onSaved: (msg: string) => void; onEvent?: (name: string) => void;
}) {
  const ev = (n: string) => onEvent?.(n);
  const [step, setStep] = useState<Step>('choose');
  const [path, setPath] = useState<'old' | 'new'>('old');
  const [phone, setPhone] = useState(''); const [name, setName] = useState('');
  const [cust, setCust] = useState<{ id: number; name: string } | null>(null); const [created, setCreated] = useState(false);
  const [owner, setOwner] = useState<{ name: string; notified: boolean; cust?: string; refToken?: string | null; referable?: boolean; referred?: boolean } | null>(null);
  const [refd, setRefd] = useState<{ at: string; already: boolean } | null>(null);
  const [live, setLive] = useState<{ q: string; r: ElSuggest } | null>(null); const [tail, setTail] = useState(''); const seq = useRef(0);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const [fcOpen, setFcOpen] = useState(false); const [confirm, setConfirm] = useState(false); const [kind, setKind] = useState('');
  const dlg = useRef<HTMLDivElement>(null);
  /** PM (c): leaving the call step unsaved asks first; nothing is logged on discard (the created customer stays, owner = this expert). */
  const close = (why: 'cancel' | 'done', force = false) => {
    if (!force && step === 'log' && why === 'cancel') { setConfirm(true); return; }
    if (step === 'other') ev('incoming_other_closed'); onClose(why);
  };
  useEffect(() => { dlg.current?.querySelector<HTMLElement>('input:not([readonly]),.iw-opt,.tc-foot .btn-primary')?.focus(); }, [step]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && !fcOpen) close(step === 'ok' ? 'done' : 'cancel'); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });
  const backTxt = currentNo ? `برگشت به کار ${faNum(currentNo)}` : 'برگشت به کارها';
  const ph = phone11(phone);
  const go = (s: Step) => { setErr(''); setStep(s); };
  const pick = (p: 'old' | 'new') => { void elApi.choose(p === 'old' ? 'own' : 'new').catch(() => undefined); setPath(p); go(p === 'old' ? 'old_phone' : 'new_form'); ev(p === 'old' ? 'incoming_search' : 'incoming_new_open'); };
  const badPhone = () => setErr('شماره‌ی موبایل کامل ۱۱ رقمی را بنویس (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).');
  useEffect(() => { // SEARCH-65b live list: 250 ms debounce, stale answers dropped, aborted on change (same as LockedInbound)
    const q = phone.trim(); if (step !== 'old_phone' || !liveQueryReady(q)) { setLive(null); return; }
    const my = ++seq.current; const ac = new AbortController();
    const t = window.setTimeout(() => { elApi.suggest(q, ac.signal).then((r) => { if (seq.current === my) setLive({ q, r }); }).catch(() => undefined); }, 250);
    return () => { window.clearTimeout(t); ac.abort(); };
  }, [phone, step]);
  const pickLive = async (id: number, last4: string) => {
    setBusy(true); setErr('');
    try { const r = await elApi.pick(id);
      if (r.result === 'own') { setTail(last4); setCust(r.customer); setCreated(false); setLive(null); setStep('own'); ev('incoming_live_pick'); } else setErr('message' in r ? r.message : 'باز نشد.');
    } catch (e) { setErr(e instanceof Error ? e.message : 'باز نشد.'); } finally { setBusy(false); }
  };
  const findOld = async () => {
    if (!ph) return badPhone(); setBusy(true); setErr(''); setTail('');
    try { const r: ElSearch = await elApi.search(ph);
      if (r.result === 'own') { setCust(r.customer); setCreated(false); setStep('own'); }
      else if (r.result === 'other') { setOwner({ name: r.ownerName, notified: r.notified, cust: r.name, refToken: r.refToken, referable: r.referable, referred: r.referred }); setRefd(null); setStep('other'); ev('incoming_other'); }
      else if (r.result === 'none') setStep('none');
      else setErr(r.message);
    } catch (e) { setErr(e instanceof Error ? e.message : 'جست‌وجو انجام نشد.'); } finally { setBusy(false); }
  };
  const create = async () => {
    if (!ph) return badPhone();
    const n = name.replace(/\s+/g, ' ').trim();
    if (n.length < 3 || !n.includes(' ') || /[\d۰-۹]/.test(n)) { setErr('نام و نام خانوادگی را کامل بنویس (بدون عدد).'); return; }
    setBusy(true); setErr('');
    try { const r = await elApi.create({ phone: ph, name: n }); // server: duplicate check first; never creates a duplicate
      if (r.result === 'created') { setCust(r.customer); setCreated(true); setStep('log'); ev('incoming_new_created'); onSaved(`${r.customer.name} ساخته شد · مشتری خودت`); }
      else if (r.result === 'duplicate') {
        if (r.mine) { const s = await elApi.search(ph); if (s.result === 'own') { setCust(s.customer); setCreated(false); setStep('dup'); return; } }
        setOwner({ name: r.mine ? 'خودت' : r.ownerName, notified: !!r.notified }); setStep('other');
      } else setErr('message' in r ? r.message : 'ثبت نشد.');
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  const refer = async () => {
    if (!owner?.refToken) return; setBusy(true); setErr('');
    try { const r = await elApi.refer(owner.refToken);
      if (r.result === 'referred') { setRefd({ at: r.at, already: r.already }); setStep('referred'); ev('incoming_referred'); }
      else setErr(r.message);
    } catch (e) { setErr(e instanceof Error ? e.message : 'ارجاع انجام نشد.'); } finally { setBusy(false); }
  };
  const saved = (m: string) => { ev(created ? 'incoming_new_saved' : 'incoming_own_saved'); setOk(m); setStep('ok'); onSaved(m); };
  // v1.1: new path = 3 steps; for the qualifier step 3 is the first-call form (call + form, one save).
  const P = path === 'new' && kind === 'simple' ? ['نوع تماس', 'شماره و نام', 'فرم تماس اول'] : PATHS[path];
  const stepNo = step === 'choose' ? 1 : step === 'old_phone' || step === 'new_form' || step === 'dup' || step === 'none' ? 2 : 3;
  const counted = step !== 'choose' && step !== 'none' && step !== 'ok' && step !== 'referred';
  const title = { choose: 'کی زنگ زد؟', old_phone: 'مشتری قبلی: شماره‌اش را بزن', own: 'مشتری خودت است', other: 'این مشتری مال همکار است', referred: SC.referredTitle(owner?.name ?? ''), none: 'این شماره در CRM نیست',
    new_form: 'مشتری جدید: فقط شماره و نام', dup: 'این شماره از قبل هست', log: 'ثبت تماس با مشتری جدید', ok: 'ثبت شد' }[step];
  const phoneIn = (ro: boolean, lv = false) => <>
    <label htmlFor="iw-phone">{lv ? 'شماره یا نام تماس‌گیرنده*' : 'شماره‌ی تماس‌گیرنده*'} <small>{ro ? 'از مرحله‌ی قبل' : lv ? 'چند رقم یا نام' : 'دقیق، ۱۱ رقم'}</small></label>
    <input id="iw-phone" className={ro ? 'ro' : undefined} readOnly={ro} value={ro ? faNum(ph ?? phone) : phone} onChange={(e) => setPhone(e.target.value)} placeholder={lv ? '۰۹۱۲… یا نام مشتری' : '۰۹۱۲۱۲۳۴۵۶۷'} inputMode={lv ? 'text' : 'tel'} dir={lv ? 'auto' : 'ltr'} autoComplete="off" data-testid="iw-phone" /></>;
  const telBtn = ph ? <a className="btn btn-primary iw-tel" href={`tel:${ph}`} data-testid="iw-tel-call"><Phone size={15} aria-hidden="true" /> تماس</a> : null;
  const hit = (kind: 'own' | 'new' | 'dup') => <div className={`tc-hit${kind === 'own' ? '' : ` ${kind}`}`} data-testid={`iw-hit-${kind}`}>
    {kind === 'new' ? <Plus size={18} aria-hidden="true" /> : kind === 'dup' ? <AlertTriangle size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
    <div><b>{cust?.name} <span className="dp-id">#{faNum(cust?.id ?? 0)}</span></b><small><span className="dp-chip l-own" data-testid="iw-own-badge">{SC.own}</span> {kind === 'new' ? 'ساخته شد · ' : ''}<bdi dir="ltr" data-testid="iw-tel">{ph ? maskTel(ph) : tail ? `••••${faNum(tail)}` : ''}</bdi>{kind === 'dup' ? ' · مشتری تازه ساخته نشد' : ''}</small>
      {kind === 'own' && cust ? <span className="iw-links"><a href={`/customers/${cust.id}`} target="_blank" rel="noopener" data-testid="iw-file"><FileText size={13} aria-hidden="true" /> پرونده</a> · <a href={`/customers/${cust.id}#sec-calls`} target="_blank" rel="noopener" data-testid="iw-history">تاریخچه و یادداشت‌ها</a></span> : null}</div>
    {kind === 'dup' ? null : telBtn ?? (cust ? <PickedTel id={cust.id} /> : null)}</div>;
  return <div className="tc-ov" role="presentation" style={fcOpen ? { display: 'none' } : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) close(step === 'ok' ? 'done' : 'cancel'); }}>
    <div className="tc-dlg iw-dlg" role="dialog" aria-modal="true" aria-labelledby="iw-h" ref={dlg} data-testid="iw-wizard" data-step={step} data-path={path}>
      <div className="tc-dlg-h"><div><small className="dp-hint"><PhoneIncoming size={13} aria-hidden="true" /> تماس ورودی{counted ? ` · مرحله‌ی ${faNum(stepNo)} از ${faNum(P.length)}` : ''}</small>
        <h2 id="iw-h">{title}</h2>
        {counted ? <ol className="tc-stp" aria-hidden="true">{P.map((t, i) => <li key={t} className={i + 1 <= stepNo ? 'on' : ''}>{t}</li>)}</ol> : null}
        {counted ? <div className="iw-wbar" aria-hidden="true"><i style={{ width: `${Math.round(100 * stepNo / P.length)}%` }} /></div> : null}</div>
        <button type="button" className="dp-x" onClick={() => close(step === 'ok' ? 'done' : 'cancel')} aria-label="بستن" disabled={busy} data-testid="iw-x"><X size={18} /></button></div>

      {step === 'choose' ? <div className="iw-opts" role="group" aria-label="نوع مشتری">
        <button type="button" className="iw-opt" onClick={() => pick('old')} data-testid="iw-old"><User size={26} aria-hidden="true" /><b>مشتری قبلیه</b><small>شماره‌اش در CRM هست؛ پیدا کن و تماس را ثبت کن</small></button>
        <button type="button" className="iw-opt nw" onClick={() => pick('new')} data-testid="iw-new"><Plus size={26} aria-hidden="true" /><b>مشتری جدیده، تازه زنگ زده</b><small>اولین تماسش است؛ با شماره و نام بساز، بعد تماس را ثبت کن</small></button>
        <div className="tc-foot"><button type="button" className="btn btn-ghost" onClick={() => close('cancel')} data-testid="iw-cancel">انصراف</button></div>
      </div> : null}

      {step === 'old_phone' ? <form onSubmit={(e) => { e.preventDefault(); void findOld(); }} className="tc-form" role="search">
        {phoneIn(false, true)}
        <p className="dp-hint" data-testid="iw-hint"><Search size={13} aria-hidden="true" /> {SC.hint}</p>
        {live && live.r.result === 'ok' && live.r.items.length ? <ul className="el-live" data-testid="iw-live" aria-label="مشتری‌های خودت">
          {live.r.items.map((it) => <li key={it.id}><button type="button" className="el-live-row" disabled={busy} onClick={() => void pickLive(it.id, it.phoneLast4)} data-testid={`iw-live-${it.id}`}>
            <b>{it.name}</b><span className="dp-chip l-own" data-testid="iw-live-own">{SC.own}</span><span className="el-live-ph" dir="ltr">••••{faNum(it.phoneLast4)}</span>
            {it.priority && it.priority >= 1 && it.priority <= 3 ? <span className={`dp-chip p${it.priority}`}>{`اولویت ${faNum(it.priority)}`}</span> : null}
            {it.match === 'exact' ? <span className="dp-chip l-exact">{live.r.result === 'ok' && live.r.kind === 'phone' ? 'همین شماره' : 'همین نام'}</span> : null}</button></li>)}</ul> : null}
        {live && live.r.result === 'ok' && !live.r.items.length && live.q === phone.trim() ? <p className="dp-box sm" role="status" data-testid="iw-live-none"><Info size={14} aria-hidden="true" /> بین مشتری‌های خودت پیدا نشد{ph ? ' — «پیدا کن» را بزن تا مشتری همکار یا «مشتری جدید» را ببینی.' : '.'}</p> : null}
        {live && live.r.result === 'rate_limited' ? <p className="dp-box sm" role="status" data-testid="iw-live-limited">{live.r.message}</p> : null}
        <div className="tc-foot"><button type="submit" className="btn btn-primary" disabled={busy} data-testid="iw-find"><Search size={15} aria-hidden="true" /> {busy ? 'در حال جست‌وجو…' : 'پیدا کن'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => go('choose')} disabled={busy} data-testid="iw-back"><ChevronRight size={15} aria-hidden="true" /> قبلی</button></div>
      </form> : null}

      {confirm ? <div className="tc-form" role="alertdialog" aria-labelledby="iw-cf-h" data-testid="iw-confirm">
        <div className="tc-hit dup"><AlertTriangle size={18} aria-hidden="true" /><div><b id="iw-cf-h">بستن بدون ثبت تماس؟</b>
          <small>مشتری ثبت شده و به نام خودت می‌ماند، ولی این تماس ثبت نمی‌شود.</small></div></div>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => setConfirm(false)} data-testid="iw-confirm-stay">ادامهٔ ثبت</button>
          <button type="button" className="btn btn-ghost" onClick={() => { ev('incoming_discard'); close('cancel', true); }} data-testid="iw-confirm-discard">بستن بدون ثبت</button></div>
      </div> : null}
      {!confirm && step === 'own' && cust ? <LogCall customer={cust} phone={ph} currentNo={currentNo} saveLabel="ثبت تماس" onSaved={saved} extra={hit('own')} onFormOpen={setFcOpen} onUnsaved={() => { ev('incoming_discard'); close('cancel', true); }} onKind={setKind} isNew={false} /> : null}
      {!confirm && step === 'log' && cust ? <LogCall customer={cust} phone={ph} currentNo={currentNo} saveLabel="ثبت تماس و فرم تماس اول" onSaved={saved} extra={hit('new')} onFormOpen={setFcOpen} onUnsaved={() => { ev('incoming_discard'); close('cancel', true); }} onKind={setKind} isNew={true} /> : null}

      {step === 'dup' && cust ? <div className="tc-form">{hit('dup')}
        <p className="dp-hint"><Lock size={13} aria-hidden="true" /> اگر مال همکار بود فقط نام کارشناسش را می‌بینی.</p>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => go('own')} data-testid="iw-dup-log">برو به ثبت تماس</button>
          <button type="button" className="btn btn-ghost" onClick={() => go('new_form')}><ChevronRight size={15} aria-hidden="true" /> قبلی</button></div>
      </div> : null}

      {step === 'other' && owner && owner.cust ? <div className="tc-form">
        <div className="tc-hit oth" role="status" data-testid="iw-other"><Lock size={18} aria-hidden="true" /><div>
          <b data-testid="iw-other-name">{owner.cust}</b>
          <small data-testid="iw-owner">{SC.belongs(owner.name)}</small>
          {owner.referred ? <small data-testid="iw-other-referred">{SC.already}</small> : null}
          {!owner.referable ? <small data-testid="iw-other-noref">{SC.notReferable}</small> : null}</div></div>
        <div className="tc-foot">{owner.referable && owner.refToken ? <button type="button" className="btn btn-primary" onClick={() => void refer()} disabled={busy} data-testid="iw-refer"><Send size={15} aria-hidden="true" /> {busy ? SC.referring : SC.referTo(owner.name)}</button> : null}
          <button type="button" className={owner.referable && owner.refToken ? 'btn btn-ghost' : 'btn btn-primary'} onClick={() => close('done')} disabled={busy} data-testid="iw-close-other">{SC.close}</button></div>
      </div> : null}
      {step === 'other' && owner && !owner.cust ? <div className="tc-form">
        <div className="tc-hit oth" role="status" data-testid="iw-other"><Lock size={18} aria-hidden="true" /><div>
          <b data-testid="iw-owner">کارشناس این مشتری: {owner.name}</b>
          <small>{owner.name === 'خودت' ? 'این شماره مال خودت است.' : `جزئیات نشان داده نمی‌شود. بگو ${owner.name} با او تماس می‌گیرد.`}</small></div></div>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => close('done')} data-testid="iw-close-other">بستن و {backTxt}</button></div>
      </div> : null}
      {step === 'referred' && owner && refd ? <div className="tc-form">
        <div className="tc-hit" role="status" data-testid="iw-referred"><Check size={18} aria-hidden="true" /><div>
          <b>{owner.cust}</b><small>{SC.referredLine(owner.name, tehHm(refd.at))}</small></div></div>
        <ul className="iw-ref-list" data-testid="iw-referred-list">
          {refd.already ? <li>{SC.already}</li> : <li>{SC.b1(owner.name)}</li>}
          <li>{SC.b2(owner.name)}</li><li>{SC.b3}</li></ul>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => close('done')} data-testid="iw-close-referred">بستن و {backTxt}</button></div>
      </div> : null}

      {step === 'none' ? <div className="tc-form">
        {phoneIn(true)}
        <div className="tc-hit new" role="status" data-testid="iw-none"><Search size={18} aria-hidden="true" /><div><b>مشتری‌ای با این شماره پیدا نشد</b><small>اگر تازه زنگ زده، همین‌جا بسازش؛ شماره خودش پر می‌شود.</small></div></div>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => { void elApi.choose('new').catch(() => undefined); setPath('new'); ev('incoming_new_open'); go('new_form'); }} data-testid="iw-none-new"><Plus size={15} aria-hidden="true" /> مشتری جدیده، با همین شماره</button>
          <button type="button" className="btn btn-ghost" onClick={() => go('old_phone')} data-testid="iw-none-fix"><Pencil size={15} aria-hidden="true" /> شماره را درست کن</button></div>
      </div> : null}

      {step === 'new_form' ? <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="tc-form">
        {phoneIn(false)}
        <label htmlFor="iw-name">نام و نام خانوادگی*</label>
        <input id="iw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً علی رضایی" autoComplete="off" data-testid="iw-name" />
        <p className="tc-xol"><Info size={13} aria-hidden="true" /> اول تکراری‌بودن شماره بررسی می‌شود؛ مشتری تکراری ساخته نمی‌شود · مالک = خودت · پیامکی فرستاده نمی‌شود</p>
        <div className="tc-foot"><button type="submit" className="btn btn-primary" disabled={busy} data-testid="iw-create"><Plus size={15} aria-hidden="true" /> {busy ? 'در حال بررسی…' : 'بررسی و ساختن'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => go('choose')} disabled={busy}><ChevronRight size={15} aria-hidden="true" /> قبلی</button></div>
      </form> : null}

      {step === 'ok' ? <div className="tc-form"><p className="dp-box ok sm" role="status" data-testid="iw-ok"><Check size={14} aria-hidden="true" /> {ok}</p>
        <div className="tc-foot"><button type="button" className="btn btn-primary" onClick={() => onClose('done')} data-testid="iw-done">{backTxt}</button></div></div> : null}
      {err ? <p className="dp-err" role="alert" data-testid="iw-err">{err}</p> : null}
    </div>
  </div>;
}
