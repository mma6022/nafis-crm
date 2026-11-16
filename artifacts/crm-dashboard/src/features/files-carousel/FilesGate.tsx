/** Route gate for /loan-applications: users 8/2/3 with flag.files_carousel=1 get the one-card view; everyone else renders the old page untouched (no extra fetch). */
import type { ReactNode } from 'react';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { FC_USERS, useFcConfig } from './api';
import FilesCarousel from './FilesCarousel';
import { useTodaySplit } from '@/features/today-split/api';
import FilesLockGate from '@/features/today-split/FilesLock';
import { useSf480 } from '@/features/sales-fixes/api';
import CasesKanban from '@/features/sales-fixes/CasesKanban';

export default function FilesGate({ children }: { children: ReactNode }) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const u = session?.user as { id?: number; role?: string } | undefined;
  const target = u?.id != null && FC_USERS[Number(u.id)] != null && u.role === 'salesperson';
  const cfg = useFcConfig(target ? Number(u!.id) : null);
  // FILES-LOCK (stage 2): only users whose own flag.files_lock is on (the /split answer carries the key only then).
  const ts = useTodaySplit(target ? Number(u!.id) : null, u?.role);
  // SALES-FIXES 480000 (t810u): sales experts get «پرونده‌های من» as a status kanban at any step (no files lock / board turn); flag.sf480_open_lists = '0' → old gate.
  const sf = useSf480(u?.role);
  if (u?.role === 'salesperson' && sf.openLists) return <CasesKanban />;
  if (u?.role === 'salesperson' && !sf.ready) return <div className="dp-page"><div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div></div>;
  if (!target) return <>{children}</>;
  if (cfg.isLoading || ts.isLoading) return <div className="dp-page"><div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div></div>;
  if (cfg.data?.enabled) return ts.data?.filesLock ? <FilesLockGate board={ts.data.filesBoard} /> : <FilesCarousel />;
  return <>{children}</>;
}
