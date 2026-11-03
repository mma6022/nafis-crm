/** «ثبت مشتری جدید» with the number taken on the server from this call (same path as «الان مشتری جدید دارم»: duplicate check first, owner = me). */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Check, UserPlus } from 'lucide-react';
import { viApi, viRefresh, ViError } from './api';

export function NewCustomerInline({ source, eventId, onDone }: { source: 'incoming' | 'missed'; eventId: number; onDone?: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(''); const [done, setDone] = useState<{ id: number; name: string } | null>(null);
  if (done) return <p className="vi-ok" role="status" data-testid="vi-new-ok"><Check className="i" aria-hidden="true" /><span>مشتری <b>{done.name}</b> ساخته شد و کارشناسش خودت هستی.</span>
    <Link className="vi-lk" href={`/customers/${done.id}`}>باز کردن مشتری</Link></p>;
  if (!open) return <button type="button" className="btn btn-ghost vi-b" onClick={() => setOpen(true)} data-testid="vi-new"><UserPlus size={16} aria-hidden="true" />ثبت مشتری جدید</button>;
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await viApi.newCustomer(source, eventId, name);
      if (r.result === 'created' && r.customer) { setDone(r.customer); viRefresh(qc); onDone?.(); } else setErr(r.message ?? 'ثبت نشد.'); }
    catch (e) { const x = e instanceof ViError ? e : null;
      const d = x?.details as { ownerName?: string; mine?: boolean } | null;
      setErr(x?.status === 409 && d?.ownerName ? (d.mine ? 'این شماره قبلاً به نام مشتری خودت ثبت شده؛ مشتری تکراری ساخته نشد.' : `این شماره قبلاً ثبت شده؛ کارشناسش «${d.ownerName}» است. مشتری تکراری ساخته نشد.`) : x?.message ?? 'ثبت نشد.'); }
    finally { setBusy(false); }
  };
  return <div className="vi-new" data-testid="vi-new-form">
    <label><small>نام و نام خانوادگی</small><input className="inp" value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="مثلاً «علی رضایی»" autoFocus data-testid="vi-new-name" /></label>
    <p className="muted">شماره همین تماس است و خودش پر می‌شود؛ اگر قبلاً ثبت شده باشد، مشتری تکراری ساخته نمی‌شود.</p>
    <div className="vi-acts"><button type="button" className="btn btn-primary vi-b" disabled={busy || name.trim().length < 3} onClick={() => void save()} data-testid="vi-new-save">{busy ? 'در حال ثبت…' : 'ثبت مشتری'}</button>
      <button type="button" className="btn btn-ghost vi-b" onClick={() => setOpen(false)} disabled={busy}>انصراف</button></div>
    {err ? <p className="dp-err" role="alert" data-testid="vi-new-err">{err}</p> : null}
  </div>;
}
