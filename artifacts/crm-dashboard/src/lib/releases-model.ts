// Release 84(A): pure helpers for «نسخه‌ها» (site + CRM tabs). No React, no fetch; unit-tested in
// scripts/releases-model-fixture.mjs.

export const TEHRAN_OFFSET_MINUTES = 210; // UTC+03:30 all year

/** 14-digit UTC RID (or 12-digit, manager appends "00") -> Date, or null. */
export function ridToDate(rid: string | null | undefined): Date | null {
  const d = String(rid ?? '').match(/^\d+/)?.[0] ?? '';
  const v = d.length === 12 ? `${d}00` : d;
  if (v.length !== 14) return null;
  const n = (a: number, b: number) => Number(v.slice(a, b));
  const [y, mo, da, h, mi, s] = [n(0, 4), n(4, 6), n(6, 8), n(8, 10), n(10, 12), n(12, 14)];
  const dt = new Date(Date.UTC(y, mo - 1, da, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da
    || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
  return dt;
}

export type TehranTime = { iso: string; date: string; time: string };

/** RID (UTC) -> Tehran wall clock. iso = "2026-10-29 00:54" (Latin digits), date = Jalali Persian, time = Persian HH:MM. */
export function ridToTehran(rid: string | null | undefined): TehranTime | null {
  const dt = ridToDate(rid);
  if (!dt) return null;
  const t = new Date(dt.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const p = (v: number) => String(v).padStart(2, '0');
  const iso = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  let date = iso.slice(0, 10);
  try {
    date = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(t);
  } catch { /* keep Gregorian */ }
  const fa = (s: string) => s.replace(/\d/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[Number(c)]);
  return { iso, date, time: fa(`${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`) };
}

export type OperationKind = 'none' | 'running' | 'success' | 'failed' | 'manual_recovery' | 'unknown';
export type OperationView = { kind: OperationKind; title: string; message: string; blocksActions: boolean };

const ERROR_FA: Record<string, string> = {
  activation_failed: 'فعال‌سازی ناموفق بود و نسخه‌ی قبلی سر جایش ماند.',
  database_schema_changed: 'ساختار دیتابیس در حین تغییر نسخه عوض شد؛ سرویس CRM برای حفظ داده‌ها متوقف شد.',
  failed_to_restore_links: 'لینک نسخه‌ی قبلی برنگشت؛ سرویس CRM متوقف است.',
  operation_in_progress: 'یک عملیات دیگر در حال اجراست.',
};

/** Maps the release manager's operation file ({target,status,error,updatedAt}) to what the CRM tab shows. */
export function mapOperation(op: { status?: string | null; error?: string | null; target?: string | null } | null | undefined): OperationView {
  const status = String(op?.status ?? '').trim().toLowerCase();
  const err = op?.error ? (ERROR_FA[op.error] ?? op.error) : '';
  const target = op?.target ? ` (${op.target})` : '';
  switch (status) {
    case '':
      return { kind: 'none', title: '', message: '', blocksActions: false };
    case 'running':
    case 'applying':
      return { kind: 'running', title: `در حال اعمال نسخه${target}`, message: 'تغییر نسخه در حال انجام است. تا پایان آن، هیچ دکمه‌ای فعال نیست.', blocksActions: true };
    case 'succeeded':
    case 'success':
      return { kind: 'success', title: `آخرین تغییر نسخه موفق بود${target}`, message: 'سرویس CRM با نسخه‌ی جدید بالا آمد.', blocksActions: false };
    case 'failed':
      return { kind: 'failed', title: `آخرین تغییر نسخه ناموفق بود${target}`, message: err || 'تغییرات اعمال نشد.', blocksActions: false };
    case 'manual_recovery_required':
      return { kind: 'manual_recovery', title: 'CRM متوقف است؛ بازیابی دستی لازم است', message: (err ? `${err} ` : '') + 'تا بازیابی توسط توسعه‌دهنده، هیچ تغییر نسخه‌ای از این صفحه انجام نمی‌شود.', blocksActions: true };
    default:
      return { kind: 'unknown', title: `وضعیت ناشناخته: ${status}`, message: 'تا روشن شدن وضعیت، تغییر نسخه غیرفعال است.', blocksActions: true };
  }
}

export type Gate = { action: 'none' | 'deploy' | 'rollback'; allowed: boolean; reason: string };

/**
 * What the CRM tab may offer for one release. Rollback (version < current) is refused for anything
 * older than the last schema change (cutoff), and for everything when the cutoff is unknown.
 */
export function releaseGate(args: { version: string; current: string | null; cutoff: string | null; ready: boolean; busy: boolean }): Gate {
  const { version, current, cutoff, ready, busy } = args;
  if (current && version === current) return { action: 'none', allowed: false, reason: 'نسخه‌ی فعلی' };
  const action: Gate['action'] = current && version < current ? 'rollback' : 'deploy';
  if (!ready) return { action, allowed: false, reason: 'این نسخه کامل یا معتبر نیست.' };
  if (busy) return { action, allowed: false, reason: 'تا پایان یا بازیابی عملیات جاری غیرفعال است.' };
  if (action === 'rollback') {
    if (!cutoff) return { action, allowed: false, reason: 'زمان آخرین تغییر ساختار دیتابیس معلوم نیست؛ بازگردانی از این صفحه بسته است.' };
    const cut = cutoff.length === 12 ? `${cutoff}00` : cutoff;
    if (version < cut) return { action, allowed: false, reason: `قدیمی‌تر از آخرین تغییر ساختار دیتابیس (${cut}) است؛ کد قدیمی با دیتابیس فعلی سازگار نیست. بازگردانی فقط دستی و توسط توسعه‌دهنده.` };
  }
  return { action, allowed: true, reason: '' };
}

export function paginate<T>(items: T[], page: number, size: number): { rows: T[]; page: number; pages: number; total: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: items.slice((p - 1) * size, p * size), page: p, pages, total };
}

/** Manager polling: slow when idle, faster only while an operation runs. */
export function crmRefetchMs(kind: OperationKind): number {
  return kind === 'running' ? 4000 : 30000;
}
