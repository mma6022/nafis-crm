import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { RefreshCw } from 'lucide-react';
import { listPublicLoanPlans } from '@workspace/api-client-react';
import { PlanCarousel } from './PlanCarousel';
import { PlanRequirements } from './PlanRequirements';
import { PlanCalculator } from './PlanCalculator';

export function useCatalog() { return useQuery({ queryKey: ['customer', 'catalog'], queryFn: () => listPublicLoanPlans(), staleTime: 60_000 }); }

export function LoanPlanCards() {
  const options = useCatalog();
  const [active, setActive] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  const recommendedId = Number(new URLSearchParams(window.location.search).get('planId'));
  const first = options.data?.find(p => p.id === recommendedId)?.id ?? options.data?.[0]?.id ?? null;
  useEffect(() => { if (first != null && !options.data?.some(p => p.id === active)) setActive(first); }, [first, options.data, active]);
  const reset = () => { setAmount(''); setDuration(''); };
  if (options.isLoading) return <div role="status" aria-label="در حال دریافت">{[0, 1].map(i => <div className="cp-skeleton" key={i} />)}</div>;
  if (options.isError) return <div className="cp-alert" role="alert">{options.error instanceof Error ? options.error.message : 'دریافت طرح‌ها ناموفق بود.'} <button type="button" className="cp-btn cp-btn-outline cp-btn-small" onClick={() => void options.refetch()} data-testid="button-retry-plans">تلاش دوباره <RefreshCw size={13} /></button></div>;
  if (!options.data?.length) return <div className="cp-empty"><strong>طرحی فعال نیست</strong><p>در حال حاضر طرحی برای نمایش وجود ندارد.</p></div>;
  return <div className="cp-stack" style={{ marginTop: 12 }}>
    <PlanCarousel plans={options.data} activeId={active} onSelect={id => { if (id !== active) { setActive(id); reset(); } }} />
    {active != null && <>
      <PlanRequirements key={`r${active}`} planId={active} />
      <PlanCalculator key={`c${active}`} planId={active} amount={amount} duration={duration} onAmount={setAmount} onDuration={setDuration} />
      <div className="nfp-ap-cta"><Link href={`/customer/apply?planId=${active}`} className="nf-btn nf-btn--primary nf-btn--block" data-testid="link-request-plan">درخواست این طرح</Link></div>
    </>}
  </div>;
}
