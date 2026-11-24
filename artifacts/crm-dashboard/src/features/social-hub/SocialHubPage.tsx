/* social-hub v1.1 §ب «مدیریت فروش شبکه‌های اجتماعی». Managers only, only while flag.social_hub_v1 is ON. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { shApi, useShMe, type ShPlan } from './api';
import { useShToast } from './ui';
import { BotsTab } from './Bots';
import { MessagesTab } from './Messages';
import { DocsTab } from './Docs';
import { AccessPage } from './Access';
import './social-hub.css';

const TABS = [['bots', 'ربات‌ها'], ['msgs', 'پیام‌های آماده'], ['docs', 'آموزش‌ها و مستندات']] as const;
export function SocialHubPage() {
  const me = useShMe(); const { toast, node } = useShToast();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(() => (new URLSearchParams(window.location.search).get('tab') as any) || 'bots');
  const plans = useQuery<{ plans: ShPlan[] }>({ queryKey: ['sh-plans'], queryFn: () => shApi('/plans'), retry: false, enabled: Boolean(me.data?.manager) });
  if (me.isLoading) return null;
  if (!me.data?.enabled || !me.data.manager) return <div className="sh sh-page" dir="rtl"><p className="sh-sub">این بخش در دسترس نیست.</p></div>;
  return <div className="sh sh-page" dir="rtl" data-testid="sh-page">
    <div className="sh-tabs" role="tablist">{TABS.map(([k, l]) => <button type="button" role="tab" aria-selected={tab === k} key={k} className={`sh-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)} data-testid={`sh-tab-${k}`}>{l}</button>)}</div>
    <div role="tabpanel" style={{ marginTop: 20 }}>
      {tab === 'bots' ? <BotsTab toast={toast} /> : tab === 'msgs' ? <MessagesTab toast={toast} /> : <DocsTab plans={plans.data?.plans ?? []} toast={toast} />}
    </div>
    {node}
  </div>;
}
export function SocialHubAccessRoute({ params }: { params: { id: string } }) {
  const me = useShMe();
  if (me.isLoading) return null;
  if (!me.data?.enabled || !me.data.manager) return <div className="sh sh-page" dir="rtl"><p className="sh-sub">این بخش در دسترس نیست.</p></div>;
  return <AccessPage botId={Number(params.id)} />;
}
