import type { DatabaseSync } from "node:sqlite";

function digits(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\D/g, "");
}

export function normalizeCustomerMobile(value: unknown): string {
  let normalized = digits(value);
  if (normalized.startsWith("0098") && normalized.length === 14) normalized = `0${normalized.slice(4)}`;
  else if (normalized.startsWith("98") && normalized.length === 12) normalized = `0${normalized.slice(2)}`;
  else if (normalized.length === 10 && normalized.startsWith("9")) normalized = `0${normalized}`;
  return normalized;
}

export function normalizeCustomerNationalCode(value: unknown): string {
  return digits(value);
}

export function normalizePersianSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک");
}

export function registerCustomerIdentityFunctions(db: DatabaseSync): void {
  db.function("crm_customer_mobile_key", (value: unknown) => normalizeCustomerMobile(value));
  db.function("crm_customer_national_code_key", (value: unknown) => normalizeCustomerNationalCode(value));
  db.function("crm_persian_search_key", (value: unknown) => normalizePersianSearchText(value));
}

export function installCustomerIdentityGuards(db: DatabaseSync): void {
  registerCustomerIdentityFunctions(db);
  db.exec(`
    DROP TRIGGER IF EXISTS customers_unique_mobile_insert;
    DROP TRIGGER IF EXISTS customers_unique_mobile_update;
    DROP TRIGGER IF EXISTS customers_unique_national_code_insert;
    CREATE TRIGGER customers_unique_mobile_insert
    BEFORE INSERT ON customers
    WHEN NEW.merged_into_customer_id IS NULL AND COALESCE(NEW.status, 'in_progress') <> 'cancelled'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM customers c
        WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_mobile_key(c.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
      SELECT CASE WHEN NEW.national_code IS NOT NULL AND trim(NEW.national_code) <> '' AND EXISTS (
        SELECT 1 FROM customers c
        WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_national_code_key(c.national_code) = crm_customer_national_code_key(NEW.national_code)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_NATIONAL_CODE_CONFLICT') END;
    END;
    CREATE TRIGGER customers_unique_mobile_update
    BEFORE UPDATE OF phone,national_code,status,merged_into_customer_id ON customers
    WHEN NEW.merged_into_customer_id IS NULL AND COALESCE(NEW.status, 'in_progress') <> 'cancelled'
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM customers c
        WHERE c.id <> NEW.id AND c.merged_into_customer_id IS NULL
          AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_mobile_key(c.phone) = crm_customer_mobile_key(NEW.phone)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_MOBILE_CONFLICT') END;
      SELECT CASE WHEN NEW.national_code IS NOT NULL AND trim(NEW.national_code) <> '' AND EXISTS (
        SELECT 1 FROM customers c
        WHERE c.id <> NEW.id AND c.merged_into_customer_id IS NULL
          AND COALESCE(c.status, 'in_progress') <> 'cancelled'
          AND crm_customer_national_code_key(c.national_code) = crm_customer_national_code_key(NEW.national_code)
      ) THEN RAISE(ABORT, 'ACTIVE_CUSTOMER_NATIONAL_CODE_CONFLICT') END;
    END;
  `);
}

export function isAdminRole(role: unknown): boolean {
  return role === "admin";
}