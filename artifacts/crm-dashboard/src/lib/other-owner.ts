/**
 * Other salespersons' exact matches returned by GET /customers for a salesperson's search
 * (server: api-server/src/lib/cross-owner-search.ts). Added outside the generated schema,
 * like suggestedPlans. Only id, a partial name, a masked mobile and the owner name are ever sent.
 */
export type OtherOwnerMatch = { id: number; name: string; maskedPhone: string; ownerName: string };

export function otherOwnerMatchesOf(page: unknown): OtherOwnerMatch[] {
  const value = (page as { otherOwnerMatches?: unknown } | null | undefined)?.otherOwnerMatches;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is OtherOwnerMatch => !!item && typeof item === 'object' && Number.isInteger(Number((item as OtherOwnerMatch).id)))
    .map((item) => ({ id: Number(item.id), name: String(item.name ?? ''), maskedPhone: String(item.maskedPhone ?? ''), ownerName: String(item.ownerName ?? '') }));
}

export function otherOwnerLimitedOf(page: unknown): boolean {
  return (page as { otherOwnerLimited?: unknown } | null | undefined)?.otherOwnerLimited === true;
}

/** «کارشناس این مشتری: [نام کارشناس]» */
export const otherOwnerLabel = (ownerName: string) => `کارشناس این مشتری: ${ownerName || 'کارشناس دیگر'}`;

export type TransferCallInfo = { ownerName: string; extension: string | null; notified: boolean };

/** «انتقال تماس به کارشناسش»: the owner's internal extension (+ a bell to the owner, server-side). */
export async function requestTransferCall(customerId: number): Promise<TransferCallInfo> {
  const response = await fetch(`/api/cross-owner/transfer-call/${customerId}`, { method: 'POST', credentials: 'include' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || 'دریافت داخلی کارشناس انجام نشد.');
  return body as TransferCallInfo;
}

export type MyTransfer = {
  historyId: number; customerId: number; customerName: string; maskedPhone: string; transferredAt: string;
  source: string; sourceLabel: string; byMe: boolean; toSalespersonId: number; toSalespersonName: string;
  currentSalespersonId: number | null; currentSalespersonName: string | null; stage: string; stageLabel: string;
};
