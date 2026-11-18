/** SALES-FIXES 480000 (t810u item 7): «مشتریان من» for a locked sales expert at any step (was the CustLocked card).
 *  Own customers only — server-scoped GET /sales-fixes/my-customers. A row opens that customer's page in «کارهای امروز من» (/today?customer=).
 *  With flag.customers_priority_kanban_v1 ON, the same short list can be shown in priority columns (no GET /customers). */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Kanban, LayoutList, Phone, FolderOpen, Plus } from 'lucide-react';
import { useMinWidth } from '@/pages/customers-ui';
import { useUpdateCustomer } from '@workspace/api-client-react';
import { toPersianDigits } from '@/lib/customer-id';
import { useCpkOn, listMyCustomersKanban } from '@/features/customers-priority-kanban/api';
import { CustomersKanban, type CpkCustomer } from '@/features/customers-priority-kanban/CustomersKanban';
import { CPK_PAGE, faNum, type CpkView } from '@/features/customers-priority-kanban/helpers';
import { sfApi, fa, faDay, PRIO_FA } from './api';
import { SfSearchButton } from './SearchOverlay';
import { IncomingWizard } from '@/features/expert-lockdown/IncomingWizard';
import '@/pages/customers.css';
import './sf480.css';

const ST_FA: Record<string, string> = { in_progress: 'در حال انجام', completed: 'تکمیل‌شده', cancelled: 'لغوشده' };
const STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'in_progress', label: 'در حال انجام' },
  { value: 'completed', label: 'اتمام' },
  { value: 'cancelled', label: 'لغو شده' },
  { value: '', label: 'همه' },
];

export const MY_CUSTOMERS_DEFAULT_VIEW: CpkView = "board";

export function MyCustomersPage() {
  const cpkOn = useCpkOn();
  const isDesktop = useMinWidth(1024);
  // t853u: board is the default for everyone. List only when the user picks it.
  // Remember at most for this visit (component state); leaving the page falls back to the board. No localStorage.
  const [view, setView] = useState<CpkView>(MY_CUSTOMERS_DEFAULT_VIEW);
  const [formOpen, setFormOpen] = useState(false);
  const setAndRemember = (v: CpkView) => { setView(v); };

  const [q, setQ] = useState(''); const [dq, setDq] = useState(''); const [off, setOff] = useState(0);
  const [status, setStatus] = useState('in_progress');
  useEffect(() => { const t = window.setTimeout(() => { setDq(q.trim()); setOff(0); }, 300); return () => window.clearTimeout(t); }, [q]);
  const r = useQuery({ queryKey: ['sf480-my-customers', dq, off], queryFn: () => sfApi.myCustomers(dq, off), placeholderData: keepPreviousData, retry: 1, enabled: !cpkOn || view === 'table' });
  const total = r.data?.total ?? 0;

  const countsQ = useQuery({
    queryKey: ['sf480-my-customers', 'counts', dq],
    queryFn: () => listMyCustomersKanban({ search: dq || undefined, offset: 0, limit: 1, counts: true }),
    enabled: cpkOn && view === 'board',
    staleTime: 30_000,
    retry: 1,
  });
  const tabCount = (value: string) => {
    if (!countsQ.data) return null;
    if (!value) return countsQ.data.totalCustomers ?? 0;
    return countsQ.data.statusCounts?.find((s) => s.status === value)?.count ?? 0;
  };

  const qc = useQueryClient();
  const updateCustomer = useUpdateCustomer();
  const changePriority = (customer: CpkCustomer, priorityValue: number | null) => new Promise<'saved' | 'deferred' | 'error'>((resolve) => {
    updateCustomer.mutate({ id: customer.id, data: { priority: priorityValue } }, {
      onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sf480-my-customers'] }); resolve('saved'); },
      onError: () => resolve('error'),
    });
  });

  const fetchPage = (args: { priority?: number; hasPriority?: boolean; offset: number; limit: number; search?: string; status?: string }) =>
    listMyCustomersKanban({
      search: args.search,
      status: args.status,
      priority: args.priority,
      hasPriority: args.hasPriority,
      offset: args.offset,
      limit: args.limit || CPK_PAGE,
    }) as Promise<{ items: CpkCustomer[]; total: number }>;

  if (cpkOn && view === 'board') {
    return <div className="sf-mc-page cpk-on-board" data-testid="sf-my-customers" dir="rtl">
      <div className="sf-kb-h">
        <h1>مشتریان من</h1>
        <button type="button" className="csx-primary" onClick={() => setFormOpen(true)} data-testid="sf-mc-new"><Plus size={16} aria-hidden="true" /> ثبت مشتری جدید</button>
        <span className="sf-sp" />
        <div className="csx-viewseg cpk-show" role="group" aria-label="نوع نمایش">
          <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setAndRemember('table')} data-testid="btn-view-table"><LayoutList size={17} aria-hidden="true" /> فهرست</button>
          <button type="button" className={view === 'board' ? 'active' : ''} aria-pressed={view === 'board'} onClick={() => setAndRemember('board')} data-testid="btn-view-board"><Kanban size={17} aria-hidden="true" /> ستون‌ها</button>
        </div>
      </div>
      <input className="inp sf-mc-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجو با نام یا چهار رقم از شماره…" aria-label="جستجوی مشتریان من" data-testid="sf-mc-q" />
      <div className="csx-tabs" role="tablist" aria-label="وضعیت پیگیری" data-testid="select-filter-status">
        {STATUS_TABS.map((tab) => {
          const n = tabCount(tab.value);
          return <button key={tab.value || 'all'} type="button" role="tab" className="csx-tab" aria-selected={status === tab.value} data-s={tab.value || undefined} onClick={() => setStatus(tab.value)} data-testid={`tab-status-${tab.value || 'all'}`}>
            {tab.label}
            {countsQ.isError ? null : n == null ? <span className="n sk" aria-hidden="true" /> : <span className="n" aria-label={`${faNum(n)} مشتری`}>{faNum(n)}</span>}
          </button>;
        })}
      </div>
      <CustomersKanban
        filters={{ search: dq || undefined, status: (status || undefined) as any }}
        priorityFilter=""
        isDesktop={isDesktop}
        canDrag
        canCall={false}
        menuItems={() => []}
        onChangePriority={changePriority}
        onClearFilters={() => { setQ(''); setDq(''); setStatus(''); }}
        hasQuery={Boolean(dq) || Boolean(status)}
        fetchPage={fetchPage}
        cardHref={(c) => `/today?customer=${c.id}`}
      />
      {formOpen ? <IncomingWizard startNew currentNo={null} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); void qc.invalidateQueries({ queryKey: ['sf480-my-customers'] }); }} /> : null}
    </div>;
  }

  return <div className="sf-mc-page" data-testid="sf-my-customers">
    <div className="sf-kb-h">
      <h1>مشتریان من</h1>
        <button type="button" className="csx-primary" onClick={() => setFormOpen(true)} data-testid="sf-mc-new"><Plus size={16} aria-hidden="true" /> ثبت مشتری جدید</button>
      {r.data ? <span className="sf-mut" data-testid="sf-mc-total">{fa(total)} مشتری</span> : null}
      <span className="sf-sp" />
      {cpkOn ? <div className="csx-viewseg cpk-show" role="group" aria-label="نوع نمایش">
        <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setAndRemember('table')} data-testid="btn-view-table"><LayoutList size={17} aria-hidden="true" /> فهرست</button>
        <button type="button" className={view === 'board' ? 'active' : ''} aria-pressed={view === 'board'} onClick={() => setAndRemember('board')} data-testid="btn-view-board"><Kanban size={17} aria-hidden="true" /> ستون‌ها</button>
      </div> : <SfSearchButton big />}
    </div>
    <input className="inp sf-mc-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); }} placeholder="فیلتر با نام یا چهار رقم از شماره…" aria-label="فیلتر مشتریان من" data-testid="sf-mc-q" />
    {r.isLoading ? <div className="dp-skel" role="status">در حال بارگذاری…</div>
      : r.isError ? <div className="dp-box err" role="alert">فهرست بارگذاری نشد. <button type="button" className="btn btn-ghost" onClick={() => void r.refetch()}>تلاش دوباره</button></div>
      : <>
        <ul className="sf-mc-list">{(r.data?.items ?? []).map((c) => <li key={c.id}>
          <Link href={`/today?customer=${c.id}`} className="sf-mc-row" data-testid="sf-mc-row">
            <span className="sf-kcn"><b>{toPersianDigits(c.name)}</b><span className="dp-id">#{fa(c.id)}</span></span>
            <span className="sf-mut" dir="ltr">•••{fa(c.phoneLast4)}</span>
            {c.priority ? <span className="sf-pr">{PRIO_FA[c.priority] ?? ''}</span> : null}
            <span className={`sf-life ${c.status}`}>{ST_FA[c.status] ?? ''}</span>
            <span className="sf-mut"><Phone size={13} aria-hidden="true" /> {c.lastCallAt ? faDay(c.lastCallAt) : 'بدون تماس'}</span>
            <span className="sf-mut"><FolderOpen size={13} aria-hidden="true" /> {fa(c.cases)} پرونده</span>
          </Link></li>)}</ul>
        {!r.data?.items.length ? <p className="sf-sempty">مشتری‌ای پیدا نشد.</p> : null}
        {total > 30 ? <div className="sf-mc-pg"><button type="button" className="btn btn-ghost" disabled={off === 0} onClick={() => setOff(Math.max(0, off - 30))}>قبلی</button>
          <span className="sf-mut">{fa(off + 1)} تا {fa(Math.min(total, off + 30))} از {fa(total)}</span>
          <button type="button" className="btn btn-ghost" disabled={off + 30 >= total} onClick={() => setOff(off + 30)} data-testid="sf-mc-next">بعدی</button></div> : null}
      </>}
      {formOpen ? <IncomingWizard startNew currentNo={null} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); void qc.invalidateQueries({ queryKey: ['sf480-my-customers'] }); }} /> : null}
  </div>;
}
