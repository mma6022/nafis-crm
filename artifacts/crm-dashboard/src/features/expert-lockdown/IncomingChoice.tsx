/** incoming2-59 «تماس ورودی داشتم» (expert_lockdown): two options for a customer who called the expert's own line.
 *  1) «جزو مشتری‌های منه» → the exact search (LockedInbound): own → «خارج از لیست», other expert → owner name + bell.
 *  2) «ثبت مشتری جدید» → short wizard: phone (server exact-duplicate check, owner name only) → name → confirm → POST /expert-lockdown/incoming/new.
 *     The server makes this expert the owner and registrar, lead source «تماس ورودی», and sends no SMS / Telegram / welcome. */
import { useState } from 'react';
import { useLocation } from 'wouter';
import { Check, Info, Lock, PhoneIncoming, UserPlus, UserRound, X } from 'lucide-react';
import { MoreFields, Stepper, WizardActions, type WizardStep } from '@/components/wizard/Wizard';
import { elApi, type ElNew } from './api';
import { LockedInbound } from './IncomingCall';
import './lockdown.css';

type Opt = 'own' | 'new' | null;
type StepKey = 'phone' | 'name' | 'confirm';
const STEPS: readonly WizardStep<StepKey>[] = [{ key: 'phone', title: 'شماره موبایل' }, { key: 'name', title: 'نام مشتری' }, { key: 'confirm', title: 'تأیید و ثبت' }];
const faNum = (v: string | number) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

export function LockedIncomingChoice({ onClose, onSaved, currentNo }: { onClose: () => void; onSaved: () => void; currentNo?: number | null }) {
  const [opt, setOpt] = useState<Opt>(null);
  const pick = (o: Exclude<Opt, null>) => { void elApi.choose(o).catch(() => undefined); setOpt(o); };
  if (opt === 'own') return <LockedInbound onClose={onClose} onSaved={onSaved} currentNo={currentNo} onBack={() => setOpt(null)} />;
  if (opt === 'new') return <NewCustomer onClose={onClose} onBack={() => setOpt(null)} />;
  return <section className="dp-inbound card" aria-labelledby="el-ch-h" data-testid="el-choice">
    <div className="dp-sheet-h"><div><small className="dp-hint"><PhoneIncoming size={13} aria-hidden="true" /> مشتری خودش به خط تو زنگ زده</small>
      <h2 id="el-ch-h">تماس ورودی داشتم</h2></div>
      <button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
    <div className="el-choice">
      <button type="button" className="el-opt" onClick={() => pick('own')} data-testid="el-choose-own">
        <UserRound size={20} aria-hidden="true" /><b>جزو مشتری‌های منه</b><small>با شماره‌ی کامل یا نام کامل پرونده‌اش را پیدا کن و تماس را «خارج از لیست» ثبت کن.</small></button>
      <button type="button" className="el-opt" onClick={() => pick('new')} data-testid="el-choose-new">
        <UserPlus size={20} aria-hidden="true" /><b>ثبت مشتری جدید</b><small>اول شماره را چک می‌کنیم؛ اگر تکراری نبود، مشتری به نام خودت ثبت می‌شود.</small></button>
    </div>
  </section>;
}

function NewCustomer({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [, go] = useLocation();
  const [step, setStep] = useState<StepKey>('phone');
  const [phone, setPhone] = useState(''); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [dup, setDup] = useState<Extract<ElNew, { result: 'duplicate' }> | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const fail = (r: ElNew) => {
    if (r.result === 'duplicate') { setDup(r); setStep('phone'); return; }
    if (r.result === 'invalid' || r.result === 'rate_limited') { setErr(r.message); if (r.field === 'phone') setStep('phone'); else if (r.field) setStep('name'); }
  };
  const check = async () => {
    setErr(''); setDup(null); if (phone.replace(/[^\d۰-۹]/g, '').length < 10) { setErr('شماره‌ی موبایل کامل ۱۱ رقمی را بنویس (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).'); return; }
    setBusy(true);
    try { const r = await elApi.newCheck(phone); if (r.result === 'new') setStep('name'); else fail(r); }
    catch (e) { setErr(e instanceof Error ? e.message : 'بررسی انجام نشد.'); } finally { setBusy(false); }
  };
  const toConfirm = () => {
    setErr(''); const n = name.replace(/\s+/g, ' ').trim();
    if (n.length < 3 || !n.includes(' ') || /[\d۰-۹]/.test(n)) { setErr('نام و نام خانوادگی مشتری را کامل بنویس (بدون عدد).'); return; }
    setStep('confirm');
  };
  const save = async () => {
    setErr(''); setBusy(true);
    try { const r = await elApi.create({ phone, name: name.replace(/\s+/g, ' ').trim(), description: note.trim() || undefined });
      if (r.result === 'created') { onClose(); go(`/customers/${r.customer.id}`); return; } fail(r);
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <section className="dp-inbound card" aria-labelledby="el-nw-h" data-testid="el-new">
    <div className="dp-sheet-h"><div><small className="dp-hint"><UserPlus size={13} aria-hidden="true" /> تماس ورودی · ثبت مشتری جدید</small>
      <h2 id="el-nw-h">ثبت مشتری جدید</h2></div>
      <button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
    <Stepper steps={STEPS} current={step} onGo={busy ? undefined : (k) => { if (k === 'phone' || (k === 'name' && step === 'confirm')) setStep(k); }} testPrefix="el-nw-step-" />
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
    {step === 'name' ? <form onSubmit={(e) => { e.preventDefault(); toConfirm(); }} className="el-nw-form">
      <p className="dp-box ok sm" data-testid="el-nw-new"><Check size={14} aria-hidden="true" /> شماره‌ی {faNum(phone)} تکراری نیست.</p>
      <label className="dp-hint" htmlFor="el-nw-name">نام و نام خانوادگی</label>
      <input id="el-nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً علی رضایی" autoComplete="off" data-testid="el-nw-name" />
      <MoreFields label="توضیح (اختیاری)"><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} placeholder="مثلاً درباره‌ی وام خرید کالا پرسید" data-testid="el-nw-note" aria-label="توضیح" /></MoreFields>
      <WizardActions onBack={() => setStep('phone')} testPrefix="el-nw-name" />
    </form> : null}
    {step === 'confirm' ? <div className="el-nw-form" data-testid="el-nw-confirm">
      <dl className="el-nw-sum">
        <dt>نام</dt><dd>{name.replace(/\s+/g, ' ').trim()}</dd>
        <dt>موبایل</dt><dd dir="ltr">{faNum(phone)}</dd>
        <dt>منبع</dt><dd>تماس ورودی</dd>
        <dt>کارشناس پرونده</dt><dd>خودت</dd>
        {note.trim() ? <><dt>توضیح</dt><dd>{note.trim()}</dd></> : null}
      </dl>
      <p className="dp-hint"><Info size={13} aria-hidden="true" /> پیامکی برای مشتری فرستاده نمی‌شود. بعد از ثبت، پرونده‌ی مشتری باز می‌شود.</p>
      <WizardActions nextType="button" onNext={() => void save()} nextLabel="ثبت مشتری" pending={busy} pendingLabel="در حال ثبت…" onBack={() => setStep('name')} testPrefix="el-nw-save" />
    </div> : null}
    {err ? <p className="dp-err" role="alert" data-testid="el-nw-err">{err}</p> : null}
  </section>;
}
