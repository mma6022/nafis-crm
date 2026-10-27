import { ChevronLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { customerAnnotations, faDate } from './api';

/** «یادداشت‌های اینستاگرام» on the customer page (owner / admin). Hidden when empty. */
export function CustomerAnnotations({ customerId }: { customerId: number }) {
  const q = useQuery({ queryKey: ['customer-annotations', customerId], queryFn: () => customerAnnotations(customerId), retry: false, staleTime: 30_000 });
  const rows = q.data?.items ?? [];
  if (!rows.length) return null;
  return (
    <details className="csx-sub" data-testid="section-annotations" open><summary>یادداشت‌های {rows[0].label} ({rows.length.toLocaleString('fa-IR')}) <ChevronLeft size={16} /></summary>
      <ul className="la-notes">
        {rows.map((r) => <li key={r.id}><span className="la-chip">{r.label}</span><p>{r.body}</p><small className="muted">{r.actorLabel} · {faDate(r.createdAt)}</small></li>)}
      </ul>
    </details>
  );
}
