// Shared bits of customer-portal part 2 (کمک در انتخاب طرح، گفتگو، کیف پول); classes from nfp2.css.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ChevronLeft, Phone } from 'lucide-react';
import { portalApi } from './api';
import { ExpertPicker, ExpertPickerButton } from './ExpertPicker';
import type { ExpertChannel } from './sales-experts';
import { Icon, money } from './PortalUi';

/** Amount + small «تومان», like the mockup's T(). */
export function Toman({ value }: { value: number }) {
  return <><bdi className="nfp-num">{money(value)}</bdi><small className="nfp-tm">تومان</small></>;
}

/** «۲ میلیون و ۵۰۰ هزار تومان» (amount in words, under the top-up input). */
export function moneyWords(n: number, unit = true) {
  const m = Math.floor(n / 1e6); const k = Math.round((n % 1e6) / 1e3);
  const words = [m ? `${money(m)} میلیون` : '', k ? `${money(k)} هزار` : ''].filter(Boolean).join(' و ');
  return words ? `${words}${unit ? ' تومان' : ''}` : '';
}

/** Case expert for the contact picker (top row + file number), from the newest active application. */
export function useCaseExpert() {
  const q = useQuery({ queryKey: ['customer', 'applications', 'active'], queryFn: portalApi.activeApplications, staleTime: 60_000, retry: false });
  const app = q.data?.find(a => a.salesExpert) ?? q.data?.[0];
  return { assigned: app?.salesExpert ?? null, caseNo: app?.id ?? null };
}

const CH: Array<[ExpertChannel, string, string]> = [
  ['call', 'تماس', 'تماس تلفنی با کارشناس فروش'],
  ['whatsapp', 'واتساپ', 'پیام در واتساپ به کارشناس فروش'],
  ['telegram', 'تلگرام', 'پیام در تلگرام به کارشناس فروش'],
  ['bale', 'بله', 'پیام در بله به کارشناس فروش'],
];

/** «سؤال دارید؟» card: four channel buttons, each opens the sales-expert picker. */
export function HelpCard({ title = 'سؤال دارید؟', text = 'کارشناس‌های فروش ما راهنمایی‌تان می‌کنند. یکی را انتخاب کنید.', id = 'nfp-hc' }: { title?: string; text?: string; id?: string }) {
  const { assigned, caseNo } = useCaseExpert();
  return <section className="nfp-card nfp-help-card" aria-labelledby={id}>
    <div className="nfp-exp"><span className="nfp-av"><Icon icon={Phone} /></span><div><b id={id}>{title}</b><small>{text}</small></div></div>
    <div className="nfp-ch-row">{CH.map(([ch, label, aria]) => <ExpertPickerButton key={ch} channel={ch} label={label} ariaLabel={aria} className="nfp-ch-btn" testId={`button-help-${ch}`} assigned={assigned} caseNo={caseNo} />)}</div>
  </section>;
}

/** Inline text link that opens the call picker. */
export function ExpertLink({ children, className = 'nfp-link-btn' }: { children: ReactNode; className?: string }) {
  const { assigned, caseNo } = useCaseExpert();
  return <ExpertPicker assigned={assigned} caseNo={caseNo} trigger={<button type="button" className={className} aria-haspopup="dialog">{children}</button>} />;
}

/** Primary/secondary «تماس با کارشناس» button. */
export function ExpertButton({ label = 'تماس با کارشناس', className = 'nf-btn nf-btn--secondary', testId }: { label?: string; className?: string; testId?: string }) {
  const { assigned, caseNo } = useCaseExpert();
  return <ExpertPickerButton label={label} ariaLabel="تماس با کارشناس فروش" className={className} testId={testId} assigned={assigned} caseNo={caseNo} />;
}

/** Desktop breadcrumb (hidden on mobile by nfp.css). */
export function Crumb({ items }: { items: Array<[string, string?]> }) {
  return <nav className="nfp-crumb" aria-label="مسیر">{items.map(([t, h], i) => <span key={t} style={{ display: 'contents' }}>
    {i > 0 && <Icon icon={ChevronLeft} small />}{h ? <Link href={h}>{t}</Link> : <span>{t}</span>}</span>)}</nav>;
}
