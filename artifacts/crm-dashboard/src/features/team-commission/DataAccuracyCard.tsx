import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, ChevronLeft, ChevronRight, Gift, Lock, ShieldCheck, X, XCircle, CheckCircle2 } from 'lucide-react';
import { faDateTime, tcApi, tm, TeamCommissionApiError, type AccuracyReason, type DataAccuracyState } from './api';
import './team-commission.css';

type Visible = Extract<DataAccuracyState, { visible: true }>;
const first = (name: string | null | undefined) => (name ?? '؟').replace(/^(خانم|آقای)\s+/, '').slice(0, 1);

/** «درستی اطلاعات تماس اول» card on the customer case (approved design crm-commission 01-09). Hidden unless the team model applies. */
export function DataAccuracyCard({ customerId, onSubmitted, place = 'd' }: { customerId: number; onSubmitted?: () => void; place?: string }) {
  const qc = useQueryClient();
  const key = ['team-data-accuracy', customerId];
  const q = useQuery({ queryKey: key, queryFn: () => tcApi.accuracy(customerId), enabled: Number.isSafeInteger(customerId), staleTime: 15_000, retry: false });
  const [open, setOpen] = useState<null | 'ok' | 'bad'>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 6000); return () => window.clearTimeout(t); }, [toast]);
  const s = q.data;
  if (!s || !s.visible) return null;
  const done = (text: string) => { setOpen(null); setToast(text); void qc.invalidateQueries({ queryKey: key }); onSubmitted?.(); };
  return <>
    <ReviewCard s={s} place={place} onOk={() => setOpen('ok')} onBad={() => setOpen('bad')} />
    {open === 'ok' ? <OkDialog s={s} onClose={() => setOpen(null)} onDone={() => done(`ثبت شد · ${tm(s.bonusToman)} پاداش برای ${s.p1.qualifierName ?? 'کارشناس تماس اول'}`)} /> : null}
    {open === 'bad' ? <RejectWizard s={s} onClose={() => setOpen(null)} onDone={() => done(`ثبت شد · دلیل برای ${s.p1.qualifierName ?? 'کارشناس تماس اول'} نمایش داده می‌شود`)} /> : null}
    {toast ? <div className="tc-toast" role="status" data-testid="tc-accuracy-toast"><Check size={18} /> <span>{toast}</span></div> : null}
  </>;
}

function ReviewCard({ s, place, onOk, onBad }: { s: Visible; place: string; onOk: () => void; onBad: () => void }) {
  const qual = s.p1.qualifierName ?? 'کارشناس تماس اول';
  const closer = s.closerName ?? 'کارشناس پیگیری';
  const mine = s.viewer === 'closer';
  const by = (name: string | null) => (mine ? 'ثبت شما' : `ثبت ${name ?? closer}`);
  const head = <header><h2 id={`h-tc-acc-${place}-${s.customerId}`}><ShieldCheck size={20} /> درستی اطلاعات تماس اول</h2></header>;
  const source = s.p1.kind === 'first_call' ? 'از تماس اول' : 'از راه ارتقا';
  const ref = <div className="tc-ref"><span className="av" aria-hidden="true">{first(qual)}</span>
    <div><b>معرفی {qual} · اولویت ۱</b><span className="tc-muted">{source} · {faDateTime(s.p1.at)}{mine ? ' · به شما واگذار شد' : ''}</span></div></div>;
  const override = s.canOverride ? <div className="tc-two">
    <button type="button" className="tc-ghost" onClick={onOk} disabled={s.status === 'correct'} data-testid="tc-admin-ok">تغییر به «درست بود»</button>
    <button type="button" className="tc-ghost" onClick={onBad} data-testid="tc-admin-bad">تغییر به «درست نبود»</button>
  </div> : null;
  let body: ReactNode;
  if (s.status === 'pending') {
    body = s.canReview ? <>
      {ref}
      <p className="tc-q2">اطلاعاتی که {qual} در فرم تماس اول ثبت کرده با واقعیت پرونده یکی بود؟</p>
      <div className="tc-two">
        <button type="button" className="tc-yes" onClick={onOk} data-testid="tc-accuracy-yes"><CheckCircle2 size={20} /> اطلاعات درست بود</button>
        <button type="button" className="tc-nob" onClick={onBad} data-testid="tc-accuracy-no"><XCircle size={20} /> اطلاعات درست نبود</button>
      </div>
      <div className="tc-bonus"><Gift size={18} /><span>اگه درست بود، {qual} <b>{tm(s.bonusToman)}</b> پاداش می‌گیره.</span></div>
      <p className="tc-lock"><Lock size={14} /> بعد از ثبت، فقط مدیر می‌تواند تغییرش دهد.</p>
    </> : <>
      {ref}
      <div className="tc-sum">
        <div className="r"><span>وضعیت</span><b data-testid="tc-accuracy-status">در انتظار بررسی {closer}</b></div>
        <div className="r"><span>پاداش درستی داده</span><b>{tm(s.bonusToman)}</b></div>
      </div>
      <p className="tc-lock"><Lock size={14} /> فقط کارشناس پیگیری پرونده می‌تواند این را ثبت کند.</p>
    </>;
  } else if (s.status === 'correct' && s.review) {
    body = <>
      <div className="tc-res ok" data-testid="tc-accuracy-status"><CheckCircle2 size={24} /><div><b>اطلاعات درست بود</b><span>{by(s.review.reviewedByName)} · {faDateTime(s.review.updatedAt ?? s.review.reviewedAt)}</span></div></div>
      <div className="tc-bonus"><Gift size={18} /><span>{tm(s.review.bonusToman)} پاداش درستی داده {s.viewer === 'qualifier' ? 'برای شما' : `برای ${qual}`} ثبت شد.</span></div>
      {override}
      <p className="tc-lock"><Lock size={14} /> قفل شد · فقط مدیر می‌تواند تغییر دهد.</p>
    </>;
  } else if (s.review) {
    body = <>
      <div className="tc-res bad" data-testid="tc-accuracy-status"><XCircle size={24} /><div><b>اطلاعات درست نبود</b><span>دلیل: {s.review.reasonLabel} · {by(s.review.reviewedByName)} · {faDateTime(s.review.updatedAt ?? s.review.reviewedAt)}</span></div></div>
      {s.review.note ? <p className="tc-quote">«{s.review.note}»</p> : null}
      <div className="tc-sum"><div className="r"><span>پاداش درستی داده</span><b>تعلق نگرفت</b></div></div>
      {override}
      <p className="tc-lock"><Lock size={14} /> قفل شد · فقط مدیر می‌تواند تغییر دهد.</p>
    </>;
  }
  return <section className="tc tc-sec tc-rv csx-sec" aria-labelledby={`h-tc-acc-${place}-${s.customerId}`} data-testid="tc-accuracy-card">{head}{body}</section>;
}

function useModal(onClose: () => void, busy: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, [onClose, busy]);
  return ref;
}
const failText = (e: unknown) => (e instanceof TeamCommissionApiError ? e.message : 'اتصال به سرور برقرار نشد.');

function OkDialog({ s, onClose, onDone }: { s: Visible; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useModal(onClose, busy);
  const qual = s.p1.qualifierName ?? 'کارشناس تماس اول';
  const submit = async () => {
    setBusy(true); setError('');
    try { await tcApi.submitAccuracy(s.customerId, { correct: true }); onDone(); }
    catch (e) { setError(`ثبت نشد؛ ${failText(e)} دوباره امتحان کن.`); } finally { setBusy(false); }
  };
  return <div className="tc-layer" dir="rtl">
    <div className="tc-scrim" onClick={() => !busy && onClose()} aria-hidden="true" />
    <div ref={ref} className="tc-sheet" role="alertdialog" aria-modal="true" aria-labelledby="tc-ok-h" tabIndex={-1} data-testid="tc-ok-dialog">
      <div className="tc-grab" aria-hidden="true" />
      <h2 id="tc-ok-h">اطلاعات درست بود؟</h2>
      <p>تأیید می‌کنی که اطلاعات فرم تماس اول {qual} برای «{s.customerName}» با واقعیت پرونده یکی بود.</p>
      <div className="tc-bonus" style={{ fontSize: 15 }}><Gift size={18} /><span>{qual} <b>{tm(s.bonusToman)}</b> پاداش درستی داده می‌گیرد.</span></div>
      <p className="tc-lock"><Lock size={14} /> {s.viewer === 'admin' ? 'این تغییر با نام شما در تاریخچه ثبت می‌شود.' : 'بعد از ثبت، فقط مدیر می‌تواند تغییرش دهد.'}</p>
      {error ? <div className="tc-errbox" role="alert"><AlertCircle size={18} /> {error}</div> : null}
      <button type="button" className="tc-green" onClick={submit} disabled={busy} data-testid="tc-ok-confirm"><Check size={18} /> {busy ? 'در حال ثبت…' : 'بله، درست بود'}</button>
      <button type="button" className="tc-ghost" onClick={onClose} disabled={busy}>انصراف</button>
    </div>
  </div>;
}

/** 2-step wizard: 1) reason + note  2) review & submit. Bottom sheet on mobile, centered dialog on desktop. */
function RejectWizard({ s, onClose, onDone }: { s: Visible; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState<AccuracyReason | null>(null);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useModal(onClose, busy);
  const qual = s.p1.qualifierName ?? 'کارشناس تماس اول';
  const noteLen = note.replace(/\s+/g, '').length;
  const reasonErr = tried && !reason;
  const noteErr = tried && reason === 'other' && noteLen < 10;
  const label = s.reasons.find((r) => r.key === reason)?.label ?? '';
  const next = () => { setTried(true); if (!reason || (reason === 'other' && noteLen < 10)) return; setStep(2); };
  const submit = async () => {
    if (!reason) return;
    setBusy(true); setError('');
    try { await tcApi.submitAccuracy(s.customerId, { correct: false, reason, note: note.trim() || undefined }); onDone(); }
    catch (e) { setError(`ثبت نشد؛ ${failText(e)} چیزی تغییر نکرد. دوباره امتحان کن.`); } finally { setBusy(false); }
  };
  return <div className="tc-layer" dir="rtl">
    <div className="tc-scrim" onClick={() => !busy && onClose()} aria-hidden="true" />
    <div ref={ref} className="tc-sheet" role="dialog" aria-modal="true" aria-labelledby="tc-rj-h" tabIndex={-1} data-testid="tc-reject-wizard">
      <div className="tc-grab" aria-hidden="true" />
      <div className="tc-sh"><h2 id="tc-rj-h">اطلاعات درست نبود</h2><button type="button" className="tc-ib" aria-label="بستن" onClick={onClose} disabled={busy}><X size={20} /></button></div>
      <div className="tc-prog" aria-live="polite">
        <div className="row"><b>{step === 2 ? 'بازبینی و ثبت' : 'چه چیزی درست نبود؟'}</b><span>مرحله {step === 2 ? '۲' : '۱'} از ۲</span></div>
        <div className="tc-steps" aria-hidden="true"><i className="on" /><i className={step === 2 ? 'on' : ''} /></div>
      </div>
      {step === 1 ? <>
        <div className="tc-fld">
          <span className="tc-lbl" id="tc-rl">دلیل <span className="tc-req">*</span></span>
          <div className={`tc-rchips ${reasonErr ? 'bad' : ''}`} role="radiogroup" aria-labelledby="tc-rl" aria-invalid={reasonErr || undefined} aria-describedby={reasonErr ? 'tc-re' : undefined}>
            {s.reasons.map((r) => <button key={r.key} type="button" role="radio" className="tc-chip" aria-checked={reason === r.key} onClick={() => setReason(r.key)} data-testid={`tc-reason-${r.key}`}><span className="rd" aria-hidden="true" />{r.label}</button>)}
          </div>
          {reasonErr ? <p className="tc-ferr" id="tc-re" role="alert"><AlertCircle size={16} /> یک دلیل انتخاب کن.</p> : null}
        </div>
        <div className="tc-fld">
          <label className="tc-lbl" htmlFor="tc-note">توضیح {reason === 'other' ? <span className="tc-req">*</span> : <span className="tc-muted">(اختیاری)</span>}</label>
          <textarea id="tc-note" className="tc-inp" value={note} onChange={(e) => setNote(e.target.value.slice(0, 2000))} placeholder="چه چیزی با فرم تماس اول نمی‌خواند؟" aria-invalid={noteErr || undefined} aria-describedby={noteErr ? 'tc-ne' : undefined} data-testid="tc-reject-note" />
          {noteErr ? <p className="tc-ferr" id="tc-ne" role="alert"><AlertCircle size={16} /> برای «سایر» توضیح لازم است (حداقل ۱۰ حرف).</p> : null}
        </div>
        <div className="tc-foot"><button type="button" className="tc-ghost" onClick={onClose}>انصراف</button><button type="button" className="tc-primary" onClick={next} data-testid="tc-reject-next">بعدی <ChevronLeft size={18} /></button></div>
      </> : <>
        <div className="tc-sum">
          <div className="r"><span>مشتری</span><b>{s.customerName}</b></div>
          <div className="r"><span>دلیل</span><b>{label}</b></div>
          {note.trim() ? <div className="r"><span>توضیح</span><span style={{ textAlign: 'start' }}>{note.trim()}</span></div> : null}
        </div>
        <div className="tc-errbox warn"><AlertCircle size={18} /><span>پاداش {tm(s.bonusToman)} به {qual} تعلق نمی‌گیرد. دلیل برای او و مدیر نمایش داده می‌شود.</span></div>
        <p className="tc-lock"><Lock size={14} /> {s.viewer === 'admin' ? 'این تغییر با نام شما در تاریخچه ثبت می‌شود.' : 'بعد از ثبت، فقط مدیر می‌تواند تغییرش دهد.'}</p>
        {error ? <div className="tc-errbox" role="alert"><AlertCircle size={18} /> {error}</div> : null}
        <div className="tc-foot"><button type="button" className="tc-ghost" onClick={() => setStep(1)} disabled={busy}><ChevronRight size={18} /> قبلی</button><button type="button" className="tc-red" onClick={submit} disabled={busy} data-testid="tc-reject-submit"><Check size={18} /> {busy ? 'در حال ثبت…' : 'ثبت «درست نبود»'}</button></div>
      </>}
    </div>
  </div>;
}
