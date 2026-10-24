/* «ثبت تماس جدید» step 1: pick the customer first, so the user knows which form opens (HANDOFF crm-calls-page).
   Step 2 (SimpleCallForm or CallForm with «تغییر مشتری») is opened by the Calls page through useCallLauncher. */
import { AlertCircle, Search, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueries } from '@tanstack/react-query';
import { getCustomer, getGetCustomerQueryKey, getListCallsQueryKey, useListCalls, useListCustomers, type CallRecord, type Customer } from '@workspace/api-client-react';
import { usesSimpleForm, type TeamSalesConfig } from '@/features/team-sales/api';
import { useDialogFocus } from '@/pages/customers-ui';

const fa = (n: number) => n.toLocaleString('fa-IR');
const norm = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  .replace(/ي/g, 'ی').replace(/ك/g, 'ک');

export type PickerUser = { id?: number; salespersonId?: number | null; name?: string | null } | undefined;
type Row = { id: number; name: string; phone: string; priority?: number | null; salespersonId?: number | null; salespersonName?: string | null; status?: string | null; last?: string | null };

function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  const query = norm(q.trim());
  if (!query) return text;
  const i = norm(text).toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
}

/** «امروز ۱۰:۴۲» / «دیروز ۰۹:۱۰» / «۱۲ مهر ۱۰:۴۲» in Tehran time. */
export function callTimeLabel(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(x);
  const time = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tehran' }).format(d);
  const today = day(new Date());
  if (day(d) === today) return `امروز ${time}`;
  if (day(d) === day(new Date(Date.now() - 86_400_000))) return `دیروز ${time}`;
  const sameYear = new Intl.DateTimeFormat('en-US-u-ca-persian', { year: 'numeric', timeZone: 'Asia/Tehran' });
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' };
  if (sameYear.format(d) !== sameYear.format(new Date())) opts.year = 'numeric';
  return `${new Intl.DateTimeFormat('fa-IR-u-ca-persian', opts).format(d)} ${time}`;
}

/** Last word of a full name («مریم کاظمی» → «کاظمی»), with «(شما)» for the signed-in user's own salesperson. */
export function whoLabel(name: string | null | undefined, salespersonId: number | null | undefined, user: PickerUser) {
  if (!name) return 'بدون تخصیص';
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  const short = parts.length > 1 ? parts[parts.length - 1] : name;
  return user?.salespersonId != null && salespersonId === user.salespersonId ? `${short} (شما)` : short;
}

export function CallCustomerPicker({ user, config, search, onSearch, checking, onPick, onRetry, onClose }: {
  user: PickerUser;
  config: TeamSalesConfig | undefined;
  /** Kept by the page so «تغییر مشتری» returns to the same search. */
  search: string; onSearch: (value: string) => void;
  /** The row being checked (getCustomer + team-sales settings) or the one whose check failed. */
  checking: { id: number; name: string; state: 'checking' | 'error' } | null;
  onPick: (row: { id: number; name: string }) => void; onRetry: () => void; onClose: () => void;
}) {
  const ref = useDialogFocus(onClose, 'input');
  const [q, setQ] = useState(search.trim());
  useEffect(() => { const t = window.setTimeout(() => setQ(search.trim()), 300); return () => window.clearTimeout(t); }, [search]);
  const active = q.length >= 2;
  const results = useListCustomers({ search: q, limit: 20 }, { query: { queryKey: ['calls-picker-customers', q], enabled: active, staleTime: 30_000 } });
  const me = user?.salespersonId ?? undefined;
  const recentParams = me != null ? { salespersonId: me, limit: 20 } : { limit: 20 };
  const recentCalls = useListCalls(recentParams, { query: { queryKey: getListCallsQueryKey(recentParams), staleTime: 30_000 } });
  const recentBase = useMemo(() => {
    const seen = new Set<number>(); const out: CallRecord[] = [];
    for (const c of recentCalls.data?.items ?? []) {
      if (c.customerId == null || c.id < 0 || seen.has(c.customerId)) continue;
      seen.add(c.customerId); out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  }, [recentCalls.data]);
  // Priority / owner / status are not on CallRecord yet (phase 2), so the few recent customers are read individually.
  const details = useQueries({ queries: recentBase.map((c) => ({ queryKey: getGetCustomerQueryKey(c.customerId as number), queryFn: () => getCustomer(c.customerId as number), staleTime: 60_000, retry: false })) });
  const recentRows: Row[] = recentBase.map((c, i) => {
    const d = details[i]?.data;
    return { id: c.customerId as number, name: d?.name ?? c.customerName, phone: d?.phone ?? c.customerPhone, priority: d?.priority, salespersonId: d?.salespersonId,
      salespersonName: d ? d.salespersonName : c.customerSalespersonName, status: d?.status, last: c.createdAt };
  });
  const resultRows: Row[] = (results.data?.items ?? []).map((c: Customer) => ({ id: c.id, name: c.name, phone: c.phone, priority: c.priority, salespersonId: c.salespersonId,
    salespersonName: c.salespersonName, status: c.status, last: c.lastCallAt }));
  const isQualifier = Boolean(config?.enabled && user?.salespersonId != null && user.salespersonId === config.qualifierSalespersonId);
  const busy = checking?.state === 'checking';

  const item = (r: Row) => {
    const simple = usesSimpleForm(config, user, r);
    const isChecking = checking?.id === r.id && checking.state === 'checking';
    const right = isChecking ? <span className="clx-chk" role="status"><span className="clx-spin" aria-hidden="true" />در حال بررسی پرونده…</span>
      : isQualifier ? <span className={`clx-fh ${simple ? 'simple' : 'legacy'}`}>{simple ? 'فرم ۳ مرحله‌ای' : 'فرم ثبت تماس'}</span> : null;
    return <li key={r.id}>
      <button type="button" className={`clx-pi${busy && !isChecking ? ' dis' : ''}${isChecking ? ' on' : ''}`} disabled={busy} onClick={() => onPick(r)}
        aria-busy={isChecking || undefined} data-testid={`picker-customer-${r.id}`} data-form={isQualifier ? (simple ? 'simple' : 'legacy') : undefined}>
        <span className="av2" aria-hidden="true">{r.name.trim()[0] ?? '؟'}</span>
        <span>
          <span className="n" style={{ display: 'block' }}><Highlight text={r.name} q={active ? q : ''} /></span>
          <span className="m">
            <span className="ph ltr" dir="ltr"><Highlight text={r.phone} q={active && /\d/.test(norm(q)) ? q : ''} /></span>
            <span className="sep">|</span><span className="clx-pr" data-p={r.priority ?? undefined}>{r.priority ? `اولویت ${fa(r.priority)}` : 'بدون اولویت'}</span>
            <span className="sep">|</span>{whoLabel(r.salespersonName, r.salespersonId, user)}
            {r.last ? <><span className="sep">|</span>آخرین تماس {callTimeLabel(r.last)}</> : null}
          </span>
        </span>
        {right}
      </button>
    </li>;
  };

  let body: ReactNode;
  if (!active) {
    body = recentCalls.isLoading ? <p className="hint" role="status">در حال بارگذاری…</p>
      : recentRows.length ? <><div className="lh">{me != null ? 'مشتری‌هایی که اخیراً با آن‌ها تماس گرفته‌اید' : 'آخرین تماس‌های ثبت‌شده'}</div><ul className="clx-pl" data-testid="picker-recent">{recentRows.map(item)}</ul></> : null;
  } else if (results.isLoading) {
    body = <p className="hint" role="status">در حال جست‌وجو…</p>;
  } else if (results.isError) {
    body = <div className="clx-inote bad" role="alert"><AlertCircle size={18} aria-hidden="true" /><div>جست‌وجو انجام نشد. اتصال را بررسی کنید و دوباره امتحان کنید.<div style={{ marginTop: 6 }}><button type="button" className="clx-gbtn" onClick={() => results.refetch()}>تلاش دوباره</button></div></div></div>;
  } else if (!resultRows.length) {
    body = <div className="clx-emp" data-testid="picker-empty"><div className="big"><UsersRound size={28} aria-hidden="true" /></div>
      <h3>{/\d/.test(norm(q)) ? 'مشتری‌ای با این شماره پیدا نشد' : 'مشتری‌ای با این نام پیدا نشد'}</h3>
      <p>شماره را کامل بنویسید یا با نام جست‌وجو کنید. اگر مشتری جدید است، اول از صفحه‌ی «مشتریان» ثبتش کنید.</p>
      <Link href="/customers" className="clx-gbtn" style={{ marginTop: 6 }} data-testid="picker-go-customers"><UsersRound size={17} aria-hidden="true" /> رفتن به مشتریان</Link></div>;
  } else {
    body = <><div className="lh" role="status">{fa(resultRows.length)} مشتری پیدا شد{(results.data?.total ?? 0) > resultRows.length ? ` (${fa(20)} مورد اول؛ دقیق‌تر جست‌وجو کنید)` : ''}</div><ul className="clx-pl" data-testid="picker-results">{resultRows.map(item)}</ul></>;
  }

  return <>
    <div className="clx-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="clx-pk" role="dialog" aria-modal="true" aria-labelledby="clx-pk-t" tabIndex={-1} dir="rtl" data-testid="call-customer-picker">
      <div className="dh"><h2 id="clx-pk-t">ثبت تماس جدید</h2><button type="button" className="clx-xb" onClick={onClose} aria-label="بستن" data-testid="picker-close"><X size={22} /></button></div>
      <ol className="clx-stp" aria-label="مرحله ۱ از ۲"><li className="s on" aria-current="step"><i>۱</i>انتخاب مشتری</li><li className="ln" aria-hidden="true" /><li className="s"><i>۲</i>ثبت تماس</li></ol>
      <div className="dbody">
        <label className="clx-sb"><Search size={18} aria-hidden="true" /><input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="نام یا شماره موبایل مشتری" aria-label="جست‌وجوی مشتری با نام یا موبایل" data-testid="picker-search" />
          {search ? <button type="button" className="x" onClick={() => onSearch('')} aria-label="پاک کردن جست‌وجو"><X size={16} /></button> : null}</label>
        {!active ? <p className="hint">حداقل ۲ حرف از نام یا ۴ رقم از موبایل را بنویسید.</p> : null}
        {checking?.state === 'error' ? <div className="clx-inote bad" role="alert" data-testid="picker-error"><AlertCircle size={18} aria-hidden="true" /><div>پرونده‌ی «{checking.name}» باز نشد. اتصال را بررسی کنید و دوباره امتحان کنید.<div style={{ marginTop: 6 }}><button type="button" className="clx-gbtn" onClick={onRetry} data-testid="picker-retry">تلاش دوباره</button></div></div></div> : null}
        {body}
      </div>
      <div className="df"><span className="hint2">{isQualifier ? 'برچسب کنار هر مشتری نشان می‌دهد کدام فرم باز می‌شود.' : 'بعد از انتخاب، فرم ثبت تماس با همین مشتری باز می‌شود.'}</span><button type="button" className="clx-gbtn" onClick={onClose}>انصراف</button></div>
    </div>
  </>;
}
