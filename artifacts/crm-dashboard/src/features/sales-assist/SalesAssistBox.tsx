/* «پیشنهاد دستیار فروش» — box of 3 on top of the customers page (Armita's handoff, sales-assist/HANDOFF-box.md).
   Only the signed-in expert's own list; trainees / others get eligible:false from the server and see nothing.
   PM overrides of the design: hide = admin setting (default 3 h), 4 fixed reasons, any logged call replaces the card. */
import { Bell, Check, ChevronUp, Clock, FileCheck2, Globe, Loader2, PhoneCall, Repeat, Settings2, Sparkles, Star, TrendingUp, UserRoundCheck, Zap, CalendarClock, PhoneOff } from 'lucide-react';
import { CALLED_LABEL } from '@/features/call-number/CallNumber';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { Sheet } from '@/pages/customers-ui';
import { SA_CALL_SAVED, faNum, fetchSuggestions, logCall, notNow, restore, saName, type SaChip, type SaItem, type SaReason } from './api';
import './sales-assist.css';
import { useCqConfig } from '@/features/call-queue/api';

type User = { id: number; role: string; salespersonId?: number | null } | undefined;
const PRI: Record<number, string> = { 1: 'p1', 2: 'p2', 3: 'p3' };
const chipIcon: Record<SaChip['key'], ReactNode> = { site_lead: <Globe className="i" />, urgent: <Zap className="i" />, from_kazemi: <UserRoundCheck className="i" />, repeat: <Repeat className="i" />, p1_stale: <PhoneOff className="i" /> };
const chipCls: Record<SaChip['key'], string> = { site_lead: 'site', urgent: 'urg', from_kazemi: 'kz', repeat: 'rep', p1_stale: 'p1s' };
const reasonIcon = (k: string) => ({ site_lead: <Globe className="i" />, from_kazemi: <UserRoundCheck className="i" />, reminder: <Bell className="i" />, note: <CalendarClock className="i" />,
  urgent: <Zap className="i" />, repeat: <Repeat className="i" />, upgrade: <TrendingUp className="i" />, docs: <FileCheck2 className="i" />, grade: <Star className="i" />,
  new_lead: <Sparkles className="i" />, no_call: <PhoneOff className="i" />, p1_stale: <PhoneOff className="i" /> } as Record<string, ReactNode>)[k] ?? <Clock className="i" />;

/** Keep cards under the finger: surviving ids keep their slot, vacated slots take the next ids in server order. */
function reconcile(prev: number[], ids: number[]): number[] {
  const keep = prev.filter((id) => ids.includes(id));
  const fresh = ids.filter((id) => !keep.includes(id));
  const out: number[] = [];
  for (let i = 0; i < Math.min(3, ids.length); i++) {
    const p = prev[i];
    if (p != null && keep.includes(p)) out.push(p); else { const n = fresh.shift(); if (n != null) out.push(n); }
  }
  while (out.length < Math.min(3, ids.length) && fresh.length) out.push(fresh.shift()!);
  return out;
}

export function SalesAssistBox({ user, onCall }: { user: User; onCall: (customerId: number) => void }) {
  const qc = useQueryClient();
  const isAdmin = user?.role === 'admin';
  // crm-call-queue: «الان نه» is removed when flag.hide_not_now is ON (the queue only empties by logging a call).
  const hideNotNow = Boolean(useCqConfig(Boolean(user)).data?.flags.hide_not_now);
  const [previewSp, setPreviewSp] = useState<number | null>(null);
  const key = ['sales-assist', user?.id ?? 0, previewSp ?? 0];
  const q = useQuery({ queryKey: key, queryFn: () => fetchSuggestions(previewSp), enabled: !!user, refetchInterval: 120_000, staleTime: 30_000 });
  const data = q.data;
  const ck = `nafis-sa-collapsed-${user?.id ?? 0}`;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(ck) === '1'; } catch { return false; } });
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(ck, c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  const [slots, setSlots] = useState<number[]>([]);
  const [gone, setGone] = useState<Record<number, 'call' | 'nn'>>({});
  const [freshIds, setFreshIds] = useState<number[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<SaItem | null>(null);
  const launched = useRef<SaItem | null>(null);
  const names = useRef(new Map<number, string>());
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 30_000); return () => window.clearInterval(t); }, []);

  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.customerId, i])), [data]);
  useEffect(() => {
    if (!data) return;
    for (const i of data.items) names.current.set(i.customerId, saName(i));
    setSlots((prev) => {
      const next = reconcile(prev, data.items.map((i) => i.customerId));
      const added = prev.length ? next.filter((id, idx) => prev[idx] !== undefined && prev[idx] !== id) : [];
      if (added.length) {
        setFreshIds(added);
        const left = prev.filter((id) => !next.includes(id)).map((id) => names.current.get(id)).filter(Boolean);
        if (left.length) setToast(`${left[0]} از پیشنهادها رفت · ${added.map((id) => names.current.get(id)).join('، ')} به پیشنهادها اضافه شد`);
        window.setTimeout(() => setFreshIds([]), 4000);
      }
      return next;
    });
    setGone({});
  }, [data]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 5000); return () => window.clearTimeout(t); }, [toast]);

  const refresh = () => window.setTimeout(() => { void qc.invalidateQueries({ queryKey: ['sales-assist'] }); }, 1300);
  useEffect(() => {
    const on = (e: Event) => {
      const id = Number((e as CustomEvent).detail?.customerId);
      const it = launched.current?.customerId === id ? launched.current : null;
      launched.current = null;
      if (it && !data?.preview) void logCall(it).catch(() => undefined);
      if (slots.includes(id)) { setGone((g) => ({ ...g, [id]: 'call' })); refresh(); }
    };
    window.addEventListener(SA_CALL_SAVED, on);
    return () => window.removeEventListener(SA_CALL_SAVED, on);
  });

  if (!user || (data && !data.eligible && !(isAdmin && data.previewable.length))) return null;
  if (!data && user.role !== 'admin' && (user.salespersonId == null || [5, 19, 20].includes(user.salespersonId))) return null; // trainees: no skeleton flash (server decides)
  if (q.isError && !data) return null;
  const preview = !!data?.preview || (isAdmin && !data?.eligible);
  if (isAdmin && data && !data.eligible && previewSp == null && data.previewable.length) { queueMicrotask(() => setPreviewSp(data.previewable[0].id)); }
  const items = slots.map((id) => byId.get(id)).filter((x): x is SaItem => !!x);
  const loading = q.isLoading || (isAdmin && previewSp == null);
  const mins = q.dataUpdatedAt ? Math.max(0, Math.floor((Date.now() - q.dataUpdatedAt) / 60_000)) : 0;
  const meta = loading ? 'در حال آماده کردن پیشنهادها…' : `${preview ? 'پیش‌نمایش برای کارشناس' : 'برای شما'} · به‌روز شده ${mins ? `${faNum(mins)} دقیقه پیش` : 'همین الان'}`;
  const snoozed = data?.snoozed ?? [];

  return <section className="sa" aria-label="پیشنهاد دستیار فروش" data-testid="sales-assist-box" data-state={loading ? 'loading' : items.length ? 'normal' : (data?.pool ?? 0) > 0 ? 'done' : 'empty'}>
    <div className="sa-h">
      <span className="ico" aria-hidden="true"><Sparkles className="i" /></span>
      <div className="tt">
        <h2>پیشنهاد دستیار فروش{!loading && items.length ? <span className="n">{faNum(items.length)} نفر</span> : null}</h2>
        <div className="meta">{meta}</div>
        {!loading && data?.p1Quota && data.p1Quota.quota > 0 ? <div className="sa-q" data-testid="sales-assist-p1-quota">سهمیه‌ی امروز اولویت ۱ بی‌تماس: {data.p1Quota.remaining ? <><b>{faNum(data.p1Quota.remaining)}</b> از {faNum(data.p1Quota.quota)} مانده</> : 'تمام شد'}{data.p1Quota.red ? <span className="rd"> · {faNum(data.p1Quota.red)} نفر بیش از {faNum(data.p1Quota.redDays)} روز</span> : null}</div> : null}
      </div>
      {isAdmin && data?.previewable.length ? <select className="sa-sel" aria-label="پیش‌نمایش کارشناس" value={previewSp ?? ''} onChange={(e) => { setSlots([]); setPreviewSp(Number(e.target.value)); }} data-testid="sales-assist-preview">
        {data.previewable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select> : null}
      {isAdmin ? <Link href="/sales-assist-settings" className="sa-tg" aria-label="تنظیمات دستیار فروش" title="تنظیمات دستیار فروش" data-testid="sales-assist-settings-link"><Settings2 className="i" /></Link> : null}
      <button type="button" className={`sa-tg${collapsed ? ' dn' : ''}`} onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? 'باز کردن' : 'جمع کردن'} data-testid="sales-assist-toggle"><ChevronUp className="i" /></button>
    </div>
    {collapsed ? (items.length ? <div className="sa-col">{items.map((i) => <span key={i.customerId} className="pp"><i className={PRI[i.priority ?? 0] ?? 'p0'} />{saName(i)}</span>)}</div> : null)
      : loading ? <div className="sa-g" aria-busy="true">{[0, 1, 2].map((k) => <div key={k} className="sac ld"><span className="sk w60" /><span className="sk w40" /><span className="sk h36" /><span className="sk h46" /></div>)}</div>
      : items.length ? <div className="sa-g">{items.map((it) => gone[it.customerId]
        ? <div key={it.customerId} className="sac gone" role="status"><span className="ok"><Check className="i" /></span><b>{gone[it.customerId] === 'call' ? `تماس ${saName(it)} ثبت شد` : `${saName(it)} کنار گذاشته شد`}</b><span>از پیشنهادها رفت</span><span className="nx"><Loader2 className="i sa-spin" /> نفر بعدی در راه است…</span></div>
        : <article key={it.customerId} className={`sac${freshIds.includes(it.customerId) ? ' fresh' : ''}`} data-testid={`sales-assist-card-${it.customerId}`} data-rank={it.rank} data-tier={it.tier}>
          {freshIds.includes(it.customerId) ? <span className="new"><Sparkles className="i" /> تازه</span> : null}
          <div className="r1">{/* v7: the name opens the profile (same route as the customer list). A plain router link: no dismiss / impression / call handler — only a logged call removes the card. Ctrl/Cmd/Shift/middle-click are left to the browser (new tab). */}
            <Link href={`/customers/${it.customerId}`} className="nm nm-link" title={`باز کردن پرونده‌ی ${saName(it)}`} data-testid={`sales-assist-name-${it.customerId}`}><bdi dir={/^[\d۰-۹*+\s-]+$/.test(saName(it)) ? 'ltr' : undefined}>{saName(it)}</bdi></Link><CustomerIdBadge id={it.customerId} className="cid" testId={`sales-assist-id-${it.customerId}`} />
            {it.priority ? <span className={`sa-pri ${PRI[it.priority]}`}>اولویت {faNum(it.priority)}</span> : null}</div>
          {it.chips.length ? <div className="tgs">{it.chips.slice(0, 3).map((c) => <span key={c.key} className={`tgx ${chipCls[c.key]}${c.tone === 'red' ? ' red' : ''}`} data-testid={c.key === 'p1_stale' ? `sales-assist-p1-${it.customerId}` : undefined}>{chipIcon[c.key]}{c.label}</span>)}</div> : null}
          <div className="why">{reasonIcon(it.reason.kind)}<span>{it.reason.text}</span></div>
          <div className="ac">
            <button type="button" className="sa-btn pri" disabled={preview} onClick={() => { launched.current = it; onCall(it.customerId); }} data-testid={`sales-assist-call-${it.customerId}`}><PhoneCall className="i" /> {CALLED_LABEL}</button>
            {hideNotNow ? null : <button type="button" className="sa-btn" disabled={preview} onClick={() => setSheetFor(it)} data-testid={`sales-assist-later-${it.customerId}`}><Clock className="i" /> الان نه</button>}
          </div>
        </article>)}</div>
      : (data?.pool ?? 0) > 0 || snoozed.length ? <div className="sa-em done" data-testid="sales-assist-done"><span className="big"><Check className="i" /></span><div><b>فعلاً کسی نمونده</b>
          <p>همه‌ی پیشنهادهای امروز را انجام دادید. با رسیدن سرنخ تازه یا یادآور بعدی، این‌جا دوباره پر می‌شود.</p>
          <div className="stt"><span>{faNum(data?.today?.calls ?? 0)} تماس ثبت شد</span>{hideNotNow ? null : <span>{faNum(data?.today?.notNow ?? 0)} «الان نه»</span>}</div></div>
          {snoozed.length && !preview && !hideNotNow ? <button type="button" className="sa-btn lnk" onClick={async () => { for (const s of snoozed) await restore(s.customerId).catch(() => undefined); void q.refetch(); }} data-testid="sales-assist-restore">دیدن «الان نه»‌ها ({faNum(snoozed.length)})</button> : null}</div>
      : <div className="sa-em" data-testid="sales-assist-empty"><span className="big"><Sparkles className="i" /></span><div><b>هنوز داده‌ای برای پیشنهاد نیست</b>
          <p>وقتی مشتری‌ای به شما تخصیص داده شود یا سرنخ تازه‌ای از سایت برسد، این‌جا ۳ نفر را برای تماس پیشنهاد می‌دهیم.</p></div></div>}
    {toast ? <div className="ts-toast ok sa-toast" role="status" data-testid="sales-assist-toast"><Check size={18} /> <span>{toast}</span></div> : null}
    {sheetFor ? <NotNowSheet item={sheetFor} reasons={data?.reasons ?? []} hours={data?.snoozeHours ?? 3} onClose={() => setSheetFor(null)}
      onDone={() => { const id = sheetFor.customerId; setSheetFor(null); setGone((g) => ({ ...g, [id]: 'nn' })); refresh(); }} /> : null}
  </section>;
}

function NotNowSheet({ item, reasons, hours, onClose, onDone }: { item: SaItem; reasons: SaReason[]; hours: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needs = reasons.find((r) => r.key === reason)?.needsText;
  const len = [...text].length;
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await notNow(item, reason, needs ? text.trim() : undefined); onDone(); } catch (e) { setErr((e as Error).message || 'ثبت نشد'); setBusy(false); }
  };
  return <Sheet title={`الان نه — ${saName(item)} #${faNum(item.customerId)}`} onClose={onClose} testId="sales-assist-later-sheet"
    footer={<><button type="button" className="csx-primary" disabled={!reason || busy || len > 120} onClick={() => { void submit(); }} data-testid="sales-assist-later-submit">{busy ? 'در حال ثبت…' : 'ثبت و نفر بعدی'}</button>
      <button type="button" className="csx-ghost" onClick={onClose}>انصراف</button></>}>
    <div className="sa-nn">
      <p className="sub">یک دلیل کوتاه کمک می‌کند پیشنهادها بهتر شوند.</p>
      <fieldset><legend>چرا الان نه؟ <span className="req" aria-hidden="true">*</span></legend>
        <div className="chips">{reasons.map((r) => <button key={r.key} type="button" className={`chip${reason === r.key ? ' on' : ''}`} aria-pressed={reason === r.key} onClick={() => setReason(r.key)} data-testid={`sales-assist-reason-${r.key}`}>{r.label}</button>)}</div>
      </fieldset>
      {needs ? <label className="txt"><span>توضیح کوتاه <em>اختیاری</em></span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="مثلاً: گفت بعد از ساعت ۴ زنگ بزنید" data-testid="sales-assist-later-text" />
        <small>{faNum(len)} / ۱۲۰</small></label> : null}
      <div className="info">{saName(item)} {hours > 0 ? `تا ${faNum(hours)} ساعت` : 'تا فردا صبح'} در پیشنهادها نمی‌آید و نفر بعدی جایش را می‌گیرد. در فهرست مشتریان سر جایش است.</div>
      {err ? <div className="csx-note bad" role="alert"><p>{err}</p></div> : null}
    </div>
  </Sheet>;
}
