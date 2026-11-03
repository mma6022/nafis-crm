/** «گزارش مرکز تماس» (design v1.1 scenes 22–23): recorded calls of all experts for the sales manager (احمد) and, read-only (no flags/review/retranscribe), plain admins (not user 29; Mohammad t742s2933). No stats or scores here. */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, Filter, Flag, RefreshCw, User, X } from 'lucide-react';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { formatJalaliValue, gregorianToJalaliValue, jalaliValueToGregorian, todayJalali } from '@/lib/jalali';
import { atText, CtError, ctReq, dirText, durText, fa, useCtConfig, type CtReport, type CtRow } from './api';
import { Phone, StatusChip, TextChip } from './shared';
import './ct.css';

const tehranDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function preset(p: 'today' | 'week' | 'month'): { from: string; to: string } {
  const to = tehranDay();
  if (p === 'today') return { from: to, to };
  if (p === 'week') { const wd = new Date(`${to}T12:00:00Z`).getUTCDay(); return { from: addDays(to, -((wd + 1) % 7)), to }; } // week starts Saturday
  const j = todayJalali(); return { from: jalaliValueToGregorian(formatJalaliValue(j.year, j.month, 1)) ?? to, to };
}
type F = { from: string; to: string; p: 'today' | 'week' | 'month' | null; expert: string; callStatus: string; textStatus: string; flagged: boolean; page: number };
const TS: [string, string][] = [['all', 'همه'], ['completed', 'متن و خلاصه آماده'], ['pending_or_failed', 'در حال تبدیل به متن یا ناموفق'], ['pending', 'در حال تبدیل به متن'], ['failed', 'ناموفق'], ['no_recording', 'بدون ضبط']];
const CS: [string, string][] = [['all', 'همه'], ['answered', 'پاسخ داد'], ['missed', 'پاسخ نداد یا اشغال']];

export default function CallCenterReport() {
  const init = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const [f, setF] = useState<F>(() => ({ ...preset('week'), p: 'week', expert: init.get('expert') ?? '', callStatus: 'all', textStatus: init.get('text') ?? 'all', flagged: init.get('flagged') === '1', page: 1 }));
  const up = (x: Partial<F>) => setF((o) => ({ ...o, page: 1, ...x }));
  const qs = new URLSearchParams({ from: f.from, to: f.to, callStatus: f.callStatus, textStatus: f.textStatus, page: String(f.page), ...(f.expert ? { expert: f.expert } : {}), ...(f.flagged ? { flagged: '1' } : {}) });
  const q = useQuery<CtReport, CtError>({ queryKey: ['call-transcripts', 'report', qs.toString()], retry: false, queryFn: () => ctReq<CtReport>('GET', `/call-transcripts/report?${qs}`),
    refetchInterval: (query) => (query.state.data?.rows.some((r) => ['queued', 'processing', 'waiting'].includes(r.textState)) ? 15_000 : false) });
  const d = q.data; const cfg = useCtConfig().data; const mgr = d ? d.manager !== false : Boolean(cfg?.manager); const expertName = d?.experts.find((e) => String(e.id) === f.expert)?.name;
  const summaryLine = [f.p === 'today' ? 'امروز' : f.p === 'week' ? 'این هفته' : f.p === 'month' ? 'این ماه' : `${fa(gregorianToJalaliValue(f.from))} تا ${fa(gregorianToJalaliValue(f.to))}`,
    expertName ? `کارشناس: ${expertName}` : '', f.textStatus !== 'all' ? `وضعیت متن: ${TS.find(([k]) => k === f.textStatus)?.[1]}` : '', f.flagged && mgr ? 'فقط علامت‌خورده' : ''].filter(Boolean).join('؛ ');
  if (q.isError && (q.error.code === 'call_transcripts_off' || q.error.status === 403)) return <div className="ctp" dir="rtl"><p className="note"><AlertTriangle className="i" />{q.error.message}</p></div>;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return <div className="ctp" dir="rtl" data-testid="ct-report">
    <div className="hrow"><h2>تماس‌های ضبط‌شده‌ی کارشناسان</h2><span className="muted">{new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</span>
      {!mgr ? <span className="chip n" data-testid="ct-admin-view"><Eye className="i" />نمای مدیر سیستم، فقط مشاهده</span> : <span className="chip b"><User className="i" />نمای احمد، مدیر فروش</span>}</div>
    <details className="card flt" open={typeof window === 'undefined' || window.innerWidth >= 700}><summary><Filter className="i" />فیلترها<span className="muted">{summaryLine}</span></summary><div className="flt-b">
      <label className={`fsel${f.expert ? ' on' : ''}`}><small>کارشناس</small><select value={f.expert} onChange={(e) => up({ expert: e.target.value })} data-testid="ct-f-expert">
        <option value="">همه‌ی کارشناسان</option>{d?.experts.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <div className="fdate"><small className="muted">بازه‌ی تاریخ</small><div className="seg sm" role="group" aria-label="بازه‌ی آماده">
        {(['today', 'week', 'month'] as const).map((p) => <button key={p} type="button" aria-pressed={f.p === p} onClick={() => up({ ...preset(p), p })}>{p === 'today' ? 'امروز' : p === 'week' ? 'این هفته' : 'این ماه'}</button>)}</div>
        <div className="frng"><PersianDatePicker value={gregorianToJalaliValue(f.from)} onChange={(v) => { const g = v && jalaliValueToGregorian(v); if (g) up({ from: g, p: null }); }} testId="ct-f-from" />
          <PersianDatePicker value={gregorianToJalaliValue(f.to)} onChange={(v) => { const g = v && jalaliValueToGregorian(v); if (g) up({ to: g, p: null }); }} testId="ct-f-to" /></div></div>
      <label className={`fsel${f.callStatus !== 'all' ? ' on' : ''}`}><small>وضعیت تماس</small><select value={f.callStatus} onChange={(e) => up({ callStatus: e.target.value })} data-testid="ct-f-call">{CS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className={`fsel${f.textStatus !== 'all' ? ' on' : ''}`}><small>وضعیت متن</small><select value={f.textStatus} onChange={(e) => up({ textStatus: e.target.value })} data-testid="ct-f-text">{TS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      {mgr ? <button className="btn gh fflag" type="button" aria-pressed={f.flagged} onClick={() => up({ flagged: !f.flagged })} data-testid="ct-f-flag"><Flag className="i" />فقط علامت‌خورده برای بررسی</button> : null}
    </div></details>
    {q.isError ? <p className="note"><AlertTriangle className="i" />{q.error.message}</p> : null}
    <div className="mlh"><b data-testid="ct-count">{q.isLoading ? 'در حال دریافت…' : `${fa(d?.total ?? 0)} تماس در این فیلتر`}</b><span className="muted">تازه‌ترین بالا</span>
      {f.textStatus !== 'all' ? <button className="btn lk" type="button" onClick={() => up({ textStatus: 'all' })}><X className="i" />پاک کردن فیلتر وضعیت متن</button> : null}
      {f.expert ? <button className="btn lk" type="button" onClick={() => up({ expert: '' })}><X className="i" />پاک کردن فیلتر کارشناس</button> : null}</div>
    <ol className="mrl">{d?.rows.map((r) => <Row key={r.eventId} r={r} mgr={mgr} onDone={() => void q.refetch()} />)}</ol>
    {d && !d.rows.length ? <p className="muted">در این فیلتر تماسی نیست.</p> : null}
    {pages > 1 ? <div className="pg"><button className="btn gh" type="button" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>قبلی</button>
      <span className="muted">صفحه‌ی {fa(f.page)} از {fa(pages)}</span><button className="btn gh" type="button" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>بعدی</button></div> : null}
  </div>;
}

function snip(r: CtRow) {
  if (r.textState === 'completed') return r.summary?.subject ?? (r.summary?.state === 'failed' ? 'خلاصه ساخته نشد.' : 'خلاصه در حال ساخته شدن است.');
  if (r.textState === 'failed') return 'متن ساخته نشد؛ خلاصه ندارد تا تبدیل مجدد.';
  if (r.textState === 'no_recording') return 'مکالمه‌ای برقرار نشد یا فایل ضبط ندارد؛ متن ندارد.';
  return 'خلاصه بعد از آماده شدن متن، خودکار ساخته می‌شود.';
}
function Row({ r, mgr, onDone }: { r: CtRow; mgr: boolean; onDone: () => void }) {
  const [, nav] = useLocation(); const qc = useQueryClient(); const [confirm, setConfirm] = useState(false);
  const go = r.hasRecording ? `/call-view/${r.eventId}` : null;
  const retx = useMutation<unknown, CtError>({ mutationFn: () => ctReq('POST', `/call-transcripts/calls/${r.eventId}/retranscribe`),
    onSuccess: () => { setConfirm(false); void qc.invalidateQueries({ queryKey: ['call-transcripts', 'call', r.eventId] }); onDone(); } });
  return <li className={`mr${r.flagged ? ' fl' : ''}${go ? ' go' : ''}`} onClick={(e) => { if (go && !(e.target as HTMLElement).closest('a,button,select,input')) nav(go); }} data-testid={`ct-row-${r.eventId}`}>
    <div className="mr-h"><h3 className="mr-n">{r.customerName ?? 'مشتری ثبت‌نشده'}</h3>{r.customerId ? <span className="cid">#{fa(r.customerId)}</span> : null}
      <span className="muted">{atText(r.startedAt)}، {dirText(r.direction)}</span>{r.flagged ? <span className="chip g flg"><Flag className="i" />برای بررسی</span> : null}</div>
    <p className="mr-x"><User className="i" /><span>کارشناس: <b>{r.expertName ?? 'نامشخص'}</b></span></p>
    <div className="mr-m"><StatusChip status={r.status} /><span className="ci-d">{durText(r.durationSeconds) ?? 'بی‌مکالمه'}</span><TextChip row={r} /></div>
    <p className={`mr-s${r.textState === 'completed' && r.summary?.subject ? '' : ' muted'}`}>{r.textState === 'completed' && r.summary?.subject ? <span className="muted">خلاصه: </span> : null}{snip(r)}</p>
    <div className="mr-a"><Phone phone={r.phone} /><span className="sp" />
      {r.textState === 'failed' && mgr ? (confirm ? <><button className="btn pri" type="button" disabled={retx.isPending} onClick={() => retx.mutate()}><RefreshCw className="i" />بله، تبدیل مجدد (هزینه دارد)</button>
        <button className="btn gh" type="button" onClick={() => setConfirm(false)}>انصراف</button></> : <button className="btn gh" type="button" onClick={() => setConfirm(true)} data-testid={`ct-retx-${r.eventId}`}><RefreshCw className="i" />تبدیل مجدد</button>) : null}
      {go ? <Link className={`btn ${r.textState === 'completed' ? 'pri' : 'gh'}`} href={go}><Eye className="i" />باز کردن تماس</Link> : null}</div>
    {retx.isError ? <p className="err" role="alert">{retx.error.message}</p> : null}
  </li>;
}
