import { useQuery } from '@tanstack/react-query';
import { teamChatApi } from './api';
import { useGetAuthSession } from '@workspace/api-client-react';

export const inboxKey = ['internal-chat', 'inbox'] as const;
export function useTeamInbox(enabled: boolean) {
  const session = useGetAuthSession();
  const userId = session.data?.user?.id;
  return useQuery({
    queryKey: [...inboxKey, userId], queryFn: teamChatApi.inbox, enabled: enabled && !!userId, retry: false,
    refetchInterval: 5000, refetchOnWindowFocus: true, refetchOnReconnect: true,
  });
}
