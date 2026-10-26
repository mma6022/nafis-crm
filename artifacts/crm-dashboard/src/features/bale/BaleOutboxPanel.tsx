import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Inbox, Paperclip } from 'lucide-react';
import { baleFetch, baleWhen, OUTBOX_STATUS_LABEL, type BaleOutboxItem } from './api';
import './bale.css';

/** «پیام‌های بله‌ی من» on /settings/bale: the expert's active + recent blocked/failed outbox rows (last 3 days).
 *  Out-of-scope rows come from the server without customer or text. Actions live on each customer's tab. */
export function BaleOutboxPanel() {
  const q = useQuery({ queryKey: ['bale', 'outbox'], queryFn: () => baleFetch<{ items: BaleOutboxItem[] }>('/bale/outbox'), retry: false, refetchInterval: 30_000 });
  const items = (q.data?.items ?? []).filter(o => o.status !== 'sent' && o.status !== 'cancelled');
  if (!items.length) return null;
  return <div className="panel" data-testid="bale-outbox-panel" style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
    <h3 style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><Inbox size={18} /> پیام‌های بله‌ی من</h3>
    <p className="muted" style={{ margin: 0, fontSize: 13 }}>پیش‌نویس‌ها، پیام‌های در صف و پیام‌هایی که در سه روز گذشته فرستاده نشدند.</p>
    <ul className="bl-queue">{items.map(o => <li key={o.id} data-testid={`bale-outbox-${o.id}`}>
      <div className="top"><span className="who">{o.customerId ? <Link href={`/customers/${o.customerId}#sec-bale`}>{o.customerName ?? `مشتری ${o.customerId}`}</Link> : 'مشتری خارج از محدوده‌ی شما'}</span>
        <span className={`bl-tag${o.status === 'pending_approval' ? ' warn' : ''}`} style={{ marginInlineStart: 0 }}>{OUTBOX_STATUS_LABEL[o.status]}</span>
        <span className="muted">{o.sourceLabel}، {baleWhen(o.createdAt)}</span></div>
      {o.blockMessage || o.errorMessage ? <span className="why">{o.blockMessage ?? o.errorMessage}</span> : null}
      {o.attachment ? <span className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }} data-testid={`bale-outbox-file-${o.id}`}><Paperclip size={13} /> فایل: <bdi>{o.attachment.name ?? 'فایل طرح'}</bdi></span> : null}
      {o.text ? <q>{o.text}</q> : null}
    </li>)}</ul>
  </div>;
}
