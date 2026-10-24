import { CalendarDays, Check, ChevronDown, ClipboardList, Download, Edit3, FileText, PhoneCall, Plus, Search, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { getCustomer, useGetAuthSession, getGetAuthSessionQueryKey, type CustomerDetail, listCalls, useListCalls, useCreateCall, useCreateConsultation, useListSalespersons, getListCallsQueryKey, getListRemindersQueryKey, getListCustomersQueryKey, getListConsultationsQueryKey, type CallInput, type CallRecord, type ConsultationInput } from '@workspace/api-client-react';
import '@/components/voip/CallReportDialog.css';
import { ErrorState, formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { Pagination } from '@/components/DataTools';
import { CallForm, CreateConsultationForm } from '@/components/Forms';
import { CallCustomerPicker, callTimeLabel, whoLabel } from '@/components/CallCustomerPicker';
import { SimpleCallForm } from '@/features/team-sales/SimpleCallForm';
import { useCallLauncher, CallLaunchStatus } from '@/features/team-sales/useCallLauncher';
import { CallReportDialog } from '@/components/voip/CallReportDialog';
import { removeCompletedAfterCallFromQueue } from '@/components/voip/after-call-cache';
import { RecordedCallsPanel } from '@/components/RecordedCallsPanel';
import { PersianDatePicker } from '@/components/PersianDatePicker';
import { jalaliValueToGregorian } from '@/lib/jalali';
import { useDialogFocus, useMinWidth } from './customers-ui';
import './calls.css';
import { CustomerName } from '@/components/customer/CustomerName';
import { RowActionsMenu } from '@/components/row-menu/RowActionsMenu';

const limit = 20;
const fa = (n: number) => n.toLocaleString('fa-IR');
type Period = 'today' | 'week' | 'all' | 'range';
type Filters = { period: Period; from: string; to: string; mine: boolean | null; expert: string };
const PERIOD_LABEL: Record<Period, string> = { today: 'امروز', week: 'این هفته', all: 'همه', range: 'بازه‌ی دلخواه' };

/** Gregorian YYYY-MM-DD of a day in Tehran (the server reads from/to as Tehran days). */
const tehranDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);
function periodBounds(f: Filters): { from?: string; to?: string; bad?: boolean } {
  const now = new Date();
  if (f.period === 'today') { const t = tehranDay(now); return { from: t, to: t }; }
  if (f.period === 'week') {
    // Persian week starts on Saturday.
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Tehran' }).format(now);
    const back = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(wd);
    return { from: tehranDay(new Date(now.getTime() - Math.max(0, back) * 86_400_000)), to: tehranDay(now) };
  }
  if (f.period === 'range') {
    const from = jalaliValueToGregorian(f.from); const to = jalaliValueToGregorian(f.to);
    if ((f.from && !from) || (f.to && !to) || (from && to && from > to)) return { bad: true };
    return { from, to };
  }
  return {};
}

export default function Calls() {
  const [tab, setTab] = useTableState<'manual' | 'recordings'>('calls.tab', 'manual');
  const desktop = useMinWidth(981);
  return <section className={`clx${tab === 'manual' && !desktop ? ' has-mbar' : ''}`} data-testid="page-calls">
    {desktop ? <div className="clx-intro"><div><p>تماس‌های امروز را ببینید و از همین‌جا تماس یا مشاوره‌ی بعدی را ثبت کنید.</p></div><span id="clx-new-slot" /></div> : null}
    <div className="clx-seg" role="tablist" aria-label="نوع گزارش تماس">
      <button type="button" role="tab" aria-selected={tab === 'manual'} onClick={() => setTab('manual')} data-testid="tab-manual">تماس‌های ثبت‌شده</button>
      <button type="button" role="tab" aria-selected={tab === 'recordings'} onClick={() => setTab('recordings')} data-testid="tab-recordings">گزارش مرکز تماس</button>
    </div>
    {tab === 'recordings' ? <RecordedCallsPanel /> : <ManualCalls desktop={desktop} />}
  </section>;
}

function ManualCalls({ desktop = true }: { desktop?: boolean }) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session.data?.user;
  const isAdmin = user?.role === 'admin';
  const can = (p: string) => isAdmin || (user?.permissions ?? []).includes(p);
  const canCustomersView = can('customers.view');
  const canCall = can('calls.create') && canCustomersView;
  const canConsult = can('consultations.create');
  // Decision 7: a user with calls access but no customers.view only ever sees their own calls (enforced by GET /calls).
  const callsOnly = Boolean(user) && !isAdmin && !canCustomersView;
  const showMine = Boolean(user) && !isAdmin && (user?.salespersonId != null || callsOnly);
  const showExpert = Boolean(user) && !callsOnly && (isAdmin || user?.customerScope === 'all');

  const [search, setSearch] = useTableState('calls.search', '');
  const [q, setQ] = useState(search);
  useEffect(() => { const t = window.setTimeout(() => setQ(search.trim()), 350); return () => window.clearTimeout(t); }, [search]);
  const [offset, setOffset] = useTableState('calls.offset', 0);
  const [f, setF] = useTableState<Filters>('calls.view', { period: 'today', from: '', to: '', mine: null, expert: '' });
  const mine = callsOnly || (showMine && (f.mine ?? true)); // default for a salesperson: «امروز + تماس‌های من»
  const bounds = periodBounds(f);
  const params = {
    search: q || undefined, limit, offset,
    salespersonId: mine ? (user?.salespersonId ?? undefined) : showExpert && f.expert ? Number(f.expert) : undefined,
    from: bounds.bad ? undefined : bounds.from, to: bounds.bad ? undefined : bounds.to,
  };
  const update = (patch: Partial<Filters>) => { setF((cur) => ({ ...cur, ...patch })); setOffset(0); };
  const calls = useListCalls(params, { query: { queryKey: getListCallsQueryKey(params), enabled: Boolean(user), placeholderData: (prev) => prev } });
  const salespersons = useListSalespersons({ query: { queryKey: ['calls-salespersons'], staleTime: 60_000, enabled: showExpert || canCall } });
  const items = calls.data?.items ?? [];
  const total = calls.data?.total ?? 0;
  const expertName = salespersons.data?.find((p) => String(p.id) === f.expert)?.name;
  const tags = [f.period === 'range' ? `${f.from || '…'} تا ${f.to || '…'}` : PERIOD_LABEL[f.period], ...(mine ? ['تماس‌های من'] : []), ...(!mine && expertName ? [`کارشناس: ${expertName}`] : []), ...(q ? [`«${q}»`] : [])];
  const filtered = f.period !== 'all' || (!callsOnly && mine) || Boolean(!mine && f.expert) || Boolean(search);
  const clearAll = () => { setSearch(''); setQ(''); setF({ period: 'all', from: '', to: '', mine: false, expert: '' }); setOffset(0); setExportError(''); };

  // ---- «ثبت تماس» (row or picker) → useCallLauncher decides SimpleCallForm vs CallForm.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickFetch, setPickFetch] = useState<{ id: number; name: string; state: 'checking' | 'error' } | null>(null);
  const [rowFetch, setRowFetch] = useState<{ id: number; error?: string } | null>(null);
  const [legacyFor, setLegacyFor] = useState<{ customer: CustomerDetail; fromPicker: boolean } | null>(null);
  const [simpleFor, setSimpleFor] = useState<{ customer: CustomerDetail; fromPicker: boolean } | null>(null);
  const [consultFor, setConsultFor] = useState<{ id: number; name: string; phone: string; salespersonName?: string | null } | null>(null);
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const origin = useRef<'picker' | 'row'>('row');
  const seq = useRef(0);
  const launcher = useCallLauncher<CustomerDetail>(user, Boolean(user) && canCustomersView, (customer, kind) => {
    const fromPicker = origin.current === 'picker';
    setPickFetch(null); setRowFetch(null); setPickerOpen(false);
    if (kind === 'simple') setSimpleFor({ customer, fromPicker }); else setLegacyFor({ customer, fromPicker });
  });
  const lastPick = useRef<{ id: number; name: string } | null>(null);
  const pick = async (row: { id: number; name: string }) => {
    const s = ++seq.current; origin.current = 'picker'; lastPick.current = row; launcher.cancel();
    setPickFetch({ id: row.id, name: row.name, state: 'checking' });
    try {
      const full = await getCustomer(row.id);
      if (s !== seq.current) return;
      launcher.launch(full);
    } catch { if (s === seq.current) setPickFetch({ id: row.id, name: row.name, state: 'error' }); }
  };
  // While the team-sales settings load, the picked row keeps its «در حال بررسی پرونده…»; a settings error shows retry.
  const pickerChecking = pickFetch && launcher.status === 'error' ? { ...pickFetch, state: 'error' as const } : pickFetch;
  const callRow = async (call: CallRecord) => {
    if (call.customerId == null) return;
    const s = ++seq.current; origin.current = 'row'; launcher.cancel(); setRowFetch({ id: call.id });
    try {
      const full = await getCustomer(call.customerId);
      if (s !== seq.current) return;
      launcher.launch(full);
    } catch { if (s === seq.current) setRowFetch({ id: call.id, error: `پرونده‌ی «${call.customerName}» باز نشد. دوباره تلاش کنید.` }); }
  };
  const openPicker = () => { seq.current++; launcher.cancel(); setPickFetch(null); setRowFetch(null); setPickerOpen(true); };
  const closePicker = () => { seq.current++; launcher.cancel(); setPickFetch(null); setPickerOpen(false); setPickerSearch(''); };
  const backToPicker = () => { setLegacyFor(null); setSimpleFor(null); setPickFetch(null); setPickerOpen(true); };
  const closeForms = () => { setLegacyFor(null); setSimpleFor(null); setPickerSearch(''); };

  const create = useCreateCall();
  const createConsult = useCreateConsultation();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    queryClient.invalidateQueries({ queryKey: ['calls-customers'] });
    queryClient.invalidateQueries({ queryKey: ['board-customers'] });
  };
  const save = async (data: CallInput) => {
    try {
      const saved = await create.mutateAsync({ data });
      closeForms();
      await removeCompletedAfterCallFromQueue(queryClient, { callLogId: saved.id });
      invalidate();
    } catch {
      // Keep the form open so the user can retry.
    }
  };
  const saveConsult = (data: ConsultationInput) => {
    createConsult.mutate({ data }, { onSuccess: (created) => {
      setConsultFor(null); invalidate(); queryClient.invalidateQueries({ queryKey: getListConsultationsQueryKey() });
      try { sessionStorage.setItem('nafis-open-matches', String(created.id)); } catch { /* ignore */ }
      setLocation('/consultations');
    } });
  };

  // ---- CSV (all pages, same server filters/authorization as the table)
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportReport = async () => {
    setExporting(true); setExportError('');
    try {
      const rows: CallRecord[] = [];
      const ids = new Set<number>();
      let expectedTotal: number | undefined;
      for (let pageOffset = 0; ; pageOffset += 500) {
        // purpose=export: the server applies the CSV export's (unchanged) scope.
        const result = await listCalls({ ...params, offset: pageOffset, limit: 500, purpose: 'export' } as typeof params & { purpose: 'export' });
        if (expectedTotal !== undefined && result.total !== expectedTotal)
          throw new Error('تعداد تماس‌ها هنگام دریافت گزارش تغییر کرد. دوباره تلاش کنید.');
        expectedTotal = result.total;
        for (const row of result.items) {
          if (ids.has(row.id)) throw new Error('تماس‌ها هنگام دریافت گزارش تغییر کردند. دوباره تلاش کنید.');
          ids.add(row.id); rows.push(row);
        }
        if (rows.length >= result.total) break;
        if (!result.items.length) throw new Error('دریافت همهٔ ردیف‌های گزارش انجام نشد.');
      }
      const cell = (value: unknown) => {
        let text = String(value ?? '');
        if (typeof value !== 'number' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const csv = [
        ['شناسه تماس', 'مشتری', 'شماره تماس', 'کارشناس تماس', 'موضوع', 'یادداشت کارشناس', 'خلاصه سیستم', 'زمان تماس'],
        ...rows.map(row => [row.id, row.customerName, row.customerPhone, row.salespersonName, row.subject, row.expertNotes, row.systemSummary, formatDateTime(row.createdAt)]),
      ].map(row => row.map(cell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `calls-${params.from ?? 'all'}-${params.to ?? 'all'}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'دریافت گزارش ناموفق بود.');
    } finally { setExporting(false); }
  };

  // ---- desktop popovers
  const [pop, setPop] = useState<'range' | 'expert' | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current?.contains(t) || t.closest('.rdp, [data-radix-popper-content-wrapper], .persian-date-popover')) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [pop]);
  const [sheet, setSheet] = useState(false);

  const isUnk = (c: CallRecord) => c.customerId == null || c.id < 0;
  const timeOf = (c: CallRecord) => callTimeLabel(c.createdAt);
  const byOf = (c: CallRecord) => whoLabel(c.salespersonName, c.salespersonId, user);
  const phoneOf = (c: CallRecord) => <span className="ph ltr" dir="ltr">{c.customerPhone}</span>;
  const busyRow = (c: CallRecord) => rowFetch?.id === c.id && !rowFetch.error;
  const callBtn = (c: CallRecord) => canCall ? <button type="button" className="clx-ra call" onClick={(e) => { e.stopPropagation(); void callRow(c); }} aria-label={`ثبت تماس برای ${c.customerName}`} aria-busy={busyRow(c) || undefined} data-testid={`button-row-call-${c.id}`}><PhoneCall aria-hidden="true" /> ثبت تماس</button> : null;
  const consultBtn = (c: CallRecord) => canConsult ? <button type="button" className="clx-ra consult" onClick={(e) => { e.stopPropagation(); setConsultFor({ id: c.customerId as number, name: c.customerName, phone: c.customerPhone, salespersonName: c.customerSalespersonName }); }} aria-label={`ثبت مشاوره برای ${c.customerName}`} data-testid={`button-row-consult-${c.id}`}><FileText aria-hidden="true" /> ثبت مشاوره</button> : null;
  const completeBtn = (c: CallRecord) => <button type="button" className="clx-ra consult" onClick={(e) => { e.stopPropagation(); setSelectedCall(c); }} aria-label="تکمیل گزارش این تماس" data-testid={`button-row-complete-${c.id}`}><Edit3 aria-hidden="true" /> تکمیل گزارش</button>;

  const emptyToday = f.period === 'today' && !q;
  const empty = <div className="clx-emp" data-testid="status-empty"><div className="big"><PhoneCall size={28} aria-hidden="true" /></div>
    {emptyToday ? <><h3>{mine ? 'امروز هنوز تماسی ثبت نکرده‌اید' : 'امروز هنوز تماسی ثبت نشده است'}</h3><p>با «ثبت تماس جدید» اولین تماس امروز را ثبت کنید، یا بازه‌ی زمانی را به «این هفته» تغییر دهید.</p>
      <div className="bt">{canCall ? <button type="button" className="clx-pbtn" onClick={openPicker} data-testid="button-empty-new-call"><Plus size={18} aria-hidden="true" /> ثبت تماس جدید</button> : null}<button type="button" className="clx-gbtn" onClick={() => update({ period: 'week' })} data-testid="button-empty-week">این هفته</button></div></>
      : <><h3>تماسی با این فیلترها پیدا نشد</h3><p>جست‌وجو یا بازه‌ی زمانی را تغییر دهید.</p>{filtered ? <div className="bt"><button type="button" className="clx-gbtn" onClick={clearAll}>پاک کردن فیلترها</button></div> : null}</>}
  </div>;

  const mineChip = showMine ? <button type="button" className="clx-fc" aria-pressed={mine} disabled={callsOnly} onClick={() => update({ mine: !mine, expert: '' })}
    title={callsOnly ? 'با دسترسی فعلی فقط تماس‌های خودتان نمایش داده می‌شود.' : undefined} data-testid="chip-calls-mine">{mine ? <Check size={16} aria-hidden="true" /> : <UserRound size={16} aria-hidden="true" />} تماس‌های من</button> : null;
  const rangeFields = (idp: string) => <>
    <label>از تاریخ<PersianDatePicker value={f.from} onChange={(from) => update({ period: 'range', from })} testId={`${idp}-from`} /></label>
    <label>تا تاریخ<PersianDatePicker value={f.to} onChange={(to) => update({ period: 'range', to })} testId={`${idp}-to`} /></label>
  </>;
  const badRange = bounds.bad ? <p className="clx-err" role="alert">تاریخ‌ها را بررسی کنید؛ تاریخ شروع نباید بعد از تاریخ پایان باشد.</p> : null;
  const summary = (mobile: boolean) => <div className="clx-fsum" data-testid="calls-summary">
    <b data-testid="text-total-calls">{fa(total)} تماس</b><span className="sep">|</span><span>{tags.join('، ')}</span>
    {filtered ? <button type="button" className="lnk" onClick={clearAll} data-testid="button-calls-clear">{mobile ? 'پاک کردن' : 'پاک کردن فیلترها'}</button> : null}
    {!mobile ? <button type="button" className="clx-gbtn sp" disabled={exporting || calls.isLoading || calls.isError || !total} onClick={exportReport} data-testid="button-calls-export"><Download size={16} aria-hidden="true" />{exporting ? 'در حال دریافت…' : 'خروجی CSV'}</button> : null}
  </div>;

  const newBtn = canCall ? <button type="button" className="clx-pbtn" onClick={openPicker} data-testid="button-new-call"><Plus size={18} aria-hidden="true" /> ثبت تماس جدید</button> : null;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(desktop ? document.getElementById('clx-new-slot') : null); }, [desktop]);

  const desktopFilters = <div className="clx-fb" data-testid="form-call-filters">
    <div className="clx-fr">
      <label className="clx-sb"><Search size={18} aria-hidden="true" /><input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)، موضوع یا یادداشت" aria-label="جست‌وجو در تماس‌ها" data-testid="input-search-calls" />
        {search ? <button type="button" className="x" onClick={() => { setSearch(''); setOffset(0); }} aria-label="پاک کردن جست‌وجو"><X size={16} /></button> : null}</label>
      <div className="clx-rel" ref={pop === 'range' ? popRef : undefined}>
        <div className="clx-pseg" role="group" aria-label="بازه‌ی زمانی">
          {(['today', 'week', 'all'] as const).map((p) => <button key={p} type="button" aria-pressed={f.period === p} onClick={() => { update({ period: p }); setPop(null); }} data-testid={`period-${p}`}>{PERIOD_LABEL[p]}</button>)}
          <button type="button" aria-pressed={f.period === 'range'} aria-expanded={pop === 'range'} onClick={() => setPop(pop === 'range' ? null : 'range')} data-testid="period-range"><CalendarDays size={16} aria-hidden="true" /> بازه‌ی دلخواه</button>
        </div>
        {pop === 'range' ? <div className="clx-dd range" role="dialog" aria-label="بازه‌ی دلخواه" style={{ insetInlineStart: 'auto', insetInlineEnd: 0 }}>
          {rangeFields('input-calls')}{badRange}
          <div className="ft"><button type="button" className="clx-fsum lnk" style={{ border: 0, background: 'none', color: 'var(--nf-brand-600)', fontWeight: 700 }} onClick={() => update({ period: 'all', from: '', to: '' })}>پاک کردن</button><button type="button" className="clx-gbtn" onClick={() => setPop(null)}>بستن</button></div>
        </div> : null}
      </div>
    </div>
    {mineChip || showExpert ? <div className="clx-fr">
      {mineChip}
      {showExpert ? <div className="clx-rel" ref={pop === 'expert' ? popRef : undefined}>
        <button type="button" className="clx-fc" aria-pressed={Boolean(!mine && f.expert)} aria-expanded={pop === 'expert'} onClick={() => setPop(pop === 'expert' ? null : 'expert')} data-testid="chip-calls-expert">
          کارشناس{!mine && expertName ? <span className="v">: {expertName}</span> : null} <ChevronDown size={16} aria-hidden="true" /></button>
        {pop === 'expert' ? <div className="clx-dd" role="dialog" aria-label="فیلتر کارشناس" style={{ maxHeight: 360, overflow: 'auto' }}>
          <button type="button" aria-pressed={!f.expert} onClick={() => { update({ expert: '' }); setPop(null); }}>همه‌ی کارشناسان مجاز</button>
          {(salespersons.data ?? []).map((p) => <button key={p.id} type="button" aria-pressed={f.expert === String(p.id)} onClick={() => { update({ expert: String(p.id), mine: false }); setPop(null); }}>{p.name}</button>)}
          {salespersons.isError ? <small role="alert">دریافت کارشناسان ناموفق بود. <button type="button" onClick={() => salespersons.refetch()}>تلاش دوباره</button></small> : null}
        </div> : null}
      </div> : null}
    </div> : null}
    {summary(false)}
    {badRange}
    {exportError ? <p role="alert" className="clx-err">{exportError}</p> : null}
  </div>;

  const mobileFilters = <div className="clx-mfil">
    <label className="clx-sb"><Search size={18} aria-hidden="true" /><input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴) یا یادداشت" aria-label="جست‌وجو در تماس‌ها" data-testid="input-search-calls" />
      {search ? <button type="button" className="x" onClick={() => { setSearch(''); setOffset(0); }} aria-label="پاک کردن جست‌وجو"><X size={16} /></button> : null}</label>
    <div className="row">
      <button type="button" className="clx-fc" aria-pressed={f.period !== 'all'} onClick={() => setSheet(true)} data-testid="chip-calls-period">{f.period === 'range' ? 'بازه‌ی دلخواه' : PERIOD_LABEL[f.period]} <ChevronDown size={16} aria-hidden="true" /></button>
      {mineChip}
      <button type="button" className="clx-fc" aria-pressed={false} onClick={() => setSheet(true)} data-testid="chip-calls-all-filters"><SlidersHorizontal size={16} aria-hidden="true" /> همه‌ی فیلترها</button>
    </div>
    {summary(true)}
    {badRange}
  </div>;

  const table = <div className="clx-twrap">
    {items.length ? <><table className="clx-ct"><caption className="clx-sr">تماس‌های ثبت‌شده</caption>
      <colgroup><col style={{ width: 205 }} /><col /><col style={{ width: 112 }} /><col style={{ width: 296 }} /></colgroup>
      <thead><tr><th scope="col">مشتری</th><th scope="col">موضوع و یادداشت</th><th scope="col">زمان و کارشناس</th><th scope="col"><span className="clx-sr">کارها</span></th></tr></thead>
      <tbody>{items.map((c) => <tr key={c.id} className={isUnk(c) ? 'unk' : undefined} tabIndex={0} aria-label={`گزارش تماس ${c.customerName}`} onClick={() => setSelectedCall(c)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelectedCall(c); } }} data-testid={`row-call-${c.id}`}>
        <td><div className="cn"><CustomerName id={c.customerId} name={c.customerName} badgeTestId={`badge-call-customer-id-${c.id}`} /></div><div className="cs">{phoneOf(c)}</div>{isUnk(c) ? <div className="l2"><span className="clx-oc">بدون پرونده</span></div> : null}</td>
        <td><div className="sj">{c.subject || 'تماس پیگیری'}</div>{c.expertNotes || c.systemSummary ? <div className="nt">{c.expertNotes || c.systemSummary}</div> : null}</td>
        <td><div className="tm" data-testid={`text-call-date-${c.id}`} title={formatDateTime(c.createdAt)}>{timeOf(c)}</div><div className="by">{byOf(c)}</div></td>
        <td className="ac" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <div className="clx-acts">{isUnk(c) ? completeBtn(c) : <>{callBtn(c)}{consultBtn(c)}
            <RowActionsMenu label={`کارهای بیشتر برای تماس ${c.customerName}`} triggerClassName="clx-rowmenu" iconSize={18} triggerTestId={`button-row-more-${c.id}`} contentTestId={`menu-call-row-${c.id}`} items={[
              { key: 'report', onSelect: () => setSelectedCall(c), icon: <ClipboardList size={17} aria-hidden="true" />, label: 'گزارش کامل این تماس', testId: `menuitem-call-report-${c.id}` },
              ...(canCustomersView ? [{ key: 'file', href: `/customers/${c.customerId}`, icon: <UserRound size={17} aria-hidden="true" />, label: 'پرونده‌ی مشتری', testId: `menuitem-call-customer-${c.id}` }] : []),
            ]} /></>}</div>
          {rowFetch?.id === c.id && rowFetch.error ? <div className="clx-err" role="alert" style={{ marginTop: 4, textAlign: 'start' }}>{rowFetch.error}</div> : null}
        </td>
      </tr>)}</tbody></table>
      <Pagination total={total} offset={offset} limit={limit} onChange={setOffset} testId="calls" /></> : empty}
  </div>;

  const cards = items.length ? <><ul className="clx-mcards" data-testid="calls-cards">{items.map((c) => <li key={c.id} className={`clx-mcd${isUnk(c) ? ' unk' : ''}`} data-testid={`card-call-${c.id}`}>
    <div className="r1">{isUnk(c) ? <span className="clx-oc">بدون پرونده</span> : null}<span className="tm">{timeOf(c)}</span></div>
    <h3><CustomerName id={c.customerId} name={c.customerName} badgeTestId={`badge-call-customer-id-${c.id}`} /></h3>
    <div className="cs">{phoneOf(c)}<span className="sep">|</span>{byOf(c)}</div>
    <div><div className="sj">{c.subject || 'تماس پیگیری'}</div>{c.expertNotes || c.systemSummary ? <div className="nt">{c.expertNotes || c.systemSummary}</div> : null}</div>
    {isUnk(c) ? <div className="ma one">{completeBtn(c)}</div> : canCall || canConsult ? <div className={`ma${canCall && canConsult ? '' : ' one'}`}>{callBtn(c)}{consultBtn(c)}</div> : null}
    {rowFetch?.id === c.id && rowFetch.error ? <div className="clx-err" role="alert">{rowFetch.error}</div> : null}
    {!isUnk(c) ? <div className="more"><button type="button" onClick={() => setSelectedCall(c)} data-testid={`button-card-report-${c.id}`}>گزارش کامل و پرونده</button></div> : null}
  </li>)}</ul><div className="clx-twrap" style={{ marginTop: 12 }}><Pagination total={total} offset={offset} limit={limit} onChange={setOffset} testId="calls" /></div></>
    : <div className="clx-twrap">{empty}</div>;

  return <>
    {slot && newBtn ? <PortalButton host={slot}>{newBtn}</PortalButton> : null}
    {desktop ? desktopFilters : mobileFilters}
    <CallLaunchStatus status={!pickerOpen ? launcher.status : null} onRetry={launcher.retry} onCancel={() => { launcher.cancel(); setRowFetch(null); }} />
    {calls.isLoading ? <SkeletonPanel rows={6} /> : calls.isError ? <ErrorState onRetry={() => calls.refetch()} /> : desktop ? table : cards}
    {!desktop && canCall ? <div className="clx-mbar">{newBtn}</div> : null}
    {sheet ? <FilterSheet onClose={() => setSheet(false)} total={total} f={f} update={update} mine={mine} showMine={showMine} callsOnly={callsOnly} showExpert={showExpert}
      salespersons={salespersons.data ?? []} rangeFields={rangeFields('sheet-calls')} badRange={badRange} onClear={clearAll} /> : null}
    {pickerOpen ? <CallCustomerPicker user={user} config={launcher.config} search={pickerSearch} onSearch={setPickerSearch} checking={pickerChecking}
      onPick={(row) => void pick(row)} onRetry={() => { if (launcher.status === 'error') launcher.retry(); else if (lastPick.current) void pick(lastPick.current); }} onClose={closePicker} /> : null}
    {legacyFor ? <CallForm key={legacyFor.customer.id} customers={[legacyFor.customer]} salespersons={salespersons.data ?? []} pending={create.isPending} error={create.isError}
      initialCustomerId={legacyFor.customer.id} onClose={closeForms} onSave={save} onChangeCustomer={legacyFor.fromPicker ? backToPicker : undefined} /> : null}
    {simpleFor ? <SimpleCallForm key={simpleFor.customer.id} customer={simpleFor.customer} userId={user?.id} noteMin={launcher.config?.noteMinLength ?? 30}
      onClose={closeForms} onNext={closeForms} onChangeCustomer={simpleFor.fromPicker ? backToPicker : undefined} onDone={invalidate} /> : null}
    {consultFor ? <CreateConsultationForm customers={[consultFor]} pending={createConsult.isPending} initialCustomerId={consultFor.id} onClose={() => setConsultFor(null)} onSave={saveConsult} /> : null}
    {selectedCall ? <CallReportDialog callId={selectedCall.id} onClose={() => setSelectedCall(null)} /> : null}
  </>;
}

function PortalButton({ host, children }: { host: HTMLElement; children: ReactNode }) { return createPortal(children, host); }

function FilterSheet({ onClose, total, f, update, mine, showMine, callsOnly, showExpert, salespersons, rangeFields, badRange, onClear }: {
  onClose: () => void; total: number; f: Filters; update: (p: Partial<Filters>) => void; mine: boolean; showMine: boolean; callsOnly: boolean; showExpert: boolean;
  salespersons: { id: number; name: string }[]; rangeFields: ReactNode; badRange: ReactNode; onClear: () => void;
}) {
  const ref = useDialogFocus(onClose);
  return <>
    <div className="clx-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="clx-msh" role="dialog" aria-modal="true" aria-labelledby="clx-msh-t" tabIndex={-1} dir="rtl" data-testid="sheet-call-filters">
      <div className="grab" aria-hidden="true" />
      <div className="hd"><h2 id="clx-msh-t">فیلتر تماس‌ها</h2><button type="button" className="clx-xb" onClick={onClose} aria-label="بستن"><X size={22} /></button></div>
      <div className="fg" role="group" aria-labelledby="clx-g-time"><span id="clx-g-time">زمان</span><div className="chips">
        {(['today', 'week', 'all', 'range'] as const).map((p) => <button key={p} type="button" className="ch" aria-pressed={f.period === p} onClick={() => update({ period: p })}>{PERIOD_LABEL[p]}</button>)}
      </div>{f.period === 'range' ? <><div className="rg">{rangeFields}</div>{badRange}</> : null}</div>
      {showMine ? <div className="fg" role="group" aria-labelledby="clx-g-by"><span id="clx-g-by">ثبت‌کننده</span><div className="chips">
        <button type="button" className="ch" aria-pressed={mine} disabled={callsOnly} onClick={() => update({ mine: true, expert: '' })}>تماس‌های من</button>
        {!callsOnly ? <button type="button" className="ch" aria-pressed={!mine} onClick={() => update({ mine: false })}>همه‌ی تماس‌های مجاز</button> : null}
      </div></div> : null}
      {showExpert ? <div className="fg"><label htmlFor="clx-sheet-expert" style={{ fontWeight: 800, fontSize: 15 }}>کارشناس</label>
        <select id="clx-sheet-expert" value={mine ? '' : f.expert} onChange={(e) => update({ expert: e.target.value, mine: false })}>
          <option value="">همه‌ی کارشناسان مجاز</option>{salespersons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div> : null}
      <div className="sf"><button type="button" className="clx-gbtn" onClick={onClear}>پاک کردن</button><button type="button" className="clx-pbtn" onClick={onClose} data-testid="sheet-show">نمایش {fa(total)} تماس</button></div>
    </div>
  </>;
}
