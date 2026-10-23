import { AlertTriangle, ArrowLeftRight, CheckCircle2, RefreshCw, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetCustomerQueryKey,
  getListCallsQueryKey,
  getListConsultationsQueryKey,
  getListCustomerActivityQueryKey,
  getListCustomerCreditChecksQueryKey,
  getListCustomerIdentityDocumentsQueryKey,
  getListCustomersQueryKey,
  getListDuplicateCustomersQueryKey,
  getListLoanApplicationsQueryKey,
  getListRemindersQueryKey,
  useListDuplicateCustomers,
  useMergeCustomers,
  type DuplicateCustomerCandidate,
  type DuplicateCustomerGroup,
  type CustomerMergeResult,
  type Salesperson,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatPhoneForDisplay } from '@/lib/phone';
import './DuplicateCustomerReview.css';

const historyLabels: Record<keyof DuplicateCustomerCandidate['historyCounts'], string> = {
  calls: 'تماس',
  reminders: 'یادآوری',
  consultations: 'مشاوره',
  loanApplications: 'درخواست وام',
  identityDocuments: 'مدرک هویتی',
  creditChecks: 'اعتبارسنجی',
};

const formatCount = (value: number) => value.toLocaleString('fa-IR');
const groupKey = (group: DuplicateCustomerGroup) => `${group.matchType}:${group.normalizedValue}`;

export function DuplicateCustomerReview({ onClose, salespersons, salespersonLoading, salespersonError, onRetrySalespersons }: {
  onClose: () => void;
  salespersons: Salesperson[];
  salespersonLoading: boolean;
  salespersonError: boolean;
  onRetrySalespersons: () => void;
}) {
  const queryClient = useQueryClient();
  const duplicates = useListDuplicateCustomers({ query: { queryKey: getListDuplicateCustomersQueryKey(), refetchOnMount: 'always' } });
  const merge = useMergeCustomers();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [salespersonId, setSalespersonId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [success, setSuccess] = useState<CustomerMergeResult | null>(null);
  const [submitError, setSubmitError] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const pendingRef = useRef(merge.isPending);
  onCloseRef.current = onClose;
  pendingRef.current = merge.isPending;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.querySelector<HTMLButtonElement>('[data-testid="button-close-duplicate-customers"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) onCloseRef.current();
      if (event.key === 'Tab') {
        const dialog = document.querySelector<HTMLElement>('[data-testid="modal-duplicate-customers"]');
        const focusable = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus();
    };
  }, []);

  const groups = (duplicates.data ?? []).filter((entry) => !success || !entry.candidates.some((candidate) => candidate.id === success.archivedSourceCustomerId));
  const group = groups.find((entry) => groupKey(entry) === selectedKey) ?? groups[0];
  const candidates = group?.candidates ?? [];
  const survivor = candidates.find((candidate) => candidate.id === targetId) ?? candidates[0];
  const source = candidates.find((candidate) => candidate.id === sourceId && candidate.id !== survivor?.id) ?? candidates.find((candidate) => candidate.id !== survivor?.id);
  const assignedPerson = salespersons.find((person) => person.id === Number(salespersonId));

  const changeGroup = (key: string) => {
    setSelectedKey(key);
    setTargetId(null);
    setSourceId(null);
    setSalespersonId('');
    setConfirming(false);
    setAcknowledged(false);
    setSubmitError(false);
    setSuccess(null);
    merge.reset();
  };

  const invalidateMergeData = (result: CustomerMergeResult) => {
    const ids = [result.survivorCustomerId, result.archivedSourceCustomerId];
    const keys = [
      getListDuplicateCustomersQueryKey(),
      getListCustomersQueryKey(),
      getListCallsQueryKey(),
      getListConsultationsQueryKey(),
      getListRemindersQueryKey(),
      getListLoanApplicationsQueryKey(),
      ['board-customers'],
      ['calls-customers'],
      ...ids.flatMap((id) => [
        getGetCustomerQueryKey(id),
        getListCustomerActivityQueryKey(id),
        getListCustomerCreditChecksQueryKey(id),
        getListCustomerIdentityDocumentsQueryKey(id),
      ]),
    ];
    keys.forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
  };

  const submit = async () => {
    if (!survivor || !source || survivor.id === source.id || !assignedPerson || !acknowledged || merge.isPending) return;
    setSubmitError(false);
    try {
      const result = await merge.mutateAsync({
        data: { targetCustomerId: survivor.id, sourceCustomerId: source.id, salespersonId: assignedPerson.id },
      });
      setSuccess(result);
      setConfirming(false);
      setAcknowledged(false);
      setSelectedKey(null);
      setTargetId(null);
      setSourceId(null);
      setSalespersonId('');
      invalidateMergeData(result);
    } catch {
      setSubmitError(true);
    }
  };

  return (
    <Modal title="ادغام مشتریان تکراری" eyebrow="بازبینی پرونده‌ها · ویژه مدیر" onClose={() => { if (!merge.isPending) onClose(); }} testId="duplicate-customers" wide>
      <div className="duplicate-review" dir="rtl">
        <div className="duplicate-review-intro">
          <div>
            <strong>هر پرونده را پیش از ادغام بررسی کنید</strong>
            <p>یک مشتری برای ادامه انتخاب می‌شود؛ پروندهٔ دیگر بایگانی خواهد شد. هیچ سابقهٔ مالی حذف یا بازنویسی نمی‌شود.</p>
          </div>
          {!duplicates.isLoading && !duplicates.isError && <div className="duplicate-review-stat" data-testid="text-duplicate-group-count"><strong>{formatCount(groups.length)}</strong><span>گروه مشابه</span></div>}
        </div>

        {success && (
          <div className="duplicate-review-message is-success" role="status" data-testid="status-merge-success">
            <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6 }} />
            ادغام انجام شد. پروندهٔ #{formatCount(success.survivorCustomerId)} باقی ماند و پروندهٔ #{formatCount(success.archivedSourceCustomerId)} بایگانی شد.
            {Object.keys(success.reparentedHistoryCounts).length > 0 && <div>سوابق منتقل‌شده: {Object.entries(success.reparentedHistoryCounts).map(([key, count]) => `${historyLabels[key as keyof typeof historyLabels] ?? key}: ${formatCount(count)}`).join(' · ')}</div>}
            <div>اسناد مالی محفوظ مانده‌اند و انتساب تاریخی آن‌ها تغییر نکرده است.</div>
            <Link href={`/customers/${success.survivorCustomerId}`} onClick={onClose} data-testid="link-merged-survivor">مشاهدهٔ پروندهٔ باقی‌مانده</Link>
          </div>
        )}

        {duplicates.isLoading ? <div role="status" aria-label="در حال بارگذاری موارد تکراری"><div className="duplicate-review-skeleton" /><div className="duplicate-review-skeleton" /><div className="duplicate-review-skeleton" /></div>
          : duplicates.isError ? <div className="duplicate-review-state" role="alert" data-testid="status-duplicate-error"><AlertTriangle size={30} /><strong>دریافت مشتریان تکراری انجام نشد</strong><p>اتصال را بررسی کنید و دوباره تلاش کنید.</p><button type="button" className="btn btn-ghost" onClick={() => void duplicates.refetch()} data-testid="button-retry-duplicates"><RefreshCw size={14} /> تلاش دوباره</button></div>
            : !groups.length ? <div className="duplicate-review-state" data-testid="status-duplicate-empty"><UsersRound size={34} /><strong>مورد تکراری برای بررسی نیست</strong><p>هیچ پروندهٔ فعالی با شمارهٔ موبایل یا کد ملی یکسان پیدا نشد.</p><button type="button" className="btn btn-ghost" onClick={() => void duplicates.refetch()} data-testid="button-refresh-duplicates"><RefreshCw size={14} /> بررسی دوباره</button></div>
              : <div className="duplicate-review-workspace">
                <aside className="duplicate-review-groups" aria-label="گروه‌های مشتریان تکراری">
                  <h4>موارد نیازمند بررسی</h4>
                  <div className="duplicate-review-group-list">
                    {groups.map((entry) => (
                      <button key={groupKey(entry)} type="button" className={`duplicate-review-group ${groupKey(entry) === groupKey(group) ? 'is-active' : ''}`} aria-current={groupKey(entry) === groupKey(group) ? 'true' : undefined} onClick={() => changeGroup(groupKey(entry))} data-testid={`button-duplicate-group-${groupKey(entry)}`}>
                        <small>{entry.matchType === 'mobile' ? 'شمارهٔ موبایل مشترک' : 'کد ملی مشترک'}</small>
                        <strong dir="ltr"><bdi>{entry.matchType === 'mobile' ? formatPhoneForDisplay(entry.normalizedValue) : entry.normalizedValue}</bdi></strong>
                        <em>{formatCount(entry.candidates.length)} پرونده</em>
                      </button>
                    ))}
                  </div>
                </aside>
                <div className="duplicate-review-detail">
                  <div className="duplicate-review-heading">
                    <div><h4>انتخاب پروندهٔ اصلی</h4><p>مشخص کنید کدام نام و شناسه باقی می‌ماند و کدام پرونده بایگانی می‌شود.</p></div>
                    <span className="duplicate-review-match">{group.matchType === 'mobile' ? 'تطابق موبایل' : 'تطابق کد ملی'}</span>
                  </div>
                  <div className="duplicate-review-candidates">
                    {candidates.map((candidate) => (
                      <div className="duplicate-review-candidate" key={candidate.id} data-testid={`card-duplicate-customer-${candidate.id}`}>
                        <div className="duplicate-review-candidate-top"><h5>{candidate.name}</h5><span className="duplicate-review-id">شناسه #{formatCount(candidate.id)}</span></div>
                        <div className="duplicate-review-meta">
                          <span dir="ltr"><bdi>{formatPhoneForDisplay(candidate.phone)}</bdi></span>
                          <span>کد ملی: <bdi>{candidate.nationalCode || 'ثبت نشده'}</bdi></span>
                          <span>کارشناس فعلی: {candidate.salespersonName || 'بدون تخصیص'}</span>
                        </div>
                        <ul className="duplicate-review-counts" aria-label={`سوابق ${candidate.name}`}>
                          {Object.entries(historyLabels).map(([key, label]) => <li key={key}>{label} {formatCount(candidate.historyCounts[key as keyof typeof candidate.historyCounts] ?? 0)}</li>)}
                        </ul>
                        <div className="duplicate-review-choice">
                          <label><input type="radio" name="duplicate-survivor" checked={survivor?.id === candidate.id} onChange={() => { setTargetId(candidate.id); if (source?.id === candidate.id) setSourceId(candidates.find((item) => item.id !== candidate.id)?.id ?? null); setConfirming(false); setAcknowledged(false); }} data-testid={`radio-survivor-${candidate.id}`} /> نام و شناسهٔ باقی‌مانده</label>
                          <label className="is-archive"><input type="radio" name="duplicate-source" checked={source?.id === candidate.id} onChange={() => { setSourceId(candidate.id); if (survivor?.id === candidate.id) setTargetId(candidates.find((item) => item.id !== candidate.id)?.id ?? null); setConfirming(false); setAcknowledged(false); }} data-testid={`radio-archive-${candidate.id}`} /> پروندهٔ بایگانی‌شونده</label>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="duplicate-review-footer">
                    <label htmlFor="duplicate-salesperson">کارشناس مسئول پروندهٔ باقی‌مانده
                      <select id="duplicate-salesperson" className="select-control" value={salespersonId} disabled={salespersonLoading || salespersonError} onChange={(event) => { setSalespersonId(event.target.value); setConfirming(false); setAcknowledged(false); }} data-testid="select-merge-salesperson">
                        <option value="">{salespersonLoading ? 'در حال دریافت کارشناسان…' : 'یک کارشناس انتخاب کنید'}</option>
                        {salespersons.map((person) => <option key={person.id} value={person.id} disabled={!person.active}>{person.name}{!person.active ? ' (غیرفعال)' : ''}</option>)}
                      </select>
                    </label>
                    {salespersonError ? <div className="duplicate-review-message is-error" role="alert" data-testid="status-merge-salesperson-error">فهرست کارشناسان دریافت نشد. <button type="button" className="btn btn-ghost" onClick={onRetrySalespersons} data-testid="button-retry-merge-salespersons">تلاش دوباره</button></div> : null}
                    {!salespersonLoading && !salespersonError && !salespersons.some((person) => person.active) ? <div className="duplicate-review-message is-error" role="status" data-testid="status-merge-no-salespersons">برای ادغام، دست‌کم یک کارشناس فعال لازم است.</div> : null}
                    <div className="duplicate-review-impact" data-testid="text-merge-impact">
                      <strong>پیش‌نمایش تغییر:</strong> {source ? `پروندهٔ ${source.name} (#${formatCount(source.id)}) بایگانی می‌شود؛` : 'پروندهٔ مبدأ را انتخاب کنید؛'} {survivor ? `نام و شناسهٔ ${survivor.name} (#${formatCount(survivor.id)}) باقی می‌ماند.` : ''} {source && `سوابق عملیاتی آن شامل ${Object.entries(historyLabels).map(([key, label]) => `${formatCount(source.historyCounts[key as keyof typeof source.historyCounts] ?? 0)} ${label}`).join('، ')} به پروندهٔ اصلی منتقل می‌شوند.`}
                    </div>
                    {confirming && <div className="duplicate-review-confirm" data-testid="panel-merge-confirmation">
                      <h5>تأیید نهایی ادغام</h5>
                      <p>پروندهٔ «{source?.name}» با شناسهٔ #{source && formatCount(source.id)} حذف نمی‌شود، بلکه بایگانی می‌شود. پروندهٔ «{survivor?.name}» با شناسهٔ #{survivor && formatCount(survivor.id)} و کارشناس {assignedPerson?.name} ادامه می‌یابد. انتساب سابقهٔ مالی به مشتری و کارشناس اصلی خود حفظ می‌شود و به کارشناس جدید منتقل نخواهد شد.</p>
                      <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} data-testid="checkbox-confirm-merge-impact" /> بایگانی‌شدن پروندهٔ مبدأ و حفظ انتساب اصلی سوابق مالی را بررسی و تأیید می‌کنم.</label>
                    </div>}
                    {submitError && <div className="duplicate-review-message is-error" role="alert" data-testid="status-merge-error">ادغام انجام نشد. ممکن است این پرونده‌ها تغییر کرده باشند؛ موارد را دوباره بررسی کنید و تلاش کنید.</div>}
                    <div className="duplicate-review-actions">
                      {confirming ? <>
                        <button type="button" className="btn btn-primary" disabled={!acknowledged || merge.isPending} onClick={() => void submit()} data-testid="button-confirm-merge">{merge.isPending ? 'در حال ادغام…' : 'تأیید و ادغام پرونده‌ها'}</button>
                        <button type="button" className="btn btn-ghost" disabled={merge.isPending} onClick={() => { setConfirming(false); setAcknowledged(false); }} data-testid="button-back-merge">بازگشت به بررسی</button>
                      </> : <button type="button" className="btn btn-primary" disabled={!survivor || !source || !assignedPerson || merge.isPending} onClick={() => { setSubmitError(false); setConfirming(true); }} data-testid="button-review-merge"><ArrowLeftRight size={15} /> بررسی و ادامه</button>}
                    </div>
                  </div>
                </div>
              </div>}
      </div>
    </Modal>
  );
}