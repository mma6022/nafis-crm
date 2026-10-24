import { CustomerName } from '@/components/customer/CustomerName';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Bug, ExternalLink, FileText, Info, MessageSquare, MoreVertical, RefreshCw, Search, UserRound, X } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { getGetAuthSessionQueryKey, getGetCustomerQueryKey, getListLoanApplicationsQueryKey, useGetAuthSession, useGetCustomer, useListLoanApplications, type LoanApplication } from '@workspace/api-client-react';
import { useDiagnostics } from '@/diagnostics/DiagnosticsProvider';
import { BUSINESS_STATUS_LABELS, loanBusinessStatus, loanStageLabel } from '@/lib/loan-labels';
import { ChatPane, type ChatAdapter } from './ChatPane';
import { CustomerAvatar, StaffAvatar, kindIcon, listTime } from './chat-ui';
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

const faId = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false });
const toman = (v?: string | number | null) => v == null || v === '' ? '' : `${Number(v).toLocaleString('fa-IR')} تومان`;
// `/threads` only returns `text || file_name` as the preview (phase 2 adds the message kind), so infer the icon from a bare file name.
const previewKind = (s: string | null) => {
  const m = s && /^[^\s/\\]+\.(png|jpe?g|webp|pdf|docx|webm|ogg|oga|opus|wav|mp3|m4a)$/i.exec(s.trim());
  if (!m) return null;
  const e = m[1].toLowerCase();
  return /png|jpe?g|webp/.test(e) ? 'image' : /pdf|docx/.test(e) ? 'file' : 'audio';
};

export default function StaffChatPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [searchOn, setSearchOn] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState(false);
  const search = useSearch();
  const [, navigate] = useLocation();
  const diagnostics = useDiagnostics();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const can = (p: string) => user?.role === 'admin' || !!user?.permissions?.includes(p);
  const me = user ? { id: user.id, name: user.fullName || user.username || 'کاربر' } : null;
  useEffect(() => {
    const raw = new URLSearchParams(search).get('customerId');
    const id = raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
    if (id && id > 0) setSel(id);
  }, [search]);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setMenu(false); }, [sel]);
  const threads = useInfiniteQuery({
    queryKey: ['chat', 'threads', term], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ items: Thread[]; nextCursor: string | null }>(`/threads?q=${encodeURIComponent(term)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: l => l.nextCursor ?? undefined, refetchInterval: 6000,
  });
  const items = useMemo(() => { const m = new Map<number, Thread>(); threads.data?.pages.forEach(p => p.items.forEach(t => m.set(t.customerId, t))); return [...m.values()]; }, [threads.data]);
  const unreadMsgs = items.reduce((s, t) => s + t.unreadCount, 0); const unreadThreads = items.filter(t => t.unreadCount > 0).length;
  const current = items.find(t => t.customerId === sel);
  const withMsgs = items.filter(t => t.lastMessageAt); const noMsgs = items.filter(t => !t.lastMessageAt);

  // Case info (header «پرونده #…» and the info panel) — existing endpoints, gated by the same permissions as the customer page.
  const canLoans = can('loan_applications.view'); const canCustomer = can('customers.view');
  const cid = sel ?? 0;
  const loansQ = useListLoanApplications({ customerId: cid, limit: 20 }, { query: { queryKey: getListLoanApplicationsQueryKey({ customerId: cid, limit: 20 }), enabled: sel != null && canLoans } });
  const loans: LoanApplication[] = loansQ.data && 'items' in loansQ.data ? loansQ.data.items : [];
  const latestLoan = [...loans].sort((a, b) => b.id - a.id)[0];
  const customerQ = useGetCustomer(cid, { query: { queryKey: getGetCustomerQueryKey(cid), enabled: sel != null && canCustomer && info } });

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
  const back = () => { setSel(null); setInfo(false); if (new URLSearchParams(search).has('customerId')) navigate('/chat', { replace: true }); };
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  const Row = (t: Thread) => {
    const kind = previewKind(t.lastMessage);
    return <button type="button" key={t.customerId} className={`nf-row ${t.customerId === sel ? 'sel' : ''} ${t.unreadCount > 0 ? 'unread' : ''}`} aria-current={t.customerId === sel} onClick={() => setSel(t.customerId)} data-testid={`row-chat-${t.customerId}`}>
      <CustomerAvatar customerId={t.customerId} name={t.name} online={t.online} />
      <span className="r-body">
        <span className="r-top"><span className="r-name"><CustomerName id={t.customerId} name={t.name} badgeTestId={`badge-chat-customer-id-${t.customerId}`} /></span>{t.lastMessageAt && <span className="r-time">{listTime(t.lastMessageAt)}</span>}</span>
        <span className="r-bot"><span className="r-prev">{kind && kindIcon(kind)}<span>{t.lastMessage || <span className="ltr">{t.mobile}</span>}</span></span>
          {t.unreadCount > 0 && <span className="r-badge" aria-label={`${t.unreadCount} پیام خوانده‌نشده`}>{t.unreadCount.toLocaleString('fa-IR')}</span>}</span>
      </span>
    </button>;
  };

  return <div className={`tg nf-chat ${sel != null ? 'has-sel' : ''} ${info && sel != null ? 'has-info' : ''}`} data-testid="page-staff-chat">
    <aside className="tg-list nf-list" aria-label="فهرست گفتگوها">
      <div className="nf-lhead">
        <label className={`nf-search ${searchOn ? 'on' : ''}`}><Search aria-hidden="true" />
          <input type="search" value={q} onFocus={() => setSearchOn(true)} onBlur={() => setSearchOn(false)} onChange={e => setQ(e.target.value)} placeholder="جست‌وجوی نام، شناسه یا موبایل" aria-label="جست‌وجوی مشتری" data-testid="input-chat-search" />
          {q && <button type="button" className="clr" onClick={() => setQ('')} aria-label="پاک کردن جست‌وجو"><X /></button>}</label>
        {threads.isSuccess && !term && <div className="nf-sum" data-testid="text-chat-unread-summary">{unreadMsgs > 0 ? <><b>{unreadMsgs.toLocaleString('fa-IR')} پیام خوانده‌نشده</b> در {unreadThreads.toLocaleString('fa-IR')} گفتگو</> : 'همهٔ پیام‌ها خوانده شده‌اند.'}</div>}
      </div>
      <div className="tg-rows nf-rows">
        {threads.isLoading && <div aria-busy="true" role="status" aria-label="در حال دریافت…">{[0, 1, 2, 3, 4].map(i => <div key={i} className="nf-skrow"><span className="c nf-sk" /><span><span className="l nf-sk" style={{ width: '60%' }} /><span className="l nf-sk" style={{ width: '85%' }} /></span></div>)}</div>}
        {threads.isError && <div className="tg-empty err" role="alert"><AlertCircle /><p>دریافت فهرست ناموفق بود.</p><button type="button" className="nf-btn s sm" onClick={() => void threads.refetch()}><RefreshCw size={18} /> تلاش دوباره</button></div>}
        {threads.isSuccess && !items.length && <div className="tg-empty"><MessageSquare /><p>{term ? 'نتیجه‌ای پیدا نشد.' : 'گفتگویی برای شما ثبت نشده است.'}</p></div>}
        {withMsgs.map(Row)}
        {noMsgs.length > 0 && <div className="nf-sec">بدون پیام</div>}
        {noMsgs.map(Row)}
        {threads.hasNextPage && <div className="nf-more"><button type="button" className="nf-btn s sm" onClick={() => void threads.fetchNextPage()} disabled={threads.isFetchingNextPage} data-testid="button-chat-more-threads">{threads.isFetchingNextPage ? 'در حال دریافت…' : 'نمایش بیشتر'}</button></div>}
      </div>
    </aside>
    <section className="tg-pane nf-pane" aria-label="گفتگو">
      {adapter ? <>
        <div className="nf-th">
          <button type="button" className="ib tg-back" onClick={back} aria-label="بازگشت به فهرست" data-testid="button-chat-back"><ArrowRight /></button>
          <button type="button" className="tt" onClick={() => setInfo(true)} aria-label="اطلاعات مشتری">
            <CustomerAvatar customerId={sel!} name={current?.name} size={44} online={current?.online} />
            <span><span className="nm"><CustomerName id={sel} name={current?.name || 'مشتری'} /></span>
              <span className="sub">{latestLoan && <><span className="file"><FileText />پرونده #{faId(latestLoan.id)}</span><span className="sep">·</span></>}
                {current?.online ? <span className="ok">آنلاین</span> : <span className="ltr">{current?.mobile}</span>}</span></span>
          </button>
          <button type="button" className={`ib d-only ${info ? 'on' : ''}`} onClick={() => setInfo(v => !v)} aria-label="اطلاعات مشتری" aria-pressed={info} data-testid="button-chat-info"><Info /></button>
          <div className="nf-menuw" ref={menuRef}>
            <button type="button" className="ib" onClick={() => setMenu(v => !v)} aria-label="گزینه‌های بیشتر" aria-haspopup="menu" aria-expanded={menu} data-testid="button-chat-menu"><MoreVertical /></button>
            {menu && <div className="nf-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setInfo(true); setMenu(false); }}><Info />اطلاعات مشتری</button>
              {canCustomer && <Link role="menuitem" href={`/customers/${sel}`} onClick={() => setMenu(false)}><UserRound />صفحهٔ مشتری</Link>}
              {diagnostics && <><hr /><button type="button" role="menuitem" onClick={() => { setMenu(false); diagnostics.open(); }} data-testid="button-chat-menu-diagnostics"><Bug />گزارش خطا</button></>}
            </div>}
          </div>
        </div>
        <ChatPane adapter={adapter} me={me} />
      </> : <div className="tg-empty"><MessageSquare /><p>یک گفتگو را انتخاب کنید.</p></div>}
    </section>
    {info && sel != null && <>
      <div className="nf-scrim" onClick={() => setInfo(false)} aria-hidden="true" />
      <aside className="nf-info" aria-label="اطلاعات مشتری" data-testid="panel-chat-customer-info">
        <div className="ihd"><b>اطلاعات مشتری</b><button type="button" className="ib" onClick={() => setInfo(false)} aria-label="بستن"><X /></button></div>
        <div className="ci-head">
          <CustomerAvatar customerId={sel} name={current?.name ?? customerQ.data?.name} size={64} online={current?.online} />
          <span className="nm"><CustomerName id={sel} name={current?.name ?? customerQ.data?.name ?? 'مشتری'} /></span>
          {current?.mobile && <span className="mo ltr">{current.mobile}</span>}
          {current?.online && <span className="stt">آنلاین</span>}
        </div>
        {canCustomer && <div className="ci-acts"><Link href={`/customers/${sel}`} className="nf-btn s"><UserRound size={18} />صفحهٔ مشتری</Link></div>}
        {canLoans && <>
          <div className="ci-sec">پرونده‌ها{loans.length > 0 && <span className="cnt">{loans.length.toLocaleString('fa-IR')}</span>}</div>
          {loansQ.isLoading && <span className="nf-sk" style={{ display: 'block', height: 96, borderRadius: 20 }} />}
          {loansQ.isError && <p className="ci-note">فهرست پرونده‌ها دریافت نشد.</p>}
          {loansQ.isSuccess && !loans.length && <p className="ci-note">پرونده‌ای برای این مشتری ثبت نشده است.</p>}
          {loans.slice(0, 5).map(l => { const bs = loanBusinessStatus(l); const stage = bs !== 'canceled' && bs !== 'completed' ? loanStageLabel(l.stage) : ''; return <div key={l.id} className={`ci-file ${l.id === latestLoan?.id ? 'cur' : ''}`}>
            <div className="h"><b><FileText />پرونده #{faId(l.id)}</b>{BUSINESS_STATUS_LABELS[bs] && <span className={`tag ${bs === 'completed' ? 'ok' : bs === 'canceled' ? 'no' : ''}`}>{BUSINESS_STATUS_LABELS[bs]}</span>}</div>
            <dl>{stage && <><dt>مرحله</dt><dd>{stage}</dd></>}<dt>طرح</dt><dd>{l.planName || 'طرح تسهیلات'}</dd>
              {(l.approvedAmount || l.requestedAmount) && <><dt>مبلغ</dt><dd>{toman(l.approvedAmount || l.requestedAmount)}</dd></>}</dl>
            <Link href={`/loan-applications/${l.id}`}><ExternalLink />مشاهدهٔ پرونده</Link></div>; })}
        </>}
        {canCustomer && customerQ.data?.salespersonName && <>
          <div className="ci-sec">مسئول پیگیری</div>
          {/* salespersonId points at `salespersons`, not `users`; the photo needs `salespersonUserId` from the server (HANDOFF §10-ج-2). */}
          <div className="ppl ci-owner"><StaffAvatar name={customerQ.data.salespersonName} size={40} /><span className="pi"><b>{customerQ.data.salespersonName}</b><small>کارشناس فروش</small></span></div>
        </>}
      </aside>
    </>}
  </div>;
}
