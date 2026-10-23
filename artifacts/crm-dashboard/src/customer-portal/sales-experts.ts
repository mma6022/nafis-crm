/**
 * Sales experts for the customer portal's expert picker (Mohammad 2026-10-23; design: nafis-design/CONTACT-EXPERTS.md).
 * Single source of truth: edit names/numbers/hours/message here only. Fixed order: قاسمی، حسنی، کاظمی.
 * Link formats copied from nafisvam.com (/workspace/nafisvam-web/src/lib/site.ts expertLinks):
 * tel:+98…, wa.me/98…, t.me/+98…, ble.ir/98… (no «+»; ble.ir/+98… is 404).
 * Raw numbers are never rendered. The office landline is not operational and must never appear
 * (scripts/portal-no-landline-fixture.mjs).
 */
export type ExpertChannel = 'call' | 'whatsapp' | 'telegram' | 'bale';
export type Expert = { name: string; mobile: string };

export const SALES_EXPERTS: readonly Expert[] = [
  { name: 'خانم قاسمی', mobile: '09003400452' },
  { name: 'خانم حسنی', mobile: '09003400462' },
  { name: 'آقای کاظمی', mobile: '09003400472' },
];

export const EXPERT_HOURS = 'شنبه تا پنج‌شنبه، ۹ تا ۱۸';
export const EXPERT_MESSAGE = 'سلام، از سایت نفیس وام پیام می‌دم و مشاوره می‌خوام.';
export const SOCIAL_INSTAGRAM = 'https://instagram.com/nafisvamm';

export const CHANNELS: Record<ExpertChannel, { via: string; act: string; external: boolean }> = {
  call: { via: 'تماس تلفنی', act: 'تماس', external: false },
  whatsapp: { via: 'واتساپ', act: 'پیام', external: true },
  telegram: { via: 'تلگرام', act: 'پیام', external: true },
  bale: { via: 'بله', act: 'پیام', external: true },
};

const fa = (v: string | number) => String(v).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

/** Prefilled message; in the portal the case number is appended when known. */
export function expertMessage(caseNo?: string | number | null): string {
  return caseNo != null && String(caseNo) !== '' ? `${EXPERT_MESSAGE} شماره پرونده: ${fa(caseNo)}` : EXPERT_MESSAGE;
}

/**
 * Link for one expert on one channel, or null when there is no valid link (row is then hidden).
 * Prefill: only WhatsApp supports a text parameter for a phone-number chat (t.me/+98… and ble.ir/98… have none).
 */
export function expertHref(mobile: string | null | undefined, channel: ExpertChannel, caseNo?: string | number | null): string | null {
  const m = (mobile ?? '').replace(/[\s-]/g, '').replace(/^\+98/, '0').replace(/^98/, '0');
  if (!/^09\d{9}$/.test(m)) return null;
  const intl = '98' + m.slice(1);
  switch (channel) {
    case 'call': return `tel:+${intl}`;
    case 'whatsapp': return `https://wa.me/${intl}?text=${encodeURIComponent(expertMessage(caseNo))}`;
    case 'telegram': return `https://t.me/+${intl}`;
    case 'bale': return `https://ble.ir/${intl}`;
  }
}

const norm = (m?: string | null) => (m ?? '').replace(/\D/g, '').replace(/^98/, '0').replace(/^9/, '09');

export type PickerRow = Expert & { role: string; assigned: boolean; href: string };

/** Rows for a channel: the case's assigned expert first («کارشناس پرونده‌ی شما») when known, then the fixed three. */
export function pickerRows(channel: ExpertChannel, assigned?: { name?: string | null; mobile?: string | null } | null, caseNo?: string | number | null): PickerRow[] {
  const rows: PickerRow[] = [];
  const a = assigned?.name && assigned.mobile ? expertHref(assigned.mobile, channel, caseNo) : null;
  if (a && assigned?.name && assigned.mobile) rows.push({ name: assigned.name, mobile: assigned.mobile, role: 'کارشناس پرونده‌ی شما', assigned: true, href: a });
  for (const e of SALES_EXPERTS) {
    if (a && norm(e.mobile) === norm(assigned?.mobile)) continue;
    const href = expertHref(e.mobile, channel, caseNo);
    if (href) rows.push({ ...e, role: 'کارشناس فروش', assigned: false, href });
  }
  return rows;
}
