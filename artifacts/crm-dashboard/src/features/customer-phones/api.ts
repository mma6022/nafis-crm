/** Extra customer mobile numbers (t853u). */
import { useQuery, useQueryClient } from "@tanstack/react-query";

export class CphError extends Error {
  status: number; code: string; body: unknown;
  constructor(message: string, status: number, code: string, body: unknown) {
    super(message); this.status = status; this.code = code; this.body = body;
  }
}
export type ExtraPhone = { id: number; phone: string; label: string | null; createdBy: number | null; createdAt: string };
export type PhoneList = {
  customerId: number;
  primary: { phone: string; label: string };
  extras: ExtraPhone[];
  total: number;
  max: number;
  canAdd: boolean;
  canDelete: boolean;
};

const hasFa = (s: unknown): s is string => typeof s === "string" && /[\u0600-\u06FF]/.test(s);
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new CphError("ذخیره انجام نشد. دوباره تلاش کنید.", 0, "network", null); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = hasFa(data?.message) ? data.message : hasFa(data?.error) ? data.error
      : res.status === 403 ? "اجازهٔ این کار را برای این مشتری ندارید."
      : res.status === 409 ? "این شماره قابل ثبت نیست."
      : "ذخیره انجام نشد. دوباره تلاش کنید.";
    throw new CphError(msg, res.status, typeof data?.code === "string" ? data.code : typeof data?.error === "string" ? data.error : "", data);
  }
  return data as T;
}

export const cphKey = (customerId: number) => ["customer-phones", customerId] as const;

export function useCustomerPhones(customerId: number | null | undefined, enabled = true) {
  return useQuery<PhoneList>({
    queryKey: cphKey(Number(customerId) || 0),
    enabled: enabled && Boolean(customerId),
    retry: false,
    staleTime: 15_000,
    queryFn: () => req<PhoneList>("GET", `/customers/${customerId}/phones`),
  });
}

export const cphApi = {
  list: (customerId: number) => req<PhoneList>("GET", `/customers/${customerId}/phones`),
  add: (customerId: number, phone: string, label?: string) =>
    req<PhoneList>("POST", `/customers/${customerId}/phones`, { phone, ...(label ? { label } : {}) }),
  remove: (customerId: number, phoneId: number) =>
    req<PhoneList>("DELETE", `/customers/${customerId}/phones/${phoneId}`),
};

export function useCphInvalidate() {
  const qc = useQueryClient();
  return (customerId: number) => { void qc.invalidateQueries({ queryKey: cphKey(customerId) }); };
}
