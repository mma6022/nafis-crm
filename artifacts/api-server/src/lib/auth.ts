import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { execute, executeChanges, queryRow, crmDb } from "./crm-db";
import { permissionsForRole } from "./access-control";

const SESSION_COOKIE = "crm_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const sessionSecret = (() => {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required");
  return value;
})();

crmDb.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
`);

const userColumns = crmDb
  .prepare("PRAGMA table_info(users)")
  .all() as unknown as Array<{ name: string }>;
if (!userColumns.some((column) => column.name === "telegram_id")) {
  crmDb.exec("ALTER TABLE users ADD COLUMN telegram_id TEXT");
}

export type AuthUser = {
  id: number;
  username: string;
  fullName: string | null;
  mobile: string | null;
  telegramId: string | null;
  priorityColors: Record<string, string>;
  role: string;
  roleName: string;
  permissions: string[];
  customerScope: "all" | "assigned";
  salespersonId: number | null;
  salespersonName: string | null;
  active: boolean;
  createdAt: string;
};

type AuthUserRow = {
  id: number;
  username: string;
  full_name: string | null;
  mobile: string | null;
  telegram_id: string | null;
  priority_colors: string | null;
  role: string;
  role_name: string | null;
  customer_scope: string | null;
  salesperson_id: number | null;
  salesperson_name: string | null;
  active: number;
  created_at: string;
};

function userFromRow(row: AuthUserRow): AuthUser {
  let priorityColors: Record<string, string> = {};
  try {
    priorityColors = row.priority_colors ? JSON.parse(row.priority_colors) : {};
  } catch {
    priorityColors = {};
  }
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name ?? null,
    mobile: row.mobile ?? null,
    telegramId: row.telegram_id ?? null,
    priorityColors,
    role: row.role,
    roleName: row.role_name ?? row.role,
    permissions: permissionsForRole(row.role),
    customerScope: row.role === "admin" ? "all" : row.customer_scope === "assigned" ? "assigned" : "all",
    salespersonId: row.salesperson_id == null ? null : Number(row.salesperson_id),
    salespersonName: row.salesperson_name ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

export function getAuthUserById(id: number): AuthUser | undefined {
  const row = queryRow<AuthUserRow>(
    `
      SELECT u.id, u.username, u.full_name, u.mobile, u.telegram_id, u.priority_colors, u.role, r.name AS role_name, r.customer_scope, u.salesperson_id,
        s.name AS salesperson_name, u.active, u.created_at
      FROM users u
      LEFT JOIN app_roles r ON r.slug = u.role
      LEFT JOIN salespersons s ON s.id = u.salesperson_id
      WHERE u.id = ?
    `,
    [id],
  );
  return row ? userFromRow(row) : undefined;
}

function tokenHash(token: string): string {
  return createHmac("sha256", sessionSecret).update(token).digest("hex");
}

function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === "string" ? value : undefined;
}

export function getAuthenticatedUser(req: Request): AuthUser | undefined {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  const row = queryRow<AuthUserRow>(
    `
      SELECT u.id, u.username, u.full_name, u.mobile, u.telegram_id, u.priority_colors, u.role, r.name AS role_name, r.customer_scope, u.salesperson_id,
        sp.name AS salesperson_name, u.active, u.created_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN app_roles r ON r.slug = u.role
      LEFT JOIN salespersons sp ON sp.id = u.salesperson_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `,
    [tokenHash(token), new Date().toISOString()],
  );
  return row ? userFromRow(row) : undefined;
}

export const requireAuth: RequestHandler = (req, res, next): void => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.locals.authUser = user;
  next();
};

export const requireAdmin: RequestHandler = (req, res, next): void => {
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.locals.authUser = user;
  next();
};

export function createSession(userId: number, res: Response): void {
  executeChanges("DELETE FROM auth_sessions WHERE expires_at <= ?", [
    new Date().toISOString(),
  ]);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  execute(
    `
      INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    [tokenHash(token), userId, expires.toISOString(), now.toISOString()],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function destroySession(req: Request, res: Response): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    executeChanges("DELETE FROM auth_sessions WHERE token_hash = ?", [
      tokenHash(token),
    ]);
  }
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
}

export function revokeUserSessions(userId: number): void {
  executeChanges("DELETE FROM auth_sessions WHERE user_id = ?", [userId]);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const [method, salt, expectedHex] = storedHash.split("$");
    const [algorithm, n, r, p] = method.split(":");
    if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function performDummyPasswordCheck(password: string): void {
  scryptSync(password, "invalid-user-timing-salt", 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}