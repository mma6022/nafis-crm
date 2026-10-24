import { useState } from 'react';
import { useListCreditRankOverrides, getListCreditRankOverridesQueryKey } from '@workspace/api-client-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { CreditRankOverrideRows } from '@/components/loan-applications/CreditRankOverrideLog';

const PAGE_SIZE = 100;

export default function CreditRankOverrides() {
  const [offset, setOffset] = useState(0);
  const params = { limit: PAGE_SIZE, offset };
  const query = useListCreditRankOverrides(params, { query: { queryKey: getListCreditRankOverridesQueryKey(params), staleTime: 30_000 } });
  const items = query.data?.items ?? [];
  return (
    <section className="data-page" data-testid="credit-rank-overrides-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">وام و قرارداد</div>
          <h2>نادیده گرفتن رتبه</h2>
          <p>هر بار که کارشناس یا مدیر رتبهٔ اعتباری را نادیده گرفته، با دلیل نوشته‌شده اینجا ثبت می‌شود. جدیدترین‌ها بالا هستند.</p>
        </div>
      </div>
      {query.isLoading ? <SkeletonPanel rows={6} /> : query.isError ? <ErrorState onRetry={() => void query.refetch()} /> : (
        <div className="panel">
          {items.length === 0 ? <div className="empty-state compact">هنوز موردی ثبت نشده است.</div> : <CreditRankOverrideRows items={items} />}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="csx-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>جدیدتر</button>
            <button type="button" className="csx-ghost" disabled={items.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>قدیمی‌تر</button>
          </div>
        </div>
      )}
    </section>
  );
}
