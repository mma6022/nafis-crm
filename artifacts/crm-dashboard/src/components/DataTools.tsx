import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

export function SearchField({ value, onChange, placeholder, testId }: { value: string; onChange: (value: string) => void; placeholder: string; testId: string }) {
  return <label className="searchbar" data-testid={`searchbar-${testId}`}><Search size={16} /><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} data-testid={`input-${testId}`} /></label>;
}

export function Modal({ title, eyebrow, onClose, children, testId }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; testId: string }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={`modal-${testId}`}><div className="modal-head"><div>{eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}<h3 id={`${testId}-title`}>{title}</h3></div><button className="modal-close" onClick={onClose} aria-label="بستن" data-testid={`button-close-${testId}`}><X size={19} /></button></div>{children}</div></div>;
}

export function Pagination({ total, offset, limit, onChange, testId }: { total: number; offset: number; limit: number; onChange: (offset: number) => void; testId: string }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return <div className="pagination"><span data-testid={`text-pagination-${testId}`}>صفحه {page.toLocaleString('fa-IR')} از {pages.toLocaleString('fa-IR')} · {total.toLocaleString('fa-IR')} مورد</span><div className="pagination-actions"><button className="page-btn" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))} aria-label="صفحه قبل" data-testid={`button-prev-${testId}`}><ChevronRight size={15} /></button><button className="page-btn" disabled={page >= pages} onClick={() => onChange(offset + limit)} aria-label="صفحه بعد" data-testid={`button-next-${testId}`}><ChevronLeft size={15} /></button></div></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state" data-testid="status-empty"><Search /><strong>{title}</strong><p>{description}</p></div>;
}