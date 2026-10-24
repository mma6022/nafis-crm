/** Dashboard card «کیف پول من»: balance, posted this month, pending count. Replaces «پورسانت فروش من». */
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Wallet } from 'lucide-react';
import { staffWalletApi } from './api';
import { WalletError, WalletHero } from './StaffWallet';
import './nfk.css';
import './staff-wallet.css';

export function WalletDashboardCard({ salespersonId }: { salespersonId: number }) {
  const q = useQuery({ queryKey: ['staff-wallet', salespersonId, null, 'dash'], queryFn: () => staffWalletApi.wallet({ salespersonId }), staleTime: 30_000, retry: 1 });
  return <section className="nfk sw-wid" style={{ marginBottom: 16 }} aria-label="کیف پول من">
    <header><h2><Wallet className="i" />کیف پول من</h2><Link href="/my-wallet">باز کردن<ChevronLeft className="i s" /></Link></header>
    <div className="sw">
      {q.data ? <WalletHero d={{ ...q.data, viewer: 'self' }} admin={false} />
        : q.isError ? <WalletError onRetry={() => q.refetch()} />
          : <><div className="sk" style={{ height: 130 }} /><div className="sk" style={{ height: 90 }} /></>}
    </div>
  </section>;
}
