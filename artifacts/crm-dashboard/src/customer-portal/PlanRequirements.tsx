import { useQuery } from '@tanstack/react-query';
import { FileText, RefreshCw } from 'lucide-react';
import { publicPlansApi } from './api';

const LABELS: Record<string, string> = {
  national_card: 'کارت ملی', birth_certificate_all_pages: 'شناسنامه (تمام صفحات)', employment_proof: 'مدرک اشتغال به کار',
  residence_proof: 'مدرک محل سکونت', juale_contract: 'قرارداد جعاله', guarantee_check: 'چک تضمین',
  guarantee_promissory: 'سفته تضمین', account_turnover_3_months: 'گردش حساب ۳ ماهه', account_turnover_6_months: 'گردش حساب ۶ ماهه',
  average_balance_3_months: 'میانگین موجودی ۳ ماهه', average_balance_6_months: 'میانگین موجودی ۶ ماهه',
  national_card_front: 'کارت ملی (روی کارت)', national_card_back: 'کارت ملی (پشت کارت)',
  birth_certificate_first_page: 'شناسنامه (صفحه اول)', birth_certificate_second_page: 'شناسنامه (صفحه دوم)', birth_certificate_last_page: 'شناسنامه (صفحه آخر)',
};
export const UNKNOWN_DOCUMENT_LABEL = 'نام فارسی مدرک ثبت نشده';
export function documentDisplayLabel(value: unknown): string {
  const text = String(value ?? '').trim();
  if (/[\u0600-\u06FF]/.test(text)) return text;
  return LABELS[text.toLowerCase().replace(/[\s-]+/g, '_')] ?? UNKNOWN_DOCUMENT_LABEL;
}

export function PlanRequirements({ planId }: { planId: number }) {
  const q = useQuery({ queryKey: ['customer', 'plan-documents', planId], queryFn: () => publicPlansApi.documents(planId), staleTime: 60_000 });
  if (q.isLoading) return <section className="cp-card" role="status" aria-label="در حال دریافت"><div className="cp-skeleton" /></section>;
  if (q.isError || !q.data) return <div className="cp-alert" role="alert">دریافت مدارک طرح ناموفق بود. <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void q.refetch()} data-testid="button-retry-plan-details">تلاش دوباره <RefreshCw size={13} /></button></div>;
  const docs = (q.data.requiredDocuments ?? []).map(documentDisplayLabel);
  return <section className="cp-card cp-pd-body" data-testid={`section-plan-details-${q.data.id}`}>
    <div><h3>مدارک لازم برای درخواست</h3>
      {docs.length ? <ul className="cp-pd-list">{docs.map((d, i) => <li key={i} data-testid={`text-required-document-${i}`}><FileText size={14} /> {d}</li>)}</ul> : <p>مدرک خاصی ثبت نشده است.</p>}</div>
  </section>;
}
