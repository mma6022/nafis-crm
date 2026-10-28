/** Route gate for /loan-applications: users 8/2/3 with flag.files_carousel=1 get the one-card view; everyone else renders the old page untouched (no extra fetch). */
import type { ReactNode } from 'react';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { FC_USERS, useFcConfig } from './api';
import FilesCarousel from './FilesCarousel';

export default function FilesGate({ children }: { children: ReactNode }) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const u = session?.user as { id?: number; role?: string } | undefined;
  const target = u?.id != null && FC_USERS[Number(u.id)] != null && u.role === 'salesperson';
  const cfg = useFcConfig(target ? Number(u!.id) : null);
  if (!target) return <>{children}</>;
  if (cfg.isLoading) return <div className="dp-page"><div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div></div>;
  if (cfg.data?.enabled) return <FilesCarousel />;
  return <>{children}</>;
}
