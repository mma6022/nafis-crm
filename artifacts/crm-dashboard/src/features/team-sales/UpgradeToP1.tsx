import { CustomerName } from '@/components/customer/CustomerName';
import { AlertCircle, ArrowUp, Check, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchNextCloser, shortName, TeamSalesApiError, upgradePriority, type NextCloser, type PromoteResult, type TransferCheck } from './api';
import { TransferCheckBox } from './TransferCheckBox';
import './team-sales.css';

/** Sidebar card «ارتقا به اولویت ۱» (screens 30-35). Only rendered for the qualifier on own P-/P2/P3 customers. */
export function UpgradeCard({ onOpen }: { onOpen: () => void }) {
  return <section className="csx-sec ts-card" aria-labelledby="h-ts-upgrade" data-testid="ts-upgrade-card">
    <header><h2 id="h-ts-upgrade"><Star size={20} /> ارتقا به اولویت ۱</h2></header>
    <p className="ts-muted">اگه مشتری آماده‌ی ثبت درخواسته، ارتقا بده تا به کارشناس پیگیری برسه.</p>
    <button type="button" className="ts-primary" onClick={onOpen} data-testid="ts-upgrade-open"><ArrowUp size={18} /> ارتقا به اولویت ۱</button>
  </section>;
}

export function UpgradedCard({ result }: { result: PromoteResult }) {
  const time = result.dueLabel;
  if (result.kept) return <section className="csx-sec ts-card" aria-labelledby="h-ts-upgraded" data-testid="ts-upgraded-card">
    <header><h2 id="h-ts-upgraded"><Star size={20} /> ارتقا یافت</h2></header>
    <div className="ts-ok-card"><span className="ts-av" aria-hidden="true">{shortName(result.closerName).slice(0, 1)}</span>
      <div><b>{result.message}</b><p>اولویت ۱ — پرونده نزد خودت می‌ماند</p></div></div>
  </section>;
  return <section className="csx-sec ts-card" aria-labelledby="h-ts-upgraded" data-testid="ts-upgraded-card">
    <header><h2 id="h-ts-upgraded"><Star size={20} /> واگذاری به پیگیری</h2></header>
    <div className="ts-ok-card">
      <span className="ts-av" aria-hidden="true">{shortName(result.closerName).slice(0, 1)}</span>
      <div><b>{result.message}</b><p>اولویت ۱ — مهلت تماس تا {time}</p></div>
    </div>
    <p className="ts-muted">این مشتری دیگر در صف شما نیست. اگر {result.closerName} مشکلی دید، با شما هماهنگ می‌کند.</p>
  </section>;
}

export function UpgradeDialog({ customer, onClose, onDone }: {
  customer: { id: number; name: string }; onClose: () => void; onDone: (r: PromoteResult) => void;
}) {
  const [next, setNext] = useState<NextCloser | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [tcErr, setTcErr] = useState<TransferCheck | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { let live = true; fetchNextCloser(customer.id).then((n) => { if (live) setNext(n); }, () => { /* generic text fallback */ }); return () => { live = false; }; }, [customer.id]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose, pending]);
  const who = next?.name ?? 'کارشناس پیگیری نوبت بعدی';
  const self = next?.self === true; // HOTFIX-73: a closer's own customer stays with them
  // R3: the receiver check from the preview, or from a refused hand-off (409 transferCheck).
  const tc = tcErr ?? (next?.transferCheck && !next.transferCheck.ok ? next.transferCheck : null);
  const confirm = async (overrideReason?: string) => {
    if (!reason.trim()) { setError('دلیل کوتاه ارتقا را بنویس.'); document.getElementById('ts-up-reason')?.focus(); return; }
    setPending(true); setError('');
    try { onDone(await upgradePriority(customer.id, note, overrideReason, reason)); }
    catch (e) {
      if (e instanceof TeamSalesApiError && e.transferCheck) { setTcErr(e.transferCheck); return; }
      const why = e instanceof TeamSalesApiError && e.message ? e.message : 'اتصال به سرور برقرار نشد.';
      setError(`ارتقا انجام نشد؛ ${why} اولویت و کارشناس تغییری نکرد. دوباره امتحان کن.`);
    } finally { setPending(false); }
  };
  return <div className="ts-layer" dir="rtl">
    <div className="ts-scrim" onClick={() => !pending && onClose()} aria-hidden="true" />
    <div ref={ref} className="ts-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ts-up-title" aria-describedby="ts-up-desc" tabIndex={-1} data-testid="ts-upgrade-dialog">
      <h2 id="ts-up-title">ارتقا به اولویت ۱؟</h2>
      {self ? <p id="ts-up-desc">«<CustomerName id={customer.id} name={customer.name} />» اولویت ۱ می‌شود و نزد خودت می‌ماند.</p>
        : <p id="ts-up-desc">«<CustomerName id={customer.id} name={customer.name} />» از صف شما خارج می‌شود و به {next ? next.name : 'کارشناس پیگیری نوبت بعدی'} می‌رسد.</p>}
      {self ? null : <div className="ts-next">
        <span className="ts-av" aria-hidden="true">{next ? shortName(next.name).slice(0, 1) : '؟'}</span>
        <div><b data-testid="ts-next-closer">{who}</b><p data-testid="ts-next-why">{next?.assignment === 'previous_expert' ? 'کارشناس قبلی مشتری' : 'تقسیم عادلانه (نوبت بعدی چرخش)'} — مهلت تماس ۳ ساعت کاری</p></div>
      </div>}
      <label htmlFor="ts-up-reason" className="ts-lbl">دلیل کوتاه<span aria-hidden="true">*</span> <span className="ts-muted">(در گزارش مدیر ثبت می‌شود)</span></label>
      <input id="ts-up-reason" className="ts-inp" value={reason} aria-required="true" onChange={(e) => { setReason(e.target.value); setError(''); }} data-testid="ts-upgrade-reason" />
      <label htmlFor="ts-up-note" className="ts-lbl">{self ? 'یادداشت' : `یادداشت برای ${next ? next.name : 'کارشناس پیگیری'}`} <span className="ts-muted">(اختیاری)</span></label>
      <textarea id="ts-up-note" className="ts-inp" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="ts-upgrade-note" />
      {error ? <div className="ts-alert" role="alert" data-testid="ts-upgrade-error"><AlertCircle size={18} /> {error}</div> : null}
      {tc ? <TransferCheckBox tc={tc} pending={pending} onOverride={(r) => { void confirm(r); }} /> : null}
      {tc ? null : <button type="button" className="ts-primary" onClick={() => { void confirm(); }} disabled={pending} data-testid="ts-upgrade-confirm"><ArrowUp size={18} /> {pending ? 'در حال ارتقا…' : error ? 'تلاش دوباره' : 'بله، ارتقا بده'}</button>}
      <button type="button" className="ts-ghost" onClick={onClose} disabled={pending} data-testid="ts-upgrade-cancel">انصراف</button>
    </div>
  </div>;
}

export function TsToast({ text, onClose, onLink }: { text: string; onClose: () => void; onLink?: () => void }) {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => { const t = window.setTimeout(() => close.current(), 6000); return () => window.clearTimeout(t); }, [text]);
  return <div className="ts-toast ok" role="status" data-testid="ts-toast"><Check size={18} /> <span>{text}</span>{onLink ? <button type="button" onClick={onLink}>تاریخچه</button> : null}</div>;
}
