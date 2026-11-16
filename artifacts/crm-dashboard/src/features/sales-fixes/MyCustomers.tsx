/** SALES-FIXES 480000 (t810u item 7): «مشتریان من» for a locked sales expert at any step (was the CustLocked card).
 *  Own customers only — server-scoped GET /sales-fixes/my-customers. A row opens that customer's page in «کارهای امروز من» (/today?customer=). */
import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Phone, FolderOpen } from 'lucide-react';
import { toPersianDigits } from '@/lib/customer-id';
import { sfApi, fa, faDay, PRIO_FA } from './api';
import { SfSearchButton } from './SearchOverlay';
import './sf480.css';

const ST_FA: Record<string, string> = { in_progress: 'در حال انجام', completed: 'تکمیل‌شده', cancelled: 'لغوشده' };

export function MyCustomersPage() {
  const [q, setQ] = useState(''); const [dq, setDq] = useState(''); const [off, setOff] = useState(0);
  useEffect(() => { const t = window.setTimeout(() => { setDq(q.trim()); setOff(0); }, 300); return () => window.clearTimeout(t); }, [q]);
  const r = useQuery({ queryKey: ['sf480-my-customers', dq, off], queryFn: () => sfApi.myCustomers(dq, off), placeholderData: keepPreviousData, retry: 1 });
  const total = r.data?.total ?? 0;
  return <div className="sf-mc-page" data-testid="sf-my-customers">
    <div className="sf-kb-h"><h1>مشتریان من</h1>{r.data ? <span className="sf-mut" data-testid="sf-mc-total">{fa(total)} مشتری</span> : null}<span className="sf-sp" /><SfSearchButton big /></div>
    <input className="inp sf-mc-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="فیلتر با نام یا چهار رقم از شماره…" aria-label="فیلتر مشتریان من" data-testid="sf-mc-q" />
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
  </div>;
}
