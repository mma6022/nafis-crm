/** crm-voice-notes: pure helpers (no React, no DOM) — covered by the API fixture scripts/voice-notes-fixture.mjs. */
export const MAX_RECORD_SECONDS = 120;

/**
 * Appends a transcript to what is already in the field. Never replaces or trims existing text; if the field has a
 * max length, only the appended part is cut.
 */
export function appendTranscript(existing: string, transcript: string, maxLength?: number): string {
  const add = (transcript ?? '').trim();
  const base = existing ?? '';
  if (!add) return base;
  const sep = base.trim() === '' ? '' : /\n\s*$/.test(base) ? '' : '\n';
  const head = base.trim() === '' ? '' : base.replace(/[ \t]+$/, '');
  const next = head + sep + add;
  if (maxLength === undefined || next.length <= maxLength) return next;
  return base.length >= maxLength ? base : next.slice(0, maxLength);
}

/** First MediaRecorder type the browser supports: webm/opus (Chrome, Firefox, Android) → mp4/aac (iOS Safari). */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac'];
export function pickRecorderType(isSupported: (t: string) => boolean): string {
  for (const t of RECORDER_TYPES) { try { if (isSupported(t)) return t; } catch { /* ignore */ } }
  return '';
}
/** Content-Type to upload with (no codec parameters; server accepts the base type). */
export function uploadType(blobType: string): string {
  const t = (blobType || '').split(';')[0].trim().toLowerCase();
  return t || 'audio/webm';
}

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (s: string | number) => String(s).replace(/\d/g, (d) => FA[Number(d)]);
export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return faDigits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

/** Persian message for getUserMedia / MediaRecorder failures. */
export function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'اجازهٔ استفاده از میکروفون داده نشد. از تنظیمات مرورگر اجازه بدهید و دوباره امتحان کنید.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'میکروفونی روی این دستگاه پیدا نشد.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'میکروفون در اختیار برنامهٔ دیگری است؛ آن را ببندید و دوباره امتحان کنید.';
  if (name === 'Unsupported') return 'این مرورگر ضبط صدا را پشتیبانی نمی‌کند؛ متن را تایپ کنید.';
  return 'ضبط صدا شروع نشد؛ دوباره امتحان کنید.';
}

/** Persian message for a failed upload/transcription; the field text is never touched on error. */
export function transcribeErrorMessage(status: number, serverMessage: unknown): string {
  if (typeof serverMessage === 'string' && /[\u0600-\u06ff]/.test(serverMessage)) return serverMessage;
  if (status === 0) return 'اتصال اینترنت برقرار نیست؛ متن قبلی سر جایش است. دوباره امتحان کنید.';
  if (status === 404) return 'تبدیل صدا به متن فعلاً غیرفعال است.';
  if (status === 403) return 'تبدیل صدا به متن برای نقش شما فعال نیست.';
  if (status === 413) return 'ضبط بیش از حد طولانی بود؛ حداکثر ۲ دقیقه ضبط کنید.';
  if (status === 429) return 'سقف روزانهٔ تبدیل صدا پر شده است؛ متن را تایپ کنید.';
  return 'تبدیل صدا به متن انجام نشد؛ متن قبلی سر جایش است. دوباره امتحان کنید.';
}
