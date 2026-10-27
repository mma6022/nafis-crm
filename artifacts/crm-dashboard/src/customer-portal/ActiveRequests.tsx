import type { Application } from './api';
import { RequestCard } from './PortalUi';

/** Request cards of the redesigned portal (handoff §3): plan, status pill, مبلغ واریزی, مبلغ قسط, phase bar, next to-do. */
export function ActiveRequestList({ items, limit, grid }: { items: Application[]; limit?: number; grid?: boolean }) {
  const visible = limit ? items.slice(0, limit) : items;
  return <div className={`nfp-stack${grid ? ' nfp-rq-grid' : ''}`}>{visible.map(app => <RequestCard app={app} key={app.id} />)}</div>;
}
