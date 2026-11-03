/** Part 6 (design simotel v1.2 scenes 36–37): «گزارش کارشناسان» in /call-center. Live line status + per-expert counts for a range.
 *  Every number is from Simotel call events (voip_after_call_events) of the expert's extension; nothing is a sample. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, Headset, HelpCircle, Phone, PhoneIncoming, PhoneMissed, Radio } from 'lucide-react';
import { formatJalaliValue, jalaliValueToGregorian, todayJalali } from '@/lib/jalali';
import { dur, fa, hm, viApi, viReq, ViError, type ViLive, type ViReport } from './api';
import './vi.css';

type P = 'today' | 'week' | 'month';
const tehranDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function range(p: P) { const to = tehranDay(); if (p === 'today') return { from: to, to };
  if (p === 'week') { const wd = new Date(`${to}T12:00:00Z`).getUTCDay(); return { from: addDays(to, -((wd + 1) % 7)), to }; }
  const j = todayJalali(); return { from: jalaliValueToGregorian(formatJalaliValue(j.year, j.month, 1)) ?? to, to }; }
const PL: Record<P, string> = { today: 'امروز', week: 'این هفته', month: 'این ماه' };
const ST: Record<ViLive['state'], [string, string]> = { idle: ['آزاد', 'ok'], ringing: ['زنگ', 'rg'], inuse: ['در مکالمه', 'tk'], pause: ['مکث', 'ps'], unavailable: ['در دسترس نیست', 'na'], unknown: ['نامشخص', 'na'] };

export function ExpertReport({ onCalls }: { onCalls: (userId: number, r: { from: string; to: string; p: P }) => void }) {
  const [p, setP] = useState<P>('today'); const r = range(p);
  const q = useQuery<ViReport, ViError>({ queryKey: ['voip-incoming', 'report', r.from, r.to], retry: false, queryFn: () => viApi.report(r.from, r.to), refetchInterval: 60_000, refetchIntervalInBackground: false });
  const lq = useQuery<{ live: ViLive[] }, ViError>({ queryKey: ['voip-incoming', 'live'], retry: false, queryFn: () => viReq('GET', '/voip-incoming/live'), refetchInterval: 5_000, refetchIntervalInBackground: false });
  const live = lq.data?.live ?? q.data?.live ?? [];
  const rows = q.data?.rows ?? [];
  return <div className="vi vi-rep" data-testid="vi-report">
    <div className="hrow"><h2>گزارش کارشناسان</h2><span className="muted">{new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span></div>
    <section className="card vi-live" aria-labelledby="vi-live-h" data-testid="vi-live">
      <div className="vi-mch"><h3 id="vi-live-h"><Radio className="i" aria-hidden="true" /> وضعیت زنده</h3><span className="muted">هر چند ثانیه به‌روز می‌شود</span></div>
      <ul className="vi-leg" aria-label="راهنمای رنگ‌ها">{(['idle', 'ringing', 'inuse', 'pause'] as const).map((k) => <li key={k}><span className={`vi-dot ${ST[k][1]}`} aria-hidden="true" />{ST[k][0]}</li>)}</ul>
      {lq.isError && !q.data ? <p className="dp-err" role="alert">{lq.error.message}</p> : null}
      <ul className="vi-lv">{live.map((x) => <li key={x.userId} className="vi-lr" data-testid="vi-live-row" data-state={x.state}>
        <span className={`vi-dot ${ST[x.state][1]}`} aria-hidden="true" /><b>{x.name}</b><span className="muted">{x.support ? 'پشتیبانی، ' : ''}داخلی <bdi>{fa(x.extension)}</bdi></span>
        <span className={`vi-st ${ST[x.state][1]}`}>{ST[x.state][0]}{x.since && x.state !== 'idle' && x.state !== 'unknown' ? <small> از {hm(x.since)}</small> : null}</span></li>)}</ul>
      {!live.length && !lq.isLoading ? <p className="muted">کارشناسی با داخلی ویپ پیدا نشد.</p> : null}
    </section>
    <div className="vi-rh"><div className="seg sm" role="group" aria-label="بازه">{(['today', 'week', 'month'] as const).map((k) => <button key={k} type="button" aria-pressed={p === k} onClick={() => setP(k)} data-testid={`vi-p-${k}`}>{PL[k]}</button>)}</div>
      <span className="muted">{PL[p]}؛ همه‌ی تماس‌های داخلی هر کارشناس در سیموتل</span></div>
    {q.isError ? <p className="note" role="alert"><AlertTriangle className="i" />{q.error.message}</p> : q.isLoading ? <div className="dp-skel" role="status">در حال دریافت…</div> : null}
    <ol className="vi-cards">{rows.map((x) => <li key={x.userId} className="card vi-ec" data-testid="vi-expert" data-user={x.userId}>
      <div className="vi-ech"><b>{x.name}</b><span className="muted">داخلی <bdi>{fa(x.extension)}</bdi></span></div>
      <dl className="vi-stats">
        <div><dt><Phone className="i" aria-hidden="true" />تماس‌ها</dt><dd data-testid="vi-s-calls">{fa(x.calls)}</dd><small>{fa(x.outgoing)} خروجی، {fa(x.incoming)} ورودی</small></div>
        <div><dt><Headset className="i" aria-hidden="true" />پاسخ‌داده</dt><dd data-testid="vi-s-ans">{fa(x.answered)} از {fa(x.calls)}</dd><small>نرخ پاسخ {x.answerRate == null ? '—' : `٪${fa(x.answerRate)}`}</small></div>
        <div><dt><BarChart3 className="i" aria-hidden="true" />زمان مکالمه</dt><dd data-testid="vi-s-talk">{dur(x.talkSeconds)}</dd></div>
        <div><dt><BarChart3 className="i" aria-hidden="true" />میانگین هر مکالمه</dt><dd data-testid="vi-s-avg">{dur(x.avgSeconds)}</dd></div>
        <div><dt><PhoneMissed className="i" aria-hidden="true" />ورودی بی‌پاسخ</dt><dd data-testid="vi-s-missed">{fa(x.missedIncoming)}</dd></div>
      </dl>
      <button type="button" className="btn gh" onClick={() => onCalls(x.userId, { ...r, p })} data-testid="vi-drill"><PhoneIncoming className="i" aria-hidden="true" />تماس‌های {x.name}</button>
    </li>)}</ol>
    {q.data && !rows.length ? <p className="muted">کارشناسی برای گزارش نیست.</p> : null}
    <section className="card vi-help" aria-labelledby="vi-help-h"><h3 id="vi-help-h"><HelpCircle className="i" aria-hidden="true" /> هر عدد یعنی چه</h3><ul>
      <li><b>تماس‌ها</b>: هر تماس ورودی یا خروجی روی داخلی کارشناس در این بازه (هر تماس یک بار، به نام کارشناسی که روی خط بود).</li>
      <li><b>پاسخ‌داده</b>: تماس‌هایی که مکالمه برقرار شد؛ نرخ پاسخ = پاسخ‌داده تقسیم بر همه.</li>
      <li><b>زمان مکالمه</b> و <b>میانگین</b>: فقط زمان مکالمه‌ی برقرارشده، بدون زمان زنگ خوردن.</li>
      <li><b>ورودی بی‌پاسخ</b>: شماره‌هایی که تماس ورودی‌شان جواب داده نشد و به این کارشناس سپرده شد (مشتری خودش، یا اگر مشتری نبود اولین داخلی‌ای که زنگ خورد). هر شماره یک بار.</li>
      <li>پشتیبانی (خانم تاجیک) فقط در وضعیت زنده می‌آید، نه در آمار فروش.</li></ul></section>
  </div>;
}
