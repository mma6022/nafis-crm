/* social-hub v1.1 §الف: «افزودن این شماره به مشتری ثبت‌شده» on the incoming card. Only while flag.social_hub_phone_attach_v1 is ON.
   Any expert, any customer (Mohammad t418s1654). Never creates a customer. A number on another customer is not saved. */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { FileText, Link2, Search, UserPlus, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { fa, messageError, shApi, useShMe, type ShPickRow } from './api';
import { Name, NumList, PhoneNum, Switch, Wizard, useShToast } from './ui';
import './social-hub.css';

/** The second button on the unknown-number card; renders nothing while the flag is OFF. */
export function AttachPhoneButton({ phone, callEventId, onNew }: { phone: string; callEventId?: number | null; onNew?: (phone: string) => void }) {
  const me = useShMe().data; const [open, setOpen] = useState(false);
  if (!me?.phoneAttach || !phone) return null;
  return <>
    <span className="sh" style={{ display: 'contents' }}><button type="button" className="sh-btn sec sh-attach-btn" onClick={() => setOpen(true)} data-testid="sh-attach-open"><Link2 size={16} aria-hidden="true" />افزودن این شماره به مشتری ثبت‌شده</button></span>
    {open ? <AttachPhoneWizard phone={phone} callEventId={callEventId ?? null} onClose={() => setOpen(false)} onNew={onNew} /> : null}
  </>;
}

type Dup = { id: number; name: string; ownerName: string | null };
const SH_PHONES_MAX = 10; // 1 primary + 9 extras while flag.social_hub_phone_attach_v1 is ON (server enforces the same cap)
export function AttachPhoneWizard({ phone, callEventId, onClose, onNew, initialQuery = '' }: { phone: string; callEventId: number | null; onClose: () => void; onNew?: (phone: string) => void; initialQuery?: string }) {
  const qc = useQueryClient(); const { node } = useShToast();
  const [q, setQ] = useState(initialQuery); const [rows, setRows] = useState<ShPickRow[] | null>(null); const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<ShPickRow | null>(null); const [step, setStep] = useState(0); const [logCall, setLogCall] = useState(true);
  const [err, setErr] = useState(''); const [dup, setDup] = useState<Dup | null>(null); const [same, setSame] = useState(false);
  const [done, setDone] = useState<{ c: ShPickRow; extras: string[] } | null>(null);
  useEffect(() => {
    const t = q.trim(); if (!t) { setRows(null); return; }
    const h = window.setTimeout(() => { shApi<{ rows: ShPickRow[] }>(`/phone-attach/search?q=${encodeURIComponent(t)}`).then((r) => setRows(r.rows)).catch((e) => { setRows([]); setErr(messageError(e)); }); }, 250);
    return () => window.clearTimeout(h);
  }, [q]);
  const save = async () => {
    if (!sel || busy) return; setBusy(true); setErr('');
    try {
      const r = await shApi<{ phones: { primary: string; extras: string[] } }>('/phone-attach', 'POST', { customerId: sel.id, phone, callEventId, logCall });
      setDone({ c: sel, extras: r.phones.extras });
      void qc.invalidateQueries({ queryKey: ['daily-plan'] }); void qc.invalidateQueries({ queryKey: ['customer-phones'] });
    } catch (e: any) {
      if (e?.code === 'duplicate_mobile') setDup(await refetchDup());
      else if (e?.code === 'same_customer') setSame(true);
      else setErr(messageError(e));
    } finally { setBusy(false); }
  };
  // the duplicate owner comes back on the 409; bbFetch keeps only message/code, so read it again by number
  const refetchDup = async (): Promise<Dup> => {
    try { const r = await shApi<{ rows: ShPickRow[] }>(`/phone-attach/search?q=${encodeURIComponent(phone)}`); const c = r.rows.find((x) => x.phone === phone || x.extras.includes(phone)); return c ? { id: c.id, name: c.name, ownerName: c.ownerName } : { id: 0, name: '', ownerName: null }; }
    catch { return { id: 0, name: '', ownerName: null }; }
  };
  const title = 'افزودن شماره به مشتری ثبت‌شده'; const steps = ['انتخاب مشتری', 'تأیید'];
  const numRow = <div className="sh-row sh-wrap"><span className="sh-lbl">شمارهٔ جدید</span><PhoneNum p={phone} copy={false} /></div>;
  if (done) return <Wizard title={title} onClose={onClose} short testId="sh-attach-done"
    foot={<><Link href={`/customers/${done.c.id}`} className="sh-btn pri" onClick={onClose}><FileText aria-hidden="true" />باز کردن پرونده</Link><button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button></>}>
    <div className="sh-stack"><div className="sh-msg ok" role="status" data-testid="sh-attach-ok">شماره به پروندهٔ {done.c.name} افزوده شد.</div><Name name={done.c.name} id={done.c.id} /><NumList primary={done.c.phone} extras={done.extras} /><span className="sh-sub">مشتری تازه‌ای ساخته نشد.</span></div>{node}</Wizard>;
  if (dup) return <Wizard title={title} steps={steps} cur={1} onClose={onClose} testId="sh-attach-dup"
    foot={<>{dup.id ? <Link href={`/customers/${dup.id}`} className="sh-btn pri" onClick={onClose}><FileText aria-hidden="true" />باز کردن پروندهٔ او</Link> : null}<button type="button" className="sh-btn ghost" onClick={() => { setDup(null); setStep(0); }}>انتخاب مشتری دیگر</button></>}>
    <div className="sh-stack"><div className="sh-sumbox"><div className="sh-sumr">{numRow}</div></div><div className="sh-msg">این شماره همین حالا برای مشتری دیگری ثبت شده است.</div>
      {dup.id ? <div className="sh-res"><span className="sh-ava">{dup.name.slice(0, 1)}</span><span className="rb"><Name name={dup.name} id={dup.id} /><span className="rl"><PhoneNum p={phone} copy={false} /></span><span className="rl">کارشناس: {dup.ownerName ?? 'بدون کارشناس'}</span></span></div> : null}</div></Wizard>;
  const full = Boolean(sel && 1 + sel.extras.length >= SH_PHONES_MAX);
  if (step === 1 && sel) return <Wizard title={title} steps={steps} cur={1} onClose={onClose} testId="sh-attach-confirm"
    foot={same ? <><Link href={`/customers/${sel.id}`} className="sh-btn pri" onClick={onClose}><FileText aria-hidden="true" />باز کردن پرونده</Link><button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button></>
      : <><button type="button" className="sh-btn pri" disabled={busy || full} onClick={() => void save()} data-testid="sh-attach-save">افزودن این شماره</button><button type="button" className="sh-btn ghost" onClick={() => setStep(0)}>قبلی</button></>}>
    <div className="sh-stack"><div className="sh-sumbox"><div className="sh-sumr"><span className="sh-lbl">شمارهٔ جدید</span><PhoneNum p={phone} copy={false} /></div>
      <div className="sh-sumr"><span className="sh-lbl">مشتری</span><Name name={sel.name} id={sel.id} /></div>
      <div className="sh-sumr col"><span className="sh-lbl">شماره‌های فعلی</span><NumList primary={sel.phone} extras={sel.extras} /></div></div>
      {full && !same ? <div className="sh-msg amber" data-testid="sh-attach-full">{sel.name} به سقف {fa(SH_PHONES_MAX)} شماره رسیده است؛ برای افزودن این شماره، یکی از شماره‌های اضافه را در پرونده حذف کنید.</div> : null}
      {same ? <div className="sh-msg amber">این شماره از قبل برای {sel.name} ثبت شده است.</div>
        : callEventId && !full ? <Switch on={logCall} onChange={setLogCall} label={`ثبت همین تماس در پروندهٔ ${sel.name}`} testId="sh-attach-log" /> : null}
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div></Wizard>;
  return <Wizard title={title} steps={steps} cur={0} onClose={onClose} testId="sh-attach-pick"
    foot={<><button type="button" className="sh-btn pri" disabled={!sel} onClick={() => { setSame(false); setStep(1); }} data-testid="sh-attach-next">ادامه</button><button type="button" className="sh-btn ghost" onClick={onClose}>انصراف</button></>}>
    <div className="sh-stack" style={{ gap: 8 }}>{numRow}
      <div className="sh-fld"><Search size={18} aria-hidden="true" /><input value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} aria-label="جست‌وجو با نام، شماره یا شناسه" placeholder="نام، شماره یا شناسه" autoFocus data-testid="sh-attach-q" />
        {q ? <button type="button" className="sh-ib" style={{ border: 0 }} aria-label="پاک کردن" onClick={() => setQ('')}><X aria-hidden="true" /></button> : null}</div>
      {rows === null ? <div className="sh-lbl">جست‌وجو با نام، شماره یا شناسه</div>
        : !rows.length ? <div className="sh-empty"><b className="sh-h3">مشتری‌ای پیدا نشد.</b><div className="sh-row sh-wrap" style={{ justifyContent: 'center' }}>
          <button type="button" className="sh-btn ghost sm" onClick={() => setQ('')}>پاک کردن جست‌وجو</button>
          {onNew ? <button type="button" className="sh-btn sec sm" onClick={() => { onClose(); onNew(phone); }}><UserPlus aria-hidden="true" />ثبت مشتری جدید با این شماره</button> : null}</div></div>
        : <><div className="sh-lbl" style={{ margin: '4px 0' }}>{fa(rows.length)} مشتری پیدا شد</div>
          <div className="sh-stack" role="listbox" aria-label="نتیجه‌ها" style={{ gap: 8 }}>{rows.map((r) => <div key={r.id} role="option" aria-selected={sel?.id === r.id} tabIndex={0} className={`sh-res${sel?.id === r.id ? ' sel' : ''}`}
            onClick={() => setSel(r)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(r); } }} data-testid="sh-attach-row">
            <span className="sh-ava">{r.name.replace(/^(آقای|خانم)\s+/, '').slice(0, 1)}</span>
            <span className="rb"><Name name={r.name} id={r.id} /><span className="rl"><PhoneNum p={r.phone} copy={false} /></span><span className="rl">کارشناس: {r.ownerName ?? 'بدون کارشناس'}{r.mine ? ' (شما)' : ''}</span></span>
            <span className={`sh-chip ${r.extras.length ? 'tint' : 'ok'}`}>{r.extras.length ? `${fa(r.extras.length)} شمارهٔ اضافه` : 'بدون شمارهٔ اضافه'}</span></div>)}</div></>}
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div></Wizard>;
}
