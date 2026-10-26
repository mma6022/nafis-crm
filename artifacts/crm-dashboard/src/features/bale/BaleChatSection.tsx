import { useQuery } from '@tanstack/react-query';
import { Eye, Paperclip, MessageCircle } from 'lucide-react';
import { ErrorState } from '@/components/CrmShell';
import { baleFetch, baleWhen, faNum, MODE_LABEL, type BaleChat } from './api';
import './bale.css';

/** Read-only «گفتگوی بله» on the customer page (piece 1a). Scope is enforced by the server (own customers / admin). */
export function BaleChatSection({ customerId }: { customerId: number }) {
  const q = useQuery({ queryKey: ['bale', 'chat', customerId], queryFn: () => baleFetch<BaleChat>(`/bale/customers/${customerId}/messages`), retry: false });
  const st = (q.error as unknown as { status?: number } | null)?.status;
  if (st === 403 || st === 404) return null;
  const d = q.data;
  return <section className="csx-sec" id="sec-bale" aria-labelledby="h-bale" data-testid="section-customer-bale">
    <header><h2 id="h-bale"><MessageCircle size={20} /> گفتگوی بله</h2>{d ? <span className="muted">{faNum(d.messages.length)} پیام</span> : null}</header>
    <span className="bl-ro"><Eye size={14} /> فقط خواندنی{d?.expert ? ` · کارشناس: ${d.expert.name} — ${d.expert.connected ? `بله وصل، حالت ${MODE_LABEL[d.expert.mode]}` : 'بله وصل نیست'}` : ''}{d && !d.masterEnabled ? ' · بله خاموش است' : ''}</span>
    {q.isLoading ? <div className="stack" aria-busy="true"><span className="csx-sk" style={{ height: 44 }} /><span className="csx-sk" style={{ height: 44 }} /></div>
      : q.isError ? <ErrorState onRetry={() => q.refetch()} />
      : d && d.messages.length ? <div className="bl-chat" role="log" aria-label="پیام‌های بله">{d.messages.map(m => <div key={m.id} className={`bl-msg ${m.direction}`} data-testid={`bale-msg-${m.id}`}>
          {m.hasFile ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><Paperclip size={14} /> فایل</span> : null}
          {m.text ?? (m.hasFile ? null : '—')}
          <span className="meta">{m.direction === 'in' ? 'مشتری' : (m.expertName ?? 'کارشناس')} · {baleWhen(m.createdAt)}</span>
        </div>)}</div>
      : <p className="muted" style={{ margin: 0 }}>هنوز گفتگویی در بله با این مشتری ثبت نشده است.</p>}
  </section>;
}
