/* t979 v1.1 — the three tabs with their counters; the same strip on every surface. */
import './quick-replies.css';
import { QR_TABS, fdig, type QrTab } from './model';

export function TabBar({ value, counts, onChange, label = 'نوع پیام', sm = false }: { value: QrTab; counts: Record<QrTab, number>; onChange: (t: QrTab) => void; label?: string; sm?: boolean }) {
  return <div className={`qr-tabs${sm ? ' sm' : ''}`} role="tablist" aria-label={label} data-testid="qr-tabs">
    {QR_TABS.map((t) => <button key={t.id} type="button" role="tab" id={`qr-tab-${t.id}`} className={`qr-tab${value === t.id ? ' on' : ''}`} aria-selected={value === t.id}
      onClick={() => onChange(t.id)} data-tab={t.id}>{t.label}<span className="qr-cnt" aria-label={`${fdig(counts[t.id])} پیام`}>{fdig(counts[t.id])}</span></button>)}
  </div>;
}
