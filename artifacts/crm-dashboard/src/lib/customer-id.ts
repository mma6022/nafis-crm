// Shared customer-id helpers: display (Persian digits) and search (Latin, Persian and Arabic digits, optional «#»).
import { normalizePersianSearchText } from './search';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(value: unknown): string {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (d) => String(FA.indexOf(d) >= 0 ? FA.indexOf(d) : AR.indexOf(d)));
}

export function toPersianDigits(value: unknown): string {
  return String(value ?? '').replace(/\d/g, (d) => FA[Number(d)]);
}

/** A valid positive customer id, or null. Accepts numbers and digit strings in any script. */
export function customerIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(toLatinDigits(value).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type CustomerIdQuery = { id: number; explicit: boolean };

/**
 * «1234», «#1234», «#۱۲۳۴», «٫١٢٣٤» → { id: 1234 }. `explicit` is true when the user typed «#»,
 * meaning they asked for the id only.
 */
export function parseCustomerIdQuery(raw: unknown): CustomerIdQuery | null {
  const text = toLatinDigits(raw).trim();
  const m = /^([#＃])?\s*(\d{1,9})$/.exec(text);
  if (!m) return null;
  const id = Number(m[2]);
  return id > 0 ? { id, explicit: Boolean(m[1]) } : null;
}

/** Normalised text for client-side LIKE-style matching: Persian letters folded, digits Latin, leading «#» dropped. */
export function normalizeCustomerSearch(raw: unknown): string {
  return toLatinDigits(normalizePersianSearchText(raw)).trim().replace(/^[#＃]\s*/, '').toLowerCase();
}

type Searchable = { id?: unknown; name?: unknown; phone?: unknown; extra?: unknown[] };

/** Client-side customer match used by pickers and in-page filters. */
export function matchesCustomerSearch(query: string, row: Searchable): boolean {
  const q = query.trim();
  if (!q) return true;
  const idQuery = parseCustomerIdQuery(q);
  const rowId = customerIdOf(row.id);
  if (idQuery && rowId === idQuery.id) return true;
  if (idQuery?.explicit) return false;
  const needle = normalizeCustomerSearch(q);
  const hay = normalizeCustomerSearch([row.name, row.phone, ...(row.extra ?? [])].filter((v) => v !== null && v !== undefined).join(' '));
  return hay.includes(needle);
}

/** Stable sort that moves exact customer-id matches to the top. */
export function rankExactCustomerId<T>(rows: readonly T[], query: string, idOf: (row: T) => unknown): T[] {
  const idQuery = parseCustomerIdQuery(query);
  if (!idQuery) return [...rows];
  const exact: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (customerIdOf(idOf(row)) === idQuery.id ? exact : rest).push(row);
  return [...exact, ...rest];
}
