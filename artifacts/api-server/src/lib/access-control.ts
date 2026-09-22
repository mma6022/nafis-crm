import type { RequestHandler } from "express";
import { crmDb, execute, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";

export const PERMISSIONS = [
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
] as const;
for (const role of defaults) {
  execute("INSERT OR IGNORE INTO app_roles (slug, name, description, customer_scope, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)", [...role, now]);
}
const standard = PERMISSIONS.filter((permission) => !permission.startsWith("users.") && !permission.startsWith("notifications.") && permission !== "database.manage" && permission !== "customers.delete" && permission !== "loan_applications.approve" && permission !== "loan_applications.delete");
for (const permission of PERMISSIONS) execute("INSERT OR IGNORE INTO role_permissions (role_slug, permission) VALUES ('admin', ?)", [permission]);
for (const role of ["registrar", "salesperson"]) {
  for (const permission of standard) execute("INSERT OR IGNORE INTO role_permissions (role_slug, permission) VALUES (?, ?)", [role, permission]);
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