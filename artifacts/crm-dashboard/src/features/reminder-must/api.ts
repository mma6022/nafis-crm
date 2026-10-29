/** REMINDER-B client (mandatory due-reminder popup). Only users 8/2/3 ever call /reminder-must/config; everyone else never touches it. */
import { useQuery } from '@tanstack/react-query';
import { DpError } from '@/features/daily-plan/api';
import type { RctRules } from './CustomTime';

export const RM_USERS: Readonly<Record<number, number>> = { 8: 6, 2: 3, 3: 4 };
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new DpError((data && typeof data.message === 'string' && data.message) || (typeof data?.error === 'string' ? data.error : '') || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '', data?.details ?? null);
  return data as T;
}
export type RmCall = { id: number; at: string; outcome: string | null; note: string };
export type RmItem = { reminderId: number; customerId: number; customerName: string; phoneMasked: string; tel: string; subject: string; reason: string; createdBy: string;
  createdAt: string; remindAt: string; outsideHours: boolean; lastCalls?: RmCall[]; fileEdit?: boolean };
export type RmFeed = { enabled: true; workTime: boolean; pendingCount: number; items: RmItem[]; serverNow: string;
  snooze: { active: boolean; until: string | null; used: boolean; available: boolean; minutes: number };
  rules: { noteMin: number; noteMax: number; reasonMin: number; reasonMax: number; todayPmOpen: boolean; custom?: RctRules } };
export type RmOutcome = 'answered' | 'no_answer' | 'follow_up';
export type RmNext = 'tomorrow_am' | 'today_pm' | 'in_3_days' | 'none' | 'custom';
export const rmApi = {
  config: () => req<{ enabled: boolean }>('GET', '/reminder-must/config'),
  feed: () => req<RmFeed>('GET', '/reminder-must/feed'),
  shown: (id: number) => req<{ ok: true }>('POST', `/reminder-must/${id}/shown`, {}),
  snooze: () => req<{ ok: true; until: string; count: number }>('POST', '/reminder-must/snooze', {}),
  complete: (id: number, b: { callId: number; outcome: RmOutcome; note: string; next: RmNext; reason: string; remindAt?: string }) =>
    req<{ ok: true; remaining: number; nextAt: string | null }>('POST', `/reminder-must/${id}/complete`, b),
  saveCall: (b: Record<string, unknown>) => req<{ id: number }>('POST', '/calls', b),
};
export const useRmConfig = (userId: number | null | undefined) =>
  useQuery({ queryKey: ['reminder-must', 'config', userId], queryFn: rmApi.config, enabled: userId != null && RM_USERS[userId] != null, retry: false, staleTime: 60_000 });
