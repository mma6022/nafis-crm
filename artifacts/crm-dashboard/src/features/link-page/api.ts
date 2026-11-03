/* links v1.0: is «صفحه‌ی لینک‌ها» on, and may this user manage it? While flag.links_page is OFF the server answers 404 → hidden. */
import { useQuery } from '@tanstack/react-query';
export type LinkPageMe = { enabled: boolean; canManage: boolean; canEditHeader: boolean };
const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export function useLinkPageMe(enabled: boolean) {
  return useQuery<LinkPageMe>({
    queryKey: ['link-page-me'], enabled, retry: false, staleTime: 60_000,
    queryFn: async () => { const r = await fetch(`${base()}/api/link-page/me`, { credentials: 'include' }); if (!r.ok) return { enabled: false, canManage: false, canEditHeader: false }; return (await r.json()) as LinkPageMe; },
  });
}
