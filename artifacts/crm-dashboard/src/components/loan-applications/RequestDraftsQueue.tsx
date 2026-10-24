// «در انتظار ثبت» queue (HANDOFF §6/§7). Server decides scope (salesperson → own) and canDelete (admin, unpaid only).
import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, BadgeCheck, CalendarClock, ChevronLeft, Clock, Hourglass, Trash2, Wallet } from 'lucide-react';
import { ConfirmDialog, jalaliDate } from '@/pages/customers-ui';
import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { DELETE_REASONS, DRAFTS_KEY, DraftHttpError, draftsApi, draftWait, fa, faToman, tehranTime, useDraftList, type LegacyCaseRow, type OrphanFeeRow, type RequestDraft } from '@/lib/request-drafts';
import './request-drafts.css';

const NOT_DELETABLE = 'پیش‌نویس پرداخت‌دار حذف‌شدنی نیست';

function StepBar({ d }: { d: RequestDraft }) {
  return <div className="rqd-step">
    <b>مرحله {fa(d.step)} از {fa(d.totalSteps)}</b>
    <span className="bar" aria-hidden="true">{Array.from({ length: d.totalSteps }, (_, i) => <i key={i} className={i < d.step - 1 ? 'done' : i === d.step - 1 ? 'cur' : ''} />)}</span>
    <span className="muted">{d.stepLabel}</span>
  </div>;
}
function Flags({ d }: { d: RequestDraft }) {
  return <>
    {!d.creditFresh && d.step > 4 ? <span className="rqd-flag gold"><AlertTriangle size={14} aria-hidden="true" /> استعلام اعتبار باید تازه شود</span> : null}
    {d.expiringSoon && d.daysUntilAutoDelete !== null ? <span className="rqd-flag red" data-testid={`draft-expiring-${d.id}`}><CalendarClock size={14} aria-hidden="true" /> {d.daysUntilAutoDelete <= 0 ? 'امروز خودکار پاک می‌شود' : `${fa(d.daysUntilAutoDelete)} روز دیگر خودکار پاک می‌شود`}</span> : null}
  </>;
}
function Fee({ d }: { d: RequestDraft }) {
  return d.paid ? <div className="rqd-fee"><span className="rqd-paid"><BadgeCheck size={15} aria-hidden="true" /> هزینه‌ی پرونده واریز شده</span><span className="muted">{jalaliDate(d.feePaidAt)} {tehranTime(d.feePaidAt)}</span></div>
    : <span className="muted">واریز نشده</span>;
}
function Wait({ d }: { d: RequestDraft }) {
  const w = draftWait(d.waitingHours);
  return <div className="rqd-wait"><span className={`rqd-pill ${w.tone}`}><Clock size={14} aria-hidden="true" /> {w.text}</span><span className="muted">ذخیره {jalaliDate(d.updatedAt)}، {tehranTime(d.updatedAt)}</span></div>;
}

const ORPHAN_LABEL = 'هزینه‌ی واریزشده بدون پرونده';
const LEGACY_LABEL = 'پیش‌ثبت‌نام قدیمی';
const LEGACY_STATUS: Record<string, string> = { requested: 'درخواست‌شده', rejected: 'ردشده', approved: 'تأییدشده', cancelled: 'لغوشده' };
function WaitPill({ hours, at, verb }: { hours: number; at: string; verb: string }) {
  const w = draftWait(hours);
  return <div className="rqd-wait"><span className={`rqd-pill ${w.tone}`}><Clock size={14} aria-hidden="true" /> {w.text}</span><span className="muted">{verb} {jalaliDate(at)}، {tehranTime(at)}</span></div>;
}
function RoName({ name, id, phone, testId }: { name: string | null; id: number; phone: string | null; testId: string }) {
  return <div className="rqd-name"><b>{name ?? '—'}</b> <CustomerIdBadge id={id} testId={testId} />{phone ? <div className="muted" dir="ltr">{phone}</div> : null}</div>;
}
/** Admin only (server sends [] to everyone else). Read-only: no continue / delete. */
function OrphanFees({ rows, isDesktop }: { rows: OrphanFeeRow[]; isDesktop: boolean }) {
  if (!rows.length) return null;
  return <section className="rqd-ro" aria-labelledby="rqd-orphan-h" data-testid="orphan-fees-section">
    <header><Wallet size={18} aria-hidden="true" /><div><h3 id="rqd-orphan-h">{ORPHAN_LABEL} <span className="rqd-ro-count">{fa(rows.length)}</span></h3>
      <p className="muted">فقط برای مدیر. این‌ها درخواست نیستند و از این فهرست تغییری داده نمی‌شود؛ فقط نمایش است.</p></div></header>
    {isDesktop ? <table className="csx-table rqd-table rqd-ro-table" data-testid="orphan-fees-table">
      <thead><tr><th>مشتری</th><th>مبلغ واریزی</th><th>طرح</th><th>واریز از</th><th>کارشناس</th><th>منتظر</th></tr></thead>
      <tbody>{rows.map((o) => <tr key={o.chargeId} data-testid={`orphan-fee-row-${o.chargeId}`}>
        <td><RoName name={o.customerName} id={o.customerId} phone={o.customerPhone} testId={`orphan-fee-customer-id-${o.chargeId}`} /><span className="rqd-ro-tag">{ORPHAN_LABEL}</span></td>
        <td><b>{faToman(o.amountToman)}</b><div className="muted">شماره‌ی واریز {fa(o.chargeId)}</div></td>
        <td>{o.planName ?? '—'}</td><td>{o.byCustomer ? 'پرتال مشتری' : 'کارشناس'}</td>
        <td>{o.salespersonName ?? '—'}</td><td><WaitPill hours={o.waitingHours} at={o.paidAt} verb="واریز" /></td>
      </tr>)}</tbody></table>
      : <div className="csx-list rqd-cards">{rows.map((o) => <article key={o.chargeId} className="csx-card rqd-card rqd-ro-card" data-testid={`orphan-fee-card-${o.chargeId}`}>
        <div className="top"><RoName name={o.customerName} id={o.customerId} phone={o.customerPhone} testId={`orphan-fee-customer-id-${o.chargeId}`} /><WaitPill hours={o.waitingHours} at={o.paidAt} verb="واریز" /></div>
        <span className="rqd-ro-tag">{ORPHAN_LABEL}</span>
        <div><b>{faToman(o.amountToman)}</b> <span className="muted">· {o.planName ?? '—'} · {o.byCustomer ? 'پرتال مشتری' : 'کارشناس'}</span></div>
        {o.salespersonName ? <div className="muted">کارشناس: {o.salespersonName}</div> : null}
      </article>)}</div>}
  </section>;
}
/** Pre-registration cases left at stage «پیش‌نویس» (not in the case list). Nothing is edited here; «ادامه» opens the case
 *  itself (next step: primary contract) — its paid fee is already linked, so continuing never charges again. */
function LegacyCases({ rows, isDesktop, showSp }: { rows: LegacyCaseRow[]; isDesktop: boolean; showSp: boolean }) {
  if (!rows.length) return null;
  const st = (s: string) => LEGACY_STATUS[s] ?? s;
  return <section className="rqd-ro" aria-labelledby="rqd-legacy-h" data-testid="legacy-cases-section">
    <header><Archive size={18} aria-hidden="true" /><div><h3 id="rqd-legacy-h">{LEGACY_LABEL}‌ها با وضعیت پیش‌نویس <span className="rqd-ro-count">{fa(rows.length)}</span></h3>
      <p className="muted">این پرونده‌ها ثبت شده‌اند اما در مرحله‌ی پیش‌نویس مانده‌اند و در فهرست پرونده‌ها دیده نمی‌شوند. «ادامه» خود پرونده را باز می‌کند (مرحله‌ی بعد: قرارداد اولیه)؛ هزینه‌ی واریزشده دوباره کسر نمی‌شود.</p></div></header>
    {isDesktop ? <table className="csx-table rqd-table rqd-ro-table" data-testid="legacy-cases-table">
      <thead><tr><th>مشتری</th><th>پرونده</th><th>طرح و مبلغ</th>{showSp ? <th>کارشناس</th> : null}<th>منتظر</th><th><span className="sr-only">عملیات</span></th></tr></thead>
      <tbody>{rows.map((a) => <tr key={a.applicationId} data-testid={`legacy-case-row-${a.applicationId}`}>
        <td><RoName name={a.customerName} id={a.customerId} phone={a.customerPhone} testId={`legacy-case-customer-id-${a.applicationId}`} /></td>
        <td><span className="rqd-ro-tag">{LEGACY_LABEL}</span><div>پرونده‌ی {fa(a.applicationId)} · {st(a.status)}</div><div className="muted">ایجاد {jalaliDate(a.createdAt)}</div></td>
        <td>{a.planName ?? '—'}<div className="muted">{faToman(a.requestedAmount)}{a.durationMonths ? ` · ${fa(a.durationMonths)} ماه` : ''}</div></td>
        {showSp ? <td>{a.salespersonName ?? '—'}</td> : null}<td><WaitPill hours={a.waitingHours} at={a.updatedAt} verb="آخرین تغییر" /></td>
        <td><Link href={`/loan-applications/${a.applicationId}`} className="csx-ghost sm" data-testid={`legacy-case-continue-${a.applicationId}`}>ادامه</Link></td>
      </tr>)}</tbody></table>
      : <div className="csx-list rqd-cards">{rows.map((a) => <article key={a.applicationId} className="csx-card rqd-card rqd-ro-card" data-testid={`legacy-case-card-${a.applicationId}`}>
        <div className="top"><RoName name={a.customerName} id={a.customerId} phone={a.customerPhone} testId={`legacy-case-customer-id-${a.applicationId}`} /><WaitPill hours={a.waitingHours} at={a.updatedAt} verb="آخرین تغییر" /></div>
        <div><span className="rqd-ro-tag">{LEGACY_LABEL}</span> پرونده‌ی {fa(a.applicationId)} · {st(a.status)}</div>
        <div className="muted">{a.planName ?? '—'} · {faToman(a.requestedAmount)}</div>
        {showSp && a.salespersonName ? <div className="muted">کارشناس: {a.salespersonName}</div> : null}
        <div className="acts"><Link href={`/loan-applications/${a.applicationId}`} className="csx-ghost sm" data-testid={`legacy-case-continue-${a.applicationId}`}>ادامه از پرونده</Link></div>
      </article>)}</div>}
  </section>;
}

export function RequestDraftsQueue({ isDesktop, isAdmin, onOpen }: { isDesktop: boolean; isAdmin: boolean; onOpen: (d: RequestDraft) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const { data, isLoading, error, refetch } = useDraftList(true, scope, search);
  const [toDelete, setToDelete] = useState<RequestDraft | null>(null);
  const [chip, setChip] = useState('');
  const [reason, setReason] = useState('');
  const [delErr, setDelErr] = useState('');
  const [deleting, setDeleting] = useState(false);
  const items = data?.items ?? [];
  const orphans = data?.orphanFees ?? [];
  const legacy = data?.legacyCases ?? [];
  const extras = orphans.length + legacy.length;
  const showSp = Boolean(data?.seesAll) && scope === 'all';
  const late = items.filter((d) => d.paidOver24h);
  const fullReason = [chip, reason.trim()].filter(Boolean).join(' — ');

  const doDelete = async () => {
    if (!toDelete) return;
    if (fullReason.length < 3) { setDelErr('دلیل حذف را انتخاب یا وارد کن.'); return; }
    setDeleting(true); setDelErr('');
    try {
      await draftsApi.remove(toDelete.id, fullReason);
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: DRAFTS_KEY });
    } catch (e) {
      setDelErr(e instanceof DraftHttpError && e.code === 'PAID_DRAFT_NOT_DELETABLE' ? NOT_DELETABLE : e instanceof DraftHttpError && e.offline ? 'اتصال قطع است؛ دوباره تلاش کن.' : 'حذف انجام نشد.');
    } finally { setDeleting(false); }
  };
  const openDelete = (d: RequestDraft) => { setChip(''); setReason(''); setDelErr(''); setToDelete(d); };
  const delBtn = (d: RequestDraft) => !isAdmin ? null : d.canDelete
    ? <button type="button" className="csx-ib" aria-label={`حذف درخواست ${d.customerName ?? ''}`} onClick={() => openDelete(d)} data-testid={`button-delete-draft-${d.id}`}><Trash2 size={18} /></button>
    : <span className="rqd-tip" data-tip={NOT_DELETABLE}><button type="button" className="csx-ib" disabled aria-disabled="true" aria-label={NOT_DELETABLE} title={NOT_DELETABLE} data-testid={`button-delete-draft-${d.id}`}><Trash2 size={18} /></button></span>;
  const cont = (d: RequestDraft) => d.canContinue
    ? <button type="button" className="csx-primary sm" onClick={() => onOpen(d)} data-testid={`button-continue-draft-${d.id}`}>ادامه <ChevronLeft size={16} aria-hidden="true" /></button> : null;
  const name = (d: RequestDraft) => <div className="rqd-name">
    <b>{d.customerName ?? '—'}</b> <CustomerIdBadge id={d.customerId} testId={`draft-customer-id-${d.id}`} />
    {d.source === 'portal' ? <span className="rqd-portal">از پرتال</span> : null}
    {d.customerPhone ? <div className="muted" dir="ltr">{d.customerPhone}</div> : null}
  </div>;

  return <div className="rqd" data-testid="request-drafts-queue">
    <div className="csx-tools rqd-tools">
      <label className="csx-search"><input type="search" placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-draft-search" /></label>
      {data?.seesAll ? <div className="csx-viewseg" role="group" aria-label="دامنه">
        <button type="button" className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>همه کارشناس‌ها</button>
        <button type="button" className={scope === 'mine' ? 'active' : ''} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>فقط من</button>
      </div> : null}
      <span className="grow" />
      <span className="muted d-only">{data ? `${fa(data.total)} مورد · ترتیب: اول واریزشده‌ها، بعد قدیمی‌ترها` : ''}</span>
    </div>
    {late.length ? <div className="rqd-banner" role="alert" data-testid="drafts-paid-over-24h">
      <AlertTriangle size={22} aria-hidden="true" />
      <div><b>{fa(late.length)} مشتری هزینه‌ی پرونده را داده ولی درخواستش بیش از ۲۴ ساعت است ثبت نشده</b>
        <p>پول این مشتری‌ها گرفته شده؛ این‌ها بالای فهرست‌اند. با «ادامه» ثبت را تمام کن.</p></div>
    </div> : null}
    {isLoading ? <div className="csx-list csx-skcards" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="csx-skcard"><span className="csx-sk" style={{ height: 22, width: '45%' }} /><span className="csx-sk" style={{ height: 48 }} /></div>)}</div>
      : error ? <div className="csx-note bad" role="alert"><p>دریافت فهرست انجام نشد. <button type="button" className="csx-link" onClick={() => refetch()}>تلاش دوباره</button></p></div>
      : !items.length && extras ? <p className="muted rqd-none" data-testid="drafts-empty">{search.trim() ? 'درخواست نیمه‌کاره‌ای با این جست‌وجو پیدا نشد.' : 'درخواست نیمه‌کاره‌ای نیست.'}</p>
      : !items.length ? <div className="csx-empty rqd-empty" data-testid="drafts-empty"><Hourglass size={40} aria-hidden="true" />
        <h2>{search.trim() ? 'موردی پیدا نشد' : 'درخواست نیمه‌کاره‌ای نیست'}</h2>
        <p>{search.trim() ? 'جست‌وجو را تغییر بده.' : 'هر درخواستی که شروع شود و هنوز ثبت نشده باشد، این‌جا می‌ماند تا از همان مرحله ادامه داده شود.'}</p></div>
      : isDesktop ? <table className="csx-table rqd-table" data-testid="drafts-table">
        <thead><tr><th>مشتری</th><th>مانده در</th><th>هزینه‌ی پرونده</th>{showSp ? <th>کارشناس</th> : null}<th>منتظر</th><th><span className="sr-only">اقدام</span></th></tr></thead>
        <tbody>{items.map((d) => <tr key={d.id} className={draftWait(d.waitingHours).tone === 'red' ? 'late' : ''} data-testid={`draft-row-${d.id}`}>
          <td>{name(d)}</td><td><StepBar d={d} /><Flags d={d} /></td><td><Fee d={d} /></td>
          {showSp ? <td>{d.salespersonName ?? '—'}</td> : null}<td><Wait d={d} /></td>
          <td><div className="rqd-acts">{cont(d)}{delBtn(d)}</div></td>
        </tr>)}</tbody></table>
      : <div className="csx-list rqd-cards">{items.map((d) => <article key={d.id} className={`csx-card rqd-card${draftWait(d.waitingHours).tone === 'red' ? ' late' : ''}`} data-testid={`draft-card-${d.id}`}>
          <div className="top">{name(d)}<Wait d={d} /></div>
          <StepBar d={d} /><Flags d={d} /><Fee d={d} />
          {showSp && d.salespersonName ? <div className="muted">کارشناس: {d.salespersonName}</div> : null}
          <div className="rqd-acts">{cont(d)}{isAdmin && d.canDelete ? delBtn(d) : null}</div>
          {isAdmin && !d.canDelete ? <p className="rqd-nodel">{NOT_DELETABLE}</p> : null}
        </article>)}</div>}
    {!isLoading && !error ? <><OrphanFees rows={orphans} isDesktop={isDesktop} /><LegacyCases rows={legacy} isDesktop={isDesktop} showSp={showSp} /></> : null}

    {toDelete ? <ConfirmDialog title="حذف درخواست نیمه‌کاره؟" confirmLabel="حذف درخواست" pendingLabel="در حال حذف…" pending={deleting} error={delErr || undefined}
      onClose={() => setToDelete(null)} onConfirm={doDelete} testId="delete-request-draft-dialog">
      <p>درخواست {toDelete.customerName ?? ''} <CustomerIdBadge id={toDelete.customerId} /> حذف می‌شود. هزینه‌ای واریز نشده است. حذف با دلیل در تاریخچه‌ی مشتری ثبت می‌شود.</p>
      <div className="rqd-chips" role="group" aria-label="دلیل حذف">{DELETE_REASONS.map((r) => <button key={r} type="button" className="csx-chip" aria-pressed={chip === r} onClick={() => { setChip(chip === r ? '' : r); setDelErr(''); }}>{r}</button>)}</div>
      <label className="rqd-reason">توضیح (اختیاری اگر دلیلی انتخاب شده)<textarea rows={2} maxLength={400} value={reason} onChange={(e) => { setReason(e.target.value); setDelErr(''); }} data-testid="input-draft-delete-reason" /></label>
    </ConfirmDialog> : null}
  </div>;
}
