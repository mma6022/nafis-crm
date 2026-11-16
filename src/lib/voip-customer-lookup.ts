import type { DatabaseSync } from "node:sqlite";

export type VoipCustomer = { id: number; name: string; phone: string };

export function listActiveVoipCustomers(
  db: DatabaseSync,
  salespersonId: number | null,
): VoipCustomer[] {
  const owner = salespersonId === null ? "" : " AND salesperson_id=?";
  const params = salespersonId === null ? [] : [salespersonId];
  return db.prepare(
    `SELECT id,name,phone FROM customers
     WHERE merged_into_customer_id IS NULL${owner} ORDER BY name,id`,
  ).all(...params) as VoipCustomer[];
}

export function findVoipCustomerByPhone(
  db: DatabaseSync,
  phone: string,
  normalizePhone: (value: string) => string | null,
  salespersonId: number | null,
): VoipCustomer | null {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const active = listActiveVoipCustomers(db, salespersonId)
    .find((customer) => normalizePhone(customer.phone) === normalized);
  if (active) return active;

  const owner = salespersonId === null ? "" : " AND survivor.salesperson_id=?";
  const params = salespersonId === null ? [] : [salespersonId];
  const aliases = db.prepare(`
    SELECT survivor.id,survivor.name,survivor.phone,source.phone AS source_phone
    FROM customers source
    JOIN customers survivor ON survivor.id=source.merged_into_customer_id
    WHERE source.merged_into_customer_id IS NOT NULL
      AND survivor.merged_into_customer_id IS NULL${owner}
    ORDER BY survivor.id,source.id
  `).all(...params) as Array<VoipCustomer & { source_phone: string }>;
  const match = aliases.find((customer) => normalizePhone(customer.source_phone) === normalized);
  return match ? { id: Number(match.id), name: match.name, phone: match.phone } : null;
}