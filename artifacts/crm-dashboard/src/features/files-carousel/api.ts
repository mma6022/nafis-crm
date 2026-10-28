/** FILES-61 «پرونده‌های من» تک‌کارتی client. Only users 8/2/3 ever call /files-carousel/config; everyone else never touches it. */
import { useQuery } from '@tanstack/react-query';
import { DpError } from '@/features/daily-plan/api';

export const FC_USERS: Readonly<Record<number, number>> = { 8: 6, 2: 3, 3: 4 };
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new DpError((data && typeof data.message === 'string' && data.message) || 'انجام نشد. دوباره تلاش کن.', res.status, data?.error ?? '', data?.details ?? null);
  return data as T;
}
export type FcCard = { fileId: number; customerId: number; customerName: string; phone: string | null; type: string; typeLabel: string; group: string; groupLabel: string; stage: string;
  status: string; isDraft: boolean; businessStatus: string; createdAt: string; returnedToday: boolean;
  lastFollowUp: { at: string; atTehran: string | null; source: string; outcome: string | null; outcomeLabel: string | null } | null;
  position: number; state: 'done' | 'current' | 'pending'; reason: string | null; ask: string | null;
  todayFollowUp: { at: string; outcome: string; outcomeLabel: string | null; note: string } | null };
export type FcView = { enabled: true; date: string; total: number; done: number; index: number | null; currentFileId: number | null; orderSource: 'assistant' | 'default';
  outcomes: { code: string; label: string }[]; noteMax: number; cards: FcCard[] };
export const fcApi = {
  config: () => req<{ enabled: boolean }>('GET', '/files-carousel/config'),
  today: () => req<FcView>('GET', '/files-carousel/today'),
  followup: (b: { fileId: number; outcome: string; note: string }) => req<{ ok: true; fileId: number; view: FcView }>('POST', '/files-carousel/followup', b),
};
export const useFcConfig = (userId: number | null | undefined) =>
  useQuery({ queryKey: ['files-carousel', 'config', userId], queryFn: fcApi.config, enabled: userId != null && FC_USERS[userId] != null, retry: false, staleTime: 60_000 });
