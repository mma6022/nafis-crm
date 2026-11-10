/* Gate: designed KB/keys/bots admin when flag.customer_bale_admin is ON; otherwise the expert-bot connect page. */
import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useBaleBotMe } from './api';
import BaleBotAdmin from './BaleBotAdmin';
import CustomerBotKbAdmin, { DesignedNoAccess } from '../customer-bale/CustomerBotKbAdmin';

export default function BaleBotAdminPage() {
  const meQ = useBaleBotMe(); const me = meQ.data; const [, nav] = useLocation();
  useEffect(() => { document.title = 'ربات‌های بله | نفیس وام'; }, []);
  if (meQ.isLoading) return <div className="bbt" dir="rtl"><main className="pg bbpg"><span className="bbsk" /></main></div>;
  if (!me) { nav('/'); return null; }
  if (me.customerBot?.admin) {
    if (!me.canManage) return <DesignedNoAccess />;
    return <CustomerBotKbAdmin />;
  }
  return <BaleBotAdmin />;
}
