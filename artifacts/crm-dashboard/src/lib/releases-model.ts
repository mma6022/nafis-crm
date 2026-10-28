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

export type OperationKind = 'none' | 'running' | 'success' | 'auto_rollback' | 'failed' | 'manual_recovery' | 'unknown';
/** badge = short label for the target row; blocksActions = every rollback button off. */
export type OperationView = { kind: OperationKind; badge: string; title: string; message: string; blocksActions: boolean };

const ERROR_FA: Record<string, string> = {
  activation_failed: 'نسخه‌ی تازه بالا نیامد و سیستم خودکار به نسخه‌ی قبلی برگشت. هیچ داده‌ای از دست نرفته.',
  database_schema_changed: 'ساختار پایگاه داده وسط کار عوض شد؛ CRM برای حفظ داده‌ها متوقف شد.',
  failed_to_restore_links: 'برگرداندن نسخه‌ی قبلی هم انجام نشد؛ CRM متوقف است.',
  operation_in_progress: 'یک عملیات دیگر در حال اجراست.',
};

/**
 * Maps the release manager's operation file ({target,status,error,updatedAt}) to the CRM tab.
 * failed + activation_failed = the manager restored the previous links itself -> «برگشت خودکار» (PM #6).
 * manual_recovery_required (database_schema_changed / failed_to_restore_links) -> «خطا» + «نیاز به کار دستی».
 */
export function mapOperation(op: { status?: string | null; error?: string | null; target?: string | null } | null | undefined): OperationView {
  const status = String(op?.status ?? '').trim().toLowerCase();
  const code = String(op?.error ?? '').trim();
  const err = code ? (ERROR_FA[code] ?? code) : '';
  switch (status) {
    case '':
      return { kind: 'none', badge: '', title: '', message: '', blocksActions: false };
    case 'running':
    case 'applying':
      return { kind: 'running', badge: 'در حال اجرا', title: 'در حال تغییر نسخه‌ی CRM…', message: 'تا تمام شدن، برگشت یا استقرار دیگری ممکن نیست. می‌توانی این صفحه را ببندی؛ کار روی سرور ادامه پیدا می‌کند.', blocksActions: true };
    case 'succeeded':
    case 'success':
      return { kind: 'success', badge: 'موفق', title: 'آخرین تغییر نسخه موفق بود.', message: 'CRM با این نسخه بالا آمد.', blocksActions: false };
    case 'failed':
      if (code === 'activation_failed' || code === '') {
        return { kind: 'auto_rollback', badge: 'برگشت خودکار', title: 'تغییر نسخه انجام نشد؛ CRM خودکار به نسخه‌ی قبلی برگشت.', message: err || ERROR_FA.activation_failed, blocksActions: false };
      }
      return { kind: 'failed', badge: 'خطا', title: 'تغییر نسخه انجام نشد.', message: err, blocksActions: false };
    case 'manual_recovery_required':
      return { kind: 'manual_recovery', badge: 'خطا', title: 'CRM متوقف است؛ نیاز به کار دستی', message: (err ? `${err} ` : '') + 'تا توسعه‌دهنده دستی درستش نکند، هیچ تغییر نسخه‌ای از این صفحه انجام نمی‌شود.', blocksActions: true };
    default:
      return { kind: 'unknown', badge: 'نامعلوم', title: 'وضعیت آخرین عملیات معلوم نیست.', message: 'تا روشن شدن وضعیت، برگشت غیرفعال است.', blocksActions: true };
  }
}

export type Gate = { action: 'none' | 'rollback'; allowed: boolean; reason: string };

/**
 * What the CRM tab may offer for one release. Only rollback (version < current); newer versions get
 * nothing (PM #4: no deploy from this page). Rollback is refused for anything older than the last
 * schema change (cutoff, given with its display label) and for everything when the cutoff is unknown.
 */
export function releaseGate(args: { version: string; current: string | null; cutoff: string | null; cutoffLabel?: string; ready: boolean; busy: boolean }): Gate {
  const { version, current, cutoff, ready, busy } = args;
  if (!current) return { action: 'none', allowed: false, reason: 'نسخه‌ی فعلی معلوم نیست.' };
  if (version === current) return { action: 'none', allowed: false, reason: 'نسخه‌ی فعلی' };
  if (version > current) return { action: 'none', allowed: false, reason: 'نسخه‌ی جدیدتر؛ استقرار از این صفحه انجام نمی‌شود.' };
  if (!ready) return { action: 'rollback', allowed: false, reason: 'این نسخه کامل یا معتبر نیست.' };
  if (!cutoff) return { action: 'rollback', allowed: false, reason: 'زمان آخرین تغییر ساختار پایگاه داده معلوم نیست؛ برگشت بسته است.' };
  const cut = cutoff.length === 12 ? `${cutoff}00` : cutoff;
  if (version < cut) return { action: 'rollback', allowed: false, reason: `با پایگاه داده‌ی فعلی جور نیست (ساختار از ${args.cutoffLabel || cut} عوض شده)` };
  if (busy) return { action: 'rollback', allowed: false, reason: 'تا تمام شدن عملیات جاری، برگشت ممکن نیست.' };
  return { action: 'rollback', allowed: true, reason: '' };
}

export function paginate<T>(items: T[], page: number, size: number): { rows: T[]; page: number; pages: number; total: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: items.slice((p - 1) * size, p * size), page: p, pages, total };
}

/** Manager polling: every 15 s while the tab is open (HANDOFF), 4 s only while an operation runs. */
export function crmRefetchMs(kind: OperationKind): number {
  return kind === 'running' ? 4000 : 15000;
}
