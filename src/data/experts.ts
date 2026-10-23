/**
 * Sales experts + the shared «با کدام کارشناس تماس می‌گیرید؟» picker (Mohammad 2026-10-23, via PM; design: Armita
 * /workspace/nafis-design/CONTACT-EXPERTS.md). The company landline is not in service, so every call / messenger entry
 * point on the site (header, mobile menu, mobile bar, footer, hero, CTAs, contact page, error messages) opens the picker
 * (src/components/experts/ExpertPicker.astro) and the visitor picks one of these experts. SINGLE SOURCE of names,
 * channels and link formats: the CRM customer portal copies the same data and formats.
 *
 * Rules (PM decisions 2026-10-23):
 * - fixed order (array order): خانم قاسمی، خانم حسنی، آقای کاظمی. Names are shown exactly as `name`.
 * - raw phone numbers are NOT shown anywhere (only inside tel: / wa.me / t.me / ble.ir hrefs).
 * - a channel an expert does not have is `null` → that row is not rendered; a channel no expert has → its triggers are
 *   not rendered either (`hasChannel`). scripts/check-messengers.mjs fails the build on any broken / generic link.
 * - messengers that support it get the prefilled message PREFILL (WhatsApp, Telegram). Bale has no documented draft param.
 *
 * Link formats (re-checked 2026-10-23, see the expert-picker report):
 * - call      tel:+989…                         (E.164)
 * - WhatsApp  https://wa.me/989…?text=…         (no «+»; 302 → api.whatsapp.com/send?phone=…&text=…)
 * - Telegram  https://t.me/+989…?text=…         (official «phone number link», core.telegram.org/api/links; opens the
 *                                                chat ONLY if the expert's privacy «Who can find me by my number» =
 *                                                Everybody. Prefer a username: `telegram: 'username'` → t.me/username?text=…)
 * - Bale      https://ble.ir/989…               (no «+»; ble.ir/+98… is 404. Android App Link for ir.nasim; the page is
 *                                                identical for any number, real account or not, so it proves the format,
 *                                                not the account. Prefer a username: `bale: 'username'` → ble.ir/username)
 */
type Handle = string | null; // a mobile «09…» (phone link) or a username; null = the expert has no such channel
export interface Expert {
  id: string;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  telegram: Handle;
  bale: Handle;
}

export const EXPERTS: readonly Expert[] = [
  { id: 'ghasemi', name: 'خانم قاسمی', phone: '09003400452', whatsapp: '09003400452', telegram: '09003400452', bale: '09003400452' },
  { id: 'hasani', name: 'خانم حسنی', phone: '09003400462', whatsapp: '09003400462', telegram: '09003400462', bale: '09003400462' },
  { id: 'kazemi', name: 'آقای کاظمی', phone: '09003400472', whatsapp: '09003400472', telegram: '09003400472', bale: '09003400472' },
];

import type { Channel } from './picker-trigger';
export type { Channel, PickerMode } from './picker-trigger';

export const PICKER_TITLE = 'با کدام کارشناس تماس می‌گیرید؟';
export const EXPERT_ROLE = 'کارشناس فروش';
export const PICKER_HOURS = 'شنبه تا پنج‌شنبه، ۹ تا ۱۸';
export const PREFILL = 'سلام، از سایت نفیس وام پیام می‌دم و مشاوره می‌خوام.';

/** Per-channel copy and sprite icon. `via` = header subtitle, `action` = row pill, `trigger` = icon-only trigger label. */
export const CHANNELS: Record<Channel, { label: string; via: string; action: string; icon: 'phone' | 'wa' | 'tg' | 'bale'; trigger: string }> = {
  call: { label: 'تماس تلفنی', via: 'از طریق تماس تلفنی', action: 'تماس', icon: 'phone', trigger: 'تماس با کارشناس' },
  whatsapp: { label: 'واتساپ', via: 'از طریق واتساپ', action: 'پیام', icon: 'wa', trigger: 'پیام در واتساپ' },
  telegram: { label: 'تلگرام', via: 'از طریق تلگرام', action: 'پیام', icon: 'tg', trigger: 'پیام در تلگرام' },
  bale: { label: 'بله', via: 'از طریق بله', action: 'پیام', icon: 'bale', trigger: 'پیام در بله' },
};
export const ALL_CHANNELS: Channel[] = ['call', 'whatsapp', 'telegram', 'bale'];

const MOBILE = /^09\d{9}$/;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const intl = (m: string) => '98' + m.slice(1);
const q = `?text=${encodeURIComponent(PREFILL)}`;

/** The link for one expert on one channel, or null (channel missing or the value is not a valid mobile / username). */
export function expertLink(e: Expert, ch: Channel): string | null {
  const ch2key = { call: 'phone', whatsapp: 'whatsapp', telegram: 'telegram', bale: 'bale' } as const;
  const v = e[ch2key[ch]];
  if (!v) return null;
  if (MOBILE.test(v)) {
    if (ch === 'call') return `tel:+${intl(v)}`;
    if (ch === 'whatsapp') return `https://wa.me/${intl(v)}${q}`;
    if (ch === 'telegram') return `https://t.me/+${intl(v)}${q}`;
    return `https://ble.ir/${intl(v)}`;
  }
  if (USERNAME.test(v) && ch === 'telegram') return `https://t.me/${v}${q}`;
  if (USERNAME.test(v) && ch === 'bale') return `https://ble.ir/${v}`;
  return null;
}

export const expertLinks = (e: Expert): Record<Channel, string | null> =>
  Object.fromEntries(ALL_CHANNELS.map((ch) => [ch, expertLink(e, ch)])) as Record<Channel, string | null>;

/** Does at least one expert have this channel? If not, no trigger for it is rendered anywhere. */
export const hasChannel = (ch: Channel) => EXPERTS.some((e) => expertLink(e, ch));
export const MESSENGERS: Channel[] = (['whatsapp', 'telegram', 'bale'] as Channel[]).filter(hasChannel);

/** Trigger attributes live in a tiny module so client islands do not bundle the expert data / link templates. */
export { pickerTrigger } from './picker-trigger';
