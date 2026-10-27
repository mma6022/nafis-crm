import { createHash, createHmac, randomBytes } from "node:crypto";
import { execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { ensureSiteLeadSchema, recordSiteLeadRequest } from "./site-leads-store";
import { insertCustomerRecord } from "./customer-create";
import { normalizeCustomerMobile, normalizePersianSearchText } from "./customer-integrity";
import { isWorkingHours } from "./callback-config";

/** Website lead intake (POST /api/public/leads). Every row has source='website'. */
export const LEAD_SOURCE = "website";
export const WEBSITE_LEAD_TAG = "website_lead";

export const NEEDS = ["cash", "goods", "help"] as const;
/**
 * Received-amount bands (million toman). The site's `reqBands()` keys ("lo-hi", top band "lo-up") on a fixed
 * 100/200/300/500/1000 scale; the original coarse keys stay accepted for older site builds.
 */
export const AMOUNT_BANDS = [
  "0-100", "100-200", "200-300", "300-500", "500-1000", "1000-up",
  "upto100", "100-300", "500plus",
  "unsure",
] as const;
export const CONTACT_TIMES = ["morning", "evening", "any"] as const;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const ALLOWED_KEYS = new Set<string>([
  "type", "name", "phone", "need", "amountBand", "planId", "term", "contactTime", "src", "consent",
  "website", "startedAt", "fillMs", ...UTM_KEYS,
]);
/**
 * «درخواست تماس کارشناس» (site contract): { kind:'callback', name, phone, contactTime:'now'|'morning'|'evening',
 * need?:'cash'|'goods'|'help', planId?, src, consent:true, website, startedAt, utm_* }.
 */
export const CALLBACK_TIMES = ["now", "morning", "evening"] as const;
export const CALLBACK_NEEDS = ["cash", "goods", "help"] as const;
const CALLBACK_KEYS = new Set<string>([
  "kind", "name", "phone", "contactTime", "need", "planId", "src", "consent", "website", "startedAt", "fillMs", ...UTM_KEYS,
]);
/** «همین الان» only exists during working hours; a late/stale "now" is queued as the next morning. */
export function effectiveContactTime(time: (typeof CALLBACK_TIMES)[number], at: Date): (typeof CALLBACK_TIMES)[number] {
  return time === "now" && !isWorkingHours(at) ? "morning" : time;
}

/** A human needs at least a few seconds for three wizard steps. */
export const MIN_FILL_MS = 3_000;
/** sessionStorage keeps the wizard for one tab; a day-old start time is not a live form. */
export const MAX_FILL_MS = 24 * 60 * 60 * 1000;
/**
 * `startedAt` is the visitor's own device clock, which in the wild runs seconds to hours off the server (a manually
 * set clock, a wrong zone/DST setting). A device running ahead used to make every honest submission fail as
 * «too_fast»/«expired» (2026-10-24 16:29 Tehran). So the server only trusts its sign loosely: a future start time
 * within this window is accepted, and the minimum-fill check uses `fillMs` (measured on the page with a monotonic
 * timer, clock-independent) when the site sends it, otherwise only a non-negative `now - startedAt`.
 */
export const CLOCK_SKEW_MS = 14 * 60 * 60 * 1000;

export type PublicLead = {
  name: string;
  phone: string;
  need: (typeof NEEDS)[number];
  amountBand: (typeof AMOUNT_BANDS)[number];
  planId: number | null;
  term: number | null;
  contactTime: (typeof CONTACT_TIMES)[number];
  src: string | null;
  utm: Partial<Record<(typeof UTM_KEYS)[number], string>>;
};

export type PublicCallback = {
  name: string;
  phone: string;
  contactTime: (typeof CALLBACK_TIMES)[number];
  need: (typeof CALLBACK_NEEDS)[number] | null;
  planId: number | null;
  src: string | null;
  utm: Partial<Record<(typeof UTM_KEYS)[number], string>>;
};

export type CallbackValidation =
  | { ok: true; callback: PublicCallback }
  | { ok: false; status: 400 | 422; error: "invalid" | "spam" | "too_fast" | "expired"; fields?: string[] };

export type LeadValidation =
  | { ok: true; lead: PublicLead }
  | { ok: false; status: 400 | 422; error: "invalid" | "spam" | "too_fast" | "expired"; fields?: string[] };

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'\u200c-]*$/u;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function oneOf<T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function optionalInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^\d{1,7}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

export function normalizeLeadName(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_RE.test(value)) return undefined;
  const name = normalizePersianSearchText(value).replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60 || !NAME_RE.test(name)) return undefined;
  return name;
}

export function normalizeLeadPhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 20) return undefined;
  const phone = normalizeCustomerMobile(value);
  return /^09\d{9}$/.test(phone) ? phone : undefined;
}

type IntakeFailure = { ok: false; status: 400 | 422; error: "invalid" | "spam" | "too_fast" | "expired"; fields?: string[] };

/** Shape, allowed keys, honeypot and fill timing: identical for every public intake type. */
function intakeGate(body: unknown, allowed: Set<string>, now: number): { input: Record<string, unknown> } | IntakeFailure {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid", fields: ["body"] };
  }
  const input = body as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknownKeys.length) return { ok: false, status: 400, error: "invalid", fields: ["unknown_field"] };

  // Honeypot: the hidden field is never shown to people. Reject honestly.
  if (input.website !== undefined && input.website !== "") {
    return { ok: false, status: 400, error: "spam" };
  }
  const startedAt = input.startedAt;
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)) {
    return { ok: false, status: 400, error: "invalid", fields: ["startedAt"] };
  }
  let fillMs: number | null = null;
  if (input.fillMs !== undefined && input.fillMs !== null) {
    if (typeof input.fillMs !== "number" || !Number.isSafeInteger(input.fillMs) || input.fillMs < 0) {
      return { ok: false, status: 400, error: "invalid", fields: ["fillMs"] };
    }
    fillMs = input.fillMs;
  }
  const elapsed = now - startedAt;
  if (elapsed < -CLOCK_SKEW_MS || elapsed > MAX_FILL_MS + CLOCK_SKEW_MS) return { ok: false, status: 422, error: "expired" };
  if (fillMs !== null) {
    if (fillMs > MAX_FILL_MS) return { ok: false, status: 422, error: "expired" };
    if (fillMs < MIN_FILL_MS) return { ok: false, status: 422, error: "too_fast" };
  } else if (elapsed >= 0 && elapsed < MIN_FILL_MS) {
    // Negative elapsed = the device clock runs ahead; its fill time is unknown, so it is not called "too fast".
    return { ok: false, status: 422, error: "too_fast" };
  }
  return { input };
}

function readSrcAndUtm(input: Record<string, unknown>, fields: string[]): { src: string | null; utm: PublicLead["utm"] } {
  let src: string | null = null;
  if (input.src !== undefined && input.src !== null && input.src !== "") {
    if (typeof input.src === "string" && SLUG_RE.test(input.src)) src = input.src;
    else fields.push("src");
  }
  const utm: PublicLead["utm"] = {};
  for (const key of UTM_KEYS) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > 100 || CONTROL_RE.test(value) || /[<>]/.test(value)) {
      fields.push(key);
      continue;
    }
    utm[key] = value.trim();
  }
  return { src, utm };
}

/**
 * Which intake a body is for. `kind:'callback'` is the callback form; absent kind (with absent or "lead" type)
 * is the request wizard (older site builds send neither). Anything else is rejected.
 */
export function publicIntakeType(body: unknown): "lead" | "callback" | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "lead";
  const input = body as Record<string, unknown>;
  if (input.kind !== undefined) return input.kind === "callback" ? "callback" : undefined;
  if (input.type === undefined || input.type === "lead") return "lead";
  return undefined;
}

/** Strict validation of a callback request. Same gate, name/phone rules and consent as a lead. */
export function validatePublicCallback(body: unknown, now = Date.now()): CallbackValidation {
  const gate = intakeGate(body, CALLBACK_KEYS, now);
  if ("ok" in gate) return gate;
  const { input } = gate;
  const fields: string[] = [];
  if (input.kind !== "callback") fields.push("kind");
  const name = normalizeLeadName(input.name);
  if (!name) fields.push("name");
  const phone = normalizeLeadPhone(input.phone);
  if (!phone) fields.push("phone");
  if (!oneOf(CALLBACK_TIMES, input.contactTime)) fields.push("contactTime");
  const needRaw = input.need;
  const need = needRaw === undefined || needRaw === null || needRaw === "" ? null : needRaw;
  if (need !== null && !oneOf(CALLBACK_NEEDS, need)) fields.push("need");
  const planId = optionalInt(input.planId, 1, 9_999_999);
  if (planId === undefined) fields.push("planId");
  if (input.consent !== true) fields.push("consent");
  const { src, utm } = readSrcAndUtm(input, fields);
  if (fields.length) return { ok: false, status: 400, error: "invalid", fields };
  return {
    ok: true,
    callback: {
      name: name!,
      phone: phone!,
      contactTime: input.contactTime as PublicCallback["contactTime"],
      need: need as PublicCallback["need"],
      planId: planId ?? null,
      src,
      utm,
    },
  };
}

/** Strict validation. Field names may be reported, input values never are. */
export function validatePublicLead(body: unknown, now = Date.now()): LeadValidation {
  const gate = intakeGate(body, ALLOWED_KEYS, now);
  if ("ok" in gate) return gate;
  const { input } = gate;

  const fields: string[] = [];
  if (input.type !== undefined && input.type !== "lead") fields.push("type");
  const name = normalizeLeadName(input.name);
  if (!name) fields.push("name");
  const phone = normalizeLeadPhone(input.phone);
  if (!phone) fields.push("phone");
  // Legal 2026-10-24: the site no longer asks a request type, so `need` is optional and defaults to "help".
  // Old cached site pages that still send cash/goods keep working (stored for staff only).
  const need = input.need === undefined || input.need === null || input.need === "" ? "help" : input.need;
  if (!oneOf(NEEDS, need)) fields.push("need");
  if (!oneOf(AMOUNT_BANDS, input.amountBand)) fields.push("amountBand");
  if (!oneOf(CONTACT_TIMES, input.contactTime)) fields.push("contactTime");
  const planId = optionalInt(input.planId, 1, 1_000_000);
  if (planId === undefined) fields.push("planId");
  const term = optionalInt(input.term, 1, 120);
  if (term === undefined) fields.push("term");
  if (input.consent !== true) fields.push("consent");
  const { src, utm } = readSrcAndUtm(input, fields);
  if (fields.length) return { ok: false, status: 400, error: "invalid", fields };
  return {
    ok: true,
    lead: {
      name: name!,
      phone: phone!,
      need: need as PublicLead["need"],
      amountBand: input.amountBand as PublicLead["amountBand"],
      planId: planId ?? null,
      term: term ?? null,
      contactTime: input.contactTime as PublicLead["contactTime"],
      src,
      utm,
    },
  };
}

const NEED_FA: Record<PublicLead["need"], string> = {
  cash: "پول نقد (وام)",
  goods: "خرید کالا به‌صورت قسطی",
  help: "نمی‌داند، راهنمایی می‌خواهد",
};
const BAND_FA: Record<PublicLead["amountBand"], string> = {
  "0-100": "تا ۱۰۰ میلیون تومان",
  "100-200": "۱۰۰ تا ۲۰۰ میلیون تومان",
  "200-300": "۲۰۰ تا ۳۰۰ میلیون تومان",
  "300-500": "۳۰۰ تا ۵۰۰ میلیون تومان",
  "500-1000": "۵۰۰ تا ۱۰۰۰ میلیون تومان",
  "1000-up": "بیش از ۱۰۰۰ میلیون تومان",
  upto100: "تا ۱۰۰ میلیون تومان",
  "100-300": "۱۰۰ تا ۳۰۰ میلیون تومان",
  "500plus": "بیش از ۵۰۰ میلیون تومان",
  unsure: "مشخص نکرده",
};
const TIME_FA: Record<PublicLead["contactTime"], string> = {
  morning: "صبح",
  evening: "عصر",
  any: "فرقی نمی‌کند",
};

/** Persian label of the request form's contact time (for the staff alert). */
export function leadContactTimeFa(lead: PublicLead): string {
  return TIME_FA[lead.contactTime];
}

/** Same summary as a new customer's description, for an existing customer's alert (their stored one is older). */
export function leadRequestDetails(lead: PublicLead): string {
  const planName = lead.planId
    ? queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [lead.planId])?.name ?? null
    : null;
  return leadDescription(lead, planName);
}

/** Staff-facing Persian summary stored as the new customer's description. */
export function leadDescription(lead: PublicLead, planName?: string | null): string {
  const lines = [
    "درخواست از سایت nafisvam.com",
    // «نیاز» only for legacy cash/goods leads (staff-only); the site no longer asks it, "help" is the default.
    ...(lead.need === "help" ? [] : [`نیاز: ${NEED_FA[lead.need]}`]),
    `حدود مبلغ: ${BAND_FA[lead.amountBand]}`,
  ];
  if (lead.planId) {
    lines.push(`طرح انتخابی: ${planName ? `${planName} ` : ""}(#${lead.planId})${lead.term ? `، ${lead.term} ماهه` : ""}`);
  }
  lines.push(`زمان مناسب تماس: ${TIME_FA[lead.contactTime]}`);
  if (lead.src) lines.push(`منبع صفحه: ${lead.src}`);
  const utm = Object.entries(lead.utm).map(([key, value]) => `${key}=${value}`).join(" ");
  if (utm) lines.push(`UTM: ${utm}`);
  return lines.join("\n");
}

/** Unambiguous alphabet (no 0/O, 1/I/L, U): codes are read out over the phone. */
const TRACKING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * Short, non-guessable reference shown to the visitor, e.g. "NV-7KQ4-M9TX".
 * 8 symbols from 30 = ~39 bits of CSPRNG entropy; rejection sampling keeps it unbiased.
 */
export function newTrackingCode(): string {
  const out: string[] = [];
  while (out.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= 240) continue; // 240 = 8 × 30, so the remainder below is uniform
      out.push(TRACKING_ALPHABET[byte % 30]);
      if (out.length === 8) break;
    }
  }
  return `NV-${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

export function hashLeadIp(ip: string): string {
  const secret = process.env.SESSION_SECRET;
  return secret
    ? createHmac("sha256", secret).update(`public-lead-ip:${ip}`).digest("hex")
    : createHash("sha256").update(`public-lead-ip:${ip}`).digest("hex");
}

let schemaReady = false;
export function ensurePublicLeadSchema(): void {
  if (schemaReady) return;
  execute(`CREATE TABLE IF NOT EXISTS public_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'website' CHECK(source='website'),
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('new_customer','existing_customer')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    need TEXT NOT NULL,
    amount_band TEXT NOT NULL,
    plan_id INTEGER,
    term INTEGER,
    contact_time TEXT NOT NULL,
    src TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const leadColumns = queryRows<{ name: string }>("PRAGMA table_info(public_leads)").map((c) => c.name);
  if (!leadColumns.includes("tracking_code")) execute("ALTER TABLE public_leads ADD COLUMN tracking_code TEXT");
  execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_public_leads_tracking ON public_leads(tracking_code) WHERE tracking_code IS NOT NULL");
  execute("CREATE INDEX IF NOT EXISTS idx_public_leads_ip ON public_leads(ip_hash, created_at)");
  execute("CREATE INDEX IF NOT EXISTS idx_public_leads_phone ON public_leads(phone, created_at)");
  ensureCallbackSchema();
  const catalogColumns = queryRows<{ name: string }>("PRAGMA table_info(customer_tag_catalog)").map((c) => c.name);
  if (catalogColumns.includes("canonical_label")) {
    execute(
      "INSERT OR IGNORE INTO customer_tag_catalog(tag,label_fa,canonical_label) VALUES (?,?,?)",
      [WEBSITE_LEAD_TAG, "سرنخ سایت", "سرنخ سایت"],
    );
  } else if (catalogColumns.length) {
    execute("INSERT OR IGNORE INTO customer_tag_catalog(tag,label_fa) VALUES (?,?)", [WEBSITE_LEAD_TAG, "سرنخ سایت"]);
  }
  schemaReady = true;
}

/**
 * «درخواست تماس کارشناس» (additive only: two new tables, nothing existing is altered).
 * A callback is not a customer yet; staff convert it (see callback-requests.ts). It shares
 * the lead intake's caps and 10-minute duplicate window through leadCounts().
 */
export const CALLBACK_STATUSES = ["new", "in_progress", "called", "no_answer", "cancelled"] as const;
export const CANCEL_REASONS = ["duplicate", "wrong_number", "changed_mind", "other"] as const;
export const CALLBACK_EVENT_ACTIONS = ["status", "assign", "note", "reveal", "call", "convert", "notify"] as const;
export function ensureCallbackSchema(): void {
  // Pre-release shape (preferred_time/topic) only ever existed on dev databases: replace it while still empty.
  const existing = queryRows<{ name: string }>("PRAGMA table_info(callback_requests)").map((c) => c.name);
  if (existing.includes("preferred_time")) {
    const rows = Number(queryRow<{ n: number }>("SELECT COUNT(*) AS n FROM callback_requests")?.n ?? 0);
    if (rows > 0) throw new Error("callback_requests has pre-release rows; migrate manually");
    execute("DROP TABLE IF EXISTS callback_request_events");
    execute("DROP TABLE callback_requests");
  }
  execute(`CREATE TABLE IF NOT EXISTS callback_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'website' CHECK(source='website'),
    tracking_code TEXT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    contact_time TEXT NOT NULL CHECK(contact_time IN ('now','morning','evening')),
    need TEXT CHECK(need IS NULL OR need IN ('cash','goods','help')),
    plan_id INTEGER,
    src TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
    ip_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','called','no_answer','cancelled')),
    cancel_reason TEXT CHECK(cancel_reason IS NULL OR cancel_reason IN ('duplicate','wrong_number','changed_mind','other')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    last_attempt_at TEXT,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    converted_at TEXT,
    converted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_activity_at TEXT NOT NULL
  )`);
  execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_callback_requests_tracking ON callback_requests(tracking_code) WHERE tracking_code IS NOT NULL");
  execute("CREATE INDEX IF NOT EXISTS idx_callback_requests_queue ON callback_requests(status, contact_time, created_at)");
  execute("CREATE INDEX IF NOT EXISTS idx_callback_requests_ip ON callback_requests(ip_hash, created_at)");
  execute("CREATE INDEX IF NOT EXISTS idx_callback_requests_phone ON callback_requests(phone, created_at)");
  execute("CREATE INDEX IF NOT EXISTS idx_callback_requests_assignee ON callback_requests(assigned_user_id, status)");
  execute(`CREATE TABLE IF NOT EXISTS callback_request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callback_id INTEGER NOT NULL REFERENCES callback_requests(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK(action IN ('status','assign','note','reveal','call','convert','notify')),
    from_value TEXT,
    to_value TEXT,
    created_at TEXT NOT NULL
  )`);
  execute("CREATE INDEX IF NOT EXISTS idx_callback_request_events ON callback_request_events(callback_id, id)");
}

function trackingCodeTaken(code: string): boolean {
  return Boolean(
    queryRow("SELECT 1 AS hit FROM public_leads WHERE tracking_code=?", [code])
      ?? queryRow("SELECT 1 AS hit FROM callback_requests WHERE tracking_code=?", [code]),
  );
}

export function uniqueTrackingCode(): string {
  let code = newTrackingCode();
  while (trackingCodeTaken(code)) code = newTrackingCode();
  return code;
}

export type CallbackRecordResult = { id: number; trackingCode: string; customerId: number | null };

/** Store a callback request. Links an existing customer by mobile but never creates one. */
export function recordPublicCallback(callback: PublicCallback, ipHash: string, now = new Date()): CallbackRecordResult {
  ensurePublicLeadSchema();
  ensureSiteLeadSchema();
  return runImmediateTransaction(() => {
    const timestamp = now.toISOString();
    const customerId = canonicalCustomerByMobile(callback.phone) ?? null;
    const trackingCode = uniqueTrackingCode();
    const id = execute(
      `INSERT INTO callback_requests
        (tracking_code, name, phone, contact_time, need, plan_id, src, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         ip_hash, customer_id, created_at, updated_at, last_activity_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trackingCode, callback.name, callback.phone, effectiveContactTime(callback.contactTime, now), callback.need, callback.planId,
        callback.src, callback.utm.utm_source ?? null, callback.utm.utm_medium ?? null, callback.utm.utm_campaign ?? null,
        callback.utm.utm_content ?? null, callback.utm.utm_term ?? null, ipHash, customerId, timestamp, timestamp, timestamp,
      ],
    );
    // crm-site-leads: a callback from an existing customer is a repeat website request on that customer.
    if (customerId != null) recordSiteLeadRequest({ customerId, source: "callback", sourceId: id, requestedAt: timestamp,
      contactTime: effectiveContactTime(callback.contactTime, now), isRepeat: true });
    return { id, trackingCode, customerId };
  });
}

export type LeadCounts = { ipDay: number; phoneDay: number; phoneRecent: number };

export function leadCounts(ipHash: string, phone: string, now = new Date()): LeadCounts {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const row = queryRow<{ ip_day: number | null; phone_day: number | null; phone_recent: number | null }>(
    `SELECT
       SUM(CASE WHEN ip_hash=? AND created_at>? THEN 1 ELSE 0 END) AS ip_day,
       SUM(CASE WHEN phone=? AND created_at>? THEN 1 ELSE 0 END) AS phone_day,
       SUM(CASE WHEN phone=? AND created_at>? THEN 1 ELSE 0 END) AS phone_recent
     FROM (
       SELECT ip_hash, phone, created_at FROM public_leads WHERE created_at>?
       UNION ALL
       SELECT ip_hash, phone, created_at FROM callback_requests WHERE created_at>?
     )`,
    [ipHash, day, phone, day, phone, recent, day, day],
  );
  return {
    ipDay: Number(row?.ip_day ?? 0),
    phoneDay: Number(row?.phone_day ?? 0),
    phoneRecent: Number(row?.phone_recent ?? 0),
  };
}

export function canonicalCustomerByMobile(phone: string): number | undefined {
  const rows = queryRows<{ id: number; merged_into_customer_id: number | null }>(
    `SELECT id, merged_into_customer_id FROM customers
     WHERE crm_customer_mobile_key(phone)=crm_customer_mobile_key(?)
     ORDER BY CASE WHEN merged_into_customer_id IS NULL THEN 0 ELSE 1 END, id`,
    [phone],
  );
  const first = rows[0];
  if (!first) return undefined;
  let id = Number(first.id);
  let next = first.merged_into_customer_id;
  for (let depth = 0; next != null && depth < 50; depth += 1) {
    const row = queryRow<{ id: number; merged_into_customer_id: number | null }>(
      "SELECT id, merged_into_customer_id FROM customers WHERE id=?",
      [next],
    );
    if (!row) break;
    id = Number(row.id);
    next = row.merged_into_customer_id;
  }
  return id;
}

export function defaultAllocationProgramId(): number | undefined {
  const programs = queryRows<{ id: number }>(
    "SELECT id FROM allocation_programs WHERE active=1 AND is_default=1 ORDER BY id",
  );
  return programs.length === 1 ? Number(programs[0].id) : undefined;
}

export type LeadRecordResult = { customerId: number; created: boolean; trackingCode: string };

/**
 * Create the CRM customer exactly like the other intakes (unverified, default
 * allocation program) or link the lead to the existing customer with the same
 * mobile. Always logs a public_leads row with source='website'.
 */
export function recordPublicLead(lead: PublicLead, ipHash: string, now = new Date()): LeadRecordResult {
  ensurePublicLeadSchema();
  ensureSiteLeadSchema();
  return runImmediateTransaction(() => {
    const timestamp = now.toISOString();
    let customerId = canonicalCustomerByMobile(lead.phone);
    let created = false;
    if (customerId === undefined) {
      const planName = lead.planId
        ? queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [lead.planId])?.name ?? null
        : null;
      const base = { name: lead.name, phone: lead.phone, description: leadDescription(lead, planName), priority: null,
        registeredByUserId: null, registrationSource: "site_lead" as const };
      const programId = defaultAllocationProgramId();
      try {
        customerId = insertCustomerRecord({ ...base, allocationProgramId: programId });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "ALLOCATION_PROGRAM_UNAVAILABLE") throw error;
        // A lead must never be lost because allocation is misconfigured; it stays unassigned.
        customerId = insertCustomerRecord(base);
      }
      created = true;
    }
    execute(
      "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES (?,?,?)",
      [customerId, WEBSITE_LEAD_TAG, timestamp],
    );
    const trackingCode = uniqueTrackingCode();
    const leadId = execute(
      `INSERT INTO public_leads
        (source, customer_id, outcome, name, phone, need, amount_band, plan_id, term, contact_time, src,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term, ip_hash, created_at, tracking_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        LEAD_SOURCE, customerId, created ? "new_customer" : "existing_customer", lead.name, lead.phone,
        lead.need, lead.amountBand, lead.planId, lead.term, lead.contactTime, lead.src,
        lead.utm.utm_source ?? null, lead.utm.utm_medium ?? null, lead.utm.utm_campaign ?? null,
        lead.utm.utm_content ?? null, lead.utm.utm_term ?? null, ipHash, timestamp, trackingCode,
      ],
    );
    // crm-site-leads: «سرنخ سایت» stays active until a call is logged; an existing customer = «درخواست چندباره».
    recordSiteLeadRequest({ customerId, source: "lead", sourceId: leadId, requestedAt: timestamp, contactTime: lead.contactTime, isRepeat: !created });
    return { customerId, created, trackingCode };
  });
}
