import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useLocation, useSearch } from 'wouter';
import { ChatPane, type ChatAdapter } from './ChatPane';
import type { ChatPage, ChatMessage } from '@/customer-portal/api';

type Thread = { customerId: number; name: string; mobile: string; online: boolean; lastMessage: string | null; lastMessageAt: string | null; unreadCount: number };
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api/chat${path}`, { ...init, credentials: 'include', headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init.headers } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message) ? body.message : r.status === 403 ? 'اجازه دسترسی ندارید.' : 'ارتباط با سامانه برقرار نشد.');
  return body as T;
}
export const staffChatPresence = () => api('/presence', { method: 'POST', body: '{}' });
export const fetchStaffUnread = () => api<{ count: number }>('/unread-count');

export default function StaffChatPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const [term, setTerm] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const search = useSearch();
  const [, navigate] = useLocation();
  useEffect(() => {
    const raw = new URLSearchParams(search).get('customerId');
    const id = raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
    if (id && id > 0) setSel(id);
  }, [search]);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const threads = useInfiniteQuery({
    queryKey: ['chat', 'threads', term], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ items: Thread[]; nextCursor: string | null }>(`/threads?q=${encodeURIComponent(term)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: l => l.nextCursor ?? undefined, refetchInterval: 6000,
  });
  const items = useMemo(() => { const m = new Map<number, Thread>(); threads.data?.pages.forEach(p => p.items.forEach(t => m.set(t.customerId, t))); return [...m.values()]; }, [threads.data]);
  const current = items.find(t => t.customerId === sel);
  const adapter = useMemo<ChatAdapter | null>(() => sel == null ? null : ({
    key: `staff-${sel}`, mine: 'staff',
    load: (beforeId?: number) => api<ChatPage>(`/${sel}/messages${beforeId ? `?beforeId=${beforeId}` : ''}`),
    send: (clientId, text, file) => {
      if (file) { const d = new FormData(); d.append('clientId', clientId); d.append('text', text); d.append('file', file); return api<ChatMessage>(`/${sel}/messages`, { method: 'POST', body: d }); }
      return api<ChatMessage>(`/${sel}/messages`, { method: 'POST', body: JSON.stringify({ clientId, text }) });
    },
    read: id => api(`/${sel}/read`, { method: 'POST', body: JSON.stringify({ lastMessageId: id }) }),
    onActivity: () => { void qc.invalidateQueries({ queryKey: ['chat', 'threads'] }); void qc.invalidateQueries({ queryKey: ['chat', 'unread'] }); },
  }), [sel, qc]);
  return <div className={`tg ${sel != null ? 'has-sel' : ''}`} data-testid="page-staff-chat">
    <aside className="tg-list" aria-label="فهرست گفتگوها">
      <div className="tg-search"><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="جست‌وجوی نام یا موبایل" aria-label="جست‌وجوی مشتری" data-testid="input-chat-search" /></div>
      <div className="tg-rows">
        {threads.isLoading && <div className="tg-empty" role="status">در حال دریافت…</div>}
        {threads.isError && <div className="tg-empty" role="alert">دریافت فهرست ناموفق بود.<br /><button type="button" className="tg-ib" onClick={() => void threads.refetch()} aria-label="تلاش دوباره"><RefreshCw size={16} /></button></div>}
        {threads.isSuccess && !items.length && <div className="tg-empty">{term ? 'نتیجه‌ای پیدا نشد.' : 'گفتگویی برای شما ثبت نشده است.'}</div>}
        {items.map(t => <button type="button" key={t.customerId} className="tg-row" aria-current={t.customerId === sel} onClick={() => setSel(t.customerId)} data-testid={`row-chat-${t.customerId}`}>
          <span className="tg-av">{t.name?.[0] || '؟'}{t.online && <span className="tg-dot" title="آنلاین" />}</span>
          <span className="tg-meta"><strong>{t.name}</strong><small>{t.lastMessage || t.mobile}</small></span>
          {t.unreadCount > 0 && <span className="tg-badge" aria-label={`${t.unreadCount} پیام خوانده‌نشده`}>{t.unreadCount.toLocaleString('fa-IR')}</span>}
        </button>)}
        {threads.hasNextPage && <button type="button" className="tg-row" onClick={() => void threads.fetchNextPage()} disabled={threads.isFetchingNextPage} data-testid="button-chat-more-threads">نمایش بیشتر</button>}
      </div>
    </aside>
    <section className="tg-pane" aria-label="گفتگو">
      {adapter ? <>
        <div className="tg-head"><button type="button" className="tg-ib tg-back" onClick={() => { setSel(null); if (new URLSearchParams(search).has('customerId')) navigate('/chat', { replace: true }); }} aria-label="بازگشت به فهرست"><ArrowRight size={18} /></button>
          <div className="tg-av">{current?.name?.[0] || '؟'}{current?.online && <span className="tg-dot" />}</div>
          <div className="tg-meta"><strong>{current?.name || 'مشتری'}</strong><small dir="ltr" style={{ textAlign: 'right' }}>{current?.online ? 'آنلاین' : current?.mobile}</small></div></div>
        <ChatPane adapter={adapter} />
      </> : <div className="tg-empty">یک گفتگو را انتخاب کنید.</div>}
    </section>
  </div>;
}
