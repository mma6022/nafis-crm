/**
 * Extra mobile numbers for a customer (t853u). Additive table customer_phones;
 * customers.phone stays the primary number and is never dropped or rewritten here.
 * Total cap: 3 numbers including the primary. Created idempotently on first use.
 */
import type { AuthUser } from "./auth";
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { isAdminRole, normalizeCustomerMobile } from "./customer-integrity";

export const CUSTOMER_PHONES_MAX = 3;
export const CUSTOMER_PHONE_LABEL_MAX = 20;
export const INVALID_PHONE_MESSAGE = "شماره‌ی موبایل کامل ۱۱ رقمی را بنویس (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).";
export const LIMIT_MESSAGE = "برای هر مشتری حداکثر سه شماره می‌توان ثبت کرد.";
export const SAME_PHONE_MESSAGE = "این شماره از قبل برای همین مشتری ثبت شده است.";
export const DELETE_PRIMARY_MESSAGE = "شماره‌ی اصلی را نمی‌توان حذف کرد.";
export const NOT_FOUND_MESSAGE = "این مشتری پیدا نشد.";
export const PHONE_NOT_FOUND_MESSAGE = "این شماره پیدا نشد.";
export const FORBIDDEN_MESSAGE = "اجازهٔ افزودن یا حذف شماره برای این مشتری را ندارید.";
export const NOT_OWN_PHONE_MESSAGE = "این شماره مال این مشتری نیست.";

export type ExtraPhone = {
  id: number;
  phone: string;
  label: string | null;
  createdBy: number | null;
  createdAt: string;
};

export type PhoneOwner = {
  id: number;
  name: string;
  salespersonId: number | null;
  salespersonName: string | null;
  mergedIntoCustomerId: number | null;
  status: string | null;
};

let ready = false;
export function ensureCustomerPhonesSchema(): void {
  if (ready) {
    try {
      if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='customer_phones'")) return;
    } catch { /* fall through and try again */ }
    ready = false;
  }
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS customer_phones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      label TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customer_phones_customer ON customer_phones(customer_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_phones_phone ON customer_phones(phone);
    CREATE TRIGGER IF NOT EXISTS customer_phones_unique_insert
    BEFORE INSERT ON customer_phones
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM customers c
        WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_mobile_key(c.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM customer_phones p
        WHERE crm_customer_mobile_key(p.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
    END;
    CREATE TRIGGER IF NOT EXISTS customers_unique_mobile_vs_extras_insert
    BEFORE INSERT ON customers
    WHEN NEW.merged_into_customer_id IS NULL AND COALESCE(NEW.status, 'in_progress') <> 'cancelled'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM customer_phones p
        JOIN customers c ON c.id = p.customer_id
        WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_mobile_key(p.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
    END;
    CREATE TRIGGER IF NOT EXISTS customers_unique_mobile_vs_extras_update
    BEFORE UPDATE OF phone, status, merged_into_customer_id ON customers
    WHEN NEW.merged_into_customer_id IS NULL AND COALESCE(NEW.status, 'in_progress') <> 'cancelled'
    BEGIN
      SELECT CASE WHEN (crm_customer_mobile_key(NEW.phone) IS NOT crm_customer_mobile_key(OLD.phone)
          OR OLD.merged_into_customer_id IS NOT NULL OR COALESCE(OLD.status, 'in_progress') = 'cancelled') AND EXISTS (
        SELECT 1 FROM customer_phones p
        JOIN customers c ON c.id = p.customer_id
        WHERE c.id <> NEW.id AND c.merged_into_customer_id IS NULL
          AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_mobile_key(p.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
    END;
  `);
  ready = true;
}

/** Exact match: this customer's primary or any extra number. Two placeholders (same phone twice). */
export const ANY_PHONE_EXACT_SQL =
  "(crm_customer_mobile_key(c.phone)=? OR EXISTS (SELECT 1 FROM customer_phones xp WHERE xp.customer_id=c.id AND crm_customer_mobile_key(xp.phone)=?))";

/** Substring match used by GET /customers?search= and similar. One extra placeholder for the LIKE. */
export const ANY_PHONE_LIKE_SQL =
  "EXISTS (SELECT 1 FROM customer_phones xp WHERE xp.customer_id=c.id AND xp.phone LIKE ?)";

export function parseCustomerPhone(raw: unknown): { ok: true; phone: string } | { ok: false; message: string } {
  const phone = normalizeCustomerMobile(String(raw ?? "").slice(0, 40));
  if (!/^09\d{9}$/.test(phone)) return { ok: false, message: INVALID_PHONE_MESSAGE };
  return { ok: true, phone };
}

export function parsePhoneLabel(raw: unknown): { ok: true; label: string | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, label: null };
  const label = String(raw).replace(/\s+/g, " ").trim();
  if (!label) return { ok: true, label: null };
  if ([...label].length > CUSTOMER_PHONE_LABEL_MAX) {
    return { ok: false, message: `برچسب شماره حداکثر ${CUSTOMER_PHONE_LABEL_MAX} نویسه باشد.` };
  }
  return { ok: true, label };
}

export function duplicatePhoneMessage(name: string, ownerName: string | null | undefined): string {
  const n = String(name ?? "").trim() || "این مشتری";
  const o = String(ownerName ?? "").trim();
  if (!o) return `این شماره برای «${n}» ثبت شده است (بدون کارشناس).`;
  return `این شماره برای «${n}» با کارشناس «${o}» ثبت شده است.`;
}

function followSurvivor(id: number, merged: number | null): number {
  let cur = id, next = merged, i = 0;
  while (next != null && i < 10) {
    const row = queryRow<{ id: number; merged: number | null }>(
      "SELECT id, merged_into_customer_id merged FROM customers WHERE id=?",
      [Number(next)],
    );
    if (!row) break;
    cur = Number(row.id);
    next = row.merged;
    i += 1;
  }
  return cur;
}

function ownerRow(id: number): PhoneOwner | null {
  return queryRow<PhoneOwner>(
    `SELECT c.id, c.name, c.salesperson_id AS salespersonId, s.name AS salespersonName,
            c.merged_into_customer_id AS mergedIntoCustomerId, COALESCE(c.status, 'in_progress') AS status
       FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?`,
    [id],
  ) ?? null;
}

/** Same ordering as findCustomerByPhone: active → cancelled → merged (then follow survivor). */
export function findOwnerByAnyPhone(phone: string): PhoneOwner | null {
  const parsed = parseCustomerPhone(phone);
  if (!parsed.ok) return null;
  ensureCustomerPhonesSchema();
  const rows = queryRows<{ id: number; merged: number | null }>(
    `SELECT c.id, c.merged_into_customer_id AS merged
       FROM customers c
      WHERE crm_customer_mobile_key(c.phone)=?
         OR EXISTS (SELECT 1 FROM customer_phones p WHERE p.customer_id=c.id AND crm_customer_mobile_key(p.phone)=?)
      ORDER BY CASE
        WHEN c.merged_into_customer_id IS NULL AND COALESCE(c.status,'in_progress') <> 'cancelled' THEN 0
        WHEN c.merged_into_customer_id IS NULL THEN 1
        ELSE 2 END,
        c.created_at DESC, c.id DESC`,
    [parsed.phone, parsed.phone],
  );
  if (!rows.length) return null;
  const id = followSurvivor(Number(rows[0].id), rows[0].merged);
  return ownerRow(id);
}

export function customerOwnsPhone(customerId: number, phone: string): boolean {
  const parsed = parseCustomerPhone(phone);
  if (!parsed.ok) return false;
  ensureCustomerPhonesSchema();
  const primary = queryRow<{ phone: string | null }>(
    "SELECT phone FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
    [customerId],
  );
  if (primary && normalizeCustomerMobile(primary.phone ?? "") === parsed.phone) return true;
  return Boolean(queryRow(
    "SELECT 1 x FROM customer_phones WHERE customer_id=? AND phone=?",
    [customerId, parsed.phone],
  ));
}

export function listExtraPhones(customerId: number): ExtraPhone[] {
  ensureCustomerPhonesSchema();
  return queryRows<{ id: number; phone: string; label: string | null; created_by: number | null; created_at: string }>(
    "SELECT id, phone, label, created_by, created_at FROM customer_phones WHERE customer_id=? ORDER BY id",
    [customerId],
  ).map((row) => ({
    id: Number(row.id),
    phone: String(row.phone),
    label: row.label ?? null,
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: String(row.created_at),
  }));
}

export function loadCustomerPrimary(customerId: number): { id: number; phone: string; salespersonId: number | null } | null {
  const row = queryRow<{ id: number; phone: string | null; salesperson_id: number | null }>(
    "SELECT id, phone, salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
    [customerId],
  );
  if (!row) return null;
  return { id: Number(row.id), phone: String(row.phone ?? ""), salespersonId: row.salesperson_id == null ? null : Number(row.salesperson_id) };
}

/** lockdownAccess: the request already passed expert_lockdown for this customer (today / incoming / case). */
export function canManageCustomerPhones(user: AuthUser, customerId: number, lockdownAccess = false): boolean {
  const row = loadCustomerPrimary(customerId);
  if (!row) return false;
  if (isAdminRole(user.role)) return true;
  if (!user.permissions.includes("customers.update")) return false;
  if (user.customerScope === "all") return true;
  if (user.salespersonId != null && row.salespersonId === Number(user.salespersonId)) return true;
  return Boolean(lockdownAccess);
}

export function canViewCustomerPhones(user: AuthUser, customerId: number, lockdownAccess = false): boolean {
  const row = loadCustomerPrimary(customerId);
  if (!row) return false;
  if (isAdminRole(user.role) || user.customerScope === "all") return true;
  if (user.salespersonId != null && row.salespersonId === Number(user.salespersonId)) return true;
  return Boolean(lockdownAccess);
}

export type PhoneListView = {
  customerId: number;
  primary: { phone: string; label: string };
  extras: ExtraPhone[];
  total: number;
  max: number;
  canAdd: boolean;
  canDelete: boolean;
};

export function listCustomerPhones(user: AuthUser, customerId: number, lockdownAccess = false): { ok: true; view: PhoneListView } | { ok: false; status: number; error: string; message: string } {
  const row = loadCustomerPrimary(customerId);
  if (!row) return { ok: false, status: 404, error: "not_found", message: NOT_FOUND_MESSAGE };
  const extras = listExtraPhones(customerId);
  const can = canManageCustomerPhones(user, customerId, lockdownAccess);
  const primary = parseCustomerPhone(row.phone);
  return {
    ok: true,
    view: {
      customerId,
      primary: { phone: primary.ok ? primary.phone : row.phone, label: "شماره اصلی" },
      extras,
      total: 1 + extras.length,
      max: CUSTOMER_PHONES_MAX,
      canAdd: can && 1 + extras.length < CUSTOMER_PHONES_MAX,
      canDelete: can,
    },
  };
}

export type AddPhoneFail = { ok: false; status: number; error: string; message: string; field?: string; customer?: PhoneOwner };
export type AddPhoneOk = { ok: true; extra: ExtraPhone; view: PhoneListView };

export function addCustomerPhone(user: AuthUser, customerId: number, rawPhone: unknown, rawLabel: unknown, now = new Date(), lockdownAccess = false): AddPhoneOk | AddPhoneFail {
  const row = loadCustomerPrimary(customerId);
  if (!row) return { ok: false, status: 404, error: "not_found", message: NOT_FOUND_MESSAGE };
  if (!canManageCustomerPhones(user, customerId, lockdownAccess)) return { ok: false, status: 403, error: "forbidden", message: FORBIDDEN_MESSAGE };
  const parsed = parseCustomerPhone(rawPhone);
  if (!parsed.ok) return { ok: false, status: 400, error: "invalid_phone", message: parsed.message, field: "phone" };
  const label = parsePhoneLabel(rawLabel);
  if (!label.ok) return { ok: false, status: 400, error: "invalid_label", message: label.message, field: "label" };
  if (customerOwnsPhone(customerId, parsed.phone)) {
    return { ok: false, status: 409, error: "same_customer", message: SAME_PHONE_MESSAGE, field: "phone" };
  }
  const owner = findOwnerByAnyPhone(parsed.phone);
  if (owner && Number(owner.id) !== Number(customerId)) {
    return {
      ok: false,
      status: 409,
      error: "duplicate_mobile",
      message: duplicatePhoneMessage(owner.name, owner.salespersonName),
      field: "phone",
      customer: owner,
    };
  }
  const extras = listExtraPhones(customerId);
  if (1 + extras.length >= CUSTOMER_PHONES_MAX) {
    return { ok: false, status: 409, error: "phone_limit", message: LIMIT_MESSAGE };
  }
  const at = now.toISOString();
  try {
    const id = execute(
      "INSERT INTO customer_phones(customer_id, phone, label, created_by, created_at) VALUES(?,?,?,?,?)",
      [customerId, parsed.phone, label.label, user.id, at],
    );
    const extra: ExtraPhone = { id: Number(id), phone: parsed.phone, label: label.label, createdBy: user.id, createdAt: at };
    const listed = listCustomerPhones(user, customerId, lockdownAccess);
    if (!listed.ok) return { ok: false, status: listed.status, error: listed.error, message: listed.message };
    return { ok: true, extra, view: listed.view };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (text.includes("ACTIVE_CUSTOMER_MOBILE_CONFLICT") || text.includes("UNIQUE")) {
      const again = findOwnerByAnyPhone(parsed.phone);
      if (again && Number(again.id) !== Number(customerId)) {
        return {
          ok: false,
          status: 409,
          error: "duplicate_mobile",
          message: duplicatePhoneMessage(again.name, again.salespersonName),
          field: "phone",
          customer: again,
        };
      }
      return { ok: false, status: 409, error: "same_customer", message: SAME_PHONE_MESSAGE, field: "phone" };
    }
    throw err;
  }
}

export function deleteCustomerPhone(user: AuthUser, customerId: number, phoneId: number, lockdownAccess = false): { ok: true; view: PhoneListView } | AddPhoneFail {
  const row = loadCustomerPrimary(customerId);
  if (!row) return { ok: false, status: 404, error: "not_found", message: NOT_FOUND_MESSAGE };
  if (!canManageCustomerPhones(user, customerId, lockdownAccess)) return { ok: false, status: 403, error: "forbidden", message: FORBIDDEN_MESSAGE };
  if (!Number.isSafeInteger(phoneId) || phoneId <= 0) {
    return { ok: false, status: 400, error: "not_found", message: PHONE_NOT_FOUND_MESSAGE };
  }
  const extra = queryRow<{ id: number; customer_id: number }>(
    "SELECT id, customer_id FROM customer_phones WHERE id=?",
    [phoneId],
  );
  if (!extra) return { ok: false, status: 404, error: "not_found", message: PHONE_NOT_FOUND_MESSAGE };
  if (Number(extra.customer_id) !== Number(customerId)) {
    return { ok: false, status: 404, error: "not_found", message: PHONE_NOT_FOUND_MESSAGE };
  }
  execute("DELETE FROM customer_phones WHERE id=? AND customer_id=?", [phoneId, customerId]);
  const listed = listCustomerPhones(user, customerId, lockdownAccess);
  if (!listed.ok) return { ok: false, status: listed.status, error: listed.error, message: listed.message };
  return { ok: true, view: listed.view };
}

/** All normalised numbers for a customer (primary first), for incoming-call matching and click-to-call. */
export function customerPhoneKeys(customerId: number): string[] {
  const row = queryRow<{ phone: string | null }>("SELECT phone FROM customers WHERE id=?", [customerId]);
  const keys: string[] = [];
  const primary = row?.phone ? normalizeCustomerMobile(row.phone) : "";
  if (/^09\d{9}$/.test(primary)) keys.push(primary);
  for (const extra of listExtraPhones(customerId)) {
    if (!keys.includes(extra.phone)) keys.push(extra.phone);
  }
  return keys;
}

/** Extra phones of every (possibly merged) customer, mapped onto the surviving id for customerMatcher. */
export function extraPhoneIndexRows(): { id: number; phone: string; status: string | null }[] {
  ensureCustomerPhonesSchema();
  const rows = queryRows<{ id: number; phone: string; status: string | null; merged: number | null }>(
    `SELECT c.id, p.phone, c.status, c.merged_into_customer_id AS merged
       FROM customer_phones p JOIN customers c ON c.id=p.customer_id`,
  );
  return rows.map((row) => ({
    id: followSurvivor(Number(row.id), row.merged),
    phone: row.phone,
    status: row.status,
  }));
}

export function phoneBelongsToActiveCustomer(phone: string, exceptCustomerId: number | null = null): PhoneOwner | null {
  const owner = findOwnerByAnyPhone(phone);
  if (!owner) return null;
  if (exceptCustomerId != null && Number(owner.id) === Number(exceptCustomerId)) return null;
  if (owner.mergedIntoCustomerId != null) return owner;
  if (owner.status === "cancelled") return owner;
  return owner;
}
