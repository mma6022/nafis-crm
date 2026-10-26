import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { toast } from '@/hooks/use-toast';
import { asFetch, asWhen, faNum } from './api';

/** v8 «احمد | مدیر فروش» admin panel: editable underperformance thresholds (assistant_settings manager_* keys only)
 *  and a read-only preview of what the manager runner will report (today / this week). Piece B (conversions, commission,
 *  active hours, yesterday/month) is not here yet. */
type Th = { callsRatio: number; callsCompare: 'same_time' | 'full_day'; overdueRemindersMax: number; siteLeadsMax: number; p1NoCallDays: number };
type Alert = { rule: string; points: number; reason: string };
type Exp = { salespersonId: number; name: string; calls: { count: number; answered: number; answeredShare: number | null };
  overdueReminders: { count: number; maxDaysLate: number }; siteLeadsOverdue: { count: number }; p1NoCall: { count: number; days: number };
  baseline: { todayCalls: number; average: number | null; workday: boolean }; score: { points: number; level: 'ok' | 'watch' | 'alert'; alerts: Alert[] } };
type Rep = { range: 'today' | 'week'; label: string; generatedAt: string; experts: Exp[]; siteLeadsUnavailable?: boolean;
  team: { calls: number; answeredShare: number | null; overdueReminders: number; siteLeadsOverdue: number; p1NoCall: number; alerts: number } };
const LV: Record<Exp['score']['level'], { t: string; c: string; bg: string }> = {
  alert: { t: 'هشدار', c: '#B42318', bg: '#FDECEC' }, watch: { t: 'زیر نظر', c: '#8A6212', bg: '#FFF6E0' }, ok: { t: 'خوب', c: '#1F7A4D', bg: '#E8F5EE' } };
const pct = (x: number | null) => x == null ? '—' : `${faNum(Math.round(x * 100))}٪`;

export function ManagerPanel() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['admin-manager-settings'], queryFn: () => asFetch<{ thresholds: Th; defaults: Th }>('/admin/assistants/manager-settings') });
  const [range, setRange] = useState<'today' | 'week'>('today');
  const rep = useQuery({ queryKey: ['admin-manager-report', range], queryFn: () => asFetch<Rep>(`/admin/assistants/manager-report?range=${range}`), refetchInterval: 120_000 });
  const [f, setF] = useState<Th | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (st.data && !f) setF(st.data.thresholds); }, [st.data, f]);
  const save = async (body: Partial<Th>) => {
    setBusy(true);
    try { const r = await asFetch<{ thresholds: Th }>('/admin/assistants/manager-settings', { method: 'PUT', body }); setF(r.thresholds); toast({ title: 'آستانه‌ها ذخیره شد' });
      await qc.invalidateQueries({ queryKey: ['admin-manager-settings'] }); void qc.invalidateQueries({ queryKey: ['admin-manager-report'] }); }
    catch (e) { toast({ title: (e as Error).message }); } finally { setBusy(false); }
  };
  const num = (k: keyof Th, label: string, hint: string, min: number, max: number, step = 1) => <label className="mgr-f" key={k}>
    <span><b>{label}</b><small>{hint}</small></span>
    <input type="number" inputMode="decimal" dir="ltr" min={min} max={max} step={step} value={String(f![k])} disabled={busy}
      onChange={e => setF({ ...f!, [k]: e.target.value === '' ? ('' as any) : Number(e.target.value) })} data-testid={`input-mgr-${k}`} />
  </label>;

  return <div className="panel mgr-panel" data-testid="panel-manager-assistant">
    <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><BarChart3 size={18} color="#5E2B97" /> احمد | مدیر فروش — آستانه‌های کم‌کاری</h3>
    <p style={{ color: 'var(--nf-ink-muted)', fontSize: 13, marginTop: 0 }}>امتیاز فقط بر پایه‌ی امروز است. هر هشدار دلیل و عدد دارد. کارآموزها و کاربر ۲۹ در گزارش نیستند. احمد فقط می‌خواند و جز چت و اعلان برای مدیر و یادداشت دستیار چیزی نمی‌نویسد.</p>
    {st.isLoading || !f ? <SkeletonPanel rows={2} /> : st.isError ? <ErrorState onRetry={() => st.refetch()} /> : <form className="mgr-form" onSubmit={e => { e.preventDefault(); void save({ ...f, callsRatio: Number(f.callsRatio) }); }}>
      <label className="mgr-f"><span><b>تماس امروز کمتر از ٪ میانگین ۷روزه</b><small>پیش‌فرض ۷۰٪ (۱۰ تا ۱۰۰)</small></span>
        <input type="number" dir="ltr" min={10} max={100} step={5} value={f.callsRatio === ('' as any) ? '' : Math.round(Number(f.callsRatio) * 100)} disabled={busy}
          onChange={e => setF({ ...f, callsRatio: e.target.value === '' ? ('' as any) : Number(e.target.value) / 100 })} data-testid="input-mgr-callsRatio" /></label>
      <label className="mgr-f"><span><b>مقایسه با میانگین</b><small>تا همین ساعت یا کل روز</small></span>
        <select value={f.callsCompare} disabled={busy} onChange={e => setF({ ...f, callsCompare: e.target.value as Th['callsCompare'] })} data-testid="select-mgr-callsCompare">
          <option value="same_time">تا همین ساعت</option><option value="full_day">کل روز</option></select></label>
      {num('overdueRemindersMax', 'یادآور عقب‌افتاده بیش از', 'پیش‌فرض ۵', 0, 200)}
      {num('siteLeadsMax', 'سرنخ سایت بی‌جواب بیش از', 'پیش‌فرض ۰ (هر سرنخ)', 0, 50)}
      {num('p1NoCallDays', 'P1 بی‌تماس بیش از (روز)', 'پیش‌فرض ۳', 1, 60)}
      <div className="mgr-act"><button type="submit" className="btn btn-primary" disabled={busy} data-testid="button-mgr-save">ذخیره</button>
        <button type="button" className="btn" disabled={busy || !st.data} onClick={() => void save(st.data!.defaults)} data-testid="button-mgr-defaults">پیش‌فرض‌ها</button></div>
    </form>}

    <div className="mgr-head"><b>پیش‌نمایش گزارش</b>
      <div role="radiogroup" aria-label="بازه" style={{ display: 'flex', gap: 6 }}>
        {(['today', 'week'] as const).map(r => <button key={r} type="button" role="radio" aria-checked={range === r} className={`btn ${range === r ? 'btn-primary' : ''}`} onClick={() => setRange(r)} data-testid={`button-mgr-range-${r}`}>{r === 'today' ? 'امروز' : 'این هفته'}</button>)}
      </div></div>
    {rep.isLoading ? <SkeletonPanel rows={3} /> : rep.isError || !rep.data ? <ErrorState onRetry={() => rep.refetch()} /> : <>
      <div className="mgr-team" data-testid="mgr-team">
        <span>تماس: <b>{faNum(rep.data.team.calls)}</b></span><span>جواب‌داده: <b>{pct(rep.data.team.answeredShare)}</b></span>
        <span>یادآور عقب‌افتاده: <b>{faNum(rep.data.team.overdueReminders)}</b></span><span>سرنخ سایت دیرشده: <b>{faNum(rep.data.team.siteLeadsOverdue)}</b></span>
        <span>P1 بی‌تماس: <b>{faNum(rep.data.team.p1NoCall)}</b></span>
        <small>{rep.data.label} · به‌روز {asWhen(rep.data.generatedAt)}{rep.data.siteLeadsUnavailable ? ' · سرنخ سایت در دسترس نیست' : ''}</small>
      </div>
      <div className="mgr-list">{rep.data.experts.map(e => { const lv = LV[e.score.level]; return <div key={e.salespersonId} className="mgr-row" data-testid={`mgr-expert-${e.salespersonId}`}>
        <div className="mgr-rh"><b>{e.name}</b><span className="mgr-lv" style={{ color: lv.c, background: lv.bg }}>{lv.t}{e.score.points ? ` · ${faNum(e.score.points)}` : ''}</span></div>
        <div className="mgr-nums">
          <span>تماس <b>{faNum(e.calls.count)}</b>{range === 'today' && e.baseline.average != null ? <small> (میانگین {faNum(e.baseline.average)})</small> : null}</span>
          <span>جواب‌داده <b>{pct(e.calls.answeredShare)}</b></span>
          <span>یادآور عقب <b>{faNum(e.overdueReminders.count)}</b>{e.overdueReminders.count ? <small> (تا {faNum(e.overdueReminders.maxDaysLate)} روز)</small> : null}</span>
          <span>سرنخ سایت <b>{faNum(e.siteLeadsOverdue.count)}</b></span>
          <span>P1 بی‌تماس +{faNum(e.p1NoCall.days)}روز <b>{faNum(e.p1NoCall.count)}</b></span>
        </div>
        {e.score.alerts.length ? <ul className="mgr-al">{e.score.alerts.map(a => <li key={a.rule}>{a.reason}</li>)}</ul> : null}
      </div>; })}</div>
    </>}
  </div>;
}
