/**
 * «نرخ‌ها» on طرح‌های تسهیلاتی (PM 2026-10-28; design site-seo-pages v1.2 scene 36).
 * - Admin: open rate alerts («به‌زودی کهنه می‌شود» / «کهنه شد») with «به‌روزرسانی نرخ», and rate_stale_days / rate_warn_days.
 * - Everyone with loan_plans.view: «آخرین به‌روزرسانی نرخ» + history on the plan detail (PlanRateFacts).
 * The rate itself is still edited in the plan form (annual_interest); the server writes history + timestamp.
 */
import { AlertTriangle, Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errText, useMe } from '@/lib/goods-api';
import { formatDate, formatDateTime } from '@/components/CrmShell';

type Alert = { id: number; planId: number; planName: string; kind: 'soon' | 'stale'; rateUpdatedAt: string; daysLeft: number | null; hideOn: string };
type Settings = { staleDays: number; warnDays: number };
type HistoryRow = { id: number; oldValue: string | null; newValue: string | null; changedByName: string | null; changedAt: string; source: string };
const fa = (n: number) => n.toLocaleString('fa-IR');
const SOURCE: Record<string, string> = { initial_confirmed: 'تأیید اولیه', panel: 'ویرایش در پنل', create: 'ساخت طرح' };

export const planRateKeys = { alerts: ['plan-rate-alerts'] as const, settings: ['plan-rate-settings'] as const, history: (id: number) => ['plan-rate-history', id] as const };

export function PlanRateAlerts({ onUpdate }: { onUpdate: (planId: number) => void }) {
  const { isAdmin } = useMe();
  const alerts = useQuery({ queryKey: planRateKeys.alerts, queryFn: () => api.get<{ items: Alert[] }>('/loan-plan-rates/alerts'), enabled: isAdmin, staleTime: 60_000 });
  const items = alerts.data?.items ?? [];
  if (!isAdmin) return null;
  return <section className="panel" style={{ marginBottom: 14 }} data-testid="plan-rate-alerts">
    <div className="panel-head"><div><h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Bell size={16} />اعلان‌های نرخ{items.length ? ` (${fa(items.length)})` : ''}</h3>
      <p>نرخ کهنه در سایت و FAQ پنهان می‌شود و «از کارشناس بپرسید» نشان داده می‌شود.</p></div></div>
    {items.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>{items.map((a) => <li key={a.id} className={`inline-alert ${a.kind === 'stale' ? 'error' : 'warning'}`} style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 10, border: '1px solid #e5e7eb' }} data-testid={`plan-rate-alert-${a.planId}`}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>{a.kind === 'stale' ? <AlertTriangle size={18} color="#b42318" /> : <Bell size={18} color="#b54708" />}<span>
        <b>{a.kind === 'soon' ? `نرخ «${a.planName}» ${fa(a.daysLeft ?? 0)} روز دیگر کهنه می‌شود` : `نرخ «${a.planName}» کهنه شد و در سایت پنهان است`}</b><br />
        <small>{a.kind === 'soon' ? `از ${formatDate(`${a.hideOn}T12:00:00Z`)} در سایت و FAQ «از کارشناس بپرسید» نشان داده می‌شود.` : 'سایت و FAQ «از کارشناس بپرسید» نشان می‌دهند تا نرخ تازه ثبت شود.'}</small><br />
        <small>آخرین به‌روزرسانی: {formatDate(a.rateUpdatedAt)}</small></span></span>
      <button className={`btn ${a.kind === 'stale' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => onUpdate(a.planId)} data-testid={`plan-rate-update-${a.planId}`}>به‌روزرسانی نرخ</button></li>)}</ul>
      : <p className="subtle-note" style={{ margin: 0 }}>{alerts.isLoading ? 'در حال بارگذاری…' : alerts.isError ? errText(alerts.error) : 'همه‌ی نرخ‌های طرح‌های فعال تازه است.'}</p>}
    <RateSettingsForm />
  </section>;
}

function RateSettingsForm() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: planRateKeys.settings, queryFn: () => api.get<Settings>('/loan-plan-rates/settings') });
  const [form, setForm] = useState({ staleDays: '', warnDays: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setForm({ staleDays: String(q.data.staleDays), warnDays: String(q.data.warnDays) }); }, [q.data]);
  const save = async () => {
    setBusy(true); setMsg('');
    try { await api.put<Settings>('/loan-plan-rates/settings', { staleDays: Number(form.staleDays), warnDays: Number(form.warnDays) });
      setMsg('ذخیره شد.'); client.invalidateQueries({ queryKey: planRateKeys.settings }); client.invalidateQueries({ queryKey: planRateKeys.alerts }); }
    catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };
  return <details style={{ marginTop: 10 }} data-testid="plan-rate-settings"><summary>تنظیمات نرخ</summary>
    <div className="form-grid" style={{ marginTop: 8 }}>
      <div className="field"><label>rate_stale_days (روز)</label><input inputMode="numeric" value={form.staleDays} onChange={(e) => setForm({ ...form, staleDays: e.target.value.replace(/\D/g, '').slice(0, 3) })} />
        <small className="subtle-note">نرخی که آخرین به‌روزرسانی‌اش قدیمی‌تر از این باشد، در سایت و FAQ پنهان می‌شود.</small></div>
      <div className="field"><label>rate_warn_days (روز)</label><input inputMode="numeric" value={form.warnDays} onChange={(e) => setForm({ ...form, warnDays: e.target.value.replace(/\D/g, '').slice(0, 3) })} />
        <small className="subtle-note">این‌قدر پیش از کهنه شدن، برای ادمین اعلان CRM ساخته می‌شود. باید کمتر از rate_stale_days باشد.</small></div>
    </div>
    <button className="btn btn-secondary" disabled={busy} onClick={save}>ذخیره تنظیمات</button>{msg ? <span className="subtle-note" style={{ marginInlineStart: 8 }}>{msg}</span> : null}
  </details>;
}

export function PlanRateFacts({ planId }: { planId: number }) {
  const q = useQuery({ queryKey: planRateKeys.history(planId), queryFn: () => api.get<{ items: HistoryRow[] }>(`/loan-plan-rates/${planId}/history`), staleTime: 30_000 });
  const rows = q.data?.items ?? [];
  const last = rows[0];
  return <section className="plan-detail-section" data-testid="plan-rate-facts"><h4>نرخ (سود سالانه)</h4>
    <p className="subtle-note" style={{ margin: '0 0 6px' }}>آخرین به‌روزرسانی نرخ: <strong>{last ? formatDate(last.changedAt) : '—'}</strong></p>
    {rows.length ? <details><summary>تاریخچه‌ی نرخ ({fa(rows.length)})</summary><ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>{rows.map((r) =>
      <li key={r.id}>{formatDateTime(r.changedAt)} · {r.oldValue == null ? '—' : r.oldValue} ← {r.newValue == null ? '—' : r.newValue} · {SOURCE[r.source] ?? r.source}{r.changedByName ? ` · ${r.changedByName}` : ''}</li>)}</ul></details> : null}
  </section>;
}
