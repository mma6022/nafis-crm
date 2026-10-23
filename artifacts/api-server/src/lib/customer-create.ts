import { execute, executeChanges, queryRow, queryRows } from "./crm-db";

export type CustomerCreateInput = {
  name: string;
  phone: string;
  description?: string | null;
  nationalCode?: string | null;
  birthDateJalali?: string | null;
  postalCode?: string | null;
  fatherName?: string | null;
  address?: string | null;
  email?: string | null;
  isUrgent?: boolean;
  salespersonId?: number | null;
  allocationProgramId?: number | null;
  priority?: number | null;
  status?: string;
  assignedSalespersonId?: number | null;
};

export function nextAllocatedSalesperson(programId: number): number | undefined {
  const program = queryRow<{
    cursor_item_index: number;
    cursor_item_used: number;
  }>(
    `SELECT cursor_item_index, cursor_item_used
     FROM allocation_programs WHERE id = ? AND active = 1`,
    [programId],
  );
  if (!program) return undefined;
  const items = queryRows<{ salesperson_id: number; quota: number }>(
    `SELECT api.salesperson_id, api.quota
     FROM allocation_program_items api
     JOIN salespersons s ON s.id = api.salesperson_id
     WHERE api.program_id = ? AND s.active = 1
     ORDER BY api.sort_order, api.id`,
    [programId],
  );
  if (!items.length) return undefined;
  const index = Math.max(0, Number(program.cursor_item_index)) % items.length;
  const used = Math.max(0, Number(program.cursor_item_used));
  const item = items[index];
  const reachedQuota = used + 1 >= Number(item.quota);
  executeChanges(
    `UPDATE allocation_programs
     SET cursor_item_index = ?, cursor_item_used = ?, updated_at = ?
     WHERE id = ?`,
    [
      reachedQuota ? (index + 1) % items.length : index,
      reachedQuota ? 0 : used + 1,
      new Date().toISOString(),
      programId,
    ],
  );
  return Number(item.salesperson_id);
}

/** Insert a new unverified CRM customer and apply optional allocation within the caller's transaction. */
export function insertCustomerRecord(input: CustomerCreateInput): number {
  const allocatedSalespersonId = input.allocationProgramId
    ? nextAllocatedSalesperson(input.allocationProgramId)
    : undefined;
  if (input.allocationProgramId && !allocatedSalespersonId) {
    throw new Error("ALLOCATION_PROGRAM_UNAVAILABLE");
  }
  return execute(
    `INSERT INTO customers
      (name, phone, description, national_code, birth_date_jalali, postal_code,
       father_name, address, email, verification_status, is_urgent, created_at,
       salesperson_id, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.phone,
      input.description ?? null,
      input.nationalCode ?? null,
      input.birthDateJalali ?? null,
      input.postalCode ?? null,
      input.fatherName ?? null,
      input.address ?? null,
      input.email ?? null,
      input.isUrgent ? 1 : 0,
      new Date().toISOString(),
      input.assignedSalespersonId !== undefined
        ? input.assignedSalespersonId
        : input.salespersonId ?? allocatedSalespersonId ?? null,
      input.priority ?? null,
      input.status ?? "in_progress",
    ],
  );
}
