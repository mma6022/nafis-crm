import { customerIdOf, parseCustomerIdQuery, rankExactCustomerId } from '@/lib/customer-id';
import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { useMemo, useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock3, Instagram, LoaderCircle, MessageCircle, Pause, Play, RefreshCw, Search, UserRound } from 'lucide-react';
import { Link, Redirect } from 'wouter';
import { getGetAuthSessionQueryKey, useGetAuthSession } from '@workspace/api-client-react';
import { formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import ManychatConnectionForm, { type ManychatStatus } from './ManychatConnectionForm';
import InstagramLeadReview from './InstagramLeadReview';
import './InstagramInbox.css';

type InstagramStatus = ManychatStatus & {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  replyMode?: 'intake' | 'ai';
  accountId: string | null;
  hasStoredLeads: boolean;
};
type InstagramThread = {
  id: string | number;
  senderId?: string | null;
  name?: string | null;
  phone?: string | null;
  request?: string | null;
  customerId?: string | number | null;
  status?: string | null;
  paused?: boolean;
  lastMessageAt?: string | null;
  lastMessage?: string | null;
  lastReplyAt?: string | null;
  error?: string | null;
};
type InstagramMessage = Record<string, unknown> & { id?: string | number };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `خطای دریافت اطلاعات (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `خطای ثبت تغییر (${response.status})`);
  }
  const result = await response.text();
  return (result ? JSON.parse(result) : undefined) as T;
}

function unwrapList<T>(response: T[] | { threads?: T[]; messages?: T[] }): T[] {
  if (Array.isArray(response)) return response;
  return response.threads ?? response.messages ?? [];
}

function messageText(message: InstagramMessage): string {
  for (const key of ['text', 'message', 'body', 'content']) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'پیام متنی در دسترس نیست';
}

function messageDate(message: InstagramMessage): string | null {
  for (const key of ['createdAt', 'timestamp', 'sentAt', 'created_at']) {
    const value = message[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function messageIsInbound(message: InstagramMessage): boolean {
  const direction = String(message.direction ?? message.role ?? message.senderType ?? '').toLowerCase();
  return ['inbound', 'incoming', 'user', 'customer', 'lead', 'received'].includes(direction);
}

const statusLabels: Record<string, string> = {
  new: 'جدید',
  open: 'باز',
  active: 'فعال',
  in_progress: 'در حال پیگیری',
  qualified: 'واجد شرایط',
  converted: 'تبدیل‌شده',
  ready_for_review: 'آمادهٔ بررسی',
  closed: 'بسته',
  failed: 'ناموفق',
  error: 'خطا',
};

function statusLabel(status?: string | null): string {
  if (!status) return 'نامشخص';
  return statusLabels[status] ?? status.replaceAll('_', ' ');
}

const aiPreparationErrors: Record<string, string> = {
  ai_reply_preparation_failed: 'پاسخ هوش مصنوعی آماده نشد. این گفت‌وگو به بررسی کارشناس نیاز دارد.',
  ai_reply_too_long: 'پاسخ هوش مصنوعی حتی پس از درخواست کوتاه‌سازی از حد مجاز طولانی‌تر بود.',
  ai_reply_incomplete: 'پاسخ هوش مصنوعی ناقص بود؛ برای جلوگیری از مشاورهٔ ناقص ارسال نشد.',
  ai_reply_empty: 'سرویس هوش مصنوعی پاسخ قابل‌استفاده‌ای برنگرداند.',
  ai_reply_timeout: 'سرویس هوش مصنوعی در زمان مجاز پاسخ نداد.',
  ai_reply_provider_unavailable: 'ارتباط با سرویس هوش مصنوعی برقرار نشد یا سرویس در دسترس نبود.',
  ai_reply_rate_limited: 'سرویس هوش مصنوعی فعلاً محدودیت تعداد درخواست دارد.',
  ai_reply_invalid_credentials: 'سرویس هوش مصنوعی اتصال را تأیید نکرد؛ تنظیمات سرویس باید بررسی شود.',
  ai_reply_context_too_large: 'اطلاعات طرح‌های فعال از ظرفیت مجاز مشاوره بیشتر است.',
};

export default function InstagramInbox() {
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const canView = user?.role === 'admin' || user?.role === 'registrar';
  const queryClient = useQueryClient();
  const [search, setSearch] = useTableState('instagram.search', '');
  const [statusFilter, setStatusFilter] = useTableState('instagram.status', 'all');
  const [selectedId, setSelectedId] = useState<string | number | null>(null);

  const integration = useQuery({
    queryKey: ['instagram', 'status'],
    queryFn: () => getJson<InstagramStatus>('/api/instagram/status'),
    enabled: Boolean(canView),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  // Previously received leads remain visible even while the page is disconnected.
  const canReadInbox = Boolean(canView);
  const threadsQuery = useQuery({
    queryKey: ['instagram', 'threads'],
    queryFn: async () => unwrapList(await getJson<InstagramThread[] | { threads: InstagramThread[] }>('/api/instagram/threads')),
    enabled: Boolean(canView && canReadInbox),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const threads = threadsQuery.data ?? [];
  const filteredThreads = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const idQuery = parseCustomerIdQuery(search);
    return rankExactCustomerId(threads.filter((thread) => {
      const matchesSearch = !needle || (idQuery !== null && customerIdOf(thread.customerId) === idQuery.id) || (!idQuery?.explicit && [thread.name, thread.phone, thread.request, thread.senderId, thread.lastMessage]
        .some((value) => value?.toLocaleLowerCase().includes(needle)));
      return matchesSearch && (statusFilter === 'all' || (statusFilter === 'error' ? Boolean(thread.error) : thread.status === statusFilter));
    }), search, (thread) => thread.customerId);
  }, [threads, search, statusFilter]);
  const selectedThread = threads.find((thread) => String(thread.id) === String(selectedId)) ?? filteredThreads[0] ?? null;
  const selectedThreadId = selectedThread?.id;
  const messagesQuery = useQuery({
    queryKey: ['instagram', 'threads', selectedThreadId, 'messages'],
    queryFn: async () => unwrapList(await getJson<InstagramMessage[] | { messages: InstagramMessage[] }>(`/api/instagram/threads/${encodeURIComponent(String(selectedThreadId))}/messages`)),
    enabled: Boolean(canView && canReadInbox && selectedThreadId != null),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const pauseMutation = useMutation({
    mutationFn: ({ id, paused }: { id: string | number; paused: boolean }) =>
      postJson(`/api/instagram/threads/${encodeURIComponent(String(id))}/pause`, { paused }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instagram', 'threads'] }),
  });

  if (session.isLoading) return <div className="instagram-inbox-page" dir="rtl"><SkeletonPanel rows={5} /></div>;
  if (!user) return <Redirect to="/login" />;
  if (!canView) return <Redirect to="/" />;

  const retryAll = () => {
    void integration.refetch();
    void threadsQuery.refetch();
    void messagesQuery.refetch();
  };

  return (
    <section className="instagram-inbox-page" dir="rtl">
      <header className="instagram-page-heading">
        <div className="instagram-title">
          <span className="instagram-brand-icon"><Instagram size={23} /></span>
          <div><p className="instagram-eyebrow">مدیریت سرنخ‌ها</p><h2>صندوق دایرکت اینستاگرام</h2></div>
        </div>
        <button type="button" className="instagram-refresh" onClick={retryAll} disabled={integration.isFetching || threadsQuery.isFetching} data-testid="button-refresh-instagram">
          <RefreshCw size={16} className={integration.isFetching || threadsQuery.isFetching ? 'instagram-spinning' : ''} /> به‌روزرسانی
        </button>
      </header>

      <div className="instagram-safety-note" role="note" data-testid="notice-instagram-window">
        <AlertTriangle size={20} />
        <div><strong>محدودیت پنجره پیام و پاسخ‌گویی</strong><p>پنجره مجاز پاسخ‌گویی متا محدود است؛ هیچ تضمین ضد مسدودسازیِ ۱۰ ثانیه‌ای وجود ندارد و تحویل پیام نیز ممکن است با تأخیر انجام شود. وضعیت پیام‌ها را پیگیری کنید و از ارسال خودکار یا مکرر خارج از چارچوب متا خودداری کنید.</p></div>
      </div>

      {integration.isLoading ? <div className="instagram-state-card"><LoaderCircle className="instagram-spinning" size={20} /> در حال بررسی اتصال اینستاگرام…</div> : null}
      {integration.isError ? <div className="instagram-error-banner" role="alert" data-testid="status-instagram-status-error">
        <span>وضعیت اتصال قابل دریافت نیست: {integration.error instanceof Error ? integration.error.message : 'خطای نامشخص'}</span>
        <button type="button" onClick={() => void integration.refetch()} data-testid="button-retry-instagram-status">تلاش دوباره</button>
      </div> : null}
       {integration.data && !integration.data.enabled ? <div className="instagram-setup-banner" role="status" data-testid="status-instagram-setup">
        <div className="instagram-setup-icon"><Instagram size={21} /></div>
          <div><strong>{integration.data.configured ? 'پاسخ خودکار Manychat خاموش است' : 'اتصال CRM به Manychat تکمیل نشده است'}</strong>
            <p>{integration.data.configured ? 'دریافت پیام آزمایشی امکان‌پذیر است، ولی پاسخ خودکار تا زمان فعال‌سازی مدیر خاموش می‌ماند.' : 'در روش بدون API، مدیر فقط کلید ارتباط را ثبت می‌کند. سرنخ‌های قبلی همچنان در این صندوق می‌مانند.'}</p>
        </div>
      </div> : null}
      {integration.data ? <p className="instagram-reply-mode-status" data-testid="status-instagram-reply-mode">
        حالت پاسخ‌گویی فعلی: <strong>{(integration.data.replyMode ?? 'intake') === 'ai' ? 'مشاوره هوشمند' : 'ثبت اطلاعات'}</strong>
      </p> : null}
      {user.role === 'admin' && integration.data ? <section className="instagram-connect-card" aria-labelledby="instagram-connect-heading" data-testid="card-instagram-admin-connection">
        <div className="instagram-connect-heading">
          <div className="instagram-setup-icon"><Instagram size={21} /></div>
           <div><p className="instagram-eyebrow">فقط مدیر سیستم</p><h3 id="instagram-connect-heading">اتصال صفحه از طریق Manychat</h3></div>
          <span className={`instagram-connection-pill ${integration.data.connected ? 'is-connected' : ''}`} data-testid="status-instagram-oauth">
              {integration.data.connected ? 'رویداد ورودی با کلید ارتباط ثبت شده' : 'دریافت رویداد هنوز تأیید نشده'}
          </span>
        </div>
        <p className="instagram-live-status" data-testid="status-instagram-live">
            وضعیت اتصال CRM: {!integration.data.configured ? 'کلید ارتباط Manychat هنوز در CRM ثبت نشده است.'
             : !integration.data.connected ? 'تنظیمات سرور آماده است؛ هنوز دایرکت آزمایشی دریافت نشده است.'
                 : integration.data.enabled ? integration.data.mode === 'flow'
                    ? 'CRM آماده‌سازی پاسخ برای Flow را فعال کرده است؛ ارسال واقعی را در Manychat و پیج بررسی کنید.'
                    : 'رویداد ورودی ثبت شده و پاسخ خودکار CRM فعال است؛ تحویل واقعی را در Manychat بررسی کنید.'
                  : 'رویداد ورودی با کلید ارتباط ثبت شده؛ پاسخ خودکار هنوز خاموش است. تحویل واقعی را جداگانه بررسی کنید.'}
        </p>
        <ManychatConnectionForm status={integration.data} onUpdated={() => { void integration.refetch(); void threadsQuery.refetch(); }} />
        <div className="instagram-connect-actions">
           <a href="https://manychat.com/" target="_blank" rel="noreferrer" className="instagram-connect-button" data-testid="link-instagram-connect">باز کردن Manychat</a>
             <span>با دریافت نام کامل و موبایل، ثبت مشتری خودکار است. درخواست مشتری تکراری جدا ثبت می‌شود؛ اگر به سؤال درخواست پاسخ ندهد، پس از ۳۰ دقیقه خلاصهٔ گفت‌وگو ثبت می‌شود. نیاز فوری به وام با تگ «فوری» مشخص می‌شود و اولویت مشتری جدید خالی می‌ماند. در حالت API، برای دریافت دایرکت، درخواست ورودی Manychat با کلید ارتباط جداگانه لازم است.</span>
        </div>
      </section> : null}

      {canReadInbox ? (
        <div className="instagram-workspace">
          <aside className="instagram-thread-panel">
            <div className="instagram-list-header"><div><strong>گفت‌وگوها</strong><span>{filteredThreads.length} سرنخ</span></div></div>
            <label className="instagram-search"><Search size={17} /><input type="search" placeholder="جست‌وجوی نام، شماره یا درخواست…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="جست‌وجوی سرنخ‌ها" data-testid="input-instagram-search" /></label>
            <select className="instagram-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="فیلتر وضعیت" data-testid="select-instagram-status">
              <option value="all">همه وضعیت‌ها</option><option value="error">دارای خطا</option>
              {[...new Set(threads.map((thread) => thread.status).filter((value): value is string => Boolean(value)))].map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
            {threadsQuery.isLoading ? <div className="instagram-list-loading"><LoaderCircle className="instagram-spinning" size={19} /> در حال دریافت گفت‌وگوها…</div> : null}
            {threadsQuery.isError ? <div className="instagram-list-error" role="alert"><p>دریافت گفت‌وگوها ناموفق بود.</p><button type="button" onClick={() => void threadsQuery.refetch()} data-testid="button-retry-instagram-threads">تلاش دوباره</button></div> : null}
            {!threadsQuery.isLoading && !threadsQuery.isError && filteredThreads.length === 0 ? <div className="instagram-empty-list"><MessageCircle size={24} /><span>{threads.length ? 'سرنخی با این فیلتر پیدا نشد.' : 'هنوز گفت‌وگویی ثبت نشده است.'}</span></div> : null}
            <div className="instagram-thread-list">
              {filteredThreads.map((thread) => (
                <button type="button" key={thread.id} className={`instagram-thread-card ${String(thread.id) === String(selectedThread?.id) ? 'selected' : ''}`} onClick={() => setSelectedId(thread.id)} data-testid={`button-instagram-thread-${thread.id}`}>
                  <span className="instagram-avatar"><UserRound size={19} /></span>
                   <span className="instagram-thread-copy"><strong>{thread.name || (thread.senderId?.startsWith('mc:') ? `مخاطب Manychat ${thread.senderId.split(':').at(-1)}` : thread.senderId) || `سرنخ ${thread.id}`}{thread.customerId != null ? <> <CustomerIdBadge id={thread.customerId} /></> : null}</strong><small>{thread.lastMessage || thread.request || 'بدون پیام'}</small><span className="instagram-thread-meta"><span className={`instagram-status-pill ${thread.error ? 'has-error' : ''}`}>{thread.error ? 'خطا' : statusLabel(thread.status)}</span><time>{formatDateTime(thread.lastMessageAt)}</time></span></span>
                  {thread.paused ? <Pause size={14} className="instagram-paused-mark" aria-label="متوقف" /> : null}
                </button>
              ))}
            </div>
          </aside>

          <main className="instagram-detail-panel">
            {selectedThread ? <>
              <header className="instagram-detail-header">
                <div className="instagram-lead-avatar"><UserRound size={22} /></div>
                 <div className="instagram-lead-heading"><h3>{selectedThread.name || (selectedThread.senderId?.startsWith('mc:') ? `مخاطب Manychat ${selectedThread.senderId.split(':').at(-1)}` : selectedThread.senderId) || `سرنخ ${selectedThread.id}`}</h3><div>{selectedThread.senderId ? <span dir="ltr">{selectedThread.senderId.startsWith('mc:') ? `Manychat #${selectedThread.senderId.split(':').at(-1)}` : `@${selectedThread.senderId}`}</span> : null}{selectedThread.phone ? <span dir="ltr">{selectedThread.phone}</span> : null}<span className={`instagram-status-pill ${selectedThread.error ? 'has-error' : ''}`}>{selectedThread.error ? 'خطا' : statusLabel(selectedThread.status)}</span></div></div>
                {user.role === 'admin' ? <button type="button" className={`instagram-pause-button ${selectedThread.paused ? 'is-paused' : ''}`} disabled={pauseMutation.isPending} onClick={() => pauseMutation.mutate({ id: selectedThread.id, paused: !selectedThread.paused })} data-testid={`button-instagram-pause-${selectedThread.id}`}>
                  {pauseMutation.isPending ? <LoaderCircle size={15} className="instagram-spinning" /> : selectedThread.paused ? <Play size={15} /> : <Pause size={15} />}{selectedThread.paused ? 'ادامه' : 'توقف'}
                </button> : null}
              </header>
              {pauseMutation.isError ? <div className="instagram-inline-error" role="alert">تغییر وضعیت توقف ثبت نشد: {pauseMutation.error instanceof Error ? pauseMutation.error.message : 'خطای نامشخص'}</div> : null}
              {selectedThread.error ? <div className="instagram-thread-error" role="alert"><AlertTriangle size={17} /><div><strong>خطای این گفت‌وگو</strong><p>{aiPreparationErrors[selectedThread.error] ? `${aiPreparationErrors[selectedThread.error]} پیامی ارسال نشده است.` : selectedThread.error}</p></div></div> : null}
              <section className="instagram-lead-summary" aria-label="جزئیات سرنخ">
                <div><span>درخواست</span><strong>{selectedThread.request || 'ثبت نشده'}</strong></div>
                <div><span>شماره تماس</span><strong dir="ltr">{selectedThread.phone || 'ثبت نشده'}</strong></div>
                <div><span>آخرین پاسخ</span><strong>{formatDateTime(selectedThread.lastReplyAt)}</strong></div>
                {selectedThread.customerId != null ? <><Link href={`/customers/${selectedThread.customerId}`} className="instagram-customer-link" data-testid={`link-instagram-customer-${selectedThread.customerId}`}>مشاهده پرونده مشتری</Link> <CustomerIdBadge id={selectedThread.customerId} /></> : <div><span>پرونده CRM</span><strong>هنوز متصل نشده</strong></div>}
              </section>
              {selectedThread.customerId == null ?
                <InstagramLeadReview key={String(selectedThread.id)} lead={selectedThread}
                  onConverted={() => { void threadsQuery.refetch(); }} /> : null}
              <section className="instagram-messages" aria-label="تاریخچه پیام‌ها">
                <div className="instagram-messages-heading"><strong>تاریخچه پیام‌ها</strong><span><Clock3 size={14} /> آخرین فعالیت: {formatDateTime(selectedThread.lastMessageAt)}</span></div>
                {messagesQuery.isLoading ? <div className="instagram-messages-state"><LoaderCircle size={18} className="instagram-spinning" /> در حال دریافت پیام‌ها…</div> : null}
                {messagesQuery.isError ? <div className="instagram-list-error" role="alert"><p>تاریخچه پیام‌ها دریافت نشد.</p><button type="button" onClick={() => void messagesQuery.refetch()} data-testid="button-retry-instagram-messages">تلاش دوباره</button></div> : null}
                {!messagesQuery.isLoading && !messagesQuery.isError && (messagesQuery.data?.length ?? 0) === 0 ? <div className="instagram-messages-state">پیامی برای نمایش وجود ندارد.</div> : null}
                <div className="instagram-message-list">
                  {messagesQuery.data?.map((message, index) => {
                    const inbound = messageIsInbound(message);
                    return <article key={message.id ?? `${messageDate(message) ?? 'message'}-${index}`} className={`instagram-message ${inbound ? 'inbound' : 'outbound'}`} data-testid={`message-instagram-${message.id ?? index}`}>
                      <p>{messageText(message)}</p><time>{formatDateTime(messageDate(message))}</time>
                    </article>;
                  })}
                </div>
              </section>
            </> : <div className="instagram-detail-empty"><MessageCircle size={34} /><strong>یک گفت‌وگو را انتخاب کنید</strong><span>جزئیات سرنخ و تاریخچه پیام‌ها اینجا نمایش داده می‌شود.</span></div>}
          </main>
        </div>
      ) : null}
      <div className="instagram-privacy-footnote"><Check size={15} /> این صندوق برای مدیر و کارشناس ثبت در دسترس است.</div>
    </section>
  );
}