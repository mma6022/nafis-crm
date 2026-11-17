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

export type MyCustomersKanbanPage = {
  items: Array<{
    id: number; name: string; phone?: string; phoneLast4?: string | null;
    priority: number | null; status: string; lastCallAt: string | null; nextReminderAt?: string | null;
  }>;
  total: number;
  statusCounts?: Array<{ status: string; count: number }>;
  totalCustomers?: number;
};

export async function listMyCustomersKanban(opts: {
  search?: string; status?: string; priority?: number; hasPriority?: boolean;
  offset: number; limit: number; counts?: boolean;
}): Promise<MyCustomersKanbanPage> {
  const qs = new URLSearchParams();
  if (opts.search) qs.set("q", opts.search);
  qs.set("offset", String(opts.offset));
  qs.set("limit", String(opts.limit));
  if (opts.status) qs.set("status", opts.status);
  if (opts.hasPriority === false) qs.set("hasPriority", "false");
  else if (opts.priority != null) qs.set("priority", String(opts.priority));
  if (opts.counts) qs.set("counts", "1");
  const res = await fetch(`/api/sales-fixes/my-customers?${qs}`, { credentials: "include" });
  if (!res.ok) throw new Error(String(res.status));
  const body = await res.json() as MyCustomersKanbanPage & { items: Array<any> };
  const items = (body.items ?? []).map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    phoneLast4: r.phoneLast4 ? String(r.phoneLast4) : null,
    priority: r.priority == null ? null : Number(r.priority),
    status: String(r.status ?? "in_progress"),
    lastCallAt: r.lastCallAt ?? null,
    nextReminderAt: r.nextReminderAt ?? null,
  }));
  return { items, total: Number(body.total ?? 0), statusCounts: body.statusCounts, totalCustomers: body.totalCustomers };
}
