import { Link } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import type { Application } from './api';
import { stages, stageOrder } from './stages';
import './request-cards.css';

const fa = (v: string | number | null | undefined) => v == null ? '—' : Number(v).toLocaleString('fa-IR');
const day = (v?: string) => v ? new Date(v).toLocaleDateString('fa-IR') : '—';
const terminalLabels: Record<string, string> = { rejected: 'رد شده', cancelled: 'لغو شده', canceled: 'لغو شده', closed: 'بسته شده' };
const terminalOf = (status?: string | null, stage?: string | null) => {
  for (const k of [status, stage]) if (k && terminalLabels[k.toLowerCase()]) return terminalLabels[k.toLowerCase()];
  return null;
};

export function StageTrack({ stage, status }: { stage?: string | null; status?: string | null }) {
  const terminal = terminalOf(status, stage);
  const idx = stage ? stageOrder.indexOf(stage) : -1;
  if (terminal) return <div className="cp-track terminal" role="img" aria-label={`وضعیت پایانی پرونده: ${terminal}`}>
    <div className="cp-track-dots compact">{stageOrder.map(k => <span key={k} />)}</div>
    <div className="cp-track-labels"><strong>{terminal}</strong><span className="cp-track-step">این پرونده دیگر در مسیر فعال نیست</span></div>
  </div>;
  if (idx < 0) return null;
  return <div className="cp-track" role="img" aria-label={`مسیر عمومی پرونده؛ مرحله فعلی: ${stages[stage!]}`}>
    <div className="cp-track-dots compact">{stageOrder.map((k, i) => <span key={k} className={i < idx ? 'done' : i === idx ? 'now' : ''} />)}</div>
    <div className="cp-track-labels"><strong>{stages[stage!]}</strong><span className="cp-track-step">مرحله {fa(idx + 1)} از {fa(stageOrder.length)} در مسیر عمومی</span></div>
  </div>;
}

type Payout = Application & { cashPayoutAmount?: string | null; cashPayoutEstimated?: boolean };

export function ActiveRequestList({ items, limit }: { items: Application[]; limit?: number }) {
  return <div className="cp-rc-list">{(limit ? items.slice(0, limit) : items).map(a => {
    const app = a as Payout;
    const terminal = terminalOf(app.status, app.stage);
    const done = app.stage === 'completed';
    const label = terminal || (app.stage && stages[app.stage]) || 'در حال بررسی';
    const months = app.durationMonths || app.requestedDurationMonths;
    const amt = app.cashPayoutAmount;
    return <article key={app.id} className={`cp-rc${terminal ? ' terminal' : ''}`} data-testid={`card-application-${app.id}`}>
      <Link className="cp-rc-link" href={`/customer/applications/${app.id}`} data-testid={`link-application-${app.id}`}>
        <div className="cp-rc-top">
          <span><strong>{app.planName || `درخواست شماره ${fa(app.id)}`}</strong><small>شماره پرونده {fa(app.id)} · ثبت {day(app.createdAt)}</small></span>
          <span className={`cp-rc-badge${terminal ? ' terminal' : done ? ' done' : ''}`}>{label}</span>
        </div>
        <div className="cp-rc-pay">
          <small>{app.cashPayoutEstimated ? 'برآورد مبلغ واریزی' : 'مبلغ واریز به شما'}</small>
          {amt != null && amt !== '' ? <b>{fa(amt)} تومان</b> : <b className="none">مبلغ واریزی هنوز مشخص نشده</b>}
        </div>
        <dl className="cp-rc-meta">
          <div><dt>مدت</dt><dd>{months ? `${fa(months)} ماه` : '—'}</dd></div>
          <div><dt>وضعیت فعلی</dt><dd>{label}</dd></div>
        </dl>
        <span className="cp-rc-more">مشاهده جزئیات <ChevronLeft size={14} aria-hidden="true" /></span>
      </Link>
      <StageTrack stage={app.stage} status={app.status} />
    </article>;
  })}</div>;
}
