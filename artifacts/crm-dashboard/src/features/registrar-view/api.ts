/** registrar_view client (assistants53). Server: artifacts/api-server/src/routes/registrar-view.ts + GET /customers?scope=registered. Read only. */
import { useQuery } from '@tanstack/react-query';

export type RvCase = { id: number; name: string; phoneMasked: string; isUrgent: boolean; status: string; statusLabel: string; priority: number | null;
  ownerName: string | null; ownedByMe: boolean; readOnly: boolean; registeredAt: string; source: string | null; sourceLabel: string | null;
  registrarNote: string | null; city: string | null; intakeCreditRank: string | null; callCount: number; lastCallAt: string | null };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${base()}/api${path}`, { credentials: 'include' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? 'پرونده پیدا نشد.' : `خطا (${r.status})`), { status: r.status });
  return body as T;
}
export const RV_ME_KEY = ['registrar-view', 'me'];
export function useRegistrarMe(enabled = true) {
  return useQuery({ queryKey: RV_ME_KEY, enabled, staleTime: 60_000, retry: false,
    queryFn: () => get<{ enabled: boolean; count: number }>('/registrar-view/me').catch(() => ({ enabled: false, count: 0 })) });
}
export function useRegistrarCase(id: number, enabled: boolean) {
  return useQuery({ queryKey: ['registrar-view', 'case', id], enabled: enabled && Number.isFinite(id), retry: false, queryFn: () => get<RvCase>(`/registrar-view/customers/${id}`) });
}
