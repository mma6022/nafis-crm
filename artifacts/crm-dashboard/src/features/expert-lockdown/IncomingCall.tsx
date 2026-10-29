/** expert_lockdown «تماس ورودی · پیدا کردن پرونده» (Armita crm-daily-plan w_in_search / w_in_file / w_in_err / w_in_done).
 *  Exact match only (full mobile or full name) via POST /api/expert-lockdown/incoming/search — never a list.
 *  Own customer → the case opens for a short window and the call is logged with the normal out-of-list call form (POST /calls, context out_of_list).
 *  Another expert's customer → owner name only; the server sends that owner one internal bell. */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, FileText, Info, Lock, PhoneIncoming, Search, UserPlus, UserRound, X } from 'lucide-react';
import { cqFollowUpAt, CqResultFields, cqResultError, emptyCqResult, type CqResultValue } from '@/features/call-queue/ResultFields';
import { announceCallSaved, faNum, useCqConfig } from '@/features/call-queue/api';
import { dpApi } from '@/features/daily-plan/api';
import { elApi, type ElSearch, type ElSuggest } from './api';
import './lockdown.css';

/** SEARCH-65b input rules (mirror of the server's elPhoneQuery / elNameKey): when is a live query worth sending. */
const latin = (v: string) => v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
export function liveQueryReady(v: string): boolean {
  const s = latin(v).replace(/[\s\-–—_.()\[\]/]/g, '');
  if (/^\+?\d+$/.test(s)) return s.replace(/\D/g, '').length >= 4;
  return v.replace(/[\s\u200c]/g, '').length >= 2;
}
const PRIO_FA: Record<number, string> = { 1: 'اولویت ۱', 2: 'اولویت ۲', 3: 'اولویت ۳' };

export function LockedInbound({ onClose, onSaved, currentNo, onBack, onNew }: { onClose: () => void; onSaved: () => void; currentNo?: number | null; onBack?: () => void; onNew?: (phone: string) => void }) {
  const cq = useCqConfig().data;
  const [term, setTerm] = useState('');
  const [live, setLive] = useState<{ q: string; r: ElSuggest } | null>(null);
  const seq = useRef(0);
  useEffect(() => { // 250 ms debounce; stale answers dropped; aborted when the text changes.
    const q = term.trim(); if (!liveQueryReady(q)) { setLive(null); return; }
    const my = ++seq.current; const ac = new AbortController();
    const t = window.setTimeout(() => { elApi.suggest(q, ac.signal).then((r) => { if (seq.current === my) setLive({ q, r }); }).catch(() => { /* aborted / offline: keep last */ }); }, 250);
    return () => { window.clearTimeout(t); ac.abort(); };
  }, [term]);
  const pick = async (id: number) => {
    setBusy(true); setErr(''); setOk(''); setVal(emptyCqResult()); setShow(false);
    try { setRes(await elApi.pick(id)); setLive(null); } catch (e) { setErr(e instanceof Error ? e.message : 'باز نشد.'); } finally { setBusy(false); }
  };
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
    if (!own) return; setShow(true); if (cqResultError(val)) { setErr(''); return; } // live error lives in CqResultFields (no stale copy)
    setBusy(true); setErr('');
    try { const one = val.oneLine.trim();
      const r = await dpApi.saveCall({ customerId: own.id, salespersonId: cq?.salespersonId ?? undefined, subject: 'تماس ورودی', customerRequest: '', expertNotes: one, outcome: val.outcome, call_result: val.manual, oneLineNote: one,
        followUpAt: cqFollowUpAt(val), outOfList: true, context: 'out_of_list' });
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
      <label className="dp-hint" htmlFor="el-in-q">شماره یا نام مشتری — نتیجه همین‌طور که می‌نویسی می‌آید</label>
      <input id="el-in-q" value={term} onChange={(e) => { setTerm(e.target.value); if (res && res.result !== 'own') setRes(null); }} placeholder="چند رقم از شماره (حداقل ۴) یا نام (حداقل ۲ حرف)" inputMode="text" autoComplete="off" data-testid="el-in-q" />
      <button type="submit" className="btn btn-ghost" disabled={busy} data-testid="el-in-go"><Search size={15} aria-hidden="true" /> {busy && !own ? 'در حال جست‌وجو…' : 'پیدا کن'}</button></form>
    {!res && live && live.r.result === 'ok' && live.r.items.length ? <ul className="el-live" data-testid="el-in-live" aria-label="مشتری‌های خودت">
      {live.r.items.map((it) => <li key={it.id}><button type="button" className="el-live-row" disabled={busy} onClick={() => void pick(it.id)} data-testid={`el-in-hit-${it.id}`}>
        <b>{it.name}</b><span className="el-live-ph" dir="ltr" data-testid="el-in-hit-ph">{it.phone ? faNum(it.phone.replace(/^(?:\+98|0098)/, '0')) : `••••${faNum(it.phoneLast4)}`}</span>
        {it.priority && PRIO_FA[it.priority] ? <span className={`dp-chip p${it.priority}`}>{PRIO_FA[it.priority]}</span> : null}
        {it.match === 'exact' ? <span className="dp-chip l-exact">{(live.r.result === 'ok' && live.r.kind === 'phone') ? 'همین شماره' : 'همین نام'}</span> : null}</button></li>)}</ul> : null}
    {!res && live && live.r.result === 'ok' && !live.r.items.length && live.q === term.trim() ? <div className="dp-box sm el-live-none" role="status" data-testid="el-in-nohit">
      <span><Info size={14} aria-hidden="true" /> پیدا نشد — بین مشتری‌های خودت چنین {live.r.kind === 'phone' ? 'شماره‌ای' : 'نامی'} نیست.</span>
      {onNew ? <button type="button" className="btn btn-primary" onClick={() => onNew(live.r.result === 'ok' && live.r.phone ? live.r.phone : (live.r.result === 'ok' && live.r.kind === 'phone' ? latin(live.q).replace(/[^\d+]/g, '') : ''))} data-testid="el-in-new"><UserPlus size={15} aria-hidden="true" /> ثبت مشتری جدید</button> : null}
      <small>اگر مشتری کارشناس دیگری است، شماره‌ی کامل را بنویس و «پیدا کن» را بزن تا فقط نام کارشناسش را ببینی.</small></div> : null}
    {!res && live && live.r.result === 'rate_limited' ? <p className="dp-box sm" role="status" data-testid="el-in-live-limited">{live.r.message}</p> : null}
    {res && res.result !== 'own' && res.result !== 'other' ? <p className="dp-box sm" role="status" data-testid={`el-in-${res.result}`}><Info size={14} aria-hidden="true" /> {res.message}</p> : null}
    {res?.result === 'other' ? <div className="el-owner" role="status" data-testid="el-in-other">
      <span><Lock size={14} aria-hidden="true" /> این مشتری مال کارشناس دیگری است</span>
      <b data-testid="el-in-owner">{res.name} · این مشتری برای کارشناس {res.ownerName} است</b>
      <small>پرونده و ثبت تماس فقط برای کارشناس خودش باز است. برای ارجاع از «تماس ورودی داشتم» استفاده کن.</small>
    </div> : null}
    {own ? <div className="dp-result" data-testid="el-in-file">
      <p><b>{own.name}</b> <span className="dp-id">#{faNum(own.id)}</span> <span className="dp-chip l-out_of_list">خارج از لیست</span> · <Link href={`/customers/${own.id}`} data-testid="el-in-open"><FileText size={13} aria-hidden="true" /> باز کردن پرونده</Link></p>
      <div className="dp-box warn sm"><b>این پرونده در لیست امروزت نیست · «خارج از لیست»</b><br />از جست‌وجوی تماس ورودی باز شد. نتیجه و یادداشت یک‌خطی لازم است. در «گزارش مدیر» جدا شمرده می‌شود و در درصد نمی‌آید.</div>
      <CqResultFields value={val} onChange={setVal} showErrors={show} idPrefix="el-in" />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid="el-in-save"><Check size={15} aria-hidden="true" /> ثبت «خارج از لیست»{back}</button></div> : null}
    {err ? <p className="dp-err" role="alert" data-testid="el-in-err">{err}</p> : null}
    {!res && !ok && !live ? <ul className="dp-hint" data-testid="el-in-rules">
      <li><UserRound size={13} aria-hidden="true" /> فقط وقتی مشتری خودش زنگ زده. همین‌طور که می‌نویسی، فقط مشتری‌های خودت (حداکثر ۸ تا) می‌آیند؛ روی اسم بزن.</li>
      <li>مشتری خودت: پرونده چند دقیقه باز می‌شود و تماس «خارج از لیست» ثبت می‌شود.</li>
      <li>مشتری کارشناس دیگر (فقط با شماره‌ی کامل): نام مشتری و نام کارشناسش را می‌بینی.</li>
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
    <table><thead><tr><th>کارشناس</th><th>باز کردن</th><th>«مشتری منه»</th><th>«مشتری جدید»</th><th>جست‌وجو</th><th>مشتری خودش</th><th>مشتری دیگران</th><th>پیدا نشد</th><th>ثبت خارج از لیست</th><th>شماره‌ی تکراری</th><th>مشتری جدید ثبت شد</th></tr></thead>
      <tbody>{data.experts.map((x) => <tr key={x.userId} data-testid={`el-stats-${x.userId}`}><td>{x.name}</td><td>{faNum(x.opens)}</td><td>{faNum(x.chooseOwn ?? 0)}</td><td>{faNum(x.chooseNew ?? 0)}</td><td>{faNum(x.searches)}</td><td>{faNum(x.own)}</td><td>{faNum(x.other)}</td><td>{faNum(x.none)}</td><td>{faNum(x.loggedOutOfList)}</td><td>{faNum(x.duplicates ?? 0)}</td><td>{faNum(x.created ?? 0)}</td></tr>)}</tbody></table>
  </section>;
}
