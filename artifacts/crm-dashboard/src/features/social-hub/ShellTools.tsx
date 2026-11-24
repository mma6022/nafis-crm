/* social-hub v1.1 (Armita build-r1 §1): compact 390 top bar, ONLY while flag.social_hub_v1 is ON (CrmShell passes shCompact).
   Search and «گزارش خطا» leave the bar and live in «منو» / «بیشتر». Flag OFF → nothing here renders and the live bar is unchanged. */
import { Bug, Search } from 'lucide-react';
import { openSfSearch } from '@/features/sales-fixes/api';
import { useDiagnostics } from '@/diagnostics/DiagnosticsProvider';
import './social-hub.css';

/** Short 390 titles for the social-hub pages; null elsewhere (live title). */
export function shMobileTitle(location: string): string | null {
  const p = location.split('?')[0];
  if (/^\/social-hub\/bots\/\d+\/access/.test(p)) return 'دسترسی ربات';
  if (p === '/social-hub' || p.startsWith('/social-hub/')) return 'شبکه‌های اجتماعی';
  return null;
}
export function ShDrawerTools({ search, onPick }: { search: boolean; onPick: () => void }) {
  const diag = useDiagnostics();
  if (!search && !diag) return null;
  return <div className="sh-dtools" role="group" aria-label="ابزارها" data-testid="sh-drawer-tools">
    {search ? <button type="button" className="side-link" onClick={() => { onPick(); openSfSearch(); }} data-testid="sh-drawer-search"><Search aria-hidden="true" /><span>جست‌وجو</span></button> : null}
    {diag ? <button type="button" className="side-link" onClick={() => { onPick(); diag.open(); }} data-testid="sh-drawer-diag"><Bug aria-hidden="true" /><span>گزارش خطا</span></button> : null}
  </div>;
}
