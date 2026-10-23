import type { RequestHandler } from "express";
import { crmDb, execute, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";

// Historical databases constrained users.role to three original roles.
// Preserve every row/index/trigger while allowing the existing app_roles policy
// to govern custom roles (including the new accounting role).
const userSchema = crmDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as {sql:string} | undefined;
if (userSchema && /CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i.test(userSchema.sql)) {
  const auxiliary = crmDb.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{sql:string}>;
  const columns = (crmDb.prepare("PRAGMA table_info(users)").all() as Array<{name:string}>).map(c=>`"${c.name.replace(/"/g,'""')}"`).join(",");
  crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    crmDb.exec(userSchema.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?users["']?/i,"CREATE TABLE users_role_migration").replace(/CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i,""));
    crmDb.exec(`INSERT INTO users_role_migration(${columns}) SELECT ${columns} FROM users; DROP TABLE users; ALTER TABLE users_role_migration RENAME TO users;`);
    for (const item of auxiliary) crmDb.exec(item.sql);
    crmDb.exec("COMMIT");
  } catch (error) { crmDb.exec("ROLLBACK"); throw error; }
  finally { crmDb.exec("PRAGMA foreign_keys=ON"); }
}

export const PERMISSIONS = [
  "internal_chat.use",
  "reports.view",
  "dashboard.view",
  "customers.view", "customers.create", "customers.update", "customers.delete",
  "customers.credit_check",
  "calls.view", "calls.create",
  "consultations.view", "consultations.create", "consultations.update",
  "consultation_ai.use",
  "reminders.view", "reminders.manage",
  "loan_plans.view", "loan_plans.manage",
  "allocation_programs.view", "allocation_programs.manage",
  "users.view", "users.manage",
  "notifications.view", "notifications.manage",
  "database.manage",
  "contracts.view", "contracts.manage", "contracts.generate", "contracts.send",
  "loan_applications.view", "loan_applications.create", "loan_applications.update",
  "loan_applications.review", "loan_applications.approve", "loan_applications.delete",
  "wallets.view", "wallets.transfer",
  "goods_purchases.view", "goods_purchases.manage", "goods_finance.view", "goods_finance.manage",
  "payment_orders.view", "payment_orders.create", "payment_orders.sales_approve", "payment_orders.admin_approve", "payment_orders.pay",
  "bank_accounts.view", "bank_accounts.manage",
  "accounting.view", "accounting.manage", "accounting.opening",
  "callbacks.view", "callbacks.manage", "callbacks.assign",
] as const;

export type Permission = typeof PERMISSIONS[number];

crmDb.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS app_roles (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    customer_scope TEXT NOT NULL DEFAULT 'all' CHECK(customer_scope IN ('all', 'assigned')),
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_slug TEXT NOT NULL,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_slug, permission),
    FOREIGN KEY (role_slug) REFERENCES app_roles(slug) ON DELETE CASCADE
  );
`);

const now = new Date().toISOString();
const defaults = [
  ["admin", "مدیر سیستم", "دسترسی کامل و غیرقابل محدودسازی", "all", 1],
  ["registrar", "ثبت‌نام‌کننده", "ثبت و پیگیری عمومی مشتریان", "all", 1],
  ["salesperson", "کارشناس فروش", "دسترسی به مشتریان تخصیص‌یافته", "assigned", 1],
  ["funder", "تأمین‌کننده مالی", "بررسی و تأیید مالی پرونده‌های تسهیلات", "all", 1],
  ["accounting", "حسابداری", "ثبت واریز دستور پرداخت و اسناد مالی", "all", 1],
] as const;
for (const role of defaults) {
  execute("INSERT OR IGNORE INTO app_roles (slug, name, description, customer_scope, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)", [...role, now]);
}
const standard = PERMISSIONS.filter((permission) => !/^(goods_|payment_orders\.|bank_accounts\.|accounting\.|callbacks\.)/.test(permission) && !permission.startsWith("users.") && !permission.startsWith("notifications.") && permission !== "database.manage" && permission !== "customers.delete" && permission !== "loan_applications.approve" && permission !== "loan_applications.delete" && permission !== "wallets.transfer");
for (const permission of PERMISSIONS) execute("INSERT OR IGNORE INTO role_permissions (role_slug, permission) VALUES ('admin', ?)", [permission]);
for (const role of ["funder","accounting"]) execute("INSERT OR IGNORE INTO role_permissions(role_slug,permission) VALUES(?,'internal_chat.use')",[role]);
for (const role of ["registrar", "salesperson"]) {
  for (const permission of standard.filter(p => p !== "reports.view" || role === "salesperson")) execute("INSERT OR IGNORE INTO role_permissions (role_slug, permission) VALUES (?, ?)", [role, permission]);
}
execute("DELETE FROM role_permissions WHERE role_slug='salesperson' AND permission='loan_applications.review'");
for (const permission of ["loan_applications.view", "loan_applications.review", "contracts.view"] as const) {
  execute("INSERT OR IGNORE INTO role_permissions (role_slug, permission) VALUES ('funder', ?)", [permission]);
}
execute("DELETE FROM role_permissions WHERE role_slug='funder' AND permission='loan_applications.approve'");
for (const [role, permissions] of Object.entries({
  registrar: ["goods_purchases.view", "goods_purchases.manage", "goods_finance.view", "payment_orders.view", "payment_orders.create", "bank_accounts.view"],
  salesperson: ["goods_purchases.view", "goods_finance.view", "payment_orders.view", "payment_orders.sales_approve", "bank_accounts.view"],
  accounting: ["dashboard.view", "customers.view", "goods_purchases.view", "goods_finance.view", "payment_orders.view", "payment_orders.pay", "bank_accounts.view", "bank_accounts.manage", "accounting.view", "accounting.manage"],
})) for (const permission of permissions) execute("INSERT OR IGNORE INTO role_permissions(role_slug,permission) VALUES(?,?)", [role,permission]);

// «درخواست‌های تماس»: seeded once (schema_migrations marker), so an admin who later removes these from a
// role is not overridden on restart. admin has everything implicitly. registrar and salesperson follow up
// website requests («به من بسپار» included); salesperson's 'assigned' scope limits them to requests that are
// theirs or still unassigned. callbacks.assign (giving a request to someone else) is admin-only by default;
// grant it to a manager role from Users if one is created. funder and accounting get nothing.
execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
if (!queryRows("SELECT 1 AS hit FROM schema_migrations WHERE version='callbacks_permissions_v1'").length) {
  for (const role of ["registrar", "salesperson"]) {
    for (const permission of ["callbacks.view", "callbacks.manage"]) {
      execute("INSERT OR IGNORE INTO role_permissions(role_slug,permission) SELECT slug, ? FROM app_roles WHERE slug=?", [permission, role]);
    }
  }
  execute("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES ('callbacks_permissions_v1', ?)", [now]);
}

export function permissionsForRole(role: string): string[] {
  if (role === "admin") return [...PERMISSIONS];
  return queryRows<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_slug = ? ORDER BY permission", [role]).map((row) => row.permission);
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next): void => {
    const user = res.locals.authUser as AuthUser | undefined;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (user.role !== "admin" && !user.permissions.includes(permission)) {
      res.status(403).json({ error: "Forbidden", permission });
      return;
    }
    next();
  };
}