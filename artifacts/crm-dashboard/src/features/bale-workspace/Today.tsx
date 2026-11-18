/* «فضای کار بله» ه‍ + و — on the open customer card of «کارهای امروز من»: «دعوت به بله» (Bale + SMS) and «ارسال شرایط طرح» when a Bale chat is linked.
   Renders nothing while flag.bale_workspace_v1 is OFF (one /me request, cached) or for a customer the viewer may not invite (server: own customer or manager). */
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
import { useToast } from '@/features/bale-bot/ui';
import { InviteButton } from './Invite';
import { StarMark } from './Stars';
import { useBwsMe, type BwsInvite } from './api';
import './bale-workspace.css';

export function BwsTodayBox({ customerId }: { customerId: number }) {
  const me = useBwsMe();
  const b = useQuery<{ chatId: number | null; invites: BwsInvite[]; stars: number } | null>({ queryKey: ['bws-brief', customerId], enabled: !!me.data, retry: false, staleTime: 15_000,
    queryFn: () => bbFetch<{ chatId: number | null; invites: BwsInvite[]; stars: number }>(`/bale-workspace/customers/${customerId}/brief`).catch(() => null) });
  const { toast, node } = useToast();
  if (!me.data || !b.data) return null;
  return <section className="bws-today" aria-label="بله" data-testid="bws-today">
    <div className="hd"><b>بله</b><StarMark n={b.data.stars} small /><span className="sp" />
      {b.data.chatId ? <Link className="bws-btn sec" href={`/bale-bot/${b.data.chatId}?bws=plans`} data-testid="bws-today-plans">ارسال شرایط طرح</Link> : null}</div>
    <InviteButton key={customerId} path={`/bale-workspace/customers/${customerId}/invite`} last={b.data.invites[0] ?? null} toast={toast} onDone={() => void b.refetch()} />
    {node}
  </section>;
}
