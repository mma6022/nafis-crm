import { crmDb, queryRow, execute, runImmediateTransaction } from "./crm-db";
import { nextAllocatedSalesperson } from "./customer-create";
import { defaultOwnerDecision, logRuleAssignment } from "./default-owner-rule";
import "./customer-chat-schema";

crmDb.exec(`
CREATE TABLE IF NOT EXISTS customer_portal_registrations(
 customer_id INTEGER PRIMARY KEY REFERENCES customers(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_portal_inquiry_claims(
 customer_id INTEGER NOT NULL,identity_key TEXT NOT NULL,status TEXT NOT NULL,
 response_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(customer_id,identity_key));
`);

export function allocatePortalSalesperson(): number {
  // Caller already owns the customer-registration transaction. Allocation
  // cursor advancement and insertion must commit together.
  const program = queryRow<{ id: number }>(
    "SELECT id FROM allocation_programs WHERE active=1 AND is_default=1 ORDER BY id LIMIT 1");
  if (!program) throw new Error("NO_DEFAULT_ALLOCATION_PROGRAM");
  const id = nextAllocatedSalesperson(Number(program.id));
  const valid = id && queryRow(
    "SELECT s.id FROM salespersons s JOIN users u ON u.salesperson_id=s.id AND u.active=1 WHERE s.id=? AND s.active=1 GROUP BY s.id HAVING COUNT(u.id)=1", [id]);
  if (!valid) throw new Error("NO_ACTIVE_SALESPERSON");
  return Number(id);
}
/**
 * crm-default-owner: owner of a NEW portal customer. «قانون ثبت» (source portal, no registrar) wins and does not move
 * the allocation cursor; otherwise the old portal allocation decides. Call portalOwnerLogged() right after the INSERT.
 */
export function portalNewCustomerOwner(): { salespersonId: number; ruleApplied: boolean } {
  const d = defaultOwnerDecision("portal", null);
  if (d.apply) return { salespersonId: d.ownerSalespersonId, ruleApplied: true };
  return { salespersonId: allocatePortalSalesperson(), ruleApplied: false };
}
export function portalOwnerLogged(customerId: number, owner: { salespersonId: number; ruleApplied: boolean }) {
  if (owner.ruleApplied) logRuleAssignment({ customerId, registrarUserId: null, source: "portal", ownerSalespersonId: owner.salespersonId });
}
export function markPortalRegistration(id: number) {
  execute("INSERT OR IGNORE INTO customer_portal_registrations(customer_id,created_at) VALUES(?,?)", [id,new Date().toISOString()]);
}
export function isPortalRegistration(id: number) {
  return !!queryRow("SELECT 1 FROM customer_portal_registrations WHERE customer_id=?", [id]);
}
export function isCustomerSubmitted(id: number) {
  return !!queryRow("SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action='customer_portal_created' AND actor_customer_id IS NOT NULL LIMIT 1", [id]);
}
export function claimInquiry(customerId: number, key: string) {
  return runImmediateTransaction(() => {
    const old = queryRow<{status:string;response_json:string|null;updated_at:string}>(
      "SELECT * FROM customer_portal_inquiry_claims WHERE customer_id=? AND identity_key=?", [customerId,key]);
    if (old?.response_json) return {cached:JSON.parse(old.response_json),claimed:false};
    // An unknown provider outcome must not silently become another paid call.
    if (old) return {cached:null,claimed:false};
    execute("INSERT INTO customer_portal_inquiry_claims(customer_id,identity_key,status,updated_at) VALUES(?,?,'pending',?)",
      [customerId,key,new Date().toISOString()]);
    return {cached:null,claimed:true};
  });
}
