import { withNotificationActor } from "./notification-actor-context";
import { createHmac, randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { execute, executeChanges, queryRow } from "./crm-db";
import { normalizeCustomerMobile } from "./customer-integrity";
import { customerPortalIdentityReady } from "./customer-portal-identity";

const COOKIE_NAME = "customer_portal_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CustomerPortalSession = {
  mobile: string;
  customerId: number | null;
};

type SessionRow = {
  mobile: string;
  customer_id: number | null;
  customer_phone: string | null;
  merged_into_customer_id: number | null;
  created_at: string;
};

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Customer portal authentication is not configured");
  return secret;
}

function tokenHash(token: string): string {
  return createHmac("sha256", sessionSecret())
    .update(`customer-portal-session:${token}`)
    .digest("hex");
}

function readToken(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[COOKIE_NAME];
  return typeof token === "string" ? token : undefined;
}

export function customerPortalSession(res: Response): CustomerPortalSession | undefined {
  return res.locals.customerPortalSession as CustomerPortalSession | undefined;
}

export const requireCustomerPortal: RequestHandler = (req, res, next): void => {
  try {
    const token = readToken(req);
    if (!token) {
      res.status(401).json({ error: "Customer authentication required" });
      return;
    }
    const row = queryRow<SessionRow>(
      `SELECT c.*,s.mobile, s.customer_id, c.phone AS customer_phone,
         s.created_at
       FROM customer_portal_sessions s
       LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [tokenHash(token), new Date().toISOString()],
    );
    if (!row) {
      destroyCustomerPortalSession(req, res);
      res.status(401).json({ error: "Customer authentication required" });
      return;
    }
    if (row.customer_id != null) {
      const boundMobile = normalizeCustomerMobile(row.mobile);
      const currentMobile = row.customer_phone == null
        ? ""
        : normalizeCustomerMobile(row.customer_phone);
      if (
        row.merged_into_customer_id != null ||
        !boundMobile ||
        !currentMobile ||
        currentMobile !== boundMobile
      ) {
        destroyCustomerPortalSession(req, res);
        res.status(401).json({ error: "Customer authentication required" });
        return;
      }
    }
    res.locals.customerPortalSession = {
      mobile: row.mobile,
      customerId: row.customer_id == null ? null : Number(row.customer_id),
    } satisfies CustomerPortalSession;
    const ready = row.customer_id != null && customerPortalIdentityReady(row);
    res.locals.customerPortalIdentityReady = ready;
    if (!ready && Date.now() - Date.parse(row.created_at) > 15 * 60_000) {
      destroyCustomerPortalSession(req, res);
      res.status(401).json({ error: "customer_otp_expired", message: "برای احراز هویت، دوباره کد ورود دریافت کنید." });
      return;
    }
    if (!ready && !["/me", "/identity", "/verify"].includes(req.path)) {
      res.status(403).json({ error: "identity_required", message: "ابتدا احراز هویت و تطبیق مالکیت شماره همراه را تکمیل کنید." });
      return;
    }
    withNotificationActor(`customer:${row.customer_id ?? "unbound"}`, next);
  } catch (error) {
    next(error);
  }
};

export function createCustomerPortalSession(
  mobile: string,
  customerId: number | null,
  res: Response,
): CustomerPortalSession {
  executeChanges(
    "DELETE FROM customer_portal_sessions WHERE expires_at <= ?",
    [new Date().toISOString()],
  );
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  execute(
    `INSERT INTO customer_portal_sessions
       (token_hash, mobile, customer_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [tokenHash(token), mobile, customerId, expiresAt.toISOString(), now.toISOString()],
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
  return { mobile, customerId };
}

export function destroyCustomerPortalSession(req: Request, res: Response): void {
  const token = readToken(req);
  if (token) {
    executeChanges("DELETE FROM customer_portal_sessions WHERE token_hash = ?", [
      tokenHash(token),
    ]);
  }
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
}

export function updateCustomerPortalSessionCustomer(
  req: Request,
  customerId: number,
): void {
  const token = readToken(req);
  if (!token) throw new Error("Customer session is no longer valid");
  const changes = executeChanges(
    "UPDATE customer_portal_sessions SET customer_id = ? WHERE token_hash = ? AND expires_at > ?",
    [customerId, tokenHash(token), new Date().toISOString()],
  );
  if (changes !== 1) throw new Error("Customer session is no longer valid");
}