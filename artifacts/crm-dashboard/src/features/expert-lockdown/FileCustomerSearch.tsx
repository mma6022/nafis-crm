/** FILES-SEARCH-FIX: «پرونده‌های من › ثبت پرونده جدید» step 1 for a locked expert (users 8/2/3 under expert_lockdown).
 *  The old list (GET /customers) is closed by the lockdown guard (403 expert_lockdown) so the wizard always said «مشتری یافت نشد».
 *  Same behaviour as the incoming-call search (SEARCH-C v1.1): own customers appear live by name or a few digits («مشتری خودت»);
 *  a colleague's customer only with the full 11-digit number + «پیدا کن» → name + owner + «ارجاع به …» (no id, file or history),
 *  so a second file for a colleague's customer can never be started here (the server guard refuses it too). */
import { useEffect, useRef, useState } from 'react';
import { Check, Info, Lock, Search, Send } from 'lucide-react';
import type { Customer } from '@workspace/api-client-react';
import { faNum } from '@/features/call-queue/api';
import { elApi, type ElSuggest } from './api';
import { liveQueryReady } from './IncomingCall';
import { phone11, SC } from './IncomingWizard';
import './lockdown.css';
import '@/features/daily-plan/carousel.css';

export const FS_HINT = 'مشتری‌های خودت همین‌طور که می‌نویسی می‌آیند (نام یا چند رقم). مشتری همکار فقط با شماره‌ی کامل ۱۱ رقمی و «پیدا کن» پیدا می‌شود؛ برای او پرونده نساز، به کارشناسش ارجاع بده.';
type Other = { cust: string; owner: string; refToken: string | null; referable: boolean; referred: boolean };
const tehHm = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };

export function FileCustomerSearch({ selectedId, onSelect }: { selectedId: number | null; onSelect: (c: Customer | null) => void }) {
  const [q, setQ] = useState('');
  const [live, setLive] = useState<{ q: string; r: ElSuggest } | null>(null);
  const [other, setOther] = useState<Other | null>(null);
  const [refd, setRefd] = useState<{ at: string; already: boolean } | null>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const ph = phone11(q);
  useEffect(() => { // 250 ms debounce, stale answers dropped, aborted on change (same as the incoming wizard)
    setOther(null); setRefd(null); setNone(false); setErr('');
    const t0 = q.trim(); if (!liveQueryReady(t0)) { setLive(null); return; }
    const my = ++seq.current; const ac = new AbortController();
    const t = window.setTimeout(() => { elApi.suggest(t0, ac.signal).then((r) => { if (seq.current === my) setLive({ q: t0, r }); }).catch(() => undefined); }, 250);
    return () => { window.clearTimeout(t); ac.abort(); };
  }, [q]);
  const openOwn = async (id: number) => {
    const r = await fetch(`/api/customers/${id}`, { credentials: 'include' });
    if (!r.ok) throw new Error('پرونده‌ی مشتری باز نشد. دوباره تلاش کن.');
    onSelect((await r.json()) as Customer);
  };
  const pick = async (id: number) => {
    setBusy(true); setErr('');
    try { const r = await elApi.pick(id, 'new_file'); if (r.result === 'own') await openOwn(r.customer.id); else setErr('message' in r ? r.message : 'باز نشد.'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'باز نشد.'); } finally { setBusy(false); }
  };
  const find = async () => {
    if (!ph) { setErr('برای مشتری همکار شماره‌ی موبایل کامل ۱۱ رقمی را بنویس.'); return; }
    setBusy(true); setErr(''); setOther(null); setRefd(null); setNone(false);
    try { const r = await elApi.search(ph, 'new_file');
      if (r.result === 'own') await openOwn(r.customer.id);
      else if (r.result === 'other') { onSelect(null); setOther({ cust: r.name, owner: r.ownerName, refToken: r.refToken, referable: r.referable, referred: r.referred }); }
      else if (r.result === 'none') setNone(true);
      else setErr(r.message);
    } catch (e) { setErr(e instanceof Error ? e.message : 'جست‌وجو انجام نشد.'); } finally { setBusy(false); }
  };
  const refer = async () => {
    if (!other?.refToken) return; setBusy(true); setErr('');
    try { const r = await elApi.refer(other.refToken); if (r.result === 'referred') setRefd({ at: r.at, already: r.already }); else setErr(r.message); }
    catch (e) { setErr(e instanceof Error ? e.message : 'ارجاع انجام نشد.'); } finally { setBusy(false); }
  };
  const items = live && live.r.result === 'ok' ? live.r.items : [];
  return (
    <form className="tc-form fs-search" role="search" onSubmit={(e) => { e.preventDefault(); void find(); }} data-testid="fs-search">
      <label className="lwz-search">
        <Search size={20} aria-hidden="true" />
        <span className="lwz-sr">جستجوی مشتری</span>
        <input type="search" inputMode="search" placeholder="نام یا چند رقم موبایل مشتری خودت؛ مشتری همکار: شماره‌ی کامل" value={q}
          onChange={(e) => setQ(e.target.value)} autoFocus data-testid="input-customer-search" />
      </label>
      <p className="dp-hint" data-testid="fs-hint"><Info size={13} aria-hidden="true" /> {FS_HINT}</p>
      {items.length ? <ul className="el-live" data-testid="fs-live" aria-label="مشتری‌های خودت">
        {items.map((it) => <li key={it.id}><button type="button" className={`el-live-row${selectedId === it.id ? ' on' : ''}`} aria-pressed={selectedId === it.id} disabled={busy} onClick={() => void pick(it.id)} data-testid={`wizard-customer-option-${it.id}`}>
          <b>{it.name}</b><span className="dp-chip l-own" data-testid="fs-own">{SC.own}</span><span className="el-live-ph" dir="ltr">••••{faNum(it.phoneLast4)}</span>
          {selectedId === it.id ? <Check size={16} aria-label="انتخاب شد" /> : null}</button></li>)}</ul> : null}
      {live && live.r.result === 'ok' && !items.length && live.q === q.trim() && !other && !none ? <p className="dp-box sm" role="status" data-testid="fs-live-none"><Info size={14} aria-hidden="true" /> بین مشتری‌های خودت پیدا نشد{ph ? ' — «پیدا کن» را بزن تا ببینی مشتری همکار است یا نه.' : '. اگر مشتری همکار است، شماره‌ی کامل ۱۱ رقمی را بنویس.'}</p> : null}
      {live && live.r.result !== 'ok' && live.q === q.trim() ? <p className="dp-box sm" role="status" data-testid="fs-live-msg">{live.r.message}</p> : null}
      {none ? <p className="dp-box sm" role="status" data-testid="fs-none"><Info size={14} aria-hidden="true" /> این شماره در CRM نیست. مشتری جدید را از «تماس ورودی داشتم › ثبت مشتری جدید» ثبت کن.</p> : null}
      {other && !refd ? <div className="tc-hit oth" role="status" data-testid="fs-other"><Lock size={18} aria-hidden="true" /><div>
        <b data-testid="fs-other-name">{other.cust}</b>
        <small data-testid="fs-owner">{SC.belongs(other.owner)}</small>
        <small>برای مشتری همکار پرونده ساخته نمی‌شود.</small>
        {other.referred ? <small>{SC.already}</small> : null}
        {!other.referable ? <small>{SC.notReferable}</small> : null}</div></div> : null}
      {other && refd ? <div className="tc-hit" role="status" data-testid="fs-referred"><Check size={18} aria-hidden="true" /><div>
        <b>{SC.referredTitle(other.owner)}</b><small>{refd.already ? SC.already : SC.referredLine(other.owner, tehHm(refd.at))}</small><small>{SC.b2(other.owner)}</small></div></div> : null}
      {err ? <p className="lwz-err" role="alert" data-testid="fs-err">{err}</p> : null}
      <div className="tc-foot">
        {other && !refd && other.referable && other.refToken
          ? <button type="button" className="btn btn-primary" onClick={() => void refer()} disabled={busy} data-testid="fs-refer"><Send size={15} aria-hidden="true" /> {busy ? SC.referring : SC.referTo(other.owner)}</button>
          : <button type="submit" className="btn btn-ghost" disabled={busy || !ph} data-testid="fs-find"><Search size={15} aria-hidden="true" /> {busy ? 'در حال جست‌وجو…' : 'پیدا کن'}</button>}
      </div>
    </form>
  );
}
