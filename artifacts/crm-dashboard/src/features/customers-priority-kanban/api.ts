/** customers-priority-kanban v1 client. OFF → GET /customers-priority-kanban/me is 404 → useCpkOn() false → today's board stays. */
import { useQuery } from "@tanstack/react-query";

export type CpkMe = { enabled: true };

async function getMe(): Promise<CpkMe | null> {
  try {
    const res = await fetch("/api/customers-priority-kanban/me", { credentials: "include" });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json() as { enabled?: boolean };
    return data?.enabled === true ? { enabled: true } : null;
  } catch {
    return null;
  }
}

export function useCpkMe() {
  return useQuery({ queryKey: ["customers-priority-kanban", "me"], queryFn: getMe, retry: false, staleTime: 60_000 });
}

export const useCpkOn = () => useCpkMe().data?.enabled === true;
