/** TODAY-SPLIT client: only users 8/2/3 (salesperson role) ever ask /files-carousel/split; everyone else renders the old «امروز» untouched. */
import { useQuery } from '@tanstack/react-query';
import { DpError } from '@/features/daily-plan/api';
import { FC_USERS, fcApi } from '@/features/files-carousel/api';

async function splitReq(): Promise<{ on: boolean; filesLock: boolean }> {
  const res = await fetch('/api/files-carousel/split', { credentials: 'include' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new DpError((data && data.message) || 'انجام نشد.', res.status, data?.error ?? '', null);
  return { on: data?.on === true, filesLock: data?.on === true && data?.filesLock === true }; // FILES-LOCK (stage 2): server sends the key only while its flag is on
}
export const useTodaySplit = (userId: number | null | undefined, role?: string) =>
  useQuery({ queryKey: ['today-split', 'me', userId], queryFn: splitReq, enabled: userId != null && FC_USERS[userId] != null && role === 'salesperson', retry: false, staleTime: 60_000 });

/** FILES-LOCK dock hint: cache-only (enabled:false → never fetches; /files-carousel/today writes fc_days, so the shell must not call it).
 *  Fills in once «امروز» or «پرونده‌ها» has loaded; null = no lock (flag off, list open, or nothing left). */
export function useFilesLockHint(userId: number | null | undefined): { remaining: number } | null {
  const s = useQuery({ queryKey: ['today-split', 'me', userId], queryFn: splitReq, enabled: false });
  const t = useQuery({ queryKey: ['files-carousel', 'today'], queryFn: fcApi.today, enabled: false });
  const v = t.data;
  if (!s.data?.filesLock || !v) return null;
  const remaining = v.cards.filter((c) => c.state !== 'done').length;
  return remaining > 0 && !v.split?.unlocked && v.mode !== 'list' ? { remaining } : null;
}
