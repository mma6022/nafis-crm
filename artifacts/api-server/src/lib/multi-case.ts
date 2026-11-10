/**
 * MULTI-CASE v1 — flag.multi_case_v1 (call_queue_settings). Default OFF.
 *
 * OFF: do not call the guards. Filing-fee reuse, one open draft per customer, and
 * calls/reminders without a case link stay as they are.
 *
 * ON:
 *  - Unlimited cases per customer, but one OPEN case per customer+plan
 *    (not deleted, status ≠ rejected, stage ≠ completed). Closing releases the plan.
 *  - The same Idempotency-Key repeats that request. A new key while the plan is open
 *    is open_same_plan_case, never a silent return of the other case.
 *  - Each new case pays its own fee. An unattached fee for that plan blocks a second charge.
 *  - Drafts may set request_key so two requests of one customer do not replace each other.
 *  - Calls and reminders may store loan_application_id after an ownership check.
 *    Omitting the choice stays a general customer record (legacy clients and automatic logs).
 *
 * Activate (call_queue_settings.updated_at is NOT NULL, same as the other flags):
 *   INSERT INTO call_queue_settings(key, value, updated_at)
 *   VALUES ('flag.multi_case_v1', '1', datetime('now'))
 *   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
 * Off:
 *   UPDATE call_queue_settings SET value = '0', updated_at = datetime('now')
 *   WHERE key = 'flag.multi_case_v1' OR key LIKE 'flag.multi_case_v1.user.%';
 * Do not rename loan_plans rows. Multi-case screens label a plan from bank_name.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";

export const MC_FLAG = "flag.multi_case_v1";

/** A plan fee of 0 does not need a filing-fee charge. Anything else, including a missing or invalid fee, still does. */
export function planRequiresFilingFee(fee: unknown): boolean {
  const text = String(fee ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) return true;
  return BigInt(text) > 0n;
}
export const OPEN_SAME_PLAN = "open_same_plan_case";
export const OPEN_SAME_PLAN_CASE_MESSAGE =
  "برای این مشتری یک پروندهٔ باز با همین طرح وجود دارد. تا وقتی آن پرونده لغو یا تکمیل نشود، پروندهٔ تازه با همین طرح ساخته نمی‌شود. طرح دیگر آزاد است و هزینهٔ هر پرونده جداگانه حساب می‌شود.";
export const OPEN_SAME_PLAN_REQUEST_MESSAGE =
  "برای این طرح یک درخواست ناتمام (هزینه یا پیش‌نویس) باز است. همان درخواست را ادامه دهید. درخواست تازه با همین طرح، تا بسته شدن آن، ساخته نمی‌شود و هزینهٔ پروندهٔ دیگر دوباره استفاده نمی‌شود.";

const CASE_CHOICE_MESSAGES: Record<string, string> = {
  case_not_found: "این پرونده برای این مشتری پیدا نشد یا در دسترس شما نیست.",
  case_customer_mismatch: "پروندهٔ انتخاب‌شده مال این مشتری نیست.",
  invalid_case_choice: "پرونده را انتخاب کنید یا «تماس عمومی مشتری» را بزنید.",
};

export type McActor = {
  id: number;
  role?: string | null;
  salespersonId?: number | null;
  customerScope?: string | null;
};

export type OpenPlanClash = Error & {
  applicationId?: number | null;
  chargeId?: number | null;
  planId?: number;
  planName?: string | null;
  held?: "case" | "request";
};

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; }
  catch { return null; }
};

export function mcGlobalOn(): boolean { return setting(MC_FLAG) === "1"; }

/** Global flag.multi_case_v1=1, or flag.multi_case_v1.user.<id>=1. Anything else is OFF. */
export function mcFlagOn(userId: number | null | undefined): boolean {
  if (mcGlobalOn()) return true;
  if (!userId) return false;
  return setting(`${MC_FLAG}.user.${Number(userId)}`) === "1";
}

const tableExists = (name: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [name]);
const columnExists = (table: string, column: string) => {
  if (!/^[a-z_]+$/.test(table)) return false;
  try { return queryRows<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column); }
  catch { return false; }
};

let ready = false;
export function ensureMultiCaseSchema() {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS loan_plan_open_slots (
    customer_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    charge_id INTEGER,
    application_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (customer_id, plan_id)
  );`);
  if (tableExists("call_logs") && !columnExists("call_logs", "loan_application_id")) {
    crmDb.exec("ALTER TABLE call_logs ADD COLUMN loan_application_id INTEGER");
  }
  if (tableExists("reminders") && !columnExists("reminders", "loan_application_id")) {
    crmDb.exec("ALTER TABLE reminders ADD COLUMN loan_application_id INTEGER");
  }
  if (columnExists("call_logs", "loan_application_id")) {
    crmDb.exec("CREATE INDEX IF NOT EXISTS idx_call_logs_loan_app ON call_logs(loan_application_id)");
  }
  if (columnExists("reminders", "loan_application_id")) {
    crmDb.exec("CREATE INDEX IF NOT EXISTS idx_reminders_loan_app ON reminders(loan_application_id)");
  }
  if (tableExists("loan_applications")
    && ["status", "stage", "deleted_at", "customer_id", "plan_id"].every((column) => columnExists("loan_applications", column))) {
    crmDb.exec(`DROP TRIGGER IF EXISTS trg_mc_release_open_slot;
      CREATE TRIGGER trg_mc_release_open_slot
      AFTER UPDATE OF status, stage, deleted_at ON loan_applications
      FOR EACH ROW
      WHEN NEW.status = 'rejected' OR NEW.stage = 'completed' OR NEW.deleted_at IS NOT NULL
      BEGIN
        DELETE FROM loan_plan_open_slots WHERE application_id = NEW.id;
      END;`);
  }
  ready = true;
}

export function resetMultiCaseSchemaForTests() { ready = false; }

function clash(partial: Omit<OpenPlanClash, keyof Error>): never {
  const err = new Error(OPEN_SAME_PLAN) as OpenPlanClash;
  Object.assign(err, partial);
  throw err;
}

export function openSamePlanBody(error: unknown) {
  if (!(error instanceof Error) || error.message !== OPEN_SAME_PLAN) return null;
  const extra = error as OpenPlanClash;
  const held = extra.held === "request" ? "request" : "case";
  return {
    error: OPEN_SAME_PLAN,
    code: OPEN_SAME_PLAN,
    message: held === "request" ? OPEN_SAME_PLAN_REQUEST_MESSAGE : OPEN_SAME_PLAN_CASE_MESSAGE,
    applicationId: extra.applicationId ?? null,
    chargeId: extra.chargeId ?? null,
    planId: extra.planId ?? null,
    planName: extra.planName ?? null,
    held,
  };
}

type OpenRow = { id: number; plan_name: string | null };

/** OPEN = not deleted, not rejected (لغو), stage is not completed. */
export function findOpenSamePlan(customerId: number, planId: number, exceptApplicationId?: number): OpenRow | undefined {
  return queryRow<OpenRow>(
    `SELECT a.id, lp.name AS plan_name
     FROM loan_applications a
     LEFT JOIN loan_plans lp ON lp.id = a.plan_id
     WHERE a.customer_id=? AND a.plan_id=? AND a.deleted_at IS NULL
       AND a.status<>'rejected' AND COALESCE(a.stage,'')<>'completed'
       AND a.id<>?
     ORDER BY a.id DESC LIMIT 1`,
    [customerId, planId, exceptApplicationId ?? -1],
  );
}

/**
 * Inside the filing-fee immediate transaction, after the idempotency replay and after
 * this draft's own unattached charge has been returned. Throws before any wallet debit.
 */
export function reserveOpenPlan(customerId: number, planId: number): { mode: "reserved" } {
  ensureMultiCaseSchema();
  const open = findOpenSamePlan(customerId, planId);
  if (open) clash({ held: "case", applicationId: Number(open.id), planId, planName: open.plan_name });
  const slot = queryRow<{ charge_id: number | null; application_id: number | null }>(
    "SELECT charge_id, application_id FROM loan_plan_open_slots WHERE customer_id=? AND plan_id=?",
    [customerId, planId],
  );
  if (slot) {
    clash({
      held: slot.application_id != null ? "case" : "request",
      applicationId: slot.application_id == null ? null : Number(slot.application_id),
      chargeId: slot.charge_id == null ? null : Number(slot.charge_id),
      planId,
    });
  }
  const unattached = queryRow<{ id: number; plan_name: string | null }>(
    `SELECT f.id, lp.name AS plan_name FROM loan_filing_fee_charges f
     LEFT JOIN loan_plans lp ON lp.id=f.plan_id
     WHERE f.customer_id=? AND f.plan_id=? AND f.application_id IS NULL
     ORDER BY f.id DESC LIMIT 1`,
    [customerId, planId],
  );
  if (unattached) clash({ held: "request", chargeId: Number(unattached.id), planId, planName: unattached.plan_name });
  try {
    execute(
      "INSERT INTO loan_plan_open_slots(customer_id, plan_id, charge_id, application_id, created_at) VALUES(?,?,NULL,NULL,?)",
      [customerId, planId, new Date().toISOString()],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/constraint|UNIQUE/i.test(msg)) clash({ held: "request", planId });
    throw error;
  }
  return { mode: "reserved" };
}

export function bindSlotCharge(customerId: number, planId: number, chargeId: number) {
  const changed = executeChanges(
    `UPDATE loan_plan_open_slots SET charge_id=?
     WHERE customer_id=? AND plan_id=? AND charge_id IS NULL AND application_id IS NULL`,
    [chargeId, customerId, planId],
  );
  if (changed !== 1) clash({ held: "request", chargeId, planId });
}

/** After the new application row exists, same immediate transaction. */
export function claimSlotForApplication(customerId: number, planId: number, chargeId: number | null, applicationId: number) {
  ensureMultiCaseSchema();
  const other = findOpenSamePlan(customerId, planId, applicationId);
  if (other) clash({ held: "case", applicationId: Number(other.id), planId, planName: other.plan_name });
  const slot = queryRow<{ charge_id: number | null; application_id: number | null }>(
    "SELECT charge_id, application_id FROM loan_plan_open_slots WHERE customer_id=? AND plan_id=?",
    [customerId, planId],
  );
  if (!slot) {
    try {
      execute(
        "INSERT INTO loan_plan_open_slots(customer_id, plan_id, charge_id, application_id, created_at) VALUES(?,?,?,?,?)",
        [customerId, planId, chargeId, applicationId, new Date().toISOString()],
      );
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/constraint|UNIQUE/i.test(msg)) clash({ held: "case", planId, applicationId });
      throw error;
    }
  }
  if (slot.application_id != null && Number(slot.application_id) !== applicationId) {
    clash({ held: "case", applicationId: Number(slot.application_id), planId });
  }
  if (slot.charge_id != null && Number(slot.charge_id) !== chargeId) {
    clash({ held: "request", chargeId: Number(slot.charge_id), planId });
  }
  const changed = executeChanges(
    `UPDATE loan_plan_open_slots SET application_id=?, charge_id=?
     WHERE customer_id=? AND plan_id=?
       AND (application_id IS NULL OR application_id=?)
       AND (charge_id IS NULL OR charge_id=?)`,
    [applicationId, chargeId, customerId, planId, applicationId, chargeId],
  );
  if (changed !== 1) clash({ held: "case", planId, applicationId });
}

function choiceError(status: number, code: string): never {
  const err = new Error(code) as Error & { status: number };
  err.status = status;
  throw err;
}

export function caseChoiceErrorBody(error: unknown): { status: number; body: { error: string; code: string; message: string } } | null {
  if (!(error instanceof Error)) return null;
  const status = (error as Error & { status?: number }).status;
  const message = CASE_CHOICE_MESSAGES[error.message];
  if (!message || status == null) return null;
  return { status, body: { error: error.message, code: error.message, message } };
}

/**
 * Missing caseScope / loanApplicationId → null (general / legacy / automatic).
 * A sent case id must belong to this customer and to a customer the actor may see.
 */
export function resolveCaseLink(actor: McActor, customerId: number, body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const hasScope = Object.prototype.hasOwnProperty.call(record, "caseScope");
  const hasId = Object.prototype.hasOwnProperty.call(record, "loanApplicationId");
  if (!hasScope && !hasId) return null;
  if (record.caseScope === "general") return null;
  if (record.loanApplicationId == null || record.loanApplicationId === "") {
    if (record.caseScope === "case") choiceError(400, "invalid_case_choice");
    return null;
  }
  const applicationId = Number(record.loanApplicationId);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) choiceError(400, "invalid_case_choice");
  const row = queryRow<{ id: number; customer_id: number; salesperson_id: number | null; deleted_at: string | null }>(
    `SELECT a.id, a.customer_id, a.deleted_at, c.salesperson_id
     FROM loan_applications a JOIN customers c ON c.id=a.customer_id WHERE a.id=?`,
    [applicationId],
  );
  if (!row || row.deleted_at) choiceError(404, "case_not_found");
  if (Number(row.customer_id) !== customerId) choiceError(409, "case_customer_mismatch");
  if (actor.customerScope === "assigned" && Number(row.salesperson_id) !== Number(actor.salespersonId)) {
    choiceError(404, "case_not_found");
  }
  return applicationId;
}

export function customerVisible(actor: McActor, customerId: number): boolean {
  const row = queryRow<{ salesperson_id: number | null }>(
    "SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
    [customerId],
  );
  if (!row) return false;
  if (actor.customerScope === "assigned" && Number(row.salesperson_id) !== Number(actor.salespersonId)) return false;
  return true;
}

const OPEN_SQL = "a.deleted_at IS NULL AND a.status<>'rejected' AND COALESCE(a.stage,'')<>'completed'";

export function listCustomerCases(customerId: number) {
  const bank = columnExists("loan_plans", "bank_name") ? "lp.bank_name" : "NULL";
  const amount = columnExists("loan_applications", "requested_amount") ? "a.requested_amount" : "NULL";
  const hasMonths = columnExists("loan_applications", "duration_months");
  const hasRequestedMonths = columnExists("loan_applications", "requested_duration_months");
  const months = hasMonths && hasRequestedMonths ? "COALESCE(a.duration_months, a.requested_duration_months)"
    : hasMonths ? "a.duration_months" : hasRequestedMonths ? "a.requested_duration_months" : "NULL";
  return queryRows<{ id: number; plan_id: number | null; plan_name: string | null; bank_name: string | null; stage: string | null; status: string; open: number; requested_amount: string | null; months: number | null }>(
    `SELECT a.id, a.plan_id, lp.name AS plan_name, ${bank} AS bank_name, a.stage, a.status,
       ${amount} AS requested_amount, ${months} AS months,
       CASE WHEN ${OPEN_SQL} THEN 1 ELSE 0 END AS open
     FROM loan_applications a LEFT JOIN loan_plans lp ON lp.id=a.plan_id
     WHERE a.customer_id=? AND a.deleted_at IS NULL ORDER BY a.id DESC`,
    [customerId],
  ).map((row) => ({
    id: Number(row.id),
    planId: row.plan_id == null ? null : Number(row.plan_id),
    planName: row.plan_name ?? null,
    bankName: row.bank_name ?? null,
    stage: row.stage ?? null,
    status: row.status,
    requestedAmount: row.requested_amount ?? null,
    durationMonths: row.months == null ? null : Number(row.months),
    open: Number(row.open) === 1,
  }));
}

export function getCaseRow(applicationId: number) {
  const bank = columnExists("loan_plans", "bank_name") ? "lp.bank_name" : "NULL";
  return queryRow<{ id: number; customer_id: number; plan_id: number | null; plan_name: string | null; bank_name: string | null; stage: string | null; status: string; deleted_at: string | null }>(
    `SELECT a.id, a.customer_id, a.plan_id, lp.name AS plan_name, ${bank} AS bank_name, a.stage, a.status, a.deleted_at
     FROM loan_applications a LEFT JOIN loan_plans lp ON lp.id=a.plan_id WHERE a.id=?`,
    [applicationId],
  );
}

export function listCaseCalls(customerId: number, applicationId?: number) {
  if (!columnExists("call_logs", "loan_application_id")) return [];
  return queryRows<{ id: number; loan_application_id: number | null; subject: string | null; created_at: string }>(
    `SELECT id, loan_application_id, subject, created_at FROM call_logs
     WHERE customer_id=? ${applicationId ? "AND loan_application_id=?" : ""} ORDER BY id DESC LIMIT 200`,
    applicationId ? [customerId, applicationId] : [customerId],
  ).map((row) => ({
    id: Number(row.id),
    loanApplicationId: row.loan_application_id == null ? null : Number(row.loan_application_id),
    subject: row.subject ?? null,
    createdAt: row.created_at,
  }));
}

export function listCaseReminders(customerId: number, applicationId?: number) {
  if (!columnExists("reminders", "loan_application_id")) return [];
  return queryRows<{ id: number; loan_application_id: number | null; subject: string | null; remind_at: string }>(
    `SELECT id, loan_application_id, subject, remind_at FROM reminders
     WHERE customer_id=? ${applicationId ? "AND loan_application_id=?" : ""} ORDER BY id DESC LIMIT 200`,
    applicationId ? [customerId, applicationId] : [customerId],
  ).map((row) => ({
    id: Number(row.id),
    loanApplicationId: row.loan_application_id == null ? null : Number(row.loan_application_id),
    subject: row.subject ?? null,
    remindAt: row.remind_at,
  }));
}
