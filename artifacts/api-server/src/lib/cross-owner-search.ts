/**
 * Cross-owner customer lookup for salespersons (crm-id-search-everywhere).
 *
 * A salesperson only ever sees their own customers. When their search is an EXACT
 * identifier (customer id, full mobile or full name of ≥3 letters) and the match belongs
 * to another salesperson, they get a minimal "faded" hint: id, name and owner name only.
 * No mobile, national code or any other field leaves the server; the detail routes stay
 * scoped, so the hint is not openable.
 *
 * Not for admins, registrars ("all" scope) or the team-sales qualifier (Kazemi) — their
 * behaviour is unchanged. Partial / prefix input never matches (no enumeration), and
 * lookups are rate limited per user.
 */
import type { AuthUser } from "./auth";
import { queryRows } from "./crm-db";
import { normalizeCustomerMobile, normalizePersianSearchText } from "./customer-integrity";
import { parseCustomerIdQuery, toLatinDigits } from "./customer-id-search";
import { getTeamSalesConfig } from "./team-sales";

export type OtherOwnerMatch = { id: number; name: string; ownerName: string };
export type OtherOwnerResult = { items: OtherOwnerMatch[]; limited: boolean };

export type ExactLookup =
  | { kind: "id"; id: number }
  | { kind: "phone"; phone: string }
  | { kind: "name"; name: string };

/** Max distinct cross-owner lookups per user per window. */
export const CROSS_OWNER_LIMIT = 30;
export const CROSS_OWNER_WINDOW_MS = 10 * 60_000;
const MAX_MATCHES = 5;

/** Collapse ZWNJ / repeated spaces so «علی  رضایی» and «علی‌رضایی» variants compare equal-ish. */
export function exactNameKey(value: unknown): string {
  return normalizePersianSearchText(value).replace(/\u200c/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which exact lookup (if any) a raw search string represents.
 * - «#1234», «#۱۲۳۴», «1234», «۱۲۳۴» → customer id (a leading 0 is a phone fragment, never an id)
 * - a complete Iranian mobile (09xxxxxxxxx, +98…, 98…, 9xxxxxxxxx) → phone
 * - text with ≥3 letters and no digits → full name (compared for equality, never LIKE)
 */
export function exactLookupOf(raw: unknown): ExactLookup | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const latin = toLatinDigits(text).replace(/[\s\-()]/g, "");
  const parsed = parseCustomerIdQuery(text);
  if (parsed && (parsed.explicit || !/^0/.test(latin))) return { kind: "id", id: parsed.id };
  if (/^\+?\d+$/.test(latin)) {
    const phone = normalizeCustomerMobile(latin);
    return /^09\d{9}$/.test(phone) ? { kind: "phone", phone } : null;
  }
  if (/\d/.test(latin)) return null;
  const name = exactNameKey(text);
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  return letters >= 3 ? { kind: "name", name } : null;
}

/** Salespersons with "assigned" scope, except the team-sales qualifier. */
export function crossOwnerEligible(user: Pick<AuthUser, "role" | "customerScope" | "salespersonId">): boolean {
  if (user.role !== "salesperson" || user.customerScope !== "assigned" || user.salespersonId == null) return false;
  let qualifier: number | null = null;
  try { qualifier = getTeamSalesConfig().qualifierSalespersonId ?? null; } catch { qualifier = null; }
  return qualifier == null || Number(user.salespersonId) !== Number(qualifier);
}

/* ---- rate limit: per user, sliding window, a repeated identical lookup is free ---- */
const buckets = new Map<number, { at: number; key: string }[]>();
export function resetCrossOwnerRateLimit(): void { buckets.clear(); }
function allow(userId: number, key: string, now: number): boolean {
  const recent = (buckets.get(userId) ?? []).filter((entry) => now - entry.at < CROSS_OWNER_WINDOW_MS);
  if (recent.some((entry) => entry.key === key)) { buckets.set(userId, recent); return true; }
  if (recent.length >= CROSS_OWNER_LIMIT) { buckets.set(userId, recent); return false; }
  recent.push({ at: now, key });
  buckets.set(userId, recent);
  return true;
}

/**
 * Other salespersons' customers that EXACTLY match the search. Empty for ineligible users
 * or non-exact input. Only id, name and owner name are selected.
 */
export function findOtherOwnerMatches(
  user: Pick<AuthUser, "id" | "role" | "customerScope" | "salespersonId">,
  raw: unknown,
  now: number = Date.now(),
): OtherOwnerResult {
  if (!crossOwnerEligible(user)) return { items: [], limited: false };
  const lookup = exactLookupOf(raw);
  if (!lookup) return { items: [], limited: false };
  const key = lookup.kind === "id" ? `id:${lookup.id}` : lookup.kind === "phone" ? `phone:${lookup.phone}` : `name:${lookup.name}`;
  if (!allow(Number(user.id), key, now)) return { items: [], limited: true };
  const match = lookup.kind === "id"
    ? { sql: "c.id=?", params: [lookup.id] as (string | number)[] }
    : lookup.kind === "phone"
      ? { sql: "crm_customer_mobile_key(c.phone)=?", params: [lookup.phone] }
      // Exact (normalised) equality; mirrors exactNameKey in SQL (ZWNJ → space, double spaces collapsed, trimmed).
      : { sql: "trim(replace(replace(replace(replace(crm_persian_search_key(c.name),char(8204),' '),'   ',' '),'  ',' '),'  ',' '))=?", params: [lookup.name] };
  const rows = queryRows<{ id: number; name: string; owner_name: string | null }>(
    `SELECT c.id, c.name, s.name owner_name
       FROM customers c JOIN salespersons s ON s.id=c.salesperson_id
      WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id IS NOT NULL AND c.salesperson_id<>?
        AND ${match.sql}
      ORDER BY c.id LIMIT ${MAX_MATCHES}`,
    [Number(user.salespersonId), ...match.params],
  );
  return {
    items: rows.map((row) => ({ id: Number(row.id), name: String(row.name ?? ""), ownerName: String(row.owner_name ?? "") })),
    limited: false,
  };
}
