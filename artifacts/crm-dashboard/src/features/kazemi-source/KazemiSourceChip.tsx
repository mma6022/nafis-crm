import { ArrowLeftRight, UserCheck } from 'lucide-react';
import './kazemi-source.css';

/** crm-kazemi-source: server-provided label (display only). null / missing = no chip (Kazemi's own, unassigned). */
export type KazemiSource = {
  kind: 'from_kazemi' | 'previous';
  handoffAt: string | null;
  mechanism: 'qualifier_form' | 'promote' | 'customer_update' | 'other' | null;
  handoffToSalespersonId: number | null;
  returned: boolean;
};

export const kazemiSourceOf = (c: unknown): KazemiSource | null => {
  const v = (c as { kazemiSource?: KazemiSource | null } | null)?.kazemiSource;
  return v && (v.kind === 'from_kazemi' || v.kind === 'previous') ? v : null;
};

export const KAZEMI_SOURCE_FILTERS = [
  ['', 'همه'],
  ['from_kazemi', 'از کاظمی'],
  ['previous', 'مشتری قبلی'],
] as const;

const MECHANISM: Record<string, string> = {
  qualifier_form: 'اولویت ۱ خودکار از فرم تماس اول',
  promote: 'ارتقای دستی به اولویت ۱',
  customer_update: 'تغییر کارشناس در پرونده',
  other: 'واگذاری',
};

function faDate(iso: string | null, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    timeZone: 'Asia/Tehran', month: 'long', day: 'numeric',
    ...(withTime ? { year: 'numeric', hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export function KazemiSourceChip({ source, size = 'sm', testId }: { source: KazemiSource | null; size?: 'sm' | 'lg'; testId?: string }) {
  if (!source) return null;
  if (source.kind === 'previous') {
    return <span className={`kzs is-prev${size === 'lg' ? ' is-lg' : ''}`} title="این مشتری از قبل با همین کارشناس بوده و از کاظمی منتقل نشده است" data-testid={testId} data-kind="previous">
      <UserCheck size={size === 'lg' ? 15 : 13} aria-hidden="true" /><span>مشتری قبلی</span>
    </span>;
  }
  const date = faDate(source.handoffAt);
  const title = [`تحویل از کاظمی: ${faDate(source.handoffAt, true)}`, source.mechanism ? MECHANISM[source.mechanism] : null,
    source.returned ? 'پیش از کاظمی هم مشتری همین کارشناس بوده و برگشته است' : null].filter(Boolean).join(' — ');
  return <span className={`kzs is-kz${size === 'lg' ? ' is-lg' : ''}`} title={title} aria-label={title} data-testid={testId} data-kind="from_kazemi" data-returned={source.returned ? '1' : undefined}>
    <ArrowLeftRight size={size === 'lg' ? 15 : 13} aria-hidden="true" /><span>از کاظمی</span>{date ? <span className="kzs-date">{date}</span> : null}
  </span>;
}
