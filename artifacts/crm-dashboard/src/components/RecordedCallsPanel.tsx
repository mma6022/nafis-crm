import { useMemo, useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, RefreshCw, Users } from 'lucide-react';
import {
  useListVoipRecordings, getListVoipRecordingsQueryKey, getDownloadVoipRecordingUrl,
  useGetAuthSession, getGetAuthSessionQueryKey, type ListVoipRecordingsParams, type VoipRecording,
  getListUsersQueryKey,
} from '@workspace/api-client-react';
import { useVoipExtensions, saveVoipExtension, type VoipExtension } from '@/components/voip/voip-api';
import { formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { TranscriptDialog } from '@/components/voip/TranscriptDialog';
import { EmptyState } from '@/components/DataTools';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliValueToGregorian } from '@/lib/jalali';

const LIMIT = 20;
const statusLabels: Record<string, string> = { ANSWERED: 'پاسخ داده شده', 'NO ANSWER': 'بی‌پاسخ', BUSY: 'مشغول', FAILED: 'ناموفق' };
const directionLabels: Record<string, string> = { incoming: 'ورودی', outgoing: 'خروجی', local: 'داخلی', unknown: 'نامشخص' };

const FIRST_DAY = '1405/07/12';
const todayForFilter = () => {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('/');
};
const defaultRange = () => ({ from: FIRST_DAY, to: todayForFilter() });

function errInfo(err: unknown): { status?: number; message: string } {
  const e = err as { status?: number; data?: { error?: unknown } | null } | null;
  const status = e?.status;
  const server = typeof e?.data?.error === 'string' && e.data.error.trim() ? e.data.error : null;
  if (server) return { status, message: server };
  const labels: Record<number, string> = {
    400: 'فیلترهای واردشده معتبر نیست.', 401: 'نشست شما پایان یافته؛ دوباره وارد شوید.',
    403: 'اجازه مشاهده گزارش تماس‌ها را ندارید.', 422: 'داخلی شما برای گزارش تماس‌ها تنظیم نشده است.',
  };
  return { status, message: (status && labels[status]) || 'دریافت گزارش تماس‌ها ناموفق بود؛ دوباره تلاش کنید.' };
}

function fileExtension(disposition: string | null): string {
  if (!disposition) return 'mp3';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const ext = m ? /\.([A-Za-z0-9]{2,5})$/.exec(m[1].trim())?.[1]?.toLowerCase() : undefined;
  return ext && ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'webm', 'gsm'].includes(ext) ? ext : 'mp3';
}

const fa = (n: number) => n.toLocaleString('fa-IR');
const duration = (s: number) => { const m = Math.floor(s / 60); return `${fa(m)}:${fa(s % 60).padStart(2, '۰')}`; };

export function RecordedCallsPanel() {
  const initial = useMemo(defaultRange, []);
  const [draft, setDraft] = useTableState('recordedCalls.draft', { ...initial, phone: '', extension: '', status: '', recordedOnly: false });
  const [applied, setApplied] = useTableState('recordedCalls.applied', draft);
  const [page, setPage] = useTableState('recordedCalls.page', 1);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [transcript, setTranscript] = useState<{ id: string; from: string; to: string } | null>(null);
  const [dlError, setDlError] = useState<Record<string, string>>({});
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session.data?.user?.role === 'admin';

  const params: ListVoipRecordingsParams = {
    from: jalaliValueToGregorian(applied.from), to: jalaliValueToGregorian(applied.to),
    phone: applied.phone.trim() || undefined, extension: applied.extension.trim() || undefined,
    status: (applied.status || undefined) as ListVoipRecordingsParams['status'],
    recordedOnly: applied.recordedOnly || undefined, page,
  };
  const report = useListVoipRecordings(params, { query: { queryKey: getListVoipRecordingsQueryKey(params), retry: false, staleTime: 30_000 } });
  const data = report.data;
  const err = report.isError ? errInfo(report.error) : null;
  const canManage = !!data?.canManage || isAdmin;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.limit || LIMIT))) : 1;

  const apply = (e: React.FormEvent) => { e.preventDefault(); setApplied(draft); setPage(1); };

  const download = async (row: VoipRecording) => {
    setPending((p) => ({ ...p, [row.id]: true }));
    setDlError((p) => { const n = { ...p }; delete n[row.id]; return n; });
    try {
      const res = await fetch(getDownloadVoipRecordingUrl(row.id, { from: data?.from ?? params.from!, to: data?.to ?? params.to! }), { credentials: 'include' });
      if (!res.ok) {
        let msg = 'دریافت فایل ضبط‌شده ناموفق بود.';
        try { const j = await res.clone().json(); if (typeof j?.error === 'string' && j.error) msg = j.error; } catch { /* keep default */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const safeId = row.id.replace(/[^A-Za-z0-9_.-]/g, '_');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `call-${safeId}.${fileExtension(res.headers.get('Content-Disposition'))}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setDlError((p) => ({ ...p, [row.id]: e instanceof Error ? e.message : 'دریافت فایل ناموفق بود.' }));
    } finally {
      setPending((p) => { const n = { ...p }; delete n[row.id]; return n; });
    }
  };

  return <div className="data-page" data-testid="panel-recorded-calls">
    <div className="page-intro"><div><div className="eyebrow">تماس‌های مرکز تلفن</div><h2>گزارش مرکز تماس</h2><p>گزارش تماس‌های ثبت‌شده در مرکز تلفن و فایل‌های ضبط‌شده، بر اساس دسترسی شما.</p></div>
      {data ? <div className="data-summary"><span>تماس‌های دارای ضبط</span><strong data-testid="text-recorded-total">{fa(data.recordedTotal)}</strong></div> : null}</div>

    <form className="panel" onSubmit={apply} style={{ marginBottom: 16 }}>
      <div className="form-grid">
        <div className="field"><label>از تاریخ (شمسی)</label><PersianDatePicker value={draft.from} minValue={FIRST_DAY} onChange={value => setDraft({ ...draft, from: value || FIRST_DAY })} testId="input-rc-from" /></div>
        <div className="field"><label>تا تاریخ (شمسی)</label><PersianDatePicker value={draft.to} minValue={FIRST_DAY} onChange={value => setDraft({ ...draft, to: value || todayForFilter() })} testId="input-rc-to" /></div>
        <div className="field"><label htmlFor="rc-phone">شماره تلفن</label><input id="rc-phone" dir="ltr" maxLength={32} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="09..." data-testid="input-rc-phone" /></div>
        {canManage ? <div className="field"><label htmlFor="rc-ext">داخلی</label><input id="rc-ext" dir="ltr" maxLength={32} value={draft.extension} onChange={(e) => setDraft({ ...draft, extension: e.target.value })} data-testid="input-rc-extension" /></div> : null}
        <div className="field"><label htmlFor="rc-status">وضعیت</label><select id="rc-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} data-testid="select-rc-status"><option value="">همه</option>{Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label className="boolean-field"><input type="checkbox" checked={draft.recordedOnly} onChange={(e) => setDraft({ ...draft, recordedOnly: e.target.checked })} data-testid="checkbox-rc-recorded" /><strong>فقط دارای فایل ضبط‌شده</strong></label></div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }}>
        <button type="submit" className="btn btn-primary" data-testid="button-rc-apply">اعمال فیلتر</button>
        <button type="button" className="btn btn-ghost" disabled={report.isFetching} onClick={() => report.refetch()} data-testid="button-rc-refresh"><RefreshCw size={15} /> {report.isFetching ? 'در حال به‌روزرسانی...' : 'به‌روزرسانی'}</button>
        {data ? <span className="subtle-note">آخرین دریافت: {formatDateTime(data.fetchedAt)}</span> : null}
      </div>
    </form>

    {report.isLoading ? <SkeletonPanel rows={6} /> : err ? <div className="error-state" role="alert" data-testid="error-rc">
      <span>{err.message}</span>
      {err.status === 422 && !isAdmin ? <span style={{ display: 'block', marginTop: 6 }}>از مدیر سیستم بخواهید حساب CRM شما را به شماره داخلی مرکز تلفن متصل کند.</span> : null}
      {err.status === 422 && isAdmin ? <span style={{ display: 'block', marginTop: 6 }}>در بخش تخصیص داخلی‌ها، برای هر کاربر شماره داخلی را ثبت کنید.</span> : null}
      <button className="btn btn-ghost" onClick={() => report.refetch()}>تلاش دوباره</button></div>
    : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>زمان</th><th>جهت</th><th>از</th><th>به</th><th>کارشناس</th><th>وضعیت</th><th>مدت / گفتگو</th><th>فایل ضبط‌شده</th><th>متن مکالمه</th></tr></thead><tbody>
      {data && data.items.length ? data.items.map((r) => <tr key={r.id} data-testid={`row-rc-${r.id}`}>
        <td className="secondary-cell">{formatDateTime(r.startedAt)}</td>
        <td>{directionLabels[r.direction] ?? r.direction}</td>
        <td dir="ltr" style={{ textAlign: 'right' }}>{r.fromNumber}</td>
        <td dir="ltr" style={{ textAlign: 'right' }}>{r.toNumber}{r.customerName ? <span className="secondary-cell" dir="rtl">{r.customerName}</span> : null}</td>
        <td>{r.expertNames.length ? r.expertNames.join('، ') : 'نامشخص'}{r.extensions.length ? <span className="secondary-cell" dir="ltr">{r.extensions.join(', ')}</span> : null}</td>
        <td>{statusLabels[r.status] ?? r.status}</td>
        <td>{duration(r.durationSeconds)} / {duration(r.talkSeconds)}</td>
        <td>{r.hasRecording ? <><button type="button" className="btn btn-ghost" disabled={!!pending[r.id]} onClick={() => download(r)} data-testid={`button-rc-download-${r.id}`}><Download size={14} /> {pending[r.id] ? 'در حال دریافت...' : 'دانلود'}</button>{dlError[r.id] ? <span role="alert" className="form-error" style={{ display: 'block', marginTop: 4 }}>{dlError[r.id]}</span> : null}</> : <span className="secondary-cell">بدون ضبط</span>}</td>
      <td><button type="button" className="btn btn-ghost" disabled={!r.hasRecording || !data} title={r.hasRecording ? 'تبدیل مکالمه به متن' : 'این تماس فایل ضبط‌شده ندارد'} onClick={() => data && setTranscript({ id: r.id, from: data.from, to: data.to })} data-testid={`button-transcribe-${r.id}`}><FileText size={14} /> تبدیل مکالمه به متن</button></td>
      </tr>) : <tr><td colSpan={9}><EmptyState title="تماسی یافت نشد" description="بازه تاریخ یا فیلترها را تغییر دهید." /></td></tr>}
    </tbody></table>
      {data ? <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 12 }}>
        <button className="btn btn-ghost" disabled={page <= 1 || report.isFetching} onClick={() => setPage(page - 1)} data-testid="button-rc-prev">قبلی</button>
        <span>صفحه {fa(page)} از {fa(totalPages)} ({fa(data.total)} تماس)</span>
        <button className="btn btn-ghost" disabled={page >= totalPages || report.isFetching} onClick={() => setPage(page + 1)} data-testid="button-rc-next">بعدی</button></div> : null}
    </div>}

    {transcript ? <TranscriptDialog key={transcript.id} recordingId={transcript.id} from={transcript.from} to={transcript.to} onClose={() => setTranscript(null)} /> : null}
    {canManage ? <ExtensionMapping /> : null}
  </div>;
}

function ExtensionMapping() {
  const queryClient = useQueryClient();
  const list = useVoipExtensions(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (item: VoipExtension) => {
    setSaving(true); setMsg(null);
    try {
      await saveVoipExtension(item.userId, { extension: value.trim() || null, authorizationUsername: item.authorizationUsername });
      await list.refetch();
      queryClient.invalidateQueries({ queryKey: ['voip-config'] });
      queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListVoipRecordingsQueryKey().slice(0, 1) });
      setEditing(null); setMsg({ ok: true, text: 'داخلی ذخیره شد.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'ذخیره ناموفق بود.' });
    } finally { setSaving(false); }
  };

  return <div className="panel" style={{ marginTop: 16 }} data-testid="panel-extension-mapping">
    <div className="panel-head"><div><h3>تخصیص داخلی به کاربران</h3><p>برای نمایش نام کارشناس در گزارش، هر حساب CRM را به شماره داخلی مرکز تلفن متصل کنید. نیازی به فعال‌سازی تلفن مرورگر نیست.</p></div><Users color="#9aa4b3" /></div>
    {msg ? <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? undefined : 'form-error'} style={msg.ok ? { color: '#047857', fontSize: 13 } : undefined}>{msg.text}</p> : null}
    {list.isLoading ? <SkeletonPanel rows={3} /> : list.isError ? <div className="error-state"><span>دریافت فهرست داخلی‌ها ناموفق بود.</span><button className="btn btn-ghost" onClick={() => list.refetch()}>تلاش دوباره</button></div>
    : <div style={{ overflowX: 'auto' }}><table className="data-table"><thead><tr><th>کاربر</th><th>شماره داخلی</th><th>عملیات</th></tr></thead><tbody>
      {list.data?.items.map((item) => <tr key={item.userId}><td>{item.displayName}</td>
        {editing === item.userId ? <><td><input aria-label={`داخلی ${item.displayName}`} dir="ltr" maxLength={32} value={value} onChange={(e) => setValue(e.target.value)} placeholder="مثال: 101" style={{ width: 110, padding: 4 }} /></td>
          <td><div style={{ display: 'flex', gap: 6 }}><button className="btn btn-primary" disabled={saving} onClick={() => save(item)}>{saving ? 'در حال ذخیره...' : 'ذخیره'}</button><button className="btn btn-ghost" disabled={saving} onClick={() => setEditing(null)}>لغو</button></div></td></>
        : <><td dir="ltr" style={{ textAlign: 'right' }}>{item.extension || 'ندارد'}</td><td><button className="btn btn-ghost" onClick={() => { setEditing(item.userId); setValue(item.extension ?? ''); setMsg(null); }} data-testid={`button-map-ext-${item.userId}`}>ویرایش</button></td></>}
      </tr>)}
    </tbody></table></div>}
  </div>;
}
