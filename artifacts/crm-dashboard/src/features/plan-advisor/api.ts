/** plan-advisor v1 client. OFF → GET /plan-advisor/me is 404 → usePaOn() false → today's page stays. */
import { useQuery } from "@tanstack/react-query";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error(data?.message || data?.error || String(res.status)), { status: res.status, body: data });
  return data as T;
}

export function usePaMe() {
  return useQuery({
    queryKey: ["plan-advisor", "me"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/plan-advisor/me", { credentials: "include" });
        if (res.status === 404) return null;
        if (!res.ok) return null;
        const data = await res.json() as { enabled?: boolean };
        return data?.enabled === true ? { enabled: true as const } : null;
      } catch { return null; }
    },
    retry: false, staleTime: 60_000,
  });
}
export const usePaOn = () => usePaMe().data?.enabled === true;

export type PaChip = { key: string; label: string; value: string; raw: unknown; source: "site" | "inquiry" | "file" | null; editable: boolean; retiredKind?: string | null };
export type PaCredit = { rank: string | null; chequeColor: string | null; bouncedCount: number | null; loanDebtToman: number | null; inquiryAt: string | null };
export type PaPlanCard = {
  planId: number; name: string; bankName: string; loanType: string; status: "fit" | "depends" | "no";
  max: number; installments: number[]; reasons: string[]; info: string[];
};
export type PaSuggest = { customer: { id: number; name: string }; chips: PaChip[]; credit: PaCredit; plans: PaPlanCard[] };
export type PaQuote = {
  planId: number; planName: string; principal: number; months: number;
  ceiling: number | null; overCeiling: boolean;
  depositAmount: number | null; installment: number | null; count: number;
  annualInterest: number | null; depositPercent: number | null;
  downPayment: number; deduction: number | null; filingFee: number;
  commission: number | null; commissionPercent: number | null;
  installmentsTotal: number | null; totalPayable: number | null;
};

export const paSuggest = (customerId: number) => req<PaSuggest>("GET", `/plan-advisor/suggest?customerId=${customerId}`);
export const paQuote = (planId: number, principal: number, term: number, customerId?: number | null) =>
  req<PaQuote>("GET", `/plan-advisor/quote?planId=${planId}&principal=${principal}&term=${term}${customerId ? `&customerId=${customerId}` : ""}`);
export const paSaveChips = (customerId: number, patch: Record<string, unknown>) =>
  req<PaSuggest>("PATCH", "/plan-advisor/conditions", { customerId, patch });
export const paSearchCustomers = (q: string) => req<{ items: Array<{ id: number; name: string }> }>("GET", `/plan-advisor/customers?q=${encodeURIComponent(q)}`);
