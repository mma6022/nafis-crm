import type { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./auth";
import { customerMergeFamilySql } from "./customer-chat-history";

/**
 * Authorize a historical customer artifact through its audited merge target.
 * This deliberately does not authorize creating new artifacts for the source.
 */
export function assertArchivedCustomerSurvivorAccess(
  db: DatabaseSync,
  sourceCustomerId: number,
  actor: Pick<AuthUser, "role" | "customerScope" | "salespersonId">,
): number {
  const survivor = db.prepare(`
    ${customerMergeFamilySql}
    SELECT target.id,target.salesperson_id FROM family
    JOIN customers target ON target.id=family.customer_id
    WHERE family.origin_customer_id=? AND family.customer_id<>family.origin_customer_id
  `).get(sourceCustomerId) as { id: number; salesperson_id: number | null } | undefined;
  if (!survivor) throw new Error("customer_not_found");
  if (actor.role !== "admin" && actor.customerScope === "assigned"
    && survivor.salesperson_id !== actor.salespersonId) {
    throw new Error("Forbidden");
  }
  return Number(survivor.id);
}