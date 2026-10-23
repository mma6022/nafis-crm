import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Clock, PhoneCall, PhoneIncoming, PhoneMissed, UserPlus, Ban, RotateCcw, Play, Check } from 'lucide-react';
import { ErrorState, SkeletonPanel, formatDateTime } from '@/components/CrmShell';
import { EmptyState, Modal } from '@/components/DataTools';
import { Stepper, WizardActions, type WizardStep } from '@/components/wizard/Wizard';
import { errText, useMe } from '@/lib/goods-api';
import {
  CALLBACK_STATUS_FA, CALLBACK_TRANSITIONS, PREFERRED_TIME_FA, TOPIC_FA, callbacksApi,
  type CallbackItem, type CallbackStatus,
} from '@/lib/callbacks-api';
import './callback-requests.css';

const fa = (n: number) => n.toLocaleString('fa-IR');
const faPhone = (p: string) => p.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

const STATUS_ACTION: Record<CallbackStatus, { label: string; icon: typeof Play; tone: string }> = {
  in_progress: { label: 'شروع پیگیری', icon: Play, tone: 'nf-btn-ghost' },
  called: { label: 'تماس گرفته شد', icon: Check, tone: 'nf-btn-primary' },
  no_answer: { label: 'پاسخ نداد', icon: PhoneMissed, tone: 'nf-btn-ghost' },
  cancelled: { label: 'لغو', icon: Ban, tone: 'nf-btn-ghost cb-danger' },
  new: { label: 'جدید', icon: RotateCcw, tone: 'nf-btn-ghost' },
};

export default function CallbackRequests() {
  const [view, setView] = useState<'open' | 'closed'>('open');
  const [converting, setConverting] = useState<CallbackItem | null>(null);
  const { user, can } = useMe();
  const canManage = can('callbacks.manage');
  const canAssign = canManage && (user?.role === 'admin' || (user as { customerScope?: string } | undefined)?.customerScope !== 'assigned');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['callbacks', view], queryFn: () => callbacksApi.list(view), refetchInterval: 20_000 });
  const assignees = useQuery({ queryKey: ['callbacks', 'assignees'], queryFn: callbacksApi.assignees, enabled: canAssign, staleTime: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['callbacks'] });
  const counts = list.data?.counts;

  return (
    <div className="cb-page" data-testid="page-callback-requests">
      <div className="page-intro">
        <div><div className="eyebrow">سرنخ‌های سایت</div><h2>درخواست‌های تماس</h2><p>«همین الان» اول، بعد قدیمی‌ترین درخواست. روی شماره بزنید تا تماس گرفته شود.</p></div>
        <div className="data-summary"><PhoneIncoming size={17} /><span>جدید</span><strong data-testid="text-callbacks-new">{fa(counts?.new ?? 0)}</strong></div>
      </div>
      <div className="cb-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'open'} className={view === 'open' ? 'is-on' : ''} onClick={() => setView('open')} data-testid="tab-callbacks-open">باز <b>{fa(counts?.open ?? 0)}</b></button>
        <button role="tab" aria-selected={view === 'closed'} className={view === 'closed' ? 'is-on' : ''} onClick={() => setView('closed')} data-testid="tab-callbacks-closed">بسته‌شده <b>{fa(counts?.closed ?? 0)}</b></button>
      </div>
      {list.isLoading ? <SkeletonPanel rows={4} /> : list.isError ? <ErrorState onRetry={() => list.refetch()} /> : !list.data?.items.length
        ? <EmptyState title={view === 'open' ? 'درخواست بازی نیست' : 'هنوز درخواستی بسته نشده'} description="درخواست‌های «تماس کارشناس» سایت اینجا می‌آیند." />
        : <ul className="cb-list">{list.data.items.map(item => (
          <CallbackCard key={item.id} item={item} canManage={canManage} canAssign={canAssign} assignees={assignees.data?.items ?? []} onChanged={refresh} onConvert={() => setConverting(item)} />
        ))}</ul>}
      {converting && <ConvertWizard item={converting} onClose={() => setConverting(null)} onDone={() => { setConverting(null); refresh(); }} />}
    </div>
  );
}

function CallbackCard({ item, canManage, canAssign, assignees, onChanged, onConvert }: {
  item: CallbackItem; canManage: boolean; canAssign: boolean; assignees: { id: number; name: string }[]; onChanged: () => void; onConvert: () => void;
}) {
  const [notes, setNotes] = useState(item.notes ?? '');
  const [error, setError] = useState('');
  useEffect(() => setNotes(item.notes ?? ''), [item.notes]);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setError(''); onChanged(); },
    onError: (e) => setError(errText(e)),
  });
  const next = CALLBACK_TRANSITIONS[item.status];
  const urgent = item.preferredTime === 'now' && item.status !== 'called' && item.status !== 'cancelled';
  return (
    <li className={`cb-card${urgent ? ' is-urgent' : ''}`} data-testid={`card-callback-${item.id}`}>
      <div className="cb-head">
        <div className="cb-who">
          <strong>{item.name}</strong>
          <a className="cb-tel" href={`tel:${item.phone}`} dir="ltr" data-testid={`link-tel-${item.id}`}><PhoneCall size={18} /> {faPhone(item.phone)}</a>
        </div>
        <span className={`cb-status is-${item.status}`} data-testid={`status-callback-${item.id}`}>{CALLBACK_STATUS_FA[item.status]}{item.attempts > 0 ? ` (${fa(item.attempts)} تلاش بی‌پاسخ)` : ''}</span>
      </div>
      <dl className="cb-meta">
        <div><dt><Clock size={15} /> زمان تماس</dt><dd className={urgent ? 'cb-now' : ''}>{PREFERRED_TIME_FA[item.preferredTime]}</dd></div>
        <div><dt>موضوع</dt><dd>{item.topic ? TOPIC_FA[item.topic] : '—'}</dd></div>
        <div><dt>ثبت</dt><dd>{formatDateTime(item.createdAt)}</dd></div>
        {item.lastAttemptAt && <div><dt>آخرین تلاش</dt><dd>{formatDateTime(item.lastAttemptAt)}</dd></div>}
        {item.trackingCode && <div><dt>کد پیگیری</dt><dd dir="ltr">{item.trackingCode}</dd></div>}
        {item.customerId && <div><dt>مشتری</dt><dd><Link href={`/customers/${item.customerId}`}>{item.customerName ?? `#${item.customerId}`}</Link></dd></div>}
      </dl>
      {canManage && <>
        <div className="cb-actions">
          {next.map(status => {
            const a = STATUS_ACTION[status];
            const label = status === 'in_progress' && item.status !== 'new' ? 'بازگشایی / پیگیری' : status === 'no_answer' && item.status === 'no_answer' ? 'دوباره پاسخ نداد' : a.label;
            return <button key={status} type="button" className={`nf-btn ${a.tone}`} disabled={run.isPending} onClick={() => run.mutate(() => callbacksApi.status(item.id, status))} data-testid={`button-status-${status}-${item.id}`}><a.icon size={18} /> {label}</button>;
          })}
          {!item.convertedAt && item.status !== 'cancelled' && <button type="button" className="nf-btn nf-btn-ghost" onClick={onConvert} data-testid={`button-convert-${item.id}`}><UserPlus size={18} /> تبدیل به سرنخ</button>}
        </div>
        <div className="cb-edit">
          {canAssign
            ? <label>کارشناس مسئول
              <select value={item.assignedUserId ?? ''} disabled={run.isPending} onChange={e => run.mutate(() => callbacksApi.assign(item.id, e.target.value ? Number(e.target.value) : null))} data-testid={`select-assign-${item.id}`}>
                <option value="">— تخصیص‌نیافته —</option>
                {assignees.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></label>
            : <div className="cb-assignee">کارشناس: <b>{item.assignedUserName ?? '—'}</b></div>}
          <label>یادداشت
            <textarea rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} data-testid={`input-notes-${item.id}`} />
          </label>
          {notes.trim() !== (item.notes ?? '') && <button type="button" className="nf-btn nf-btn-ghost" disabled={run.isPending} onClick={() => run.mutate(() => callbacksApi.notes(item.id, notes))} data-testid={`button-save-notes-${item.id}`}>ذخیره یادداشت</button>}
        </div>
      </>}
      {!canManage && item.notes && <p className="cb-notes">{item.notes}</p>}
      {error && <p className="cb-error" role="alert">{error}</p>}
    </li>
  );
}

const CONVERT_STEPS: readonly WizardStep<'review' | 'confirm'>[] = [{ key: 'review', title: 'بررسی' }, { key: 'confirm', title: 'تأیید' }];

function ConvertWizard({ item, onClose, onDone }: { item: CallbackItem; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'review' | 'confirm'>('review');
  const [error, setError] = useState('');
  const convert = useMutation({ mutationFn: () => callbacksApi.convert(item.id), onSuccess: onDone, onError: e => setError(errText(e)) });
  return (
    <Modal title="تبدیل به سرنخ" eyebrow={item.name} onClose={onClose} testId="convert-callback">
      <form className="cb-wizard" onSubmit={e => { e.preventDefault(); if (step === 'review') setStep('confirm'); else convert.mutate(); }}>
        <Stepper<"review" | "confirm"> steps={CONVERT_STEPS} current={step} onGo={k => setStep(k)} />
        {step === 'review' ? <dl className="cb-meta">
          <div><dt>نام</dt><dd>{item.name}</dd></div>
          <div><dt>موبایل</dt><dd dir="ltr">{faPhone(item.phone)}</dd></div>
          <div><dt>موضوع</dt><dd>{item.topic ? TOPIC_FA[item.topic] : '—'}</dd></div>
          <div><dt>کارشناس</dt><dd>{item.assignedUserName ?? 'طبق برنامه تخصیص'}</dd></div>
        </dl> : <p className="cb-confirm">
          {item.customerId
            ? <>این شماره قبلاً مشتری «{item.customerName}» است. درخواست به همان پرونده وصل می‌شود و برچسب «سرنخ سایت» می‌گیرد؛ اطلاعات مشتری تغییر نمی‌کند.</>
            : <>یک مشتری جدید (تأییدنشده) با برچسب «سرنخ سایت» ساخته می‌شود و یادداشت‌ها در توضیحات پرونده می‌آید. درخواست تسهیلات خودکار ساخته نمی‌شود.</>}
        </p>}
        {error && <p className="cb-error" role="alert">{error}</p>}
        <WizardActions onBack={step === 'confirm' ? () => setStep('review') : undefined} nextLabel={step === 'review' ? 'ادامه' : 'تبدیل'} pending={convert.isPending} testPrefix="convert-callback" />
      </form>
    </Modal>
  );
}
