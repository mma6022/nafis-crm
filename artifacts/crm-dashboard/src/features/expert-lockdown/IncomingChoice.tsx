/** NEWCUST-65 «تماس ورودی داشتم» (expert_lockdown, interim ahead of incoming2-59): two options for a customer who called the expert's own line.
 *  1) «جزو مشتری‌های منه» → the existing exact search (LockedInbound).
 *  2) «ثبت مشتری جدید» → 3 steps: phone (server exact-duplicate check, owner name only) → name → log the call.
 *     The server makes this expert the owner and registrar, lead source «تماس ورودی», and sends no SMS / Telegram / notification.
 *     Logging: the CRM's own rule (useCallLauncher) → the first-call form (SimpleCallForm) for the qualifier, else «خارج از لیست» (POST /calls). */
import { useState } from 'react';
import { Check, FileText, Info, Lock, PhoneIncoming, UserPlus, UserRound, X } from 'lucide-react';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { MoreFields, Stepper, WizardActions, type WizardStep } from '@/components/wizard/Wizard';
import { announceCallSaved } from '@/features/call-queue/api';
import { useCallLauncher } from '@/features/team-sales/useCallLauncher';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { elApi, type ElNew } from './api';
import { LockedInbound } from './IncomingCall';
import { OutOfListLog } from './OutOfListLog';
import './lockdown.css';

type Opt = 'own' | 'new' | null;
type StepKey = 'phone' | 'name' | 'log';
const STEPS: readonly WizardStep<StepKey>[] = [{ key: 'phone', title: 'شماره موبایل' }, { key: 'name', title: 'نام مشتری' }, { key: 'log', title: 'ثبت تماس' }];
const faNum = (v: string | number) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
const NAME_ERR = 'نام و نام خانوادگی مشتری را کامل بنویس (بدون عدد).';
const PHONE_ERR = 'شماره‌ی موبایل کامل ۱۱ رقمی را بنویس (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).';

export function LockedIncomingChoice({ onClose, onSaved, currentNo }: { onClose: () => void; onSaved: () => void; currentNo?: number | null }) {
  const [opt, setOpt] = useState<Opt>(null);
  if (opt === 'own') return <LockedInbound onClose={onClose} onSaved={onSaved} currentNo={currentNo} onBack={() => setOpt(null)} />;
  if (opt === 'new') return <NewCustomer onClose={onClose} onSaved={onSaved} currentNo={currentNo} onBack={() => setOpt(null)} />;
  return <section className="dp-inbound card" aria-labelledby="el-ch-h" data-testid="el-choice">
    <div className="dp-sheet-h"><div><small className="dp-hint"><PhoneIncoming size={13} aria-hidden="true" /> مشتری خودش به خط تو زنگ زده</small>
      <h2 id="el-ch-h">تماس ورودی داشتم</h2></div>
      <button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
    <div className="el-choice">
      <button type="button" className="el-opt" onClick={() => setOpt('own')} data-testid="el-choose-own">
        <UserRound size={20} aria-hidden="true" /><b>جزو مشتری‌های منه</b><small>با شماره‌ی کامل یا نام کامل پرونده‌اش را پیدا کن و تماس را «خارج از لیست» ثبت کن.</small></button>
      <button type="button" className="el-opt" onClick={() => setOpt('new')} data-testid="el-choose-new">
        <UserPlus size={20} aria-hidden="true" /><b>ثبت مشتری جدید</b><small>اول شماره را چک می‌کنیم؛ اگر تکراری نبود، مشتری به نام خودت ثبت می‌شود.</small></button>
    </div>
  </section>;
}

function NewCustomer({ onClose, onBack, onSaved, currentNo }: { onClose: () => void; onBack: () => void; onSaved: () => void; currentNo?: number | null }) {
  const [created, setCreated] = useState<{ id: number; name: string; phone: string } | null>(null); const [ok, setOk] = useState('');
  const [step, setStep] = useState<StepKey>('phone');
  const [phone, setPhone] = useState(''); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [dup, setDup] = useState<Extract<ElNew, { result: 'duplicate' }> | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const fail = (r: ElNew) => {
    if (r.result === 'duplicate') { setDup(r); setStep('phone'); return; }
    if (r.result === 'invalid' || r.result === 'rate_limited') { setErr(r.message); if (r.field === 'phone') setStep('phone'); else if (r.field) setStep('name'); }
  };
  const check = async () => {
    setErr(''); setDup(null); if (phone.replace(/[^\d۰-۹٠-٩]/g, '').length < 10) { setErr(PHONE_ERR); return; }
    setBusy(true);
    try { const r = await elApi.newCheck(phone); if (r.result === 'new') setStep('name'); else fail(r); }
    catch (e) { setErr(e instanceof Error ? e.message : 'بررسی انجام نشد.'); } finally { setBusy(false); }
  };
  const save = async () => {
    setErr(''); const n = name.replace(/\s+/g, ' ').trim();
    if (n.length < 3 || !n.includes(' ') || /[\d۰-۹٠-٩]/.test(n)) { setErr(NAME_ERR); return; }
    setBusy(true);
    try { const r = await elApi.create({ phone, name: n, description: note.trim() || undefined });
      if (r.result === 'created') { setCreated({ ...r.customer, phone }); setStep('log'); onSaved(); return; } fail(r);
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <section className="dp-inbound card" aria-labelledby="el-nw-h" data-testid="el-new">
    <div className="dp-sheet-h"><div><small className="dp-hint"><UserPlus size={13} aria-hidden="true" /> تماس ورودی · مرحله‌ی {faNum(STEPS.findIndex((s) => s.key === step) + 1)} از {faNum(STEPS.length)}</small>
      <h2 id="el-nw-h">ثبت مشتری جدید</h2></div>
      <button type="button" className="dp-x" onClick={onClose} aria-label="بستن" disabled={busy}><X size={18} /></button></div>
    <Stepper steps={STEPS} current={step} onGo={busy || created ? undefined : (k) => { if (k === 'phone') setStep(k); }} testPrefix="el-nw-step-" />
    {step === 'phone' ? <form onSubmit={(e) => { e.preventDefault(); void check(); }} className="el-nw-form">
      <label className="dp-hint" htmlFor="el-nw-phone">شماره موبایل مشتری</label>
      <input id="el-nw-phone" value={phone} onChange={(e) => { setPhone(e.target.value); setDup(null); }} placeholder="۰۹۱۲۱۲۳۴۵۶۷" inputMode="tel" dir="ltr" autoComplete="off" data-testid="el-nw-phone" />
      {dup ? <div className="el-owner" role="status" data-testid="el-nw-dup">
        <span><Lock size={14} aria-hidden="true" /> این شماره قبلاً ثبت شده است · مشتری جدید ساخته نشد</span>
        <b data-testid="el-nw-owner">کارشناس پرونده: {dup.mine ? 'خودت' : dup.ownerName}</b>
        <small>{dup.mine ? 'این مشتری مال خودت است؛ از گزینه‌ی «جزو مشتری‌های منه» پرونده را پیدا کن و تماس را ثبت کن.' : 'پرونده فقط برای کارشناس خودش باز است.'}</small>
        {dup.mine ? <button type="button" className="btn btn-ghost" onClick={onBack} data-testid="el-nw-to-own"><UserRound size={14} aria-hidden="true" /> رفتن به «جزو مشتری‌های منه»</button> : null}
      </div> : <p className="dp-hint"><Info size={13} aria-hidden="true" /> فقط تکراری بودن شماره چک می‌شود؛ اطلاعات مشتری دیگری نشان داده نمی‌شود.</p>}
      <WizardActions nextLabel="بررسی شماره" pending={busy} pendingLabel="در حال بررسی…" onBack={onBack} backLabel="برگشت به انتخاب" testPrefix="el-nw-phone" />
    </form> : null}
    {step === 'name' ? <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="el-nw-form">
      <p className="dp-box ok sm" data-testid="el-nw-new"><Check size={14} aria-hidden="true" /> شماره‌ی <bdi dir="ltr">{faNum(phone.trim())}</bdi> تکراری نیست.</p>
      <label className="dp-hint" htmlFor="el-nw-name">نام و نام خانوادگی</label>
      <input id="el-nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً علی رضایی" autoComplete="off" data-testid="el-nw-name" />
      <MoreFields label="توضیح (اختیاری)"><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} placeholder="مثلاً درباره‌ی وام خرید کالا پرسید" data-testid="el-nw-note" aria-label="توضیح" /></MoreFields>
      <dl className="el-nw-sum"><dt>منبع</dt><dd>تماس ورودی</dd><dt>کارشناس پرونده</dt><dd>خودت</dd></dl>
      <p className="dp-hint"><Info size={13} aria-hidden="true" /> پیامکی برای مشتری فرستاده نمی‌شود. بعد از ثبت، همین‌جا تماس را ثبت می‌کنی.</p>
      <WizardActions nextLabel="ثبت مشتری" pending={busy} pendingLabel="در حال ثبت…" onBack={() => setStep('phone')} testPrefix="el-nw-save" />
    </form> : null}
    {step === 'log' && created ? ok
      ? <div className="el-nw-form"><p className="dp-box ok sm" role="status" data-testid="el-nw-logged"><Check size={14} aria-hidden="true" /> {ok}</p>
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="el-nw-close">بستن</button></div>
      : <LogNew customer={created} currentNo={currentNo} onSaved={(m) => { setOk(m); onSaved(); }}
          extra={<p className="dp-box ok sm" data-testid="el-nw-created"><Check size={14} aria-hidden="true" /> {created.name} <span className="dp-id">#{faNum(created.id)}</span> به نام خودت ثبت شد. حالا نتیجه‌ی همین تماس را ثبت کن.</p>} /> : null}
    {err ? <p className="dp-err" role="alert" data-testid="el-nw-err">{err}</p> : null}
  </section>;
}

/** The new customer is this expert's own, in progress, no priority: the CRM's rule (useCallLauncher) decides the form —
 *  the qualifier (Kazemi) gets the existing first-call form, then the call is mirrored as a done «خارج از لیست»; others the regular «خارج از لیست» log. */
function LogNew({ customer, currentNo, onSaved, extra }: { customer: { id: number; name: string; phone: string }; currentNo?: number | null; onSaved: (m: string) => void; extra: React.ReactNode }) {
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const [fc, setFc] = useState(false); const [saved, setSaved] = useState('');
  const launcher = useCallLauncher(user, Boolean(user), () => setFc(true));
  const cust = { id: customer.id, name: customer.name, phone: customer.phone, salespersonId: user?.salespersonId ?? null, status: 'in_progress', priority: null };
  const kind = !user ? 'wait' : launcher.choose(cust);
  if (kind === 'wait' || kind === 'error') return <div className="el-nw-form">{extra}<p className="dp-hint" role="status" data-testid="el-nw-wait">{kind === 'error' ? 'تنظیمات فرم تماس بارگذاری نشد؛ دوباره امتحان کن.' : 'در حال آماده‌سازی فرم تماس…'}
    {kind === 'error' ? <button type="button" className="btn btn-ghost" onClick={launcher.retry}>تلاش دوباره</button> : null}</p></div>;
  if (kind === 'simple') {
    const finish = () => { setFc(false); if (saved) onSaved(saved); };
    return <div className="el-nw-form">{extra}
      <p className="dp-hint" data-testid="el-nw-first-hint"><Info size={13} aria-hidden="true" /> تماس اول این مشتری است: نتیجه‌ی تماس را با فرم تماس اول ثبت کن. با برچسب «خارج از لیست» در کارهای امروز می‌آید.</p>
      <button type="button" className="btn btn-primary" onClick={() => launcher.launch(cust)} data-testid="el-nw-first-open"><FileText size={15} aria-hidden="true" /> ثبت تماس (فرم تماس اول)</button>
      {fc ? <SimpleCallForm customer={{ id: customer.id, name: customer.name, phone: customer.phone, priority: null }} userId={user?.id}
        onClose={finish} onNext={finish}
        onDone={(r) => { announceCallSaved(r.callLogId, customer.id); setSaved(`${customer.name}: تماس و فرم تماس اول ثبت شد («خارج از لیست»)`); void elApi.firstCallLogged(customer.id, r.callLogId).catch(() => undefined); }} /> : null}
    </div>;
  }
  return <OutOfListLog customer={customer} currentNo={currentNo} idPrefix="el-nw" onSaved={onSaved} extra={extra} />;
}
