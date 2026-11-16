import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Router, type Request } from "express";
import {
  createCustomerPortalSession,
  destroyCustomerPortalSession,
} from "../lib/customer-portal-auth";
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { normalizeIranianMobile } from "../lib/customer-notifications";
import { sendCustomerPortalOtp } from "../lib/customer-portal-sms";
import { normalizeCustomerMobile } from "../lib/customer-integrity";
import { customerPortalIdentityReady } from "../lib/customer-portal-identity";

const router = Router();
const OTP_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_DAILY_MOBILE_SENDS = 5;
const MAX_DAILY_IP_SENDS = 30;
const MAX_OTP_ATTEMPTS = 5;
const MAX_DAILY_MOBILE_ATTEMPTS = 10;
const MAX_DAILY_IP_ATTEMPTS = 30;
const GENERIC_REQUEST_RESPONSE = {
  ok: true,
  message: "If the mobile number is eligible, a verification code will be sent.",
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Customer portal authentication is not configured");
  return value;
}

function hmac(value: string, purpose: string): string {
  return createHmac("sha256", secret()).update(`${purpose}:${value}`).digest("hex");
}

function requestIp(req: Request): string {
  const peer = req.socket.remoteAddress || "unknown";
  // The production loopback Nginx proxy overwrites X-Real-IP. Never trust
  // client-provided forwarded headers on a directly connected public socket.
  const forwarded = req.get("X-Real-IP");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && forwarded && isIP(forwarded)
    ? forwarded : peer;
}

function mobileFrom(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeIranianMobile(value) : undefined;
}

router.post("/otp/request", async (req, res): Promise<void> => {
  const mobile = mobileFrom(req.body?.mobile);
  if (!mobile) {
    res.status(202).json(GENERIC_REQUEST_RESPONSE);
    return;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const ipHash = hmac(requestIp(req), "customer-portal-ip");
  const throttle = queryRow<{ recent_mobile: number; recent_ip: number; daily_mobile: number; daily_ip: number }>(
    `SELECT
       SUM(CASE WHEN mobile=? AND created_at>? THEN 1 ELSE 0 END) AS recent_mobile,
       SUM(CASE WHEN ip_hash=? AND created_at>? THEN 1 ELSE 0 END) AS recent_ip,
       SUM(CASE WHEN mobile=? AND created_at>=? THEN 1 ELSE 0 END) AS daily_mobile,
       SUM(CASE WHEN ip_hash=? AND created_at>=? THEN 1 ELSE 0 END) AS daily_ip
     FROM customer_portal_otp_challenges`,
    [
      mobile, new Date(now.getTime() - SEND_COOLDOWN_MS).toISOString(),
      ipHash, new Date(now.getTime() - SEND_COOLDOWN_MS).toISOString(),
      mobile, dayStart, ipHash, dayStart,
    ],
  );
  if (
    Number(throttle?.recent_mobile ?? 0) > 0 ||
    Number(throttle?.recent_ip ?? 0) > 0 ||
    Number(throttle?.daily_mobile ?? 0) >= MAX_DAILY_MOBILE_SENDS ||
    Number(throttle?.daily_ip ?? 0) >= MAX_DAILY_IP_SENDS
  ) {
    res.status(202).json(GENERIC_REQUEST_RESPONSE);
    return;
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
  const challengeId = execute(
    `INSERT INTO customer_portal_otp_challenges
       (mobile, ip_hash, otp_hash, expires_at, attempts, delivery_status, created_at)
     VALUES (?, ?, ?, ?, 0, 'pending', ?)`,
    [mobile, ipHash, hmac(`${mobile}:${code}`, "customer-portal-otp"), expiresAt, nowIso],
  );
  try {
    await sendCustomerPortalOtp(mobile, code);
    executeChanges(
      "UPDATE customer_portal_otp_challenges SET delivery_status='sent' WHERE id=? AND delivery_status='pending'",
      [challengeId],
    );
    res.status(202).json(GENERIC_REQUEST_RESPONSE);
  } catch (error) {
    executeChanges(
      "UPDATE customer_portal_otp_challenges SET delivery_status='failed', consumed_at=? WHERE id=?",
      [new Date().toISOString(), challengeId],
    );
    const relayFailure = error instanceof Error ? error.message : "";
    const unavailable = relayFailure === "sms_disabled" || relayFailure === "sms_relay_not_configured";
    res.status(unavailable ? 503 : 502).json({
      error: unavailable ? "SMS delivery is not configured." : "SMS delivery failed; please try again later.",
      code: unavailable ? "sms_not_configured" : "sms_delivery_failed",
      message: unavailable ? "ارسال پیامک سامانه فعلاً فعال نیست؛ با پشتیبانی تماس بگیرید." : "ارسال پیامک ناموفق بود؛ کمی بعد دوباره تلاش کنید.",
    });
  }
});

type OtpRow = { id: number; mobile: string; otp_hash: string };
type ExistingCustomer = { id: number; phone: string; merged_into_customer_id: number | null };

function canonicalCustomersForMobile(mobile: string): { ids: number[]; unresolved: boolean } {
  const normalizedMobile = normalizeCustomerMobile(mobile);
  const matches = queryRows<ExistingCustomer>(
    `SELECT id,phone,merged_into_customer_id FROM customers
     WHERE crm_customer_mobile_key(phone)=crm_customer_mobile_key(?)
     ORDER BY id`,
    [mobile],
  );
  const canonicalIds = new Set<number>();
  let unresolved = false;
  for (const match of matches) {
    if (match.merged_into_customer_id == null) {
      if (normalizeCustomerMobile(match.phone) !== normalizedMobile) {
        unresolved = true;
        continue;
      }
      canonicalIds.add(Number(match.id));
      continue;
    }
    const survivor = queryRow<{ id: number; phone: string }>(
      `WITH RECURSIVE merge_chain(customer_id,depth) AS (
         SELECT ?,0
         UNION ALL
         SELECT audit.survivor_customer_id,chain.depth+1
         FROM merge_chain chain
         JOIN customer_merge_audit audit ON audit.source_customer_id=chain.customer_id
         WHERE chain.depth<100
       )
       SELECT c.id,c.phone FROM merge_chain chain
       JOIN customers c ON c.id=chain.customer_id
       WHERE c.merged_into_customer_id IS NULL
       ORDER BY chain.depth LIMIT 1`,
      [match.id],
    );
    if (!survivor) unresolved = true;
    else if (normalizeCustomerMobile(survivor.phone) !== normalizedMobile) {
      // A source phone only identifies the survivor while it remains that
      // survivor's current canonical phone; historical aliases are untrusted.
      unresolved = true;
    } else canonicalIds.add(Number(survivor.id));
  }
  return { ids: [...canonicalIds], unresolved };
}

router.post("/otp/verify", (req, res): void => {
  const mobile = mobileFrom(req.body?.mobile);
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!mobile || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "invalid_otp_format", message: "شماره همراه و کد شش‌رقمی معتبر را وارد کنید." });
    return;
  }
  const ipHash = hmac(requestIp(req), "customer-portal-ip");
  const result = runTransaction(() => {
    const attemptWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const attempts = queryRow<{ mobile_attempts: number; ip_attempts: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN mobile=? THEN attempts ELSE 0 END),0) AS mobile_attempts,
         COALESCE(SUM(CASE WHEN ip_hash=? THEN attempts ELSE 0 END),0) AS ip_attempts
       FROM customer_portal_otp_challenges WHERE created_at>=?`,
      [mobile, ipHash, attemptWindowStart],
    );
    if (
      Number(attempts?.mobile_attempts ?? 0) >= MAX_DAILY_MOBILE_ATTEMPTS ||
      Number(attempts?.ip_attempts ?? 0) >= MAX_DAILY_IP_ATTEMPTS
    ) return { valid: false as const, rateLimited: true as const };
    const challenge = queryRow<OtpRow>(
      `SELECT id, mobile, otp_hash FROM customer_portal_otp_challenges
       WHERE mobile=? AND delivery_status='sent' AND consumed_at IS NULL
         AND expires_at>? AND attempts<? ORDER BY id DESC LIMIT 1`,
      [mobile, new Date().toISOString(), MAX_OTP_ATTEMPTS],
    );
    if (!challenge) return { valid: false as const };
    const actual = Buffer.from(hmac(`${mobile}:${code}`, "customer-portal-otp"), "hex");
    const expected = Buffer.from(challenge.otp_hash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      executeChanges(
        `UPDATE customer_portal_otp_challenges SET attempts=attempts+1
         WHERE id=? AND consumed_at IS NULL`,
        [challenge.id],
      );
      return { valid: false as const };
    }
    executeChanges(
      "UPDATE customer_portal_otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
      [new Date().toISOString(), challenge.id],
    );
    const customers = canonicalCustomersForMobile(mobile);
    if (customers.ids.length > 1 || customers.unresolved) {
      return { valid: false as const, ambiguous: true as const };
    }
    return {
      valid: true as const,
      customerId: customers.ids.length === 1 ? customers.ids[0] : null,
    };
  });
  if (!result.valid) {
    res.status(result.ambiguous ? 409 : result.rateLimited ? 429 : 401).json({
      error: result.ambiguous
        ? "Customer identity is ambiguous; support must resolve it before login."
        : result.rateLimited
          ? "Too many verification attempts; request a new code later."
          : "The mobile or verification code is invalid or expired.",
      message: result.ambiguous ? "اطلاعات حساب شما نیاز به بررسی دارد؛ با پشتیبانی تماس بگیرید."
        : result.rateLimited ? "تعداد تلاش‌ها بیش از حد مجاز است؛ بعداً دوباره کد دریافت کنید."
        : "کد ورود نادرست یا منقضی شده است؛ کد پیامک‌شده را بررسی کنید.",
    });
    return;
  }
  const session = createCustomerPortalSession(mobile, result.customerId, res);
  const identityReady = session.customerId !== null && customerPortalIdentityReady(
    queryRow<any>("SELECT * FROM customers WHERE id=?", [session.customerId]),
  );
  res.status(200).json({
    authenticated: true,
    mobile: session.mobile,
    customerId: session.customerId,
    profileComplete: identityReady,
    identityReady,
  });
});

router.post("/logout", (req, res): void => {
  destroyCustomerPortalSession(req, res);
  res.status(200).json({ ok: true });
});

export default router;