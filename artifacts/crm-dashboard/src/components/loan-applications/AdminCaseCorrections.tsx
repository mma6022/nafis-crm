import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetLoanApplicationAdminControls,
  useSetLoanApplicationAdminStage,
  useEditLoanApplicationAsAdmin,
  getGetLoanApplicationAdminControlsQueryKey,
  getGetLoanApplicationQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  type LoanCaseAdminChangeResult,
  type LoanCaseAdminEditInput,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';

const STAGE_FA: Record<string, string> = {
  draft: 'پیش‌نویس',
  primary_contract_pending_signature: 'در انتظار امضای قرارداد مشتری',
  approved_contract_pending_signature: 'امضای قرارداد جایگزین',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  funder_initial_approval: 'تصویب مبلغ وام',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  collateral_review: 'بررسی وثیقه',
  physical_documents_correction: 'رفع نقص مدارک فیزیکی',
  physical_documents_submission: 'ارسال مدارک فیزیکی',
  physical_documents_review: 'بررسی مدارک فیزیکی',
  expert_approval: 'ثبت تصمیم تأمین‌کننده مالی',
  funder_documents_correction: 'اصلاح مدارک مردود تأمین‌کننده',
  funder_result_review: 'بررسی نتیجه تأمین‌کننده',
  funder_amendment_pending_signature: 'در انتظار امضای الحاقیه',
  funder_amendment_review: 'بررسی الحاقیه',
  admin_approval: 'تأیید نهایی مدیر',
  wallet_charge_pending: 'در انتظار تأیید شارژ',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل شده',
};
const FINANCIAL_STAGES = ['completed', 'final_invoice_pending_signature'];
const stageFa = (s: string) => STAGE_FA[s] ?? s;

export function normalizeAdminDigits(value: string) {
  return value
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,\u066C\u060C\s]/g, '');
}
const normText = (v: string) => v
  .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();

const LOCKED = 'برای این پرونده ثبت مالی انجام شده یا شرایط مالی قفل است؛ شرایط قابل تغییر نیست.';
const CONSENT = 'تأیید صریح پیامدهای قرارداد الزامی است.';
const ERRORS: Record<string, string> = {
  admin_only: 'این بخش فقط برای مدیر در دسترس است.',
  invalid_admin_case_input: 'اطلاعات واردشده معتبر نیست؛ مقادیر را بررسی کنید.',
  admin_confirmation_required: 'تأیید نهایی الزامی است.',
  admin_reason_required: 'دلیل باید بین ۲ تا ۲۰۰۰ نویسه باشد.',
  admin_revision_required: 'نسخه پرونده مشخص نیست؛ فرم را دوباره باز کنید.',
  admin_case_revision_conflict: 'پرونده پس از باز شدن این فرم تغییر کرده است. اطلاعات تازه بارگیری شد؛ دوباره بررسی و ثبت کنید.',
  invalid_admin_case_stage: 'مرحله انتخاب‌شده معتبر نیست.',
  admin_case_no_changes: 'تغییری برای ثبت وجود ندارد.',
  admin_stage_requires_financial_posting: 'مرحله‌های پایانی مالی فقط برای پرونده‌ای مجازند که ثبت مالی واقعی دارد.',
  admin_case_financial_terms_locked: LOCKED,
  invalid_admin_case_terms: 'مبلغ، مدت یا شرایط انتخاب‌شده معتبر نیست.',
  admin_case_terms_not_eligible: 'مبلغ یا مدت انتخاب‌شده با شرایط طرح سازگار نیست.',
  admin_case_invalid_plan_condition: 'شرط انتخاب‌شده متعلق به این طرح نیست.',
  admin_case_contract_send_in_progress: 'ارسال قرارداد در حال انجام است؛ کمی بعد دوباره تلاش کنید.',
  admin_case_contract_revision_consent_required: CONSENT,
  admin_case_shared_contract: 'قرارداد این پرونده با پرونده دیگری مشترک است و با این اصلاح قابل بازنویسی نیست.',
  invalid_guarantor: 'اطلاعات ضامن معتبر نیست.',
  invalid_application_notes: 'یادداشت معتبر نیست (حداکثر ۲۰۰۰ نویسه).',
  invalid_manual_values: 'فیلدهای دستی قرارداد معتبر نیستند.',
};
function errCode(e: unknown) {
  const x = e as { data?: { error?: string; code?: string }; response?: { data?: { error?: string; code?: string } } };
  return x?.data?.error ?? x?.data?.code ?? x?.response?.data?.error ?? x?.response?.data?.code;
}
function errMsg(e: unknown) {
  const x = e as { status?: number; response?: { status?: number } };
  const code = errCode(e);
  const status = x?.status ?? x?.response?.status;
  if (code && ERRORS[code]) return ERRORS[code];
  if (status === 403) return ERRORS.admin_only;
  if (status === 400 || status === 422) return ERRORS.invalid_admin_case_input;
  if (status === 409) return 'تغییر به دلیل وضعیت فعلی پرونده انجام نشد؛ اطلاعات واردشده حفظ شده است.';
  return 'ثبت تغییر انجام نشد؛ دوباره تلاش کنید.';
}
const isStale = (e: unknown) => {
  const c = errCode(e);
  return c === 'admin_case_revision_conflict' || c === 'stale_revision' || c === 'revision_conflict';
};

type Mode = 'stage' | 'edit' | null;
const box: React.CSSProperties = { display: 'grid', gap: 6, fontSize: 12, color: '#475569' };

export function AdminCaseCorrections({ applicationId }: { applicationId: number }) {
  const queryClient = useQueryClient();
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session?.user?.role === 'admin';
  const [mode, setMode] = useState<Mode>(null);
  const controlsKey = getGetLoanApplicationAdminControlsQueryKey(applicationId);
  const controlsQuery = useGetLoanApplicationAdminControls(applicationId, {
    query: {
      queryKey: controlsKey,
      enabled: isAdmin && Number.isFinite(applicationId),
      refetchInterval: 20000,
      refetchOnWindowFocus: true,
    },
  });
  const controls = controlsQuery.data;
  const setStage = useSetLoanApplicationAdminStage();
  const editCase = useEditLoanApplicationAsAdmin();

  // Form state
  const snapshotRevision = useRef<string | null>(null);
  const [stage, setStageValue] = useState('');
  const [planId, setPlanId] = useState(0);
  const [conditionId, setConditionId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  const [needsGuarantor, setNeedsGuarantor] = useState(false);
  const [gName, setGName] = useState('');
  const [gCode, setGCode] = useState('');
  const [gMobile, setGMobile] = useState('');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LoanCaseAdminChangeResult | null>(null);

  const initialize = (c: NonNullable<typeof controls>, m: Mode) => {
    snapshotRevision.current = c.revision;
    const d = c.defaults;
    setStageValue(c.stage);
    setPlanId(d.planId);
    setConditionId(d.conditionId ?? null);
    setAmount(d.requestedAmount);
    setDuration(String(d.durationMonths));
    setNeedsGuarantor(d.needsGuarantor);
    setGName(d.guarantor?.fullName ?? '');
    setGCode(d.guarantor?.nationalCode ?? '');
    setGMobile(d.guarantor?.mobile ?? '');
    setManual({ ...(d.manualValues ?? {}) });
    setNotes(d.notes ?? '');
    setReason(''); setConfirmed(false); setAck(false); setError('');
    setMode(m);
  };

  const open = async (m: Exclude<Mode, null>) => {
    setResult(null);
    const fresh = await controlsQuery.refetch();
    if (fresh.data) initialize(fresh.data, m);
    else setError('دریافت اطلاعات اصلاح پرونده انجام نشد.');
  };

  const invalidateAll = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(applicationId) }),
    queryClient.invalidateQueries({ queryKey: controlsKey }),
    queryClient.invalidateQueries({
      predicate: q => {
        const k = q.queryKey[0];
        return typeof k === 'string' && (k.startsWith('/api/loan-applications') || k.startsWith('/api/customers')
          || k.startsWith('/api/crm') || k.startsWith('/api/wallet') || k.startsWith('/api/company-wallet') || k.startsWith('/api/contracts'));
      },
    }),
  ]);

  const plan = useMemo(() => controls?.plans.find(p => p.id === planId), [controls, planId]);
  const condition = plan?.conditions.find(c => c.id === conditionId);
  const funded = controls?.financialTermsLocked ?? controls?.financialPosted ?? false;

  const changeStaleHandler = async (e: unknown) => {
    setError(errMsg(e));
    if (isStale(e)) {
      const fresh = await controlsQuery.refetch();
      if (fresh.data && mode) {
        const keepReason = reason;
        initialize(fresh.data, mode);
        setReason(keepReason);
        setError(ERRORS.admin_case_revision_conflict);
      }
    }
  };

  const onPlan = (id: number) => {
    const p = controls?.plans.find(x => x.id === id);
    if (!p) return;
    setPlanId(id);
    const first = p.conditions[0];
    setConditionId(first?.id ?? null);
    if (first) { setNeedsGuarantor(first.needsGuarantor); if (!first.durations.includes(Number(normText(duration)))) setDuration(String(first.durations[0] ?? '')); }
    const next: Record<string, string> = {};
    p.manualVariables.forEach(v => { next[v.variable] = manual[v.variable] ?? ''; });
    setManual(next);
  };
  const onCondition = (id: number) => {
    setConditionId(id);
    const c = plan?.conditions.find(x => x.id === id);
    if (c) { setNeedsGuarantor(c.needsGuarantor); if (!c.durations.includes(Number(normText(duration)))) setDuration(String(c.durations[0] ?? '')); }
  };

  const reasonOk = reason.trim().length >= 2 && reason.trim().length <= 2000;

  const submitStage = () => {
    if (!controls) return;
    setError('');
    if (stage === controls.stage && controls.status !== 'rejected') { setError(ERRORS.admin_case_no_changes); return; }
    if (!reasonOk) { setError(ERRORS.admin_reason_required); return; }
    if (!confirmed) { setError(ERRORS.admin_confirmation_required); return; }
    setStage.mutate({ id: applicationId, data: { expectedRevision: snapshotRevision.current ?? controls.revision, stage, reason: reason.trim(), confirmed: true } }, {
      onSuccess: async (r) => { await invalidateAll(); setResult(r); setMode(null); },
      onError: changeStaleHandler,
    });
  };

  const submitEdit = () => {
    if (!controls) return;
    setError('');
    const d = controls.defaults;
    const body: LoanCaseAdminEditInput = { expectedRevision: snapshotRevision.current ?? controls.revision, reason: reason.trim(), confirmed: true };
    let substantive = false;
    const amt = normalizeAdminDigits(amount);
    const dur = normalizeAdminDigits(duration);
    if (amt !== d.requestedAmount) {
      if (!/^[1-9]\d{0,17}$/.test(amt)) { setError('مبلغ باید عدد صحیح مثبت به تومان باشد.'); return; }
      body.requestedAmount = amt; substantive = true;
    }
    if (dur !== String(d.durationMonths)) {
      const n = Number(dur);
      if (!/^\d+$/.test(dur) || n < 1 || n > 600) { setError('تعداد اقساط باید بین ۱ تا ۶۰۰ ماه باشد.'); return; }
      body.durationMonths = n; substantive = true;
    }
    const planChanged = planId !== d.planId;
    if (planChanged) { body.planId = planId; substantive = true; }
    if (planChanged || (conditionId ?? null) !== (d.conditionId ?? null)) {
      if (conditionId == null) { setError('شرط طرح را انتخاب کنید.'); return; }
      body.conditionId = conditionId; substantive = true;
      if (planChanged && !body.requestedAmount) body.requestedAmount = amt;
      if (planChanged && !body.durationMonths) body.durationMonths = Number(dur);
    }
    if (needsGuarantor !== d.needsGuarantor) { body.needsGuarantor = needsGuarantor; substantive = true; }
    if (needsGuarantor) {
      const g = { fullName: normText(gName), nationalCode: normalizeAdminDigits(gCode), mobile: normalizeAdminDigits(gMobile) };
      const og = d.guarantor;
      const gChanged = g.fullName !== (og?.fullName ?? '') || g.nationalCode !== (og?.nationalCode ?? '') || g.mobile !== (og?.mobile ?? '');
      if (gChanged) {
        if (g.fullName.length < 2) { setError('نام کامل ضامن حداقل ۲ نویسه است.'); return; }
        if (g.nationalCode && !/^\d{10}$/.test(g.nationalCode)) { setError('کد ملی ضامن باید ۱۰ رقم باشد.'); return; }
        if (g.mobile && !/^09\d{9}$/.test(g.mobile)) { setError('شماره همراه ضامن باید با ۰۹ شروع شود و ۱۱ رقم باشد.'); return; }
        body.guarantor = { fullName: g.fullName, nationalCode: g.nationalCode || null, mobile: g.mobile || null };
        substantive = true;
      }
    }
    const mv: Record<string, string> = {};
    Object.entries(manual).forEach(([k, v]) => { mv[k] = normText(v); });
    if (planChanged || JSON.stringify(mv) !== JSON.stringify(Object.fromEntries(Object.entries(d.manualValues ?? {}).map(([k, v]) => [k, v])))) {
      body.manualValues = mv; substantive = true;
    }
    if (notes.trim() !== (d.notes ?? '').trim()) {
      if (notes.length > 2000) { setError('یادداشت حداکثر ۲۰۰۰ نویسه است.'); return; }
      body.notes = notes.trim() === '' ? null : notes.trim();
    }
    if (body.notes === undefined && !substantive) { setError(ERRORS.admin_case_no_changes); return; }
    if (substantive && funded) { setError(ERRORS.admin_case_financial_terms_locked); return; }
    if (substantive && controls.hasContracts) {
      if (!ack) { setError(ERRORS.admin_case_contract_revision_consent_required); return; }
      body.acknowledgeContractRevision = true;
    }
    if (!reasonOk) { setError(ERRORS.admin_reason_required); return; }
    if (!confirmed) { setError(ERRORS.admin_confirmation_required); return; }
    editCase.mutate({ id: applicationId, data: body }, {
      onSuccess: async (r) => { await invalidateAll(); setResult(r); setMode(null); },
      onError: changeStaleHandler,
    });
  };

  const [lastRev, setLastRev] = useState<string | null>(null);
  useEffect(() => { if (mode === null) setLastRev(null); else setLastRev(controls?.revision ?? null); }, [controls?.revision, mode]);
  const externallyChanged = mode !== null && controls && snapshotRevision.current && controls.revision !== snapshotRevision.current && lastRev !== null;

  if (!isAdmin) return null;
  const pending = setStage.isPending || editCase.isPending;

  const common = (
    <>
      <label style={box}>
        دلیل اصلاح (الزامی، ۲ تا ۲۰۰۰ نویسه)
        <textarea rows={3} value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} data-testid="admin-correction-reason" />
      </label>
      <label style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="admin-correction-confirm" />
        <span>تأیید می‌کنم این اصلاح با نام من در تاریخچه پرونده ثبت می‌شود و هیچ سابقه‌ای حذف نخواهد شد.</span>
      </label>
      {error && <p role="alert" className="form-error" data-testid="admin-correction-error" style={{ margin: 0 }}>{error}</p>}
      {externallyChanged && (
        <p role="status" data-testid="admin-correction-stale-notice" style={{ margin: 0, fontSize: 12, color: '#92400e' }}>
          پرونده در نشست دیگری تغییر کرده است. مقادیر در حال ویرایش شما حفظ شده‌اند؛ برای دریافت اطلاعات تازه، فرم را دوباره باز کنید.
        </p>
      )}
    </>
  );

  return (
    <div className="panel" data-testid="admin-case-corrections" style={{ padding: 16, display: 'grid', gap: 10, border: '1px solid #fde68a', background: '#fffbeb' }}>
      <div>
        <strong style={{ fontSize: 13 }}>اصلاحات مدیریتی پرونده</strong>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>فقط مدیر؛ هر اقدام با دلیل در تاریخچه ثبت می‌شود و هرگز تراکنش مالی ایجاد نمی‌کند.</p>
      </div>
      {controlsQuery.isLoading && <p style={{ margin: 0, fontSize: 12 }} data-testid="admin-controls-loading">در حال دریافت اطلاعات…</p>}
      {controlsQuery.isError && !controls && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: '#b91c1c' }} data-testid="admin-controls-error">
          دریافت اطلاعات اصلاح ممکن نشد. <button type="button" className="btn" onClick={() => controlsQuery.refetch()} data-testid="admin-controls-retry">تلاش دوباره</button>
        </p>
      )}
      {controls && (
        <p style={{ margin: 0, fontSize: 12 }} data-testid="admin-current-stage">مرحله فعلی: <strong>{stageFa(controls.stage)}</strong>{controls.financialPosted ? ' · ثبت مالی انجام شده' : ''}</p>
      )}
      {result && (
        <p role="status" data-testid="admin-correction-result" style={{ margin: 0, fontSize: 12, color: '#047857' }}>
          اصلاح ثبت شد؛ مرحله جدید: {stageFa(result.stage)}.{' '}
          {result.requiresNewContract
            ? <strong data-testid="admin-requires-new-contract">قرارداد جدید لازم است: پرونده به پیش‌نویس بازگشت و باید قرارداد جایگزین ساخته، امضا و دوباره تأیید شود.</strong>
            : 'نیازی به قرارداد جدید نیست.'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={!controls || pending} onClick={() => open('stage')} data-testid="admin-open-stage">اصلاح دستی مرحله</button>
        <button type="button" className="btn btn-primary" disabled={!controls || pending} onClick={() => open('edit')} data-testid="admin-open-edit">ویرایش اطلاعات پرونده</button>
      </div>

      {mode === 'stage' && controls && (
        <Modal title="اصلاح دستی مرحله" eyebrow="مدیر" onClose={() => setMode(null)} testId="admin-stage">
          <div style={{ display: 'grid', gap: 12, padding: 16 }}>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>این اقدام بررسی‌های اداری را دور می‌زند، ولی هیچ مبلغی ثبت نمی‌کند و سابقه‌ای را حذف نمی‌کند.</p>
            <label style={box}>
              مرحله جدید
              <select value={stage} onChange={e => setStageValue(e.target.value)} data-testid="admin-stage-select">
                {controls.stages.map(s => {
                  const lock = FINANCIAL_STAGES.includes(s) && !controls.financialPosted;
                  return <option key={s} value={s} disabled={lock}>{stageFa(s)}{lock ? ' (نیازمند ثبت مالی واقعی)' : ''}</option>;
                })}
              </select>
            </label>
            {!controls.financialPosted && <p style={{ margin: 0, fontSize: 11, color: '#92400e' }} data-testid="admin-stage-financial-note">مرحله‌های «تکمیل شده» و «امضای صورت‌حساب نهایی» فقط وقتی فعال‌اند که برای پرونده ثبت مالی واقعی وجود داشته باشد.</p>}
            {common}
            <div><button type="button" className="btn btn-primary" disabled={pending} onClick={submitStage} data-testid="admin-stage-submit">{setStage.isPending ? 'در حال ثبت…' : 'ثبت اصلاح مرحله'}</button></div>
          </div>
        </Modal>
      )}

      {mode === 'edit' && controls && (
        <Modal title="ویرایش اطلاعات پرونده" eyebrow="مدیر" onClose={() => setMode(null)} testId="admin-edit" wide>
          <div style={{ display: 'grid', gap: 12, padding: 16 }}>
            {funded && <p style={{ margin: 0, fontSize: 12, color: '#92400e' }} data-testid="admin-edit-funded-note">این پرونده قبلاً تأمین مالی شده است؛ فقط یادداشت قابل ویرایش است و شرایط مالی قفل است.</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              <label style={box}>طرح
                <select value={planId} disabled={funded} onChange={e => onPlan(Number(e.target.value))} data-testid="admin-edit-plan">
                  {controls.plans.map(p => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (غیرفعال)'}</option>)}
                </select>
              </label>
              <label style={box}>شرط طرح
                <select value={conditionId ?? ''} disabled={funded || !plan?.conditions.length} onChange={e => onCondition(Number(e.target.value))} data-testid="admin-edit-condition">
                  {conditionId == null && <option value="">انتخاب کنید</option>}
                  {plan?.conditions.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label style={box}>مبلغ درخواستی (تومان)
                <input dir="ltr" inputMode="numeric" value={amount} disabled={funded} onChange={e => setAmount(e.target.value)} data-testid="admin-edit-amount" />
              </label>
              <label style={box}>تعداد اقساط (ماه)
                <input dir="ltr" inputMode="numeric" value={duration} disabled={funded} onChange={e => setDuration(e.target.value)} data-testid="admin-edit-duration" />
              </label>
            </div>
            {condition && <p style={{ margin: 0, fontSize: 11, color: '#64748b' }} data-testid="admin-edit-condition-hint">سقف اصل: {BigInt(condition.maxPrincipal || '0').toLocaleString('fa-IR')} تومان · مدت‌های مجاز: {condition.durations.map(n => n.toLocaleString('fa-IR')).join('، ')} ماه</p>}
            <label style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
              <input type="checkbox" checked={needsGuarantor} disabled={funded} onChange={e => setNeedsGuarantor(e.target.checked)} data-testid="admin-edit-needs-guarantor" />
              پرونده ضامن نیاز دارد
            </label>
            {needsGuarantor && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <label style={box}>نام کامل ضامن<input value={gName} disabled={funded} onChange={e => setGName(e.target.value)} data-testid="admin-edit-guarantor-name" /></label>
                <label style={box}>کد ملی ضامن<input dir="ltr" inputMode="numeric" value={gCode} disabled={funded} onChange={e => setGCode(e.target.value)} data-testid="admin-edit-guarantor-code" /></label>
                <label style={box}>همراه ضامن<input dir="ltr" inputMode="numeric" value={gMobile} disabled={funded} onChange={e => setGMobile(e.target.value)} data-testid="admin-edit-guarantor-mobile" /></label>
              </div>
            )}
            {plan && plan.manualVariables.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                {plan.manualVariables.map(v => (
                  <label key={v.variable} style={box}>{v.label}
                    <input value={manual[v.variable] ?? ''} disabled={funded} onChange={e => setManual(m => ({ ...m, [v.variable]: e.target.value }))} data-testid={`admin-edit-manual-${v.variable}`} />
                  </label>
                ))}
              </div>
            )}
            <label style={box}>یادداشت پرونده
              <textarea rows={3} value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} data-testid="admin-edit-notes" />
            </label>
            {controls.hasContracts && !funded && (
              <label style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start', padding: 10, border: '1px solid #fcd34d', borderRadius: 8 }}>
                <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="admin-edit-ack-contract" />
                <span>می‌دانم با تغییر شرایط، اسناد و امضاهای قبلی فقط به‌عنوان سابقه می‌مانند، هیچ ابطال بیرونی انجام نمی‌شود، پرونده به پیش‌نویس برمی‌گردد و قرارداد جایگزین، امضای دوباره و تأیید جدید لازم است. (فقط برای تغییر شرایط؛ یادداشت بدون اثر است.)</span>
              </label>
            )}
            {common}
            <div><button type="button" className="btn btn-primary" disabled={pending} onClick={submitEdit} data-testid="admin-edit-submit">{editCase.isPending ? 'در حال ثبت…' : 'ثبت ویرایش'}</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
