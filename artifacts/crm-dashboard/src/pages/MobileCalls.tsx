import { useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, PhoneIncoming, PhoneOutgoing, Smartphone, Trash2 } from 'lucide-react';
import {
  useListMobileCalls, getListMobileCallsQueryKey,
  useListMobileCallExperts, getListMobileCallExpertsQueryKey,
  useListMobileCallDevices, getListMobileCallDevicesQueryKey,
  useCreateMobileCallDevice, useRevokeMobileCallDevice,
} from '@workspace/api-client-react';
import '@/components/voip/CallReportDialog.css';
import { ErrorState, formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Pagination, SearchField } from '@/components/DataTools';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { CallReportDialog } from '@/components/voip/CallReportDialog';
import { useMe, errText } from '@/lib/goods-api';
import { jalaliValueToGregorian } from '@/lib/jalali';

const limit = 10;
const fa = (n: number) => n.toLocaleString('fa-IR');
function dur(s?: number | null) {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${fa(h)}:` : ''}${fa(m).padStart(h ? 2 : 1, '۰')}:${fa(r).padStart(2, '۰')}`;
}
const statusText: Record<string, string> = { completed: 'پاسخ‌داده‌شده', missed: 'بی‌پاسخ', rejected: 'ردشده', failed: 'ناموفق', ringing: 'در حال زنگ', active: 'فعال' };

export default function MobileCalls() {
  const { user, can, isAdmin, loading } = useMe();
  const qc = useQueryClient();
  const [search, setSearch] = useTableState('mobileCalls.search', '');
  const [direction, setDirection] = useTableState('mobileCalls.direction', '');
  const [expert, setExpert] = useTableState('mobileCalls.expert', '');
  const [from, setFrom] = useTableState('mobileCalls.from', '');
  const [to, setTo] = useTableState('mobileCalls.to', '');
  const [offset, setOffset] = useTableState('mobileCalls.offset', 0);
  const [eventId, setEventId] = useState<number | null>(null);
  const [devUser, setDevUser] = useState('');
  const [devName, setDevName] = useState('');
  const [token, setToken] = useState<{ token: string; name: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const params = {
    fromDate: from ? jalaliValueToGregorian(from) : undefined,
    toDate: to ? jalaliValueToGregorian(to) : undefined,
    direction: (direction || undefined) as 'incoming' | 'outgoing' | undefined,
    expertUserId: isAdmin && expert ? Number(expert) : undefined,
    search: search.trim() || undefined,
    limit, offset,
  };
  const calls = useListMobileCalls(params, { query: { queryKey: [...getListMobileCallsQueryKey(params), user?.id], enabled: !loading && can('calls.view'), refetchInterval: 5000 } });
  const experts = useListMobileCallExperts({ query: { queryKey: getListMobileCallExpertsQueryKey(), enabled: isAdmin } });
  const devices = useListMobileCallDevices({ query: { queryKey: getListMobileCallDevicesQueryKey(), enabled: isAdmin } });
  const create = useCreateMobileCallDevice({ mutation: { gcTime: 0 } });
  const revoke = useRevokeMobileCallDevice();

  if (loading) return <SkeletonPanel rows={5} />;
  const items = calls.data?.items ?? [];
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/mobile-calls`;
  const meta = `"callId": "call-0001",\n  "direction": "incoming",\n  "callerNumber": "09120000000",\n  "calleeNumber": "09350000000",\n  "contactName": "",\n  "startedAt": "2026-10-06T10:00:00+03:30"`;
  const startEx = `POST ${base}/start\nAuthorization: Bearer <DEVICE_TOKEN>\nContent-Type: application/json\n\n{\n  ${meta}\n}`;
  const endEx = `POST ${base}/end\nAuthorization: Bearer <DEVICE_TOKEN>\nContent-Type: application/json\n\n{\n  ${meta},\n  "answeredAt": "2026-10-06T10:00:08+03:30",\n  "endedAt": "2026-10-06T10:03:08+03:30",\n  "durationSeconds": 180,\n  "status": "completed"\n}`;

  const generate = async () => {
    setMsg('');
    try {
      const r = await create.mutateAsync({ data: { userId: Number(devUser), deviceName: devName.trim() } });
      setToken({ token: r.token, name: r.device.deviceName });
      create.reset();
      setCopied(false); setDevName('');
      qc.invalidateQueries({ queryKey: getListMobileCallDevicesQueryKey() });
    } catch (e) { setMsg(errText(e)); }
  };
  const doRevoke = async (id: number, name: string) => {
    if (!window.confirm(`دستگاه «${name}» لغو شود؟ تاریخچه تماس‌ها حفظ می‌ماند.`)) return;
    try { await revoke.mutateAsync({ id }); qc.invalidateQueries({ queryKey: getListMobileCallDevicesQueryKey() }); } catch (e) { setMsg(errText(e)); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(token!.token); setCopied(true); } catch { setMsg('کپی انجام نشد؛ کلید را دستی کپی کنید.'); } };

  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">ارتباطات مشتری</div><h2>تماس‌های موبایل</h2><p>همهٔ تماس‌های ورودی و خروجی، حتی بدون یادداشت.</p></div>
      <div className="data-summary"><Smartphone size={17} /><span>کل تماس‌ها</span><strong data-testid="text-mobile-total">{fa(calls.data?.total ?? 0)}</strong></div></div>
    <div className="data-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
      <SearchField value={search} onChange={reset(setSearch)} placeholder="جست‌وجوی شماره یا نام مخاطب..." testId="mobile-calls" />
      <select className="input" value={direction} onChange={(e) => reset(setDirection)(e.target.value)} aria-label="جهت تماس" data-testid="select-direction"><option value="">همهٔ جهت‌ها</option><option value="incoming">ورودی</option><option value="outgoing">خروجی</option></select>
      {isAdmin ? <select className="input" value={expert} onChange={(e) => reset(setExpert)(e.target.value)} aria-label="کارشناس" data-testid="select-expert"><option value="">همهٔ کارشناسان</option>{(experts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : null}
      <PersianDatePicker value={from} onChange={reset(setFrom)} placeholder="از تاریخ" testId="mobile-from" />
      <PersianDatePicker value={to} onChange={reset(setTo)} placeholder="تا تاریخ" testId="mobile-to" />
    </div>
    <div className="subtle-note" data-testid="text-mobile-stats">ورودی: {fa(calls.data?.incomingCount ?? 0)} · خروجی: {fa(calls.data?.outgoingCount ?? 0)} · مجموع مدت مکالمه: {dur(calls.data?.totalDurationSeconds ?? 0)}</div>
    {calls.isLoading ? <SkeletonPanel rows={6} /> : calls.isError ? <ErrorState onRetry={() => calls.refetch()} /> :
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>جهت</th><th>تماس‌گیرنده ← مقصد</th><th>مخاطب</th><th>کارشناس</th><th>شروع</th><th>پایان</th><th>مدت مکالمه</th><th>وضعیت</th></tr></thead>
        <tbody>{items.length ? items.map((c) => {
          const noted = Boolean(c.reportSavedAt || c.subject || c.expertNotes);
          return <tr key={c.id} tabIndex={0} role="button" onClick={() => setEventId(c.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEventId(c.id); }} data-testid={`row-mobile-call-${c.id}`}>
            <td>{c.direction === 'incoming' ? <span><PhoneIncoming size={15} /> ورودی</span> : <span><PhoneOutgoing size={15} /> خروجی</span>}</td>
            <td><span className="mono" dir="ltr">{c.callerNumber} ← {c.calleeNumber}</span></td>
            <td>{c.contactName || <span className="secondary-cell">ناشناس</span>}</td>
            <td>{c.expertName}<span className="secondary-cell">{c.deviceName}</span></td>
            <td className="secondary-cell">{formatDateTime(c.startedAt)}</td>
            <td className="secondary-cell">{c.endedAt ? formatDateTime(c.endedAt) : '—'}</td>
            <td className="mono">{dur(c.durationSeconds)}</td>
            <td>{c.isLive ? <b className="cr-live-chip">در جریان</b> : statusText[c.status] ?? c.status}<span className="secondary-cell">{c.isLive ? 'قابل ثبت یادداشت' : noted ? 'یادداشت ثبت شده' : 'بدون یادداشت'}</span></td>
          </tr>;
        }) : <tr><td colSpan={8}><EmptyState title="تماسی پیدا نشد" description="با تغییر فیلترها یا پس از اتصال دستگاه، تماس‌ها اینجا دیده می‌شوند." /></td></tr>}</tbody></table>
        <Pagination total={calls.data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} testId="mobile-calls" /></div>}
    {eventId != null ? <CallReportDialog eventId={eventId} title="گزارش تماس موبایل" onClose={() => setEventId(null)} /> : null}

    {isAdmin ? <div className="data-table-wrap" style={{ padding: 16, marginTop: 16 }}>
      <h3><KeyRound size={16} /> دستگاه‌ها و کلید اتصال</h3>
      <p className="subtle-note">هر کلید فقط به همان کارشناس انتخاب‌شده محدود است. لغو دستگاه فقط ارسال تماس جدید را متوقف می‌کند و تاریخچه حفظ می‌شود.</p>
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="input" value={devUser} onChange={(e) => setDevUser(e.target.value)} aria-label="کارشناس دستگاه" data-testid="select-device-expert"><option value="">انتخاب کارشناس فعال</option>{(experts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <input className="input" value={devName} maxLength={120} onChange={(e) => setDevName(e.target.value)} placeholder="نام دستگاه" data-testid="input-device-name" />
        <button className="btn btn-primary" disabled={!devUser || !devName.trim() || create.isPending} onClick={generate} data-testid="button-create-device">{create.isPending ? 'در حال ساخت...' : 'ساخت کلید'}</button>
      </div>
      {msg ? <p className="form-error" role="alert" data-testid="error-mobile-device">{msg}</p> : null}
      {token ? <div className="cr-live" role="status" data-testid="box-device-token"><b>کلید «{token.name}» فقط همین یک بار نمایش داده می‌شود.</b><div className="mono" dir="ltr" style={{ wordBreak: 'break-all', margin: '8px 0' }}>{token.token}</div>
        <button className="btn btn-ghost" onClick={copy} data-testid="button-copy-token"><Copy size={15} /> {copied ? 'کپی شد' : 'کپی کلید'}</button> <button className="btn btn-ghost" onClick={() => setToken(null)} data-testid="button-hide-token">بستن و پنهان‌کردن</button></div> : null}
      {devices.isLoading ? <SkeletonPanel rows={2} /> : devices.isError ? <ErrorState onRetry={() => devices.refetch()} /> :
        <table className="data-table"><thead><tr><th>دستگاه</th><th>کارشناس</th><th>وضعیت</th><th>آخرین اتصال</th><th /></tr></thead><tbody>
          {(devices.data ?? []).length ? (devices.data ?? []).map((d) => <tr key={d.id} data-testid={`row-device-${d.id}`}><td>{d.deviceName}</td><td>{d.expertName}</td><td>{d.active ? 'فعال' : 'لغوشده'}</td><td className="secondary-cell">{d.lastSeenAt ? formatDateTime(d.lastSeenAt) : 'هنوز متصل نشده'}</td>
            <td>{d.active ? <button className="btn btn-ghost" onClick={() => doRevoke(d.id, d.deviceName)} disabled={revoke.isPending} data-testid={`button-revoke-${d.id}`}><Trash2 size={15} /> لغو</button> : null}</td></tr>)
            : <tr><td colSpan={5}><EmptyState title="دستگاهی ثبت نشده" description="برای شروع، کارشناس و نام دستگاه را انتخاب و کلید بسازید." /></td></tr>}</tbody></table>}
      <h3>راهنمای اتصال</h3>
      <p className="subtle-note">برنامهٔ گوشی باید با کلید دستگاه (Bearer) در شروع و پایان هر تماس درخواست بفرستد. شناسهٔ callId در هر دو یکسان است و ارسال تکراری یا پایان پیش از شروع ایمن است. کارشناس از روی کلید تعیین می‌شود و در بدنه پذیرفته نمی‌شود. contactName اگر مخاطب ناشناس است رشتهٔ خالی؛ زمان‌ها ISO با منطقهٔ زمانی؛ durationSeconds فقط طول مکالمه (بدون زنگ خوردن)؛ status یکی از completed، missed، rejected، failed.</p>
      <pre dir="ltr" className="mono" style={{ overflow: 'auto', fontSize: 12 }} data-testid="text-example-start">{startEx}</pre>
      <pre dir="ltr" className="mono" style={{ overflow: 'auto', fontSize: 12 }} data-testid="text-example-end">{endEx}</pre>
    </div> : null}
  </section>;
}
