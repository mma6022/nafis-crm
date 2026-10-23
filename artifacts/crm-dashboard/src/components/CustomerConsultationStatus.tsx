import { ClipboardList } from 'lucide-react';
import { getListConsultationsQueryKey, getListConsultOptionsQueryKey, useListConsultations, useListConsultOptions, type ListConsultationsParams } from '@workspace/api-client-react';

export const isYesValue = (value: string) => ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
const FALLBACK = 'ثبت نشده';
const card: React.CSSProperties = { border: '1px solid #dbe2ee', borderRadius: 12, background: '#fff', padding: 16, marginBottom: 16 };
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 800, color: 'var(--nafiss-blue)', margin: '0 0 8px' };

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  const missing = value === FALLBACK;
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px dashed #e2e8f0', fontSize: 12 }}>
    <span style={{ color: '#64748b' }}>{label}</span>
    <strong data-testid={testId} style={{ color: missing ? '#94a3b8' : 'var(--ink-deep)', fontWeight: missing ? 500 : 700 }}>{value}</strong>
  </div>;
}

export function CustomerConsultationStatus({ customerId }: { customerId?: number }) {
  const params: ListConsultationsParams = { customerId, limit: 1 };
  const query = useListConsultations(params, { query: { queryKey: getListConsultationsQueryKey(params), enabled: !!customerId, staleTime: 0 } });
  const options = useListConsultOptions(undefined, { query: { queryKey: getListConsultOptionsQueryKey(), staleTime: 0 } });
  if (!customerId) return null;
  const head = <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><ClipboardList size={16} color="var(--nafiss-blue)" /><strong style={{ fontSize: 13, color: 'var(--ink-deep)' }}>آخرین وضعیت مشاوره مشتری</strong></div>;
  if (query.isLoading || options.isLoading) return <div style={card} role="status" data-testid="status-consultation-loading">{head}<div style={{ height: 70, borderRadius: 8, background: '#eef2f7' }} /></div>;
  if (query.isError || options.isError) return <div style={card} role="alert" data-testid="status-consultation-error">{head}<p style={{ margin: '0 0 8px', fontSize: 12, color: '#be123c' }}>دریافت وضعیت مشاوره انجام نشد.</p><button type="button" className="btn btn-ghost" onClick={() => { void query.refetch(); void options.refetch(); }}>تلاش دوباره</button></div>;
  const c = query.data?.items?.[0] ?? null;
  if (!c) return <div style={card} data-testid="status-consultation-none">{head}<p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>برای این مشتری هنوز مشاوره‌ای ثبت نشده است.</p></div>;
  const opts = options.data ?? [];
  const label = (key: string, value?: string | null) => value ? (opts.find((o) => o.fieldKey === key && o.value === value)?.labelFa ?? value) : FALLBACK;
  const yesNo = (key: string, v?: boolean | null) => v == null ? FALLBACK : (opts.find((o) => o.fieldKey === key && isYesValue(o.value) === v)?.labelFa ?? FALLBACK);
  const date = c.createdAt ?? c.updatedAt;
  const hasG = c.hasGuarantor;
  const gRow = (l: string, v: string, id: string) => <Row label={l} value={hasG === false ? 'بدون ضامن' : v} testId={id} />;
  return <div style={card} data-testid="status-consultation">
    {head}
    <p style={{ margin: '0 0 12px', fontSize: 11, color: '#64748b', lineHeight: 1.9 }}>
      ثبت‌شده در {date ? new Date(date).toLocaleDateString('fa-IR') : FALLBACK} · شناسه مشاوره #{c.id.toLocaleString('fa-IR')}
      <br />رتبه این مشاوره صرفاً اظهار کارشناس و راهنماست؛ تأیید رتبه اعتباری نیست.
    </p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
      <div><h4 style={sectionTitle}>متقاضی</h4>
        <Row label="رتبه اعتباری (اظهاری)" value={label('credit_rank', c.creditRank)} testId="text-status-credit-rank" />
        <Row label="وضعیت چک" value={label('customer_check_status', c.customerCheckStatus)} testId="text-status-check" />
        <Row label="کسر از حقوق" value={yesNo('has_customer_salary_deduct', c.hasCustomerSalaryDeduct)} testId="text-status-salary" />
        <Row label="شغل" value={label('job_type', c.jobType)} testId="text-status-job" />
      </div>
      <div><h4 style={sectionTitle}>ضامن</h4>
        <Row label="ضامن دارد" value={yesNo('has_guarantor', c.hasGuarantor)} testId="text-status-has-guarantor" />
        {gRow('رتبه اعتباری ضامن (اظهاری)', label('guarantor_credit_rank', c.guarantorCreditRank), 'text-status-guarantor-credit-rank')}
        {gRow('وضعیت چک ضامن', label('guarantor_check_type', c.guarantorCheckType), 'text-status-guarantor-check')}
        {gRow('کسر از حقوق ضامن', yesNo('has_guarantor_salary_deduct', c.hasGuarantorSalaryDeduct), 'text-status-guarantor-salary')}
      </div>
    </div>
  </div>;
}
