/**
 * Other salespersons' exact matches returned by GET /customers for a salesperson's search
 * (server: api-server/src/lib/cross-owner-search.ts). Added outside the generated schema,
 * like suggestedPlans. Only id, name and owner name are ever sent.
 */
export type OtherOwnerMatch = { id: number; name: string; ownerName: string };

export function otherOwnerMatchesOf(page: unknown): OtherOwnerMatch[] {
  const value = (page as { otherOwnerMatches?: unknown } | null | undefined)?.otherOwnerMatches;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is OtherOwnerMatch => !!item && typeof item === 'object' && Number.isInteger(Number((item as OtherOwnerMatch).id)))
    .map((item) => ({ id: Number(item.id), name: String(item.name ?? ''), ownerName: String(item.ownerName ?? '') }));
}

export function otherOwnerLimitedOf(page: unknown): boolean {
  return (page as { otherOwnerLimited?: unknown } | null | undefined)?.otherOwnerLimited === true;
}

/** «مشتریِ [نام کارشناس]» */
export const otherOwnerLabel = (ownerName: string) => `مشتریِ ${ownerName || 'کارشناس دیگر'}`;
