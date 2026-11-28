/* t984: the read-only wallet query (GET /api/bale-workspace/chats/:id/wallet; 404 while flag.bale_fullheight_v1 is OFF). */
import { useQuery } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
import type { BfhWallet } from './model';

export function useBfhWallet(chatId: number | null, on: boolean) {
  return useQuery<BfhWallet>({ queryKey: ['bfh-wallet', chatId], enabled: on && chatId != null, retry: false, staleTime: 10_000, refetchOnWindowFocus: true,
    queryFn: () => bbFetch<BfhWallet>(`/bale-workspace/chats/${chatId}/wallet`) });
}
