import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { portalApi } from '@/customer-portal/api';
import { ChatPane, type ChatAdapter } from './ChatPane';

export function CustomerChat() {
  const qc = useQueryClient();
  const thread = useQuery({ queryKey: ['customer', 'chat-thread'], queryFn: portalApi.chatThread, refetchInterval: 8000 });
  const adapter = useMemo<ChatAdapter>(() => ({
    key: 'customer', mine: 'customer',
    load: portalApi.chatMessages, send: portalApi.chatSend, read: portalApi.chatRead,
    onActivity: () => void qc.invalidateQueries({ queryKey: ['customer', 'chat-thread'] }),
  }), [qc]);
  const t = thread.data;
  return <>
    <div className="cp-pagehead"><div><p className="cp-eyebrow"><Link href="/customer/advice" className="cp-link">مشاوره</Link> / کارشناس فروش</p><h1 className="cp-title">گفتگو با کارشناس فروش</h1></div></div>
    <div className="tg single">
      <section className="tg-pane" aria-label="گفتگو با کارشناس">
        <div className="tg-head"><Link href="/customer/advice" className="tg-ib" aria-label="بازگشت به مشاوره"><ArrowRight size={18} /></Link>
          <div className="tg-av">{(t?.expertName || 'ک')[0]}{t?.expertOnline && <span className="tg-dot" />}</div>
          <div className="tg-meta"><strong>{thread.isError ? 'کارشناس فروش' : t?.expertName || 'کارشناس فروش'}</strong><small data-testid="text-expert-online">{thread.isError ? 'وضعیت نامشخص' : t?.expertOnline ? 'آنلاین' : 'آفلاین'}</small></div></div>
        <ChatPane adapter={adapter} />
      </section>
    </div></>;
}
