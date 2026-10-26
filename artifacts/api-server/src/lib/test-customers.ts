/**
 * v10: «مشتری تستی» — reporting-layer filter only (no data is changed).
 * A customer is a test customer when its name, after trimming and stripping leading '[' characters, starts with
 * "TEST" (case-insensitive) or «تست», or its description contains "[TEST]" (case-insensitive).
 * Used by the manager report / alerts / summaries and by the assistants' /my-context when the admin switch
 * assistant_settings.exclude_test_customers is ON (default ON: a missing row = ON).
 */
import type { DatabaseSync } from "node:sqlite";

export const EXCLUDE_TEST_CUSTOMERS_KEY = "exclude_test_customers";
const WS = "' '||char(9)||char(10)||char(13)";
/** SQL boolean expression: 1 when the customers row aliased `c` is a test customer. */
export function testCustomerSql(c = "c"): string {
  const nm = `ltrim(trim(COALESCE(NULLIF(trim(${c}.name),''), trim(COALESCE(${c}.first_name,'')||' '||COALESCE(${c}.last_name,''))), ${WS}), '['||${WS})`;
  return `(upper(substr(${nm},1,4))='TEST' OR substr(${nm},1,3)='تست' OR upper(COALESCE(${c}.description,'')) LIKE '%[TEST]%')`;
}
/** SQL predicate for a nullable customer id column: true when the id is NULL or the customer is NOT a test customer. */
export function notTestCustomerIdSql(idExpr: string): string {
  return `(${idExpr} IS NULL OR NOT EXISTS (SELECT 1 FROM customers tc WHERE tc.id=${idExpr} AND ${testCustomerSql("tc")}))`;
}
export function isTestCustomerName(name: unknown, description?: unknown): boolean {
  const n = String(name ?? "").trim().replace(/^[\[\s]+/, "");
  return /^test/i.test(n) || n.startsWith("تست") || /\[test\]/i.test(String(description ?? ""));
}
export function excludeTestOn(db: DatabaseSync): boolean {
  try { const r = db.prepare("SELECT value FROM assistant_settings WHERE key=?").get(EXCLUDE_TEST_CUSTOMERS_KEY) as { value?: string } | undefined; return r?.value !== "0"; }
  catch { return true; }
}
export function testCustomerIds(db: DatabaseSync): Set<number> {
  try { return new Set((db.prepare(`SELECT id FROM customers c WHERE ${testCustomerSql("c")}`).all() as any[]).map(r => Number(r.id))); } catch { return new Set(); }
}
