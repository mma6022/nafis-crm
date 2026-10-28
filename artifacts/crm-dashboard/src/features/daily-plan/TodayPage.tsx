/** «کارهای امروز» for the expert (Armita v1.2 w_* / st_* / fn_* / mv_* scenes). Only the current item has a tel: button; the next ones stay locked until outcome + note are saved. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Check, ChevronDown, Clock, FileText, Lock, Phone, PhoneIncoming, Search, X } from 'lucide-react';
import { cqFollowUpAt, CqResultFields, cqResultError, emptyCqResult, focusCallResult, type CqResultValue } from '@/features/call-queue/ResultFields';
import { announceCallSaved, faClock, faNum, tehranParts, useCqConfig } from '@/features/call-queue/api';
import { custList, dpApi, DpError, useDpConfig, type DpItem, type DpToday } from './api';
import './daily-plan.css';
import { elApi, useLockdownMe } from '@/features/expert-lockdown/api';
import { IncomingTopButton, IncomingWizard, maskTel, phone11 } from '@/features/expert-lockdown/IncomingWizard';
import { TodayCarousel } from './TodayCarousel';

import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, useGetAuthSession, useGetCustomer } from '@workspace/api-client-react';
import { CallLaunchStatus, useCallLauncher } from '@/features/team-sales/useCallLauncher';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { useHistorySummary, useFileCard } from '@/features/history/api';
import { C3File, C3History, C3Upgrade, RetireeHint } from '@/features/history/TodayC3';

/** FIRSTCALL-62: the customer handed to the existing first-call form (team-sales/SimpleCallForm), same props as the customer page. */
type FcCustomer = { id: number; name: string; phone: string; priority?: number | null };
export type Working = Extract<DpToday, { eligible: true }>;
/** «چهارشنبه ۶ آبان ۱۴۰۵» — assembled from parts so the RTL order never depends on the browser's ICU pattern (Armita bug: garbled header date). */
export const faDate = (ymd: string) => {
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(new Date(`${ymd}T12:00:00+03:30`));
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? '';
  return faNum(`${g('weekday')} ${g('day')} ${g('month')} ${g('year')}`.replace(/\s+/g, ' ').trim());
};
/** REMINDER-68 (Armita review #1): experts see the CRM's masked form ۰۹۱۲***۰۰۱۲ (same helper as the incoming wizard); tel: still dials the full number. */
const telFa = (p: string) => maskTel(phone11(p) ?? p.replace(/^\+98/, '0'));

export function Chips({ i }: { i: DpItem }) {
  return <span className="dp-chips">
    {i.typeLabel ? <span className={`dp-chip t-${i.type}`}>{i.typeLabel}</span> : null}
    {i.label ? <span className={`dp-chip l-${i.source}`} data-testid="dp-label">{i.label}</span> : null}
    {i.urgent && i.type !== 'urgent' ? <span className="dp-chip t-urgent">فوری</span> : null}
    {i.priority === 1 ? <span className="dp-chip p1">اولویت ۱</span> : null}
    {i.bucket === 'extra' ? <span className="dp-chip extra">کار اضافه</span> : null}
  </span>;
}
function dial(tel: string) { const a = document.createElement('a'); a.href = tel; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
/** First return to the CRM after a tel: link (focus / visibility), once. */
function watchBack(callId: number, done: () => void) {
  const at = Date.now();
  const back = () => {
    if (document.visibilityState !== 'visible' || Date.now() - at < 3000) return;
    window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back);
    void dpApi.returned(callId).catch(() => {}).finally(done);
  };
  window.addEventListener('focus', back); document.addEventListener('visibilitychange', back);
}

export default function TodayPage() {
  const cfg = useDpConfig().data;
  const on = Boolean(cfg?.flags.daily_plan);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['daily-plan', 'today'], queryFn: dpApi.today, enabled: on, refetchInterval: 30_000, retry: false });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['daily-plan', 'today'] });
  const [inbound, setInbound] = useState(false);
  const locked = useLockdownMe(false).data?.locked === true; // expert_lockdown (assistants54): reads the shell's cached /expert-lockdown/me, never fetches
  // FIRSTCALL-62: the first-call form lives here (not in CurrentCard) so the 30s refetch / next item never unmounts its result screen.
  const [fc, setFc] = useState<FcCustomer | null>(null);
  const fcSession = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  if (!cfg || (on && q.isLoading)) return <div className="dp-page"><div className="dp-skel" role="status" data-testid="dp-loading">در حال بارگذاری کارهای امروز…</div></div>;
  if (!on) return <div className="dp-page"><h1>کارهای امروز</h1><p data-testid="dp-off">این بخش هنوز فعال نشده است.</p></div>;
  if (q.isError || !q.data) return <div className="dp-page"><h1>کارهای امروز</h1><div className="dp-box err" role="alert" data-testid="dp-error">لیست امروز بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void q.refetch()}>تلاش دوباره</button></div></div>;
  const d = q.data as DpToday;
  if (!('eligible' in d) || !d.eligible) return <div className="dp-page"><h1>کارهای امروز</h1><div className="dp-box" data-testid="dp-not-eligible">«کارهای امروز» برای کارشناس‌های فروش است. برای حساب تو لیستی ساخته نمی‌شود.</div></div>;
  if (cfg.carousel === true) return <TodayCarousel d={d} refresh={refresh} />; // incoming2-59 flag.today_carousel (8/2/3 only); OFF → the view below, unchanged
  return <div className="dp-page" data-testid="dp-today" data-state={d.state}>
    <Head d={d} />
    {locked ? <IncomingTopButton onClick={() => { if (!inbound) void elApi.open().catch(() => undefined); setInbound(true); }} testId="dp-inbound-open" /> : null}
    {d.pendingCall ? <div className="dp-box warn" role="alert" data-testid="dp-pending-other">تماس باز با <b>{d.pendingCall.customerName}</b> هنوز نتیجه ندارد. اول نتیجه و یادداشتش را ثبت کن (از «تماس ورودی» همین صفحه یا پرونده‌ی مشتری).</div> : null}
    <StateBox d={d} />
    {d.current ? <CurrentCard key={`${d.current.id}-${d.current.moveCount}`} d={d} cur={d.current} onDone={refresh} onFirstCall={setFc} /> : null}
    {fc ? <SimpleCallForm customer={fc} userId={fcSession.data?.user?.id} onClose={() => { setFc(null); refresh(); }}
      onDone={(r) => { announceCallSaved(r.callLogId, fc.id); refresh(); }} onNext={() => { setFc(null); refresh(); }} /> : null}
    {locked ? null : <div className="dp-inbound-row">
      <button type="button" className="btn btn-ghost" onClick={() => { if (locked && !inbound) void elApi.open().catch(() => undefined); setInbound((v) => !v); }} aria-expanded={inbound} data-testid="dp-inbound-open"><PhoneIncoming size={16} aria-hidden="true" /> {locked ? 'تماس ورودی داشتم' : 'تماس ورودی'}</button>
      <small>فقط وقتی مشتری خودش زنگ زده؛ کار جاری عوض نمی‌شود.</small>
    </div>}
    {inbound ? locked ? <IncomingWizard currentNo={null} onClose={() => setInbound(false)} onSaved={refresh} /> : <Inbound onClose={() => setInbound(false)} onSaved={refresh} /> : null}
    <Order d={d} />
  </div>;
}

function Head({ d }: { d: Working }) {
  const p = d.progress; const left = d.upcoming.filter((i) => i.bucket === 'main').length;
  return <header className="dp-head card" data-testid="dp-head">
    <div className="dp-head-t"><div><h1>کارهای امروز</h1><p>{faDate(d.date)}</p></div>
      {d.mode === 'auto' ? <span className="dp-chip l-auto" data-testid="dp-mode-auto">لیست خودکار</span> : d.assistantNote ? <span className="dp-note-chip" title={d.assistantNote}>یادداشت دستیار</span> : null}</div>
    {p.total ? <>
      <div className="dp-pos" data-testid="dp-pos"><b>{faNum(p.position || p.done)} از {faNum(p.total)}</b><small>کار فعلی</small></div>
      <div className="dp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="انجام لیست اصلی"><i style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></div>
      <p className="dp-sub" data-testid="dp-sub">{faNum(p.done)} انجام شد · {faNum(left)} کار بعد از این{p.extraDone ? ` · کار اضافه: ${faNum(p.extraDone)}` : ''}{p.outOfList ? ` · خارج از لیست: ${faNum(p.outOfList)}` : ''}</p>
    </> : null}
    {d.assistantNote && d.mode !== 'auto' ? <blockquote className="dp-anote" data-testid="dp-assistant-note">{d.assistantNote}</blockquote> : null}
  </header>;
}

export function StateBox({ d }: { d: Working }) {
  const s = d.state;
  if (s === 'holiday') return <div className="dp-box" data-testid="dp-st-holiday">امروز تعطیل است. لیست روز کاری بعد صبح ساعت ۰۸:۰۰ آماده می‌شود.</div>;
  if (s === 'not_started') return <div className="dp-box" data-testid="dp-st-before">لیست امروز ساعت ۰۸:۰۰ باز می‌شود.</div>;
  if (s === 'closed') return <div className="dp-box" data-testid="dp-st-closed">روز کاری بسته شد (۱۸:۰۰). کارهای انجام‌نشده بالای لیست روز کاری بعد می‌روند.</div>;
  if (s === 'empty') return <div className="dp-box" data-testid="dp-st-empty">امروز کاری در لیستت نیست.</div>;
  if (s === 'parked') { const n = [...d.moved].sort((a, b) => String(a.movedTo).localeCompare(String(b.movedTo)))[0];
    return <div className="dp-box" data-testid="dp-st-parked">فعلاً کاری نیست. {n?.movedTo ? <>کار جابه‌جاشده ساعت {faClock(n.movedTo)} برمی‌گردد.</> : null}</div>; }
  if (s === 'finished') return <div className="dp-box ok" data-testid="dp-fn-wait"><b>لیست امروز تمام شد؛ دستیار در حال افزودن کار بیشتر است.</b>{d.waitUntil ? <small> اگر تا ساعت {faClock(d.waitUntil)} کاری نرسید، «لیست خودکار» ادامه می‌دهد.</small> : null}</div>;
  if (s === 'finished_auto') return <div className="dp-box ok" data-testid="dp-fn-auto">همه‌ی کارهای امروز انجام شد. صف خودکار هم فعلاً کاری ندارد.</div>;
  return null;
}

export function CurrentCard({ d, cur, onDone, onSaved, saveLabel, onFirstCall }: { d: Working; cur: NonNullable<Working['current']>; onDone: () => void; onSaved?: (cur: DpItem) => void; saveLabel?: string; onFirstCall: (c: FcCustomer) => void }) {
  const cq = useCqConfig().data;
  // FIRSTCALL-62 (Mohammad 10:33): a first call opens EXACTLY the existing first-call form — same rule as the customer page's «ثبت تماس»
  // (useCallLauncher → usesSimpleForm: the qualifier's own in-progress customer with no priority yet). Everything else keeps the result form below.
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const custQ = useGetCustomer(cur.customerId, { query: { queryKey: getGetCustomerQueryKey(cur.customerId), retry: false } });
  const cust = custQ.data ?? (custQ.isError && user ? { id: cur.customerId, name: cur.name, phone: cur.phone ?? '', salespersonId: user.salespersonId ?? null, status: 'in_progress', priority: cur.priority ?? null } : null);
  const fcOf = (c: NonNullable<typeof cust>): FcCustomer => ({ id: cur.customerId, name: c.name ?? cur.name, phone: c.phone ?? cur.phone ?? '', priority: c.priority ?? null });
  const launcher = useCallLauncher(user, Boolean(user), (c: NonNullable<typeof cust>, kind) => { if (kind === 'simple') onFirstCall(fcOf(c)); });
  const formKind = !user || (!cust && custQ.isLoading) ? 'wait' : launcher.choose(cust);
  const firstForm = formKind === 'simple';
  const openFirst = () => { if (cust) launcher.launch(cust); };
  // «تماس» pressed before the customer/session finished loading: open the first-call form as soon as the choice is known.
  const [autoFirst, setAutoFirst] = useState(false);
  useEffect(() => { if (autoFirst && cust && formKind !== 'wait') { setAutoFirst(false); if (formKind !== 'legacy') launcher.launch(cust); } }, [autoFirst, cust, formKind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [opened, setOpened] = useState(cur.callOpen); const [val, setVal] = useState<CqResultValue>(emptyCqResult()); const [show, setShow] = useState(false);
  const [move, setMove] = useState(false); const [callAt, setCallAt] = useState<string | null>(null);
  useEffect(() => { if (cur.callOpen) setOpened(true); }, [cur.callOpen]);
  const call = async () => {
    setBusy(true); setErr('');
    try { const r = await dpApi.start(cur.id); setOpened(true); setCallAt(new Date().toISOString()); watchBack(r.callId, onDone); dial(r.tel); if (formKind !== 'legacy') { if (cust) openFirst(); else setAutoFirst(true); } }
    catch (e) { setErr(e instanceof Error ? e.message : 'تماس باز نشد.'); } finally { setBusy(false); }
  };
  const save = async () => {
    setShow(true); if (cqResultError(val)) { setErr(''); if (!val.manual) focusCallResult('dp'); return; } // live error lives in CqResultFields (no stale copy)
    setBusy(true); setErr('');
    try {
      const one = val.oneLine.trim();
      const r = await dpApi.saveCall({ customerId: cur.customerId, salespersonId: cq?.salespersonId ?? undefined, subject: 'کارهای امروز', customerRequest: '', expertNotes: one,
        outcome: val.outcome, call_result: val.manual, oneLineNote: one, followUpAt: cqFollowUpAt(val), planItemId: cur.id });
      announceCallSaved(r.id, cur.customerId); onSaved?.(cur); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  const nextNo = d.progress.position + 1;
  // HISTORY-A v1.2 + C3-79 (Mohammad 17:27): a first-call item (type 'first') keeps the one-column card + first-call form unless the
  // customer already had calls on the old form; EVERY other Today card (urgent/followup/due/…; incl. Kazemi's no-priority customers that
  // open the qualifier form) shows the three columns.
  const firstItem = cur.type === 'first';
  const hx = useHistorySummary(cur.customerId, formKind !== 'wait' && !(firstItem && formKind === 'simple'));
  const c3 = formKind !== 'wait' && Boolean(hx.data) && (firstItem ? formKind !== 'simple' && !hx.data!.firstCall : true);
  const fileQ = useFileCard(cur.customerId, c3);
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(t); }, [toast]);
  const fa = fileQ.data?.answers;
  const middle = <>
    <div className="dp-cur-top"><span className="dp-count">{cur.bucket === 'main' ? <>کار {faNum(d.progress.position)} از {faNum(d.progress.total)}</> : 'کار اضافه'}</span><Chips i={cur} /></div>
    <h2 id="dp-cur-name">{cur.name} <span className="dp-id">#{faNum(cur.customerId)}</span></h2>
    {cur.reason ? <p className="dp-reason" data-testid="dp-reason">{cur.reason}</p> : null}
    {cur.keyNote ? <div className="dp-keynote"><small><FileText size={13} aria-hidden="true" /> نکته از یادداشت‌ها</small><q>{cur.keyNote}</q></div> : null}
    {cur.phone ? <p className="dp-phone" dir="ltr" data-testid="dp-phone"><Phone size={14} aria-hidden="true" /> {telFa(cur.phone)}</p> : null}
    {opened ? <div className="dp-box ok sm" role="status" data-testid="dp-called"><Phone size={14} aria-hidden="true" /> تماس با دکمه‌ی CRM{callAt ? ` ${faClock(callAt)}` : ''} شروع شد · حالا نتیجه را ثبت کن.</div> : null}
    <div className="dp-actions">
      <button type="button" className="btn btn-primary dp-call" disabled={busy} onClick={() => void call()} data-testid="dp-call"><Phone size={16} aria-hidden="true" /> {opened ? 'دوباره گرفتن شماره' : `تماس با ${cur.name}`}</button>
      <Link href={`/customers/${cur.customerId}`} className="btn btn-ghost" data-testid="dp-file"><FileText size={16} aria-hidden="true" /> پرونده</Link>
      <a href={`/customers/${cur.customerId}#sec-calls`} target="_blank" rel="noopener" className="btn btn-ghost" title="تاریخچه‌ی تماس‌ها و یادداشت‌های قبلی (برگه‌ی جدید)" data-testid="dp-history"><Clock size={16} aria-hidden="true" /> تاریخچه</a>
    </div>
    <div className="dp-move-row">
      <button type="button" className="dp-link" disabled={cur.movesLeft <= 0 || busy} onClick={() => setMove(true)} data-testid="dp-move-open"><Clock size={15} aria-hidden="true" /> به ساعت دیگه‌ی امروز</button>
      <small data-testid="dp-move-count">جابه‌جایی {faNum(cur.moveCount)} از {faNum(d.moveMax)}</small>
    </div>
    {cur.movesLeft <= 0 ? <p className="dp-hint" data-testid="dp-move-limit">این کار ۲ بار جابه‌جا شده؛ باید نتیجه‌ی تماس ثبت شود.</p> : null}
    {c3 && hx.data?.ask?.length && !opened ? <div className="hx-askb" data-testid="c3-ask"><b>چی بپرسه</b><ul className="hx-ask">{hx.data.ask.map((a) => <li key={a}>{a}</li>)}</ul></div> : null}
    {c3 ? <RetireeHint sso={fa?.ssoRetiree} rel={fa?.ssoRetireeRelation ?? null} /> : null}
    {opened && formKind !== 'legacy' ? <div className="dp-result" data-testid="dp-result-first">
      {firstForm ? <button type="button" className="btn btn-primary dp-save" disabled={busy} onClick={openFirst} data-testid="dp-first-open"><FileText size={16} aria-hidden="true" /> فرم تماس اول</button>
        : <p className="dp-hint" role="status" data-testid="dp-first-wait">در حال آماده‌سازی فرم تماس…</p>}
      <p className="dp-hint"><Lock size={13} aria-hidden="true" /> تماس اول با «فرم تماس اول» ثبت می‌شود (اطلاعات اولیه‌ی مشتری). بعد از ثبت، کار بعدی باز می‌شود.</p>
    </div> : opened ? <div className="dp-result" data-testid="dp-result">
      <CqResultFields value={val} onChange={setVal} showErrors={show} idPrefix="dp" submitLabel="ثبت نتیجه" />
      <button type="button" className={`btn btn-primary dp-save${val.manual ? '' : ' dis'}`} disabled={busy} aria-disabled={!val.manual || undefined} onClick={() => void save()} data-testid="dp-save">{saveLabel ?? <>ثبت نتیجه و رفتن به کار {faNum(nextNo)}</>}</button>
    </div> : <p className="dp-hint"><Lock size={13} aria-hidden="true" /> {firstForm ? 'بعد از زدن «تماس»، «فرم تماس اول» باز می‌شود. کار بعدی تا ثبت آن قفل است.' : 'بعد از زدن «تماس»، فرم «نتیجه‌ی تماس» همین‌جا باز می‌شود. کار بعدی تا ثبت نتیجه و یادداشت قفل است.'}</p>}
    <CallLaunchStatus status={launcher.status} onRetry={launcher.retry} onCancel={launcher.cancel} />
    {err ? <p className="dp-err" role="alert" data-testid="dp-err">{err}</p> : null}
    {move ? <MoveSheet d={d} cur={cur} onClose={() => setMove(false)} onMoved={() => { setMove(false); onDone(); }} /> : null}
    {c3 && hx.data ? <C3Upgrade customerId={cur.customerId} name={cur.name} d={hx.data} /> : null}
  </>;
  if (!c3) return <section className="dp-cur card" aria-labelledby="dp-cur-name" data-testid="dp-current">{middle}</section>;
  return <section className="dp-cur card c3" aria-labelledby="dp-cur-name" data-testid="dp-current" data-c3="1">
    <div className="c3g">
      <C3History customerId={cur.customerId} />
      <div className="c3m" data-testid="c3-middle">{middle}</div>
      <C3File customerId={cur.customerId} name={cur.name} phone={cust?.phone ?? cur.phone ?? ''} priority={cust?.priority ?? cur.priority ?? null} onSavedToast={setToast} />
    </div>
    {toast ? <div className="hx-toast" role="status" data-testid="c3-toast"><Check size={18} aria-hidden="true" /> <span>{toast}</span></div> : null}
  </section>;
}

function MoveSheet({ d, cur, onClose, onMoved }: { d: Working; cur: DpItem; onClose: () => void; onMoved: () => void }) {
  const now = tehranParts(new Date()); const nowMin = now.h * 60 + now.mi; const last = 17 * 60 + 45;
  const chips = useMemo(() => { const out: string[] = []; for (let h = 9; h <= 17; h++) if (h * 60 > nowMin + 14) out.push(`${String(h).padStart(2, '0')}:00`); const near = out.slice(0, 5); if (last > nowMin + 14) near.push('17:45'); return near; }, [nowMin]);
  const [at, setAt] = useState(chips[0] ?? ''); const [exact, setExact] = useState(false);
  const [reason, setReason] = useState(d.moveReasons[0]?.code ?? 'customer_asked_later'); const [text, setText] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const go = async () => {
    if (!at) { setErr('ساعت را انتخاب کن.'); return; }
    if (reason === 'other' && !text.trim()) { setErr('برای «سایر» یک خط توضیح لازم است.'); return; }
    setBusy(true); setErr('');
    try { await dpApi.move(cur.id, { at: `${d.date}T${at}:00+03:30`, reason, ...(reason === 'other' ? { text: text.trim() } : {}) }); onMoved(); }
    catch (e) { setErr(e instanceof DpError || e instanceof Error ? e.message : 'جابه‌جا نشد.'); } finally { setBusy(false); }
  };
  return <div className="dp-overlay" role="presentation" onClick={onClose}>
    <div className="dp-sheet" role="dialog" aria-modal="true" aria-labelledby="dp-mv-h" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()} data-testid="dp-move-sheet">
      <div className="dp-sheet-h"><div><small><Clock size={13} aria-hidden="true" /> کار {faNum(d.progress.position)} از {faNum(d.progress.total)} · جابه‌جایی {faNum(cur.moveCount + 1)} از {faNum(d.moveMax)}</small>
        <h2 id="dp-mv-h">به ساعت دیگه‌ی امروز</h2><p>{cur.name} <span className="dp-id">#{faNum(cur.customerId)}</span></p></div>
        <button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
      <div className="field"><label>ساعت <span className="req">*</span> <small>فقط امروز · تا ۱۷:۴۵</small></label>
        <div className="dp-times">{chips.map((c) => <button key={c} type="button" className={`dp-time${!exact && at === c ? ' on' : ''}`} aria-pressed={!exact && at === c} onClick={() => { setExact(false); setAt(c); }} data-testid={`dp-mv-${c}`}>{faNum(c)}</button>)}
          <button type="button" className={`dp-time${exact ? ' on' : ''}`} aria-pressed={exact} onClick={() => setExact(true)}><Clock size={14} aria-hidden="true" /> ساعت دقیق</button></div>
        {exact ? <input type="time" step={900} min="09:00" max="17:45" value={at} onChange={(e) => setAt(e.target.value)} aria-label="ساعت دقیق" data-testid="dp-mv-exact" /> : null}
        {!chips.length ? <p className="dp-hint">دیگر ساعتی تا ۱۷:۴۵ نمانده؛ نتیجه‌ی تماس را ثبت کن.</p> : null}</div>
      <div className="field"><label>دلیل <span className="req">*</span></label>
        <div className="dp-times">{d.moveReasons.map((r) => <button key={r.code} type="button" className={`dp-time${reason === r.code ? ' on' : ''}`} aria-pressed={reason === r.code} onClick={() => setReason(r.code)} data-testid={`dp-mv-r-${r.code}`}>{r.label}</button>)}</div>
        {reason === 'other' ? <input value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="یک خط، حداکثر ۶۰ نویسه" aria-label="توضیح" data-testid="dp-mv-text" /> : null}</div>
      <ul className="dp-rules"><li>کار در ساعت انتخابی برمی‌گردد و درست بعد از کار جاری می‌نشیند، با برچسب «جابه‌جاشده».</li>
        <li>هر جابه‌جایی با ساعت و دلیل در خط زمانی پرونده ثبت می‌شود و در گزارش مدیر شمرده می‌شود.</li>
        <li>هر کار حداکثر ۲ بار؛ آخرین ساعت ۱۷:۴۵. رد کردن یا حذف کار ممکن نیست.</li>
        <li>اگر تا ۱۸:۰۰ انجام نشود، «انجام‌نشده» می‌شود و بالای لیست روز کاری بعد می‌رود.</li></ul>
      {err ? <p className="dp-err" role="alert" data-testid="dp-mv-err">{err}</p> : null}
      <div className="dp-sheet-f"><button type="button" className="btn btn-primary" disabled={busy || !at} onClick={() => void go()} data-testid="dp-mv-go"><Clock size={15} aria-hidden="true" /> جابه‌جا کن به {faNum(at || '—')}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button></div>
    </div>
  </div>;
}

function Inbound({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const cq = useCqConfig().data;
  const [term, setTerm] = useState(''); const [rows, setRows] = useState<ReturnType<typeof custList> | null>(null);
  const [pick, setPick] = useState<{ id: number; name: string } | null>(null); const [val, setVal] = useState<CqResultValue>(emptyCqResult());
  const [show, setShow] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const find = async () => { if (term.trim().length < 2) { setErr('حداقل ۲ نویسه.'); return; } setBusy(true); setErr('');
    try { setRows(custList(await dpApi.search(term.trim()))); } catch (e) { setErr(e instanceof Error ? e.message : 'جست‌وجو انجام نشد.'); } finally { setBusy(false); } };
  const save = async () => {
    if (!pick) return; setShow(true); if (cqResultError(val)) { setErr(''); return; } // live error lives in CqResultFields (no stale copy)
    setBusy(true); setErr('');
    try { const one = val.oneLine.trim();
      const r = await dpApi.saveCall({ customerId: pick.id, salespersonId: cq?.salespersonId ?? undefined, subject: 'تماس ورودی', customerRequest: '', expertNotes: one, outcome: val.outcome, call_result: val.manual, oneLineNote: one,
        followUpAt: cqFollowUpAt(val), outOfList: true, context: 'out_of_list' });
      announceCallSaved(r.id, pick.id); setOk(`برای ${pick.name} با برچسب «خارج از لیست» ثبت شد.`); setPick(null); setVal(emptyCqResult()); setShow(false); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'ثبت نشد.'); } finally { setBusy(false); }
  };
  return <section className="dp-inbound card" aria-labelledby="dp-in-h" data-testid="dp-inbound">
    <div className="dp-sheet-h"><h2 id="dp-in-h"><PhoneIncoming size={16} aria-hidden="true" /> تماس ورودی · خارج از لیست</h2><button type="button" className="dp-x" onClick={onClose} aria-label="بستن"><X size={18} /></button></div>
    <form className="dp-search" onSubmit={(e) => { e.preventDefault(); void find(); }} role="search">
      <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="نام یا شماره‌ی مشتری" aria-label="جست‌وجوی مشتری برای تماس ورودی" data-testid="dp-in-q" />
      <button type="submit" className="btn btn-ghost" disabled={busy} data-testid="dp-in-go"><Search size={15} aria-hidden="true" /> جست‌وجو</button></form>
    {ok ? <p className="dp-box ok sm" role="status" data-testid="dp-in-done"><Check size={14} aria-hidden="true" /> {ok}</p> : null}
    {rows && !pick ? rows.length ? <ul className="dp-in-list">{rows.slice(0, 10).map((c) => <li key={c.id}><button type="button" onClick={() => { setPick(c); setOk(''); }} data-testid={`dp-in-pick-${c.id}`}>
      <b>{c.name}</b> <span className="dp-id">#{faNum(c.id)}</span></button></li>)}</ul> : <p className="dp-hint">مشتری‌ای پیدا نشد.</p> : null}
    {pick ? <div className="dp-result" data-testid="dp-in-form"><p><b>{pick.name}</b> <span className="dp-id">#{faNum(pick.id)}</span> <span className="dp-chip l-out_of_list">خارج از لیست</span> · <Link href={`/customers/${pick.id}`}>پرونده</Link></p>
      <CqResultFields value={val} onChange={setVal} showErrors={show} idPrefix="dp-in" submitLabel="ثبت" />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid="dp-in-save">ثبت تماس ورودی</button></div> : null}
    {err ? <p className="dp-err" role="alert" data-testid="dp-in-err">{err}</p> : null}
  </section>;
}

function Row({ i, n, locked }: { i: DpItem; n?: number; locked?: boolean }) {
  return <li className={`dp-row s-${i.status}`} data-testid={`dp-row-${i.status}`}>
    {n ? <span className="dp-n">{faNum(n)}</span> : null}
    <div><b>{i.name}</b> <span className="dp-id">#{faNum(i.customerId)}</span> <Chips i={i} />
      {i.status === 'moved' && i.movedTo ? <small className="dp-when"> · جابه‌جاشده به {faClock(i.movedTo)}</small> : null}
      {i.status === 'undone' ? <small className="dp-when"> · انجام‌نشده</small> : null}</div>
    {locked ? <Lock size={14} className="dp-lock" aria-label="قفل" /> : i.status === 'done' ? <Check size={15} className="dp-ok" aria-label="انجام شد" /> : null}
  </li>;
}
function Order({ d }: { d: Working }) {
  const [openDone, setOpenDone] = useState(false);
  const base = d.progress.position;
  const shown = d.upcoming.slice(0, 30);
  return <section className="dp-order card" aria-labelledby="dp-ord-h" data-testid="dp-order">
    <div className="dp-order-h"><h2 id="dp-ord-h">ترتیب امروز</h2><small><Lock size={12} aria-hidden="true" /> ترتیب ثابت است</small></div>
    {d.done.length ? <button type="button" className="dp-done-t" aria-expanded={openDone} onClick={() => setOpenDone((v) => !v)} data-testid="dp-done-toggle"><Check size={14} aria-hidden="true" /> {faNum(d.done.length)} کار انجام شد <ChevronDown size={14} aria-hidden="true" /></button> : null}
    {openDone ? <ul className="dp-rows">{d.done.map((i) => <Row key={i.id} i={i} />)}</ul> : null}
    <ul className="dp-rows">
      {d.current ? <li className="dp-row s-current"><span className="dp-n">{faNum(base || 1)}</span><div><b>{d.current.name}</b> <span className="dp-id">#{faNum(d.current.customerId)}</span> <Chips i={d.current} /></div></li> : null}
      {shown.map((i, k) => <Row key={i.id} i={i} n={i.bucket === 'main' ? base + 1 + d.upcoming.slice(0, k).filter((x) => x.bucket === 'main').length : undefined} locked />)}
    </ul>
    {d.upcoming.length > shown.length ? <p className="dp-hint">{faNum(d.upcoming.length - shown.length)} کار دیگر بعد از این‌ها</p> : null}
    {d.moved.length ? <><h3>جابه‌جاشده</h3><ul className="dp-rows">{d.moved.map((i) => <Row key={i.id} i={i} locked />)}</ul></> : null}
    {d.transferred?.length ? <><h3>منتقل شد</h3><ul className="dp-rows">{d.transferred.map((i) => <Row key={i.id} i={i} />)}</ul></> : null}
    {d.undone?.length ? <><h3>انجام‌نشده</h3><ul className="dp-rows">{d.undone.map((i) => <Row key={i.id} i={i} />)}</ul></> : null}
  </section>;
}
