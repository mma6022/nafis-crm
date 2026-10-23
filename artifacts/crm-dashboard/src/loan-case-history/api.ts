export type CaseAuthor = { id: number; name: string; avatarUrl: string | null };
export type CaseNoteAttachment = { fileName: string; mimeType: string; fileSize: number; kind: 'image' | 'audio' | 'file'; fileUrl: string };
export type CaseNote = { id: number; applicationId: number; text: string; clientId: string; createdAt: string; author: CaseAuthor; attachment: CaseNoteAttachment | null };
export type CaseNotesPage = { items: CaseNote[]; nextCursor: string | null };
export type HistoryEvent = { id: number; action: string; reason: string | null; createdAt: string; author: CaseAuthor | null };
export type HistoryPage = { items: HistoryEvent[]; nextCursor: string | null };
export type CaseUser = { id?: number | null; role?: string | null; permissions?: string[] | null } | null | undefined;

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RECORD_SECONDS = 120;

export class CaseApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const base = () => import.meta.env.BASE_URL.replace(/\/$/, '');
export const withBase = (url: string | null | undefined): string | null =>
  !url ? null : /^(https?:)?\/\//.test(url) || !url.startsWith('/') ? url : `${base()}${url}`;

export const canReadNotes = (u: CaseUser) => !!u && (u.role === 'admin' || !!u.permissions?.includes('loan_applications.view'));
export const canWriteNotes = (u: CaseUser) => !!u && (u.role === 'admin' || !!u.permissions?.includes('loan_applications.update'));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${base()}/api/loan-applications${path}`, { credentials: 'include', ...init }); }
  catch { throw new CaseApiError('ارتباط با سامانه برقرار نشد. دوباره تلاش کنید.', 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    const message = typeof body?.message === 'string' && /[\u0600-\u06ff]/.test(body.message) ? body.message
      : response.status === 401 ? 'نشست شما پایان یافته است. دوباره وارد شوید.'
      : response.status === 403 ? 'اجازه انجام این عملیات را ندارید.'
      : response.status === 404 ? 'پرونده پیدا نشد.'
      : response.status === 413 ? 'حجم فایل نباید بیشتر از ۱۶ مگابایت باشد.'
      : 'ارتباط با سامانه برقرار نشد. دوباره تلاش کنید.';
    throw new CaseApiError(message, response.status, code);
  }
  return body as T;
}

const qs = (beforeId: string | number | null | undefined, limit: number) =>
  `?${beforeId != null && beforeId !== '' ? `beforeId=${encodeURIComponent(String(beforeId))}&` : ''}limit=${limit}`;

export const fetchNotes = (id: number, beforeId?: string | null, limit = 30) =>
  request<CaseNotesPage>(`/${id}/notes${qs(beforeId, limit)}`);
export const fetchHistory = (id: number, beforeId?: string | null, limit = 30) =>
  request<HistoryPage>(`/${id}/history${qs(beforeId, limit)}`);

export function postNote(id: number, clientId: string, text: string, file: File | null) {
  const form = new FormData();
  form.append('clientId', clientId);
  if (text.trim()) form.append('text', text.trim());
  if (file) form.append('file', file, file.name);
  return request<CaseNote>(`/${id}/notes`, { method: 'POST', body: form });
}
