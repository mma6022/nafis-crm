import { useQuery } from "@tanstack/react-query";
import type { MultiCaseRow } from "@/components/multi-case/types";

export type { MultiCaseRow } from "@/components/multi-case/types";
export { faCase } from "@/components/multi-case/types";
export type MultiCaseLink = { id: number; loanApplicationId: number | null; subject?: string | null; createdAt?: string; remindAt?: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}

export function useMultiCaseStatus(enabled = true) {
  return useQuery({
    queryKey: ["multi-case-status"],
    queryFn: () => getJson<{ enabled: boolean }>("/api/multi-case/status").catch(() => ({ enabled: false })),
    enabled, staleTime: 30_000, retry: false,
  });
}

export function useMultiCaseCustomer(customerId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["multi-case-customer", customerId],
    queryFn: () => getJson<{ enabled: boolean; cases: MultiCaseRow[]; calls: MultiCaseLink[]; reminders: MultiCaseLink[] }>(`/api/multi-case/customers/${customerId}`),
    enabled: enabled && customerId > 0, staleTime: 15_000, retry: false,
  });
}
