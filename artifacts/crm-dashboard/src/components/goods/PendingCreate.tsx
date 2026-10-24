import type { ReactNode } from 'react';
import { CircleAlert, Check, Clock3, Hourglass, Lock, Plus, User, Users } from 'lucide-react';
import { EmptyState, Pagination } from '@/components/DataTools';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { errText, shortFaDate, toman } from '@/lib/goods-api';
import { OLD_WAIT_DAYS, usePendingQueue, waitText, waitTone, type PendingKind, type PendingRow } from '@/lib/pending-create';

const COPY: Record<PendingKind, { ref: string; done: string; action: string; empty: string; emptyHint: string; allLabel: string; banner: string }> = {
  goods: { ref: 'پرونده', done: 'پرونده‌ی تسهیلات تکمیل شد', action: 'شروع خرید کالا', empty: 'همه‌ی پرونده‌های تکمیل‌شده خرید کالا دارند', emptyHint: 'پرونده‌ای که تکمیل شود و خرید کالا نداشته باشد، اینجا می‌آید.', allLabel: 'همه‌ی خریدها', banner: 'شروع خرید کالا' },
  payments: { ref: 'خرید', done: 'خرید کالا تکمیل شد', action: 'ایجاد دستور پرداخت', empty: 'همه‌ی خریدهای تکمیل‌شده دستور پرداخت دارند', emptyHint: 'خریدی که تکمیل شود و دستور پرداخت نداشته باشد، اینجا می‌آید.', allLabel: 'همه‌ی دستورها', banner: 'دستور پرداخت' },
};
const refId = (kind: PendingKind, r: PendingRow) => (kind === 'goods' ? r.applicationId : r.purchaseId) ?? 0;
const rowKey = (kind: PendingKind, r: PendingRow) => `${kind}-${refId(kind, r)}`;

export function WaitChip({ days, testId }: { days: number; testId?: string }) {
  const tone = waitTone(days);
  return <span className={`gp-chip gp-wait ${tone === 'grey' ? 'muted' : tone}`} data-testid={testId} data-wait-tone={tone}>
    {tone === 'red' ? <CircleAlert size={13} /> : <Clock3 size={13} />}{waitText(days)}
  </span>;
}

/** «در انتظار ایجاد»: completed cases/purchases still waiting for a goods purchase / payment order, oldest first. */
export function PendingCreate({ kind, search, page, onPage, onCreate, onShowAll }: {
  kind: PendingKind; search: string; page: number; onPage: (p: number) => void;
  onCreate: (row: PendingRow) => void; onShowAll: () => void;
}) {
  const q = usePendingQueue(kind, search, page, true);
  const c = COPY[kind];
  const data = q.data;
  // Button vs «در صف ثبت‌نام‌کننده» follows the viewer's permission from the server (HANDOFF server 14), not the role name.
  const viewOnly = data ? !data.canCreate : false;
  const rows = data?.items ?? [];
  const tid = `pending-${kind}`;
  const action = (r: PendingRow, mobile = false): ReactNode => viewOnly
    ? <span className="gp-queue-note" title={kind === 'goods' ? 'ساخت خرید کالا با ثبت‌نام‌کننده است' : 'ساخت دستور پرداخت با ثبت‌نام‌کننده است'} data-testid={`note-${tid}-${refId(kind, r)}`}><Hourglass size={14} />در صف ثبت‌نام‌کننده</span>
    : <div className="gp-pend-action">
      <button type="button" className={`btn btn-primary ${mobile ? 'gp-btn-block' : ''}`} disabled={!r.canCreate} onClick={() => onCreate(r)} data-testid={`button-${tid}-${refId(kind, r)}`}>
        {r.canCreate ? <Plus size={16} /> : <Lock size={15} />}{c.action}
      </button>
      {r.blocked && r.unavailableReason ? <small className="gp-pend-reason">{r.unavailableReason}</small> : null}
    </div>;
  const stageCell = (r: PendingRow) => <span className="gp-pend-stage"><span className="gp-chip green sm"><Check size={12} />{c.done}</span><small>{shortFaDate(r.readySince ?? r.completedAt)}</small></span>;
  const sub = (r: PendingRow) => `${c.ref} #${refId(kind, r).toLocaleString('fa-IR')}، ${r.planName}`;
  if (q.isLoading) return <SkeletonPanel rows={5} />;
  if (q.isError) return <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div>;
  if (!data) return null;
  const old = data.old ?? 0;
  return <div className="gp-pending" data-testid={tid}>
    {old > 0 ? <div className="gp-banner red" data-testid={`banner-${tid}-old`}>
      <span className="gp-banner-icon"><CircleAlert size={20} /></span>
      <div><strong>{old.toLocaleString('fa-IR')} مشتری بیش از {OLD_WAIT_DAYS.toLocaleString('fa-IR')} روز منتظر {c.banner} است</strong></div>
      <p className="gp-banner-side">از بالای فهرست شروع کن؛ قدیمی‌ترها اول آمده‌اند.</p>
    </div> : null}
    <div className="gp-pend-meta">
      <span className="gp-pend-scope"><span className={`gp-chip ${viewOnly ? 'blue' : 'muted'}`} data-testid={`scope-${tid}`}>{viewOnly ? <><User size={13} />فقط مشتری‌های خودت</> : <><Users size={13} />همه‌ی کارشناس‌ها</>}</span>
      {!viewOnly && data.blocked > 0 ? <small className="gp-pend-locked" data-testid={`locked-${tid}`}><Lock size={12} />{data.blocked.toLocaleString('fa-IR')} مورد قفل در شمارنده حساب نشده</small> : null}</span>
      <span className="gp-pend-legend" aria-label="راهنمای رنگ انتظار"><small>رنگ انتظار:</small><span className="gp-chip muted sm">۰ تا ۲ روز</span><span className="gp-chip gold sm">۳ تا ۶ روز</span><span className="gp-chip red sm">۷ روز و بیشتر</span></span>
    </div>
    {!rows.length ? <div className="panel gp-pend-empty" data-testid={`empty-${tid}`}>
      <EmptyState title={search.trim() ? 'موردی با این جست‌وجو پیدا نشد' : c.empty} description={search.trim() ? 'نام، موبایل یا شماره را دوباره بررسی کن.' : c.emptyHint} />
      <button type="button" className="btn btn-ghost" onClick={onShowAll} data-testid={`button-${tid}-show-all`}>{c.allLabel}</button>
    </div> : <>
      <div className="panel table-wrap gp-desktop-only"><table className="data-table gp-table gp-pend-table">
        <thead><tr><th>مشتری</th>{viewOnly ? null : <th>کارشناس</th>}<th>مرحله‌ی تمام‌شده</th><th>منتظر</th><th aria-label="عملیات" /></tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(kind, r)} className={`gp-wait-${waitTone(r.waitingDays)}`} data-testid={`row-${tid}-${refId(kind, r)}`}>
          <td><span className="primary-cell">{r.customerName}</span><span className="secondary-cell gp-sub">{sub(r)}</span></td>
          {viewOnly ? null : <td className={r.customerSalespersonName ? '' : 'secondary-cell'}>{r.customerSalespersonName || 'بدون کارشناس'}</td>}
          <td>{stageCell(r)}</td>
          <td><WaitChip days={r.waitingDays} testId={`wait-${tid}-${refId(kind, r)}`} /></td>
          <td className="gp-pend-cta">{action(r)}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="gp-cards-list gp-mobile-only">{rows.map((r) => <div key={rowKey(kind, r)} className={`gp-mcard gp-wait-${waitTone(r.waitingDays)}`} data-testid={`card-${tid}-${refId(kind, r)}`}>
        <div className="gp-mcard-top"><span className="mono">{c.ref} #{refId(kind, r).toLocaleString('fa-IR')}</span><WaitChip days={r.waitingDays} /></div>
        <strong className="gp-pend-name">{r.customerName}</strong>
        <span className="secondary-cell">{r.planName}{viewOnly ? '' : ` · ${r.customerSalespersonName || 'بدون کارشناس'}`}</span>
        <div className="gp-mcard-mid">{stageCell(r)}{kind === 'payments' && r.amountToman ? <span className="gp-money">{toman(r.amountToman)}</span> : null}</div>
        {action(r, true)}
      </div>)}</div>
      {data.total > data.limit ? <Pagination total={data.total} offset={(page - 1) * data.limit} limit={data.limit} onChange={(o) => onPage(Math.floor(o / data.limit) + 1)} testId={`pagination-${tid}`} /> : null}
    </>}
  </div>;
}
