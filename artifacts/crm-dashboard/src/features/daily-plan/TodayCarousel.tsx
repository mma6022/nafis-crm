/** incoming2-59 «کارهای امروز من» — card deck (Armita crm-daily-plan-cards v1.0), only behind flag.today_carousel (server: users 8/2/3).
 *  Built from the same GET /daily-plans/today data as the list view: done (oldest first, read-only) → current → upcoming (locked, peeks only).
 *  One open card; order is fixed (no manual swipe — Armita «سوایپ دستی نداریم»); the deck advances by itself only after a 2xx save.
 *  «کار N از M» counts the main list only. «تماس ورودی داشتم» is always visible (header ≥1024px, sticky bottom bar on phone). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, FileText, Flag, Info, Lock, PartyPopper, PhoneIncoming, Search, UserPlus, Users, X } from 'lucide-react';
import { faClock, faNum } from '@/features/call-queue/api';
import { elApi } from '@/features/expert-lockdown/api';
import { IncomingTopButton, IncomingWizard } from '@/features/expert-lockdown/IncomingWizard';
import { useSsIncoming } from '@/features/sales-shell/api';
import { dpApi, type DpItem } from './api';
import { Chips, CurrentCard, StateBox, faDate, type Working } from './TodayPage';
import './carousel.css';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { announceCallSaved } from '@/features/call-queue/api';

const OUT: Record<string, string> = { connected: 'صحبت شد', no_answer: 'جواب نداد', follow_up: 'پیگیری', not_interested: 'تمایل ندارد', wrong_number: 'شماره اشتباه' };
const ev = (name: string, itemId?: number | null, cardIndex?: number | null) => { void dpApi.carouselEvent(`today_carousel_${name}`, { itemId: itemId ?? null, cardIndex: cardIndex ?? null }).catch(() => undefined); };
const doneAsc = (d: Working) => [...d.done].sort((a, b) => String(a.doneAt ?? '').localeCompare(String(b.doneAt ?? '')) || a.id - b.id);
const focusHead = (el: HTMLElement | null) => { const h = el?.querySelector<HTMLElement>('h2,h3'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } };

export function TodayCarousel({ d, refresh }: { d: Working; refresh: () => void }) {
  const done = useMemo(() => doneAsc(d), [d]);
  const cur = d.current;
  const p = d.progress;
  const [back, setBack] = useState(0); // 0 = current (or the last done card when there is no current)
  const [anim, setAnim] = useState<'' | 'next' | 'prev'>('');
  const [toast, setToast] = useState(''); const flashT = useRef<number | undefined>(undefined);
  const [live, setLive] = useState('');
  const [wiz, setWiz] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const pendingAdvance = useRef<{ name: string } | null>(null);
  // FIRSTCALL-62 in the carousel: a first-call item opens the existing first-call form, held at page level (the card unmounts on advance).
  const [fc, setFc] = useState<{ id: number; name: string; phone: string; priority?: number | null } | null>(null);
  const fcSession = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const seen = useRef<Set<number> | null>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const lastCur = useRef<number | null>(cur?.id ?? null);

  const reviewLen = done.length + (cur ? 1 : 0);
  const maxBack = Math.max(0, cur ? done.length : done.length - 1);
  const b = Math.min(back, maxBack);
  const viewDone: DpItem | null = cur && b === 0 ? null : done[done.length - (cur ? b : b + 1)] ?? null;
  const onCurrent = !!cur && b === 0;
  const finished = !cur && (d.state === 'finished' || d.state === 'finished_auto');
  // release 69 (Armita live-59 #3): ~3 s, bottom on mobile too (own class: team-commission.css also defines a global .tc-toast that pinned it to the top on phones).
  const flash = (m: string) => { setToast(m); window.clearTimeout(flashT.current); flashT.current = window.setTimeout(() => setToast(''), 3000); };
  const kick = (a: 'next' | 'prev') => { setAnim(a); window.setTimeout(() => setAnim(''), 300); };

  useEffect(() => { ev('view', cur?.id, cur ? reviewLen : null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (finished) ev('finished_view'); }, [finished]);
  useEffect(() => { // an urgent item that newly lands right after the current card → one-time banner
    const nx = d.upcoming[0];
    if (seen.current && nx && nx.urgent && !seen.current.has(nx.id)) setUrgent(true);
    seen.current = new Set([...(seen.current ?? []), ...d.upcoming.map((i) => i.id)]);
  }, [d.upcoming]);
  useLayoutEffect(() => { // auto-advance: the current id changed after our own 2xx save
    const now = cur?.id ?? null;
    if (now === lastCur.current) return;
    lastCur.current = now; setBack(0);
    const pa = pendingAdvance.current; pendingAdvance.current = null;
    if (!pa) return;
    kick('next');
    const no = p.position || p.done;
    setLive(cur ? (cur.bucket === 'main' ? `کار ${faNum(no)} از ${faNum(p.total)}` : 'کار اضافه') : 'لیست امروز تمام شد');
    flash(`${pa.name}: نتیجه ثبت شد${cur && cur.bucket === 'main' ? ` · کار ${faNum(no)}` : ''}`);
    ev('auto_advance', now, now ? done.length + 1 : null);
    window.setTimeout(() => focusHead(deckRef.current), 290);
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const page = (dir: 'back' | 'fwd' | 'cur') => {
    const nb = dir === 'back' ? Math.min(maxBack, b + 1) : dir === 'fwd' ? Math.max(0, b - 1) : 0;
    if (nb === b) return;
    kick(dir === 'back' ? 'prev' : 'next'); setBack(nb);
    ev(dir === 'back' ? 'page_back' : dir === 'fwd' ? 'page_forward' : 'back_to_current');
    window.setTimeout(() => focusHead(deckRef.current), 0);
  };

  const mainUp = d.upcoming.filter((i) => i.bucket === 'main');
  const next = d.upcoming[0] ?? null;
  const posLine = cur
    ? cur.bucket === 'main' ? <>کار <b>{faNum(p.position)}</b> از <b>{faNum(p.total)}</b></> : <>کار اضافه · لیست اصلی {faNum(p.done)} از {faNum(p.total)}</>
    : p.total ? <>{faNum(p.done)} از {faNum(p.total)} · {finished ? 'همه انجام شد' : 'کار جاری نداری'}</> : null;
  const openWiz = () => { setWiz(true); ev('incoming_open', cur?.id, cur ? reviewLen : null); void elApi.open().catch(() => undefined); };
  const curNo = cur && cur.bucket === 'main' ? p.position : null;
  useSsIncoming(() => { if (!wiz) openWiz(); return true; }); // SALES-SHELL v2: the dock's «الان مشتری جدید دارم» opens this same wizard

  return <div className="dp-page tc-page" data-testid="dp-today" data-state={d.state} data-view="carousel">
    <header className="tc-head">
      <div><h1>کارهای امروز من</h1><p className="tc-date" data-testid="tc-date"><bdi>{faDate(d.date)}</bdi></p></div>
      {d.mode === 'auto' ? <span className="dp-chip l-auto" data-testid="dp-mode-auto">لیست خودکار</span> : null}
    </header>
    <IncomingTopButton onClick={openWiz} testId="tc-inb" />

    {p.total || cur ? <section className="tc-kp" aria-label="پیشرفت لیست اصلی" data-testid="tc-progress">
      <div className="tc-kpr"><span className="tc-pos" data-testid="tc-pos">{posLine}</span>
        <small>{faNum(p.done)} انجام شد · {faNum(mainUp.length)} کار بعد از این</small>
        {p.extraDone ? <span className="dp-chip extra" data-testid="tc-extra">کار اضافه: {faNum(p.extraDone)} (جدا شمرده می‌شود)</span> : null}
        {p.outOfList ? <span className="dp-chip l-out_of_list">خارج از لیست: {faNum(p.outOfList)}</span> : null}</div>
      {p.total ? <div className="tc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label="انجام لیست اصلی"><i style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></div> : null}
    </section> : null}

    {d.assistantNote && d.mode !== 'auto' ? <p className="tc-anote" data-testid="dp-assistant-note"><Info size={14} aria-hidden="true" /> {d.assistantNote}</p> : null}
    {d.pendingCall ? <div className="dp-box warn" role="alert" data-testid="dp-pending-other">تماس باز با <b>{d.pendingCall.customerName}</b> هنوز نتیجه ندارد. اول نتیجه و یادداشتش را ثبت کن (از «تماس ورودی داشتم» یا پرونده‌ی مشتری).</div> : null}
    {urgent ? <div className="tc-urgent" role="alert" data-testid="tc-urgent"><AlertTriangle size={16} aria-hidden="true" /> مشتری فوری درست بعد از کار جاری اضافه شد
      <button type="button" className="dp-x" onClick={() => setUrgent(false)} aria-label="بستن"><X size={16} /></button></div> : null}
    {!cur && !finished ? <StateBox d={d} /> : null}

    <div className={`tc-deck${anim ? ` a-${anim}` : ''}`} ref={deckRef} data-testid="tc-deck">
      {onCurrent && next ? <i className="tc-pk" aria-hidden="true" /> : null}
      {onCurrent && d.upcoming[1] ? <i className="tc-pk tc-pk2" aria-hidden="true" /> : null}
      <div className="tc-card" key={onCurrent ? `c${cur!.id}-${cur!.moveCount}` : viewDone ? `d${viewDone.id}` : 'fin'} data-testid="tc-card">
        {onCurrent ? <CurrentCard d={d} cur={cur!} onDone={refresh} saveLabel="ثبت نتیجه و کار بعدی" onSaved={(it) => { pendingAdvance.current = { name: it.name }; }} onFirstCall={setFc} />
          : viewDone ? <DoneCard it={viewDone} no={done.indexOf(viewDone) + 1} of={reviewLen} />
          : finished ? <FinishedCard d={d} /> : null}
      </div>
    </div>

    {reviewLen > 1 || b > 0 ? <nav className="tc-pager" aria-label="مرور کارت‌های انجام‌شده" data-testid="tc-pager">
      <button type="button" className="btn btn-ghost" disabled={b >= maxBack} onClick={() => page('back')} data-testid="tc-back"><ChevronRight size={16} aria-hidden="true" /> کار انجام‌شده‌ی قبلی</button>
      {b > 0 ? <button type="button" className="btn btn-ghost" onClick={() => page('fwd')} data-testid="tc-fwd">بعدی <ChevronLeft size={16} aria-hidden="true" /></button> : null}
      {b > 0 && cur ? <button type="button" className="btn btn-primary" onClick={() => page('cur')} data-testid="tc-to-current">برگشت به کار جاری</button> : null}
    </nav> : null}

    {onCurrent && next ? <p className="tc-dots" data-testid="tc-next"><span className="tc-nxt">بعدی: <b>{next.name}</b> <span className="dp-id">#{faNum(next.customerId)}</span>
      {next.urgent ? <span className="dp-chip t-urgent">فوری</span> : seen.current && !seen.current.has(next.id) ? <span className="dp-chip">تازه اضافه شد</span> : null}</span>
      <small><Lock size={12} aria-hidden="true" /> ترتیب ثابت است · فقط کارت جاری باز است</small></p> : null}
    {d.moved.length ? <p className="dp-hint" data-testid="tc-moved">جابه‌جاشده‌ها: {d.moved.map((m) => `${m.name}${m.movedTo ? ` (${faClock(m.movedTo)})` : ''}`).join('، ')}</p> : null}

    <p className="tc-live" aria-live="polite" role="status" data-testid="tc-live">{live}</p>
    {toast ? <div className="tc-ctoast" role="status" data-testid="tc-toast"><Check size={15} aria-hidden="true" /> {toast}</div> : null}
    {fc ? <SimpleCallForm customer={fc} userId={fcSession.data?.user?.id} onClose={() => { setFc(null); refresh(); }}
      onDone={(r) => { announceCallSaved(r.callLogId, fc.id); pendingAdvance.current = { name: fc.name }; refresh(); }} onNext={() => { setFc(null); refresh(); }} /> : null}
    {wiz ? <IncomingWizard currentNo={curNo} onClose={(why) => { setWiz(false); setBack(0); if (why === 'cancel') ev('incoming_cancel'); window.setTimeout(() => focusHead(deckRef.current), 0); }} onSaved={(m) => { refresh(); flash(m); }} onEvent={(n) => ev(n)} /> : null}
  </div>;
}

function DoneCard({ it, no, of }: { it: DpItem; no: number; of: number }) {
  return <section className="dp-cur card tc-done" aria-labelledby={`tc-d-${it.id}`} data-testid="tc-done-card">
    <div className="dp-cur-top"><span className="dp-count">کارت {faNum(no)} از {faNum(of)} · فقط خواندنی</span><Chips i={it} /></div>
    <h3 id={`tc-d-${it.id}`}>{it.name} <span className="dp-id">#{faNum(it.customerId)}</span></h3>
    <p className="tc-done-st"><Check size={15} aria-hidden="true" /> انجام شد{it.outcome ? ` · ${OUT[it.outcome] ?? it.outcome}` : ''}{it.doneAt ? ` · ساعت ${faClock(it.doneAt)}` : ''}</p>
    {it.reason ? <p className="dp-reason">{it.reason}</p> : null}
    <Link href={`/customers/${it.customerId}`} className="btn btn-ghost" data-testid="tc-done-file"><FileText size={16} aria-hidden="true" /> پرونده</Link>
  </section>;
}

function FinishedCard({ d }: { d: Working }) {
  return <section className="dp-cur card tc-fin" aria-labelledby="tc-fin-h" data-testid="tc-finished">
    <PartyPopper size={40} aria-hidden="true" className="tc-fin-i" />
    <h3 id="tc-fin-h">لیست امروز تمام شد</h3>
    {d.state === 'finished_auto' ? <p>همه‌ی کارهای امروز انجام شد. صف خودکار هم فعلاً کاری ندارد.</p>
      : <p>دستیار در حال افزودن کار بیشتر است.{d.waitUntil ? ` اگر تا ساعت ${faClock(d.waitUntil)} کاری نرسید، «لیست خودکار» ادامه می‌دهد.` : ''}</p>}
  </section>;
}
