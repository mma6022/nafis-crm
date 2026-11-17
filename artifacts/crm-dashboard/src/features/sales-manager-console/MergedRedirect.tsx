// Wraps an old settings route. Only when /api/sales-admin/me answers merged=true (flag.sales_admin_merge_v12 ON, user may manage) does it replace
// the URL with the anchor on /sales-admin. While loading, on 404 (flag OFF) or 403 (expert, lead) it renders the old page untouched.
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { useSmcMe } from './api';
import { mergedTarget } from './merge-routes';

export function MergedRedirect({ children }: { children: ReactNode }) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session?.user;
  const [loc, setLoc] = useLocation();
  const me = useSmcMe(Boolean(user && user.role === 'admin')).data;
  const target = me?.merged && me.canManage ? mergedTarget(loc, window.location.search, window.location.hash, { bale: Boolean(me.bale) }) : null;
  useEffect(() => { if (target) setLoc(target, { replace: true }); }, [target, setLoc]);
  if (target) return null;
  return <>{children}</>;
}
/** /sales-admin itself: only while merged; otherwise the same «not found» as any unknown path today. */
export function SalesAdminGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = session?.user;
  const q = useSmcMe(Boolean(user && user.role === 'admin'));
  if (q.isLoading) return null;
  return <>{q.data?.merged ? children : fallback}</>;
}
