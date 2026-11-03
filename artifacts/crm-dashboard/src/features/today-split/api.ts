/** TODAY-SPLIT client: only users 8/2/3 (salesperson role) ever ask /files-carousel/split; everyone else renders the old «امروز» untouched. */
import { useQuery } from '@tanstack/react-query';
import { DpError } from '@/features/daily-plan/api';
import { FC_USERS } from '@/features/files-carousel/api';

async function splitReq(): Promise<{ on: boolean }> {
  const res = await fetch('/api/files-carousel/split', { credentials: 'include' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new DpError((data && data.message) || 'انجام نشد.', res.status, data?.error ?? '', null);
  return { on: data?.on === true };
}
export const useTodaySplit = (userId: number | null | undefined, role?: string) =>
  useQuery({ queryKey: ['today-split', 'me', userId], queryFn: splitReq, enabled: userId != null && FC_USERS[userId] != null && role === 'salesperson', retry: false, staleTime: 60_000 });
