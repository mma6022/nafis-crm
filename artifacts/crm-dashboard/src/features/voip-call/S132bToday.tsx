/** SIMOTEL-132 B (design §7.2 `missed`, Q12 «کامل کردن نام»): Today extras. Flag off → renders nothing and fetches nothing. */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, PhoneCall, PhoneMissed, UserPen, UserPlus } from 'lucide-react';
import { faClock, faNum } from '@/features/call-queue/api';
import { IncomingWizard } from '@/features/expert-lockdown/IncomingWizard';
import { s132bApi, useS132bMissed, useVcMe, vcApi, VcError, VC_ME_KEY, S132B_MISSED_KEY, type S132bMissedRow } from './api';
import { CopyBtn, useS132bOn } from './S132bLayer';
import './s132b.css';

export function S132bToday() {
  const on = useS132bOn();
  return on ? <S132bTodayOn /> : null;
}

function S132bTodayOn() {
  const qc = useQueryClient();
  const me = useVcMe(true);
  const m = useS132bMissed(true);
  const [open, setOpen] = useState(false);
  const [wiz, setWiz] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const b = me.data?.s132b;
  const rows = m.data?.rows ?? [];
  const busy = Boolean(me.data?.call?.active || b?.busy);
  const redial = async (r: S132bMissedRow) => {
    if (!r.customer || busy) return; setMsg('');
    try { await vcApi.start({ customerId: r.customer.id, fileId: null }); void qc.invalidateQueries({ queryKey: VC_ME_KEY }); }
    catch (e) { setMsg(e instanceof VcError ? e.message : 'تماس گرفته نشد؛ دوباره بزن.'); }
  };
  return <>
    {rows.length && !open ? <button type="button" className="s1b-tlink" onClick={() => setOpen(true)} data-testid="s1b-missed-link">
      <PhoneMissed size={15} aria-hidden="true" />{faNum(rows.length)} تماس بی‌پاسخ امروز</button> : null}
    {rows.length && open ? <section className="s1b-tcard" data-testid="s1b-missed">
      <h3><PhoneMissed size={18} aria-hidden="true" />تماس‌های بی‌پاسخ امروز <span className="s1b-cnt">{faNum(rows.length)}</span>
        <button type="button" className="s1b-lnk" style={{ marginInlineStart: 'auto' }} onClick={() => setOpen(false)}>بستن</button></h3>
      {msg ? <p className="s1b-err" role="alert" data-testid="s1b-missed-err">{msg}</p> : null}
      {rows.map((r) => <div className="s1b-row" key={r.key} data-testid="s1b-missed-row" data-cls={r.cls}>
        <div className="s1b-rw"><b>{r.customer ? <>{r.customer.name} <span className="s1b-id">#{faNum(r.customer.id)}</span></> : 'شماره ناشناس'}</b>
          <span>{r.kind === 'mine' ? 'به داخلی خودت' : 'از صف'} · ساعت {faClock(r.lastAt)}{r.times > 1 ? ` · ${faNum(r.times)} بار` : ''}{r.customer && r.cls !== 'own' ? ` · کارشناس: ${r.customer.ownerName ?? 'بدون کارشناس'}` : ''}</span></div>
        {r.phone ? <span className="s1b-ph"><bdi dir="ltr">{faNum(r.phone)}</bdi><CopyBtn text={r.phone} /></span> : null}
        {r.task != null ? <span className="vc-chip q" data-testid="s1b-task">کارت تسک {faNum(r.task)}</span> : null}
        {r.redial ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void redial(r)} data-testid="s1b-redial"><PhoneCall size={15} aria-hidden="true" />تماس دوباره</button>
          : !r.customer && r.phone ? <button type="button" className="btn btn-ghost" onClick={() => setWiz(r.phone)} data-testid="s1b-missed-new"><UserPlus size={15} aria-hidden="true" />ثبت مشتری جدید</button>
          : r.customer && r.cls === 'support' ? <Link href={`/customers/${r.customer.id}`} className="btn btn-ghost">باز کردن پرونده</Link> : null}
      </div>)}
    </section> : null}
    {b?.noName?.length ? <NoNameCard items={b.noName} /> : null}
    {wiz ? <IncomingWizard currentNo={null} presetPhone={wiz} onClose={() => setWiz(null)} onSaved={() => { void qc.invalidateQueries({ queryKey: S132B_MISSED_KEY }); void qc.invalidateQueries({ queryKey: ['daily-plan'] }); }} /> : null}
  </>;
}

function NoNameCard({ items }: { items: { id: number; createdAt: string }[] }) {
  const qc = useQueryClient();
  const it = items[0];
  const [v, setV] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const save = async () => {
    if (busy || !v.trim()) return; setBusy(true); setErr('');
    try { await s132bApi.completeName(it.id, v); setOk(`نام مشتری #${faNum(it.id)} ثبت شد.`); setV(''); void qc.invalidateQueries({ queryKey: VC_ME_KEY }); }
    catch (e) { setErr(e instanceof VcError ? e.message : 'ذخیره نشد؛ دوباره بزن.'); } finally { setBusy(false); }
  };
  return <section className="s1b-tcard" data-testid="s1b-noname">
    <h3><UserPen size={18} aria-hidden="true" />کامل کردن نام{items.length > 1 ? <span className="s1b-cnt">{faNum(items.length)}</span> : null}</h3>
    <p className="s1b-mut">مشتری <Link href={`/customers/${it.id}`} className="s1b-lnk">#{faNum(it.id)}</Link> از تماس بیرون از صف «بدون نام» ساخته شد · ساعت {faClock(it.createdAt)}</p>
    <form className="s1b-nf" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="s1b-nfr"><input aria-label="نام مشتری" value={v} maxLength={80} onChange={(e) => { setV(e.target.value); setOk(''); }} placeholder="نام و نام خانوادگی" autoComplete="off" data-testid="s1b-noname-in" />
        <button type="submit" className="btn btn-primary" disabled={busy || !v.trim()} data-testid="s1b-noname-save"><Check size={15} aria-hidden="true" />ذخیره</button></div>
      {err ? <p className="s1b-err" role="alert">{err}</p> : null}
      {ok ? <p className="s1b-mut" role="status">{ok}</p> : null}
    </form>
  </section>;
}
