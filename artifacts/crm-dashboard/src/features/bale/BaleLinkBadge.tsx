import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { baleFetch, baleWhen, METHOD_LABEL, type BaleMatchMethod } from './api';
import './bale.css';

type R = { linked: boolean; link: null | { id: number; method: BaleMatchMethod; linkedAt: string; expertName: string | null } };
/** «متصل به بله» on the customer profile hero: shown only when an active customer_bale_links row exists (own customers / admin). */
export function BaleLinkBadge({ customerId }: { customerId: number }) {
  const q = useQuery({ queryKey: ['bale', 'customer-link', customerId], queryFn: () => baleFetch<R>(`/bale/customers/${customerId}/link`), retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  const l = q.data?.linked ? q.data.link : null;
  if (!l) return null;
  const title = `از «اسکن بله» (${METHOD_LABEL[l.method]})${l.expertName ? ` — ${l.expertName}` : ''}، ${baleWhen(l.linkedAt)}`;
  return <span className="bl-linked-badge" title={title} data-testid="badge-bale-linked"><Link2 size={13} aria-hidden="true" /> متصل به بله</span>;
}
