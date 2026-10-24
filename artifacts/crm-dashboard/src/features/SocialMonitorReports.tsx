import { CustomerIdBadge, CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { useEffect, useRef, useMemo, useState } from 'react';
import type { SocialMonitorThread as Thread, SocialThreadMessage as Message, SocialThreadHistory as MessagesBody, SocialThreadSummary as Summary } from '@workspace/api-client-react';

type Employee = { id: number; name: string };
type DayRow = {
  employeeId: number; employeeName: string; day: string; conversationCount: number;
  inboundCount: number; outboundCount: number; messageCount: number; services: string;
  summary?: string | null;
};
type Report = { employees: Employee[]; days: DayRow[]; conversations: Thread[] };

const serviceNames: Record<string, string> = { tg: 'تلگرام', wa: 'واتس‌اپ', bale: 'بله' };
const fmtDay = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const todayTehran = () => fmtDay(new Date());
const faDate = (day: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' })
  .format(new Date(`${day}T12:00:00+03:30`));
const faTime = (value: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const faDateTime = (value: string) => `${faDate(fmtDay(new Date(value)))}، ${faTime(value)}`;
const faNum = (n: number) => new Intl.NumberFormat('fa-IR').format(n);

async function request<T>(url: string, init?: RequestInit, fallback = 'درخواست انجام نشد.'): Promise<T> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
  if (!response.ok) {
    let message = fallback;
    try { message = (await response.json()).error || message; } catch { /* keep Persian fallback */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
const readJson = <T,>(url: string) => request<T>(url, undefined, 'دریافت گزارش پیام‌رسان‌ها انجام نشد.');
const errText = (c: unknown, f: string) => (c instanceof Error && c.message ? c.message : f);

function CustomerLinker({ thread, onBound }: { thread: Thread; onBound: () => void }) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    setErr('');
    const q = search.trim();
    if (!q || (q.length < 2 && !/^[0-9۰-۹٠-٩]+$/.test(q))) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      setSearching(true);
      readJson<{ customers: Array<{ id: number; name: string }> }>(`/api/social-monitor/customers?search=${encodeURIComponent(q)}`)
        .then(b => { if (!cancelled) setResults(b.customers); })
        .catch(c => { if (!cancelled) setErr(errText(c, 'جستجوی مشتری انجام نشد.')); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);
  const bind = async (id: number) => {
    setBusy(true); setErr('');
    try {
      await request<{ ok: true }>(`/api/social-monitor/threads/${encodeURIComponent(thread.threadId)}/customer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: id }),
      }, 'ثبت ارتباط مشتری انجام نشد.');
      onBound();
    } catch (c) { setErr(errText(c, 'ثبت ارتباط مشتری انجام نشد.')); setBusy(false); }
  };
  const ambiguous = thread.customerMatch === 'ambiguous';
  return (
    <div className="smr-linker">
      <strong>{ambiguous ? 'تطبیق قطعی نیست؛ نام و شناسهٔ مشتری را بررسی و انتخاب کنید.' : 'این گفتگو هنوز به مشتری CRM وصل نیست.'}</strong>
      {ambiguous && <div className="smr-chips">{thread.customerCandidates.map(c =>
        <button key={c.id} type="button" className="btn btn-ghost" disabled={busy} onClick={() => void bind(c.id)} data-testid={`button-candidate-${c.id}`}>{customerNameText(c.name, c.id)}</button>)}</div>}
      <label>{ambiguous ? 'یا جستجوی مشتری دیگر' : 'جستجوی مشتری'}
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="نام یا شناسهٔ CRM مشتری" data-testid="input-customer-search" /></label>
      {searching && <small>در حال جستجو…</small>}
      {!searching && (search.trim().length >= 2 || /^[0-9۰-۹٠-٩]+$/.test(search.trim())) && results.length === 0 && !err && <small>مشتری‌ای پیدا نشد.</small>}
      <div className="smr-chips">{results.map(c =>
        <button key={c.id} type="button" className="btn btn-ghost" disabled={busy} onClick={() => void bind(c.id)} data-testid={`button-link-customer-${c.id}`}>اتصال به {customerNameText(c.name, c.id)}</button>)}</div>
      {err && <div className="smr-error" role="alert">{err}</div>}
    </div>
  );
}

function SummaryPanel({ threadId }: { threadId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState('');
  const [consent, setConsent] = useState(false);
  const [posting, setPosting] = useState(false);
  const current = useRef(threadId);
  current.current = threadId;
  const base = `/api/social-monitor/threads/${encodeURIComponent(threadId)}/summary`;

  useEffect(() => {
    setSummary(null); setErr(''); setConsent(false); setPosting(false);
    let cancelled = false;
    readJson<Summary>(base)
      .then(s => { if (!cancelled) setSummary(s); })
      .catch(c => { if (!cancelled) setErr(errText(c, 'دریافت وضعیت خلاصه انجام نشد.')); });
    return () => { cancelled = true; };
  }, [base]);

  const pending = summary?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const t = setInterval(() => {
      readJson<Summary>(base)
        .then(s => { if (!cancelled) setSummary(s); })
        .catch(c => { if (!cancelled) setErr(errText(c, 'دریافت وضعیت خلاصه انجام نشد.')); });
    }, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pending, base]);

  const start = async () => {
    const id = threadId;
    setPosting(true); setErr(''); setConsent(false);
    try {
      const s = await request<Summary>(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 'شروع خلاصه‌سازی انجام نشد.');
      if (current.current === id) setSummary(s);
    } catch (c) { if (current.current === id) setErr(errText(c, 'شروع خلاصه‌سازی انجام نشد.')); }
    finally { if (current.current === id) setPosting(false); }
  };

  const showAction = summary && (summary.status === 'none' || summary.status === 'error' || (summary.status === 'ready' && summary.stale));
  const label = summary?.status === 'ready' ? 'ساخت دوبارهٔ خلاصه' : summary?.status === 'error' ? 'تلاش دوباره' : 'ساخت خلاصهٔ گفتگو';
  return (
    <section className="smr-ai" aria-label="خلاصهٔ گفتگو" data-testid="panel-thread-summary">
      <h3>خلاصهٔ کل گفتگو</h3>
      {!summary && !err && <div className="smr-skeleton" />}
      {pending && <div className="smr-state-inline" role="status">در حال ساخت خلاصه از کل تاریخچهٔ ذخیره‌شده…</div>}
      {summary?.status === 'ready' && <>
        {summary.stale && <div className="smr-stale">پس از ساخت این خلاصه پیام‌های جدیدی ذخیره شده است؛ خلاصه قدیمی است.</div>}
        <p className="smr-ai-text">{summary.text}</p>
        {summary.updatedAt && <small>آخرین به‌روزرسانی: {faDateTime(summary.updatedAt)}</small>}
      </>}
      {summary?.status === 'error' && <div className="smr-error" role="alert">{summary.error || 'ساخت خلاصه ناموفق بود.'}</div>}
      {summary?.status === 'none' && <small>هنوز خلاصه‌ای ساخته نشده است.</small>}
      {err && <div className="smr-error" role="alert">{err}</div>}
      {showAction && !consent && <button type="button" className="btn btn-primary" disabled={posting} onClick={() => setConsent(true)} data-testid="button-summary-start">{label}</button>}
      {consent && <div className="smr-consent" role="alertdialog" aria-label="رضایت ارسال به هوش مصنوعی">
        <p>با ادامه، تمام متن ذخیره‌شدهٔ این گفتگو، از همهٔ تاریخ‌ها و پیام‌رسان‌ها و نه فقط پیام‌های نمایش‌داده‌شده، برای خلاصه‌سازی به سرویس هوش مصنوعی پیکربندی‌شده ارسال می‌شود.</p>
        <div className="smr-chips">
          <button type="button" className="btn btn-primary" onClick={() => void start()} data-testid="button-summary-confirm">می‌پذیرم و ارسال کن</button>
          <button type="button" className="btn btn-ghost" onClick={() => setConsent(false)}>انصراف</button>
        </div>
      </div>}
    </section>
  );
}

function ThreadDetail({ threadId, listThread, onClose, onBound }: { threadId: string; listThread: Thread; onClose: () => void; onBound: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [thread, setThread] = useState<Thread>(listThread);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [err, setErr] = useState('');
  const token = useRef(0);
  const base = `/api/social-monitor/threads/${encodeURIComponent(threadId)}/messages`;

  const load = () => {
    const id = ++token.current;
    setLoading(true); setErr(''); setMessages([]); setThread(listThread);
    readJson<MessagesBody>(base)
      .then(b => { if (id !== token.current) return; setMessages(b.messages); setCursor(b.olderCursor); setHasMore(b.hasMore); setThread(b.thread); })
      .catch(c => { if (id === token.current) setErr(errText(c, 'دریافت پیام‌ها انجام نشد.')); })
      .finally(() => { if (id === token.current) setLoading(false); });
  };
  useEffect(() => { load(); return () => { token.current++; }; }, [threadId]);

  const older = () => {
    if (!cursor || olderLoading) return;
    const id = token.current;
    setOlderLoading(true); setErr('');
    readJson<MessagesBody>(`${base}?before=${encodeURIComponent(cursor)}`)
      .then(b => {
        if (id !== token.current) return;
        setMessages(prev => { const seen = new Set(prev.map(m => m.id)); return [...b.messages.filter(m => !seen.has(m.id)), ...prev]; });
        setCursor(b.olderCursor); setHasMore(b.hasMore);
      })
      .catch(c => { if (id === token.current) setErr(errText(c, 'دریافت پیام‌های قدیمی‌تر انجام نشد.')); })
      .finally(() => { if (id === token.current) setOlderLoading(false); });
  };

  const items = useMemo(() => {
    const out: Array<{ type: 'sep'; day: string } | { type: 'msg'; m: Message }> = [];
    let last = '';
    for (const m of messages) {
      const d = fmtDay(new Date(m.occurredAt));
      if (d !== last) { out.push({ type: 'sep', day: d }); last = d; }
      out.push({ type: 'msg', m });
    }
    return out;
  }, [messages]);

  const linked = thread.customerId != null && (thread.customerMatch === 'linked' || thread.customerMatch === 'exact');
  return (
    <section className="smr-detail" aria-label="متن گفتگو" data-testid="panel-thread-detail">
      <div className="smr-detail-head">
        <div><h2>{thread.contactName}</h2>
          <span>{thread.employeeName} · {thread.services.map(s => serviceNames[s]).join('، ')} · {faNum(thread.messageCount)} پیام از {faNum(thread.sourceCount)} منبع</span></div>
        <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="button-close-thread">بستن</button>
      </div>
      <div className="smr-customer">
        {linked ? <>
          <span>مشتری CRM:</span>
          <a href={`/customers/${thread.customerId}`} className="smr-link" data-testid="link-thread-customer">{thread.customerName || 'مشتری'}</a> <CustomerIdBadge id={thread.customerId} />
          {thread.customerMatch === 'exact' && <small>(تطبیق خودکار نام یا شناسهٔ CRM)</small>}
        </> : <CustomerLinker thread={thread} onBound={onBound} />}
      </div>
      <SummaryPanel threadId={threadId} />
      <div className="smr-archive-note">آرشیو فقط‌خواندنی است. تاریخچه شامل همهٔ پیام‌های ذخیره‌شده در همهٔ بازه‌هاست، نه فقط بازهٔ فیلتر شده.</div>
      {err && <div className="smr-error" role="alert">{err} <button type="button" className="smr-link" onClick={() => (messages.length ? older() : load())}>تلاش دوباره</button></div>}
      {loading ? <div className="smr-skeleton tall" /> : messages.length === 0 ? <div className="smr-state">متنی برای نمایش ذخیره نشده است.</div> :
        <div className="smr-messages" data-testid="list-thread-messages">
          {hasMore && <button type="button" className="btn btn-ghost smr-older" disabled={olderLoading} onClick={older} data-testid="button-load-older">{olderLoading ? 'در حال دریافت…' : 'بارگذاری پیام‌های قدیمی‌تر'}</button>}
          {!hasMore && <div className="smr-start">ابتدای تاریخچهٔ ذخیره‌شده</div>}
          {items.map(it => it.type === 'sep'
            ? <div key={`s-${it.day}`} className="smr-sep"><span>{faDate(it.day)}</span></div>
            : <article key={it.m.id} className={`smr-message ${it.m.direction}`}>
              <div className="smr-message-meta">{it.m.direction === 'inbound' ? 'مشتری' : 'کارشناس'} · {serviceNames[it.m.service]} · {it.m.timestampKnown ? faTime(it.m.occurredAt) : `زمان مشاهده در مرورگر (ساعت اصلی نامشخص): ${faTime(it.m.occurredAt)}`}</div>
              <div className="smr-message-text">{it.m.text}</div>
            </article>)}
        </div>}
    </section>
  );
}

export function SocialMonitorReports() {
  const today = useMemo(todayTehran, []);
  const [from, setFrom] = useState(() => {
    const d = new Date(`${today}T12:00:00+03:30`); d.setDate(d.getDate() - 6);
    return fmtDay(d);
  });
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState('');
  const [service, setService] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = () => {
    const params = new URLSearchParams({ from, to });
    if (employeeId) params.set('employeeId', employeeId);
    if (service) params.set('service', service);
    return params.toString();
  };
  const reqId = useRef(0);
  const refresh = async () => {
    const id = ++reqId.current;
    setLoading(true); setError(''); setSelectedId(null);
    try { const r = await readJson<Report>(`/api/social-monitor/reports?${query()}`); if (id === reqId.current) setReport(r); }
    catch (cause) { if (id !== reqId.current) return; setReport(null); setError(errText(cause, 'دریافت گزارش انجام نشد.')); }
    finally { if (id === reqId.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [from, to, employeeId, service]);

  const selected = report?.conversations.find(t => t.threadId === selectedId) || null;

  return (
    <section className="smr-page" data-testid="page-social-monitor-reports">
      <header className="smr-heading">
        <div><h1>گزارش پیام‌رسان‌ها</h1><p>فقط گفتگوهایی نمایش داده می‌شوند که کارشناس در پنل باز کرده است.</p></div>
        <button className="btn btn-primary" type="button" onClick={() => void refresh()} disabled={loading} data-testid="button-refresh">به‌روزرسانی</button>
      </header>
      <div className="smr-filters">
        <label>از تاریخ<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label>تا تاریخ<input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} /></label>
        <label>کارشناس<select value={employeeId} onChange={e => setEmployeeId(e.target.value)}><option value="">همهٔ کارشناسان</option>{report?.employees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label>پیام‌رسان<select value={service} onChange={e => setService(e.target.value)}><option value="">همه</option><option value="tg">تلگرام</option><option value="wa">واتس‌اپ</option><option value="bale">بله</option></select></label>
      </div>
      <div className="smr-privacy">متن پیام‌ها از گفتگوی باز و پیام‌های بارگذاری‌شده در مرورگر کارشناس ثبت شده است و مدرک ارسال پیام نیست. پیام‌های ذخیره‌شده فقط برای مدیر قابل مشاهده‌اند؛ تاریخچهٔ چت‌های بسته بارگیری نمی‌شود.</div>
      {error && <div className="smr-error" role="alert">{error} <button type="button" className="smr-link" onClick={() => void refresh()}>تلاش دوباره</button></div>}
      {loading ? <div className="smr-state">در حال دریافت گزارش…</div> : !report ? null : report.days.length === 0
        ? <div className="smr-state">برای این بازه هنوز گزارشی ثبت نشده است. کارشناس باید پیام‌رسان را از صفحهٔ «پیام‌رسان‌ها» باز کند.</div>
        : <>
          <div className="smr-table-wrap"><table className="smr-table">
            <thead><tr><th>روز</th><th>کارشناس</th><th>خلاصه روزانه</th><th>گفتگوها</th><th>پیام مشتری</th><th>پاسخ کارشناس</th><th>کل پیام‌ها</th><th>پیام‌رسان‌ها</th></tr></thead>
            <tbody>{report.days.map((row, index) => <tr key={`${row.employeeId}-${row.day}-${index}`}>
              <td>{faDate(row.day)}</td><td>{row.employeeName}</td><td className="smr-summary">{row.summary || `${row.conversationCount} گفتگو؛ ${row.inboundCount} پیام مشتری و ${row.outboundCount} پاسخ کارشناس`}</td><td>{row.conversationCount}</td>
              <td>{row.inboundCount}</td><td>{row.outboundCount}</td><td>{row.messageCount}</td>
              <td>{String(row.services || '').split(',').filter(Boolean).map(k => serviceNames[k]).join('، ')}</td>
            </tr>)}</tbody>
          </table></div>
          <div className="smr-conversations"><h2>گفتگوهای ثبت‌شده</h2>
            <p className="smr-hint">هر ردیف یک گفتگوی پیوسته است؛ شمارش‌ها مطابق فیلتر بالا هستند و با باز کردن گفتگو کل تاریخچه نمایش داده می‌شود.</p>
            {!report.conversations.length ? <div className="smr-state">گفتگویی در این بازه ثبت نشده است.</div> :
              <div className="smr-table-wrap"><table className="smr-table"><thead><tr><th>مخاطب</th><th>کارشناس</th><th>پیام‌رسان</th><th>مشتری CRM</th><th>پیام مشتری</th><th>پاسخ کارشناس</th><th>آخرین پیام</th><th></th></tr></thead>
                <tbody>{report.conversations.map(row => <tr key={row.threadId} className={selectedId === row.threadId ? 'smr-selected' : ''} data-testid={`row-thread-${row.threadId}`}>
                  <td><button type="button" className="smr-link" onClick={() => setSelectedId(row.threadId)}>{row.contactName}</button></td>
                  <td>{row.employeeName}</td>
                  <td>{row.services.map(s => serviceNames[s]).join('، ')}</td>
                  <td>{row.customerMatch === 'linked' || row.customerMatch === 'exact' ? (row.customerName ? <CustomerName id={row.customerId} name={row.customerName} /> : 'متصل')
                    : row.customerMatch === 'ambiguous' ? <span className="smr-badge warn">نیازمند انتخاب</span> : <span className="smr-badge">بدون اتصال</span>}</td>
                  <td>{row.inboundCount}</td><td>{row.outboundCount}</td>
                  <td>{faDateTime(row.lastMessageAt)}</td>
                  <td><button type="button" className="smr-link" onClick={() => setSelectedId(row.threadId)} data-testid={`button-open-thread-${row.threadId}`}>مشاهده گفتگو</button></td>
                </tr>)}</tbody>
              </table></div>}
          </div>
          {selected && <ThreadDetail key={selected.threadId} threadId={selected.threadId} listThread={selected}
            onClose={() => setSelectedId(null)} onBound={() => void refresh()} />}
        </>}
      <footer className="smr-footnote">خلاصهٔ روزانه بر پایهٔ شمار پیام‌ها و گفتگوهای ثبت‌شده است. خلاصهٔ هوش مصنوعی هر گفتگو فقط پس از تأیید صریح مدیر ساخته می‌شود.</footer>
    </section>
  );
}
