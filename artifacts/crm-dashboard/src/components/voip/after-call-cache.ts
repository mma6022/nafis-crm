import type { QueryClient } from '@tanstack/react-query';
import { getListPendingVoipAfterCallsQueryKey, type VoipAfterCallPending } from '@workspace/api-client-react';

export async function removeCompletedAfterCallFromQueue(
  queryClient: QueryClient, completed: { eventId?: number; callLogId?: number },
) {
  const key = getListPendingVoipAfterCallsQueryKey();
  // Cancel an older polling response before applying the successful save.
  await queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData<VoipAfterCallPending>(key, (old) => {
    if (!old) return old;
    const items = old.items.filter(e => e.id !== completed.eventId
      && (completed.callLogId === undefined || e.callLogId !== completed.callLogId));
    return { ...old, items, total: Math.max(0, old.total - (old.items.length - items.length)) };
  });
  void queryClient.invalidateQueries({ queryKey: key });
}