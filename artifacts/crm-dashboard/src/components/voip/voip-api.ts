import { useQuery } from '@tanstack/react-query';

export type VoipConfig = {
  enabled: boolean;
  wssUrl: string;
  sipDomain: string;
  stunUrls: string[];
  extension: string | null;
  authorizationUsername: string | null;
  canManage: boolean;
  historySyncAvailable: boolean;
  phonebookSyncAvailable: boolean;
};
export type VoipContact = { id: number; name: string; phone: string; customerSalespersonName?: string | null };
export type VoipExtension = { userId: number; displayName: string; extension: string | null; authorizationUsername: string | null };
export type VoipCallEvent = {
  callId: string;
  direction: 'incoming' | 'outgoing';
  phone: string;
  status: 'ringing' | 'answered' | 'completed' | 'missed' | 'rejected' | 'failed';
  startedAt: string;
  answeredAt?: string | null;
  endedAt?: string | null;
};
export type VoipCallRecord = VoipCallEvent & {
  id: number; customerId: number | null; customerName: string | null; customerSalespersonName?: string | null;
  extension: string; actorName: string; source: 'browser';
};

export async function voipRequest<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  // /api is the shared API artifact's registered route, not the web artifact's base.
  const response = await fetch(`/api/voip${path}`, {
    method, credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const labels: Record<number, string> = {
      400: 'اطلاعات واردشده معتبر نیست.', 401: 'نشست شما پایان یافته؛ دوباره وارد شوید.',
      403: 'اجازه این عملیات را ندارید.', 404: 'اطلاعات موردنظر پیدا نشد.',
      409: 'اطلاعات با تنظیمات یا سابقه موجود تداخل دارد.',
      422: 'تنظیمات تلفن یا داخلی کامل نیست.',
    };
    throw new Error(labels[response.status] ?? 'ارتباط با CRM برقرار نشد؛ دوباره تلاش کنید.');
  }
  return response.json() as Promise<T>;
}
export const useVoipContacts = (search: string) => useQuery({
  queryKey: ['voip-contacts', search],
  queryFn: () => voipRequest<{ items: VoipContact[] }>(`/contacts?search=${encodeURIComponent(search)}`),
});
export const useVoipHistory = (page = 1, customerId?: number, enabled = true) => useQuery({
  queryKey: ['voip-calls', page, customerId],
  queryFn: () => voipRequest<{ items: VoipCallRecord[]; total: number; page: number; limit: number }>(
    `/calls?page=${page}${customerId ? `&customerId=${customerId}` : ''}`),
  refetchInterval: 30000,
  enabled,
});
export const useVoipExtensions = (enabled: boolean) => useQuery({
  queryKey: ['voip-extensions'], queryFn: () => voipRequest<{ items: VoipExtension[] }>('/extensions'), enabled,
});
export const saveVoipConfig = (data: Pick<VoipConfig, 'enabled' | 'wssUrl' | 'sipDomain' | 'stunUrls'>) =>
  voipRequest<unknown>('/config', data, 'PUT');
export const saveVoipExtension = (userId: number, data: Pick<VoipExtension, 'extension' | 'authorizationUsername'>) =>
  voipRequest<unknown>(`/extensions/${userId}`, data, 'PUT');
export const lookupVoipContact = (phone: string) =>
  voipRequest<{ customer: VoipContact | null }>(`/lookup?phone=${encodeURIComponent(phone)}`);