/** SALES-SHELL v2 locked scenes (spec §4ب / §4ب): «مشتریان» → calm card, no list; «یادآورهای من» → own list, view only.
 *  Neither page writes anything. CustLocked reads only the current task; RemLocked reads GET /reminders (own rows, GET-only allowance). */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Eye, UsersRound, ArrowLeft } from 'lucide-react';
import { useListReminders, getListRemindersQueryKey, type Reminder } from '@workspace/api-client-react';
import { dpApi } from '@/features/daily-plan/api';
import { faNum, tehranHm } from './api';

export function CustLocked() {
  const t = useQuery({ queryKey: ['ss-cur-task'], queryFn: dpApi.today, staleTime: 30_000, retry: false });
  const d = t.data && 'current' in t.data ? t.data : null;
  const cur = d?.current ?? null;
  return <div className="ss-page" data-testid="ss-cust-locked">
    <section className="ss-calm" aria-labelledby="ss-calm-t">
      <span className="ss-calm-ic" aria-hidden="true"><UsersRound size={26} /></span>
      <h2 id="ss-calm-t">اول کار جاری را ثبت کن</h2>
      <p>در حالت محدود، فهرست مشتری‌ها نشان داده نمی‌شود. وقتی نتیجه‌ی کار جاری ثبت شود، کار بعدی خودش باز می‌شود.</p>
      {cur ? <div className="ss-curmini" data-testid="ss-curmini">
        <b>کار {faNum(d!.progress.position || 1)} از {faNum(d!.progress.total)}</b>
        <span>{cur.name?.trim() || 'بدون نام'} <span className="ss-id">#{faNum(cur.customerId)}</span></span>
        {cur.reason ? <small>{cur.reason}</small> : null}
      </div> : null}
      <Link href="/today" className="btn btn-primary ss-back" data-testid="ss-back-to-current"><ArrowLeft size={18} aria-hidden="true" /> برگرد به کار جاری</Link>
      <p className="ss-foot">«الان مشتری جدید دارم» در پایین صفحه همیشه در دسترس است.</p>
    </section>
  </div>;
}

type Tab = 'today' | 'later' | 'done';
const TEH = 'Asia/Tehran';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TEH, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayLabel = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: TEH, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));

export function RemLocked() {
  const [tab, setTab] = useState<Tab>('today');
  const pOpen = { done: false };
  const pDone = { done: true };
  const open = useListReminders(pOpen, { query: { queryKey: getListRemindersQueryKey(pOpen), refetchInterval: 30_000 } });
  const done = useListReminders(pDone, { query: { queryKey: getListRemindersQueryKey(pDone), enabled: tab === 'done' } });
  const now = Date.now(); const today = dayKey(new Date());
  const g = useMemo(() => {
    const rows = open.data ?? [];
    const overdue: Reminder[] = [], laterToday: Reminder[] = [], later: Reminder[] = [];
    for (const r of rows) {
      const t = new Date(r.remindAt).getTime();
      if (t <= now) overdue.push(r); else if (dayKey(new Date(r.remindAt)) === today) laterToday.push(r); else later.push(r);
    }
    return { overdue, laterToday, later };
  }, [open.data, now, today]);
  const doneRows = useMemo(() => [...(done.data ?? [])].sort((a, b) => b.remindAt.localeCompare(a.remindAt)).slice(0, 50), [done.data]);

  const row = (r: Reminder, od: boolean) => <li key={r.id} className={`ss-rl${od ? ' od' : ''}`} data-testid={`ss-rem-${r.id}`}>
    <span className="ss-rt" dir="ltr">{tehranHm(r.remindAt)}</span>
    <span className="ss-rb"><b>{r.customerName?.trim() || (r.customerId ? 'بدون نام' : 'بدون مشتری')}</b>{r.customerId ? <span className="ss-id">#{faNum(r.customerId)}</span> : null}<small>{r.subject}{r.message && r.message !== r.subject ? ` — ${r.message}` : ''}</small></span>
  </li>;
  const tabs: { k: Tab; l: string; n?: number }[] = [
    { k: 'today', l: 'امروز', n: g.overdue.length + g.laterToday.length },
    { k: 'later', l: 'فردا و بعد', n: g.later.length },
    { k: 'done', l: 'تکمیل‌شده' },
  ];
  const laterByDay = useMemo(() => {
    const m = new Map<string, Reminder[]>();
    for (const r of g.later) { const k = dayKey(new Date(r.remindAt)); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [g.later]);

  return <div className="ss-page" data-testid="ss-rem-locked">
    <div className="ss-rhead"><h2>یادآورهای من</h2><span className="ss-ro" data-testid="ss-view-only"><Eye size={15} aria-hidden="true" /> فقط دیدن</span></div>
    <p className="ss-rnote">در حالت محدود این فهرست فقط برای دیدن است. هر یادآور سررسیده به نوبت در پنجره‌ی یادآور باز می‌شود و نتیجه همان‌جا ثبت می‌شود.</p>
    <div className="ss-seg" role="tablist" aria-label="دسته‌ی یادآورها">
      {tabs.map((t) => <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'on' : ''} onClick={() => setTab(t.k)} data-testid={`ss-rem-tab-${t.k}`}>{t.l}{t.n ? <span className="n">{faNum(t.n)}</span> : null}</button>)}
    </div>
    {open.isLoading ? <div className="ss-empty" role="status">در حال بارگذاری…</div> : open.isError ? <div className="ss-empty" role="alert">فهرست یادآورها باز نشد. کمی بعد دوباره سر بزن.</div>
      : tab === 'today' ? <>
        {g.overdue.length ? <section className="ss-rgrp red"><h3>سررسیده، {faNum(g.overdue.length)} · به نوبت در پنجره‌ی یادآور باز می‌شوند</h3><ul>{g.overdue.map((r) => row(r, true))}</ul></section> : null}
        {g.laterToday.length ? <section className="ss-rgrp"><h3>بعداً در امروز</h3><ul>{g.laterToday.map((r) => row(r, false))}</ul></section> : null}
        {!g.overdue.length && !g.laterToday.length ? <div className="ss-empty">برای امروز یادآوری نمانده.</div> : null}
      </>
      : tab === 'later' ? (laterByDay.length ? laterByDay.map(([k, rs]) => <section key={k} className="ss-rgrp"><h3>{dayLabel(rs[0].remindAt)}</h3><ul>{rs.map((r) => row(r, false))}</ul></section>) : <div className="ss-empty">یادآوری برای روزهای بعد نیست.</div>)
      : done.isLoading ? <div className="ss-empty" role="status">در حال بارگذاری…</div> : doneRows.length ? <section className="ss-rgrp done"><h3>آخرین {faNum(doneRows.length)} یادآور تکمیل‌شده</h3><ul>{doneRows.map((r) => row(r, false))}</ul></section> : <div className="ss-empty">هنوز یادآوری تکمیل نشده.</div>}
  </div>;
}
