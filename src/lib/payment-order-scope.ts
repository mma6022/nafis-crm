import type { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./auth";

type PaymentScopeActor = Pick<AuthUser, "role" | "customerScope" | "salespersonId">;

/** Resolve archived payment identity through its audited, active survivor. */
export function paymentCustomerForActor(
  db: DatabaseSync,
  customerId: number,
  actor: PaymentScopeActor,
): any | undefined {
  const customer = db.prepare(`SELECT id,name,national_code,birth_date_jalali,salesperson_id,
      merged_into_customer_id
    FROM customers WHERE id=?`).get(customerId) as any;
  if (!customer) return undefined;
  if (customer.merged_into_customer_id == null) {
    if (actor.role !== "admin" && actor.customerScope !== "all"
      && (actor.salespersonId === null || customer.salesperson_id !== actor.salespersonId)) return undefined;
    return { ...customer, payment_scope_salesperson_id: customer.salesperson_id };
  }
  const survivor = db.prepare(`SELECT target.id,target.salesperson_id
    FROM customer_merge_audit audit
    JOIN customers target ON target.id=audit.survivor_customer_id
    WHERE audit.source_customer_id=? AND target.id=?
      AND target.merged_into_customer_id IS NULL`).get(
    customer.id, customer.merged_into_customer_id,
  ) as { id: number; salesperson_id: number | null } | undefined;
  if (!survivor || (actor.role !== "admin" && actor.customerScope === "assigned"
    && survivor.salesperson_id !== actor.salespersonId)) return undefined;
  return { ...customer, payment_scope_salesperson_id: survivor.salesperson_id };
}

/** SQL scope used by order lists; archived rows are authorized by survivor, never source owner. */
export function paymentOrderListScope(actor: PaymentScopeActor): { sql: string; params: number[] } {
  const auditedSurvivor = `EXISTS (
    SELECT 1 FROM customer_merge_audit audit
    JOIN customers survivor ON survivor.id=audit.survivor_customer_id
    WHERE audit.source_customer_id=c.id AND c.merged_into_customer_id=survivor.id
      AND survivor.merged_into_customer_id IS NULL
  )`;
  if (actor.role !== "admin" && actor.customerScope === "assigned") {
    const salespersonId = actor.salespersonId ?? -1;
    return {
      sql: ` AND ((c.merged_into_customer_id IS NULL AND c.salesperson_id=?)
        OR (${auditedSurvivor} AND EXISTS (
          SELECT 1 FROM customer_merge_audit audit
          JOIN customers survivor ON survivor.id=audit.survivor_customer_id
          WHERE audit.source_customer_id=c.id AND c.merged_into_customer_id=survivor.id
            AND survivor.merged_into_customer_id IS NULL AND survivor.salesperson_id=?
        )))`,
      params: [salespersonId, salespersonId],
    };
  }
  return {
    sql: ` AND (c.merged_into_customer_id IS NULL OR ${auditedSurvivor})`,
    params: [],
  };
}