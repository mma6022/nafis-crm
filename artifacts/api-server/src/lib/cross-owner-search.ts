/**
 * Cross-owner customer lookup for salespersons (crm-id-search-everywhere).
 *
 * A salesperson only ever sees their own customers. When their search is an EXACT
 * identifier (customer id, full mobile or full name of ≥3 letters) and the match belongs
 * to another salesperson, they get a minimal "faded" hint: id, a partial name («سهیلا د***»),
 * a masked mobile («0912*****67») and «کارشناس این مشتری: X». No notes, amounts, documents,
 * calls, national code or full mobile leave the server; the detail routes stay scoped, so the
 * hint is not openable. The «انتقال تماس به کارشناسش» action (transferCallHint) returns only
 * the owner's internal extension and may ping the owner's bell.
 *
 * Every assigned-scope salesperson (experts, trainees 5/19/20 and — since Task C — the team-sales
 * qualifier). Not for admins / registrars ("all" scope) or user 29. Partial / prefix input never
 * matches (no enumeration), lookups are rate limited per user, and matches + clicks are logged
 * (cross_owner_lookup_log; never the raw query).
 */
import type { AuthUser } from "./auth";
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { normalizeCustomerMobile, normalizePersianSearchText } from "./customer-integrity";
import { parseCustomerIdQuery, toLatinDigits } from "./customer-id-search";

/** Task C (2026-10-26): name and mobile leave the server masked («سهیلا د***», «0912*****67»). */
export type OtherOwnerMatch = { id: number; name: string; maskedPhone: string; ownerName: string };
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

/** User ids never offered the lookup (user 29). */
export const CROSS_OWNER_EXCLUDED_USER_IDS = [29];

/**
 * Salespersons with "assigned" scope — every sales expert, the trainees and (since Task C, 2026-10-26) the team-sales
 * qualifier too, so a wrongly-called expert can see whose customer it is and transfer the call. Never user 29.
 */
export function crossOwnerEligible(user: Pick<AuthUser, "role" | "customerScope" | "salespersonId"> & { id?: number }): boolean {
  if (user.id != null && CROSS_OWNER_EXCLUDED_USER_IDS.includes(Number(user.id))) return false;
  return user.role === "salesperson" && user.customerScope === "assigned" && user.salespersonId != null;
}

/** «سهیلا دهقانی» → «سهیلا د***»; a single word keeps its first two letters. */
export function maskCustomerName(raw: unknown): string {
  const words = String(raw ?? "").replace(/\u200c/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "***";
  if (words.length === 1) return `${[...words[0]].slice(0, 2).join("")}***`;
  return `${words[0]} ${[...words[1]][0]}***`;
}

/** «09121234567» → «0912*****67»; anything that is not a full mobile → «***». */
export function maskCustomerPhone(raw: unknown): string {
  const phone = normalizeCustomerMobile(toLatinDigits(String(raw ?? "")).replace(/[\s\-()]/g, ""));
  return /^09\d{9}$/.test(phone) ? `${phone.slice(0, 4)}*****${phone.slice(-2)}` : "***";
}

/* ---- audit log: every cross-owner lookup that returned something, and every «انتقال تماس» click (no raw query) ---- */
let logReady = false;
export function ensureCrossOwnerLog(): void {
  if (logReady) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS cross_owner_lookup_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, salesperson_id INTEGER, action TEXT NOT NULL,
      lookup_kind TEXT, customer_ids TEXT NOT NULL DEFAULT '[]', owner_salesperson_id INTEGER, notified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cross_owner_lookup_user ON cross_owner_lookup_log(user_id, id DESC);`);
  logReady = true;
}
function logLookup(row: { userId: number; salespersonId: number | null; action: "search" | "search_limited" | "transfer_click";
  kind?: string | null; customerIds?: number[]; ownerSalespersonId?: number | null; notified?: boolean; at: number }): void {
  try {
    ensureCrossOwnerLog();
    execute(`INSERT INTO cross_owner_lookup_log(user_id,salesperson_id,action,lookup_kind,customer_ids,owner_salesperson_id,notified,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, [row.userId, row.salespersonId, row.action, row.kind ?? null, JSON.stringify(row.customerIds ?? []),
      row.ownerSalespersonId ?? null, row.notified ? 1 : 0, new Date(row.at).toISOString()]);
  } catch { /* logging never breaks the search */ }
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
  if (!allow(Number(user.id), key, now)) {
    logLookup({ userId: Number(user.id), salespersonId: Number(user.salespersonId), action: "search_limited", kind: lookup.kind, at: now });
    return { items: [], limited: true };
  }
  const match = lookup.kind === "id"
    ? { sql: "c.id=?", params: [lookup.id] as (string | number)[] }
    : lookup.kind === "phone"
      ? { sql: "crm_customer_mobile_key(c.phone)=?", params: [lookup.phone] }
      // Exact (normalised) equality; mirrors exactNameKey in SQL (ZWNJ → space, double spaces collapsed, trimmed).
      : { sql: "trim(replace(replace(replace(replace(crm_persian_search_key(c.name),char(8204),' '),'   ',' '),'  ',' '),'  ',' '))=?", params: [lookup.name] };
  const rows = queryRows<{ id: number; name: string; phone: string | null; owner_id: number; owner_name: string | null }>(
    `SELECT c.id, c.name, c.phone, c.salesperson_id owner_id, s.name owner_name
       FROM customers c JOIN salespersons s ON s.id=c.salesperson_id
      WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id IS NOT NULL AND c.salesperson_id<>?
        AND ${match.sql}
      ORDER BY c.id LIMIT ${MAX_MATCHES}`,
    [Number(user.salespersonId), ...match.params],
  );
  if (rows.length) logLookup({ userId: Number(user.id), salespersonId: Number(user.salespersonId), action: "search", kind: lookup.kind,
    customerIds: rows.map((row) => Number(row.id)), at: now });
  return {
    items: rows.map((row) => ({ id: Number(row.id), name: maskCustomerName(row.name), maskedPhone: maskCustomerPhone(row.phone),
      ownerName: String(row.owner_name ?? "") })),
    limited: false,
  };
}

/** A click is honoured only for a customer this user's own cross-owner search returned in the last 30 minutes. */
export const TRANSFER_CALL_SEARCH_WINDOW_MS = 30 * 60_000;
/** At most one «مشتری‌ات زنگ زده» bell per caller + customer in this window. */
export const TRANSFER_CALL_NOTIFY_WINDOW_MS = 5 * 60_000;
const TRAINEE_IDS = [5, 19, 20];

export type TransferCallResult =
  | { ok: true; ownerName: string; extension: string | null; notified: boolean; notifyReason: string | null }
  | { ok: false; status: 403 | 404; error: string };

/**
 * «انتقال تماس به کارشناسش»: the owner's internal extension (voip_extensions) and — at most once per 5 min — a bell row
 * «مشتری‌ات زنگ زده» addressed to the owner's own user (site_notification_events.recipient_user_id). No customer field
 * beyond the masked hint leaves the server; nothing about the customer, call or ownership is changed.
 */
export function transferCallHint(
  user: Pick<AuthUser, "id" | "role" | "customerScope" | "salespersonId"> & { fullName?: string | null },
  customerId: number,
  now: number = Date.now(),
  opts: { notify?: boolean } = {},
): TransferCallResult {
  if (!crossOwnerEligible(user)) return { ok: false, status: 403, error: "دسترسی ندارید" };
  ensureCrossOwnerLog();
  const since = new Date(now - TRANSFER_CALL_SEARCH_WINDOW_MS).toISOString();
  const searched = queryRows<{ customer_ids: string }>(
    "SELECT customer_ids FROM cross_owner_lookup_log WHERE user_id=? AND action='search' AND created_at>=? ORDER BY id DESC LIMIT 200",
    [Number(user.id), since]).some((row) => { try { return (JSON.parse(row.customer_ids) as number[]).includes(customerId); } catch { return false; } });
  const c = searched ? queryRow<{ id: number; name: string; salesperson_id: number | null; owner_name: string | null }>(
    `SELECT c.id, c.name, c.salesperson_id, s.name owner_name FROM customers c JOIN salespersons s ON s.id=c.salesperson_id
      WHERE c.id=? AND c.merged_into_customer_id IS NULL`, [customerId]) : null;
  if (!c || c.salesperson_id == null || Number(c.salesperson_id) === Number(user.salespersonId))
    return { ok: false, status: 404, error: "این مشتری در نتیجهٔ جست‌وجوی اخیر شما نیست" };
  const owner = queryRow<{ id: number }>(
    "SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' AND active=1 ORDER BY id LIMIT 1", [Number(c.salesperson_id)]);
  let extension: string | null = null;
  try {
    extension = owner ? (queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [owner.id])?.extension ?? null) : null;
  } catch { extension = null; }
  let notified = false;
  let notifyReason: string | null = null;
  if (opts.notify === false) notifyReason = "disabled";
  else if (!owner) notifyReason = "no_user";
  else if (TRAINEE_IDS.includes(Number(c.salesperson_id)) || CROSS_OWNER_EXCLUDED_USER_IDS.includes(Number(owner.id))) notifyReason = "not_eligible";
  else {
    const recent = queryRow("SELECT 1 x FROM cross_owner_lookup_log WHERE user_id=? AND action='transfer_click' AND notified=1 AND customer_ids=? AND created_at>=?",
      [Number(user.id), JSON.stringify([customerId]), new Date(now - TRANSFER_CALL_NOTIFY_WINDOW_MS).toISOString()]);
    const bellReady = (crmDb.prepare("PRAGMA table_info(site_notification_events)").all() as { name: string }[]).some((col) => col.name === "recipient_user_id");
    if (recent) notifyReason = "recent";
    else if (!bellReady) notifyReason = "no_bell";
    else {
      const caller = String(user.fullName ?? "").trim() || "یکی از همکاران";
      execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
        VALUES(?,?,?,'customer',?,'transfer-call','مشتری‌ات زنگ زده',?,'customers.view',?,?,?)`,
        [customerId, String(c.name || "مشتری"), Number(c.salesperson_id), customerId,
          `${caller} می‌خواهد تماس این مشتری را به شما انتقال دهد.`, new Date(now).toISOString(), `transfer-call:${Number(user.id)}`, owner.id]);
      notified = true;
    }
  }
  logLookup({ userId: Number(user.id), salespersonId: Number(user.salespersonId), action: "transfer_click", customerIds: [customerId],
    ownerSalespersonId: Number(c.salesperson_id), notified, at: now });
  return { ok: true, ownerName: String(c.owner_name ?? ""), extension: extension && String(extension).trim() ? String(extension).trim() : null, notified, notifyReason };
}

/** Fields of another expert's customer an assigned-scope salesperson may still see in the duplicate-mobile flow. */
const FOREIGN_KEEP = new Set(["id", "phone", "salespersonId", "salespersonName", "status", "priority", "isUrgent", "createdAt",
  "activityCount", "pendingRepeatRequestCount", "mergedIntoCustomerId"]);

/**
 * Task C (API enforcement): the duplicate-mobile lookups (GET /customers/phone-match, 409 duplicate_mobile) used to return
 * another expert's full profile to any salesperson. For an assigned-scope salesperson and a customer that is not theirs,
 * keep only id / owner / status / counters (needed for «ثبت درخواست برای پرونده موجود»), mask the name and null every
 * other field (notes, national code, address, credit, …). Admins, registrars and the owner are unchanged.
 */
export function redactForeignCustomer<T extends Record<string, unknown>>(
  user: Pick<AuthUser, "role" | "customerScope" | "salespersonId">, customer: T | null | undefined,
): T | null | undefined {
  if (!customer || user.role !== "salesperson" || user.customerScope !== "assigned") return customer;
  if (customer.salespersonId != null && Number(customer.salespersonId) === Number(user.salespersonId)) return customer;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customer)) {
    if (FOREIGN_KEEP.has(key)) out[key] = value;
    else if (key === "name") out[key] = maskCustomerName(value);
    else if (Array.isArray(value)) out[key] = [];
    else if (typeof value === "boolean") out[key] = false;
    else out[key] = null;
  }
  return out as T;
}
