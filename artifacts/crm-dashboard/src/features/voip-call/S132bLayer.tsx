/** SIMOTEL-132 B (design simotel v1.3.2 §7.1 `in_*`, §10 `out_*`, §11): calls the expert takes or dials on the VoIP phone itself.
 *  Flag off → this renders nothing and sends nothing: it only reads the after-call queue the popup already fetches, and starts its own
 *  small poll only when that payload carries the `s132b` key (present only while flag.simotel132b is on for this user). */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, Copy, FileText, Headset, Lock, PhoneOutgoing, Search, User, UserPlus, X } from 'lucide-react';
import { getGetAuthSessionQueryKey, getListPendingVoipAfterCallsQueryKey, useGetAuthSession, useListPendingVoipAfterCalls } from '@workspace/api-client-react';
import { useTabState } from '@/lib/tab-coordinator';
import { faClock, faNum } from '@/features/call-queue/api';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { IncomingWizard } from '@/features/expert-lockdown/IncomingWizard';
import { s132bApi, useS132bLive, VcError, VC_ME_KEY, S132B_LIVE_KEY, S132B_MISSED_KEY, type S132bCard } from './api';
import './s132b.css';

/** Passive: true only while the cached /voip/after-call/pending payload says B is on for this user. Never fetches by itself. */
export function useS132bOn(): boolean {
  const q = useListPendingVoipAfterCalls({ query: { queryKey: getListPendingVoipAfterCallsQueryKey(), enabled: false } });
  return Boolean((q.data as any)?.s132b?.on);
}
export const faDur = (s: number | null | undefined) => {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${faNum(m)} دقیقه${r ? ` و ${faNum(r)} ثانیه` : ''}` : `${faNum(r)} ثانیه`;
};
export function CopyBtn({ text, testId = 's1b-copy' }: { text: string; testId?: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="s1b-ib" aria-label="کپی شماره" data-testid={testId}
    onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); window.setTimeout(() => setOk(false), 1500); }).catch(() => undefined); }}>
    {ok ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}</button>;
}
export const PhoneRow = ({ p }: { p: string }) => <div className="s1b-ph"><span className="s1b-phl">شماره</span><bdi dir="ltr">{faNum(p)}</bdi><CopyBtn text={p} /></div>;

export function S132bLayer() {
  const on = useS132bOn();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  if (!on || !user || user.role === 'admin') return null;
  return <S132bOnLayer userId={Number(user.id)} />;
}

function S132bOnLayer({ userId }: { userId: number }) {
  const { visible } = useTabState();
  const qc = useQueryClient();
  const q = useS132bLive(true, visible);
  const cards = q.data?.cards ?? [];
  const [gone, setGone] = useState<number[]>([]);
  const [form, setForm] = useState<{ id: number; c: { id: number; name: string; phone: string; priority: number | null } } | null>(null);
  const [wiz, setWiz] = useState<string | null>(null);
  const busyRef = useRef<boolean | undefined>(undefined);
  const busy = q.data?.busy ?? false;
  useEffect(() => { // the VoIP button lock and the lists follow the live state
    if (busyRef.current !== undefined && busyRef.current !== busy) {
      void qc.invalidateQueries({ queryKey: VC_ME_KEY }); void qc.invalidateQueries({ queryKey: S132B_MISSED_KEY });
      if (!busy) { void qc.invalidateQueries({ queryKey: ['daily-plan'] }); void qc.invalidateQueries({ queryKey: ['voip-call', 'history'] }); }
    }
    busyRef.current = busy;
  }, [busy, qc]);
  const ff = cards.find((c) => c.firstForm && c.customer && c.phone);
  useEffect(() => { // Q14: the qualifier's first-call form opens once by itself after an answered call to a new number
    if (!ff || form) return;
    setForm({ id: ff.id, c: { id: ff.customer!.id, name: ff.customer!.name, phone: ff.phone!, priority: ff.customer!.priority } });
    void s132bApi.formOpened(ff.id).catch(() => undefined);
  }, [ff?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { void qc.invalidateQueries({ queryKey: S132B_LIVE_KEY }); void qc.invalidateQueries({ queryKey: VC_ME_KEY }); };
  const close = (id: number) => { setGone((g) => [...g, id]); void s132bApi.close(id).catch(() => undefined).finally(refresh); };
  const shown = cards.filter((c) => !gone.includes(c.id));
  const inc = shown.filter((c) => c.direction === 'incoming').slice(0, 2);
  const out = shown.filter((c) => c.direction !== 'incoming').slice(0, 2);
  return <>
    {inc.length ? <div className="s1b-top" data-testid="s1b-top">{inc.map((c) => <InCard key={c.id} c={c} onClose={() => close(c.id)} onNew={(p) => setWiz(p)} />)}</div> : null}
    {out.length ? <div className="s1b-bot" data-testid="s1b-bot">{out.map((c) => <OutToast key={c.id} c={c} onClose={() => close(c.id)} onSaved={refresh} />)}</div> : null}
    {form ? <SimpleCallForm customer={form.c} userId={userId} voip={{ callId: form.id, b: true }} eyebrow="تماس بیرون از صف"
      onClose={() => { setForm(null); refresh(); }} onDone={() => { void qc.invalidateQueries({ queryKey: ['daily-plan'] }); }} onNext={() => { setForm(null); refresh(); }} /> : null}
    {wiz ? <IncomingWizard currentNo={null} presetPhone={wiz} onClose={() => setWiz(null)} onSaved={() => { void qc.invalidateQueries({ queryKey: ['daily-plan'] }); refresh(); }} /> : null}
  </>;
}

const isAns = (c: S132bCard) => String(c.status).toUpperCase() === 'ANSWERED';
const ringing = (c: S132bCard) => c.live && String(c.status).toUpperCase() === 'RINGING';

function NoteBox({ c }: { c: S132bCard }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false); const [v, setV] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const n = c.note; if (!n || !isAns(c) || c.live) return null;
  const save = async () => {
    if (busy) return; setBusy(true); setErr('');
    try { await s132bApi.note(c.id, v); setEdit(false); void qc.invalidateQueries({ queryKey: S132B_LIVE_KEY }); }
    catch (e) { setErr(e instanceof VcError ? e.message : 'ثبت نشد؛ دوباره بزن.'); } finally { setBusy(false); }
  };
  if (edit) return <div className="s1b-note"><label className="s1b-lbl" htmlFor={`s1b-n-${c.id}`}>یادداشت</label>
    <textarea id={`s1b-n-${c.id}`} value={v} maxLength={500} rows={3} onChange={(e) => setV(e.target.value)} data-testid="s1b-note-in" />
    {err ? <p className="s1b-err" role="alert">{err}</p> : null}
    <div className="s1b-acts"><button type="button" className="btn btn-primary" disabled={busy || !v.trim()} onClick={() => void save()} data-testid="s1b-note-save">ذخیره</button>
      <button type="button" className="btn btn-ghost" onClick={() => setEdit(false)}>انصراف</button></div></div>;
  if (n.state === 'pending') return <div className="s1b-note" data-testid="s1b-note-pending"><span className="vc-chip q">در حال نوشتن خلاصه</span>
    <p className="s1b-mut">یادداشت از خلاصه‌ی تماس خودش نوشته می‌شود؛ لازم نیست منتظر بمانی.</p></div>;
  if (n.text) return <div className="s1b-note" data-testid="s1b-note-ready"><div className="s1b-nh"><b>{n.edited ? 'یادداشت' : 'یادداشت از خلاصه‌ی تماس'}</b>
    <button type="button" className="s1b-lnk" onClick={() => { setV(n.text ?? ''); setEdit(true); }} data-testid="s1b-note-edit">ویرایش</button></div><p>{n.text}</p></div>;
  return <div className="s1b-note" data-testid="s1b-note-none"><button type="button" className="s1b-lnk" onClick={() => { setV(''); setEdit(true); }} data-testid="s1b-note-write">نوشتن یادداشت</button></div>;
}

function InCard({ c, onClose, onNew }: { c: S132bCard; onClose: () => void; onNew: (phone: string) => void }) {
  const cu = c.customer;
  const head = c.live ? (ringing(c) ? 'تماس ورودی؛ تلفن ویپ شما زنگ می‌خورد' : 'تماس ورودی؛ در مکالمه')
    : `تماس ورودی تمام شد: ${isAns(c) ? 'پاسخ داد' : 'بی‌پاسخ'}`;
  const support = c.cls === 'support';
  return <section className={`s1b-card${c.live ? ' live' : ''}`} role="region" aria-live="polite" aria-label={head} data-testid="s1b-in" data-cls={c.cls} data-live={c.live ? '1' : '0'}>
    <header className="s1b-h"><span className={`s1b-ic${ringing(c) ? ' rg' : ''}`}><Headset size={20} aria-hidden="true" /></span>
      <div><h3>{head}</h3><p>{c.live ? <>داخلی <bdi>{faNum(c.extension ?? '')}</bdi>؛ جواب دادن و قطع تماس از خود تلفن ویپ است.</> : c.durationSeconds ? <>مدت {faDur(c.durationSeconds)} · ساعت {faClock(c.startedAt)}</> : <>ساعت {faClock(c.startedAt)}</>}</p></div>
      <button type="button" className="s1b-x" onClick={onClose} aria-label="بستن پنجره" data-testid="s1b-close"><X size={18} aria-hidden="true" /></button></header>
    <div className="s1b-b">
      {cu ? <>
        <div className="s1b-nm"><b>{cu.name}</b><span className="s1b-id">#{faNum(cu.id)}</span>
          {c.cls === 'own' ? <span className="vc-chip s"><User size={13} aria-hidden="true" />مشتری خودت</span> : support ? <span className="vc-chip q">پشتیبانی</span> : null}</div>
        {c.cls !== 'own' ? <p className="s1b-mut">کارشناس: {cu.ownerName ?? 'بدون کارشناس'}{support ? ' (فقط برای اطلاع)' : ''}</p> : null}
        {c.phone ? <PhoneRow p={c.phone} /> : null}
        {cu.lastCallAt && c.live ? <p className="s1b-last">آخرین تماس: {faNum(new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(cu.lastCallAt)))}</p> : null}
        {c.cls === 'other' && c.live ? <p className="s1b-mut">مشتری کارشناس دیگر است؛ انتقال تماس از خود تلفن ویپ است.</p> : null}
        {!c.live ? <NoteBox c={c} /> : null}
        {c.cls === 'own' || support ? <div className="s1b-acts"><Link href={`/customers/${cu.id}`} className="btn btn-primary" data-testid="s1b-open"><FileText size={16} aria-hidden="true" />{support ? 'باز کردن پرونده (نمای ثبت‌نام)' : 'باز کردن پرونده'}</Link>
          {!c.live ? <button type="button" className="btn btn-ghost" onClick={onClose}>بستن</button> : null}</div> : null}
      </> : c.cls === 'hidden' ? <>
        <div className="s1b-nm"><b>شماره نمایش داده نشد</b></div>
        <div className="s1b-acts"><Link href="/customers" className="btn btn-ghost" data-testid="s1b-search"><Search size={16} aria-hidden="true" />جست‌وجو</Link></div>
      </> : <>
        <div className="s1b-nm"><b>شماره ناشناس</b></div>
        {c.phone ? <PhoneRow p={c.phone} /> : null}
        <div className="s1b-acts">{c.phone ? <button type="button" className="btn btn-primary" onClick={() => onNew(c.phone!)} data-testid="s1b-new"><UserPlus size={16} aria-hidden="true" />ثبت مشتری جدید</button> : null}
          <Link href="/customers" className="btn btn-ghost" data-testid="s1b-search"><Search size={16} aria-hidden="true" />جست‌وجو</Link></div>
      </>}
      {c.live && c.cls === 'own' ? <p className="s1b-foot"><Lock size={13} aria-hidden="true" />کار جاری و نوبت عوض نمی‌شود. این تماس خودکار به پرونده‌ی {cu?.name} وصل می‌شود.</p> : null}
    </div>
  </section>;
}

function OutToast({ c, onClose, onSaved }: { c: S132bCard; onClose: () => void; onSaved: () => void }) {
  const cu = c.customer;
  const [name, setName] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: number; name: string } | null>(null);
  const savedOwn = !c.live && c.saved && c.cls === 'own';
  useEffect(() => { if (!savedOwn) return; const t = window.setTimeout(onClose, 8000); return () => window.clearTimeout(t); }, [savedOwn]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (busy) return; setBusy(true); setErr('');
    try { const r = await s132bApi.name(c.id, name); setMade({ id: r.customer.id, name: r.customer.name }); onSaved(); }
    catch (e) { setErr(e instanceof VcError ? e.message : 'ذخیره نشد؛ دوباره بزن.'); } finally { setBusy(false); }
  };
  const created = made ?? (c.createdCustomer && cu && cu.name !== 'بدون نام' ? { id: cu.id, name: cu.name } : null);
  let body: React.ReactNode;
  if (c.cls === 'new' && !created) {
    body = <><div className="s1b-th"><UserPlus size={16} aria-hidden="true" /><b>شماره‌ی تازه، در CRM نیست</b></div>
      {c.phone ? <PhoneRow p={c.phone} /> : null}
      <form className="s1b-nf" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="s1b-lbl" htmlFor={`s1b-nm-${c.id}`}>نام مشتری</label>
        <div className="s1b-nfr"><input id={`s1b-nm-${c.id}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="نام و نام خانوادگی" autoComplete="off" data-testid="s1b-name" />
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()} data-testid="s1b-name-save"><Check size={16} aria-hidden="true" />ذخیره</button></div>
        {err ? <p className="s1b-err" role="alert" data-testid="s1b-err">{err}</p> : null}
        <p className="s1b-mut">با اولویت ۱ در پنل خودت ساخته می‌شود؛ گزارش و خلاصه‌ی تماس خودکار اضافه می‌شوند. اگر نام ننویسی: «بدون نام».</p>
      </form></>;
  } else if (c.cls === 'new' && created) {
    body = <div className="s1b-th ok" data-testid="s1b-made"><Check size={16} aria-hidden="true" /><span>مشتری <b>{created.name}</b> #{faNum(created.id)} ساخته شد، اولویت ۱</span>
      <Link href={`/customers/${created.id}`} className="s1b-lnk">پرونده</Link></div>;
  } else if (cu && c.cls === 'own') {
    body = <div className={`s1b-th${savedOwn ? ' ok' : ''}`} data-testid={savedOwn ? 's1b-out-saved' : 's1b-out-live'}><PhoneOutgoing size={16} aria-hidden="true" />
      <span>{c.live ? <>تماس خروجی بیرون از صف با <b>{cu.name}</b> #{faNum(cu.id)}</> : savedOwn ? <>تماس خروجی <b>{cu.name}</b> #{faNum(cu.id)} ثبت شد</> : <>تماس خروجی <b>{cu.name}</b> #{faNum(cu.id)} تمام شد</>}</span>
      {!c.live ? <Link href={`/customers/${cu.id}`} className="s1b-lnk" data-testid="s1b-hist">سابقه</Link> : null}</div>;
  } else if (cu) {
    body = <><div className="s1b-th"><PhoneOutgoing size={16} aria-hidden="true" /><span><b>{cu.name}</b> #{faNum(cu.id)}</span>{c.cls === 'support' ? <span className="vc-chip q">پشتیبانی</span> : null}</div>
      <p className="s1b-mut">کارشناس: {cu.ownerName ?? 'بدون کارشناس'}{c.cls === 'support' ? ' (فقط برای اطلاع)' : ''}</p>
      {c.phone ? <PhoneRow p={c.phone} /> : null}
      {c.cls === 'other' ? <p className="s1b-mut" data-testid="s1b-other">برای تو مشتری ساخته نمی‌شود.</p> : null}</>;
  } else {
    body = <div className="s1b-th"><PhoneOutgoing size={16} aria-hidden="true" /><b>{c.cls === 'hidden' ? 'شماره نمایش داده نشد' : 'تماس خروجی بیرون از صف'}</b></div>;
  }
  return <section className="s1b-toast" role="status" data-testid="s1b-out" data-cls={c.cls} data-live={c.live ? '1' : '0'}>
    <button type="button" className="s1b-x" onClick={onClose} aria-label="بستن" data-testid="s1b-close"><X size={16} aria-hidden="true" /></button>
    {body}
  </section>;
}
