/** Team builder (flag.multi_team_v1). Admin + sales_manager edit; experts see their own team read-only. */
import { useEffect, useRef } from 'react';
import { useGetAuthSession } from '@workspace/api-client-react';
import { useSalesTeamsMe } from './api';
import { mountSalesTeams, type Me } from './sales-teams-ui';
import './sales-teams.css';

export default function SalesTeamsPage() {
  const session = useGetAuthSession({ query: { retry: false } });
  const me = useSalesTeamsMe(Boolean(session.data?.user));
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    const data = me.data;
    if (!el || !data?.enabled) return;
    const stop = mountSalesTeams({ root: el, me: data as Me, chrome: false });
    return () => stop();
  }, [me.data]);

  if (me.isError && (me.error as { status?: number })?.status === 404) {
    return <section className="data-page"><p>این صفحه فعال نیست.</p></section>;
  }
  if (me.data && me.data.enabled === true && me.data.canView === false && me.data.canManage === false) {
    return <section className="data-page"><p>فقط تیم خودتان را می‌بینید. شما هنوز در تیمی نیستید.</p></section>;
  }
  return <div ref={root} className="st-root" dir="rtl" lang="fa" />;
}
