/** expert_lockdown «تماس ورودی · پیدا کردن پرونده» (Armita crm-daily-plan w_in_search / w_in_file / w_in_err / w_in_done).
 *  Exact match only (full mobile or full name) via POST /api/expert-lockdown/incoming/search — never a list.
 *  Own customer → the case opens for a short window and the call is logged with the normal out-of-list call form (POST /calls, context out_of_list).
 *  Another expert's customer → owner name only; the server sends that owner one internal bell. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, FileText, Info, Lock, PhoneIncoming, Search, UserRound, X } from 'lucide-react';
import { CqResultFields, cqResultError, emptyCqResult, type CqResultValue } from '@/features/call-queue/ResultFields';
import { announceCallSaved, faNum, useCqConfig } from '@/features/call-queue/api';
import { dpApi } from '@/features/daily-plan/api';
import { elApi, type ElSearch } from './api';
import './lockdown.css';

export function LockedInbound({ onClose, onSaved, currentNo, onBack }: { onClose: () => void; onSaved: () => void; currentNo?: number | null; onBack?: () => void }) {
  const cq = useCqConfig().data;
  const [term, setTerm] = useState('');
  const [res, setRes] = useState<ElSearch | null>(null);
  const [val, setVal] = useState<CqResultValue>(emptyCqResult());
  const [show, setShow] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const back = currentNo ? ` و برگشت به کار ${faNum(currentNo)}` : '';
  const find = async () => {
    const q = term.trim(); if (q.length < 2) { setErr('شماره‌ی موبایل کامل یا نام و نام خانوادگی کامل را بنویس.'); return; }
    setBusy(true); setErr(''); setOk(''); setRes(null); setVal(emptyCqResult()); setShow(false);
    try { setRes(await elApi.search(q)); } catch (e) { setErr(e instanceof Error ? e.message : 'جست‌وجو انجام نشد.'); } finally { setBusy(false); }
  };
  const own = res?.result === 'own' ? res.customer : null;
  const save = async () => {
    if (!own) return; setShow(true); const bad = cqResultError(val); if (bad) { setErr(bad); return; }
    setBusy(true); setErr('');
    try { const one = val.oneLine.trim();
      const r = await dpApi.saveCall({ customerId: own.id, salespersonId: cq?.salespersonId ?? undefined, subject: 'تماس ورودی', customerRequest: '', expertNotes: one, outcome: val.outcome, oneLineNote: one,
        followUpAt: val.outcome === 'follow_up' ? val.followUpAt : undefined, outOfList: true, context: 'out_of_list' });
      announceCallSaved(r.id, own.id); setOk(`${own.name}: «خارج از لیست» ثبت شد${currentNo ? ` · برگشت به کار ${faNum(currentNo)}` : ''}`);
      setRes(null); setTerm(''); setVal(emptyCqResult()); setShow(false); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <section className="dp-inbound card" aria-labelledby="el-in-h" data-testid="el-inbound">
    <div className="dp-sheet-h"><div><small className="dp-hint"><PhoneIncoming size={13} aria-hidden="true" /> فقط برای تماس ورودی</small>
      <h2 id="el-in-h">پیدا کردن پرونده‌ی مشتری‌ای که زنگ زده</h2></div>
      <button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
    {ok ? <p className="dp-box ok sm" role="status" data-testid="el-in-done"><Check size={14} aria-hidden="true" /> {ok}</p> : null}
    <form className="dp-search" onSubmit={(e) => { e.preventDefault(); void find(); }} role="search">
      <label className="dp-hint" htmlFor="el-in-q">شماره‌ی موبایل کامل یا نام کامل مشتری</label>
      <input id="el-in-q" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="مثلاً ۰۹۱۲۱۲۳۴۵۶۷ یا نام و نام خانوادگی" inputMode="text" autoComplete="off" data-testid="el-in-q" />
      <button type="submit" className="btn btn-ghost" disabled={busy} data-testid="el-in-go"><Search size={15} aria-hidden="true" /> {busy && !own ? 'در حال جست‌وجو…' : 'پیدا کن'}</button></form>
    {res && res.result !== 'own' && res.result !== 'other' ? <p className="dp-box sm" role="status" data-testid={`el-in-${res.result}`}><Info size={14} aria-hidden="true" /> {res.message}</p> : null}
    {res?.result === 'other' ? <div className="el-owner" role="status" data-testid="el-in-other">
      <span><Lock size={14} aria-hidden="true" /> این مشتری مال کارشناس دیگری است</span>
      <b data-testid="el-in-owner">کارشناس پرونده: {res.ownerName}</b>
      <small>{res.notified ? `به ${res.ownerName} خبر دادیم که این مشتری تماس گرفته است.` : 'برای این تماس قبلاً خبر داده شده است.'} پرونده و ثبت تماس فقط برای کارشناس خودش باز است.</small>
    </div> : null}
    {own ? <div className="dp-result" data-testid="el-in-file">
      <p><b>{own.name}</b> <span className="dp-id">#{faNum(own.id)}</span> <span className="dp-chip l-out_of_list">خارج از لیست</span> · <Link href={`/customers/${own.id}`} data-testid="el-in-open"><FileText size={13} aria-hidden="true" /> باز کردن پرونده</Link></p>
      <div className="dp-box warn sm"><b>این پرونده در لیست امروزت نیست · «خارج از لیست»</b><br />از جست‌وجوی تماس ورودی باز شد. نتیجه و یادداشت یک‌خطی لازم است. در «گزارش مدیر» جدا شمرده می‌شود و در درصد نمی‌آید.</div>
      <CqResultFields value={val} onChange={setVal} showErrors={show} idPrefix="el-in" />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid="el-in-save"><Check size={15} aria-hidden="true" /> ثبت «خارج از لیست»{back}</button></div> : null}
    {err ? <p className="dp-err" role="alert" data-testid="el-in-err">{err}</p> : null}
    {!res && !ok ? <ul className="dp-hint" data-testid="el-in-rules">
      <li><UserRound size={13} aria-hidden="true" /> فقط وقتی مشتری خودش زنگ زده. فقط یک پرونده با همان شماره یا همان نام کامل پیدا می‌شود؛ فهرست نشان داده نمی‌شود.</li>
      <li>مشتری خودت: پرونده چند دقیقه باز می‌شود و تماس «خارج از لیست» ثبت می‌شود.</li>
      <li>مشتری کارشناس دیگر: فقط نام کارشناسش را می‌بینی و به او خبر داده می‌شود.</li>
      <li>کار جاری سر جایش است و شمارنده‌ی لیست عوض نمی‌شود.</li></ul> : null}
    {onBack ? <button type="button" className="btn btn-ghost" onClick={onBack} data-testid="el-in-back">برگشت به انتخاب</button> : null}
  </section>;
}

export function IncomingStatsCard() {
  // admin users 1 / 5 only (server 403s everyone else → the card stays hidden); shown only while flag.expert_lockdown is ON.
  const data = useQuery({ queryKey: ['expert-lockdown', 'daily'], queryFn: () => elApi.daily(), retry: false, refetchInterval: 60_000 }).data;
  if (!data || !data.flag) return null;
  return <section className="card el-card" data-testid="el-stats" aria-labelledby="el-stats-h">
    <h2 id="el-stats-h"><PhoneIncoming size={16} aria-hidden="true" /> تماس ورودی کارشناس‌ها · امروز</h2>
    <table><thead><tr><th>کارشناس</th><th>باز کردن</th><th>جست‌وجو</th><th>مشتری خودش</th><th>مشتری دیگران</th><th>پیدا نشد</th><th>ثبت خارج از لیست</th></tr></thead>
      <tbody>{data.experts.map((x) => <tr key={x.userId} data-testid={`el-stats-${x.userId}`}><td>{x.name}</td><td>{faNum(x.opens)}</td><td>{faNum(x.searches)}</td><td>{faNum(x.own)}</td><td>{faNum(x.other)}</td><td>{faNum(x.none)}</td><td>{faNum(x.loggedOutOfList)}</td></tr>)}</tbody></table>
  </section>;
}
