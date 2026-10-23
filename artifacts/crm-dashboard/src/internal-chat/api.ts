export type TeamUser = { id: number; name: string; role: string; online: boolean };
export type TeamMessage = {
  id: number; conversationId: string; senderId: number; senderName: string; text: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'file' | 'deleted';
  fileName: string | null; mimeType: string | null; fileSize: number | null; fileUrl: string | null;
  clientId: string; createdAt: string; editedAt: string | null; deletedAt: string | null;
  replyTo: { id: number; text: string; senderName: string } | null;
  readBy: number[]; reactions: { emoji: string; count: number; mine: boolean }[];
};
export type TeamConversation = {
  id: string; name: string; kind: 'group' | 'direct'; members: TeamUser[];
  unreadCount: number; lastMessage: TeamMessage | null;
};
export type TeamInbox = { myId: number; conversations: TeamConversation[]; users: TeamUser[]; unreadCount: number };
export type TeamPage = { messages: TeamMessage[]; hasMore: boolean; typingUsers: TeamUser[] };
const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/internal-chat`;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(base + path, { ...init, credentials: 'include' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || 'ارتباط با چت برقرار نشد.');
  return data;
}
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const teamChatApi = {
  inbox: () => request<TeamInbox>('/conversations'),
  direct: (userId: number) => request<TeamConversation>('/conversations', json('POST', { userId })),
  messages: (id: string, options: { beforeId?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.beforeId) params.set('beforeId', String(options.beforeId));
    if (options.q) params.set('q', options.q);
    return request<TeamPage>(`/conversations/${encodeURIComponent(id)}/messages?${params}`);
  },
  send: (id: string, clientId: string, text: string, file?: File, replyToId?: number) => {
    const body = new FormData(); body.set('clientId', clientId); body.set('text', text);
    if (file) body.set('file', file);
    if (replyToId) body.set('replyToId', String(replyToId));
    return request<TeamMessage>(`/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body });
  },
  read: (id: string, lastMessageId: number) => request<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}/read`, json('POST', { lastMessageId })),
  typing: (id: string, typing: boolean) => request<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}/typing`, json('POST', { typing })),
  edit: (id: number, text: string) => request<TeamMessage>(`/messages/${id}`, json('PATCH', { text })),
  remove: (id: number) => request<TeamMessage>(`/messages/${id}`, { method: 'DELETE' }),
  react: (id: number, emoji: string) => request<TeamMessage>(`/messages/${id}/reactions`, json('PUT', { emoji })),
};
