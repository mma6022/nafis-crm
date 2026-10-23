import { useQuery } from '@tanstack/react-query';
import { Landmark, RefreshCw, FileText } from 'lucide-react';
import { getPublicLoanPlan } from '@workspace/api-client-react';
import { displayPlanTerms, durationPercent } from './plan-display-values';

const n = (v: string | number | null | undefined) => v == null ? '—' : Number(v).toLocaleString('fa-IR');
const digitsOnly = (v: string) => v.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).trim();

export function PlanDetails({ planId, amount, duration }: { planId: number; amount: string; duration: string }) {
  const q = useQuery({ queryKey: ['customer', 'plan-details', planId], queryFn: () => getPublicLoanPlan(planId), staleTime: 60_000 });
  if (q.isLoading) return <section className="cp-card" role="status" aria-label="در حال دریافت"><div className="cp-skeleton" /><div className="cp-skeleton" /></section>;
  if (q.isError || !q.data) return <div className="cp-alert" role="alert">دریافت جزئیات طرح ناموفق بود. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void q.refetch()} data-testid="button-retry-plan-details">تلاش دوباره <RefreshCw size={13} /></button></div>;
  const p = q.data;
  const terms = displayPlanTerms(p);
  const term = duration ? terms.find(t => t.installments === Number(duration)) : undefined;
  const interest = durationPercent(p.annualInterest, Number(duration));
  const raw = digitsOnly(amount);
  const parsedAmount = /^\d+$/.test(raw) ? Number(raw) : null;
  const base = parsedAmount != null && Number.isSafeInteger(parsedAmount) && parsedAmount > 0 ? parsedAmount : null;
  const est = (pct: number | null) => base == null || pct == null ? null : Math.round(base * pct / 100);
  const fmtPct = (v: number | null) => v == null ? 'اعلام نشده' : `${n(v)}٪`;
  const money = (v: number | null) => v == null ? 'اعلام نشده' : `${n(v)} تومان`;
  const requirements = [
    p.customerCheck && !['none', 'false'].includes(p.customerCheck) ? 'چک مشتری طبق شرایط طرح' : null,
    p.needsCustomerPromissory ? 'سفته مشتری' : null,
    p.needsGuarantor ? 'معرفی ضامن' : null,
    p.guarantorCheck && !['none', 'false'].includes(p.guarantorCheck) ? 'چک ضامن طبق شرایط طرح' : null,
    p.needsGuarantorPromissory ? 'سفته ضامن' : null,
    p.needsAccountTurnover ? 'گردش حساب بانکی' : null,
    p.needsAvgBalance ? 'میانگین موجودی حساب' : null,
    p.needsCustomerSalaryDeduct ? 'گواهی کسر از حقوق مشتری' : null,
    p.needsGuarantorSalaryDeduct ? 'گواهی کسر از حقوق ضامن' : null,
  ].filter((label): label is string => Boolean(label));
  return <section className="cp-pd" data-testid={`section-plan-details-${p.id}`}>
    <div className="cp-visual">
      <span className="cp-visual-bank"><Landmark size={15} /> {p.bankName || 'بانک اعلام نشده'}</span>
      <h2>{p.name}</h2>
      {p.platformName && <p>{p.platformName}</p>}
      <dl><div><dt>مبلغ تسهیلات</dt><dd>{p.principalAmount && /^\d+$/.test(p.principalAmount) ? `${n(p.principalAmount)} تومان` : 'طبق شرایط طرح'}</dd></div>
        <div><dt>سود سالانه</dt><dd>{fmtPct(interest)}</dd></div>
        <div><dt>اقساط</dt><dd>{terms.length ? `${terms.map(t => n(t.installments)).join('، ')} ماه` : 'اعلام نشده'}</dd></div></dl>
    </div>
    <div className="cp-card cp-pd-body">
      {requirements.length > 0 && <div><h3>شرایط و ضمانت‌های طرح</h3>
        <ul className="cp-pd-requirements">{requirements.map(label => <li key={label}><FileText size={18} /><span>{label}</span></li>)}</ul>
        <p className="cp-hint">شرایط عمومی طرح است؛ شرط انتخاب‌شده در فرم درخواست نیز باید رعایت شود.</p>
      </div>}
      {p.notes && <div><h3>توضیحات طرح</h3><p style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</p></div>}
      <div><h3>مدارک مورد نیاز</h3>
        {p.requiredDocuments?.length ? <ul className="cp-pd-list">{p.requiredDocuments.map((d, i) => <li key={i}><FileText size={14} /> {d}</li>)}</ul> : <p>مدرک خاصی ثبت نشده است.</p>}</div>
      <div><h3>شرایط اقساط بر اساس مدت</h3>
        {terms.length ? <div className="cp-pd-table"><table><thead><tr><th>مدت</th><th>پیش‌پرداخت</th><th>کسورات</th><th>سپرده</th></tr></thead><tbody>
          {terms.map(t => <tr key={t.installments} aria-current={term === t ? 'true' : undefined} className={term === t ? 'on' : ''}><td>{n(t.installments)} ماه</td><td>{fmtPct(t.prepaymentPercent)}</td><td>{fmtPct(t.deductionPercent)}</td><td>{fmtPct(t.depositPercent)}</td></tr>)}
        </tbody></table></div> : <p>شرایط اقساط ثبت نشده است.</p>}
      </div>
      <div><h3>محاسبه تقریبی</h3>
        {term && base != null ? <><p className="cp-hint">برآورد اولیه نمایشی برای {n(base)} تومان و {n(term.installments)} ماه، فقط بر پایه درصدهای همین مدت. مبلغ نهایی را سامانه تعیین می‌کند و هزینه تشکیل پرونده جدا از این درصدها محاسبه می‌شود.</p>
          <dl className="cp-dl"><div><dt>پیش‌پرداخت ({fmtPct(term.prepaymentPercent)})</dt><dd>{money(est(term.prepaymentPercent))}</dd></div>
            <div><dt>کسورات ({fmtPct(term.deductionPercent)})</dt><dd>{money(est(term.deductionPercent))}</dd></div>
            <div><dt>سپرده ({fmtPct(term.depositPercent)})</dt><dd>{money(est(term.depositPercent))}</dd></div></dl></>
          : <p className="cp-hint">برای دیدن برآورد اولیه، مبلغ و مدت را در بخش شرایط درخواست وارد کنید.</p>}
      </div>
    </div>
  </section>;
}
