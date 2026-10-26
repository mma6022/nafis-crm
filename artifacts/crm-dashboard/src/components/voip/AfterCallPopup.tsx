import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PhoneCall, RefreshCw } from 'lucide-react';
import {
  useGetAuthSession, getGetAuthSessionQueryKey,
  useListPendingVoipAfterCalls, getListPendingVoipAfterCallsQueryKey,
  useCompleteVoipAfterCall,
  getListCallsQueryKey, getListCustomersQueryKey, getListRemindersQueryKey,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';
import { removeCompletedAfterCallFromQueue } from '@/components/voip/after-call-cache';
import { CallReportEditor } from './CallReportDialog';
import { useLocation } from 'wouter';
import { useTabState } from '@/lib/tab-coordinator';

export function AfterCallPopup() {
  const [location]=useLocation();
  const queryClient = useQueryClient();
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session?.user;
  const allowed = Boolean(user && (user.role === 'admin' || user.permissions?.includes('calls.view')));
  const isAdmin = user?.role === 'admin';
  const key = getListPendingVoipAfterCallsQueryKey();
  // perf 2026-10-26: the change stream pushes every call event, so with it open a 15 s safety poll is enough (was 2 s per tab).
  // The stream and the poll run only while this tab is visible; showing the tab refetches at once.
  const { visible } = useTabState();
  const [streamOpen, setStreamOpen] = useState(false);
  const pendingQ = useListPendingVoipAfterCalls({ query: { queryKey: key, enabled: allowed, refetchInterval: streamOpen ? 15000 : 4000, refetchIntervalInBackground: false } });
  const data = pendingQ.data;
  const complete = useCompleteVoipAfterCall();
  const [deferred, setDeferred] = useState<number[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const items = useMemo(() => data?.items ?? [], [data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    queryClient.invalidateQueries({ predicate: q => String(q.queryKey[0]).startsWith('/api/mobile-calls') });
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    queryClient.invalidateQueries({predicate:q=>/^\/api\/(?:calls|voip\/after-call)\/-?\d+\/report$/.test(String(q.queryKey[0]))});
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/customers') || String(q.queryKey[0]).startsWith('/api/dashboard') });
  };
  const invalidateRef = useRef(invalidate); invalidateRef.current = invalidate;

  useEffect(() => {
    if (!allowed || !visible || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${import.meta.env.BASE_URL}api/voip/after-call/stream`, { withCredentials: true });
    es.onopen = () => setStreamOpen(true);
    es.onerror = () => setStreamOpen(false);
    es.onmessage = () => { setStreamOpen(true); invalidateRef.current(); };
    return () => { es.close(); setStreamOpen(false); };
  }, [allowed,user?.id,visible]);

  useEffect(()=>{setDeferred([]);setShown(null);setDirty(false);setErr('');},[user?.id]);

  useEffect(() => {
    const own=items.filter(i=>i.expertUserId===user?.id);
    const live=own.find(i=>i.isLive&&!deferred.includes(i.id));
    if(live && live.id!==shown && !dirty && !items.find(i=>i.id===shown)?.isLive){setShown(live.id);return;}
    if (shown == null) {
      const next = own.find((i) => !deferred.includes(i.id));
      if (next) setShown(next.id);
    }
  }, [items, deferred, shown,dirty,user?.id]);

  if (!allowed) return null;
  const current = shown != null ? items.find((i) => i.id === shown) : undefined;
  const deferredPending = items.filter((i) => deferred.includes(i.id));
  const closeEditor = () => {
    if (dirty && !window.confirm('تغییرات ذخیره‌نشده از بین می‌رود. بستن؟')) return;
    if (shown != null) setDeferred((d) => (d.includes(shown) ? d : [...d, shown]));
    setShown(null); setDirty(false); setErr('');
  };
  const discard = async (id: number) => {
    if (!window.confirm('این تماس در تاریخچه مشتری ثبت نشود؟ ثبت خودکار اولیهٔ همین تماس برداشته می‌شود، اما سابقهٔ اصلی تماس و فایل صوتی احتمالی حفظ می‌شوند.')) return;
    try {
      await complete.mutateAsync({ id, data: { expertNotes: '', discardHistory: true } });
      await removeCompletedAfterCallFromQueue(queryClient, { eventId: id });
      setShown(null); setDirty(false); invalidate();
    } catch { setErr('عدم ثبت انجام نشد. دوباره تلاش کنید.'); }
  };
  const finish = async (id: number, sent: { subject: string | null; expertNotes: string }) => {
    try {
      await complete.mutateAsync({ id, data: { expertNotes: sent.expertNotes, subject: sent.subject } });
      await removeCompletedAfterCallFromQueue(queryClient, { eventId: id });
      invalidate();
    } catch { setErr('گزارش ذخیره شد اما بستن از صف انجام نشد.'); }
  };
  const lastChecked = data?.lastCheckedAt ? formatDateTime(data.lastCheckedAt) : 'هنوز بررسی نشده';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return <>
    {location==='/calls' ? <>
    <div className="subtle-note" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }} data-testid="status-after-call">
      <PhoneCall size={14} />
      <span>{data?.liveEventSeenAt ? `آخرین رویداد زنده: ${formatDateTime(data.liveEventSeenAt)}` : 'هنوز رویداد زنده‌ای از مرکز تماس دریافت نشده است.'} · آخرین بررسی: {lastChecked}</span>
      {data?.syncError ? <span role="alert" style={{ color: '#991b1b' }} data-testid="text-after-call-sync-error">خطای همگام‌سازی: {data.syncError}</span> : null}
      {pendingQ.isError ? <span role="alert" style={{ color: '#991b1b' }}>دریافت تماس‌های در انتظار ناموفق بود.</span> : null}
      <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => pendingQ.refetch()} disabled={pendingQ.isFetching} data-testid="button-after-call-retry"><RefreshCw size={13} /> بررسی مجدد</button>
      {deferredPending.length > 0 ? <button type="button" className="btn btn-primary" style={{ padding: '2px 10px' }} onClick={() => { setShown(deferredPending[0].id); setDeferred((d) => d.filter((x) => x !== deferredPending[0].id)); }} data-testid="button-after-call-reopen">تماس‌های ثبت‌نشده: {deferredPending.length.toLocaleString('fa-IR')}</button> : null}
    </div>
    {isAdmin && data && !data.liveEventSeenAt ? <div className="cr-setup" data-testid="setup-live-events">
      برای دریافت زنده تماس‌ها، در پنل سرویس‌دهنده این تنظیمات لازم است (تا زمانی که رویداد داخلی نرسد، اتصال زنده تأیید نمی‌شود): Maintenance &gt; Settings &gt; AP Settings، فعال‌سازی Event Webhooks، حالت G4 با POST JSON، رویدادهای IncomingCall، OutgoingCall، New State و CDR، نشانی <span dir="ltr" className="mono">{origin}{import.meta.env.BASE_URL.replace(/\/$/, '')}/api/voip/simotel/events</span>، احراز Basic Auth با نام کاربری <span dir="ltr" className="mono">crm-events</span> و گذرواژه برابر کلید حساب API سیموتل.
    </div> : null}
    </> : null}
    {shown != null ? <Modal key={shown} title={current?.isLive ? 'تماس در جریان' : 'نتیجه تماس'} eyebrow={current ? `تماس ${current.direction === 'incoming' ? 'ورودی' : 'خروجی'}${items.length > 1 ? ` · ${items.length.toLocaleString('fa-IR')} مورد در صف` : ''}` : 'گزارش تماس'} onClose={closeEditor} testId="after-call" wide>
      <CallReportEditor source={{ kind: 'event', id: shown }} onDirtyChange={setDirty}
        onSaved={async (r, sent) => { if (current && !r.isLive) await finish(shown, sent); }}
        footer={() => <>
          {current && !current.isLive ? <button className="btn btn-ghost" type="button" onClick={() => void discard(shown)} disabled={complete.isPending} data-testid="button-after-call-discard">عدم ثبت در تاریخچه تماس</button> : null}
          <button className="btn btn-ghost" type="button" onClick={closeEditor} data-testid="button-after-call-later">{current ? 'بعداً' : 'بستن'}</button>
        </>} />
      {err ? <p role="alert" className="form-error">{err}</p> : null}
    </Modal> : null}
  </>;
}
