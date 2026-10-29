/** SALES-SHELL v2 client (Armita sales-shell-redesign v1.0.1). Server: api-server/src/lib/sales-shell.ts.
 *  Per-user flag; OFF (or any error) → the old CrmShell, unchanged. */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

export type SsNavBadges = { reminders: { overdue: number; laterToday: number }; dndUntil: string | null; at: string };
const LS = (uid: number) => `nafis.ssv2.${uid}`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: 'include' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}

/** The flag for the signed-in user. The last answer is remembered per user (localStorage) only to avoid a one-frame flash of the old shell. */
export function useSalesShellV2(uid: number | null | undefined, enabled: boolean): boolean {
  const q = useQuery({
    queryKey: ['sales-shell-me', uid ?? 0],
    enabled: Boolean(uid) && enabled,
    queryFn: async () => {
      const v = await get<{ v2: boolean }>('/sales-shell/me').then((d) => d.v2 === true).catch(() => false);
      try { if (v) window.localStorage.setItem(LS(uid!), '1'); else window.localStorage.removeItem(LS(uid!)); } catch { /* ignore */ }
      return v;
    },
    initialData: () => { try { return uid ? window.localStorage.getItem(LS(uid)) === '1' : false; } catch { return false; } },
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  return Boolean(uid) && enabled && q.data === true;
}

/** spec §9 GET /nav-badges (own reminders + DND end). */
export function useNavBadges(enabled: boolean) {
  return useQuery({ queryKey: ['nav-badges'], queryFn: () => get<SsNavBadges>('/nav-badges'), enabled, refetchInterval: 30_000, refetchOnWindowFocus: true, retry: false });
}

/** «الان مشتری جدید دارم»: the dock asks the today page to open the incoming wizard (pending flag survives the route change). */
export const SS_INCOMING_EVENT = 'nafis:incoming-open';
export function ssRequestIncoming() {
  try { (window as unknown as { __ssIncoming?: number }).__ssIncoming = Date.now(); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(SS_INCOMING_EVENT));
}
/** The today page handles a pending request (fresher than 10 s) once; `open` returns false while it cannot open yet (loading / another view owns it). */
export function useSsIncoming(open: () => boolean) {
  const ref = useRef(open); ref.current = open;
  useEffect(() => {
    const w = window as unknown as { __ssIncoming?: number };
    const tryOpen = () => { const t = w.__ssIncoming; if (typeof t !== 'number' || Date.now() - t > 10_000) return; if (ref.current()) w.__ssIncoming = undefined; };
    tryOpen();
    const id = window.setInterval(tryOpen, 400); // the page may still be loading when the request arrives
    window.addEventListener(SS_INCOMING_EVENT, tryOpen);
    return () => { window.clearInterval(id); window.removeEventListener(SS_INCOMING_EVENT, tryOpen); };
  }, []);
}

export const faNum = (n: number) => n.toLocaleString('fa-IR');
export const tehranHm = (iso: string) => new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(new Date(iso));
