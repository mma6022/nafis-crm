import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { defaultOwnerDecision, logRuleAssignment, type RegistrationSource } from "./default-owner-rule";
import { customerSourceFor } from "./registration-sources";
import { recordUrgentChange } from "./customer-urgent";
import { intakeValuesForCreate, type IntakeInput } from "./lead-intake";

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
  /** crm-default-owner: real registrar (users.id) — null/undefined for system intakes. */
  registeredByUserId?: number | null;
  /** crm-default-owner: intake channel; every caller passes one. */
  registrationSource: RegistrationSource;
  /** crm-instagram-leads: source / intake rank / registrar note (validated by the caller); missing → server defaults. */
  intake?: IntakeInput;
  /** urgent v1.1: the required reason when created «فوری» from the staff form. */
  urgentReason?: { reason: string; code: string } | null;
  /** incoming2-59 (expert lockdown «ثبت مشتری جدید»): the registering expert owns the customer; «قانون ثبت» is not applied. */
  skipDefaultOwnerRule?: boolean;
};

/** Result of the last insertCustomerRecord in this process (read synchronously by the caller right after the insert). */
export type CustomerCreateOutcome = { customerId: number; ruleApplied: boolean; salespersonId: number | null };
let lastOutcome: CustomerCreateOutcome | null = null;
export const lastCustomerCreateOutcome = (): CustomerCreateOutcome | null => lastOutcome;

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

/**
 * Insert a new unverified CRM customer and apply optional allocation within the caller's transaction.
 * crm-default-owner: when «قانون ثبت» applies, the default owner wins over assignment/allocation (the allocation cursor is
 * NOT advanced) and one history row is written; registered_by / registration_source are always stored.
 */
export function insertCustomerRecord(input: CustomerCreateInput): number {
  const rule: ReturnType<typeof defaultOwnerDecision> = input.skipDefaultOwnerRule
    ? { apply: false, skip: "incoming_call_expert" }
    : defaultOwnerDecision(input.registrationSource, input.registeredByUserId ?? null);
  let owner: number | null;
  if (rule.apply) owner = rule.ownerSalespersonId;
  else {
    const allocatedSalespersonId = input.allocationProgramId
      ? nextAllocatedSalesperson(input.allocationProgramId)
      : undefined;
    if (input.allocationProgramId && !allocatedSalespersonId) {
      throw new Error("ALLOCATION_PROGRAM_UNAVAILABLE");
    }
    owner = input.assignedSalespersonId !== undefined
      ? input.assignedSalespersonId
      : input.salespersonId ?? allocatedSalespersonId ?? null;
  }
  const createdAt = new Date().toISOString();
  const iv = intakeValuesForCreate(crmDb, input.registrationSource, input.registeredByUserId ?? null, input.intake, createdAt);
  const id = execute(
    `INSERT INTO customers
      (name, phone, description, national_code, birth_date_jalali, postal_code,
       father_name, address, email, verification_status, is_urgent, created_at,
       salesperson_id, priority, status, registered_by, registration_source, source,
       lead_source, lead_source_other, intake_credit_rank, registrar_note, registered_by_seller_id, registered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      createdAt,
      owner,
      input.priority ?? null,
      input.status ?? "in_progress",
      input.registeredByUserId ?? null,
      input.registrationSource,
      customerSourceFor(input.registrationSource, iv.leadSource),
      iv.leadSource, iv.leadSourceOther, iv.intakeCreditRank, iv.registrarNote, iv.registeredBySellerId, iv.registeredAt,
    ],
  );
  // crm-urgent-history: a customer created «فوری» counts as a set (one history row + one bell to Kazemi).
  if (input.isUrgent) recordUrgentChange(crmDb, id, 0, 1, input.registeredByUserId != null
    ? { kind: "user", userId: input.registeredByUserId } : { kind: "system", label: input.registrationSource }, `create:${input.registrationSource}`,
    input.urgentReason?.reason ?? null, { reasonCode: input.urgentReason?.code ?? null });
  if (rule.apply) logRuleAssignment({ customerId: id, registrarUserId: input.registeredByUserId ?? null, source: input.registrationSource,
    ownerSalespersonId: rule.ownerSalespersonId, priority: input.priority ?? null });
  lastOutcome = { customerId: id, ruleApplied: rule.apply, salespersonId: owner };
  return id;
}
