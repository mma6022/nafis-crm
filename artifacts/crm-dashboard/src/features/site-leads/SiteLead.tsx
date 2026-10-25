import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Globe, PhoneCall, Repeat2, Sun, Sunset, Timer } from 'lucide-react';
import { Link } from 'wouter';
import './site-leads.css';

/**
 * crm-site-leads: «سرنخ سایت» / «درخواست چندباره» chips, the «اول لیست» deadline countdown and the customer's
 * preferred call time. Server-provided (display only); the 3-hour deadline is 3 WORKING hours (team-sales rule).
 */
export type SiteLeadState = {
  active: true; requestedAt: string; latestRequestedAt: string; dueAt: string; contactTime: string; contactTimeFa: string;
  isRepeat: boolean; windowNow: boolean; openRequests: number;
};
export type TopOfList = { kind: 'site_lead' | 'from_kazemi'; startedAt: string; dueAt: string; windowNow: boolean };
export type SiteLeadRequest = { id: number; source: 'lead' | 'callback'; requestedAt: string; contactTime: string; contactTimeFa: string; isRepeat: boolean;
  answeredAt: string | null; answeredByCallId: number | null; answerSource: string | null; backfilled: boolean };

export const siteLeadOf = (c: unknown): SiteLeadState | null => {
  const v = (c as { siteLead?: SiteLeadState | null } | null)?.siteLead;
  return v && v.active ? v : null;
};
export const topOfListOf = (c: unknown): TopOfList | null => {
  const v = (c as { topOfList?: TopOfList | null } | null)?.topOfList;
  return v && (v.kind === 'site_lead' || v.kind === 'from_kazemi') && v.dueAt ? v : null;
};
export const siteLeadRequestsOf = (c: unknown): SiteLeadRequest[] => {
  const v = (c as { siteLeadRequests?: SiteLeadRequest[] } | null)?.siteLeadRequests;
  return Array.isArray(v) ? v : [];
};
/** The plain «سرنخ سایت» tag is replaced by the live chip while a request is unanswered. */
export const hideTagForSiteLead = (c: unknown) => (key: string) => !(key === 'website_lead' && siteLeadOf(c));

const fa = (n: number) => n.toLocaleString('fa-IR');
const faTime = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const faDay = (iso: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long' }).format(new Date(iso));
const faDateTime = (iso: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const tehranDayKey = (d: Date) => new Date(d.getTime() + 3.5 * 3600e3).toISOString().slice(0, 10);

/** Re-render every `ms` (countdowns). One timer per mounted component; cheap. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

export const CLOSE_MINUTES = 30;
export function remainingParts(dueAt: string, now: number): { minutes: number; overdue: boolean; close: boolean; text: string } {
  const diff = Date.parse(dueAt) - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const span = h ? `${fa(h)}:${String(m).padStart(2, '0').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])}` : `${fa(m)} دقیقه`;
  if (diff <= 0) return { minutes, overdue: true, close: true, text: `${span} گذشته` };
  return { minutes, overdue: false, close: minutes <= CLOSE_MINUTES, text: `${span} مانده` };
}

export function SiteLeadChips({ customer, testId }: { customer: unknown; testId?: string }) {
  const s = siteLeadOf(customer);
  if (!s) return null;
  const title = `درخواست از سایت: ${faDateTime(s.requestedAt)}${s.openRequests > 1 ? ` — ${fa(s.openRequests)} درخواست بی‌پاسخ` : ''} — تا ثبت تماس فعال است`;
  return <>
    <span className="slc is-site" title={title} aria-label={title} data-testid={testId ? `${testId}-site` : undefined}><Globe size={13} aria-hidden="true" /><span>سرنخ سایت</span></span>
    {s.isRepeat ? <span className="slc is-repeat" title="مشتری فعلی دوباره از سایت درخواست داده است" data-testid={testId ? `${testId}-repeat` : undefined}><Repeat2 size={13} aria-hidden="true" /><span>درخواست چندباره</span></span> : null}
  </>;
}

export function DeadlineCountdown({ customer, top: topProp, testId, size = 'sm' }: { customer?: unknown; top?: TopOfList | null; testId?: string; size?: 'sm' | 'lg' }) {
  const now = useNow();
  const top = topProp ?? topOfListOf(customer);
  if (!top) return null;
  const r = remainingParts(top.dueAt, now);
  const due = tehranDayKey(new Date(top.dueAt)) === tehranDayKey(new Date(now)) ? faTime(top.dueAt) : `${faDay(top.dueAt)} ${faTime(top.dueAt)}`;
  const label = top.kind === 'site_lead' ? 'مهلت تماس سرنخ سایت' : 'مهلت تماس اول (از کاظمی)';
  const title = `${label}: ${due} — ۳ ساعت کاری از ${top.kind === 'site_lead' ? 'درخواست' : 'تحویل'} (${faDateTime(top.startedAt)})`;
  return <span className={`sld${r.overdue ? ' is-over' : r.close ? ' is-close' : ''}${size === 'lg' ? ' is-lg' : ''}`} title={title} aria-label={`${label}: ${r.text}، تا ${due}`}
    data-testid={testId} data-state={r.overdue ? 'overdue' : r.close ? 'close' : 'ok'} data-kind={top.kind}>
    <Timer size={size === 'lg' ? 15 : 13} aria-hidden="true" /><span>{r.text}</span><span className="sld-due">تا {due}</span>
  </span>;
}

export function PreferredTimeNote({ customer, testId }: { customer: unknown; testId?: string }) {
  const s = siteLeadOf(customer);
  if (!s) return null;
  const Icon = s.contactTime === 'evening' ? Sunset : s.contactTime === 'morning' ? Sun : AlarmClock;
  const text = s.contactTime === 'morning' ? 'مشتری خواسته صبح تماس بگیرید (۹ تا ۱۳)'
    : s.contactTime === 'evening' ? 'مشتری خواسته عصر تماس بگیرید (۱۳ تا ۱۸)'
    : s.contactTime === 'now' ? 'مشتری خواسته همین الان تماس بگیرید' : 'زمان تماس برای مشتری فرقی نمی‌کند';
  return <div className={`slp${s.windowNow ? ' is-now' : ''}`} data-testid={testId} data-time={s.contactTime}>
    <Icon size={15} aria-hidden="true" /><span>{text}</span>{s.windowNow && (s.contactTime === 'morning' || s.contactTime === 'evening') ? <b className="slp-now">الان وقتش است</b> : null}
  </div>;
}

const ANSWER_FA: Record<string, string> = { call_log: 'با ثبت تماس', callback_called: '«تماس گرفته شد» در درخواست‌های تماس', callback_cancelled: 'لغو درخواست تماس', backfill: 'تماس ثبت‌شده (پیش از این قابلیت)' };
export function SiteLeadHistory({ customer }: { customer: unknown }) {
  const rows = siteLeadRequestsOf(customer);
  if (!rows.length) return null;
  const open = rows.filter((r) => !r.answeredAt).length;
  return <details className="csx-sub slh" data-testid="site-lead-history" open={open > 0 || undefined}>
    <summary><Globe size={16} aria-hidden="true" /> درخواست‌های سایت ({fa(rows.length)}{open ? ` — ${fa(open)} بی‌پاسخ` : ''})</summary>
    <ul className="slh-list">
      {rows.map((r) => <li key={r.id} className={r.answeredAt ? 'is-done' : 'is-open'} data-testid={`site-lead-request-${r.id}`}>
        <span className="slh-when">{faDateTime(r.requestedAt)}</span>
        <span className="slh-src">{r.source === 'callback' ? 'درخواست تماس' : 'فرم درخواست'}{r.isRepeat ? ' · چندباره' : ''} · زمان تماس: {r.contactTimeFa}</span>
        <span className="slh-state">{r.answeredAt ? `پاسخ داده شد ${faDateTime(r.answeredAt)}${r.answerSource ? ` — ${ANSWER_FA[r.answerSource] ?? r.answerSource}` : ''}` : 'بی‌پاسخ — در «اول لیست»'}</span>
      </li>)}
    </ul>
  </details>;
}

/* ---------- call pages: the «اول لیست» queue ---------- */
export type QueueItem = TopOfList & { customerId: number; name: string; priority: number | null; salespersonId: number | null; salespersonName: string | null; siteLead: SiteLeadState | null };
type QueueBody = { now: string; items: QueueItem[]; counts: { salespersonId: number | null; salespersonName: string | null; siteLeads: number; repeats: number; fromKazemi: number; overdue: number }[] };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const SITE_LEAD_QUEUE_KEY = ['site-leads-queue'] as const;
export function useSiteLeadQueue() {
  return useQuery({ queryKey: SITE_LEAD_QUEUE_KEY, refetchInterval: 60_000, retry: false, queryFn: async (): Promise<QueueBody> => {
    const r = await fetch(`${base()}/api/site-leads/queue`, { credentials: 'include' });
    if (!r.ok) throw new Error('دریافت فهرست انجام نشد.');
    return r.json() as Promise<QueueBody>;
  } });
}

export function SiteLeadQueuePanel({ onCall, showOwner = false }: { onCall?: (c: { id: number; name: string }) => void; showOwner?: boolean }) {
  const q = useSiteLeadQueue();
  const items = q.data?.items ?? [];
  if (q.isLoading || q.isError || !items.length) return null;
  const sites = items.filter((i) => i.kind === 'site_lead').length;
  return <section className="panel slq" data-testid="site-lead-queue" aria-label="اول لیست تماس">
    <div className="slq-head"><h3><PhoneCall size={16} aria-hidden="true" /> اول لیست تماس</h3>
      <span className="slq-sum">{sites ? `${fa(sites)} سرنخ سایت` : ''}{sites && items.length > sites ? ' · ' : ''}{items.length > sites ? `${fa(items.length - sites)} از کاظمی` : ''}</span></div>
    <ul className="slq-list">
      {items.map((i) => <li key={`${i.kind}-${i.customerId}`} data-testid={`site-lead-queue-${i.customerId}`} data-kind={i.kind}>
        <div className="slq-name"><Link href={`/customers/${i.customerId}`}>{i.name}</Link><span className="slq-id">#{fa(i.customerId)}</span></div>
        <div className="slq-chips">
          {i.kind === 'site_lead' ? <SiteLeadChips customer={{ siteLead: i.siteLead }} /> : <span className="kzs is-kz">از کاظمی</span>}
          {i.priority === 1 ? <span className="slc is-p1">اولویت ۱</span> : null}
          <DeadlineCountdown top={i} testId={`site-lead-queue-countdown-${i.customerId}`} />
          {i.siteLead && (i.siteLead.contactTime === 'morning' || i.siteLead.contactTime === 'evening') ? <span className={`slc is-time${i.siteLead.windowNow ? ' is-now' : ''}`}>{i.siteLead.contactTime === 'morning' ? 'صبح' : 'عصر'}</span> : null}
          {showOwner ? <span className="slq-owner">{i.salespersonName || 'بدون کارشناس'}</span> : null}
        </div>
        {onCall ? <button type="button" className="btn btn-primary slq-call" onClick={() => onCall({ id: i.customerId, name: i.name })} data-testid={`site-lead-queue-call-${i.customerId}`}>ثبت تماس</button> : null}
      </li>)}
    </ul>
  </section>;
}
