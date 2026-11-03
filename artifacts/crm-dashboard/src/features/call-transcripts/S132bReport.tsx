/** SIMOTEL-132 B (design §7.3 mgr_report): live state per extension + per-expert call stats. No ranking, no explanation box. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTabState } from '@/lib/tab-coordinator';
import { ctReq, CtError, fa } from './api';
import '@/features/voip-call/s132b.css';

type Live = { userId: number; name: string; extension: string; support: boolean; state: string; since: string | null };
type Exp = { userId: number; name: string; calls: number; answered: number; answerRate: number | null; talkSeconds: number; avgSeconds: number | null; missedIncoming: number };
type Rep = { range: string; from: string; to: string; live: Live[]; experts: Exp[] };
const ST: Record<string, string> = { free: 'آزاد', ring: 'زنگ', talk: 'در مکالمه', pause: 'مکث', off: 'خاموش' };
const clock = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const dur = (s: number | null) => { if (s == null) return '—'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${fa(h)} ساعت و ${fa(m)} دقیقه` : m ? `${fa(m)} دقیقه${r ? ` و ${fa(r)} ثانیه` : ''}` : `${fa(r)} ثانیه`; };

export function S132bReportTab() {
  const { visible } = useTabState();
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const q = useQuery<Rep, CtError>({ queryKey: ['call-transcripts', 'b-report', range], retry: false, refetchInterval: visible ? 10_000 : false,
    queryFn: () => ctReq<Rep>('GET', `/call-transcripts/b-report?range=${range}`) });
  const d = q.data;
  return <div className="ctp" dir="rtl" data-testid="s1b-report">
    <div className="hrow"><h2>گزارش کارشناسان</h2></div>
    {q.isError ? <p className="note" role="alert">{q.error.message}</p> : null}
    {!d && !q.isError ? <p className="muted" role="status">در حال بارگذاری…</p> : null}
    {d ? <>
      <h3 className="s1b-h3">الان</h3>
      <div className="s1b-live" data-testid="s1b-live">{d.live.map((l) => <div className="s1b-lc" key={l.userId} data-testid="s1b-live-card" data-state={l.state}>
        <b>{l.name}{l.support ? ' (پشتیبانی)' : ''}</b><span>داخلی <bdi>{fa(l.extension)}</bdi></span>
        <span className={`s1b-st ${l.state}`}>{ST[l.state] ?? l.state}{l.since && l.state !== 'free' ? ` · از ${clock(l.since)}` : ''}</span></div>)}</div>
      <div className="s1b-rng" role="group" aria-label="بازه">{(['today', 'week', 'month'] as const).map((r) =>
        <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} data-testid={`s1b-rng-${r}`}>{r === 'today' ? 'امروز' : r === 'week' ? 'این هفته' : 'این ماه'}</button>)}</div>
      <table className="s1b-tbl" data-testid="s1b-tbl"><thead><tr><th>کارشناس</th><th>تماس‌ها</th><th>جواب داده</th><th>کل مکالمه</th><th>میانگین هر تماس</th><th>ورودی بی‌پاسخ</th></tr></thead>
        <tbody>{d.experts.map((e) => <tr key={e.userId}><td>{e.name}</td><td>{fa(e.calls)}</td>
          <td>{fa(e.answered)} از {fa(e.calls)}{e.answerRate != null ? ` (${fa(e.answerRate)}٪)` : ''}</td><td>{dur(e.talkSeconds)}</td><td>{dur(e.avgSeconds)}</td><td>{fa(e.missedIncoming)}</td></tr>)}</tbody></table>
      <div className="s1b-exp">{d.experts.map((e) => <div className="s1b-ec" key={e.userId}><b>{e.name}</b><dl>
        <dt>تماس‌ها</dt><dd>{fa(e.calls)}</dd><dt>جواب داده</dt><dd>{fa(e.answered)} از {fa(e.calls)}{e.answerRate != null ? ` (${fa(e.answerRate)}٪)` : ''}</dd>
        <dt>کل مکالمه</dt><dd>{dur(e.talkSeconds)}</dd><dt>میانگین هر تماس</dt><dd>{dur(e.avgSeconds)}</dd><dt>ورودی بی‌پاسخ</dt><dd>{fa(e.missedIncoming)}</dd></dl></div>)}</div>
    </> : null}
  </div>;
}
