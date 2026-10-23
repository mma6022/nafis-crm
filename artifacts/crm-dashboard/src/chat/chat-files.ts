// What the chat server accepts (api-server lib/chat-storage.ts validateChatFile + multer 16 MB limit).
// The picker, drag-and-drop and the recorder all go through acceptChatFile so the customer sees the
// problem before uploading instead of a 400 from the server.
export const CHAT_MAX_BYTES = 16 * 1024 * 1024;
const BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/x-m4a',
};
export const CHAT_MIME = new Set([...Object.values(BY_EXT), 'audio/x-wav', 'audio/mp4', 'video/webm']);
export const CHAT_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,audio/webm,audio/ogg,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a,.ogg,.wav';
export const CHAT_ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp';
export const CHAT_ACCEPT_DOCS = 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,audio/webm,audio/ogg,audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a,.ogg,.wav';

export type ChatFileCheck = { ok: true; file: File } | { ok: false; reason: 'type' | 'size' | 'empty' };
const ext = (name: string) => (name.split('.').pop() || '').toLowerCase();
export function acceptChatFile(file: File): ChatFileCheck {
  if (!file.size) return { ok: false, reason: 'empty' };
  if (file.size > CHAT_MAX_BYTES) return { ok: false, reason: 'size' };
  const mime = file.type.split(';')[0].toLowerCase();
  if (mime && CHAT_MIME.has(mime)) return { ok: true, file };
  // Some browsers leave type empty (or octet-stream) for .docx/.m4a; the server checks the MIME, so set it from the extension.
  const mapped = BY_EXT[ext(file.name)];
  if (mapped && (!mime || mime === 'application/octet-stream')) return { ok: true, file: new File([file], file.name, { type: mapped, lastModified: file.lastModified }) };
  return { ok: false, reason: 'type' };
}
export type ChatFileKind = 'image' | 'pdf' | 'word' | 'audio' | 'file';
export function chatFileKind(mime?: string | null, name?: string | null): ChatFileKind {
  const m = (mime || '').toLowerCase(); const e = ext(name || '');
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(e)) return 'image';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (m.includes('wordprocessingml') || e === 'docx' || e === 'doc') return 'word';
  if (m.startsWith('audio/') || m === 'video/webm' || ['mp3', 'm4a', 'ogg', 'wav', 'webm'].includes(e)) return 'audio';
  return 'file';
}
