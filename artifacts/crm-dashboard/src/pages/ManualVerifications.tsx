import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Clock3, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import {
  getGetCustomerQueryKey,
  getGetManualVerificationRequestQueryKey,
  getListManualVerificationRequestsQueryKey,
  useApproveManualVerificationRequest,
  useCreateManualVerificationRequest,
  useGetManualVerificationRequest,
  useListManualVerificationRequests,
  useVerifyCustomerIdentity,
  type ManualVerificationApproval,
  type ManualVerificationApprovalCorrectedValues,
  type ManualVerificationCheckStatuses,
  type ManualVerificationDetail,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';
import './ManualVerifications.css';
import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { matchesCustomerSearch, rankExactCustomerId } from '@/lib/customer-id';

const checkKeys = ['shahkarLite', 'personInfo', 'postalCodeInfo', 'sana'] as const;
type CheckKey = typeof checkKeys[number];
type Decision = { method: 'system' | 'manual'; reason: string };
type Decisions = Record<CheckKey, Decision>;
type ProfileKey = keyof ManualVerificationApprovalCorrectedValues;
const fields: { key: ProfileKey; label: string; placeholder?: string; ltr?: boolean }[] = [
  { key: 'name', label: 'نام کامل' },
  { key: 'firstName', label: 'نام' },
  { key: 'lastName', label: 'نام خانوادگی' },
  { key: 'fatherName', label: 'نام پدر' },
  { key: 'nationalCode', label: 'کد ملی', placeholder: '۱۰ رقم', ltr: true },
  { key: 'mobile', label: 'شماره همراه', placeholder: '09xxxxxxxxx', ltr: true },
  { key: 'birthDateJalali', label: 'تاریخ تولد شمسی', placeholder: '۱۳۷۰/۰۱/۰۱', ltr: true },
  { key: 'postalCode', label: 'کد پستی', placeholder: '۱۰ رقم', ltr: true },
  { key: 'address', label: 'نشانی' },
];
const checkNames: Record<CheckKey, string> = {
  shahkarLite: 'تطابق مالکیت همراه (شاهکار)',
  personInfo: 'اطلاعات هویتی ثبت احوال',
  postalCodeInfo: 'تطابق کد پستی و نشانی',
  sana: 'استعلام ثنا',
};
// Only transliterate numerals: in particular, never strip the date separators.
const normalizeNumerals = (s: string) => s.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632));
const normalizeDate = (s: string) => normalizeNumerals(s.trim()).replace(/[-.]/g, '/');
const valueOf = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const profileValue = (profile: Record<string, unknown>, key: ProfileKey) => valueOf(profile[key === 'mobile' ? 'phone' : key] ?? profile[key]);
const draftEdits = (form: Record<ProfileKey, string>, profile: Record<string, unknown>) =>
  Object.fromEntries(fields.filter(({ key }) => normalizeNumerals(form[key].trim()) !== normalizeNumerals(profileValue(profile, key).trim())).map(({ key }) => [key, form[key]])) as Partial<Record<ProfileKey, string>>;
const initialDecisions = (checks: ManualVerificationCheckStatuses): Decisions => Object.fromEntries(
  checkKeys.map(key => [key, { method: checks[key].ok ? 'system' : 'manual', reason: '' }]),
) as Decisions;

function readableError(error: unknown, fallback: string): string {
  const e = error as { status?: number; data?: unknown } | null;
  const payload = e?.data as { message?: unknown; detail?: unknown; error?: unknown; code?: unknown } | undefined;
  const raw = [payload?.code, payload?.error, payload?.message, payload?.detail].find((value): value is string => typeof value === 'string') ?? '';
  if (e?.status === 409) {
    if (/active customer already has/i.test(raw)) return 'شماره همراه یا کد ملی واردشده قبلاً برای یک مشتری فعال ثبت شده است. مقدار دیگری وارد کنید.';
    if (/successful SAPI result matching|freshly re-queried/i.test(raw)) return 'نتیجه موفق استعلام با اطلاعات اصلاح‌شده مطابقت ندارد. پس از اصلاح، استعلام هویت را دوباره انجام دهید.';
    return 'اطلاعات یا وضعیت این درخواست تغییر کرده است. وضعیت تازه را بارگذاری کنید و دوباره تصمیم بگیرید.';
  }
  if (e?.status === 404) return 'این درخواست دیگر در دسترس نیست. فهرست را تازه‌سازی کنید.';
  if (e?.status === 403) return 'دسترسی بررسی هویت فقط برای مدیر سامانه مجاز است.';
  if (e?.status === 401) return 'نشست شما پایان یافته است. دوباره وارد سامانه شوید.';
  if (e?.status === 502 || e?.status === 503 || e?.status === 504 || !e?.status) {
    return 'ارتباط با سرویس استعلام یا سرور برقرار نشد. چند لحظه بعد دوباره تلاش کنید.';
  }
  if (e?.status === 400 || e?.status === 422) {
    if (/matching failed or unavailable SAPI check/i.test(raw)) return 'نتیجه ناموفق استعلام با اطلاعات هویتی فعلی مشتری تطابق ندارد. اطلاعات را اصلاح و استعلام را دوباره انجام دهید؛ تا آن زمان درخواست تازه قابل ایجاد نیست.';
    if (/national|کد ملی/i.test(raw)) return 'کد ملی معتبر نیست؛ مقدار ده‌رقمی صحیح را وارد کنید.';
    if (/mobile|phone|شماره همراه/i.test(raw)) return 'شماره همراه معتبر نیست؛ شماره ثبت‌شده مشتری را بررسی کنید.';
    if (/birth|jalali|تولد|جلالی/i.test(raw)) return 'تاریخ تولد جلالی معتبر نیست؛ آن را به صورت سال/ماه/روز وارد کنید.';
    if (/postal|کد پستی/i.test(raw)) return 'کد پستی معتبر نیست؛ کد ده‌رقمی را بررسی کنید.';
    if (/reason|failed or unavailable|requires a reason/i.test(raw)) return 'برای هر تأیید دستی، بررسی باید ناموفق یا در دسترس نباشد و دلیل فارسی آن ثبت شود.';
    if (/نام معتبر/i.test(raw)) return 'نام کامل معتبر را وارد کنید.';
    return 'مقادیر اصلاح‌شده معتبر نیستند. کد ملی، شماره همراه، تاریخ تولد و کد پستی را بررسی کنید.';
  }
  if (e?.status === 429) return 'تعداد درخواست‌های استعلام زیاد است. کمی صبر کنید و دوباره تلاش کنید.';
  if (e?.status && e.status >= 500) return 'خطای سرور در بررسی هویت رخ داد. چند لحظه بعد دوباره تلاش کنید.';
  return fallback;
}

type FieldErrors = Partial<Record<ProfileKey, string>>;
type ReasonErrors = Partial<Record<CheckKey, string>>;
const validNationalCode = (code: string) => {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const remainder = code.slice(0, 9).split('').reduce((sum, digit, index) => sum + Number(digit) * (10 - index), 0) % 11;
  return Number(code[9]) === (remainder < 2 ? remainder : 11 - remainder);
};
function validateProfile(form: Record<ProfileKey, string>, original: Record<string, unknown>, mode: 'requery' | 'approve'): FieldErrors {
  const errors: FieldErrors = {};
  const changed = (key: ProfileKey) => normalizeNumerals(form[key].trim()) !== normalizeNumerals(profileValue(original, key).trim());
  const national = normalizeNumerals(form.nationalCode.trim());
  const mobile = normalizeNumerals(form.mobile.trim());
  const postal = normalizeNumerals(form.postalCode.trim());
  const birth = normalizeDate(form.birthDateJalali);
  if (!national) errors.nationalCode = 'کد ملی برای استعلام هویت الزامی است.';
  else if (!validNationalCode(national)) errors.nationalCode = 'کد ملی معتبر نیست؛ کد ده‌رقمی و رقم کنترل آن را بررسی کنید.';
  if (!mobile) errors.mobile = 'شماره همراه برای استعلام هویت الزامی است.';
  else if (!/^(?:09\d{9}|(?:\+?98)9\d{9})$/.test(mobile)) errors.mobile = 'شماره همراه معتبر نیست؛ شماره ۱۱ رقمی با ۰۹ یا پیش‌شماره ۹۸ وارد کنید.';
  if (!birth) errors.birthDateJalali = 'تاریخ تولد جلالی برای استعلام هویت الزامی است.';
  else {
    const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(birth);
    const currentYear = Number(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric' }).format(new Date()));
    if (!match || Number(match[1]) < 1200 || Number(match[1]) > currentYear || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31)
      errors.birthDateJalali = 'تاریخ تولد معتبر را به شکل سال/ماه/روز شمسی وارد کنید.';
  }
  if (!postal) errors.postalCode = 'کد پستی برای استعلام هویت الزامی است.';
  else if (!/^\d{10}$/.test(postal)) errors.postalCode = 'کد پستی باید دقیقاً ۱۰ رقم باشد.';
  if ((mode === 'approve' || changed('name')) && !form.name.trim()) errors.name = 'نام کامل الزامی است.';
  else if (form.name.trim().length > 200) errors.name = 'نام کامل نباید بیش از ۲۰۰ نویسه باشد.';
  for (const key of ['firstName', 'lastName', 'fatherName'] as const) {
    if (form[key].trim().length > 100) errors[key] = 'این مقدار نباید بیش از ۱۰۰ نویسه باشد.';
  }
  if (form.address.trim().length > 1000) errors.address = 'نشانی نباید بیش از ۱۰۰۰ نویسه باشد.';
  return errors;
}

function apiFieldErrors(error: unknown): { fields: FieldErrors; reasons: ReasonErrors } {
  const api = error as { status?: number; data?: { error?: unknown; message?: unknown; detail?: unknown } } | null;
  if (api?.status !== 400 && api?.status !== 422) return { fields: {}, reasons: {} };
  const raw = String(api.data?.error ?? api.data?.message ?? api.data?.detail ?? '');
  const fields: FieldErrors = {};
  const reasons: ReasonErrors = {};
  if (/nationalCode|national.code|کد ملی/i.test(raw)) fields.nationalCode = 'کد ملی معتبر نیست؛ کد و رقم کنترل آن را بررسی کنید.';
  else if (/mobile|phone|شماره همراه/i.test(raw)) fields.mobile = 'شماره همراه معتبر نیست؛ شماره ثبت‌شده مشتری را بررسی کنید.';
  else if (/birthDateJalali|birth|jalali|تولد|جلالی/i.test(raw)) fields.birthDateJalali = 'تاریخ تولد جلالی معتبر نیست؛ سال، ماه و روز را بررسی کنید.';
  else if (/postalCode|postal|کد پستی/i.test(raw)) fields.postalCode = 'کد پستی معتبر نیست؛ کد ده‌رقمی را بررسی کنید.';
  else if (/\bname\b|نام معتبر/i.test(raw)) fields.name = 'نام کامل معتبر وارد کنید.';
  else if (/reason|failed or unavailable/i.test(raw)) {
    const key = checkKeys.find(check => raw.includes(check));
    if (key) reasons[key] = 'برای این بررسی ناموفق، دلیل فارسی معتبر ثبت کنید.';
  }
  return { fields, reasons };
}

function changedValues(form: Record<ProfileKey, string>, original: Record<string, unknown>): ManualVerificationApprovalCorrectedValues {
  const result: Record<string, string | null> = {};
  for (const { key } of fields) {
    const current = (['nationalCode', 'mobile', 'birthDateJalali', 'postalCode'] as ProfileKey[]).includes(key)
      ? normalizeNumerals(profileValue(original, key).trim()) : profileValue(original, key).trim();
    const next = (['nationalCode', 'mobile', 'birthDateJalali', 'postalCode'] as ProfileKey[]).includes(key)
      ? normalizeNumerals(form[key].trim()) : form[key].trim();
    if (next !== current) result[key] = next || null;
  }
  return result as ManualVerificationApprovalCorrectedValues;
}

type Selection = { id: number; draft?: Partial<Record<ProfileKey, string>>; message?: string; notice?: string };
function RequestDialog({ selection, latestPendingId, onReplace, onClose, onFinished }: {
  selection: Selection;
  latestPendingId?: number;
  onReplace: (next: Selection) => void;
  onClose: () => void;
  onFinished: (message: string) => void;
}) {
  const { id } = selection;
  const queryClient = useQueryClient();
  const detail = useGetManualVerificationRequest(id, {
    query: { queryKey: getGetManualVerificationRequestQueryKey(id), refetchOnWindowFocus: false },
  });
  const verify = useVerifyCustomerIdentity();
  const approve = useApproveManualVerificationRequest();
  const createRequest = useCreateManualVerificationRequest();
  const [form, setForm] = useState<Record<ProfileKey, string> | null>(null);
  const requeryDraft = useRef<Partial<Record<ProfileKey, string>> | null>(null);
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [message, setMessage] = useState(selection.message ?? '');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [reasonErrors, setReasonErrors] = useState<ReasonErrors>({});
  const [notice, setNotice] = useState(selection.notice ?? '');
  const [conflict, setConflict] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [needsFreshChecks, setNeedsFreshChecks] = useState(false);
  const [reconcileRequired, setReconcileRequired] = useState(false);
  const [savingCheck, setSavingCheck] = useState(false);
  const busy = savingCheck || verify.isPending || approve.isPending || createRequest.isPending || refreshing;

  useEffect(() => {
    if (!detail.data) return;
    setForm({
      ...Object.fromEntries(fields.map(({ key }) => [key, profileValue(detail.data.currentProfile, key)])) as Record<ProfileKey, string>,
      ...selection.draft,
      ...requeryDraft.current,
    });
    requeryDraft.current = null;
    setDecisions(initialDecisions(detail.data.currentChecks));
  }, [detail.data]);

  const refresh = async (unlockApproval = true): Promise<boolean> => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListManualVerificationRequestsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetManualVerificationRequestQueryKey(id), refetchType: 'none' }),
        ...(detail.data ? [queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(detail.data.customerId) })] : []),
      ]);
      const latest = await detail.refetch();
      if (latest.isError || !latest.data) {
        setNeedsFreshChecks(true);
        setMessage(readableError(latest.error, 'وضعیت تازه بررسی‌ها دریافت نشد. پیش از تصمیم نهایی، آن را دوباره بارگذاری کنید.'));
        return false;
      }
      // Invalidate choices from the previous inquiry before approval can be enabled again.
      setDecisions(initialDecisions(latest.data.currentChecks));
      if (unlockApproval) setNeedsFreshChecks(false);
      return true;
    } catch (error) {
      setNeedsFreshChecks(true);
      setMessage(readableError(error, 'وضعیت تازه بررسی‌ها دریافت نشد. پیش از تصمیم نهایی، آن را دوباره بارگذاری کنید.'));
      return false;
    } finally {
      setRefreshing(false);
    }
  };

  const onError = (error: unknown, fallback: string) => {
    const status = (error as { status?: number })?.status;
    setConflict(status === 409 || status === 404);
    const inline = apiFieldErrors(error);
    setFieldErrors(inline.fields);
    setReasonErrors(inline.reasons);
    setMessage(Object.keys(inline.fields).length || Object.keys(inline.reasons).length ? '' : readableError(error, fallback));
    if (status === 409 || status === 404) void refresh();
  };

  const reconcileRequest = async (customerId: number, edits: Partial<Record<ProfileKey, string>>, providerUnavailable = false) => {
    setNeedsFreshChecks(true);
    setReconcileRequired(true);
    try {
      // Idempotent for the current event; supersedes the previous pending
      // request when the latest SAPI event/profile/failure set has changed.
      const replacement = await createRequest.mutateAsync({ id: customerId });
      await queryClient.invalidateQueries({ queryKey: getListManualVerificationRequestsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetManualVerificationRequestQueryKey(id), refetchType: 'none' });
      if (replacement.id !== id) {
        onReplace({
          id: replacement.id,
          draft: edits,
          ...(providerUnavailable
            ? { message: 'سرویس استعلام در دسترس نبود. نتیجه عدم دسترسی ثبت شد؛ درخواست جایگزین را با دقت بررسی کنید.' }
            : { notice: 'نتیجه استعلام تازه ثبت شد و درخواست جایگزین برای بررسی باز شده است. وضعیت هر چهار بررسی را دوباره مرور کنید.' }),
        });
        return;
      }
      requeryDraft.current = edits;
      const fresh = await refresh();
      if (!fresh) return;
      setReconcileRequired(false);
      if (providerUnavailable) setMessage('سرویس استعلام در دسترس نبود. نتیجه عدم دسترسی ثبت شد؛ وضعیت تازه را بررسی کنید.');
      else setNotice('استعلام انجام شد؛ وضعیت تازه هر چهار بررسی را مرور کنید و فقط برای موارد ناموفق دلیل ثبت کنید.');
    } catch (error) {
      setNeedsFreshChecks(true);
      setMessage(`${providerUnavailable ? 'سرویس استعلام در دسترس نبود و نتیجه آن ثبت شد. ' : ''}درخواست بررسی با وضعیت تازه هماهنگ نشد. ${readableError(error, 'بارگذاری یا ایجاد درخواست تازه انجام نشد. دوباره تلاش کنید.')}`);
    }
  };

  const requery = async () => {
    if (!detail.data || !form || busy) return;
    if (detail.data.status !== 'pending') { setMessage('این درخواست دیگر منتظر بررسی نیست. اطلاعات را تازه‌سازی کنید.'); return; }
    const errors = validateProfile(form, detail.data.currentProfile, 'requery');
    setFieldErrors(errors);
    setReasonErrors({});
    if (Object.keys(errors).length) { setMessage(''); return; }
    setMessage(''); setNotice('');
    setNeedsFreshChecks(true);
    const edits = draftEdits(form, detail.data.currentProfile);
    requeryDraft.current = edits;
    const customerId = detail.data.customerId;
    try {
      const result = await verify.mutateAsync({
        id: customerId,
        data: {
          ...(form.nationalCode.trim() ? { nationalCode: normalizeNumerals(form.nationalCode.trim()) } : {}),
          ...(form.mobile.trim() ? { mobile: normalizeNumerals(form.mobile.trim()) } : {}),
          birthDateJalali: normalizeDate(form.birthDateJalali) || null,
          postalCode: normalizeNumerals(form.postalCode.trim()) || null,
          fatherName: form.fatherName.trim() || null,
        },
      });
      if (result.status === 'verified') {
        await refresh();
        onFinished('استعلام سیستمی موفق بود؛ هویت مشتری تأیید شد.');
      } else {
        await reconcileRequest(customerId, edits);
      }
    } catch (error) {
      // A failed transport may still have completed server-side. Keep the draft,
      // but require a fresh check snapshot before any final approval.
      setNeedsFreshChecks(true);
      if ((error as { status?: number })?.status === 502) {
        await refresh(false);
        await reconcileRequest(customerId, edits, true);
      } else {
        onError(error, 'استعلام سیستمی انجام نشد. اتصال و اطلاعات هویتی را بررسی و دوباره تلاش کنید.');
      }
    }
  };

  const decideCheck = async (key: CheckKey, decision: 'approved' | 'rejected') => {
    if (!detail.data || !form || !decisions || busy) return;
    if (Object.keys(changedValues(form, detail.data.currentProfile)).length) {
      setMessage('برای ثبت اصلاحات پروفایل از تأیید نهایی استفاده کنید؛ تصمیم مستقل برای مشخصات ذخیره‌شده است.');
      return;
    }
    const reason = decisions[key].reason.trim();
    if (!reason) { setReasonErrors(current => ({ ...current, [key]: 'دلیل فارسی تصمیم این بررسی را بنویسید.' })); return; }
    setSavingCheck(true); setMessage(''); setNotice('');
    try {
      const response = await fetch(`/api/manual-verifications/${id}/checks/${key}/decision`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason }),
      });
      const data = await response.json();
      if (!response.ok) throw { status: response.status, data };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListManualVerificationRequestsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetCustomerQueryKey(data.customerId) }),
        queryClient.invalidateQueries({ queryKey: ['/api/customers'] }),
        queryClient.invalidateQueries({ queryKey: ['wizard-customer-refresh', data.customerId] }),
      ]);
      if (data.status === 'approved') onFinished('همهٔ بررسی‌های هویت تأیید شد و مشتری احراز شده است.');
      else {
        await refresh();
        setNotice(decision === 'approved' ? 'این مشخصه تأیید شد؛ نتیجهٔ سایر مشخصه‌ها حفظ شد.' : 'این مشخصه رد شد و قرمز باقی می‌ماند؛ سایر تأییدها حفظ شد.');
      }
    } catch (error) { onError(error, 'ثبت تصمیم این بررسی انجام نشد.'); }
    finally { setSavingCheck(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail.data || !form || !decisions || busy) return;
    if (needsFreshChecks || reconcileRequired || detail.isFetching) { setMessage('نتیجه استعلام یا درخواست فعال هنوز هماهنگ نشده است. ابتدا درخواست تازه را بارگذاری کنید.'); return; }
    if (detail.data.status !== 'pending') { setMessage('این درخواست دیگر منتظر بررسی نیست. اطلاعات را تازه‌سازی کنید.'); return; }
    const errors = validateProfile(form, detail.data.currentProfile, 'approve');
    setFieldErrors(errors);
    const missingReasons: ReasonErrors = {};
    for (const key of checkKeys) {
      if (decisions[key].method !== 'manual') continue;
      if (!decisions[key].reason.trim()) missingReasons[key] = 'ثبت دلیل فارسی برای تأیید دستی این بررسی الزامی است.';
      else if (!/[\u0600-\u06FF]/.test(decisions[key].reason)) missingReasons[key] = 'دلیل این بررسی را به فارسی بنویسید.';
      else if (decisions[key].reason.length > 1000) missingReasons[key] = 'دلیل نباید بیش از ۱۰۰۰ نویسه باشد.';
    }
    setReasonErrors(missingReasons);
    if (Object.keys(errors).length || Object.keys(missingReasons).length) { setMessage(''); return; }
    for (const key of checkKeys) {
      if (decisions[key].method === 'manual' && !detail.data.sourceFailures.includes(key)) {
        setMessage(`«${checkNames[key]}» در درخواست فعلی به‌عنوان بررسی ناموفق ثبت نشده است. استعلام یا درخواست تازه را بارگذاری کنید.`);
        return;
      }
      if (decisions[key].method === 'system' && !detail.data.currentChecks[key].ok) {
        setMessage(`«${checkNames[key]}» هنوز تأیید سیستمی ندارد؛ فقط برای بررسی موفق می‌توانید روش سیستمی را انتخاب کنید.`);
        return;
      }
      if (decisions[key].method === 'manual' && detail.data.currentChecks[key].ok) {
        setMessage(`«${checkNames[key]}» موفق است و باید با روش سیستمی تأیید شود.`);
        return;
      }
    }
    setMessage(''); setNotice('');
    const correctedValues = changedValues(form, detail.data.currentProfile);
    const checks = Object.fromEntries(checkKeys.map(key => [key,
      decisions[key].method === 'manual'
        ? { method: 'manual', reason: decisions[key].reason.trim() }
        : { method: 'system' },
    ])) as ManualVerificationApproval['checks'];
    try {
      await approve.mutateAsync({
        id,
        data: { checks, ...(Object.keys(correctedValues).length ? { correctedValues } : {}) },
      });
      await refresh();
      onFinished('هر چهار بررسی هویت ثبت شد و مشتری به‌طور کامل تأیید شد.');
    } catch (error) { onError(error, 'تأیید نهایی ثبت نشد. اطلاعات اصلاح‌شده و دلایل بررسی دستی را دوباره کنترل کنید.'); }
  };

  const request = detail.data;
  return (
    <Modal title={request?.customerName ? customerNameText(request.customerName, request.customerId) : 'بررسی درخواست هویت'} eyebrow={`پرونده بررسی شماره ${id.toLocaleString('fa-IR')}`} onClose={() => { if (!busy) onClose(); }} testId="manual-verification" wide>
      {detail.isLoading ? <div className="mv-loading" aria-label="در حال دریافت جزئیات"><i /><i /><i /><i /></div> : null}
      {detail.isError ? <div className="mv-feedback" role="alert">{readableError(detail.error, 'دریافت جزئیات درخواست انجام نشد.')} <button type="button" className="btn btn-ghost" onClick={() => detail.refetch()} data-testid="button-retry-manual-detail">تلاش دوباره</button></div> : null}
      {request && form && decisions ? (
        <form onSubmit={submit} dir="rtl" noValidate>
          <div className="mv-dialog-intro">
            <div><strong>درخواست از طرف {request.requestedByName || 'کارشناس فروش'}</strong><br /><span>ثبت‌شده در {formatDateTime(request.createdAt)} · شناسه مشتری {request.customerId.toLocaleString('fa-IR')}</span></div>
            <span className="mv-chip">{request.status === 'pending' ? 'در انتظار تصمیم مدیر' : request.status === 'superseded' ? 'جایگزین‌شده با درخواست تازه' : 'بررسی پایان یافته است'}</span>
          </div>
          {request.status === 'superseded' ? <div className="mv-feedback" role="status" data-testid="status-superseded-manual-verification">این درخواست با نتیجه استعلام تازه جایگزین شده و دیگر قابل تأیید نیست. درخواست فعال مشتری را باز کنید.
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
              const edits = form ? draftEdits(form, request.currentProfile) : {};
              if (latestPendingId && latestPendingId !== id) onReplace({ id: latestPendingId, draft: edits, notice: 'درخواست فعال مشتری باز شد. نتیجه‌های تازه را بررسی کنید.' });
              else void reconcileRequest(request.customerId, edits);
            }} data-testid="button-open-latest-manual-verification">{latestPendingId && latestPendingId !== id ? 'باز کردن درخواست فعال' : 'یافتن درخواست فعال'}</button>
          </div> : null}
          {message ? <div className="mv-feedback" role="alert" data-testid="error-manual-verification">{message}{conflict || needsFreshChecks || reconcileRequired ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setMessage(''); setConflict(false); if (reconcileRequired) void reconcileRequest(request.customerId, form ? draftEdits(form, request.currentProfile) : {}); else void refresh(); }} data-testid="button-refresh-conflict">{reconcileRequired ? 'هماهنگ‌سازی درخواست فعال' : 'بارگذاری وضعیت تازه'}</button> : null}</div> : null}
          {notice ? <div className="mv-feedback success" role="status" data-testid="notice-manual-verification">{notice}</div> : null}
          <section className="mv-section">
            <div className="mv-section-head"><h4>اطلاعات هویتی و پروفایل</h4><small>مقادیر فعلی را با درخواست اولیه مقایسه و در صورت نیاز اصلاح کنید.</small></div>
            <div className="mv-fields">
              {fields.map(({ key, label, placeholder, ltr }) => (
                <div className="mv-field" key={key}>
                  <label htmlFor={`mv-${key}`}>{label}</label>
                  <input id={`mv-${key}`} data-testid={`input-manual-${key}`} value={form[key]} placeholder={placeholder || 'ثبت نشده'} dir={ltr ? 'ltr' : 'rtl'} aria-invalid={Boolean(fieldErrors[key])} aria-describedby={fieldErrors[key] ? `mv-error-${key}` : undefined} disabled={busy || request.status !== 'pending'} onChange={e => { setForm({ ...form, [key]: e.target.value }); setFieldErrors(current => ({ ...current, [key]: undefined })); }} />
                  {fieldErrors[key] ? <span id={`mv-error-${key}`} className="mv-field-error" role="alert" data-testid={`error-manual-${key}`}>{fieldErrors[key]}</span> : null}
                  {valueOf(request.originalValues[key]) && valueOf(request.originalValues[key]) !== valueOf(request.currentProfile[key]) ? <span className="mv-before" title={valueOf(request.originalValues[key])}>درخواست اولیه: {valueOf(request.originalValues[key])}</span> : null}
                </div>
              ))}
            </div>
          </section>
          <section className="mv-section">
            <div className="mv-section-head"><h4>نتیجه چهار بررسی هویت</h4><small>تأیید دستی فقط برای بررسی ناموفق یا دردسترس‌نبودن سرویس مجاز است.</small></div>
            <div className="mv-checks">
              {checkKeys.map(key => {
                const check = request.currentChecks[key];
                return (
                  <div className={`mv-check ${check.ok ? 'ok' : ''}`} key={key} data-testid={`check-manual-${key}`}>
                    <div><div className="mv-check-title">{check.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}{checkNames[key]}</div><div className="mv-check-status"><strong>{check.ok ? check.status === 'manual_verified' ? 'تأیید دستی ثبت شد' : 'موفق' : check.status === 'manual_rejected' ? 'رد شده توسط ادمین' : 'ناموفق / در دسترس نیست'}</strong></div></div>
                    <div className="mv-check-options">
                      <label className={`${decisions[key].method === 'system' ? 'selected' : ''} ${!check.ok ? 'disabled' : ''}`}><input type="radio" name={`method-${key}`} value="system" checked={decisions[key].method === 'system'} disabled={!check.ok || busy || request.status !== 'pending'} onChange={() => { setDecisions({ ...decisions, [key]: { method: 'system', reason: '' } }); setReasonErrors(current => ({ ...current, [key]: undefined })); }} data-testid={`radio-system-${key}`} />تأیید با نتیجه سامانه</label>
                      <label className={`${decisions[key].method === 'manual' ? 'selected' : ''} ${check.ok ? 'disabled' : ''}`}><input type="radio" name={`method-${key}`} value="manual" checked={decisions[key].method === 'manual'} disabled={check.ok || busy || request.status !== 'pending'} onChange={() => { setDecisions({ ...decisions, [key]: { method: 'manual', reason: '' } }); setReasonErrors(current => ({ ...current, [key]: undefined })); }} data-testid={`radio-manual-${key}`} />تأیید دستی</label>
                    </div>
                    {decisions[key].method === 'manual' && !check.ok ? <div className="mv-reason-wrap"><label htmlFor={`mv-reason-${key}`}>دلیل تأیید دستی این بررسی <span aria-hidden="true">*</span></label><textarea id={`mv-reason-${key}`} className="mv-reason" value={decisions[key].reason} maxLength={1000} aria-invalid={Boolean(reasonErrors[key])} aria-describedby={reasonErrors[key] ? `mv-reason-error-${key}` : undefined} disabled={busy || request.status !== 'pending'} placeholder="دلیل بررسی مدارک و تصمیم خود را به فارسی بنویسید…" onChange={e => { setDecisions({ ...decisions, [key]: { method: 'manual', reason: e.target.value } }); setReasonErrors(current => ({ ...current, [key]: undefined })); }} data-testid={`textarea-manual-reason-${key}`} />{reasonErrors[key] ? <span id={`mv-reason-error-${key}`} className="mv-field-error" role="alert" data-testid={`error-manual-reason-${key}`}>{reasonErrors[key]}</span> : null}</div> : null}
                    {!check.ok && request.status === 'pending' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="btn btn-primary" disabled={busy || needsFreshChecks || reconcileRequired} onClick={() => void decideCheck(key, 'approved')} data-testid={`button-approve-check-${key}`}>تأیید همین مشخصه</button>
                      <button type="button" className="btn btn-ghost" disabled={busy || needsFreshChecks || reconcileRequired} onClick={() => void decideCheck(key, 'rejected')} data-testid={`button-reject-check-${key}`}>رد همین مشخصه</button>
                    </div>}
                  </div>
                );
              })}
            </div>
          </section>
          <p className="mv-hint">استعلام دوباره فقط بررسی هویت را از سامانه دریافت می‌کند. اصلاحات پروفایل همراه با تأیید نهایی ذخیره می‌شوند. اعتبارسنجی اعتباری در این مسیر قابل تأیید دستی نیست.</p>
          <div className="mv-actions">
            <div className="mv-actions-right"><button type="submit" className="btn btn-primary" disabled={busy || needsFreshChecks || reconcileRequired || detail.isFetching || request.status !== 'pending'} data-testid="button-approve-manual-verification"><ShieldCheck size={16} />{approve.isPending ? 'در حال ثبت تأیید…' : 'تأیید نهایی هر چهار بررسی'}</button><button type="button" className="btn btn-ghost" onClick={() => void requery()} disabled={busy || request.status !== 'pending'} data-testid="button-requery-manual-verification"><RefreshCw size={15} />{verify.isPending ? 'در حال استعلام…' : 'استعلام دوباره از سامانه'}</button></div>
            <div className="mv-actions-left"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy} data-testid="button-cancel-manual-verification">بستن</button></div>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

export default function ManualVerifications() {
  const list = useListManualVerificationRequests();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [feedback, setFeedback] = useState('');
  const [search, setSearch] = useTableState('manualVerifications.search', '');
  const pending = (list.data ?? []).filter(item => item.status === 'pending');
  const shown = rankExactCustomerId(pending.filter(item => matchesCustomerSearch(search, { id: item.customerId, name: item.customerName, extra: [item.requestedByName] })), search, (item) => item.customerId);
  return (
    <div className="mv-page" dir="rtl">
      <header className="mv-hero"><div><div className="mv-kicker">میز بررسی مدیر · احراز هویت SAPI</div><h2>درخواست‌های بررسی دستی</h2><p>موارد ارجاع‌شده از فروش را بررسی کنید؛ هر چهار استعلام باید پیش از تأیید نهایی تعیین تکلیف شوند.</p></div><div className="mv-hero-count" data-testid="count-pending-verifications"><strong>{pending.length.toLocaleString('fa-IR')}</strong><span>در انتظار بررسی</span></div></header>
      {feedback ? <div className="mv-feedback success" role="status" data-testid="status-manual-verification-success"><Check size={15} style={{ display:'inline', verticalAlign:'middle', marginLeft:6 }} />{feedback}</div> : null}
      <div className="mv-toolbar"><strong>صف بررسی</strong><div className="searchbar"><Search size={15} /><input aria-label="جست‌وجوی درخواست" placeholder="نام یا شناسه مشتری، یا کارشناس" value={search} onChange={e => setSearch(e.target.value)} data-testid="input-search-manual-verifications" /></div></div>
      {list.isLoading ? <div className="mv-loading" aria-label="در حال دریافت درخواست‌ها"><i /><i /><i /><i /></div> : null}
      {list.isError ? <div className="mv-feedback" role="alert" data-testid="error-manual-verifications">{readableError(list.error, 'دریافت فهرست درخواست‌های بررسی دستی انجام نشد.')} <button type="button" className="btn btn-ghost" onClick={() => list.refetch()} data-testid="button-retry-manual-verifications">تلاش دوباره</button></div> : null}
      {!list.isLoading && !list.isError && !shown.length ? <div className="mv-empty" data-testid="empty-manual-verifications"><div className="mv-empty-icon">{search ? <Search size={25} /> : <ShieldCheck size={27} />}</div><strong>{search ? 'درخواستی پیدا نشد' : 'صف بررسی خالی است'}</strong><p>{search ? 'نام یا شناسه دیگری را جست‌وجو کنید.' : 'درخواست جدید فروش پس از ارجاع برای بررسی هویت، اینجا نمایش داده می‌شود.'}</p></div> : null}
      <div className="mv-list">{shown.map((item, index) => (
        <button type="button" className="mv-row" key={item.id} onClick={() => { setFeedback(''); setSelected({ id: item.id }); }} data-testid={`button-open-manual-verification-${item.id}`}>
          <span className="mv-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="mv-row-name"><strong><CustomerName id={item.customerId} name={item.customerName} nameTestId={`text-manual-customer-${item.id}`} /></strong></span>
          <span className="mv-cell"><small>ارجاع از فروش</small><span>{item.requestedByName || 'کارشناس فروش'}</span></span>
          <span className="mv-cell"><small>زمان درخواست</small><span><Clock3 size={12} style={{ display:'inline', verticalAlign:'middle', marginLeft:4 }} />{formatDateTime(item.createdAt)}</span></span>
          <span className="mv-cell"><small>نیازمند بررسی</small><span className="mv-chip">{item.sourceFailures.length.toLocaleString('fa-IR')} مورد ناموفق</span></span>
          <ArrowLeft className="mv-arrow" size={18} />
        </button>
      ))}</div>
      {selected !== null ? <RequestDialog key={selected.id} selection={selected} latestPendingId={list.data?.find(item => item.customerId === (list.data?.find(row => row.id === selected.id)?.customerId) && item.status === 'pending')?.id} onReplace={setSelected} onClose={() => setSelected(null)} onFinished={message => { setSelected(null); setFeedback(message); }} /> : null}
    </div>
  );
}