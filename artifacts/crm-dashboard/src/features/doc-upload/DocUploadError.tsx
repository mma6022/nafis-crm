import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { toPersianDigits } from '@/lib/customer-id';
import './doc-upload-error.css';

/** Same limit as the API's multer config for loan documents (routes/loan-applications.ts fileSize). */
export const DOC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** null = every type is accepted by this endpoint (the API has no type list for loan documents). */
export const DOC_UPLOAD_TYPES: { label: string; test: (f: File) => boolean } | null = null;

export type DocUpErr =
  | { kind: 'turn'; name: string | null; fileId: number | null }
  | { kind: 'size'; mb: number; maxMb: number }
  | { kind: 'type'; list: string }
  | { kind: 'network' }
  | { kind: 'default' };

const mb = (b: number) => toPersianDigits(String(Math.round((b / 1048576) * 10) / 10)).replace('.', '٫');

export function docClientCheck(f: File | null): DocUpErr | null {
  if (!f) return null;
  if (f.size > DOC_UPLOAD_MAX_BYTES) return { kind: 'size', mb: f.size, maxMb: DOC_UPLOAD_MAX_BYTES };
  if (DOC_UPLOAD_TYPES && !DOC_UPLOAD_TYPES.test(f)) return { kind: 'type', list: DOC_UPLOAD_TYPES.label };
  return null;
}

/** Map a failed upload to one of Armita's states. Raw English / code-like server text is never shown. */
export function docServerError(error: unknown): DocUpErr {
  const e = error as { name?: string; status?: number; data?: any } | null;
  if (!e || e.name !== 'ApiError' || !e.status) return { kind: 'network' };
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  if (d.error === 'board_turn') {
    const id = Number(d.details?.turnFileId ?? d.turnFileId);
    const nm = d.details?.turnFileName ?? d.turnFileName;
    return { kind: 'turn', name: typeof nm === 'string' && nm.trim() ? nm.trim() : null, fileId: Number.isFinite(id) && id > 0 ? id : null };
  }
  if (e.status === 413) return { kind: 'size', mb: Number(d.details?.sizeBytes) || 0, maxMb: Number(d.details?.maxBytes) || DOC_UPLOAD_MAX_BYTES };
  return { kind: 'default' };
}

export function DocUploadError({ err, onPickOther, onRetry, onGoFile }: { err: DocUpErr; onPickOther: () => void; onRetry: () => void; onGoFile: (id: number) => void }) {
  let body: React.ReactNode; let btn: React.ReactNode = null;
  const B = (label: string, on: () => void, tid: string) => <button type="button" className="btn btn-ghost dup-btn" data-testid={tid} onClick={on}>{label}</button>;
  switch (err.kind) {
    case 'turn':
      body = err.name
        ? <>مدارک پرونده‌ها به ترتیب باز می‌شود؛ اول پرونده‌ی <b>{err.name}</b>{err.fileId ? <> <CustomerIdBadge id={err.fileId} testId="doc-err-turn-id" /></> : null} را کامل کن.</>
        : <>مدارک پرونده‌ها به ترتیب باز می‌شود؛ اول پرونده‌ی نوبت را کامل کن.</>;
      if (err.fileId) btn = B(`رفتن به پرونده‌ی ${err.name ?? toPersianDigits(err.fileId)}`, () => onGoFile(err.fileId!), 'doc-err-go-file');
      break;
    case 'size':
      body = err.mb ? <>حجم این فایل {mb(err.mb)} مگابایت است؛ حداکثر {mb(err.maxMb)} مگابایت مجاز است. فایل کوچک‌تری انتخاب کن.</> : <>حجم این فایل بیشتر از حد مجاز است؛ حداکثر {mb(err.maxMb)} مگابایت مجاز است. فایل کوچک‌تری انتخاب کن.</>;
      btn = B('انتخاب فایل دیگر', onPickOther, 'doc-err-pick'); break;
    case 'type':
      body = <>این نوع فایل پذیرفته نمی‌شود. فقط {err.list} را می‌شود بارگذاری کرد.</>;
      btn = B('انتخاب فایل دیگر', onPickOther, 'doc-err-pick'); break;
    case 'network':
      body = <>اتصال برقرار نشد و مدرک بارگذاری نشد. اینترنت را بررسی کن و دوباره امتحان کن.</>;
      btn = B('دوباره امتحان کن', onRetry, 'doc-err-retry'); break;
    default:
      body = <>مدرک بارگذاری نشد. یک بار دیگر امتحان کن؛ اگر باز هم نشد، «گزارش خطا» را بزن.</>;
      btn = B('دوباره امتحان کن', onRetry, 'doc-err-retry');
  }
  return (
    <div role="alert" className="dup-err" data-testid="doc-upload-error" data-kind={err.kind}>
      <AlertTriangle size={16} aria-hidden className="dup-ico" />
      <div className="dup-main"><div className="dup-txt">{body}</div>{btn}</div>
    </div>
  );
}
