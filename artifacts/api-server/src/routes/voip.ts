import { Router, type IRouter } from "express";
import { customerSearchSql } from "../lib/customer-id-search";
import {
  CreateVoipCallBody,
  GetVoipConfigResponse,
  ListVoipCallsQueryParams,
  ListVoipContactsQueryParams,
  LookupVoipCustomerQueryParams,
  UpdateVoipConfigBody,
  UpdateVoipExtensionBody,
  UpdateVoipExtensionParams,
  ListVoipExtensionsResponse,
  UpdateVoipConfigResponse,
  UpdateVoipExtensionResponse,
  CreateVoipCallResponse,
} from "@workspace/api-zod";
import { requirePermission } from "../lib/access-control";
import { requireAdmin, type AuthUser } from "../lib/auth";
import { findVoipCustomerByPhone } from "../lib/voip-customer-lookup";
import { validSipServerAddress } from "../lib/sip-server-address";
import "../lib/call-display-exclusions";
import { CALL_LIST_START } from "../lib/call-list-cutoff";
import {
  crmDb,
  executeChanges,
  queryRow,
  queryRows,
  runTransaction,
  type SqlValue,
} from "../lib/crm-db";

const router: IRouter = Router();
const SIP_USERNAME = /^(?=.{1,128}$)[A-Za-z0-9_.-]+(?:@[A-Za-z0-9.-]+)?$/;
const EXTENSION = /^[A-Za-z0-9*#_.-]{1,32}$/;
const PHONE_LIMIT = 32;
const statusRank: Record<string, number> = {
  ringing: 0,
  answered: 1,
  completed: 2,
  missed: 2,
  rejected: 2,
  failed: 2,
};

function hasExactKeys(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}

function normalizePhone(value: string): string | null {
  const latin = value.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  let digits = latin.replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98")) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return /^0\d{9,10}$/.test(digits) ? digits : null;
}

function normalizeCallPhone(value: string, direction: string): string | null {
  if (value.trim().toLowerCase() === "anonymous") {
    return direction === "incoming" ? "anonymous" : null;
  }
  const trimmed = value.trim();
  if (!/^\+?[0-9۰-۹٠-٩()\s.-]+$/.test(trimmed)) return null;
  const latin = trimmed.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .trim();
  const hasPlus = latin.startsWith("+");
  const digits = latin.replace(/\D/g, "");
  if (digits.length < 2 || digits.length > 20) return null;
  return `${hasPlus ? "+" : ""}${digits}`;
}

function customerScope(user: AuthUser, alias = "c"): { sql: string; params: SqlValue[] } {
  const owner = user.customerScope === "assigned"
    ? ` AND ${alias}.salesperson_id = ?`
    : "";
  return {
    sql: ` AND ${alias}.merged_into_customer_id IS NULL${owner}`,
    params: user.customerScope === "assigned" ? [user.salespersonId] : [],
  };
}

function findCustomer(user: AuthUser, phone: string): { id: number; name: string; phone: string; customerSalespersonName: string | null } | null {
  const customer = findVoipCustomerByPhone(
    crmDb,
    phone,
    normalizePhone,
    user.customerScope === "assigned" ? user.salespersonId ?? -1 : null,
  );
  if (!customer) return null;
  const owner = queryRow<{ customerSalespersonName: string | null }>(
    `SELECT s.name customerSalespersonName FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
     WHERE c.id=? AND c.merged_into_customer_id IS NULL`,
    [customer.id],
  );
  return { ...customer, customerSalespersonName: owner?.customerSalespersonName ?? null };
}

function configRow(): {
  enabled: number;
  wss_url: string;
  sip_domain: string;
  stun_urls_json: string;
} {
  return queryRow("SELECT enabled, wss_url, sip_domain, stun_urls_json FROM voip_config WHERE id=1")!;
}

function extensionFor(userId: number): { extension: string | null; authorization_username: string | null } | undefined {
  return queryRow(
    "SELECT extension, authorization_username FROM voip_extensions WHERE user_id=?",
    [userId],
  );
}

function parseStunUrls(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

router.get("/voip/config", requirePermission("calls.view"), (req, res): void => {
  const user = res.locals.authUser as AuthUser;
  const config = configRow();
  const assignment = extensionFor(user.id);
  res.json(GetVoipConfigResponse.parse({
    enabled: Boolean(config.enabled),
    wssUrl: config.wss_url,
    sipDomain: config.sip_domain,
    stunUrls: parseStunUrls(config.stun_urls_json),
    extension: assignment?.extension ?? null,
    authorizationUsername: assignment?.authorization_username ?? null,
    canManage: user.role === "admin",
    historySyncAvailable: false,
    phonebookSyncAvailable: false,
  }));
});

router.put("/voip/config", requireAdmin, (req, res): void => {
  const parsed = UpdateVoipConfigBody.safeParse(req.body);
  if (!parsed.success || !hasExactKeys(req.body, ["enabled", "wssUrl", "sipDomain", "stunUrls"])) {
    res.status(400).json({ error: parsed.success ? "Malformed request body" : parsed.error.message });
    return;
  }
  const { enabled, wssUrl, sipDomain, stunUrls } = parsed.data;
  if (!validSipServerAddress(sipDomain)) {
    res.status(400).json({ error: "Invalid SIP domain" });
    return;
  }
  const validWssUrl = (value: string): boolean => {
    if (value.length > 2048) return false;
    try {
      const url = new URL(value);
      return url.protocol === "wss:" && !url.username && !url.password
        && !url.search && !url.hash && Boolean(url.hostname);
    } catch {
      return false;
    }
  };
  if ((wssUrl !== "" && !validWssUrl(wssUrl)) || (enabled && wssUrl === "")) {
    res.status(400).json({ error: "A valid WSS endpoint is required when VoIP is enabled" });
    return;
  }
  const validStunUrl = (value: string): boolean =>
    value.length <= 2048
    && /^(?:stun|stuns):(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(value);
  if (stunUrls.length > 10 || new Set(stunUrls).size !== stunUrls.length
      || stunUrls.some((url) => !validStunUrl(url))) {
    res.status(400).json({ error: "Invalid STUN URL list" });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  executeChanges(
    `UPDATE voip_config SET enabled=?,wss_url=?,sip_domain=?,stun_urls_json=?,
      updated_at=?,updated_by_user_id=? WHERE id=1`,
    [enabled ? 1 : 0, wssUrl, sipDomain.toLowerCase(), JSON.stringify(stunUrls), new Date().toISOString(), user.id],
  );
  res.json(UpdateVoipConfigResponse.parse({ ok: true }));
});

router.get("/voip/extensions", requireAdmin, (_req, res): void => {
  const rows = queryRows<{
    id: number; full_name: string | null; username: string;
    extension: string | null; authorization_username: string | null;
  }>(`SELECT u.id,u.full_name,u.username,e.extension,e.authorization_username
      FROM users u LEFT JOIN voip_extensions e ON e.user_id=u.id
      WHERE u.active=1 ORDER BY COALESCE(u.full_name,u.username),u.id`);
  res.json(ListVoipExtensionsResponse.parse({
    items: rows.map((row) => ({
      userId: Number(row.id),
      displayName: row.full_name?.trim() || row.username,
      extension: row.extension,
      authorizationUsername: row.authorization_username,
    })),
  }));
});

router.put("/voip/extensions/:userId", requireAdmin, (req, res): void => {
  const params = UpdateVoipExtensionParams.safeParse(req.params);
  const body = UpdateVoipExtensionBody.safeParse(req.body);
  if (!params.success || !body.success
      || !hasExactKeys(req.body, ["extension", "authorizationUsername"])) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : !body.success
          ? body.error.message
          : "Invalid request",
    });
    return;
  }
  const target = queryRow<{ id: number }>("SELECT id FROM users WHERE id=? AND active=1", [params.data.userId]);
  if (!target) {
    res.status(404).json({ error: "Active user not found" });
    return;
  }
  const extension = body.data.extension?.trim() || null;
  const authorizationUsername = body.data.authorizationUsername?.trim() || null;
  if ((extension !== null && !EXTENSION.test(extension))
      || (authorizationUsername !== null && !SIP_USERNAME.test(authorizationUsername))) {
    res.status(400).json({ error: "Invalid SIP extension or authorization username" });
    return;
  }
  const duplicate = extension === null ? undefined : queryRow<{ user_id: number }>(
    "SELECT user_id FROM voip_extensions WHERE extension=? AND user_id<>?",
    [extension, params.data.userId],
  );
  if (duplicate) {
    res.status(409).json({ error: "Extension is already assigned" });
    return;
  }
  const actor = res.locals.authUser as AuthUser;
  executeChanges(
    `INSERT INTO voip_extensions(user_id,extension,authorization_username,updated_at,updated_by_user_id)
     VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET extension=excluded.extension,
     authorization_username=excluded.authorization_username,updated_at=excluded.updated_at,
     updated_by_user_id=excluded.updated_by_user_id`,
    [params.data.userId, extension, authorizationUsername, new Date().toISOString(), actor.id],
  );
  res.json(UpdateVoipExtensionResponse.parse({ ok: true }));
});

router.get(
  "/voip/contacts",
  requirePermission("calls.view"),
  requirePermission("customers.view"),
  (req, res): void => {
    const parsed = ListVoipContactsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const scope = customerScope(user);
    const search = parsed.data.search?.trim();
    const idSearch = search ? customerSearchSql(search) : null;
    const clause = idSearch?.where("(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ?)", [`%${idSearch.text}%`, `%${idSearch.text}%`], "c.id");
    const searchSql = clause ? ` AND ${clause.sql}` : "";
    const searchParams = clause?.params ?? [];
    const order = idSearch?.orderPrefix("c.id") ?? { sql: "", params: [] };
    const rows = queryRows<{ id: number; name: string; phone: string; customerSalespersonName: string | null }>(
      `SELECT c.id,c.name,c.phone,s.name customerSalespersonName FROM customers c
       LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE 1=1${scope.sql}${searchSql}
       ORDER BY ${order.sql}c.name,c.id LIMIT 50`,
      [...scope.params, ...searchParams, ...order.params],
    );
    res.json({ items: rows });
  },
);

router.get(
  "/voip/lookup",
  requirePermission("calls.view"),
  requirePermission("customers.view"),
  (req, res): void => {
    const parsed = LookupVoipCustomerQueryParams.safeParse(req.query);
    const phone = parsed.success ? normalizePhone(parsed.data.phone) : null;
    if (!parsed.success || !phone) {
      res.status(400).json({ error: parsed.success ? "Invalid Iranian phone number" : parsed.error.message });
      return;
    }
    const customer = findCustomer(res.locals.authUser as AuthUser, phone);
    res.json({ customer });
  },
);

router.get("/voip/calls", requirePermission("calls.view"), (req, res): void => {
  const parsed = ListVoipCallsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  const canViewCustomers = user.role === "admin" || user.permissions.includes("customers.view");
  const page = parsed.data.page ?? 1;
  const params: SqlValue[] = [CALL_LIST_START];
  const filters: string[] = ["julianday(v.started_at)>=julianday(?)", "NOT EXISTS (SELECT 1 FROM voip_call_display_exclusions hidden WHERE hidden.phone=v.phone)"];
  if (user.role !== "admin") {
    filters.push("v.user_id=?");
    params.push(user.id);
    const own = queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [user.id])?.extension;
    filters.push("v.extension=?");
    params.push(own ?? "");
  }
  if (parsed.data.customerId !== undefined) {
    if (!canViewCustomers) {
      res.status(403).json({ error: "Forbidden", permission: "customers.view" });
      return;
    }
    const scope = customerScope(user);
    const exists = queryRow(
      `SELECT c.id FROM customers c WHERE c.id=?${scope.sql}`,
      [parsed.data.customerId, ...scope.params],
    );
    if (!exists) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    filters.push("v.customer_id=?");
    params.push(parsed.data.customerId);
  }
  const scopeJoin = !canViewCustomers
    ? " AND 0"
    : ` AND c.merged_into_customer_id IS NULL${user.customerScope === "assigned" ? " AND c.salesperson_id=?" : ""}`;
  const scopeParams: SqlValue[] = canViewCustomers && user.customerScope === "assigned"
    ? [user.salespersonId]
    : [];
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const total = queryRow<{ total: number }>(`SELECT COUNT(*) total FROM voip_browser_calls v ${where}`, params);
  const rows = queryRows<{
    id: number; call_id: string; direction: string; phone: string; status: string;
    started_at: string; answered_at: string | null; ended_at: string | null;
    customer_id: number | null; customer_name: string | null; customer_salesperson_name: string | null; extension: string;
    actor_name: string;
  }>(`SELECT v.id,v.call_id,v.direction,v.phone,v.status,v.started_at,v.answered_at,v.ended_at,
      c.id customer_id,c.name customer_name,s.name customer_salesperson_name,v.extension,COALESCE(u.full_name,u.username) actor_name
      FROM voip_browser_calls v JOIN users u ON u.id=v.user_id
      LEFT JOIN customers c ON c.id=v.customer_id${scopeJoin}
      LEFT JOIN salespersons s ON s.id=c.salesperson_id
      ${where} ORDER BY v.started_at DESC,v.id DESC LIMIT 50 OFFSET ?`,
    [...scopeParams, ...params, (page - 1) * 50]);
  res.json({
    items: rows.map((row) => ({
      id: Number(row.id), callId: row.call_id, direction: row.direction, phone: row.phone,
      status: row.status, startedAt: row.started_at, answeredAt: row.answered_at,
      endedAt: row.ended_at, customerId: row.customer_id == null ? null : Number(row.customer_id),
      customerName: row.customer_name, customerSalespersonName: row.customer_salesperson_name,
      extension: row.extension, actorName: row.actor_name,
      source: "browser",
    })),
    total: Number(total?.total ?? 0), page, limit: 50,
  });
});

router.post("/voip/calls", requirePermission("calls.create"), (req, res): void => {
  const parsed = CreateVoipCallBody.safeParse(req.body);
  if (!parsed.success || !hasExactKeys(req.body, [
    "callId", "direction", "phone", "status", "startedAt", "answeredAt", "endedAt",
  ])) {
    res.status(400).json({ error: parsed.success ? "Malformed request body" : parsed.error.message });
    return;
  }
  const body = parsed.data;
  const rawBody = req.body as Record<string, unknown>;
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const rawTimes = [rawBody.startedAt, rawBody.answeredAt, rawBody.endedAt]
    .filter((value) => value != null);
  if (rawTimes.some((value) => typeof value !== "string" || !isoDateTime.test(value))) {
    res.status(400).json({ error: "Call timestamps must be ISO 8601 date-times" });
    return;
  }
  const phone = normalizeCallPhone(body.phone, body.direction);
  const startedAt = body.startedAt.toISOString();
  const answeredAt = body.answeredAt?.toISOString() ?? null;
  const endedAt = body.endedAt?.toISOString() ?? null;
  if (!phone) {
    res.status(400).json({ error: "Invalid phone number or timestamp" });
    return;
  }
  const started = body.startedAt.getTime();
  const answered = body.answeredAt?.getTime() ?? null;
  const ended = body.endedAt?.getTime() ?? null;
  const lifecycleValid = (answered === null || answered >= started)
    && (ended === null || ended >= started)
    && (answered === null || ended === null || ended >= answered)
    && (body.status !== "ringing" || (answered === null && ended === null))
    && (body.status !== "answered" || (answered !== null && ended === null))
    && (body.status !== "completed" || (answered !== null && ended !== null))
    && (!["missed", "rejected", "failed"].includes(body.status) || (answered === null && ended !== null));
  if (!lifecycleValid) {
    res.status(400).json({ error: "Invalid call status lifecycle" });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  const existing = queryRow<{
    direction: string; phone: string; started_at: string; status: string;
    answered_at: string | null; ended_at: string | null;
  }>("SELECT direction,phone,started_at,status,answered_at,ended_at FROM voip_browser_calls WHERE user_id=? AND call_id=?",
    [user.id, body.callId]);
  const assignment = extensionFor(user.id);
  if (!existing) {
    const config = configRow();
    if (!config.enabled || !config.wss_url || !assignment?.extension) {
      res.status(409).json({ error: "VoIP is disabled or no extension is assigned" });
      return;
    }
  }
  if (existing && (existing.direction !== body.direction || existing.phone !== phone
      || existing.started_at !== startedAt
      || (existing.answered_at !== null && existing.answered_at !== answeredAt)
      || (existing.ended_at !== null && existing.ended_at !== endedAt))) {
    res.status(409).json({ error: "Immutable call fields do not match" });
    return;
  }
  if (existing) {
    const oldRank = statusRank[existing.status];
    const nextRank = statusRank[body.status];
    const validTransition = nextRank > oldRank
      && !(existing.status === "answered" && body.status !== "completed");
    const identical = existing.status === body.status
      && existing.answered_at === answeredAt
      && existing.ended_at === endedAt;
    if (!identical && !validTransition) {
      res.status(409).json({ error: "Call event is stale or conflicts with its lifecycle" });
      return;
    }
    if (!identical) executeChanges(
      "UPDATE voip_browser_calls SET status=?,answered_at=?,ended_at=?,updated_at=? WHERE user_id=? AND call_id=?",
      [body.status, answeredAt, endedAt, new Date().toISOString(), user.id, body.callId],
    );
  } else {
    const canViewCustomers = user.role === "admin" || user.permissions.includes("customers.view");
    const customer = canViewCustomers ? findCustomer(user, phone) : null;
    const now = new Date().toISOString();
    runTransaction(() => {
      crmDb.prepare(`INSERT INTO voip_browser_calls
        (user_id,call_id,direction,phone,status,started_at,answered_at,ended_at,customer_id,extension,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        user.id, body.callId, body.direction, phone, body.status, startedAt,
        answeredAt, endedAt, customer?.id ?? null,
        assignment!.extension, now, now,
      );
    });
  }
  res.json(CreateVoipCallResponse.parse({ ok: true }));
});

export default router;