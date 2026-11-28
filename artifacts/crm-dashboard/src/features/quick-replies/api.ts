/* t979 v1.1 — calls of the three new endpoints (all 404 while flag.quick_replies_v11 is OFF, and the UI never shows them then). */
import { bbFetch, BbError } from '@/features/bale-bot/api';
import { QR_ERR, type QrItem, type QrTab } from './model';

export type QrReady = { currentPlanId: number | null; currentPlanTitle: string | null; items: QrItem[]; v11?: boolean; holdMs?: number; plans?: { id: number; name: string }[] };
export type QrSent = { message: { id: number }; undoMs: number };

export const qrErr = (e: unknown) => e instanceof BbError ? (e.code && QR_ERR[e.code]) || e.message : 'درخواست انجام نشد. دوباره تلاش کنید.';
/** Direct send: the server holds the message for the undo window, then the normal sender takes it. Never fills a composer. */
export const qrSend = (chatId: number, messageId: number) => bbFetch<QrSent>(`/bale-bot/chats/${chatId}/ready/${messageId}`, { body: {} });
export const qrUndo = (outId: number) => bbFetch<{ ok: true }>(`/bale-bot/messages/${outId}/undo`, { body: {} });
export const qrSetType = (messageId: number, tab: QrTab, planId?: number | null) =>
  bbFetch<{ item: QrItem }>(`/bale-bot/ready/${messageId}/type`, { body: tab === 'plans' ? { tab, planId } : { tab } });
