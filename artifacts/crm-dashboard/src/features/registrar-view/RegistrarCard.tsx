/* «ثبت‌شده توسط شما» — read-only card on the existing customer page (/customers/:id) for a customer the user registered but no
   longer owns (registrar_view, assistants53). No buttons: the server answers 403 registrar_read_only to every write on it. */
import { faDate } from '@/features/lead-annotator/api';
import { useRegistrarCase } from './api';
import '@/features/lead-annotator/lead-annotator.css';

const fa = (n: number) => n.toLocaleString('fa-IR');
const PRIORITY: Record<string, string> = { '1': 'اولویت ۱', '2': 'اولویت ۲', '3': 'اولویت ۳' };

export function RegistrarCard({ id, enabled }: { id: number; enabled: boolean }) {
  const q = useRegistrarCase(id, enabled);
  if (!enabled || q.isLoading || q.isError || !q.data) return null;
  const c = q.data;
  const rows: Array<[string, string]> = [
    ['شماره‌ی موبایل', c.phoneMasked],
    ['کارشناس پرونده', c.ownerName ?? '—'],
    ['وضعیت', c.statusLabel],
    ['اولویت', c.priority == null ? 'بدون اولویت' : PRIORITY[String(c.priority)] ?? String(c.priority)],
    ['تاریخ ثبت', faDate(c.registeredAt)],
    ['منبع', c.sourceLabel ?? '—'],
    ['شهر', c.city || '—'],
    ['تماس‌ها', c.callCount ? `${fa(c.callCount)} تماس · آخرین: ${c.lastCallAt ? faDate(c.lastCallAt) : '—'}` : 'هنوز تماسی ثبت نشده'],
  ];
  return <article className="la-card rv-card" data-testid="rv-card" aria-label="پرونده‌ی ثبت‌شده توسط شما (فقط مشاهده)">
    <header><strong>ثبت‌شده توسط شما</strong><span className="rv-ro" data-testid="rv-readonly">فقط مشاهده</span></header>
    <dl className="rv-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd dir={k === 'شماره‌ی موبایل' ? 'ltr' : undefined}>{v}</dd></div>)}</dl>
    {c.registrarNote ? <p className="rv-note"><span className="muted">یادداشت ثبت: </span>{c.registrarNote}</p> : null}
    {c.readOnly ? <p className="muted" style={{ margin: 0 }}>این پرونده الان با «{c.ownerName ?? 'کارشناس دیگر'}» است؛ ویرایش، انتقال، ثبت تماس و تغییر وضعیت یا اولویت برای شما بسته است.</p> : null}
  </article>;
}
