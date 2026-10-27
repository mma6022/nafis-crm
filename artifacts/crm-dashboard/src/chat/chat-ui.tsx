// Shared building blocks for the two staff chat pages (/chat and /internal-chat).
// UI only: every value here comes from fields the existing endpoints already return.
import type { ReactNode } from 'react';
import { FileText, Image as ImageIcon, Mic, Users } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';

const TZ = 'Asia/Tehran';
export const initials = (name?: string | null) => (name || '؟').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('') || '؟';
export const faNum = (n: number) => n.toLocaleString('fa-IR');

/** Staff photo (from `user_avatars` via `UserAvatar`) with initials fallback and the green online dot. */
export function StaffAvatar({ userId, name, size = 48, online }: { userId?: number | null; name?: string | null; size?: number; online?: boolean }) {
  return <span className="nf-avw" style={{ width: size, height: size }}>
    <UserAvatar userId={userId} name={name} size={size} className="nf-av" />
    {online && <span className="nf-on" title="آنلاین" />}
  </span>;
}

/**
 * Customer avatar. There is no customer photo on the server yet (HANDOFF §10-ج-1), so this always
 * shows the initials. `customerId` / `avatarVersion` are the inputs a future `/api/customers/:id/avatar`
 * would need; once `/threads` returns `avatarVersion`, only the `src` branch below has to be enabled.
 */
export function CustomerAvatar({ customerId, name, size = 48, online, avatarVersion = null }: { customerId: number; name?: string | null; size?: number; online?: boolean; avatarVersion?: number | null }) {
  void avatarVersion; // reserved for the server change; no request is made today.
  return <span className="nf-avw" style={{ width: size, height: size }} data-customer-id={customerId}>
    <span className="avatar user-avatar nf-av nf-av-cus" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size / 2.9)) }}>{initials(name)}</span>
    {online && <span className="nf-on" title="آنلاین" />}
  </span>;
}

export function GroupAvatar({ size = 48 }: { size?: number }) {
  return <span className="nf-avw" style={{ width: size, height: size }}><span className="avatar nf-av nf-av-grp" aria-hidden="true" style={{ width: size, height: size }}><Users size={Math.round(size / 2)} /></span></span>;
}

/** Tehran calendar day key, so day separators and grouping follow the user's day, not UTC. */
export const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export function dayLabel(iso: string) {
  const k = dayKey(iso); const now = Date.now();
  if (k === dayKey(new Date(now).toISOString())) return 'امروز';
  if (k === dayKey(new Date(now - 864e5).toISOString())) return 'دیروز';
  return new Date(iso).toLocaleDateString('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
}
/** List-row time: clock for today, «دیروز», weekday within a week, otherwise a short date. */
export function listTime(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso); const age = Date.now() - d.getTime();
  const lbl = dayLabel(iso);
  if (lbl === 'امروز') return clock(iso);
  if (lbl === 'دیروز') return lbl;
  if (age < 6 * 864e5) return d.toLocaleDateString('fa-IR-u-ca-persian', { weekday: 'long', timeZone: TZ });
  return d.toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'short', timeZone: TZ });
}
export const fsize = (n: number | null | undefined) => n == null ? '' : n >= 1048576 ? `${(n / 1048576).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} مگابایت` : `${Math.max(1, Math.ceil(n / 1024)).toLocaleString('fa-IR')} کیلوبایت`;
export const fileTypeLabel = (mime?: string | null, name?: string | null) => {
  const e = (name || '').split('.').pop()?.toLowerCase() || '';
  if (mime === 'application/pdf' || e === 'pdf') return 'PDF';
  if ((mime || '').includes('wordprocessingml') || e === 'docx') return 'Word';
  if ((mime || '').startsWith('audio/')) return 'صدا';
  if ((mime || '').startsWith('image/')) return 'تصویر';
  return e ? e.toUpperCase() : 'فایل';
};
export const kindIcon = (kind?: string | null): ReactNode => kind === 'image' ? <ImageIcon aria-hidden="true" /> : kind === 'audio' ? <Mic aria-hidden="true" /> : kind === 'file' || kind === 'video' ? <FileText aria-hidden="true" /> : null;

/**
 * Grouping for message runs (HANDOFF §10-ب-2): a run is broken by a new day, by the
 * «پیام تازه» divider, or by a different sender. Name goes on the first message of the
 * run, the 32px avatar on the last one, middle messages keep an avatar-width spacer.
 */
export type RunInfo = { first: boolean; last: boolean; newDay: boolean; newDivider: boolean };
export function runInfo<T>(items: T[], sender: (m: T) => string, at: (m: T) => string, dividerBefore: (m: T, i: number) => boolean = () => false): RunInfo[] {
  const brk = (i: number) => i === 0 || dayKey(at(items[i])) !== dayKey(at(items[i - 1])) || dividerBefore(items[i], i) || sender(items[i]) !== sender(items[i - 1]);
  return items.map((m, i) => ({
    first: brk(i), last: i === items.length - 1 || brk(i + 1),
    newDay: i === 0 || dayKey(at(m)) !== dayKey(at(items[i - 1])),
    newDivider: dividerBefore(m, i),
  }));
}
