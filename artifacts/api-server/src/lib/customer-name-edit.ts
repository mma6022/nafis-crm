/**
 * ویرایش نام مشتری (flag.customer_name_edit, absent = OFF).
 * Armita v1.0 / Mohammad t1021u + t1024s4327: only the case owner (salesperson)
 * or a system admin may change the CRM display name of an unverified customer.
 * Issued contracts, templates, and Emzami documents are never touched.
 * The customer is not notified. There is no edit cap. One edit updates the
 * customer row, so every case that joins on customers.name shows the new name.
 */
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import type { AuthUser } from "./auth";
import { isSalesManagerUser } from "./sales-manager";

export const CNE_FLAG = "flag.customer_name_edit";
export const CNE_OFF = "customer_name_edit_off";
export const CNE_ACTION = "customer-name-changed";

export const CNE_MSG = {
  off: "این قابلیت خاموش است.",
  forbidden: "اجازه ویرایش نام این مشتری را ندارید.",
  verified: "نام از احراز هویت آمده و قابل ویرایش نیست.",
  notFound: "مشتری پیدا نشد.",
  invalidFa: "فقط حروف فارسی وارد کنید.",
  required: "این فیلد لازم است.",
  length: "فقط حروف فارسی وارد کنید.",
  server: "نام ذخیره نشد. دوباره امتحان کنید.",
} as const;

/** Persian letters + space + ZWNJ. Arabic Yeh/Kaf accepted because keyboards often emit them. */
export const CNE_FA_RE = /^[\u0621-\u0628\u062A-\u063A\u0641\u0642\u0644-\u0648\u064A\u067E\u0686\u0698\u06A9\u06AF\u06CC\u200C ]+$/;

export function cneFlagOn(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [CNE_FLAG])?.value === "1";
  } catch {
    return false;
  }
}

export function cneIsSystemAdmin(user: AuthUser): boolean {
  if (isSalesManagerUser(user)) return false;
  const base = user.baseRole || user.role;
  return base === "admin";
}

export function cneIsCaseOwner(user: AuthUser, salespersonId: number | null | undefined): boolean {
  return user.salespersonId != null && salespersonId != null && Number(user.salespersonId) === Number(salespersonId);
}

export function cneCanEditUser(user: AuthUser, salespersonId: number | null | undefined): boolean {
  return cneIsSystemAdmin(user) || cneIsCaseOwner(user, salespersonId);
}

export function cneNormalizePart(raw: unknown): { ok: true; value: string } | { ok: false; error: "required" | "invalidFa"; message: string } {
  if (typeof raw !== "string") return { ok: false, error: "required", message: CNE_MSG.required };
  const value = raw.replace(/\u200C{2,}/g, "\u200C").replace(/[^\S\u200C]+/g, " ").trim();
  if (!value) return { ok: false, error: "required", message: CNE_MSG.required };
  if (value.length < 2 || value.length > 30 || !CNE_FA_RE.test(value)) {
    return { ok: false, error: "invalidFa", message: CNE_MSG.invalidFa };
  }
  return { ok: true, value };
}

export function cneFullName(first: string, last: string): string {
  return `${first} ${last}`.replace(/[^\S\u200C]+/g, " ").trim();
}

export function cneSplitName(name: string | null | undefined, first: string | null | undefined, last: string | null | undefined): { firstName: string; lastName: string } {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (f || l) return { firstName: f, lastName: l };
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function ensureCneSchema(): void {
  execute(`CREATE TABLE IF NOT EXISTS customer_name_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    old_name TEXT NOT NULL,
    new_name TEXT NOT NULL,
    old_first_name TEXT,
    old_last_name TEXT,
    new_first_name TEXT NOT NULL,
    new_last_name TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL,
    actor_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  execute("CREATE INDEX IF NOT EXISTS idx_customer_name_edits_customer ON customer_name_edits(customer_id, id DESC)");
}

export type CustomerRow = {
  id: number;
  name: string;
  first_name: string | null;
  last_name: string | null;
  salesperson_id: number | null;
  verification_status: string | null;
  merged_into_customer_id: number | null;
};

export function cneLoadCustomer(id: number): CustomerRow | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = queryRow<CustomerRow>(
    `SELECT id, name, first_name, last_name, salesperson_id, verification_status, merged_into_customer_id
     FROM customers WHERE id=?`,
    [id],
  );
  if (!row || row.merged_into_customer_id != null) return null;
  return row;
}

export function cneIdentityVerified(row: { verification_status: string | null }): boolean {
  return row.verification_status === "verified";
}

export type CneView = {
  flagOn: true;
  canEdit: boolean;
  identityVerified: boolean;
  identity_verified: boolean;
  showVerifiedBadge: boolean;
  firstName: string;
  lastName: string;
  name: string;
};

export function cneView(user: AuthUser, row: CustomerRow): CneView {
  const verified = cneIdentityVerified(row);
  const privileged = cneCanEditUser(user, row.salesperson_id);
  const split = cneSplitName(row.name, row.first_name, row.last_name);
  return {
    flagOn: true,
    canEdit: privileged && !verified,
    identityVerified: verified,
    identity_verified: verified,
    showVerifiedBadge: privileged && verified,
    firstName: split.firstName,
    lastName: split.lastName,
    name: row.name,
  };
}

export type CnePatchOk = {
  ok: true;
  unchanged: boolean;
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  identityVerified: false;
  history: { applicationIds: number[]; editId: number | null };
};

export type CnePatchErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
  field?: "firstName" | "lastName";
};


export type CnePrepared = {
  ok: true;
  unchanged: boolean;
  row: CustomerRow;
  first: string;
  last: string;
  newName: string;
};

/** Shared checks for the dedicated /name route and the old PATCH /customers/:id form. Flag is optional so the old path stays guarded even when the feature flag is off. */
export function cnePrepareNameChange(
  user: AuthUser,
  customerId: number,
  body: { firstName?: unknown; lastName?: unknown },
  opts: { requireFlag?: boolean } = {},
): CnePrepared | CnePatchErr {
  if (opts.requireFlag && !cneFlagOn()) return { ok: false, status: 404, error: CNE_OFF, message: CNE_MSG.off };
  const row = cneLoadCustomer(customerId);
  if (!row) return { ok: false, status: 404, error: "not_found", message: CNE_MSG.notFound };
  if (!cneCanEditUser(user, row.salesperson_id)) {
    return { ok: false, status: 403, error: "forbidden", message: CNE_MSG.forbidden };
  }
  if (cneIdentityVerified(row)) {
    const first = cneNormalizePart(body.firstName);
    const last = cneNormalizePart(body.lastName);
    const prev = cneSplitName(row.name, row.first_name, row.last_name);
    const same = first.ok && last.ok
      && cneFullName(first.value, last.value) === (row.name || cneFullName(prev.firstName, prev.lastName))
      && first.value === prev.firstName && last.value === prev.lastName;
    if (same) {
      return { ok: true, unchanged: true, row, first: first.value, last: last.value, newName: row.name || cneFullName(first.value, last.value) };
    }
    return { ok: false, status: 409, error: "identity_verified", message: CNE_MSG.verified };
  }
  const first = cneNormalizePart(body.firstName);
  if (!first.ok) return { ok: false, status: 400, error: first.error, message: first.message, field: "firstName" };
  const last = cneNormalizePart(body.lastName);
  if (!last.ok) return { ok: false, status: 400, error: last.error, message: last.message, field: "lastName" };
  const newName = cneFullName(first.value, last.value);
  const oldName = row.name ?? "";
  const prev = cneSplitName(oldName, row.first_name, row.last_name);
  if (newName === (oldName || cneFullName(prev.firstName, prev.lastName))
      && first.value === prev.firstName && last.value === prev.lastName) {
    return { ok: true, unchanged: true, row, first: first.value, last: last.value, newName: oldName || newName };
  }
  return { ok: true, unchanged: false, row, first: first.value, last: last.value, newName };
}

export function cnePartsFromFullName(full: unknown): { firstName: string; lastName: string } | { ok: false; error: "required"; message: string } {
  if (typeof full !== "string") return { ok: false, error: "required", message: CNE_MSG.required };
  const value = full.replace(/\u200C{2,}/g, "\u200C").replace(/[^\S\u200C]+/g, " ").trim();
  if (!value) return { ok: false, error: "required", message: CNE_MSG.required };
  return cneSplitName(value, null, null);
}

/** Must run inside runTransaction. Does not notify the customer or touch contracts / templates / official identity fields. */
export function cneApplyNameChangeInTx(
  user: AuthUser,
  row: CustomerRow,
  first: string,
  last: string,
  now = new Date(),
): { editId: number; applicationIds: number[]; newName: string } {
  const newName = cneFullName(first, last);
  const oldName = row.name ?? "";
  const oldFirst = row.first_name ?? null;
  const oldLast = row.last_name ?? null;
  const actorName = (user.fullName && user.fullName.trim()) || user.username || "کارشناس";
  const at = now.toISOString();
  const reason = JSON.stringify({ oldName, newName, firstName: first, lastName: last });
  ensureCneSchema();
  const changed = executeChanges(
    `UPDATE customers SET name=?, first_name=?, last_name=? WHERE id=? AND merged_into_customer_id IS NULL
       AND COALESCE(verification_status,'unverified') <> 'verified'`,
    [newName, first, last, row.id],
  );
  if (!changed) throw new Error("CNE_STALE");
  const editId = execute(
    `INSERT INTO customer_name_edits(
       customer_id,old_name,new_name,old_first_name,old_last_name,new_first_name,new_last_name,actor_user_id,actor_name,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [row.id, oldName, newName, oldFirst, oldLast, first, last, user.id, actorName, at],
  );
  const apps = queryRows<{ id: number; stage: string | null }>(
    `SELECT id, stage FROM loan_applications WHERE customer_id=? AND ${cneAppAliveSql()} ORDER BY id`,
    [row.id],
  );
  const applicationIds: number[] = [];
  for (const app of apps) {
    const stage = app.stage ?? "";
    execute(
      "INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
      [app.id, stage, stage, CNE_ACTION, reason, user.id, at],
    );
    applicationIds.push(Number(app.id));
  }
  return { editId: Number(editId), applicationIds, newName };
}

export function cnePatch(user: AuthUser, customerId: number, body: { firstName?: unknown; lastName?: unknown }, now = new Date()): CnePatchOk | CnePatchErr {
  const prep = cnePrepareNameChange(user, customerId, body, { requireFlag: true });
  if (!prep.ok) return prep;
  if (prep.unchanged) {
    return {
      ok: true, unchanged: true, id: prep.row.id, name: prep.newName, firstName: prep.first, lastName: prep.last,
      identityVerified: false, history: { applicationIds: [], editId: null },
    };
  }
  const result = runTransaction(() => cneApplyNameChangeInTx(user, prep.row, prep.first, prep.last, now));
  return {
    ok: true,
    unchanged: false,
    id: prep.row.id,
    name: result.newName,
    firstName: prep.first,
    lastName: prep.last,
    identityVerified: false,
    history: { applicationIds: result.applicationIds, editId: result.editId },
  };
}

function cneAppAliveSql(): string {
  try {
    const cols = queryRows<{ name: string }>("PRAGMA table_info(loan_applications)");
    const names = new Set(cols.map((c) => c.name));
    if (names.has("deleted_at")) return "deleted_at IS NULL";
  } catch { /* schema probe */ }
  return "1=1";
}

export function cneHistorySentence(oldName: string, newName: string): string {
  return `نام از «${oldName}» به «${newName}» تغییر کرد`;
}
